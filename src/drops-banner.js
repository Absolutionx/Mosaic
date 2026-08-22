// The "this channel has Drops enabled" bar above the video. See drops.js for why: relay
// playback never counts toward Drops, so a drops-enabled channel needs a route to where
// it does. Self-contained (own DOM, listeners, state).

import { openUrl } from "@tauri-apps/plugin-opener";
import { streamHasDropsEnabled } from "./drops.js";
import { formatViewerCount } from "./format.js";

const dropsBanner = document.getElementById("drops-banner");
const dropsBannerLink = document.getElementById("drops-banner-link");
const dropsBannerViewers = document.getElementById("drops-banner-viewers");
const dropsBannerDismiss = document.getElementById("drops-banner-dismiss");
const channelInput = document.getElementById("channel-input");

// The login the user dismissed the banner for - re-renders must not reopen it, but a
// different channel re-evaluates fresh.
let manuallyDismissedFor = null;

export function updateDropsBanner(channel, stream) {
  const normalized = channel.toLowerCase();
  const dropsEnabled = Boolean(stream && streamHasDropsEnabled(stream));
  if (!dropsEnabled || manuallyDismissedFor === normalized) {
    dropsBanner.style.display = "none";
    return;
  }
  dropsBannerLink.href = `https://www.twitch.tv/${encodeURIComponent(channel)}`;
  dropsBannerViewers.textContent =
    typeof stream.viewer_count === "number"
      ? `\u2022 ${formatViewerCount(stream.viewer_count)} watching on Twitch`
      : "";
  dropsBanner.style.display = "flex";
}

/** Clears the dismissal memory on Stop, so a fresh session re-evaluates from scratch. */
export function resetDropsDismissal() {
  manuallyDismissedFor = null;
}

export function hideDropsBanner() {
  dropsBanner.style.display = "none";
}

// target="_blank" does nothing in a Tauri webview - intercept the click and hand the URL
// to openUrl(). The href stays set so it's right-click-copyable.
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
