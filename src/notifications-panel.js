// Twitch notifications: the bell in the header, like twitch.tv's. "Emote unlocked", "your gift sub has
// expired", stream streaks, new VODs, drops... Twitch's own list, through the device login (unofficial,
// get_onsite_notifications / notifications_action in helix.rs).
//
// - the bell's count is Twitch's "unseen" count; opening the panel marks everything seen (the count clears,
//   items stay unread until clicked, as on twitch.tv)
// - two tabs like Twitch: My Twitch (VIEWER) and My Channel (CREATOR), each "Last 24 hours" then "Earlier"
// - clicking an item marks it read and opens what it's about: a channel or VOD in Mosaic, anything else on
//   twitch.tv in the browser
// - the count refreshes every 3 minutes, and when Mosaic comes back to the front
// Settings > App > Notifications button hides the bell.

import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getSetting, onSettingChange } from "./settings.js";
import { pushEscape } from "./escape-stack.js";
import { fmtDateMDY } from "./format.js";

const POLL_MS = 3 * 60 * 1000;
const PAGE = 30;
const DAY = 86400000;

const ICON = (d, size = 16, extra = "") =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"${extra}>${d}</svg>`;
const BELL = '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>';
const MAIL_OPEN = '<path d="M21.2 8.4c.5.38.8.97.8 1.6v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V10a2 2 0 0 1 .8-1.6l8-6a2 2 0 0 1 2.4 0l8 6Z"/><path d="m22 10-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 10"/>';
const GEAR = '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>';
const X = '<path d="M18 6 6 18M6 6l12 12"/>';

// ---- pure helpers ----

// Twitch's notification text is light markdown: **bold** and [text](url). as plain text pieces, no HTML:
// [{ text, bold }]
export function parseBody(md) {
  const s = String(md || "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\\([*_[\]()])/g, "$1");
  const out = [];
  const re = /\*\*([^*]+)\*\*/g;
  let last = 0, m;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push({ text: s.slice(last, m.index), bold: false });
    out.push({ text: m[1], bold: true });
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push({ text: s.slice(last), bold: false });
  return out.filter((p) => p.text);
}

// "just now" / "6 minutes ago" / "18 hours ago" / "yesterday" / "3 days ago" / "10-02-26"
export function timeAgo(iso, now = Date.now()) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"} ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.floor(h / 24);
  if (d === 1) return "yesterday";
  if (d < 7) return `${d} days ago`;
  return fmtDateMDY(iso);
}

