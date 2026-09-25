// The Settings panel: every app setting in one place, grouped into sections with search. Values live in
// settings.js; changes save instantly (no Save button) and apply live where possible. main.js supplies the
// launchers for the editors that already exist (chat filter, hidden channels, Twitch connection).

import { getVersion } from "@tauri-apps/api/app";
import { getSetting, setSetting, onSettingChange, resetSettings } from "./settings.js";

let actions = {}; // { openChatFilter, openHiddenChannels, openTwitchConnection }
export function configureSettingsPanel(a) { actions = { ...actions, ...a }; }

const QUALITY_OPTIONS = [
  { value: "best", label: "Source (best)" },
  { value: "1080p60,1080p,best", label: "1080p" },
  { value: "720p60,720p,best", label: "720p" },
  { value: "480p,best", label: "480p" },
  { value: "360p,best", label: "360p" },
  { value: "audio_only", label: "Audio only" },
];

// sections -> rows. kinds: toggle, segmented, select, text, range, action, preview, info, group
const HOUR_OPTIONS = Array.from({ length: 24 }, (_, h) => ({ value: h, label: new Date(2000, 0, 1, h).toLocaleTimeString([], { hour: "numeric" }) }));
const SECTIONS = [
  { id: "chat", label: "Chat", icon: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>', rows: [
    { kind: "preview" },
    { kind: "segmented", id: "chatFontSize", title: "Text size", desc: "Size of chat messages. Auto is 13px, 15px on large windows.",
      options: [{ value: "auto", label: "Auto" }, ...[12, 13, 14, 16, 18].map((v) => ({ value: v, label: String(v) }))] },
    { kind: "segmented", id: "emoteScale", title: "Emote size", desc: "Emotes scale with the text size, then by this.",
      options: [{ value: 0.8, label: "Small" }, { value: 1, label: "Normal" }, { value: 1.3, label: "Large" }, { value: 1.6, label: "Huge" }] },
    { kind: "toggle", id: "showTimestamps", title: "Show timestamps", desc: "The time each message arrived, before the name." },
    { kind: "toggle", id: "zebraLines", title: "Alternating backgrounds", desc: "Subtle stripes between messages, easier to follow in fast chats." },
    { kind: "segmented", id: "usernameColors", title: "Username colors", desc: "Everyone's chosen color, or a calmer single color.",
      options: [{ value: "color", label: "Colorful" }, { value: "neutral", label: "Neutral" }] },
    { kind: "group", title: "Highlights" },
    { kind: "toggle", id: "highlightMentions", title: "Highlight my name", desc: "Messages that mention you stand out." },
    { kind: "text", id: "highlightKeywords", title: "Highlight keywords", desc: "Also highlight these words (comma-separated).", placeholder: "e.g. drops, giveaway" },
    { kind: "toggle", id: "highlightSound", title: "Sound on highlight", desc: "A soft chime when a highlighted message arrives." },
    { kind: "toggle", id: "firstChatterGlow", title: "First-time chatter glow", desc: "A soft glow on someone's first message in the channel." },
    { kind: "toggle", id: "highlightedGlow", title: "Highlighted message glow", desc: "The glow on messages highlighted with channel points." },
    { kind: "group", title: "Behavior" },
    { kind: "toggle", id: "pauseOnHover", title: "Pause chat on hover", desc: "Freeze scrolling while your mouse is over chat, like Twitch." },
    { kind: "segmented", id: "deletedMessages", title: "Deleted messages", desc: "Dimmed and struck through, or removed completely.",
      options: [{ value: "dim", label: "Dim" }, { value: "hide", label: "Hide" }] },
    { kind: "select", id: "chatHistory", title: "Chat history", desc: "How many messages chat keeps.",
      options: [100, 250, 500, 1000].map((v) => ({ value: v, label: `${v} messages` })) },
    { kind: "toggle", id: "asciiArt", title: "ASCII art", desc: "Fit chat art (Braille and block pictures) so it doesn't scramble." },
    { kind: "group", title: "Badges" },
    { kind: "toggle", id: "showBadges", title: "Show badges", desc: "Badges next to names." },
    { kind: "toggle", id: "hideBitsBadges", title: "Hide Bits badges", desc: "Cheer / Bits badges." },
    { kind: "toggle", id: "hidePredictionBadges", title: "Hide prediction badges", desc: "The blue/pink badges shown during predictions." },
    { kind: "group", title: "Emotes" },
    { kind: "toggle", id: "emotes7tv", title: "7TV emotes", desc: "Applies the next time you open a channel." },
    { kind: "toggle", id: "emotesBttv", title: "BetterTTV emotes", desc: "Applies the next time you open a channel." },
    { kind: "toggle", id: "emotesFfz", title: "FrankerFaceZ emotes", desc: "Applies the next time you open a channel." },
    { kind: "toggle", id: "sevenTvPaints", title: "7TV name paints", desc: "Gradient and image colors on usernames. Applies to new messages." },
    { kind: "toggle", id: "emoteColonTrigger", title: "\":\" opens emote suggestions", desc: "Type :name to see matching emotes. Tab always works." },
    { kind: "group", title: "In chat" },
    { kind: "toggle", id: "clipCards", title: "Clip cards", desc: "Twitch clip links become cards you can play right in Mosaic." },
    { kind: "toggle", id: "linkPreviews", title: "Link previews", desc: "Show a preview when you hover a link." },
    { kind: "toggle", id: "predictionsPolls", title: "Predictions & polls", desc: "Show them above chat, with betting and voting." },
    { kind: "toggle", id: "hypeGiftBanners", title: "Hype train & gift banners", desc: "Banners for hype trains and big gift-sub drops." },
    { kind: "toggle", id: "pinnedBanner", title: "Pinned messages", desc: "Show a channel's pinned message above chat." },
    { kind: "group", title: "Filters" },
    { kind: "action", title: "Chat filter", desc: "Hide messages by word, user or emote.", button: "Edit filter…", run: () => { closeSettingsPanel(); actions.openChatFilter?.(); } },
    { kind: "action", title: "Hidden channels", desc: "Channels you've hidden from Home, Browse and the sidebar.", button: "Manage…", run: () => { closeSettingsPanel(); actions.openHiddenChannels?.(); } },
  ]},
  { id: "player", label: "Player", icon: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m10 9 5 3-5 3z"/>', rows: [
    { kind: "select", id: "defaultQuality", title: "Default quality", desc: "Quality new streams and VODs start at. Falls back to the best available when a stream doesn't offer it.", options: QUALITY_OPTIONS },
    { kind: "range", id: "defaultVolume", title: "Default volume", desc: "For channels you haven't set a volume on.", min: 0, max: 100, step: 5, unit: "%" },
    { kind: "toggle", id: "rememberVolume", title: "Remember volume per channel", desc: "Each channel starts at the volume you last used for it." },
    { kind: "toggle", id: "lowLatency", title: "Low latency", desc: "Closer to live, with more rebuffering on shaky connections. Applies to the next stream." },
    { kind: "toggle", id: "catchUpToLive", title: "Catch up to live", desc: "Play slightly faster (up to 1.2x) when you fall a few seconds behind." },
    { kind: "toggle", id: "autoTheater", title: "Auto theater mode", desc: "Collapse the sidebar when a stream starts, for a wider video." },
    { kind: "toggle", id: "miniPlayer", title: "Mini player", desc: "Keep the stream in a small corner player when you go to Home or Browse." },
    { kind: "toggle", id: "autoPipOnBlur", title: "Pop out when switching apps", desc: "Move the stream to a floating window when Mosaic loses focus." },
    { kind: "toggle", id: "streamInfoOverlay", title: "Stream info on hover", desc: "The channel, title and viewers over the video when you hover it." },
    { kind: "segmented", id: "followRaids", title: "Follow raids", desc: "When the channel you're watching raids someone. Automatically shows a 5-second countdown you can cancel.",
      options: [{ value: "auto", label: "Automatically" }, { value: "ask", label: "Ask me" }, { value: "off", label: "Off" }] },
    { kind: "group", title: "VODs" },
    { kind: "segmented", id: "vodSpeed", title: "Playback speed", desc: "Speed VODs play at, remembered between VODs. The speed button in the player and the < / > keys change it too.",
      options: [0.75, 1, 1.25, 1.5, 1.75, 2].map((v) => ({ value: v, label: v === 1 ? "1×" : `${v}×` })) },
    { kind: "segmented", id: "seekStep", title: "Arrow-key seek", desc: "How far the arrow keys jump. Shift doubles it.",
      options: [5, 10, 30].map((v) => ({ value: v, label: `${v}s` })) },
    { kind: "toggle", id: "vodHeatmap", title: "Chat heatmap", desc: "Chat activity drawn above the VOD seek bar." },
    { kind: "toggle", id: "vodTopClips", title: "Top clips", desc: "Markers and a list of the VOD's most-viewed clips." },
    { kind: "toggle", id: "mutedSegments", title: "Muted-segment markers", desc: "Where the VOD's audio was muted for copyright." },
    { kind: "toggle", id: "seekThumbnails", title: "Seek thumbnails", desc: "Preview images when you hover the VOD seek bar." },
  ]},
  { id: "notifications", label: "Notifications", icon: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>', rows: [
    { kind: "toggle", id: "notifyGoLive", title: "Go-live notifications", desc: "When a channel you turned the bell on for goes live." },
    { kind: "toggle", id: "notifyCategory", title: "Category notifications", desc: "When a channel switches to a category you asked about." },
    { kind: "toggle", id: "notifyWhispers", title: "Whisper notifications", desc: "When a whisper arrives while Mosaic isn't the focused window." },
    { kind: "toggle", id: "notifySound", title: "Notification sound", desc: "Play Mosaic's chime with notifications." },
    { kind: "group", title: "Quiet hours" },
    { kind: "toggle", id: "quietHours", title: "Quiet hours", desc: "No notifications between the times below." },
    { kind: "select", id: "quietStart", title: "From", desc: "", options: HOUR_OPTIONS },
    { kind: "select", id: "quietEnd", title: "Until", desc: "", options: HOUR_OPTIONS },
  ]},
  { id: "sidebar", label: "Sidebar", icon: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/>', rows: [
    { kind: "segmented", id: "liveChannelsCount", title: "Live Channels count", desc: "How many recommended live channels to list.",
      options: [{ value: 5, label: "5" }, { value: 10, label: "10" }, { value: 15, label: "15" }, { value: 20, label: "20" }, { value: 0, label: "All" }] },
    { kind: "toggle", id: "showOfflineFollowed", title: "Show offline channels", desc: "List followed channels that aren't live." },
    { kind: "segmented", id: "followedSort", title: "Sort followed channels", desc: "Live channels always come first.",
      options: [{ value: "viewers", label: "By viewers" }, { value: "name", label: "By name" }] },
    { kind: "toggle", id: "hoverPreviews", title: "Hover previews", desc: "A live preview card when you hover a channel." },
    { kind: "segmented", id: "hoverPreviewDelay", title: "Preview delay", desc: "How long to hover before the card appears.",
      options: [{ value: 150, label: "Fast" }, { value: 350, label: "Normal" }, { value: 700, label: "Slow" }] },
    { kind: "toggle", id: "hypeGlow", title: "Hype train glow", desc: "Channels with a hype train glow in the list." },
  ]},
  { id: "home", label: "Home & MultiView", icon: '<path d="m3 11 9-8 9 8"/><path d="M5 10v10h14V10"/>', rows: [
    { kind: "toggle", id: "homeLauncher", title: "MultiView launcher", desc: "When favorites or notified channels are live, show them at the top of Home ready to watch together. Off: always the top-streams carousel." },
    { kind: "toggle", id: "homeContinueRow", title: "Continue where you left off", desc: "The row of VODs you were partway through." },
    { kind: "toggle", id: "homeRecommendedRow", title: "Live channels we think you'll like", desc: "The recommended streams row." },
    { kind: "group", title: "MultiView" },
    { kind: "segmented", id: "multiviewLayout", title: "Default layout", desc: "Focus puts one stream big once there are 3 or more. The Home launcher uses its own choice.",
      options: [{ value: "spotlight", label: "Focus" }, { value: "grid", label: "Grid" }] },
    { kind: "segmented", id: "multiviewSound", title: "Sound when opening", desc: "Which stream you hear when MultiView opens.",
      options: [{ value: "first", label: "First stream" }, { value: "muted", label: "All muted" }] },
  ]},
  { id: "twitch", label: "Twitch account", icon: '<path d="M4 3h16v11l-4 4h-4l-3 3H7v-3H4z"/><path d="M11 7v5M16 7v5"/>', rows: [
    { kind: "action", title: "Twitch connection", desc: "The extra Twitch login used for pinned messages, predictions, polls, badges, following and drops.", button: "Manage…", run: () => { closeSettingsPanel(); actions.openTwitchConnection?.(); } },
    { kind: "toggle", id: "autoClaimDrops", title: "Auto-claim drops", desc: "Claim Twitch Drops as soon as they're ready." },
  ]},
  { id: "app", label: "App", icon: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M3 9h18"/>', rows: [
    { kind: "toggle", id: "autostart", title: "Start with your computer", desc: "Open Mosaic when you sign in." },
    { kind: "toggle", id: "startMinimized", title: "Start minimized", desc: "When Mosaic starts with your computer, go straight to the tray." },
    { kind: "toggle", id: "closeToTray", title: "Minimize to tray on close", desc: "Closing the window keeps Mosaic running in the system tray." },
    { kind: "segmented", id: "uiZoom", title: "Interface zoom", desc: "Scale the whole app, for small or high-resolution screens.",
      options: [0.9, 1, 1.1, 1.25].map((v) => ({ value: v, label: `${Math.round(v * 100)}%` })) },
    { kind: "toggle", id: "reduceMotion", title: "Reduce motion", desc: "Turn off animations and glows." },
    { kind: "toggle", id: "autoUpdateCheck", title: "Check for updates automatically", desc: "At startup and every 15 minutes." },
    { kind: "action", title: "Check for updates", desc: "", button: "Check now", run: async () => actions.checkForUpdatesNow?.() },
    { kind: "group", title: "Backup" },
    { kind: "action", title: "Back up settings", desc: "Save your settings, favorites, hidden channels, filters, bells and notes to a file in Downloads.", button: "Back up",
      run: async () => { const path = await actions.exportBackup?.(); return path ? `Saved to ${path}` : "Couldn't save"; } },
    { kind: "action", title: "Restore from a backup", desc: "Load a Mosaic backup file. Mosaic reloads to apply it.", button: "Restore…", run: () => pickBackupFile() },
    { kind: "group", title: "Data" },
    { kind: "action", title: "Track ID history", desc: "Songs you've identified.", button: "Clear", danger: true, confirm: true,
      run: () => { try { localStorage.removeItem("trackIdHistory"); } catch { /* ignore */ } return "Cleared"; } },
    { kind: "action", title: "VOD heatmap cache", desc: "Saved chat heatmaps, rebuilt the next time you open a VOD.", button: "Clear", danger: true, confirm: true,
      run: () => { try { localStorage.removeItem("vodHeatmapCache"); } catch { /* ignore */ } return "Cleared"; } },
    { kind: "action", title: "Reset all settings", desc: "Put every setting on this page back to its default.", button: "Reset", danger: true, confirm: true,
      run: () => { resetSettings(); return "Reset"; } },
    { kind: "info", id: "version" },
  ]},
];

