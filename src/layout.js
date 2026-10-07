// app chrome: page switching, theater mode, header/chat collapse, OS fullscreen. each
// toggles a class on #app and syncs a button. page objects are injected, not imported, to
// dodge a cycle with main.js

import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { session } from "./session.js";
import { resyncChannelInfoBarVisibility } from "./channel-info-bar.js";

const appWindow = getCurrentWindow();

const appEl = document.getElementById("app");
const theaterBtn = document.getElementById("theater-btn");
const fullscreenBtn = document.getElementById("fullscreen-btn");
const homeTab = document.getElementById("home-tab");
const browseTab = document.getElementById("browse-tab");
const backToStreamBtn = document.getElementById("back-to-stream-btn");
const backToStreamLabel = document.getElementById("back-to-stream-label");

let homeFeed, browsePage, vodsPage;

// injected as a getter, not imported, since playbackControls' callbacks reach back into
// layout (a cycle)
let getCurrentChannel = () => "";
// mini-player hooks, injected from main.js (avoids a layout <-> mini-player import cycle)
let miniPlayerOn = () => {};
let miniPlayerOff = () => {};

// must run before any nav tab can be clicked
export function initLayout(deps) {
  homeFeed = deps.homeFeed;
  browsePage = deps.browsePage;
  vodsPage = deps.vodsPage;
  getCurrentChannel = deps.getCurrentChannel;
  if (deps.miniPlayerOn) miniPlayerOn = deps.miniPlayerOn;
  if (deps.miniPlayerOff) miniPlayerOff = deps.miniPlayerOff;
}

// true OS fullscreen (no title bar), distinct from theater mode which only collapses the
// sidebar/header
let isFullscreen = false;

export function isAppFullscreen() {
  return isFullscreen;
}

// only theater mode may auto-restore a header IT collapsed. one the user collapsed by
// hand stays collapsed on exit
let _headerAutoCollapsedByTheater = false;

export function switchPage(page) {
  if (page === session.lastActivePage && session.pageVisible) return;
  if (page === "browse") {
    homeFeed.hide();
    vodsPage.hide();
    browsePage.show();
  } else if (page === "vods") {
    homeFeed.hide();
    browsePage.hide();
    // vodsPage.show() is driven by the Videos button with a channel; switchPage("vods") only
    // manages visibility
    vodsPage.show(session.vodsChannel, { kick: session.vodsChannelIsKick });
  } else {
    browsePage.hide();
    vodsPage.hide();
    homeFeed.show();
  }
  session.lastActivePage = page;
  session.pageVisible = true;
  homeTab.classList.toggle("nav-tab-active", page === "home");
  browseTab.classList.toggle("nav-tab-active", page === "browse");
  // theater mode collapses the sidebar for video width, pointless once Home/Browse covers
  // the video (it just cuts off the channel list). only worth it while playing
  if (session.playing) setTheaterMode(false);
  updateBackToStreamBtn();
  resyncChannelInfoBarVisibility();
  // A stream is playing but we've navigated to a menu page: show the floating preview of it.
  if (session.playing && session.pageVisible) miniPlayerOn();
}

export function updateBackToStreamBtn() {
  const shouldShow = session.playing && session.pageVisible;
  backToStreamBtn.style.display = shouldShow ? "flex" : "none";
  if (shouldShow) {
    // "Now watching:" muted, the channel name emphasised (built with textContent, never parsed as markup)
    const pre = document.createElement("span");
    pre.className = "back-to-stream-pre";
    pre.textContent = "Now watching:";
    const name = document.createElement("span");
    name.className = "back-to-stream-name";
    name.textContent = getCurrentChannel() || "";
    backToStreamLabel.replaceChildren(pre, " ", name);
  }
}

// one path for both the auto on-watch/on-stop toggle and the manual button
export function setTheaterMode(on) {
  appEl.classList.toggle("theater-mode", on);
  theaterBtn.classList.toggle("theater-active", on);

  // auto-hide the top bar when the sidebar enters theater mode, and restore on exit, but
  // ONLY if theater collapsed it. the flag keeps a manual collapse winning
  if (on) {
    if (!appEl.classList.contains("header-collapsed")) {
      appEl.classList.add("header-collapsed");
      _headerAutoCollapsedByTheater = true;
    }
  } else if (_headerAutoCollapsedByTheater) {
    appEl.classList.remove("header-collapsed");
    _headerAutoCollapsedByTheater = false;
  }
}

export function toggleTheaterModeAndResync() {
  setTheaterMode(!appEl.classList.contains("theater-mode"));
}

// header collapse, theater, and chat collapse are three separate grid dimensions that
// combine freely
export function toggleHeaderCollapse() {
  const collapsed = !appEl.classList.contains("header-collapsed");
  appEl.classList.toggle("header-collapsed", collapsed);
  // a deliberate manual toggle overrides what theater was tracking, so leaving theater
  // later keeps the header as the user set it
  _headerAutoCollapsedByTheater = false;
}

