// Part of TwitchChat (see ../chat.js): the hover/click user-info card - fetching, rendering, positioning, dragging. Mixin merged onto
// TwitchChat.prototype, so `this` is the chat instance; split by feature for readability.
// Clicking a username opens it (Twitch's only home for mod tools; see chat-mod-actions.js).
// Shows avatar/badges/creation date (one cached Helix lookup), this session's message count
// + a short recent-message log (client-side only), and timeout/ban.
import { invoke } from "@tauri-apps/api/core";
import { USER_CARD_HISTORY_LIMIT } from "./shared.js";

export const chatUserCardMixin = {
  /** Opens the card for `userId`/`username`, anchored below `anchorEl`. `badgesTag` is that
   * message's raw IRC badges, rendered in the card too. `msgId`/`messageText` scope the Delete
   * button to THAT message (delete is message-scoped, unlike timeout/ban). */
  async _showUserCard(anchorEl, userId, username, badgesTag, msgId, messageText) {
    this._closeUserCard();

    const card = document.createElement("div");
    card.className = "user-card";
    // Close button included even in the loading state - the Helix lookup is usually fast but
    // the card shouldn't be unclosable while waiting.
    card.innerHTML =
      '<button class="user-card-close-btn user-card-loading-close" aria-label="Close">' +
      '<svg viewBox="0 0 24 24" width="14" height="14" fill="none"><path d="M5 5l14 14M19 5L5 19" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>' +
      "</button>" +
      '<div class="user-card-loading">Loading…</div>';
    card.querySelector(".user-card-loading-close").addEventListener("click", (e) => {
      e.stopPropagation();
      this._closeUserCard();
    });
    document.body.appendChild(card);
    this._userCardEl = card;
    // Whether THIS card was manually dragged, so the reposition after the async lookup
    // doesn't snap a moved card back. On the element so it's scoped per card.
    card._dragged = false;
    this._positionUserCard(card, anchorEl);
    this._makeUserCardDraggable(card);

    this._userCardOutsideHandler = (e) => {
      if (!card.contains(e.target) && e.target !== anchorEl) this._closeUserCard();
    };
    setTimeout(() => {
      document.addEventListener("click", this._userCardOutsideHandler, true);
    }, 0);

    // Helix lookup (cached); everything else renders synchronously, so the card shows
    // immediately with a small loading state only for the networked parts.
    let info = this._userInfoCache.get(userId);
    if (info === undefined) {
      try {
        const users = JSON.parse(await invoke("get_users_info", { userIds: [userId] }));
        info = users[0] || null;
      } catch (err) {
        console.error("Failed to load user info for card:", err);
        info = null;
      }
      this._userInfoCache.set(userId, info);
    }

    // The card may have closed (or reopened for another user) mid-lookup - don't resurrect
    // it.
    if (this._userCardEl !== card) return;

    this._renderUserCard(card, userId, username, badgesTag, info, msgId, messageText);
    // Skip repositioning if the user dragged the card during the loading window - re-running
    // it would snap the card back to the anchor.
    if (!card._dragged) this._positionUserCard(card, anchorEl);
  },

  _renderUserCard(card, userId, username, badgesTag, info, msgId, messageText) {
    card.innerHTML = "";

    const header = document.createElement("div");
    header.className = "user-card-header";

    const avatar = document.createElement("img");
    avatar.className = "user-card-avatar";
    avatar.src = info?.profile_image_url || this.blankAvatarDataUri();
    avatar.alt = "";
    header.appendChild(avatar);

    const nameBlock = document.createElement("div");
    nameBlock.className = "user-card-name-block";
    const nameEl = document.createElement("div");
    nameEl.className = "user-card-name";
    nameEl.textContent = info?.display_name || username;
    nameBlock.appendChild(nameEl);
    if (info?.login && info.login.toLowerCase() !== (info?.display_name || "").toLowerCase()) {
      const loginEl = document.createElement("div");
      loginEl.className = "user-card-login";
      loginEl.textContent = `@${info.login}`;
      nameBlock.appendChild(loginEl);
    }
    header.appendChild(nameBlock);

    // Close button in the header (not the scrollable body) so it's always reachable. mousedown
    // propagation is stopped so clicking it isn't misread as a drag start.
    const closeBtn = document.createElement("button");
    closeBtn.className = "user-card-close-btn";
    closeBtn.setAttribute("aria-label", "Close");
    closeBtn.innerHTML =
      '<svg viewBox="0 0 24 24" width="14" height="14" fill="none"><path d="M5 5l14 14M19 5L5 19" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
    closeBtn.addEventListener("mousedown", (e) => e.stopPropagation());
    closeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this._closeUserCard();
    });
    header.appendChild(closeBtn);

    card.appendChild(header);

    // Body below the header is its own scrollable region, so a long history scrolls while the
    // header (and close button) stays pinned - less fragile than one scrolling region around
    // a flex header.
    const body = document.createElement("div");
    body.className = "user-card-body";
    card.appendChild(body);

    // Badges row - same icons as next to the user's messages, reusing renderBadges().
    const badgeFragment = badgesTag ? this.renderBadges(badgesTag) : null;
    if (badgeFragment) {
      const badgeRow = document.createElement("div");
      badgeRow.className = "user-card-badges";
      badgeRow.appendChild(badgeFragment);
      body.appendChild(badgeRow);
    }

    const created = document.createElement("div");
    created.className = "user-card-created";
    // Defensive against created_at being absent - Helix has been reported to omit it despite
    // documenting it as always present.
    created.textContent = info?.created_at
      ? `Account created: ${this._formatAccountDate(info.created_at)}`
      : "Account created: unknown";
    body.appendChild(created);

    // Mod actions - same enabled/disabled logic as the old hover row. isSelf/enabled
    // recomputed each open since isMod can change.
    const isSelf = this._isSelf(username);
    const enabled = this.isMod && Boolean(this.roomId) && !isSelf;

    const actionsRow = document.createElement("div");
    actionsRow.className = "user-card-mod-actions";

    const timeoutPresets = [["1s", 1], ["30s", 30], ["1m", 60], ["10m", 600],
      ["30m", 1800], ["1h", 3600], ["4h", 14400], ["12h", 43200],
      ["1d", 86400], ["7d", 604800], ["14d", 1209600]];
    for (const [label, secs] of timeoutPresets) {
      const btn = document.createElement("button");
      btn.className = "user-card-timeout-preset";
      btn.textContent = label;
      btn.disabled = !enabled;
      btn.title = enabled ? `Timeout ${username} for ${label}` : "Mod only";
      btn.addEventListener("click", () => {
        if (!enabled) return;
        this._timeoutUser(userId, username, secs);
      });
      actionsRow.appendChild(btn);
    }
    body.appendChild(actionsRow);

    const banRow = document.createElement("div");
    banRow.className = "user-card-ban-row";

    // Delete is message-scoped (unlike timeout/ban): acts on the message whose username
    // opened this card. Disabled with its own reason when there's no message id.
    const deleteBtn = document.createElement("button");
    deleteBtn.className = "user-card-delete-btn";
    deleteBtn.textContent = "Delete message";
    const canDelete = enabled && Boolean(msgId);
    deleteBtn.disabled = !canDelete;
    deleteBtn.title = !this.isMod ? "Mod only"
      : !msgId ? "No message to delete"
      : isSelf ? "Mod only"
      : "Delete this message";
    deleteBtn.addEventListener("click", () => {
      if (!canDelete) return;
      this._deleteMessage(msgId, deleteBtn);
    });
    banRow.appendChild(deleteBtn);

    const banBtn = document.createElement("button");
    banBtn.className = "user-card-ban-btn";
    banBtn.textContent = "Ban";
    banBtn.disabled = !enabled;
    banBtn.title = enabled ? `Ban ${username}` : "Mod only";
    banBtn.addEventListener("click", () => {
      if (!enabled) return;
      this._confirmAndBan(userId, username);
    });
    banRow.appendChild(banBtn);
    body.appendChild(banRow);

    // Stats row - Messages is the only stat this client can populate (tracked in
    // renderMessage). Warnings/Timeouts/Bans/Comments have no Helix equivalent, so they're
    // omitted rather than faked.
    const stats = document.createElement("div");
    stats.className = "user-card-stats";
    const msgCount = this._messageCountByUserId.get(userId) || 0;
    const statBox = document.createElement("div");
    statBox.className = "user-card-stat";
    const statValue = document.createElement("div");
    statValue.className = "user-card-stat-value";
    statValue.textContent = String(msgCount);
    const statLabel = document.createElement("div");
    statLabel.className = "user-card-stat-label";
    statLabel.textContent = "Messages (this session)";
    statBox.appendChild(statValue);
    statBox.appendChild(statLabel);
    stats.appendChild(statBox);
    body.appendChild(stats);

    // Recent message log - client-tracked, so only since connecting (no Helix history
    // endpoint), but useful context for a mod. Capped at USER_CARD_HISTORY_LIMIT when recorded;
    // this renders the already-capped array.
    const history = this._messageHistoryByUserId.get(userId) || [];
    if (history.length > 0) {
      const historyEl = document.createElement("div");
      historyEl.className = "user-card-history";
      for (const entry of history) {
        const row = document.createElement("div");
        row.className = "user-card-history-row";
        const time = document.createElement("span");
        time.className = "user-card-history-time";
        time.textContent = new Date(entry.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        const text = document.createElement("span");
        text.className = "user-card-history-text";
        text.textContent = entry.text;
        row.appendChild(time);
        row.appendChild(text);
        historyEl.appendChild(row);
      }
      body.appendChild(historyEl);
    }
  },

  _formatAccountDate(iso) {
    try {
      return new Date(iso).toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" });
    } catch (_) {
      return iso;
    }
  },

  /** Same blank-avatar fallback as sidebar/home/browse - duplicated rather than imported
   * (those are main.js-side modules with no shared util) for a one-line data URI. */
  blankAvatarDataUri() {
    return "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";
  },

  _positionUserCard(card, anchorEl) {
    const rect = anchorEl.getBoundingClientRect();
    card.style.position = "fixed";
    const cardWidth = card.offsetWidth;
    let left = rect.left;
    const maxLeft = window.innerWidth - cardWidth - 8;
    if (left > maxLeft) left = Math.max(8, maxLeft);
    card.style.left = `${left}px`;
    const cardHeight = card.offsetHeight;
    if (rect.bottom + cardHeight + 6 <= window.innerHeight) {
      card.style.top = `${rect.bottom + 6}px`;
    } else {
      card.style.top = `${Math.max(8, rect.top - cardHeight - 6)}px`;
    }
  },

  /** Lets the user drag the card by its header. Attached to `card`, not the header, since
   * _renderUserCard() rebuilds the header after the async lookup. A .closest() check on
   * mousedown keeps "only the header starts a drag". */
  _makeUserCardDraggable(card) {
    card.addEventListener("mousedown", (e) => {
      const header = e.target.closest(".user-card-header");
      if (!header || !card.contains(header)) return;
      // Right/middle-click don't start a drag, and ignore mousedowns on interactive header
      // elements (none today, but keeps future additions working).
      if (e.button !== 0 || e.target.closest("button, a")) return;

      e.preventDefault();
      const startX = e.clientX;
      const startY = e.clientY;
      const startLeft = card.offsetLeft;
      const startTop = card.offsetTop;
      card.classList.add("dragging");

      const onMove = (moveEvent) => {
        card._dragged = true;
        // Clamp so the header (the only grab handle) can't be dragged fully off-screen - same 8px
        // margin _positionUserCard uses, on all four edges.
        const maxLeft = window.innerWidth - card.offsetWidth - 8;
        const maxTop = window.innerHeight - card.offsetHeight - 8;
        const newLeft = Math.min(
          Math.max(8, startLeft + (moveEvent.clientX - startX)),
          Math.max(8, maxLeft)
        );
        const newTop = Math.min(
          Math.max(8, startTop + (moveEvent.clientY - startY)),
          Math.max(8, maxTop)
        );
        card.style.left = `${newLeft}px`;
        card.style.top = `${newTop}px`;
      };
      const onUp = () => {
        card.classList.remove("dragging");
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        card._dragCleanup = null;
      };
      // Stored on the element so _closeUserCard() can force-detach these document listeners if
      // the card is removed mid-drag, which would otherwise leak them.
      card._dragCleanup = onUp;
      // On document, not the header, so the drag keeps tracking even if the cursor outruns the
      // card's bounds.
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
  },

  _closeUserCard() {
    if (this._userCardEl) {
      // If the card is removed mid-drag (a scroll-triggered close), its mouseup never fires, so
      // detach the document listeners here to avoid a leak.
      this._userCardEl._dragCleanup?.();
      this._userCardEl.remove();
      this._userCardEl = null;
    }
    if (this._userCardOutsideHandler) {
      document.removeEventListener("click", this._userCardOutsideHandler, true);
      this._userCardOutsideHandler = null;
    }
  },

  _formatDuration(secs) {
    if (secs >= 86400) return `${Math.round(secs / 86400)}d`;
    if (secs >= 3600) return `${Math.round(secs / 3600)}h`;
    if (secs >= 60) return `${Math.round(secs / 60)}m`;
    return `${secs}s`;
  },

  /** Case-insensitive check against this.ownLogin, to disable mod actions on the user's own
   * messages. By username (what's tracked here), and IRC display-name casing never matches the
   * lowercase login, so it can't be a plain ===. Not a security boundary - Helix rejects
   * self-targeting anyway. */
  _isSelf(username) {
    return Boolean(this.ownLogin) && Boolean(username) &&
      this.ownLogin.toLowerCase() === username.toLowerCase();
  },

};
