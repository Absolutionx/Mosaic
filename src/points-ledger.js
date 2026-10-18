// Points ledger (Points & Drops > Ledger): a record of how your channel points came and went, kept on this
// computer. Twitch doesn't give apps a points history, so Mosaic writes its own from the day this shipped:
//   - chat.js's once-a-minute balance check (channel_points_tick) calls recordTick(). The change since the last
//     check is split into what watching plausibly earned and anything above that ("extra": raids, streaks, ...)
//   - a bonus chest Mosaic claimed is exact: the tick reports the balance just before the claim
//   - things Mosaic itself does (redeeming, prediction bets, sharing a streak) are recorded right away by name
//     with noteKnown(), which also moves the remembered balance so the next check doesn't count them twice
//   - a prediction payout lands on Twitch's side a little later, so expectLater() holds it until a check sees it
//   - a change Mosaic can't explain is still recorded, labeled for what it is (spent outside Mosaic, or while
//     Mosaic was closed), so the totals always match your real balance
// localStorage "pointsLedger" (part of Settings > App > Back up). events older than KEEP_DAYS are dropped.

const KEY = "pointsLedger";
const KEEP_DAYS = 120;
const MAX_EVENTS = 6000;
const JOIN_MS = { watch: 10 * 60_000, chest: 25 * 60_000 }; // a session / run of chests (~15 min apart) continues if the last piece is this recent
const GAP_MIN = 5;           // checks further apart than this mean Mosaic wasn't watching in between
const PENDING_MS = 15 * 60_000;

// kind -> chart category: earned by watching, from bonus chests, other earnings, or spent
export const CATEGORY = {
  watch: "watch", chest: "chest",
  extra: "other", streak: "other", predwin: "other", refund: "other", away: "other",
  spend: "spent", bet: "spent", spendx: "spent", awayx: "spent",
};

let data = null;
const listeners = new Set();

function load() {
  if (data) return data;
  try { data = JSON.parse(localStorage.getItem(KEY) || "null"); } catch { data = null; }
  if (!data || typeof data !== "object" || !Array.isArray(data.ev)) data = { v: 1, ch: {}, ev: [], goals: {}, pending: {} };
  data.ch ||= {}; data.goals ||= {}; data.pending ||= {};
  return data;
}

function save() {
  const d = load();
  const cutoff = Date.now() - KEEP_DAYS * 86_400_000;
  if (d.ev.length && (d.ev[0].t < cutoff || d.ev.length > MAX_EVENTS)) {
    d.ev = d.ev.filter((e) => (e.e || e.t) >= cutoff).slice(-MAX_EVENTS);
  }
  try { localStorage.setItem(KEY, JSON.stringify(d)); } catch { /* storage full: keep going in memory */ }
  for (const fn of listeners) { try { fn(); } catch { /* ignore */ } }
}

export function onLedgerChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

// another window (or a restored backup) changed it
window.addEventListener("storage", (e) => { if (e.key === KEY) { data = null; for (const fn of listeners) { try { fn(); } catch {} } } });

function push(login, kind, amount, extra = {}) {
  const d = load();
  const now = extra.t || Date.now();
  // a watch session or a run of chests keeps growing while you watch, instead of one line per minute
  if (kind === "watch" || kind === "chest") {
    for (let i = d.ev.length - 1; i >= 0 && i >= d.ev.length - 40; i--) {
      const e = d.ev[i];
      if (e.c !== login || e.k !== kind) continue;
      if (now - (e.e || e.t) <= JOIN_MS[kind]) {
        e.a += amount; e.e = now;
        if (kind === "watch") e.m = (e.m || 0) + (extra.m || 0);
        if (kind === "chest") e.n = (e.n || 1) + 1;
        return e;
      }
      break;
    }
  }
  const ev = { t: now, c: login, k: kind, a: Math.round(amount) };
  if (kind === "watch") { ev.e = now; ev.m = extra.m || 0; }
  if (kind === "chest") { ev.e = now; ev.n = 1; }
  if (extra.note) ev.n2 = String(extra.note).slice(0, 120);
  if (extra.from) ev.f = extra.from; // for "away": when Mosaic last saw this channel
  d.ev.push(ev);
  return ev;
}

