// channels sidebar: followed channels (live + offline) and a Live Channels list. data via
// Rust-proxied Helix (followed, streams-for-users, users-info, top-live), since api.twitch.tv
// isn't reachable from WebView2

import { invoke } from "@tauri-apps/api/core";
import { feedInvoke, isKick } from "./platform.js";
import { getKickFollows, onKickFollowsChange } from "./kick-follows.js";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { streamHasDropsEnabled } from "./drops.js";

const REFRESH_INTERVAL_MS = 60_000;
const COLLAPSED_LIVE_COUNT = 8;

export class ChannelsSidebar {
  constructor({ followedListEl, showMoreBtn, loginPromptEl, topLiveListEl, onChannelSelect }) {
    this.followedListEl = followedListEl;
    this.showMoreBtn = showMoreBtn;
    this.loginPromptEl = loginPromptEl;
    this.topLiveListEl = topLiveListEl;
    this.onChannelSelect = onChannelSelect || (() => {});

    this.loggedIn = false;
    this.expanded = false;
    // {id, login, name, live, viewers, game}
    this.followed = [];
    this.avatars = new Map();

    // logins opted into go-live notifications, loaded in init() from notify_prefs.rs
    this.notifyChannels = new Set();
    // login -> array of category (game) names to notify on when the channel switches to one of them
    this.categoryTargets = new Map();
    // last-seen game per channel, to detect the transition into the target category
    this._lastGame = new Map();
    // login -> live state as of the last refresh, compared next tick to catch offline->live.
    // without it, every refresh would re-notify all already-live channels every 60s
    this._lastLiveState = new Map();

    this.refreshTimer = null;

    this.showMoreBtn.addEventListener("click", () => {
      this.expanded = !this.expanded;
      this.renderFollowed();
    });

    // follow toggled from the info bar (kick-follows.js), reflect it without waiting for the 60s refresh
    onKickFollowsChange(() => {
      if (isKick()) this.refreshKickFollowing();
    });
  }

  onLogin() {
    this.loggedIn = true;
    this.loginPromptEl.style.display = "none";
    this.refresh();
    if (!this.refreshTimer) {
      this.refreshTimer = setInterval(() => this.refresh(), REFRESH_INTERVAL_MS);
    }
  }

  // call unconditionally at startup. also restores the notification opt-in set (a local file, independent of login)
  async init() {
    try {
      const channels = await invoke("get_notify_channels");
      this.notifyChannels = new Set(channels);
      try {
        const targets = await invoke("get_notify_category_targets");
        // Backend now returns login -> array. Older backends/files returned a bare string per login;
        // normalize either shape to an array so the rest of the code only deals with arrays.
        this.categoryTargets = new Map(
          Object.entries(targets || {}).map(([login, v]) => [
            login,
            Array.isArray(v) ? v.filter(Boolean) : (v ? [v] : []),
          ]).filter(([, arr]) => arr.length)
        );
      } catch { /* older backend without category targets */ }
    } catch (err) {
      console.error("Failed to load notification preferences:", err);
    }
    await this.refreshTopLive();
  }

  async refresh() {
    // go-live detection runs independently of which platform the sidebar is showing (see
    // _pollTwitchGoLive): notifications must keep firing for Twitch follows even while viewing Kick
    await Promise.all([
      this.refreshFollowed(),
      this.refreshTopLive(),
      this._pollTwitchGoLive(),
    ]);
  }

