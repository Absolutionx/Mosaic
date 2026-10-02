// Ambient glow (Settings > Player, off by default): a soft glow around the video that follows the stream's
// colors, like YouTube's ambient mode / a TV's bias lighting.
//
// A few times a second the current frame is drawn into a tiny canvas (48x27) placed under the picture in the
// video column; CSS scales it up and blurs it heavily, so it spills into the dark space around the player
// (above / below it, and the letterbox bars) without shrinking the picture. The column clips it, so it never
// reaches the chat or sidebar. Each update blends 35% toward the new frame, so colors drift instead of
// flickering. Costs ~7 tiny drawImage calls a second; nothing runs when off, paused, or hidden. Only drawing
// happens (no pixel reads), so cross-origin video is fine.

import { getSetting, onSettingChange } from "./settings.js";
import { pictureBox } from "./chat-overlay.js";

const W = 48, H = 27, EVERY_MS = 150, BLEND = 0.35;
let video = null, host = null, canvas = null, ctx = null, timer = null, isPlaying = () => true;

export function initAmbientGlow(opts) {
  video = opts.video;
  host = opts.host;
  isPlaying = opts.isPlaying || isPlaying;
  canvas = document.createElement("canvas");
  canvas.id = "ambient-glow";
  canvas.width = W;
  canvas.height = H;
  canvas.setAttribute("aria-hidden", "true");
  host.insertBefore(canvas, host.firstChild); // host: the video column, behind the player
  ctx = canvas.getContext ? canvas.getContext("2d") : null;
  onSettingChange((id) => { if (id === "ambientGlow") apply(); });
  for (const ev of ["loadedmetadata", "resize", "playing"]) video.addEventListener(ev, place);
  video.addEventListener("emptied", () => { ctx?.clearRect(0, 0, W, H); });
  new ResizeObserver(() => place()).observe(host);
  document.addEventListener("visibilitychange", apply);
  apply();
}

export function glowEnabled() { return (getSetting("ambientGlow") || "off") !== "off"; }

function apply() {
  const mode = getSetting("ambientGlow") || "off";
  const on = mode !== "off";
  document.body.classList.toggle("ambient-glow", on);
  document.body.dataset.ambient = mode;
  clearInterval(timer);
  timer = null;
  if (!on) { ctx?.clearRect(0, 0, W, H); return; }
  requestAnimationFrame(place);
  if (!document.hidden) timer = setInterval(draw, EVERY_MS);
}

// cover the picture (not the letterbox bars), relative to the column: CSS then scales + blurs it beyond
// the picture's edges into the space around the player
function place() {
  if (!canvas || !host) return;
  const hr = host.getBoundingClientRect();
  const vr = video.getBoundingClientRect();
  const box = pictureBox(hr.width, hr.height, video.videoWidth, video.videoHeight,
    vr.width && vr.height ? { left: vr.left - hr.left, top: vr.top - hr.top, width: vr.width, height: vr.height } : null);
  Object.assign(canvas.style, { left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px` });
}

// Home / Browse / the VOD page cover the column while open
function inOtherPage() {
  return ["home-feed", "browse-page", "vods-page"].some((id) => {
    const p = document.getElementById(id);
    return p && p.style.display !== "none" && p.getClientRects().length > 0;
  });
}

export function draw() {
  if (!ctx || !video || document.hidden || !glowEnabled()) return;
  // only while the stream is in the player itself: not behind Home / Browse, nor in the mini player
  const inPlayer = isPlaying() && video.closest("#video-region") && video.getClientRects().length > 0 && !inOtherPage();
  if (!inPlayer) { canvas.classList.add("idle"); return; }
  if (canvas.classList.contains("idle")) { canvas.classList.remove("idle"); place(); }
  if (video.paused || video.readyState < 2) return; // keep the last glow while paused / buffering
  try {
    ctx.globalAlpha = BLEND;
    ctx.drawImage(video, 0, 0, W, H);
    ctx.globalAlpha = 1;
  } catch { /* frame not drawable yet */ }
}
