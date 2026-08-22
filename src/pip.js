// Controller for pip.html, the always-on-top PiP window. A separate webview, so everything
// arrives via query params from enterNativePip() (mode, src, pos, volume, muted, channel).
// Self-sufficient - the main window mutes while it exists and restores on close.

import { getCurrentWindow, currentMonitor, availableMonitors, primaryMonitor, PhysicalPosition, PhysicalSize } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { attachMseStream } from "./stream-player.js";
import { attachHlsVod } from "./vod-player.js";

const params  = new URLSearchParams(location.search);
// Platform theming: body.kick-mode flips --accent to Kick green (the volume slider uses
// it). Applied at parse time so the slider never flashes purple.
if (params.get("kick") === "1") document.body.classList.add("kick-mode");
const mode    = params.get("mode") || "live";
const src     = params.get("src") || "";
const pos     = parseFloat(params.get("pos") || "0") || 0;
const volume  = Math.min(1, Math.max(0, parseFloat(params.get("volume") ?? "1")));
const muted   = params.get("muted") === "1";
const channel = params.get("channel") || "";
const lowSrc  = params.get("lowsrc") || "";
const mvChannel = params.get("mvchannel") || "";
const mvQuality = params.get("mvquality") || "best";

const videoEl   = document.getElementById("pip-video");
const playBtn   = document.querySelector('[data-act="playpause"]');
const muteBtn   = document.querySelector('[data-act="mute"]');
const volSlider = document.querySelector('[data-act="volume"]');
const closeBtn  = document.getElementById("pip-close");
const pauseIcon = playBtn.querySelector(".docpip-pause-icon");
const playIcon  = playBtn.querySelector(".docpip-play-icon");
const volIcon   = muteBtn.querySelector(".docpip-vol-icon");
const mutedIcon = muteBtn.querySelector(".docpip-muted-icon");

if (channel) {
  getCurrentWindow().setTitle(`PiP - ${channel}`).catch(() => {});
  document.title = `PiP - ${channel}`;
}

videoEl.volume = volume;
videoEl.muted = muted;
volSlider.value = String(volume);

// Window placement: reopen where last closed, else bottom-right of the current monitor.
// Created hidden (see enterNativePip) so this runs before anything shows. Position/size
// persist via localStorage (shared same-origin with the main window), saved from move/resize
// events, so no close-time hook is needed.

const pipWin = getCurrentWindow();

async function placeWindow() {
  try {
    const savedSize = JSON.parse(localStorage.getItem("pipWinSize") || "null");
    if (savedSize && Number.isFinite(savedSize.width) && Number.isFinite(savedSize.height)
        && savedSize.width >= 160 && savedSize.height >= 90) {
      await pipWin.setSize(new PhysicalSize(savedSize.width, savedSize.height));
    }
    const saved = JSON.parse(localStorage.getItem("pipWinPos") || "null");
    let placed = false;
    if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
      // Only restore a position still on SOME monitor - a spot on an unplugged display would be
      // unreachable. 50px of the top-left visible is enough to grab it.
      const monitors = await availableMonitors().catch(() => []);
      const onScreen = monitors.some((m) =>
        saved.x >= m.position.x - 50 && saved.x < m.position.x + m.size.width - 50 &&
        saved.y >= m.position.y - 50 && saved.y < m.position.y + m.size.height - 50);
      if (onScreen) {
        await pipWin.setPosition(new PhysicalPosition(saved.x, saved.y));
        placed = true;
      }
    }
    if (!placed) {
      const mon = await currentMonitor();
      if (mon) {
        const size = await pipWin.outerSize();
        const margin = Math.round(24 * (mon.scaleFactor || 1));
        await pipWin.setPosition(new PhysicalPosition(
          mon.position.x + mon.size.width - size.width - margin,
          mon.position.y + mon.size.height - size.height - margin,
        ));
      }
    }
  } catch (err) {
    console.warn("[pip] window placement failed (showing at default position):", err);
  } finally {
    // The finally is load-bearing: the window was created invisible, so failing to reach show()
    // leaves a playing-but-unseeable zombie.
    await pipWin.show().catch(() => {});
  }
}
placeWindow();

