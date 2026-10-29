// The Settings panel: every app setting in one place, grouped into sections with search. Values live in
// settings.js; changes save instantly (no Save button) and apply live where possible. main.js supplies the
// launchers for the editors that already exist (chat filter, hidden channels, Twitch connection).

import { getVersion } from "@tauri-apps/api/app";
import { getSetting, setSetting, onSettingChange, resetSettings, playChime } from "./settings.js";
import { pushEscape } from "./escape-stack.js";
import { isAndroid } from "./mobile.js";
import { closeCommandPalette } from "./command-palette.js";
import { THEME_PRESETS, THEME_PARTS, presetById, isHex, CUSTOM_PARTS } from "./themes.js";
import { configureCustomize, startPicking, openEditor, changedParts, resetPart, customParts } from "./customize.js";
import { exportThemeCode, importThemeCode, savedLooks, saveLook, deleteLook, useLook, isCurrentLook } from "./theme-share.js";

let popEscape = null;       // this panel's entry on the shared Escape stack
let selectOwner = null;      // the button whose dropdown is open
let popSelectEscape = null; // the open dropdown's entry (Escape closes the dropdown before the panel)

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

// sections -> rows. kinds: toggle, segmented, select, text, range, action, preview, info, group, themes
// (the preset picker), accent, color (one themeColors part), changes (customized parts), code (custom CSS),
// import (a theme code), allparts (every customizable part, searchable), looks (saved looks)
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
    { kind: "toggle", id: "chatSpellcheck", title: "Spell check", desc: "Underline misspelled words while you type a message. Right-click an underlined word for suggestions." },
    { kind: "group", title: "Overlay" },
    { kind: "toggle", id: "chatOverlay", title: "Chat overlay", desc: "In theater mode and fullscreen, show chat over the video instead of beside it." },
    { kind: "toggle", id: "chatOverlayInput", title: "Type in the overlay", desc: "The chat box moves into the overlay, with the emote button and emote suggestions. Press Enter to jump into it, Escape to leave it." },
    { kind: "action", title: "Overlay position", desc: "Drag the overlay's handle to move it and its corner to resize. This puts it back on the right.", button: "Reset",
      run: () => { setSetting("chatOverlayRect", null); return "Reset"; } },
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
    { kind: "toggle", id: "emoteHoverCard", title: "Emote cards on hover", desc: "Hovering an emote shows a bigger preview, where it's from and who made it." },
    { kind: "toggle", id: "sevenTvPaints", title: "7TV name paints", desc: "Gradient and image colors on usernames. Applies to new messages." },
    { kind: "toggle", id: "sevenTvPaintsAnimate", title: "Animate name paints", desc: "The paints' colors slowly flow. Uses noticeably more CPU in busy chats." },
    { kind: "toggle", id: "emoteColonTrigger", title: "\":\" opens emote suggestions", desc: "Type :name to see matching emotes. Tab always works." },
    { kind: "group", title: "In chat" },
    { kind: "toggle", id: "clipCards", title: "Clip cards", desc: "Twitch clip links become cards you can play right in Mosaic." },
    { kind: "toggle", id: "linkPreviews", title: "Link previews", desc: "Show a preview when you hover a link. The preview loads from the link's site, which can see your IP address." },
    { kind: "toggle", id: "predictionsPolls", title: "Predictions & polls", desc: "Show them above chat, with betting and voting." },
    { kind: "toggle", id: "hypeGiftBanners", title: "Hype train & gift banners", desc: "Banners for hype trains and big gift-sub drops. Click the hype train banner for details." },
    { kind: "toggle", id: "hypeTrainCelebrate", title: "Hype train level-up celebration", desc: "A big \"LEVEL N!\" with confetti over the video when the train levels up. Toned down with Reduce motion." },
    { kind: "toggle", id: "hypeTrainSound", title: "Hype train level-up sound", desc: "Play the chime when the train levels up." },
    { kind: "toggle", id: "pinnedBanner", title: "Pinned messages", desc: "Show a channel's pinned message above chat." },
    { kind: "group", title: "Filters" },
    { kind: "action", title: "Chat filter", desc: "Hide messages by word, user or emote.", button: "Edit filter…", run: () => { closeSettingsPanel(); actions.openChatFilter?.(); } },
    { kind: "action", title: "Hidden channels", desc: "Channels you've hidden from Home, Browse and the sidebar.", button: "Manage…", run: () => { closeSettingsPanel(); actions.openHiddenChannels?.(); } },
  ]},
  { id: "player", label: "Player", icon: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m10 9 5 3-5 3z"/>', rows: [
    { kind: "select", id: "defaultQuality", title: "Default quality", desc: "Quality new streams and VODs start at. Falls back to the best available when a stream doesn't offer it.", options: QUALITY_OPTIONS },
    { kind: "range", id: "defaultVolume", title: "Default volume", desc: "For channels you haven't set a volume on.", min: 0, max: 100, step: 5, unit: "%" },
    { kind: "toggle", id: "rememberVolume", title: "Remember volume per channel", desc: "Each channel starts at the volume you last used for it." },
    { kind: "toggle", id: "audioNormalize", title: "Normalize volume", desc: "Evens out loud and quiet moments: screams are turned down, quiet talking is turned up." },
    { kind: "segmented", id: "audioNormalizeStrength", title: "Normalization strength", desc: "Light keeps more of the original dynamics; Strong evens things out the most.",
      options: [{ value: "light", label: "Light" }, { value: "balanced", label: "Balanced" }, { value: "strong", label: "Strong" }] },
    { kind: "select", id: "liveRewindSecs", title: "Live rewind", desc: "How far back you can rewind a live stream instantly. Each minute of 1080p is about 45 MB of memory. Applies to the next stream.",
      options: [{ value: 30, label: "30 seconds" }, { value: 60, label: "1 minute" }, { value: 120, label: "2 minutes" }] },
    { kind: "toggle", id: "lowLatency", title: "Low latency", desc: "Closer to live, with more rebuffering on shaky connections. Applies to the next stream." },
    { kind: "toggle", id: "preloadFavorites", title: "Preload favorites", desc: "Keep your live favorites loading in the background so they start instantly when you open them. Each one uses about as much data as watching it." },
    { kind: "segmented", id: "preloadCount", title: "How many to preload", desc: "Live favorites loading at once, besides the one you're watching.",
      options: [{ value: 1, label: "1" }, { value: 2, label: "2" }, { value: 3, label: "3" }, { value: 4, label: "4" }] },
    { kind: "action", title: "Channels to preload", desc: "Pick which favorites to preload. With none picked, any live favorite can be.", button: "Choose…", run: () => { closeSettingsPanel(); actions.openPreloadPicker?.(); } },
    { kind: "toggle", id: "catchUpToLive", title: "Catch up to live", desc: "Play slightly faster (up to 1.2x) when you fall a few seconds behind." },
    { kind: "toggle", id: "autoTheater", title: "Auto theater mode", desc: "Collapse the sidebar when a stream starts, for a wider video." },
    { kind: "toggle", id: "miniPlayer", title: "Mini player", desc: "Keep the stream in a small corner player when you go to Home or Browse." },
    { kind: "toggle", id: "autoPipOnBlur", title: "Pop out when switching apps", desc: "Move the stream to a floating window when Mosaic loses focus." },
    { kind: "segmented", id: "lurkMode", title: "Lurk mode", desc: "While Mosaic is minimized or closed to the tray, keep a Twitch stream going as audio only, so channel points, drops and watch streaks keep counting with far less work for your computer. Muted turns the sound off too. The picture and sound come back when you open Mosaic.",
      options: [{ value: "off", label: "Off" }, { value: "audio", label: "Audio only" }, { value: "muted", label: "Muted" }] },
    { kind: "toggle", id: "streamInfoOverlay", title: "Stream info on hover", desc: "The channel, title and viewers over the video when you hover it." },
    { kind: "segmented", id: "ambientGlow", title: "Ambient glow", desc: "A soft glow in the space around the video that follows the stream's colors.",
      options: [{ value: "off", label: "Off" }, { value: "subtle", label: "Subtle" }, { value: "normal", label: "Normal" }, { value: "strong", label: "Strong" }] },
    { kind: "toggle", id: "richGlow", title: "Animated glows", desc: "Hype train glows pulse and the live dot breathes, and Ambient glow uses its softest, most detailed version. Looks richer, but uses noticeably more CPU and graphics while you watch." },
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
    { kind: "segmented", id: "skipMutedSegments", title: "Muted sections", desc: "When a VOD reaches a part whose audio was muted for copyright: play it, ask with a Skip button on the player, or skip it. Clicking into one on the seek bar always plays it. Needs the Twitch login.",
      options: [{ value: "off", label: "Play" }, { value: "ask", label: "Ask" }, { value: "auto", label: "Skip" }] },
    { kind: "toggle", id: "seekThumbnails", title: "Seek thumbnails", desc: "Preview images when you hover the VOD seek bar." },
  ]},
  { id: "notifications", label: "Notifications", icon: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>', rows: [
    { kind: "toggle", id: "notifyGoLive", title: "Go-live notifications", desc: "When a channel you turned the bell on for goes live." },
    { kind: "toggle", id: "notifyCategory", title: "Category notifications", desc: "When a channel switches to a category you asked about." },
    { kind: "toggle", id: "notifyWhispers", title: "Whisper notifications", desc: "When a whisper arrives while Mosaic isn't the focused window." },
    { kind: "toggle", id: "hypeTrainNotify", title: "Hype train notifications", desc: "When a channel you follow starts a hype train." },
    { kind: "toggle", id: "notifySubExpiry", title: "Subscription ending reminders", desc: "Before a Twitch subscription that won't renew runs out (gifted, Prime or canceled). Needs the Twitch device login." },
    { kind: "select", id: "subExpiryDays", title: "Remind me", desc: "How far ahead. A second reminder comes on the last day.",
      options: [1, 3, 7, 14].map((v) => ({ value: v, label: v === 1 ? "1 day before" : `${v} days before` })) },
    { kind: "toggle", id: "subEndingNotice", title: "Show it on the channel", desc: "Watching a channel whose subscription ends within 3 days and won't renew: the Subscribed button says how long is left, and a line in chat when you open it." },
    { kind: "toggle", id: "notifySound", title: "Notification sound", desc: "Play Mosaic's chime with notifications." },
    { kind: "range", id: "notifyVolume", title: "Sound volume", desc: "How loud the chime is, for notifications and the chat highlight sound.",
      min: 0, max: 200, step: 5, unit: "%", preview: () => playChime({ preview: true }) },
    { kind: "group", title: "Quiet hours" },
    { kind: "toggle", id: "quietHours", title: "Quiet hours", desc: "No notifications or chat mention chimes between the times below." },
    { kind: "select", id: "quietStart", title: "From", desc: "", options: HOUR_OPTIONS },
    { kind: "select", id: "quietEnd", title: "Until", desc: "", options: HOUR_OPTIONS },
  ]},
  { id: "sidebar", label: "Sidebar", icon: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/>', rows: [
    { kind: "segmented", id: "liveChannelsCount", title: "Live Channels count", desc: "How many recommended live channels to list.",
      options: [{ value: 5, label: "5" }, { value: 10, label: "10" }, { value: 15, label: "15" }, { value: 20, label: "20" }, { value: 0, label: "All" }] },
    { kind: "toggle", id: "showOfflineFollowed", title: "Show offline channels", desc: "List followed channels that aren't live." },
    { kind: "segmented", id: "favoritesOrder", title: "Favorites order", desc: "Drag a favorite in the sidebar (or press Alt+Up / Alt+Down on it) to put them in your own order. Your order also decides which favorites MultiView and preloading pick first.",
      options: [{ value: "live", label: "Live first" }, { value: "custom", label: "My order" }] },
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
    { kind: "toggle", id: "livePreviews", title: "Video on hover", desc: "Hovering a live stream or a VOD (Home, Browse, a channel's Videos, the sidebar's preview card) plays it there, muted." },
    { kind: "group", title: "MultiView" },
    { kind: "segmented", id: "multiviewLayout", title: "Default layout", desc: "Focus puts one stream big once there are 3 or more. The Home launcher uses its own choice.",
      options: [{ value: "spotlight", label: "Focus" }, { value: "grid", label: "Grid" }] },
    { kind: "segmented", id: "multiviewSound", title: "Sound when opening", desc: "Which stream you hear when MultiView opens.",
      options: [{ value: "first", label: "First stream" }, { value: "muted", label: "All muted" }] },
  ]},
  { id: "twitch", label: "Twitch account", icon: '<path d="M4 3h16v11l-4 4h-4l-3 3H7v-3H4z"/><path d="M11 7v5M16 7v5"/>', rows: [
    { kind: "action", title: "Twitch connection", desc: "The extra Twitch login used for pinned messages, predictions, polls, badges, following and drops.", button: "Manage…", run: () => { closeSettingsPanel(); actions.openTwitchConnection?.(); } },
    { kind: "toggle", id: "autoClaimDrops", title: "Auto-claim drops", desc: "Claim Twitch Drops as soon as they're ready." },
    { kind: "segmented", id: "dropsAutopilot", title: "Drops autopilot", desc: "When the stream you're earning drops on ends, find another live stream with the same campaign. Ask offers the switch; Automatically switches after a 10-second countdown you can cancel. Raids still take you along as usual.",
      options: [{ value: "ask", label: "Ask" }, { value: "auto", label: "Automatically" }, { value: "off", label: "Off" }] },
    { kind: "toggle", id: "autoClaimBonus", title: "Auto-claim channel points bonus", desc: "Claim the bonus chest Twitch offers while you watch, within about a minute of it appearing." },
  ]},
  { id: "appearance", label: "Appearance", icon: '<circle cx="13.5" cy="6.5" r="1.5"/><circle cx="17.5" cy="10.5" r="1.5"/><circle cx="8.5" cy="7.5" r="1.5"/><circle cx="6.5" cy="12.5" r="1.5"/><path d="M12 2a10 10 0 0 0 0 20c1.1 0 2-.9 2-2 0-.5-.2-1-.5-1.3-.3-.4-.5-.8-.5-1.3 0-1.1.9-2 2-2h2.4A5.6 5.6 0 0 0 22 9.9C22 5.5 17.5 2 12 2z"/>', rows: [
    { kind: "looks", title: "Saved looks", desc: "Your whole look (theme, colors, customized parts and custom CSS) saved under a name. Click one to switch to it." },
    { kind: "themes", title: "Theme", desc: "A starting look for the whole app. Your color changes below go on top of it." },
    { kind: "accent", title: "Accent color", desc: "Buttons, the seek bar, Drops tags, highlights and glows. Theme uses the theme's own color (Mosaic's is the platform's). Platform always uses Twitch purple, and Kick green in Kick mode." },
    { kind: "group", title: "Colors" },
    ...THEME_PARTS.map((p) => ({ kind: "color", part: p.key, title: p.title, desc: p.desc })),
    { kind: "action", title: "Reset colors", desc: "Go back to the theme's own colors.", button: "Reset",
      run: () => { setSetting("themeColors", {}); return "Reset"; } },
    { kind: "group", title: "Customize" },
    { kind: "action", title: "Customize parts", desc: "Click anything in Mosaic, like the sidebar, chat, stream cards or the seek bar, and change its colors and corners, or hide it.", button: "Start",
      run: () => { closeSettingsPanel(); configureCustomize({ onDone: () => openSettingsPanel("appearance", "Your changes") }); startPicking(); } },
    { kind: "changes", title: "Your changes", desc: "Parts you've customized." },
    { kind: "allparts", title: "All parts", desc: "Everything you can customize, including things that only show up now and then, like hype trains, raids and predictions." },
    { kind: "action", title: "Reset all parts", desc: "Undo every part you've customized.", button: "Reset", danger: true, confirm: true,
      run: () => { setSetting("customParts", {}); return "Reset"; } },
    { kind: "group", title: "Custom CSS" },
    { kind: "toggle", id: "customCssOn", title: "Use custom CSS", desc: "Turn this off to go back to normal at once, without losing what you wrote." },
    { kind: "code", id: "customCss", title: "Custom CSS", desc: "Your own CSS rules, applied on top of everything. For anything the picker doesn't cover. Only paste CSS you understand: it can make Mosaic hard to use. Use custom CSS above is the quick way back, and if it hides Settings itself, press Ctrl+Alt+Shift+S to switch custom CSS and customized parts off until you restart." },
    { kind: "group", title: "Share" },
    { kind: "action", title: "Copy theme code", desc: "Your theme, colors, customized parts and custom CSS as one code you can send to someone or keep.", button: "Copy",
      run: async () => copyThemeCode() },
    { kind: "import", title: "Use a theme code", desc: "Paste a theme code someone shared. It replaces your current theme, colors, parts and custom CSS." },
  ]},
  { id: "app", label: "App", icon: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M3 9h18"/>', rows: [
    { kind: "toggle", id: "autostart", title: "Start with your computer", desc: "Open Mosaic when you sign in." },
    { kind: "toggle", id: "startMinimized", title: "Start minimized", desc: "When Mosaic starts with your computer, go straight to the tray." },
    { kind: "toggle", id: "closeToTray", title: "Minimize to tray on close", desc: "Closing the window keeps Mosaic running in the system tray." },
    { kind: "segmented", id: "uiZoom", title: "Interface zoom", desc: "Scale the whole app, for small or high-resolution screens.",
      options: [0.9, 1, 1.1, 1.25].map((v) => ({ value: v, label: `${Math.round(v * 100)}%` })) },
    { kind: "toggle", id: "reduceMotion", title: "Reduce motion", desc: "Turn off animations and glows." },
    { kind: "toggle", id: "videoContextMenu", title: "Browser right-click menu", desc: "Show the browser's own menu when you right-click: on video (loop, save frame, picture in picture) and in text boxes (cut, copy, paste). Keyboard shortcuts like Ctrl+C and Ctrl+V work either way." },
    { kind: "toggle", id: "devTools", title: "Developer tools", desc: "Lets Inspect and Ctrl+Shift+I open the developer tools, for troubleshooting. Leave this off unless you need it: anyone who asks you to paste code into them is trying to take over your Twitch account. Turning it off applies the next time Mosaic starts." },
    { kind: "toggle", id: "autoUpdateCheck", title: "Check for updates automatically", desc: "At startup and every 15 minutes." },
    { kind: "action", title: "Check for updates", desc: "", button: "Check now", run: async () => actions.checkForUpdatesNow?.() },
    { kind: "toggle", id: "lunaButton", title: "Amazon Luna button", desc: "The crown in the header with the games and loot you can claim with Prime, as on twitch.tv." },
    { kind: "toggle", id: "notificationsButton", title: "Notifications button", desc: "The bell in the header with your Twitch notifications, as on twitch.tv. Uses the Twitch connection for drops and points." },
    { kind: "toggle", id: "showWhatsNew", title: "Show what's new after updates", desc: "A list of what changed, the first time Mosaic starts after an update." },
    { kind: "action", title: "What's new", desc: "What changed in this version and the ones before it.", button: "Open",
      run: () => { closeSettingsPanel(); actions.openWhatsNew?.(); } },
    { kind: "action", title: "Watch stats", desc: "How much you've watched, your top channels and your streak.", button: "Open",
      run: () => { closeSettingsPanel(); actions.openWatchStats?.(); } },
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

// On Android, rows for things a phone doesn't have (a tray, starting with the computer, the desktop updater,
// developer tools, pop-out windows, MultiView) are left out
if (isAndroid) {
  const desktopOnly = new Set(["autostart", "startMinimized", "closeToTray", "autoUpdateCheck", "devTools", "videoContextMenu",
    "autoPipOnBlur", "lurkMode", "autoTheater", "miniPlayer", "streamInfoOverlay"]);
  const desktopTitles = new Set(["Check for updates", "MultiView"]);
  // the phone has no sidebar or Home page (mobile.js): Following and the tabs take their place
  for (let i = SECTIONS.length - 1; i >= 0; i--) if (SECTIONS[i].id === "sidebar" || SECTIONS[i].id === "home") SECTIONS.splice(i, 1);
  for (const sec of SECTIONS) {
    sec.rows = sec.rows.filter((r) => !desktopOnly.has(r.id) && !desktopTitles.has(r.title));
    // Frosty's names for them: Appearance is General, Player is Video, App is Other
    if (sec.id === "appearance") { sec.label = "General"; sec.group = "Customize"; }
    if (sec.id === "player") { sec.label = "Video"; sec.group = "Customize"; }
    if (sec.id === "chat") sec.group = "Customize";
    if (sec.id === "notifications") sec.group = "Customize";
    if (sec.id === "app") { sec.label = "Other"; sec.group = "Other"; }
    if (sec.id === "twitch") sec.label = "Account";
    // the header's Drops button and account menu live here on a phone
    if (sec.id === "twitch") {
      sec.rows.unshift(
        { kind: "action", title: "Drops", desc: "Your drops in progress, what you can claim, and the campaigns running now.", button: "Open",
          run: () => { closeSettingsPanel(); actions.openDrops?.(); } },
      );
      sec.rows.push(
        { kind: "action", title: "Sign out", desc: "Log Mosaic out of your Twitch account on this phone.", button: "Sign out", danger: true, confirm: true,
          run: () => { closeSettingsPanel(); actions.signOut?.(); } },
      );
    }
  }
  // Frosty's order: the account card (drawn by render), then Customize, then Other
  const order = ["twitch", "appearance", "player", "chat", "notifications", "app"];
  SECTIONS.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
}

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
  // the palette is drawn above this panel: opening Settings from under it (Ctrl+,) closes it first, so the
  // panel on top is always the one Escape closes
  closeCommandPalette();
  if (panelEl) {
    if (section) { current = section; query = ""; render(); }
    if (focusTitle) focusRow(focusTitle);
    return;
  }
  if (section) current = section;
  query = "";
  panelEl = el("div", "settings-backdrop");
  // on a phone (Frosty's layout) Settings opens on its list of sections; a section is its own page
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
  if (isAndroid) {
    panelEl.querySelector(".settings-panel").classList.toggle("m-sec", !!section);
    const back = (onClick) => {
      const b = el("button", "settings-back");
      b.type = "button";
      b.setAttribute("aria-label", "Back");
      b.innerHTML = ICON('<path d="M15 18 9 12l6-6"/>');
      b.addEventListener("click", onClick);
      return b;
    };
    panelEl.querySelector(".settings-nav-title").prepend(back(() => closeSettingsPanel()));
    panelEl.querySelector(".settings-main-head").prepend(back(() => showSectionList()));
  }
  panelEl.addEventListener("mousedown", (e) => { if (e.target === panelEl) closeSettingsPanel(); });
  panelEl.querySelector(".settings-close").addEventListener("click", closeSettingsPanel);
  const search = panelEl.querySelector(".settings-search input");
  search.addEventListener("input", () => { query = search.value.trim().toLowerCase(); render(); });
  // Escape (and Android's back button) leaves a section for the list first on a phone, then closes Settings
  popEscape = pushEscape(() => {
    if (isAndroid && panelEl?.querySelector(".settings-panel.m-sec")) { showSectionList(); return; }
    closeSettingsPanel();
  });
  // keep controls in sync with changes made elsewhere (e.g. the player's quality-menu toggles)
  unsubscribe = onSettingChange((id) => refreshValues(id));
  render();
  if (focusTitle) focusRow(focusTitle);
  else if (!isAndroid) setTimeout(() => search.focus(), 30); // on a phone, focusing would pop the keyboard up over Settings
}

