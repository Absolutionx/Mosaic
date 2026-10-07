// Reminders before a Twitch subscription runs out (Settings > Notifications > Subscription ending reminders).
// Only subscriptions that won't renew count: gifted, Prime, or cancelled ones, where Twitch gives an end date
// and no renewal date. A subscription that renews is never mentioned.
//
// what Mosaic knows comes from two places, both Twitch's web data (unofficial, needs the device login):
//   - the list of all your subscriptions (get_my_subscriptions), fetched after startup and every 6 hours.
//     this is what covers channels you aren't watching
//   - the subscription details of a channel when you open it (channel-you.js calls noteSubscription). if
//     the list query stops working, reminders still fire for the channels you actually open
//
// two reminders per subscription at most: one when it's within the chosen number of days, one on its last
// day. each is sent once (remembered across restarts), and never during quiet hours: it waits for the next
// check instead.

import { invoke } from "@tauri-apps/api/core";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { getSetting, onSettingChange, notificationAllowed, notificationOptions } from "./settings.js";
import { fmtDateMDY } from "./format.js";

const KNOWN_KEY = "subExpiryKnown";    // { [login]: { name, endsAt, tier, prime, gift, at } }  (a cache, not in backups)
const SENT_KEY = "subExpiryNotified";  // { "<login>|<endsAt>": { soon: ms, last: ms } }
const DAY = 86400000;
const LIST_EVERY_MS = 6 * 60 * 60 * 1000;
const CHECK_EVERY_MS = 30 * 60 * 1000;
const MAX_PER_CHECK = 4;               // a burst of toasts helps nobody; the rest go out at the next check

