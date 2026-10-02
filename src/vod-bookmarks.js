// VOD bookmarks: mark moments in a VOD with an optional note, see them on the seek bar, jump back later.
//   B (or the bookmark button's "Add bookmark") marks the current time and opens a note box.
//   The bookmark button lists this VOD's bookmarks: jump, edit the note, delete.
//   "VOD bookmarks" in Ctrl+K lists every bookmark across VODs; picking one opens that VOD at that moment.
// Stored locally (localStorage "vodBookmarks"), included in Settings backups. Twitch VODs only.

import { pushEscape } from "./escape-stack.js";
import { fmtDateMDY } from "./format.js";

const KEY = "vodBookmarks";
const NEAR_FRACTION = 0.008; // hovering the seek bar within ~0.8% of a bookmark shows its note

let deps = {};  // { pc, getVod() -> { videoId, title, channelLogin, channelName, createdAt, totalSeconds, thumbnail } | null, openVod(meta, seconds) }
let menuEl = null, popMenuEscape = null, listEl = null, popListEscape = null;

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
export function fmtTime(s) {
  s = Math.max(0, Math.floor(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
}

// ---- storage ----
export function loadAll() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || "null");
    if (s && s.vods && typeof s.vods === "object") return s;
  } catch { /* ignore */ }
  return { v: 1, vods: {} };
}
function saveAll(s) { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* quota */ } }
export function marksFor(videoId) {
  const v = loadAll().vods[String(videoId)];
  return v ? [...v.marks].sort((a, b) => a.t - b.t) : [];
}
export function addMark(vod, t, note = "") {
  const s = loadAll();
  const id = String(vod.videoId);
  const entry = (s.vods[id] ||= { meta: {}, marks: [] });
  entry.meta = { videoId: id, title: vod.title || "", channelLogin: vod.channelLogin || "", channelName: vod.channelName || vod.channelLogin || "",
    createdAt: vod.createdAt || "", totalSeconds: vod.totalSeconds || entry.meta.totalSeconds || 0, thumbnail: vod.thumbnail || entry.meta.thumbnail || "" };
  const mark = { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, t: Math.max(0, Math.floor(t)), note: String(note || "").slice(0, 200), at: Date.now() };
  entry.marks.push(mark);
  saveAll(s);
  return mark;
}
export function updateMark(videoId, markId, note) {
  const s = loadAll();
  const m = s.vods[String(videoId)]?.marks.find((x) => x.id === markId);
  if (m) { m.note = String(note || "").slice(0, 200); saveAll(s); }
}
export function deleteMark(videoId, markId) {
  const s = loadAll();
  const v = s.vods[String(videoId)];
  if (!v) return;
  v.marks = v.marks.filter((x) => x.id !== markId);
  if (!v.marks.length) delete s.vods[String(videoId)];
  saveAll(s);
}
// the bookmark under a hovered seek-bar position (for the tooltip), or null
export function markNear(videoId, sec, total) {
  if (!total) return null;
  let best = null;
  for (const m of marksFor(videoId)) {
    const d = Math.abs(m.t - sec);
    if (d <= total * NEAR_FRACTION && (!best || d < Math.abs(best.t - sec))) best = m;
  }
  return best;
}

// ---- player integration ----
export function initVodBookmarks(d) {
  deps = d;
  const pc = d.pc;
  pc.bookmarkLabelAt = (sec, total) => {
    const vod = deps.getVod();
    const m = vod ? markNear(vod.videoId, sec, total) : null;
    return m ? (m.note ? `Bookmark: ${m.note.slice(0, 60)}` : "Bookmark") : "";
  };
  const v = pc.videoEl;
  for (const ev of ["loadedmetadata", "durationchange", "emptied"]) v.addEventListener(ev, () => refresh());
  document.getElementById("bookmark-btn")?.addEventListener("click", (e) => { e.stopPropagation(); toggleMenu(); });
  refresh();
}

// show the button + draw this VOD's markers (or clear them when not on a Twitch VOD)
export function refresh() {
  const btn = document.getElementById("bookmark-btn");
  const layer = document.getElementById("seek-bar-bookmarks");
  const vod = deps.getVod ? deps.getVod() : null;
  if (btn) btn.style.display = vod ? "" : "none";
  if (!layer) return;
  layer.replaceChildren();
  if (!vod) { closeMenu(); return; }
  const total = vod.totalSeconds || deps.pc.videoEl.duration || 0;
  if (!(total > 0)) return;
  for (const m of marksFor(vod.videoId)) {
    const tick = el("span", "seek-bookmark-marker");
    tick.style.left = `${Math.min(100, (m.t / total) * 100)}%`;
    layer.appendChild(tick);
  }
}

// B / "Add bookmark": mark now, then ask for a note (Enter saves, Escape keeps it without one)
export function addBookmarkNow() {
  const vod = deps.getVod();
  if (!vod) return null;
  const t = deps.pc.videoEl.currentTime || 0;
  const mark = addMark(vod, t);
  refresh();
  openNoteBox(vod, mark, true);
  return mark;
}

