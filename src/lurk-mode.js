// Lurk mode (Settings > Player > Lurk mode): while Mosaic is minimized or closed to the tray with a live Twitch
// stream playing, keep it going as audio only (or muted), so channel points, drops and watch streaks keep
// counting while Mosaic does a fraction of the work. Points and drops come from Mosaic's own watch heartbeat
// (watch_heartbeat.rs), not from the picture, so they don't care what quality plays.
// While lurking:
//   - the stream switches to the audio-only rendition (Twitch; Kick has none, so it just keeps playing)
//   - "Muted" also mutes it
//   - chat stops drawing messages (TwitchChat.setLurking) and says how long you were away when you're back
//   - WebView2's memory saver goes on even though something plays (main.js syncMemorySaver asks lurkActive())
// Back on screen, the quality and sound you had come back. Minimizing waits a few seconds first, so a quick
// minimize-and-restore doesn't restart the stream; closing to the tray lurks right away.

import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getSetting, onSettingChange } from "./settings.js";
import { session } from "./session.js";
import { recapStart, recapStop } from "./lurk-recap.js";

const MINIMIZE_DELAY_MS = 8000;

let ctx = null;   // { playbackControls, multiview, chat }
let state = null; // set while lurking
let timer = null;
// the page is marked hidden when the window goes to the tray (main.rs), but NOT when it's minimized, so minimizing is
// watched on the window itself. while lurking minimized, the page is told it's hidden (set_page_visible) so it
// stops drawing; pageHidden remembers that it was us, so it doesn't read as "still away" once you're back
let minimized = false;
let pageHidden = false;

export function lurkActive() { return !!state; }

// minimized or in the tray (main.js's memory saver asks this too)
export function isAway() { return minimized || (document.hidden && !pageHidden); }

// a live stream (not a VOD) in the main player, with nothing else showing the video (MultiView, a pop-out)
export function lurkEligible() {
  if (!ctx || getSetting("lurkMode") === "off") return false;
  const pc = ctx.playbackControls;
  const ch = String(session.intendedChannel || "");
  // and actually playing: switching quality restarts the stream, which would quietly un-pause one you'd paused
  return !!session.playing && !!ch && !ch.startsWith("vod:") && !pc.videoEl?.paused
    && !ctx.multiview?.isOpen && !pc._nativePipRestore && !pc.docPipWindow;
}

export function initLurkMode(c) {
  ctx = c;
  document.addEventListener("visibilitychange", sync);
  try {
    const w = getCurrentWindow();
    const check = async () => {
      const m = await w.isMinimized().catch(() => false);
      if (m === minimized) return;
      minimized = m;
      document.dispatchEvent(new CustomEvent("mosaic:away", { detail: { away: isAway() } }));
      sync();
    };
    // minimizing shrinks the window to nothing: only then (or on the way back) is it worth asking. a plain resize
    // fires many times a second while you drag an edge
    w.onResized(({ payload }) => { if (minimized || !payload || !(payload.width > 0 && payload.height > 0)) check(); });
    // a safety net: whenever the window has focus, it's on screen
    w.onFocusChanged(async ({ payload: focused }) => {
      // minimizing always takes focus away: a second way to notice it, whatever size the resize reported
      if (!focused) { check(); return; }
      await check();
      sync();
      if (pageHidden && !minimized && !state) { pageHidden = false; invoke("set_page_visible", { visible: true }).catch(() => {}); }
    });
  } catch { /* not in Tauri (tests) */ }
  // turning it off while lurking puts everything back
  onSettingChange((id) => { if (id === "lurkMode" && getSetting("lurkMode") === "off" && state) stop(); });
}

function sync() {
  if (isAway()) {
    if (state || timer || !lurkEligible()) return;
    timer = setTimeout(() => {
      timer = null;
      if (isAway() && !state && lurkEligible()) start();
    }, MINIMIZE_DELAY_MS);
  } else {
    if (timer) { clearTimeout(timer); timer = null; }
    if (state) stop();
  }
}

// closing to the tray: lurk now instead of stopping the stream (main.js hidden-to-tray). false = not eligible
export function lurkNow() {
  if (!lurkEligible()) return false;
  if (timer) { clearTimeout(timer); timer = null; }
  if (!state) start();
  return true;
}

function start() {
  const pc = ctx.playbackControls;
  const kick = !!pc._isKickSession || !!session.kickFailover;
  state = {
    since: Date.now(),
    prevQuality: pc.autoQualityMode ? "auto" : pc.currentQuality,
    switched: false,
    muted: false,
  };
  if (!kick && state.prevQuality !== "audio_only") {
    pc.selectQuality("audio_only");
    state.switched = true;
  }
  if (getSetting("lurkMode") === "muted" && !pc.isMuted) {
    pc.toggleMute();
    state.muted = true;
  }
  try { ctx.chat?.setLurking?.(true); } catch { /* ignore */ }
  try { recapStart(session.intendedChannel); } catch { /* ignore */ } // "while you lurked" (lurk-recap.js)
  // minimized: stop drawing the page entirely (the tray already does, main.rs)
  if (minimized && !document.hidden) {
    pageHidden = true;
    invoke("set_page_visible", { visible: false }).catch(() => { pageHidden = false; });
  }
  console.info(`[lurk] on (${state.switched ? "audio only" : "quality unchanged"}${state.muted ? ", muted" : ""})`);
  document.dispatchEvent(new CustomEvent("mosaic:lurk", { detail: { on: true } }));
}

function stop() {
  const s = state;
  state = null;
  if (pageHidden) {
    pageHidden = false;
    invoke("set_page_visible", { visible: true }).catch(() => {});
  }
  const pc = ctx.playbackControls;
  if (s.muted && pc.isMuted) pc.toggleMute();
  // put the picture back, unless you picked another quality yourself in the meantime (a raid that carried you
  // to another channel keeps audio only, so that one comes back too)
  if (s.switched && session.playing && pc.currentQuality === "audio_only" && !pc.autoQualityMode) {
    pc.selectQuality(s.prevQuality || "auto");
  }
  try { ctx.chat?.setLurking?.(false, Date.now() - s.since); } catch { /* ignore */ }
  recapStop({ audioOnly: s.switched, muted: s.muted, playing: !!session.playing, channel: () => session.intendedChannel }).catch(() => {});
  console.info(`[lurk] off after ${Math.round((Date.now() - s.since) / 1000)}s`);
  document.dispatchEvent(new CustomEvent("mosaic:lurk", { detail: { on: false } }));
}
