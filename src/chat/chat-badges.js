// badge and cheermote loading/rendering (global + per-channel). mixed onto TwitchChat (see ../chat.js)

import { invoke } from "@tauri-apps/api/core";
import { kickBadgeElement } from "./kick-badges.js";

// see normalizeColor
const _normalizedColors = new Map();

// light themes (themes.js, body.theme-light): names are DARKENED until readable on the chat background
// instead. maxLum: the lightest a name may be on that background (null on dark themes)
let _lightBgKey = null, _maxLum = null, _bgReadAt = 0;
function lightThemeMaxLum() {
  const body = document.body;
  if (!body?.classList.contains("theme-light")) return null;
  // reading a computed style forces a style pass; in a busy chat that ran for every message, so the
  // background is re-read at most once a second (a theme change shows up within that)
  const now = performance.now();
  if (_lightBgKey !== null && now - _bgReadAt < 1000) return _maxLum;
  _bgReadAt = now;
  const bg = getComputedStyle(body).getPropertyValue("--m-surface").trim();
  if (bg !== _lightBgKey) {
    _lightBgKey = bg;
    const m = /^#([0-9a-f]{6})$/i.exec(bg);
    const lin = (c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
    const L = m ? [0, 2, 4].map((i) => lin(parseInt(m[1].slice(i, i + 2), 16) / 255)).reduce((a, v, i) => a + v * [0.2126, 0.7152, 0.0722][i], 0) : 1;
    // 4.5:1 for small text: (Lbg + 0.05) / (L + 0.05) >= 4.5, with a little margin
    _maxLum = (L + 0.05) / 4.7 - 0.05;
  }
  return _maxLum;
}

function normalizeColorUncached(hex, maxLum = null) {
  if (!hex || !/^#[0-9a-fA-F]{6}$/.test(hex)) return "#9147ff";
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;

  // WCAG relative luminance (gamma-corrected, not the 0.299/0.587/0.114 video-luma formula,
  // which under-weights dark saturated blues)
  const relLum = (rr, gg, bb) => {
    const lin = (c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
    return 0.2126 * lin(rr) + 0.7152 * lin(gg) + 0.0722 * lin(bb);
  };
  // 4.5:1 (readable small text) against the chat background. chat sits on the theme surface (#161b22,
  // luminance ~0.0103), not the old #0e0e10 this was tuned for, so the old 0.193 left some names at ~4:1.
  // (L+0.05)/(0.0103+0.05) = 4.5 -> L ~= 0.222, plus a little margin for the rounding to a hex color
  const MIN_LUM = 0.228;
  if (maxLum == null ? relLum(r, g, b) >= MIN_LUM : relLum(r, g, b) <= maxLum) return hex;

  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0;
  let l = (max + min) / 2;
  const d = max - min;
  if (d > 0) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }

  const hslToRgb = (hh, ss, ll) => {
    if (ss === 0) return [ll, ll, ll];
    const q = ll < 0.5 ? ll * (1 + ss) : ll + ss - ll * ss;
    const p = 2 * ll - q;
    const chan = (t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    return [chan(hh + 1 / 3), chan(hh), chan(hh - 1 / 3)];
  };

  // walk lightness up (dark themes) or down (light themes) until readable. 0.02 steps, can't loop
  // forever since l clamps to 1 (white) or 0 (black)
  let [nr, ng, nb] = [r, g, b];
  if (maxLum == null) {
    while (relLum(nr, ng, nb) < MIN_LUM && l < 1) {
      l = Math.min(1, l + 0.02);
      [nr, ng, nb] = hslToRgb(h, s, l);
    }
  } else {
    while (relLum(nr, ng, nb) > maxLum && l > 0) {
      l = Math.max(0, l - 0.02);
      [nr, ng, nb] = hslToRgb(h, s, l);
    }
  }
  const toHex = (c) => Math.round(c * 255).toString(16).padStart(2, "0");
  return `#${toHex(nr)}${toHex(ng)}${toHex(nb)}`;
}

export const chatBadgesMixin = {
  // parse the IRC `badges` tag ("broadcaster/1,subscriber/12") into one <img> per known badge;
  // unknown ones are skipped, not shown broken. Kick "kick/{type}/{count}" entries route to
  // kick-badges.js, subscriber ones months-matched against the channel's tiers. one entry point,
  // so chat lines and the user card both get Kick badges
  renderBadges(badgesTag) {
    if (!badgesTag) return null;

    const fragment = document.createDocumentFragment();
    let foundAny = false;

    for (const pair of badgesTag.split(",")) {
      if (pair.startsWith("kick/")) {
        const [, type, countStr] = pair.split("/");
        const el = kickBadgeElement(type, Number(countStr) || 1, this._kickSubscriberBadges);
        if (el) {
          fragment.appendChild(el);
          foundAny = true;
        }
        continue;
      }
      const badge = this.badgeMap.get(pair);
      if (!badge) continue;
      foundAny = true;

      const img = document.createElement("img");
      img.className = "chat-badge";
      img.dataset.badge = pair; // "setID/version", lets a click on your own badge open the badge picker
      img.src = badge.url;
      img.alt = badge.title;
      img.title = badge.title;
      img.loading = "lazy";
      fragment.appendChild(img);
    }

    return foundAny ? fragment : null;
  },

  // Twitch sometimes sends colors too dark to read on the dark bg (or, on a light theme, too light). like official Twitch,
  // LIGHTEN hue-preserving until readable: to HSL, raise only lightness until WCAG contrast vs
  // the chat bg clears ~4.5:1, back to RGB. already-readable colors pass through
  // results are remembered (a chat has a few thousand distinct colors at most), so each is worked out once
  normalizeColor(hex) {
    const maxLum = lightThemeMaxLum();
    const key = maxLum == null ? hex : `${hex}|${_lightBgKey}`;
    const hit = _normalizedColors.get(key);
    if (hit !== undefined) return hit;
    const out = normalizeColorUncached(hex, maxLum);
    if (_normalizedColors.size >= 4096) _normalizedColors.clear();
    _normalizedColors.set(key, out);
    return out;
  },

  // re-render badges into any empty slot that has a non-empty badgesTag, for lines that rendered before badgeMap had the entries
  _backfillBadges() {
    const slots = this.container.querySelectorAll(".chat-badges-slot:empty[data-badges-tag]");
    for (const slot of slots) {
      const tag = slot.dataset.badgesTag;
      if (!tag) continue;
      const fragment = this.renderBadges(tag);
      if (fragment) slot.appendChild(fragment);
    }
  },

  async loadGlobalBadges() {
    // badges.twitch.tv fails with ERR_NAME_NOT_RESOLVED inside WebView2 (the tracking-prevention
    // issue that drove IRC to Rust), so the Rust command hits Helix instead, see ingestBadgeSets
    try {
      const json = await invoke("fetch_global_badges");
      this.ingestBadgeSets(JSON.parse(json));
      // USERSTATE and PRIVMSG badges arrive independently of this fetch, so messages landing first
      // (common on a fresh connect) rendered against an empty map with no retry, which showed as
      // badges not appearing. re-render the input badge and backfill rendered lines now
      if (this._ownBadgesTag) this._renderInputBadges(this._ownBadgesTag);
      this._backfillBadges();
    } catch (err) {
      console.warn("Failed to load global badges:", err);
    }
  },

  async loadChannelBadges(twitchUserId) {
    // same WebView2 issue as loadGlobalBadges, routed through Rust. Helix returns {"data":[]} with
    // 200 for channels with no custom badges. channel entries OVERWRITE the global keys, like Twitch
    try {
      const json = await invoke("fetch_channel_badges", { broadcasterId: twitchUserId });
      this.ingestBadgeSets(JSON.parse(json));
      // same re-render-after-load reasoning as loadGlobalBadges
      if (this._ownBadgesTag) this._renderInputBadges(this._ownBadgesTag);
      this._backfillBadges();
    } catch (err) {
      console.warn("Failed to load channel badges:", err);
    }
  },

  // via Rust, WebView2 can't reach api.twitch.tv
  async loadCheermotes(broadcasterId) {
    try {
      const json = await invoke("fetch_cheermotes", { broadcasterId });
      this.ingestCheermotes(JSON.parse(json));
    } catch (err) {
      // user may not be logged in, cheermotes just degrade to plain text (the bits total badge still shows)
      console.warn("Cheermotes unavailable:", err);
    }
  },

  // flatten the Helix badge response into "set_id/version" -> {url, title}, matching the IRC
  // `badges` tag so renderBadges is a plain Map.get. Helix shape: { data: [{ set_id, versions:
  // [{ id, image_url_2x, title }] }] }, version keyed by "id"
  ingestBadgeSets(data) {
    if (!Array.isArray(data?.data)) return;

    for (const set of data.data) {
      const setId = set.set_id;
      if (!setId || !Array.isArray(set.versions)) continue;
      for (const v of set.versions) {
        const url = v.image_url_2x || v.image_url_1x;
        if (!url) continue;
        this.badgeMap.set(`${setId}/${v.id}`, {
          url,
          title: v.title || setId,
        });
      }
    }
  },

  // the user's own badges into #chat-input-badge, left of the input. called whenever USERSTATE arrives
  _renderInputBadges(badgesTag) {
    const container = this._inputBadgeEl;
    if (!container) return;
    container.innerHTML = "";
    const fragment = badgesTag ? this.renderBadges(badgesTag) : null;
    if (fragment) container.appendChild(fragment);
    // clicking your badge(s) opens the badge picker (chat-badge-picker.js). wearing none on Twitch: show a
    // small placeholder so the picker is still reachable
    const canPick = !this._isKickChat && this.isLoggedIn && !!this.channel;
    container.classList.toggle("badge-pickable", canPick);
    container.title = canPick ? "Change your chat badges" : "";
    if (canPick && !fragment) {
      const ph = document.createElement("span");
      ph.className = "chat-input-badge-empty";
      ph.innerHTML = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z"/></svg>';
      container.appendChild(ph);
    }
  },

};
