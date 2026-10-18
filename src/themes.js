// Themes (Settings > Appearance): preset color sets for the app's design tokens (styles.css, the --m-* set),
// plus your own overrides on top. Applied by settings.js applyAppearance as inline variables on <body>, which
// win over both the defaults in :root and body.kick-mode's accent. The default theme with nothing customized
// sets nothing at all, so it looks exactly as before themes existed.
//
// Light themes: a theme whose background is light also gets body.theme-light (applyAppearance), which turns
// on --m-shade (darkens colored text like pale red / green so it reads on white), light native scrollbars
// and darker accent-tinted text. Colors over video and thumbnails stay as they are in every theme.

// the parts of the app you can recolor, in the order Settings lists them. var: the design token it sets
export const THEME_PARTS = [
  { key: "bg", var: "--m-bg", title: "Background", desc: "Behind everything: the page, Home, Browse." },
  { key: "surface", var: "--m-surface", title: "Panels", desc: "The sidebar, chat, the header and dialogs." },
  { key: "surface2", var: "--m-surface-2", title: "Cards", desc: "Cards, inputs and list rows." },
  { key: "raised", var: "--m-raised", title: "Raised", desc: "Buttons and anything that sits on a card." },
  { key: "border", var: "--m-border", title: "Borders", desc: "Lines between panels and around cards." },
  { key: "text", var: "--m-text", title: "Text", desc: "Main text." },
  { key: "muted", var: "--m-muted", title: "Secondary text", desc: "Descriptions, counts and timestamps." },
];

// Mosaic is the look before themes; accent null = the platform's color (Twitch purple, Kick green)
export const THEME_PRESETS = [
  { id: "mosaic", name: "Mosaic", accent: null,
    colors: { bg: "#0e1116", surface: "#161b22", surface2: "#1c222c", raised: "#232b36", border: "#29313d", text: "#e7ebf2", muted: "#9aa5b4" } },
  { id: "midnight", name: "Midnight", accent: "#6d8bff",
    colors: { bg: "#0a0f1e", surface: "#10172c", surface2: "#151e38", raised: "#1c2747", border: "#253259", text: "#e6ebff", muted: "#9aa6c9" } },
  { id: "oled", name: "OLED Black", accent: null,
    colors: { bg: "#000000", surface: "#0a0a0a", surface2: "#121212", raised: "#1b1b1b", border: "#262626", text: "#f2f2f2", muted: "#a3a3a3" } },
  { id: "graphite", name: "Graphite", accent: null,
    colors: { bg: "#18181b", surface: "#1f1f23", surface2: "#26262b", raised: "#2f2f35", border: "#3a3a41", text: "#ececf0", muted: "#a5a5ae" } },
  { id: "forest", name: "Forest", accent: "#3ecf8e",
    colors: { bg: "#0c1310", surface: "#121c17", surface2: "#17251e", raised: "#1e2f27", border: "#283d33", text: "#e4efe9", muted: "#98ada3" } },
  { id: "rose", name: "Rosé", accent: "#ff6fa5",
    colors: { bg: "#151013", surface: "#1d1519", surface2: "#251b20", raised: "#2f2229", border: "#3c2b34", text: "#f3e8ee", muted: "#b39aa8" } },
  { id: "ocean", name: "Ocean", accent: "#22b8dc",
    colors: { bg: "#07131a", surface: "#0c1c24", surface2: "#11252e", raised: "#17303b", border: "#1f3f4c", text: "#e2f1f6", muted: "#8fb0bd" } },
  { id: "daylight", name: "Daylight", accent: null,
    colors: { bg: "#eef0f4", surface: "#ffffff", surface2: "#f4f6f9", raised: "#e6e9ef", border: "#d6dbe3", text: "#15181e", muted: "#596273" } },
  { id: "paper", name: "Paper", accent: "#c2410c",
    colors: { bg: "#f3efe8", surface: "#fbf8f3", surface2: "#f1ece3", raised: "#e7e0d4", border: "#d9d0c1", text: "#231e18", muted: "#6c6253" } },
];

export const presetById = (id) => THEME_PRESETS.find((p) => p.id === id) || THEME_PRESETS[0];

