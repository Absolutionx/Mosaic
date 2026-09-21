// In-app floating stream preview ("mini player").
//
// When a stream is playing and you navigate to Home / Browse / VODs, the page modules hide the video
// frame (inline display:none) but the stream keeps running in the background. This controller instead
// shows that SAME #video-frame as a small draggable box pinned bottom-right, so you can keep an eye on
// the stream while browsing. It's the same DOM element and the same running stream — nothing is
// duplicated, no second connection is opened.
//
// How it coexists with the pages' inline display:none: activating adds .mini-player-active to #app,
// and the CSS for that class forces the frame visible + floating with !important, which beats the
// inline style the pages set. Deactivating removes the class and the inline style takes over again.
//
// Controls: drag to move, an expand button and a click both return to the full stream, an X closes
// the preview for the current browsing session (until you return to the stream and leave again).

import { session } from "./session.js";

const POS_KEY = "miniPlayerPos"; // {right, bottom} in px, persisted so it reopens where dragged

let appEl = null;
let frameEl = null;      // #video-frame — the element we relocate
let overlayEl = null;    // our controls overlay layered on top of the frame while floating
let onExpand = null;     // callback to return to the full stream (wired from main.js)
let active = false;
let closedThisSession = false; // user hit X; stay closed until next full-stream visit

// --- dragging state ---
let dragging = false;
let dragDX = 0, dragDY = 0;

