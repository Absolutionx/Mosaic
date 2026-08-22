// Twitch chat: connection lifecycle and the message render pipeline. The IRC WebSocket lives
// in Rust (chat.rs) - WebView2's Tracking Prevention silently killed it in this webview. This
// file is TwitchChat's core (start/stop, the chat-* listeners, send/render); emotes, badges,
// AutoMod, user cards, moderation, link previews, autocomplete, and VOD replay are mixed in
// from src/chat/.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
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

// Must match .chat-input's max-height in index.html - duplicated (not read via
// getComputedStyle) since _autosizeChatInput() needs it every keystroke.
const CHAT_INPUT_MAX_HEIGHT_PX = 120;
export class TwitchChat {
  /**
   * @param {object} opts
   * @param {HTMLElement} opts.container - element to append chat lines into
   * @param {HTMLElement} opts.statusEl - connection-status element
   * @param {HTMLElement} opts.inputEl - message composer
   * @param {HTMLElement} opts.sendBtn - send button
   */
  constructor({ container, statusEl, inputEl, sendBtn, emoteBtn, emotePickerMenu, inputBadge, jumpToLatestBtn, jumpToLatestCount } = {}) {
    this.container = container;
    this.statusEl = statusEl;
    this.inputEl = inputEl;
    this.sendBtn = sendBtn;
    // Composer feature elements, passed in so a second chat (MultiView) owns its own set instead
    // of fighting over global IDs. Falls back to the main chat's elements by ID.
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
    // True while showing VOD replay (read-only, no connection to send to), so the input row is
    // hidden. Set in setVodMode(), cleared in connect().
    this._isVodMode = false;
    // --- Kick chat mode (set by connectKick, cleared by connect/disconnect) ---
    // True while showing Kick chat. sendMessage() branches on this to POST via
    // kick_send_chat_message instead of the Twitch command.
    this._isKickChat = false;
    // The watched Kick channel's broadcaster id. Required to send; null keeps Kick chat
    // read-only even when logged in.
    this._kickBroadcasterId = null;
    // The Kick channel's custom subscriber badge tiers ([{months, src}]) - renderBadges
    // months-matches kick/subscriber/N against these. Empty = generic badge.
    this._kickSubscriberBadges = [];
    // Kick login state, separate from Twitch's isLoggedIn (a user can have either, both, or
    // neither). Driven by setKickLoggedIn().
    this._kickLoggedIn = false;
    this._kickLogin = null;
    // Whether this build can offer Kick login at all - set by main.js
    // via setKickOAuthConfigured() once the async startup check lands.
    this._kickOAuthConfigured = false;
    // No-op until setVodMode() installs the real one - exists so calling it is always safe even
    // before a VOD has loaded.
    this.notifyVodSeek = () => {};
    // Account-level chat color (USERSTATE color tag), used by sendMessage()'s local echo.
    // Account-wide, so unlike _ownBadgesTag it's never reset on channel switch.
    this._ownColor = null;
    // Whether the user is a mod OR broadcaster of the CURRENT channel - what every mod-tools
    // element gates on. Derived from the USERSTATE badges tag in _updateModStatus(), the same
    // info Twitch's IRC server uses, so no separate Helix lookup is needed.
    this.isMod = false;
    /** @type {Array<() => void>} Called when isMod changes, so main.js (which owns the
     * hover-icon/menu DOM) can re-render without chat.js knowing that DOM. */
    this._modStatusListeners = [];
    /** @type {Array<{user_name, user_id, message, msg_id, category, level}>} Held messages
     * awaiting Allow/Deny, newest last. Cleared on every connect(). */
    this._automodQueue = [];
    /** @type {Map<string, number>} userId -> message count this session, for the user card.
     * Reset on connect(). */
    this._messageCountByUserId = new Map();
    /** @type {Map<string, Array<{time, text}>>} userId -> recent message log for the user card,
     * capped at USER_CARD_HISTORY_LIMIT (oldest dropped). */
    this._messageHistoryByUserId = new Map();
    /** @type {Map<string, object|null>} userId -> cached Helix /users result (null = lookup
     * failed), so reopening a card doesn't refetch. */
    this._userInfoCache = new Map();
    /** @type {Map<string, {url: string, zeroWidth: boolean}>} */
    this.sevenTvEmotes      = new Map(); // 7TV/BTTV/FFZ: name -> {url, zeroWidth, provider} - written only via _setEmote (chat-emotes.js), which enforces provider precedence
    this.twitchNativeEmotes = new Map(); // Twitch global: name -> {id, url}
    /** @type {Map<string, {url, title}>} Twitch chat badges, keyed by "setId/version" to match
     * the IRC `badges` tag. Global and channel badges share this map; channel entries override
     * the global default (subscriber/bits), matching Twitch. */
    this.badgeMap = new Map();
    /** Cheermote map: prefix.toLowerCase() -> tiers sorted DESCENDING by minBits (so Array.find
     * gives the highest matching tier first).
     * @type {Map<string, Array<{minBits, url, color}>>} */
    this.cheermoteMap = new Map();
    this.maxLines = 250;
    this.unlisteners = [];
    // Serializes AND supersedes the lifecycle methods (connect/connectKick/disconnect/
    // setVodMode/setKickVodMode). Two needs: (1) no interleaving - overlapping teardown/setup
    // pairs would double every listener; (2) latest-wins - clicking 5 channels fast should connect
    // only the 5th. Each call bumps _lifecycleEpoch and bails if a newer one bumped it. See
    // _serializeLifecycle().
    this._lifecycleChain = Promise.resolve();
    this._lifecycleEpoch = 0;
    // Explicit flag for whether the user scrolled up to read history. Distance-from-bottom
    // checks are unreliable during fast chat - scrollHeight grows the instant a message is
    // appended, so a tall message falsely reads as "scrolled up".
    this.userScrolledUp = false;
    // Marks the next scroll event as caused by our own scrollTop write, not the user; read and
    // cleared by the scroll handler. A boolean, not a counter - a counter desynced when the browser
    // coalesced rapid writes (see trimAndScroll()).
    this._suppressNextScrollEvent = false;

    // Sent-message history for Up/Down navigation. [0] is most recent; _historyIdx is the shown
    // index (-1 = live draft); _historyDraft saves the pre-Up draft so Down past 0 restores it.
    this._sentHistory  = [];
    this._historyIdx   = -1;
    this._historyDraft = "";

    // "Jump to latest" floating button, shown when scrolled up. Scoped to this instance's
    // container so a second chat (MultiView) uses its own.
    this.jumpToLatestBtn = this._jumpToLatestBtnEl
      ?? document.getElementById("jump-to-latest-btn");
    this.jumpToLatestCount = this._jumpToLatestCountEl
      ?? document.getElementById("jump-to-latest-count");
    this.newMessageCountWhileScrolledUp = 0;

    if (this.sendBtn) {
      this.sendBtn.addEventListener("click", () => this.sendMessage());
    }
    // Emote autocomplete popup element - appended to the chat pane so it
    // appears above the input row and can be positioned relative to it.
    this._emotePopup = document.createElement("div");
    this._emotePopup.className = "emote-autocomplete";
    this._emotePopup.style.display = "none";
    // Appended to <body> position:fixed so it's never clipped by overflow:hidden ancestors.
    // Coordinates computed in _showEmotePopup() from the input's live rect.
    document.body.appendChild(this._emotePopup);
    // Currently highlighted item index in the popup list.
    this._emotePopupIndex = -1;
    // Which kind of suggestion the shared popup is showing right now.
    this._popupMode = "emote"; // "emote" | "user"

    // Emote picker: the composer's smiley button + browsable grid (chat-emote-picker.js).
    // Distinct from the popup above (a typed-autocomplete list) - this is an explicit "browse
    // everything" panel, the same distinction Twitch and 7TV draw.
    this._initEmotePicker();
    // @mention autocomplete users, lowercase login -> display name. Populated from every message
    // seen this session and, for a mod/broadcaster, a one-time get_chatters() fetch (see
    // _maybeFetchChatters) that also covers silent viewers. Both merge into one map.
    this._chatUsers = new Map();
    // Guards _maybeFetchChatters() to one fetch per channel (re-checked on chat-room and
    // mod-status, since either can arrive first).
    this._chattersFetchedForChannel = null;

    // Link preview popup - same "position:fixed, appended to body" pattern as the emote popup,
    // positioned from the hovered link's rect.
    this._linkPreviewPopup = document.createElement("div");
    this._linkPreviewPopup.className = "link-preview-popup";
    this._linkPreviewPopup.style.display = "none";
    document.body.appendChild(this._linkPreviewPopup);
    // Caches successful AND failed lookups by URL so re-hovering the same link never refetches.
    // Failed lookups cache to null so a dead link isn't retried.
    this._linkPreviewCache = new Map();
    // Guards against a fetch for a link the user already moved off of resolving late and
    // reopening the popup - see _scheduleLinkPreview/_cancelLinkPreview.
    this._linkPreviewToken = 0;

    if (this.inputEl) {
      this.inputEl.addEventListener("keydown", (e) => {
        if (this._emotePopup.style.display !== "none") {
          // Autocomplete navigation - the popup is already open (via Tab), so these keys drive it.
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
          // Message history navigation. Only active when the emote popup
          // is closed (handled above) and there's actually history to show.
          if (!this._sentHistory.length) return;
          e.preventDefault();

          if (e.key === "ArrowUp") {
            if (this._historyIdx === -1) {
              // Save whatever the user was composing before navigating.
              this._historyDraft = this.inputEl.value;
            }
            if (this._historyIdx < this._sentHistory.length - 1) {
              this._historyIdx++;
            }
          } else {
            // ArrowDown
            if (this._historyIdx === -1) return; // nothing to go forward to
            this._historyIdx--;
          }

          const text = this._historyIdx === -1
            ? this._historyDraft
            : this._sentHistory[this._historyIdx];

          this.inputEl.value = text;
          this._autosizeChatInput();
          // Place cursor at end so it's easy to edit the recalled message.
          this.inputEl.setSelectionRange(text.length, text.length);
          // Sync the send-button visibility.
          this.inputEl.closest?.(".chat-input-wrapper")
            ?.classList.toggle("has-text", text.length > 0);
          return;
        } else if (e.key === "Tab") {
          // Popup closed - Tab opens it now. It used to auto-open on every keystroke, so typing "lol"
          // pre-selected an emote and the next Enter committed it instead of sending. Only swallow
          // Tab if there's a word worth suggesting for; else let it fall through.
          const { word } = this._currentEmoteWord();
          if (word && word.length >= 2) {
            e.preventDefault();
            this._updateEmotePopup();
            return;
          }
        }
        // Enter sends (no Shift+Enter multi-line, like Twitch). preventDefault() is needed now that
        // this is a <textarea> - otherwise Enter inserts a newline instead of submitting.
        if (e.key === "Enter") {
          e.preventDefault();
          this.sendMessage();
        }
      });

      // Opening is keydown-only, gated behind Tab (see above). This input listener only refreshes
      // the filtered list while the popup is already open; once closed, typing is normal until Tab
      // again.
      this.inputEl.addEventListener("input", () => {
        this._autosizeChatInput();
        // @mention autocomplete: auto-open as soon as @ + at least one letter typed.
        const atWord = this._currentAtWord();
        if (atWord.word && atWord.word.length >= 2) {
          this._updateUserPopup();
          return;
        }
        // If the @-word was deleted/changed, close a user popup.
        if (this._popupMode === "user") {
          this._hideEmotePopup();
        }
        // Emote popup refresh while it's already open (Tab-triggered).
        if (this._emotePopup.style.display !== "none") this._updateEmotePopup();
      });
      this.inputEl.addEventListener("blur", () => {
        // Small delay so a popup click registers before the popup hides.
        setTimeout(() => this._hideEmotePopup(), 150);
      });
    }
    if (this.jumpToLatestBtn) {
      this.jumpToLatestBtn.addEventListener("click", () => this.scrollToLatest());
    }
    if (this.container) {
      this.container.addEventListener("scroll", () => {
        // Ignore scroll events from our own scrollTop writes (auto-scroll, Jump to latest, connect()
        // reset) - checked FIRST. This used to run after dismissing the link preview, so every
        // auto-scroll cancelled an open preview and re-fired mouseenter/leave under a stationary
        // cursor, which read as chat "vibrating". A genuine user scroll still dismisses it below.
        if (this._suppressNextScrollEvent) {
          this._suppressNextScrollEvent = false;
          return;
        }
        // A scroll reaching here is a genuine user scroll - trimAndScroll() suppresses its own
        // scrollTop compensation explicitly, so this handler needn't guess.
        this._cancelLinkPreview();
        // Same as the link preview above - the card is anchored to a username span whose position
        // goes stale once the list scrolls.
        this._closeUserCard();
        const atBottom =
          this.container.scrollHeight - this.container.scrollTop - this.container.clientHeight < 80;
        if (atBottom) {
          // User scrolled back down manually - resume auto-scroll.
          this.userScrolledUp = false;
          this.newMessageCountWhileScrolledUp = 0;
          this.jumpToLatestBtn?.classList.remove("visible");
        } else {
          // User scrolled up intentionally.
          this.userScrolledUp = true;
          this.updateJumpToLatestVisibility();
        }
      });
    }
  }