// Restore: pick a .json with the webview's own file picker, restore it, then reload so everything applies
function pickBackupFile() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".json,application/json";
  input.addEventListener("change", async () => {
    const file = input.files && input.files[0];
    if (!file) return;
    try {
      const msg = await actions.importBackup?.(await file.text());
      showToast(`${msg} Reloading…`);
      setTimeout(() => location.reload(), 1400);
    } catch (err) {
      showToast(err && err.message ? err.message : "Couldn't restore that file.", true);
    }
  });
  input.click();
  return null;
}

function showToast(text, isError = false) {
  if (!panelEl) return;
  panelEl.querySelector(".settings-toast")?.remove();
  const t = el("div", "settings-toast" + (isError ? " error" : ""), text);
  panelEl.querySelector(".settings-main").appendChild(t);
  setTimeout(() => t.remove(), 4500);
}

const ICON = (d, size = 16) =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

let panelEl = null;
let unsubscribe = null;
let current = "chat";
let query = "";

// every setting, for the command palette: [{ title, desc, section, sectionLabel }]
export function getSettingsIndex() {
  const out = [];
  for (const sec of SECTIONS) {
    for (const r of sec.rows) {
      if (r.title && r.kind !== "group") out.push({ title: r.title, desc: r.desc || "", section: sec.id, sectionLabel: sec.label });
    }
  }
  return out;
}

