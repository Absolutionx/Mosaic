// Amazon Luna benefits: the crown in the header, like twitch.tv's (Prime Gaming became Amazon Luna). The
// games and in-game loot you can claim with Prime this month, through the device login (unofficial,
// get_prime_offers / claim_prime_offer in helix.rs).
//
// - Claim Games: each offer with its picture, what it is, and Claim / More info. Loot and codes are claimed
//   right here; a game delivered by Amazon (an "external" offer) opens its claim page on Luna instead
// - Play Now: Luna's cloud games live on Amazon's site, so this tab sends you there
// - a white dot on the crown when there's an offer you haven't looked at yet (remembered in localStorage)
// Settings > App > Amazon Luna button hides the crown.

import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getSetting, onSettingChange } from "./settings.js";
import { pushEscape } from "./escape-stack.js";

const LUNA_URL = "https://luna.amazon.com/";
const SEEN_KEY = "lunaSeenOffers";
const POLL_MS = 6 * 60 * 60 * 1000;

const ICON = (d, size = 16) =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const X = '<path d="M18 6 6 18M6 6l12 12"/>';
const OUT = '<path d="M7 17 17 7"/><path d="M8 7h9v9"/>';
const CROWN = '<path d="M3 18h18"/><path d="m3 8 4.5 4L12 5l4.5 7L21 8l-2 10H5Z"/>';

// ---- pure helpers ----

