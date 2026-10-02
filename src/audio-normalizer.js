// Audio normalization (Settings > Player > Normalize volume, off by default): evens out loud and quiet
// moments in the main player.
//
//   video -> compressor -> make-up gain -> limiter -> speakers
//
// The compressor turns loud parts down (above its threshold, by its ratio), the make-up gain lifts
// everything back up so quiet speech gets louder too, and the limiter catches anything that would clip.
// The player's own volume and mute still apply first, so the volume slider works as before.
//
// Nothing is rerouted until the setting is first turned on. A media element can't be un-routed from
// Web Audio once connected, so turning the setting off afterwards switches to a straight pass-through
// (original sound) rather than tearing the graph down.

import { getSetting, onSettingChange } from "./settings.js";

// strength presets: [threshold dB, ratio, knee dB, attack s, release s, make-up gain (linear)]
export const PRESETS = {
  light:    { threshold: -24, ratio: 3,  knee: 18, attack: 0.010, release: 0.25, makeup: 1.6 },  // ~+4 dB
  balanced: { threshold: -32, ratio: 6,  knee: 24, attack: 0.005, release: 0.30, makeup: 2.2 },  // ~+7 dB
  strong:   { threshold: -40, ratio: 12, knee: 30, attack: 0.003, release: 0.35, makeup: 4.5 },  // ~+13 dB
};

let video = null, ctx = null, source = null, comp = null, makeup = null, limiter = null, wired = null;

export function initAudioNormalizer(videoEl) {
  video = videoEl;
  onSettingChange((id) => { if (id === "audioNormalize" || id === "audioNormalizeStrength") apply(); });
  // an AudioContext created without a click may start suspended; playback resumes it
  video.addEventListener("play", () => { if (ctx && ctx.state === "suspended") ctx.resume().catch(() => {}); });
  if (getSetting("audioNormalize")) {
    // already on at startup: wait for the first click / key before rerouting. an audio context created
    // without user interaction can start suspended, and since the video's sound would be routed THROUGH
    // it, playback could be silent until a click. until then the sound plays normally (just not evened out).
    // turning the setting on in Settings is itself a click, so that path builds right away
    const start = () => {
      window.removeEventListener("pointerdown", start, true);
      window.removeEventListener("keydown", start, true);
      apply();
    };
    window.addEventListener("pointerdown", start, true);
    window.addEventListener("keydown", start, true);
  }
}

function build() {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return false;
  ctx = new AC({ latencyHint: "interactive" });
  source = ctx.createMediaElementSource(video);
  comp = ctx.createDynamicsCompressor();
  makeup = ctx.createGain();
  limiter = ctx.createDynamicsCompressor();
  // the limiter: a near-brickwall ceiling just under full scale, fast enough to catch peaks
  limiter.threshold.value = -2;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.001;
  limiter.release.value = 0.1;
  comp.connect(makeup);
  makeup.connect(limiter);
  limiter.connect(ctx.destination);
  return true;
}

function apply() {
  if (!video) return;
  const on = !!getSetting("audioNormalize");
  if (!ctx) {
    if (!on) return;          // never turned on: the audio isn't rerouted at all
    if (!build()) return;
  }
  const p = PRESETS[getSetting("audioNormalizeStrength")] || PRESETS.balanced;
  const t = ctx.currentTime;
  comp.threshold.setValueAtTime(p.threshold, t);
  comp.ratio.setValueAtTime(p.ratio, t);
  comp.knee.setValueAtTime(p.knee, t);
  comp.attack.setValueAtTime(p.attack, t);
  comp.release.setValueAtTime(p.release, t);
  makeup.gain.setValueAtTime(p.makeup, t);
  const want = on ? "normalized" : "bypass";
  if (wired !== want) {
    source.disconnect();
    source.connect(on ? comp : ctx.destination);
    wired = want;
  }
  if (ctx.state === "suspended") ctx.resume().catch(() => {});
}

// for Stats for nerds / diagnostics: how much the compressor is pulling down right now (dB, <= 0)
export function normalizerReduction() {
  return wired === "normalized" && comp ? comp.reduction : null;
}
