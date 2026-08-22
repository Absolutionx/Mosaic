// Channels sidebar: followed channels (live + offline) and a Live Channels list. Data via
// Rust-proxied Helix (followed, streams-for-users, users-info, top-live), since api.twitch.tv
// isn't reachable from WebView2.

import { invoke } from "@tauri-apps/api/core";
import { feedInvoke, isKick } from "./platform.js";
import { getKickFollows, onKickFollowsChange } from "./kick-follows.js";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { streamHasDropsEnabled } from "./drops.js";

const REFRESH_INTERVAL_MS = 60_000;
const COLLAPSED_LIVE_COUNT = 8;

export class ChannelsSidebar {
  /**
   * @param {object} opts
   * @param {HTMLElement} opts.followedListEl
   * @param {HTMLElement} opts.showMoreBtn
   * @param {HTMLElement} opts.loginPromptEl
   * @param {HTMLElement} opts.topLiveListEl
   * @param {(channel: string) => void} opts.onChannelSelect - lowercase login on click.
   */
  constructor({ followedListEl, showMoreBtn, loginPromptEl, topLiveListEl, onChannelSelect }) {
    this.followedListEl = followedListEl;
    this.showMoreBtn = showMoreBtn;
    this.loginPromptEl = loginPromptEl;
    this.topLiveListEl = topLiveListEl;
    this.onChannelSelect = onChannelSelect || (() => {});

    this.loggedIn = false;
    this.expanded = false;
    /** Merged followed-channel rows: {id, login, name, live, viewers, game} */
    this.followed = [];
    /** @type {Map<string, string>} user_id -> profile_image_url */
    this.avatars = new Map();

    /** @type {Set<string>} Logins opted into go-live notifications. Loaded in init()
     * (notify_prefs.rs), kept in sync on every toggle. */
    this.notifyChannels = new Set();
    /** @type {Map<string, boolean>} login -> live state as of the last refresh, compared next
     * tick to detect offline->live transitions. Without it, every refresh would re-notify all
     * already-live channels every 60s. */
    this._lastLiveState = new Map();

    this.refreshTimer = null;

    this.showMoreBtn.addEventListener("click", () => {
      this.expanded = !this.expanded;
      this.renderFollowed();
    });

    // Follow toggled from the info bar (kick-follows.js) - reflect it without waiting for the
    // 60s refresh.
    onKickFollowsChange(() => {
      if (isKick()) this.refreshKickFollowing();
    });
  }

  /** Call once login succeeds (or has already happened on startup). */
  onLogin() {
    this.loggedIn = true;
    this.loginPromptEl.style.display = "none";
    this.refresh();
    if (!this.refreshTimer) {
      this.refreshTimer = setInterval(() => this.refresh(), REFRESH_INTERVAL_MS);
    }
  }

