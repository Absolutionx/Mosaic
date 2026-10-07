// Right-click menu on the stream player (Stats for nerds, Copy link, Pop out player) and the Stats for nerds
// overlay: a live panel in the video's corner, updated every second, with a Copy button for bug reports.
// Shift+right-click opens the browser's own menu instead, when Settings > App > Browser right-click menu
// allows it.

import { getSetting } from "./settings.js";
import { pushEscape } from "./escape-stack.js";

let deps = {};     // { stats(), copyLink() -> string | null, popOut(), isPlaying() }
let menuEl = null, popMenuEscape = null;
let statsEl = null, statsTimer = null, prev = null;

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

export function initPlayerMenu(host, d) {
  deps = d;
  host.addEventListener("contextmenu", (e) => {
    // only for the video itself: the control bar (e.g. Track ID's right-click history), any button, text field,
    // link or menu inside the player, the chat overlay and Stats for nerds keep their own right-click behavior
    if (e.target.closest?.("#chat-overlay, .nerd-stats, #controls-bar, button, input, textarea, select, a, [role='menu'], [class*='-menu']")) return;
    if (e.shiftKey && getSetting("videoContextMenu")) return; // the browser's menu, on request
    if (!deps.isPlaying?.()) return;
    e.preventDefault();
    openMenu(e.clientX, e.clientY);
  });
}

function openMenu(x, y) {
  closeMenu();
  const m = el("div", "player-menu");
  const item = (label, fn, hint) => {
    const b = el("button", "player-menu-item");
    b.type = "button";
    b.append(el("span", null, label));
    if (hint) b.append(el("span", "player-menu-hint", hint));
    b.addEventListener("click", () => { closeMenu(); fn(); });
    m.appendChild(b);
  };
  item(statsEl ? "Hide stats for nerds" : "Stats for nerds", toggleStats);
  if (deps.copyLink) {
    item("Copy link", () => {
      const url = deps.copyLink();
      if (url) navigator.clipboard.writeText(url).catch(() => {});
    }, deps.linkHint?.() || "");
  }
  if (deps.popOut) item("Pop out player", () => deps.popOut());
  document.body.appendChild(m);
  const w = m.offsetWidth, h = m.offsetHeight;
  m.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, x))}px`;
  m.style.top = `${Math.max(8, Math.min(window.innerHeight - h - 8, y))}px`;
  menuEl = m;
  popMenuEscape = pushEscape(closeMenu);
  setTimeout(() => document.addEventListener("mousedown", onOutside, true), 0);
}
function onOutside(e) { if (menuEl && !menuEl.contains(e.target)) closeMenu(); }
function closeMenu() {
  menuEl?.remove();
  menuEl = null;
  popMenuEscape?.();
  popMenuEscape = null;
  document.removeEventListener("mousedown", onOutside, true);
}

// ---- Stats for nerds ----
export function toggleStats() {
  if (statsEl) { closeStats(); return; }
  const host = deps.host || document.getElementById("video-region");
  statsEl = el("div", "nerd-stats");
  const head = el("div", "nerd-stats-head");
  head.append(el("span", null, "Stats for nerds"));
  const copy = el("button", "nerd-stats-btn", "Copy");
  copy.type = "button";
  copy.addEventListener("click", () => {
    const text = [...statsEl.querySelectorAll(".nerd-row")].map((r) => `${r.children[0].textContent}: ${r.children[1].textContent}`).join("\n");
    navigator.clipboard.writeText(text).then(() => { copy.textContent = "Copied"; setTimeout(() => { copy.textContent = "Copy"; }, 1200); }).catch(() => {});
  });
  const close = el("button", "nerd-stats-btn", "×");
  close.type = "button";
  close.title = "Close";
  close.addEventListener("click", closeStats);
  head.append(copy, close);
  statsEl.append(head, el("div", "nerd-stats-rows"));
  host.appendChild(statsEl);
  prev = null;
  update();
  statsTimer = setInterval(update, 1000);
}

export function closeStats() {
  clearInterval(statsTimer);
  statsTimer = null;
  statsEl?.remove();
  statsEl = null;
  prev = null;
}

const PATHS = { relay: "Live relay (streamlink → MSE)", vod: "VOD (hls.js)", dvr: "Rewound live (hls.js)", kick: "Kick (hls.js)", none: "—" };
const mbps = (bitsPerSec) => (bitsPerSec == null ? "—" : `${(bitsPerSec / 1e6).toFixed(2)} Mbps`);
const secs = (s) => (s == null ? "—" : `${s.toFixed(2)} s`);

// pure: two consecutive snapshots -> display rows (so it can be tested without a player)
export function statRows(cur, last, dtSec) {
  const fps = last && dtSec > 0 && cur.frames >= last.frames ? (cur.frames - last.frames) / dtSec : null;
  const relayRate = last && dtSec > 0 && cur.bytesIn != null && last.bytesIn != null && cur.bytesIn >= last.bytesIn
    ? ((cur.bytesIn - last.bytesIn) * 8) / dtSec : null;
  const codec = cur.mimeType ? (cur.mimeType.match(/codecs="([^"]+)"/) || [])[1] || cur.mimeType : cur.codecs;
  const rows = [
    ["Channel", cur.channel || "—"],
    ["Playback", PATHS[cur.path] || cur.path],
    ["Quality", cur.quality || "—"],
    ["Resolution", cur.width ? `${cur.width}×${cur.height}${fps != null && !cur.paused ? ` @ ${Math.round(fps)} fps` : ""}` : "—"],
    ["Viewport", `${cur.viewW}×${cur.viewH} (×${cur.dpr})`],
    ["Codecs", codec || "—"],
    ["Download", cur.path === "relay" ? mbps(relayRate) : mbps(cur.bandwidthEstimate)],
  ];
  if (cur.levelBitrate) rows.push(["Stream bitrate", mbps(cur.levelBitrate)]);
  rows.push(["Buffer", secs(cur.bufferAhead)]);
  if (cur.behindLive != null) rows.push(["Behind live", secs(cur.behindLive)]);
  rows.push(["Speed", `${cur.rate.toFixed(2)}×`]);
  rows.push(["Dropped frames", `${cur.dropped} / ${cur.frames}${cur.frames ? ` (${((cur.dropped / cur.frames) * 100).toFixed(2)}%)` : ""}`]);
  rows.push(["Volume", cur.muted ? "muted" : `${Math.round(cur.volume * 100)}%`]);
  if (cur.normReduction != null) rows.push(["Normalization", `on · ${cur.normReduction.toFixed(1)} dB`]);
  return rows;
}

function update() {
  if (!statsEl) return;
  if (!deps.isPlaying?.()) { closeStats(); return; }
  const now = performance.now();
  // rates are change / elapsed time: an extra refresh right after the last one would divide by a tiny gap
  // and show absurd numbers, so it's skipped (the regular one-second refresh follows)
  if (prev && now - prev.at < 500) return;
  const cur = deps.stats();
  const rows = statRows(cur, prev && prev.data, prev ? (now - prev.at) / 1000 : 0);
  prev = { at: now, data: cur };
  const box = statsEl.querySelector(".nerd-stats-rows");
  box.replaceChildren(...rows.map(([k, v]) => {
    const r = el("div", "nerd-row");
    r.append(el("span", "nerd-key", k), el("span", "nerd-val", v));
    return r;
  }));
}
