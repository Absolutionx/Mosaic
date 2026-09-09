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
    // needs the Twitch follow list, which requires a Twitch login; and skip the round-trip when
    // nothing is opted in (a later opt-in seeds its own baseline on the first tick after it's added)
    if (!this.loggedIn || this.notifyChannels.size === 0) return;

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
    if (this.notifyChannels.size === 0) {
      // nothing opted in, but still update the tracked state so a later opt-in has a correct
      // baseline instead of misreading first-seen as a transition
      for (const ch of channels) this._lastLiveState.set(ch.login, ch.live);
      return;
    }

    const newlyLive = [];
    for (const ch of channels) {
      const wasLive = this._lastLiveState.get(ch.login);
      if (ch.live && wasLive === false && this.notifyChannels.has(ch.login)) {
        newlyLive.push(ch);
      }
      this._lastLiveState.set(ch.login, ch.live);
    }
    if (newlyLive.length === 0) return;

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
    const isOn = this.notifyChannels.has(ch.login);
    notifyBtn.className = `sidebar-notify-toggle${isOn ? " active" : ""}`;
    notifyBtn.title = isOn
      ? `Notifications on - click to turn off for ${ch.name || ch.login}`
      : `Notify me when ${ch.name || ch.login} goes live`;
    notifyBtn.innerHTML =
      '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M12 22c1.1 0 2-.9 2-2h-4c0 1.1.89 2 2 2zm6-6v-5c0-3.07-1.64-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.63 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z"/></svg>';
    notifyBtn.addEventListener("click", (e) => {
      // stop this also triggering btn's click (channel select), cheap insurance now that they're siblings
      e.stopPropagation();
      this.toggleNotify(ch.login, notifyBtn, ch.name || ch.login);
    });
    row.appendChild(notifyBtn);

    return row;
  }

  async toggleNotify(login, btnEl, displayName) {
    const turningOn = !this.notifyChannels.has(login);
    if (turningOn) {
      this.notifyChannels.add(login);
    } else {
      this.notifyChannels.delete(login);
    }
    btnEl.classList.toggle("active", turningOn);
    btnEl.title = turningOn
      ? `Notifications on - click to turn off for ${displayName}`
      : `Notify me when ${displayName} goes live`;

    try {
      await invoke("set_notify_channels", { channels: [...this.notifyChannels] });
    } catch (err) {
      console.error("Failed to save notification preferences:", err);
    }

    // request permission on the FIRST opt-in, not when it goes live, so a denial gives immediate feedback instead of a silent failure hours later
    if (turningOn) {
      try {
        let granted = await isPermissionGranted();
        if (!granted) await requestPermission();
      } catch (err) {
        console.error("Notification permission request failed:", err);
      }
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
