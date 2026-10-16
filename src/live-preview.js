// Video on hover: hovering a live stream card (Home, Browse), a channel's sidebar preview card, or a VOD card
// (Home's Continue row, a channel's Videos) plays it right there, muted and at low quality, fading in over
// the thumbnail once the first frame arrives.
// Live Twitch: get_live_preview_url, one quick token request instead of starting streamlink, with ad
// segments filtered out by the local proxy (falls back to streamlink's get_live_m3u8_url). Live Kick:
// get_kick_stream. Twitch VODs: get_vod_preview_url, the same quick token route (falls back to
// get_vod_m3u8_url). Kick VODs: kick_vod_playback. hls.js plays them in small-player mode.
// A VOD starts where you left off, or a little way in when you haven't watched it.
// Speed: the playlist is requested the moment the pointer lands on a card, video loading starts after a
// short pause (so a fast sweep across a grid loads nothing) and the picture fades in on its first frame.
// One preview at a time; it stops when the pointer leaves, on click, or when the card goes away.
// Setting: Home & MultiView › Video on hover (livePreviews).

import { invoke } from "@tauri-apps/api/core";
import { attachHlsVod, Hls } from "./vod-player.js";
import { getSetting } from "./settings.js";
import { isKick } from "./platform.js";

// rest on a card this long before video starts loading, so a fast sweep across a grid loads no video
const HOVER_DELAY_MS = 200;
// a resolved playlist URL is reused for a few minutes (hovering the same card again starts at once);
// Twitch's signed playlists stay valid much longer than this
const URL_TTL_MS = 3 * 60 * 1000;
// small-card qualities for the streamlink fallbacks: streamlink takes the first that exists
const TWITCH_QUALITY = "360p30,360p,480p30,480p,worst";
const VOD_QUALITY = "360p30,360p,480p30,480p,worst";

const urlCache = new Map(); // source key -> { url, at }
const inflight = new Map(); // same keys -> the pending lookup, so a re-hover doesn't start a second one
let active = null;          // { host, video, hls, timer, watch }

// what to play. live: { kind: "live", platform, login }. vod: { kind: "vod", videoId ("kick:<uuid>" for Kick), startAt }
function sourceKey(src) {
  return src.kind === "vod" ? `vod:${src.videoId}` : `${src.platform}:${String(src.login).toLowerCase()}`;
}

async function lookup(src) {
  if (src.kind === "vod") {
    const id = String(src.videoId);
    if (id.startsWith("kick:")) return invoke("kick_vod_playback", { videoId: id });
    try {
      return await invoke("get_vod_preview_url", { videoId: id });
    } catch (err) {
      console.warn(`[hover-preview] fast path failed for VOD ${id}, using streamlink:`, err);
      return invoke("get_vod_m3u8_url", { videoId: id, quality: VOD_QUALITY });
    }
  }
  if (src.platform === "kick") {
    const info = await invoke("get_kick_stream", { slug: src.login });
    return info?.proxied_url || null;
  }
  try {
    return await invoke("get_live_preview_url", { channel: src.login });
  } catch (err) {
    console.warn(`[hover-preview] fast path failed for ${src.login}, using streamlink:`, err);
    return invoke("get_live_m3u8_url", { channel: src.login, quality: TWITCH_QUALITY });
  }
}

