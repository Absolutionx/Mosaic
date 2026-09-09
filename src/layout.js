// app chrome: page switching, theater mode, header/chat collapse, OS fullscreen. each
// toggles a class on #app and syncs a button. page objects are injected, not imported, to
// dodge a cycle with main.js

import { getCurrentWindow } from "@tauri-apps/api/window";
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

// must run before any nav tab can be clicked
export function initLayout(deps) {
  homeFeed = deps.homeFeed;
  browsePage = deps.browsePage;
  vodsPage = deps.vodsPage;
  getCurrentChannel = deps.getCurrentChannel;
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
}

export function updateBackToStreamBtn() {
  const shouldShow = session.playing && session.pageVisible;
  backToStreamBtn.style.display = shouldShow ? "flex" : "none";
  if (shouldShow) {
    backToStreamLabel.textContent = `Now watching: ${getCurrentChannel() || ""}`;
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
export async function toggleFullscreen() {
  isFullscreen = !isFullscreen;
  try {
    await appWindow.setFullscreen(isFullscreen);
  } catch (err) {
    console.error("Failed to toggle fullscreen:", err);
    isFullscreen = !isFullscreen; // revert the flag, the call didn't take
    return;
  }
  appEl.classList.toggle("app-fullscreen", isFullscreen);
  fullscreenBtn.classList.toggle("is-fullscreen", isFullscreen);
  fullscreenBtn.title = isFullscreen ? "Exit Fullscreen" : "Fullscreen";
}

// keeps isFullscreen and the button icon honest when fullscreen changes bypass
// toggleFullscreen() (an OS shortcut). onResized reliably fires on those transitions
appWindow.onResized(async () => {
  try {
    const actual = await appWindow.isFullscreen();
    if (actual !== isFullscreen) {
      isFullscreen = actual;
      appEl.classList.toggle("app-fullscreen", isFullscreen);
      fullscreenBtn.classList.toggle("is-fullscreen", isFullscreen);
      fullscreenBtn.title = isFullscreen ? "Exit Fullscreen" : "Fullscreen";
    }
  } catch (err) {
    console.error("Failed to check fullscreen state:", err);
  }
});
