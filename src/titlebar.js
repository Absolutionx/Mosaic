// Wires the custom title bar (native decorations are off): minimize / maximize / close, the window title
// (with version), the maximize-icon toggle, and the invisible edge/corner resize grips.

import { getCurrentWindow } from "@tauri-apps/api/window";
import { getVersion } from "@tauri-apps/api/app";

const win = getCurrentWindow();

// The app uses a frameless Tauri window. Keep the whole empty header surface
// draggable while allowing buttons, inputs, links, and the window controls
// to behave normally. The explicit handler also keeps dragging reliable
// across WebView2/Tauri versions instead of relying only on CSS hit testing.
//
// In THEATER mode the top header is hidden (visibility:hidden, squeezed to a thin strip), so it can't
// be grabbed to move the window. To keep the window draggable there, the same drag/double-click
// behaviour is also attached to the chat pane's header bar ("Chat") and the empty strip above the
// video. Those surfaces exist in every mode; the shared handlers below ignore clicks on real controls,
// so adding them changes nothing about normal button/scroll behaviour.
const dragEls = [
  document.querySelector("header"),
  document.querySelector(".chat-header"),
  document.getElementById("video-column"),
  document.getElementById("theater-drag-strip"),
].filter(Boolean);

// The video column is a drag surface only in theater mode, and only at its very top (the empty band
// above the 16:9 video) — never on the player, controls, or the home/browse pages it also hosts.
function isVideoColumnBody(target, currentTarget) {
  if (currentTarget?.id !== "video-column") return false;
  // only in theater mode (outside it the header is the drag surface, and the column shows pages)
  if (!document.getElementById("app")?.classList.contains("theater-mode")) return true;
  // in theater mode: block drag on the actual video/controls/info, allow it on the empty surround
  return !!target?.closest("#video-region, .controls-bar, .stream-info-overlay, #channel-info-bar, #home-feed, #browse-page, #vods-page");
}

for (const el of dragEls) {
  el.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    const target = e.target instanceof Element ? e.target : null;
    if (target?.closest("button, input, textarea, select, a, [contenteditable=\"true\"], .win-controls, .resize-grip")) {
      return;
    }
    if (isVideoColumnBody(target, e.currentTarget)) return;
    win.startDragging().catch(() => {});
  });

  // Double-clicking empty chrome mirrors a normal desktop titlebar and toggles maximize/restore.
  el.addEventListener("dblclick", (e) => {
    const target = e.target instanceof Element ? e.target : null;
    if (target?.closest("button, input, textarea, select, a, [contenteditable=\"true\"], .win-controls, .resize-grip")) {
      return;
    }
    if (isVideoColumnBody(target, e.currentTarget)) return;
    e.preventDefault();
    e.stopPropagation();
    win.toggleMaximize().catch(() => {});
  });
}

document.getElementById("titlebar-min")?.addEventListener("click", () => win.minimize());
document.getElementById("titlebar-max")?.addEventListener("click", () => win.toggleMaximize());
document.getElementById("titlebar-close")?.addEventListener("click", () => win.close());

// swap the maximize icon between "restore" and "maximize" to match window state
const maxBtn = document.getElementById("titlebar-max");
async function syncMaxIcon() {
  if (!maxBtn) return;
  let maxed = false;
  try { maxed = await win.isMaximized(); } catch { /* ignore */ }
  maxBtn.title = maxed ? "Restore" : "Maximize";
  maxBtn.innerHTML = maxed
    ? '<svg viewBox="0 0 12 12" width="11" height="11"><rect x="3.5" y="1.5" width="6" height="6" fill="none" stroke="currentColor" stroke-width="1"/><rect x="1.5" y="3.5" width="6" height="6" fill="var(--m-surface, #14181f)" stroke="currentColor" stroke-width="1"/></svg>'
    : '<svg viewBox="0 0 12 12" width="11" height="11"><rect x="2.5" y="2.5" width="7" height="7" fill="none" stroke="currentColor" stroke-width="1"/></svg>';
}
win.onResized(() => syncMaxIcon());
syncMaxIcon();

// version in the title bar
getVersion().then((v) => {
  const t = document.getElementById("titlebar-title");
  if (t) t.textContent = `Mosaic v${v}`;
}).catch(() => {});

// resize grips
for (const grip of document.querySelectorAll(".resize-grip")) {
  grip.addEventListener("mousedown", (e) => {
    e.preventDefault();
    const dir = grip.getAttribute("data-resize");
    if (dir) win.startResizeDragging(dir).catch(() => {});
  });
}
