// Command palette (Ctrl+K): one search box for channels, categories, actions, settings and VODs.
// - local results (follows, recents, actions, settings, Continue watching) appear instantly
// - Twitch channel + category search runs after a short pause in typing; results merge in without moving
//   your selection, and a stale response can never overwrite a newer query's
// - prefixes: ">" actions only, "@" channels only, "#" categories only
// main.js supplies everything app-specific through initCommandPalette(deps)

import { invoke } from "@tauri-apps/api/core";

let deps = {};
let rootEl = null, inputEl = null, listEl = null, scopeEl = null;
let items = [], sel = 0, selKey = null;
let remote = { q: "", channels: [], categories: [] };
let searchTimer = null, searchSeq = 0;

const ICONS = {
  act: '<path d="M13 2 3 14h9l-1 8 10-12h-9z"/>',
  nav: '<path d="M5 12h14"/><path d="m13 6 6 6-6 6"/>',
  gear: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
  cat: '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="9" rx="1.5"/><rect x="3" y="15" width="7" height="6" rx="1.5"/><rect x="14" y="15" width="7" height="6" rx="1.5"/>',
  vod: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
};
const svg = (d) => `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const hue = (s) => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
const fmtViewers = (n) => { n = Number(n) || 0; return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}K` : String(n); };

// fuzzy: every query character in order; favors word starts and runs. returns score + matched indexes
function fuzzy(text, q) {
  const t = String(text || "").toLowerCase(), qq = q.toLowerCase();
  let ti = 0, score = 0, prev = -2;
  const hits = [];
  for (const c of qq) {
    const i = t.indexOf(c, ti);
    if (i < 0) return null;
    hits.push(i);
    score += (i === 0 || /[\s(:›_-]/.test(t[i - 1])) ? 8 : 1;
    if (i === prev + 1) score += 5;
    prev = i; ti = i + 1;
  }
  if (t.startsWith(qq)) score += 10;
  return { score: score - t.length * 0.02, hits };
}
const hl = (text, hits) => [...String(text || "")].map((ch, i) => (hits && hits.includes(i) ? `<b>${esc(ch)}</b>` : esc(ch))).join("");

export function initCommandPalette(d) {
  deps = d;
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "k") {
      e.preventDefault();
      if (rootEl) closeCommandPalette(); else openCommandPalette();
    }
  }, true);
}

export function openCommandPalette(prefix = "") {
  if (rootEl) return;
  rootEl = document.createElement("div");
  rootEl.className = "cp-backdrop";
  rootEl.innerHTML =
    '<div class="cp" role="dialog" aria-label="Command palette">' +
      `<div class="cp-input">${svg(ICONS.search)}<span class="cp-scope"></span>` +
      '<input type="text" placeholder="Search channels, actions, settings…" autocomplete="off" spellcheck="false" aria-label="Search">' +
      '<span class="cp-kbd">Esc</span></div>' +
      '<div class="cp-list" role="listbox"></div>' +
      '<div class="cp-foot"><span><span class="cp-kbd">↑</span><span class="cp-kbd">↓</span> move</span><span><span class="cp-kbd">Enter</span> open</span>' +
      '<span><span class="cp-kbd">&gt;</span> actions</span><span><span class="cp-kbd">@</span> channels</span><span><span class="cp-kbd">#</span> categories</span>' +
      '<span class="cp-foot-right"><span class="cp-kbd">Ctrl</span><span class="cp-kbd">K</span></span></div>' +
    "</div>";
  document.body.appendChild(rootEl);
  inputEl = rootEl.querySelector("input");
  listEl = rootEl.querySelector(".cp-list");
  scopeEl = rootEl.querySelector(".cp-scope");
  inputEl.value = prefix;
  inputEl.addEventListener("input", () => { selKey = null; render(); scheduleRemoteSearch(); });
  inputEl.addEventListener("keydown", onKey);
  rootEl.addEventListener("mousedown", (e) => { if (e.target === rootEl) closeCommandPalette(); });
  remote = { q: "", channels: [], categories: [] };
  render();
  inputEl.focus();
}

export function closeCommandPalette() {
  if (!rootEl) return;
  clearTimeout(searchTimer);
  searchSeq++;
  rootEl.remove();
  rootEl = null;
}

