// Badges live rows/cards that currently have an active hype train. Any element tagged with
// data-hype-id="<broadcaster id>" and containing a .hype-badge child is managed here: a single poller
// scans the whole document, batches the ids into one BulkAllActiveHypeTrainStatusesQuery, and shows the
// badge on the channels that have a train (gold-tinted for Golden Kappa). One poller covers sidebar,
// home, and browse (and anything else that tags its cards) with no per-view wiring.

import { invoke } from "@tauri-apps/api/core";

let timer = null;

export function makeHypeBadge() {
  const b = document.createElement("span");
  b.className = "hype-badge";
  b.style.display = "none";
  b.innerHTML =
    '<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" aria-hidden="true"><path d="M12 2c-4 0-8 .5-8 4v9.5A3.5 3.5 0 0 0 7.5 19L6 20.5v.5h2l1.5-1.5h5L16 21h2v-.5L16.5 19a3.5 3.5 0 0 0 3.5-3.5V6c0-3.5-4-4-8-4zM7.5 17A1.5 1.5 0 1 1 9 15.5 1.5 1.5 0 0 1 7.5 17zM11 10H6V6.5h5zm2 0V6.5h5V10zm3.5 7a1.5 1.5 0 1 1 1.5-1.5 1.5 1.5 0 0 1-1.5 1.5z"/></svg><span class="hype-badge-lvl"></span>';
  return b;
}

async function tick() {
  const els = [...document.querySelectorAll("[data-hype-id]")];
  const ids = [...new Set(els.map((el) => el.dataset.hypeId).filter(Boolean))];
  if (!ids.length) return;

  let active = [];
  try {
    active = await invoke("get_active_hype_trains", { channelIds: ids });
  } catch {
    return; // network/GQL hiccup — leave badges as-is
  }
  const map = new Map((Array.isArray(active) ? active : []).map((a) => [String(a.channel_id), a]));

  for (const el of els) {
    const badge = el.querySelector(".hype-badge");
    if (!badge) continue;
    const a = map.get(String(el.dataset.hypeId));
    if (a) {
      badge.style.display = "";
      badge.classList.toggle("golden", !!a.golden);
      const lvl = badge.querySelector(".hype-badge-lvl");
      if (lvl) lvl.textContent = a.level > 0 ? String(a.level) : "";
      badge.title = `Hype Train${a.golden ? " (Golden Kappa)" : ""}${a.level ? ` · Level ${a.level}` : ""}`;
    } else {
      badge.style.display = "none";
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
