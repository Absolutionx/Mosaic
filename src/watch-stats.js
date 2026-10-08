// Watch stats: time watched per channel and day (live and VODs), kept locally (localStorage "watchStats",
// included in Settings backups), and a stats view with totals, a daily chart, top channels, live vs VOD
// and your streak. Tracking starts with this version; nothing is sent anywhere.

import { pushEscape } from "./escape-stack.js";
import { fmtDateMDY } from "./format.js";

const KEY = "watchStats";
const KEEP_DAYS = 400;
const MAX_GAP_S = 30; // a tick never credits more than this (sleep / suspended timers can't inflate stats)

const dayKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

function load() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || "null");
    if (s && typeof s === "object" && s.days) return s;
  } catch { /* ignore */ }
  return { v: 1, days: {}, names: {} };
}
function save(s) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* quota: skip this save */ }
}

// ---- tracking ----
let lastTick = 0;
// time is counted every tick but written once a minute: each write re-saves the whole history (a year of it
// is a couple of hundred KB), and doing that every 15 seconds for as long as something plays is a lot of
// disk writing for a number shown in hours and minutes. anything not yet written is written before the
// numbers are read (current()) and when the window goes away
const SAVE_EVERY_MS = 60000;
const pending = new Map(); // "login|kind" -> { login, name, kind, secs }
let lastSave = 0;
export function flushWatchTime() {
  if (!pending.size) return;
  const items = [...pending.values()];
  pending.clear();
  for (const p of items) recordWatch(p.login, p.name, p.kind, p.secs);
}
const current = () => { flushWatchTime(); return load(); };

// getNow() -> null when nothing is playing, else { login, name, kind: "live" | "vod" }
export function startWatchTracking(getNow, everyMs = 15000) {
  lastTick = lastSave = Date.now();
  setInterval(() => {
    const now = Date.now();
    const secs = Math.min(MAX_GAP_S, Math.max(0, (now - lastTick) / 1000));
    lastTick = now;
    const w = getNow();
    if (w && w.login && secs > 0) {
      const kind = w.kind === "vod" ? "vod" : "live";
      const key = `${String(w.login).toLowerCase()}|${kind}`;
      const p = pending.get(key);
      if (p) { p.secs += secs; if (w.name) p.name = w.name; }
      else pending.set(key, { login: w.login, name: w.name, kind, secs });
    }
    if (now - lastSave >= SAVE_EVERY_MS) { lastSave = now; flushWatchTime(); }
  }, everyMs);
  window.addEventListener("pagehide", flushWatchTime);
}

export function recordWatch(login, name, kind, secs, when = new Date()) {
  if (!login || !(secs > 0)) return;
  const l = String(login).toLowerCase();
  const s = load();
  const d = dayKey(when);
  const day = (s.days[d] ||= {});
  const entry = (day[l] ||= { live: 0, vod: 0 });
  const field = kind === "vod" ? "vod" : "live";
  entry[field] = Math.round((entry[field] + secs) * 10) / 10; // tenths: no 17-digit fractions in the saved file
  if (name) s.names[l] = name;
  const keys = Object.keys(s.days);
  if (keys.length > KEEP_DAYS) {
    for (const k of keys.sort().slice(0, keys.length - KEEP_DAYS)) delete s.days[k];
    // display names of channels that no longer appear in any kept day went with them (they used to stay forever)
    const seen = new Set();
    for (const day of Object.values(s.days)) for (const login of Object.keys(day || {})) seen.add(login);
    for (const login of Object.keys(s.names || {})) if (!seen.has(login)) delete s.names[login];
  }
  save(s);
}

