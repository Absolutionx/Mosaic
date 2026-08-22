// Part of TwitchChat (see ../chat.js): AutoMod hold queue - rendering held messages, the review panel, and clear/delete actions. Mixin merged onto
// TwitchChat.prototype, so `this` is the chat instance; split by feature for readability.
// Held messages arrive via eventsub-automod-hold (see eventsub.rs), never over IRC, so
// there's no chat line to attach to. They live in their own queue in #automod-panel until a
// mod Allows or Denies each.

import { invoke } from "@tauri-apps/api/core";
export const chatAutomodMixin = {
  /** CLEARCHAT - one user's messages cleared (timeout/ban, by anyone) or the whole chat.
   * Marks lines removed but keeps them visible, dimmed with a strikethrough (see
   * _collapseLine), so there's still a record. */
  _handleClearChat({ target_user_id, target_username, ban_duration_secs }) {
    if (!target_username && !target_user_id) {
      // Whole-chat clear.
      for (const line of this.container.querySelectorAll(".chat-line:not(.is-cleared)")) {
        this._collapseLine(line, "Chat was cleared by a moderator.");
      }
      return;
    }
    const lines = this.container.querySelectorAll(".chat-line:not(.is-cleared)");
    const targetLower = (target_username || "").toLowerCase();
    for (const line of lines) {
      const matchesId = target_user_id && line.dataset.msgUserId === target_user_id;
      const matchesName = !target_user_id && line.dataset.msgUsername?.toLowerCase() === targetLower;
      if (!matchesId && !matchesName) continue;
      const label = ban_duration_secs
        ? `Message from ${target_username} deleted (timed out for ${this._formatDuration(ban_duration_secs)}).`
        : `Message from ${target_username} deleted (banned).`;
      this._collapseLine(line, label);
    }
  },

  /** CLEARMSG - one message deleted (by anyone). Matched by msg_id, same id PRIVMSG's `id`
   * tag put on line.dataset.msgId. */
  _handleClearMsg({ target_msg_id }) {
    const line = this.container.querySelector(`.chat-line[data-msg-id="${CSS.escape(target_msg_id)}"]`);
    if (line && !line.classList.contains("is-cleared")) {
      this._collapseLine(line, `Message from ${line.dataset.msgUsername || "user"} deleted.`);
    }
  },

  /** Marks a line deleted WITHOUT destroying its content: a class dims it and strikes the
   * text, full brightness on hover. `tooltip` becomes a native `title`. */
  _collapseLine(line, tooltip) {
    line.classList.add("is-cleared");
    line.title = tooltip;
  },

  /** Adds a newly-held message to the queue and refreshes the panel/badge. Called from the
   * eventsub-automod-hold listener. */
  _addAutomodHold(hold) {
    this._automodQueue.push(hold);
    this._renderAutomodPanel();
    // Surface it even if the panel's collapsed - like the redemption banner, a mod shouldn't
    // need the panel open to notice.
    const toggleBtn = document.getElementById("automod-toggle-btn");
    if (toggleBtn) toggleBtn.classList.add("has-pending");
    // Also drop an inline line into the stream so mods see it in context.
    this._renderAutomodChatLine(hold);
  },

  /** Appends an inline chat-stream line for a held message so mods can Allow/Deny in
   * context. Tagged data-automod-msg-id so _resolveAutomodHold can pull it when resolved. */
  _renderAutomodChatLine(hold) {
    const line = document.createElement("div");
    line.className = "chat-line is-automod-held";
    line.dataset.automodMsgId = hold.msg_id;

    // Header row: label + category pill
    const label = document.createElement("div");
    label.className = "automod-held-label";
    const labelText = document.createElement("span");
    labelText.textContent = "Message held by AutoMod";
    label.appendChild(labelText);
    if (hold.category) {
      const cat = document.createElement("span");
      cat.className = "automod-held-category";
      cat.textContent = hold.category;
      label.appendChild(cat);
    }
    line.appendChild(label);

    // Body: username + plain message text (no emote rendering, like Twitch's held view -
    // the raw text before it posted)
    const body = document.createElement("div");
    body.className = "automod-held-body";
    const nameSpan = document.createElement("span");
    nameSpan.className = "chat-username automod-held-username";
    nameSpan.textContent = (hold.user_name || "user") + ":";
    body.appendChild(nameSpan);
    body.appendChild(document.createTextNode(" "));
    const msgSpan = document.createElement("span");
    msgSpan.className = "chat-message-text";
    msgSpan.textContent = hold.message || "";
    body.appendChild(msgSpan);
    line.appendChild(body);

    // Inline Allow / Deny buttons
    const actions = document.createElement("div");
    actions.className = "automod-inline-actions";
    const allowBtn = document.createElement("button");
    allowBtn.className = "automod-allow-btn";
    allowBtn.textContent = "Allow";
    const denyBtn = document.createElement("button");
    denyBtn.className = "automod-deny-btn";
    denyBtn.textContent = "Deny";
    allowBtn.addEventListener("click", () =>
      this._resolveAutomodHold(hold.msg_id, "ALLOW", allowBtn, denyBtn));
    denyBtn.addEventListener("click", () =>
      this._resolveAutomodHold(hold.msg_id, "DENY", allowBtn, denyBtn));
    actions.appendChild(allowBtn);
    actions.appendChild(denyBtn);
    line.appendChild(actions);

    this.container.appendChild(line);
    this.trimAndScroll();
  },

  /** Removes the inline line for a resolved hold, if still in the DOM (panel and inline
   * both call _resolveAutomodHold; the second is a no-op). */
  _removeAutomodChatLine(msgId) {
    const line = this.container.querySelector(
      `[data-automod-msg-id="${msgId}"]`
    );
    if (line) line.remove();
  },

  /** Rebuilds #automod-panel from this._automodQueue and updates the count badge. Full
   * rebuild on every mutation - the queue stays small, so it's simpler and cheap. */
  _renderAutomodPanel() {
    const countEl = document.getElementById("automod-queue-count");
    if (countEl) {
      const n = this._automodQueue.length;
      countEl.textContent = String(n);
      countEl.classList.toggle("visible", n > 0);
    }
    const toggleBtn = document.getElementById("automod-toggle-btn");
    if (toggleBtn) {
      toggleBtn.style.display = this.isMod ? "flex" : "none";
      if (this._automodQueue.length === 0) toggleBtn.classList.remove("has-pending");
    }

    const panel = document.getElementById("automod-panel");
    if (!panel) return;
    panel.innerHTML = "";

    if (this._automodQueue.length === 0) {
      if (this.isMod) {
        const empty = document.createElement("div");
        empty.className = "automod-panel-empty";
        empty.textContent = "No messages awaiting review.";
        panel.appendChild(empty);
      }
      return;
    }

    for (const hold of this._automodQueue) {
      panel.appendChild(this._buildAutomodItem(hold));
    }
  },

  _buildAutomodItem(hold) {
    const item = document.createElement("div");
    item.className = "automod-item";

    const header = document.createElement("div");
    header.className = "automod-item-header";
    const user = document.createElement("span");
    user.className = "automod-item-user";
    user.textContent = hold.user_name || "user";
    header.appendChild(user);
    if (hold.category) {
      const cat = document.createElement("span");
      cat.className = "automod-item-category";
      cat.textContent = hold.category;
      header.appendChild(cat);
    }
    item.appendChild(header);

    const text = document.createElement("div");
    text.className = "automod-item-text";
    text.textContent = hold.message || "";
    item.appendChild(text);

    const actions = document.createElement("div");
    actions.className = "automod-item-actions";

    const allowBtn = document.createElement("button");
    allowBtn.className = "automod-allow-btn";
    allowBtn.textContent = "Allow";
    allowBtn.addEventListener("click", () => this._resolveAutomodHold(hold.msg_id, "ALLOW", allowBtn, denyBtn));

    const denyBtn = document.createElement("button");
    denyBtn.className = "automod-deny-btn";
    denyBtn.textContent = "Deny";
    denyBtn.addEventListener("click", () => this._resolveAutomodHold(hold.msg_id, "DENY", allowBtn, denyBtn));

    actions.appendChild(allowBtn);
    actions.appendChild(denyBtn);
    item.appendChild(actions);

    return item;
  },

  async _resolveAutomodHold(msgId, action, allowBtn, denyBtn) {
    allowBtn.disabled = true;
    denyBtn.disabled = true;
    try {
      await invoke("automod_process_message", { msgId, action });
      // Remove from the queue on success - no separate approved/denied event to wait for;
      // Helix success IS the confirmation.
      this._automodQueue = this._automodQueue.filter((h) => h.msg_id !== msgId);
      this._renderAutomodPanel();
      // Also pull the inline line - both button sets call this, so the second just cleans the
      // DOM.
      this._removeAutomodChatLine(msgId);
    } catch (err) {
      console.error(`Failed to ${action.toLowerCase()} automod message:`, err);
      this.systemLine(`Failed to ${action === "ALLOW" ? "allow" : "deny"} message: ${err}`);
      allowBtn.disabled = false;
      denyBtn.disabled = false;
    }
  },

  /** Toggles #automod-panel. Wired to automod-toggle-btn in main.js (that button is static
   * HTML, not chat.js-owned), exposed as a method rather than main.js reaching in. */
  toggleAutomodPanel() {
    const panel = document.getElementById("automod-panel");
    if (!panel) return;
    const showing = panel.style.display !== "none";
    panel.style.display = showing ? "none" : "block";
  },

};