// section: which section to show. focusTitle: scroll to that setting and briefly highlight it
export function openSettingsPanel(section, focusTitle) {
  if (panelEl) {
    if (section) { current = section; query = ""; render(); }
    if (focusTitle) focusRow(focusTitle);
    return;
  }
  if (section) current = section;
  query = "";
  panelEl = el("div", "settings-backdrop");
  panelEl.innerHTML =
    '<div class="settings-panel" role="dialog" aria-modal="true" aria-label="Settings">' +
      '<aside class="settings-nav"><div class="settings-nav-title">Settings</div>' +
      '<div class="settings-search"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>' +
      '<input type="text" placeholder="Search settings" spellcheck="false"></div><nav class="settings-nav-list"></nav></aside>' +
      '<main class="settings-main"><div class="settings-main-head"><h2 class="settings-main-title"></h2>' +
      '<button type="button" class="settings-close" title="Close (Esc)" aria-label="Close">' + ICON('<path d="M18 6 6 18M6 6l12 12"/>') + '</button></div>' +
      '<div class="settings-rows"></div></main>' +
    "</div>";
  document.body.appendChild(panelEl);
  panelEl.addEventListener("mousedown", (e) => { if (e.target === panelEl) closeSettingsPanel(); });
  panelEl.querySelector(".settings-close").addEventListener("click", closeSettingsPanel);
  const search = panelEl.querySelector(".settings-search input");
  search.addEventListener("input", () => { query = search.value.trim().toLowerCase(); render(); });
  document.addEventListener("keydown", onKey, true);
  // keep controls in sync with changes made elsewhere (e.g. the player's quality-menu toggles)
  unsubscribe = onSettingChange(() => refreshValues());
  render();
  if (focusTitle) focusRow(focusTitle);
  else setTimeout(() => search.focus(), 30);
}

