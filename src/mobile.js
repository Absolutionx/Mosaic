// Mosaic on Android phones. The layout and behavior follow Frosty (github.com/tommyxchow/frosty), a Twitch app
// for phones: its design, not its code (Frosty is AGPL; nothing here is taken from it).
//   bottom tabs        Following, Top, Search
//   header             the page's name, large, on the left; your profile picture on the right opens Settings
//   Following          Pinned (your favorites), All (live), Offline (folded away); long-press a stream to pin it
//   stream rows        thumbnail with uptime; channel, title, category, "1,234 viewers"
//   Top                the app's Browse page, as Streams and Categories
//   Search             your recent searches; channels and categories as you type
//   watching           no header and no bar under the video: everything is on the video, shown with a tap.
//                      Top: back, who's streaming, quality. Middle: play/pause. Bottom: uptime and viewers;
//                      refresh, rotate, and (sideways) full screen. Chat fills the rest, with one input row:
//                      emotes, the message, send, and ⋯ for chat options
//   sideways           video and chat side by side; full screen (or a double tap) gives the video the screen,
//                      with a chat button to lay chat over it, see-through
//   leaving a stream   stops it (back arrow, Android's back button or swipe)
// Body classes the CSS keys off (styles.css, "Phones"): mobile, m-watching, m-vods, m-full, m-chatover, and
// data-mtab. Desktop never runs any of this: isAndroid is false there and initMobile returns at once.

import { invoke } from "@tauri-apps/api/core";
import { escapeCount, onEscapeChange, closeTopEscape, pushEscape } from "./escape-stack.js";

export const isAndroid = typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent);

const ICONS = {
  following: '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1.1L12 21l7.8-7.5 1-1.1a5.5 5.5 0 0 0 0-7.8z"/>',
  top: '<path d="M12 19V5"/><path d="m5 12 7-7 7 7"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  back: '<path d="M15 18 9 12l6-6"/>',
  clear: '<path d="M18 6 6 18M6 6l12 12"/>',
  rotate: '<rect x="2" y="7" width="20" height="10" rx="2"/><path d="M8 3.5a9 9 0 0 1 8.5 0"/><path d="m15 2 1.5 1.5L15 5"/>',
  chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  play: '<path d="M7 4.5v15l12-7.5z" fill="currentColor"/>',
  pause: '<rect x="6" y="4.5" width="4" height="15" rx="1" fill="currentColor"/><rect x="14" y="4.5" width="4" height="15" rx="1" fill="currentColor"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>',
  full: '<path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3"/>',
  fullExit: '<path d="M9 3v3a2 2 0 0 1-2 2H4M15 3v3a2 2 0 0 0 2 2h3M9 21v-3a2 2 0 0 0-2-2H4M15 21v-3a2 2 0 0 1 2-2h3"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  more: '<circle cx="5" cy="12" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><circle cx="19" cy="12" r="1.6" fill="currentColor"/>',
  send: '<path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13"/>',
  pin: '<path d="M12 17v5"/><path d="M9 3h6l-1 6 4 4H6l4-4z"/>',
  history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 2"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  pip: '<rect x="2" y="4" width="20" height="16" rx="2"/><rect x="12" y="11" width="8" height="6" rx="1" fill="currentColor"/>',
  timer: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2 2"/><path d="M9 2h6"/>',
};
const svg = (d, size = 22) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const TITLES = { following: "Following", browse: "Top", search: "Search" };
const TAB_ICON = { following: "following", browse: "top", search: "search" };

let deps = {};
let tabs = null;
let titleEl = null;
let followingEl = null;
let searchEl = null;

// d: what the app shell provides (main.js)
//   getFollowed()            the sidebar's followed channels: { login, name, avatar, live, viewers, game, title, thumbnail, startedAt }
//   isPinned(login)          is it one of your favorites (Following's Pinned)
//   togglePin(login)         add it to, or take it out of, your favorites
//   watch(login)             start watching a channel
//   stop()                   stop the stream (the full stop the Stop button does)
//   currentChannel()         the channel playing now ("" when none)
//   searchChannels(q)        Twitch channels matching q: [{ login, name, live, game, title, avatar }]
//   searchCategories(q)      Twitch categories matching q: [{ name, box_art_url }]
//   openCategory(game)       Top's page for that category
//   openSettings()           the Settings page
export function initMobile(d = {}) {
  if (!isAndroid) return;
  deps = d;
  document.body.classList.add("mobile");
  buildHeader();
  buildPages();
  buildTabBar();
  watchPlayer();
  buildPlayerOverlay();
  buildChatRow();
  wireBack();
  wireWake();
  wireKeyboard();
  setTab("following");
}

// the keyboard: the app fits the space above it (as Twitch's does), so the video stays at the top and chat gets
// shorter, instead of the whole page sliding up out of sight. index.html asks the web view to resize for the
// keyboard (interactive-widget=resizes-content); this covers web views that only shrink the visible area
function wireKeyboard() {
  const vv = window.visualViewport;
  if (!vv) return;
  const fit = () => {
    document.documentElement.style.setProperty("--m-vh", `${Math.round(vv.height)}px`);
    // the web view scrolls the page to show the chat box; the layout already puts it in view
    if (window.scrollY || document.documentElement.scrollTop) window.scrollTo(0, 0);
  };
  vv.addEventListener("resize", fit);
  vv.addEventListener("scroll", fit);
  fit();
}

