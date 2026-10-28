// Mosaic on Android phones: the parts of the phone layout that CSS can't do alone (styles.css, "Phones").
//   body.mobile          set on Android: the whole phone layout keys off it
//   body.m-watching      the player is on screen (not Home / Browse / Videos), so video + chat take the screen
//   body.m-drawer        the Following drawer (the desktop sidebar) is open
//   a bottom tab bar     Home, Browse, Following, Drops and Settings, in place of the header's tabs
//   Android's back button  closes the drawer or a dialog first, then leaves the player for Home, like other apps
// Desktop never loads any of this: isAndroid is false there and init() returns at once.

import { invoke } from "@tauri-apps/api/core";
import { escapeCount, onEscapeChange, closeTopEscape } from "./escape-stack.js";

export const isAndroid = typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent);

const ICONS = {
  home: '<path d="m3 11 9-8 9 8"/><path d="M5 10v10h14V10"/>',
  browse: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  following: '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1.1L12 21l7.8-7.5 1-1.1a5.5 5.5 0 0 0 0-7.8z"/>',
  drops: '<path d="M12 2.7 6.3 8.4a8 8 0 1 0 11.4 0z"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  back: '<path d="M15 18 9 12l6-6"/>',
};
const svg = (d) => `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;

let tabs = null;

export function initMobile() {
  if (!isAndroid) return;
  document.body.classList.add("mobile");
  const input = document.getElementById("channel-input");
  if (input) { input.setAttribute("enterkeyhint", "go"); }
  buildTabBar();
  watchPlayer();
  wireDrawer();
  wireBack();
  wireWake();
}

// a phone drops Mosaic's connections while it's in the background or switching networks. chat reconnects on
// its own with a growing wait; coming back on screen or getting the network back makes it try right away
function wireWake() {
  const wake = () => invoke("chat_wake").catch(() => {});
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") wake(); });
  window.addEventListener("online", wake);
}

// ---- the bottom tab bar ----
function buildTabBar() {
  tabs = document.createElement("nav");
  tabs.className = "m-tabs";
  tabs.setAttribute("aria-label", "Sections");
  const items = [
    ["home", "Home", () => { closeDrawer(); document.getElementById("home-tab")?.click(); }],
    ["browse", "Browse", () => { closeDrawer(); document.getElementById("browse-tab")?.click(); }],
    ["following", "Following", () => toggleDrawer()],
    ["drops", "Drops", () => { closeDrawer(); document.getElementById("drops-tab")?.click(); }],
    ["settings", "Settings", () => { closeDrawer(); document.getElementById("settings-open-btn")?.click(); }],
  ];
  for (const [id, label, run] of items) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "m-tab";
    b.dataset.tab = id;
    b.innerHTML = `${svg(ICONS[id])}<span>${label}</span>`;
    b.addEventListener("click", run);
    tabs.appendChild(b);
  }
  document.body.appendChild(tabs);
  syncTabs();
  // the header's tabs still drive which page is shown; mirror their state
  for (const id of ["home-tab", "browse-tab"]) {
    const el = document.getElementById(id);
    if (el) new MutationObserver(syncTabs).observe(el, { attributes: true, attributeFilter: ["class"] });
  }
}
function syncTabs() {
  if (!tabs) return;
  const drawer = document.body.classList.contains("m-drawer");
  const on = drawer ? "following"
    : document.getElementById("browse-tab")?.classList.contains("nav-tab-active") ? "browse" : "home";
  tabs.querySelectorAll(".m-tab").forEach((b) => b.classList.toggle("on", b.dataset.tab === on));
}

// ---- watching: the player is showing (Home / Browse / Videos cover it otherwise) ----
function watchPlayer() {
  const frame = document.getElementById("video-frame");
  if (!frame) return;
  const sync = () => {
    const watching = getComputedStyle(frame).display !== "none";
    const was = document.body.classList.contains("m-watching");
    document.body.classList.toggle("m-watching", watching);
    if (watching && !was) closeDrawer();
    if (watching !== was) syncHistory();
  };
  new MutationObserver(sync).observe(frame, { attributes: true, attributeFilter: ["style", "class"] });
  sync();
  // a back arrow in the header while watching, the way phone apps leave a player
  const header = document.querySelector("#app > header");
  if (header && !header.querySelector(".m-back")) {
    const back = document.createElement("button");
    back.type = "button";
    back.className = "m-back";
    back.setAttribute("aria-label", "Back");
    back.innerHTML = svg(ICONS.back);
    back.addEventListener("click", () => leavePlayer());
    header.prepend(back);
  }
}
function leavePlayer() {
  document.getElementById("home-tab")?.click();
}

// ---- the Following drawer (the desktop sidebar) ----
function toggleDrawer() {
  document.body.classList.toggle("m-drawer");
  syncTabs();
  syncHistory();
}
function closeDrawer() {
  if (!document.body.classList.contains("m-drawer")) return;
  document.body.classList.remove("m-drawer");
  syncTabs();
  syncHistory();
}
function wireDrawer() {
  const side = document.getElementById("channels-sidebar");
  // picking a channel in the drawer opens it; the drawer gets out of the way
  side?.addEventListener("click", (e) => { if (e.target.closest(".sidebar-channel")) setTimeout(closeDrawer, 0); });
  const shade = document.createElement("div");
  shade.className = "m-shade";
  shade.addEventListener("click", closeDrawer);
  document.body.appendChild(shade);
}

// ---- Android's back button ----
// The webview's back button walks its history, and with nothing left it closes Mosaic. So every layer that's
// open (the player, the drawer, a dialog) keeps one history step: back takes the top one off and closes that
// layer. When a layer closes some other way (its X, a tab), its step is taken back off too, so back never
// needs pressing twice.
// Dialogs that use the shared Escape stack are counted exactly; older ones are found by their overlay class.
const DIALOGS = ".chat-filter-overlay, .whisper-overlay, .modmenu-overlay, .hidden-channels-overlay, .cp-backdrop";
let steps = 0;      // history steps Mosaic has added
let skipPops = 0;   // pops Mosaic caused itself (taking steps back off), to ignore
const dialogOpen = () => escapeCount() > 0 || !!document.querySelector(DIALOGS);
function layers() {
  const b = document.body.classList;
  return (b.contains("m-watching") ? 1 : 0) + (b.contains("m-drawer") ? 1 : 0) + (dialogOpen() ? 1 : 0);
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
  if (document.body.classList.contains("m-drawer")) { closeDrawer(); return; }
  if (document.body.classList.contains("m-watching")) leavePlayer();
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
