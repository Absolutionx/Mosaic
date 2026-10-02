// Emote card on hover (Settings > Chat > Emote cards on hover): a bigger preview, the emote's name, where
// it's from (7TV / BetterTTV / FrankerFaceZ / Twitch / Kick, channel or global), who made it, and notes for
// renamed and zero-width emotes. Works for every emote in the app (main chat, MultiView, threads) through one
// delegated listener; the details ride on the image (chat.js _tagEmote), so hovering needs no lookups.

import { getSetting } from "./settings.js";

const SHOW_AFTER_MS = 300;
const WARM_MS = 500; // moving straight to another emote shows its card immediately

const SOURCES = {
  "seventv-channel": "7TV · Channel emote", "seventv-global": "7TV · Global emote",
  "bttv-channel": "BetterTTV · Channel emote", "bttv-global": "BetterTTV · Global emote",
  "ffz-channel": "FrankerFaceZ · Channel emote", "ffz-global": "FrankerFaceZ · Global emote",
  "kick-channel": "Kick · Channel emote", "kick-global": "Kick · Global emote", kick: "Kick emote",
  twitch: "Twitch emote",
};

let cardEl = null, showTimer = null, current = null, lastHidden = 0;

export function initEmoteCards() {
  document.addEventListener("mouseover", (e) => {
    const img = e.target.closest?.("img.chat-emote[data-emote]");
    if (!img || img === current) return;
    if (!getSetting("emoteHoverCard")) return;
    clearTimeout(showTimer);
    current = img;
    const warm = Date.now() - lastHidden < WARM_MS;
    showTimer = setTimeout(() => show(img), warm ? 0 : SHOW_AFTER_MS);
  });
  document.addEventListener("mouseout", (e) => {
    const img = e.target.closest?.("img.chat-emote[data-emote]");
    if (!img || img !== current) return;
    if (e.relatedTarget && img.contains(e.relatedTarget)) return;
    hide();
  });
  // live chat scrolls constantly as messages arrive: the card follows its emote, and only closes once the
  // emote leaves the visible chat area or is removed
  document.addEventListener("scroll", () => { if (cardEl) place(); }, true);
}

function hide() {
  clearTimeout(showTimer);
  if (cardEl) lastHidden = Date.now();
  cardEl?.remove();
  cardEl = null;
  current = null;
}

function show(img) {
  if (!img.isConnected || current !== img) return;
  cardEl?.remove();
  const d = img.dataset;
  const card = document.createElement("div");
  card.className = "emote-card";
  const preview = document.createElement("div");
  preview.className = "emote-card-preview";
  const big = document.createElement("img");
  big.alt = "";
  big.src = d.big || img.src;
  big.onerror = () => { if (big.src !== img.src) big.src = img.src; }; // larger size missing: use the chat one
  preview.appendChild(big);
  const info = document.createElement("div");
  info.className = "emote-card-info";
  const add = (cls, text) => { const e = document.createElement("div"); e.className = cls; e.textContent = text; info.appendChild(e); };
  add("emote-card-name", d.emote);
  add("emote-card-source", SOURCES[d.provider] || "Emote");
  if (d.creator) add("emote-card-meta", `by ${d.creator}`);
  if (d.original) add("emote-card-meta", `Renamed from ${d.original}`);
  if (d.zeroWidth) add("emote-card-meta", "Zero-width: overlays the emote before it");
  card.append(preview, info);
  document.body.appendChild(card);
  cardEl = card;
  place();
}

// above the emote, or below when there's no room; always inside the window. closes if the emote is gone or
// has scrolled out of its scroll area
function place() {
  const img = current, card = cardEl;
  if (!img || !card) return;
  if (!img.isConnected) { hide(); return; }
  const r = img.getBoundingClientRect();
  const scroller = img.closest(".chat-body, .multiview-chat-body, .thread-panel-body, .modlog-body");
  if (scroller) {
    const b = scroller.getBoundingClientRect();
    if (r.bottom < b.top || r.top > b.bottom) { hide(); return; }
  }
  const w = card.offsetWidth, h = card.offsetHeight;
  let top = r.top - h - 8;
  if (top < 8) top = r.bottom + 8;
  const left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2));
  card.style.top = `${Math.max(8, Math.min(window.innerHeight - h - 8, top))}px`;
  card.style.left = `${left}px`;
}
