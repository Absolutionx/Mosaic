// Muted sections (Settings > Player > VODs, or the row in a VOD's settings menu): what happens when VOD
// playback runs into a range whose audio Twitch muted for copyright.
//   "off"  play it, as Twitch does
//   "ask"  keep playing, with a small "Muted section · Skip" prompt on the player while you're in it
//   "auto" jump to the end of it, with a "Skipped a muted section · Watch it" notice
//
// only playback that RUNS INTO a muted range skips it. a seek that lands inside one (clicking the red band on
// the seek bar, a chapter, a bookmark, resuming where you left off) is taken as wanting to see that part, so
// it plays. the one exception is landing right at a range's start (within a second), which is how a VOD that
// begins muted starts playing. "Watch it" on the notice (playback-controls.js) lets one range play after all.

// the setting's value as one of the three modes. it was an on/off switch at first: on means "auto"
export function mutedSkipMode(v) {
  if (v === true || v === "auto") return "auto";
  if (v === "ask") return "ask";
  return "off";
}

const LAND_AT_START_S = 1;  // a seek landing this close to a range's start counts as running into it
const END_MARGIN_S = 0.75;  // this close to a range's end, there's nothing left worth skipping

// the muted ranges as [start, end) seconds, sorted, with zero-length / malformed entries dropped.
// segments: Helix muted_segments, [{ offset, duration }]
export function mutedRanges(segments) {
  return (Array.isArray(segments) ? segments : [])
    .map((s) => [Number(s?.offset), Number(s?.offset) + Number(s?.duration)])
    .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b > a)
    .sort((x, y) => x[0] - y[0]);
}

// where playback should jump to, or null to let it play.
//   ranges: mutedRanges(...), t: the current position, lastT: the position a moment ago during continuous
//   playback (null right after a seek or when playback starts), allowed: range starts the user chose to watch,
//   total: the VOD's length (0 = unknown).
// returns { from, to }: from = the start of the range being skipped (what "Watch it" goes back to)
export function mutedSkipTarget(ranges, t, lastT, allowed = new Set(), total = 0) {
  if (!Number.isFinite(t)) return null;
  for (const [start, end] of ranges) {
    if (t < start || t >= end - END_MARGIN_S) continue;
    if (allowed.has(start)) return null;
    // lastT exactly at the start counts: paused at 0:00 on a VOD that begins muted, then Play
    const ranInto = lastT == null ? t - start < LAND_AT_START_S : lastT <= start;
    if (!ranInto) return null;
    return { from: start, to: chainEnd(ranges, end, allowed, total) };
  }
  return null;
}

// "ask" mode offers the jump wherever you are in a muted range, however you got there (playing into it,
// clicking into it, resuming inside it): it's only an offer. { from, to } of the range at t, or null
export function mutedRangeAt(ranges, t, allowed = new Set(), total = 0) {
  if (!Number.isFinite(t)) return null;
  for (const [start, end] of ranges) {
    if (t < start || t >= end - END_MARGIN_S || allowed.has(start)) continue;
    return { from: start, to: chainEnd(ranges, end, allowed, total) };
  }
  return null;
}

// ranges that touch or overlap the end of this one are skipped in the same jump
function chainEnd(ranges, end, allowed, total) {
  let to = end;
  for (const [s2, e2] of ranges) if (s2 <= to + 0.05 && e2 > to && !allowed.has(s2)) to = e2;
  return total > 0 ? Math.min(to, total) : to;
}
