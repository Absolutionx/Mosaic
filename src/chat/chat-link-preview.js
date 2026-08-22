// Part of TwitchChat (see ../chat.js): chat link handling - URL detection/normalization and the hover preview popup. Mixin merged onto
// TwitchChat.prototype, so `this` is the chat instance; split by feature for readability.
// Hovering waits LINK_PREVIEW_HOVER_DELAY_MS before fetching (chat scrolls fast; firing on
// every mouseenter would be wasteful and flickery).
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { normalizeUrl, LINK_PREVIEW_HOVER_DELAY_MS } from "./shared.js";

export const chatLinkPreviewMixin = {
  /** Builds a clickable <a> for a chat URL, wired the "real href, intercept the click for
   * openUrl()" way (target="_blank" does nothing in a Tauri webview). Also attaches the
   * hover-preview handlers. */
  _createChatLink(word) {
    const url = normalizeUrl(word);
    const a = document.createElement("a");
    a.href = url;
    a.textContent = word;
    a.className = "chat-link";
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.addEventListener("click", (e) => {
      e.preventDefault();
      openUrl(url).catch((err) => {
        console.error("Failed to open chat link in browser:", err);
      });
    });
    a.addEventListener("mouseenter", () => this._scheduleLinkPreview(a, url));
    a.addEventListener("mouseleave", () => this._cancelLinkPreview());
    return a;
  },

  /** Begins (or restarts) the hover-preview flow, cancelling any in-flight timer/request
   * first so moving across links only fetches the one settled on. */
  _scheduleLinkPreview(linkEl, url) {
    this._cancelLinkPreview();
    const myToken = ++this._linkPreviewToken;

    const cached = this._linkPreviewCache.get(url);
    if (cached !== undefined) {
      // Respect the hover delay even on a cache hit - an instant popup reads as jumpy while
      // skimming.
      this._linkPreviewTimer = setTimeout(() => {
        if (myToken !== this._linkPreviewToken) return; // moved on already
        if (cached) this._showLinkPreviewPopup(linkEl, cached);
      }, LINK_PREVIEW_HOVER_DELAY_MS);
      return;
    }

    this._linkPreviewTimer = setTimeout(async () => {
      if (myToken !== this._linkPreviewToken) return; // moved on already
      let preview;
      try {
        preview = await invoke("fetch_link_preview", { url });
      } catch (err) {
        console.error("Link preview fetch failed:", url, err);
        preview = null;
      }
      // A preview with no title/description/image isn't worth a popup - cache null so an
      // empty/errored link isn't refetched on every hover.
      const hasContent = preview && (preview.title || preview.description || preview.image);
      this._linkPreviewCache.set(url, hasContent ? preview : null);
      if (myToken !== this._linkPreviewToken) return; // moved on while fetching
      if (hasContent) this._showLinkPreviewPopup(linkEl, preview);
    }, LINK_PREVIEW_HOVER_DELAY_MS);
  },

  /** Cancels any pending timer and hides the popup. Called on mouseleave and at each new
   * hover, so a stale timer can't pop it open after the cursor moved. */
  _cancelLinkPreview() {
    ++this._linkPreviewToken;
    if (this._linkPreviewTimer) {
      clearTimeout(this._linkPreviewTimer);
      this._linkPreviewTimer = null;
    }
    this._hideLinkPreviewPopup();
  },

  _showLinkPreviewPopup(linkEl, preview) {
    const popup = this._linkPreviewPopup;
    popup.innerHTML = "";

    if (preview.image) {
      const img = document.createElement("img");
      img.className = "link-preview-image";
      img.src = preview.image;
      img.alt = "";
      img.loading = "lazy";
      // If the image fails, drop just it rather than leaving a broken-image icon.
      img.addEventListener("error", () => img.remove());
      popup.appendChild(img);
    }

    const body = document.createElement("div");
    body.className = "link-preview-body";

    if (preview.site_name) {
      const site = document.createElement("div");
      site.className = "link-preview-site";
      site.textContent = preview.site_name;
      body.appendChild(site);
    }
    if (preview.title) {
      const title = document.createElement("div");
      title.className = "link-preview-title";
      title.textContent = preview.title;
      body.appendChild(title);
    }
    if (preview.description) {
      const desc = document.createElement("div");
      desc.className = "link-preview-description";
      desc.textContent = preview.description;
      body.appendChild(desc);
    }
    popup.appendChild(body);

    popup.style.display = "block";
    this._positionLinkPreviewPopup(linkEl);
  },

  _hideLinkPreviewPopup() {
    this._linkPreviewPopup.style.display = "none";
  },

  /** Positions the popup above the hovered link (same fixed-from-a-rect approach as the
   * emote popup), clamped horizontally so it can't run off the right edge. */
  _positionLinkPreviewPopup(linkEl) {
    const rect = linkEl.getBoundingClientRect();
    const popup = this._linkPreviewPopup;
    const popupWidth = popup.offsetWidth;
    const popupHeight = popup.offsetHeight;

    let left = rect.left;
    const maxLeft = window.innerWidth - popupWidth - 8;
    if (left > maxLeft) left = Math.max(8, maxLeft);

    popup.style.left = `${left}px`;
    // Prefer above the link; fall back to below if there's no room (a link in the first
    // lines).
    if (rect.top - popupHeight - 8 >= 0) {
      popup.style.top = `${rect.top - popupHeight - 8}px`;
    } else {
      popup.style.top = `${rect.bottom + 8}px`;
    }
  },

};