pipWin.onMoved(({ payload }) => {
  try { localStorage.setItem("pipWinPos", JSON.stringify({ x: payload.x, y: payload.y })); } catch (_) {}
});

// Off-screen watchdog. placeWindow's check only runs at open; if the monitor goes away
// while open (dock unplugged), this frameless/always-on-top/skip-taskbar window is stranded.
// Tauri has no hotplug event, so poll: if the top-left isn't on any monitor, hop to the
// primary's bottom-right (heals the persisted position via onMoved). Can't detect an
// input-switched-but-connected display - the main window's rescue button covers that.

const OFFSCREEN_POLL_MS = 5000;
let offscreenRescueBusy = false;
setInterval(async () => {
  if (offscreenRescueBusy) return;
  offscreenRescueBusy = true;
  try {
    const [pos, size, monitors] = await Promise.all([
      pipWin.outerPosition().catch(() => null),
      pipWin.outerSize().catch(() => null),
      availableMonitors().catch(() => []),
    ]);
    // No monitors reported reads as a transient enumeration failure, not "all displays gone" -
    // don't move on it.
    if (!pos || !size?.width || !monitors.length) return;
    const onScreen = monitors.some((m) =>
      pos.x >= m.position.x - 50 && pos.x < m.position.x + m.size.width - 50 &&
      pos.y >= m.position.y - 50 && pos.y < m.position.y + m.size.height - 50);
    if (onScreen) return;
    const mon = (await primaryMonitor().catch(() => null)) || monitors[0];
    console.warn("[pip] window is off every available monitor - relocating to", mon.name || "primary monitor");
    const margin = Math.round(24 * (mon.scaleFactor || 1));
    await pipWin.setPosition(new PhysicalPosition(
      mon.position.x + mon.size.width - size.width - margin,
      mon.position.y + mon.size.height - size.height - margin,
    ));
    await pipWin.show().catch(() => {}); // in case the OS hid us with the display
  } catch (_) {
    // Transient failure - the next tick tries again.
  } finally {
    offscreenRescueBusy = false;
  }
}, OFFSCREEN_POLL_MS);

// Aspect-ratio snap. The video is object-fit:contain, so a mismatched window shows black
// bars. Correcting during a drag fights the user (shudders), so snap ONCE after the last
// resize event: keep whichever dimension changed proportionally more, recompute the other
// from the video's real aspect (from loadedmetadata, so vertical VODs snap vertical). Also
// runs on metadata arrival, squaring up a stale saved size.

const SNAP_MIN_WIDTH = 192;   // ~192x108 at 16:9; matches the window's minWidth
let videoAspect = 16 / 9;     // assumed until loadedmetadata reports the truth
let lastSize = null;          // most recent onResized payload (physical px)
let preDragSize = null;       // size when the current resize burst began
let snapTimer = null;
let suppressSnapUntil = 0;    // our own setSize fires onResized too - ignore it

async function snapToAspect(keepAxis) {
  const size = lastSize || (await pipWin.innerSize().catch(() => null));
  if (!size?.width || !size?.height) return;
  let w = size.width, h = size.height;
  if (keepAxis === "height") w = Math.round(h * videoAspect);
  else h = Math.round(w / videoAspect);
  if (w < SNAP_MIN_WIDTH) { w = SNAP_MIN_WIDTH; h = Math.round(w / videoAspect); }
  // Within a pixel already - not worth a nudge (and rounding must not become a snap loop).
  if (Math.abs(w - size.width) <= 1 && Math.abs(h - size.height) <= 1) return;
  suppressSnapUntil = Date.now() + 300;
  lastSize = { width: w, height: h };
  try {
    // If the snap grows the window past the screen edge (setSize anchors the top-left, so
    // growth is down/right), shift it back on-screen.
    const [pos, mon] = await Promise.all([pipWin.outerPosition(), currentMonitor()]);
    if (pos && mon) {
      const maxX = mon.position.x + mon.size.width;
      const maxY = mon.position.y + mon.size.height;
      const nx = pos.x + w > maxX ? Math.max(mon.position.x, maxX - w) : pos.x;
      const ny = pos.y + h > maxY ? Math.max(mon.position.y, maxY - h) : pos.y;
      if (nx !== pos.x || ny !== pos.y) await pipWin.setPosition(new PhysicalPosition(nx, ny));
    }
  } catch (_) {}
  await pipWin.setSize(new PhysicalSize(w, h)).catch(() => {});
}

