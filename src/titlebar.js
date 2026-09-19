// Wires the custom title bar (native decorations are off): minimize / maximize / close, the window title
// (with version), the maximize-icon toggle, and the invisible edge/corner resize grips.

import { getCurrentWindow } from "@tauri-apps/api/window";
import { getVersion } from "@tauri-apps/api/app";

const win = getCurrentWindow();

// The app uses a frameless Tauri window. Keep the whole empty header surface
// draggable while allowing buttons, inputs, links, and the window controls
// to behave normally. The explicit handler also keeps dragging reliable
// across WebView2/Tauri versions instead of relying only on CSS hit testing.
const header = document.querySelector("header");
header?.addEventListener("mousedown", (e) => {
  if (e.button !== 0) return;

  const target = e.target instanceof Element ? e.target : null;
  if (target?.closest("button, input, textarea, select, a, [contenteditable=\"true\"], .win-controls, .resize-grip")) {
    return;
  }

  win.startDragging().catch(() => {});
});

// Double-clicking an empty part of the chrome mirrors a normal desktop
// titlebar and toggles maximize/restore.
header?.addEventListener("dblclick", (e) => {
  e.preventDefault();
  e.stopPropagation();
  const target = e.target instanceof Element ? e.target : null;
  if (target?.closest("button, input, textarea, select, a, [contenteditable=\"true\"], .win-controls, .resize-grip")) {
    return;
  }
  win.toggleMaximize().catch(() => {});
});

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