  async refreshFollowed() {
    // Kick mode: the Following section is the LOCAL follow list (kick-follows.js), which needs no login
    if (isKick()) {
      await this.refreshKickFollowing();
      return;
    }
    if (!this.loggedIn) return;

    let followedRows;
    try {
      followedRows = JSON.parse(await invoke("get_followed_channels"));
    } catch (err) {
      console.error("Failed to load followed channels:", err);
      return;
    }

    const ids = followedRows.map((r) => r.broadcaster_id);
    if (ids.length === 0) {
      this.followed = [];
      this.renderFollowed();
      return;
    }

    // both fetches depend only on `ids`, so run them concurrently. allSettled keeps each failure
    // independent, one erroring shouldn't wipe the other's data
    const missingAvatarIds = ids.filter((id) => !this.avatars.has(id));
    const [liveResult, usersResult] = await Promise.allSettled([
      invoke("get_streams_for_users", { broadcasterIds: ids }),
      missingAvatarIds.length > 0
        ? invoke("get_users_info", { userIds: missingAvatarIds })
        : Promise.resolve(null),
    ]);

    let liveRows = [];
    if (liveResult.status === "fulfilled") {
      liveRows = JSON.parse(liveResult.value);
    } else {
      console.error("Failed to load stream status:", liveResult.reason);
    }
    const liveById = new Map(liveRows.map((s) => [s.user_id, s]));

    if (usersResult.status === "fulfilled" && usersResult.value !== null) {
      const users = JSON.parse(usersResult.value);
      for (const u of users) {
        this.avatars.set(u.id, u.profile_image_url);
      }
    } else if (usersResult.status === "rejected") {
      console.error("Failed to load channel avatars:", usersResult.reason);
    }

    this.followed = followedRows
      .map((r) => {
        const live = liveById.get(r.broadcaster_id);
        return {
          id: r.broadcaster_id,
          login: r.broadcaster_login,
          title: live ? live.title : "",
          name: r.broadcaster_name,
          avatar: this.avatars.get(r.broadcaster_id) || "",
          live: Boolean(live),
          viewers: live ? live.viewer_count : 0,
          game: live ? live.game_name : "",
          dropsEnabled: live ? streamHasDropsEnabled(live) : false,
        };
      })
      // live first (highest viewers), then offline alphabetically, the official sidebar's default sort
      .sort((a, b) => {
        if (a.live !== b.live) return a.live ? -1 : 1;
        if (a.live) return b.viewers - a.viewers;
        return a.name.localeCompare(b.name);
      });

    // note: go-live detection is NOT driven from here anymore; _pollTwitchGoLive owns it so it keeps
    // working in Kick mode too (this branch doesn't run when viewing Kick). this path only renders
    this.renderFollowed();
  }

  // polls Twitch followed-channel live state for go-live notifications, INDEPENDENTLY of the sidebar's
  // current platform view. the visible Following list swaps to Kick's local follows in Kick mode
  // (refreshFollowed early-returns there), so detection used to go dark the moment you switched to
  // Kick. this fetches its own copy of the Twitch data and never touches this.followed / this.avatars
  // / rendering, so the two concerns can't re-entangle. costs one extra batched Helix call per refresh
  // while in Twitch mode (the view fetches the same rows separately), negligible next to the correctness
  async _pollTwitchGoLive() {
    // DEBUG heartbeat: records that a poll tick ran and when, so you can confirm the background poll
    // keeps ticking while the window is hidden to tray (window.__notifyPollStatus()). Harmless in prod.
    this._lastPollAt = Date.now();
    this._pollTickCount = (this._pollTickCount || 0) + 1;

    // needs the Twitch follow list, which requires a Twitch login; and skip the round-trip when
    // nothing is opted in (a later opt-in seeds its own baseline on the first tick after it's added)
    if (!this.loggedIn || (this.notifyChannels.size === 0 && this.categoryTargets.size === 0)) return;

    let followedRows;
    try {
      followedRows = JSON.parse(await invoke("get_followed_channels"));
    } catch (err) {
      console.error("Go-live poll: failed to load followed channels:", err);
      return;
    }
    const ids = followedRows.map((r) => r.broadcaster_id);
    if (ids.length === 0) return;

    let liveRows = [];
    try {
      liveRows = JSON.parse(await invoke("get_streams_for_users", { broadcasterIds: ids }));
    } catch (err) {
      console.error("Go-live poll: failed to load stream status:", err);
      return;
    }
    const liveById = new Map(liveRows.map((s) => [s.user_id, s]));

    // minimal shape the detector needs, deliberately built fresh rather than from this.followed
    const channels = followedRows.map((r) => {
      const live = liveById.get(r.broadcaster_id);
      return {
        login: r.broadcaster_login,
        name: r.broadcaster_name,
        live: Boolean(live),
        title: live ? live.title : "",
        game: live ? live.game_name : "",
      };
    });

    this._checkForNewlyLiveChannels(channels);
  }

