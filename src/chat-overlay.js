// Chat over the video in theater mode and fullscreen (Settings > Chat > Chat overlay, off by default).
// While active, the chat column is hidden (the video takes the width) and new messages are mirrored onto the
// video: a translucent column, newest at the bottom, fading out after a while. The overlay copies the lines
// the real chat already rendered (emotes, badges, colors included). It only watches chat while active.
//
// Placement is relative to the video PICTURE, not the player area: when the video is letterboxed the
// overlay stays on the picture instead of drifting over the black bars. Drag the "Chat" handle (shown on
// hover) to move it, the corner grip to resize, double-click the handle to reset. Position and size are
// stored as fractions of the picture, so they hold across window sizes, theater and fullscreen.

import { getSetting, setSetting, onSettingChange } from "./settings.js";

const MAX_LINES = 30;
const FADE_AFTER_MS = 20000;
export const DEFAULT_RECT = { x: 0.72, y: 0.12, w: 0.26, h: 0.72 }; // fractions of the video picture
const MIN_W = 200, MIN_H = 120; // px

let appEl = null, hostEl = null, videoEl = null, chatContainer = null;
let composerEl = null, composerHome = null, onActiveChange = null;
let overlayEl = null, linesEl = null, observer = null, active = false;
let rect = { ...DEFAULT_RECT };

// send(text) -> Promise<boolean>: sends through the normal chat box (same commands, restrictions, errors);
// status() -> { ok, placeholder }: whether you can chat right now
// composer: the real chat message box (#chat-input-wrapper: badge, text box, settings + emote buttons). With
// "Type in the overlay" on, it MOVES into the overlay while active and back afterwards, so typing there is
// the normal chat box: emote button + picker, Tab / ":" suggestions, replies, commands. (The picker and the
// suggestion popup are positioned from the box's on-screen rect, so they follow it.)
// onChange(active): told when the overlay turns on or off (main.js re-measures the chat box once it's home)
export function initChatOverlay({ app, chatBody, host, video, composer, onChange }) {
  onActiveChange = onChange;
  composerEl = composer || null;
  appEl = app;
  hostEl = host;
  videoEl = video;
  chatContainer = chatBody;
  overlayEl = document.createElement("div");
  overlayEl.id = "chat-overlay";
  const handle = document.createElement("div");
  handle.className = "chat-overlay-handle";
  handle.title = "Drag to move · double-click to reset";
  handle.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg><span>Chat</span>';
  linesEl = document.createElement("div");
  linesEl.className = "chat-overlay-lines";
  const grip = document.createElement("div");
  grip.className = "chat-overlay-grip";
  grip.title = "Drag to resize";
  overlayEl.append(handle, linesEl, grip);
  // Enter anywhere (not while typing somewhere else) jumps into the chat box while it's in the overlay
  window.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || !docked() || e.ctrlKey || e.altKey || e.metaKey) return;
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(t.tagName))) return;
    e.preventDefault();
    // the box is usually hidden (it only shows on hover), and hidden elements can't take focus: open it first
    overlayEl.classList.add("composer-open");
    const input = composerInput();
    input?.focus();
    // couldn't take focus (disabled: logged out, VOD replay): don't leave it stuck open with no focusout
    if (!input || document.activeElement !== input) overlayEl.classList.remove("composer-open");
  });
  // the box stays open while you type in it; leaving it closes it again (until the next hover / Enter)
  composerEl?.addEventListener("focusout", () => {
    setTimeout(() => { if (!composerEl.contains(document.activeElement)) overlayEl.classList.remove("composer-open"); }, 0);
  });
  // Escape in the docked box never exits theater mode / fullscreen (the app's Escape shortcut). like the
  // normal chat box, the first Escape closes the emote suggestions if they're open (the chat box's own
  // handler does that); otherwise it leaves the box. whether suggestions were open is noted BEFORE the chat
  // box handles the key (capture phase), since its handler doesn't mark the key as used
  let suggestionsWereOpen = false;
  composerEl?.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const pop = document.querySelector(".emote-autocomplete");
    suggestionsWereOpen = !!pop && pop.style.display !== "none";
  }, true);
  composerEl?.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !docked()) return;
    e.stopPropagation();
    e.preventDefault();
    if (!suggestionsWereOpen) composerInput()?.blur();
  });
  host.appendChild(overlayEl);

  // the handle + grip show only while the mouse is over the overlay. the overlay itself ignores the mouse
  // (clicks pass through to the player), so CSS :hover can't see it: the pointer position is checked
  // against the overlay's box instead, with a little margin so the corner grip is easy to reach
  let hoverRaf = 0;
  host.addEventListener("mousemove", (e) => {
    if (!active || hoverRaf) return;
    hoverRaf = requestAnimationFrame(() => {
      hoverRaf = 0;
      const r = overlayEl.getBoundingClientRect();
      const m = 10;
      const over = e.clientX >= r.left - m && e.clientX <= r.right + m && e.clientY >= r.top - m && e.clientY <= r.bottom + m;
      overlayEl.classList.toggle("hover", over);
    });
  });
  host.addEventListener("mouseleave", () => overlayEl.classList.remove("hover"));

  rect = loadRect();
  enableDrag(handle, "move");
  enableDrag(grip, "resize");
  handle.addEventListener("dblclick", () => { rect = { ...DEFAULT_RECT }; saveRect(); layout(); });

  observer = new MutationObserver(onChatMutations);
  // theater / fullscreen are classes on the app root
  new MutationObserver(update).observe(appEl, { attributes: true, attributeFilter: ["class"] });
  onSettingChange((id) => {
    if (id === "chatOverlay") update();
    if (id === "chatOverlayInput") syncComposer();
    if (id === "chatOverlayRect") { rect = loadRect(); layout(); }
  });
  // the picture moves / resizes with the window, the player, and each new video's shape
  new ResizeObserver(() => layout()).observe(hostEl);
  videoEl?.addEventListener("loadedmetadata", () => layout());
  videoEl?.addEventListener("resize", () => layout());
  update();
}