// a phone drops Mosaic's connections while it's in the background or switching networks. chat reconnects on
// its own with a growing wait; coming back on screen or getting the network back makes it try right away
function wireWake() {
  const wake = () => invoke("chat_wake").catch(() => {});
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") wake(); });
  window.addEventListener("online", wake);
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function iconBtn(cls, icon, label, onClick, size = 22) {
  const b = el("button", cls);
  b.type = "button";
  b.setAttribute("aria-label", label);
  b.title = label;
  b.innerHTML = svg(ICONS[icon], size);
  b.addEventListener("click", (e) => { e.stopPropagation(); onClick(e); });
  return b;
}

// ---- a bottom sheet of choices (long-press on a stream, as in Frosty) ----
function openSheet(title, items) {
  const shade = el("div", "m-sheet-shade");
  const sheet = el("div", "m-sheet");
  sheet.setAttribute("role", "dialog");
  sheet.appendChild(el("div", "m-sheet-grip"));
  if (title) sheet.appendChild(el("div", "m-sheet-title", title));
  let popEsc = null;
  const close = () => { shade.remove(); popEsc?.(); popEsc = null; };
  for (const it of items) {
    const b = el("button", "m-sheet-item");
    b.type = "button";
    b.innerHTML = it.icon ? svg(ICONS[it.icon], 20) : "";
    b.appendChild(el("span", null, it.label));
    b.addEventListener("click", () => { close(); it.run(); });
    sheet.appendChild(b);
  }
  shade.appendChild(sheet);
  shade.addEventListener("click", (e) => { if (e.target === shade) close(); });
  document.body.appendChild(shade);
  // Escape and Android's back button close it (escape-stack counts it as a dialog)
  popEsc = pushEscape(close);
}

// ---- header: the page's name, and your picture for Settings ----
function buildHeader() {
  const header = document.querySelector("#app > header");
  if (!header) return;
  titleEl = document.createElement("h1");
  titleEl.className = "m-title";
  header.prepend(titleEl);
  // the account button: logged in it's your picture and opens Settings (signing out lives there); logged out it
  // starts the code login (auth.js). runs before auth.js's own click handler
  const loginBtn = document.getElementById("login-btn");
  loginBtn?.addEventListener("click", (e) => {
    if (!loginBtn.classList.contains("logged-in")) return;
    e.stopImmediatePropagation();
    deps.openSettings?.();
  }, true);
}

// ---- the bottom tabs ----
function buildTabBar() {
  tabs = document.createElement("nav");
  tabs.className = "m-tabs";
  tabs.setAttribute("aria-label", "Sections");
  for (const id of ["following", "browse", "search"]) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "m-tab";
    b.dataset.tab = id;
    b.innerHTML = `${svg(ICONS[TAB_ICON[id]])}<span>${TITLES[id]}</span>`;
    b.addEventListener("click", () => {
      // tapping the tab you're on takes you back to its top, as phone apps do
      if (document.body.dataset.mtab === id && !document.body.classList.contains("m-vods")) scrollTabTop(id);
      setTab(id);
    });
    tabs.appendChild(b);
  }
  document.body.appendChild(tabs);
}

function scrollTabTop(id) {
  const target = id === "following" ? followingEl : id === "search" ? searchEl : document.getElementById("browse-page");
  target?.scrollTo?.({ top: 0, behavior: "smooth" });
}

function setTab(id) {
  document.body.dataset.mtab = id;
  if (titleEl) titleEl.textContent = TITLES[id];
  tabs?.querySelectorAll(".m-tab").forEach((b) => b.classList.toggle("on", b.dataset.tab === id));
  // Top is the app's own Browse page; the others are ours, shown over the (hidden) Home page. switching also
  // closes a channel's Videos page if one is open
  document.getElementById(id === "browse" ? "browse-tab" : "home-tab")?.click();
  if (id === "browse") topTabs();
  if (id === "following") renderFollowing();
  if (id === "search") showSearchStart();
}

// Top is the app's Browse page with Frosty's two tabs: Streams (Browse's Live, first and opened first) and
// Categories. Browse redraws its tabs as you use it, so they're renamed each time they appear
let topOpened = false;
function topTabs() {
  const page = document.getElementById("browse-page");
  if (!page) return;
  const fix = () => {
    const tabsEls = [...page.querySelectorAll(".browse-tab")];
    for (const t of tabsEls) {
      if (/^Live/.test(t.textContent.trim())) t.textContent = "Streams";
    }
    // the first time Top opens, it opens on Streams, as in Frosty
    const streams = tabsEls.find((t) => t.textContent.trim() === "Streams");
    if (!topOpened && streams && document.body.dataset.mtab === "browse") {
      topOpened = true;
      if (!streams.classList.contains("is-active")) streams.click();
    }
  };
  if (!page._mTabs) {
    page._mTabs = true;
    new MutationObserver(fix).observe(page, { childList: true, subtree: true });
  }
  fix();
}

// ---- Following and Search pages ----
function buildPages() {
  const column = document.getElementById("video-column");
  if (!column) return;
  followingEl = el("div", "m-page");
  followingEl.id = "m-following";
  searchEl = el("div", "m-page");
  searchEl.id = "m-search";
  column.prepend(followingEl, searchEl);
  buildSearch();
  // the sidebar refreshes the followed list every so often (and when you log in or out); redraw with it
  const side = document.getElementById("channels-sidebar");
  let t = null;
  if (side) new MutationObserver(() => { clearTimeout(t); t = setTimeout(renderFollowing, 250); })
    .observe(side, { childList: true, subtree: true });
  const loginBtn = document.getElementById("login-btn");
  if (loginBtn) new MutationObserver(() => renderFollowing()).observe(loginBtn, { attributes: true, attributeFilter: ["class"] });
}

