// App settings: one place for defaults, persistence and change notification. The Settings panel
// (settings-panel.js) edits these; features read them with getSetting() at the moment they act, and
// subscribe with onSettingChange() when they need to react live.
//
// Four settings predate this module and are also toggled from the player's quality menu; they keep their
// original localStorage keys (and value formats) so existing choices carry over and both UIs stay in sync.

import { themeVars, themeIsLight, THEME_VARS, customPartsCss } from "./themes.js";

const STORE_KEY = "mosaicSettings";

export const DEFAULTS = {
  // chat
  chatFontSize: "auto",      // "auto" (13px, 15px on large windows, as before) or a px size
  emoteScale: 1,             // 0.8 / 1 / 1.3 / 1.6
  showTimestamps: false,
  emotes7tv: true,
  emotesBttv: true,
  emotesFfz: true,
  sevenTvPaints: true,       // 7TV gradient/image username paints
  liveRewindSecs: 120,       // live video kept in memory for instant rewinding (Twitch relay + Kick); 1080p is ~45 MB a minute
  chatSpellcheck: true,      // red underlines on misspelled words in the chat box; right-click one for suggestions
  sevenTvPaintsAnimate: false, // the paints' colors slowly flowing. off: each repaint of an animated name costs CPU every frame
  clipCards: true,           // Twitch clip links -> playable cards
  linkPreviews: true,        // hover previews on links
  predictionsPolls: true,
  hypeGiftBanners: true,
  hypeTrainCelebrate: true,  // "LEVEL N!" burst with confetti over the video on level-up
  hypeTrainSound: false,     // the chime on level-up
  hypeTrainNotify: false,    // desktop notification when a followed channel starts a hype train
  ambientGlow: "off",        // "off" | "subtle" | "normal" | "strong": glow around the video from its colors
  pinnedBanner: true,
  highlightMentions: true,   // messages that mention you (or a keyword) get highlighted
  highlightKeywords: "",     // comma-separated extra words to highlight
  highlightSound: false,     // chime on a highlighted message
  pauseOnHover: false,       // freeze chat scrolling while the mouse is over it
  zebraLines: false,         // alternating line backgrounds
  usernameColors: "color",   // "color" | "neutral"
  deletedMessages: "dim",    // "dim" (struck through, as before) | "hide"
  showBadges: true,
  hideBitsBadges: false,
  hidePredictionBadges: false,
  firstChatterGlow: true,
  highlightedGlow: true,
  emoteColonTrigger: true,   // ":name" opens emote suggestions (Tab always does)
  asciiArt: true,            // special fitting for chat art
  chatHistory: 250,          // messages kept in chat
  // player
  defaultQuality: "best",    // streamlink spec (with fallbacks)
  lowLatency: false,
  preloadFavorites: false,   // keep live favorites loading in the background so they open instantly (preload.js)
  preloadCount: 1,           // how many at once (1-4)
  preloadChannels: [],       // which favorites (lowercase logins); empty = any favorite, in sidebar order
  catchUpToLive: true,
  autoPipOnBlur: false,
  lurkMode: "off",           // "off" | "audio" | "muted": minimized / in the tray, keep the stream as audio only (lurk-mode.js)
  autoTheater: true,
  vodHeatmap: true,
  vodTopClips: true,
  defaultVolume: 100,        // 0-100, for channels without a remembered volume
  rememberVolume: true,      // per-channel volume
  miniPlayer: true,          // floating mini player when you leave the stream for Home/Browse
  seekStep: 5,               // seconds per arrow key (Shift doubles it)
  streamInfoOverlay: true,
  mutedSegments: true,       // muted-audio markers on the VOD seek bar
  skipMutedSegments: "off",  // VOD ranges muted for copyright: "off" play / "ask" prompt / "auto" skip (muted-skip.js)
  seekThumbnails: true,      // preview thumbnails when hovering the VOD seek bar
  vodSpeed: 1,               // VOD playback speed (remembered across VODs)
  clipLength: 30,            // last length picked in the clip panel (Alt+X uses it)
  videoContextMenu: false,   // the browser's own right-click menu, app-wide (video, text boxes, ...)
  devTools: false,           // Inspect / Ctrl+Shift+I (release builds only; dev builds always have them)
  chatOverlay: false,        // chat over the video in theater mode / fullscreen
  chatOverlayRect: null,     // overlay position + size as fractions of the video picture (null = default)
  chatOverlayInput: true,    // a message box in the overlay
  emoteHoverCard: true,      // hovering an emote shows its card (preview, source, creator)
  audioNormalize: false,     // even out loud and quiet moments (compressor + make-up gain + limiter)
  audioNormalizeStrength: "balanced", // "light" | "balanced" | "strong"
  followRaids: "auto",       // "auto" (5s countdown, then go) | "ask" | "off"
  // notifications
  notifyGoLive: true,
  notifyCategory: true,
  notifyWhispers: true,      // desktop notification for a whisper while Mosaic isn't focused
  notifySubExpiry: true,     // reminder before a Twitch subscription that won't renew runs out (sub-expiry.js)
  subExpiryDays: 3,          // how many days ahead the first reminder comes
  showWhatsNew: true,
  lunaButton: true,          // the crown in the header: Amazon Luna benefits to claim with Prime (luna-panel.js)
  notificationsButton: true, // the bell in the header: your Twitch notifications (notifications-panel.js)        // the What's new window after an update (whats-new.js)
  subEndingNotice: true,     // on the channel: a "Sub ends in 2 days" chip by Subscribe + one line in chat (channel-you.js)
  notifySound: true,
  notifyVolume: 100,         // Mosaic's chime volume, % of the original (0-200): notifications + chat highlight sound
  quietHours: false,
  quietStart: 23,            // hour (0-23)
  quietEnd: 8,
  // sidebar
  liveChannelsCount: 10,     // 0 = all
  showOfflineFollowed: true,
  followedSort: "viewers",   // "viewers" | "name"
  favoritesOrder: "live",    // "live" (live first, most viewers first) | "custom" (the order you dragged them into)
  hoverPreviews: true,
  hoverPreviewDelay: 350,    // ms
  hypeGlow: true,
  richGlow: false,           // Animated glows: pulsing hype glows + the softest ambient glow (more CPU / GPU)
  // home
  homeLauncher: true,        // MultiView launcher for live favorites (else the top-streams carousel)
  homeContinueRow: true,     // "Continue where you left off"
  homeRecommendedRow: true,  // "Live channels we think you'll like"
  livePreviews: true,        // hovering a live stream or VOD card plays it, muted (live-preview.js)
  multiviewLayout: "spotlight", // "spotlight" (focus layout once there are 3+ streams, as before) | "grid"
  multiviewSound: "first",   // "first" stream audible | "muted" (all start muted)
  // app
  closeToTray: true,
  autoClaimDrops: true,
  autoClaimBonus: true,      // claim the channel points bonus chest automatically while watching
  dropsAutopilot: "ask",     // stream ended mid-campaign: "ask" to switch, "auto" (10s countdown) or "off" (drops-autopilot.js)
  autostart: false,          // start Mosaic with your computer
  startMinimized: false,     // ...and go straight to the tray when it does
  uiZoom: 1,
  reduceMotion: false,
  // appearance (themes.js)
  theme: "mosaic",           // preset id
  themeAccent: "theme",      // "theme" (the preset's own; Mosaic's is the platform color) | "platform" (Twitch purple / Kick green) | "#rrggbb"
  themeColors: {},           // your overrides on top of the preset: { bg, surface, surface2, raised, border, text, muted }
  customParts: {},           // Customize picker (customize.js): { partId: { bg, text, border, accent, radius, hidden } }
  customCss: "",             // Appearance > Custom CSS, your own rules on top of everything
  customCssOn: true,         // quick off switch for it, without losing what you wrote
  savedLooks: [],            // Appearance > Saved looks: [{ name, look }] (theme-share.js)
  autoUpdateCheck: true,
};

