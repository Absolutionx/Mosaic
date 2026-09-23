// AutoMod hold queue: rendering held messages, the review panel, and clear/delete actions.
// mixed onto TwitchChat (see ../chat.js). held messages arrive via eventsub-automod-hold
// (see eventsub.rs), never over IRC, so there's no chat line to attach to; they live in
// their own queue in #automod-panel until a mod Allows or Denies each

import { invoke } from "@tauri-apps/api/core";
export const chatAutomodMixin = {
  // one user's messages cleared (timeout/ban) or the whole chat. mark the lines removed but
  // keep them visible, dimmed with a strikethrough, so there's still a record
  _handleClearChat({ target_user_id, target_username, ban_duration_secs }) {
    if (!target_username && !target_user_id) {
      // whole-chat clear
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

  // matched by msg_id, the same id PRIVMSG's `id` tag put on line.dataset.msgId
  _handleClearMsg({ target_msg_id }) {
    const line = this.container.querySelector(`.chat-line[data-msg-id="${CSS.escape(target_msg_id)}"]`);
    if (line && !line.classList.contains("is-cleared")) {
      this._collapseLine(line, `Message from ${line.dataset.msgUsername || "user"} deleted.`);
    }
  },

  // dim + strike without destroying the content, full brightness on hover. tooltip becomes a native title
  _collapseLine(line, tooltip) {
    line.classList.add("is-cleared");
    line.title = tooltip;
  },

  _addAutomodHold(hold) {
    this._automodQueue.push(hold);
    this._renderAutomodPanel();
    // surface it even if the panel's collapsed, a mod shouldn't need it open to notice
    const toggleBtn = document.getElementById("automod-toggle-btn");
    if (toggleBtn) toggleBtn.classList.add("has-pending");
    // also drop an inline line into the stream so mods see it in context
    this._renderAutomodChatLine(hold);
  },

  // tagged data-automod-msg-id so _resolveAutomodHold can pull it when resolved
  _renderAutomodChatLine(hold) {
    const line = document.createElement("div");
    line.className = "chat-line is-automod-held";
    line.dataset.automodMsgId = hold.msg_id;

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

    // plain text, no emote rendering, like Twitch's held view (the raw text before it posted)
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

  // both the panel and inline call this, so the second is a no-op
  _removeAutomodChatLine(msgId) {
    const line = this.container.querySelector(
      `[data-automod-msg-id="${msgId}"]`
    );
    if (line) line.remove();
  },

  // full rebuild on every mutation, the queue stays small so it's simpler and cheap
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
    // not a mod here (e.g. opened on a channel you moderate, then switched to one you don't): its toggle
    // is hidden, so the panel must close too, otherwise it lingers as an empty bar under the header
    if (!this.isMod) {
      panel.style.display = "none";
      return;
    }

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
      // no separate approved/denied event to wait for, Helix success IS the confirmation
      this._automodQueue = this._automodQueue.filter((h) => h.msg_id !== msgId);
      this._renderAutomodPanel();
      // both button sets call this, so the second just cleans the DOM
      this._removeAutomodChatLine(msgId);
    } catch (err) {
      console.error(`Failed to ${action.toLowerCase()} automod message:`, err);
      this.systemLine(`Failed to ${action === "ALLOW" ? "allow" : "deny"} message: ${err}`);
      allowBtn.disabled = false;
      denyBtn.disabled = false;
    }
  },

  // automod-toggle-btn is static HTML in main.js, exposed as a method rather than main.js reaching in
  toggleAutomodPanel() {
    const panel = document.getElementById("automod-panel");
    if (!panel) return;
    const showing = panel.style.display !== "none";
    panel.style.display = showing ? "none" : "block";
  },

};