function fmtUptime(startedAt) {
  const t = Date.parse(startedAt || "");
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
}

function thumbUrl(t) {
  return String(t || "").replace("{width}", "440").replace("{height}", "248");
}

// long-press a stream (as in Frosty): pin or unpin it
function onLongPress(node, run) {
  let timer = null;
  let fired = false;
  const cancel = () => { clearTimeout(timer); timer = null; };
  node.addEventListener("pointerdown", () => { fired = false; cancel(); timer = setTimeout(() => { fired = true; run(); }, 500); });
  for (const ev of ["pointerup", "pointerleave", "pointercancel", "pointermove"]) {
    node.addEventListener(ev, (e) => { if (ev !== "pointermove" || Math.abs(e.movementY) > 4) cancel(); });
  }
  node.addEventListener("contextmenu", (e) => e.preventDefault());
  // the click that ends a long press isn't a tap
  node.addEventListener("click", (e) => { if (fired) { e.stopImmediatePropagation(); e.preventDefault(); fired = false; } }, true);
}

function streamActions(c) {
  const pinned = !!deps.isPinned?.(c.login);
  openSheet(c.name || c.login, [
    { icon: "pin", label: pinned ? "Unpin" : "Pin", run: () => { deps.togglePin?.(c.login); renderFollowing(); } },
  ]);
}

// one live channel, as Frosty draws it: the thumbnail with its uptime, then who, what, the category and viewers
function liveRow(c) {
  const row = el("button", "m-row");
  row.type = "button";
  const thumb = el("div", "m-thumb");
  if (c.thumbnail) {
    const img = el("img");
    img.loading = "lazy";
    img.alt = "";
    img.src = thumbUrl(c.thumbnail);
    thumb.appendChild(img);
  }
  const up = fmtUptime(c.startedAt);
  if (up) thumb.appendChild(el("span", "m-uptime", up));
  const text = el("div", "m-row-text");
  const who = el("div", "m-row-who");
  if (c.avatar) {
    const a = el("img", "m-avatar");
    a.alt = "";
    a.loading = "lazy";
    a.src = c.avatar;
    who.appendChild(a);
  }
  who.appendChild(el("span", "m-row-name", c.name || c.login));
  text.append(who, el("div", "m-row-title", c.title || ""));
  if (c.game) {
    const game = el("div", "m-row-game", c.game);
    // the category opens its streams in Top, as in Frosty
    game.addEventListener("click", (e) => { e.stopPropagation(); setTab("browse"); deps.openCategory?.({ name: c.game }); });
    text.appendChild(game);
  }
  text.appendChild(el("div", "m-row-viewers", `${(Number(c.viewers) || 0).toLocaleString()} viewers`));
  row.append(thumb, text);
  row.addEventListener("click", () => deps.watch?.(c.login));
  onLongPress(row, () => streamActions(c));
  return row;
}

function offlineRow(c) {
  const row = el("button", "m-row m-row-offline");
  row.type = "button";
  const a = el("img", "m-avatar");
  a.alt = "";
  a.loading = "lazy";
  if (c.avatar) a.src = c.avatar;
  row.append(a, el("span", "m-row-name", c.name || c.login));
  row.addEventListener("click", () => deps.watch?.(c.login));
  onLongPress(row, () => streamActions(c));
  return row;
}

let offlineOpen = false; // Frosty keeps Offline folded until you open it
function renderFollowing() {
  if (!followingEl || document.body.dataset.mtab !== "following") return;
  const loggedIn = document.getElementById("login-btn")?.classList.contains("logged-in");
  const all = (deps.getFollowed?.() || []).filter((c) => c && c.login);
  const byViewers = (a, b) => (b.viewers || 0) - (a.viewers || 0);
  const live = all.filter((c) => c.live).sort(byViewers);
  const pinned = live.filter((c) => deps.isPinned?.(c.login));
  const rest = live.filter((c) => !deps.isPinned?.(c.login));
  const offline = all.filter((c) => !c.live).sort((a, b) => String(a.name || a.login).localeCompare(String(b.name || b.login)));
  const scroll = followingEl.scrollTop;
  followingEl.replaceChildren();
  if (!loggedIn) {
    const box = el("div", "m-empty");
    box.append(el("div", "m-empty-title", "See who you follow"), el("div", "m-empty-text", "Log in with Twitch to see the channels you follow that are live."));
    const btn = el("button", "m-empty-btn", "Log in");
    btn.type = "button";
    btn.addEventListener("click", () => document.getElementById("login-btn")?.click());
    box.appendChild(btn);
    followingEl.appendChild(box);
    return;
  }
  if (!all.length) {
    followingEl.appendChild(el("div", "m-empty-text m-loading", "Loading the channels you follow…"));
    return;
  }
  const section = (label, list) => {
    followingEl.appendChild(el("div", "m-section", label));
    const box = el("div", "m-list");
    list.forEach((c) => box.appendChild(liveRow(c)));
    followingEl.appendChild(box);
  };
  if (pinned.length) section("Pinned", pinned);
  if (rest.length) section(pinned.length ? "All" : "Live", rest);
  if (!live.length) followingEl.appendChild(el("div", "m-empty-text m-pad", "None of the channels you follow are live right now."));
  if (offline.length) {
    const head = el("button", "m-section m-section-toggle" + (offlineOpen ? " open" : ""));
    head.type = "button";
    head.append(el("span", null, `Offline · ${offline.length}`));
    head.insertAdjacentHTML("beforeend", svg(ICONS.chevron, 16));
    head.addEventListener("click", () => { offlineOpen = !offlineOpen; renderFollowing(); });
    followingEl.appendChild(head);
    if (offlineOpen) {
      const list = el("div", "m-list m-list-offline");
      offline.forEach((c) => list.appendChild(offlineRow(c)));
      followingEl.appendChild(list);
    }
  }
  followingEl.scrollTop = scroll;
}

