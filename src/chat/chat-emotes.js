// emote loading, parsing, rendering, and the autocomplete popup. mixed onto TwitchChat (see ../chat.js)
import { invoke } from "@tauri-apps/api/core";
import { SEVENTV_API_BASE, BTTV_API_BASE } from "./shared.js";
import {
  parseTwitchEmotesTag,
  parseCheermoteWord,
  parseKickEmoteMarker,
  pickEmoteUrl,
  EMOTE_PROVIDER_PRIORITY,
  isChannelProvider,
} from "./emote-parsing.js";

// 7TV's zero-width (overlay) flag is bit 8 (256) on the ActiveEmote, NOT bit 1, a known
// gotcha (night/betterttv#5925). it can appear on the wrapper's `flags` and/or nested
// `data.flags`, so OR both. checking `& 1` renders Fog0/CiGrip side-by-side instead of overlaid
const SEVENTV_ZERO_WIDTH_FLAG = 1 << 8;
const isSevenTvZeroWidth = (emote) =>
  Boolean(((emote?.flags ?? 0) | (emote?.data?.flags ?? 0)) & SEVENTV_ZERO_WIDTH_FLAG);

// unlike 7TV, BTTV exposes no per-emote flag, so overlay emotes are recognized by name
// against this fixed list (as BTTV's own frontend does), rendered ON TOP of the preceding emote
const BTTV_ZERO_WIDTH_EMOTES = new Set([
  "SoSnowy",
  "IceCold",
  "SantaHat",
  "TopHat",
  "ReinDeer",
  "CandyCane",
  "cvMask",
  "cvHazmat",
]);