  // owns updating _lastLiveState, so it's safe to call every tick. takes the channel list explicitly
  // (rather than reading this.followed) so the caller controls WHICH set is checked - the go-live
  // poller passes its own platform-independent Twitch fetch, not whatever the sidebar is displaying
  async _checkForNewlyLiveChannels(channels) {
    if (this.notifyChannels.size === 0 && this.categoryTargets.size === 0) {
      // nothing opted in, but still update the tracked state so a later opt-in has a correct
      // baseline instead of misreading first-seen as a transition
      for (const ch of channels) {
        this._lastLiveState.set(ch.login, ch.live);
        if (ch.live) this._lastGame.set(ch.login, ch.game);
      }
      return;
    }

    const newlyLive = [];
    const categoryHits = [];
    for (const ch of channels) {
      const wasLive = this._lastLiveState.get(ch.login);
      if (ch.live && wasLive === false && this.notifyChannels.has(ch.login)) {
        newlyLive.push(ch);
      }
      // target-category notification: fire when the channel switches INTO any of the categories the
      // user asked for. requires a known previous game (so we don't fire on first sighting) that
      // wasn't already the matched target.
      const targets = this.categoryTargets.get(ch.login);
      if (ch.live && targets && targets.length) {
        const prevGame = (this._lastGame.get(ch.login) || "").toLowerCase();
        const now = (ch.game || "").toLowerCase();
        const wants = targets.map((t) => t.toLowerCase());
        const prevSeen = this._lastGame.get(ch.login) !== undefined;
        // fire only when the current game matches a target AND we didn't already count it last tick
        if (wants.includes(now) && prevSeen && prevGame !== now) {
          categoryHits.push({ ...ch, target: ch.game });
        }
      }
      this._lastLiveState.set(ch.login, ch.live);
      if (ch.live) this._lastGame.set(ch.login, ch.game);
      else this._lastGame.delete(ch.login); // reset when offline so the next go-live isn't a transition
    }
    if (newlyLive.length === 0 && categoryHits.length === 0) return;

    // request permission lazily, only when there's something to notify, so a user opted into nothing never gets a prompt
    try {
      let granted = await isPermissionGranted();
      if (!granted) {
        granted = (await requestPermission()) === "granted";
      }
      if (!granted) return;
    } catch (err) {
      console.error("Notification permission check failed:", err);
      return;
    }

    for (const ch of newlyLive) {
      try {
        sendNotification({
          title: `${ch.name} is live!`,
          body: ch.title || ch.game || "Started streaming on Twitch",
        });
      } catch (err) {
        console.error(`Failed to send go-live notification for ${ch.login}:`, err);
      }
    }
    for (const ch of categoryHits) {
      try {
        sendNotification({
          title: `${ch.name} is now playing ${ch.game}`,
          body: ch.title || `Switched to ${ch.game}`,
        });
      } catch (err) {
        console.error(`Failed to send category notification for ${ch.login}:`, err);
      }
    }
  }

  // DEBUG ONLY (window.__testGoLiveNotification, see main.js): force "last seen offline" and feed a
  // live row straight into the real _checkForNewlyLiveChannels(), so detection, opt-in check, and
  // notify all fire without waiting for a channel to actually go live. works while viewing the Kick
  // side too (which is the case this whole path exists to prove), since it no longer needs the channel
  // to be present in this.followed
  async debugTestGoLiveNotification(login) {
    const targetLogin = login || [...this.notifyChannels][0];
    if (!targetLogin) {
      throw new Error(
        "No channel opted into notifications yet - click the bell on a followed channel first, or pass a login explicitly: window.__testGoLiveNotification('somechannel')"
      );
    }
    if (!this.notifyChannels.has(targetLogin)) {
      throw new Error(
        `"${targetLogin}" isn't opted into notifications - click its bell icon first, or pass a login that already is.`
      );
    }
    // use real title/game text if the channel happens to be in the current view, else synthesize a
    // minimal row (still exercises the real detection + notify path either way)
    const known = this.followed.find((c) => c.login === targetLogin);
    const ch = {
      login: targetLogin,
      name: known?.name || targetLogin,
      live: true,
      title: known?.title || "",
      game: known?.game || "",
    };
    // force "last seen offline" so the real function reads this as a genuine transition
    this._lastLiveState.set(targetLogin, false);
    console.log(`[debug] Faking go-live transition for "${targetLogin}" and re-running the real notification check...`);
    await this._checkForNewlyLiveChannels([ch]);
    console.log("[debug] Done - check your OS notifications if nothing appeared, see console for any errors logged above.");
  }