pipWin.onResized(({ payload }) => {
  try { localStorage.setItem("pipWinSize", JSON.stringify({ width: payload.width, height: payload.height })); } catch (_) {}
  const prev = lastSize;
  lastSize = { width: payload.width, height: payload.height };
  if (Date.now() < suppressSnapUntil) return; // echo of our own corrective setSize
  if (!preDragSize) preDragSize = prev || lastSize;
  clearTimeout(snapTimer);
  snapTimer = setTimeout(() => {
    const from = preDragSize;
    preDragSize = null;
    // Which axis did the user drag? Compare proportional deltas so 40px on a wide window
    // doesn't outvote 40px on a short one. Corner drags land where they pulled hardest.
    const dw = Math.abs(lastSize.width - from.width) / Math.max(1, from.width);
    const dh = Math.abs(lastSize.height - from.height) / Math.max(1, from.height);
    snapToAspect(dh > dw ? "height" : "width");
  }, 150);
});

videoEl.addEventListener("loadedmetadata", () => {
  if (videoEl.videoWidth > 0 && videoEl.videoHeight > 0) {
    videoAspect = videoEl.videoWidth / videoEl.videoHeight;
  }
  // Square up whatever placeWindow restored (saved sizes can predate this or be a
  // different-aspect video) - keep the width, recompute the height.
  snapToAspect("width");
});

let feeder = null;
// Live-relay self-healing: the relay deliberately CLOSES a lagging subscriber (see
// stream_relay.rs; closing beats splicing a byte gap), and a fresh PiP is the likeliest to
// lag. So dying is expected - reattach, and the relay's fragment-aligned late-join hands each
// reconnect a clean stream. Budgeted so a genuinely-gone relay doesn't retry forever.
let deadRetries = 0;
let lastDeadAt = 0;
function attachLiveFeeder() {
  feeder = attachMseStream(videoEl, src, {
    isVod: false,
    onFatalError: () => handleFeederDeath("MSE pipeline failed"),
    onDead: (reason) => handleFeederDeath(reason),
  });
}

// MultiView PiP: resolve the live HLS m3u8 ourselves (channel/quality come as params, the
// URL is too big to pass), then play via attachHlsVod like MultiView tiles.
async function attachMvLiveFeeder() {
  let url;
  try {
    url = await invoke("get_live_m3u8_url", { channel: mvChannel, quality: mvQuality });
  } catch (err) {
    console.error("[pip:mv] couldn't resolve stream:", err);
    return;
  }
  feeder = attachHlsVod(videoEl, url, {
    startPosition: -1, // live edge
    onFatalError: () => handleFeederDeath("HLS pipeline failed"),
    smallPlayer: true,
    logPrefix: "[pip:mv]",
  });
}
function handleFeederDeath(reason) {
  const now = Date.now();
  if (now - lastDeadAt > 60_000) deadRetries = 0; // a healthy minute resets the budget
  if (deadRetries >= 5) {
    console.error(`[pip] stream died (${reason}) and retry budget is exhausted - giving up. Close and reopen PiP to retry.`);
    return;
  }
  deadRetries++;
  lastDeadAt = now;
  const delay = Math.min(1000 * deadRetries, 5000);
  console.warn(`[pip] stream died (${reason}) - reattaching in ${delay}ms (attempt ${deadRetries}/5)`);
  try { feeder?.stop?.(); } catch (_) {}
  setTimeout(() => attachLiveFeeder(), delay);
}
function attachVodFeeder(url, isLowQuality) {
  feeder = attachHlsVod(videoEl, url, {
    startPosition: mode === "vod" && videoEl.currentTime > 0 ? videoEl.currentTime : pos,
    onFatalError: (data) => {
      if (isLowQuality) {
        // The pre-resolved low-quality URL can outlive its token or 404 in ways the main-quality
        // URL can't - fall back to that known-good URL once rather than dying.
        console.warn("[pip] low-quality playlist failed - falling back to main-quality URL:", data?.details);
        try { feeder?.destroy?.(); } catch (_) {}
        attachVodFeeder(src, false);
      } else {
        console.error("[pip] hls.js fatal:", data);
      }
    },
    smallPlayer: true,
    logPrefix: "[pip:hls]",
  });
}
if (mode === "mv") {
  // mv resolves its own URL from mvchannel/mvquality (no src param).
  try { attachMvLiveFeeder(); }
  catch (err) { console.error("[pip] mv feeder attach failed:", err); }
} else if (src) {
  try {
    if (mode === "vod") {
      // Prefer the pre-resolved low-quality playlist (right-sized segments for a small window -
      // see resolvePipVodUrl); src is the fallback.
      attachVodFeeder(lowSrc || src, Boolean(lowSrc));
    } else {
      attachLiveFeeder();
    }
  } catch (err) {
    // A feeder failure must not skip the control wiring below, or the window becomes
    // uncloseable.
    console.error("[pip] feeder attach failed:", err);
  }
} else {
  console.error("[pip] opened without a src param - nothing to play.");
}

