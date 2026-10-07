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

// the glow is made smooth IN THE CANVAS, so it doesn't depend on the CSS blur (which WebView2 didn't apply
// together with the fade mask + scaling: the glow showed sharp streaks from the frame's top edge). the frame
// is averaged down in two steps (64x36, then 24x14: soft color zones that keep the scene's color variety,
// not detail), then drawn with the
// canvas's own blur, oversized so the edges don't darken, into the visible 192x108 glow canvas
// the glow canvas now covers the WHOLE column (192 wide, height follows the column's shape): the picture's
// edge colors are extended outward to the column's borders (like an Ambilight TV lighting the wall), and the
// CSS mask fades them from full strength at the picture to exactly zero AT the borders, however much room
// there is on each side
const W = 192, MID_W = 64, MID_H = 36, SAMPLE_W = 24, SAMPLE_H = 14;
let H = 108;
let pic = { x: 0, y: 0, w: W, h: H }; // the picture's rectangle in glow-canvas pixels
let seeded = false;                   // after a resize, the first paint is full strength (no fade-in from black)
const CANVAS_BLUR = "blur(9px)", PAD = 18, EVERY_MS = 150, BLEND = 0.35;
let video = null, host = null, wrap = null, canvas = null, ctx = null, timer = null, isPlaying = () => true;
let mid = null, midCtx = null, sample = null, sampleCtx = null;

function smallCanvas(w, h) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const x = c.getContext ? c.getContext("2d") : null;
  if (x) { x.imageSmoothingEnabled = true; x.imageSmoothingQuality = "high"; }
  return [c, x];
}

export function initAmbientGlow(opts) {
  video = opts.video;
  host = opts.host;
  isPlaying = opts.isPlaying || isPlaying;
  canvas = document.createElement("canvas");
  canvas.id = "ambient-glow";
  canvas.width = W;
  canvas.height = H;
  canvas.setAttribute("aria-hidden", "true");
  // a full-size wrapper whose EDGES fade out (CSS mask): the glow tapers off before the header, sidebar and
  // chat like it naturally does where there's room, instead of being cut off in a straight line where the
  // space around the player is narrower than the blur
  wrap = document.createElement("div");
  wrap.id = "ambient-glow-wrap";
  wrap.setAttribute("aria-hidden", "true");
  wrap.appendChild(canvas);
  host.insertBefore(wrap, host.firstChild); // host: the video column, behind the player
  ctx = canvas.getContext ? canvas.getContext("2d") : null;
  if (ctx) { ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high"; }
  [mid, midCtx] = smallCanvas(MID_W, MID_H);
  [sample, sampleCtx] = smallCanvas(SAMPLE_W, SAMPLE_H);
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
  if (!on) { ctx?.clearRect(0, 0, W, H); seeded = false; return; }
  requestAnimationFrame(place);
  if (!document.hidden) timer = setInterval(draw, EVERY_MS);
}

// the canvas covers the column; record where the picture sits in it (in canvas pixels, for drawing) and as
// percentages (CSS vars for the fade mask: it's opaque over the picture and fades out to each border)
function place() {
  if (!canvas || !host) return;
  const hr = host.getBoundingClientRect();
  if (!hr.width || !hr.height) return;
  const vr = video.getBoundingClientRect();
  const box = pictureBox(hr.width, hr.height, video.videoWidth, video.videoHeight,
    vr.width && vr.height ? { left: vr.left - hr.left, top: vr.top - hr.top, width: vr.width, height: vr.height } : null);
  const newH = Math.max(27, Math.round(W * hr.height / hr.width));
  if (newH !== H || canvas.height !== newH) { H = newH; canvas.width = W; canvas.height = H; seeded = false; }
  const sx = W / hr.width, sy = H / hr.height;
  pic = { x: box.left * sx, y: box.top * sy, w: box.width * sx, h: box.height * sy };
  const pct = (v) => `${Math.max(0, Math.min(100, v * 100)).toFixed(3)}%`;
  canvas.style.setProperty("--pt", pct(box.top / hr.height));
  canvas.style.setProperty("--pb", pct((box.top + box.height) / hr.height));
  canvas.style.setProperty("--pl", pct(box.left / hr.width));
  canvas.style.setProperty("--pr", pct((box.left + box.width) / hr.width));
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
    // 1. average the frame down into a few soft color zones (two steps average better than one jump)
    midCtx.drawImage(video, 0, 0, MID_W, MID_H);
    sampleCtx.drawImage(mid, 0, 0, SAMPLE_W, SAMPLE_H);
    // 2. paint it soft into the glow, blending toward it so colors drift smoothly: the picture area (it feeds
    // the blur at the picture's edges), then the edge rows / columns stretched out to the borders
    const { x, y, w, h } = pic, P = PAD;
    ctx.globalAlpha = seeded ? BLEND : 1;
    seeded = true;
    if ("filter" in ctx) ctx.filter = CANVAS_BLUR;
    ctx.drawImage(sample, x - P, y - P, w + P * 2, h + P * 2);
    ctx.drawImage(sample, 0, 0, SAMPLE_W, 1, x - P, -P, w + P * 2, y + P + 1);                                  // top edge -> up
    ctx.drawImage(sample, 0, SAMPLE_H - 1, SAMPLE_W, 1, x - P, y + h - 1, w + P * 2, H - (y + h) + P + 1);      // bottom edge -> down
    if (x > 0.5) ctx.drawImage(sample, 0, 0, 1, SAMPLE_H, -P, y - P, x + P + 1, h + P * 2);                      // left edge -> left
    if (W - (x + w) > 0.5) ctx.drawImage(sample, SAMPLE_W - 1, 0, 1, SAMPLE_H, x + w - 1, y - P, W - (x + w) + P + 1, h + P * 2); // right
    if ("filter" in ctx) ctx.filter = "none";
    ctx.globalAlpha = 1;
  } catch { /* frame not drawable yet */ }
}
