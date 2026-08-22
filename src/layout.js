// App chrome: page switching, theater mode, header/chat collapse, OS fullscreen - each
// toggles a class on #app and syncs a button. Page objects are injected (not imported) to
// avoid a cycle with main.js.

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

// --- Injected collaborators (see initLayout) ---
let homeFeed, browsePage, vodsPage;

/** The channel currently playing, for the back-to-stream pill. Injected as a getter, not
 *  imported, since playbackControls' callbacks reach back into layout (a cycle). */
let getCurrentChannel = () => "";

/** Hands layout the page objects and current-channel getter. Must run before any nav tab
 *  can be clicked. */
export function initLayout(deps) {
  homeFeed = deps.homeFeed;
  browsePage = deps.browsePage;
  vodsPage = deps.vodsPage;
  getCurrentChannel = deps.getCurrentChannel;
}

/** True OS fullscreen (no title bar) - distinct from theater mode, which only collapses
 *  the sidebar/header. */
let isFullscreen = false;

/** Read-only view of the OS-fullscreen flag, for callers that need it without owning it
 *  (main.js's Escape handler). */
export function isAppFullscreen() {
  return isFullscreen;
}

/** Only theater mode may auto-restore a header IT collapsed. A header the user collapsed
 *  by hand stays collapsed on exit. */
let _headerAutoCollapsedByTheater = false;

/** Switches between Home and Browse, keeping the nav tabs, session.lastActivePage, and the
 *  back-to-stream button in sync. Shared by both tab handlers so it's symmetric. */
export function switchPage(page) {
  if (page === session.lastActivePage && session.pageVisible) return;
  if (page === "browse") {
    homeFeed.hide();
    vodsPage.hide();
    browsePage.show();
  } else if (page === "vods") {
    homeFeed.hide();
    browsePage.hide();
    // vodsPage.show() is called by the Videos button with the channel name; switchPage("vods")
    // only manages visibility.
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
  // Theater mode collapses the sidebar for video width - pointless once Home/Browse covers
  // the video, where it just cuts off the channel list. Only relevant while playing.
  if (session.playing) setTheaterMode(false);
  updateBackToStreamBtn();
  resyncChannelInfoBarVisibility();
}


/** Shows the "Now watching: <channel>" pill only when a stream is playing AND Home/Browse
 *  is covering it (session.playing && session.pageVisible). */
export function updateBackToStreamBtn() {
  const shouldShow = session.playing && session.pageVisible;
  backToStreamBtn.style.display = shouldShow ? "flex" : "none";
  if (shouldShow) {
    backToStreamLabel.textContent = `Now watching: ${getCurrentChannel() || ""}`;
  }
}


// --- Channel info bar ---
// Fills the space below #video-frame when not in theater mode (see #channel-info-bar in
// index.html).
/**
 * Toggles sidebar-collapsing theater mode and keeps the controls-bar button in sync.
 * Centralized so the auto on-watch/on-stop behavior and the manual click share one path.
 */
export function setTheaterMode(on) {
  appEl.classList.toggle("theater-mode", on);
  theaterBtn.classList.toggle("theater-active", on);

  // Auto-hide the top bar with the sidebar entering theater mode, and restore it on exit -
  // but ONLY if theater mode collapsed it. _headerAutoCollapsedByTheater distinguishes that
  // from a manual collapse, so a manual action always wins.
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


/**
 * Flips theater mode. Shared by the button, the T shortcut, and (off-only) Escape.
 */
export function toggleTheaterModeAndResync() {
  setTheaterMode(!appEl.classList.contains("theater-mode"));
}


/**
 * Collapses/expands the top bar (#app.header-collapsed). Independent of theater mode and
 * chat-collapse - three separate grid dimensions that combine freely.
 */
export function toggleHeaderCollapse() {
  const collapsed = !appEl.classList.contains("header-collapsed");
  appEl.classList.toggle("header-collapsed", collapsed);
  // A deliberate manual toggle always overrides what theater mode was tracking, so exiting
  // theater later leaves the header as the user set it.
  _headerAutoCollapsedByTheater = false;
}


/**
 * Collapses/expands the chat column (#app.chat-collapsed). Two targets toggle the same
 * state: the Collapse button (while expanded) and the thin rail (once collapsed).
 */
export function toggleChatCollapse() {
  const collapsed = !appEl.classList.contains("chat-collapsed");
  appEl.classList.toggle("chat-collapsed", collapsed);
}


/**
 * Toggles OS-level fullscreen for the whole window via the Window API - distinct from
 * theater mode. Tracked with a local boolean since isFullscreen() is unreliable right after
 * a transition. #video-element resizes via CSS, so no resync step is needed.
 */
export async function toggleFullscreen() {
  isFullscreen = !isFullscreen;
  try {
    await appWindow.setFullscreen(isFullscreen);
  } catch (err) {
    console.error("Failed to toggle fullscreen:", err);
    isFullscreen = !isFullscreen; // revert the local flag - the call didn't take effect
    return;
  }
  appEl.classList.toggle("app-fullscreen", isFullscreen);
  fullscreenBtn.classList.toggle("is-fullscreen", isFullscreen);
  fullscreenBtn.title = isFullscreen ? "Exit Fullscreen" : "Fullscreen";
}

// Keeps isFullscreen and the button icon honest against fullscreen changes that bypassed
// toggleFullscreen() (an OS shortcut). onResized is confirmed to fire for fullscreen
// transitions, so it's a reliable re-check.
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