  // DEBUG ONLY (window.__testCategoryNotification, see main.js): force a "switched category"
  // transition through the real _checkForNewlyLiveChannels(), so the category-notify path fires
  // without waiting for a streamer to actually change games. Requires the channel to be opted into a
  // category (click the bell → add a category), and uses the FIRST category it's tracking as the fake
  // "new game" so it matches.
  async debugTestCategoryNotification(login) {
    const targetLogin = login || [...this.categoryTargets.keys()][0];
    if (!targetLogin) {
      throw new Error(
        "No channel has a category notification set yet - click a channel's bell and add a category first, or pass a login explicitly: window.__testCategoryNotification('somechannel')"
      );
    }
    const targets = this.categoryTargets.get(targetLogin);
    if (!targets || !targets.length) {
      throw new Error(`"${targetLogin}" has no category notifications set - add one via its bell icon first.`);
    }
    const fakeGame = targets[0]; // notify fires when the channel switches INTO a tracked category
    const known = this.followed.find((c) => c.login === targetLogin);
    const ch = {
      login: targetLogin,
      name: known?.name || targetLogin,
      live: true,
      title: known?.title || "",
      game: fakeGame,
    };
    // seed a DIFFERENT previous game so the current game reads as a genuine change into the target
    this._lastGame.set(targetLogin, "__something_else__");
    console.log(`[debug] Faking a category switch for "${targetLogin}" into "${fakeGame}" and re-running the real notification check...`);
    await this._checkForNewlyLiveChannels([ch]);
    console.log("[debug] Done - check your OS notifications if nothing appeared, see console for any errors logged above.");
  }

  // DEBUG ONLY (window.__testFireNotification): fire a notification straight through the real
  // sendNotification path, NO opt-in required. This is the simplest "does an OS notification actually
  // display right now (e.g. while minimized to tray)?" check - it bypasses detection and just proves
  // the notification plumbing + OS permission are working.
  async debugFireNotification() {
    try {
      let granted = await isPermissionGranted();
      if (!granted) granted = (await requestPermission()) === "granted";
      if (!granted) { console.warn("[debug] Notification permission not granted - can't display."); return; }
      sendNotification({ title: "Mosaic test notification", body: "If you can see this, notifications work while the window is hidden." });
      console.log("[debug] Fired a test notification. If nothing appeared, the OS is suppressing it (check Focus Assist / Do Not Disturb / notification settings).");
    } catch (err) {
      console.error("[debug] Failed to fire test notification:", err);
    }
  }

  // DEBUG ONLY (window.__notifyPollStatus): reports whether the background go-live/category poll is
  // still ticking, and how long ago the last tick ran. Use it after reopening from tray to confirm the
  // poll kept running while hidden (the tick count should have advanced).
  debugPollStatus() {
    const now = Date.now();
    const last = this._lastPollAt || 0;
    const agoSec = last ? Math.round((now - last) / 1000) : null;
    const status = {
      pollTickCount: this._pollTickCount || 0,
      lastTickAgoSeconds: agoSec,
      loggedIn: this.loggedIn,
      optedInChannels: this.notifyChannels.size,
      categoryTargets: this.categoryTargets.size,
    };
    console.log("[debug] Notify poll status:", status);
    return status;
  }

  // local follow list + one batched kick_followed_status lookup. live first, offline greyed
  // after, same rows buildChannelRow draws for Twitch. a failed lookup falls back to the stored
  // name/avatar and renders offline
  async refreshKickFollowing() {
    const follows = getKickFollows();
    if (follows.length === 0) {
      this.followed = [];
      this.renderFollowed();
      return;
    }
    let statuses = [];
    try {
      statuses = JSON.parse(
        await invoke("kick_followed_status", { slugs: follows.map((f) => f.slug) })
      );
    } catch (err) {
      console.error("Failed to load Kick following statuses:", err);
    }
    const bySlug = new Map(statuses.map((st) => [st.slug, st]));
    this.followed = follows
      .map((f) => {
        const st = bySlug.get(f.slug);
        return {
          id: `kick:${f.slug}`,
          login: f.slug,
          name: st?.name || f.name || f.slug,
          avatar: st?.avatar || f.avatar || "",
          live: Boolean(st?.is_live),
          viewers: st?.viewer_count ?? 0,
          game: st?.game || "",
          title: "",
        };
      })
      .sort((a, b) => {
        if (a.live !== b.live) return a.live ? -1 : 1;
        return (b.viewers || 0) - (a.viewers || 0);
      });
    this.renderFollowed();
    // the 60s refresh normally starts on Twitch login, but a Kick Following section wants live-state updates too
    if (!this.refreshTimer) {
      this.refreshTimer = setInterval(() => this.refresh(), REFRESH_INTERVAL_MS);
    }
  }