function loadPos() {
  try {
    const raw = localStorage.getItem(POS_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (typeof p.right === "number" && typeof p.bottom === "number") return p;
  } catch { /* ignore */ }
  return null;
}
function savePos(right, bottom) {
  try { localStorage.setItem(POS_KEY, JSON.stringify({ right, bottom })); } catch { /* ignore */ }
}

// Build the small controls overlay (expand / close + a drag surface) once, appended into the frame.
function ensureOverlay() {
  if (overlayEl) return overlayEl;
  overlayEl = document.createElement("div");
  overlayEl.className = "mini-player-overlay";
  overlayEl.innerHTML = `
    <div class="mini-player-bar">
      <button class="mini-player-btn mini-player-expand" title="Back to stream" aria-label="Back to stream">
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>
      </button>
      <div class="mini-player-drag" title="Drag to move"></div>
      <button class="mini-player-btn mini-player-close" title="Close preview" aria-label="Close preview">
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>
      </button>
    </div>
    <div class="mini-player-clickcatch" title="Back to stream"></div>
  `;

  overlayEl.querySelector(".mini-player-expand").addEventListener("click", (e) => { e.stopPropagation(); returnToStream(); });
  overlayEl.querySelector(".mini-player-close").addEventListener("click", (e) => { e.stopPropagation(); closePreview(); });
  // clicking the video area (but not the buttons/drag bar) returns to the stream
  overlayEl.querySelector(".mini-player-clickcatch").addEventListener("click", (e) => { e.stopPropagation(); returnToStream(); });

  // dragging via the drag surface
  const dragEl = overlayEl.querySelector(".mini-player-drag");
  dragEl.addEventListener("mousedown", startDrag);

  return overlayEl;
}

function startDrag(e) {
  if (!active || !frameEl) return;
  dragging = true;
  const rect = frameEl.getBoundingClientRect();
  // track offset of the cursor within the frame so it doesn't jump on grab
  dragDX = e.clientX - rect.left;
  dragDY = e.clientY - rect.top;
  document.addEventListener("mousemove", onDrag, true);
  document.addEventListener("mouseup", endDrag, true);
  e.preventDefault();
}
function onDrag(e) {
  if (!dragging || !frameEl) return;
  const w = frameEl.offsetWidth;
  const h = frameEl.offsetHeight;
  // convert cursor to a top-left, then to right/bottom insets (our CSS positions by right/bottom)
  let left = e.clientX - dragDX;
  let top = e.clientY - dragDY;
  // clamp to viewport with an 8px margin
  const margin = 8;
  left = Math.max(margin, Math.min(window.innerWidth - w - margin, left));
  top = Math.max(margin, Math.min(window.innerHeight - h - margin, top));
  const right = Math.max(margin, window.innerWidth - left - w);
  const bottom = Math.max(margin, window.innerHeight - top - h);
  frameEl.style.setProperty("right", right + "px", "important");
  frameEl.style.setProperty("bottom", bottom + "px", "important");
  frameEl.style.setProperty("left", "auto", "important");
  frameEl.style.setProperty("top", "auto", "important");
}
function endDrag() {
  if (!dragging) return;
  dragging = false;
  document.removeEventListener("mousemove", onDrag, true);
  document.removeEventListener("mouseup", endDrag, true);
  // persist current inset
  const right = parseInt(frameEl.style.right, 10);
  const bottom = parseInt(frameEl.style.bottom, 10);
  if (Number.isFinite(right) && Number.isFinite(bottom)) savePos(right, bottom);
}

function applyStoredPos() {
  const p = loadPos();
  const right = p ? p.right : 20;
  const bottom = p ? p.bottom : 20;
  frameEl.style.setProperty("right", right + "px", "important");
  frameEl.style.setProperty("bottom", bottom + "px", "important");
  frameEl.style.setProperty("left", "auto", "important");
  frameEl.style.setProperty("top", "auto", "important");
}

function clearInlinePos() {
  for (const prop of ["right", "bottom", "left", "top"]) frameEl.style.removeProperty(prop);
}

// Show the floating preview. Called when navigating to a menu page while a stream plays.
export function activateMiniPlayer() {
  if (!appEl || !frameEl) return;
  if (closedThisSession) return;      // user dismissed it for this browsing session
  if (!session.playing) return;       // nothing to preview
  if (active) return;
  active = true;
  ensureOverlay();
  if (!overlayEl.parentElement) frameEl.appendChild(overlayEl);
  appEl.classList.add("mini-player-active");
  applyStoredPos();
}

// Hide the floating preview and let the frame return to its normal (or page-hidden) state.
export function deactivateMiniPlayer() {
  if (!appEl || !frameEl) return;
  active = false;
  appEl.classList.remove("mini-player-active");
  clearInlinePos();
  if (overlayEl && overlayEl.parentElement) overlayEl.remove();
}

// X on the preview: dismiss it for this browsing session. Reappears next time you leave the stream.
function closePreview() {
  closedThisSession = true;
  deactivateMiniPlayer();
}

// Expand / click / "continue watching": go back to the full stream. Delegates to the callback that
// main.js already uses for backToStreamBtn, so all return paths share one code path.
function returnToStream() {
  if (typeof onExpand === "function") onExpand();
}

// Reset the per-session "closed" flag — call when the user returns to the full stream, so the preview
// is available again next time they navigate away.
export function resetMiniPlayerDismissal() {
  closedThisSession = false;
}

export function initMiniPlayer({ expandToStream } = {}) {
  appEl = document.getElementById("app");
  frameEl = document.getElementById("video-frame");
  onExpand = expandToStream;
  // keep the box on-screen if the window is resized while it's floating
  window.addEventListener("resize", () => {
    if (!active || !frameEl) return;
    const w = frameEl.offsetWidth, h = frameEl.offsetHeight, margin = 8;
    let right = parseInt(frameEl.style.right, 10); if (!Number.isFinite(right)) right = 20;
    let bottom = parseInt(frameEl.style.bottom, 10); if (!Number.isFinite(bottom)) bottom = 20;
    right = Math.max(margin, Math.min(window.innerWidth - w - margin, right));
    bottom = Math.max(margin, Math.min(window.innerHeight - h - margin, bottom));
    frameEl.style.setProperty("right", right + "px", "important");
    frameEl.style.setProperty("bottom", bottom + "px", "important");
  });
}
