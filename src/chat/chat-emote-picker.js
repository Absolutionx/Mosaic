// Part of TwitchChat (see ../chat.js): the emote picker - a composer button (#chat-emote-btn) opening a searchable grid of every available emote (Twitch/Kick global + 7TV/BTTV/FFZ), with a provider tab bar. Mixin merged onto
// TwitchChat.prototype, so `this` is the chat instance; split by feature for readability.
// Reads this.sevenTvEmotes / this.twitchNativeEmotes fresh each render rather than
// snapshotting: those maps change live and the picker is only open briefly.

/** Tab bars along the picker bottom - "All" plus one per source, PER PLATFORM: the last
 *  tab is the platform's native global set (Twitch chat gets "Twitch", Kick "Kick"). Order
 *  mirrors reach: channel emotes first, then the three providers, then native globals last. */
const EMOTE_PICKER_TABS_TWITCH = [
  { id: "all", label: "All" },
  { id: "channel", label: "Channel" },
  { id: "seventv", label: "7TV" },
  { id: "bttv", label: "BTTV" },
  { id: "ffz", label: "FFZ" },
  { id: "twitch", label: "Twitch" },
];
const EMOTE_PICKER_TABS_KICK = [
  { id: "all", label: "All" },
  { id: "channel", label: "Channel" },
  { id: "seventv", label: "7TV" },
  { id: "bttv", label: "BTTV" },
  { id: "ffz", label: "FFZ" },
  { id: "kick", label: "Kick" },
];

/** Section labels above each provider's grid in the "All" tab - distinct from the tab
 *  labels since a header reads better with more context ("7TV Global" vs "7TV"). */
const EMOTE_PICKER_SECTIONS = {
  channel: "Channel Emotes",
  seventv: "7TV Global",
  bttv: "BTTV Global",
  ffz: "FFZ Global",
  twitch: "Twitch Global",
  kick: "Kick Global",
};

function bucketForProvider(provider) {
  if (provider === "seventv-channel" || provider === "bttv-channel" ||
      provider === "ffz-channel" || provider === "kick-channel") return "channel";
  if (provider === "seventv-global") return "seventv";
  if (provider === "bttv-global") return "bttv";
  if (provider === "ffz-global") return "ffz";
  // Kick's Global + Emoji sets get their own shelf, like Twitch's native globals -
  // previously folded into "channel", which bloated that bucket and took the Kick tab slot.
  if (provider === "kick-global") return "kick";
  return null;
}

export const chatEmotePickerMixin = {
  /** Wires up the button + flyout. Called once from the constructor. */
  _initEmotePicker() {
    this.emoteBtn = this._emoteBtnEl;
    this._emotePickerMenu = this._emotePickerMenuEl;
    this._emotePickerTab = "all";
    this._emotePickerSearch = "";
    if (!this.emoteBtn || !this._emotePickerMenu) return; // absent in tests/older markup; call sites guard on this.emoteBtn

    this.emoteBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this._toggleEmotePicker();
    });

    // Outside click closes it (like quality-menu/user-menu). On mousedown so it fires before
    // a composer click would re-focus.
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

    // Keep it pinned above the composer on resize, like the other flyouts.
    window.addEventListener("resize", () => this._repositionEmotePicker());
  },

  _toggleEmotePicker() {
    if (this._emotePickerMenu.classList.contains("open")) this._closeEmotePicker();
    else this._openEmotePicker();
  },

  _openEmotePicker() {
    if (!this.emoteBtn || this.emoteBtn.disabled) return;
    // Only one flyout above the composer at a time - close any open autocomplete first.
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
    // Anchor to the whole input row (not just the textarea) so the panel matches the
    // composer's width and the Send button's right edge.
    const rect = (this.inputEl.closest(".chat-input-row, .multiview-chat-input-row") || this.inputEl).getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) { this._closeEmotePicker(); return; }
    const menuHeight = menu.offsetHeight || 360;
    menu.style.left = rect.left + "px";
    menu.style.width = rect.width + "px";
    // Prefer above the composer; if the window's too short, pin near the top instead of
    // drifting off-screen.
    const top = rect.top - menuHeight - 6;
    menu.style.top = (top >= 6 ? top : 6) + "px";
  },

  /** Groups every known emote by picker bucket, applying the search filter. Returns
   * {channel, seventv, bttv, ffz, twitch}, each an array of {name, url} sorted alphabetically. */
  _collectEmotePickerBuckets() {
    const term = this._emotePickerSearch.trim().toLowerCase();
    const buckets = { channel: [], seventv: [], bttv: [], ffz: [], twitch: [], kick: [] };
    for (const [name, entry] of this.sevenTvEmotes) {
      if (term && !name.toLowerCase().includes(term)) continue;
      const bucket = bucketForProvider(entry.provider);
      if (bucket) buckets[bucket].push({ name, url: entry.url });
    }
    // Twitch native globals belong only in a Twitch chat's picker - the map persists across
    // a platform swap (loaded once at startup), so gate on the session.
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

  /** Full (re)render: search box, tabs, and grid. Called on open and every tab switch -
   * cheap enough that a targeted diff isn't worth it. */
  _renderEmotePicker() {
    const menu = this._emotePickerMenu;
    menu.innerHTML = "";

    const gridWrap = document.createElement("div");
    gridWrap.className = "emote-picker-grid-wrap";

    const tabs = document.createElement("div");
    tabs.className = "emote-picker-tabs";
    const tabList = this._isKickChat ? EMOTE_PICKER_TABS_KICK : EMOTE_PICKER_TABS_TWITCH;
    // The remembered tab can belong to the other platform's bar (used on Twitch, flipped,
    // reopened on Kick) - snap back to All if its button is gone.
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
    // A sibling input, not the composer - Enter shouldn't send the chat message, and other
    // keys stay local instead of hitting the composer's history/autocomplete.
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

  /** Renders just the grid for the current tab + search term, without touching the
   * tabs/search box - called on every keystroke and tab switch. */
  _renderEmoteGrid(gridWrap) {
    gridWrap.innerHTML = "";
    const buckets = this._collectEmotePickerBuckets();
    const order = this._emotePickerTab === "all"
      ? (this._isKickChat
          ? ["channel", "seventv", "bttv", "ffz", "kick"]
          : ["channel", "seventv", "bttv", "ffz", "twitch"])
      : [this._emotePickerTab];
    const sections = order
      .map(id => [id, buckets[id]])
      .filter(([, rows]) => rows.length > 0);

    if (sections.length === 0) {
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
  },

  /** Inserts `name` at the cursor, padding with spaces only where needed - distinct from
   * _commitEmoteByName (chat-emotes.js), which REPLACES the partial word being autocompleted. */
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
    // Fires the "input" listener (chat.js) that toggles .has-text and drives the Send button
    // - a plain value assignment doesn't dispatch it.
    input.dispatchEvent(new Event("input", { bubbles: true }));
    this._autosizeChatInput();
    input.focus();
  },
};