  async refreshTopLive() {
    let rows = [];
    try {
      rows = JSON.parse(await feedInvoke("get_top_live_streams"));
    } catch (err) {
      console.error("Failed to load top live channels:", err);
      this.topLiveListEl.innerHTML = "";
      return;
    }
    await this.renderTopLive(rows);
  }

  renderFollowed() {
    this.followedListEl.innerHTML = "";
    const kick = isKick();

    if (this.followed.length === 0) {
      if (kick) {
        const empty = document.createElement("div");
        empty.className = "sidebar-empty";
        empty.textContent = "Follow a Kick channel to pin it here.";
        this.followedListEl.appendChild(empty);
      } else if (this.loggedIn) {
        const empty = document.createElement("div");
        empty.className = "sidebar-empty";
        empty.textContent = "No followed channels yet.";
        this.followedListEl.appendChild(empty);
      }
      this.showMoreBtn.style.display = "none";
      return;
    }

    const visible = this.expanded
      ? this.followed
      : this.followed.slice(0, COLLAPSED_LIVE_COUNT);

    for (const ch of visible) {
      // the bell is wired to the Twitch poll, Kick rows don't get one (no offline->live pipeline behind their refresh)
      this.followedListEl.appendChild(
        this.buildChannelRow(ch, { showNotifyToggle: !kick })
      );
    }

    if (this.followed.length > COLLAPSED_LIVE_COUNT) {
      this.showMoreBtn.style.display = "block";
      this.showMoreBtn.textContent = this.expanded
        ? "Show Less"
        : `Show More (${this.followed.length - COLLAPSED_LIVE_COUNT})`;
    } else {
      this.showMoreBtn.style.display = "none";
    }
  }

  async renderTopLive(rows) {
    // /helix/streams has no profile images, so batch-lookup avatars for uncached ids. Kick rows
    // skip it: kick.rs embeds the avatar inline, and kick:* ids must never reach get_users_info (Helix would 400)
    for (const s of rows) {
      if (s.profile_image_url && !this.avatars.has(s.user_id)) {
        this.avatars.set(s.user_id, s.profile_image_url);
      }
    }
    const missingAvatarIds = rows
      .map((s) => s.user_id)
      .filter((id) => !this.avatars.has(id) && !String(id).startsWith("kick:"));
    if (missingAvatarIds.length > 0 && this.loggedIn) {
      try {
        const users = JSON.parse(
          await invoke("get_users_info", { userIds: missingAvatarIds })
        );
        for (const u of users) {
          this.avatars.set(u.id, u.profile_image_url);
        }
      } catch (err) {
        console.error("Failed to load top-live avatars:", err);
      }
    }

    this.topLiveListEl.innerHTML = "";
    for (const s of rows) {
      const ch = {
        id: s.user_id,
        login: s.user_login,
        name: s.user_name,
        avatar: this.avatars.get(s.user_id) || "",
        live: true,
        viewers: s.viewer_count,
        title: s.title,
        game: s.game_name,
        dropsEnabled: streamHasDropsEnabled(s),
      };
      this.topLiveListEl.appendChild(this.buildChannelRow(ch));
    }
  }