  /** Loads the public Live Channels rail (no login needed) - call unconditionally at startup.
   * Also restores the notification opt-in set (a local file, independent of login). */
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
    await Promise.all([this.refreshFollowed(), this.refreshTopLive()]);
  }

  async refreshFollowed() {
    // Kick mode: the Following section is the LOCAL follow list (see kick-follows.js), which
    // needs no login.
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

    // get_streams_for_users and get_users_info both depend only on `ids`, so fetch them
    // concurrently. allSettled keeps each failure independent - one erroring shouldn't wipe
    // the other's data.
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
      // Live first (highest viewers), then offline alphabetically - the official sidebar's
      // default sort.
      .sort((a, b) => {
        if (a.live !== b.live) return a.live ? -1 : 1;
        if (a.live) return b.viewers - a.viewers;
        return a.name.localeCompare(b.name);
      });

    this._checkForNewlyLiveChannels();
    this.renderFollowed();
  }

  /** Compares this tick's live state against last tick's per opted-in channel and notifies
   * on offline->live. Owns updating _lastLiveState, so it's safe to call every tick. */
  async _checkForNewlyLiveChannels() {
    if (this.notifyChannels.size === 0) {
      // Nothing opted in - still update the tracked state so a later opt-in has a correct
      // baseline instead of misreading first-seen as a transition.
      for (const ch of this.followed) this._lastLiveState.set(ch.login, ch.live);
      return;
    }

    const newlyLive = [];
    for (const ch of this.followed) {
      const wasLive = this._lastLiveState.get(ch.login);
      if (ch.live && wasLive === false && this.notifyChannels.has(ch.login)) {
        newlyLive.push(ch);
      }
      this._lastLiveState.set(ch.login, ch.live);
    }
    if (newlyLive.length === 0) return;

    // Permission is requested lazily, only when there's something to notify - so a user
    // opted into nothing never gets a prompt.
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

  /** DEBUG/TESTING ONLY - triggers the real go-live path for one channel without waiting for
   * it to go live. Exposed as window.__testGoLiveNotification() (see main.js). Forces
   * _lastLiveState to false and ch.live to true, then runs the real
   * _checkForNewlyLiveChannels() - exercising the real detection, opt-in check, and notify.
   * @param {string} [login] - defaults to the first opted-in channel; must be a followed
   *   channel (production data comes from there).
   */
  async debugTestGoLiveNotification(login) {
    const targetLogin = login || [...this.notifyChannels][0];
    if (!targetLogin) {
      throw new Error(
        "No channel opted into notifications yet - click the bell on a followed channel first, or pass a login explicitly: window.__testGoLiveNotification('somechannel')"
      );
    }
    const ch = this.followed.find((c) => c.login === targetLogin);
    if (!ch) {
      throw new Error(
        `"${targetLogin}" isn't in your followed channels list right now - debugTestGoLiveNotification only works with a channel from this.followed, since that's where the notification's title/game text comes from.`
      );
    }
    if (!this.notifyChannels.has(targetLogin)) {
      throw new Error(
        `"${targetLogin}" isn't opted into notifications - click its bell icon first, or pass a login that already is.`
      );
    }
    // Force "last seen offline" so the real function reads this as a genuine transition.
    this._lastLiveState.set(targetLogin, false);
    // Also force ch.live, since _checkForNewlyLiveChannels reads it (not just _lastLiveState)
    // - a real-offline channel would otherwise never trigger.
    ch.live = true;
    console.log(`[debug] Faking go-live transition for "${targetLogin}" and re-running the real notification check...`);
    await this._checkForNewlyLiveChannels();
    console.log("[debug] Done - check your OS notifications if nothing appeared, see console for any errors logged above.");
  }

  /** Kick-mode Following: local follow list + one batched kick_followed_status lookup. Live
   * first, offline greyed after - the same rows buildChannelRow draws for Twitch. A failed
   * lookup falls back to stored name/avatar and renders offline. */
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
    // The 60s refresh normally starts on Twitch login - a Kick Following section wants
    // live-state updates too.
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
      // The bell is wired to the Twitch poll - Kick rows don't get one (no offline->live
      // pipeline behind their refresh).
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
    // /helix/streams has no profile images, so batch-lookup avatars for uncached ids. Kick
    // rows skip it: kick.rs embeds the avatar inline, and kick:* ids must never reach
    // get_users_info (Helix would 400 the batch).
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

  /**
   * @param {object} ch - channel row data (see refreshFollowed/renderTopLive)
   * @param {object} [opts]
   * @param {boolean} [opts.showNotifyToggle] - adds a go-live bell. Only for Followed rows;
   *   Top Live rows are channels the user may not follow, so it doesn't apply there.
   */
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
              // home/browse pass Helix's raw object (which has this field); this one is
              // hand-built and was missing it, so every sidebar click read as offline. This
              // branch only runs for a row known to be live, so hardcoding "live" is correct.
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

    // The bell must NOT be nested inside `btn` - a <button> inside a <button> is invalid HTML
    // and clicks unreliably. Wrap both as siblings in a plain container.
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
      // Stop this from also triggering btn's click (channel select) - cheap insurance now that
      // they're siblings.
      e.stopPropagation();
      this.toggleNotify(ch.login, notifyBtn, ch.name || ch.login);
    });
    row.appendChild(notifyBtn);

    return row;
  }

  /** Flips one channel's notification opt-in, updates the bell immediately, and persists the
   * full set via notify_prefs.rs. */
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

    // Request permission on the FIRST opt-in (not when it goes live) so a denial gives
    // immediate feedback, not a silent failure hours later.
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

/** 1x1 transparent pixel, so <img> never shows a broken-image icon for a channel with no
 *  avatar URL (e.g. top-live entries). */
function blankAvatarDataUri() {
  return "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";
}