export const chatEmotesMixin = {
  // thin wrappers over emote-parsing.js, kept as methods so render code can call this.parseTwitchEmotesTag() etc
  parseTwitchEmotesTag(message, emotesTag) {
    return parseTwitchEmotesTag(message, emotesTag);
  },

  parseCheermote(word) {
    return parseCheermoteWord(word, this.cheermoteMap);
  },

  parseKickEmoteMarker(word) {
    return parseKickEmoteMarker(word);
  },

  pickEmoteUrl(host) {
    return pickEmoteUrl(host);
  },

  // single write-path for every third-party emote into this.sevenTvEmotes. applies
  // EMOTE_PROVIDER_PRIORITY so a name collision resolves the same way every session, not by
  // whichever fire-and-forget fetch finished last. a same-provider write always goes through
  _setEmote(name, entry, provider) {
    const existing = this.sevenTvEmotes.get(name);
    if (existing && existing.provider !== provider &&
        (EMOTE_PROVIDER_PRIORITY[provider] ?? 0) < (EMOTE_PROVIDER_PRIORITY[existing.provider] ?? 0)) {
      return; // a higher-priority provider already owns this name
    }
    this.sevenTvEmotes.set(name, { ...entry, provider });
  },

  // remove channel-level emotes, keep globals. connect() clears everything on a live switch,
  // but setVodMode() only goes through disconnect() (which doesn't), so a VOD opened after a
  // live channel kept that channel's emotes. globals are re-fetched anyway (idempotent)
  _clearChannelEmotes() {
    for (const [name, entry] of this.sevenTvEmotes) {
      if (isChannelProvider(entry.provider)) this.sevenTvEmotes.delete(name);
    }
  },

  async loadSevenTvGlobalEmotes() {
    try {
      const res = await fetch(`${SEVENTV_API_BASE}/emote-sets/global`);
      if (!res.ok) {
        console.warn("[7tv] Global emote-set fetch failed:", res.status);
        return;
      }
      const data = await res.json();
      const countBefore = this.sevenTvEmotes.size;
      this.ingestEmoteSet(data, "seventv-global");
      console.log(`Loaded ${this.sevenTvEmotes.size - countBefore} 7TV global emotes.`);
    } catch (err) {
      console.warn("Failed to load 7TV global emotes:", err);
    }
  },

  async loadSevenTvChannelEmotes(twitchUserId) {
    try {
      const res = await fetch(`${SEVENTV_API_BASE}/users/twitch/${twitchUserId}`);
      if (!res.ok) {
        if (res.status === 404) {
          // informational, not a warning: usually the channel just has no 7TV profile. logged so a
          // channel emote not rendering can be told from "no 7TV profile" vs a real failure
          console.log(`[7tv] No 7TV profile for user id ${twitchUserId} (404) - channel likely hasn't set one up.`);
        } else {
          console.warn("7TV channel lookup failed:", res.status);
        }
        return;
      }
      const data = await res.json();
      if (data.emote_set) {
        this.ingestEmoteSet(data.emote_set, "seventv-channel");
        this.systemLine(`Loaded ${data.emote_set.emotes?.length ?? 0} 7TV emotes for this channel.`);
        // subscribe to this set's changes so mid-stream additions/removals (a channel-points emote)
        // show live, not just the set at fetch time. emote_set.id is the SET's id (distinct from the
        // twitchUserId we looked up BY), which is what 7TV's EventAPI needs as object_id
        if (data.emote_set.id) {
          invoke("start_seventv_events", { emoteSetId: data.emote_set.id }).catch((err) => {
            console.warn("Failed to start 7TV live emote updates:", err);
          });
        }
      } else {
        console.log(`[7tv] User id ${twitchUserId} has a 7TV profile but no emote_set in the response:`, JSON.stringify(data));
      }
    } catch (err) {
      console.warn("Failed to load 7TV channel emotes:", err);
    }
  },

  // 7TV supports Kick first-class, same lookup as Twitch just /users/kick/{kick user id}.
  // BTTV/FFZ have no Kick support, so no Kick counterparts (their globals still load in Kick chat)
  async loadSevenTvKickChannelEmotes(kickUserId) {
    try {
      const res = await fetch(`${SEVENTV_API_BASE}/users/kick/${kickUserId}`);
      if (!res.ok) {
        if (res.status === 404) {
          console.log(`[7tv] No 7TV profile for Kick user id ${kickUserId} (404) - channel likely hasn't linked Kick on 7TV.`);
        } else {
          console.warn("7TV Kick channel lookup failed:", res.status);
        }
        return;
      }
      const data = await res.json();
      if (data.emote_set) {
        this.ingestEmoteSet(data.emote_set, "seventv-channel");
        this.systemLine(`Loaded ${data.emote_set.emotes?.length ?? 0} 7TV emotes for this channel.`);
        // same live-update subscription as the Twitch loader, the EventAPI is keyed on the SET id which is platform-agnostic
        if (data.emote_set.id) {
          invoke("start_seventv_events", { emoteSetId: data.emote_set.id }).catch((err) => {
            console.warn("Failed to start 7TV live emote updates:", err);
          });
        }
      } else {
        console.log(`[7tv] Kick user id ${kickUserId} has a 7TV profile but no emote_set in the response.`);
      }
    } catch (err) {
      console.warn("Failed to load 7TV Kick channel emotes:", err);
    }
  },

  // the channel's native Kick emotes (its set + Kick's Global/Emoji sets) via Rust, since
  // kick.com is Cloudflare-fronted. kick_chat.rs flattens inline [emote:id:name] tokens to
  // names; ingesting name -> CDN-url here turns them back into images in the same render path
  async loadKickNativeEmotes(slug) {
    try {
      const emotes = JSON.parse(await invoke("kick_channel_emotes", { slug }));
      let channelCount = 0;
      let globalCount = 0;
      for (const e of emotes) {
        if (!e?.id || !e?.name) continue;
        const url = `https://files.kick.com/emotes/${e.id}/fullsize`;
        this._setEmote(e.name, { url, zeroWidth: false }, e.global ? "kick-global" : "kick-channel");
        if (e.global) globalCount++;
        else channelCount++;
      }
      if (channelCount > 0) this.systemLine(`Loaded ${channelCount} Kick emotes for this channel.`);
      if (globalCount > 0) console.log(`Loaded ${globalCount} Kick global emotes.`);
    } catch (err) {
      console.warn("Failed to load Kick native emotes:", err);
    }
  },

  async loadBttvGlobalEmotes() {
    try {
      const res = await fetch(`${BTTV_API_BASE}/cached/emotes/global`);
      if (!res.ok) return;
      const emotes = await res.json();
      let count = 0;
      for (const emote of emotes) {
        // BTTV CDN: https://cdn.betterttv.net/emote/<id>/2x.<ext>
        const ext = emote.imageType || "png";
        const url = `https://cdn.betterttv.net/emote/${emote.id}/2x.${ext}`;
        this._setEmote(emote.code, { url, zeroWidth: BTTV_ZERO_WIDTH_EMOTES.has(emote.code) }, "bttv-global");
        count++;
      }
      console.log(`Loaded ${count} BTTV global emotes.`);
    } catch (err) {
      console.warn("Failed to load BTTV global emotes:", err);
    }
  },

  // same numeric-user-id requirement as loadSevenTvChannelEmotes; 404 just means no BTTV page
  async loadBttvChannelEmotes(twitchUserId) {
    try {
      const res = await fetch(`${BTTV_API_BASE}/cached/users/twitch/${twitchUserId}`);
      if (!res.ok) {
        if (res.status === 404) {
          console.log(`[bttv] No BTTV user for id ${twitchUserId} (404) - channel likely has no BTTV emotes.`);
        } else {
          console.warn("BTTV channel lookup failed:", res.status);
        }
        return;
      }
      const data = await res.json();
      const emotes = [...(data.channelEmotes || []), ...(data.sharedEmotes || [])];
      let count = 0;
      for (const emote of emotes) {
        if (!emote?.id || !emote?.code) continue;
        const ext = emote.imageType || "png";
        const url = `https://cdn.betterttv.net/emote/${emote.id}/2x.${ext}`;
        this._setEmote(emote.code, { url, zeroWidth: BTTV_ZERO_WIDTH_EMOTES.has(emote.code) }, "bttv-channel");
        count++;
      }
      if (count > 0) this.systemLine(`Loaded ${count} BTTV emotes for this channel.`);
    } catch (err) {
      console.warn("Failed to load BTTV channel emotes:", err);
    }
  },

  // BTTV's cached FFZ endpoints return FFZ emotes in a BTTV-like flat array. using BTTV's
  // mirror keeps all third-party emote traffic on the one API base known to work from the
  // webview. 2x/4x can be null, so fall through sizes
  _ingestFfzEmotes(emotes, provider) {
    let count = 0;
    for (const emote of emotes || []) {
      const images = emote?.images || {};
      const url = images["2x"] || images["4x"] || images["1x"];
      if (!url || !emote.code) continue;
      this._setEmote(emote.code, { url, zeroWidth: false }, provider);
      count++;
    }
    return count;
  },

  // FFZ was previously not loaded at all, which is why common FFZ emotes (LOLW/KEKW, both FFZ
  // channel emotes) rendered as plain text
  async loadFfzGlobalEmotes() {
    try {
      const res = await fetch(`${BTTV_API_BASE}/cached/frankerfacez/emotes/global`);
      if (!res.ok) {
        console.warn("[ffz] Global emote fetch failed:", res.status);
        return;
      }
      const count = this._ingestFfzEmotes(await res.json(), "ffz-global");
      console.log(`Loaded ${count} FFZ global emotes.`);
    } catch (err) {
      console.warn("Failed to load FFZ global emotes:", err);
    }
  },

  // same numeric-id requirement and 404-is-normal semantics as the other channel loaders
  async loadFfzChannelEmotes(twitchUserId) {
    try {
      const res = await fetch(`${BTTV_API_BASE}/cached/frankerfacez/users/twitch/${twitchUserId}`);
      if (!res.ok) {
        if (res.status === 404) {
          console.log(`[ffz] No FFZ room for id ${twitchUserId} (404) - channel likely has no FFZ emotes.`);
        } else {
          console.warn("FFZ channel lookup failed:", res.status);
        }
        return;
      }
      const count = this._ingestFfzEmotes(await res.json(), "ffz-channel");
      if (count > 0) this.systemLine(`Loaded ${count} FFZ emotes for this channel.`);
    } catch (err) {
      console.warn("Failed to load FFZ channel emotes:", err);
    }
  },

  // via Rust, same WebView2 cross-origin issue as badges/cheermotes. populates twitchNativeEmotes,
  // which renderMessageBody() falls back to when a message has no IRC emotes tag, and which
  // autocomplete searches
  async loadTwitchGlobalEmotes() {
    try {
      const json = await invoke("fetch_global_emotes");
      const data = JSON.parse(json);
      let count = 0;
      for (const emote of data.data ?? []) {
        const images = emote.images || {};
        const url = images.url_4x || images.url_2x || images.url_1x;
        if (!url) continue;
        this.twitchNativeEmotes.set(emote.name, { id: emote.id, url });
        count++;
      }
      console.log(`Loaded ${count} Twitch global emotes.`);
    } catch (err) {
      console.warn("Failed to load Twitch global emotes:", err);
    }
  },

  // Helix shape { data: [{ prefix, tiers: [...] }] }. prefers dark/animated/2x images to match the theme
  ingestCheermotes(data) {
    if (!Array.isArray(data?.data)) return;
    for (const cheermote of data.data) {
      const prefix = cheermote.prefix?.toLowerCase();
      if (!prefix) continue;
      const tiers = (cheermote.tiers || [])
        .filter(t => t.can_cheer)
        .map(t => ({
          minBits: t.min_bits,
          color:   t.color || "#9147ff",
          url:     t.images?.dark?.animated?.["2"]
                || t.images?.dark?.animated?.["1"]
                || t.images?.dark?.static?.["2"]
                || t.images?.dark?.static?.["1"]
                || "",
        }))
        .filter(t => t.url)
        .sort((a, b) => b.minBits - a.minBits); // descending, see parseCheermote
      if (tiers.length) this.cheermoteMap.set(prefix, tiers);
    }
  },

  _updateEmotePopup() {
    const { word } = this._currentEmoteWord();
    if (!word || word.length < 2) {
      this._hideEmotePopup();
      return;
    }
    const lower = word.toLowerCase();
    // prefix matches first, capped at 12. same platform gate as the picker: Twitch native globals
    // aren't suggestable in a Kick chat (they'd send text that renders unresolved for everyone)
    const all = this._isKickChat
      ? [...this.sevenTvEmotes.keys()]
      : [...this.sevenTvEmotes.keys(), ...this.twitchNativeEmotes.keys()];
    const prefix = all.filter(n => n.toLowerCase().startsWith(lower));
    const contains = all.filter(n =>
      !n.toLowerCase().startsWith(lower) && n.toLowerCase().includes(lower));
    const matches = [...prefix, ...contains].slice(0, 12);

    if (matches.length === 0) {
      this._hideEmotePopup();
      return;
    }
    this._showEmotePopup(matches);
  },

  _currentEmoteWord() {
    const input = this.inputEl;
    if (!input) return { word: "", wordStart: 0, wordEnd: 0 };
    const pos = input.selectionStart ?? input.value.length;
    const val = input.value;
    let start = pos;
    while (start > 0 && val[start - 1] !== " ") start--;
    let end = pos;
    while (end < val.length && val[end] !== " ") end++;
    const word = val.slice(start, end);
    return { word, wordStart: start, wordEnd: end };
  },

  _showEmotePopup(names) {
    const popup = this._emotePopup;
    popup.innerHTML = "";
    this._emotePopupIndex = -1;

    for (let i = 0; i < names.length; i++) {
      const name = names[i];
      const emote = this.sevenTvEmotes.get(name);
      const twitchEmote = !emote ? this.twitchNativeEmotes.get(name) : null;
      const item = document.createElement("div");
      item.className = "emote-autocomplete-item";
      item.dataset.name = name;

      if (emote) {
        const img = document.createElement("img");
        img.src = emote.url;
        img.alt = name;
        img.className = "emote-autocomplete-img";
        item.appendChild(img);
      } else if (twitchEmote) {
        const img = document.createElement("img");
        img.src = twitchEmote.url;
        img.alt = name;
        img.className = "emote-autocomplete-img";
        item.appendChild(img);
      }
      const label = document.createElement("span");
      label.textContent = name;
      item.appendChild(label);

      item.addEventListener("mousedown", (e) => {
        e.preventDefault(); // prevent blur before commit
        this._commitEmoteByName(name);
      });
      popup.appendChild(item);
    }
    popup.style.display = "block";

    // after display:block so it has a measurable height
    this._repositionPopup();

    // select the first item so Tab/Enter immediately commits
    this._setEmoteSelection(0);
  },

  _repositionPopup() {
    if (!this.inputEl || this._emotePopup.style.display === "none") return;
    const rect = this.inputEl.getBoundingClientRect();
    // if the input is hidden or not laid out its rect is zero-sized, and positioning at (0,0)
    // would strand the popup in the top-left over the nav bar
    if (rect.width === 0 || rect.height === 0) {
      this._hideEmotePopup();
      return;
    }
    const popupHeight = this._emotePopup.offsetHeight;
    this._emotePopup.style.position = "fixed";
    this._emotePopup.style.left = rect.left + "px";
    this._emotePopup.style.width = rect.width + "px";
    // prefer above the input, fall back to below if there's not enough room
    if (rect.top - popupHeight - 6 >= 0) {
      this._emotePopup.style.top = (rect.top - popupHeight - 6) + "px";
      this._emotePopup.style.bottom = "";
    } else {
      this._emotePopup.style.top = (rect.bottom + 6) + "px";
      this._emotePopup.style.bottom = "";
    }
  },

  _hideEmotePopup() {
    this._emotePopup.style.display = "none";
    this._emotePopupIndex = -1;
  },

  _moveEmoteSelection(delta) {
    const items = this._emotePopup.querySelectorAll(".emote-autocomplete-item");
    const next = Math.max(0, Math.min(items.length - 1,
      this._emotePopupIndex + delta));
    this._setEmoteSelection(next);
  },

  _setEmoteSelection(index) {
    const items = this._emotePopup.querySelectorAll(".emote-autocomplete-item");
    items.forEach((el, i) => el.classList.toggle("selected", i === index));
    this._emotePopupIndex = index;
    items[index]?.scrollIntoView({ block: "nearest" });
  },

  _commitEmoteSelection() {
    const items = this._emotePopup.querySelectorAll(".emote-autocomplete-item");
    const selected = items[this._emotePopupIndex];
    if (!selected) { this._hideEmotePopup(); return; }
    if (this._popupMode === "user") this._commitUserByName(selected.dataset.name);
    else this._commitEmoteByName(selected.dataset.name);
  },

  _commitEmoteByName(name) {
    const input = this.inputEl;
    if (!input) return;
    const { wordStart, wordEnd } = this._currentEmoteWord();
    const val = input.value;
    input.value = val.slice(0, wordStart) + name + " " + val.slice(wordEnd);
    this._autosizeChatInput();
    const newPos = wordStart + name.length + 1;
    input.setSelectionRange(newPos, newPos);
    this._hideEmotePopup();
    input.focus();
    // used to re-run _updateEmotePopup() here, but that's the auto-open behavior this feature was
    // changed to NOT do: the cursor now sits after a trailing space, so it risked reopening
    // suggestions with no Tab press. opening happens only via Tab now
  },

  ingestEmoteSet(emoteSet, provider) {
    if (!emoteSet || !Array.isArray(emoteSet.emotes)) return;
    for (const emote of emoteSet.emotes) {
      const host = emote.data?.host;
      const url = this.pickEmoteUrl(host);
      if (!url) {
        // rare, most emotes have a valid host.url. logged once per emote so a missing one can be identified, not silently dropped
        console.warn(`[7tv] Skipping emote "${emote.name}" - no usable host.url. host:`, JSON.stringify(host));
        continue;
      }
      this._setEmote(emote.name, {
        url,
        zeroWidth: isSevenTvZeroWidth(emote),
      }, provider);
    }
  },

  // real-time counterpart to the one-time fetch at join. payload.added entries are individual
  // emote objects (flat, not wrapped) merged directly; payload.removed entries need only .name
  _applySevenTvEmoteSetUpdate(payload) {
    const added = Array.isArray(payload?.added) ? payload.added : [];
    const removed = Array.isArray(payload?.removed) ? payload.removed : [];

    for (const emote of added) {
      const host = emote.data?.host;
      const url = this.pickEmoteUrl(host);
      if (!url || !emote.name) {
        console.warn(`[7tv] Skipping live-added emote "${emote.name}" - no usable host.url. host:`, JSON.stringify(host));
        continue;
      }
      this._setEmote(emote.name, {
        url,
        zeroWidth: isSevenTvZeroWidth(emote),
      }, "seventv-channel");
    }
    for (const emote of removed) {
      // only delete if this provider owns it: a same-named emote from another provider (which
      // _setEmote's precedence may have let 7TV shadow) shouldn't vanish because 7TV removed ITS
      // emote. the shadowed one isn't restored until its loader next runs (channel switch), accepted as rare
      if (emote.name && this.sevenTvEmotes.get(emote.name)?.provider === "seventv-channel") {
        this.sevenTvEmotes.delete(emote.name);
      }
    }

    // mirrors the systemLine() the initial load posts, so a temporary emote appearing/disappearing mid-stream is as visible as the batch load
    for (const emote of added) {
      if (emote.name) this.systemLine(`7TV emote added: ${emote.name}`);
    }
    for (const emote of removed) {
      if (emote.name) this.systemLine(`7TV emote removed: ${emote.name}`);
    }
  },

};