function focusRow(title) {
  const row = [...panelEl.querySelectorAll(".settings-row")].find((r) => r.querySelector(".settings-row-title")?.textContent === title);
  if (!row) return;
  row.scrollIntoView?.({ block: "center" });
  row.classList.remove("flash");
  void row.offsetWidth; // restart the animation
  row.classList.add("flash");
}

export function closeSettingsPanel() {
  if (!panelEl) return;
  panelEl.remove();
  panelEl = null;
  document.removeEventListener("keydown", onKey, true);
  unsubscribe?.();
  unsubscribe = null;
  closeSelectMenu();
}

function onKey(e) {
  if (e.key !== "Escape") return;
  e.stopPropagation();
  if (document.querySelector(".settings-select-menu")) closeSelectMenu();
  else closeSettingsPanel();
}

function matches(row) {
  if (!query) return true;
  return `${row.title || ""} ${row.desc || ""}`.toLowerCase().includes(query);
}

function render() {
  if (!panelEl) return;
  // nav
  const nav = panelEl.querySelector(".settings-nav-list");
  nav.replaceChildren();
  for (const sec of SECTIONS) {
    const hits = sec.rows.filter((r) => r.title && matches(r)).length;
    const b = el("button", "settings-nav-item" + (!query && sec.id === current ? " active" : "") + (query && !hits ? " dim" : ""));
    b.type = "button";
    b.innerHTML = ICON(sec.icon);
    b.appendChild(el("span", null, sec.label));
    if (query && hits) b.appendChild(el("span", "settings-nav-count", String(hits)));
    b.addEventListener("click", () => {
      current = sec.id; query = "";
      panelEl.querySelector(".settings-search input").value = "";
      render();
    });
    nav.appendChild(b);
  }
  // rows: one section, or every match across sections while searching
  const title = panelEl.querySelector(".settings-main-title");
  const rows = panelEl.querySelector(".settings-rows");
  rows.replaceChildren();
  if (query) {
    title.textContent = "Search results";
    let any = false;
    for (const sec of SECTIONS) {
      const hits = sec.rows.filter((r) => r.title && matches(r));
      if (!hits.length) continue;
      any = true;
      rows.appendChild(el("div", "settings-group", sec.label));
      for (const r of hits) rows.appendChild(buildRow(r));
    }
    if (!any) rows.appendChild(el("div", "settings-empty", `No settings match "${query}"`));
  } else {
    const sec = SECTIONS.find((s) => s.id === current) || SECTIONS[0];
    title.textContent = sec.label;
    for (const r of sec.rows) rows.appendChild(buildRow(r));
  }
  refreshValues();
}

