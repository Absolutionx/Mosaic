// Mosaic on Android phones. The layout follows Frosty (github.com/tommyxchow/frosty), a Twitch app for phones:
// its design, not its code (Frosty is AGPL; nothing here is taken from it).
//   bottom tabs        Following, Browse, Search
//   header             the page's name, large, on the left; your profile picture on the right opens Settings
//   Following          your live channels as rows (thumbnail, then channel, title, category, viewers), then offline ones
//   Search             channels and categories as you type
//   watching           no header: the video at the top, chat filling the rest; tap the video for the back arrow,
//                      who's streaming and the controls. Sideways: video and chat side by side
//   leaving a stream   stops it (back arrow, Android's back button or swipe)
// Body classes the CSS keys off (styles.css, "Phones"): mobile, m-watching, m-vods, m-full, and data-mtab.
// Desktop never runs any of this: isAndroid is false there and initMobile returns at once.

import { invoke } from "@tauri-apps/api/core";
import { escapeCount, onEscapeChange, closeTopEscape } from "./escape-stack.js";

export const isAndroid = typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent);

const ICONS = {
  following: '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1.1L12 21l7.8-7.5 1-1.1a5.5 5.5 0 0 0 0-7.8z"/>',
  browse: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  back: '<path d="M15 18 9 12l6-6"/>',
  clear: '<path d="M18 6 6 18M6 6l12 12"/>',
};
const svg = (d, size = 22) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const TITLES = { following: "Following", browse: "Browse", search: "Search" };

let deps = {};
let tabs = null;
let titleEl = null;
let followingEl = null;
let searchEl = null;

// d: what the app shell provides (main.js)
//   getFollowed()            the sidebar's followed channels: { login, name, avatar, live, viewers, game, title, thumbnail }
//   watch(login)             start watching a channel
//   stop()                   stop the stream (the full stop the Stop button does)
//   searchChannels(q)        Twitch channels matching q: [{ login, name, live, game, title, avatar }]
//   searchCategories(q)      Twitch categories matching q: [{ name, box_art_url }]
//   openCategory(game)       Browse that category
//   openSettings()           the Settings page
export function initMobile(d = {}) {
  if (!isAndroid) return;
  deps = d;
  document.body.classList.add("mobile");
  buildHeader();
  buildPages();
  buildTabBar();
  watchPlayer();
  wireVideoOverlay();
  wireBack();
  wireWake();
  setTab("following");
}

// a phone drops Mosaic's connections while it's in the background or switching networks. chat reconnects on
// its own with a growing wait; coming back on screen or getting the network back makes it try right away
function wireWake() {
  const wake = () => invoke("chat_wake").catch(() => {});
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") wake(); });
  window.addEventListener("online", wake);
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
    b.innerHTML = `${svg(ICONS[id])}<span>${TITLES[id]}</span>`;
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
  const el = id === "following" ? followingEl : id === "search" ? searchEl : document.getElementById("browse-page");
  el?.scrollTo?.({ top: 0, behavior: "smooth" });
}

function setTab(id) {
  document.body.dataset.mtab = id;
  if (titleEl) titleEl.textContent = TITLES[id];
  tabs?.querySelectorAll(".m-tab").forEach((b) => b.classList.toggle("on", b.dataset.tab === id));
  // Browse is the app's own page; the others are ours, shown over the (hidden) Home page. switching also closes
  // a channel's Videos page if one is open
  document.getElementById(id === "browse" ? "browse-tab" : "home-tab")?.click();
  if (id === "following") renderFollowing();
  if (id === "search") setTimeout(() => searchEl?.querySelector("input")?.focus(), 50);
}