function onKey(e) {
  if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeCommandPalette(); return; }
  if (e.key === "ArrowDown") { e.preventDefault(); move(1); }
  else if (e.key === "ArrowUp") { e.preventDefault(); move(-1); }
  else if (e.key === "Enter") { e.preventDefault(); runItem(sel); }
}
function move(d) {
  if (!items.length) return;
  sel = (sel + d + items.length) % items.length;
  selKey = items[sel].key;
  paint();
}

function parseQuery() {
  const raw = inputEl.value;
  const scope = { ">": "actions", "@": "channels", "#": "categories" }[raw[0]] || null;
  return { scope, q: (scope ? raw.slice(1) : raw).trim() };
}

// Twitch channel + category search, debounced; only the latest query's answer is ever used
function scheduleRemoteSearch() {
  clearTimeout(searchTimer);
  const { scope, q } = parseQuery();
  if (q.length < 2 || scope === "actions") { remote = { q: "", channels: [], categories: [] }; return; }
  const seq = ++searchSeq;
  searchTimer = setTimeout(async () => {
    const [channels, categories] = await Promise.all([
      scope === "categories" ? [] : invoke("search_twitch_channels", { query: q }).catch(() => []),
      scope === "channels" ? [] : deps.searchCategories?.(q).catch(() => []) ?? [],
    ]);
    if (seq !== searchSeq || !rootEl) return; // a newer query (or close) superseded this one
    remote = { q, channels: channels || [], categories: categories || [] };
    render();
  }, 220);
}

// ---- building results ----
function channelRow(c, m, source) {
  const avatar = c.avatar
    ? `<img class="cp-av-img" src="${esc(c.avatar)}" alt="">`
    : `<span class="cp-av-letter" style="background:hsl(${hue(c.login)} 42% 38%)">${esc((c.name || c.login || "?")[0].toUpperCase())}</span>`;
  const sub = c.live ? (c.game || "Live") : (c.game || (source === "twitch" ? "Offline" : "Offline"));
  return {
    key: `ch:${c.login}`,
    html: `<span class="cp-av ${c.live ? "live" : "offline"}">${avatar}</span>` +
      `<span class="cp-main"><span class="cp-title">${hl(c.name || c.login, m && m.hits)}${c.favorite ? ' <span class="cp-star">★</span>' : ""}</span>` +
      `<span class="cp-sub">${esc(sub)}${source === "recent" ? " · recently watched" : ""}</span></span>` +
      `<span class="cp-meta">${c.live && c.viewers != null ? `<span class="cp-viewers">● ${fmtViewers(c.viewers)}</span>` : ""}<span class="cp-kbd cp-enter">↵</span></span>`,
    run: () => deps.watch?.(c.login),
  };
}
function iconRow(key, icon, title, sub, m, run, keys) {
  return {
    key,
    html: `<span class="cp-icon">${svg(icon)}</span><span class="cp-main"><span class="cp-title">${hl(title, m && m.hits)}</span>` +
      `<span class="cp-sub">${esc(sub)}</span></span><span class="cp-meta">${(keys || []).map((k) => `<span class="cp-kbd">${esc(k)}</span>`).join("")}` +
      '<span class="cp-kbd cp-enter">↵</span></span>',
    run,
  };
}