// the background the theme ends up with (your override, else the preset's)
const bgOf = (presetId, custom) => {
  const c = custom && typeof custom === "object" ? custom : {};
  return isHex(c.bg) ? c.bg : presetById(presetId).colors.bg;
};
// a light theme: its background is light (so a dark preset given a light background counts too)
export const themeIsLight = (presetId, custom) => lum(bgOf(presetId, custom)) > 0.35;

// every variable a theme may set, so switching back can clear them all
export const THEME_VARS = [
  ...THEME_PARTS.map((p) => p.var), "--m-border-soft", "--m-faint",
  "--m-accent", "--m-accent-hover", "--m-accent-soft", "--m-accent-fg",
  "--accent", "--accent-dark", "--accent-light", "--accent-text", "--accent-soft", "--accent-fg",
];

const HEX = /^#[0-9a-f]{6}$/i;
export const isHex = (v) => typeof v === "string" && HEX.test(v);
const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const hex = (c) => "#" + c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("");
// a toward b by t (0..1)
const mix = (a, b, t) => { const x = rgb(a), y = rgb(b); return hex(x.map((v, i) => v + (y[i] - v) * t)); };
const lum = (h) => {
  const [r, g, b] = rgb(h).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

// the variables for a theme: preset, your color overrides ({ key: "#rrggbb" }) and the accent choice
// ("theme" | "platform" | "#rrggbb"). null = set nothing (the built-in look)
export function themeVars(presetId, custom, accent) {
  const preset = presetById(presetId);
  const over = custom && typeof custom === "object" ? custom : {};
  const hasOver = THEME_PARTS.some((p) => isHex(over[p.key]));
  // the preset's own accent is the "theme" choice; Mosaic has none, so that's the platform color
  const accentHex = isHex(accent) ? accent : accent === "theme" ? preset.accent : null;
  if (preset.id === "mosaic" && !hasOver && !accentHex) return null;
  const c = {};
  for (const p of THEME_PARTS) c[p.key] = isHex(over[p.key]) ? over[p.key] : preset.colors[p.key];
  const vars = {};
  for (const p of THEME_PARTS) vars[p.var] = c[p.key];
  // the two in-between shades follow from their neighbors, so they always fit the colors above
  vars["--m-border-soft"] = mix(c.border, c.surface, 0.5);
  vars["--m-faint"] = mix(c.muted, c.bg, 0.35);
  if (accentHex) {
    const light = lum(c.bg) > 0.35;
    const fg = lum(accentHex) > 0.45 ? "#0e0e10" : "#ffffff"; // dark text on light accents (like Kick green)
    const [r, g, b] = rgb(accentHex);
    Object.assign(vars, {
      "--m-accent": accentHex,
      "--m-accent-hover": mix(accentHex, "#000000", 0.15),
      "--m-accent-soft": `rgba(${r},${g},${b},.12)`,
      "--m-accent-fg": fg,
      "--accent": accentHex,
      "--accent-dark": mix(accentHex, "#000000", 0.15),
      "--accent-light": mix(accentHex, "#ffffff", 0.2),
      // accent-tinted text: lighter on dark backgrounds, darker on light ones
      "--accent-text": light ? mix(accentHex, "#000000", 0.3) : mix(accentHex, "#ffffff", 0.4),
      "--accent-soft": `rgba(${r},${g},${b},.13)`,
      "--accent-fg": fg,
    });
  }
  return vars;
}

// ---- Customize (customize.js): named parts of the app you can pick and restyle ----
// Each part has a friendly name, the group it's listed under, the CSS selector it covers, and which
// controls make sense for it: bg (background), text, border, accent (recolors the accent inside it), glow
// (the color of its glow / highlight effects), radius (corner roundness), size (text size), hide. Parts are
// matched innermost-first when you pick, and within one element the first listed wins, so more specific
// parts come before the general ones they sit inside. Names, not raw selectors, are what's saved, so a
// customization keeps working when the markup underneath changes.
const C = {
  box: ["bg", "text", "border", "radius"],
  panel: ["bg", "text", "border", "accent", "radius"],
  area: ["bg", "text", "border", "accent"],
  btn: ["bg", "text", "border", "radius"],
  label: ["text", "size", "hide"],
  badge: ["bg", "text", "radius", "hide"],
  fill: ["bg", "radius"],
  line: ["bg", "text", "border", "glow", "radius"],
};
const P = (group, list) => list.map(([id, name, sel, ctl]) => ({ id, group, name, sel, ctl: Array.isArray(ctl) ? ctl : C[ctl] }));
export const CUSTOM_PARTS = [
  ...P("Header", [
    ["nav-tab-active", "Selected tab", ".nav-tab.nav-tab-active", ["bg", "text", "radius"]],
    ["nav-tabs", "Navigation tabs", ".nav-tab", ["text", "radius", "size"]],
    ["channel-search", "Channel search", "#channel-input", "box"],
    ["watch-btn", "Watch button", "#watch-btn", ["bg", "text", "radius"]],
    ["header-unread", "Unread counts", ".header-whispers-unread", "badge"],
    ["update-btn", "Update button", ".header-update-btn", "btn"],
    ["header-buttons", "Header buttons", ".titlebar-action-buttons button, .header-whispers-btn", "btn"],
    ["window-buttons", "Window buttons", ".win-btn", ["bg", "text", "radius"]],
    ["logo", "Mosaic logo", "header h1", ["text", "size", "hide"]],
    ["header", "Header", "#app > header", "area"],
  ]),
  ...P("Sidebar", [
    ["live-dot", "Live dot", ".sidebar-live-dot", ["bg", "hide"]],
    ["sidebar-drops", "Drops label", ".sidebar-drops-label", ["text", "size", "hide"]],
    ["sidebar-viewers", "Viewer counts", ".sidebar-channel-viewer-row", ["text", "size", "hide"]],
    ["sidebar-name", "Channel names", ".sidebar-channel-name", ["text", "size"]],
    ["sidebar-game", "Channel games", ".sidebar-channel-sub, .sidebar-channel-status", ["text", "size", "hide"]],
    ["sidebar-avatar", "Channel pictures", ".sidebar-channel-avatar, .sidebar-channel-avatar-wrap", ["border", "radius", "hide"]],
    ["sidebar-hype", "Hype train glow", ".sidebar-channel.hype-active", ["glow", "bg", "radius"]],
    ["sidebar-rows", "Channel rows", ".sidebar-channel", "box"],
    ["sidebar-show-more", "Show more", ".sidebar-show-more", "btn"],
    ["sidebar-login", "Login prompt", ".sidebar-login-prompt, .sidebar-empty", ["bg", "text", "border", "hide"]],
    ["sidebar-titles", "Section titles", ".sidebar-section-title", ["text", "size", "hide"]],
    ["sidebar-dividers", "Dividers", ".sidebar-section-divider", ["bg", "hide"]],
    ["sidebar-preview", "Hover preview card", ".sidebar-preview", "panel"],
    ["notify-menu", "Notify menu", ".sidebar-notify-menu", "panel"],
    ["sidebar", "Sidebar", "#channels-sidebar", "area"],
  ]),
  ...P("Home", [
    ["live-badge", "LIVE badge", ".home-live-badge", "badge"],
    ["drops-badge", "Drops Enabled badge", ".home-drops-badge", "badge"],
    ["viewer-count", "Viewer count", ".home-grid-viewers, .home-carousel-viewers", "badge"],
    ["card-tags", "Tags", ".home-card-tag, .channel-info-tag", ["bg", "text", "border", "radius", "hide"]],
    ["card-title", "Stream titles", ".home-grid-title", ["text", "size"]],
    ["card-name", "Streamer names", ".home-grid-name, .home-carousel-name", ["text", "size"]],
    ["card-game", "Game names", ".home-grid-game, .home-carousel-game", ["text", "size", "hide"]],
    ["card-thumb", "Thumbnails", ".home-grid-thumb-wrap, .home-carousel-thumb", ["border", "radius"]],
    ["card-hype", "Card hype train glow", ".home-grid-card.hype-active, .home-carousel-card.hype-active", ["glow", "radius"]],
    ["continue-progress", "Watch progress bar", ".home-continue-progress-fill", "fill"],
    ["carousel-arrows", "Carousel arrows", ".home-carousel-nav", ["bg", "text", "radius", "hide"]],
    ["mvl", "MultiView launcher", ".home-mvl", "panel"],
    ["stream-cards", "Stream cards", ".home-grid-card, .home-carousel-card, .home-continue-card", "box"],
    ["show-more", "Show more", ".home-show-more", "btn"],
    ["section-titles", "Section titles", ".home-section-title, .browse-page-title, .browse-category-title", ["text", "size"]],
    ["page", "Page background", "#home-feed, #browse-page, #vods-page", ["bg", "text", "accent"]],
  ]),
  ...P("Browse & videos", [
    ["browse-search", "Category search", ".browse-search-wrap", "box"],
    ["filter-pills", "Filter pills", ".browse-pill", "box"],
    ["browse-tabs", "Browse tabs", ".browse-tab", ["bg", "text", "radius"]],
    ["category-art", "Category art", ".browse-game-art", ["border", "radius"]],
    ["category-cards", "Category cards", ".browse-game-card", ["bg", "text", "radius"]],
    ["vod-views", "VOD view counts", ".vod-views-badge", "badge"],
    ["vod-chapters", "Chapters badge", ".vod-chapters-badge", "badge"],
    ["vod-resume", "Resume bar", ".vod-resume-fill", "fill"],
    ["vods-tabs", "Videos tabs", ".vods-tab", ["bg", "text", "radius"]],
    ["vods-header", "Videos header", ".vods-header", "area"],
    ["load-more", "Load more", ".vods-load-more, .browse-pagination-footer button", "btn"],
  ]),
  ...P("Player", [
    ["seek-fill", "Seek bar", "#seek-bar-fill", "fill"],
    ["seek-heatmap", "Chat heatmap", ".seek-heat-area, .seek-heat-line", ["bg", "hide"]],
    ["seek-muted", "Muted sections", ".seek-bar-muted-segment", ["bg", "hide"]],
    ["seek-clips", "Clip markers", ".seek-clip-marker", ["bg", "hide"]],
    ["seek-bookmarks", "Bookmark markers", ".seek-bookmark-marker", ["bg", "hide"]],
    ["seek-tooltip", "Seek time bubble", ".seek-bar-tooltip", ["bg", "text", "radius"]],
    ["seek-track", "Seek bar track", "#seek-bar-track", ["bg", "radius"]],
    ["volume", "Volume slider", ".volume-slider", ["accent"]],
    ["time-display", "Time", ".time-display", ["text", "size"]],
    ["live-btn", "LIVE button", "#live-btn", ["bg", "text", "radius"]],
    ["control-buttons", "Control buttons", ".control-btn", ["text", "bg", "radius"]],
    ["player-controls", "Player controls", "#controls-bar", ["bg", "text", "accent"]],
    ["center-play", "Big play button", ".center-play-btn", ["bg", "text", "border", "radius"]],
    ["stream-info", "Stream info overlay", ".stream-info-overlay", ["bg", "text", "radius", "hide"]],
    ["drops-bar", "Drops aren't counting bar", ".drops-banner", "panel"],
    ["muted-skip", "Muted section notice", ".muted-skip-notice", "panel"],
    ["nerd-stats", "Stats for nerds", ".nerd-stats", ["bg", "text", "radius"]],
    ["audio-only", "Audio only panel", ".audio-only-overlay", ["bg", "text"]],
    ["raid-banner", "Raid banner", ".raid-banner", "panel"],
    ["mini-player", "Mini player bar", ".mini-player-bar", ["bg", "text"]],
    ["video-bg", "Video background", "#video-region", ["bg"]],
  ]),
  ...P("Player menus", [
    ["quality-menu", "Quality menu", ".quality-menu", "panel"],
    ["speed-menu", "Speed menu", ".speed-menu", "panel"],
    ["chapters-menu", "Chapters menu", ".chapters-menu, .vod-chapters-popup", "panel"],
    ["clips-menu", "Top clips menu", ".clips-menu", "panel"],
    ["bookmarks-menu", "Bookmarks", ".bm-panel, .bm-menu", "panel"],
    ["clip-panel", "Clip maker", ".clip-panel", "panel"],
    ["track-id", "Track ID", ".track-id-panel", "panel"],
    ["player-menu", "Video right-click menu", ".player-menu", "panel"],
  ]),
  ...P("Channel", [
    ["follow-btn", "Follow button", "#channel-info-follow-btn", "btn"],
    ["subscribe-btn", "Subscribe button", "#channel-info-subscribe-btn", "btn"],
    ["videos-btn", "Videos button", "#channel-info-videos-btn", "btn"],
    ["channel-drops-tag", "Drops tag", ".channel-info-tag.channel-info-drops-tag", "badge"],
    ["channel-category", "Category tag", ".channel-info-tag.channel-info-category-tag", "badge"],
    ["channel-name", "Channel name", ".channel-info-name", ["text", "size"]],
    ["channel-title", "Stream title", ".channel-info-title", ["text", "size"]],
    ["channel-viewers", "Viewer count", ".channel-info-viewers", ["text", "size", "hide"]],
    ["channel-avatar", "Channel picture", ".channel-info-avatar", ["border", "radius"]],
    ["channel-you", "Your stats on the channel", ".cyou-panel", "panel"],
    ["channel-bar", "Channel bar", "#channel-info-bar", "area"],
  ]),
  ...P("Chat", [
    ["chat-mentions", "Mentions", ".chat-line.is-mention, .chat-line.chat-mention", "line"],
    ["chat-highlighted", "Highlighted messages", ".chat-line.is-highlighted-message", "line"],
    ["chat-first", "First-time chatters", ".chat-line.is-first-msg", "line"],
    ["chat-points-msg", "Channel points messages", ".chat-line.is-channel-point-message, .chat-line.channel-point-redeem-event", "line"],
    ["chat-bits", "Cheers", ".chat-line.has-bits", "line"],
    ["chat-replies", "Replies", ".chat-line.is-reply", "line"],
    ["chat-system", "System messages", ".chat-line.system", ["bg", "text", "size"]],
    ["chat-deleted", "Deleted messages", ".chat-line.is-cleared", ["bg", "text"]],
    ["chat-automod", "AutoMod held messages", ".chat-line.is-automod-held", "line"],
    ["chat-timestamps", "Timestamps", ".chat-ts", ["text", "size", "hide"]],
    ["chat-badges", "Badges", ".chat-badges-slot", ["hide"]],
    ["chat-links", "Links", ".chat-link", ["text"]],
    ["chat-reply-header", "Reply context", ".reply-header", ["text", "size", "hide"]],
    ["first-msg-label", "First message label", ".first-msg-label", "badge"],
    ["chat-messages", "Chat messages", ".chat-line", ["bg", "text", "radius", "size"]],
    ["pinned-message", "Pinned message", "#pinned-message", ["bg", "text", "border", "radius", "hide"]],
    ["chat-reply-bar", "Replying-to bar", ".chat-reply-indicator", "panel"],
    ["jump-latest", "Jump to latest", ".jump-to-latest-btn", "btn"],
    ["chat-mode-chips", "Chat mode chips", ".chat-mode-chip", "badge"],
    ["chat-points-bar", "Channel points balance", ".chat-points, .rewards-balance", ["bg", "text", "radius"]],
    ["chat-send", "Send button", "#chat-send-btn", ["bg", "text", "radius"]],
    ["chat-input-buttons", "Message box buttons", "#chat-emote-btn, #chat-settings-btn, .chat-filter-btn", ["text", "bg", "radius"]],
    ["chat-input", "Message box", "#chat-input-wrapper", "box"],
    ["chat-input-row", "Message box area", "#chat-input-row", ["bg", "border"]],
    ["chat-settings-menu", "Chat settings menu", ".chat-settings-menu", "panel"],
    ["chat-context-menu", "Chat right-click menu", ".chat-context-menu", "panel"],
    ["chat-collapse", "Collapse chat button", ".chat-collapse-toggle", ["text", "bg", "radius"]],
    ["chat-header", "Chat header", ".chat-header", "area"],
    ["chat", "Chat", "#chat-pane", "area"],
  ]),
  ...P("Chat events", [
    ["sub-events", "Subscriptions", ".chat-event.sub-event", "line"],
    ["gift-events", "Gifted subs", ".chat-event.gift-event", "line"],
    ["raid-events", "Raids", ".chat-event.raid-event", "line"],
    ["announcements", "Announcements", ".chat-event.announcement-event", "line"],
    ["generic-events", "Other events", ".chat-event.generic-event", "line"],
    ["chat-event-names", "Event names", ".chat-event-name", ["text", "size"]],
    ["chat-event-cards", "Event cards", ".chat-event", "line"],
    ["gift-banner", "Gift sub banner", ".gift-sub-banner", "panel"],
    ["resub-banner", "Resub banner", ".resub-banner", "panel"],
    ["chat-clip-cards", "Clip cards", ".chat-clip-card", "box"],
    ["link-previews", "Link previews", ".link-preview-popup", "panel"],
  ]),
  ...P("Hype train", [
    ["hype-fill", "Hype train progress", ".hype-fill, .hype-train-fill", ["bg", "glow", "radius"]],
    ["hype-level", "Level", ".hype-train-level, .hype-pct", ["text", "size"]],
    ["hype-burst", "Level-up celebration", ".hype-burst", ["glow", "text", "hide"]],
    ["hype-ring", "Countdown ring", ".hype-ring", ["glow"]],
    ["hype-details", "Hype train details", ".hype-details", "panel"],
    ["hype-banner", "Hype train banner", ".hype-train-banner", ["glow", "bg", "text", "border", "radius"]],
  ]),
  ...P("Predictions & polls", [
    ["prediction-blue", "Blue side", ".le-side.blue, .le-go.blue, .pred-outcome.blue", ["bg", "text", "glow"]],
    ["prediction-pink", "Pink side", ".le-side.pink, .le-go.pink, .pred-outcome.pink", ["bg", "text", "glow"]],
    ["poll-bars", "Poll bars", ".le-row-fill", "fill"],
    ["poll-rows", "Poll choices", ".le-row", "box"],
    ["le-buttons", "Bet and vote buttons", ".le-go", "btn"],
    ["le-card", "Predictions & polls card", ".le-card", "panel"],
    ["prediction-overlay", "Prediction over the video", ".prediction-overlay", "panel"],
  ]),
  ...P("Emotes", [
    ["emote-tabs", "Emote picker tabs", ".emote-picker-tab", ["bg", "text", "radius"]],
    ["emote-search", "Emote search", ".emote-picker-search-wrap", "box"],
    ["emote-titles", "Emote sections", ".emote-picker-section-title", ["text", "size"]],
    ["emote-items", "Emote tiles", ".emote-picker-item, .emote-tile", ["bg", "radius"]],
    ["emote-picker", "Emote picker", ".emote-picker-menu", "panel"],
    ["emote-suggest-sel", "Selected suggestion", ".emote-autocomplete-item.selected", ["bg", "text", "radius"]],
    ["emote-suggest", "Emote suggestions", ".emote-autocomplete", "panel"],
    ["emote-card", "Emote card", ".emote-card", "panel"],
  ]),
  ...P("Whispers", [
    ["whisper-mine", "Your messages", ".whisper-msg.self .whisper-bubble", ["bg", "text", "radius"]],
    ["whisper-theirs", "Their messages", ".whisper-bubble", ["bg", "text", "border", "radius"]],
    ["whisper-threads", "Conversations", ".whisper-thread-row", "box"],
    ["whisper-unread", "Unread count", ".whisper-thread-unread", "badge"],
    ["whisper-input", "Whisper box", ".whisper-input-wrap", "box"],
    ["whisper-send", "Send button", ".whisper-send", "btn"],
    ["whisper-header", "Whispers header", ".whisper-header", "area"],
    ["whispers", "Whispers window", ".whisper-modal", "panel"],
  ]),
  ...P("Notifications", [
    ["notif-unread", "Unread dot", ".notif-dot", ["bg", "hide"]],
    ["notif-items", "Notifications", ".notif-item", "box"],
    ["notif-tabs", "Notification tabs", ".notif-tab", ["bg", "text", "radius"]],
    ["luna", "Amazon Luna panel", ".notif-panel.luna-panel", "panel"],
    ["notifications", "Notifications panel", ".notif-panel", "panel"],
  ]),
  ...P("Drops & rewards", [
    ["drops-earning", "Earning now tag", ".drops-earning", "badge"],
    ["drops-progress", "Drop progress bars", ".drops-bar span, .rewards-bar-fill", "fill"],
    ["drops-unlinked", "Account not linked", ".drops-unlinked", ["text", "hide"]],
    ["drops-campaigns", "Campaigns you're earning", ".drops-campaign", "box"],
    ["drops-tiles", "Available campaigns", ".drops-tile", "box"],
    ["reward-rows", "Channel point rewards", ".reward-row", "box"],
    ["rewards", "Rewards window", ".rewards-modal", "panel"],
  ]),
  ...P("MultiView", [
    ["mv-focused", "Focused stream", ".multiview-tile.multiview-tile-focused", ["border", "glow", "radius"]],
    ["mv-tiles", "Stream tiles", ".multiview-tile", ["bg", "border", "radius"]],
    ["mv-tile-name", "Tile names", ".multiview-tile-name", ["bg", "text", "hide"]],
    ["mv-bar", "MultiView bar", ".multiview-bar", "panel"],
    ["mv-followed", "Followed channels picker", ".multiview-followed-panel", "panel"],
    ["mv-chat", "MultiView chat", ".multiview-chat", "area"],
    ["multiview", "MultiView background", ".multiview-overlay", ["bg"]],
  ]),
  ...P("Popups", [
    ["user-card", "User card", ".user-card", "panel"],
    ["user-menu", "Account menu", ".user-menu", "panel"],
    ["mod-menu", "Mod menu", ".modmenu", "panel"],
    ["mod-log", "Mod log", ".modlog-modal", "panel"],
    ["automod", "AutoMod queue", ".automod-panel", "panel"],
    ["thread", "Reply thread", ".thread-panel", "panel"],
    ["badge-picker", "Badge picker", ".badge-picker", "panel"],
    ["chat-filter", "Chat filter", ".chat-filter-modal", "panel"],
    ["clip-player", "Clip player", ".clip-player", "panel"],
    ["palette", "Command palette", ".cp", "panel"],
    ["dropdowns", "Dropdown menus", ".tsel-menu, .settings-select-menu", "panel"],
    ["tooltips", "Tooltips", ".app-tooltip", ["bg", "text", "radius"]],
    ["toasts", "Toasts", ".app-toast, .settings-toast", ["bg", "text", "border", "radius"]],
  ]),
  ...P("Panels", [
    ["buttons", "Panel buttons", ".hub-btn, .settings-action", "btn"],
    ["switches", "Switches (on)", ".settings-switch.on", ["bg"]],
    ["segmented", "Option buttons (chosen)", ".settings-seg-btn.on", ["bg", "text", "radius"]],
    ["panel-titles", "Panel section titles", ".hub-section, .settings-group", ["text", "size"]],
    ["settings-nav", "Settings menu", ".settings-nav", ["bg", "text", "border"]],
    ["whats-new", "What's new", ".settings-panel.whatsnew-panel", "panel"],
    ["watch-stats", "Watch stats", ".stats-card", "box"],
    ["dialogs", "Dialogs", ".hub-panel, .settings-panel", "panel"],
    ["backdrops", "Dimmed backdrop", ".hub-backdrop, .settings-backdrop, .cp-backdrop", ["bg"]],
  ]),
];
export const partById = (id) => CUSTOM_PARTS.find((p) => p.id === id) || null;

// the accent variable set for one color (themeVars uses the same recipe for a theme's accent)
export function accentVars(accentHex, onLight = false) {
  if (!isHex(accentHex)) return {};
  const fg = lum(accentHex) > 0.45 ? "#0e0e10" : "#ffffff";
  const [r, g, b] = rgb(accentHex);
  return {
    "--m-accent": accentHex, "--m-accent-hover": mix(accentHex, "#000000", 0.15),
    "--m-accent-soft": `rgba(${r},${g},${b},.12)`, "--m-accent-fg": fg,
    "--accent": accentHex, "--accent-dark": mix(accentHex, "#000000", 0.15),
    "--accent-light": mix(accentHex, "#ffffff", 0.2),
    "--accent-text": onLight ? mix(accentHex, "#000000", 0.3) : mix(accentHex, "#ffffff", 0.4),
    "--accent-soft": `rgba(${r},${g},${b},.13)`, "--accent-fg": fg,
  };
}

export const SIZE_OPTIONS = [
  { value: null, label: "Default" }, { value: 0.85, label: "Smaller" }, { value: 1.15, label: "Larger" }, { value: 1.3, label: "Huge" },
];

export const RADIUS_OPTIONS = [
  { value: null, label: "Default" }, { value: 0, label: "Square" }, { value: 6, label: "Soft" },
  { value: 12, label: "Round" }, { value: 999, label: "Pill" },
];

// the stylesheet for your customized parts: { partId: { bg, text, border, accent, radius, hidden } }.
// !important so they win over the app's own rules; colors also set the matching design tokens inside the
// part, so what's inside it (which uses those tokens) follows along
export function customPartsCss(custom, onLight = false) {
  if (!custom || typeof custom !== "object") return "";
  const out = [];
  // general parts first, specific ones after, so a specific part wins over the one it sits in
  for (const part of [...CUSTOM_PARTS].reverse()) {
    const c = custom[part.id];
    if (!c || typeof c !== "object") continue;
    const d = [];
    if (c.hidden && part.ctl.includes("hide")) d.push("display: none !important");
    if (isHex(c.bg) && part.ctl.includes("bg")) d.push(`background: ${c.bg} !important`);
    if (isHex(c.text) && part.ctl.includes("text")) {
      d.push(`color: ${c.text} !important`, `--m-text: ${c.text}`, `--m-muted: color-mix(in srgb, ${c.text} 72%, transparent)`, `--m-faint: color-mix(in srgb, ${c.text} 52%, transparent)`);
    }
    if (isHex(c.border) && part.ctl.includes("border")) d.push(`border-color: ${c.border} !important`, `--m-border: ${c.border}`, `--m-border-soft: ${c.border}`);
    if (isHex(c.accent) && part.ctl.includes("accent")) for (const [k, v] of Object.entries(accentVars(c.accent, onLight))) d.push(`${k}: ${v}`);
    // glow: glows and highlights are drawn from the accent (and hype trains from --hype-color, which
    // hype-train.js sets inline per level, hence !important)
    if (isHex(c.glow) && part.ctl.includes("glow")) {
      for (const [k, v] of Object.entries(accentVars(c.glow, onLight))) d.push(`${k}: ${v}`);
      d.push(`--hype-color: ${c.glow} !important`);
    }
    if (Number.isFinite(c.size) && c.size !== 1 && part.ctl.includes("size")) d.push(`zoom: ${Math.max(0.6, Math.min(2, c.size))}`);
    if (Number.isFinite(c.radius) && part.ctl.includes("radius")) d.push(`border-radius: ${Math.max(0, Math.min(999, c.radius))}px !important`);
    // one rule per selector branch, ordered by how specific it is (below), so a narrower part (the Drops
    // tag) always beats a broader one (Tags) on the same element
    if (d.length) for (const branch of part.sel.split(",")) out.push({ spec: specificity(branch), css: `${branch.trim()} { ${d.join("; ")}; }` });
  }
  // stable sort: equal specificity keeps general-before-specific list order
  return out.map((r, i) => ({ ...r, i })).sort((a, b) => a.spec - b.spec || a.i - b.i).map((r) => r.css).join("\n");
}

// CSS specificity of one simple selector branch, as one number (ids, then classes / attributes /
// pseudo-classes, then element names)
export function specificity(sel) {
  const s = String(sel).replace(/::[\w-]+/g, "");
  const ids = (s.match(/#[\w-]+/g) || []).length;
  const cls = (s.match(/\.[\w-]+|\[[^\]]*\]|:(?!:)[\w-]+/g) || []).length;
  const tags = (s.replace(/[#.][\w-]+|\[[^\]]*\]|:[\w-]+/g, " ").match(/(^|[\s>+~])[a-z][\w-]*/gi) || []).length;
  return ids * 10000 + cls * 100 + tags;
}