function resolveUrl(src) {
  const key = sourceKey(src);
  const hit = urlCache.get(key);
  if (hit && Date.now() - hit.at < URL_TTL_MS) return Promise.resolve(hit.url);
  if (inflight.has(key)) return inflight.get(key);
  const p = lookup(src)
    .then((url) => { if (url) urlCache.set(key, { url, at: Date.now() }); return url || null; })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

// stop whatever preview is playing (or about to). safe to call any time
export function stopLivePreview() {
  const a = active;
  if (!a) return;
  active = null;
  clearTimeout(a.timer);
  clearInterval(a.watch);
  if (a.hls) { try { a.hls.destroy(); } catch {} }
  if (a.video) {
    try { a.video.pause(); a.video.removeAttribute("src"); a.video.load(); } catch {}
    a.video.remove();
  }
  a.host?.classList.remove("live-hover-playing");
}

// start a preview of `src` in `host` (the element holding the thumbnail; the video is laid over its top
// 16:9 area, inserted right after `after` so badges that follow stay on top). delay = ms to wait first
function startPreview(host, src, { after = null, delay = HOVER_DELAY_MS } = {}) {
  if (!host || !getSetting("livePreviews")) return;
  if (active && active.host === host) return; // already previewing this card
  stopLivePreview();
  const key = sourceKey(src);
  const a = { host, video: null, hls: null, timer: null, watch: null };
  active = a;
  // the card can be re-rendered away (feed refresh, navigation) without a pointerleave: stop then
  a.watch = setInterval(() => {
    if (!host.isConnected || document.hidden) stopLivePreview();
  }, 1000);
  // the lookup starts now, in parallel with the pause below
  const urlPromise = resolveUrl(src);
  urlPromise.catch(() => {}); // reported below, once the pause is over
  a.timer = setTimeout(async () => {
    let url;
    try {
      url = await urlPromise;
    } catch (err) {
      console.warn(`[hover-preview] ${key}: couldn't get the video:`, err);
      return;
    }
    if (active !== a || !url) return; // pointer left while resolving
    const video = document.createElement("video");
    video.className = "live-hover-video";
    video.muted = true;
    video.defaultMuted = true;
    video.playsInline = true;
    video.setAttribute("aria-hidden", "true");
    video.addEventListener("playing", () => { if (active === a) host.classList.add("live-hover-playing"); }, { once: true });
    if (after && after.parentNode === host) after.after(video);
    else host.prepend(video);
    a.video = video;
    const isVod = src.kind === "vod";
    a.hls = attachHlsVod(video, url, {
      // live: the live edge. VOD: where you left off, or a little way in
      startPosition: isVod ? Math.max(0, Number(src.startAt) || 0) : -1,
      liveEdge: !isVod,
      smallPlayer: true,
      logPrefix: "[hover-preview]",
      // a dead URL (stream ended, token expired): forget it so the next hover resolves afresh
      onFatalError: () => { urlCache.delete(key); if (active === a) stopLivePreview(); },
    });
    // a preview gives up quickly on a video it can't decode, instead of the endless media-error recovery
    // a full player wants
    let mediaErrors = 0;
    a.hls?.on(Hls.Events.ERROR, (_, data) => {
      if (data?.fatal && data.type === Hls.ErrorTypes.MEDIA_ERROR && ++mediaErrors > 2 && active === a) stopLivePreview();
    });
    video.play().catch(() => {});
  }, Math.max(0, delay));
}

// live stream preview (also used directly by the sidebar's hover card)
export function startLivePreview(host, login, { platform, after = null, delay = HOVER_DELAY_MS } = {}) {
  if (!login) return;
  startPreview(host, { kind: "live", platform: platform || (isKick() ? "kick" : "twitch"), login }, { after, delay });
}

function wire(card, target, start) {
  card.addEventListener("pointerenter", start);
  card.addEventListener("pointerleave", () => { if (active?.host === target) stopLivePreview(); });
  card.addEventListener("pointerdown", () => { if (active?.host === target) stopLivePreview(); });
}

// wire a live card: hover starts, leaving or clicking stops
export function attachLivePreview(card, { host, login, after = null, platform } = {}) {
  if (!card || !login) return;
  const target = host || card;
  wire(card, target, () => startLivePreview(target, login, { after, platform }));
}

// where a VOD preview starts: your saved spot, else 10% in (past the "starting soon" screen most streams
// open with), at most 10 minutes in
export function vodPreviewStart(positionSecs, totalSecs) {
  const pos = Number(positionSecs) || 0;
  const total = Number(totalSecs) || 0;
  if (pos > 0 && (!total || pos < total - 30)) return pos;
  return total > 0 ? Math.min(total * 0.1, 600) : 0;
}

// wire a VOD card
export function attachVodPreview(card, { host, videoId, startAt = 0, after = null } = {}) {
  if (!card || !videoId) return;
  const target = host || card;
  wire(card, target, () => startPreview(target, { kind: "vod", videoId: String(videoId), startAt }, { after }));
}

// leaving the window (alt-tab, minimize) stops it too
window.addEventListener("blur", () => stopLivePreview());