// ---- Search: recent searches until you type, then channels and categories ----
const HISTORY_KEY = "mobileSearchHistory";
function readHistory() {
  try { const a = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]"); return Array.isArray(a) ? a.filter((x) => typeof x === "string") : []; } catch { return []; }
}
function saveHistory(term) {
  const t = String(term || "").trim();
  if (!t) return;
  const list = [t, ...readHistory().filter((x) => x.toLowerCase() !== t.toLowerCase())].slice(0, 15);
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(list)); } catch { /* ignore */ }
}
let showSearchStart = () => {};

function buildSearch() {
  const bar = el("div", "m-search-bar");
  bar.innerHTML = svg(ICONS.search, 18);
  const input = el("input", "m-search-input");
  input.type = "search";
  input.placeholder = "Search";
  input.setAttribute("enterkeyhint", "search");
  input.autocomplete = "off";
  input.spellcheck = false;
  const clear = el("button", "m-search-clear");
  clear.type = "button";
  clear.setAttribute("aria-label", "Clear");
  clear.innerHTML = svg(ICONS.clear, 16);
  bar.append(input, clear);
  const results = el("div", "m-search-results");
  searchEl.append(bar, results);

  const renderHistory = () => {
    const list = readHistory();
    results.replaceChildren();
    if (!list.length) { results.appendChild(el("div", "m-empty-text m-loading", "No recent searches")); return; }
    const head = el("div", "m-section m-section-row");
    head.appendChild(el("span", null, "History"));
    const clr = el("button", "m-text-btn", "Clear");
    clr.type = "button";
    clr.addEventListener("click", () => { try { localStorage.removeItem(HISTORY_KEY); } catch { /* ignore */ } renderHistory(); });
    head.appendChild(clr);
    results.appendChild(head);
    for (const term of list) {
      const row = el("button", "m-row m-row-history");
      row.type = "button";
      row.innerHTML = svg(ICONS.history, 20);
      row.appendChild(el("span", "m-row-name", term));
      row.addEventListener("click", () => { input.value = term; run(); });
      results.appendChild(row);
    }
  };

  let seq = 0;
  let timer = null;
  const run = async () => {
    const q = input.value.trim();
    const mine = ++seq;
    clear.style.visibility = q ? "visible" : "hidden";
    if (!q) { renderHistory(); return; }
    const [chans, cats] = await Promise.all([
      Promise.resolve(deps.searchChannels?.(q)).catch(() => null),
      Promise.resolve(deps.searchCategories?.(q)).catch(() => null),
    ]);
    if (mine !== seq) return; // a newer search started meanwhile
    results.replaceChildren();
    const channels = Array.isArray(chans) ? chans : [];
    results.appendChild(el("div", "m-section", "Channels"));
    const list = el("div", "m-list");
    for (const c of channels) {
      const row = el("button", "m-row m-row-offline");
      row.type = "button";
      const a = el("img", "m-avatar");
      a.alt = "";
      if (c.avatar) a.src = c.avatar;
      const text = el("div", "m-row-text");
      const name = el("div", "m-row-who");
      name.appendChild(el("span", "m-row-name", c.name || c.login));
      if (c.live) name.appendChild(el("span", "m-live-dot", "LIVE"));
      text.append(name, el("div", "m-row-game", c.live ? (c.game || c.title || "") : "Offline"));
      row.append(a, text);
      row.addEventListener("click", () => { saveHistory(q); deps.watch?.(c.login); });
      list.appendChild(row);
    }
    // no exact match among them: go to the channel by its name anyway, as Frosty offers
    const login = q.toLowerCase().replace(/^.*twitch\.tv\//, "").split(/[/?#\s]/)[0];
    if (/^[a-z0-9_]{2,25}$/.test(login) && !channels.some((c) => String(c.login).toLowerCase() === login)) {
      const go = el("button", "m-row m-row-direct");
      go.type = "button";
      go.append(el("span", "m-direct-label", "Go to channel"), el("span", "m-row-name", login));
      go.addEventListener("click", () => { saveHistory(q); deps.watch?.(login); });
      list.appendChild(go);
    }
    if (!list.children.length) list.appendChild(el("div", "m-empty-text m-pad", chans === null ? "Log in to search channels." : "Unable to find channel"));
    results.appendChild(list);
    results.appendChild(el("div", "m-section", "Categories"));
    const categories = Array.isArray(cats) ? cats : [];
    if (!categories.length) {
      results.appendChild(el("div", "m-empty-text m-pad", cats === null ? "Unable to load categories" : "No matching categories"));
      return;
    }
    const grid = el("div", "m-cat-grid");
    for (const g of categories.slice(0, 18)) {
      const card = el("button", "m-cat");
      card.type = "button";
      const art = el("img");
      art.alt = "";
      art.loading = "lazy";
      art.src = String(g.box_art_url || "").replace(/\d+x\d+(?=\.\w+$)/, "188x250").replace("{width}", "188").replace("{height}", "250");
      card.append(art, el("span", "m-cat-name", g.name || ""));
      card.addEventListener("click", () => { saveHistory(q); setTab("browse"); deps.openCategory?.(g); });
      grid.appendChild(card);
    }
    results.appendChild(grid);
  };
  input.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(run, 300); });
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); clearTimeout(timer); saveHistory(input.value); run(); input.blur(); } });
  clear.addEventListener("click", () => { input.value = ""; run(); input.focus(); });
  showSearchStart = () => { if (!input.value.trim()) renderHistory(); };
  run();
}