// controls (mirrors enterDocPip's controls bar, minus the parts that only make sense
// sharing the main window's video element)

function syncPlayIcon() {
  pauseIcon.style.display = videoEl.paused ? "none" : "";
  playIcon.style.display  = videoEl.paused ? "" : "none";
}
function syncMuteIcon() {
  volIcon.style.display   = videoEl.muted ? "none" : "";
  mutedIcon.style.display = videoEl.muted ? "" : "none";
}
videoEl.addEventListener("play", syncPlayIcon);
videoEl.addEventListener("pause", syncPlayIcon);
videoEl.addEventListener("volumechange", syncMuteIcon);
syncPlayIcon();
syncMuteIcon();

function togglePlayPause() {
  if (videoEl.paused) videoEl.play().catch(() => {});
  else videoEl.pause();
}
playBtn.addEventListener("click", togglePlayPause);

// Double-click the stage = play/pause, NOT maximize. The stage is a drag-region, and
// Tauri maps a double-click on one to toggle_maximize - nonsense here (the restore resize
// collides with the aspect-snap). A CAPTURE listener runs before Tauri's bubble one;
// stopImmediatePropagation blocks it. Matches Tauri's condition exactly so the control
// buttons (no drag-region attr) are untouched.
document.addEventListener("mousedown", (e) => {
  if (e.detail === 2 && e.button === 0 && e.target?.hasAttribute?.("data-tauri-drag-region")) {
    e.preventDefault();
    e.stopImmediatePropagation();
    togglePlayPause();
  }
}, true);
muteBtn.addEventListener("click", () => { videoEl.muted = !videoEl.muted; });
const volBubble = document.getElementById("pip-vol-bubble");
function showVolBubble(fraction, pct) {
  const sliderRect = volSlider.getBoundingClientRect();
  const barRect = volSlider.parentElement.getBoundingClientRect();
  volBubble.style.left = `${sliderRect.left - barRect.left + fraction * sliderRect.width}px`;
  volBubble.textContent = `${pct}%`;
  volBubble.style.display = "block";
}
volSlider.addEventListener("input", () => {
  videoEl.volume = parseFloat(volSlider.value);
  if (videoEl.volume > 0) videoEl.muted = false;
  // While dragging, the bubble tracks the THUMB (the value being set), not the raw pointer
  // x - identical mid-bar, but stays correct when the pointer overshoots.
  const v = parseFloat(volSlider.value);
  showVolBubble(v, Math.round(v * 100));
});
volSlider.addEventListener("mousemove", (e) => {
  const rect = volSlider.getBoundingClientRect();
  const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  showVolBubble(frac, Math.round(frac * 100));
});
volSlider.addEventListener("mouseleave", () => { volBubble.style.display = "none"; });
closeBtn.addEventListener("click", () => {
  getCurrentWindow().close().catch(() => {});
});

// Tear the feeder down on pagehide so the relay subscription / hls.js instance doesn't
// linger between the page dying and the process exiting.
window.addEventListener("pagehide", () => {
  try { feeder?.stop?.(); feeder?.destroy?.(); } catch (_) {}
});
