// the strip below the player (avatar, name, title, game, viewers, tags) plus the in-video
// overlay. owns its DOM/caches; watchChannel/switchPage/setStatus are injected via
// initChannelInfoBar() to avoid a circular import

import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { isKickFollowed, toggleKickFollow } from "./kick-follows.js";
import { getKickAlias, setKickAlias } from "./kick-aliases.js";
import { streamHasDropsEnabled } from "./drops.js";
import { updateDropsBanner } from "./drops-banner.js";
import { formatViewerCount } from "./format.js";
import { session } from "./session.js";

let watchChannel = () => {};
let switchPage = () => {};
let setStatus = () => {};

// call once from main.js at startup, before any bar button can be clicked
export function initChannelInfoBar(deps) {
  watchChannel = deps.watchChannel;
  switchPage = deps.switchPage;
  setStatus = deps.setStatus;
}

// runs after refreshKickAliasBtn() re-evaluates the alias button, so main.js's dev "Test failover" button can track it
let _afterAliasBtnRefresh = () => {};
export function setAfterAliasBtnRefresh(fn) {
  _afterAliasBtnRefresh = fn;
}

// exported only so main.js can hang the dev "Test failover" button next to it
export { channelInfoKickAliasBtn };

const channelInfoBar = document.getElementById("channel-info-bar");
const channelInfoAvatar = document.getElementById("channel-info-avatar");
const channelInfoName = document.getElementById("channel-info-name");
const channelInfoFollowBtn = document.getElementById("channel-info-follow-btn");
const channelInfoSubscribeBtn = document.getElementById("channel-info-subscribe-btn");
const channelInfoVideosBtn = document.getElementById("channel-info-videos-btn");
const channelInfoKickAliasBtn = document.getElementById("channel-info-kick-alias-btn");
const channelInfoViewers = document.getElementById("channel-info-viewers");
const channelInfoTitle = document.getElementById("channel-info-title");
const channelInfoTags = document.getElementById("channel-info-tags");
const streamInfoOverlay = document.getElementById("stream-info-overlay");
const streamInfoAvatar = document.getElementById("stream-info-avatar");
const streamInfoName  = document.getElementById("stream-info-name");
const streamInfoBadge  = document.getElementById("stream-info-badge");
const streamInfoTitle  = document.getElementById("stream-info-title");
const streamInfoMeta  = document.getElementById("stream-info-meta");

// cached like the other avatar maps so returning to a channel doesn't refetch
const channelInfoAvatars = new Map();

// populated alongside channelInfoAvatars so the partner badge needs no extra fetch
const channelBroadcasterTypes = new Map();
let channelInfoRefreshTimer = null;
// last (channel, stream) the bar rendered with, so resync can re-show/hide cheaply without a full re-render
let lastChannelInfo = null;

export function updateStreamInfoOverlay(channel, stream, avatarUrl, broadcasterType) {
  if (!stream || !channel) {
    streamInfoOverlay.classList.add("empty");
    return;
  }
  streamInfoAvatar.src = avatarUrl || blankAvatarDataUri();
  streamInfoName.textContent = stream.user_name || channel;
  // only for verified partners (broadcaster_type="partner")
  streamInfoBadge.style.display =
    broadcasterType === "partner" ? "inline-block" : "none";
  streamInfoTitle.textContent = stream.title || "";
  const gamePart    = stream.game_name ? `Playing ${stream.game_name}` : "";
  // full comma-formatted number ("4,373 viewers") like Twitch's overlay, vs the abbreviated "4.4K" in the tighter bar
  const viewerPart  =
    typeof stream.viewer_count === "number"
      ? `${stream.viewer_count.toLocaleString()} viewers`
      : "";
  streamInfoMeta.textContent =
    gamePart && viewerPart ? `${gamePart} for ${viewerPart}` :
    gamePart || viewerPart;
  streamInfoOverlay.classList.remove("empty");
}