// ---- watching ----
function watchPlayer() {
  const frame = document.getElementById("video-frame");
  const vods = document.getElementById("vods-page");
  const app = document.getElementById("app");
  if (!frame) return;
  const sync = () => {
    const watching = getComputedStyle(frame).display !== "none" && !app?.classList.contains("mini-player-active");
    const inVods = !!vods && getComputedStyle(vods).display !== "none";
    const was = document.body.classList.contains("m-watching");
    const wasVods = document.body.classList.contains("m-vods");
    document.body.classList.toggle("m-watching", watching);
    document.body.classList.toggle("m-vods", inVods && !watching);
    if (!watching) document.body.classList.remove("m-full", "m-chatover");
    // a stream that ends any way (not just the back arrow) hands the screen's turning back to the phone
    if (!watching && was) setOrientation("auto");
    syncSystemBars();
    if (watching !== was) { syncAutoPip(); if (!watching) stopSleepTimer(); }
    if (titleEl) titleEl.textContent = inVods && !watching ? "Videos" : TITLES[document.body.dataset.mtab] || "";
    if (watching !== was || inVods !== wasVods) {
      if (!watching && was && document.body.dataset.mtab === "following") renderFollowing();
      syncHistory();
    }
  };
  new MutationObserver(sync).observe(frame, { attributes: true, attributeFilter: ["style", "class"] });
  if (vods) new MutationObserver(sync).observe(vods, { attributes: true, attributeFilter: ["style", "class"] });
  if (app) new MutationObserver(sync).observe(app, { attributes: true, attributeFilter: ["class"] });
  sync();
}

// leaving a stream stops it, like Frosty: back to the tab you came from
function leavePlayer() {
  heldFor = null;
  setOrientation("auto");
  if (deps.stop) deps.stop();
  else document.getElementById("home-tab")?.click();
  setTab(document.body.dataset.mtab || "following");
}

// the screen's turning (app_extras.rs set_orientation): "landscape", "portrait", or "auto" (the phone decides)
function setOrientation(mode) {
  invoke("set_orientation", { mode }).catch(() => {});
}
const isLandscape = () => window.matchMedia("(orientation: landscape)").matches;

// the phone's status and navigation bars hide while watching sideways, as in Frosty (app_extras.rs
// set_system_bars); a swipe from the edge shows them for a moment
let barsHidden = false;
function syncSystemBars() {
  const hide = document.body.classList.contains("m-watching") && isLandscape();
  if (hide === barsHidden) return;
  barsHidden = hide;
  invoke("set_system_bars", { visible: !hide }).catch(() => {});
}
window.matchMedia("(orientation: landscape)").addEventListener("change", () => syncSystemBars());

// the rotate button turns the screen and holds it there only until the phone itself is turned that way (as
// YouTube's and Twitch's apps do): from then on the phone's own turning takes over again, so turning it later
// switches between upright and sideways as usual
let heldFor = null; // "landscape" or "portrait" while the button's choice is held
function rotate() {
  heldFor = isLandscape() ? "portrait" : "landscape";
  if (heldFor === "portrait") document.body.classList.remove("m-full", "m-chatover");
  setOrientation(heldFor);
}
// how the phone is actually held, from its motion sensor (the screen's orientation is held, so it can't say)
window.addEventListener("deviceorientation", (e) => {
  if (!heldFor || e.beta == null || e.gamma == null) return;
  const beta = Math.abs(e.beta), gamma = Math.abs(e.gamma);
  const heldSideways = gamma > 55 && beta < 40;
  const heldUpright = beta > 55 && gamma < 35;
  if ((heldFor === "landscape" && heldSideways) || (heldFor === "portrait" && heldUpright)) {
    heldFor = null;
    setOrientation("auto");
  }
});

function toggleFull() {
  if (!isLandscape()) return; // upright, the video already spans the width
  const on = document.body.classList.toggle("m-full");
  if (!on) document.body.classList.remove("m-chatover");
}

