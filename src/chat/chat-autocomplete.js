// @mention autocomplete: chatter fetching + the username popup. mixed onto TwitchChat (see ../chat.js)

import { invoke } from "@tauri-apps/api/core";
export const chatAutocompleteMixin = {
  _currentAtWord() {
    const input = this.inputEl;
    if (!input) return { word: "", wordStart: 0, wordEnd: 0 };
    const pos = input.selectionStart ?? input.value.length;
    const val = input.value;
    let start = pos;
    while (start > 0 && val[start - 1] !== " ") start--;
    let end = pos;
    while (end < val.length && val[end] !== " ") end++;
    const word = val.slice(start, end);
    if (!word.startsWith("@")) return { word: "", wordStart: 0, wordEnd: 0 };
    return { word, wordStart: start, wordEnd: end };
  },

  // pull the full chatter roster (get_chatters) so @mention can suggest silent viewers.
  // mod/broadcaster only (else 403), tried from both the room-id and mod-status listeners
  // and guarded against a duplicate
  async _maybeFetchChatters() {
    if (!this.roomId || !this.channel) return;
    const isBroadcaster = this.ownLogin && this.ownLogin.toLowerCase() === this.channel;
    if (!this.isMod && !isBroadcaster) return;
    if (this._chattersFetchedForChannel === this.channel) return;
    this._chattersFetchedForChannel = this.channel;

    try {
      const raw = await invoke("get_chatters", { broadcasterId: this.roomId });
      const chatters = JSON.parse(raw);
      for (const c of chatters) {
        const login = c.user_login;
        if (!login) continue;
        // don't clobber a display-name casing already captured from a real PRIVMSG, the more live source
        if (!this._chatUsers.has(login.toLowerCase())) {
          this._chatUsers.set(login.toLowerCase(), c.user_name || login);
        }
      }
    } catch (err) {
      // expected for a channel you aren't a mod/broadcaster of (403), not worth logging
      this._chattersFetchedForChannel = null;
    }
  },

  _updateUserPopup() {
    const { word } = this._currentAtWord();
    if (!word || word.length < 2) { this._hideEmotePopup(); return; }
    const prefix = word.slice(1).toLowerCase();
    const matches = [];
    for (const [login, displayName] of this._chatUsers) {
      if (login.startsWith(prefix)) matches.push(displayName);
      if (matches.length >= 10) break;
    }
    if (matches.length === 0) { this._hideEmotePopup(); return; }
    this._showUserPopup(matches);
  },

  _showUserPopup(names) {
    this._popupMode = "user";
    const popup = this._emotePopup;
    popup.innerHTML = "";
    this._emotePopupIndex = -1;

    for (const name of names) {
      const item = document.createElement("div");
      item.className = "emote-autocomplete-item";
      item.dataset.name = name;

      const icon = document.createElement("span");
      icon.className = "user-mention-icon";
      icon.textContent = "@";
      item.appendChild(icon);

      const label = document.createElement("span");
      label.textContent = name;
      item.appendChild(label);

      item.addEventListener("mousedown", (e) => {
        e.preventDefault();
        this._commitUserByName(name);
      });
      popup.appendChild(item);
    }
    popup.style.display = "block";
    this._repositionPopup();
    this._setEmoteSelection(0);
  },

  _commitUserByName(name) {
    const input = this.inputEl;
    if (!input) return;
    const { wordStart, wordEnd } = this._currentAtWord();
    const val = input.value;
    const replacement = `@${name} `;
    input.value = val.slice(0, wordStart) + replacement + val.slice(wordEnd);
    this._autosizeChatInput();
    const pos = wordStart + replacement.length;
    input.setSelectionRange(pos, pos);
    this._hideEmotePopup();
    this._popupMode = "emote";
    input.focus();
    input.closest?.(".chat-input-wrapper")
      ?.classList.toggle("has-text", input.value.length > 0);
  },

};
