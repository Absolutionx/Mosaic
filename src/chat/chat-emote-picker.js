// the emote picker: a composer button (#chat-emote-btn) opening a searchable grid of every
// available emote (Twitch/Kick global + 7TV/BTTV/FFZ) with a provider tab bar. mixed onto
// TwitchChat (see ../chat.js). reads this.sevenTvEmotes / this.twitchNativeEmotes fresh each
// render rather than snapshotting, since those maps change live and the picker is open briefly

import { EMOJI_GROUPS } from "../emoji-data.js";

// "All" plus one tab per source, per platform: the last tab is the platform's native global
// set (Twitch chat gets "Twitch", Kick "Kick"). order mirrors reach: channel emotes first,
// then the three providers, then native globals last
const EMOTE_PICKER_TABS_TWITCH = [
  { id: "all", label: "All" },
  { id: "channel", label: "Channel" },
  { id: "seventv", label: "7TV" },
  { id: "bttv", label: "BTTV" },
  { id: "ffz", label: "FFZ" },
  { id: "twitch", label: "Twitch" },
  { id: "emoji", label: "\uD83D\uDE00" },
];
const EMOTE_PICKER_TABS_KICK = [
  { id: "all", label: "All" },
  { id: "channel", label: "Channel" },
  { id: "seventv", label: "7TV" },
  { id: "bttv", label: "BTTV" },
  { id: "ffz", label: "FFZ" },
  { id: "kick", label: "Kick" },
  { id: "emoji", label: "\uD83D\uDE00" },
];

// section headers read better with more context than the tab labels ("7TV Global" vs "7TV")
const EMOTE_PICKER_SECTIONS = {
  channel: "Channel Emotes",
  seventv: "7TV Global",
  bttv: "BTTV Global",
  ffz: "FFZ Global",
  twitch: "Twitch Global",
  kick: "Kick Global",
  emoji: "Emoji",
};

function bucketForProvider(provider) {
  if (provider === "seventv-channel" || provider === "bttv-channel" ||
      provider === "ffz-channel" || provider === "kick-channel") return "channel";
  if (provider === "seventv-global") return "seventv";
  if (provider === "bttv-global") return "bttv";
  if (provider === "ffz-global") return "ffz";
  // Kick's Global + Emoji sets get their own shelf, like Twitch's native globals. folding them
  // into "channel" (the old way) bloated that bucket and stole the Kick tab slot
  if (provider === "kick-global") return "kick";
  return null;
}

