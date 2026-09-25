// Chat badge picker ("chat identity"): choose which global badge and which channel badge you wear. Opens from
// the badge next to the message box, or by clicking one of your own badges in chat. Mixed into TwitchChat.
//
// - options: get_badge_options (Rust, unofficial GQL via the device login) returns set/version pairs only;
//   titles and images come from this.badgeMap (the global + channel badge lists Mosaic already loads)
// - what you're wearing now: the USERSTATE badges tag (this._ownBadgesTag)
// - selecting: set_chat_badge; the badge next to the message box updates immediately (Twitch confirms it on
//   your next message / USERSTATE)

import { invoke } from "@tauri-apps/api/core";

const CHECK = '<svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';

export const chatBadgePickerMixin = {
  _initBadgePicker() {
    if (this._badgePickerInit) return;
    this._badgePickerInit = true;
    this._inputBadgeEl?.addEventListener("click", (e) => {
      if (!this._inputBadgeEl.classList.contains("badge-pickable")) return;
      e.stopPropagation();
      this.toggleBadgePicker(this._inputBadgeEl);
    });
    // your own badges in chat lines (e.g. your subscriber badge) open it too
    this.container?.addEventListener("click", (e) => {
      const img = e.target.closest && e.target.closest("img.chat-badge");
      if (!img || this._isKickChat || !this.isLoggedIn) return;
      const line = img.closest(".chat-line");
      if (!line || !this._isSelf?.(line.dataset.msgUsername || "")) return;
      e.stopPropagation();
      this.toggleBadgePicker(img);
    });
  },

  toggleBadgePicker(anchor) {
    if (this._badgePickerEl) { this._closeBadgePicker(); return; }
    this._openBadgePicker(anchor);
  },

  _closeBadgePicker() {
    this._badgePickerEl?.remove();
    this._badgePickerEl = null;
    if (this._badgePickerOutside) {
      document.removeEventListener("mousedown", this._badgePickerOutside, true);
      document.removeEventListener("keydown", this._badgePickerOutside, true);
      this._badgePickerOutside = null;
    }
  },

  _ownBadgePairs() {
    return (this._ownBadgesTag || "").split(",").map((p) => p.trim()).filter(Boolean);
  },

  async _openBadgePicker(anchor) {
    this._closeBadgePicker();
    const pop = document.createElement("div");
    pop.className = "badge-picker";
    pop.setAttribute("role", "dialog");
    pop.innerHTML =
      '<div class="badge-picker-head"><div class="badge-picker-title">Chat badges</div>' +
      '<div class="badge-picker-sub"></div></div>' +
      '<div class="badge-picker-body"><div class="badge-picker-loading"><span></span><span></span><span></span><span></span><span></span></div></div>' +
      '<div class="badge-picker-foot">Shows next to your name. Takes effect on your next message.</div>';
    pop.querySelector(".badge-picker-sub").textContent = `in ${this.channel}`;
    document.body.appendChild(pop);
    this._badgePickerEl = pop;
    this._positionBadgePicker(anchor);
    this._badgePickerOutside = (e) => {
      if (e.type === "keydown") { if (e.key === "Escape") this._closeBadgePicker(); return; }
      if (!pop.contains(e.target) && !(anchor && anchor.contains && anchor.contains(e.target))) this._closeBadgePicker();
    };
    setTimeout(() => {
      document.addEventListener("mousedown", this._badgePickerOutside, true);
      document.addEventListener("keydown", this._badgePickerOutside, true);
    }, 0);

    let opts;
    try {
      opts = await invoke("get_badge_options", { channelLogin: this.channel });
    } catch (err) {
      if (this._badgePickerEl !== pop) return;
      this._renderBadgePickerError(pop, typeof err === "string" ? err : err?.message || "Couldn't load your badges");
      this._positionBadgePicker(anchor);
      return;
    }
    if (this._badgePickerEl !== pop) return;
    this._renderBadgePickerLists(pop, opts || { global: [], channel: [] });
    this._positionBadgePicker(anchor);
  },

  // above the anchor (the composer sits at the bottom), kept inside the window
  _positionBadgePicker(anchor) {
    const pop = this._badgePickerEl;
    if (!pop || !anchor) return;
    const r = anchor.getBoundingClientRect();
    const w = pop.offsetWidth, h = pop.offsetHeight;
    let top = r.top - h - 8;
    if (top < 8) top = Math.min(window.innerHeight - h - 8, r.bottom + 8);
    pop.style.top = `${Math.max(8, top)}px`;
    pop.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, r.left - 6))}px`;
  },

  _renderBadgePickerLists(pop, opts) {
    const body = pop.querySelector(".badge-picker-body");
    body.replaceChildren();
    const wearing = new Set(this._ownBadgePairs());
    const section = (label, scope, list) => {
      const known = (list || []).map((b) => ({ pair: `${b.setID}/${b.version}`, ...b }))
        .filter((b, i, arr) => arr.findIndex((x) => x.pair === b.pair) === i);
      const wrap = document.createElement("div");
      wrap.className = "badge-picker-section";
      const h = document.createElement("div");
      h.className = "badge-picker-label";
      h.textContent = label;
      wrap.appendChild(h);
      if (!known.length) {
        const none = document.createElement("div");
        none.className = "badge-picker-none";
        none.textContent = scope === "channel" ? "No badges to pick in this channel" : "No global badges to pick";
        wrap.appendChild(none);
        return wrap;
      }
      const grid = document.createElement("div");
      grid.className = "badge-picker-grid";
      for (const b of known) {
        const info = this.badgeMap?.get(b.pair);
        const tile = document.createElement("button");
        tile.type = "button";
        tile.className = "badge-picker-tile" + (wearing.has(b.pair) ? " selected" : "");
        tile.dataset.pair = b.pair;
        tile.title = info?.title || b.setID;
        if (info?.url) {
          const img = document.createElement("img");
          img.src = info.url; img.alt = ""; img.loading = "lazy";
          tile.appendChild(img);
        } else {
          const t = document.createElement("span");
          t.className = "badge-picker-fallback";
          t.textContent = b.setID.slice(0, 2).toUpperCase();
          tile.appendChild(t);
        }
        const tick = document.createElement("span");
        tick.className = "badge-picker-check";
        tick.innerHTML = CHECK;
        tile.appendChild(tick);
        tile.addEventListener("click", () => this._selectBadge(scope, b, known, tile));
        grid.appendChild(tile);
      }
      wrap.appendChild(grid);
      return wrap;
    };
    body.append(section("This channel", "channel", opts.channel), section("Global", "global", opts.global));
  },

  async _selectBadge(scope, badge, scopeList, tile) {
    const pop = this._badgePickerEl;
    if (!pop || tile.classList.contains("selected") || tile.classList.contains("busy")) return;
    tile.classList.add("busy");
    const errEl = pop.querySelector(".badge-picker-error");
    if (errEl) errEl.remove();
    try {
      await invoke("set_chat_badge", { scope, channelId: String(this.roomId || ""), setId: badge.setID, version: badge.version });
    } catch (err) {
      tile.classList.remove("busy");
      const e = document.createElement("div");
      e.className = "badge-picker-error";
      e.textContent = typeof err === "string" ? err : err?.message || "Twitch didn't accept that badge";
      pop.querySelector(".badge-picker-body").appendChild(e);
      return;
    }
    tile.classList.remove("busy");
    // swap the badge of this kind in what you're wearing, and redraw the badge next to the message box
    const scopePairs = new Set(scopeList.map((b) => b.pair));
    const pairs = this._ownBadgePairs();
    const idx = pairs.findIndex((p) => scopePairs.has(p));
    const next = pairs.filter((p) => !scopePairs.has(p));
    next.splice(idx >= 0 ? idx : next.length, 0, badge.pair);
    this._ownBadgesTag = next.join(",");
    this._renderInputBadges(this._ownBadgesTag);
    tile.parentElement.querySelectorAll(".badge-picker-tile").forEach((t) => t.classList.toggle("selected", t === tile));
  },

  _renderBadgePickerError(pop, message) {
    const body = pop.querySelector(".badge-picker-body");
    body.replaceChildren();
    const e = document.createElement("div");
    e.className = "badge-picker-error";
    e.textContent = message;
    body.append(e);
  },
};
