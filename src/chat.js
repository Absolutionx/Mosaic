// Twitch chat: connection lifecycle and the message render pipeline. the IRC WebSocket lives in
// Rust (chat.rs), WebView2's Tracking Prevention silently killed it in this webview. this file is
// TwitchChat's core (start/stop, the chat-* listeners, send/render); emotes, badges, AutoMod, user
// cards, moderation, link previews, autocomplete, and VOD replay are mixed in from src/chat/

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { loadFilter } from "./chat-filter.js";
import { clearModLog } from "./mod-log.js";
import { chatEmotesMixin } from "./chat/chat-emotes.js";
import { chatEmotePickerMixin } from "./chat/chat-emote-picker.js";
import { chatVodReplayMixin } from "./chat/chat-vod-replay.js";
import { chatBadgesMixin } from "./chat/chat-badges.js";
import { chatAutomodMixin } from "./chat/chat-automod.js";
import { chatUserCardMixin } from "./chat/chat-usercard.js";
import { chatModActionsMixin } from "./chat/chat-mod-actions.js";
import { chatLinkPreviewMixin } from "./chat/chat-link-preview.js";
import { chatAutocompleteMixin } from "./chat/chat-autocomplete.js";
import { chatEventsMixin } from "./chat/chat-events.js";
import { looksLikeUrl, USER_CARD_HISTORY_LIMIT } from "./chat/shared.js";

// must match .chat-input's max-height in index.html, duplicated (not read via getComputedStyle) since _autosizeChatInput() needs it every keystroke
const CHAT_INPUT_MAX_HEIGHT_PX = 120;
// ASCII-art detection helpers (see _isAsciiArt)
const ASCII_ART_MIN_GRAPHEMES = 40;
const ART_SYMBOL_RE = /[\p{So}\p{Sk}]/u;
let _graphemeSegmenter = null;
function graphemeSegmenter() {
  if (!_graphemeSegmenter) _graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  return _graphemeSegmenter;
}

// Keeps chat art scaled to fit the chat column. One shared ResizeObserver watches each art block's
// outer box (full chat width): it fits when the block is first laid out (so it works even if the chat
// was hidden or the line was built off-DOM) and again whenever the column width changes. The inner box
// is what gets zoomed; `zoom` scales without re-wrapping, so rows stay intact.
let _artFitObserver = null;
function fitArt(outer) {
  const inner = outer._artInner;
  const avail = outer.clientWidth;
  if (!inner || !avail || avail === outer._artLastAvail) return;
  outer._artLastAvail = avail;
  inner.style.zoom = "1";
  const natural = inner.offsetWidth;
  inner.style.zoom = natural > avail ? String(Math.floor((avail / natural) * 1000) / 1000) : "1";
}
function observeArtFit(outer, inner) {
  outer._artInner = inner;
  if (!_artFitObserver) {
    _artFitObserver = new ResizeObserver((entries) => {
      for (const e of entries) {
        // trimmed/removed lines: stop watching so they can be garbage-collected
        if (!e.target.isConnected) { _artFitObserver.unobserve(e.target); continue; }
        fitArt(e.target);
      }
    });
  }
  _artFitObserver.observe(outer);
}