function buildRow(r) {
  if (r.kind === "group") return el("div", "settings-group", r.title);
  if (r.kind === "preview") return buildPreview();
  if (r.kind === "info") {
    const v = el("div", "settings-version", "Mosaic");
    getVersion().then((ver) => { v.textContent = `Mosaic v${ver}`; }).catch(() => {});
    return v;
  }
  const row = el("div", "settings-row");
  const text = el("div", "settings-row-text");
  text.append(el("div", "settings-row-title", r.title));
  if (r.desc) text.append(el("div", "settings-row-desc", r.desc));
  row.appendChild(text);
  const ctl = el("div", "settings-row-control");
  row.appendChild(ctl);

  if (r.kind === "toggle") {
    const sw = el("button", "settings-switch");
    sw.type = "button";
    sw.setAttribute("role", "switch");
    sw.dataset.setting = r.id;
    sw.appendChild(el("span", "settings-switch-knob"));
    sw.addEventListener("click", () => setSetting(r.id, !getSetting(r.id)));
    ctl.appendChild(sw);
    row.classList.add("clickable");
    text.addEventListener("click", () => sw.click());
  } else if (r.kind === "segmented") {
    const seg = el("div", "settings-segmented");
    seg.dataset.setting = r.id;
    for (const o of r.options) {
      const b = el("button", "settings-seg-btn", o.label);
      b.type = "button";
      b.dataset.value = String(o.value);
      b.addEventListener("click", () => setSetting(r.id, o.value));
      seg.appendChild(b);
    }
    ctl.appendChild(seg);
  } else if (r.kind === "select") {
    const b = el("button", "settings-select");
    b.type = "button";
    b.dataset.setting = r.id;
    b.append(el("span", "settings-select-label"));
    const chev = el("span", "settings-select-chev");
    chev.innerHTML = ICON('<path d="m6 9 6 6 6-6"/>', 14);
    b.append(chev);
    b.addEventListener("click", (e) => { e.stopPropagation(); toggleSelectMenu(b, r); });
    ctl.appendChild(b);
  } else if (r.kind === "text") {
    const input = el("input", "settings-text");
    input.type = "text";
    input.placeholder = r.placeholder || "";
    input.value = String(getSetting(r.id) || "");
    input.dataset.setting = r.id;
    input.addEventListener("input", () => setSetting(r.id, input.value)); // saves as you type
    ctl.appendChild(input);
    row.classList.add("wide-control");
  } else if (r.kind === "range") {
    const wrap = el("div", "settings-range");
    const input = el("input");
    input.type = "range"; input.min = String(r.min); input.max = String(r.max); input.step = String(r.step || 1);
    input.dataset.setting = r.id;
    const val = el("span", "settings-range-value");
    input.addEventListener("input", () => { setSetting(r.id, Number(input.value)); });
    wrap.append(input, val);
    ctl.appendChild(wrap);
    wrap.dataset.unit = r.unit || "";
  } else if (r.kind === "action") {
    const b = el("button", "settings-action" + (r.danger ? " danger" : ""), r.button);
    b.type = "button";
    let armed = false, timer = null;
    b.addEventListener("click", () => {
      // destructive actions ask once: the first click turns the button into "Sure?"
      if (r.confirm && !armed) {
        armed = true;
        b.textContent = "Sure?";
        b.classList.add("armed");
        timer = setTimeout(() => { armed = false; b.textContent = r.button; b.classList.remove("armed"); }, 3000);
        return;
      }
      clearTimeout(timer);
      armed = false;
      b.classList.remove("armed");
      const out = r.run?.();
      const finish = (done) => {
        if (typeof done !== "string") { b.disabled = false; b.textContent = r.button; return; }
        // long results (a saved file's path) go in a toast; short ones on the button
        if (done.length > 24) { showToast(done); b.textContent = r.button; b.disabled = false; return; }
        b.textContent = `${done} ✓`;
        setTimeout(() => { b.textContent = r.button; b.disabled = false; }, 1800);
      };
      if (out && typeof out.then === "function") {
        b.disabled = true;
        b.textContent = "Working…";
        out.then(finish, (err) => { finish(null); showToast(typeof err === "string" ? err : err?.message || "Something went wrong", true); });
      } else if (typeof out === "string") {
        b.disabled = true;
        finish(out);
      }
    });
    ctl.appendChild(b);
  }
  return row;
}