// stream may be null (offline or a failed lookup): the bar still shows what's knowable
// (name, Follow/Subscribe) but omits viewer count/title/tags rather than faking them. callable
// BEFORE start_stream resolves, which is why visibility gates on session.intendedChannel (see resync)
export async function updateChannelInfoBar(channel, stream) {
  lastChannelInfo = { channel, stream };
  // both platforms offer Videos now, belt-and-braces in case any path hid it
  channelInfoVideosBtn.style.display = "";

  channelInfoName.textContent = (stream && stream.user_name) || channel;
  channelInfoTitle.textContent = (stream && stream.title) || "";
  channelInfoViewers.textContent =
    stream && typeof stream.viewer_count === "number"
      ? `${formatViewerCount(stream.viewer_count)} viewers`
      : "";

  const channelUrl = `https://www.twitch.tv/${encodeURIComponent(channel)}`;
  channelInfoFollowBtn.href = channelUrl;
  // a preceding Kick session may have left this "Following", on Twitch it's a plain link-out, always "Follow"
  channelInfoFollowBtn.textContent = "Follow";
  channelInfoFollowBtn.classList.remove("is-following");
  channelInfoSubscribeBtn.href = channelUrl;
  // sync "Link Kick" to THIS channel's alias (and re-show it, the Kick populator hides it).
  // without the per-channel refresh the label followed you across channels and a fresh channel
  // showed the default even with an alias saved
  refreshKickAliasBtn(channel);

  channelInfoTags.innerHTML = "";
  if (stream && streamHasDropsEnabled(stream)) {
    const dropsTag = document.createElement("span");
    dropsTag.className = "channel-info-tag channel-info-drops-tag";
    dropsTag.textContent = "Drops Enabled";
    channelInfoTags.appendChild(dropsTag);
  }
  for (const t of (stream && stream.tags) || []) {
    if (typeof t !== "string" || t.toLowerCase().replace(/\s+/g, "") === "dropsenabled") {
      continue; // already shown as its own styled tag above, don't duplicate
    }
    const tag = document.createElement("span");
    tag.className = "channel-info-tag";
    tag.textContent = t;
    channelInfoTags.appendChild(tag);
  }

  // show the cached avatar for this broadcaster immediately, else blank rather than keeping the
  // previous channel's. check both the id-keyed (live) and login-keyed (offline) entries
  channelInfoAvatar.src =
    (stream && stream.user_id && channelInfoAvatars.get(stream.user_id)) ||
    channelInfoAvatars.get(`login:${channel}`) ||
    blankAvatarDataUri();

  updateStreamInfoOverlay(
    channel, stream,
    channelInfoAvatar.src,
    (stream?.user_id && channelBroadcasterTypes.get(stream.user_id)) || "",
  );

  // everything above is synchronous, so resync visibility now, BEFORE the avatar fetch, so the
  // bar appears with name/title/viewers instantly. it used to be the last line (after
  // get_users_info), which held the whole bar behind that fetch
  resyncChannelInfoBarVisibility();

  // live -> stream.user_id via get_users_info (batch); offline -> only the login, via
  // get_user_by_login. cached under "login:<channel>" (distinct from the id-keyed entry) so both coexist
  const cacheKey   = (stream && stream.user_id) ? stream.user_id : `login:${channel}`;
  const alreadyHas = channelInfoAvatars.has(cacheKey);

  if (!alreadyHas) {
    try {
      let url = null;
      let broadcasterType = "";
      if (stream && stream.user_id) {
        const users = JSON.parse(await invoke("get_users_info", { userIds: [stream.user_id] }));
        url = users[0]?.profile_image_url ?? null;
        broadcasterType = users[0]?.broadcaster_type ?? "";
        if (broadcasterType) channelBroadcasterTypes.set(stream.user_id, broadcasterType);
      } else if (channel) {
        const user = JSON.parse(await invoke("get_user_by_login", { login: channel }));
        url = user?.profile_image_url ?? null;
      }
      if (url) {
        channelInfoAvatars.set(cacheKey, url);
        // only apply if this is still the intended channel: this is the tail of an await, and
        // session.intendedChannel (set synchronously in watchChannel) is the current truth, unlike
        // currentChannel (not set until start_stream resolves) or lastChannelInfo
        if (session.intendedChannel === channel) {
          channelInfoAvatar.src = url;
          updateStreamInfoOverlay(channel, stream, url, broadcasterType);
        }
      }
    } catch (err) {
      console.error("Failed to load channel info avatar:", err);
    }
  }
}

