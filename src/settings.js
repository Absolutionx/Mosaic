// App settings: one place for defaults, persistence and change notification. The Settings panel
// (settings-panel.js) edits these; features read them with getSetting() at the moment they act, and
// subscribe with onSettingChange() when they need to react live.
//
// Four settings predate this module and are also toggled from the player's quality menu; they keep their
// original localStorage keys (and value formats) so existing choices carry over and both UIs stay in sync.

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
  catchUpToLive: true,
  autoPipOnBlur: false,
  autoTheater: true,
  vodHeatmap: true,
  vodTopClips: true,
  defaultVolume: 100,        // 0-100, for channels without a remembered volume
  rememberVolume: true,      // per-channel volume
  miniPlayer: true,          // floating mini player when you leave the stream for Home/Browse
  seekStep: 5,               // seconds per arrow key (Shift doubles it)
  streamInfoOverlay: true,
  mutedSegments: true,       // muted-audio markers on the VOD seek bar
  seekThumbnails: true,      // preview thumbnails when hovering the VOD seek bar
  vodSpeed: 1,               // VOD playback speed (remembered across VODs)
  clipLength: 30,            // last length picked in the clip panel (Alt+X uses it)
  videoContextMenu: false,   // the browser's own right-click menu, app-wide (video, text boxes, ...)
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
  notifySound: true,
  notifyVolume: 100,         // Mosaic's chime volume, % of the original (0-200): notifications + chat highlight sound
  quietHours: false,
  quietStart: 23,            // hour (0-23)
  quietEnd: 8,
  // sidebar
  liveChannelsCount: 10,     // 0 = all
  showOfflineFollowed: true,
  followedSort: "viewers",   // "viewers" | "name"
  hoverPreviews: true,
  hoverPreviewDelay: 350,    // ms
  hypeGlow: true,
  // home
  homeLauncher: true,        // MultiView launcher for live favorites (else the top-streams carousel)
  homeContinueRow: true,     // "Continue where you left off"
  homeRecommendedRow: true,  // "Live channels we think you'll like"
  multiviewLayout: "spotlight", // "spotlight" (focus layout once there are 3+ streams, as before) | "grid"
  multiviewSound: "first",   // "first" stream audible | "muted" (all start muted)
  // app
  closeToTray: true,
  autoClaimDrops: true,
  autoClaimBonus: true,      // claim the channel points bonus chest automatically while watching
  autostart: false,          // start Mosaic with your computer
  startMinimized: false,     // ...and go straight to the tray when it does
  uiZoom: 1,
  reduceMotion: false,
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
    if (legacy) localStorage.setItem(legacy.key, legacy.write(value));
    else {
      const s = load();
      s[id] = value;
      localStorage.setItem(STORE_KEY, JSON.stringify(s));
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
  body.classList.toggle("reduce-motion", !!getSetting("reduceMotion"));
}

// ---- notifications (Settings > Notifications) ----
// per-kind master switches + quiet hours; every desktop notification Mosaic sends goes through this
function inQuietHours(now = new Date()) {
  const start = Number(getSetting("quietStart")), end = Number(getSetting("quietEnd"));
  const h = now.getHours();
  if (start === end) return false;
  return start < end ? h >= start && h < end : h >= start || h < end; // windows can wrap midnight
}
export function notificationAllowed(kind) {
  const key = { golive: "notifyGoLive", category: "notifyCategory", whisper: "notifyWhispers" }[kind];
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