// live preview for the Chat section: a sample line using the real chat styles
function buildPreview() {
  const wrap = el("div", "settings-chat-preview");
  wrap.innerHTML =
    '<div class="settings-chat-preview-label">Preview</div>' +
    '<div class="settings-chat-preview-body chat-body">' +
      '<div class="chat-line"><span class="chat-ts">9:41 PM</span><span class="chat-username" style="color:#ff7a59">viewer1:</span> ' +
      '<span class="chat-text">that play was insane <span class="settings-fake-emote chat-emote"></span> clip it</span></div>' +
      '<div class="chat-line"><span class="chat-ts">9:41 PM</span><span class="chat-username" style="color:#7aa2ff">modguy:</span> ' +
      '<span class="chat-text">GG <span class="settings-fake-emote chat-emote alt"></span></span></div>' +
    "</div>";
  return wrap;
}

// reflect current values onto every control on screen
function refreshValues() {
  if (!panelEl) return;
  panelEl.querySelectorAll(".settings-switch").forEach((sw) => {
    const on = !!getSetting(sw.dataset.setting);
    sw.classList.toggle("on", on);
    sw.setAttribute("aria-checked", String(on));
  });
  panelEl.querySelectorAll(".settings-segmented").forEach((seg) => {
    const v = String(getSetting(seg.dataset.setting));
    seg.querySelectorAll(".settings-seg-btn").forEach((b) => b.classList.toggle("on", b.dataset.value === v));
  });
  panelEl.querySelectorAll(".settings-range input").forEach((input) => {
    const v = getSetting(input.dataset.setting);
    if (document.activeElement !== input) input.value = String(v);
    const label = input.parentElement.querySelector(".settings-range-value");
    if (label) label.textContent = `${v}${input.parentElement.dataset.unit || ""}`;
  });
  panelEl.querySelectorAll(".settings-text").forEach((input) => {
    if (document.activeElement !== input) input.value = String(getSetting(input.dataset.setting) || "");
  });
  panelEl.querySelectorAll(".settings-select").forEach((b) => {
    const r = findRow(b.dataset.setting);
    const v = getSetting(b.dataset.setting);
    const opt = r && r.options.find((o) => o.value === v);
    b.querySelector(".settings-select-label").textContent = opt ? opt.label : String(v);
  });
}