export const chatEmotePickerMixin = {
  _initEmotePicker() {
    this.emoteBtn = this._emoteBtnEl;
    this._emotePickerMenu = this._emotePickerMenuEl;
    this._emotePickerTab = "all";
    this._emotePickerSearch = "";
    if (!this.emoteBtn || !this._emotePickerMenu) return; // absent in tests/older markup, call sites guard on this.emoteBtn

    this.emoteBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this._toggleEmotePicker();
    });

    // on mousedown so it fires before a composer click would re-focus
    document.addEventListener("mousedown", (e) => {
      if (!this._emotePickerMenu.classList.contains("open")) return;
      if (this._emotePickerMenu.contains(e.target)) return;
      if (this.emoteBtn.contains(e.target)) return;
      this._closeEmotePicker();
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this._emotePickerMenu.classList.contains("open")) {
        this._closeEmotePicker();
      }
    });

    // keep it pinned above the composer on resize, like the other flyouts
    window.addEventListener("resize", () => this._repositionEmotePicker());
  },

  _toggleEmotePicker() {
    if (this._emotePickerMenu.classList.contains("open")) this._closeEmotePicker();
    else this._openEmotePicker();
  },

  _openEmotePicker() {
    if (!this.emoteBtn || this.emoteBtn.disabled) return;
    // only one flyout above the composer at a time, close any open autocomplete first
    this._hideEmotePopup();
    this._emotePickerMenu.classList.add("open");
    this.emoteBtn.classList.add("open");
    this._renderEmotePicker();
    this._repositionEmotePicker();
  },

  _closeEmotePicker() {
    this._emotePickerMenu?.classList.remove("open");
    this.emoteBtn?.classList.remove("open");
  },

  _repositionEmotePicker() {
    const menu = this._emotePickerMenu;
    if (!menu || !this.inputEl || !menu.classList.contains("open")) return;
    // anchor to the whole input row, not just the textarea, so it matches the composer width and Send's right edge
    const rect = (this.inputEl.closest(".chat-input-row, .multiview-chat-input-row") || this.inputEl).getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) { this._closeEmotePicker(); return; }
    const menuHeight = menu.offsetHeight || 360;
    menu.style.left = rect.left + "px";
    menu.style.width = rect.width + "px";
    // prefer above the composer; if the window's too short, pin near the top instead of drifting off-screen
    const top = rect.top - menuHeight - 6;
    menu.style.top = (top >= 6 ? top : 6) + "px";
  },

  _collectEmotePickerBuckets() {
    const term = this._emotePickerSearch.trim().toLowerCase();
    const buckets = { channel: [], seventv: [], bttv: [], ffz: [], twitch: [], kick: [] };
    for (const [name, entry] of this.sevenTvEmotes) {
      if (term && !name.toLowerCase().includes(term)) continue;
      const bucket = bucketForProvider(entry.provider);
      if (bucket) buckets[bucket].push({ name, url: entry.url });
    }
    // Twitch native globals belong only in a Twitch chat's picker, but the map persists across a
    // platform swap (loaded once at startup), so gate on the session
    if (!this._isKickChat) {
      for (const [name, entry] of this.twitchNativeEmotes) {
        if (term && !name.toLowerCase().includes(term)) continue;
        buckets.twitch.push({ name, url: entry.url });
      }
    }
    for (const key of Object.keys(buckets)) {
      buckets[key].sort((a, b) => a.name.localeCompare(b.name));
    }
    return buckets;
  },

  // cheap enough on open + every tab switch that a targeted diff isn't worth it
  _renderEmotePicker() {
    const menu = this._emotePickerMenu;
    menu.innerHTML = "";

    const gridWrap = document.createElement("div");
    gridWrap.className = "emote-picker-grid-wrap";

    const tabs = document.createElement("div");
    tabs.className = "emote-picker-tabs";
    const tabList = this._isKickChat ? EMOTE_PICKER_TABS_KICK : EMOTE_PICKER_TABS_TWITCH;
    // the remembered tab can belong to the other platform's bar (used on Twitch, flipped, reopened
    // on Kick), so snap back to All if its button is gone
    if (!tabList.some((t) => t.id === this._emotePickerTab)) {
      this._emotePickerTab = "all";
    }
    for (const tab of tabList) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "emote-picker-tab" + (this._emotePickerTab === tab.id ? " active" : "");
      btn.textContent = tab.label;
      btn.title = tab.id === "all" ? "All emotes" : EMOTE_PICKER_SECTIONS[tab.id];
      btn.addEventListener("click", () => {
        this._emotePickerTab = tab.id;
        tabs.querySelectorAll(".emote-picker-tab").forEach(el => el.classList.remove("active"));
        btn.classList.add("active");
        this._renderEmoteGrid(gridWrap);
      });
      tabs.appendChild(btn);
    }

    const searchWrap = document.createElement("div");
    searchWrap.className = "emote-picker-search-wrap";
    const search = document.createElement("input");
    search.type = "text";
    search.className = "emote-picker-search-input";
    search.placeholder = "Search emotes…";
    search.value = this._emotePickerSearch;
    search.autocomplete = "off";
    search.spellcheck = false;
    search.addEventListener("input", () => {
      this._emotePickerSearch = search.value;
      this._renderEmoteGrid(gridWrap);
    });
    // a sibling input, not the composer: Enter mustn't send the message, and other keys stay local
    // instead of hitting the composer's history/autocomplete
    search.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { this._closeEmotePicker(); return; }
      e.stopPropagation();
    });
    searchWrap.appendChild(search);

    menu.appendChild(gridWrap);
    menu.appendChild(tabs);
    menu.appendChild(searchWrap);

    this._renderEmoteGrid(gridWrap);
    search.focus();
  },

  _renderEmoteGrid(gridWrap) {
    gridWrap.innerHTML = "";
    const q = this._emotePickerSearch.trim().toLowerCase();

    // dedicated emoji tab: standard Unicode emoji grouped by category
    if (this._emotePickerTab === "emoji") {
      this._renderEmojiSections(gridWrap, q);
      return;
    }

    const buckets = this._collectEmotePickerBuckets();
    const order = this._emotePickerTab === "all"
      ? (this._isKickChat
          ? ["channel", "seventv", "bttv", "ffz", "kick"]
          : ["channel", "seventv", "bttv", "ffz", "twitch"])
      : [this._emotePickerTab];
    const sections = order
      .map(id => [id, buckets[id]])
      .filter(([, rows]) => rows.length > 0);

    // when searching from "All", also surface matching Unicode emoji so search finds everything
    const emojiMatches = (this._emotePickerTab === "all" && q) ? this._emojiMatches(q) : [];

    if (sections.length === 0 && emojiMatches.length === 0) {
      const empty = document.createElement("div");
      empty.className = "emote-picker-empty";
      empty.textContent = this._emotePickerSearch.trim()
        ? "No emotes match your search."
        : "No emotes loaded for this channel yet.";
      gridWrap.appendChild(empty);
      return;
    }

    for (const [id, rows] of sections) {
      const section = document.createElement("div");
      section.className = "emote-picker-section";

      const title = document.createElement("div");
      title.className = "emote-picker-section-title";
      title.textContent = `${EMOTE_PICKER_SECTIONS[id]} · ${rows.length}`;
      section.appendChild(title);

      const grid = document.createElement("div");
      grid.className = "emote-picker-grid";
      for (const { name, url } of rows) {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "emote-picker-item";
        item.title = name;
        const img = document.createElement("img");
        img.src = url;
        img.alt = name;
        img.loading = "lazy";
        item.appendChild(img);
        item.addEventListener("click", () => this._insertEmoteAtCursor(name));
        grid.appendChild(item);
      }
      section.appendChild(grid);
      gridWrap.appendChild(section);
    }

    if (emojiMatches.length) gridWrap.appendChild(this._makeEmojiSection("Emoji", emojiMatches));
  },

  _renderEmojiSections(gridWrap, q) {
    let any = false;
    for (const g of EMOJI_GROUPS) {
      const list = q ? g.emojis.filter(([, name]) => name.toLowerCase().includes(q)) : g.emojis;
      if (!list.length) continue;
      any = true;
      gridWrap.appendChild(this._makeEmojiSection(g.name, list));
    }
    if (!any) {
      const empty = document.createElement("div");
      empty.className = "emote-picker-empty";
      empty.textContent = "No emoji match your search.";
      gridWrap.appendChild(empty);
    }
  },

  _makeEmojiSection(title, list) {
    const section = document.createElement("div");
    section.className = "emote-picker-section";
    const t = document.createElement("div");
    t.className = "emote-picker-section-title";
    t.textContent = `${title} · ${list.length}`;
    section.appendChild(t);
    const grid = document.createElement("div");
    grid.className = "emote-picker-grid emote-picker-grid-emoji";
    for (const [emoji, name] of list) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "emote-picker-item emote-picker-emoji-item";
      item.title = name;
      item.textContent = emoji;
      item.addEventListener("click", () => this._insertEmoteAtCursor(emoji));
      grid.appendChild(item);
    }
    section.appendChild(grid);
    return section;
  },

  _emojiMatches(q) {
    const out = [];
    for (const g of EMOJI_GROUPS) {
      for (const e of g.emojis) {
        if (e[1].toLowerCase().includes(q)) {
          out.push(e);
          if (out.length >= 60) return out;
        }
      }
    }
    return out;
  },

  // pad with spaces only where needed. distinct from _commitEmoteByName (chat-emotes.js), which
  // REPLACES the partial word being autocompleted
  _insertEmoteAtCursor(name) {
    const input = this.inputEl;
    if (!input) return;
    const val = input.value;
    const pos = input.selectionStart ?? val.length;
    const needsLeadingSpace = pos > 0 && val[pos - 1] !== " ";
    const needsTrailingSpace = pos >= val.length || val[pos] !== " ";
    const insertText = (needsLeadingSpace ? " " : "") + name + (needsTrailingSpace ? " " : "");
    input.value = val.slice(0, pos) + insertText + val.slice(pos);
    const newPos = pos + insertText.length;
    input.setSelectionRange(newPos, newPos);
    // fires the input listener (chat.js) that toggles .has-text and drives Send, a plain assignment doesn't dispatch it
    input.dispatchEvent(new Event("input", { bubbles: true }));
    this._autosizeChatInput();
    input.focus();
  },
};