  // showNotifyToggle only for Followed rows; Top Live rows are channels the user may not follow, so a bell doesn't apply
  buildChannelRow(ch, opts = {}) {
    const btn = document.createElement("button");
    btn.className = "sidebar-channel";
    btn.addEventListener("click", () =>
      this.onChannelSelect(
        ch.login,
        ch.live
          ? {
              user_id: ch.id,
              user_name: ch.name,
              title: ch.title || "",
              tags: ch.dropsEnabled ? ["DropsEnabled"] : [],
              viewer_count: ch.viewers,
              // watchChannel() checks stream.type === "live" to decide whether to attempt playback.
              // home/browse pass Helix's raw object; this row is hand-built and was missing the field, so
              // every sidebar click read as offline. this branch only runs for a known-live row, so hardcoding "live" is correct
              type: "live",
            }
          : null
      )
    );

    const avatarWrap = document.createElement("div");
    avatarWrap.className = "sidebar-channel-avatar-wrap";

    const avatar = document.createElement("img");
    avatar.className = `sidebar-channel-avatar${ch.live ? "" : " offline"}`;
    avatar.src = ch.avatar || blankAvatarDataUri();
    avatar.alt = "";
    avatarWrap.appendChild(avatar);

    // tag live rows for the hype-train poller; the icon itself sits next to the viewer count below
    if (ch.live && ch.id) btn.dataset.hypeId = ch.id;

    btn.appendChild(avatarWrap);

    const info = document.createElement("div");
    info.className = "sidebar-channel-info";

    const name = document.createElement("div");
    name.className = `sidebar-channel-name${ch.live ? "" : " offline"}`;
    name.textContent = ch.name || ch.login;
    info.appendChild(name);

    const sub = document.createElement("div");
    sub.className = "sidebar-channel-sub";
    sub.textContent = ch.live ? ch.game || "" : "Offline";
    info.appendChild(sub);

    btn.appendChild(info);

    const status = document.createElement("div");
    status.className = `sidebar-channel-status ${ch.live ? "live" : "offline"}`;
    if (ch.live) {
      const viewerRow = document.createElement("div");
      viewerRow.className = "sidebar-channel-viewer-row";
      const dot = document.createElement("span");
      dot.className = "sidebar-live-dot";
      viewerRow.appendChild(dot);
      viewerRow.appendChild(document.createTextNode(formatViewerCount(ch.viewers)));
      // hype trains are shown as a glow on the whole row (see hype-badges.js), no inline badge
      status.appendChild(viewerRow);

      if (ch.dropsEnabled) {
        const dropsLabel = document.createElement("div");
        dropsLabel.className = "sidebar-drops-label";
        dropsLabel.textContent = "Drops";
        dropsLabel.title = "Drops Enabled";
        status.appendChild(dropsLabel);
      }
    }
    btn.appendChild(status);

    if (!opts.showNotifyToggle) {
      return btn;
    }

    // the bell must NOT nest inside `btn`: a <button> inside a <button> is invalid HTML and clicks
    // unreliably. wrap both as siblings in a plain container
    const row = document.createElement("div");
    row.className = "sidebar-channel-row";
    row.appendChild(btn);

    const notifyBtn = document.createElement("button");
    const isOn = this.notifyChannels.has(ch.login) || this.categoryTargets.has(ch.login);
    notifyBtn.className = `sidebar-notify-toggle${isOn ? " active" : ""}`;
    notifyBtn.title = isOn
      ? `Notifications on for ${ch.name || ch.login} - click to change`
      : `Notify me about ${ch.name || ch.login}`;
    notifyBtn.innerHTML =
      '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M12 22c1.1 0 2-.9 2-2h-4c0 1.1.89 2 2 2zm6-6v-5c0-3.07-1.64-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.63 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z"/></svg>';
    notifyBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.openNotifyMenu(notifyBtn, ch);
    });
    row.appendChild(notifyBtn);

    return row;
  }

  // Fleshed-out popup on the bell, in two sections: "Notify when live" (a toggle) and "Notify for
  // categories" (multiple categories as removable chips, added via a searchable input).
  openNotifyMenu(anchor, ch) {
    document.querySelector(".sidebar-notify-menu")?.remove();
    const menu = document.createElement("div");
    menu.className = "sidebar-notify-menu";

    // ---- header ----
    const header = document.createElement("div");
    header.className = "sidebar-notify-header";
    header.textContent = ch.name || ch.login;
    menu.appendChild(header);

    // ---- Section 1: Notify when live ----
    const liveSection = document.createElement("div");
    liveSection.className = "sidebar-notify-section";
    const liveRow = document.createElement("label");
    liveRow.className = "sidebar-notify-liverow";
    const liveCb = document.createElement("input");
    liveCb.type = "checkbox";
    liveCb.checked = this.notifyChannels.has(ch.login);
    const liveText = document.createElement("div");
    liveText.className = "sidebar-notify-liverow-text";
    liveText.innerHTML =
      '<div class="sidebar-notify-liverow-title">Notify when live</div>' +
      '<div class="sidebar-notify-liverow-sub">Get a notification when they start streaming</div>';
    liveCb.addEventListener("change", async () => {
      if (liveCb.checked) this.notifyChannels.add(ch.login);
      else this.notifyChannels.delete(ch.login);
      await this._saveNotifyPrefs();
      this._refreshBellState(anchor, ch);
      if (liveCb.checked) await this._ensureNotifyPermission();
    });
    liveRow.appendChild(liveCb);
    liveRow.appendChild(liveText);
    liveSection.appendChild(liveRow);
    menu.appendChild(liveSection);

    // ---- Section 2: Notify for categories ----
    const catSection = document.createElement("div");
    catSection.className = "sidebar-notify-section";
    const catTitle = document.createElement("div");
    catTitle.className = "sidebar-notify-section-title";
    catTitle.textContent = "Notify for categories";
    const catSub = document.createElement("div");
    catSub.className = "sidebar-notify-section-sub";
    catSub.textContent = "Get pinged when they switch to any of these";
    catSection.appendChild(catTitle);
    catSection.appendChild(catSub);

    // current categories, as an array we mutate then persist
    const current = [...(this.categoryTargets.get(ch.login) || [])];

    // chips container
    const chips = document.createElement("div");
    chips.className = "sidebar-notify-chips";
    catSection.appendChild(chips);

    const persist = async () => {
      if (current.length) this.categoryTargets.set(ch.login, [...current]);
      else this.categoryTargets.delete(ch.login);
      await this._saveNotifyPrefs();
      this._refreshBellState(anchor, ch);
      if (current.length) await this._ensureNotifyPermission();
    };

    const renderChips = () => {
      chips.innerHTML = "";
      if (!current.length) {
        const empty = document.createElement("div");
        empty.className = "sidebar-notify-chips-empty";
        empty.textContent = "No categories yet";
        chips.appendChild(empty);
        return;
      }
      current.forEach((name, idx) => {
        const chip = document.createElement("span");
        chip.className = "sidebar-notify-chip";
        const label = document.createElement("span");
        label.textContent = name;
        const x = document.createElement("button");
        x.type = "button";
        x.className = "sidebar-notify-chip-x";
        x.setAttribute("aria-label", `Remove ${name}`);
        x.innerHTML = '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';
        x.addEventListener("click", async () => {
          current.splice(idx, 1);
          renderChips();
          await persist();
        });
        chip.appendChild(label);
        chip.appendChild(x);
        chips.appendChild(chip);
      });
    };
    renderChips();

    // search input + suggestions
    const inputWrap = document.createElement("div");
    inputWrap.className = "sidebar-notify-cat-inputwrap";
    const catInput = document.createElement("input");
    catInput.type = "text";
    catInput.className = "sidebar-notify-cat-input";
    catInput.placeholder = "Add a category…";
    const suggestBox = document.createElement("div");
    suggestBox.className = "sidebar-notify-suggest";
    suggestBox.style.display = "none";
    inputWrap.appendChild(catInput);
    inputWrap.appendChild(suggestBox);
    catSection.appendChild(inputWrap);
    menu.appendChild(catSection);

    const addCategory = async (name) => {
      const clean = (name || "").trim();
      if (!clean) return;
      // case-insensitive dedupe
      if (current.some((c) => c.toLowerCase() === clean.toLowerCase())) {
        catInput.value = "";
        suggestBox.style.display = "none";
        return;
      }
      current.push(clean);
      renderChips();
      catInput.value = "";
      suggestBox.style.display = "none";
      await persist();
      catInput.focus();
    };

    let debounce;
    const runSearch = async () => {
      const q = catInput.value.trim();
      if (q.length < 2) { suggestBox.style.display = "none"; return; }
      let results = [];
      try { results = JSON.parse(await invoke("search_categories", { query: q })); } catch { return; }
      if (!Array.isArray(results) || !results.length) { suggestBox.style.display = "none"; return; }
      suggestBox.innerHTML = "";
      // hide ones already added
      const added = new Set(current.map((c) => c.toLowerCase()));
      const ql = q.toLowerCase();
      // Twitch's search/categories returns up to 40 matches in no useful order (roughly alphabetical,
      // NOT by popularity), so a plain slice could drop the obvious pick — e.g. "grand theft auto"
      // buries "Grand Theft Auto V" behind spin-offs. Rank by match quality first: exact name, then
      // prefix, then word-boundary, then plain substring; ties broken by shorter name (the canonical
      // title tends to be shortest). Then show a longer list so nothing prominent is lost.
      const score = (name) => {
        const n = (name || "").toLowerCase();
        if (n === ql) return 0;
        if (n.startsWith(ql)) return 1;
        if (n.includes(` ${ql}`) || n.includes(`${ql} `)) return 2;
        if (n.includes(ql)) return 3;
        return 4;
      };
      const filtered = results
        .filter((c) => !added.has((c.name || "").toLowerCase()))
        .sort((a, b) => {
          const s = score(a.name) - score(b.name);
          if (s !== 0) return s;
          return (a.name || "").length - (b.name || "").length;
        })
        .slice(0, 15);
      if (!filtered.length) { suggestBox.style.display = "none"; return; }
      for (const cat of filtered) {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "sidebar-notify-suggest-item";
        const img = document.createElement("img");
        img.src = (cat.box_art_url || "").replace("{width}", "36").replace("{height}", "48");
        img.alt = "";
        img.addEventListener("error", () => { img.style.visibility = "hidden"; });
        const nm = document.createElement("span");
        nm.textContent = cat.name;
        item.appendChild(img);
        item.appendChild(nm);
        item.addEventListener("click", () => addCategory(cat.name));
        suggestBox.appendChild(item);
      }
      suggestBox.style.display = "";
    };
    catInput.addEventListener("input", () => { clearTimeout(debounce); debounce = setTimeout(runSearch, 250); });
    catInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        // add the first suggestion if present, else the raw typed text
        const first = suggestBox.querySelector(".sidebar-notify-suggest-item span");
        addCategory(first ? first.textContent : catInput.value);
      } else if (e.key === "Escape") {
        suggestBox.style.display = "none";
      }
    });

    document.body.appendChild(menu);
    const r = anchor.getBoundingClientRect();
    const mw = menu.offsetWidth || 260;
    const mh = menu.offsetHeight || 240;
    // prefer below the bell; flip above if it would overflow the viewport bottom
    let top = r.bottom + 4;
    if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 4);
    menu.style.top = `${top}px`;
    menu.style.left = `${Math.max(8, Math.min(window.innerWidth - mw - 8, r.left - mw + 20))}px`;
    const close = (ev) => {
      if (!menu.contains(ev.target) && ev.target !== anchor) {
        menu.remove();
        document.removeEventListener("mousedown", close);
      }
    };
    setTimeout(() => document.addEventListener("mousedown", close), 0);
  }

  _refreshBellState(btn, ch) {
    const on = this.notifyChannels.has(ch.login) || this.categoryTargets.has(ch.login);
    btn.classList.toggle("active", on);
    btn.title = on
      ? `Notifications on for ${ch.name || ch.login} - click to change`
      : `Notify me about ${ch.name || ch.login}`;
  }

  async _saveNotifyPrefs() {
    try {
      await invoke("set_notify_channels", { channels: [...this.notifyChannels] });
      await invoke("set_notify_category_targets", { targets: Object.fromEntries(this.categoryTargets) });
    } catch (err) {
      console.error("Failed to save notification preferences:", err);
    }
  }

  async _ensureNotifyPermission() {
    try {
      let granted = await isPermissionGranted();
      if (!granted) await requestPermission();
    } catch (err) {
      console.error("Notification permission request failed:", err);
    }
  }
}

function formatViewerCount(n) {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}K`;
  return String(n);
}

// 1x1 transparent pixel so <img> never shows a broken-image icon for a channel with no avatar (e.g. top-live entries)
function blankAvatarDataUri() {
  return "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";
}
