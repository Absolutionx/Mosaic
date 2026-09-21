// Marks live rows/cards that currently have an active hype train with a GLOW (no badge). Any element
// tagged with data-hype-id="<broadcaster id>" is managed here: a single poller scans the whole
// document, batches the ids into one BulkAllActiveHypeTrainStatusesQuery, and toggles glow classes on
// the channels that have a train — .hype-active (purple) and additionally .hype-golden for Golden
// Kappa. One poller covers sidebar, home, and browse (and anything else that tags its cards) with no
// per-view wiring. The glow styling lives in styles.css.

import { invoke } from "@tauri-apps/api/core";

let timer = null;

async function tick() {
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
  obs.observe(document.body, { childList: true, subtree: true });
}

// let a view trigger an immediate refresh right after it renders new cards
export function refreshHypeBadges() { tick(); }