// Kick counterpart of updateChannelInfoBar: fills the SAME bar + overlay from KickLiveInfo, no
// Twitch lookups. Follow/Subscribe link out to kick.com (real actions need scopes this app
// lacks); Videos opens the same in-app VODs page (kick_channel_videos)
export function updateKickChannelInfoBar(channel, info) {
  lastChannelInfo = {
    channel,
    stream: null,
    kick: true,
    // channelInfoName.textContent isn't usable, the verified checkmark is appended inside that span so it reads "Name✓"
    displayName: info.display_name || channel,
    avatar: info.avatar || "",
  };

  channelInfoName.textContent = info.display_name || channel;
  if (info.verified) {
    const v = document.createElement("span");
    v.className = "channel-info-verified";
    v.title = "Verified";
    v.textContent = "✓";
    channelInfoName.appendChild(v);
  }
  channelInfoTitle.textContent = info.title || "";

  // viewer count only, Kick's follower count was noise next to the live number
  channelInfoViewers.textContent =
    typeof info.viewer_count === "number"
      ? `${formatViewerCount(info.viewer_count)} viewers`
      : "";

  const channelUrl = `https://kick.com/${encodeURIComponent(channel)}`;
  // aliases pair a Twitch channel to a Kick one, nothing to link on a Kick session, so hide it
  channelInfoKickAliasBtn.style.display = "none";
  _afterAliasBtnRefresh(); // hide the dev "Test failover" button too on Kick sessions
  // on Kick, Follow is a REAL in-app toggle (local list -> sidebar Following), not a link-out. href kept so middle-click/copy work
  channelInfoFollowBtn.href = channelUrl;
  const followed = isKickFollowed(channel);
  channelInfoFollowBtn.textContent = followed ? "Following" : "Follow";
  channelInfoFollowBtn.classList.toggle("is-following", followed);
  channelInfoSubscribeBtn.href = channelUrl;
  // same in-app VODs page, fetched from kick_channel_videos
  channelInfoVideosBtn.style.display = "";

  channelInfoTags.innerHTML = "";
  if (info.category) {
    // the category gets the accent-filled treatment since it's the pill people scan for, mirroring the site putting it first in green
    const cat = document.createElement("span");
    cat.className = "channel-info-tag channel-info-category-tag";
    cat.textContent = info.category;
    channelInfoTags.appendChild(cat);
  }
  const plainPills = [];
  if (info.language) plainPills.push(languageLabel(info.language));
  if (info.is_mature) plainPills.push("18+");
  for (const t of info.tags || []) {
    if (typeof t === "string" && t.trim()) plainPills.push(t.trim());
  }
  for (const text of plainPills) {
    const tag = document.createElement("span");
    tag.className = "channel-info-tag";
    tag.textContent = text;
    channelInfoTags.appendChild(tag);
  }

  channelInfoAvatar.src = info.avatar || blankAvatarDataUri();

  // synthesize the Helix-ish shape the overlay expects. Kick's verified checkmark maps onto the overlay's partner badge slot
  updateStreamInfoOverlay(
    channel,
    {
      user_name: info.display_name || channel,
      title: info.title || "",
      game_name: info.category || "",
      viewer_count: typeof info.viewer_count === "number" ? info.viewer_count : undefined,
    },
    channelInfoAvatar.src,
    info.verified ? "partner" : "",
  );

  resyncChannelInfoBarVisibility();
}

// Kick states language as a word ("English") or sometimes an ISO code ("en"), expand codes, pass words through
export function languageLabel(lang) {
  const s = String(lang).trim();
  if (!s) return "";
  if (s.length > 3) return s; // already a word
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(s.toLowerCase()) || s;
  } catch {
    return s;
  }
}

// keeps the viewer count fresh while watching, on the home feed's 60s cadence, else the bar
// would freeze at the playback-start count. isStillCurrent is re-checked each tick
export function startChannelInfoRefresh(channel, isStillCurrent) {
  if (channelInfoRefreshTimer) clearInterval(channelInfoRefreshTimer);
  channelInfoRefreshTimer = setInterval(() => {
    if (!isStillCurrent()) return;
    invoke("get_stream_for_login", { login: channel })
      .then((json) => updateChannelInfoBar(channel, JSON.parse(json)))
      .catch((err) => console.error("Failed to refresh channel info bar:", err));
  }, 60_000);
}

export function hideChannelInfoBar() {
  channelInfoBar.style.display = "none";
  lastChannelInfo = null;
  streamInfoOverlay.classList.add("empty");
  if (channelInfoRefreshTimer) {
    clearInterval(channelInfoRefreshTimer);
    channelInfoRefreshTimer = null;
  }
}