// settings stored under their original keys (see header)
const LEGACY = {
  lowLatency: { key: "lowLatency", read: (v) => v === "true", write: (b) => String(!!b) },
  catchUpToLive: { key: "catchUpToLive", read: (v) => v !== "0", write: (b) => (b ? "1" : "0") },
  autoPipOnBlur: { key: "autoPipOnBlur", read: (v) => v === "1", write: (b) => (b ? "1" : "0") },
  closeToTray: { key: "closeToTray", read: (v) => v !== "0", write: (b) => (b ? "1" : "0") },
};

let store = null;
function load() {
  if (store) return store;
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) || "{}");
    store = raw && typeof raw === "object" ? raw : {};
  } catch { store = {}; }
  // "Muted sections" began as an on/off switch (skipMutedSegments: true/false): on means "auto"
  if (typeof store.skipMutedSegments === "boolean") store.skipMutedSegments = store.skipMutedSegments ? "auto" : "off";
  return store;
}

export function getSetting(id) {
  const legacy = LEGACY[id];
  if (legacy) {
    let v = null;
    try { v = localStorage.getItem(legacy.key); } catch { /* ignore */ }
    return v === null ? DEFAULTS[id] : legacy.read(v);
  }
  const s = load();
  return id in s ? s[id] : DEFAULTS[id];
}

