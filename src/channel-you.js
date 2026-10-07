// "You and this channel": the panel behind the Subscribe button on a Twitch channel. Read-only: your
// subscription, how long you've followed, the messages you've sent from Mosaic, your watch time, channel
// points and watch streak, with a link out to Twitch for the subscribing itself (Mosaic never buys or
// changes a subscription). Kick keeps the plain link-out.
//
// where each piece comes from:
//   - following since: the official API (get_follow_info)
//   - subscribed + months: your own chat state. Twitch sends a "badge-info" tag when you join a chat
//     ("subscriber/14" = 14 months), and the tier is encoded in the subscriber badge's version
//   - tier, Prime, gift, renewal / end date: Twitch's web GraphQL, unofficial (get_subscription_info, needs the
//     device login). every field is optional here: a row only shows when Twitch returned it. a subscription
//     that won't renew shows its end date and the days left, highlighted (with a dot on the button) once
//     it's inside the reminder window; the reminders themselves are sub-expiry.js
//   - messages: counted locally from now on (Twitch has no "messages you sent" number). only messages sent
//     from Mosaic count
//   - watch time: the local watch stats (watch-stats.js)

import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { pushEscape } from "./escape-stack.js";
import { fmtDateMDY } from "./format.js";
import { channelWatchTime, fmtHours } from "./watch-stats.js";
import { noteSubscription, expiryState, leftText } from "./sub-expiry.js";

// ---- messages you sent, per channel (localStorage, included in Settings backups) ----
const MSG_KEY = "myChatCounts"; // { [channel]: { n, since: "YYYY-MM-DD" } }; Kick channels are keyed "kick:<slug>"

const dayKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const msgKey = (channel, kick) => (kick ? "kick:" : "") + String(channel || "").toLowerCase();

function loadCounts() {
  try {
    const v = JSON.parse(localStorage.getItem(MSG_KEY) || "null");
    if (v && typeof v === "object" && !Array.isArray(v)) return v;
  } catch { /* unreadable: start over */ }
  return {};
}

// called by chat after a message was sent successfully
export function countOwnMessage(channel, { kick = false, when = new Date() } = {}) {
  if (!channel) return;
  const all = loadCounts();
  const k = msgKey(channel, kick);
  const e = all[k] && typeof all[k] === "object" ? all[k] : { n: 0, since: dayKey(when) };
  e.n = (Number(e.n) || 0) + 1;
  if (!e.since) e.since = dayKey(when);
  all[k] = e;
  try { localStorage.setItem(MSG_KEY, JSON.stringify(all)); } catch { /* quota: this message goes uncounted */ }
  if (panel && view && !kick && view.login === String(channel).toLowerCase()) update();
}

// { n, since } for a channel; n is 0 and since null when nothing was ever sent there
export function ownMessageCount(channel, { kick = false } = {}) {
  const e = loadCounts()[msgKey(channel, kick)];
  return e && typeof e === "object" ? { n: Number(e.n) || 0, since: e.since || null } : { n: 0, since: null };
}

// ---- pure helpers ----

// your own badges in a channel -> what they say about your subscription.
//   badges:    "subscriber/3012,premium/1"  (what you're wearing; the version encodes the tier: 2xxx / 3xxx)
//   badgeInfo: "subscriber/14"              (months subscribed; "founder/14" for founders)
export function parseBadgeState(badges, badgeInfo) {
  const pairs = (s) => String(s || "").split(",").map((p) => p.trim().split("/")).filter((p) => p[0]);
  let subscribed = false, months = null, tier = null, founder = false;
  for (const [set, value] of pairs(badgeInfo)) {
    if (set !== "subscriber" && set !== "founder") continue;
    subscribed = true;
    if (set === "founder") founder = true;
    const n = parseInt(value, 10);
    if (Number.isFinite(n) && n > 0) months = n;
  }
  for (const [set, value] of pairs(badges)) {
    if (set === "founder") { subscribed = true; founder = true; }
    if (set !== "subscriber") continue;
    subscribed = true;
    const v = parseInt(value, 10);
    if (Number.isFinite(v)) tier = v >= 3000 ? 3 : v >= 2000 ? 2 : 1;
  }
  return { subscribed, months, tier, founder };
}

