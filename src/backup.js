// Settings > App > Back up / Restore: everything that's yours in one JSON file. Settings, favorites, hidden
// channels, chat filter, Kick follows and aliases, per-channel volumes, Track ID history and window
// positions (localStorage), plus notification bells and private user notes (stored on the Rust side).
// Only the keys listed here are ever written back on restore, so a backup can't inject anything else.
// Caches (heatmaps, the session being resumed) are left out; login tokens aren't in either store.

import { invoke } from "@tauri-apps/api/core";

const LOCAL_KEYS = [
  "mosaicSettings", "lowLatency", "catchUpToLive", "autoPipOnBlur", "closeToTray",
  "favoriteChannels", "hiddenChannels", "chatFilter", "kickFollows", "kickAliases",
  "channelVolumes", "trackIdHistory", "homeMvLayout", "miniPlayerPos", "pipWinSize", "pipWinPos",
];

export async function exportBackup() {
  const local = {};
  for (const k of LOCAL_KEYS) {
    const v = localStorage.getItem(k);
    if (v !== null) local[k] = v;
  }
  const [channels, categoryTargets, noteIds] = await Promise.all([
    invoke("get_notify_channels").catch(() => []),
    invoke("get_notify_category_targets").catch(() => ({})),
    invoke("get_user_note_ids").catch(() => []),
  ]);
  const notes = {};
  for (const id of noteIds || []) {
    const text = await invoke("get_user_note", { userId: id }).catch(() => "");
    if (text) notes[id] = text;
  }
  const backup = {
    app: "Mosaic", kind: "settings-backup", format: 1, created: new Date().toISOString(),
    local, notify: { channels: channels || [], categoryTargets: categoryTargets || {} }, notes,
  };
  return invoke("save_backup_file", { contents: JSON.stringify(backup, null, 2) }); // -> saved path
}

// returns a short summary; throws with a readable message on a bad file
export async function importBackup(text) {
  let b;
  try { b = JSON.parse(text); } catch { throw new Error("That file isn't a Mosaic backup (not valid JSON)."); }
  if (!b || b.app !== "Mosaic" || b.kind !== "settings-backup") throw new Error("That file isn't a Mosaic backup.");
  let restored = 0;
  for (const k of LOCAL_KEYS) {
    if (b.local && typeof b.local[k] === "string") { localStorage.setItem(k, b.local[k]); restored++; }
  }
  if (b.notify) {
    if (Array.isArray(b.notify.channels)) await invoke("set_notify_channels", { channels: b.notify.channels.map(String) }).catch(() => {});
    if (b.notify.categoryTargets && typeof b.notify.categoryTargets === "object") {
      await invoke("set_notify_category_targets", { targets: b.notify.categoryTargets }).catch(() => {});
    }
  }
  let notes = 0;
  for (const [id, text] of Object.entries(b.notes || {})) {
    if (typeof text === "string") { await invoke("set_user_note", { userId: String(id), note: text }).catch(() => {}); notes++; }
  }
  return `Restored ${restored} settings group${restored === 1 ? "" : "s"} and ${notes} note${notes === 1 ? "" : "s"}.`;
}
