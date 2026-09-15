// moderation (delete, timeout, ban) and slash-command equivalents. mixed onto TwitchChat
// (see ../chat.js). needs this.roomId and the target user id; disabled, not hidden, for
// non-mods and self-targeting (Helix would 400)

import { invoke } from "@tauri-apps/api/core";
export const chatModActionsMixin = {
  // handled means success or failure both count, so it isn't also sent as a plain message
  async _tryHandleSlashCommand(text) {
    const parts = text.slice(1).split(/\s+/).filter(Boolean);
    const cmd = (parts.shift() || "").toLowerCase();

    switch (cmd) {
      case "ban":
        return this._slashBan(parts);
      case "unban":
        return this._slashUnban(parts);
      case "timeout":
        return this._slashTimeout(parts);
      case "untimeout":
        // /untimeout just lifts the restriction early, same DELETE .../bans as /unban, Helix has no timeout-vs-ban distinction once in effect
        return this._slashUnban(parts);
      case "clear":
        return this._slashClear();
      default:
        return false; // not a command we recognize
    }
  },

  _requireModForSlashCommand(commandLabel) {
    if (!this.roomId) {
      this.systemLine(`Can't run ${commandLabel}: not connected to a channel.`);
      return false;
    }
    if (!this.isMod) {
      this.systemLine(`Can't run ${commandLabel}: you must be a moderator.`);
      return false;
    }
    return true;
  },

  async _resolveSlashTarget(login, commandLabel) {
    try {
      return await invoke("get_user_id_for_login", { login });
    } catch (err) {
      console.error(`${commandLabel}: failed to resolve user`, login, err);
      this.systemLine(`Can't find a user named "${login}".`);
      return null;
    }
  },

  async _slashBan(args) {
    if (!this._requireModForSlashCommand("/ban")) return true;
    const [login, ...reasonParts] = args;
    if (!login) {
      this.systemLine("Usage: /ban <username> [reason]");
      return true;
    }
    if (this._isSelf(login)) {
      this.systemLine("You can't ban yourself.");
      return true;
    }
    const userId = await this._resolveSlashTarget(login, "/ban");
    if (!userId) return true;
    const reason = reasonParts.join(" ") || undefined;
    try {
      await invoke("ban_user", { broadcasterId: this.roomId, targetUserId: userId, reason });
      this.systemLine(`${login} has been banned.`);
    } catch (err) {
      console.error("Failed to ban user:", err);
      this.systemLine(`Failed to ban ${login}: ${err}`);
    }
    return true;
  },

  async _slashUnban(args) {
    if (!this._requireModForSlashCommand("/unban")) return true;
    const [login] = args;
    if (!login) {
      this.systemLine("Usage: /unban <username>");
      return true;
    }
    const userId = await this._resolveSlashTarget(login, "/unban");
    if (!userId) return true;
    try {
      await invoke("unban_user", { broadcasterId: this.roomId, targetUserId: userId });
      this.systemLine(`${login} has been unbanned.`);
    } catch (err) {
      // Helix 400s "not banned" when there's nothing to lift (e.g. /untimeout on an expired timeout), a common outcome, not a failure
      if (this._isNotBannedError(err)) {
        this.systemLine(`${login} is not currently banned or timed out.`);
      } else {
        console.error("Failed to unban user:", err);
        this.systemLine(`Failed to unban ${login}: ${err}`);
      }
    }
    return true;
  },

  // match on the message text, not just the 400, since a 400 could be a malformed id which
  // should still show as a failure
  _isNotBannedError(err) {
    return /not banned/i.test(String(err));
  },

  async _slashTimeout(args) {
    if (!this._requireModForSlashCommand("/timeout")) return true;
    if (args.length === 0) {
      this.systemLine("Usage: /timeout <username> [duration] (e.g. /timeout someuser 10m)");
      return true;
    }
    // flexible order: whichever token parses as a duration is the duration, the rest is the
    // username. /timeout defaults to 10 minutes
    let login = null;
    let durationSeconds = 600;
    let sawDuration = false;
    for (const token of args) {
      const parsed = this._parseDuration(token);
      if (parsed !== null && !sawDuration) {
        durationSeconds = parsed;
        sawDuration = true;
      } else if (!login) {
        login = token;
      }
    }
    if (!login) {
      this.systemLine("Usage: /timeout <username> [duration]");
      return true;
    }
    if (this._isSelf(login)) {
      this.systemLine("You can't time out yourself.");
      return true;
    }
    const userId = await this._resolveSlashTarget(login, "/timeout");
    if (!userId) return true;
    try {
      await invoke("ban_user", { broadcasterId: this.roomId, targetUserId: userId, durationSeconds });
      this.systemLine(`${login} has been timed out for ${this._formatDuration(durationSeconds)}.`);
    } catch (err) {
      console.error("Failed to timeout user:", err);
      this.systemLine(`Failed to timeout ${login}: ${err}`);
    }
    return true;
  },

  async _slashClear() {
    if (!this._requireModForSlashCommand("/clear")) return true;
    try {
      // messageId null clears the ENTIRE room (per Helix), not one message, see delete_chat_message in main.rs
      await invoke("delete_chat_message", { broadcasterId: this.roomId, messageId: null });
      this.systemLine("Chat has been cleared.");
    } catch (err) {
      console.error("Failed to clear chat:", err);
      this.systemLine(`Failed to clear chat: ${err}`);
    }
    return true;
  },

  // null if it isn't a duration, so the caller can tell a duration from an all-digit username. a bare number is seconds
  _parseDuration(token) {
    const m = /^(\d+)(s|m|h|d|w)?$/i.exec(token);
    if (!m) return null;
    const n = parseInt(m[1], 10);
    if (!Number.isFinite(n) || n <= 0) return null;
    const unit = (m[2] || "s").toLowerCase();
    const multiplier = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 }[unit];
    return n * multiplier;
  },

  // disable the btn while in flight so a slow connection doesn't invite a second click
  async _deleteMessage(msgId, btn) {
    if (!msgId || !this.roomId) return;
    const original = btn.innerHTML;
    btn.disabled = true;
    try {
      await invoke("delete_chat_message", { broadcasterId: this.roomId, messageId: msgId });
      // no optimistic update: Twitch's CLEARMSG for this arrives over IRC and is handled centrally in _handleClearMsg, same as any other client
    } catch (err) {
      console.error("Failed to delete message:", err);
      this.systemLine(`Failed to delete message: ${err}`);
    } finally {
      btn.disabled = false;
      btn.innerHTML = original;
    }
  },

  async _timeoutUser(targetUserId, targetUsername, durationSeconds) {
    if (!targetUserId || !this.roomId) return;
    try {
      await invoke("ban_user", {
        broadcasterId: this.roomId,
        targetUserId,
        durationSeconds,
      });
      this.systemLine(`${targetUsername} has been timed out for ${this._formatDuration(durationSeconds)}.`);
    } catch (err) {
      console.error("Failed to timeout user:", err);
      this.systemLine(`Failed to timeout ${targetUsername}: ${err}`);
    }
  },

  // small duration menu for the per-message hover Timeout button (StreamNook-style: 1s/10m/1h/24h)
  _showTimeoutMenu(anchor, targetUserId, targetUsername) {
    document.querySelector(".mod-timeout-menu")?.remove();
    if (!targetUserId) return;
    const menu = document.createElement("div");
    menu.className = "mod-timeout-menu";
    const presets = [["1s", 1], ["10m", 600], ["1h", 3600], ["24h", 86400]];
    for (const [label, secs] of presets) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        this._timeoutUser(targetUserId, targetUsername, secs);
        menu.remove();
      });
      menu.appendChild(b);
    }
    document.body.appendChild(menu);
    const r = anchor.getBoundingClientRect();
    const mw = menu.offsetWidth || 150;
    menu.style.top = `${r.bottom + 4}px`;
    menu.style.left = `${Math.max(8, Math.min(window.innerWidth - mw - 8, r.left - mw / 2))}px`;
    const close = (e) => {
      if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener("mousedown", close); }
    };
    setTimeout(() => document.addEventListener("mousedown", close), 0);
  },

  // bans are permanent and easy to misclick, unlike timeout (the picker confirms) or delete
  // (reversible), so this is the one mod action with a confirm step
  _confirmAndBan(targetUserId, targetUsername) {
    if (!window.confirm(`Permanently ban ${targetUsername}? This can be undone later via unban.`)) {
      return;
    }
    this._banUser(targetUserId, targetUsername);
  },

  async _banUser(targetUserId, targetUsername) {
    if (!targetUserId || !this.roomId) return;
    try {
      await invoke("ban_user", { broadcasterId: this.roomId, targetUserId });
      this.systemLine(`${targetUsername} has been banned.`);
    } catch (err) {
      console.error("Failed to ban user:", err);
      this.systemLine(`Failed to ban ${targetUsername}: ${err}`);
    }
  },

  // copy + reply only, mod actions live in the user card now. rebuilt each right-click since reply depends on isLoggedIn/msgId
  _showMessageContextMenu(x, y, line) {
    this._closeMessageContextMenu();

    const menu = document.createElement("div");
    menu.className = "chat-context-menu";

    const addItem = (label, onClick, opts = {}) => {
      const item = document.createElement("button");
      item.className = "chat-context-menu-item" + (opts.danger ? " chat-context-menu-item-danger" : "");
      item.textContent = label;
      item.disabled = Boolean(opts.disabled);
      if (!opts.disabled) {
        item.addEventListener("click", (e) => {
          e.stopPropagation();
          this._closeMessageContextMenu();
          onClick();
        });
      }
      menu.appendChild(item);
      return item;
    };

    addItem("Copy message", () => {
      navigator.clipboard.writeText(line.dataset.msgText || "").catch(() => {});
    });

    if (this.isLoggedIn && line.dataset.msgId) {
      addItem("Reply", () => {
        this._setReplyTarget(line.dataset.msgId, line.dataset.msgUsername, line.dataset.msgText || "");
      });
    }

    document.body.appendChild(menu);
    menu.style.position = "fixed";
    const menuWidth = menu.offsetWidth;
    const menuHeight = menu.offsetHeight;
    menu.style.left = `${Math.min(x, window.innerWidth - menuWidth - 8)}px`;
    menu.style.top = `${Math.min(y, window.innerHeight - menuHeight - 8)}px`;

    this._contextMenuEl = menu;
    this._contextMenuOutsideHandler = (e) => {
      if (!menu.contains(e.target)) this._closeMessageContextMenu();
    };
    setTimeout(() => {
      document.addEventListener("click", this._contextMenuOutsideHandler, true);
      document.addEventListener("contextmenu", this._contextMenuOutsideHandler, true);
    }, 0);
  },

  _closeMessageContextMenu() {
    if (this._contextMenuEl) {
      this._contextMenuEl.remove();
      this._contextMenuEl = null;
    }
    if (this._contextMenuOutsideHandler) {
      document.removeEventListener("click", this._contextMenuOutsideHandler, true);
      document.removeEventListener("contextmenu", this._contextMenuOutsideHandler, true);
      this._contextMenuOutsideHandler = null;
    }
  },

};