const tierNumber = (t) => ({ 1000: 1, 2000: 2, 3000: 3 }[String(t)] || null);

// Twitch's answer (get_subscription_info; null without the device login, undefined while loading) and the chat
// state (parseBadgeState; null when chat hasn't said anything for this channel) -> one model.
// subscribed is true / false / null (unknown). a "yes" from either side wins: both are direct evidence
export function mergeSubscription(gql, chat) {
  const g = gql && typeof gql === "object" ? gql : null;
  const yes = (g && g.subscribed === true) || !!(chat && chat.subscribed);
  const no = !yes && ((g && g.subscribed === false) || !!chat);
  return {
    subscribed: yes ? true : no ? false : null,
    tier: (g && tierNumber(g.tier)) || (chat && chat.tier) || null,
    prime: !!(g && g.prime),
    founder: !!((g && g.founder) || (chat && chat.founder)),
    months: (g && Number(g.months) > 0 ? Number(g.months) : null) ?? (chat && chat.months) ?? null,
    streakMonths: g && Number(g.streak_months) > 0 ? Number(g.streak_months) : null,
    gift: g && g.is_gift ? { by: g.gifter || null, date: g.gift_date || null } : null,
    renewsAt: (g && g.renews_at) || null,
    endsAt: (g && g.ends_at) || null,
  };
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

// the model as text: { head, chips: [..], lines: [..], expiry }.
// expiry is null, or { text, soon }: when it renews, or when it ends and how long is left. soon = it won't
// renew and the end is inside the reminder window (`days`)
export function subscriptionView(m, { loading = false, now = new Date(), days } = {}) {
  if (m.subscribed === null) return { head: loading ? "\u2026" : "\u2014", chips: [], lines: [], expiry: null };
  if (!m.subscribed) return { head: "Not subscribed", chips: [], lines: [], expiry: null };
  const head = m.months ? `Subscribed \u00b7 ${plural(m.months, "month")}` : "Subscribed";
  const chips = [];
  // a Prime sub is always Tier 1 underneath; "Prime" alone says what it is
  if (m.prime) chips.push("Prime");
  else if (m.tier) chips.push(`Tier ${m.tier}`);
  if (m.founder) chips.push("Founder");
  // a streak equal to the total says nothing new
  if (m.streakMonths && m.streakMonths !== m.months) chips.push(`${plural(m.streakMonths, "month")} in a row`);
  const lines = [];
  if (m.gift) {
    const on = fmtDateMDY(m.gift.date);
    lines.push(`Gifted${m.gift.by ? ` by ${m.gift.by}` : ""}${on ? ` on ${on}` : ""}`);
  }
  let expiry = null;
  if (m.renewsAt && fmtDateMDY(m.renewsAt)) {
    expiry = { text: `Renews ${fmtDateMDY(m.renewsAt)}`, soon: false };
  } else {
    const st = expiryState(m.endsAt, null, now.getTime(), days);
    if (st) {
      const date = fmtDateMDY(m.endsAt);
      const text = st.over ? `Ended ${date}` : st.lastDay ? `Ends today (${date})` : `Ends ${date} \u00b7 ${leftText(st)}`;
      expiry = { text, soon: st.soon };
    }
  }
  return { head, chips, lines, expiry };
}

// "2 yr 3 mo", "5 mo", "12 days", "Today". calendar months, so the 31st -> the 30th still counts a month short
export function followAge(iso, now = new Date()) {
  const from = new Date(iso);
  if (Number.isNaN(from.getTime()) || from > now) return "";
  let months = (now.getFullYear() - from.getFullYear()) * 12 + (now.getMonth() - from.getMonth());
  if (now.getDate() < from.getDate()) months--;
  if (months >= 12) {
    const y = Math.floor(months / 12), mo = months % 12;
    return mo ? `${y} yr ${mo} mo` : `${y} yr`;
  }
  if (months >= 1) return `${months} mo`;
  const days = Math.floor((now.getTime() - from.getTime()) / 86400000);
  return days >= 1 ? plural(days, "day") : "Today";
}

// ---- state ----
const SUB_TTL_MS = 10 * 60 * 1000;   // the button's "Subscribed" label is re-checked this often at most
const DETAIL_TTL_MS = 60 * 1000;     // reopening the panel within a minute reuses the last answers
const chatStates = new Map();        // login -> parseBadgeState(...)
const coreCache = new Map();         // login -> { at, info }   (get_subscription_info, details: false)
const detailCache = new Map();       // login -> { at, sub, follow, points, streak, resub }

let button = null;
let deps = { loggedIn: () => false, connectTwitch: () => {} };
let target = null;   // { login, name }: the Twitch channel the button belongs to right now; null = Kick / nothing
let panel = null, refs = null, view = null, popEscape = null, openSeq = 0, watcher = null;

// call once at startup. button: the info bar's Subscribe button. loggedIn(): is a Twitch account logged in.
// connectTwitch(done): opens the device-login prompt
export function initChannelYou(options) {
  button = options.button;
  if (options.loggedIn) deps.loggedIn = options.loggedIn;
  if (options.connectTwitch) deps.connectTwitch = options.connectTwitch;
}

// a different account (or none): nothing learned about the previous one applies
export function resetChannelYou() {
  chatStates.clear();
  coreCache.clear();
  detailCache.clear();
  closeChannelYou();
  syncButton();
  if (target) refreshCore(target.login, true);
}

// chat's USERSTATE for a channel (sent when you join and after each message you send)
export function noteOwnChatState(channel, badges, badgeInfo) {
  const login = String(channel || "").toLowerCase();
  if (!login) return;
  chatStates.set(login, parseBadgeState(badges, badgeInfo));
  if (target && target.login === login) syncButton();
  if (panel && view && view.login === login) update();
}

// the info bar tells us which channel it shows; null on Kick or when it hides. safe to call repeatedly with
// the same channel (the bar re-populates every minute)
export function setChannelYouTarget(login, name) {
  const l = login ? String(login).toLowerCase() : null;
  if ((target && target.login) === l) {
    if (target && name) target.name = name;
    return;
  }
  closeChannelYou();
  target = l ? { login: l, name: name || login } : null;
  syncButton();
  if (target) refreshCore(target.login, false);
}

// true when the click was handled here (a Twitch channel); false = the caller links out as before
export function toggleChannelYou() {
  if (!target || !button) return false;
  if (panel) closeChannelYou();
  else openPanel();
  return true;
}

function currentModel(login, gql) {
  const cached = coreCache.get(login);
  return mergeSubscription(gql !== undefined ? gql : cached ? cached.info : undefined, chatStates.get(login) || null);
}

const CLOCK = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>';
const STAR = '<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path fill="currentColor" d="M12 2.6l2.8 5.9 6.4.8-4.7 4.4 1.2 6.4L12 17l-5.7 3.1 1.2-6.4L2.8 9.3l6.4-.8z"/></svg>';

function syncButton() {
  if (!button) return;
  const model = target ? currentModel(target.login) : null;
  const subscribed = !!model && model.subscribed === true;
  // a subscription that won't renew and is about to run out: a dot on the button, and the tooltip says when
  const st = subscribed ? expiryState(model.endsAt, model.renewsAt) : null;
  const ending = !!(st && st.soon);
  if (button.classList.contains("is-subscribed") !== subscribed || !button.firstChild) {
    button.textContent = "";
    if (subscribed) {
      const icon = document.createElement("span");
      icon.className = "sub-star";
      icon.innerHTML = STAR;
      button.appendChild(icon);
    }
    const label = document.createElement("span");
    label.textContent = subscribed ? "Subscribed" : "Subscribe";
    button.appendChild(label);
    button.classList.toggle("is-subscribed", subscribed);
  }
  button.classList.toggle("sub-ending", ending);
  button.title = !target ? ""
    : ending ? `Your subscription ${st.lastDay ? "ends today" : `ends ${fmtDateMDY(st.endsAt)} (${leftText(st)})`} and won't renew`
    : "Your subscription, follow and stats for this channel";
  if (target) button.setAttribute("aria-haspopup", "dialog");
  else button.removeAttribute("aria-haspopup");
}

// one small request per channel, so the button can say "Subscribed" without the panel being opened
async function refreshCore(login, force) {
  const cached = coreCache.get(login);
  if (!force && cached && Date.now() - cached.at < SUB_TTL_MS) return;
  let info;
  try { info = await invoke("get_subscription_info", { channelLogin: login, details: false }); } catch { return; }
  // subscribed: also ask when it ends or renews, for the dot on the button and the reminders (sub-expiry.js)
  if (info && info.subscribed === true) {
    try {
      const full = await invoke("get_subscription_info", { channelLogin: login, details: true });
      if (full && full.subscribed === true) info = full;
    } catch { /* the short answer still stands */ }
  }
  coreCache.set(login, { at: Date.now(), info: info ?? null });
  noteSubscription(login, target && target.login === login ? target.name : login, info);
  if (info && Array.isArray(info.errors) && info.errors.length) console.warn("[channel-you] subscription lookup:", info.errors.join(" | "));
  if (target && target.login === login) syncButton();
  if (panel && view && view.login === login) update();
}

// ---- the panel ----
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

function openPanel() {
  const login = target.login;
  const seq = ++openSeq;
  const cached = detailCache.get(login);
  const fresh = cached && Date.now() - cached.at < DETAIL_TTL_MS ? cached : null;
  // opening a channel you're subscribed to already fetched the full subscription answer (refreshCore):
  // reuse it while it's fresh
  const core = coreCache.get(login);
  const fullSub = core && core.info && core.info.detailed === true && Date.now() - core.at < DETAIL_TTL_MS ? core.info : undefined;
  // undefined = still loading
  view = {
    login, name: target.name,
    sub: fresh ? fresh.sub : fullSub,
    follow: fresh ? fresh.follow : undefined,
    points: fresh ? fresh.points : undefined,
    streak: fresh ? fresh.streak : undefined,
    resub: fresh ? fresh.resub : undefined,
  };

  panel = el("div", "cyou-panel");
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", `You and ${view.name}`);
  refs = {};
  panel.appendChild(el("div", "cyou-title", `You and ${view.name}`));

  panel.appendChild(el("div", "cyou-label", "Subscription"));
  refs.head = panel.appendChild(el("div", "cyou-head"));
  refs.chips = panel.appendChild(el("div", "cyou-chips"));
  refs.expiry = panel.appendChild(el("div", "cyou-expiry"));
  refs.expiry.innerHTML = CLOCK;
  refs.expiryText = refs.expiry.appendChild(el("span"));
  refs.lines = panel.appendChild(el("div", "cyou-lines"));

  panel.appendChild(el("div", "cyou-label", "Your activity"));
  const stats = panel.appendChild(el("div", "cyou-stats"));
  refs.tiles = {};
  for (const id of ["follow", "messages", "watch", "points", "streak"]) {
    const tile = el("div", "cyou-stat");
    const value = tile.appendChild(el("div", "cyou-stat-value"));
    const label = tile.appendChild(el("div", "cyou-stat-label"));
    refs.tiles[id] = { tile, value, label };
    stats.appendChild(tile);
  }

  refs.note = panel.appendChild(el("div", "cyou-note"));
  const actions = panel.appendChild(el("div", "cyou-actions"));
  refs.link = actions.appendChild(el("button", "cyou-btn"));
  refs.link.type = "button";
  refs.link.addEventListener("click", () => {
    const m = currentModel(view.login, view.sub);
    const url = m.subscribed ? "https://www.twitch.tv/subscriptions" : `https://www.twitch.tv/subs/${encodeURIComponent(view.login)}`;
    openUrl(url).catch((err) => console.error("Failed to open Twitch in the browser:", err));
    closeChannelYou();
  });
  refs.connect = actions.appendChild(el("button", "cyou-btn", "Connect Twitch"));
  refs.connect.type = "button";
  refs.connect.addEventListener("click", () => {
    closeChannelYou();
    deps.connectTwitch(() => { detailCache.delete(login); if (target && target.login === login) refreshCore(login, true); });
  });

  document.body.appendChild(panel);
  button.classList.add("open");
  button.setAttribute("aria-expanded", "true");
  update();
  if (!panel) return; // the button turned out to be hidden: place() closed it again
  popEscape = pushEscape(() => closeChannelYou());
  setTimeout(() => {
    if (openSeq !== seq || !panel) return;
    document.addEventListener("mousedown", onOutside, true);
    window.addEventListener("resize", place);
  }, 0);
  // the bar changes size or disappears without a window resize (theater mode, a page switch): follow it,
  // and place() closes the panel when the button is gone
  if (typeof ResizeObserver !== "undefined") {
    watcher = new ResizeObserver(() => place());
    watcher.observe(button);
    const bar = button.closest(".channel-info-bar");
    if (bar) watcher.observe(bar);
  }

  if (!fresh) loadDetails(login, seq);
}

function loadDetails(login, seq) {
  const live = () => panel && openSeq === seq;
  const store = () => {
    if (!live()) return;
    if (["sub", "follow", "points", "streak", "resub"].every((k) => view[k] !== undefined)) {
      detailCache.set(login, { at: Date.now(), sub: view.sub, follow: view.follow, points: view.points, streak: view.streak, resub: view.resub });
    }
    update();
  };
  const settle = (key, promise, onError = () => null) => {
    promise.then((v) => v ?? null, onError).then((v) => { if (live()) { view[key] = v; store(); } });
  };
  // null means "no device login"; a failed call is a different thing (unknown), so it gets its own shape
  if (view.sub === undefined) settle("sub", invoke("get_subscription_info", { channelLogin: login, details: true }).then((info) => {
    coreCache.set(login, { at: Date.now(), info: info ?? null });
    noteSubscription(login, target && target.login === login ? target.name : login, info);
    if (info && Array.isArray(info.errors) && info.errors.length) console.warn("[channel-you] subscription lookup:", info.errors.join(" | "));
    if (target && target.login === login) syncButton();
    return info;
  }), (e) => ({ subscribed: null, errors: [String(e)] }));
  // the official lookup needs the Twitch login; { error } keeps "couldn't tell" apart from "not following"
  settle("follow", invoke("get_follow_info", { login }), (e) => ({ error: String(e) }));
  settle("points", invoke("get_channel_points", { channelLogin: login }));
  settle("streak", invoke("get_watch_streak", { channelLogin: login }));
  settle("resub", invoke("get_resub_notification", { channelLogin: login }));
}

// since: a "YYYY-MM-DD" day or a timestamp. it's shown as "since MM-DD-YY" and kept in one piece, so a narrow
// tile wraps before it and never in the middle of the date
function setTile(id, value, label, { since = null, title = "" } = {}) {
  const t = refs.tiles[id];
  t.tile.hidden = value == null;
  t.value.textContent = value ?? "";
  t.label.textContent = label || "";
  const day = since ? fmtDateMDY(since) : "";
  if (day) {
    t.label.append(" ");
    t.label.appendChild(el("span", "cyou-since", `since ${day}`));
  }
  t.tile.title = title;
}

function update() {
  if (!panel || !view) return;
  const login = view.login;
  const model = currentModel(login, view.sub);
  const connected = view.sub === undefined ? null : view.sub !== null; // device login; null = not known yet

  // subscription
  const sv = subscriptionView(model, { loading: view.sub === undefined });
  refs.head.textContent = sv.head;
  refs.chips.textContent = "";
  for (const c of sv.chips) refs.chips.appendChild(el("span", "cyou-chip", c));
  refs.chips.hidden = !sv.chips.length;
  refs.expiry.hidden = !sv.expiry;
  refs.expiryText.textContent = sv.expiry ? sv.expiry.text : "";
  refs.expiry.classList.toggle("soon", !!(sv.expiry && sv.expiry.soon));
  refs.lines.textContent = "";
  for (const l of sv.lines) refs.lines.appendChild(el("div", "cyou-line", l));
  if (view.resub && model.subscribed) refs.lines.appendChild(el("div", "cyou-line cyou-ready", "Anniversary ready to share in chat"));
  refs.lines.hidden = !refs.lines.childElementCount;

  // following: the official answer, else the date Twitch's web data carried
  const f = view.follow;
  const gqlFollowedAt = view.sub && view.sub.followed_at;
  const followedAt = (f && f.followed_at) || gqlFollowedAt || null;
  if (followedAt && followAge(followedAt)) setTile("follow", followAge(followedAt), "Following", { since: followedAt });
  else if (f === undefined) setTile("follow", "…", "Following");
  else if (f && f.error) setTile("follow", "—", deps.loggedIn() ? "Following: couldn't check" : "Log in to see when you followed");
  else setTile("follow", "—", "Not following");

  // messages sent from Mosaic
  const sent = ownMessageCount(login);
  setTile("messages", sent.n.toLocaleString(), "Messages from Mosaic", {
    since: sent.since,
    title: "Messages you sent in this chat from Mosaic. Twitch doesn't provide a total, so Mosaic counts them itself, starting with this version.",
  });

  // watch time (local watch stats)
  const watched = channelWatchTime(login);
  setTile("watch", fmtHours(watched.secs), "Watched", { since: watched.since, title: "Time watched in Mosaic, live and VODs." });

  // channel points + watch streak: only when Twitch returned them
  setTile("points", typeof view.points === "number" ? view.points.toLocaleString() : null, "Channel points");
  const streak = view.streak && Number(view.streak.count) > 0 ? Number(view.streak.count) : null;
  setTile("streak", streak ? String(streak) : null, "Watch streak", { title: "Streams in a row you've watched." });

  // an odd number of tiles: the last one takes the full row
  const shown = Object.values(refs.tiles).map((t) => t.tile).filter((t) => !t.hidden);
  shown.forEach((t, i) => t.classList.toggle("wide", shown.length % 2 === 1 && i === shown.length - 1));

  // the unofficial data needs the device login
  refs.note.hidden = connected !== false;
  refs.note.textContent = "Tier, renewal date, gifts and channel points need the one-time Twitch device login (same as pinned messages).";
  refs.connect.hidden = connected !== false;
  refs.link.textContent = model.subscribed ? "Manage on Twitch" : "Subscribe on Twitch";
  place();
}

// under the button when there's room, otherwise above it (the bar usually sits at the bottom of the window).
// above, it's pinned by its bottom edge so rows that arrive later grow it upward, not over the button
function place() {
  if (!panel || !button) return;
  const r = button.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) { closeChannelYou(); return; } // the bar was hidden under us
  panel.style.top = panel.style.bottom = "";
  const h = panel.offsetHeight, w = panel.offsetWidth;
  const below = r.bottom + 6 + h <= window.innerHeight - 8;
  if (below) panel.style.top = `${r.bottom + 6}px`;
  else if (r.top - 6 - h >= 8) panel.style.bottom = `${window.innerHeight - r.top + 6}px`;
  else panel.style.top = "8px"; // a very short window: take what there is
  panel.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - w - 8))}px`;
}

function onOutside(e) {
  if (!panel) return;
  if (panel.contains(e.target) || (button && button.contains(e.target))) return;
  closeChannelYou();
}

export function closeChannelYou() {
  if (!panel) return;
  openSeq++;
  document.removeEventListener("mousedown", onOutside, true);
  window.removeEventListener("resize", place);
  watcher?.disconnect();
  watcher = null;
  popEscape?.();
  popEscape = null;
  panel.remove();
  panel = null;
  refs = null;
  view = null;
  if (button) {
    button.classList.remove("open");
    button.setAttribute("aria-expanded", "false");
  }
}