function openNoteBox(vod, mark, isNew) {
  closeMenu();
  const box = el("div", "bm-menu bm-note");
  box.appendChild(el("div", "bm-title", `${isNew ? "Bookmarked" : "Edit note"} · ${fmtTime(mark.t)}`));
  const input = el("input", "bm-input");
  input.type = "text";
  input.maxLength = 200;
  input.placeholder = "Add a note (optional)";
  input.value = mark.note || "";
  box.appendChild(input);
  box.appendChild(el("div", "bm-hint", "Enter to save · Esc to skip"));
  input.addEventListener("keydown", (e) => {
    e.stopPropagation(); // player shortcuts (space, arrows, B) stay out of the note
    if (e.key === "Enter") { e.preventDefault(); updateMark(vod.videoId, mark.id, input.value.trim()); refresh(); closeMenu(); }
  });
  showMenu(box);
  setTimeout(() => input.focus(), 0);
}

function toggleMenu() {
  if (menuEl) { closeMenu(); return; }
  const vod = deps.getVod();
  if (!vod) return;
  const m = el("div", "bm-menu");
  const add = el("button", "bm-item bm-add");
  add.type = "button";
  add.append(el("span", null, "Add bookmark"), el("span", "bm-time", `at ${fmtTime(deps.pc.videoEl.currentTime || 0)} · B`));
  add.addEventListener("click", () => { closeMenu(); addBookmarkNow(); });
  m.appendChild(add);
  const marks = marksFor(vod.videoId);
  if (marks.length) m.appendChild(el("div", "bm-sep"));
  for (const mk of marks) {
    const row = el("div", "bm-row");
    const jump = el("button", "bm-item bm-jump");
    jump.type = "button";
    jump.append(el("span", "bm-time", fmtTime(mk.t)), el("span", "bm-note-text", mk.note || "No note"));
    jump.addEventListener("click", () => { deps.pc.videoEl.currentTime = mk.t; closeMenu(); });
    const edit = el("button", "bm-icon", "✎");
    edit.type = "button"; edit.title = "Edit note";
    edit.addEventListener("click", () => openNoteBox(vod, mk, false));
    const del = el("button", "bm-icon", "✕");
    del.type = "button"; del.title = "Delete";
    del.addEventListener("click", () => { deleteMark(vod.videoId, mk.id); refresh(); closeMenu(); toggleMenu(); });
    row.append(jump, edit, del);
    m.appendChild(row);
  }
  const all = el("button", "bm-item bm-all", "All VOD bookmarks…");
  all.type = "button";
  all.addEventListener("click", () => { closeMenu(); openBookmarksList(); });
  m.appendChild(el("div", "bm-sep"));
  m.appendChild(all);
  showMenu(m);
}

function showMenu(m) {
  closeMenu();
  document.body.appendChild(m);
  const btn = document.getElementById("bookmark-btn");
  const r = (btn && btn.offsetParent ? btn : document.getElementById("video-region") || document.body).getBoundingClientRect();
  const w = m.offsetWidth, h = m.offsetHeight;
  m.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w))}px`;
  m.style.top = `${Math.max(8, r.top - h - 8)}px`;
  menuEl = m;
  popMenuEscape = pushEscape(closeMenu);
  setTimeout(() => document.addEventListener("mousedown", onOutside, true), 0);
}
function onOutside(e) {
  if (menuEl && !menuEl.contains(e.target) && !e.target.closest?.("#bookmark-btn")) closeMenu();
}
export function closeMenu() {
  menuEl?.remove();
  menuEl = null;
  popMenuEscape?.();
  popMenuEscape = null;
  document.removeEventListener("mousedown", onOutside, true);
}

// ---- every bookmark, across VODs ----
export function openBookmarksList() {
  closeBookmarksList();
  const backdrop = el("div", "hub-backdrop");
  const panel = el("div", "hub-panel bm-panel");
  backdrop.appendChild(panel);
  const head = el("div", "hub-head");
  head.appendChild(el("div", "hub-title", "VOD bookmarks"));
  head.appendChild(el("div", "hub-spacer"));
  const close = el("button", "hub-close");
  close.type = "button"; close.title = "Close (Esc)";
  close.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';
  close.addEventListener("click", closeBookmarksList);
  head.appendChild(close);
  const body = el("div", "hub-body");
  panel.append(head, body);
  const vods = Object.values(loadAll().vods)
    .filter((v) => v.marks && v.marks.length)
    .sort((a, b) => Math.max(...b.marks.map((m) => m.at)) - Math.max(...a.marks.map((m) => m.at)));
  if (!vods.length) body.appendChild(el("div", "hub-empty", "No bookmarks yet. Press B while watching a VOD to mark a moment."));
  for (const v of vods) {
    const card = el("div", "bm-vod");
    const head2 = el("div", "bm-vod-head");
    head2.append(el("div", "bm-vod-title", v.meta.title || `VOD ${v.meta.videoId}`),
      el("div", "bm-vod-sub", [v.meta.channelName, fmtDateMDY(v.meta.createdAt)].filter(Boolean).join(" · ")));
    card.appendChild(head2);
    for (const mk of [...v.marks].sort((a, b) => a.t - b.t)) {
      const row = el("button", "bm-item bm-jump");
      row.type = "button";
      row.append(el("span", "bm-time", fmtTime(mk.t)), el("span", "bm-note-text", mk.note || "No note"));
      row.addEventListener("click", () => { closeBookmarksList(); deps.openVod?.(v.meta, mk.t); });
      card.appendChild(row);
    }
    body.appendChild(card);
  }
  backdrop.addEventListener("mousedown", (e) => { if (e.target === backdrop) closeBookmarksList(); });
  document.body.appendChild(backdrop);
  listEl = backdrop;
  popListEscape = pushEscape(closeBookmarksList);
}
export function closeBookmarksList() {
  listEl?.remove();
  listEl = null;
  popListEscape?.();
  popListEscape = null;
}
