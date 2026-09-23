// VOD chat heatmap: how busy chat was across a Twitch VOD, drawn on the seek bar with the biggest
// spikes marked. Rather than downloading the whole chat (tens of thousands of messages on a long VOD),
// it samples ~40-200 evenly spaced points: at each, Rust fetches ONE page of VOD chat starting there and
// returns just how many messages the page held and the time they spanned (get_vod_chat_density in
// helix.rs). A quiet stretch spreads a page over minutes; a spike packs it into seconds, so
// messages ÷ seconds is a good relative measure of chat activity. Sampled in batches so the heatmap
// fills in progressively; finished heatmaps are cached per VOD (localStorage) so reopening is instant.

import { invoke } from "@tauri-apps/api/core";

const BATCH = 25;               // offsets per backend call (fetched 6 at a time in Rust)
const MIN_SAMPLES = 40;
const MAX_SAMPLES = 200;        // ~1 sample/minute, capped: a 6h VOD is 200 small requests total
const MAX_PEAKS = 6;
const CACHE_KEY = "vodHeatmapCache";
const CACHE_MAX = 40;           // VODs remembered
const CACHE_VERSION = 1;

// evenly spaced sample centers across the VOD
function sampleOffsets(total) {
  const n = Math.max(MIN_SAMPLES, Math.min(MAX_SAMPLES, Math.round(total / 60)));
  const step = total / n;
  return Array.from({ length: n }, (_, i) => Math.floor((i + 0.5) * step));
}

// messages per second for one sample. the page starts at the sample offset and runs to its last
// message, so dividing by (last - offset) also accounts for a silent gap right after the offset
function rateOf(s) {
  if (!s || s.error) return null;
  if (!s.count) return 0;
  const span = Math.max(1, (s.last ?? s.offset) - s.offset);
  return s.count / span;
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
  return sorted[i];
}

// rates -> { levels: 0..1 per sample (null = not loaded yet), peaks: [sample index...] }
export function analyze(rates) {
  const n = rates.length;
  // light smoothing (1-2-1) so single noisy samples don't read as spikes; skips unloaded samples
  const smooth = rates.map((r, i) => {
    if (r == null) return null;
    let sum = 2 * r, w = 2;
    if (i > 0 && rates[i - 1] != null) { sum += rates[i - 1]; w += 1; }
    if (i < n - 1 && rates[i + 1] != null) { sum += rates[i + 1]; w += 1; }
    return sum / w;
  });
  const known = smooth.filter((v) => v != null).sort((a, b) => a - b);
  // scale to the 97th percentile so one extreme outlier doesn't flatten everything else
  const ceiling = percentile(known, 0.97) || known[known.length - 1] || 0;
  const levels = smooth.map((v) => (v == null ? null : ceiling > 0 ? Math.min(1, v / ceiling) : 0));

  // peaks: local maxima clearly above typical activity, spread out, strongest first
  const median = percentile(known, 0.5);
  const threshold = Math.max(median * 2, percentile(known, 0.85));
  const candidates = [];
  for (let i = 0; i < n; i++) {
    const v = smooth[i];
    if (v == null || v <= 0 || v < threshold) continue;
    const left = i > 0 ? smooth[i - 1] ?? -1 : -1;
    const right = i < n - 1 ? smooth[i + 1] ?? -1 : -1;
    if (v >= left && v >= right) candidates.push(i);
  }
  candidates.sort((a, b) => smooth[b] - smooth[a]);
  const minSep = Math.max(2, Math.round(n * 0.04));
  const peaks = [];
  for (const i of candidates) {
    if (peaks.every((p) => Math.abs(p - i) >= minSep)) peaks.push(i);
    if (peaks.length >= MAX_PEAKS) break;
  }
  peaks.sort((a, b) => a - b);
  return { levels, peaks };
}

function loadCache() {
  try {
    const c = JSON.parse(localStorage.getItem(CACHE_KEY) || "{}");
    return c && typeof c === "object" ? c : {};
  } catch { return {}; }
}
function saveCache(videoId, total, rates) {
  try {
    const c = loadCache();
    c[videoId] = { v: CACHE_VERSION, total, rates, at: Date.now() };
    const ids = Object.keys(c);
    if (ids.length > CACHE_MAX) {
      ids.sort((a, b) => (c[a].at || 0) - (c[b].at || 0));
      for (const id of ids.slice(0, ids.length - CACHE_MAX)) delete c[id];
    }
    localStorage.setItem(CACHE_KEY, JSON.stringify(c));
  } catch { /* quota: heatmap just isn't cached */ }
}

// Starts building the heatmap for a Twitch VOD. onUpdate({ levels, peaks, total, done }) is called as
// batches arrive (and once immediately on a cache hit). Returns { cancel } — call it when the VOD
// changes so a slow load can't paint onto the next video.
export function startVodHeatmap(videoId, total, onUpdate) {
  let cancelled = false;
  const handle = { cancel: () => { cancelled = true; } };
  if (!videoId || !/^\d+$/.test(String(videoId)) || !(total > 0)) return handle; // Twitch VODs only

  const cached = loadCache()[videoId];
  if (cached && cached.v === CACHE_VERSION && Array.isArray(cached.rates) && Math.abs((cached.total || 0) - total) < 5) {
    onUpdate({ ...analyze(cached.rates), total, done: true });
    return handle;
  }

  const offsets = sampleOffsets(total);
  const rates = new Array(offsets.length).fill(null);
  const indexOf = new Map(offsets.map((o, i) => [o, i]));

  (async () => {
    let failures = 0;
    for (let b = 0; b < offsets.length && !cancelled; b += BATCH) {
      const batch = offsets.slice(b, b + BATCH);
      let res = [];
      try {
        res = await invoke("get_vod_chat_density", { videoId: String(videoId), offsets: batch });
      } catch (err) {
        console.warn("[heatmap] batch failed:", err);
        failures += batch.length;
      }
      if (cancelled) return;
      for (const s of res || []) {
        const i = indexOf.get(Math.floor(s.offset));
        if (i == null) continue;
        const r = rateOf(s);
        if (r == null) failures++;
        else rates[i] = r;
      }
      const done = b + BATCH >= offsets.length;
      onUpdate({ ...analyze(rates), total, done });
    }
    // only cache a (nearly) complete picture, so a flaky load is retried next time
    if (!cancelled && failures <= offsets.length * 0.1) {
      saveCache(videoId, total, rates.map((r) => (r == null ? 0 : r)));
    }
  })();

  return handle;
}
