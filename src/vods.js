// a channel's past broadcasts in a grid, played via the streamlink relay. get_videos_for_login
// resolves login -> user_id internally; Helix thumbnail URLs use %{width}x%{height}
// placeholders we substitute before use

import { invoke } from "@tauri-apps/api/core";
import { fetchVodChapters } from "./chapters.js";
import { relativeDate } from "./format.js";
import { openClipPlayer } from "./chat/chat-clips.js";
import { openDownloadDialog } from "./vod-downloads.js";

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
  // tab: "videos" (past broadcasts) or "clips" (Twitch only). the header's tabs switch between them without
  // reloading the page
  async show(channel, { kick = false, tab } = {}) {
    // no tab asked for: coming back to the same channel (e.g. after watching one of its VODs) keeps the
    // tab you were on; a different channel starts on Past broadcasts
    const sameChannel = channel === this.currentChannel;
    this.currentChannel = channel;
    this.isKick = kick;
    // openNextOn: a one-shot request (the command palette's "Clips of …") for the next show()
    const requested = tab || this.openNextOn;
    this.openNextOn = null;
    this.tab = kick ? "videos" : (requested || (sameChannel && this.tab) || "videos");
    this.containerEl.style.display = "block";
    if (this.videoFrameEl) this.videoFrameEl.style.display = "none";

    this.containerEl.innerHTML = "";
    const header = document.createElement("div");
    header.className = "vods-header";
    const name = document.createElement("span");
    name.className = "vods-channel-name";
    name.textContent = channel;
    const tabs = document.createElement("div");
    tabs.className = "vods-tabs";
    const tabDefs = kick ? [["videos", "Past broadcasts"]] : [["videos", "Past broadcasts"], ["clips", "Clips"]];
    for (const [id, label] of tabDefs) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "vods-tab" + (id === this.tab ? " active" : "");
      b.dataset.tab = id;
      b.textContent = label;
      b.addEventListener("click", () => {
        if (this.tab === id) return;
        this.tab = id;
        tabs.querySelectorAll(".vods-tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === id));
        this._renderTab(channel);
      });
      tabs.appendChild(b);
    }
    header.append(name, tabs);
    this.bodyEl = document.createElement("div");
    this.bodyEl.className = "vods-body";
    this.containerEl.append(header, this.bodyEl);
    this._renderTab(channel);
  }

  _renderTab(channel) {
    if (this.tab === "clips") this._renderClips(channel);
    else this._renderVideos(channel, this.isKick);
  }

  // ---- Past broadcasts ----
  async _renderVideos(channel, kick) {
    const body = this.bodyEl;
    body.innerHTML = `<div class="home-section-title vods-loading">Loading videos…</div>`;

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
      if (this.bodyEl !== body || this.tab !== "videos") return;
      body.innerHTML = "";
      const msg = document.createElement("div");
      msg.className = "home-section-title";
      msg.textContent = `Failed to load videos: ${String(err)}`;
      body.appendChild(msg);
      return;
    }

    // user navigated away / switched tab while the fetch was in flight
    if (this.currentChannel !== channel || this.bodyEl !== body || this.tab !== "videos") return;
    body.innerHTML = "";

    if (vods.length === 0) {
      const empty = document.createElement("div");
      empty.className = "home-section-title";
      empty.textContent = "No past broadcasts found.";
      body.appendChild(empty);
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
    body.appendChild(grid);

    // fire chapter fetches for every VOD in parallel, badges land as they resolve so the grid
    // is usable immediately. Twitch-only
    if (!kick) {
      this._injectChapterBadges(cardRefs, channel);
    }
  }

  // ---- Clips (Twitch) ----
  // most-viewed clips in a time range (Twitch's own default is the last 7 days), 24 at a time with Load more.
  // clicking one plays it in the in-app clip player (the same one chat clip cards use)
  _renderClips(channel) {
    const body = this.bodyEl;
    body.innerHTML = "";
    if (!this.clipPeriod) this.clipPeriod = "week";
    const bar = document.createElement("div");
    bar.className = "vods-clip-periods";
    const grid = document.createElement("div");
    grid.className = "home-grid vods-grid";
    const status = document.createElement("div");
    status.className = "home-section-title vods-loading";
    const more = document.createElement("button");
    more.type = "button";
    more.className = "vods-load-more";
    more.textContent = "Load more";
    more.style.display = "none";
    for (const [id, label] of [["day", "Last 24 hours"], ["week", "Last 7 days"], ["month", "Last 30 days"], ["all", "All time"]]) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "vods-clip-period" + (id === this.clipPeriod ? " active" : "");
      b.textContent = label;
      b.addEventListener("click", () => {
        if (this.clipPeriod === id) return;
        this.clipPeriod = id;
        this._renderClips(channel);
      });
      bar.appendChild(b);
    }
    body.append(bar, status, grid, more);

    // a request only lands if it's still the current channel, tab, period and list
    const req = (this._clipsReq = (this._clipsReq || 0) + 1);
    const period = this.clipPeriod;
    let cursor = "";
    const load = async () => {
      more.disabled = true;
      more.textContent = "Loading…";
      if (!grid.children.length) status.textContent = "Loading clips…";
      let res;
      try {
        res = await invoke("get_channel_clips", { login: channel, period, cursor });
      } catch (err) {
        if (req !== this._clipsReq) return;
        status.textContent = `Failed to load clips: ${String(err)}`;
        more.disabled = false;
        more.textContent = "Load more";
        return;
      }
      if (req !== this._clipsReq || this.currentChannel !== channel || this.tab !== "clips") return;
      for (const clip of res.clips || []) grid.appendChild(this._buildClipCard(clip));
      cursor = res.cursor || "";
      status.textContent = grid.children.length ? "" : "No clips in this time range.";
      status.style.display = grid.children.length ? "none" : "";
      more.style.display = cursor ? "" : "none";
      more.disabled = false;
      more.textContent = "Load more";
    };
    more.addEventListener("click", load);
    load();
  }

  _buildClipCard(clip) {
    const card = document.createElement("button");
    card.className = "home-grid-card clip-grid-card";
    card.addEventListener("click", () => openClipPlayer(clip));

    const thumbWrap = document.createElement("div");
    thumbWrap.className = "home-grid-thumb-wrap";
    const thumb = document.createElement("img");
    thumb.className = "home-grid-thumb";
    thumb.alt = "";
    thumb.loading = "lazy";
    const markNoThumb = () => {
      thumb.onerror = null;
      thumb.removeAttribute("src");
      thumb.classList.add("no-thumb");
      thumbWrap.classList.add("vod-thumb-missing");
    };
    if (clip.thumbnail) { thumb.src = clip.thumbnail; thumb.onerror = markNoThumb; } else markNoThumb();
    thumbWrap.appendChild(thumb);

    const secs = Math.round(Number(clip.duration) || 0);
    if (secs > 0) {
      const dur = document.createElement("span");
      dur.className = "home-grid-viewers vod-duration";
      dur.textContent = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
      thumbWrap.appendChild(dur);
    }
    if (typeof clip.views === "number") {
      const views = document.createElement("span");
      views.className = "vod-views-badge";
      views.textContent = `${clip.views.toLocaleString()} views`;
      thumbWrap.appendChild(views);
    }
    card.appendChild(thumbWrap);

    const meta = document.createElement("div");
    meta.className = "home-grid-meta vods-meta";
    const text = document.createElement("div");
    text.className = "home-grid-text";
    const title = document.createElement("div");
    title.className = "home-grid-title";
    title.textContent = clip.title || "(untitled)";
    title.title = clip.title || "";
    const sub = document.createElement("div");
    sub.className = "home-grid-game";
    sub.textContent = [clip.creator ? `Clipped by ${clip.creator}` : "", clip.created_at ? relativeDate(clip.created_at) : ""].filter(Boolean).join(" · ");
    text.append(title, sub);
    meta.appendChild(text);
    card.appendChild(meta);
    return card;
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
    // download (Twitch VODs). a span, not a button: the card itself is a button, and nested buttons are invalid
    let downloadBtn = null;
    if (!this.isKick) {
      const dl = document.createElement("span");
      dl.className = "vod-card-download";
      dl.setAttribute("role", "button");
      dl.tabIndex = 0;
      dl.title = "Download";
      dl.innerHTML = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11"/><path d="m7 10 5 5 5-5"/><path d="M5 20h14"/></svg>';
      const open = (e) => {
        e.preventDefault();
        e.stopPropagation(); // don't also open the VOD
        const meta = this._vodMeta(vod);
        openDownloadDialog({ videoId: vod.id, title: vod.title || "", channel: meta.channelName || this.currentChannel, createdAt: vod.created_at || "", durationSecs: totalSeconds });
      };
      dl.addEventListener("click", open);
      dl.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") open(e); });
      downloadBtn = dl;
    }

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

    if (downloadBtn) thumbWrap.appendChild(downloadBtn);
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
    // one page-wide listener for the whole VODs page, replaced on each load. it used to be added on every
    // load and never removed, each copy keeping that load's cards alive
    if (this._closeChapterPopup) document.removeEventListener("click", this._closeChapterPopup, { capture: true });
    this._closeChapterPopup = closePopup;
    document.addEventListener("click", closePopup, { capture: true });

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