// ---- Following and Search pages ----
function buildPages() {
  const column = document.getElementById("video-column");
  if (!column) return;
  followingEl = document.createElement("div");
  followingEl.id = "m-following";
  followingEl.className = "m-page";
  searchEl = document.createElement("div");
  searchEl.id = "m-search";
  searchEl.className = "m-page";
  column.prepend(followingEl, searchEl);
  buildSearch();
  // the sidebar refreshes the followed list every so often (and when you log in or out); redraw with it
  const side = document.getElementById("channels-sidebar");
  let t = null;
  if (side) new MutationObserver(() => { clearTimeout(t); t = setTimeout(renderFollowing, 250); })
    .observe(side, { childList: true, subtree: true });
  // logging in or out changes what Following can show
  const loginBtn = document.getElementById("login-btn");
  if (loginBtn) new MutationObserver(() => renderFollowing()).observe(loginBtn, { attributes: true, attributeFilter: ["class"] });
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function fmtViewers(n) {
  n = Number(n) || 0;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1).replace(/\.0$/, "")}K`;
  return String(n);
}

function thumbUrl(t) {
  return String(t || "").replace("{width}", "440").replace("{height}", "248");
}

// one live channel: thumbnail on the left with its viewer count, then who, what and the category
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
  thumb.appendChild(el("span", "m-viewers", fmtViewers(c.viewers)));
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
  text.append(who, el("div", "m-row-title", c.title || ""), el("div", "m-row-game", c.game || ""));
  row.append(thumb, text);
  row.addEventListener("click", () => deps.watch?.(c.login));
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
  return row;
}

function renderFollowing() {
  if (!followingEl || document.body.dataset.mtab !== "following") return;
  const loggedIn = document.getElementById("login-btn")?.classList.contains("logged-in");
  const all = (deps.getFollowed?.() || []).filter((c) => c && c.login);
  const live = all.filter((c) => c.live).sort((a, b) => (b.viewers || 0) - (a.viewers || 0));
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
  if (!live.length) followingEl.appendChild(el("div", "m-empty-text m-pad", "None of the channels you follow are live right now."));
  const liveList = el("div", "m-list");
  live.forEach((c) => liveList.appendChild(liveRow(c)));
  followingEl.appendChild(liveList);
  if (offline.length) {
    followingEl.appendChild(el("div", "m-section", `Offline · ${offline.length}`));
    const list = el("div", "m-list m-list-offline");
    offline.forEach((c) => list.appendChild(offlineRow(c)));
    followingEl.appendChild(list);
  }
  followingEl.scrollTop = scroll;
}

function buildSearch() {
  const bar = el("div", "m-search-bar");
  bar.innerHTML = svg(ICONS.search, 18);
  const input = el("input", "m-search-input");
  input.type = "search";
  input.placeholder = "Channels and categories";
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

  let seq = 0;
  let timer = null;
  const run = async () => {
    const q = input.value.trim();
    const mine = ++seq;
    clear.style.visibility = q ? "visible" : "hidden";
    if (!q) { results.replaceChildren(el("div", "m-empty-text m-pad", "Find a channel or a category.")); return; }
    const [chans, cats] = await Promise.all([
      Promise.resolve(deps.searchChannels?.(q)).catch(() => null),
      Promise.resolve(deps.searchCategories?.(q)).catch(() => null),
    ]);
    if (mine !== seq) return; // a newer search started meanwhile
    results.replaceChildren();
    // typing a channel's name and pressing search goes straight to it, as the desktop's Watch box does
    const direct = el("button", "m-row m-row-direct");
    direct.type = "button";
    direct.append(el("span", "m-direct-label", "Watch"), el("span", "m-row-name", q));
    direct.addEventListener("click", () => deps.watch?.(q.toLowerCase().replace(/^.*twitch\.tv\//, "").split(/[/?#]/)[0]));
    results.appendChild(direct);
    const channels = Array.isArray(chans) ? chans : [];
    if (channels.length) {
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
        row.addEventListener("click", () => deps.watch?.(c.login));
        list.appendChild(row);
      }
      results.appendChild(list);
    } else if (chans === null) {
      results.appendChild(el("div", "m-empty-text m-pad", "Log in to search channels."));
    }
    const categories = Array.isArray(cats) ? cats : [];
    if (categories.length) {
      results.appendChild(el("div", "m-section", "Categories"));
      const grid = el("div", "m-cat-grid");
      for (const g of categories.slice(0, 18)) {
        const card = el("button", "m-cat");
        card.type = "button";
        const art = el("img");
        art.alt = "";
        art.loading = "lazy";
        art.src = String(g.box_art_url || "").replace(/\d+x\d+(?=\.\w+$)/, "188x250").replace("{width}", "188").replace("{height}", "250");
        card.append(art, el("span", "m-cat-name", g.name || ""));
        card.addEventListener("click", () => { setTab("browse"); deps.openCategory?.(g); });
        grid.appendChild(card);
      }
      results.appendChild(grid);
    }
  };
  input.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(run, 300); });
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); clearTimeout(timer); run(); input.blur(); } });
  clear.addEventListener("click", () => { input.value = ""; run(); input.focus(); });
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
    if (!watching) document.body.classList.remove("m-full");
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
  if (deps.stop) deps.stop();
  else document.getElementById("home-tab")?.click();
  setTab(document.body.dataset.mtab || "following");
}

// on the video: a back arrow top-left (shown with the controls), and the full-screen button hides chat
function wireVideoOverlay() {
  const region = document.getElementById("video-region");
  if (region && !region.querySelector(".m-vback")) {
    const back = el("button", "m-vback");
    back.type = "button";
    back.setAttribute("aria-label", "Back");
    back.innerHTML = svg(ICONS.back, 24);
    back.addEventListener("click", (e) => { e.stopPropagation(); leavePlayer(); });
    region.appendChild(back);
  }
  // the desktop full-screen button resizes the window; a phone has none, so it hides chat instead
  document.getElementById("fullscreen-btn")?.addEventListener("click", (e) => {
    e.stopImmediatePropagation();
    e.preventDefault();
    document.body.classList.toggle("m-full");
  }, true);
}

// ---- Android's back button ----
// The webview's back button walks its history, and with nothing left it closes Mosaic. So every layer that's
// open (the player, a channel's Videos page, a dialog) keeps one history step: back takes the top one off and
// closes that layer. When a layer closes some other way (its X, a tab), its step is taken back off too, so back
// never needs pressing twice. The tabs themselves add no steps: back on a tab leaves Mosaic, as in other apps.
// Dialogs that use the shared Escape stack are counted exactly; older ones are found by their overlay class.
const DIALOGS = ".chat-filter-overlay, .whisper-overlay, .modmenu-overlay, .hidden-channels-overlay, .cp-backdrop";
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