export function toggleChatCollapse() {
  const collapsed = !appEl.classList.contains("chat-collapsed");
  appEl.classList.toggle("chat-collapsed", collapsed);
}

// tracked with a local boolean since isFullscreen() is unreliable right after a
// transition. #video-element resizes via CSS, so nothing to resync
//
// the window side lives in one Rust command (set_app_fullscreen, app_extras.rs; the why is written up
// there). in short: a maximized window goes fullscreen in place and is put back in place on exit, without
// ever dropping to its restored size and without the OS maximize animation. entering resolves true only if
// Rust had to fall back to un-maximizing the window first; that answer is handed back on exit so the window
// is maximized again.
//
// the layout switches BEFORE the window does, and without the grid's collapse animation: otherwise the
// screen-sized window first shows the old layout, then the video grows into place over ~200ms
let _remaximizeOnExit = false;
let _fsBusy = false;       // a toggle's window call is in flight
let _fsGen = 0;            // bumped per toggle, so a state check that started earlier is discarded
let _fsSnapTimer = null;

function applyFullscreenUi(on) {
  appEl.classList.add("fs-switching"); // styles.css: no grid transition while the window changes size
  appEl.classList.toggle("app-fullscreen", on);
  fullscreenBtn.classList.toggle("is-fullscreen", on);
  fullscreenBtn.title = on ? "Exit Fullscreen" : "Fullscreen";
  clearTimeout(_fsSnapTimer);
  _fsSnapTimer = setTimeout(() => appEl.classList.remove("fs-switching"), 300);
}

export async function toggleFullscreen() {
  if (_fsBusy) return;
  _fsBusy = true;
  _fsGen++;
  const on = !isFullscreen;
  isFullscreen = on;
  applyFullscreenUi(on);
  try {
    if (on) {
      _remaximizeOnExit = (await invoke("set_app_fullscreen", { on: true, remaximize: false })) === true;
      // worth knowing when a report says the switch still looks rough
      if (_remaximizeOnExit) console.warn("[fullscreen] in-place switch not possible; used the un-maximize route");
    } else {
      await invoke("set_app_fullscreen", { on: false, remaximize: _remaximizeOnExit });
      _remaximizeOnExit = false;
    }
  } catch (err) {
    console.error("Failed to toggle fullscreen:", err);
    isFullscreen = !on; // the call didn't take: put the flag and the layout back
    applyFullscreenUi(!on);
    return;
  } finally {
    _fsBusy = false;
  }
  if (isFullscreen) setTimeout(() => { fixFullscreenSurface(); }, 350);
}

// the web content must cover the whole fullscreen window. if WebView2 missed the resize (content shorter or
// narrower than the window), toggling fullscreen off and on forces it to recompute. a no-op when they match.
// the off/on pair goes through the same Rust command as a normal toggle: "off" can land on a maximized
// window, and going fullscreen from one needs that command's handling
export async function fixFullscreenSurface() {
  if (!isFullscreen || _fsBusy) return false;
  try {
    const dpr = window.devicePixelRatio || 1;
    const inner = await appWindow.innerSize();
    const offW = Math.abs(inner.width - Math.round(window.innerWidth * dpr));
    const offH = Math.abs(inner.height - Math.round(window.innerHeight * dpr));
    if (offW <= 4 && offH <= 4) return false;
    console.log(`[fullscreen] content ${Math.round(window.innerWidth * dpr)}x${Math.round(window.innerHeight * dpr)} vs window ${inner.width}x${inner.height}; re-applying fullscreen`);
    // the off/on pair resizes the window: keep onResized from reading the "off" half as an exit
    _fsBusy = true;
    _fsGen++;
    try {
      await invoke("set_app_fullscreen", { on: false, remaximize: false });
      const fellBack = (await invoke("set_app_fullscreen", { on: true, remaximize: false })) === true;
      _remaximizeOnExit = _remaximizeOnExit || fellBack;
    } finally {
      _fsBusy = false;
    }
    return true;
  } catch (err) {
    console.warn("[fullscreen] surface check failed:", err);
    return false;
  }
}

// keeps isFullscreen and the button icon honest when fullscreen changes bypass
// toggleFullscreen() (an OS shortcut). onResized reliably fires on those transitions.
// a toggle of our own also resizes the window: those are skipped, and so is a
// check that was already waiting on the window state when a toggle started, since its answer is stale
appWindow.onResized(async () => {
  if (_fsBusy) return;
  const gen = _fsGen;
  try {
    const actual = await appWindow.isFullscreen();
    if (_fsBusy || gen !== _fsGen) return;
    if (actual !== isFullscreen) {
      isFullscreen = actual;
      if (!actual) _remaximizeOnExit = false;
      applyFullscreenUi(actual);
    }
  } catch (err) {
    console.error("Failed to check fullscreen state:", err);
  }
});