  /** Shows/hides the whole chat-input-row, not just disabling it - VOD replay has no
   * connection to send to. Matches Twitch's VOD player (no chat box in replay). */
  _setInputRowVisible(visible) {
    const inputRow = this.inputEl?.closest(".chat-input-row");
    if (inputRow) inputRow.style.display = visible ? "" : "none";
  }

  /** Grows/shrinks the textarea to fit content up to the CSS max-height (then scrolls
   * internally). Height must reset to "auto" before reading scrollHeight, else it reports the
   * stale current height. Called on input and after clearing. overflow-y is toggled to `auto` only
   * past MAX_HEIGHT_PX so a short line doesn't show stray scroll arrows. */
  _autosizeChatInput() {
    const el = this.inputEl;
    if (!el) return;
    // Not laid out yet (hidden panel, pre-first-paint): scrollHeight reads 0 and writing
    // height:0px would collapse the box. A later call from a visible state settles it.
    if (el.scrollHeight === 0) return;
    // Captured BEFORE the resize: growing the input shrinks .chat-body (flex siblings), which the
    // scroll handler can't distinguish from scrolling up - so typing a long message used to pause
    // chat. If pinned to newest before the grow, stay pinned.
    const wasPinned = !this.userScrolledUp;
    el.style.height = "auto";
    const overflowing = el.scrollHeight > CHAT_INPUT_MAX_HEIGHT_PX;
    el.style.height = `${Math.min(el.scrollHeight, CHAT_INPUT_MAX_HEIGHT_PX)}px`;
    el.style.overflowY = overflowing ? "auto" : "hidden";
    // Publish the input row's real height so the jump-to-latest pill sits above it via calc() -
    // its old hardcoded offset assumed a one-line input.
    const row = el.closest(".chat-input-row");
    if (row?.parentElement) {
      row.parentElement.style.setProperty("--chat-input-row-h", `${row.offsetHeight}px`);
    }
    if (wasPinned && this.container) {
      // Same programmatic-scroll marker every other pinned write uses,
      // so the scroll handler doesn't misattribute this to the user.
      this._suppressNextScrollEvent = true;
      this.container.scrollTop = this.container.scrollHeight;
    }
  }