export class TwitchChat {
  constructor({ container, statusEl, inputEl, sendBtn, emoteBtn, emotePickerMenu, inputBadge, jumpToLatestBtn, jumpToLatestCount } = {}) {
    this.container = container;
    this.statusEl = statusEl;
    this.inputEl = inputEl;
    this.sendBtn = sendBtn;
    // passed in so a second chat (MultiView) owns its own set instead of fighting over global IDs. falls back to the main chat's elements by ID
    this._emoteBtnEl = emoteBtn ?? document.getElementById("chat-emote-btn");
    this._emotePickerMenuEl = emotePickerMenu ?? document.getElementById("emote-picker-menu");
    this._inputBadgeEl = inputBadge ?? document.getElementById("chat-input-badge");
    this._jumpToLatestBtnEl = jumpToLatestBtn ?? null;
    this._jumpToLatestCountEl = jumpToLatestCount ?? null;
    this.channel = null;
    this.isLoggedIn = false;
    this.ownLogin = null;
    this.ownDisplayName = null;
    this.ownUserId = null;
    // true while showing VOD replay (read-only, no connection to send to), so the input row is hidden. set in setVodMode(), cleared in connect()
    this._isVodMode = false;
    // true while showing Kick chat. sendMessage() branches on this to POST via kick_send_chat_message instead of the Twitch command
    this._isKickChat = false;
    // required to send; null keeps Kick chat read-only even when logged in
    this._kickBroadcasterId = null;
    // the Kick channel's custom subscriber badge tiers ([{months, src}]), renderBadges months-matches kick/subscriber/N against these. empty = generic badge
    this._kickSubscriberBadges = [];
    // Kick login state, separate from Twitch's isLoggedIn (a user can have either, both, or neither)
    this._kickLoggedIn = false;
    this._kickLogin = null;
    // whether this build can offer Kick login at all, set by main.js once the async startup check lands
    this._kickOAuthConfigured = false;
    // no-op until setVodMode() installs the real one, so calling it is always safe even before a VOD has loaded
    this.notifyVodSeek = () => {};
    // account-level chat color (USERSTATE color tag), used by the local echo. account-wide, so unlike _ownBadgesTag it's never reset on channel switch
    this._ownColor = null;
    // whether the user is a mod OR broadcaster of the CURRENT channel, what every mod-tools element gates on. derived from the USERSTATE badges tag, the same info Twitch's IRC server uses, so no separate Helix lookup
    this.isMod = false;
    // called when isMod changes, so main.js (which owns the hover-icon/menu DOM) can re-render without chat.js knowing that DOM
    this._modStatusListeners = [];
    // held messages awaiting Allow/Deny, newest last. cleared on every connect()
    this._automodQueue = [];
    // userId -> message count this session, for the user card. reset on connect()
    this._messageCountByUserId = new Map();
    // userId -> recent message log for the user card, capped at USER_CARD_HISTORY_LIMIT (oldest dropped)
    this._messageHistoryByUserId = new Map();
    // userId -> cached Helix /users result (null = lookup failed), so reopening a card doesn't refetch
    this._userInfoCache = new Map();
    this.sevenTvEmotes      = new Map(); // 7TV/BTTV/FFZ: name -> {url, zeroWidth, provider}, written only via _setEmote (chat-emotes.js), which enforces provider precedence
    this.twitchNativeEmotes = new Map(); // Twitch global: name -> {id, url}
    // user-defined message filter (emotes/words/phrases); compiled once here and on every edit via
    // reloadChatFilter(). null when nothing is blocked, so renderMessage skips the check entirely
    this._compiledFilter = null;
    this.reloadChatFilter();
    // keyed by "setId/version" to match the IRC `badges` tag. global and channel badges share this map; channel entries override the global default (subscriber/bits), like Twitch
    this.badgeMap = new Map();
    // prefix.toLowerCase() -> tiers sorted DESCENDING by minBits, so Array.find gives the highest matching tier first
    this.cheermoteMap = new Map();
    this.maxLines = 250;
    this.unlisteners = [];
    // serializes AND supersedes the lifecycle methods (connect/connectKick/disconnect/setVodMode/
    // setKickVodMode). two needs: (1) no interleaving, overlapping teardown/setup pairs would double
    // every listener; (2) latest-wins, clicking 5 channels fast should connect only the 5th. each call
    // bumps _lifecycleEpoch and bails if a newer one bumped it
    this._lifecycleChain = Promise.resolve();
    this._lifecycleEpoch = 0;
    // explicit flag for whether the user scrolled up to read history. distance-from-bottom checks are
    // unreliable during fast chat: scrollHeight grows the instant a message is appended, so a tall
    // message falsely reads as "scrolled up"
    this.userScrolledUp = false;
    // marks the next scroll event as caused by our own scrollTop write, not the user. a boolean, not a counter, which desynced when the browser coalesced rapid writes
    this._suppressNextScrollEvent = false;

    // sent-message history for Up/Down. [0] is most recent; _historyIdx is the shown index (-1 = live draft); _historyDraft saves the pre-Up draft so Down past 0 restores it
    this._sentHistory  = [];
    this._historyIdx   = -1;
    this._historyDraft = "";

    // shown when scrolled up. scoped to this instance's container so a second chat (MultiView) uses its own
    this.jumpToLatestBtn = this._jumpToLatestBtnEl
      ?? document.getElementById("jump-to-latest-btn");
    this.jumpToLatestCount = this._jumpToLatestCountEl
      ?? document.getElementById("jump-to-latest-count");
    this.newMessageCountWhileScrolledUp = 0;

    if (this.sendBtn) {
      this.sendBtn.addEventListener("click", () => this.sendMessage());
    }
    // appended to the chat pane so it appears above the input row and can be positioned relative to it
    this._emotePopup = document.createElement("div");
    this._emotePopup.className = "emote-autocomplete";
    this._emotePopup.style.display = "none";
    // appended to <body> position:fixed so it's never clipped by overflow:hidden ancestors. coordinates computed in _showEmotePopup() from the input's live rect
    document.body.appendChild(this._emotePopup);
    this._emotePopupIndex = -1;
    // which kind of suggestion the shared popup is showing right now ("emote" | "user")
    this._popupMode = "emote";

    // the composer's smiley button + browsable grid (chat-emote-picker.js). distinct from the popup above (a typed-autocomplete list), this is an explicit "browse everything" panel
    this._initEmotePicker();
    // lowercase login -> display name. populated from every message seen this session and, for a mod/broadcaster, a one-time get_chatters() fetch that also covers silent viewers
    this._chatUsers = new Map();
    // guards _maybeFetchChatters() to one fetch per channel (re-checked on chat-room and mod-status, since either can arrive first)
    this._chattersFetchedForChannel = null;

    // same "position:fixed, appended to body" pattern as the emote popup, positioned from the hovered link's rect
    this._linkPreviewPopup = document.createElement("div");
    this._linkPreviewPopup.className = "link-preview-popup";
    this._linkPreviewPopup.style.display = "none";
    document.body.appendChild(this._linkPreviewPopup);
    // caches successful AND failed lookups by URL so re-hovering the same link never refetches. failed lookups cache to null so a dead link isn't retried
    this._linkPreviewCache = new Map();
    // guards against a fetch for a link the user already moved off of resolving late and reopening the popup
    this._linkPreviewToken = 0;

    if (this.inputEl) {
      this.inputEl.addEventListener("keydown", (e) => {
        if (this._emotePopup.style.display !== "none") {
          // the popup is already open (via Tab), so these keys drive it
          if (e.key === "ArrowUp") {
            e.preventDefault();
            this._moveEmoteSelection(-1);
            return;
          }
          if (e.key === "ArrowDown") {
            e.preventDefault();
            this._moveEmoteSelection(1);
            return;
          }
          if (e.key === "Tab" || e.key === "Enter") {
            e.preventDefault();
            this._commitEmoteSelection();
            return;
          }
          if (e.key === "Escape") {
            this._hideEmotePopup();
            return;
          }
        } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
          // only active when the emote popup is closed (handled above) and there's actually history to show
          if (!this._sentHistory.length) return;
          e.preventDefault();

          if (e.key === "ArrowUp") {
            if (this._historyIdx === -1) {
              // save whatever the user was composing before navigating
              this._historyDraft = this.inputEl.value;
            }
            if (this._historyIdx < this._sentHistory.length - 1) {
              this._historyIdx++;
            }
          } else {
            if (this._historyIdx === -1) return; // nothing to go forward to
            this._historyIdx--;
          }

          const text = this._historyIdx === -1
            ? this._historyDraft
            : this._sentHistory[this._historyIdx];

          this.inputEl.value = text;
          this._autosizeChatInput();
          // place cursor at end so it's easy to edit the recalled message
          this.inputEl.setSelectionRange(text.length, text.length);
          this.inputEl.closest?.(".chat-input-wrapper")
            ?.classList.toggle("has-text", text.length > 0);
          return;
        } else if (e.key === "Tab") {
          // Tab opens it now. it used to auto-open on every keystroke, so typing "lol" pre-selected an emote and the next Enter committed it instead of sending. only swallow Tab if there's a word worth suggesting for
          const { word } = this._currentEmoteWord();
          if (word && word.length >= 2) {
            e.preventDefault();
            this._updateEmotePopup();
            return;
          }
        }
        // Enter sends (no Shift+Enter multi-line, like Twitch). preventDefault() is needed now that this is a <textarea>, else Enter inserts a newline instead of submitting
        if (e.key === "Enter") {
          e.preventDefault();
          this.sendMessage();
        }
      });

      // opening is keydown-only, gated behind Tab (above). this input listener only refreshes the filtered list while the popup is already open
      this.inputEl.addEventListener("input", () => {
        this._autosizeChatInput();
        // @mention autocomplete: auto-open as soon as @ + at least one letter is typed
        const atWord = this._currentAtWord();
        if (atWord.word && atWord.word.length >= 2) {
          this._updateUserPopup();
          return;
        }
        // if the @-word was deleted/changed, close a user popup
        if (this._popupMode === "user") {
          this._hideEmotePopup();
        }
        // emote popup refresh while it's already open (Tab-triggered)
        if (this._emotePopup.style.display !== "none") this._updateEmotePopup();
      });
      this.inputEl.addEventListener("blur", () => {
        // small delay so a popup click registers before the popup hides
        setTimeout(() => this._hideEmotePopup(), 150);
      });
    }
    if (this.jumpToLatestBtn) {
      this.jumpToLatestBtn.addEventListener("click", () => this.scrollToLatest());
    }
    if (this.container) {
      this.container.addEventListener("scroll", () => {
        // ignore scroll events from our own scrollTop writes (auto-scroll, Jump to latest, connect() reset),
        // checked FIRST. this used to run after dismissing the link preview, so every auto-scroll cancelled an
        // open preview and re-fired mouseenter/leave under a stationary cursor, which read as chat "vibrating"
        if (this._suppressNextScrollEvent) {
          this._suppressNextScrollEvent = false;
          return;
        }
        // a scroll reaching here is a genuine user scroll, trimAndScroll() suppresses its own scrollTop compensation explicitly
        this._cancelLinkPreview();
        // same as the link preview above, the card is anchored to a username span whose position goes stale once the list scrolls
        this._closeUserCard();
        const atBottom =
          this.container.scrollHeight - this.container.scrollTop - this.container.clientHeight < 80;
        if (atBottom) {
          // user scrolled back down manually, resume auto-scroll
          this.userScrolledUp = false;
          this.newMessageCountWhileScrolledUp = 0;
          this.jumpToLatestBtn?.classList.remove("visible");
        } else {
          // user scrolled up intentionally
          this.userScrolledUp = true;
          this.updateJumpToLatestVisibility();
        }
      });
    }
  }

  // shows/hides the whole chat-input-row, not just disabling it, VOD replay has no connection to send to. matches Twitch's VOD player (no chat box in replay)
  _setInputRowVisible(visible) {
    const inputRow = this.inputEl?.closest(".chat-input-row");
    if (inputRow) inputRow.style.display = visible ? "" : "none";
  }

  // grows/shrinks the textarea to fit content up to the CSS max-height (then scrolls internally).
  // height must reset to "auto" before reading scrollHeight, else it reports the stale current height.
  // overflow-y is toggled to auto only past MAX_HEIGHT_PX so a short line doesn't show stray scroll arrows
  _autosizeChatInput() {
    const el = this.inputEl;
    if (!el) return;
    // not laid out yet (hidden panel, pre-first-paint): scrollHeight reads 0 and writing height:0px would collapse the box. a later call from a visible state settles it
    if (el.scrollHeight === 0) return;
    // captured BEFORE the resize: growing the input shrinks .chat-body (flex siblings), which the scroll handler can't distinguish from scrolling up, so typing a long message used to pause chat. if pinned to newest before the grow, stay pinned
    const wasPinned = !this.userScrolledUp;
    el.style.height = "auto";
    const overflowing = el.scrollHeight > CHAT_INPUT_MAX_HEIGHT_PX;
    el.style.height = `${Math.min(el.scrollHeight, CHAT_INPUT_MAX_HEIGHT_PX)}px`;
    el.style.overflowY = overflowing ? "auto" : "hidden";
    // publish the input row's real height so the jump-to-latest pill sits above it via calc(), its old hardcoded offset assumed a one-line input
    const row = el.closest(".chat-input-row");
    if (row?.parentElement) {
      row.parentElement.style.setProperty("--chat-input-row-h", `${row.offsetHeight}px`);
    }
    if (wasPinned && this.container) {
      // same programmatic-scroll marker every other pinned write uses, so the scroll handler doesn't misattribute this to the user
      this._suppressNextScrollEvent = true;
      this.container.scrollTop = this.container.scrollHeight;
    }
  }

  // userId (from validate_oauth_token) is stored so sendMessage()'s local echo gives own messages a real userId, without it clicking your own username had nothing to open the card from
  setLoggedIn(login, userId, displayName) {
    this.isLoggedIn = true;
    this.ownLogin = login;
    this.ownDisplayName = displayName || login; // properly-cased for display
    this.ownUserId = userId || null;
    if (this.inputEl) {
      this.inputEl.disabled = false;
      this.inputEl.placeholder = "Send a message";
      const wrapper = this.inputEl.closest(".chat-input-wrapper");
      this.inputEl.addEventListener("input", () => {
        wrapper?.classList.toggle("has-text", this.inputEl.value.length > 0);
      });
      // settle the composer at its computed height now, else the empty box sits at the browser's rows="1" height until the first keystroke, misaligning the badge/placeholder
      this._autosizeChatInput();
    }
    if (this.sendBtn) this.sendBtn.disabled = false;
    if (this.emoteBtn) this.emoteBtn.disabled = false;

    // Ensure the global emote sets are available even if no stream has been opened yet — so the
    // whisper composer's emote picker/autocomplete work on a fresh launch. Idempotent and cheap; the
    // full per-channel sets still load when a stream is opened.
    this.loadGlobalEmotesOnce();

    // badge/cheermote fetches need a Helix token. if connect() ran before login they 401'd silently; now retry without a stream restart
    if (this.channel) {
      this.loadGlobalBadges();
      if (this.roomId) {
        this.loadChannelBadges(this.roomId);
        this.loadCheermotes(this.roomId);
        invoke("start_eventsub", { broadcasterId: this.roomId }).catch(() => {});
        // same retry reasoning as above: ownLogin/the Helix token _maybeFetchChatters() needs are only available from here on
        this._maybeFetchChatters();
      }
    }
  }

  // Loads the provider-global emote sets outside of connecting to a channel, so whispers have a usable
  // emote set on a fresh instance. Third-party globals (7TV/BTTV/FFZ) need no auth and load once. The
  // user's Twitch global/available emotes need a Helix token, so they load once a login exists — which
  // is why this is safe to call both from initWhispers (maybe pre-login) and setLoggedIn (post-login).
  loadGlobalEmotesOnce() {
    if (!this._thirdPartyGlobalsLoaded) {
      this._thirdPartyGlobalsLoaded = true;
      this.loadSevenTvGlobalEmotes();
      this.loadBttvGlobalEmotes();
      this.loadFfzGlobalEmotes();
    }
    if (this.isLoggedIn && !this._twitchGlobalsLoaded) {
      this._twitchGlobalsLoaded = true;
      this.loadTwitchGlobalEmotes();
      this.loadAvailableTwitchEmotes();
    }
  }

  async sendMessage() {
    if (!this.inputEl || this._isVodMode) return;

    // Kick send path: separate command, separate login, no Twitch IRC semantics (slash commands, reply-parent, USERSTATE color). early self-contained branch so the Twitch path is unchanged
    if (this._isKickChat) {
      if (!this._kickLoggedIn || this._kickBroadcasterId == null) return;
      const text = this.inputEl.value.trim();
      if (!text) return;
      try {
        await invoke("kick_send_chat_message", {
          broadcasterUserId: this._kickBroadcasterId,
          message: text,
        });
        this.inputEl.value = "";
        this._autosizeChatInput();
        this.inputEl.closest?.(".chat-input-wrapper")?.classList.remove("has-text");
        this._sentHistory.unshift(text);
        if (this._sentHistory.length > 50) this._sentHistory.pop();
        this._historyIdx = -1;
        this._historyDraft = "";
        // Kick's Pusher feed echoes the sender's own message back (unlike Twitch IRC), so no optimistic local echo here, it would double every sent message
      } catch (err) {
        this.systemLine(`Couldn't send to Kick: ${err}`);
      }
      return;
    }

    if (!this.isLoggedIn) return;
    // Twitch chat has no multi-line messages: line breaks (e.g. pasted multi-row art) become spaces.
    // The backend enforces this too (a CR/LF would end the IRC command); doing it here keeps our own
    // optimistic echo identical to what everyone else receives
    const text = this.inputEl.value.replace(/\r\n|\r|\n/g, " ").trim();
    if (!text) return;

    if (text.startsWith("/")) {
      const handled = await this._tryHandleSlashCommand(text);
      if (handled) {
        this.inputEl.value = "";
        this._autosizeChatInput();
        return;
      }
      // not a recognized command, fall through and send as a literal message, like Twitch, rather than swallowing a message that just starts with "/"
    }

    try {
      // capture the reply context before clearReply() wipes it, so the optimistic echo below can be
      // placed into the correct thread
      const replyingToUser = this._replyToId ? this._replyToUser : null;
      const replyingToBody = this._replyToId ? this._replyToBody : null;
      const replyingThreadRoot = this._replyToId ? this._replyToThreadRoot : null;
      const replyingParentId = this._replyToId || null;

      await invoke("send_chat_message", {
        message: text,
        replyToMsgId: this._replyToId || null,
      });
      this.clearReply();
      this.inputEl.value = "";
      this._autosizeChatInput();
      this.inputEl.closest?.(".chat-input-wrapper")?.classList.remove("has-text");

      // prepend so index 0 always means "most recent"; cap at 50 to avoid unbounded growth
      this._sentHistory.unshift(text);
      if (this._sentHistory.length > 50) this._sentHistory.pop();
      this._historyIdx   = -1;
      this._historyDraft = "";

      // Twitch IRC doesn't echo a client's own PRIVMSG back, so render it optimistically here. this
      // doesn't reflect server-side moderation (a dropped message still looks sent), acceptable.
      // userId/badgesTag flow through so own messages get a clickable card. For a normal message msgId
      // is left undefined (Delete stays disabled). For a REPLY we mint a synthetic local id and pass
      // the reply/thread context so our own reply is stored in _msgStore under the right threadRootId
      // and therefore shows up when the thread is opened — otherwise our reply was invisible in-thread.
      const localMsgId = replyingToUser ? `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` : undefined;
      this.renderMessage(this.ownDisplayName || this.ownLogin || "you", this._ownColor || "#9147ff", text, this._ownBadgesTag,
                          undefined, undefined, replyingToUser || undefined, replyingToBody || undefined, localMsgId, this.ownUserId,
                          /*isAction=*/false, /*emotesTag=*/null, /*isFirstMsg=*/false,
                          /*isHighlighted=*/false, /*replyParentMsgId=*/replyingParentId,
                          /*replyThreadParentMsgId=*/replyingThreadRoot || null);
      // IRC won't echo this back, so the Mod Chat tab (which watches "chat-message") never sees our own
      // messages — surface them via a window event using the same badge filter
      window.dispatchEvent(new CustomEvent("mosaic-own-message", { detail: {
        username: this.ownDisplayName || this.ownLogin || "you",
        color: this._ownColor || "#9147ff",
        message: text,
        badges: this._ownBadgesTag || "",
      }}));
    } catch (err) {
      console.error("Failed to send message:", err);
      this.systemLine(`Failed to send: ${err}`);
    }
  }

  // /ban, /unban, /timeout, /untimeout, /clear, the same actions as the user card, typed. all but
  // /clear resolve a username -> id first (Helix takes ids), so they're async. /timeout accepts flexible
  // order ("username 10m" or "10m username"), like Twitch's own (duration optional, defaults to 10 min)

  setStatus(text) {
    if (!this.statusEl) return;
    // "connected (#channel)" is redundant with the header/title and eats chat-header space, so blank it.
    // transient states (connecting/reconnecting/error/replay/kick) still show as real feedback.
    this.statusEl.textContent = /^connected\b/i.test(text || "") ? "" : text;
  }

  systemLine(text) {
    const div = document.createElement("div");
    div.className = "chat-line system";
    div.textContent = text;
    this.container.appendChild(div);
    this.trimAndScroll();
  }

  trimAndScroll() {
    // trimming shifts scrollTop, which must not read as a user scroll (that would resume auto-scroll).
    // two guards: overflow-anchor:none + exact scrollHeight-delta compensation prevent drift, and a boolean
    // (not a counter, which desynced when the browser coalesced writes) marks the next scroll event as ours
    const heightBefore = this.container.scrollHeight;
    while (this.container.children.length > this.maxLines) {
      this.container.removeChild(this.container.firstChild);
    }
    const removedHeight = heightBefore - this.container.scrollHeight;
    if (removedHeight > 0 && this.userScrolledUp) {
      // suppress the scroll event this assignment fires, our adjustment, not the user scrolling
      this._suppressNextScrollEvent = true;
      this.container.scrollTop -= removedHeight;
    }
    if (!this.userScrolledUp) {
      // suppress the scroll event this assignment will fire so it doesn't falsely flip userScrolledUp on the next tick
      this._suppressNextScrollEvent = true;
      this.container.scrollTop = this.container.scrollHeight;
    } else {
      this.newMessageCountWhileScrolledUp++;
      this.updateJumpToLatestVisibility();
    }

  }

  updateJumpToLatestVisibility() {
    if (!this.jumpToLatestBtn) return;
    if (!this.userScrolledUp) {
      this.newMessageCountWhileScrolledUp = 0;
      this.jumpToLatestBtn.classList.remove("visible");
      return;
    }
    this.jumpToLatestBtn.classList.add("visible");
    if (this.jumpToLatestCount) {
      this.jumpToLatestCount.textContent =
        this.newMessageCountWhileScrolledUp > 0 ? `${this.newMessageCountWhileScrolledUp} new -` : "";
    }
  }

  scrollToLatest() {
    this.userScrolledUp = false;
    this.newMessageCountWhileScrolledUp = 0;
    this._suppressNextScrollEvent = true;
    this.container.scrollTop = this.container.scrollHeight;
    if (this.jumpToLatestBtn) this.jumpToLatestBtn.classList.remove("visible");
  }

  // runs fn after the previous lifecycle op settles (so teardown/setup pairs never interleave), but skips it if a newer lifecycle call arrived. fn gets an isCurrent() predicate to re-check after its own awaits. rapid channel switches collapse to the last one
  _serializeLifecycle(fn) {
    const myEpoch = ++this._lifecycleEpoch;
    const isCurrent = () => this._lifecycleEpoch === myEpoch;
    const run = this._lifecycleChain.then(
      () => {
        // superseded while waiting our turn, don't touch listeners or the Rust connection at all; the newer call owns them now
        if (!isCurrent()) return undefined;
        return fn(isCurrent);
      },
      () => {
        if (!isCurrent()) return undefined;
        return fn(isCurrent);
      },
    );
    this._lifecycleChain = run.catch(() => {});
    return run;
  }

  // safe to call again to switch channels
  async connect(channel) {
    return this._serializeLifecycle((isCurrent) => this._doConnect(channel, isCurrent));
  }

  async _doConnect(channel, isCurrent = () => true) {
    // without this, switching from a VOD to live left the old tick() loop running, it kept wiping #chat-messages and printing "replay restarting..." into what looked like live chat (both render into the same container)
    if (this._vodReplayStop) {
      this._vodReplayStop();
      this._vodReplayStop = null;
    }
    this.channel = channel.toLowerCase();
    this.roomId = null;
    this._stopPinPoll();
    clearModLog(); // mod-action log is per-channel
    this._stopHypePoll();
    this._stopPredictionPoll();
    this._stopResubPoll();
    this.closeThread();
    this._roomModes = {};
    this._renderChatModes();
    this._hideTimeoutPanel();
    // clear any stale gift-sub banner from the previous channel
    if (typeof this._hideGiftSubBanner === "function") this._hideGiftSubBanner();
    if (this._msgStore) this._msgStore.clear();
    this.userScrolledUp = false;
    // leaving any prior Kick-chat session behind, back on Twitch IRC now
    this._isKickChat = false;
    this._kickBroadcasterId = null;
    // stale chatters from the old channel shouldn't suggest into this one, cleared here (not just in disconnect()) since connect() can be called channel-to-channel without disconnect()
    this._chatUsers.clear();
    this._chattersFetchedForChannel = null;
    // returning to live from a VOD (or connecting fresh), restore the input row that setVodMode() hides during replay
    this._isVodMode = false;
    this._setInputRowVisible(true);
    // a preceding Kick session leaves the composer disabled with a "Log in with Kick to chat" placeholder (shared DOM), which clearing _isKickChat doesn't undo, so every Twitch stream after a Kick one showed a dead composer
    this._applyTwitchInputState();
    // a fresh channel, so a suppression queued for the previous channel's cleared body is meaningless
    this._suppressNextScrollEvent = false;
    this.newMessageCountWhileScrolledUp = 0;
    this.sevenTvEmotes.clear();
    this.twitchNativeEmotes.clear();
    this.badgeMap.clear();
    this.cheermoteMap.clear();
    this._ownBadgesTag = null;
    // being a mod in the previous channel says nothing about this one, and USERSTATE won't arrive instantly, so mod tools would otherwise wrongly stay on
    this.isMod = false;
    // notify listeners (e.g. the shield button) so listener-driven mod UI hides immediately on switch;
    // USERSTATE re-derives and re-fires if this channel makes us a mod
    for (const fn of this._modStatusListeners) {
      try { fn(false); } catch (err) { console.error("mod status listener error:", err); }
    }
    // a new channel's held messages have nothing to do with the previous one's, clear the queue and the panel/badge it drives
    this._automodQueue = [];
    // start each channel with the panel closed (it's opened on demand via the AutoMod button)
    const amPanel = document.getElementById("automod-panel");
    if (amPanel) amPanel.style.display = "none";
    this._renderAutomodPanel();
    // same for the per-user tracking the card reads. user info (account age etc.) is left cached: it's about the account, not the channel
    this._messageCountByUserId = new Map();
    this._messageHistoryByUserId = new Map();
    this._closeUserCard();
    this.container.innerHTML = "";
    this.newMessageCountWhileScrolledUp = 0;
    if (this.jumpToLatestBtn) this.jumpToLatestBtn.classList.remove("visible");

    await this.teardownListeners();
    await this.setupListeners();

    this.setStatus("connecting…");
    // Rust's connect (chat.rs) emits its own "Connecting to chat..." system message, so printing it here too was pure duplication

    // 7TV globals load immediately; channel emotes load once Rust reports the room-id (via the chat-room event) after joining
    this.loadSevenTvGlobalEmotes();
    this.loadBttvGlobalEmotes();
    this.loadFfzGlobalEmotes();
    this.loadTwitchGlobalEmotes();
    this.loadAvailableTwitchEmotes();
    this._thirdPartyGlobalsLoaded = true; // connect() has now pulled the 3rd-party global sets
    if (this.isLoggedIn) this._twitchGlobalsLoaded = true;
    // re-pull available emotes right after the user unlocks/modifies one via the rewards panel. the event
    // also carries the exact {id, token} just unlocked, which we add immediately — reliable even if the
    // broader AvailableEmotesForChannel fetch misses it.
    if (!this._emotesChangedBound) {
      this._emotesChangedBound = true;
      window.addEventListener("mosaic-emotes-changed", (e) => {
        const d = e && e.detail;
        if (d && d.id && d.token) {
          this.twitchNativeEmotes.set(d.token, {
            id: d.id,
            url: `https://static-cdn.jtvnw.net/emoticons/v2/${d.id}/default/dark/2.0`,
          });
          console.log(`Added unlocked emote ${d.token} (${d.id}) to the usable set.`);
        }
        this.loadAvailableTwitchEmotes();
      });
    }
    // globals load now, channel-specific badges (which override global subscriber art) load once the room-id is known
    this.loadGlobalBadges();

    // if a newer channel was clicked mid-setup, don't open the Rust IRC connection for this stale one, the queued newer connect will. this is what stops rapid switching from crawling through every intermediate channel
    if (!isCurrent()) return;

    try {
      await invoke("start_chat", { channel: this.channel });
    } catch (err) {
      this.setStatus("error");
      this.systemLine(`Failed to start chat: ${err}`);
    }
  }

  async disconnect() {
    return this._serializeLifecycle(() => this._doDisconnect());
  }

  async _doDisconnect() {
    // Twitch pins don't apply once we leave; also covers the Kick path (connectKick calls this first)
    this._stopPinPoll();
    this._stopHypePoll();
    this._stopPointsPoll();
    this._stopResubPoll();
    invoke("heartbeat_clear_target").catch(() => {});
    invoke("pubsub_clear").catch(() => {});
    invoke("seventv_cosmetics_clear").catch(() => {});
    if (this._userPaints) this._userPaints.clear();
    if (this._userBadges) this._userBadges.clear();
    this._stopPredictionPoll();
    // always dismiss the emote autocomplete popup, it's position:fixed on body, so it can strand over unrelated UI after a channel switch or stop
    this._hideEmotePopup();
    // same, plus its emote grid would otherwise show the OLD channel's emotes for a moment
    this._closeEmotePicker();
    this._chatUsers.clear(); // stale users from old channel shouldn't appear in @mentions
    // same position:fixed-on-body reasoning for the link preview popup, also cancels any in-flight hover fetch so an old-channel request can't reopen it over the new channel
    this._cancelLinkPreview();
    // same reasoning again for the user card
    this._closeUserCard();
    // stop any VOD replay loop before tearing down the live connection, so the two don't overlap switching from a VOD back to live
    if (this._vodReplayStop) {
      this._vodReplayStop();
      this._vodReplayStop = null;
    }
    try {
      await invoke("stop_eventsub");
    } catch (_) {}
    try {
      await invoke("stop_seventv_events");
    } catch (_) {}
    try {
      await invoke("stop_chat");
    } catch (err) {
      console.error("stop_chat error:", err);
    }
    await this.teardownListeners();
    // leave the pane in a neutral Twitch shape rather than the torn-down session's. matters for Stop-from-Kick with nothing connecting after; new-mode callers overwrite this immediately
    this._isKickChat = false;
    this._kickBroadcasterId = null;
    this._applyTwitchInputState();
  }

  // Wipes the visible chat pane and the recent-message store. Used when restoring from the tray so a
  // fresh window doesn't show the previous channel's stale messages. Safe to call anytime.
  clearChatMessages() {
    if (this.container) this.container.innerHTML = "";
    if (this._msgStore) this._msgStore.clear();
    this.userScrolledUp = false;
    this.newMessageCountWhileScrolledUp = 0;
    if (this.jumpToLatestBtn) this.jumpToLatestBtn.classList.remove("visible");
    if (typeof this._hideGiftSubBanner === "function") this._hideGiftSubBanner();
    this.closeThread();
  }

  // there's no Kick chat-replay API, so this is setVodMode minus the replay engine, tear down the live connection, clear the pane, hide the composer, and say why it's empty
  async setKickVodMode() {
    return this._serializeLifecycle(() => this._doSetKickVodMode());
  }

  async _doSetKickVodMode() {
    await this._doDisconnect();
    this._clearChannelEmotes();
    this.container.innerHTML = "";
    this.channel = null;
    this._isKickChat = false;
    this._isVodMode = true;
    this._setInputRowVisible(false);
    this.setStatus("replay");
    this.systemLine("Chat replay isn't available for Kick VODs.");
  }

  // tears down Twitch chat and starts the read-only Rust Pusher client (kick_chat.rs), whose events ride
  // the same chat-message/chat-system pipeline. exists because disconnect() ends with teardownListeners();
  // the old Kick swap called disconnect() then started the Kick client directly, so its events arrived with
  // no listener and vanished (video fine, chat frozen). the Twitch return path goes through connect(), which re-registers listeners
  async connectKick(channel, chatroomId, broadcasterUserId, subscriberBadges) {
    return this._serializeLifecycle(() =>
      this._doConnectKick(channel, chatroomId, broadcasterUserId, subscriberBadges),
    );
  }

  async _doConnectKick(channel, chatroomId, broadcasterUserId, subscriberBadges) {
    await this._doDisconnect(); // full Twitch teardown, incl. listeners
    this.channel = channel.toLowerCase();
    this._isKickChat = true;
    // connect() resets this returning to Twitch, but this path never goes through connect(), and a stale true blocks sendMessage()'s early return
    this._isVodMode = false;
    this._kickBroadcasterId = broadcasterUserId ?? null;
    // replaced (not merged) per connection so channel A's tiers can't dress channel B's subscribers
    this._kickSubscriberBadges = Array.isArray(subscriberBadges) ? subscriberBadges : [];
    // the lines in the pane ("Connecting to chat...", emote notices) belong to the torn-down Twitch connection, not the Kick chat starting
    this.container.innerHTML = "";
    // own-identity leftovers from the Twitch session: USERSTATE's badge tag renders next to the input and on local echoes. it's Twitch state with no Kick equivalent and nothing on a Kick connection overwrites it, so without this your Twitch badges followed you into Kick chat
    this._ownBadgesTag = null;
    this._renderInputBadges(null);
    this.newMessageCountWhileScrolledUp = 0;
    if (this.jumpToLatestBtn) this.jumpToLatestBtn.classList.remove("visible");
    // re-register the listeners disconnect() tore down, the Kick client emits the same event names
    await this.setupListeners();
    // this used to load NOTHING for Kick chat (neither connect()'s globals nor the chat-room channel load),
    // so names rendered as bare text or the previous channel's leftover art. clear, then load: all three
    // providers' globals, 7TV's Kick channel set (BTTV/FFZ have no Kick support), and the native Kick emotes
    this.sevenTvEmotes.clear();
    this.loadSevenTvGlobalEmotes();
    this.loadBttvGlobalEmotes();
    this.loadFfzGlobalEmotes();
    if (this._kickBroadcasterId != null) {
      this.loadSevenTvKickChannelEmotes(this._kickBroadcasterId);
    }
    this.loadKickNativeEmotes(this.channel);
    // sending needs the user logged into Kick AND a broadcaster id. if both hold, show and enable the composer; otherwise it stays read-only (Kick login comes later, failover/browse don't block on it)
    this._applyKickInputState();
    // if sending isn't possible, say WHY once in the pane, a silently read-only chat with no visible cause was the complaint
    if (!this._kickLoggedIn) {
      if (!this._kickOAuthConfigured) {
        this.systemLine(
          "Kick chat is read-only: this build has no Kick API credentials, so login isn't available. " +
          "Register an app at kick.com/settings/developer and build with KICK_CLIENT_ID / KICK_CLIENT_SECRET set (see kick_oauth.rs)."
        );
      }
      // configured-but-logged-out needs no system line, the disabled composer's "Log in with Kick to chat" placeholder covers it
    } else if (this._kickBroadcasterId == null) {
      this.systemLine(
        "Kick chat is read-only for this channel: Kick's payload didn't include a broadcaster id to send to."
      );
    }
    try {
      await invoke("start_kick_chat", { chatroomId });
    } catch (err) {
      this.setStatus("error");
      this.systemLine(`Failed to start Kick chat: ${err}`);
    }
  }

  // the composer DOM is SHARED between platforms and _applyKickInputState mutates it, with nothing on the Twitch return path undoing it (symptom: a Twitch stream after a Kick session showing a dead composer asking for a Kick login). called from connect() and disconnect()
  _applyTwitchInputState() {
    const canSend = this.isLoggedIn;
    if (this.inputEl) {
      this.inputEl.disabled = !canSend;
      this.inputEl.placeholder = "Send a message";
    }
    if (this.sendBtn) this.sendBtn.disabled = !canSend;
    if (this.emoteBtn) this.emoteBtn.disabled = !canSend;
  }

  // reconciles the composer (row visibility + enabled state + status text) with current Kick state. called from connectKick and whenever Kick login changes while Kick chat shows
  _applyKickInputState() {
    if (!this._isKickChat) return;
    const canSend = this._kickLoggedIn && this._kickBroadcasterId != null;
    // show the composer whenever sending is possible or one login away, a hidden row gave "read-only" no explanation. only when login isn't offered at all (no Kick credentials, or no broadcaster id) does the row hide entirely, VOD-style
    const loginPossible = this._kickOAuthConfigured && this._kickBroadcasterId != null;
    this._setInputRowVisible(canSend || loginPossible);
    if (this.inputEl) {
      this.inputEl.disabled = !canSend;
      this.inputEl.placeholder = canSend
        ? "Send a message"
        : "Log in with Kick to chat";
    }
    if (this.sendBtn) this.sendBtn.disabled = !canSend;
    if (this.emoteBtn) this.emoteBtn.disabled = !canSend;
    if (canSend) {
      this.setStatus(`kick chat - ${this._kickLogin || "connected"}`);
    } else {
      this.setStatus("kick chat (read-only)");
    }
  }

  // called once at startup after the kick_oauth_configured check: whether this BUILD can do Kick login at all (real credentials baked in). distinct from _kickLoggedIn (whether the user has)
  setKickOAuthConfigured(configured) {
    this._kickOAuthConfigured = Boolean(configured);
    if (this._isKickChat) this._applyKickInputState();
  }

  // updates the composer live if Kick chat is showing, so logging in mid-stream flips it writable without a reconnect
  setKickLoggedIn(loggedIn, login) {
    this._kickLoggedIn = Boolean(loggedIn);
    this._kickLogin = login || null;
    if (this._isKickChat) this._applyKickInputState();
  }

  async setupListeners() {
    this.unlisteners.push(
      await listen("chat-message", (event) => {
        const { username, color, message, badges, bits, custom_reward_id,
                reply_parent_user, reply_parent_body, msg_id, user_id, is_action,
                emotes_tag, is_first_msg, is_highlighted, reply_parent_msg_id,
                reply_thread_parent_msg_id } = event.payload;
        // track chatters for @mention autocomplete (cap at 500 to avoid memory bloat)
        if (username) {
          this._chatUsers.set(username.toLowerCase(), username);
          if (this._chatUsers.size > 500) {
            this._chatUsers.delete(this._chatUsers.keys().next().value);
          }
        }
        this.renderMessage(username, color || "#9147ff", message, badges, bits, custom_reward_id,
                           reply_parent_user, reply_parent_body, msg_id, user_id, is_action,
                           emotes_tag, is_first_msg, is_highlighted, reply_parent_msg_id,
                           reply_thread_parent_msg_id);
      })
    );

    this.unlisteners.push(
      await listen("chat-system", (event) => {
        const p = event.payload || {};
        this.systemLine(p.text);
        // Twitch refused our message because we're banned / timed out (e.g. the panel was dismissed with
        // "Check again" but the ban still stands): put the panel back
        if (p.msg_id === "msg_banned") this._showTimeoutPanel(null);
        else if (p.msg_id === "msg_timedout") {
          const m = /(\d+)\s*(?:more\s*)?second/i.exec(p.text || "");
          this._showTimeoutPanel(m ? Number(m[1]) : null);
        }
      })
    );

    // Moderation actions against us from PubSub (chatrooms-user-v1, pubsub.rs). IRC announces a ban
    // (CLEARCHAT) but never an unban, so this is what lifts the panel live when a mod unbans /
    // un-times-out us in this channel.
    this.unlisteners.push(
      await listen("pubsub-self-moderation", (event) => {
        const p = event.payload || {};
        if (String(p.channel_id) !== String(this.roomId)) return;
        const panel = document.getElementById("chat-timeout-panel");
        const locked = panel && panel.style.display !== "none";
        if (p.action === "unban" || p.action === "untimeout") {
          if (locked) {
            this._hideTimeoutPanel();
            this.systemLine(p.action === "unban"
              ? "You were unbanned. You can chat again."
              : "Your timeout was lifted. You can chat again.");
          }
        }
      })
    );

    this.unlisteners.push(
      await listen("chat-status", (event) => {
        this.setStatus(event.payload.status);
      })
    );

    this.unlisteners.push(
      await listen("eventsub-redeem", (event) => {
        this.renderRedeemEvent(event.payload);
      })
    );

    // real-time redemptions (all channels) + live balance via PubSub
    this.unlisteners.push(
      await listen("pubsub-redemption", (event) => {
        const p = event.payload || {};
        if (!p.reward_title) return;
        this.renderRedeemEvent({
          redeemer: p.user_name || p.user_login || "someone",
          reward_title: p.reward_title,
          reward_cost: p.reward_cost,
          user_input: p.user_input,
          redemption_id: p.redemption_id,
        });
      })
    );
    this.unlisteners.push(
      await listen("pubsub-points", (event) => {
        const p = event.payload || {};
        if (String(p.channel_id) !== String(this.roomId)) return; // only the watched channel
        const el = document.getElementById("rewards-balance");
        const btn = document.getElementById("rewards-btn");
        if (el) el.textContent = fmtCount(p.balance);
        if (btn) btn.classList.add("has-balance");
      })
    );

    // USERNOTICE (subs/resubs/gifts/raids/announce) and EventSub hype train / predictions. same teardown via unlisteners
    await this._initEventListeners(listen);

    this.unlisteners.push(
      await listen("chat-room", (event) => {
        // persist so setLoggedIn() can reload badges/cheermotes after login
        this.roomId = event.payload.room_id;
        this.loadSevenTvChannelEmotes(this.roomId);
        // BTTV channel emotes and FFZ (no other loader) were never fetched, the cause of common emotes (LOLW, KEKW, both FFZ channel emotes) rendering as bare text in live chat
        this.loadBttvChannelEmotes(this.roomId);
        this.loadFfzChannelEmotes(this.roomId);
        this.loadChannelBadges(this.roomId);
        this.loadCheermotes(this.roomId);
        // works when logged in as broadcaster/mod of this channel; silently no-ops otherwise
        invoke("start_eventsub", { broadcasterId: this.roomId }).catch(() => {});
        // room-id just became known, the other trigger for _maybeFetchChatters()
        this._maybeFetchChatters();
        // begin polling for a Twitch pinned message (see _startPinPoll)
        this._startPinPoll(this.roomId);
        // begin polling for an active hype train (see _startHypePoll)
        this._startHypePoll(this.channel);
        // begin polling for an active prediction (see _startPredictionPoll)
        this._startPredictionPoll(this.channel);
        // check for a shareable sub-anniversary (see _startResubPoll)
        this._startResubPoll(this.channel);
        // watch heartbeat: report minute-watched so Twitch drops + channel points accrue for this
        // channel (needs the device login; no-ops without it)
        invoke("heartbeat_set_target", { channelId: this.roomId, login: this.channel }).catch(() => {});
        // real-time channel-point redemptions + balance for ANY channel (device login required)
        invoke("pubsub_set_channel", { channelLogin: this.channel }).catch(() => {});
        // 7TV cosmetics (username paints) for this channel
        this._ensurePaintDefs();
        this._ensureBadgeDefs();
        this._setupCosmeticsListener();
        this._setupRoomListeners();
        invoke("seventv_cosmetics_set_channel", { channelId: this.roomId }).catch(() => {});
        // persistent channel-points pill by the chatbox (device login required; hides otherwise)
        this._startPointsPoll(this.channel);
        // load the set of user ids that have a note, for the in-chat indicator (see user_notes.rs)
        if (!this._noteUserIds) invoke("get_user_note_ids").then((ids) => { this._noteUserIds = new Set(ids); }).catch(() => {});
      })
    );

    this.unlisteners.push(
      await listen("seventv-emote-set-update", (event) => {
        this._applySevenTvEmoteSetUpdate(event.payload);
      })
    );

    this.unlisteners.push(
      await listen("user-state", (event) => {
        // cache the badge string to retry after the badge maps finish loading (USERSTATE often arrives before loadGlobalBadges/loadChannelBadges complete)
        this._ownBadgesTag = event.payload.badges;
        this._renderInputBadges(this._ownBadgesTag);
        // own chat color for this channel, used by the local echo. Twitch allows unset color; leave it null rather than coercing, since normalizeColor() has its own fallback
        if (event.payload.color) this._ownColor = event.payload.color;
        // mod-tools visibility depends on this, re-derive and let main.js (which owns the hover-icon/menu DOM) re-render, since USERSTATE can arrive after the first messages
        this._updateModStatus();
      })
    );

    this.unlisteners.push(
      await listen("chat-clearchat", (event) => {
        this._handleClearChat(event.payload);
      })
    );

    this.unlisteners.push(
      await listen("chat-clearmsg", (event) => {
        this._handleClearMsg(event.payload);
      })
    );

    this.unlisteners.push(
      await listen("eventsub-automod-hold", (event) => {
        this._addAutomodHold(event.payload);
      })
    );
  }

  async teardownListeners() {
    for (const unlisten of this.unlisteners) {
      try {
        unlisten();
      } catch (_) {
        /* already gone, fine */
      }
    }
    this.unlisteners = [];
  }

  // (re)reads the saved filter and compiles it into fast-to-check form: an emote-name Set, a single
  // whole-word regex, and a lowercased phrase list. called from the constructor and after the settings
  // modal edits the lists. leaves _compiledFilter null when nothing is blocked so the hot path is free
  reloadChatFilter() {
    const data = loadFilter();
    const emotes = new Set(data.emotes || []);
    const words = (data.words || []).filter(Boolean);
    const strings = (data.strings || []).map((s) => s.toLowerCase()).filter(Boolean);
    if (emotes.size === 0 && words.length === 0 && strings.length === 0) {
      this._compiledFilter = null;
      return;
    }
    let wordsRegex = null;
    if (words.length) {
      // one alternation, whole-word, case-insensitive; no `g` flag so .test() stays stateless
      const escaped = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
      wordsRegex = new RegExp(`\\b(?:${escaped.join("|")})\\b`, "i");
    }
    this._compiledFilter = { emotes, wordsRegex, strings };
  }

  // set of emote names actually present in a message, mirroring renderMessageBody's resolution so we
  // match real emotes (Twitch native by tag position, Kick markers, 7TV/BTTV/FFZ + Twitch by name),
  // not the same text typed as a plain word
  getEmoteNamesInMessage(message, emotesTag = null) {
    const names = new Set();
    const twitchEmotes = this.parseTwitchEmotesTag(message, emotesTag);
    const words = message.split(" ");
    let charPos = 0;
    for (const word of words) {
      const kick = this.parseKickEmoteMarker(word);
      if (kick) {
        names.add(kick.name);
      } else if (twitchEmotes.get(charPos)) {
        names.add(word); // Twitch native: the name is the word at this position
      } else if (this.sevenTvEmotes.get(word) || this.twitchNativeEmotes?.get(word)) {
        names.add(word);
      }
      charPos += word.length + 1; // every branch of renderMessageBody advances by this, spaces included
    }
    return names;
  }

  // true if this message should be hidden. own messages are always exempt (typing a blocked word
  // shouldn't vanish your own line)
  _shouldFilterMessage(username, message, emotesTag) {
    const f = this._compiledFilter;
    if (!f || !message) return false;

    const own = (this._isKickChat ? this._kickLogin : this.ownLogin) || this.ownDisplayName;
    if (own && username && username.toLowerCase() === own.toLowerCase()) return false;

    if (f.strings.length) {
      const lower = message.toLowerCase();
      for (const s of f.strings) if (lower.includes(s)) return true;
    }
    if (f.wordsRegex && f.wordsRegex.test(message)) return true;
    // blocked emotes are NOT hidden here; they're stripped from the body inline (see renderMessageBody),
    // and the only-blocked-emotes case is hidden in renderMessage
    return false;
  }

  // emote name if this word renders as an emote (Kick marker / Twitch-by-position / 7TV·BTTV·Twitch-by-name), else null
  _emoteNameForWord(word, twitchAtPos) {
    const kick = this.parseKickEmoteMarker(word);
    if (kick) return kick.name;
    if (twitchAtPos) return word;
    if (this.sevenTvEmotes.get(word) || this.twitchNativeEmotes?.get(word)) return word;
    return null;
  }

  // true when every non-empty token is a blocked emote (nothing would remain after stripping) -> hide the whole line
  _messageIsOnlyBlockedEmotes(message, emotesTag) {
    const f = this._compiledFilter;
    if (!f || f.emotes.size === 0 || !message) return false;
    const twitchEmotes = this.parseTwitchEmotesTag(message, emotesTag);
    const words = message.split(" ");
    let charPos = 0, sawBlocked = false, sawKeepable = false;
    for (const word of words) {
      if (word.length > 0) {
        const name = this._emoteNameForWord(word, twitchEmotes.get(charPos));
        if (name && f.emotes.has(name)) sawBlocked = true;
        else sawKeepable = true;
      }
      charPos += word.length + 1;
    }
    return sawBlocked && !sawKeepable;
  }

  // Twitch pinned message: poll GetPinnedChat (via Rust get_pinned_chat_messages) every 30s and show
  // a banner atop the chat pane. Twitch-only; Kick has no equivalent. failures are logged loudly so a
  // rejected token/client pairing is obvious (see the Rust command's comment)
  // Sub-anniversary: check once on join (and re-check occasionally) for a shareable resub, show a banner
  // matching twitch.tv's "It's your N month sub anniversary!" with a Share button.
  // Threaded reply view: a panel over the chat pane showing a whole reply thread (grouped by Twitch's
  // reply-thread-parent-msg-id), with a reply box that posts back into the thread. Shows the messages
  // received this session that belong to the thread (IRC only carries live messages).
  // --- 7TV cosmetics (paints) ---
  async _ensurePaintDefs() {
    if (this._paintDefs) return;
    this._paintDefs = new Map();
    try {
      const paints = await invoke("get_all_seventv_paints");
      if (Array.isArray(paints)) for (const p of paints) if (p && p.id) this._paintDefs.set(p.id, p);
      console.log(`Loaded ${this._paintDefs.size} 7TV paints.`);
    } catch (err) {
      console.warn("Failed to load 7TV paints:", err);
    }
  }

  _setupCosmeticsListener() {
    if (this._cosmeticsBound) return;
    this._cosmeticsBound = true;
    this._userPaints = this._userPaints || new Map();
    this._userBadges = this._userBadges || new Map();
    listen("seventv-cosmetic", (e) => {
      const p = e.payload || {};
      if (!p.twitch_id) return;
      if (p.kind === "PAINT") {
        if (p.action === "delete") this._userPaints.delete(p.twitch_id);
        else if (p.ref_id) this._userPaints.set(p.twitch_id, p.ref_id);
        this._reapplyPaintForUser(p.twitch_id);
      } else if (p.kind === "BADGE") {
        if (p.action === "delete") this._userBadges.delete(p.twitch_id);
        else if (p.ref_id) this._userBadges.set(p.twitch_id, p.ref_id);
        this._reapplyBadgeForUser(p.twitch_id);
      }
    }).catch(() => {});
  }

  async _ensureBadgeDefs() {
    if (this._badgeDefs) return;
    this._badgeDefs = new Map();
    try {
      const badges = await invoke("get_all_seventv_badges");
      if (Array.isArray(badges)) {
        for (const b of badges) {
          if (!b || !b.id || !Array.isArray(b.images) || !b.images.length) continue;
          const img = b.images.slice().sort((a, c) => (a.scale || 99) - (c.scale || 99))[0];
          if (img && img.url) this._badgeDefs.set(b.id, { name: b.name || "7TV Badge", url: img.url });
        }
      }
      console.log(`Loaded ${this._badgeDefs.size} 7TV badges.`);
    } catch (err) {
      console.warn("Failed to load 7TV badges:", err);
    }
  }

  _seventvBadgeEl(userId) {
    if (!userId || !this._userBadges || !this._badgeDefs) return null;
    const badgeId = this._userBadges.get(userId);
    if (!badgeId) return null;
    const def = this._badgeDefs.get(badgeId);
    if (!def) return null;
    const img = document.createElement("img");
    img.className = "chat-badge seventv-badge";
    img.src = def.url;
    img.alt = def.name;
    img.title = def.name;
    return img;
  }

  _reapplyBadgeForUser(twitchId) {
    if (!this.container) return;
    let sel;
    try { sel = `.chat-line[data-msg-user-id="${CSS.escape(twitchId)}"]`; }
    catch { return; }
    for (const line of this.container.querySelectorAll(sel)) {
      const existing = line.querySelector(".seventv-badge");
      if (existing) existing.remove();
      const name = line.querySelector(".chat-username");
      const el = this._seventvBadgeEl(twitchId);
      if (el && name) line.insertBefore(el, name);
    }
  }

  _applyPaint(el, userId) {
    if (!userId || !this._userPaints || !this._paintDefs) return;
    const paintId = this._userPaints.get(userId);
    if (!paintId) return;
    const paint = this._paintDefs.get(paintId);
    if (!paint) return;
    const css = this._paintCss(paint);
    if (!css) return;
    el.classList.add("has-7tv-paint");
    el.style.backgroundImage = css.backgroundImage;
    el.style.filter = css.filter || "";
  }

  // re-apply (or clear) a user's paint on already-rendered messages when their cosmetic changes
  _reapplyPaintForUser(twitchId) {
    if (!this.container) return;
    let sel;
    try { sel = `.chat-line[data-msg-user-id="${CSS.escape(twitchId)}"] .chat-username`; }
    catch { return; }
    for (const el of this.container.querySelectorAll(sel)) {
      el.classList.remove("has-7tv-paint");
      el.style.backgroundImage = "";
      el.style.filter = "";
      this._applyPaint(el, twitchId);
    }
  }

  _paintCss(paint) {
    const data = paint && paint.data;
    if (!data || !Array.isArray(data.layers) || !data.layers.length) return null;
    const rgba = (c) => (c ? `rgba(${c.r || 0},${c.g || 0},${c.b || 0},${(c.a == null ? 255 : c.a) / 255})` : "rgba(0,0,0,1)");
    const stopsStr = (stops) => (stops || []).map((s) => `${rgba(s.color)} ${Math.round((s.at || 0) * 100)}%`).join(", ");
    const images = [];
    for (const layer of data.layers) {
      const ty = layer.ty || {};
      switch (ty.__typename) {
        case "PaintLayerTypeLinearGradient": {
          const s = stopsStr(ty.stops);
          if (s) images.push(`${ty.repeating ? "repeating-" : ""}linear-gradient(${ty.angle || 0}deg, ${s})`);
          break;
        }
        case "PaintLayerTypeRadialGradient": {
          const s = stopsStr(ty.stops);
          if (s) images.push(`${ty.repeating ? "repeating-" : ""}radial-gradient(circle, ${s})`);
          break;
        }
        case "PaintLayerTypeSingleColor": {
          const c = rgba(ty.color);
          images.push(`linear-gradient(${c}, ${c})`);
          break;
        }
        default: break; // image layers deferred
      }
    }
    if (!images.length) return null;
    let filter = "";
    if (Array.isArray(data.shadows) && data.shadows.length) {
      filter = data.shadows
        .map((s) => `drop-shadow(${s.offsetX || 0}px ${s.offsetY || 0}px ${s.blur || 0}px ${rgba(s.color)})`)
        .join(" ");
    }
    return { backgroundImage: images.join(", "), filter };
  }

  // --- chat mode indicators (emote-only / subs-only / followers / slow / unique) + timeout panel ---
  _setupRoomListeners() {
    if (this._roomListenersBound) return;
    this._roomListenersBound = true;
    listen("chat-roomstate", (e) => this._onRoomState(e.payload || {})).catch(() => {});
    listen("chat-clearchat", (e) => this._onClearChat(e.payload || {})).catch(() => {});
  }

  _onRoomState(p) {
    if (!this._roomModes) this._roomModes = {};
    const m = this._roomModes;
    if (p.emote_only != null) m.emoteOnly = p.emote_only;
    if (p.subs_only != null) m.subsOnly = p.subs_only;
    if (p.r9k != null) m.r9k = p.r9k;
    if (p.followers_only != null) m.followersOnly = p.followers_only; // -1 off, 0 all, N min
    if (p.slow != null) m.slow = p.slow; // seconds, 0 off
    this._renderChatModes();
  }

  _renderChatModes() {
    const wrap = document.getElementById("chat-mode-indicators");
    if (!wrap) return;
    const m = this._roomModes || {};
    const chips = [];
    if (m.emoteOnly) chips.push("Emote Only");
    if (m.subsOnly) chips.push("Subscriber Only");
    if (m.followersOnly != null && m.followersOnly >= 0) {
      chips.push(m.followersOnly > 0 ? `Followers Only (${this._fmtFollowDur(m.followersOnly)})` : "Followers Only");
    }
    if (m.slow && m.slow > 0) chips.push(`Slow Mode (${m.slow}s)`);
    if (m.r9k) chips.push("Unique Chat");
    wrap.innerHTML = "";
    if (!chips.length) { wrap.style.display = "none"; return; }
    for (const label of chips) {
      const chip = document.createElement("span");
      chip.className = "chat-mode-chip";
      chip.textContent = label;
      wrap.appendChild(chip);
    }
    wrap.style.display = "";
  }

  _fmtFollowDur(min) {
    if (min >= 1440) return `${Math.round(min / 1440)}d`;
    if (min >= 60) return `${Math.round(min / 60)}h`;
    return `${min}m`;
  }

  _onClearChat(p) {
    // a CLEARCHAT targeting our own user id means we were timed out / banned
    if (!this.ownUserId || !p) return;
    if (String(p.target_user_id) !== String(this.ownUserId)) return;
    this._showTimeoutPanel(p.ban_duration_secs && p.ban_duration_secs > 0 ? p.ban_duration_secs : null);
  }

  _showTimeoutPanel(secs) {
    const panel = document.getElementById("chat-timeout-panel");
    const wrapper = document.getElementById("chat-input-wrapper");
    if (!panel || !wrapper) return;
    if (this._timeoutTicker) { clearInterval(this._timeoutTicker); this._timeoutTicker = null; }
    const banned = secs == null;
    if (!banned) this._timeoutEnds = Date.now() + secs * 1000;
    wrapper.style.display = "none";
    panel.style.display = "";
    // built once; only the countdown text updates each second (rebuilding would make the button flicker)
    panel.innerHTML =
      `<div class="chat-timeout-title">\u23F1 ${banned ? "BANNED" : "TIMEOUT"}</div>` +
      `<div class="chat-timeout-body"></div>` +
      // fallback if the live unban notice doesn't arrive: re-enable the box; if Twitch still refuses the
      // next message (msg_banned / msg_timedout NOTICE) the panel comes straight back
      `<button type="button" class="chat-timeout-recheck" title="Unbanned? Re-enable the message box">Check again</button>`;
    panel.querySelector(".chat-timeout-recheck").addEventListener("click", () => this._hideTimeoutPanel());
    const bodyEl = panel.querySelector(".chat-timeout-body");
    const render = () => {
      if (banned) {
        bodyEl.textContent = "You are permanently banned from this chat.";
        return;
      }
      const remain = Math.max(0, Math.ceil((this._timeoutEnds - Date.now()) / 1000));
      if (remain <= 0) { this._hideTimeoutPanel(); return; }
      bodyEl.textContent = `You are currently timed out from Chat, you can chat again in ${this._fmtCountdown(remain)}.`;
    };
    render();
    if (!banned) this._timeoutTicker = setInterval(render, 1000);
  }

  _hideTimeoutPanel() {
    if (this._timeoutTicker) { clearInterval(this._timeoutTicker); this._timeoutTicker = null; }
    const panel = document.getElementById("chat-timeout-panel");
    const wrapper = document.getElementById("chat-input-wrapper");
    if (panel) { panel.style.display = "none"; panel.innerHTML = ""; }
    if (wrapper && !this._isVodMode) wrapper.style.display = "";
  }

  _fmtCountdown(s) {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    if (m > 0) return `${m} minute${m > 1 ? "s" : ""} ${sec} second${sec !== 1 ? "s" : ""}`;
    return `${sec} second${sec !== 1 ? "s" : ""}`;
  }

  openThread(rootId) {
    if (!rootId) return;
    this._openThreadRoot = rootId;
    const pane = document.getElementById("chat-pane");
    if (!pane) return;
    let panel = document.getElementById("thread-panel");
    if (!panel) {
      panel = document.createElement("div");
      panel.id = "thread-panel";
      panel.className = "thread-panel";
      panel.innerHTML =
        '<div class="thread-panel-header">' +
        '<span class="thread-panel-title">Thread</span>' +
        '<button class="thread-panel-close" title="Close">\u2715</button>' +
        '</div>' +
        '<div class="thread-panel-body" id="thread-panel-body"></div>' +
        '<div class="thread-panel-replyctx">Replying to <span class="thread-panel-replyuser"></span> \u00b7 ' +
        '<button class="thread-panel-cancel">Cancel</button></div>' +
        '<div class="thread-panel-inputrow">' +
        '<input type="text" class="thread-panel-input" placeholder="Reply\u2026" maxlength="500" />' +
        '<button class="thread-panel-send">Reply</button>' +
        '</div>';
      pane.appendChild(panel);
      panel.querySelector(".thread-panel-close").addEventListener("click", () => this.closeThread());
      panel.querySelector(".thread-panel-cancel").addEventListener("click", () => this.closeThread());
      const input = panel.querySelector(".thread-panel-input");
      const send = panel.querySelector(".thread-panel-send");
      const doSend = async () => {
        const text = input.value.trim();
        if (!text || !this.isLoggedIn || this._isKickChat) return;
        // reply into the thread: parent = the latest message in the thread, falling back to the root
        const inThread = this._msgStore
          ? [...this._msgStore.values()].filter((m) => m.threadRootId === this._openThreadRoot)
          : [];
        const target = inThread.length ? inThread[inThread.length - 1].id : this._openThreadRoot;
        send.disabled = true;
        try {
          await invoke("send_chat_message", { message: text, replyToMsgId: target });
          input.value = "";
          // Twitch never echoes our own message back, so render it optimistically. A thread reply is
          // still a normal chat message, so show it in the MAIN CHAT too (not just the thread) — that's
          // where it was going missing. renderMessage writes the single _msgStore entry (under this
          // thread's root) and, because that root matches the open thread, also appends it to the
          // thread panel live. So one call covers both views without a duplicate store entry.
          if (!this._isKickChat && this._openThreadRoot) {
            const parentMsg = this._msgStore ? this._msgStore.get(target) : null;
            const parentUser = parentMsg?.user || null;
            const parentBody = parentMsg?.body || null;
            const localId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            this.renderMessage(
              this.ownDisplayName || this.ownLogin || "you",
              this._ownColor || "#9147ff",
              text,
              this._ownBadgesTag,
              undefined, undefined,
              parentUser || undefined, parentBody || undefined,
              localId, this.ownUserId,
              /*isAction=*/false, /*emotesTag=*/null, /*isFirstMsg=*/false,
              /*isHighlighted=*/false, /*replyParentMsgId=*/target,
              /*replyThreadParentMsgId=*/this._openThreadRoot,
            );
          }
        } catch (err) {
          this.systemLine(`Couldn't send: ${err}`);
        } finally {
          send.disabled = false;
          input.focus();
        }
      };
      send.addEventListener("click", doSend);
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); doSend(); } });
    }

    const body = panel.querySelector(".thread-panel-body");
    body.innerHTML = "";
    const msgs = this._msgStore
      ? [...this._msgStore.values()].filter((m) => m.threadRootId === rootId)
      : [];
    if (!msgs.length) {
      body.innerHTML = '<div class="thread-panel-empty">This thread\u2019s messages aren\u2019t in view. Only messages received since you joined this channel are shown.</div>';
    } else {
      for (const m of msgs) body.appendChild(this._buildThreadLine(m));
    }
    const canReply = this.isLoggedIn && !this._isKickChat;
    panel.querySelector(".thread-panel-inputrow").style.display = canReply ? "" : "none";
    panel.querySelector(".thread-panel-replyctx").style.display = canReply ? "" : "none";
    this._updateThreadReplyCtx();
    panel.style.display = "flex";
    body.scrollTop = body.scrollHeight;
  }

  // reflect who a thread reply will go to (the latest message in the thread)
  _updateThreadReplyCtx() {
    const panel = document.getElementById("thread-panel");
    if (!panel || !this._openThreadRoot) return;
    const inThread = this._msgStore
      ? [...this._msgStore.values()].filter((m) => m.threadRootId === this._openThreadRoot)
      : [];
    const last = inThread.length ? inThread[inThread.length - 1] : null;
    const who = panel.querySelector(".thread-panel-replyuser");
    if (who) who.textContent = last ? `@${last.user}` : "thread";
  }

  closeThread() {
    this._openThreadRoot = null;
    const panel = document.getElementById("thread-panel");
    if (panel) panel.style.display = "none";
  }

  _buildThreadLine(m) {
    const line = document.createElement("div");
    line.className = "thread-line";
    if (m.id === this._openThreadRoot) line.classList.add("thread-root");
    const user = document.createElement("span");
    user.className = "thread-line-user";
    user.style.color = m.color || "#9147ff";
    user.textContent = m.user;
    line.appendChild(user);
    line.appendChild(document.createTextNode(": "));
    const bodyEl = document.createElement("span");
    bodyEl.className = "thread-line-body";
    try { bodyEl.appendChild(this._filteredBody(m.body, m.emotesTag || null, m.user)); }
    catch { bodyEl.textContent = m.body; }
    line.appendChild(bodyEl);
    return line;
  }

  _appendThreadLine(m) {
    const body = document.getElementById("thread-panel-body");
    if (!body) return;
    const empty = body.querySelector(".thread-panel-empty");
    if (empty) empty.remove();
    const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
    body.appendChild(this._buildThreadLine(m));
    if (atBottom) body.scrollTop = body.scrollHeight;
    this._updateThreadReplyCtx();
  }

  _startResubPoll(login) {
    this._stopResubPoll();
    if (!login) return;
    const check = async () => {
      if (this.channel !== login) return;
      let info = null;
      try { info = await invoke("get_resub_notification", { channelLogin: login }); } catch { return; }
      if (this.channel !== login) return;
      const el = document.getElementById("resub-banner");
      if (!el) return;
      const months = info ? (info.cumulative_months || info.months || 0) : 0;
      if (!info || months <= 0) { el.style.display = "none"; return; }
      this._renderResubBanner(el, info, login, months);
    };
    check();
    this._resubTimer = setInterval(check, 5 * 60 * 1000); // anniversaries don't appear often
  }

  _stopResubPoll() {
    if (this._resubTimer) { clearInterval(this._resubTimer); this._resubTimer = null; }
    const el = document.getElementById("resub-banner");
    if (el) { el.style.display = "none"; el.innerHTML = ""; }
  }

  _renderResubBanner(el, info, login, months) {
    el.innerHTML = "";
    const text = document.createElement("span");
    text.className = "resub-banner-text";
    text.textContent = `It's your ${months} month sub anniversary!`;
    const share = document.createElement("button");
    share.className = "resub-banner-share";
    share.textContent = "Share";
    const dismiss = document.createElement("button");
    dismiss.className = "resub-banner-dismiss";
    dismiss.textContent = "\u2715";
    dismiss.title = "Dismiss";
    dismiss.addEventListener("click", () => { el.style.display = "none"; });

    const doShare = async (message, btn) => {
      btn.disabled = true;
      btn.textContent = "Sharing\u2026";
      try {
        await invoke("share_resub", {
          channelLogin: login,
          message: (message && message.trim()) ? message.trim() : null,
          includeStreak: (info.streak_months || 0) > 1,
        });
        el.style.display = "none";
        el.innerHTML = "";
      } catch (e) {
        btn.disabled = false;
        btn.textContent = "Retry";
        btn.title = typeof e === "string" ? e : "Failed";
      }
    };

    // clicking Share swaps in a message box (like twitch.tv), so the anniversary can carry a message
    share.addEventListener("click", () => {
      text.style.display = "none";
      share.style.display = "none";
      const wrap = document.createElement("span");
      wrap.className = "resub-banner-inputwrap";
      const input = document.createElement("input");
      input.type = "text";
      input.className = "resub-banner-input";
      input.placeholder = "Add a message (optional)";
      input.maxLength = 500;
      const send = document.createElement("button");
      send.className = "resub-banner-share";
      send.textContent = "Send";
      wrap.appendChild(input);
      wrap.appendChild(send);
      el.insertBefore(wrap, dismiss);
      input.focus();
      send.addEventListener("click", () => doShare(input.value, send));
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") doShare(input.value, send); });
    });

    el.appendChild(text);
    el.appendChild(share);
    el.appendChild(dismiss);
    el.style.display = "";
  }


  _startPinPoll(channelId) {
    this._stopPinPoll();
    if (!channelId) return;
    const poll = async () => {
      try {
        const pins = await invoke("get_pinned_chat_messages", { channelId });
        this._renderPin(Array.isArray(pins) ? pins : []);
      } catch (err) {
        console.error("[pinned] GetPinnedChat failed:", err);
      }
    };
    poll();
    this._pinPollTimer = setInterval(poll, 30000);
  }

  _stopPinPoll() {
    if (this._pinPollTimer) {
      clearInterval(this._pinPollTimer);
      this._pinPollTimer = null;
    }
    this._dismissedPinId = null;
    this._renderPin([]);
  }

  // renders the first pin as a banner (dismissible until a different message is pinned). uses
  // textContent for user/message so pinned content can't inject markup
  _renderPin(pins) {
    const el = document.getElementById("pinned-message");
    if (!el) return;
    const pin = pins && pins[0];
    if (!pin || !pin.text) {
      el.style.display = "none";
      el.replaceChildren();
      return;
    }
    if (pin.message_id && pin.message_id === this._dismissedPinId) {
      el.style.display = "none";
      return;
    }
    el.innerHTML =
      '<svg class="pinned-icon" viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true"><path d="M14 2l6 6-4 1-3 3-1 5-3-3-4.5 4.5-1.4-1.4L11 15.6 8 12.6l5-1 3-3z"/></svg>' +
      '<div class="pinned-body"><span class="pinned-user"></span> <span class="pinned-text"></span></div>' +
      '<button class="pinned-dismiss" aria-label="Dismiss pinned message">\u2715</button>';
    const userEl = el.querySelector(".pinned-user");
    const textEl = el.querySelector(".pinned-text");
    userEl.textContent = pin.sender_name || "";
    if (pin.sender_color && /^#[0-9a-fA-F]{6}$/.test(pin.sender_color)) userEl.style.color = pin.sender_color;
    textEl.textContent = pin.text;
    el.style.display = "flex";
    el.querySelector(".pinned-dismiss").onclick = () => {
      this._dismissedPinId = pin.message_id || "";
      el.style.display = "none";
    };
  }

  // Twitch hype train: poll GetHypeTrainExecution (via Rust get_hype_train) for the watched channel
  // and show a Twitch-style bar atop the chat pane (level, progress, countdown, level-up flash).
  // read-only web GQL, works for any channel (unlike the broadcaster-only EventSub path)
  _startHypePoll(login) {
    this._stopHypePoll();
    this._stopPredictionPoll();
    if (!login) return;
    this._hypePollActive = true;
    // adaptive cadence (matches StreamNook): poll fast while a train runs so the bar tracks
    // contributions instead of jumping once every interval, faster still near a level-up, slow when idle
    const IDLE = 15000, ACTIVE = 3000, IMMINENT = 1000;
    const poll = async () => {
      if (!this._hypePollActive) return;
      let next = IDLE;
      try {
        const d = await invoke("get_hype_train", { channelLogin: login });
        if (d && d.active) {
          // level-up detection for the celebration flash
          const prev = this._hype ? this._hype.level : 0;
          this._hype = d;
          this._renderHype(prev > 0 && d.level > prev);
          // 1s countdown ticker (only started once)
          if (!this._hypeTick) this._hypeTick = setInterval(() => this._tickHype(), 1000);
          const imminent = d.goal > 0 && d.progress / d.goal > 0.85;
          next = imminent ? IMMINENT : ACTIVE;
        } else {
          this._clearHype();
          next = IDLE;
        }
      } catch (err) {
        console.error("[hype] GetHypeTrainExecution failed:", err);
      }
      if (this._hypePollActive) this._hypePollTimer = setTimeout(poll, next);
    };
    poll();
  }

  _stopHypePoll() {
    this._hypePollActive = false;
    if (this._hypePollTimer) { clearTimeout(this._hypePollTimer); this._hypePollTimer = null; }
    this._clearHype();
  }

  _clearHype() {
    this._hype = null;
    if (this._hypeTick) { clearInterval(this._hypeTick); this._hypeTick = null; }
    const el = document.getElementById("hype-train-banner");
    if (el) { el.style.display = "none"; el.replaceChildren(); }
  }

  // ms remaining until the train expires
  _hypeMsLeft() {
    if (!this._hype || !this._hype.expires_at) return 0;
    const t = Date.parse(this._hype.expires_at);
    return isNaN(t) ? 0 : t - Date.now();
  }

  _tickHype() {
    if (!this._hype) return;
    if (this._hypeMsLeft() <= 0) { this._clearHype(); return; }
    const c = document.getElementById("hype-countdown");
    if (c) c.textContent = this._fmtHypeTime(this._hypeMsLeft());
  }

  _fmtHypeTime(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }

  _renderHype(levelUp) {
    const el = document.getElementById("hype-train-banner");
    if (!el || !this._hype) return;
    const h = this._hype;
    const pct = h.goal > 0 ? Math.min(100, Math.round((h.progress / h.goal) * 100)) : 0;
    el.className = "hype-train-banner" + (h.is_golden ? " golden" : "");
    el.innerHTML =
      '<div class="hype-fill"></div>' +
      '<div class="hype-row">' +
        '<span class="hype-left">' +
          '<svg viewBox="0 0 15 13" width="15" height="13" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" clip-rule="evenodd" d="M4.1.55H2.4v4.25H.7v5.95h.85a1.7 1.7 0 0 0 3.4 0h.85a1.7 1.7 0 0 0 3.4 0h.85a1.7 1.7 0 0 0 3.4 0h.85V.55H6.65v1.7h.85v2.55H4.1V.55zM12.6 9.05V6.5H2.4v2.55h10.2zM9.2 4.8h3.4V2.25H9.2V4.8z"/></svg>' +
          '<span class="hype-level"></span>' +
        '</span>' +
        '<span class="hype-pct"></span>' +
        '<span class="hype-countdown" id="hype-countdown"></span>' +
      '</div>';
    el.querySelector(".hype-fill").style.width = pct + "%";
    el.querySelector(".hype-level").textContent = (h.is_golden ? "✨ " : "") + "LVL " + h.level;
    el.querySelector(".hype-pct").textContent = levelUp ? "LEVEL UP!" : pct + "%";
    el.querySelector("#hype-countdown").textContent = this._fmtHypeTime(this._hypeMsLeft());
    el.style.display = "block";
    if (levelUp) {
      el.classList.add("level-up");
      setTimeout(() => el.classList.remove("level-up"), 2500);
    }
  }

  // Twitch prediction: poll GetChannelPrediction (via Rust) for the watched channel and show an
  // overlay atop chat (title, outcomes with vote bars + point/user totals, status, countdown). needs
  // the device login (same token as pins); nothing shows otherwise
  _startPredictionPoll(login) {
    this._stopPredictionPoll();
    if (!login) return;
    const poll = async () => {
      try {
        const p = await invoke("get_channel_prediction", { channelLogin: login });
        this._prediction = p && p.id ? p : null;
        this._renderPrediction();
        if (this._prediction && !this._predTick) this._predTick = setInterval(() => this._tickPrediction(), 1000);
      } catch (err) {
        console.error("[prediction] GetChannelPrediction failed:", err);
      }
    };
    poll();
    this._predPollTimer = setInterval(poll, 5000);
  }

  _stopPredictionPoll() {
    if (this._predPollTimer) { clearInterval(this._predPollTimer); this._predPollTimer = null; }
    this._prediction = null;
    if (this._predTick) { clearInterval(this._predTick); this._predTick = null; }
    const el = document.getElementById("prediction-overlay");
    if (el) { el.style.display = "none"; el.replaceChildren(); }
  }

  _predSecondsLeft() {
    const p = this._prediction;
    if (!p || !p.created_at) return 0;
    const start = Date.parse(p.created_at);
    if (isNaN(start)) return 0;
    return Math.max(0, Math.round((start + p.window_seconds * 1000 - Date.now()) / 1000));
  }

  _tickPrediction() {
    if (!this._prediction) return;
    if (this._prediction.status === "ACTIVE") {
      const c = document.getElementById("prediction-countdown");
      if (c) c.textContent = this._predSecondsLeft() + "s";
    }
  }

  _renderPrediction() {
    const el = document.getElementById("prediction-overlay");
    if (!el) return;
    const p = this._prediction;
    if (!p) { el.style.display = "none"; el.replaceChildren(); return; }

    const totalPoints = p.outcomes.reduce((a, o) => a + (o.total_points || 0), 0);
    const statusText =
      p.status === "ACTIVE" ? `<span id="prediction-countdown">${this._predSecondsLeft()}s</span>`
      : p.status === "LOCKED" ? "Locked" : "Result";

    const rows = p.outcomes.map((o) => {
      const pct = totalPoints > 0 ? Math.round((o.total_points / totalPoints) * 100) : 0;
      const isWinner = p.winning_outcome_id && o.id === p.winning_outcome_id;
      const colorClass = (o.color || "BLUE").toLowerCase() === "pink" ? "pink" : "blue";
      return (
        `<div class="pred-outcome ${colorClass}${isWinner ? " winner" : ""}">` +
          `<div class="pred-fill" style="width:${pct}%"></div>` +
          `<div class="pred-outcome-row">` +
            `<span class="pred-title"></span>` +
            `<span class="pred-stats">${pct}% · ${fmtCount(o.total_points)}</span>` +
          `</div>` +
        `</div>`
      );
    }).join("");

    el.innerHTML =
      `<div class="pred-head"><span class="pred-badge">Prediction</span><span class="pred-name"></span><span class="pred-status">${statusText}</span></div>` +
      `<div class="pred-outcomes">${rows}</div>`;
    el.querySelector(".pred-name").textContent = p.title || "";
    // set outcome titles via textContent (avoid markup injection)
    el.querySelectorAll(".pred-outcome").forEach((node, i) => {
      const t = node.querySelector(".pred-title");
      if (t) t.textContent = p.outcomes[i] ? p.outcomes[i].title : "";
    });
    el.style.display = "block";
  }

  // persistent channel-points balance pill next to the chatbox. polls the current channel's balance
  // (device login required); hides when not connected / no balance / on Kick
  _startPointsPoll(login) {
    this._stopPointsPoll();
    if (!login) return;
    const setBal = (txt) => {
      const el = document.getElementById("rewards-balance");
      const btn = document.getElementById("rewards-btn");
      if (el) el.textContent = txt || "";
      if (btn) btn.classList.toggle("has-balance", !!txt);
    };
    const poll = async () => {
      try {
        const p = await invoke("get_channel_points", { channelLogin: login });
        setBal(p == null ? "" : fmtCount(p));
      } catch { setBal(""); }
    };
    poll();
    this._pointsPollTimer = setInterval(poll, 60000);
  }

  _stopPointsPoll() {
    if (this._pointsPollTimer) { clearInterval(this._pointsPollTimer); this._pointsPollTimer = null; }
    const el = document.getElementById("rewards-balance");
    const btn = document.getElementById("rewards-btn");
    if (el) el.textContent = "";
    if (btn) btn.classList.remove("has-balance");
  }

  renderMessage(username, color, message, badgesTag, bits, customRewardId,
                replyParentUser, replyParentBody, msgId, userId, isAction = false,
                emotesTag = null, isFirstMsg = false, isHighlighted = false, replyParentMsgId = null,
                replyThreadParentMsgId = null) {
    // words/phrases hide the whole message (see reloadChatFilter / the Chat Filter modal)
    if (this._shouldFilterMessage(username, message, emotesTag)) return;

    // keep a bounded store of recent messages for the threaded reply view (Twitch only; needs a msg id)
    if (msgId && !this._isKickChat) {
      const threadRootId = replyThreadParentMsgId || msgId;
      if (!this._msgStore) this._msgStore = new Map();
      this._msgStore.set(msgId, {
        id: msgId, user: username, color, body: message, emotesTag, isAction,
        threadRootId, parentUser: replyParentUser || null,
      });
      if (this._msgStore.size > 1000) this._msgStore.delete(this._msgStore.keys().next().value);
      // if this belongs to the thread currently open, append it live
      if (this._openThreadRoot && threadRootId === this._openThreadRoot) {
        this._appendThreadLine(this._msgStore.get(msgId));
      }
    }
    // blocked emotes: stripped from the body but the message still shows, UNLESS it's only blocked
    // emotes (then hide it). own messages are never filtered or stripped
    const _own = (this._isKickChat ? this._kickLogin : this.ownLogin) || this.ownDisplayName;
    const isOwnMsg = !!(_own && username && username.toLowerCase() === _own.toLowerCase());
    const stripEmotes = !isOwnMsg && !!(this._compiledFilter && this._compiledFilter.emotes.size);
    if (stripEmotes && this._messageIsOnlyBlockedEmotes(message, emotesTag)) return;

    const line = document.createElement("div");
    line.className = "chat-line";
    // synthetic local ids (our own un-echoed messages) go in the store for threading but must not be
    // exposed as dataset.msgId — they're not real Twitch ids, so Reply/Delete against them would fail
    if (msgId && !String(msgId).startsWith("local-")) line.dataset.msgId = msgId;
    if (userId) line.dataset.msgUserId = userId;
    line.dataset.msgUsername = username;
    line.dataset.msgText = message;

    // tracked for every message with a real sender id (not the local echo / VOD replay). history is capped since only the card needs it, and only the last few
    if (userId) {
      this._messageCountByUserId.set(userId, (this._messageCountByUserId.get(userId) || 0) + 1);
      const history = this._messageHistoryByUserId.get(userId) || [];
      history.push({ time: Date.now(), text: message });
      if (history.length > USER_CARD_HISTORY_LIMIT) history.shift();
      this._messageHistoryByUserId.set(userId, history);
    }

    // channel point message: left-border highlight + gem prefix
    if (customRewardId) {
      line.classList.add("is-channel-point-message");
      const gem = document.createElement("span");
      gem.className = "channel-point-gem";
      gem.title = "Channel Point Redemption";
      line.appendChild(gem);
    }

    // "Highlight My Message" reward (msg-id=highlighted-message): accent left border + tint, matching twitch.tv
    if (isHighlighted) {
      line.classList.add("is-highlighted-message");
      const hdr = document.createElement("div");
      hdr.className = "highlight-redeem-header";
      const gem = document.createElement("span");
      gem.className = "channel-point-gem";
      hdr.appendChild(gem);
      const who = document.createElement("span");
      who.className = "highlight-redeem-user";
      who.textContent = username;
      hdr.appendChild(who);
      hdr.appendChild(document.createTextNode(" redeemed Highlight My Message"));
      line.insertBefore(hdr, line.firstChild);
    }

    // first-time chatter: purple highlight matching twitch.tv's treatment for a user's first message in the channel (IRC "first-msg" tag, see is_first_msg in chat.rs). the classic viewer-visible welcome
    if (isFirstMsg) {
      line.classList.add("is-first-msg");
      const label = document.createElement("div");
      label.className = "first-msg-label";
      label.textContent = "First time chatting";
      line.appendChild(label);
    }

    if (replyParentUser && replyParentBody) {
      line.classList.add("is-reply");
      const replyHeader = document.createElement("div");
      replyHeader.className = "reply-header";
      replyHeader.textContent = `↩ ${replyParentUser}: ${replyParentBody}`;
      replyHeader.title = `Replying to ${replyParentUser}: ${replyParentBody}`;
      replyHeader.addEventListener("click", (e) => {
        e.stopPropagation();
        const rootId = replyThreadParentMsgId || replyParentMsgId;
        if (rootId) this.openThread(rootId);
        else replyHeader.classList.toggle("expanded");
      });
      line.appendChild(replyHeader);
    }

    // mention highlight when the body contains @ownLogin, or this is a reply to a message by ownLogin. the login is platform-appropriate: ownLogin is Twitch-only, so Kick sessions use the Kick login (else @'s of the Kick name matched nothing)
    const mentionLogin = this._isKickChat ? this._kickLogin : this.ownLogin;
    if (mentionLogin) {
      const login = mentionLogin.toLowerCase();
      // escape regex metacharacters defensively, Twitch logins are [a-z0-9_] but Kick usernames can carry characters like '-'
      const escaped = login.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      // match with OR without the "@", Twitch highlights a bare "Name," like "@Name". the branches need different left edges: @ is non-word, while the bare name needs a word boundary so "xName"/"Name8" don't light up
      const bodyMention = new RegExp(`(?:@|\\b)${escaped}\\b`, "i").test(message);
      const replyToMe = replyParentUser &&
        replyParentUser.toLowerCase() === login;
      if (bodyMention || replyToMe) {
        line.classList.add("is-mention");
      }
    }

    // wrapped in a span so this point stays addressable by _backfillOwnBadges(), a badge set that finishes loading after this line rendered (a real race) can still be patched in
    const badgeSlot = document.createElement("span");
    badgeSlot.className = "chat-badges-slot";
    badgeSlot.dataset.badgesTag = badgesTag || "";
    const badgeFragment = this.renderBadges(badgesTag);
    if (badgeFragment) badgeSlot.appendChild(badgeFragment);
    line.appendChild(badgeSlot);

    const nameSpan = document.createElement("span");
    nameSpan.className = "chat-username";
    nameSpan.style.color = this.normalizeColor(color);
    nameSpan.textContent = username + ":";
    if (userId) this._applyPaint(nameSpan, userId);
    // clicking the username opens the user card (avatar, account age, timeout/ban, delete). timeout/ban are card-only (like Twitch); delete is also on the hover row. needs the sender's userId, absent only for the local echo. VOD lines have a real userId, so their cards work; timeout/ban stay disabled there (no roomId)
    if (userId) {
      nameSpan.classList.add("chat-username-clickable");
      nameSpan.addEventListener("click", (e) => {
        e.stopPropagation();
        this._showUserCard(nameSpan, userId, username, badgesTag, msgId, message);
      });
    }
    if (userId) { const sb = this._seventvBadgeEl(userId); if (sb) line.appendChild(sb); }
    line.appendChild(nameSpan);
    if (userId && this._noteUserIds && this._noteUserIds.has(userId)) {
      const noteDot = document.createElement("span");
      noteDot.className = "chat-note-dot";
      noteDot.title = "You have a note on this user";
      line.appendChild(noteDot);
    }

    const textSpan = document.createElement("span");
    textSpan.className = "chat-message-text" + (isAction ? " chat-action-message" : "");
    if (isAction) textSpan.style.fontStyle = "italic";
    // "ASCII art" (Braille / block / box-drawing pictures). See _isAsciiArt, _asciiArtRows,
    // _renderAsciiArtRows, _renderAsciiArtFlow and fitArt
    const isAsciiArt = this._isAsciiArt(message);
    const artRows = isAsciiArt ? this._asciiArtRows(message) : null;
    if (artRows) {
      // normal case: the message is clean rows separated by single spaces. draw them one per line in
      // Twitch's font stack (so every glyph resolves to the same font Twitch uses) and scale to fit
      line.classList.add("is-ascii-art-rows");
      textSpan.appendChild(this._renderAsciiArtRows(artRows));
    } else if (isAsciiArt) {
      // fallback for art whose chunks aren't clean rows: Twitch web chat's exact text width + font with
      // normal wrapping (Chatterino's approach), scaled to fit
      line.classList.add("is-ascii-art-rows");
      textSpan.appendChild(this._renderAsciiArtFlow(this.renderMessageBody(message, emotesTag, stripEmotes)));
    } else {
      textSpan.appendChild(this.renderMessageBody(message, emotesTag, stripEmotes));
    }
    line.appendChild(document.createTextNode(" "));
    line.appendChild(textSpan);

    // bits badge after the text, tier-colored and animated (mirrors Twitch's cheermote tiers). also tints the whole line so cheers stand out
    if (bits && bits > 0) {
      line.classList.add("has-bits");
      const tier =
        bits >= 10000 ? "red" :
        bits >= 5000  ? "blue" :
        bits >= 1000  ? "green" :
        bits >= 100   ? "purple" : "gray";
      const badge = document.createElement("span");
      badge.className = `bits-total-badge cheer-${tier}`;
      badge.title = `${bits.toLocaleString()} bits cheered`;
      badge.textContent = `⬧ ${bits.toLocaleString()}`;
      line.appendChild(badge);
    }

    // built lazily on first mouseenter to avoid creating DOM nodes for every message up front
    line.addEventListener("mouseenter", () => {
      if (line.querySelector(".chat-line-actions")) return; // already built
      const actions = document.createElement("div");
      actions.className = "chat-line-actions";

      const copyBtn = document.createElement("button");
      copyBtn.className = "chat-line-action-btn";
      copyBtn.title = "Copy message";
      copyBtn.innerHTML = `<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
        <path d="M4 2h7a1 1 0 0 1 1 1v9h-1V3H4V2zm-1 2h7a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zm0 10h7V5H3v9z"/>
      </svg>`;
      copyBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        navigator.clipboard.writeText(line.dataset.msgText || "").catch(() => {});
      });

      if (this.isLoggedIn && line.dataset.msgId) {
        const replyBtn = document.createElement("button");
        replyBtn.className = "chat-line-action-btn";
        replyBtn.title = "Reply";
        replyBtn.innerHTML = `<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
          <path d="M6 3.5L1 7.5l5 4V9c3.5 0 6 1 7.5 4C13 9 11 5 6 5V3.5z"/>
        </svg>`;
        replyBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          this._setReplyTarget(line.dataset.msgId, line.dataset.msgUsername, line.dataset.msgText || "");
        });
        actions.appendChild(replyBtn);
      }

      actions.appendChild(copyBtn);

      // Mod-only hover actions (delete / timeout / ban): rendered only when you're a mod of this
      // channel. Non-mods don't see them at all (previously they showed greyed-out and disabled).
      // Enforcement is still server-side; this is purely to declutter chat for non-mods.
      if (this.isMod && this.roomId) {
        const targetUsername = line.dataset.msgUsername || "";
        const isSelf = this._isSelf(targetUsername);

        const canDelete = Boolean(line.dataset.msgId) && !isSelf;
        const deleteBtn = document.createElement("button");
        deleteBtn.className = "chat-line-action-btn mod-action-btn";
        deleteBtn.title = canDelete ? "Delete message" : "Delete message (unavailable)";
        deleteBtn.disabled = !canDelete;
        deleteBtn.innerHTML = `<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
          <path d="M5.5 1a1 1 0 0 0-1 1v1H2v1h12V3h-2.5V2a1 1 0 0 0-1-1h-3zM3 5l.7 8.4A1 1 0 0 0 4.7 14h6.6a1 1 0 0 0 1-.94L13 5H3zm3 2h1v5H6V7zm3 0h1v5H9V7z"/>
        </svg>`;
        deleteBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          if (!canDelete) return;
          this._deleteMessage(line.dataset.msgId, deleteBtn);
        });
        actions.appendChild(deleteBtn);

        // Timeout (with a duration menu) + Ban, matching StreamNook's per-message dock
        const canMod = Boolean(line.dataset.msgUserId) && !isSelf;
        const toBtn = document.createElement("button");
        toBtn.className = "chat-line-action-btn mod-action-btn";
        toBtn.title = canMod ? "Timeout" : "Timeout (unavailable)";
        toBtn.disabled = !canMod;
        toBtn.innerHTML = `<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm0 12.5A5.5 5.5 0 1 1 8 2.5a5.5 5.5 0 0 1 0 11zM7.25 4v4.31l3.4 2 .75-1.25-2.65-1.56V4h-1.5z"/></svg>`;
        toBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          if (!canMod) return;
          this._showTimeoutMenu(toBtn, line.dataset.msgUserId, line.dataset.msgUsername);
        });
        actions.appendChild(toBtn);

        const banBtn = document.createElement("button");
        banBtn.className = "chat-line-action-btn mod-action-btn";
        banBtn.title = canMod ? "Ban" : "Ban (unavailable)";
        banBtn.disabled = !canMod;
        banBtn.innerHTML = `<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zM2.5 8a5.5 5.5 0 0 1 8.9-4.32l-7.72 7.72A5.47 5.47 0 0 1 2.5 8zm5.5 5.5c-1.28 0-2.46-.44-3.4-1.18l7.72-7.72A5.5 5.5 0 0 1 8 13.5z"/></svg>`;
        banBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          if (!canMod) return;
          this._confirmAndBan(line.dataset.msgUserId, line.dataset.msgUsername);
        });
        actions.appendChild(banBtn);
      }

      line.appendChild(actions);
    });

    // copy/reply only; mod actions (besides the hover Delete) live in the user card
    line.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this._showMessageContextMenu(e.clientX, e.clientY, line);
    });

    this.container.appendChild(line);
    this.trimAndScroll();
  }

  renderRedeemEvent({ redeemer, reward_title, reward_cost, user_input, redemption_id }) {
    // own channel delivers redemptions via BOTH EventSub and PubSub; dedupe by redemption id
    if (redemption_id) {
      if (!this._seenRedeem) this._seenRedeem = new Set();
      if (this._seenRedeem.has(redemption_id)) return;
      this._seenRedeem.add(redemption_id);
      if (this._seenRedeem.size > 500) this._seenRedeem.clear();
    }
    const line = document.createElement("div");
    line.className = "chat-line channel-point-redeem-event";

    const icon = document.createElement("span");
    icon.className = "channel-point-gem";
    line.appendChild(icon);

    const redeemInfo = document.createElement("span");
    redeemInfo.className = "redeem-info";

    const nameEl = document.createElement("span");
    nameEl.className = "redeem-username";
    nameEl.textContent = redeemer;
    redeemInfo.appendChild(nameEl);

    redeemInfo.appendChild(document.createTextNode(" redeemed "));

    const titleEl = document.createElement("span");
    titleEl.className = "redeem-title";
    titleEl.textContent = reward_title;
    redeemInfo.appendChild(titleEl);

    const costEl = document.createElement("span");
    costEl.className = "redeem-cost";
    costEl.textContent = ` · ${reward_cost.toLocaleString()} pts`;
    redeemInfo.appendChild(costEl);

    if (user_input) {
      const inputEl = document.createElement("div");
      inputEl.className = "redeem-user-input";
      inputEl.textContent = user_input;
      redeemInfo.appendChild(inputEl);
    }

    line.appendChild(redeemInfo);
    this.container.appendChild(line);
    this.trimAndScroll();
  }

  // zero-width emotes (7TV/BTTV overlays like Fog0) stack onto the emote before them into one glyph. finds the last emote image, wraps it in a positioned container, and layers this one centered over it. returns false if there's no preceding emote
  _overlayZeroWidthEmote(fragment, emoteUrl, word) {
    // the last node is usually a separator space; the emote is before it. walk back past trailing text nodes to the last element (an <img.chat-emote> or an existing overlay container)
    let anchor = fragment.lastChild;
    while (anchor && anchor.nodeType === Node.TEXT_NODE) {
      const prev = anchor.previousSibling;
      // drop the separating space we appended after the previous emote, so the overlay sits flush on it rather than a space away
      fragment.removeChild(anchor);
      anchor = prev;
    }
    if (!anchor || anchor.nodeType !== Node.ELEMENT_NODE) return false;

    let container;
    if (anchor.classList && anchor.classList.contains("chat-emote-overlay")) {
      // already an overlay stack (a second/third zero-width emote on the same base), just add another layer
      container = anchor;
    } else if (anchor.classList && anchor.classList.contains("chat-emote")) {
      container = document.createElement("span");
      container.className = "chat-emote-overlay";
      fragment.replaceChild(container, anchor);
      anchor.classList.add("chat-emote-overlay-base");
      container.appendChild(anchor);
    } else {
      return false;
    }

    const layer = document.createElement("img");
    layer.className = "chat-emote chat-emote-overlay-layer";
    layer.src = emoteUrl;
    layer.alt = word;
    layer.title = word;
    layer.loading = "lazy";
    layer.onerror = () => {
      this._loggedEmoteUrlFailures ??= new Set();
      if (!this._loggedEmoteUrlFailures.has(emoteUrl)) {
        this._loggedEmoteUrlFailures.add(emoteUrl);
        console.warn(`[emotes] Image failed to load for "${word}": ${emoteUrl}`);
      }
    };
    container.appendChild(layer);
    return true;
  }

  // checks Twitch native emotes (by IRC-tag position) first, then 7TV/BTTV (by name), then cheermotes, then plain text
  // ASCII-art detection, same rule as Chatterino (messages/AsciiArt.cpp): at least 40 grapheme
  // clusters containing a Unicode "Symbol, other" (So) or "Symbol, modifier" (Sk) code point. That
  // covers Braille (the vast majority of Twitch art), block elements and box drawing.
  _isAsciiArt(message) {
    if (!message || message.length < ASCII_ART_MIN_GRAPHEMES) return false;
    let n = 0;
    for (const { segment } of graphemeSegmenter().segment(message)) {
      if (ART_SYMBOL_RE.test(segment) && ++n >= ASCII_ART_MIN_GRAPHEMES) return true;
    }
    return false;
  }

  // Twitch sends art as ONE line whose rows are separated by single spaces (blank cells inside a row
  // are U+2800, not spaces). Returns those rows when the chunks really are rows (most the same
  // length, give or take a couple), else null so the caller falls back to width-based wrapping.
  _asciiArtRows(message) {
    // rows are separated by spaces; line breaks count too (older local echoes of pasted art had them)
    const rows = message.split(/[ \r\n\t]+/).filter(Boolean);
    if (rows.length < 2) return null;
    const lens = rows.map((r) => Array.from(r).length).sort((x, y) => x - y);
    const median = lens[Math.floor(lens.length / 2)];
    if (median < 6) return null;
    const close = lens.filter((l) => Math.abs(l - median) <= 2).length;
    return close / rows.length >= 0.6 ? rows : null;
  }

  // One row per line, in Twitch's chat font stack at Twitch's size (13px / 20px lines), never wrapped.
  // No per-character tricks: each glyph resolves to exactly the font Twitch's own chat uses (Braille ->
  // Windows symbol fallback, block chars -> Arial, etc.), so mixed art keeps Twitch's widths. The block
  // is then scaled to fit the chat column and re-fit whenever the column's width changes.
  _renderAsciiArtRows(rows) {
    const outer = document.createElement("div");
    outer.className = "chat-art";
    const inner = document.createElement("div");
    inner.className = "chat-art-inner";
    for (const row of rows) {
      const r = document.createElement("div");
      r.className = "chat-art-row";
      r.textContent = row;
      inner.appendChild(r);
    }
    outer.appendChild(inner);
    observeArtFit(outer, inner);
    return outer;
  }

  // Fallback layout: the message body wrapped normally inside a box exactly as wide as Twitch web
  // chat's text area (300px) in Twitch's font, so it breaks where Twitch breaks it; scaled to fit.
  _renderAsciiArtFlow(bodyNode) {
    const outer = document.createElement("div");
    outer.className = "chat-art";
    const inner = document.createElement("div");
    inner.className = "chat-art-inner chat-art-flow";
    inner.appendChild(bodyNode);
    outer.appendChild(inner);
    observeArtFit(outer, inner);
    return outer;
  }

  // Should this user's message have blocked emotes stripped? Yes when the chat filter blocks any emotes,
  // except for your own messages (same rule as main chat, see renderMessage)
  _stripEmotesFor(username) {
    if (!(this._compiledFilter && this._compiledFilter.emotes.size)) return false;
    const u = String(username || "").toLowerCase();
    if (!u) return true;
    const own = [(this._isKickChat ? this._kickLogin : this.ownLogin), this.ownDisplayName]
      .filter(Boolean).map((x) => String(x).toLowerCase());
    return !own.includes(u);
  }

  // A message body for secondary views (thread panel, Mod Chat): blocked emotes stripped per the chat
  // filter; a message that is ONLY blocked emotes becomes a muted "hidden" note (main chat drops those
  // entirely, but a thread or log needs to keep its shape, e.g. a thread's root message)
  _filteredBody(message, emotesTag, username) {
    const strip = this._stripEmotesFor(username);
    if (strip && this._messageIsOnlyBlockedEmotes(message, emotesTag)) {
      const note = document.createElement("span");
      note.className = "chat-filtered-note";
      note.textContent = "hidden by your chat filter";
      return note;
    }
    return this.renderMessageBody(message, emotesTag, strip);
  }

  // stripEmotes: remove the chat filter's blocked emotes. null (the default) = apply the filter, so every
  // place that shows messages (thread panel, reply banner, Mod Chat, sub/announcement messages, and any
  // future one) is filtered unless it explicitly opts out; main chat passes an explicit value because it
  // exempts your own messages. see _stripEmotesFor / _filteredBody
  renderMessageBody(message, emotesTag = null, stripEmotes = null) {
    if (stripEmotes === null) stripEmotes = !!(this._compiledFilter && this._compiledFilter.emotes.size);
    const fragment = document.createDocumentFragment();
    const twitchEmotes = this.parseTwitchEmotesTag(message, emotesTag);
    const words = message.split(" ");
    let charPos = 0;

    words.forEach((word, i) => {
      // strip blocked emotes: omit any word that renders as a blocked emote (and its trailing space),
      // keeping the rest of the message. the "only blocked emotes" case is hidden upstream in renderMessage
      if (stripEmotes) {
        const blockedName = this._emoteNameForWord(word, twitchEmotes.get(charPos));
        if (blockedName && this._compiledFilter?.emotes.has(blockedName)) {
          charPos += word.length + 1;
          return;
        }
      }
      // id-carrying marker from kick_chat.rs's flatten_emote_tokens. rendered from the id, not a name lookup, so a subscriber's cross-channel emote works too. checked first, the marker can't coincide with a Twitch emote or word
      const kickEmote = this.parseKickEmoteMarker(word);
      if (kickEmote) {
        const emoteUrl = `https://files.kick.com/emotes/${kickEmote.id}/fullsize`;
        const img = document.createElement("img");
        img.className = "chat-emote";
        img.src = emoteUrl;
        img.alt = kickEmote.name;
        img.title = kickEmote.name;
        img.loading = "lazy";
        img.onerror = () => {
          this._loggedEmoteUrlFailures ??= new Set();
          if (!this._loggedEmoteUrlFailures.has(emoteUrl)) {
            this._loggedEmoteUrlFailures.add(emoteUrl);
            console.warn(`[emotes] Image failed to load for "${kickEmote.name}": ${emoteUrl}`);
          }
        };
        fragment.appendChild(img);
        if (i < words.length - 1) fragment.appendChild(document.createTextNode(" "));
        charPos += word.length + 1;
        return;
      }

      // Twitch native emote, matched by character position from the IRC tag
      const twitch = twitchEmotes.get(charPos);
      if (twitch) {
        const img = document.createElement("img");
        img.className = "chat-emote";
        img.src = `https://static-cdn.jtvnw.net/emoticons/v2/${twitch.id}/default/dark/2.0`;
        img.alt = word;
        img.title = word;
        img.loading = "lazy";
        fragment.appendChild(img);
      } else {
        // 7TV / BTTV emote, matched by name; Twitch native, name fallback
        const emote        = this.sevenTvEmotes.get(word);
        const twitchByName = !emote ? (this.twitchNativeEmotes?.get(word) ?? null) : null;
        const emoteUrl     = emote?.url
          ?? (twitchByName ? `https://static-cdn.jtvnw.net/emoticons/v2/${twitchByName.id}/default/dark/2.0` : null);
        if (emoteUrl) {
          // zero-width emotes (Fog0, cvHazmat) render ON TOP OF the preceding emote, not beside it. detect the flag and wrap the previous emote and this one in an overlay container
          if (emote?.zeroWidth) {
            const overlaid = this._overlayZeroWidthEmote(fragment, emoteUrl, word);
            if (overlaid) {
              // a zero-width emote consumes no horizontal space and needs no separator, skip the space and advance charPos
              charPos += word.length + 1;
              return;
            }
            // if there was no preceding emote to overlay onto (zero-width at message start), fall through and render it as a normal image rather than dropping it
          }
          const img = document.createElement("img");
          img.className = "chat-emote";
          img.src = emoteUrl;
          img.alt = word;
          img.title = word;
          img.loading = "lazy";
          // a failed emote image collapses to its alt text, identical to it never loading, which made "emote shows as its name" undiagnosable. log each failing URL once so a dead CDN link is distinguishable from a missing emote
          img.onerror = () => {
            this._loggedEmoteUrlFailures ??= new Set();
            if (!this._loggedEmoteUrlFailures.has(emoteUrl)) {
              this._loggedEmoteUrlFailures.add(emoteUrl);
              console.warn(`[emotes] Image failed to load for "${word}": ${emoteUrl}`);
            }
          };
          fragment.appendChild(img);
        } else if (looksLikeUrl(word)) {
          fragment.appendChild(this._createChatLink(word));
        } else {
          const cheer = this.parseCheermote(word);
          if (cheer) {
            const img = document.createElement("img");
            img.className = "chat-emote cheermote";
            img.src = cheer.tier.url;
            img.alt = word;
            img.title = word;
            img.loading = "lazy";
            fragment.appendChild(img);
            const amt = document.createElement("span");
            amt.className = "bits-amount";
            amt.style.color = cheer.tier.color;
            amt.textContent = cheer.amount.toLocaleString();
            fragment.appendChild(amt);
          } else if (word.length > 0) {
            fragment.appendChild(document.createTextNode(word));
          }
        }
      }
      if (i < words.length - 1) fragment.appendChild(document.createTextNode(" "));
      charPos += word.length + 1;
    });

    return fragment;
  }

  // shows a reply indicator bar above the input and stores the message ID so the next send goes as a reply
  _setReplyTarget(msgId, username, msgText = "") {
    this._replyToId = msgId;
    this._replyToUser = username;
    this._replyToBody = msgText;
    // the thread this reply belongs to: the parent's own thread root if it has one, else the parent id
    // itself (a fresh thread). used to place our optimistic local echo into the right thread, since
    // Twitch never echoes our own message back with an id.
    const parent = this._msgStore ? this._msgStore.get(msgId) : null;
    this._replyToThreadRoot = parent?.threadRootId || msgId;

    // build or re-use the indicator block above the input row. instance-scoped so a second chat (MultiView) gets its own bar
    let bar = this._replyIndicatorEl;
    if (!bar || !bar.isConnected) {
      bar = document.createElement("div");
      bar.className = "chat-reply-indicator";
      const inputRow = this.inputEl?.closest(".chat-input-row, .multiview-chat-input-row");
      if (inputRow) inputRow.parentElement?.insertBefore(bar, inputRow);
      this._replyIndicatorEl = bar;
    }
    bar.innerHTML = "";
    bar.style.display = "block";

    const header = document.createElement("div");
    header.className = "chat-reply-indicator-header";

    const arrow = document.createElement("span");
    arrow.className = "chat-reply-indicator-arrow";
    arrow.textContent = "↩";

    const headerLabel = document.createElement("span");
    headerLabel.className = "chat-reply-indicator-header-label";
    headerLabel.textContent = `Replying to @${username}`;

    const cancel = document.createElement("button");
    cancel.className = "chat-reply-indicator-cancel";
    cancel.title = "Cancel reply";
    cancel.textContent = "✕";
    cancel.addEventListener("click", () => this.clearReply());

    header.appendChild(arrow);
    header.appendChild(headerLabel);
    header.appendChild(cancel);
    bar.appendChild(header);

    const body = document.createElement("div");
    body.className = "chat-reply-indicator-body";

    const userSpan = document.createElement("span");
    userSpan.className = "chat-reply-indicator-user";
    userSpan.textContent = `${username}: `;

    const textSpan = document.createElement("span");
    textSpan.className = "chat-reply-indicator-text";
    // Render emotes in the quote (not just their names). The parent message is in _msgStore keyed by
    // its id, carrying the emotesTag; use renderMessageBody so 7TV/BTTV/FFZ/Twitch emotes show as
    // images, matching how the message appears in chat. Fall back to plain text if it isn't stored.
    // reuse the parent message looked up above (for the thread root); it carries the emotesTag
    try {
      textSpan.appendChild(this.renderMessageBody(msgText, parent?.emotesTag || null, this._stripEmotesFor(username)));
    } catch {
      textSpan.textContent = msgText;
    }

    body.appendChild(userSpan);
    body.appendChild(textSpan);
    bar.appendChild(body);

    // Don't prefill an @mention: this sends as a real Twitch reply (reply-parent-msg-id tag, see
    // send in chat.rs), and the reply context is carried by the thread itself — an @mention in the
    // body would be redundant and is what made replies look like plain mentions. Just focus the
    // empty input; the indicator bar above shows who's being replied to.
    if (this.inputEl) {
      this._autosizeChatInput();
      this.inputEl.focus();
    }
  }

  clearReply() {
    this._replyToId = null;
    this._replyToUser = null;
    this._replyToBody = null;
    this._replyToThreadRoot = null;
    const bar = this._replyIndicatorEl;
    if (bar) bar.style.display = "none";
  }

  // re-derives isMod from the cached USERSTATE badges tag and notifies onModStatusChange() subscribers if it changed. "moderator" or "broadcaster" present in the tag means mod tools should show
  _updateModStatus() {
    const tag = this._ownBadgesTag || "";
    const wasMod = this.isMod;
    this.isMod = tag.split(",").some((pair) => {
      const setId = pair.split("/")[0];
      return setId === "moderator" || setId === "broadcaster";
    });
    // one of the two _maybeFetchChatters() triggers (the other is chat-room); whichever of roomId/isMod arrives second unblocks the fetch
    this._maybeFetchChatters();
    if (this.isMod !== wasMod) {
      // the AutoMod toggle's visibility depends on isMod, refresh even with an empty queue so the button appears the moment USERSTATE confirms mod status
      this._renderAutomodPanel();
      // Hover action bars are built lazily and cached per line; the mod buttons (delete/timeout/ban)
      // are only added when isMod. If mod status flips mid-session, drop the cached bars so each line
      // rebuilds its correct button set on the next hover.
      try {
        this.container?.querySelectorAll(".chat-line-actions").forEach((el) => el.remove());
      } catch { /* container may not exist yet */ }
      for (const fn of this._modStatusListeners) {
        try { fn(this.isMod); } catch (err) { console.error("mod status listener error:", err); }
      }
    }
  }

  // returns an unsubscribe function, same convention as the Tauri listen() calls elsewhere in this file
  onModStatusChange(fn) {
    this._modStatusListeners.push(fn);
    return () => {
      this._modStatusListeners = this._modStatusListeners.filter((f) => f !== fn);
    };
  }

}

// mixed in here rather than inline to keep this file manageable. all run with the same `this` as everything above; no behavioral difference from one giant class body
Object.assign(TwitchChat.prototype, chatEmotesMixin, chatEmotePickerMixin, chatVodReplayMixin, chatBadgesMixin, chatAutomodMixin, chatUserCardMixin, chatModActionsMixin, chatLinkPreviewMixin, chatAutocompleteMixin, chatEventsMixin);

// compact number formatter for prediction point/vote totals (12500 -> "12.5K")
function fmtCount(n) {
  n = Number(n) || 0;
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "K";
  return String(n);
}
