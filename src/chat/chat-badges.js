// Part of TwitchChat (see ../chat.js): badge and cheermote loading/rendering (global + per-channel). Mixin merged onto
// TwitchChat.prototype, so `this` is the chat instance; split by feature for readability.

import { invoke } from "@tauri-apps/api/core";
import { kickBadgeElement } from "./kick-badges.js";
export const chatBadgesMixin = {
  /** Parses the IRC `badges` tag ("broadcaster/1,subscriber/12") and renders an <img> per
   * badge in badgeMap; unknown badges are skipped, not shown broken. Kick "kick/{type}/{count}"
   * entries route to kick-badges.js, subscriber ones months-matched against the channel's
   * tiers. One entry point, so chat lines and the user card both get Kick badges. */
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
      img.src = badge.url;
      img.alt = badge.title;
      img.title = badge.title;
      img.loading = "lazy";
      fragment.appendChild(img);
    }

    return foundAny ? fragment : null;
  },

  /** Twitch sometimes sends colors too dark to read on the dark background. Like official
   * Twitch, LIGHTEN (hue-preserving) until readable: to HSL, raise only lightness until WCAG
   * contrast vs the chat bg clears ~4.5:1, back to RGB. Already-readable colors pass through. */
  normalizeColor(hex) {
    if (!hex || !/^#[0-9a-fA-F]{6}$/.test(hex)) return "#9147ff";
    const r = parseInt(hex.slice(1, 3), 16) / 255;
    const g = parseInt(hex.slice(3, 5), 16) / 255;
    const b = parseInt(hex.slice(5, 7), 16) / 255;

    // WCAG relative luminance (gamma-corrected, not the 0.299/0.587/0.114 video-luma
    // formula, which under-weights dark saturated blues).
    const relLum = (rr, gg, bb) => {
      const lin = (c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
      return 0.2126 * lin(rr) + 0.7152 * lin(gg) + 0.0722 * lin(bb);
    };
    // Contrast vs the chat bg (~#0e0e10, lum ~0.004) at 4.5:1 needs lum >= this
    // ((L + 0.05)/(0.004 + 0.05) = 4.5 -> L ~= 0.193).
    const MIN_LUM = 0.193;
    if (relLum(r, g, b) >= MIN_LUM) return hex;

    // RGB -> HSL
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

    // HSL -> RGB
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

    // Walk lightness up until readable. 0.02 steps; can't loop forever since l clamps to 1
    // (white), above any floor.
    let [nr, ng, nb] = [r, g, b];
    while (relLum(nr, ng, nb) < MIN_LUM && l < 1) {
      l = Math.min(1, l + 0.02);
      [nr, ng, nb] = hslToRgb(h, s, l);
    }
    const toHex = (c) => Math.round(c * 255).toString(16).padStart(2, "0");
    return `#${toHex(nr)}${toHex(ng)}${toHex(nb)}`;
  },

  /** Re-renders badges into any empty .chat-badges-slot that has a non-empty badgesTag -
   * lines that rendered before badgeMap had the entries. Scoped to all lines. */
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
    // badges.twitch.tv fails with ERR_NAME_NOT_RESOLVED inside WebView2 (the
    // tracking-prevention issue that drove IRC to Rust). The Rust command hits Helix - see
    // ingestBadgeSets.
    try {
      const json = await invoke("fetch_global_badges");
      this.ingestBadgeSets(JSON.parse(json));
      // Re-render the input badge AND backfill rendered lines now that badgeMap has entries:
      // USERSTATE and PRIVMSG badges arrive independently of this fetch, so messages landing
      // first (common on a fresh connect) previously rendered against an empty map with no
      // retry - reported as badges not showing.
      if (this._ownBadgesTag) this._renderInputBadges(this._ownBadgesTag);
      this._backfillBadges();
    } catch (err) {
      console.warn("Failed to load global badges:", err);
    }
  },

  async loadChannelBadges(twitchUserId) {
    // Same WebView2 issue as loadGlobalBadges - routed through Rust. Helix returns
    // {"data":[]} with 200 for channels with no custom badges. Channel entries OVERWRITE the
    // global keys, matching Twitch.
    try {
      const json = await invoke("fetch_channel_badges", { broadcasterId: twitchUserId });
      this.ingestBadgeSets(JSON.parse(json));
      // Same re-render-after-load reasoning as loadGlobalBadges.
      if (this._ownBadgesTag) this._renderInputBadges(this._ownBadgesTag);
      this._backfillBadges();
    } catch (err) {
      console.warn("Failed to load channel badges:", err);
    }
  },

  /** Fetches cheermotes for this channel via Rust (WebView2 can't reach api.twitch.tv). */
  async loadCheermotes(broadcasterId) {
    try {
      const json = await invoke("fetch_cheermotes", { broadcasterId });
      this.ingestCheermotes(JSON.parse(json));
    } catch (err) {
      // Silently ignore - user may not be logged in; cheermotes degrade to plain text (the
      // bits total badge still shows).
      console.warn("Cheermotes unavailable:", err);
    }
  },

  /** Normalizes the Helix badge response into flat "set_id/version" -> {url, title} in
   * this.badgeMap, matching the IRC `badges` tag so renderBadges is a plain Map.get. Helix
   * shape: { data: [{ set_id, versions: [{ id, image_url_2x, title }] }] } - top-level "data",
   * version keyed by "id". */
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

  /** Renders the user's own badges into #chat-input-badge, left of the input. Called
   * whenever USERSTATE arrives. */
  _renderInputBadges(badgesTag) {
    const container = this._inputBadgeEl;
    if (!container) return;
    container.innerHTML = "";
    if (!badgesTag) return;
    const fragment = this.renderBadges(badgesTag);
    if (fragment) container.appendChild(fragment);
  },

};