  /** Enables the composer once login succeeds. `userId` (from validate_oauth_token) is stored
   * so sendMessage()'s local echo gives own messages a real userId - without it, clicking your
   * own username had nothing to open the card from. */
  setLoggedIn(login, userId, displayName) {
    this.isLoggedIn = true;
    this.ownLogin = login;
    this.ownDisplayName = displayName || login; // properly-cased for display
    this.ownUserId = userId || null;
    if (this.inputEl) {
      this.inputEl.disabled = false;
      this.inputEl.placeholder = "Send a message";
      // Show the Send button only while there is text to send.
      const wrapper = this.inputEl.closest(".chat-input-wrapper");
      this.inputEl.addEventListener("input", () => {
        wrapper?.classList.toggle("has-text", this.inputEl.value.length > 0);
      });
      // Settle the composer at its computed height now, else the empty box sits at the browser's
      // rows="1" height until the first keystroke, misaligning the badge/placeholder.
      this._autosizeChatInput();
    }
    if (this.sendBtn) this.sendBtn.disabled = false;
    if (this.emoteBtn) this.emoteBtn.disabled = false;

    // Badge/cheermote fetches need a Helix token. If connect() ran before login they 401'd
    // silently; now retry without a stream restart.
    if (this.channel) {
      this.loadGlobalBadges();
      if (this.roomId) {
        this.loadChannelBadges(this.roomId);
        this.loadCheermotes(this.roomId);
        invoke("start_eventsub", { broadcasterId: this.roomId }).catch(() => {});
        // Same retry reasoning as above: ownLogin/the Helix token
        // _maybeFetchChatters() needs are only available from here on.
        this._maybeFetchChatters();
      }
    }
  }

