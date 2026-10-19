// "While you lurked" (lurk-mode.js): back from lurking for 5 minutes or more, a slim bar at the top of the video
// sums it up: "LURKED 1h 12m · +260 ◈ · 4 chests · Chrono Tokens 62%". It opens minimized, like a poll or a
// prediction in chat, and fades after a few seconds; click it for the full card (points with the watching / chest
// split, chests claimed, drop progress from-to, watch streak) and a way into the Ledger.
//   points: tallied from the points ledger as it records (points-ledger.js onLedgerAdd), only for that channel
//   drops: the inventory read when lurking started and again at the end; the drop that moved most is shown
//   streak: read at the end (get_watch_streak); shown when there is one
// Every part only shows when something happened. Lurks shorter than MIN_MS get only the line in chat.

import { invoke } from "@tauri-apps/api/core";
import { onLedgerAdd, CATEGORY } from "./points-ledger.js";

const MIN_MS = 5 * 60_000;
const FADE_MS = 10_000;

let run = null;    // the lurk being tallied
let el = null;     // the bar on screen
let fadeTimer = null;
let openLedger = null;

export function configureLurkRecap(opts) { openLedger = opts?.openLedger || null; }

const num = (n) => Math.round(Number(n) || 0).toLocaleString();
function dur(ms) {
  const min = Math.max(1, Math.round(ms / 60_000));
  if (min < 60) return `${min}m`;
  return min % 60 ? `${Math.floor(min / 60)}h ${min % 60}m` : `${Math.floor(min / 60)}h`;
}
const pct = (d) => (d.required ? Math.min(100, Math.round((d.current / d.required) * 100)) : 0);

// in-progress drops by campaign + name
function snapDrops(inv) {
  const m = new Map();
  for (const c of Array.isArray(inv) ? inv : []) {
    for (const d of c.drops || []) {
      m.set(`${c.id}|${d.name}`, { name: d.name || "Drop", game: c.game || "", current: d.current || 0, required: d.required || 0, done: !!(d.claimed || d.claimable) });
    }
  }
  return m;
}
// the drop that moved most while you were away (or became ready)
function movedDrop(before, after) {
  if (!before || !after) return null;
  let best = null;
  for (const [k, a] of after) {
    const b = before.get(k);
    if (!b) continue;
    const gain = a.current - b.current;
    const finished = a.done && !b.done;
    if (gain <= 0 && !finished) continue;
    const score = finished ? Infinity : gain;
    if (!best || score > best.score) best = { score, name: a.name, from: pct(b), to: a.done ? 100 : pct(a), ready: finished };
  }
  return best;
}

// lurking started on this channel
export function recapStart(login) {
  run?.unsub?.();
  if (run) clearInterval(run.beat);
  const r = { login: String(login || "").toLowerCase(), since: Date.now(), watch: 0, chest: 0, chests: 0, other: 0, spent: 0, drops: null };
  // every channel counts: a raid (or drops autopilot) can carry you somewhere else while you're away
  r.unsub = onLedgerAdd((l, kind, a) => {
    if (run !== r || !a) return;
    const cat = CATEGORY[kind] || "other";
    if (kind === "chest") { r.chest += a; r.chests += 1; } else if (cat === "watch") r.watch += a; else if (cat === "spent") r.spent += a; else r.other += a;
  });
  // time the computer spent asleep isn't lurking: a hidden page still gets a timer about once a minute, so a much
  // longer gap between beats means the PC was suspended, and that stretch is left out of "Lurked 1h 12m"
  r.asleep = 0;
  let beat = Date.now();
  r.beat = setInterval(() => {
    const now = Date.now();
    if (now - beat > 150_000) r.asleep += now - beat - 20_000;
    beat = now;
  }, 20_000);
  run = r;
  invoke("get_drops_inventory").then((inv) => { if (run === r) r.drops = snapDrops(inv); }).catch(() => {});
}

// back on screen. opts: { audioOnly, muted, playing, channel() -> what's on screen now }
export async function recapStop(opts = {}) {
  const r = run;
  run = null;
  if (!r) return;
  r.unsub?.();
  clearInterval(r.beat);
  const ms = Math.max(0, Date.now() - r.since - (r.asleep || 0));
  if (ms < MIN_MS || !opts.playing) return;
  const now = String(opts.channel?.() || r.login).toLowerCase();
  const [inv, streak] = await Promise.all([
    r.drops ? invoke("get_drops_inventory").catch(() => null) : Promise.resolve(null),
    now ? invoke("get_watch_streak", { channelLogin: now }).catch(() => null) : Promise.resolve(null),
  ]);
  // coming back from audio only, the picture takes a few seconds to return: wait for it (up to 10s), so the bar's
  // few seconds are spent over the stream, not over the "Audio only" screen
  if (opts.audioOnly) await pictureBack(10_000);
  // the lookups take a moment: switched channels meanwhile, it belongs to the stream you left
  if (opts.channel && String(opts.channel() || "").toLowerCase() !== now) return;
  show({ ...r, now, ms, drop: movedDrop(r.drops, inv ? snapDrops(inv) : null), streak: Number(streak?.count) || 0, ...opts });
}

