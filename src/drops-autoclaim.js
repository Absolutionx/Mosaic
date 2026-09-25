import { notificationAllowed, notificationOptions } from "./settings.js";
// Auto-claims Twitch Drops the moment they're claimable, so you never have to open the rewards panel.
// Polls the drops inventory on a timer and claims anything ready. Needs the device login (the inventory
// call returns nothing without it), so it quietly no-ops until that's set up.

import { invoke } from "@tauri-apps/api/core";
import { isPermissionGranted, sendNotification } from "@tauri-apps/plugin-notification";

let timer = null;

async function tick() {
  let campaigns = [];
  try {
    campaigns = await invoke("get_drops_inventory");
  } catch {
    return; // not device-connected / offline — try again next tick
  }
  if (!Array.isArray(campaigns)) return;

  for (const c of campaigns) {
    for (const d of c.drops || []) {
      if (d.claimable && !d.claimed && d.drop_instance_id) {
        try {
          await invoke("claim_drop", { dropInstanceId: d.drop_instance_id });
          console.log(`Auto-claimed drop: ${d.name}`);
          notifyClaimed(d.name, c.game);
        } catch (err) {
          console.warn(`Failed to auto-claim "${d.name}":`, err);
        }
      }
    }
  }
}

async function notifyClaimed(name, game) {
  try {
    // don't prompt for permission just for this; only notify if the user already granted it
    if (await isPermissionGranted() && notificationAllowed("drops")) { // quiet hours (Settings > Notifications)
      sendNotification(notificationOptions({ title: "Drop claimed", body: game ? `${name} — ${game}` : name }));
    }
  } catch {
    /* notifications unavailable — the claim still happened */
  }
}

export function startDropsAutoClaim() {
  if (timer) return;
  tick();
  timer = setInterval(tick, 180000); // every 3 minutes (time-based drops can't complete faster)
}

// Settings > App > Auto-claim drops switched off
export function stopDropsAutoClaim() {
  clearInterval(timer);
  timer = null;
}