function loadRect() {
  const r = getSetting("chatOverlayRect");
  const ok = r && ["x", "y", "w", "h"].every((k) => Number.isFinite(r[k]));
  return ok ? { ...r } : { ...DEFAULT_RECT };
}
function saveRect() { setSetting("chatOverlayRect", { ...rect }); }

function update() {
  const want = !!getSetting("chatOverlay") &&
    (appEl.classList.contains("theater-mode") || appEl.classList.contains("app-fullscreen"));
  if (want === active) { if (active) layout(); return; }
  active = want;
  document.body.classList.toggle("chat-overlay-active", active);
  if (active) {
    observer.observe(chatContainer, { childList: true });
    requestAnimationFrame(layout); // after the chat column collapses
  } else {
    observer.disconnect();
    linesEl.replaceChildren();
  }
  syncComposer();
  onActiveChange?.(active);
}

const composerInput = () => composerEl?.querySelector("textarea, input");
const docked = () => !!composerEl && composerEl.parentElement === overlayEl;

// move the real chat box into the overlay (active + setting on) or back to its exact original spot
function syncComposer() {
  if (!composerEl) return;
  const want = active && !!getSetting("chatOverlayInput");
  if (want && !docked()) {
    composerHome = { parent: composerEl.parentElement, next: composerEl.nextSibling };
    overlayEl.insertBefore(composerEl, overlayEl.querySelector(".chat-overlay-grip"));
    overlayEl.classList.add("with-input");
  } else if (!want && docked()) {
    const focused = composerEl.contains(document.activeElement);
    if (composerHome && composerHome.parent) composerHome.parent.insertBefore(composerEl, composerHome.next && composerHome.next.parentNode === composerHome.parent ? composerHome.next : null);
    overlayEl.classList.remove("with-input");
    if (focused) composerInput()?.blur();
    onActiveChange?.(false); // re-measure the box at its real width
  }
}