  async sendMessage() {
    if (!this.inputEl || this._isVodMode) return;

    // Kick send path: separate command, separate login, no Twitch IRC semantics (slash commands,
    // reply-parent, USERSTATE color). Early self-contained branch so the Twitch path is unchanged.
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
        // Kick's Pusher feed echoes the sender's own message back (unlike Twitch IRC), so no
        // optimistic local echo here - it would double every sent message.
      } catch (err) {
        this.systemLine(`Couldn't send to Kick: ${err}`);
      }
      return;
    }

    if (!this.isLoggedIn) return;
    const text = this.inputEl.value.trim();
    if (!text) return;

    if (text.startsWith("/")) {
      const handled = await this._tryHandleSlashCommand(text);
      if (handled) {
        this.inputEl.value = "";
        this._autosizeChatInput();
        return;
      }
      // Not a recognized command - fall through and send as a literal message, like Twitch, rather
      // than swallowing a message that just starts with "/".
    }

    try {
      await invoke("send_chat_message", {
        message: text,
        replyToMsgId: this._replyToId || null,
      });
      this.clearReply();
      this.inputEl.value = "";
      this._autosizeChatInput();
      this.inputEl.closest?.(".chat-input-wrapper")?.classList.remove("has-text");

      // Add to sent history so Up/Down can recall it. Prepend so index 0
      // always means "most recent"; cap at 50 to avoid unbounded growth.
      this._sentHistory.unshift(text);
      if (this._sentHistory.length > 50) this._sentHistory.pop();
      this._historyIdx   = -1;
      this._historyDraft = "";

      // Twitch IRC doesn't echo a client's own PRIVMSG back, so render it optimistically here. This
      // doesn't reflect server-side moderation (a dropped message still looks sent) - acceptable.
      // userId/badgesTag flow through so own messages get a clickable card. Color is _ownColor,
      // falling back to default purple. msgId is left undefined (no id until it echoes, which it
      // won't), so Delete stays correctly disabled.
      this.renderMessage(this.ownDisplayName || this.ownLogin || "you", this._ownColor || "#9147ff", text, this._ownBadgesTag,
                          undefined, undefined, undefined, undefined, undefined, this.ownUserId,
                          /*isAction=*/false, /*emotesTag=*/null, /*isFirstMsg=*/false);
    } catch (err) {
      console.error("Failed to send message:", err);
      this.systemLine(`Failed to send: ${err}`);
    }
  }

  // --- Slash commands ---
  // /ban, /unban, /timeout, /untimeout, /clear - the same actions as the user card, typed. All
  // but /clear resolve a username -> id first (Helix takes ids), so they're async. /timeout
  // accepts flexible order ("username 10m" or "10m username"), like Twitch's own (duration
  // optional, defaults to 10 minutes).

  setStatus(text) {
    if (this.statusEl) this.statusEl.textContent = text;
  }

  systemLine(text) {
    const div = document.createElement("div");
    div.className = "chat-line system";
    div.textContent = text;
    this.container.appendChild(div);
    this.trimAndScroll();
  }

  trimAndScroll() {
    // Trimming shifts scrollTop, which must not read as a user scroll (that would resume
    // auto-scroll). Two guards: overflow-anchor:none + exact scrollHeight-delta compensation prevent
    // drift, and a boolean (not a counter, which desynced when the browser coalesced writes) marks
    // the next scroll event as ours.
    const heightBefore = this.container.scrollHeight;
    while (this.container.children.length > this.maxLines) {
      this.container.removeChild(this.container.firstChild);
    }
    const removedHeight = heightBefore - this.container.scrollHeight;
    if (removedHeight > 0 && this.userScrolledUp) {
      // Suppress the scroll event this assignment fires - our adjustment, not the user scrolling.
      this._suppressNextScrollEvent = true;
      this.container.scrollTop -= removedHeight;
    }
    if (!this.userScrolledUp) {
      // Suppress the scroll event this assignment will fire so it doesn't
      // falsely flip userScrolledUp on the next tick.
      this._suppressNextScrollEvent = true;
      this.container.scrollTop = this.container.scrollHeight;
    } else {
      this.newMessageCountWhileScrolledUp++;
      this.updateJumpToLatestVisibility();
    }

  }

  /** Shows/hides the floating button and updates its new-message count. */
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

  /** Scrolls to the latest message and resumes auto-scroll. */
  scrollToLatest() {
    this.userScrolledUp = false;
    this.newMessageCountWhileScrolledUp = 0;
    this._suppressNextScrollEvent = true;
    this.container.scrollTop = this.container.scrollHeight;
    if (this.jumpToLatestBtn) this.jumpToLatestBtn.classList.remove("visible");
  }

  /**
   * Runs `fn` after the previous lifecycle op settles (so teardown/setup pairs never interleave),
   * but skips it if a newer lifecycle call arrived. `fn` gets an isCurrent() predicate to re-check
   * after its own awaits. Result: rapid channel switches collapse to the last one.
   */
  _serializeLifecycle(fn) {
    const myEpoch = ++this._lifecycleEpoch;
    const isCurrent = () => this._lifecycleEpoch === myEpoch;
    const run = this._lifecycleChain.then(
      () => {
        // Superseded while waiting our turn - don't touch listeners or the
        // Rust connection at all; the newer call owns them now.
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

  /** Connect (via the Rust backend) and join a channel. Safe to call again to switch channels. */
  async connect(channel) {
    return this._serializeLifecycle((isCurrent) => this._doConnect(channel, isCurrent));
  }

  async _doConnect(channel, isCurrent = () => true) {
    // Stop any VOD replay loop from a previous setVodMode(). Without this, switching from a VOD to
    // live left the old tick() loop running - it kept wiping #chat-messages and printing "replay
    // restarting..." into what looked like live chat (both render into the same container).
    if (this._vodReplayStop) {
      this._vodReplayStop();
      this._vodReplayStop = null;
    }
    this.channel = channel.toLowerCase();
    this.roomId = null;
    this.userScrolledUp = false;
    // Leaving any prior Kick-chat session behind - back on Twitch IRC now.
    this._isKickChat = false;
    this._kickBroadcasterId = null;
    // Stale chatters from the old channel shouldn't suggest into this one - cleared here (not just
    // in disconnect()) since connect() can be called channel-to-channel without disconnect().
    this._chatUsers.clear();
    this._chattersFetchedForChannel = null;
    // Returning to live from a VOD (or connecting fresh) - restore the input row that setVodMode()
    // hides during replay.
    this._isVodMode = false;
    this._setInputRowVisible(true);
    // ...and restore the composer: a preceding Kick session leaves it disabled with a "Log in with
    // Kick to chat" placeholder (shared DOM), which clearing _isKickChat doesn't undo - so every
    // Twitch stream after a Kick one showed a dead composer.
    this._applyTwitchInputState();
    // Reset rather than leave a pending suppression - a fresh channel, so a suppression queued for
    // the previous channel's cleared body is meaningless.
    this._suppressNextScrollEvent = false;
    this.newMessageCountWhileScrolledUp = 0;
    this.sevenTvEmotes.clear();
    this.twitchNativeEmotes.clear();
    this.badgeMap.clear();
    this.cheermoteMap.clear();
    this._ownBadgesTag = null;
    // Reset on every channel switch - being a mod in the previous channel says nothing about this
    // one, and USERSTATE won't arrive instantly, so mod tools would otherwise wrongly stay on.
    this.isMod = false;
    // A new channel's held messages have nothing to do with the previous
    // one's - clear the queue and the panel/badge it drives.
    this._automodQueue = [];
    this._renderAutomodPanel();
    // Same for the per-user tracking the card reads - a count or log from another channel would
    // mislead. User info (account age etc.) is left cached: it's about the account, not the
    // channel.
    this._messageCountByUserId = new Map();
    this._messageHistoryByUserId = new Map();
    this._closeUserCard();
    this.container.innerHTML = "";
    this.newMessageCountWhileScrolledUp = 0;
    if (this.jumpToLatestBtn) this.jumpToLatestBtn.classList.remove("visible");

    await this.teardownListeners();
    await this.setupListeners();

    this.setStatus("connecting…");
    // Rust's connect (chat.rs) emits its own "Connecting to chat..." system message, so printing
    // it here too was pure duplication (the IPC round-trip is near-instant).

    // Load 7TV global emotes immediately; channel emotes load once Rust
    // reports the room-id (via the chat-room event) after joining.
    this.loadSevenTvGlobalEmotes();
    this.loadBttvGlobalEmotes();
    this.loadFfzGlobalEmotes();
    this.loadTwitchGlobalEmotes();
    // Same for Twitch chat badges: globals load now, channel-specific ones (which override global
    // subscriber art) load once the room-id is known.
    this.loadGlobalBadges();

    // If a newer channel was clicked mid-setup, don't open the Rust IRC connection for this stale
    // one - the queued newer connect will. This is what stops rapid switching from crawling through
    // every intermediate channel.
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
    // Always dismiss the emote autocomplete popup - it's position:fixed on body, so it can strand
    // over unrelated UI after a channel switch or stop.
    this._hideEmotePopup();
    // Same, plus its emote grid would otherwise show the OLD channel's emotes for a moment.
    this._closeEmotePicker();
    this._chatUsers.clear(); // stale users from old channel shouldn't appear in @mentions
    // Same position:fixed-on-body reasoning for the link preview popup - also cancels any
    // in-flight hover fetch so an old-channel request can't reopen it over the new channel.
    this._cancelLinkPreview();
    // Same reasoning again for the user card.
    this._closeUserCard();
    // Stop any VOD replay loop before tearing down the live connection, so the two don't overlap
    // switching from a VOD back to live.
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
    // Leave the pane in a neutral Twitch shape rather than the torn-down session's. Matters for
    // Stop-from-Kick with nothing connecting after (else the composer keeps Kick's disabled state).
    // New-mode callers overwrite this immediately, so it only sticks when idle/Twitch is next.
    this._isKickChat = false;
    this._kickBroadcasterId = null;
    this._applyTwitchInputState();
  }

  /** Chat state for a Kick VOD: there's no Kick chat-replay API, so this is setVodMode minus the
   * replay engine - tear down the live connection, clear the pane, hide the composer, and say why
   * it's empty. */
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

  /** Kick-mode chat: tears down Twitch chat and starts the read-only Rust Pusher client
   * (kick_chat.rs), whose events ride the same chat-message/chat-system pipeline. Exists because
   * disconnect() ends with teardownListeners(); the old Kick swap called disconnect() then started
   * the Kick client directly, so its events arrived with no listener and vanished (video fine, chat
   * frozen). The Twitch return path goes through connect(), which re-registers listeners. */
  async connectKick(channel, chatroomId, broadcasterUserId, subscriberBadges) {
    return this._serializeLifecycle(() =>
      this._doConnectKick(channel, chatroomId, broadcasterUserId, subscriberBadges),
    );
  }

  async _doConnectKick(channel, chatroomId, broadcasterUserId, subscriberBadges) {
    await this._doDisconnect(); // full Twitch teardown, incl. listeners
    this.channel = channel.toLowerCase();
    this._isKickChat = true;
    // Clear VOD-replay mode if the previous session was a VOD - connect() resets this returning to
    // Twitch, but this path never goes through connect(), and a stale true blocks sendMessage()'s
    // early return.
    this._isVodMode = false;
    this._kickBroadcasterId = broadcasterUserId ?? null;
    // This channel's custom subscriber badge art - replaced (not merged) per connection so channel
    // A's tiers can't dress channel B's subscribers.
    this._kickSubscriberBadges = Array.isArray(subscriberBadges) ? subscriberBadges : [];
    // Fresh pane: the lines in it ("Connecting to chat...", emote notices) belong to the
    // torn-down Twitch connection, not the Kick chat starting.
    this.container.innerHTML = "";
    // Own-identity leftovers from the Twitch session: USERSTATE's badge tag renders next to the
    // input and on local echoes. It's Twitch state with no Kick equivalent and nothing on a Kick
    // connection overwrites it, so without this your Twitch badges followed you into Kick chat.
    this._ownBadgesTag = null;
    this._renderInputBadges(null);
    this.newMessageCountWhileScrolledUp = 0;
    if (this.jumpToLatestBtn) this.jumpToLatestBtn.classList.remove("visible");
    // Re-register the listeners disconnect() tore down - the Kick client emits the same event
    // names, so this is all the frontend needs.
    await this.setupListeners();
    // Emotes. This used to load NOTHING for Kick chat (neither connect()'s globals nor the
    // chat-room channel load), so names rendered as bare text or the previous channel's leftover
    // art. Clear, then load: all three providers' globals, 7TV's Kick channel set (BTTV/FFZ have no
    // Kick support), and the channel's native Kick emotes.
    this.sevenTvEmotes.clear();
    this.loadSevenTvGlobalEmotes();
    this.loadBttvGlobalEmotes();
    this.loadFfzGlobalEmotes();
    if (this._kickBroadcasterId != null) {
      this.loadSevenTvKickChannelEmotes(this._kickBroadcasterId);
    }
    this.loadKickNativeEmotes(this.channel);
    // Sending needs the user logged into Kick AND a broadcaster id. If both hold, show and enable
    // the composer; otherwise it stays read-only (Kick login comes later - failover/browse don't
    // block on it).
    this._applyKickInputState();
    // If sending isn't possible, say WHY once in the pane - a silently read-only chat with no
    // visible cause was the complaint. The three causes are distinct:
    if (!this._kickLoggedIn) {
      if (!this._kickOAuthConfigured) {
        this.systemLine(
          "Kick chat is read-only: this build has no Kick API credentials, so login isn't available. " +
          "Register an app at kick.com/settings/developer and build with KICK_CLIENT_ID / KICK_CLIENT_SECRET set (see kick_oauth.rs)."
        );
      }
      // Configured-but-logged-out needs no system line - the disabled
      // composer's "Log in with Kick to chat" placeholder covers it.
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

  /** Twitch counterpart of _applyKickInputState: puts the shared composer back into Twitch shape
   * - enabled with "Send a message" when logged in, disabled otherwise. The composer DOM is SHARED
   * between platforms and _applyKickInputState mutates it, with nothing on the Twitch return path
   * undoing it (symptom: a Twitch stream after a Kick session showing a dead composer asking for a
   * Kick login). Called from connect() and disconnect(). */
  _applyTwitchInputState() {
    const canSend = this.isLoggedIn;
    if (this.inputEl) {
      this.inputEl.disabled = !canSend;
      this.inputEl.placeholder = "Send a message";
    }
    if (this.sendBtn) this.sendBtn.disabled = !canSend;
    if (this.emoteBtn) this.emoteBtn.disabled = !canSend;
  }

  /** Reconciles the composer (row visibility + enabled state + status text) with current Kick
   * state. Called from connectKick and whenever Kick login changes while Kick chat shows. */
  _applyKickInputState() {
    if (!this._isKickChat) return;
    const canSend = this._kickLoggedIn && this._kickBroadcasterId != null;
    // Show the composer whenever sending is possible or one login away - a hidden row gave
    // "read-only" no explanation. Only when login isn't offered at all (no Kick credentials, or no
    // broadcaster id) does the row hide entirely, VOD-style.
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

  /** Called once at startup after the kick_oauth_configured check: whether this BUILD can do Kick
   * login at all (real credentials baked in). Distinct from _kickLoggedIn (whether the user has).
   * Decides shown-disabled vs hidden-with-explanation. */
  setKickOAuthConfigured(configured) {
    this._kickOAuthConfigured = Boolean(configured);
    if (this._isKickChat) this._applyKickInputState();
  }

  /** Called when Kick login state changes (OAuth success, session restore, logout). Updates the
   * composer live if Kick chat is showing, so logging in mid-stream flips it writable without a
   * reconnect. */
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
                emotes_tag, is_first_msg } = event.payload;
        // Track chatters for @mention autocomplete (cap at 500 to avoid memory bloat).
        if (username) {
          this._chatUsers.set(username.toLowerCase(), username);
          if (this._chatUsers.size > 500) {
            this._chatUsers.delete(this._chatUsers.keys().next().value);
          }
        }
        this.renderMessage(username, color || "#9147ff", message, badges, bits, custom_reward_id,
                           reply_parent_user, reply_parent_body, msg_id, user_id, is_action,
                           emotes_tag, is_first_msg);
      })
    );

    this.unlisteners.push(
      await listen("chat-system", (event) => {
        this.systemLine(event.payload.text);
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

    // Rich event listeners: USERNOTICE (subs/resubs/gifts/raids/announce)
    // and EventSub hype train / predictions. Same teardown via unlisteners.
    await this._initEventListeners(listen);

    this.unlisteners.push(
      await listen("chat-room", (event) => {
        // Persist so setLoggedIn() can reload badges/cheermotes after login.
        this.roomId = event.payload.room_id;
        this.loadSevenTvChannelEmotes(this.roomId);
        // BTTV channel emotes and FFZ (no other loader) were never fetched - the cause of common
        // emotes (LOLW, KEKW, both FFZ channel emotes) rendering as bare text in live chat.
        this.loadBttvChannelEmotes(this.roomId);
        this.loadFfzChannelEmotes(this.roomId);
        this.loadChannelBadges(this.roomId);
        this.loadCheermotes(this.roomId);
        // EventSub for channel point redemption events (works when logged
        // in as broadcaster/mod of this channel; silently no-ops otherwise).
        invoke("start_eventsub", { broadcasterId: this.roomId }).catch(() => {});
        // Room-id just became known - the other trigger for
        // _maybeFetchChatters() (see its comment for why there are two).
        this._maybeFetchChatters();
      })
    );

    this.unlisteners.push(
      await listen("seventv-emote-set-update", (event) => {
        this._applySevenTvEmoteSetUpdate(event.payload);
      })
    );

    this.unlisteners.push(
      await listen("user-state", (event) => {
        // Cache the badge string to retry after the badge maps finish loading (USERSTATE often
        // arrives before loadGlobalBadges/loadChannelBadges complete).
        this._ownBadgesTag = event.payload.badges;
        this._renderInputBadges(this._ownBadgesTag);
        // Own chat color for this channel - used by the local echo. Twitch allows unset color; leave
        // it null rather than coercing, since normalizeColor() has its own fallback.
        if (event.payload.color) this._ownColor = event.payload.color;
        // Mod-tools visibility depends on this - re-derive and let main.js (which owns the
        // hover-icon/menu DOM) re-render, since USERSTATE can arrive after the first messages.
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

  renderMessage(username, color, message, badgesTag, bits, customRewardId,
                replyParentUser, replyParentBody, msgId, userId, isAction = false,
                emotesTag = null, isFirstMsg = false) {
    const line = document.createElement("div");
    line.className = "chat-line";
    // Store data needed by hover action buttons.
    if (msgId) line.dataset.msgId = msgId;
    if (userId) line.dataset.msgUserId = userId;
    line.dataset.msgUsername = username;
    line.dataset.msgText = message;

    // User card stats - tracked for every message with a real sender id (not the local echo / VOD
    // replay). History is capped since only the card needs it, and only the last few.
    if (userId) {
      this._messageCountByUserId.set(userId, (this._messageCountByUserId.get(userId) || 0) + 1);
      const history = this._messageHistoryByUserId.get(userId) || [];
      history.push({ time: Date.now(), text: message });
      if (history.length > USER_CARD_HISTORY_LIMIT) history.shift();
      this._messageHistoryByUserId.set(userId, history);
    }

    // Channel point message: left-border highlight + gem prefix.
    if (customRewardId) {
      line.classList.add("is-channel-point-message");
      const gem = document.createElement("span");
      gem.className = "channel-point-gem";
      gem.title = "Channel Point Redemption";
      line.appendChild(gem);
    }

    // First-time chatter: purple highlight matching twitch.tv's treatment for a user's first
    // message in the channel (IRC "first-msg" tag - see is_first_msg in chat.rs). The classic
    // viewer-visible welcome, not returning-chatter or Creator Highlights.
    if (isFirstMsg) {
      line.classList.add("is-first-msg");
      const label = document.createElement("div");
      label.className = "first-msg-label";
      label.textContent = "First time chatting";
      line.appendChild(label);
    }

    // Reply: show a quoted header above the message.
    if (replyParentUser && replyParentBody) {
      line.classList.add("is-reply");
      const replyHeader = document.createElement("div");
      replyHeader.className = "reply-header";
      replyHeader.textContent = `↩ ${replyParentUser}: ${replyParentBody}`;
      line.appendChild(replyHeader);
    }

    // Mention highlight when the body contains @ownLogin, or this is a reply to a message by
    // ownLogin. The login is platform-appropriate: ownLogin is Twitch-only, so Kick sessions use the
    // Kick login (else @'s of the Kick name matched nothing).
    const mentionLogin = this._isKickChat ? this._kickLogin : this.ownLogin;
    if (mentionLogin) {
      const login = mentionLogin.toLowerCase();
      // Escape regex metacharacters defensively - Twitch logins are
      // [a-z0-9_] but Kick usernames can carry characters like '-'.
      const escaped = login.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      // Match with OR without the "@" - Twitch highlights a bare "Name," like "@Name". The branches
      // need different left edges: "@" is non-word (so "\b@" wouldn't match), while the bare name
      // needs "\b" so "xName"/"Name8" don't light up. Trailing \b guards both.
      const bodyMention = new RegExp(`(?:@|\\b)${escaped}\\b`, "i").test(message);
      const replyToMe = replyParentUser &&
        replyParentUser.toLowerCase() === login;
      if (bodyMention || replyToMe) {
        line.classList.add("is-mention");
      }
    }

    // Wrapped in a span (though renderBadges returns a fragment) so this point stays addressable
    // by _backfillOwnBadges() - a badge set that finishes loading after this line rendered (a real
    // race) can still be patched in. Only for the current message's own badges.
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
    // Clicking the username opens the user card (avatar, account age, timeout/ban, delete).
    // Timeout/ban are card-only (like Twitch); delete is also on the hover row per request. Needs
    // the sender's userId - absent only for the local echo (Twitch never echoes it back). VOD lines
    // have a real userId, so their cards work; timeout/ban stay disabled there (no roomId).
    // msgId/message flow through so Delete knows which line.
    if (userId) {
      nameSpan.classList.add("chat-username-clickable");
      nameSpan.addEventListener("click", (e) => {
        e.stopPropagation();
        this._showUserCard(nameSpan, userId, username, badgesTag, msgId, message);
      });
    }
    line.appendChild(nameSpan);

    const textSpan = document.createElement("span");
    textSpan.className = "chat-message-text" + (isAction ? " chat-action-message" : "");
    if (isAction) textSpan.style.fontStyle = "italic";
    textSpan.appendChild(this.renderMessageBody(message, emotesTag));
    line.appendChild(document.createTextNode(" "));
    line.appendChild(textSpan);

    // Bits badge after the text, tier-colored and animated (mirrors Twitch's cheermote tiers).
    // Also tints the whole line so cheers stand out.
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

    // Hover action buttons (copy + reply). Built lazily on first mouseenter
    // to avoid creating DOM nodes for every message up front.
    line.addEventListener("mouseenter", () => {
      if (line.querySelector(".chat-line-actions")) return; // already built
      const actions = document.createElement("div");
      actions.className = "chat-line-actions";

      // Copy button
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

      // Reply button (only shown when logged in and msg has an ID)
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

      // Delete - the one mod action kept on hover per request (timeout/ban moved to the card).
      // Always rendered, disabled+grayed for non-mods/self rather than hidden; enforcement is
      // server-side.
      {
        const targetUsername = line.dataset.msgUsername || "";
        const isSelf = this._isSelf(targetUsername);
        const canDelete = this.isMod && Boolean(line.dataset.msgId) && Boolean(this.roomId) && !isSelf;
        const deleteBtn = document.createElement("button");
        deleteBtn.className = "chat-line-action-btn mod-action-btn";
        deleteBtn.title = canDelete ? "Delete message" : "Delete message (mod only)";
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
      }

      line.appendChild(actions);
    });

    // Right-click menu - copy/reply only; mod actions (besides the hover Delete) live in the user
    // card.
    line.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this._showMessageContextMenu(e.clientX, e.clientY, line);
    });

    this.container.appendChild(line);
    this.trimAndScroll();
  }

  /** Renders a channel point redemption event from EventSub as a special chat line. */
  renderRedeemEvent({ redeemer, reward_title, reward_cost, user_input }) {
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

  /**
   * Renders a zero-width emote as an overlay on the preceding emote.
   * Zero-width emotes (7TV/BTTV overlays like Fog0) stack onto the emote before them into one
   * glyph. Finds the last emote image, wraps it in a positioned container, and layers this one
   * centered over it. Returns false if there's no preceding emote (caller renders it normally).
   */
  _overlayZeroWidthEmote(fragment, emoteUrl, word) {
    // The last node is usually a separator space; the emote is before it. Walk back past trailing
    // text nodes to the last element (an <img.chat-emote> or an existing overlay container).
    let anchor = fragment.lastChild;
    while (anchor && anchor.nodeType === Node.TEXT_NODE) {
      const prev = anchor.previousSibling;
      // Drop the separating space we appended after the previous emote, so
      // the overlay sits flush on it rather than a space away.
      fragment.removeChild(anchor);
      anchor = prev;
    }
    if (!anchor || anchor.nodeType !== Node.ELEMENT_NODE) return false;

    let container;
    if (anchor.classList && anchor.classList.contains("chat-emote-overlay")) {
      // Already an overlay stack (a second/third zero-width emote on the
      // same base) - just add another layer.
      container = anchor;
    } else if (anchor.classList && anchor.classList.contains("chat-emote")) {
      // Wrap the base emote in an overlay container in-place.
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

  /** Splits message text on whitespace and renders emotes and cheermotes inline. Checks Twitch
   * native emotes (by IRC-tag position) first, then 7TV/BTTV (by name), then cheermotes, then plain
   * text. */
  renderMessageBody(message, emotesTag = null) {
    const fragment = document.createDocumentFragment();
    const twitchEmotes = this.parseTwitchEmotesTag(message, emotesTag);
    const words = message.split(" ");
    let charPos = 0;

    words.forEach((word, i) => {
      // Kick native emote - id-carrying marker from kick_chat.rs's flatten_emote_tokens. Rendered
      // from the id, not a name lookup, so a subscriber's cross-channel emote works too (see
      // parseKickEmoteMarker). Checked first - the marker can't coincide with a Twitch emote or word.
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

      // Twitch native emote - matched by character position from IRC tag
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
        // 7TV / BTTV emote - matched by name; Twitch native - name fallback
        const emote        = this.sevenTvEmotes.get(word);
        const twitchByName = !emote ? (this.twitchNativeEmotes?.get(word) ?? null) : null;
        const emoteUrl     = emote?.url
          ?? (twitchByName ? `https://static-cdn.jtvnw.net/emoticons/v2/${twitchByName.id}/default/dark/2.0` : null);
        if (emoteUrl) {
          // Zero-width emotes (Fog0, cvHazmat) render ON TOP OF the preceding emote, not beside it.
          // Detect the flag and wrap the previous emote and this one in an overlay container instead
          // of appending a standalone image.
          if (emote?.zeroWidth) {
            const overlaid = this._overlayZeroWidthEmote(fragment, emoteUrl, word);
            if (overlaid) {
              // A zero-width emote consumes no horizontal space and needs no separator - skip the space
              // and advance charPos.
              charPos += word.length + 1;
              return;
            }
            // If there was no preceding emote to overlay onto (zero-width at message start), fall
            // through and render it as a normal image rather than dropping it.
          }
          const img = document.createElement("img");
          img.className = "chat-emote";
          img.src = emoteUrl;
          img.alt = word;
          img.title = word;
          img.loading = "lazy";
          // A failed emote image collapses to its alt text - identical to it never loading, which made
          // "emote shows as its name" undiagnosable. Log each failing URL once so a dead CDN link is
          // distinguishable from a missing emote.
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
            // Animated cheermote image (dark theme, 2x).
            const img = document.createElement("img");
            img.className = "chat-emote cheermote";
            img.src = cheer.tier.url;
            img.alt = word;
            img.title = word;
            img.loading = "lazy";
            fragment.appendChild(img);
            // Colored bit count immediately after the image.
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

  // --- Reply state ---

  /**
   * Set the active reply target. Shows a reply indicator bar above the input and stores the
   * message ID so the next send goes as a reply.
   */
  _setReplyTarget(msgId, username, msgText = "") {
    this._replyToId = msgId;
    this._replyToUser = username;

    // Build or re-use the indicator block above the input row. Instance-scoped so a second chat
    // (MultiView) gets its own bar. Anchor to whichever input-row class this instance uses.
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

    // --- Top row: "Replying to @username" + close button ---
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

    // --- Second row: the quoted message body ---
    const body = document.createElement("div");
    body.className = "chat-reply-indicator-body";

    const userSpan = document.createElement("span");
    userSpan.className = "chat-reply-indicator-user";
    userSpan.textContent = `${username}: `;

    const textSpan = document.createElement("span");
    textSpan.className = "chat-reply-indicator-text";
    textSpan.textContent = msgText;

    body.appendChild(userSpan);
    body.appendChild(textSpan);
    bar.appendChild(body);

    // Prefill input with @mention so the user sees who they're replying to.
    if (this.inputEl) {
      this.inputEl.value = `@${username} `;
      this._autosizeChatInput();
      this.inputEl.focus();
      // Put cursor at end.
      const len = this.inputEl.value.length;
      this.inputEl.setSelectionRange(len, len);
    }
  }

  clearReply() {
    this._replyToId = null;
    this._replyToUser = null;
    const bar = this._replyIndicatorEl;
    if (bar) bar.style.display = "none";
    // Clear any prefilled @mention if the user hasn't typed anything extra.
    if (this.inputEl && this._replyToUser) {
      const prefix = `@${this._replyToUser} `;
      if (this.inputEl.value === prefix) {
        this.inputEl.value = "";
        this._autosizeChatInput();
      }
    }
  }

  /** Re-derives this.isMod from the cached USERSTATE badges tag and notifies onModStatusChange()
   * subscribers if it changed. "moderator" or "broadcaster" present in the tag means mod tools
   * should show - the same thing Twitch's IRC server requires before honoring /timeout, /ban. */
  _updateModStatus() {
    const tag = this._ownBadgesTag || "";
    const wasMod = this.isMod;
    this.isMod = tag.split(",").some((pair) => {
      const setId = pair.split("/")[0];
      return setId === "moderator" || setId === "broadcaster";
    });
    // Mod status just changed - one of the two _maybeFetchChatters() triggers (the other is
    // chat-room); whichever of roomId/isMod arrives second unblocks the fetch. Its own guard makes
    // this a no-op if chat-room already fired.
    this._maybeFetchChatters();
    if (this.isMod !== wasMod) {
      // The AutoMod toggle's visibility depends on isMod - refresh even with an empty queue so the
      // button appears the moment USERSTATE confirms mod status.
      this._renderAutomodPanel();
      for (const fn of this._modStatusListeners) {
        try { fn(this.isMod); } catch (err) { console.error("mod status listener error:", err); }
      }
    }
  }

  /** Subscribes to isMod changes. Returns an unsubscribe function, same
   * convention as the Tauri listen() calls elsewhere in this file. */
  onModStatusChange(fn) {
    this._modStatusListeners.push(fn);
    return () => {
      this._modStatusListeners = this._modStatusListeners.filter((f) => f !== fn);
    };
  }

}

// Mixed in here rather than inline to keep this file manageable - see each src/chat/ file's
// header for what it covers. All run with the same `this` as everything above; no behavioral
// difference from one giant class body.
Object.assign(TwitchChat.prototype, chatEmotesMixin, chatEmotePickerMixin, chatVodReplayMixin, chatBadgesMixin, chatAutomodMixin, chatUserCardMixin, chatModActionsMixin, chatLinkPreviewMixin, chatAutocompleteMixin, chatEventsMixin);