function findRow(id) {
  for (const s of SECTIONS) for (const r of s.rows) if (r.id === id) return r;
  return null;
}

// themed dropdown for "select" rows
function toggleSelectMenu(btn, r) {
  if (document.querySelector(".settings-select-menu")) { closeSelectMenu(); return; }
  const menu = el("div", "settings-select-menu");
  const cur = getSetting(r.id);
  for (const o of r.options) {
    const item = el("button", "settings-select-item" + (o.value === cur ? " on" : ""), o.label);
    item.type = "button";
    item.addEventListener("click", () => { setSetting(r.id, o.value); closeSelectMenu(); });
    menu.appendChild(item);
  }
  document.body.appendChild(menu);
  const rect = btn.getBoundingClientRect();
  menu.style.minWidth = `${rect.width}px`;
  const h = menu.offsetHeight;
  menu.style.left = `${Math.min(rect.left, window.innerWidth - menu.offsetWidth - 8)}px`;
  menu.style.top = `${rect.bottom + 4 + h > window.innerHeight - 8 ? rect.top - h - 4 : rect.bottom + 4}px`;
  setTimeout(() => document.addEventListener("mousedown", onSelectOutside, true), 0);
}
function onSelectOutside(e) {
  const m = document.querySelector(".settings-select-menu");
  if (m && !m.contains(e.target)) closeSelectMenu();
}
function closeSelectMenu() {
  document.querySelector(".settings-select-menu")?.remove();
  document.removeEventListener("mousedown", onSelectOutside, true);
}