// called by chat.js after every balance check. r = channel_points_tick's answer ({ balance, before?, claimed });
// playing = this channel is what's playing (minutes count towards the watch session)
export function recordTick(login, r, playing) {
  if (!login || !r || r.balance == null) return;
  login = String(login).toLowerCase();
  const d = load();
  const now = Date.now();
  const c = d.ch[login];
  if (!c || c.bal == null) {
    d.ch[login] = { bal: r.balance, at: now };
    save();
    return;
  }
  const minutes = Math.max(0, (now - c.at) / 60_000);
  const pre = r.claimed && r.before != null ? r.before : r.balance;
  let delta = pre - c.bal;

  // a prediction payout or refund Mosaic is expecting
  const pend = d.pending[login] || [];
  for (let i = 0; i < pend.length && delta > 0; i++) {
    const p = pend[i];
    if (delta >= p.a * 0.98) {
      push(login, p.k, p.a, { note: p.note });
      delta -= p.a;
      pend.splice(i--, 1);
    }
  }
  d.pending[login] = pend.filter((p) => now - p.at < PENDING_MS);
  if (!d.pending[login].length) delete d.pending[login];

  if (delta !== 0) {
    if (minutes > GAP_MIN) {
      push(login, delta > 0 ? "away" : "awayx", delta, { from: c.at });
    } else if (delta > 0) {
      // watching earns ~10 points per 5 minutes, up to about twice that with multipliers; anything past a
      // generous cap for the time since the last check came from somewhere else (a raid, a streak, a gift)
      // watching pays in lumps (10 points, up to ~20 with multipliers) every 5 minutes, so a lump fits only
      // when the last one was a while ago
      const sinceLump = c.lump ? (now - c.lump) / 60_000 : Infinity;
      const cap = !playing ? 0 : sinceLump >= 4 ? 24 + Math.ceil(minutes * 2) : Math.ceil(minutes * 4);
      const watch = Math.min(delta, cap);
      if (watch > 0) { push(login, "watch", watch, { m: 0 }); if (watch >= 8) c.lump = now; }
      if (delta - watch > 0) push(login, "extra", delta - watch);
    } else {
      push(login, "spendx", delta);
    }
  }
  // the time counts even when no points arrived this minute
  if (playing && minutes > 0 && minutes <= GAP_MIN) {
    push(login, "watch", 0, { m: minutes });
  }
  if (r.claimed && r.before != null && r.balance > r.before) push(login, "chest", r.balance - r.before);

  c.bal = r.balance; c.at = now;
  save();
}

// something Mosaic just did with a known amount: negative for spending (a redemption, a prediction bet),
// positive for earning (sharing a watch streak). kind: spend | bet | streak
export function noteKnown(login, amount, kind, note) {
  if (!login || !amount) return;
  login = String(login).toLowerCase();
  const d = load();
  push(login, kind, amount, { note });
  const c = d.ch[login];
  if (c && c.bal != null) c.bal += amount;
  save();
}

// a payout Twitch will add shortly (a won or refunded prediction): recorded when a balance check sees it
export function expectLater(login, amount, kind, note) {
  if (!login || !(amount > 0)) return;
  login = String(login).toLowerCase();
  const d = load();
  (d.pending[login] ||= []).push({ a: Math.round(amount), k: kind, note: note ? String(note).slice(0, 120) : "", at: Date.now() });
  save();
}

// ---- reading ----

export function ledgerEvents(sinceMs, login) {
  const d = load();
  return d.ev.filter((e) => (e.e || e.t) >= sinceMs && (!login || e.c === login));
}
export function ledgerChannels() { return load().ch; }
export function ledgerBalance(login) { return load().ch[String(login || "").toLowerCase()]?.bal ?? null; }
export function getGoal(login) { return load().goals[String(login || "").toLowerCase()] || null; }
export function setGoal(login, goal) {
  const d = load();
  const k = String(login || "").toLowerCase();
  if (goal) d.goals[k] = { id: goal.id, title: String(goal.title || "").slice(0, 80), cost: Number(goal.cost) || 0, image: goal.image || null };
  else delete d.goals[k];
  save();
}

// totals for a set of events: earned, spent, minutes watched, and what watching + chests earned per hour
export function summarize(events) {
  let earned = 0, spent = 0, minutes = 0, fromWatching = 0;
  for (const e of events) {
    if (e.a > 0) earned += e.a; else spent += e.a;
    if (e.k === "watch") { minutes += e.m || 0; fromWatching += e.a; }
    if (e.k === "chest") fromWatching += e.a;
  }
  const perHour = minutes >= 15 ? Math.round(fromWatching / (minutes / 60)) : null;
  return { earned, spent, minutes, perHour };
}