// Twitch's offer text is markdown: plain text, links as their words, list markers and emphasis dropped
export function plainText(md) {
  return String(md || "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\*\*|__|`/g, "")
    .replace(/^[ \t]*[-*][ \t]+/gm, "• ")
    .replace(/^#+\s*/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// the short line under the picture: the first sentence/line of the description, else the game's name
export function tagline(o) {
  const first = plainText(o.description).split(/\n|(?<=[.!?])\s/)[0] || "";
  return first.length > 90 ? first.slice(0, 88) + "…" : first || o.game || "";
}

// how Claim works for an offer: "app" (claimed here), "link" (opens a page), or null (nothing to do)
export function claimMode(o) {
  if (!o || o.claimed) return null;
  if (o.delivery === "EXTERNAL_OFFER" || o.delivery === "EXTERNAL") return "link";
  if (o.delivery === "DIRECT_ENTITLEMENT" || o.delivery === "CLAIM_CODE" || o.delivery === "SES_ENTITLEMENT") return "app";
  return "link";
}

export function claimUrl(o) {
  return o && /^https:\/\//i.test(o.url || "") ? o.url : LUNA_URL;
}

const readSeen = () => { try { const v = JSON.parse(localStorage.getItem(SEEN_KEY) || "[]"); return new Set(Array.isArray(v) ? v : []); } catch { return new Set(); } };
const writeSeen = (ids) => { try { localStorage.setItem(SEEN_KEY, JSON.stringify([...ids].slice(-200))); } catch { /* ignore */ } };

// ---- state ----
let deps = { connectTwitch: (done) => done?.() };
let btn = null, dot = null, panel = null, popEscape = null;
let data = null, connected = null, loading = false, error = null, lastLoad = 0;
let tab = "claim";
const expanded = new Set();
const busy = new Set();
const results = new Map(); // offer id -> { claimed, claim_data, error }

function updateDot() {
  if (!dot) return;
  const seen = readSeen();
  const fresh = (data?.offers || []).some((o) => !o.claimed && !seen.has(o.id));
  dot.style.display = fresh && !panel ? "" : "none";
}

async function load(force = false) {
  if (loading || (!force && data && Date.now() - lastLoad < 5 * 60 * 1000)) return;
  loading = true; error = null;
  if (panel) render();
  try {
    const r = await invoke("get_prime_offers");
    if (r === null) { connected = false; data = null; }
    else { connected = true; data = r; lastLoad = Date.now(); }
  } catch (e) {
    error = typeof e === "string" ? e : "Couldn't load the offers";
    console.warn("[luna]", e);
  }
  loading = false;
  updateDot();
  if (panel) render();
}

export function initLunaPanel(options = {}) {
  deps = { ...deps, ...options };
  btn = document.getElementById("luna-btn");
  dot = document.getElementById("luna-dot");
  if (!btn) return;
  btn.addEventListener("click", (e) => { e.stopPropagation(); if (panel) closeLunaPanel(); else openLunaPanel(); });
  const applyVisible = () => {
    const on = !!getSetting("lunaButton");
    btn.style.display = on ? "" : "none";
    if (!on) closeLunaPanel();
  };
  applyVisible();
  onSettingChange((id) => { if (id === "lunaButton") { applyVisible(); if (getSetting("lunaButton")) load(true); } });
  setTimeout(() => { if (getSetting("lunaButton")) load(); }, 6000);
  setInterval(() => { if (getSetting("lunaButton")) load(true); }, POLL_MS);
}

// the device login changed: start over
export function resetLuna() {
  data = null; connected = null; error = null; results.clear();
  updateDot();
  if (panel) { render(); load(true); }
}

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

export function openLunaPanel() {
  if (panel || !btn) return;
  panel = el("div", "notif-panel luna-panel");
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "Amazon Luna benefits");
  document.body.appendChild(panel);
  btn.classList.add("open");
  place();
  window.addEventListener("resize", place);
  setTimeout(() => document.addEventListener("mousedown", onOutside, true), 0);
  popEscape = pushEscape(() => closeLunaPanel());
  render();
  load();
}

export function closeLunaPanel() {
  if (!panel) return;
  // everything that was on screen counts as looked at: the dot goes until something new arrives
  if (data?.offers?.length) { const seen = readSeen(); for (const o of data.offers) seen.add(o.id); writeSeen(seen); }
  panel.remove();
  panel = null;
  btn?.classList.remove("open");
  window.removeEventListener("resize", place);
  document.removeEventListener("mousedown", onOutside, true);
  popEscape?.(); popEscape = null;
  updateDot();
}

function onOutside(e) {
  if (!panel) return;
  if (panel.contains(e.target) || btn.contains(e.target)) return;
  closeLunaPanel();
}

function place() {
  if (!panel || !btn) return;
  const r = btn.getBoundingClientRect();
  const w = Math.min(380, window.innerWidth - 16);
  panel.style.width = `${w}px`;
  panel.style.top = `${Math.round(r.bottom + 8)}px`;
  panel.style.left = `${Math.round(Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8)))}px`;
  panel.style.maxHeight = `${Math.max(260, window.innerHeight - r.bottom - 24)}px`;
}

function linkButton(label, url, cls = "luna-btn") {
  const b = el("button", cls);
  b.type = "button";
  b.append(el("span", null, label));
  b.insertAdjacentHTML("beforeend", ICON(OUT, 13));
  b.addEventListener("click", () => openUrl(url).catch(() => {}));
  return b;
}

function render() {
  if (!panel) return;
  const keepScroll = panel.querySelector(".luna-scroll")?.scrollTop || 0;
  panel.replaceChildren();

  const head = el("div", "notif-head luna-head");
  const title = el("div", "luna-title");
  title.insertAdjacentHTML("afterbegin", ICON(CROWN, 17));
  title.append(el("span", null, "Amazon Luna benefits"));
  const close = el("button", "notif-icon-btn");
  close.type = "button"; close.title = "Close (Esc)"; close.setAttribute("aria-label", "Close"); close.innerHTML = ICON(X, 16);
  close.addEventListener("click", closeLunaPanel);
  head.append(title, close);
  panel.append(head);

  const scroll = el("div", "luna-scroll");
  const intro = el("div", "luna-intro");
  intro.append(
    el("div", "luna-intro-title", "More games, more ways to play"),
    el("div", "luna-intro-text", "Prime members can claim PC games and in-game loot, and play games from the cloud, all on Amazon Luna."),
    linkButton("Explore Luna", LUNA_URL, "luna-btn primary"),
  );
  scroll.append(intro);

  const tabs = el("div", "notif-tabs luna-tabs");
  for (const [id, label] of [["claim", "Claim Games"], ["play", "Play Now"]]) {
    const b = el("button", "notif-tab" + (tab === id ? " active" : ""), label);
    b.type = "button";
    b.addEventListener("click", () => { tab = id; render(); });
    tabs.append(b);
  }
  scroll.append(tabs);

  if (tab === "play") {
    const p = el("div", "luna-note");
    p.append(
      el("div", null, "Luna's cloud games play on Amazon's site and apps. Twitch doesn't hand that list to other apps, so it opens there."),
      linkButton("Play on Luna", LUNA_URL, "luna-btn primary"),
    );
    scroll.append(p);
  } else if (connected === false) {
    const p = el("div", "luna-note");
    const go = el("button", "luna-btn primary", "Connect Twitch");
    go.type = "button";
    go.addEventListener("click", () => { closeLunaPanel(); deps.connectTwitch(() => { resetLuna(); openLunaPanel(); }); });
    p.append(el("div", null, "Your Prime offers come through the same Twitch connection as drops and channel points."), go);
    scroll.append(p);
  } else if (!data && (loading || connected === null)) {
    scroll.append(el("div", "notif-empty", "Loading…"));
  } else if (error && !data) {
    const p = el("div", "luna-note");
    p.append(el("div", null, "Twitch didn't send the offers this time."), linkButton("See them on Luna", LUNA_URL));
    scroll.append(p);
  } else {
    const offers = data.offers || [];
    if (data.eligibility && offers.length && offers.every((o) => o.prime === false)) {
      const warn = el("div", "luna-warn");
      warn.append(el("div", null, "Claiming needs Amazon Prime linked to your Twitch account."), linkButton("Link Prime", "https://www.twitch.tv/prime", "luna-btn"));
      scroll.append(warn);
    }
    if (!offers.length) scroll.append(el("div", "notif-empty", "No offers right now."));
    for (const o of offers) scroll.append(buildOffer(o));
  }
  panel.append(scroll);
  scroll.scrollTop = keepScroll;
}

function buildOffer(o) {
  const res = results.get(o.id);
  const claimed = !!(o.claimed || res?.claimed);
  const card = el("div", "luna-offer" + (claimed ? " claimed" : ""));
  card.append(el("div", "luna-offer-name", o.game || o.title));
  if (o.image) {
    const pic = el("div", "luna-offer-pic");
    const img = el("img");
    img.src = o.image; img.alt = ""; img.loading = "lazy";
    img.addEventListener("error", () => pic.remove());
    pic.append(img);
    if (claimed) pic.append(el("span", "luna-offer-badge", "Claimed"));
    card.append(pic);
  }
  card.append(el("div", "luna-offer-title", o.title && o.title !== o.game ? o.title : tagline(o)));
  if (o.publisher) card.append(el("div", "luna-offer-sub", o.publisher));

  const code = res?.claim_data || o.claim_data;
  if (claimed && code) {
    const codeRow = el("div", "luna-code");
    const isUrl = /^https:\/\//i.test(code);
    codeRow.append(el("span", "luna-code-text", code));
    const copy = el("button", "luna-btn small", isUrl ? "Open" : "Copy");
    copy.type = "button";
    copy.addEventListener("click", () => {
      if (isUrl) { openUrl(code).catch(() => {}); return; }
      navigator.clipboard?.writeText(code).then(() => { copy.textContent = "Copied"; setTimeout(() => { copy.textContent = "Copy"; }, 1500); }).catch(() => {});
    });
    codeRow.append(copy);
    card.append(codeRow);
  }
  if (res?.error && !claimed) card.append(el("div", "luna-error", res.error));

  const actions = el("div", "luna-offer-actions");
  const mode = claimMode({ ...o, claimed });
  if (claimed) {
    const b = el("button", "luna-btn primary", "Claimed");
    b.type = "button"; b.disabled = true;
    actions.append(b);
  } else if (mode === "link") {
    actions.append(linkButton("Claim on Luna", claimUrl(o), "luna-btn primary"));
  } else if (mode === "app") {
    const b = el("button", "luna-btn primary", busy.has(o.id) ? "Claiming…" : "Claim");
    b.type = "button"; b.disabled = busy.has(o.id) || o.can_claim === false;
    if (o.can_claim === false) b.title = "Not claimable on this account";
    b.addEventListener("click", () => claim(o));
    actions.append(b);
  }
  const more = el("button", "luna-btn", expanded.has(o.id) ? "Less info" : "More info");
  more.type = "button";
  more.addEventListener("click", () => { if (expanded.has(o.id)) expanded.delete(o.id); else expanded.add(o.id); render(); });
  actions.append(more);
  card.append(actions);

  if (expanded.has(o.id)) {
    const info = el("div", "luna-offer-info");
    const desc = plainText(o.description);
    if (desc) info.append(el("div", "luna-offer-desc", desc));
    const how = plainText(o.instructions);
    if (how) { info.append(el("div", "luna-offer-label", "How to use it")); info.append(el("div", "luna-offer-desc", how)); }
    if (!desc && !how) info.append(el("div", "luna-offer-desc", "No details from Twitch for this one."));
    card.append(info);
  }
  return card;
}

async function claim(o) {
  if (busy.has(o.id)) return;
  busy.add(o.id); render();
  let r = null, err = null;
  try { r = await invoke("claim_prime_offer", { offerId: o.id }); } catch (e) { err = e; }
  busy.delete(o.id);
  if (r === null && !err) { connected = false; render(); return; }
  if (err || !r) results.set(o.id, { claimed: false, error: "Couldn't claim it here. Try it on Luna." });
  else if (r.claimed) { results.set(o.id, { claimed: true, claim_data: r.claim_data || null }); o.claimed = true; }
  else results.set(o.id, { claimed: false, error: r.error === "UNKNOWN" || !r.error ? "Twitch couldn't claim it. Try it on Luna." : `Twitch said: ${r.error}` });
  render();
}