// what clicking an item does: { app: "channel", login } | { app: "vod", id, length, login } | { url } | null
export function itemTarget(n) {
  const t = n && n.target;
  if (t && t.kind === "channel" && t.login) return { app: "channel", login: String(t.login).toLowerCase() };
  if (t && t.kind === "vod" && t.id) return { app: "vod", id: String(t.id), length: t.length || 0, login: t.login || "" };
  if (t && t.kind === "clip" && (t.url || t.slug)) return { url: t.url || `https://clips.twitch.tv/${t.slug}` };
  if (t && t.kind === "link" && /^https:\/\//i.test(t.url || "")) return { url: t.url };
  const a = (n && n.actions || []).find((x) => /^https:\/\//i.test(x.url || ""));
  if (a) return { url: a.url };
  if (t && t.kind === "game" && t.name) return { url: `https://www.twitch.tv/directory/category/${encodeURIComponent(t.name)}` };
  return null;
}

export const badgeText = (n) => (n > 99 ? "99+" : String(n));

// Twitch sends the category as an id ("drops_and_quests", "watch_streaks"): "Drops and quests"
export function categoryLabel(c) {
  const t = String(c || "").replace(/[_-]+/g, " ").trim().toLowerCase();
  return t ? t[0].toUpperCase() + t.slice(1) : "";
}

// ---- state ----
let deps = { watchChannel: () => {}, openVod: () => {}, connectTwitch: (done) => done?.() };
let btn = null, badge = null, pollTimer = null, lastPoll = 0;
let unseen = 0, userId = null;
const tabs = {
  VIEWER: { label: "My Twitch", items: [], hasMore: false, unread: 0, loaded: false, loading: false },
  CREATOR: { label: "My Channel", items: [], hasMore: false, unread: 0, loaded: false, loading: false },
};
let tab = "VIEWER";
let panel = null, popEscape = null, connected = null;

function setBadge(n) {
  unseen = Math.max(0, n | 0);
  if (!badge) return;
  badge.textContent = badgeText(unseen);
  badge.style.display = unseen > 0 ? "" : "none";
  if (btn) btn.title = unseen > 0 ? `Notifications (${unseen} new)` : "Notifications";
}

function applySummary(r) {
  if (!r) return;
  if (r.user_id) userId = r.user_id;
  tabs.VIEWER.unread = r.unread_viewer || 0;
  tabs.CREATOR.unread = r.unread_creator || 0;
  if (!panel) setBadge(r.unseen || 0);
}

// the background check: the count on the bell (and the first page, so opening the panel is instant)
async function poll() {
  if (!btn || !getSetting("notificationsButton") || panel) return;
  lastPoll = Date.now();
  let r;
  try { r = await invoke("get_onsite_notifications", { displayType: "VIEWER", first: PAGE }); } catch (e) { console.warn("[notifications]", e); return; }
  if (r === null) { connected = false; setBadge(0); return; } // no device login
  connected = true;
  applySummary(r);
  if (!panel) { tabs.VIEWER.items = r.items || []; tabs.VIEWER.hasMore = !!r.has_more; tabs.VIEWER.loaded = true; }
}

// call once at startup. watchChannel(login), openVod(id, lengthSecs, login), connectTwitch(done)
export function initNotificationsPanel(options = {}) {
  deps = { ...deps, ...options };
  btn = document.getElementById("notifications-btn");
  badge = document.getElementById("notifications-unread");
  if (!btn) return;
  btn.addEventListener("click", (e) => { e.stopPropagation(); if (panel) closeNotificationsPanel(); else openNotificationsPanel(); });
  const applyVisible = () => {
    const on = !!getSetting("notificationsButton");
    btn.style.display = on ? "" : "none";
    if (!on) closeNotificationsPanel();
  };
  applyVisible();
  onSettingChange((id) => { if (id === "notificationsButton") { applyVisible(); if (getSetting("notificationsButton")) poll(); } });
  setTimeout(poll, 4000); // after startup has settled
  pollTimer = setInterval(poll, POLL_MS);
  document.addEventListener("visibilitychange", () => { if (!document.hidden && Date.now() - lastPoll > 60000) poll(); });
}

// signing in or out of the device login: start over
export function resetNotifications() {
  for (const t of Object.values(tabs)) Object.assign(t, { items: [], hasMore: false, unread: 0, loaded: false, loading: false });
  userId = null; connected = null;
  setBadge(0);
  if (panel) render(); else poll();
}

// ---- the panel ----
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

export function openNotificationsPanel() {
  if (panel || !btn) return;
  panel = el("div", "notif-panel");
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "Notifications");
  document.body.appendChild(panel);
  btn.classList.add("open");
  place();
  window.addEventListener("resize", place);
  setTimeout(() => document.addEventListener("mousedown", onOutside, true), 0);
  popEscape = pushEscape(() => closeNotificationsPanel());
  render();
  load(tab, false);
  // opened: Twitch counts them as seen, the bell's count goes
  if (unseen > 0) {
    setBadge(0);
    invoke("notifications_action", { action: "seen" }).catch((e) => console.warn("[notifications] seen:", e));
  }
}

export function closeNotificationsPanel() {
  if (!panel) return;
  panel.remove();
  panel = null;
  btn?.classList.remove("open");
  window.removeEventListener("resize", place);
  document.removeEventListener("mousedown", onOutside, true);
  popEscape?.(); popEscape = null;
}

function onOutside(e) {
  if (!panel) return;
  if (panel.contains(e.target) || btn.contains(e.target)) return;
  closeNotificationsPanel();
}

function place() {
  if (!panel || !btn) return;
  const r = btn.getBoundingClientRect();
  const w = Math.min(380, window.innerWidth - 16);
  panel.style.width = `${w}px`;
  panel.style.top = `${Math.round(r.bottom + 8)}px`;
  panel.style.left = `${Math.round(Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8)))}px`;
  // half the room below the button (it used to run to the bottom of the window)
  panel.style.maxHeight = `${Math.max(240, Math.round((window.innerHeight - r.bottom - 24) / 2))}px`;
}

async function load(kind, more) {
  const t = tabs[kind];
  if (t.loading) return;
  if (!more && t.loaded && t.items.length && Date.now() - lastPoll < 30000 && kind === "VIEWER") return; // the poll just fetched it
  t.loading = true;
  if (panel) render();
  let r = null, err = null;
  try {
    r = await invoke("get_onsite_notifications", { displayType: kind, first: PAGE, after: more ? (t.items[t.items.length - 1]?.cursor || null) : null });
  } catch (e) { err = e; }
  t.loading = false;
  if (err) { t.error = typeof err === "string" ? err : "Couldn't load notifications"; if (panel) render(); return; }
  t.error = null;
  if (r === null) { connected = false; if (panel) render(); return; }
  connected = true;
  if (r.user_id) userId = r.user_id;
  tabs.VIEWER.unread = r.unread_viewer || 0;
  tabs.CREATOR.unread = r.unread_creator || 0;
  const items = r.items || [];
  if (more) {
    const seen = new Set(t.items.map((i) => i.id));
    t.items = t.items.concat(items.filter((i) => !seen.has(i.id)));
  } else t.items = items;
  t.hasMore = !!r.has_more;
  t.loaded = true;
  if (panel) render();
}

function render() {
  if (!panel) return;
  const keepScroll = panel.querySelector(".notif-list")?.scrollTop || 0;
  panel.replaceChildren();

  const head = el("div", "notif-head");
  const markAll = el("button", "notif-icon-btn");
  markAll.type = "button"; markAll.title = "Mark all as read"; markAll.innerHTML = ICON(MAIL_OPEN, 16);
  markAll.disabled = !connected || !userId || tab !== "VIEWER" || !tabs.VIEWER.items.some((i) => !i.read);
  markAll.addEventListener("click", markAllRead);
  const title = el("div", "notif-title", "Notifications");
  const settings = el("button", "notif-icon-btn");
  settings.type = "button"; settings.title = "Notification settings on Twitch"; settings.innerHTML = ICON(GEAR, 16);
  settings.addEventListener("click", () => openUrl("https://www.twitch.tv/settings/notifications").catch(() => {}));
  const close = el("button", "notif-icon-btn");
  close.type = "button"; close.title = "Close (Esc)"; close.setAttribute("aria-label", "Close"); close.innerHTML = ICON(X, 16);
  close.addEventListener("click", closeNotificationsPanel);
  head.append(markAll, title, settings, close);
  panel.append(head);

  if (connected === false) {
    const empty = el("div", "notif-connect");
    empty.append(
      el("div", "notif-connect-title", "Your Twitch notifications"),
      el("div", "notif-connect-text", "Emote unlocks, gift subs, stream streaks, new VODs and more, as on twitch.tv. They come through the same Twitch connection as drops and channel points."),
    );
    const go = el("button", "notif-connect-btn", "Connect Twitch");
    go.type = "button";
    go.addEventListener("click", () => {
      closeNotificationsPanel();
      deps.connectTwitch(() => { resetNotifications(); openNotificationsPanel(); });
    });
    empty.append(go);
    panel.append(empty);
    return;
  }

  const tabRow = el("div", "notif-tabs");
  for (const kind of ["VIEWER", "CREATOR"]) {
    const t = tabs[kind];
    const b = el("button", "notif-tab" + (kind === tab ? " active" : ""), t.unread ? `${t.label} (${t.unread})` : t.label);
    b.type = "button";
    b.addEventListener("click", () => { if (tab === kind) return; tab = kind; render(); load(kind, false); });
    tabRow.append(b);
  }
  panel.append(tabRow);

  const list = el("div", "notif-list");
  const t = tabs[tab];
  if (!t.loaded && (t.loading || connected === null)) list.append(el("div", "notif-empty", "Loading…"));
  else if (t.error && !t.items.length) list.append(el("div", "notif-empty", t.error));
  else if (!t.items.length) list.append(el("div", "notif-empty", tab === "VIEWER" ? "No notifications yet." : "Nothing about your channel yet."));
  else {
    const now = Date.now();
    const recent = t.items.filter((i) => now - Date.parse(i.created_at || 0) < DAY);
    const older = t.items.filter((i) => !(now - Date.parse(i.created_at || 0) < DAY));
    for (const [label, group] of [["Last 24 hours", recent], ["Earlier", older]]) {
      if (!group.length) continue;
      list.append(el("div", "notif-group", label));
      for (const n of group) list.append(buildItem(n, now));
    }
    if (t.hasMore) {
      const more = el("div", "notif-more", t.loading ? "Loading…" : "");
      list.append(more);
    }
  }
  list.addEventListener("scroll", () => {
    if (t.hasMore && !t.loading && list.scrollTop + list.clientHeight >= list.scrollHeight - 80) load(tab, true);
  });
  panel.append(list);
  list.scrollTop = keepScroll;
}

function buildItem(n, now) {
  const row = el("div", "notif-item" + (n.read ? "" : " unread"));
  row.tabIndex = 0;
  row.setAttribute("role", "button");
  const pic = el("div", "notif-pic");
  if (n.thumbnail) {
    const img = el("img");
    img.src = n.thumbnail; img.alt = ""; img.loading = "lazy";
    img.addEventListener("error", () => img.remove());
    pic.append(img);
  }
  const text = el("div", "notif-text");
  const body = el("div", "notif-body");
  for (const p of parseBody(n.body)) body.append(p.bold ? el("strong", null, p.text) : document.createTextNode(p.text));
  const meta = el("div", "notif-meta", [timeAgo(n.created_at, now), categoryLabel(n.category)].filter(Boolean).join(" · "));
  text.append(body, meta);
  const dot = el("span", "notif-dot");
  const del = el("button", "notif-del");
  del.type = "button"; del.title = "Remove"; del.setAttribute("aria-label", "Remove"); del.innerHTML = ICON(X, 13);
  del.addEventListener("click", (e) => { e.stopPropagation(); removeItem(n); });
  row.append(pic, text, dot, del);
  const go = () => openItem(n);
  row.addEventListener("click", go);
  row.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
  return row;
}

function markRead(n) {
  if (n.read) return;
  n.read = true;
  const t = tabs[tab];
  t.unread = Math.max(0, t.unread - 1);
  invoke("notifications_action", { action: "read", ids: [n.id] }).catch((e) => console.warn("[notifications] read:", e));
}

function openItem(n) {
  markRead(n);
  const target = itemTarget(n);
  if (!target) { render(); return; }
  closeNotificationsPanel();
  if (target.app === "channel") deps.watchChannel(target.login);
  else if (target.app === "vod") deps.openVod(target.id, target.length, target.login);
  else if (target.url) openUrl(target.url).catch(() => {});
}

async function removeItem(n) {
  const t = tabs[tab];
  const i = t.items.indexOf(n);
  if (i < 0) return;
  t.items.splice(i, 1);
  if (!n.read) t.unread = Math.max(0, t.unread - 1);
  render();
  try {
    await invoke("notifications_action", { action: "delete", ids: [n.id] });
  } catch (e) {
    console.warn("[notifications] delete:", e);
    t.items.splice(i, 0, n); // Twitch said no: put it back
    if (!n.read) t.unread++;
    render();
  }
}

async function markAllRead() {
  if (!userId) return;
  const t = tabs.VIEWER;
  const before = t.items.map((i) => i.read);
  for (const i of t.items) i.read = true;
  const prevUnread = t.unread;
  t.unread = 0;
  render();
  try {
    await invoke("notifications_action", { action: "read_all", userId });
  } catch (e) {
    console.warn("[notifications] read all:", e);
    t.items.forEach((i, k) => { i.read = before[k]; });
    t.unread = prevUnread;
    render();
  }
}
