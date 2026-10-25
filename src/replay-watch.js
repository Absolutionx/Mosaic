// Clips and VODs count as watching (1.8.1). Twitch's own players report replays, and a broken watch streak
// ("watch a clip, VOD or stream in the next 24h to save it") is saved from those reports; Mosaic's players
// used to send nothing. This times the reports like the web player does (checked 10-19-26) and
// heartbeat_replay (watch_heartbeat.rs) sends them with the Twitch connection:
//   - when it starts playing: "start" (a clip also counts a view)
//   - a clip's first minute ~9 s in, a VOD's ~15 s in, then one every 60 s of playing
//   - "nsec" (Twitch's n_second_play) after 5, 15 and 45 s of playing (checked 10-24-26)
//   - a VOD only: "viewed" every 20 s of playing, the account's "watched up to here" (updateUserViewedVideo),
//     which twitch.tv's player sends and Mosaic's didn't
// Only while it's actually playing (not paused, buffering or ended), and one at a time: a clip opened over a
// VOD reports alone until it closes, then the VOD carries on.

import { invoke } from "@tauri-apps/api/core";

const FIRST_MINUTE_AT = { clip: 9, vod: 15 };
const MINUTE = 60;
const N_SECOND_AT = [5, 15, 45];
const VIEWED_EVERY = { vod: 20 }; // clips have no viewed position
const TICK_MS = 1000;
// a background page's timers can be slowed to once a minute; seconds are counted from the clock, capped so a
// sleeping computer doesn't count as watching
const MAX_STEP_S = 65;

const watchers = []; // newest last; only the newest one reports
let timer = null;

// start reporting a clip ("clip", slug) or Twitch VOD ("vod", id) playing in <video>. stillCurrent() says
// whether it's still the one on screen; once it says no, the watcher ends. Returns a stop function.
export function watchReplay(kind, id, video, stillCurrent = () => true) {
  if (!FIRST_MINUTE_AT[kind] || !id || !video) return () => {};
  const key = `${kind}:${id}`;
  for (let i = watchers.length - 1; i >= 0; i--) if (watchers[i].key === key || watchers[i].video === video) watchers.splice(i, 1);
  const w = { key, kind, id: String(id), video, stillCurrent, played: 0, minutes: 0, started: false, nsec: 0, viewed: 0, last: 0 };
  watchers.push(w);
  if (!timer) timer = setInterval(tick, TICK_MS);
  return () => remove(w);
}

function remove(w) {
  const i = watchers.indexOf(w);
  if (i >= 0) watchers.splice(i, 1);
  if (!watchers.length && timer) { clearInterval(timer); timer = null; }
}

export const isPlaying = (v) => !!v && v.isConnected && !v.paused && !v.ended && v.readyState >= 3;

// what's due after `played` seconds of playing, given what was already sent (for tests too).
// sent: { started, minutes, nsec (milestones sent), viewed (viewed reports sent) }
export function dueReports(kind, played, sent) {
  const out = [];
  if (!sent.started && played > 0) out.push("start");
  for (let n = sent.nsec || 0; n < N_SECOND_AT.length && played >= N_SECOND_AT[n]; n++) out.push("nsec");
  const first = FIRST_MINUTE_AT[kind];
  let m = sent.minutes || 0;
  while (played >= first + m * MINUTE) { out.push("minute"); m++; }
  const every = VIEWED_EVERY[kind];
  if (every) for (let v = sent.viewed || 0; played >= (v + 1) * every; v++) out.push("viewed");
  return out;
}

function tick() {
  const now = Date.now();
  for (let i = watchers.length - 1; i >= 0; i--) {
    let ok = false;
    try { ok = watchers[i].stillCurrent(); } catch { ok = false; }
    if (!ok) remove(watchers[i]);
  }
  const w = watchers[watchers.length - 1];
  if (!w) return;
  for (const other of watchers) if (other !== w) other.last = 0; // a paused-behind VOD doesn't bank time
  if (!isPlaying(w.video)) { w.last = 0; return; }
  const step = w.last ? Math.min((now - w.last) / 1000, MAX_STEP_S) : 0.5;
  w.last = now;
  w.played += step;
  for (const ev of dueReports(w.kind, w.played, w)) {
    if (ev === "start") w.started = true;
    else if (ev === "nsec") w.nsec++;
    else if (ev === "viewed") w.viewed++;
    else w.minutes++;
    send(w, ev, ev === "nsec" ? N_SECOND_AT[w.nsec - 1] : 0);
  }
}

function send(w, event, seconds) {
  invoke("heartbeat_replay", {
    kind: w.kind,
    id: w.id,
    event,
    minutes: w.minutes,
    position: Number(w.video.currentTime) || 0,
    muted: !!w.video.muted,
    seconds,
  }).catch((e) => console.warn(`[replay-watch] ${w.kind} ${w.id} ${event}:`, e));
}

// for tests
export const _watchers = () => watchers.slice();
