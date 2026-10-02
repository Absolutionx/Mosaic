// Marks live rows/cards that currently have an active hype train with a GLOW (no badge). Any element
// tagged with data-hype-id="<broadcaster id>" is managed here: a single poller scans the whole
// document, batches the ids into one BulkAllActiveHypeTrainStatusesQuery, and toggles glow classes on
// the channels that have a train — .hype-active (purple) and additionally .hype-golden for Golden
// Kappa. One poller covers sidebar, home, and browse (and anything else that tags its cards) with no
// per-view wiring. The glow styling lives in styles.css.

import { invoke } from "@tauri-apps/api/core";
import { isPermissionGranted, sendNotification } from "@tauri-apps/plugin-notification";
import { getSetting, notificationAllowed, notificationOptions } from "./settings.js";

let timer = null;
// followed channels (sidebar rows) that had a train at the last check. null until the first check, so
// trains already running when Mosaic starts don't all notify at once
let knownTrains = null;

async function notifyTrain(name, a) {
  try {
    if (await isPermissionGranted() && notificationAllowed("hype")) {
      sendNotification(notificationOptions({
        title: `Hype train on ${name}`,
        body: `${a.golden ? "Golden Kappa train" : "A hype train"} just started${a.level ? ` · Level ${a.level}` : ""}`,
      }));
    }
  } catch { /* notifications unavailable */ }
}

async function tick() {
  // glow: Settings > Sidebar (only while the window is visible; a visibilitychange re-tick catches up).
  // notify: Settings > Notifications > Hype trains, which also runs while hidden / in the tray
  const glow = !!getSetting("hypeGlow"), notify = !!getSetting("hypeTrainNotify");
  if (!glow && !notify) { knownTrains = null; return; }
  if (document.hidden && !notify) return;
  const els = [...document.querySelectorAll("[data-hype-id]")];
  const ids = [...new Set(els.map((el) => el.dataset.hypeId).filter(Boolean))];
  if (!ids.length) return;

  let active = [];
  try {
    active = await invoke("get_active_hype_trains", { channelIds: ids });
  } catch {
    return; // network/GQL hiccup — leave glows as-is
  }
  const map = new Map((Array.isArray(active) ? active : []).map((a) => [String(a.channel_id), a]));

  if (notify) {
    // followed channels are the sidebar rows (Home / Browse cards include channels you don't follow)
    const rows = new Map(els.filter((el) => el.closest("#channels-sidebar")).map((el) => [String(el.dataset.hypeId), el]));
    const now = new Set([...map.keys()].filter((id) => rows.has(id)));
    if (knownTrains) {
      for (const id of now) {
        if (knownTrains.has(id)) continue;
        const row = rows.get(id);
        notifyTrain(row.querySelector(".sidebar-channel-name")?.textContent?.trim() || "a followed channel", map.get(id));
      }
    }
    knownTrains = now;
  } else {
    knownTrains = null;
  }
  if (!glow || document.hidden) return;

  for (const el of els) {
    const a = map.get(String(el.dataset.hypeId));
    if (a) {
      // glow on the row/card itself: purple for a normal train, golden for Golden Kappa
      el.classList.add("hype-active");
      el.classList.toggle("hype-golden", !!a.golden);
      el.title = `Hype Train${a.golden ? " (Golden Kappa)" : ""}${a.level ? ` · Level ${a.level}` : ""}`;
    } else {
      el.classList.remove("hype-active", "hype-golden");
    }
  }
}

export function startHypeBadgePolling() {
  if (timer) return;
  tick();
  timer = setInterval(tick, 20000);
  // refresh promptly when the view changes / new cards render
  document.addEventListener("visibilitychange", () => { if (!document.hidden) tick(); });
  // when any view re-renders its cards (new [data-hype-id] elements), re-apply badges right away so they
  // don't blink out until the next 20s tick. we only react to ADDED cards, not our own badge toggles, so
  // there's no feedback loop.
  let debounce;
  const obs = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType === 1 && (node.matches?.("[data-hype-id]") || node.querySelector?.("[data-hype-id]"))) {
          clearTimeout(debounce);
          debounce = setTimeout(tick, 300);
          return;
        }
      }
    }
  });
  // only where cards live (sidebar, Home, Browse). observing the whole page ran this on every chat message
  const roots = ["channels-sidebar", "home-feed", "browse-page"].map((id) => document.getElementById(id)).filter(Boolean);
  for (const root of roots.length ? roots : [document.body]) obs.observe(root, { childList: true, subtree: true });
}

// let a view trigger an immediate refresh right after it renders new cards
export function refreshHypeBadges() { tick(); }