function focusRow(title) {
  const row = [...panelEl.querySelectorAll(".settings-row, .settings-themes-row")].find((r) => r.querySelector(".settings-row-title")?.textContent === title);
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
  popEscape?.();
  popEscape = null;
  unsubscribe?.();
  unsubscribe = null;
  closeSelectMenu();
}

function showSectionList() {
  panelEl?.querySelector(".settings-panel")?.classList.remove("m-sec");
}

// the account card at the top of a phone's settings list, as in Frosty: your picture and name, opening Account
function accountCard() {
  const loginBtn = document.getElementById("login-btn");
  const loggedIn = !!loginBtn?.classList.contains("logged-in");
  const card = el("button", "settings-account-card");
  card.type = "button";
  const pic = el("div", "settings-account-pic");
  const src = loginBtn?.querySelector(".account-avatar")?.getAttribute("src");
  if (loggedIn && src) { const img = el("img"); img.alt = ""; img.src = src; pic.appendChild(img); }
  const text = el("div", "settings-account-text");
  text.append(el("div", "settings-account-name", loggedIn ? (loginBtn.title || "Twitch") : "Log in"),
    el("div", "settings-account-sub", loggedIn ? "Account, drops and sign out" : "Log in with Twitch to chat and see who you follow"));
  card.append(pic, text);
  card.addEventListener("click", () => {
    if (!loggedIn) { closeSettingsPanel(); loginBtn?.click(); return; }
    current = "twitch"; render();
    panelEl.querySelector(".settings-panel").classList.add("m-sec");
  });
  return card;
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
  let group = null;
  if (isAndroid) nav.appendChild(accountCard());
  for (const sec of SECTIONS) {
    // a phone's list: Account is the card above; the rest under Frosty's group names
    if (isAndroid && sec.id === "twitch") continue;
    if (isAndroid && sec.group && sec.group !== group) { group = sec.group; nav.appendChild(el("div", "settings-nav-group", group)); }
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
      if (isAndroid) { panelEl.querySelector(".settings-panel").classList.add("m-sec"); panelEl.querySelector(".settings-rows").scrollTop = 0; }
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
  if (r.kind === "themes") return buildThemePicker(r);
  if (r.kind === "changes") return buildChangesList(r);
  if (r.kind === "allparts") return buildAllParts(r);
  if (r.kind === "looks") return buildLooks(r);
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
    // a row with preview (e.g. the chime volume) plays it while dragging, spaced out so it doesn't stutter
    let previewTimer = null;
    input.addEventListener("input", () => {
      setSetting(r.id, Number(input.value));
      if (r.preview) { clearTimeout(previewTimer); previewTimer = setTimeout(() => r.preview(), 220); }
    });
    wrap.append(input, val);
    ctl.appendChild(wrap);
    wrap.dataset.unit = r.unit || "";
  } else if (r.kind === "code") {
    // a code box that saves a moment after you stop typing (applying CSS on every key would flicker)
    row.classList.add("settings-row-code");
    const ta = el("textarea", "settings-code");
    ta.spellcheck = false;
    ta.placeholder = "/* e.g. make the sidebar a little wider */\n#app { --sidebar-width: 280px; }";
    ta.value = String(getSetting(r.id) || "");
    ta.dataset.setting = r.id;
    let t = null;
    ta.addEventListener("input", () => { clearTimeout(t); t = setTimeout(() => setSetting(r.id, ta.value), 350); });
    ta.addEventListener("blur", () => { clearTimeout(t); setSetting(r.id, ta.value); });
    // Tab types a tab (two spaces) instead of leaving the box
    ta.addEventListener("keydown", (e) => {
      if (e.key !== "Tab" || e.shiftKey) return;
      e.preventDefault();
      ta.setRangeText("  ", ta.selectionStart, ta.selectionEnd, "end");
      ta.dispatchEvent(new Event("input"));
    });
    row.appendChild(ta);
  } else if (r.kind === "import") {
    row.classList.add("wide-control");
    const wrap = el("div", "settings-import");
    const input = el("input", "settings-text");
    input.type = "text";
    input.placeholder = "MOSAIC-THEME:…";
    input.spellcheck = false;
    const b = el("button", "settings-action", "Use");
    b.type = "button";
    b.addEventListener("click", () => {
      try {
        const summary = importThemeCode(input.value);
        input.value = "";
        showToast(summary);
        render();
      } catch (err) {
        showToast(err?.message || "That isn't a Mosaic theme code.", true);
      }
    });
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") b.click(); });
    wrap.append(input, b);
    ctl.appendChild(wrap);
  } else if (r.kind === "accent") {
    // Platform | Theme, or any color from the swatch (which then shows as chosen)
    const seg = el("div", "settings-segmented settings-accent");
    for (const [value, label] of [["theme", "Theme"], ["platform", "Platform"]]) {
      const b = el("button", "settings-seg-btn", label);
      b.type = "button";
      b.dataset.value = value;
      b.addEventListener("click", () => setSetting("themeAccent", value));
      seg.appendChild(b);
    }
    const pick = colorInput((v) => setSetting("themeAccent", v));
    pick.classList.add("settings-accent-pick");
    pick.title = "Custom color";
    seg.appendChild(pick);
    ctl.appendChild(seg);
  } else if (r.kind === "color") {
    const wrap = el("div", "settings-color");
    wrap.dataset.part = r.part;
    const input = colorInput((v) => setSetting("themeColors", { ...themeColors(), [r.part]: v }));
    const reset = el("button", "settings-color-reset");
    reset.type = "button";
    reset.title = "Use the theme's color";
    reset.innerHTML = ICON('<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>', 13);
    reset.addEventListener("click", () => { const c = { ...themeColors() }; delete c[r.part]; setSetting("themeColors", c); });
    wrap.append(el("span", "settings-color-hex"), input, reset);
    ctl.appendChild(wrap);
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

// ---- Appearance (themes.js) ----
const themeColors = () => { const c = getSetting("themeColors"); return c && typeof c === "object" ? c : {}; };
// the color a part shows right now: your override, else the theme's
const partColor = (key) => (isHex(themeColors()[key]) ? themeColors()[key] : presetById(getSetting("theme")).colors[key]);

// a native color picker that saves as you drag (spaced out, so dragging doesn't write the setting every frame)
function colorInput(onPick) {
  const input = el("input", "settings-color-input");
  input.type = "color";
  let t = null;
  input.addEventListener("input", () => { clearTimeout(t); t = setTimeout(() => onPick(input.value.toLowerCase()), 40); });
  input.addEventListener("change", () => { clearTimeout(t); onPick(input.value.toLowerCase()); });
  return input;
}

// Your changes: each customized part with Edit and Reset (rebuilt by refreshValues when anything changes)
function buildChangesList(r) {
  const wrap = el("div", "settings-themes-row settings-changes");
  const text = el("div", "settings-row-text");
  text.append(el("div", "settings-row-title", r.title), el("div", "settings-row-desc", r.desc));
  wrap.append(text, el("div", "settings-changes-list"));
  fillChanges(wrap.querySelector(".settings-changes-list"));
  return wrap;
}
function fillChanges(list) {
  list.replaceChildren();
  const parts = changedParts();
  if (!parts.length) { list.appendChild(el("div", "settings-changes-empty", "Nothing customized yet. Press Start above and click any part of Mosaic.")); return; }
  for (const p of parts) {
    const item = el("div", "settings-change");
    const name = el("div", "settings-change-name");
    name.append(el("span", null, p.name), el("span", "settings-change-group", p.group));
    const edit = el("button", "settings-action", "Edit");
    edit.type = "button";
    edit.addEventListener("click", () => editPart(p));
    const reset = el("button", "settings-color-reset");
    reset.type = "button";
    reset.title = "Reset this part";
    reset.style.visibility = "visible";
    reset.innerHTML = ICON('<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>', 13);
    reset.addEventListener("click", () => resetPart(p.id));
    item.append(name, edit, reset);
    list.appendChild(item);
  }
}

// Saved looks: a chip per look (click to switch, x to delete), then Save current look
function buildLooks(r) {
  const wrap = el("div", "settings-themes-row settings-looks");
  const text = el("div", "settings-row-text");
  text.append(el("div", "settings-row-title", r.title), el("div", "settings-row-desc", r.desc));
  const list = el("div", "settings-looks-list");
  wrap.append(text, list);
  fillLooks(list);
  return wrap;
}
function fillLooks(list) {
  list.replaceChildren();
  for (const l of savedLooks()) {
    const chip = el("div", "settings-look" + (isCurrentLook(l.look) ? " on" : ""));
    const use = el("button", "settings-look-use", l.name);
    use.type = "button";
    use.title = `Switch to ${l.name}`;
    use.addEventListener("click", () => { try { useLook(l.name); showToast(`Switched to ${l.name}.`); } catch (e) { showToast(e.message, true); } });
    const del = el("button", "settings-look-del");
    del.type = "button";
    del.title = `Delete ${l.name}`;
    del.innerHTML = ICON('<path d="M18 6 6 18M6 6l12 12"/>', 12);
    // asks once: the first click arms it
    let armed = false, t = null;
    del.addEventListener("click", () => {
      if (!armed) { armed = true; chip.classList.add("armed"); del.title = "Click again to delete"; t = setTimeout(() => { armed = false; chip.classList.remove("armed"); del.title = `Delete ${l.name}`; }, 2500); return; }
      clearTimeout(t);
      deleteLook(l.name);
    });
    chip.append(use, del);
    list.appendChild(chip);
  }
  const add = el("button", "settings-look-add", savedLooks().length ? "+ Save current look" : "+ Save your current look");
  add.type = "button";
  add.addEventListener("click", () => {
    const form = el("div", "settings-look-form");
    const input = el("input", "settings-text");
    input.type = "text"; input.placeholder = "Name, e.g. Night"; input.maxLength = 40; input.spellcheck = false;
    const save = el("button", "settings-action", "Save");
    save.type = "button";
    const cancel = el("button", "settings-action", "Cancel");
    cancel.type = "button";
    const done = () => form.replaceWith(add);
    const go = () => {
      // the same name replaces that look: say so, so it's not a surprise
      const replacing = savedLooks().some((l) => l.name.toLowerCase() === String(input.value).trim().toLowerCase());
      try { const n = saveLook(input.value); showToast(replacing ? `Updated "${n}" to your current look.` : `Saved "${n}".`); } catch (e) { showToast(e.message, true); return; }
      fillLooks(list);
    };
    save.addEventListener("click", go);
    cancel.addEventListener("click", done);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); if (e.key === "Escape") { e.stopPropagation(); done(); } });
    form.append(input, save, cancel);
    add.replaceWith(form);
    input.focus();
  });
  list.appendChild(add);
}