// the player's overlay, laid out as Frosty's. Shown with the controls (a tap on the video); it drives the app's
// own player (the hidden desktop controls) so playback works exactly as on desktop
function buildPlayerOverlay() {
  const region = document.getElementById("video-region");
  const frame = document.getElementById("video-frame");
  const video = document.getElementById("video-element");
  if (!region || region.querySelector(".m-ov")) return;
  const ov = el("div", "m-ov");

  const top = el("div", "m-ov-top");
  top.appendChild(iconBtn("m-ov-btn", "back", "Back", () => leavePlayer(), 24));
  const info = el("div", "m-ov-info");
  const avatar = el("img", "m-ov-avatar");
  avatar.alt = "";
  const words = el("div", "m-ov-words");
  const name = el("div", "m-ov-name");
  const title = el("div", "m-ov-title");
  const game = el("div", "m-ov-game");
  words.append(name, title, game);
  info.append(avatar, words);
  top.appendChild(info);
  const chatBtn = iconBtn("m-ov-btn m-ov-chat", "chat", "Chat over the video", () => document.body.classList.toggle("m-chatover"));
  // quality and the rest of the player's settings (the app's quality menu, as a sheet)
  // the player's Options (quality, and Twitch's external playback options), as a sheet
  const qualityBtn = iconBtn("m-ov-btn", "gear", "Options", () => openPlayerOptions());
  top.append(chatBtn, qualityBtn);

  const play = el("button", "m-ov-play");
  play.type = "button";
  play.setAttribute("aria-label", "Play or pause");
  const drawPlay = () => { play.innerHTML = svg(video && !video.paused ? ICONS.pause : ICONS.play, 34); };
  play.addEventListener("click", (e) => { e.stopPropagation(); document.getElementById("play-pause-btn")?.click(); setTimeout(drawPlay, 50); });
  if (video) for (const ev of ["play", "pause", "playing"]) video.addEventListener(ev, drawPlay);
  drawPlay();

  const bottom = el("div", "m-ov-bottom");
  const stats = el("div", "m-ov-stats");
  const uptime = el("span", "m-ov-uptime");
  const viewers = el("span", "m-ov-viewers");
  stats.append(uptime, viewers);
  const right = el("div", "m-ov-right");
  const fullBtn = iconBtn("m-ov-btn m-ov-full", "full", "Full screen", () => toggleFull());
  right.append(
    iconBtn("m-ov-btn", "pip", "Picture-in-picture", () => enterPip()),
    iconBtn("m-ov-btn", "refresh", "Refresh", () => { const c = deps.currentChannel?.(); if (c) deps.watch?.(c); }),
    iconBtn("m-ov-btn", "rotate", "Turn the screen", () => rotate()),
    fullBtn,
  );
  bottom.append(stats, right);
  ov.append(top, play, bottom);
  region.appendChild(ov);

  // who's streaming, from the same data the desktop overlay uses (channel-info-bar.js)
  let startedAt = "";
  window.addEventListener("mosaic:stream-info", (e) => {
    const { channel, stream, avatarUrl } = e.detail || {};
    name.textContent = stream?.user_name || channel || "";
    title.textContent = stream?.title || "";
    game.textContent = stream?.game_name || "";
    if (avatarUrl) avatar.src = avatarUrl;
    avatar.style.visibility = avatarUrl ? "visible" : "hidden";
    startedAt = stream?.started_at || "";
    viewers.innerHTML = typeof stream?.viewer_count === "number" ? svg(ICONS.eye, 15) : "";
    if (typeof stream?.viewer_count === "number") viewers.append(stream.viewer_count.toLocaleString());
    tick();
  });
  const tick = () => {
    const up = fmtUptime(startedAt);
    uptime.textContent = up;
    uptime.style.display = up ? "" : "none";
  };
  setInterval(() => { if (frame?.classList.contains("controls-visible")) tick(); }, 1000);
  const drawFull = () => { fullBtn.innerHTML = svg(document.body.classList.contains("m-full") ? ICONS.fullExit : ICONS.full, 22); };
  new MutationObserver(drawFull).observe(document.body, { attributes: true, attributeFilter: ["class"] });

  // double tap: full screen, sideways only (upright, the video already spans the width)
  region.addEventListener("dblclick", (e) => {
    e.stopImmediatePropagation();
    e.preventDefault();
    if (isLandscape()) toggleFull();
  }, true);
  // the desktop's theater and full-screen buttons (hidden here, but their shortcuts still reach them)
  document.getElementById("theater-btn")?.addEventListener("click", (e) => { e.stopImmediatePropagation(); e.preventDefault(); rotate(); }, true);
  document.getElementById("fullscreen-btn")?.addEventListener("click", (e) => { e.stopImmediatePropagation(); e.preventDefault(); toggleFull(); }, true);
  // the desktop's PiP opens its own window, which a phone can't: Android's floating player instead
  document.getElementById("pip-btn")?.addEventListener("click", (e) => { e.stopImmediatePropagation(); e.preventDefault(); enterPip(); }, true);
  // turned upright by hand: full screen is a sideways thing
  window.matchMedia("(orientation: landscape)").addEventListener("change", (e) => {
    if (!e.matches) document.body.classList.remove("m-full", "m-chatover");
  });
}

// ---- Twitch's external playback options: background audio, picture-in-picture, sleep timer ----
const PREFS_KEY = "mobilePlayback";
function readPrefs() {
  let p = {};
  try { p = JSON.parse(localStorage.getItem(PREFS_KEY) || "{}") || {}; } catch { /* defaults */ }
  return { backgroundAudio: p.backgroundAudio === "always" ? "always" : "never", pip: p.pip !== false };
}
function savePrefs(p) {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch { /* ignore */ }
}

// picture-in-picture (app_extras.rs set_pip): with the option on, leaving the app while watching shrinks Mosaic
// to a floating video (Android 12+); the player's PiP button goes into it on any Android 8+
function syncAutoPip() {
  const on = document.body.classList.contains("m-watching") && readPrefs().pip;
  invoke("set_pip", { auto: on, enterNow: false }).catch(() => {});
}
function enterPip() {
  invoke("set_pip", { auto: readPrefs().pip, enterNow: true }).catch(() => {});
}
// while floating, the window is a small 16:9 box: show only the video in it
function syncPipLayout() {
  const small = window.innerWidth < 520 && window.innerHeight < 360 && window.innerWidth > window.innerHeight;
  const floating = small && document.body.classList.contains("m-watching");
  const was = document.body.classList.contains("m-pip");
  document.body.classList.toggle("m-pip", floating);
  if (floating && !was) keepPlayingWhileFloating();
}
window.addEventListener("resize", syncPipLayout);

