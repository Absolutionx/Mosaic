import { notificationAllowed, notificationOptions } from "./settings.js";
// Auto-claims Twitch Drops the moment they're claimable, so you never have to open the rewards panel.
// Polls the drops inventory on a timer and claims anything ready. Needs the device login (the inventory
// call returns nothing without it), so it quietly no-ops until that's set up.

import { invoke } from "@tauri-apps/api/core";
import { isPermissionGranted, sendNotification } from "@tauri-apps/plugin-notification";

let timer = null;

// instance ids already confirmed claimed (never claimed or announced twice, even if Twitch keeps listing
// them) and refused ones with their next retry time (hourly, not every tick). kept across restarts
const DONE_KEY = "dropsClaimDone", RETRY_KEY = "dropsClaimRetry";
const RETRY_AFTER_MS = 60 * 60 * 1000, FORGET_AFTER_MS = 14 * 24 * 60 * 60 * 1000;
const loadMap = (k) => { try { return JSON.parse(localStorage.getItem(k) || "{}") || {}; } catch { return {}; } };
const saveMap = (k, m) => {
  const now = Date.now();
  for (const [id, at] of Object.entries(m)) if (now - at > FORGET_AFTER_MS) delete m[id];
  try { localStorage.setItem(k, JSON.stringify(m)); } catch { /* quota */ }
};

async function tick() {
  let campaigns = [];
  try {
    campaigns = await invoke("get_drops_inventory");
  } catch {
    return; // not device-connected / offline — try again next tick
  }
  if (!Array.isArray(campaigns)) return;

  const done = loadMap(DONE_KEY), retry = loadMap(RETRY_KEY);
  const now = Date.now();
  for (const c of campaigns) {
    for (const d of c.drops || []) {
      const id = d.drop_instance_id;
      if (!d.claimable || d.claimed || !id) continue;
      if (done[id]) continue;                                   // already claimed + announced
      if (retry[id] && now - retry[id] < RETRY_AFTER_MS) continue; // refused recently: wait
      try {
        // resolves only when Twitch confirmed the claim (helix.rs claim_result)
        await invoke("claim_drop", { dropInstanceId: id });
        done[id] = now;
        delete retry[id];
        console.log(`Auto-claimed drop: ${d.name}`);
        notifyClaimed(d.name, c.game);
      } catch (err) {
        retry[id] = now;
        console.warn(`Twitch refused auto-claim of "${d.name}" (retrying in an hour):`, err);
      }
    }
  }
  saveMap(DONE_KEY, done);
  saveMap(RETRY_KEY, retry);
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
