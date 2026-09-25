// a channel's past broadcasts in a grid, played via the streamlink relay. get_videos_for_login
// resolves login -> user_id internally; Helix thumbnail URLs use %{width}x%{height}
// placeholders we substitute before use

import { invoke } from "@tauri-apps/api/core";
import { fetchVodChapters } from "./chapters.js";
import { relativeDate } from "./format.js";

function resolveThumbnailUrl(url, width = 440, height = 248) {
  return url
    .replace("%{width}", String(width))
    .replace("%{height}", String(height));
}

function parseDuration(dur) {
  const h = (dur.match(/(\d+)h/) || [])[1] | 0;
  const m = (dur.match(/(\d+)m/) || [])[1] | 0;
  const s = (dur.match(/(\d+)s/) || [])[1] | 0;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${m}:${String(s).padStart(2, "0")}`;
}

function parseDurationToSeconds(dur) {
  const h = (dur.match(/(\d+)h/) || [])[1] | 0;
  const m = (dur.match(/(\d+)m/) || [])[1] | 0;
  const s = (dur.match(/(\d+)s/) || [])[1] | 0;
  return h * 3600 + m * 60 + s;
}

export class VodsPage {
  constructor({ containerEl, videoFrameEl, onVodSelect }) {
    this.containerEl = containerEl;
    this.videoFrameEl = videoFrameEl;
    this.onVodSelect = onVodSelect || (() => {});
    this.currentChannel = null;
    this.isKick = false;
  }

  // kick=true fetches via kick_channel_videos and skips the chapter pass (Twitch GQL only);
  // everything else renders the same
  async show(channel, { kick = false } = {}) {
    this.currentChannel = channel;
    this.isKick = kick;
    this.containerEl.style.display = "block";
    if (this.videoFrameEl) this.videoFrameEl.style.display = "none";

    this.containerEl.innerHTML = `
      <div class="vods-header">
        <span class="vods-channel-name">${this._esc(channel)}</span>
        <span class="vods-header-label">Past Broadcasts</span>
      </div>
      <div class="home-section-title vods-loading">Loading videos…</div>`;

    let vods;
    let progressByVodId = {};
    try {
      const [vodsResult, progressResult] = await Promise.allSettled([
        kick
          ? invoke("kick_channel_videos", { slug: channel })
          : invoke("get_videos_for_login", { login: channel }),
        invoke("get_all_vod_progress"),
      ]);
      if (vodsResult.status === "rejected") throw vodsResult.reason;
      vods = JSON.parse(vodsResult.value);
      if (progressResult.status === "fulfilled") {
        progressByVodId = progressResult.value;
      } else {
        console.warn("Failed to load VOD resume progress:", progressResult.reason);
      }
    } catch (err) {
      this.containerEl.innerHTML = `
        <div class="vods-header">
          <span class="vods-channel-name">${this._esc(channel)}</span>
          <span class="vods-header-label">Past Broadcasts</span>
        </div>
        <div class="home-section-title">Failed to load videos: ${this._esc(String(err))}</div>`;
      return;
    }

    // user navigated away while the fetch was in flight
    if (this.currentChannel !== channel) return;

    this.containerEl.innerHTML = "";

    const header = document.createElement("div");
    header.className = "vods-header";
    header.innerHTML = `
      <span class="vods-channel-name">${this._esc(channel)}</span>
      <span class="vods-header-label">Past Broadcasts</span>`;
    this.containerEl.appendChild(header);

    if (vods.length === 0) {
      const empty = document.createElement("div");
      empty.className = "home-section-title";
      empty.textContent = "No past broadcasts found.";
      this.containerEl.appendChild(empty);
      return;
    }

    const grid = document.createElement("div");
    grid.className = "home-grid vods-grid";
    const cardRefs = [];
    for (const vod of vods) {
      const card = this._buildVodCard(vod, progressByVodId[vod.id]);
      grid.appendChild(card);
      const totalSeconds = vod.duration ? parseDurationToSeconds(vod.duration) : 0;
      cardRefs.push({ vodId: vod.id, totalSeconds, card, meta: this._vodMeta(vod) });
    }
    this.containerEl.appendChild(grid);

    // fire chapter fetches for every VOD in parallel, badges land as they resolve so the grid
    // is usable immediately. Twitch-only
    if (!kick) {
      this._injectChapterBadges(cardRefs, channel);
    }
  }

  hide() {
    this.containerEl.style.display = "none";
    if (this.videoFrameEl) this.videoFrameEl.style.display = "";
    this.currentChannel = null;
  }

  // display metadata recorded alongside saved progress, used by Home's "Continue where you left off"
  _vodMeta(vod) {
    return {
      title: vod.title || "",
      channelName: vod.user_name || this.currentChannel || "",
      channelLogin: vod.user_login || this.currentChannel || "",
      thumbnailUrl: vod.thumbnail_url || "",
      createdAt: vod.created_at || "",
    };
  }

  _buildVodCard(vod, progress) {
    const card = document.createElement("button");
    card.className = "home-grid-card";
    const totalSeconds = vod.duration ? parseDurationToSeconds(vod.duration) : 0;
    card.addEventListener("click", () => this.onVodSelect(vod.id, totalSeconds, this.currentChannel, undefined, this._vodMeta(vod)));

    const thumbWrap = document.createElement("div");
    thumbWrap.className = "home-grid-thumb-wrap";

    const thumb = document.createElement("img");
    thumb.className = "home-grid-thumb";
    thumb.alt = "";
    const thumbUrl = vod.thumbnail_url || "";
    // Helix hands back a "_404_processing" URL for VODs still transcoding, treat as no
    // thumbnail rather than firing a 403
    const isProcessing = thumbUrl.includes("404_processing") || !thumbUrl;
    // no thumbnail (still recording/processing, or it failed to load): show a themed placeholder. the old
    // fallback set src="" which Chromium draws as a broken image (a light outline around an empty box)
    const markNoThumb = () => {
      thumb.onerror = null;
      thumb.removeAttribute("src");
      thumb.classList.add("no-thumb");
      thumbWrap.classList.add("vod-thumb-missing");
    };
    if (isProcessing) {
      markNoThumb();
    } else {
      thumb.src = resolveThumbnailUrl(thumbUrl);
      thumb.onerror = markNoThumb;
    }
    thumbWrap.appendChild(thumb);

    if (vod.duration) {
      const dur = document.createElement("span");
      dur.className = "home-grid-viewers vod-duration";
      dur.textContent = parseDuration(vod.duration);
      thumbWrap.appendChild(dur);
    }

    if (typeof vod.view_count === "number") {
      const views = document.createElement("span");
      views.className = "vod-views-badge";
      views.textContent = `${vod.view_count.toLocaleString()} views`;
      thumbWrap.appendChild(views);
    }

    // same "essentially finished" threshold as main.js's resume logic, so a card never shows
    // a resume bar for a VOD that would restart from 0
    if (
      progress &&
      progress.total_secs > 0 &&
      progress.position_secs < progress.total_secs - 30
    ) {
      const track = document.createElement("div");
      track.className = "vod-resume-track";
      const fill = document.createElement("div");
      fill.className = "vod-resume-fill";
      const pct = Math.min(100, Math.max(0, (progress.position_secs / progress.total_secs) * 100));
      fill.style.width = `${pct}%`;
      track.appendChild(fill);
      thumbWrap.appendChild(track);
    }

    card.appendChild(thumbWrap);

    // no avatar, every VOD here is the same channel
    const meta = document.createElement("div");
    meta.className = "home-grid-meta vods-meta";

    const text = document.createElement("div");
    text.className = "home-grid-text";

    const title = document.createElement("div");
    title.className = "home-grid-title";
    title.textContent = vod.title || "(untitled)";
    title.title = vod.title || "";

    const date = document.createElement("div");
    date.className = "home-grid-game"; // reuse the muted subtitle style
    date.textContent = vod.created_at ? relativeDate(vod.created_at) : "";

    text.appendChild(title);
    text.appendChild(date);
    meta.appendChild(text);
    card.appendChild(meta);

    return card;
  }

  async _injectChapterBadges(cardRefs, channel) {
    // one active popup at a time
    let activePopup = null;
    const closePopup = () => { activePopup?.remove(); activePopup = null; };
    document.addEventListener("click", closePopup, { capture: true, once: false });

    await Promise.all(cardRefs.map(async ({ vodId, card, totalSeconds, meta: vodMeta }) => {
      try {
        const chapters = await fetchVodChapters(vodId);
        if (this.currentChannel !== channel) return;
        if (!chapters.length) return;

        const meta = card.querySelector(".vods-meta");
        if (!meta) return;

        const badge = document.createElement("button");
        badge.className = "vod-chapters-badge";
        badge.type = "button";
        badge.innerHTML =
          `<svg viewBox="0 0 20 20" width="11" height="11" fill="currentColor" style="flex-shrink:0">` +
          `<circle cx="3" cy="4.5" r="1.4"/><rect x="6" y="3.5" width="11" height="2" rx="1"/>` +
          `<circle cx="3" cy="10"  r="1.4"/><rect x="6" y="9"   width="11" height="2" rx="1"/>` +
          `<circle cx="3" cy="15.5" r="1.4"/><rect x="6" y="14.5" width="11" height="2" rx="1"/>` +
          `</svg> Chapters ${chapters.length}`;

        badge.addEventListener("click", (e) => {
          e.stopPropagation(); // don't open the VOD
          if (activePopup) { closePopup(); return; }

          const popup = document.createElement("div");
          popup.className = "vod-chapters-popup";
          chapters.forEach((ch) => {
            const item = document.createElement("button");
            item.className = "vod-chapters-popup-item";
            const h  = Math.floor(ch.positionSec / 3600);
            const m  = Math.floor((ch.positionSec % 3600) / 60);
            const s  = Math.floor(ch.positionSec % 60);
            const ts = h > 0
              ? `${h}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`
              : `${m}:${String(s).padStart(2,"0")}`;
            // built with textContent: chapter titles come from Twitch and must never be parsed as markup
            const timeEl = document.createElement("span");
            timeEl.className = "vod-chapters-popup-time";
            timeEl.textContent = ts;
            const titleEl = document.createElement("span");
            titleEl.className = "vod-chapters-popup-title";
            titleEl.textContent = ch.title;
            item.append(timeEl, titleEl);
            item.addEventListener("click", (ev) => {
              ev.stopPropagation();
              closePopup();
              this.onVodSelect(vodId, totalSeconds, this.currentChannel, Math.floor(ch.positionSec), vodMeta);
            });
            popup.appendChild(item);
          });

          document.body.appendChild(popup);
          activePopup = popup;

          const r = badge.getBoundingClientRect();
          popup.style.left   = `${r.left}px`;
          popup.style.bottom = `${window.innerHeight - r.top + 6}px`;
          popup.style.top    = "";
          // if it would run off the right edge, shift left
          const pw = popup.getBoundingClientRect().width;
          if (r.left + pw > window.innerWidth - 8) {
            popup.style.left = `${window.innerWidth - pw - 8}px`;
          }
        });

        meta.appendChild(badge);
      } catch (err) {
        console.warn(`[chapters] failed for VOD ${vodId}:`, err);
      }
    }));
  }

  _esc(str) {
    return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
}