// the rectangle the video picture actually occupies inside the player area (object-fit: contain), in
// coordinates relative to the host
export function pictureBox(hostW, hostH, vidW, vidH, videoBox) {
  const box = videoBox || { left: 0, top: 0, width: hostW, height: hostH };
  if (!vidW || !vidH || !box.width || !box.height) return box;
  const scale = Math.min(box.width / vidW, box.height / vidH);
  const w = vidW * scale, h = vidH * scale;
  return { left: box.left + (box.width - w) / 2, top: box.top + (box.height - h) / 2, width: w, height: h };
}

function currentPicture() {
  const hr = hostEl.getBoundingClientRect();
  let videoBox = null;
  if (videoEl && videoEl.isConnected) {
    const vr = videoEl.getBoundingClientRect();
    if (vr.width && vr.height) videoBox = { left: vr.left - hr.left, top: vr.top - hr.top, width: vr.width, height: vr.height };
  }
  return pictureBox(hr.width, hr.height, videoEl?.videoWidth, videoEl?.videoHeight, videoBox);
}

// keep the stored rect sane and the overlay fully on the picture
function clampRect(pic) {
  const minW = Math.min(1, MIN_W / Math.max(1, pic.width)), minH = Math.min(1, MIN_H / Math.max(1, pic.height));
  rect.w = Math.min(1, Math.max(minW, rect.w));
  rect.h = Math.min(1, Math.max(minH, rect.h));
  rect.x = Math.min(1 - rect.w, Math.max(0, rect.x));
  rect.y = Math.min(1 - rect.h, Math.max(0, rect.y));
}

function layout() {
  if (!active || !overlayEl) return;
  const pic = currentPicture();
  if (!pic.width || !pic.height) return;
  clampRect(pic);
  overlayEl.style.left = `${pic.left + rect.x * pic.width}px`;
  overlayEl.style.top = `${pic.top + rect.y * pic.height}px`;
  overlayEl.style.width = `${rect.w * pic.width}px`;
  overlayEl.style.height = `${rect.h * pic.height}px`;
}

function enableDrag(el, mode) {
  el.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    el.setPointerCapture?.(e.pointerId);
    const pic = currentPicture();
    const start = { x: e.clientX, y: e.clientY, rect: { ...rect } };
    overlayEl.classList.add("dragging");
    const move = (ev) => {
      const dx = (ev.clientX - start.x) / pic.width, dy = (ev.clientY - start.y) / pic.height;
      if (mode === "move") { rect.x = start.rect.x + dx; rect.y = start.rect.y + dy; }
      else { rect.w = start.rect.w + dx; rect.h = start.rect.h + dy; }
      layout();
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      overlayEl.classList.remove("dragging");
      saveRect();
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  });
}

function onChatMutations(mutations) {
  for (const m of mutations) {
    for (const node of m.addedNodes) {
      if (node.nodeType !== 1 || !node.classList.contains("chat-line")) continue;
      if (node.classList.contains("is-cleared")) continue;
      addLine(node);
    }
  }
}

function addLine(line) {
  const copy = line.cloneNode(true);
  copy.removeAttribute("id");
  copy.querySelectorAll("[id]").forEach((e) => e.removeAttribute("id"));
  copy.querySelectorAll("button, .chat-line-actions, .chat-reply-btn").forEach((e) => e.remove());
  copy.classList.add("chat-overlay-line");
  linesEl.appendChild(copy);
  while (linesEl.children.length > MAX_LINES) linesEl.firstElementChild.remove();
  setTimeout(() => {
    copy.classList.add("fading");
    setTimeout(() => copy.remove(), 900);
  }, FADE_AFTER_MS);
}
