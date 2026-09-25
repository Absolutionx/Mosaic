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
  // btn (optional): greyed out while the request runs. the right-click menu closes itself instead, so passes none
  async _deleteMessage(msgId, btn = null) {
    if (!msgId || !this.roomId) return;
    const original = btn ? btn.innerHTML : "";
    if (btn) btn.disabled = true;
    try {
      await invoke("delete_chat_message", { broadcasterId: this.roomId, messageId: msgId });
      // no optimistic update: Twitch's CLEARMSG for this arrives over IRC and is handled centrally in _handleClearMsg, same as any other client
    } catch (err) {
      console.error("Failed to delete message:", err);
      this.systemLine(`Failed to delete message: ${err}`);
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = original;
      }
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

  // Right-click menu on a chat message: Reply / Copy message / Copy username / View profile for everyone,
  // plus Delete / Timeout / Ban when you're a mod here (these replaced the old hover buttons). Rebuilt on
  // every right-click, so it always reflects the current login and mod status.
  _showMessageContextMenu(x, y, line) {
    this._closeMessageContextMenu();
    const ICON = {
      reply: '<path d="M9 17 4 12l5-5"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/>',
      copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>',
      user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
      at: '<circle cx="12" cy="12" r="4"/><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8"/>',
      trash: '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M6 6l1 14h10l1-14"/>',
      clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
      ban: '<circle cx="12" cy="12" r="9"/><path d="m5.6 5.6 12.8 12.8"/>',
    };
    const svg = (k) =>
      `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICON[k]}</svg>`;

    const menu = document.createElement("div");
    menu.className = "chat-context-menu";
    menu.setAttribute("role", "menu");

    const username = line.dataset.msgUsername || "";
    const userId = line.dataset.msgUserId || "";
    const msgId = line.dataset.msgId || "";

    const addItem = (icon, label, onClick, opts = {}) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "chat-context-menu-item" + (opts.danger ? " chat-context-menu-item-danger" : "");
      item.setAttribute("role", "menuitem");
      item.innerHTML = svg(icon);
      const text = document.createElement("span");
      text.textContent = label;
      item.appendChild(text);
      if (opts.hint) {
        const hint = document.createElement("span");
        hint.className = "chat-context-menu-hint";
        hint.textContent = opts.hint;
        item.appendChild(hint);
      }
      item.disabled = Boolean(opts.disabled);
      if (!opts.disabled) {
        item.addEventListener("click", (e) => {
          e.stopPropagation();
          if (!opts.keepOpen) this._closeMessageContextMenu();
          onClick(item);
        });
      }
      menu.appendChild(item);
      return item;
    };
    const addDivider = () => {
      const d = document.createElement("div");
      d.className = "chat-context-menu-divider";
      menu.appendChild(d);
    };

    if (username) {
      const head = document.createElement("div");
      head.className = "chat-context-menu-head";
      head.textContent = username;
      menu.appendChild(head);
    }

    if (this.isLoggedIn && msgId) {
      addItem("reply", "Reply", () => this._setReplyTarget(msgId, username, line.dataset.msgText || ""));
    }
    addItem("copy", "Copy message", () => {
      navigator.clipboard.writeText(line.dataset.msgText || "").catch(() => {});
    });
    if (username) {
      addItem("at", "Copy username", () => {
        navigator.clipboard.writeText(username).catch(() => {});
      });
    }
    const nameEl = line.querySelector(".chat-username-clickable");
    if (nameEl) addItem("user", "View profile", () => nameEl.click());

    // mod actions: only when you moderate this channel (enforcement is server-side regardless)
    if (this.isMod && this.roomId) {
      const isSelf = this._isSelf(username);
      const canDelete = Boolean(msgId) && !isSelf;
      const canMod = Boolean(userId) && !isSelf;
      addDivider();
      addItem("trash", "Delete message", () => this._deleteMessage(msgId, null), { disabled: !canDelete });

      // Timeout expands its durations right inside the menu (no side flyout to chase near screen edges)
      const toItem = addItem("clock", "Timeout", () => {
        const open = menu.classList.toggle("timeout-open");
        toItem.setAttribute("aria-expanded", String(open));
        this._positionContextMenu(menu, x, y);
      }, { disabled: !canMod, keepOpen: true, hint: "▸" });
      if (canMod) {
        const row = document.createElement("div");
        row.className = "chat-context-menu-durations";
        for (const [label, secs] of [["1s", 1], ["1m", 60], ["10m", 600], ["1h", 3600], ["24h", 86400]]) {
          const b = document.createElement("button");
          b.type = "button";
          b.textContent = label;
          b.title = `Timeout ${username} for ${label}`;
          b.addEventListener("click", (e) => {
            e.stopPropagation();
            this._closeMessageContextMenu();
            this._timeoutUser(userId, username, secs);
          });
          row.appendChild(b);
        }
        menu.appendChild(row);
      }
      addItem("ban", "Ban", () => this._confirmAndBan(userId, username), { danger: true, disabled: !canMod });
    }

    document.body.appendChild(menu);
    this._positionContextMenu(menu, x, y);

    this._contextMenuEl = menu;
    this._contextMenuOutsideHandler = (e) => {
      if (e.type === "keydown") {
        if (e.key === "Escape") this._closeMessageContextMenu();
        return;
      }
      if (!menu.contains(e.target)) this._closeMessageContextMenu();
    };
    setTimeout(() => {
      document.addEventListener("click", this._contextMenuOutsideHandler, true);
      document.addEventListener("contextmenu", this._contextMenuOutsideHandler, true);
      document.addEventListener("keydown", this._contextMenuOutsideHandler, true);
    }, 0);
  },

  // keep the menu inside the window (re-run when the Timeout durations expand it)
  _positionContextMenu(menu, x, y) {
    menu.style.position = "fixed";
    const w = menu.offsetWidth, h = menu.offsetHeight;
    menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - w - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - h - 8))}px`;
  },

  _closeMessageContextMenu() {
    if (this._contextMenuEl) {
      this._contextMenuEl.remove();
      this._contextMenuEl = null;
    }
    if (this._contextMenuOutsideHandler) {
      document.removeEventListener("click", this._contextMenuOutsideHandler, true);
      document.removeEventListener("contextmenu", this._contextMenuOutsideHandler, true);
      document.removeEventListener("keydown", this._contextMenuOutsideHandler, true);
      this._contextMenuOutsideHandler = null;
    }
  },

};