const listeners = new Set();
export function onSettingChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function setSetting(id, value) {
  if (!(id in DEFAULTS)) return;
  const legacy = LEGACY[id];
  try {
    if (legacy) { if (!window.__mosaicRestoring) localStorage.setItem(legacy.key, legacy.write(value)); }
    else {
      const s = load();
      s[id] = value;
      // a backup is being restored (backup.js): saving the settings still in memory would undo it
      if (!window.__mosaicRestoring) localStorage.setItem(STORE_KEY, JSON.stringify(s));
    }
  } catch { /* quota: the change still applies this session */ }
  applyAppearance();
  for (const fn of listeners) {
    try { fn(id, value); } catch (err) { console.error("[settings] listener error:", err); }
  }
}

export function resetSettings() {
  store = {};
  try {
    localStorage.removeItem(STORE_KEY);
    for (const { key } of Object.values(LEGACY)) localStorage.removeItem(key);
  } catch { /* ignore */ }
  applyAppearance();
  for (const id of Object.keys(DEFAULTS)) {
    for (const fn of listeners) {
      try { fn(id, getSetting(id)); } catch { /* ignore */ }
    }
  }
}

// other windows of Mosaic (the PiP player, MultiView pop-outs) share these settings through localStorage:
// when the main window changes them, re-read and re-apply, so a pop-out follows a theme change live
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key !== STORE_KEY && e.key !== null) return;
    store = null;
    applyAppearance();
  });
}

// Safe mode: Ctrl+Alt+Shift+S switches custom CSS and customized parts off (and back on) without deleting
// them, for when they've hidden Settings itself. Lasts until pressed again or Mosaic restarts
let safeMode = false;
if (typeof document !== "undefined") {
  document.addEventListener("keydown", (e) => {
    if (!(e.ctrlKey && e.altKey && e.shiftKey && e.code === "KeyS")) return;
    e.preventDefault();
    safeMode = !safeMode;
    applyAppearance();
    showSafeModeNote(safeMode);
  }, true);
}
function showSafeModeNote(on) {
  document.getElementById("mosaic-safe-note")?.remove();
  const n = document.createElement("div");
  n.id = "mosaic-safe-note";
  n.textContent = on
    ? "Custom CSS and customized parts are off until you press Ctrl+Alt+Shift+S again or restart Mosaic."
    : "Custom CSS and customized parts are back on.";
  Object.assign(n.style, {
    position: "fixed", left: "50%", bottom: "24px", transform: "translateX(-50%)", zIndex: "2147483647",
    padding: "10px 16px", borderRadius: "10px", font: "600 13px system-ui, sans-serif",
    background: "#161b22", color: "#e7ebf2", border: "1px solid #29313d", boxShadow: "0 8px 24px rgba(0,0,0,.45)",
  });
  document.body.appendChild(n);
  setTimeout(() => n.remove(), 5000);
}

// a <style> of ours at the end of <head> (created once, kept last so it wins ties)
function styleTag(id) {
  let el = document.getElementById(id);
  if (!el) {
    el = document.createElement("style");
    el.id = id;
    document.head.appendChild(el);
  }
  return el;
}

// display-only settings apply through CSS (variables + body classes), so they change instantly, including
// on messages already in chat
export function applyAppearance() {
  const root = document.documentElement;
  // text size: "auto" leaves the built-in sizing alone (13px, 15px on large windows); a number overrides
  // it everywhere chat appears (via body.chat-font-custom, which out-specifies the large-window rule)
  const size = getSetting("chatFontSize");
  const custom = size !== "auto" && Number(size) > 0;
  if (custom) root.style.setProperty("--chat-font-size", `${Number(size)}px`);
  else root.style.removeProperty("--chat-font-size");
  document.body?.classList.toggle("chat-font-custom", custom);
  root.style.setProperty("--chat-emote-scale", String(Number(getSetting("emoteScale")) || 1));
  const body = document.body;
  if (!body) return;
  // theme: inline variables on <body>, so they win over :root and body.kick-mode's accent (themes.js)
  const vars = themeVars(getSetting("theme"), getSetting("themeColors"), getSetting("themeAccent"));
  for (const v of THEME_VARS) {
    if (vars && vars[v]) body.style.setProperty(v, vars[v]);
    else body.style.removeProperty(v);
  }
  const light = themeIsLight(getSetting("theme"), getSetting("themeColors"));
  body.classList.toggle("theme-light", light);
  // your picked parts, then your own CSS, as the last stylesheets in the page so they win
  styleTag("mosaic-custom-parts").textContent = safeMode ? "" : customPartsCss(getSetting("customParts"), light);
  styleTag("mosaic-custom-css").textContent = !safeMode && getSetting("customCssOn") ? String(getSetting("customCss") || "") : "";
  body.classList.toggle("chat-show-timestamps", !!getSetting("showTimestamps"));
  body.classList.toggle("chat-zebra", !!getSetting("zebraLines"));
  body.classList.toggle("chat-neutral-names", getSetting("usernameColors") === "neutral");
  body.classList.toggle("chat-hide-deleted", getSetting("deletedMessages") === "hide");
  body.classList.toggle("chat-hide-badges", !getSetting("showBadges"));
  body.classList.toggle("chat-hide-bits-badges", !!getSetting("hideBitsBadges"));
  body.classList.toggle("chat-hide-prediction-badges", !!getSetting("hidePredictionBadges"));
  body.classList.toggle("chat-no-first-glow", !getSetting("firstChatterGlow"));
  body.classList.toggle("chat-no-highlight-glow", !getSetting("highlightedGlow"));
  body.classList.toggle("no-stream-info-overlay", !getSetting("streamInfoOverlay"));
  body.classList.toggle("no-hype-glow", !getSetting("hypeGlow"));
  body.classList.toggle("rich-glow", !!getSetting("richGlow"));
  body.classList.toggle("chat-paints-animate", !!getSetting("sevenTvPaintsAnimate"));
  body.classList.toggle("reduce-motion", !!getSetting("reduceMotion"));
  // spell check in the chat box (WebView2 uses the Windows spell checker and its language)
  const chatInput = document.getElementById("chat-input");
  if (chatInput) chatInput.spellcheck = !!getSetting("chatSpellcheck");
}

