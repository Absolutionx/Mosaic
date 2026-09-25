// Twitch clip links in chat become clip cards (thumbnail, title, channel, views, length, clipper) that play
// in an in-app player instead of opening the browser. Used by _createChatLink (chat-link-preview.js).
//
// - details: get_clip_info (Helix, needs login). no details (logged out, deleted clip, error) -> the plain
//   link stays, so nothing is ever lost
// - the card is rendered at its final size straight away (a loading skeleton), so filling it in never
//   shifts chat and can't push the newest line out of view while chat is following
// - playback: resolve_clip_url (streamlink) resolves the clip and returns it routed through the local
//   server: an MP4 via /clip-proxy (streamed, Range-aware, Twitch-player headers) or an HLS playlist via
//   /hls-proxy, played with hls.js. the main stream is muted while a clip plays and restored on close

import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import Hls from "hls.js";

// clips.twitch.tv/<slug>, clips.twitch.tv/embed?clip=<slug>, (www.|m.)twitch.tv/<channel>/clip/<slug>
const CLIP_RES = [
  /^https?:\/\/clips\.twitch\.tv\/(?:embed\?(?:.*&)?clip=)?([A-Za-z0-9_-]{4,100})(?:[/?#&]|$)/i,
  /^https?:\/\/(?:www\.|m\.)?twitch\.tv\/[A-Za-z0-9_]{1,25}\/clip\/([A-Za-z0-9_-]{4,100})(?:[/?#]|$)/i,
];

export function parseClipSlug(url) {
  for (const re of CLIP_RES) {
    const m = re.exec(url || "");
    if (m && m[1] !== "embed") return m[1];
  }
  return null;
}

// slug -> Promise<info|null>, shared by every card for the same clip (busy chats repeat the same link)
const infoCache = new Map();
const INFO_CACHE_MAX = 300;
function getClipInfo(slug) {
  if (infoCache.has(slug)) return infoCache.get(slug);
  const p = invoke("get_clip_info", { slug }).catch(() => null);
  infoCache.set(slug, p);
  if (infoCache.size > INFO_CACHE_MAX) infoCache.delete(infoCache.keys().next().value);
  return p;
}

function fmtViews(n) {
  n = Number(n) || 0;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}K`;
  return String(n);
}
function fmtDuration(sec) {
  const s = Math.round(Number(sec) || 0);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

const PLAY_SVG = '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M8 5v14l11-7z" fill="currentColor"/></svg>';

// Returns the element to put in the message in place of the link. `linkEl` is the ordinary chat link,
// used as the fallback when the clip's details can't be loaded.
export function buildClipCard(slug, linkEl) {
  const card = document.createElement("span");
  card.className = "chat-clip-card is-loading";
  card.setAttribute("role", "button");
  card.tabIndex = 0;
  card.title = "Play clip";
  card.innerHTML =
    '<span class="chat-clip-thumb"><span class="chat-clip-play">' + PLAY_SVG + "</span></span>" +
    '<span class="chat-clip-meta"><span class="chat-clip-title"></span><span class="chat-clip-sub"></span></span>';

  getClipInfo(slug).then((info) => {
    if (!info || !info.title) {
      card.replaceWith(linkEl); // no details: keep it a normal link
      return;
    }
    card.classList.remove("is-loading");
    const thumb = card.querySelector(".chat-clip-thumb");
    if (info.thumbnail) {
      const img = document.createElement("img");
      img.alt = "";
      img.loading = "lazy";
      img.src = info.thumbnail;
      img.onerror = () => img.remove();
      thumb.prepend(img);
    }
    const dur = document.createElement("span");
    dur.className = "chat-clip-dur";
    dur.textContent = fmtDuration(info.duration);
    thumb.appendChild(dur);
    card.querySelector(".chat-clip-title").textContent = info.title;
    card.querySelector(".chat-clip-sub").textContent =
      `${info.channel || ""} · ${fmtViews(info.views)} views` + (info.creator ? ` · clipped by ${info.creator}` : "");
    const open = (e) => {
      e.preventDefault();
      e.stopPropagation();
      openClipPlayer(info);
    };
    card.addEventListener("click", open);
    card.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") open(e); });
  });
  return card;
}

// ---- in-app clip player ----
let playerEl = null;
let restoreMain = null;
let hls = null;

export function closeClipPlayer() {
  if (!playerEl) return;
  if (hls) { hls.destroy(); hls = null; }
  const v = playerEl.querySelector("video");
  if (v) { v.pause(); v.removeAttribute("src"); v.load(); }
  playerEl.remove();
  playerEl = null;
  document.removeEventListener("keydown", onKey, true);
  if (restoreMain) { restoreMain(); restoreMain = null; }
}

function onKey(e) {
  if (e.key === "Escape") { e.stopPropagation(); closeClipPlayer(); }
}

export async function openClipPlayer(info) {
  closeClipPlayer();
  // mute the stream you're watching while the clip plays; put it back exactly as it was on close
  const main = document.getElementById("video-element");
  if (main && !main.muted) {
    main.muted = true;
    restoreMain = () => { main.muted = false; };
  }

  const el = document.createElement("div");
  el.className = "clip-player-backdrop";
  el.innerHTML =
    '<div class="clip-player" role="dialog" aria-modal="true" aria-label="Clip">' +
      '<div class="clip-player-head"><div class="clip-player-titles"><div class="clip-player-title"></div>' +
      '<div class="clip-player-sub"></div></div>' +
      '<button type="button" class="clip-player-close" aria-label="Close" title="Close (Esc)">' +
      '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg></button></div>' +
      '<div class="clip-player-stage"><video class="clip-player-video" controls playsinline></video>' +
      '<div class="clip-player-status">Loading clip…</div></div>' +
      '<div class="clip-player-foot"><button type="button" class="clip-player-open">Open on Twitch</button></div>' +
    "</div>";
  el.querySelector(".clip-player-title").textContent = info.title || "Clip";
  el.querySelector(".clip-player-sub").textContent =
    `${info.channel || ""} · ${fmtViews(info.views)} views` + (info.creator ? ` · clipped by ${info.creator}` : "");
  el.addEventListener("mousedown", (e) => { if (e.target === el) closeClipPlayer(); }); // click outside
  el.querySelector(".clip-player-close").addEventListener("click", closeClipPlayer);
  el.querySelector(".clip-player-open").addEventListener("click", () => {
    const url = info.url || `https://clips.twitch.tv/${info.slug}`;
    openUrl(url).catch(() => {});
  });
  document.body.appendChild(el);
  playerEl = el;
  document.addEventListener("keydown", onKey, true);

  const video = el.querySelector("video");
  const status = el.querySelector(".clip-player-status");
  const fail = (msg, detail) => {
    if (playerEl !== el) return;
    console.error("[clip-player]", msg, detail || "");
    status.textContent = msg;
    status.style.display = "";
  };
  let res;
  try {
    res = await invoke("resolve_clip_url", { slug: info.slug });
  } catch (err) {
    fail("Couldn't load this clip. Try Open on Twitch.", err);
    return;
  }
  if (playerEl !== el) return; // closed (or another clip opened) while resolving
  const src = res && typeof res === "object" ? res.url : res;
  const kind = res && typeof res === "object" ? res.kind : "mp4";
  video.addEventListener("playing", () => { status.style.display = "none"; }, { once: true });
  video.addEventListener("error", () => {
    const code = video.error ? video.error.code : "?";
    fail(`Couldn't play this clip here (error ${code}). Try Open on Twitch.`,
      { kind, code, message: video.error && video.error.message, src });
  }, { once: true });
  if (kind === "hls" && Hls.isSupported()) {
    hls = new Hls({ enableCEA708Captions: false, subtitleDisplay: false }); // no auto-shown captions (see vod-player.js)
    hls.on(Hls.Events.ERROR, (_e, data) => {
      if (data && data.fatal) fail("Couldn't play this clip here. Try Open on Twitch.", data);
    });
    hls.loadSource(src);
    hls.attachMedia(video);
  } else {
    video.src = src;
  }
  await video.play().catch(() => {}); // autoplay can be refused; the controls still work
}