// Android pauses the app (and its web view, which stops the video) when it starts floating. While it floats,
// app_extras.rs pip_keep_playing resumes the web view, and the stream plays on; once a second it also asks
// whether the app is still floating, since closing the floating window tells the page nothing. Closed, the
// stream pauses unless Background audio is Always
let floatLoop = null;
function keepPlayingWhileFloating() {
  clearInterval(floatLoop);
  const tick = async () => {
    let floating = false;
    try { floating = await invoke("pip_keep_playing"); } catch { /* not Android */ }
    const video = document.getElementById("video-element");
    if (floating) {
      if (video?.paused) document.getElementById("play-pause-btn")?.click();
      return;
    }
    // back to full size (the resize handler takes it from here) or the floating window was closed
    clearInterval(floatLoop);
    floatLoop = null;
    const small = window.innerWidth < 520 && window.innerHeight < 360;
    if (small && readPrefs().backgroundAudio === "never" && video && !video.paused) {
      pausedForBackground = true;
      document.getElementById("play-pause-btn")?.click();
    }
  };
  tick();
  floatLoop = setInterval(tick, 1000);
}

// background audio: "Never" pauses the stream when you leave the app (unless it's floating), and plays it
// again when you come back; "Always" lets it keep playing. Android can still stop an app in the background
let pausedForBackground = false;
document.addEventListener("visibilitychange", () => {
  const video = document.getElementById("video-element");
  if (!video || !document.body.classList.contains("m-watching")) return;
  if (document.visibilityState === "hidden") {
    if (readPrefs().backgroundAudio !== "never") return;
    // going into the floating window hides the page for a moment before it shrinks: wait to see which it is
    setTimeout(() => {
      if (document.visibilityState !== "hidden" || document.body.classList.contains("m-pip")) return;
      if (!video.paused) {
        pausedForBackground = true;
        document.getElementById("play-pause-btn")?.click();
      }
    }, 800);
  } else if (pausedForBackground && !document.body.classList.contains("m-pip")) {
    pausedForBackground = false;
    if (video.paused) document.getElementById("play-pause-btn")?.click();
  }
});

// sleep timer: stops the stream after a while
let sleepTimer = null;
let sleepEndsAt = 0;
function stopSleepTimer() {
  clearTimeout(sleepTimer);
  sleepTimer = null;
  sleepEndsAt = 0;
}
function startSleepTimer(minutes) {
  stopSleepTimer();
  if (!minutes) return;
  sleepEndsAt = Date.now() + minutes * 60000;
  sleepTimer = setTimeout(() => { stopSleepTimer(); if (document.body.classList.contains("m-watching")) leavePlayer(); }, minutes * 60000);
}
function sleepLabel() {
  if (!sleepEndsAt) return "Off";
  const m = Math.max(1, Math.round((sleepEndsAt - Date.now()) / 60000));
  return `Stops in ${m} min`;
}

// the Options sheet, laid out as Twitch's: Quality, then External playback options
function openPlayerOptions() {
  const prefs = readPrefs();
  const shade = el("div", "m-sheet-shade");
  const sheet = el("div", "m-sheet m-options");
  sheet.setAttribute("role", "dialog");
  sheet.appendChild(el("div", "m-sheet-grip"));
  sheet.appendChild(el("div", "m-sheet-title", "Options"));
  let popEsc = null;
  const close = () => { shade.remove(); popEsc?.(); popEsc = null; };

  const row = (title, sub, control, onClick) => {
    const r = el(onClick ? "button" : "div", "m-opt-row");
    if (onClick) { r.type = "button"; r.addEventListener("click", onClick); }
    const text = el("div", "m-opt-text");
    text.appendChild(el("div", "m-opt-title", title));
    if (sub) text.appendChild(el("div", "m-opt-sub", sub));
    r.appendChild(text);
    if (control) r.appendChild(control);
    sheet.appendChild(r);
    return r;
  };
  const toggle = (on, change) => {
    const t = el("button", "m-switch" + (on ? " on" : ""));
    t.type = "button";
    t.setAttribute("role", "switch");
    t.setAttribute("aria-checked", String(on));
    t.addEventListener("click", (e) => { e.stopPropagation(); const now = !t.classList.contains("on"); t.classList.toggle("on", now); t.setAttribute("aria-checked", String(now)); change(now); });
    return t;
  };
  const segmented = (options, value, change) => {
    const g = el("div", "m-seg");
    for (const [v, label] of options) {
      const b = el("button", "m-seg-btn" + (v === value ? " on" : ""), label);
      b.type = "button";
      b.addEventListener("click", () => { g.querySelectorAll(".m-seg-btn").forEach((x) => x.classList.toggle("on", x === b)); change(v); });
      g.appendChild(b);
    }
    return g;
  };

  const q = String(deps.currentQuality?.() || "");
  const qualityLabel = !q ? "" : q === "best" ? "Source" : q === "worst" ? "Lowest" : q === "auto" ? "Auto"
    : q === "audio_only" ? "Audio only" : q.split(",")[0];
  row("Quality", qualityLabel || "Choose the stream's quality", null, () => {
    close();
    setTimeout(() => document.getElementById("settings-btn")?.dispatchEvent(new MouseEvent("click", { bubbles: true })), 0);
  });
  sheet.appendChild(el("div", "m-opt-section", "External playback options"));
  const bg = row("Background audio", "Keep the stream's sound playing when you leave Mosaic.", null);
  bg.classList.add("m-opt-stack");
  bg.appendChild(segmented([["never", "Never"], ["always", "Always"]], prefs.backgroundAudio, (v) => { prefs.backgroundAudio = v; savePrefs(prefs); }));
  row("Picture-in-Picture", "Automatically continue playing in a floating window when you leave the app.",
    toggle(prefs.pip, (on) => { prefs.pip = on; savePrefs(prefs); syncAutoPip(); }));
  const sleep = row("Sleep timer", "Stop the stream after a while.", null);
  sleep.classList.add("m-opt-stack");
  const sleepNow = el("div", "m-opt-sub m-sleep-now", sleepLabel());
  sleep.querySelector(".m-opt-text").appendChild(sleepNow);
  sleep.appendChild(segmented([[0, "Off"], [15, "15m"], [30, "30m"], [60, "1h"], [120, "2h"]], sleepEndsAt ? -1 : 0,
    (v) => { startSleepTimer(v); sleepNow.textContent = sleepLabel(); }));

  shade.appendChild(sheet);
  shade.addEventListener("click", (e) => { if (e.target === shade) close(); });
  document.body.appendChild(shade);
  popEsc = pushEscape(close);
}