// open a part's editor from Settings: outlined if it's on screen right now, otherwise in the middle
function editPart(p) {
  closeSettingsPanel();
  configureCustomize({ onDone: () => openSettingsPanel("appearance", "Your changes") });
  const node = [...document.querySelectorAll(p.sel)].find((n) => n.getClientRects().length) || null;
  openEditor(p.id, node);
}

// All parts: every customizable part, by group, with a search. Groups start folded except while searching
let allPartsQuery = "";
function buildAllParts(r) {
  const wrap = el("div", "settings-themes-row settings-allparts");
  const text = el("div", "settings-row-text");
  text.append(el("div", "settings-row-title", r.title), el("div", "settings-row-desc", r.desc));
  const search = el("input", "settings-text settings-allparts-search");
  search.type = "text";
  search.placeholder = `Search ${CUSTOM_PARTS.length} parts`;
  search.spellcheck = false;
  search.value = allPartsQuery;
  const list = el("div", "settings-allparts-list");
  search.addEventListener("input", () => { allPartsQuery = search.value; fillAllParts(list); });
  wrap.append(text, search, list);
  fillAllParts(list);
  return wrap;
}
function fillAllParts(list) {
  const q = allPartsQuery.trim().toLowerCase();
  const open = new Set([...list.querySelectorAll("details[open]")].map((d) => d.dataset.group));
  list.replaceChildren();
  const groups = [...new Set(CUSTOM_PARTS.map((p) => p.group))];
  const changed = customParts();
  let any = false;
  for (const g of groups) {
    const parts = CUSTOM_PARTS.filter((p) => p.group === g && (!q || `${p.name} ${p.group}`.toLowerCase().includes(q)));
    if (!parts.length) continue;
    any = true;
    const det = el("details", "settings-allparts-group");
    det.dataset.group = g;
    if (q || open.has(g)) det.open = true;
    const sum = el("summary", null);
    const n = parts.filter((p) => changed[p.id]).length;
    sum.append(el("span", null, g), el("span", "settings-allparts-count", n ? `${n} changed · ${parts.length}` : String(parts.length)));
    det.appendChild(sum);
    for (const p of parts) {
      const item = el("button", "settings-allparts-item" + (changed[p.id] ? " changed" : ""));
      item.type = "button";
      item.append(el("span", "settings-allparts-name", p.name), el("span", "settings-allparts-edit", "Edit"));
      item.addEventListener("click", () => editPart(p));
      det.appendChild(item);
    }
    list.appendChild(det);
  }
  if (!any) list.appendChild(el("div", "settings-changes-empty", `No parts match "${allPartsQuery.trim()}".`));
}