// re-show/hide the bar from its last render, no re-fetch. gated on session.intendedChannel
// (set synchronously in watchChannel), not session.playing (only true once start_stream
// resolves), which would hold the bar behind the launch wait
export function resyncChannelInfoBarVisibility() {
  if (!lastChannelInfo) return;
  channelInfoBar.style.display = session.intendedChannel !== null && !session.pageVisible ? "flex" : "none";
}

// 1x1 transparent pixel so the avatar <img> never shows a broken-image icon while loading or absent
export function blankAvatarDataUri() {
  return "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";
}

// same intercept-the-click, call openUrl() as dropsBannerLink (target="_blank" does nothing in
// a Tauri webview). both just link out to the channel page, the OAuth scope lacks write perms
// for real Follow/Subscribe actions
for (const btn of [channelInfoFollowBtn, channelInfoSubscribeBtn]) {
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    // Kick sessions: Follow is an in-app toggle (local list, sidebar re-renders via
    // onKickFollowsChange). Subscribe still links out (no local paid-sub equivalent); Twitch keeps both as link-outs
    if (btn === channelInfoFollowBtn && lastChannelInfo?.kick) {
      const slug = lastChannelInfo.channel;
      const nowFollowed = toggleKickFollow(slug, {
        name: lastChannelInfo.displayName || slug,
        avatar: lastChannelInfo.avatar || "",
      });
      btn.textContent = nowFollowed ? "Following" : "Follow";
      btn.classList.toggle("is-following", nowFollowed);
      return;
    }
    openUrl(btn.href).catch((err) => {
      console.error("Failed to open channel link in browser:", err);
    });
  });
}

// "Link Kick" (Twitch bar): shows/edits this channel's Kick failover alias, label reflects
// state. click swaps it for an inline input: Enter saves (empty clears), Escape cancels, blur
// commits (window.prompt is unreliable in Tauri)
export function refreshKickAliasBtn(channel) {
  // mid-edit: leave it alone. the bar re-populates on a 60s timer, and yanking the button back
  // next to the open editor would be worse than a one-tick-stale label. finish() re-runs this
  if (channelInfoKickAliasBtn.nextElementSibling?.classList?.contains("channel-info-alias-input")) {
    return;
  }
  channelInfoKickAliasBtn.style.display = "";
  const alias = getKickAlias(channel);
  channelInfoKickAliasBtn.textContent = alias ? `Kick: ${alias}` : "Link Kick";
  channelInfoKickAliasBtn.classList.toggle("has-alias", Boolean(alias));
  _afterAliasBtnRefresh(); // dev "Test failover" button tracks this button's visibility
}

channelInfoKickAliasBtn.addEventListener("click", () => {
  if (!lastChannelInfo || lastChannelInfo.kick) return;
  const channel = lastChannelInfo.channel;
  // already editing? (input present right after the button)
  if (channelInfoKickAliasBtn.nextElementSibling?.classList?.contains("channel-info-alias-input")) {
    return;
  }
  const input = document.createElement("input");
  input.type = "text";
  input.className = "channel-info-alias-input";
  input.placeholder = "kick channel name";
  input.value = getKickAlias(channel) || "";
  input.spellcheck = false;
  channelInfoKickAliasBtn.style.display = "none";
  channelInfoKickAliasBtn.after(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (commit) => {
    if (done) return;
    done = true;
    if (commit) {
      const ok = setKickAlias(channel, input.value);
      if (!ok) {
        setStatus(`"${input.value.trim()}" isn't a valid Kick channel name`);
      } else if (input.value.trim()) {
        setStatus(`Kick failover for ${channel} set to ${input.value.trim().toLowerCase()}`);
      } else {
        setStatus(`Kick failover link for ${channel} cleared`);
      }
    }
    input.remove();
    refreshKickAliasBtn(channel);
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") finish(true);
    else if (e.key === "Escape") finish(false);
    e.stopPropagation(); // keep player shortcuts out of the field
  });
  input.addEventListener("blur", () => finish(true));
});

channelInfoVideosBtn.addEventListener("click", () => {
  if (!lastChannelInfo) return;
  const channel = lastChannelInfo.channel;
  session.vodsChannel = channel;
  // the Kick bar stamps lastChannelInfo.kick, the Twitch bar doesn't. remembered in
  // session.vodsChannelIsKick so later re-opens fetch from the right place
  session.vodsChannelIsKick = Boolean(lastChannelInfo.kick);
  switchPage("vods");
});

// target="_blank" does nothing in a Tauri webview, so intercept the click and call openUrl().
// the href stays set (in updateDropsBanner) so it's a real, copyable <a>