// ---- numbers ----
export function computeStats(period, stats = current(), today = new Date()) {
  const days = period === "week" ? 7 : period === "month" ? 30 : null;
  const series = [];
  if (days) {
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const k = dayKey(d);
      series.push({ day: k, secs: dayTotal(stats.days[k]) });
    }
  }
  const included = days ? new Set(series.map((x) => x.day)) : null;
  let total = 0, live = 0, vod = 0;
  const byChannel = {};
  for (const [k, day] of Object.entries(stats.days)) {
    if (included && !included.has(k)) continue;
    for (const [login, e] of Object.entries(day)) {
      live += e.live || 0; vod += e.vod || 0;
      byChannel[login] = (byChannel[login] || 0) + (e.live || 0) + (e.vod || 0);
    }
  }
  total = live + vod;
  const top = Object.entries(byChannel).sort((a, b) => b[1] - a[1]).slice(0, 10)
    .map(([login, secs]) => ({ login, name: stats.names[login] || login, secs }));
  return { total, live, vod, series, top, streak: streak(stats, today), since: Object.keys(stats.days).sort()[0] || null };
}
// one channel's total over everything kept (KEEP_DAYS), and the first day it was watched (null if never)
export function channelWatchTime(login, stats = current()) {
  const l = String(login || "").toLowerCase();
  let secs = 0, since = null;
  for (const [day, entries] of Object.entries(stats.days)) {
    const e = entries && entries[l];
    if (!e) continue;
    secs += (e.live || 0) + (e.vod || 0);
    if (!since || day < since) since = day;
  }
  return { secs, since };
}
function dayTotal(day) {
  return day ? Object.values(day).reduce((a, e) => a + (e.live || 0) + (e.vod || 0), 0) : 0;
}
// consecutive days with at least a minute watched, ending today (or yesterday, if today has none yet)
function streak(stats, today) {
  let n = 0;
  const d = new Date(today);
  if (dayTotal(stats.days[dayKey(d)]) < 60) d.setDate(d.getDate() - 1);
  while (dayTotal(stats.days[dayKey(d)]) >= 60) { n++; d.setDate(d.getDate() - 1); }
  return n;
}
export function fmtHours(secs) {
  const m = Math.round(secs / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `${h}h ${r}m` : `${h}h`;
}

// ---- the stats view ----
let viewEl = null, popEscape = null;
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

// opts: { avatarFor(login) -> url | "", watch(login) }
export function openWatchStats(opts = {}) {
  closeWatchStats();
  const backdrop = el("div", "hub-backdrop");
  const panel = el("div", "hub-panel stats-panel");
  backdrop.appendChild(panel);
  const head = el("div", "hub-head");
  head.appendChild(el("div", "hub-title", "Watch stats"));
  const tabs = el("div", "hub-tabs");
  const close = el("button", "hub-close");
  close.type = "button"; close.title = "Close (Esc)";
  close.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';
  close.addEventListener("click", closeWatchStats);
  head.append(tabs, close);
  const body = el("div", "hub-body");
  panel.append(head, body);
  let period = "week";
  for (const [id, label] of [["week", "This week"], ["month", "This month"], ["all", "All time"]]) {
    const b = el("button", "hub-tab" + (id === period ? " active" : ""), label);
    b.type = "button";
    b.addEventListener("click", () => { period = id; tabs.querySelectorAll(".hub-tab").forEach((t) => t.classList.toggle("active", t === b)); render(); });
    tabs.appendChild(b);
  }
  function render() {
    const st = computeStats(period);
    body.replaceChildren();
    if (!st.total) {
      body.appendChild(el("div", "hub-empty", period === "all" ? "Nothing yet. Time you spend watching is counted from now on." : "Nothing watched in this period yet."));
      return;
    }
    const cards = el("div", "stats-cards");
    const card = (big, label) => { const c = el("div", "stats-card"); c.append(el("div", "stats-card-big", big), el("div", "stats-card-label", label)); cards.appendChild(c); };
    card(fmtHours(st.total), period === "all" ? `Watched since ${fmtDateMDY(st.since)}` : "Watched");
    card(st.total ? `${Math.round((st.live / st.total) * 100)}%` : "0%", `Live · ${fmtHours(st.vod)} of VODs`);
    card(`${st.streak} day${st.streak === 1 ? "" : "s"}`, "Current streak");
    body.appendChild(cards);
    if (st.series.length) {
      const max = Math.max(60, ...st.series.map((x) => x.secs));
      const chart = el("div", "stats-chart" + (st.series.length > 7 ? " dense" : ""));
      for (const x of st.series) {
        const col = el("div", "stats-col");
        col.title = `${fmtDateMDY(x.day)}: ${fmtHours(x.secs)}`;
        const bar = el("div", "stats-bar");
        bar.style.height = `${Math.max(x.secs ? 4 : 0, (x.secs / max) * 100)}%`;
        const d = new Date(`${x.day}T12:00:00`);
        col.append(bar, el("div", "stats-col-label", st.series.length > 7 ? String(d.getDate()) : d.toLocaleDateString([], { weekday: "short" })));
        chart.appendChild(col);
      }
      body.appendChild(chart);
    }
    body.appendChild(el("div", "hub-section", "Top channels"));
    const list = el("div", "stats-top");
    const topMax = st.top[0] ? st.top[0].secs : 1;
    for (const c of st.top) {
      const row = el("button", "stats-row");
      row.type = "button";
      row.title = `Watch ${c.name}`;
      const av = el("span", "stats-av");
      const url = opts.avatarFor ? opts.avatarFor(c.login) : "";
      if (url) { const img = el("img"); img.src = url; img.alt = ""; av.appendChild(img); } else av.textContent = (c.name[0] || "?").toUpperCase();
      const main = el("span", "stats-row-main");
      const bar = el("span", "stats-row-bar");
      const fill = el("span");
      fill.style.width = `${(c.secs / topMax) * 100}%`;
      bar.appendChild(fill);
      main.append(el("span", "stats-row-name", c.name), bar);
      row.append(av, main, el("span", "stats-row-time", fmtHours(c.secs)));
      row.addEventListener("click", () => { closeWatchStats(); opts.watch?.(c.login); });
      list.appendChild(row);
    }
    body.appendChild(list);
  }
  render();
  backdrop.addEventListener("mousedown", (e) => { if (e.target === backdrop) closeWatchStats(); });
  document.body.appendChild(backdrop);
  viewEl = backdrop;
  popEscape = pushEscape(closeWatchStats);
}

export function closeWatchStats() {
  viewEl?.remove();
  viewEl = null;
  popEscape?.();
  popEscape = null;
}