async function copyThemeCode() {
  const code = exportThemeCode();
  try {
    await navigator.clipboard.writeText(code);
    return "Copied";
  } catch {
    // no clipboard access: show it so it can be copied by hand
    showToast(code);
    return null;
  }
}

function buildThemePicker(r) {
  const wrap = el("div", "settings-themes-row");
  const text = el("div", "settings-row-text");
  text.append(el("div", "settings-row-title", r.title), el("div", "settings-row-desc", r.desc));
  const grid = el("div", "settings-themes");
  for (const p of THEME_PRESETS) {
    const b = el("button", "settings-theme");
    b.type = "button";
    b.dataset.theme = p.id;
    // a tiny mock of the app in the theme's colors: sidebar, a card, a line of text, the accent
    const sw = el("div", "settings-theme-swatch");
    sw.style.background = p.colors.bg;
    sw.innerHTML =
      `<span class="tsw-side" style="background:${p.colors.surface};border-color:${p.colors.border}"></span>` +
      `<span class="tsw-card" style="background:${p.colors.surface2};border-color:${p.colors.border}">` +
        `<i style="background:${p.colors.text}"></i><i style="background:${p.colors.muted}"></i></span>` +
      `<span class="tsw-accent" style="background:${p.accent || "var(--m-accent)"}"></span>`;
    b.append(sw, el("span", "settings-theme-name", p.name));
    b.addEventListener("click", () => setSetting("theme", p.id));
    grid.appendChild(b);
  }
  wrap.append(text, grid);
  return wrap;
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
// changed: the setting that just changed (undefined = refresh everything)
function refreshValues(changed) {
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
  panelEl.querySelectorAll(".settings-theme").forEach((b) => b.classList.toggle("on", b.dataset.theme === getSetting("theme")));
  // the parts lists only depend on customParts; rebuilding 200 rows on every color-picker tick made dragging stutter
  if (changed === undefined || ["savedLooks", "theme", "themeAccent", "themeColors", "customParts", "customCss", "customCssOn"].includes(changed)) {
    panelEl.querySelectorAll(".settings-looks-list").forEach((l) => { if (!l.querySelector(".settings-look-form")) fillLooks(l); });
  }
  if (changed === undefined || changed === "customParts") {
    panelEl.querySelectorAll(".settings-changes-list").forEach((l) => fillChanges(l));
    panelEl.querySelectorAll(".settings-allparts-list").forEach((l) => fillAllParts(l));
  }
  panelEl.querySelectorAll(".settings-code").forEach((ta) => {
    if (document.activeElement !== ta) ta.value = String(getSetting(ta.dataset.setting) || "");
  });
  panelEl.querySelectorAll(".settings-accent").forEach((seg) => {
    const a = getSetting("themeAccent");
    seg.querySelectorAll(".settings-seg-btn").forEach((b) => b.classList.toggle("on", b.dataset.value === a));
    const pick = seg.querySelector(".settings-accent-pick");
    pick.classList.toggle("on", isHex(a));
    if (document.activeElement !== pick) pick.value = isHex(a) ? a : (getComputedStyle(document.body).getPropertyValue("--m-accent").trim() || "#9147ff");
  });
  panelEl.querySelectorAll(".settings-color").forEach((w) => {
    const input = w.querySelector("input");
    if (document.activeElement !== input) input.value = partColor(w.dataset.part);
    w.querySelector(".settings-color-hex").textContent = partColor(w.dataset.part).toUpperCase();
    w.classList.toggle("custom", isHex(themeColors()[w.dataset.part]));
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
  const wasOwn = selectOwner === btn;
  if (document.querySelector(".settings-select-menu")) closeSelectMenu();
  if (wasOwn) return; // clicking the open dropdown's button closes it; another dropdown's opens that one instead
  selectOwner = btn;
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
  popSelectEscape = pushEscape(() => closeSelectMenu());
}
function onSelectOutside(e) {
  const m = document.querySelector(".settings-select-menu");
  // its own button is left to the click that follows: closing here would let that click reopen it (a flicker)
  if (m && !m.contains(e.target) && !selectOwner?.contains(e.target)) closeSelectMenu();
}
function closeSelectMenu() {
  document.querySelector(".settings-select-menu")?.remove();
  selectOwner = null;
  document.removeEventListener("mousedown", onSelectOutside, true);
  popSelectEscape?.();
  popSelectEscape = null;
}