// ---- chat's input row, as Frosty has it: emotes, the message, send, ⋯ ----
function buildChatRow() {
  const row = document.getElementById("chat-input-row");
  const wrapper = document.getElementById("chat-input-wrapper");
  const input = document.getElementById("chat-input");
  const gear = document.getElementById("chat-settings-btn");
  if (!row || !wrapper || !input || row.querySelector(".m-send")) return;
  // Frosty's box just says "Chat" (the app rewrites its placeholder as chat connects; keep it short here, it
  // has to fit in the narrow sideways chat). "Log in to chat" and other states stay as the app writes them
  const shortPlaceholder = () => {
    if (/^Send a (message|reply)/i.test(input.placeholder)) input.placeholder = "Chat";
  };
  new MutationObserver(shortPlaceholder).observe(input, { attributes: true, attributeFilter: ["placeholder"] });
  shortPlaceholder();
  input.setAttribute("enterkeyhint", "send");
  // Frosty's send arrow, outside the box; it presses the app's own Send (hidden on a phone)
  const send = iconBtn("m-send", "send", "Send", () => {
    const own = document.getElementById("chat-send-btn");
    if (own && !own.disabled) own.click();
    else input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  }, 20);
  row.appendChild(send);
  // channel points (and, on channels you moderate, the mod tools) from the row Frosty doesn't have: here,
  // next to ⋯, with their own buttons and panels as on desktop
  // grouped, so sideways (narrow chat) they can sit on their own line above the box (styles.css)
  const extras = el("div", "m-chat-extras");
  for (const id of ["modmenu-btn", "modlog-btn", "rewards-btn"]) {
    const b = document.getElementById(id);
    if (b) { b.classList.add("m-chat-extra"); extras.appendChild(b); }
  }
  row.appendChild(extras);
  // the chat settings button becomes Frosty's ⋯ at the end of the row (its menu opens as a sheet)
  if (gear) {
    gear.innerHTML = svg(ICONS.more, 22);
    gear.title = "More";
    gear.setAttribute("aria-label", "More");
    row.appendChild(gear);
  }
  const syncSend = () => row.classList.toggle("m-has-text", !!input.value.trim());
  input.addEventListener("input", syncSend);
  input.addEventListener("keyup", syncSend);
  syncSend();
}

// ---- Android's back button ----
// The webview's back button walks its history, and with nothing left it closes Mosaic. So every layer that's
// open (the player, a channel's Videos page, a dialog) keeps one history step: back takes the top one off and
// closes that layer. When a layer closes some other way (its X, a tab), its step is taken back off too, so back
// never needs pressing twice. The tabs themselves add no steps: back on a tab leaves Mosaic, as in other apps.
// Dialogs that use the shared Escape stack are counted exactly; older ones are found by their overlay class.
const DIALOGS = ".chat-filter-overlay, .whisper-overlay, .modmenu-overlay, .hidden-channels-overlay, .cp-backdrop, .m-sheet-shade";
let steps = 0;      // history steps Mosaic has added
let skipPops = 0;   // pops Mosaic caused itself (taking steps back off), to ignore
const dialogOpen = () => escapeCount() > 0 || !!document.querySelector(DIALOGS);
function layers() {
  const b = document.body.classList;
  return (b.contains("m-watching") ? 1 : 0) + (b.contains("m-vods") ? 1 : 0) + (dialogOpen() ? 1 : 0);
}
function syncHistory() {
  const want = layers();
  while (steps < want) {
    try { history.pushState({ mosaic: steps + 1 }, ""); } catch { break; }
    steps++;
  }
  if (steps > want) {
    skipPops++;
    const n = steps - want;
    steps = want;
    history.go(-n);
  }
}
function closeTop() {
  if (dialogOpen()) {
    if (!closeTopEscape()) document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    return;
  }
  const b = document.body.classList;
  if (b.contains("m-watching")) { leavePlayer(); return; }
  if (b.contains("m-vods")) setTab(document.body.dataset.mtab || "following");
}
function wireBack() {
  window.addEventListener("popstate", () => {
    if (skipPops) { skipPops--; return; }
    steps = Math.max(0, steps - 1);
    closeTop();
    // whatever closing did (or didn't) change, line history back up with what's open
    setTimeout(syncHistory, 0);
  });
  onEscapeChange(() => setTimeout(syncHistory, 0));
  new MutationObserver(() => syncHistory()).observe(document.body, { childList: true });
  syncHistory();
}