// resolves once the main player shows a picture again (an audio-only stream has no video size), or after ms
function pictureBack(ms) {
  const v = document.getElementById("video-element");
  return new Promise((resolve) => {
    if (!v) { resolve(); return; }
    let done = false;
    const finish = () => { if (done) return; done = true; clearTimeout(t); clearInterval(poll); v.removeEventListener("resize", check); resolve(); };
    // the last frame of the old picture can linger: only a new size after the switch counts
    const startW = v.videoWidth;
    const check = () => { if (v.videoWidth > 0 && (startW === 0 || v.readyState >= 2)) finish(); };
    v.addEventListener("resize", check);
    const poll = setInterval(check, 500);
    const t = setTimeout(finish, ms);
    setTimeout(check, 1500);
  });
}

export function hideLurkRecap() {
  waitObs?.disconnect(); waitObs = null;
  if (fadeTimer) { clearTimeout(fadeTimer); fadeTimer = null; }
  el?.remove();
  el = null;
}

const ICON_LURK = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 14v-2a9 9 0 0 1 18 0v2"/><path d="M21 15a2 2 0 0 1-2 2h-1v-6h1a2 2 0 0 1 2 2zM3 15a2 2 0 0 0 2 2h1v-6H5a2 2 0 0 0-2 2z"/></svg>';
const ICON_CHEV = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
const ICON_X = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>';

