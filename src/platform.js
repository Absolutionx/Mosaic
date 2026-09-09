// thin on purpose: Rust already normalizes Kick into Helix shapes, so all this does is
// track the active mode and reroute discovery calls to their Kick equivalents

import { invoke } from "@tauri-apps/api/core";

let current = "twitch";
const listeners = new Set();

export function isKick() {
  return current === "kick";
}

export function togglePlatform() {
  setPlatform(current === "kick" ? "twitch" : "kick");
}

export function setPlatform(mode) {
  if ((mode !== "twitch" && mode !== "kick") || mode === current) return;
  current = mode;
  for (const listener of listeners) {
    try {
      listener(mode);
    } catch (err) {
      console.error("[platform] change listener failed:", err);
    }
  }
}

export function onPlatformChange(listener) {
  listeners.add(listener);
}

// only discovery commands go here. watch/chat/auth route explicitly or have no Kick
// equivalent, so they never fire in Kick mode
const KICK_FEED_COMMANDS = {
  get_top_live_streams: "kick_top_live_streams",
  get_live_streams_page: "kick_live_streams_page",
  get_top_games: "kick_top_games",
  get_streams_for_game_id: "kick_streams_for_category",
  get_streams_for_game_names: "kick_streams_for_game_names",
  search_categories: "kick_search_categories",
  get_category_viewer_counts: "kick_category_viewer_counts",
};

export function feedInvoke(command, args) {
  if (current === "kick" && KICK_FEED_COMMANDS[command]) {
    return invoke(KICK_FEED_COMMANDS[command], args ?? {});
  }
  return invoke(command, args ?? {});
}
