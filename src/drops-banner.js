// "this channel has Drops enabled" bar above the video. relay playback never counts
// toward Drops (see drops.js), so a drops-enabled channel needs a route to where it does

import { openUrl } from "@tauri-apps/plugin-opener";
import { streamHasDropsEnabled } from "./drops.js";
import { formatViewerCount } from "./format.js";

const dropsBanner = document.getElementById("drops-banner");
const dropsBannerLink = document.getElementById("drops-banner-link");
const dropsBannerViewers = document.getElementById("drops-banner-viewers");
const dropsBannerDismiss = document.getElementById("drops-banner-dismiss");
const channelInput = document.getElementById("channel-input");

// the login we dismissed the banner for, so re-renders don't reopen it but a
// different channel re-evaluates fresh
let manuallyDismissedFor = null;

export function updateDropsBanner(channel, stream) {
  // Drops now accrue in-app via the watch heartbeat, so the old "can't be earned here, watch on
  // Twitch" banner is obsolete and always hidden. Progress/claim live in the Points & Drops panel.
  dropsBanner.style.display = "none";
}

export function resetDropsDismissal() {
  manuallyDismissedFor = null;
}

export function hideDropsBanner() {
  dropsBanner.style.display = "none";
}

// target="_blank" does nothing in a Tauri webview, so intercept the click and hand
// the url to openUrl(). href stays set so it's right-click-copyable
dropsBannerLink.addEventListener("click", (e) => {
  e.preventDefault();
  openUrl(dropsBannerLink.href).catch((err) => {
    console.error("Failed to open Twitch link in browser:", err);
  });
});

dropsBannerDismiss.addEventListener("click", () => {
  manuallyDismissedFor = channelInput.value.trim().toLowerCase() || null;
  hideDropsBanner();
});