function node(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

let waitObs = null;
function show(r) {
  hideLurkRecap();
  const host = document.getElementById("video-region");
  if (!host) return;
  // the stream is in the mini player (you were on Home or Browse) or not on screen: hold the bar until the
  // stream is shown full size again, for up to 10 minutes, rather than squeezing it into a small corner box
  if (host.offsetWidth < 480) {
    waitObs?.disconnect();
    const until = Date.now() + 10 * 60_000;
    waitObs = new ResizeObserver(() => {
      if (Date.now() > until) { waitObs?.disconnect(); waitObs = null; return; }
      if (host.offsetWidth >= 480) { waitObs?.disconnect(); waitObs = null; show(r); }
    });
    waitObs.observe(host);
    return;
  }
  const earned = r.watch + r.chest + r.other;
  const card = node("div", "lurk-recap min");
  card.setAttribute("role", "status");

  // ---- the minimized bar ----
  const head = node("div", "lr-head");
  head.tabIndex = 0;
  head.setAttribute("aria-expanded", "false");
  const kind = node("span", "lr-kind");
  kind.innerHTML = ICON_LURK;
  kind.appendChild(node("span", null, "Lurked"));
  const sum = node("span", "lr-sum");
  const part = (strong, rest) => {
    if (sum.childNodes.length) sum.appendChild(node("i"));
    if (strong) sum.appendChild(node("b", null, strong));
    if (rest) sum.appendChild(document.createTextNode(rest));
  };
  part(dur(r.ms));
  if (earned > 0) part(`+${num(earned)}`, " ◈");
  if (r.chests) part(null, `${r.chests} chest${r.chests === 1 ? "" : "s"}`);
  if (r.drop) part(null, `${r.drop.name} `), sum.appendChild(node("b", null, r.drop.ready ? "ready" : `${r.drop.to}%`));
  const chev = node("button", "lr-ib lr-chev");
  chev.type = "button"; chev.title = "Expand"; chev.innerHTML = ICON_CHEV;
  const x = node("button", "lr-ib");
  x.type = "button"; x.title = "Dismiss"; x.innerHTML = ICON_X;
  head.append(kind, sum, node("span", "lr-sp"), chev, x);
  card.appendChild(head);

  // ---- the full card ----
  const body = node("div", "lr-body");
  const title = node("div", "lr-title", "Welcome back");
  const where = r.now && r.now !== r.login ? `${r.login}, then ${r.now}` : r.login;
  title.appendChild(node("span", null, ` · you lurked on ${where} for ${dur(r.ms)}${r.muted ? ", muted" : r.audioOnly ? ", audio only" : ""}`));
  body.appendChild(title);
  const tiles = node("div", "lr-tiles");
  const tile = (big, unit, label, meter) => {
    const t = node("div", "lr-tile");
    const b = node("div", "lr-big", big);
    if (unit) b.appendChild(node("span", "u", unit));
    const lbl = node("div", "lr-lbl", label);
    lbl.title = label;
    t.append(b, lbl);
    if (meter) t.appendChild(meter);
    tiles.appendChild(t);
  };
  const meter = (segs) => {
    const m = node("div", "lr-meter");
    for (const [left, width, cls] of segs) { const s = node("span", cls); s.style.left = `${left}%`; s.style.width = `${width}%`; m.appendChild(s); }
    return m;
  };
  {
    const parts = [[r.watch, "lr-m-watch"], [r.chest, "lr-m-chest"], [r.other, "lr-m-other"]].filter(([v]) => v > 0);
    let at = 0;
    const segs = parts.map(([v, cls]) => { const w = (v / earned) * 100; const seg = [at, Math.max(0, w - 1), cls]; at += w; return seg; });
    tile(earned > 0 ? `+${num(earned)}` : "0", "◈", "points earned", segs.length ? meter(segs) : null);
  }
  if (r.chests) tile(String(r.chests), null, `chest${r.chests === 1 ? "" : "s"} claimed`);
  if (r.drop) {
    if (r.drop.ready) tile("Ready", null, r.drop.name, meter([[0, 100, "lr-m-accent"]]));
    else tile(`${r.drop.to}%`, `from ${r.drop.from}%`, r.drop.name, meter([[0, r.drop.from, "lr-m-was"], [r.drop.from, r.drop.to - r.drop.from, "lr-m-accent"]]));
  }
  if (r.streak > 0) tile(`🔥 ${num(r.streak)}`, null, "watch streak");
  tiles.style.gridTemplateColumns = `repeat(${tiles.children.length}, 1fr)`;
  body.appendChild(tiles);
  const foot = node("div", "lr-foot");
  const breakdown = [[r.watch, "watching"], [r.chest, "chests"], [r.other, "other"]].filter(([v]) => v > 0).map(([v, l]) => `${l} ${num(v)} ◈`).join(" · ");
  foot.appendChild(node("span", "note", breakdown || "Nothing earned on this channel while you were away"));
  if (openLedger) {
    const open = node("button", "lr-btn primary", "Open ledger");
    open.type = "button";
    open.addEventListener("click", () => { hideLurkRecap(); openLedger(); });
    foot.appendChild(open);
  }
  body.appendChild(foot);
  card.appendChild(body);

  // ---- fading while minimized ----
  const bar = node("span", "lr-bar");
  bar.appendChild(node("span"));
  card.appendChild(bar);
  const startFade = () => {
    if (fadeTimer) clearTimeout(fadeTimer);
    bar.firstChild.style.transition = "none";
    bar.firstChild.style.transform = "scaleX(1)";
    requestAnimationFrame(() => requestAnimationFrame(() => {
      bar.firstChild.style.transition = `transform ${FADE_MS}ms linear`;
      bar.firstChild.style.transform = "scaleX(0)";
    }));
    fadeTimer = setTimeout(() => { if (el === card) { card.classList.add("leaving"); setTimeout(() => { if (el === card) hideLurkRecap(); }, 220); } }, FADE_MS);
  };
  let opened = false;
  const toggle = () => {
    const open = card.classList.toggle("min") === false;
    head.setAttribute("aria-expanded", String(open));
    chev.title = open ? "Minimize" : "Expand";
    if (!opened) { opened = true; if (fadeTimer) { clearTimeout(fadeTimer); fadeTimer = null; } bar.remove(); }
  };
  head.addEventListener("click", (e) => { if (!x.contains(e.target)) toggle(); });
  head.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } });
  x.addEventListener("click", (e) => { e.stopPropagation(); hideLurkRecap(); });
  // pointing at it holds the fade
  card.addEventListener("mouseenter", () => { if (!opened && fadeTimer) { clearTimeout(fadeTimer); fadeTimer = null; bar.firstChild.style.transition = "none"; bar.firstChild.style.transform = "scaleX(1)"; } });
  card.addEventListener("mouseleave", () => { if (!opened && el === card) startFade(); });

  // a raid / drops autopilot banner keeps the top spot; sit just under it
  const rb = host.querySelector(".raid-banner");
  if (rb) card.style.top = `${rb.offsetTop + rb.offsetHeight + 8}px`;
  host.appendChild(card);
  el = card;
  startFade();
}