const loadMap = (k) => {
  try {
    const v = JSON.parse(localStorage.getItem(k) || "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch { return {}; }
};
const saveMap = (k, m) => { try { localStorage.setItem(k, JSON.stringify(m)); } catch { /* quota */ } };

export function reminderDays() {
  const n = Number(getSetting("subExpiryDays"));
  return Number.isFinite(n) && n >= 1 ? n : 3;
}

// ---- pure helpers ----

// whole days until `endsAt`, rounded up (0.2 days left reads as "1 day"); null for no / unreadable date
export function daysLeft(endsAt, now = Date.now()) {
  const t = Date.parse(endsAt);
  return Number.isNaN(t) ? null : Math.ceil((t - now) / DAY);
}

// the state of one subscription's end: null when it renews or has no end date.
// { endsAt, days, over, lastDay, soon }  soon = inside the reminder window (and not over)
export function expiryState(endsAt, renewsAt, now = Date.now(), days = reminderDays()) {
  if (!endsAt || renewsAt) return null;
  const t = Date.parse(endsAt);
  if (Number.isNaN(t)) return null;
  const ms = t - now, left = Math.ceil(ms / DAY);
  return { endsAt, days: left, over: ms <= 0, lastDay: ms > 0 && ms <= DAY, soon: ms > 0 && left <= days };
}

// "12 days left" / "1 day left" / "ends today"
export function leftText(state) {
  if (!state || state.over) return "";
  if (state.lastDay) return "ends today";
  return `${state.days} day${state.days === 1 ? "" : "s"} left`;
}

// which reminders are due. known / sent: the two stored maps. returns [{ key, stage, login, name, ... }],
// soonest first. stage "last" (final 24 hours) replaces "soon" when both would apply
export function dueReminders(known, sent, now = Date.now(), days = reminderDays()) {
  const out = [];
  for (const [login, k] of Object.entries(known || {})) {
    if (!k || typeof k !== "object") continue;
    const st = expiryState(k.endsAt, null, now, days);
    if (!st || st.over) continue;
    const stage = st.lastDay ? "last" : st.soon ? "soon" : null;
    if (!stage) continue;
    const key = `${login}|${k.endsAt}`;
    const done = (sent && sent[key]) || {};
    if (done[stage] || (stage === "soon" && done.last)) continue;
    out.push({ key, stage, login, name: k.name || login, endsAt: k.endsAt, days: st.days, tier: k.tier || null, prime: !!k.prime, gift: !!k.gift });
  }
  return out.sort((a, b) => Date.parse(a.endsAt) - Date.parse(b.endsAt));
}

export function reminderText(r) {
  const kind = r.gift ? "gifted subscription" : r.prime ? "Prime subscription" : "subscription";
  const when = r.stage === "last" ? "ends today" : `ends in ${r.days} day${r.days === 1 ? "" : "s"} (${fmtDateMDY(r.endsAt)})`;
  return { title: `${r.name}: subscription ending`, body: `Your ${kind} ${when} and won't renew.` };
}

// drop what can't matter any more: ended subscriptions, and reminders for dates that have passed
function prune(known, sent, now) {
  for (const [login, k] of Object.entries(known)) {
    const t = k && Date.parse(k.endsAt);
    if (!t || Number.isNaN(t) || now - t > 2 * DAY) delete known[login];
  }
  for (const key of Object.keys(sent)) {
    const t = Date.parse(key.slice(key.indexOf("|") + 1));
    if (Number.isNaN(t) || now - t > 7 * DAY) delete sent[key];
  }
}

// ---- what's known ----

const entry = (name, endsAt, s, now) => ({ name, endsAt, tier: s.tier || null, prime: !!s.prime, gift: !!s.is_gift, at: now });

// channel-you.js: the subscription answer Twitch just returned for a channel (get_subscription_info). only
// an answer whose dates are known counts (dates_known): the short answer, or one whose detail query failed,
// says nothing about the end date and must not erase what's known
export function noteSubscription(login, name, info, now = Date.now()) {
  const l = String(login || "").toLowerCase();
  if (!l || !info || typeof info !== "object" || info.subscribed == null || info.dates_known !== true) return;
  const known = loadMap(KNOWN_KEY);
  const ending = info.subscribed === true && info.ends_at && !info.renews_at;
  if (ending) known[l] = entry(name || l, info.ends_at, info, now);
  else if (l in known) delete known[l]; // renewed, resubscribed, or gone
  else return;
  saveMap(KNOWN_KEY, known);
  if (ending) scheduleCheck(2000);
}

// the full list replaces everything known: it's the whole truth for the account
export function applySubscriptionList(subs, now = Date.now()) {
  const known = {};
  for (const s of Array.isArray(subs) ? subs : []) {
    if (!s || !s.login || !s.ends_at || s.renews_at) continue;
    known[String(s.login).toLowerCase()] = entry(s.name || s.login, s.ends_at, s, now);
  }
  saveMap(KNOWN_KEY, known);
  return known;
}

// signing out: nothing known belongs to whoever logs in next
export function resetSubExpiry() {
  try { localStorage.removeItem(KNOWN_KEY); } catch { /* ignore */ }
}

// ---- the checks ----
let started = false, listTimer = null, checkTimer = null, soonTimer = null, checking = false, listWarned = false;

async function refreshList() {
  if (!getSetting("notifySubExpiry")) return;
  let res;
  try {
    res = await invoke("get_my_subscriptions");
  } catch (err) {
    // Twitch rejected the (unofficial) query. the per-channel source still works; say so once
    if (!listWarned) { listWarned = true; console.warn("[sub-expiry] couldn't list subscriptions:", err); }
    return;
  }
  if (!res || !Array.isArray(res.subs)) return; // no device login
  applySubscriptionList(res.subs);
  await checkNow();
}

export async function checkNow(now = Date.now()) {
  if (checking || !getSetting("notifySubExpiry")) return 0;
  checking = true;
  let count = 0;
  try {
    const known = loadMap(KNOWN_KEY), sent = loadMap(SENT_KEY);
    prune(known, sent, now);
    saveMap(KNOWN_KEY, known);
    const due = dueReminders(known, sent, now);
    // quiet hours (or the switch): leave them unsent, the next check picks them up
    if (due.length && notificationAllowed("subexpiry")) {
      let granted = await isPermissionGranted();
      if (!granted) granted = (await requestPermission()) === "granted";
      if (granted) {
        for (const r of due.slice(0, MAX_PER_CHECK)) {
          sendNotification(notificationOptions(reminderText(r)));
          (sent[r.key] ||= {})[r.stage] = now;
          count++;
        }
      }
    }
    saveMap(SENT_KEY, sent);
  } catch (err) {
    console.warn("[sub-expiry] reminder check failed:", err);
  } finally {
    checking = false;
  }
  return count;
}

function scheduleCheck(ms) {
  if (!started) return;
  clearTimeout(soonTimer);
  soonTimer = setTimeout(() => { checkNow(); }, ms);
}

// call once at startup. the first list fetch waits a little so the logins are restored first
export function startSubExpiryReminders({ firstListAfterMs = 20000 } = {}) {
  if (started) return;
  started = true;
  setTimeout(refreshList, firstListAfterMs);
  listTimer = setInterval(refreshList, LIST_EVERY_MS);
  checkTimer = setInterval(() => { checkNow(); }, CHECK_EVERY_MS);
  // switched on in Settings, or a different number of days: look right away
  onSettingChange((id, v) => {
    if (id === "notifySubExpiry" && v) refreshList();
    else if (id === "subExpiryDays") scheduleCheck(500);
  });
}