// ---- notifications (Settings > Notifications) ----
// per-kind master switches + quiet hours; every desktop notification Mosaic sends goes through this
// Settings > Notifications > Quiet hours: also silences the chat mention chime (chat.js)
export function quietNow(now = new Date()) { return !!getSetting("quietHours") && inQuietHours(now); }
function inQuietHours(now = new Date()) {
  const start = Number(getSetting("quietStart")), end = Number(getSetting("quietEnd"));
  const h = now.getHours();
  if (start === end) return false;
  return start < end ? h >= start && h < end : h >= start || h < end; // windows can wrap midnight
}
export function notificationAllowed(kind) {
  const key = { golive: "notifyGoLive", category: "notifyCategory", whisper: "notifyWhispers", subexpiry: "notifySubExpiry" }[kind];
  if (key && !getSetting(key)) return false;
  if (getSetting("quietHours") && inQuietHours()) return false;
  return true;
}
// Mosaic's own chime (desktop notifications ask the OS to stay silent; see notificationOptions). Windows
// toasts are silent here (no sound name -> <audio silent="true"/>), so this is the only notification sound,
// and Settings > Notifications > Sound volume scales it (0% plays nothing).
// two bell-like notes (fundamental + an octave overtone, ~0.6s ring): a pure short sine sounded far quieter
// than its level. 100% averages ~12 dB louder than the original chime and 200% ~18 dB; the limiter at the
// end keeps 200% just under full scale where the two notes overlap, so it never distorts
const CHIME_PEAK = 0.3, CHIME_OVERTONE = 0.4, CHIME_RING_S = 0.6;
let audioCtx = null, chimeLimiter = null, lastChime = 0;
export function playChime({ preview = false } = {}) {
  const volume = Math.max(0, Math.min(200, Number(getSetting("notifyVolume") ?? 100))) / 100;
  if (!(volume > 0)) return;
  if (!preview && Date.now() - lastChime < 1500) return; // never machine-gun it in a busy chat
  lastChime = Date.now();
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
    if (!chimeLimiter) {
      chimeLimiter = audioCtx.createDynamicsCompressor();
      chimeLimiter.threshold.value = -4;
      chimeLimiter.knee.value = 4;
      chimeLimiter.ratio.value = 20;
      chimeLimiter.attack.value = 0.001;
      chimeLimiter.release.value = 0.1;
      chimeLimiter.connect(audioCtx.destination);
    }
    const t = audioCtx.currentTime;
    const peak = CHIME_PEAK * volume;
    for (const [freq, at] of [[880, 0], [1320, 0.12]]) {
      const env = audioCtx.createGain();
      env.gain.setValueAtTime(0.0001, t + at);
      env.gain.exponentialRampToValueAtTime(peak, t + at + 0.01);
      env.gain.exponentialRampToValueAtTime(0.0001, t + at + CHIME_RING_S);
      env.connect(chimeLimiter);
      for (const [mult, amp] of [[1, 1], [2, CHIME_OVERTONE]]) {
        const osc = audioCtx.createOscillator(), level = audioCtx.createGain();
        osc.type = "sine"; osc.frequency.value = freq * mult;
        level.gain.value = amp;
        osc.connect(level).connect(env);
        osc.start(t + at); osc.stop(t + at + CHIME_RING_S + 0.05);
      }
    }
  } catch { /* no audio available */ }
}
// extra options for sendNotification: with Mosaic's sound setting on, it plays its own chime and asks the OS
// for a silent toast, so the sound is the same everywhere; with it off, both stay quiet
export function notificationOptions(opts) {
  if (getSetting("notifySound")) playChime();
  return { ...opts, silent: true };
}