function buildGroups() {
  const { scope, q } = parseQuery();
  const groups = [];
  const collect = (title, list, key, toRow, limit) => {
    const out = [];
    for (const o of list) {
      const m = q ? fuzzy(key(o), q) : { score: 0, hits: [] };
      if (m) out.push({ o, m });
    }
    if (q) out.sort((a, b) => b.m.score - a.m.score);
    if (out.length) groups.push({ title, best: out[0].m.score, rows: out.slice(0, limit).map(({ o, m }) => toRow(o, q ? m : null)) });
  };
  const followed = deps.getFollowed?.() || [];
  const recent = deps.getRecent?.() || [];

  if (!q) {
    if (!scope || scope === "channels") {
      const liveFavs = followed.filter((c) => c.live && (scope || c.favorite));
      collect(scope ? "Live now" : "Live favorites", scope ? followed.filter((c) => c.live) : liveFavs, (c) => c.name, (c, m) => channelRow(c, m), scope ? 8 : 4);
      const recentRows = recent.filter((r) => !liveFavs.some((f) => f.login === r.login))
        .map((r) => followed.find((f) => f.login === r.login) || r);
      collect("Recent", recentRows, (c) => c.name, (c, m) => channelRow(c, m, "recent"), 4);
    }
    if (!scope) collect("Continue watching", deps.getContinue?.() || [], (v) => v.title, vodRow, 3);
    if (!scope || scope === "actions") collect(scope ? "Actions" : "Suggested", scope ? actions() : actions().filter((a) => a.suggested), (a) => a.title, actionRow, scope ? 30 : 4);
    if (scope === "categories") groups.push({ title: "", best: 0, rows: [], hint: "Type to search categories" });
    return groups;
  }

  if (!scope || scope === "channels") {
    collect("Your channels", followed, (c) => c.name || c.login, (c, m) => channelRow(c, m), 6);
    const known = new Set(followed.map((c) => c.login));
    if (remote.q === q) collect("On Twitch", remote.channels.filter((c) => !known.has(c.login)), (c) => c.name || c.login, (c, m) => channelRow(c, m, "twitch"), 5);
  }
  if ((!scope || scope === "categories") && remote.q === q) {
    collect("Categories", remote.categories, (g) => g.name, (g, m) => iconRow(`cat:${g.id}`, ICONS.cat, g.name, "Category", m, () => deps.openCategory?.(g)), 5);
  }
  if (!scope || scope === "actions") collect("Actions", actions(), (a) => a.title, actionRow, scope ? 30 : 5);
  if (!scope) collect("Settings", deps.getSettingsIndex?.() || [], (s) => s.title, (s, m) =>
    iconRow(`set:${s.section}:${s.title}`, ICONS.gear, s.title, `Settings › ${s.sectionLabel}`, m, () => deps.openSetting?.(s.section, s.title)), 5);
  if (!scope) collect("Continue watching", deps.getContinue?.() || [], (v) => v.title, vodRow, 3);
  groups.sort((a, b) => b.best - a.best);
  const searching = remote.q !== q && q.length >= 2 && scope !== "actions";
  if (searching) groups.push({ title: "", best: -1, rows: [], hint: "Searching Twitch…" });
  return groups;
}
function actions() { return deps.getActions?.() || []; }
function actionRow(a, m) { return iconRow(`act:${a.title}`, a.nav ? ICONS.nav : ICONS.act, a.title, a.sub || "", m, a.run, a.keys); }
function vodRow(v, m) {
  return iconRow(`vod:${v.videoId}`, ICONS.vod, v.title || "VOD", `${v.channelName || v.channelLogin || ""} · continue watching`, m, () => deps.resumeVod?.(v));
}

function render() {
  if (!rootEl) return;
  const { scope } = parseQuery();
  scopeEl.textContent = scope ? { actions: "Actions", channels: "Channels", categories: "Categories" }[scope] : "";
  scopeEl.style.display = scope ? "" : "none";
  const groups = buildGroups();
  listEl.replaceChildren();
  items = [];
  for (const g of groups) {
    if (g.title) {
      const h = document.createElement("div");
      h.className = "cp-group";
      h.textContent = g.title;
      listEl.appendChild(h);
    }
    if (g.hint) {
      const hint = document.createElement("div");
      hint.className = "cp-hint";
      hint.textContent = g.hint;
      listEl.appendChild(hint);
    }
    for (const r of g.rows) {
      const el = document.createElement("div");
      el.className = "cp-item";
      el.setAttribute("role", "option");
      el.innerHTML = r.html;
      const idx = items.length;
      el.addEventListener("mousemove", () => { if (sel !== idx) { sel = idx; selKey = r.key; paint(); } });
      el.addEventListener("click", () => runItem(idx));
      listEl.appendChild(el);
      items.push(r);
    }
  }
  if (!items.length && !listEl.querySelector(".cp-hint")) {
    const empty = document.createElement("div");
    empty.className = "cp-empty";
    empty.textContent = "Nothing matches. Try another word.";
    listEl.appendChild(empty);
  }
  // keep the selection on the same item when late Twitch results arrive; otherwise start at the top
  const keep = selKey ? items.findIndex((i) => i.key === selKey) : -1;
  sel = keep >= 0 ? keep : 0;
  paint();
}

function paint() {
  listEl.querySelectorAll(".cp-item").forEach((el, i) => el.classList.toggle("sel", i === sel));
  listEl.querySelector(".cp-item.sel")?.scrollIntoView?.({ block: "nearest" });
}

function runItem(i) {
  const r = items[i];
  if (!r) return;
  closeCommandPalette();
  try { r.run?.(); } catch (err) { console.error("[command palette]", err); }
}
