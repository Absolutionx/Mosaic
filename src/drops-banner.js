// "Drops aren't counting" bar above the video, on a Drops-enabled Twitch channel. When the watch heartbeat
// (watch_heartbeat.rs) says watching can't count, Mosaic first fixes it itself, the way logging out and back
// in would (heartbeat_repair: a fresh Twitch connection token, the stream looked up again, a minute reported
// right away). Only if that doesn't work does the bar show, with the button to connect again (main.js wires
// it to the Twitch connection editor through configureDropsBanner). It also quietly fixes the heartbeat
// thinking the video is paused while it plays. Hidden again as soon as watching counts.

import { invoke } from "@tauri-apps/api/core";
import { streamHasDropsEnabled } from "./drops.js";

const dropsBanner = document.getElementById("drops-banner");
const dropsBannerMessage = document.getElementById("drops-banner-message");
const dropsBannerLink = document.getElementById("drops-banner-link");
const dropsBannerDismiss = document.getElementById("drops-banner-dismiss");

const MESSAGES = {
  no_login: ["Drops need the Twitch connection to count here.", "Connect Twitch"],
  rejected: ["Drops aren't counting: Twitch won't accept your Twitch connection, even after Mosaic logged in again.", "Reconnect Twitch"],
};

let onReconnect = null;
let watchedChannel = null; // the drops-enabled channel being checked, if any
let dismissedFor = null; // the channel the bar was closed for, so it stays closed there
let timer = null;
let quietUntil = 0; // just reconnected: the heartbeat needs a minute to see the new connection work
let repairedAt = 0, repairedFor = null; // the automatic fix runs once per channel, at most every 10 minutes

const videoPlaying = () => {
  const v = document.getElementById("video-element");
  return !!v && !v.paused && !v.ended;
};

export function configureDropsBanner(o) { onReconnect = o.openTwitchConnection || null; }

function stopChecking() {
  clearTimeout(timer);
  timer = null;
}

async function check() {
  timer = null;
  if (!watchedChannel) return;
  const channel = watchedChannel;
  const w = await invoke("heartbeat_watching").catch(() => null);
  if (watchedChannel !== channel) return;
  const mine = w && w.login?.toLowerCase() === channel;
  // the video plays but the heartbeat missed it (a pause it never heard the end of): nothing would count
  if (mine && !w.playing && videoPlaying()) invoke("heartbeat_set_playing", { playing: true }).catch(() => {});
  let health = mine ? w.health : "ok";
  if (MESSAGES[health] && (repairedFor !== channel || Date.now() - repairedAt > 600000)) {
    repairedFor = channel; repairedAt = Date.now();
    health = await invoke("heartbeat_repair", { playing: videoPlaying() }).catch(() => health);
    if (watchedChannel !== channel) return;
  }
  const msg = MESSAGES[health];
  if (msg && dismissedFor !== watchedChannel && Date.now() > quietUntil) {
    dropsBannerMessage.textContent = msg[0];
    dropsBannerLink.textContent = msg[1];
    dropsBannerLink.dataset.mode = health;
    dropsBanner.style.display = "";
  } else {
    dropsBanner.style.display = "none";
  }
  // the heartbeat learns the answer within its first minute; after that, keep an eye out for changes
  timer = setTimeout(check, 20000);
}

export function updateDropsBanner(channel, stream) {
  stopChecking();
  dropsBanner.style.display = "none";
  watchedChannel = streamHasDropsEnabled(stream) ? String(channel || "").toLowerCase() : null;
  if (watchedChannel) timer = setTimeout(check, 5000);
}

export function resetDropsDismissal() {
  dismissedFor = null;
}

export function hideDropsBanner() {
  stopChecking();
  watchedChannel = null;
  dropsBanner.style.display = "none";
}

dropsBannerLink.addEventListener("click", (e) => {
  e.preventDefault();
  const reconnect = dropsBannerLink.dataset.mode === "rejected";
  onReconnect?.({ reconnect }, () => {
    quietUntil = Date.now() + 90000;
    dropsBanner.style.display = "none";
  });
});

dropsBannerDismiss.addEventListener("click", () => {
  dismissedFor = watchedChannel;
  dropsBanner.style.display = "none";
});
