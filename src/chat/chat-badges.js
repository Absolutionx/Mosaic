// badge and cheermote loading/rendering (global + per-channel). mixed onto TwitchChat (see ../chat.js)

import { invoke } from "@tauri-apps/api/core";
import { kickBadgeElement } from "./kick-badges.js";
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
      img.src = badge.url;
      img.alt = badge.title;
      img.title = badge.title;
      img.loading = "lazy";
      fragment.appendChild(img);
    }

    return foundAny ? fragment : null;
  },

  // Twitch sometimes sends colors too dark to read on the dark bg. like official Twitch,
  // LIGHTEN hue-preserving until readable: to HSL, raise only lightness until WCAG contrast vs
  // the chat bg clears ~4.5:1, back to RGB. already-readable colors pass through
  normalizeColor(hex) {
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
    // contrast vs the chat bg (~#0e0e10, lum ~0.004) at 4.5:1 needs lum >= this ((L+0.05)/(0.004+0.05)=4.5 -> L ~= 0.193)
    const MIN_LUM = 0.193;
    if (relLum(r, g, b) >= MIN_LUM) return hex;

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

    // walk lightness up until readable. 0.02 steps, can't loop forever since l clamps to 1 (white)
    let [nr, ng, nb] = [r, g, b];
    while (relLum(nr, ng, nb) < MIN_LUM && l < 1) {
      l = Math.min(1, l + 0.02);
      [nr, ng, nb] = hslToRgb(h, s, l);
    }
    const toHex = (c) => Math.round(c * 255).toString(16).padStart(2, "0");
    return `#${toHex(nr)}${toHex(ng)}${toHex(nb)}`;
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
    if (!badgesTag) return;
    const fragment = this.renderBadges(badgesTag);
    if (fragment) container.appendChild(fragment);
  },

};
