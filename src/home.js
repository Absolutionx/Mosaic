import { getSetting } from "./settings.js";
// home feed (in #video-column when nothing plays): carousel, recommended grid, category
// rows, all via Rust-proxied Helix. Helix has no recommendation/genre endpoint, so this
// fakes it with top-viewed streams and a hand-picked RPG list

import { invoke } from "@tauri-apps/api/core";
import { feedInvoke, isKick } from "./platform.js";
import { streamHasDropsEnabled } from "./drops.js";
import { filterHidden, isHidden, onHiddenChange, showHideChannelMenu } from "./hidden-channels.js";
import { relativeDate } from "./format.js";

const REFRESH_INTERVAL_MS = 60_000;

// seconds -> "1:02:03" / "12:34"
function fmtClock(secs) {
  const t = Math.max(0, Math.floor(secs || 0));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}
// the fetches return far more (Twitch 100, Kick 40, category rows hundreds), capped here
// just to fill out the page
const CAROUSEL_SIZE = 15;
const GRID_COLLAPSED_COUNT = 8;
// "Continue where you left off": two rows of five before "Show more" (fixed 5-column grid, see CSS)
const CONTINUE_COLLAPSED_COUNT = 10;
const KICK_CATEGORY_ROW_COUNT = 6;
const RPG_GAME_NAMES = [
  "Path of Exile 2",
  "Elden Ring",
  "Baldur's Gate 3",
  "Final Fantasy XIV Online",
  "Diablo IV",
  "Genshin Impact",
];

export class HomeFeed {
  constructor({ containerEl, onChannelSelect, onVodResume, getLiveFavorites, getLiveLogins, onOpenMultiView }) {
    this.containerEl = containerEl;
    this.onChannelSelect = onChannelSelect || (() => {});
    this.onVodResume = onVodResume || (() => {});
    // MultiView launcher (top of Home, replaces the carousel when favorites are live), see buildMultiViewLauncher
    this.getLiveFavorites = getLiveFavorites || (() => []);
    this.getLiveLogins = getLiveLogins || (() => new Set());
    this.onOpenMultiView = onOpenMultiView || (() => {});
    this._mvExcluded = new Set();   // favorites unticked in the launcher (kept across refreshes)
    this._mvAudio = null;           // login whose sound plays (and is the big tile in Focus layout)
    this._mvLayout = (() => { try { return localStorage.getItem("homeMvLayout") === "spotlight" ? "spotlight" : "grid"; } catch { return "grid"; } })();
    this.continueItems = []; // "Continue where you left off" (partially watched VODs), see _loadContinue
    this.avatars = new Map();
    this.carouselIndex = 0;
    this.gridExpanded = false;
    this.refreshTimer = null;
    this.loaded = false;
    // #video-frame has its own solid black background, separate from its placeholder, so
    // hiding only the placeholder left a black box over the feed. hide/show them together
    this.videoFrameEl = document.getElementById("video-frame");
    // re-render when a channel is hidden/unhidden so it drops out of / returns to the feed live
    window.addEventListener("mosaic:live-favorites-changed", () => {
      if (this.loaded && this.topLive && this.containerEl.style.display !== "none") this._refreshLauncher();
    });
    onHiddenChange(() => {
      if (this.loaded && this.containerEl.style.display !== "none") this._loadContinue().then(() => this.render());
    });
  }

  show() {
    this.containerEl.style.display = "block";
    if (this.videoFrameEl) this.videoFrameEl.style.display = "none";
    // progress changes while a VOD plays, so reload the continue row on every visit (cheap: one local
    // file read), then re-render if the rest of the feed is already loaded
    this._loadContinue().then(() => { if (this.loaded && this.topLive) this.render(); });
    if (!this.loaded) {
      this.loaded = true;
      this.refresh();
      if (!this.refreshTimer) {
        this.refreshTimer = setInterval(() => this.refresh(), REFRESH_INTERVAL_MS);
      }
    }
  }

  hide() {
    this.containerEl.style.display = "none";
    if (this.videoFrameEl) this.videoFrameEl.style.display = "";
  }

  // refetch now if the feed is showing, else mark stale for the next show()
  reloadForPlatformChange() {
    this.topLive = [];
    this.extraRows = [];
    if (this.containerEl.style.display !== "none" && this.loaded) {
      this.refresh();
    } else {
      this.loaded = false;
    }
  }

  async refresh() {
    // rows below the grid are platform-shaped: Twitch keeps its hand-picked RPGs row (exact
    // Helix names), Kick builds rows from whatever's biggest now (a Twitch game list resolved
    // to nothing on Kick)
    const [topLive, extraRows] = await Promise.all([
      this.fetchTopLive(),
      isKick()
        ? this.fetchKickCategoryRows()
        : this.fetchRpgs().then((rpgs) =>
            rpgs.length > 0 ? [{ key: "rpgs", title: "RPGs", streams: rpgs }] : []
          ),
    ]);
    await this.hydrateAvatars([
      ...topLive,
      ...extraRows.flatMap((r) => r.streams),
    ]);
    this.topLive = topLive;
    this.extraRows = extraRows;
    await this._loadContinue();
    this.render();
  }

  // Partially-watched VODs for "Continue where you left off", from the local progress store. Only
  // entries that have display metadata (recorded when a VOD is opened from a VOD card), that were
  // watched past the first 30s, and aren't basically finished. Most recent first, capped at 30.
  async _loadContinue() {
    // one-time (per session) background backfill of title/thumbnail for older Twitch VODs watched
    // before that metadata was recorded; re-renders this row when it fills anything in. needs a login,
    // so on failure (e.g. not logged in yet) it's retried on the next Home refresh
    if (!this._backfillStarted) {
      this._backfillStarted = true;
      invoke("backfill_vod_progress_metadata")
        .then(async (filled) => {
          if (filled > 0) {
            await this._loadContinue();
            if (this.loaded && this.topLive && this.containerEl.style.display !== "none") this.render();
          }
        })
        .catch(() => { this._backfillStarted = false; });
    }
    let all = {};
    try { all = (await invoke("get_all_vod_progress")) || {}; } catch { this.continueItems = []; return; }
    const END_THRESHOLD = 30; // matches main.js VOD_RESUME_END_THRESHOLD_SECS: within 30s of the end = finished
    this.continueItems = Object.entries(all)
      .map(([videoId, e]) => ({
        videoId,
        positionSecs: e.position_secs || 0,
        totalSecs: e.total_secs || 0,
        updatedAt: e.updated_at || 0,
        title: e.title || "",
        channelName: e.channel_name || e.channel_login || "",
        channelLogin: e.channel_login || "",
        thumbnailUrl: e.thumbnail_url || "",
        createdAt: e.created_at || "",
        dismissed: !!e.dismissed,
      }))
      .filter((it) =>
        !it.dismissed &&
        it.title &&
        it.totalSecs > 0 &&
        it.positionSecs >= 30 &&
        it.positionSecs < it.totalSecs - END_THRESHOLD &&
        !isHidden(it.channelLogin))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 30); // 10 shown (2 rows of 5), the rest behind "Show more"
  }

  // same wrapping grid + "Show more" toggle as the other Home sections (was a horizontal scroller)
  buildContinueSection() {
    const key = "grid-expanded-continue";
    const items = this.continueItems;
    const section = document.createElement("div");
    section.className = "home-section home-continue";
    const heading = document.createElement("div");
    heading.className = "home-section-title";
    heading.textContent = "Continue where you left off";
    section.appendChild(heading);

    const grid = document.createElement("div");
    grid.className = "home-grid home-continue-grid";
    const expanded = this._expandedSections?.has(key);
    const visible = expanded ? items : items.slice(0, CONTINUE_COLLAPSED_COUNT);
    for (const it of visible) grid.appendChild(this.buildContinueCard(it));
    section.appendChild(grid);

    if (items.length > CONTINUE_COLLAPSED_COUNT) {
      const showMore = document.createElement("button");
      showMore.className = "home-show-more";
      showMore.innerHTML = expanded
        ? 'Show less <svg viewBox="0 0 24 24" width="14" height="14" style="transform:rotate(180deg)"><path d="M7 10l5 5 5-5z" fill="currentColor"/></svg>'
        : 'Show more <svg viewBox="0 0 24 24" width="14" height="14"><path d="M7 10l5 5 5-5z" fill="currentColor"/></svg>';
      showMore.addEventListener("click", () => {
        if (!this._expandedSections) this._expandedSections = new Set();
        if (expanded) this._expandedSections.delete(key);
        else this._expandedSections.add(key);
        this.render();
      });
      section.appendChild(showMore);
    }
    return section;
  }

  buildContinueCard(it) {
    const card = document.createElement("button");
    card.className = "home-grid-card home-continue-card";
    card.title = it.updatedAt
      ? `Resume at ${fmtClock(it.positionSecs)} · last watched ${relativeDate(new Date(it.updatedAt).toISOString())}`
      : `Resume at ${fmtClock(it.positionSecs)}`;
    card.addEventListener("click", () => this.onVodResume(it));

    const thumbWrap = document.createElement("div");
    thumbWrap.className = "home-grid-thumb-wrap";
    const thumb = document.createElement("img");
    thumb.className = "home-grid-thumb";
    thumb.alt = "";
    const url = it.thumbnailUrl || "";
    // Helix hands back a "_404_processing" URL for VODs still transcoding, treat as no thumbnail
    if (url && !url.includes("404_processing")) {
      thumb.src = url
        .replace("%{width}", "440").replace("%{height}", "248")
        .replace("{width}", "440").replace("{height}", "248");
      thumb.onerror = () => { thumb.removeAttribute("src"); thumb.classList.add("no-thumb"); };
    } else {
      thumb.classList.add("no-thumb");
    }
    thumbWrap.appendChild(thumb);

    const left = document.createElement("span");
    left.className = "home-grid-viewers";
    // where you left off, out of the full length (e.g. "1:02:33 / 3:10:00")
    left.textContent = `${fmtClock(it.positionSecs)} / ${fmtClock(it.totalSecs)}`;
    thumbWrap.appendChild(left);

    // resume progress bar along the bottom of the thumbnail
    const bar = document.createElement("div");
    bar.className = "home-continue-progress";
    const fill = document.createElement("div");
    fill.className = "home-continue-progress-fill";
    fill.style.width = `${Math.min(100, Math.max(0, (it.positionSecs / it.totalSecs) * 100))}%`;
    bar.appendChild(fill);
    thumbWrap.appendChild(bar);

    // remove from this row only: the saved position is kept, so opening the VOD again later (e.g. from
    // the channel's VODs page) still resumes. a span, not a button: the card is itself a button and
    // buttons can't nest. stops propagation so it doesn't also open the VOD
    const remove = document.createElement("span");
    remove.className = "home-continue-remove";
    remove.setAttribute("role", "button");
    remove.setAttribute("aria-label", "Remove from Continue where you left off");
    remove.title = "Remove from this list";
    remove.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';
    remove.addEventListener("click", async (e) => {
      e.stopPropagation();
      e.preventDefault();
      try { await invoke("dismiss_vod_from_continue", { videoId: it.videoId }); } catch { /* ignore */ }
      this.continueItems = this.continueItems.filter((x) => x.videoId !== it.videoId);
      this.render();
    });
    thumbWrap.appendChild(remove);
    card.appendChild(thumbWrap);

    const text = document.createElement("div");
    text.className = "home-grid-text home-continue-text";
    const title = document.createElement("div");
    title.className = "home-grid-title";
    title.textContent = it.title;
    const name = document.createElement("div");
    name.className = "home-grid-name";
    name.textContent = it.channelName;
    // when it was streamed, same wording as the VODs page ("3 days ago"). when the stream date isn't
    // known (e.g. Kick VODs), fall back to when you last watched it
    const date = document.createElement("div");
    date.className = "home-grid-game home-continue-date";
    date.textContent = it.createdAt
      ? relativeDate(it.createdAt)
      : (it.updatedAt ? `Watched ${relativeDate(new Date(it.updatedAt).toISOString())}` : "");
    text.appendChild(title);
    text.appendChild(name);
    if (date.textContent) text.appendChild(date);
    card.appendChild(text);
    return card;
  }

  // one section per category; a category whose fetch fails or comes back empty is dropped,
  // not shown blank
  async fetchKickCategoryRows() {
    let games = [];
    try {
      const payload = JSON.parse(await feedInvoke("get_top_games", {}));
      games = Array.isArray(payload?.games) ? payload.games : [];
    } catch (err) {
      console.error("Failed to load home feed (Kick categories):", err);
      return [];
    }
    const top = games
      .filter((g) => g && g.id && g.name)
      .sort((a, b) => (b.viewers || 0) - (a.viewers || 0))
      .slice(0, KICK_CATEGORY_ROW_COUNT);
    const rows = await Promise.all(
      top.map(async (g) => {
        try {
          const streams = JSON.parse(
            await feedInvoke("get_streams_for_game_id", { gameId: g.id })
          );
          return {
            key: `kickcat-${g.id}`,
            title: g.name,
            streams: Array.isArray(streams) ? streams : [],
          };
        } catch (err) {
          console.error(`Failed to load Kick category row "${g.name}":`, err);
          return { key: `kickcat-${g.id}`, title: g.name, streams: [] };
        }
      })
    );
    return rows.filter((r) => r.streams.length > 0);
  }

  async fetchTopLive() {
    try {
      return JSON.parse(await feedInvoke("get_top_live_streams"));
    } catch (err) {
      console.error("Failed to load home feed (top live):", err);
      return [];
    }
  }

  async fetchRpgs() {
    try {
      return JSON.parse(
        await feedInvoke("get_streams_for_game_names", { gameNames: RPG_GAME_NAMES })
      );
    } catch (err) {
      console.error("Failed to load home feed (RPGs):", err);
      return [];
    }
  }

  async hydrateAvatars(streams) {
    // Kick streams carry their avatar inline (kick.rs embeds profile_image_url), so seed
    // those first and only batch-query Twitch for missing ids. kick:* ids must never reach
    // get_users_info or Helix 400s the whole batch
    for (const s of streams) {
      if (s.profile_image_url && !this.avatars.has(s.user_id)) {
        this.avatars.set(s.user_id, s.profile_image_url);
      }
    }
    const missingIds = [...new Set(streams.map((s) => s.user_id))].filter(
      (id) => !this.avatars.has(id) && !String(id).startsWith("kick:")
    );
    if (missingIds.length === 0) return;
    try {
      const users = JSON.parse(await invoke("get_users_info", { userIds: missingIds }));
      for (const u of users) this.avatars.set(u.id, u.profile_image_url);
    } catch (err) {
      // not fatal, cards just fall back to a blank avatar. usually means not logged in yet
      // (get_users_info needs auth), expected on first load
      console.error("Failed to load home feed avatars:", err);
    }
  }

  render() {
    this.containerEl.innerHTML = "";
    // top of Home: your live favorites in a MultiView launcher (2+ live), a single "watch" card (1 live),
    // or, with none live, the old top-streams carousel
    const top = this._buildTopSection();
    if (top) this.containerEl.appendChild(top);
    // Settings > Home: each row can be hidden
    if (this.continueItems.length > 0 && getSetting("homeContinueRow")) {
      this.containerEl.appendChild(this.buildContinueSection());
    }
    if (getSetting("homeRecommendedRow")) {
      this.containerEl.appendChild(
        this.buildSection(
          "Live channels we think you'll like",
          this.topLive || [],
          GRID_COLLAPSED_COUNT,
          "grid-expanded-likely"
        )
      );
    }
    for (const row of this.extraRows || []) {
      if (!row.streams.length) continue;
      this.containerEl.appendChild(
        this.buildSection(row.title, row.streams, GRID_COLLAPSED_COUNT, `grid-expanded-${row.key}`)
      );
    }
  }

  _liveFavorites() {
    try { return (this.getLiveFavorites() || []).filter((f) => !isHidden(f.login)); } catch { return []; }
  }

  _buildTopSection() {
    // Settings > Home > MultiView launcher off: always the classic top-streams carousel
    const favs = isKick() || !getSetting("homeLauncher") ? [] : this._liveFavorites();
    let el = null;
    if (favs.length >= 2) el = this.buildMultiViewLauncher(favs);
    else if (favs.length === 1) el = this.buildSingleFavorite(favs[0]);
    else if ((this.topLive || []).length > 0) el = this.buildCarousel(this.topLive.slice(0, CAROUSEL_SIZE));
    if (el) el.dataset.homeTop = "1";
    return el;
  }

  // swap just the top section in place (live favorites changed, or a launcher control was used), leaving
  // the rest of Home and its scroll position alone
  _refreshLauncher() {
    const old = this.containerEl.querySelector('[data-home-top="1"]');
    const next = this._buildTopSection();
    if (old && next) old.replaceWith(next);
    else if (old) old.remove();
    else if (next) this.containerEl.prepend(next);
  }

  _liveThumb(url) {
    if (!url) return "";
    return url.replace("{width}", "640").replace("{height}", "360") + `?t=${Math.floor(Date.now() / 60000)}`;
  }

  buildSingleFavorite(f) {
    const section = document.createElement("div");
    section.className = "home-section home-mvl-single";
    const head = document.createElement("div");
    head.className = "home-section-title";
    head.textContent = f.favorite ? "Your favorite is live" : "A channel you get notified about is live";
    section.appendChild(head);
    const card = document.createElement("button");
    card.className = "mvl-single";
    card.addEventListener("click", () => this.onChannelSelect(f.login, null));
    const media = document.createElement("div");
    media.className = "mvl-single-media";
    if (f.thumbnail) {
      const img = document.createElement("img");
      img.alt = ""; img.src = this._liveThumb(f.thumbnail);
      img.onerror = () => img.remove();
      media.appendChild(img);
    }
    const live = document.createElement("span");
    live.className = "mvl-live"; live.textContent = "LIVE";
    media.appendChild(live);
    const info = document.createElement("div");
    info.className = "mvl-single-info";
    const n = document.createElement("div"); n.className = "mvl-single-name"; n.textContent = f.name;
    const t = document.createElement("div"); t.className = "mvl-single-title"; t.textContent = f.title;
    const g = document.createElement("div"); g.className = "mvl-single-game";
    g.textContent = `${f.game}${f.game ? " · " : ""}${formatViewerCount(f.viewers)} viewers`;
    const go = document.createElement("span"); go.className = "mvl-go mvl-go-inline"; go.textContent = "Watch now";
    info.append(n, t, g, go);
    card.append(media, info);
    section.appendChild(card);
    return section;
  }

  // the "Sound from" dropdown's menu: one row per included stream, current one highlighted
  _toggleSoundMenu(btn, included) {
    const open = document.querySelector(".mvl-sound-menu");
    this._closeSoundMenu();
    if (open) return; // clicking the button again closes it
    const menu = document.createElement("div");
    menu.className = "mvl-sound-menu";
    for (const f of included) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "mvl-sound-item" + (f.login === this._mvAudio ? " active" : "");
      const nm = document.createElement("span"); nm.textContent = f.name;
      const vv = document.createElement("span"); vv.className = "mvl-sound-item-v"; vv.textContent = formatViewerCount(f.viewers);
      item.append(nm, vv);
      item.addEventListener("click", (e) => {
        e.stopPropagation();
        this._closeSoundMenu();
        this._mvAudio = f.login;
        this._refreshLauncher();
      });
      menu.appendChild(item);
    }
    document.body.appendChild(menu);
    const r = btn.getBoundingClientRect();
    const h = menu.offsetHeight;
    menu.style.minWidth = `${r.width}px`;
    menu.style.left = `${r.left}px`;
    menu.style.top = `${r.bottom + 4 + h > window.innerHeight - 8 ? Math.max(8, r.top - h - 4) : r.bottom + 4}px`;
    this._soundMenuClose = (e) => {
      if (e.type === "keydown" ? e.key === "Escape" : !menu.contains(e.target)) this._closeSoundMenu();
    };
    setTimeout(() => {
      document.addEventListener("mousedown", this._soundMenuClose, true);
      document.addEventListener("keydown", this._soundMenuClose, true);
    }, 0);
  }

  _closeSoundMenu() {
    document.querySelectorAll(".mvl-sound-menu").forEach((m) => m.remove());
    if (this._soundMenuClose) {
      document.removeEventListener("mousedown", this._soundMenuClose, true);
      document.removeEventListener("keydown", this._soundMenuClose, true);
      this._soundMenuClose = null;
    }
  }

  // "Watch your favorites together": live favorites previewed as a MultiView layout; tick who's in, pick
  // Grid or Focus, pick whose sound plays, one button opens MultiView with exactly that
  buildMultiViewLauncher(favs) {
    const MAX = 9; // MultiView's tile cap
    const included = favs.filter((f) => !this._mvExcluded.has(f.login)).slice(0, MAX);
    const inLogins = included.map((f) => f.login);
    if (!this._mvAudio || !inLogins.includes(this._mvAudio)) this._mvAudio = inLogins[0] || null;

    const section = document.createElement("div");
    section.className = "home-section home-mvl";
    const head = document.createElement("div");
    head.className = "home-mvl-head";
    head.innerHTML = '<span class="home-section-title">Watch your channels together</span>';
    const sub = document.createElement("span");
    sub.className = "home-mvl-sub";
    sub.textContent = `${favs.length} live · your favorites and channels you get notified about`;
    head.appendChild(sub);
    section.appendChild(head);

    const panel = document.createElement("div");
    panel.className = "mvl";

    // ---- preview stage (what MultiView will look like) ----
    // clicking a tile includes it or leaves it out (like the chips); left-out streams stay visible, dimmed,
    // so they can be clicked back in. the sound comes from the "Sound from" dropdown, marked with a badge
    const n = included.length;
    const inSetStage = new Set(inLogins);
    // included first, then the left-out ones, up to MultiView's 9 slots
    const slots = [...included, ...favs.filter((f) => !inSetStage.has(f.login))].slice(0, MAX);
    const audioFav = included.find((f) => f.login === this._mvAudio) || null;
    const spot = this._mvLayout === "spotlight" && slots.length >= 3 && !!audioFav;
    const stage = document.createElement("div");
    stage.className = "mvl-stage" + (spot ? " spotlight" : "");
    // the preview's shape follows the layout so every tile keeps a true 16:9 (a fixed 16:9 box squeezed two
    // side-by-side streams into tall, cropped tiles with black bars around them)
    if (spot) {
      // big stream on top (16:9 at full width), the rest in one row underneath (each 16:9 at 1/k width)
      const k = slots.length - 1;
      stage.style.gridTemplateColumns = `repeat(${k}, 1fr)`;
      stage.style.gridTemplateRows = `${k}fr 1fr`;
      stage.style.aspectRatio = `${16 * k} / ${9 * (k + 1)}`;
      stage.style.maxWidth = `${Math.round((460 * 16 * k) / (9 * (k + 1)))}px`;
    } else {
      const cols = slots.length <= 1 ? 1 : slots.length <= 4 ? 2 : 3;
      const rows = Math.ceil(Math.max(slots.length, 1) / cols);
      stage.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
      stage.style.gridTemplateRows = `repeat(${rows}, 1fr)`;
      stage.style.aspectRatio = `${16 * cols} / ${9 * rows}`;
      // cap the height (~460px) by capping the width in proportion, so the shape never distorts
      stage.style.maxWidth = `${Math.round((460 * 16 * cols) / (9 * rows))}px`;
    }
    const order = spot ? [audioFav, ...slots.filter((f) => f !== audioFav)] : slots;
    for (const f of order) {
      const on = inSetStage.has(f.login);
      const blocked = !on && n >= MAX; // full: can't add until one is left out
      const tile = document.createElement("button");
      tile.className = "mvl-tile" + (on ? "" : " off") + (f.login === this._mvAudio ? " audio" : "") +
        (spot && f === audioFav ? " main" : "") + (blocked ? " blocked" : "");
      tile.title = blocked ? "MultiView holds up to 9 streams" : on ? `Click to leave ${f.name} out` : `Click to include ${f.name}`;
      tile.setAttribute("aria-pressed", String(on));
      if (spot && f === audioFav) tile.style.gridColumn = `1 / span ${slots.length - 1}`;
      if (f.thumbnail) {
        const img = document.createElement("img");
        img.alt = ""; img.src = this._liveThumb(f.thumbnail); img.loading = "lazy";
        img.onerror = () => img.remove();
        tile.appendChild(img);
      }
      const live = document.createElement("span"); live.className = "mvl-live"; live.textContent = "LIVE";
      const v = document.createElement("span"); v.className = "mvl-viewers"; v.textContent = formatViewerCount(f.viewers);
      const cap = document.createElement("span"); cap.className = "mvl-cap";
      const nm = document.createElement("b"); nm.textContent = f.name;
      const gm = document.createElement("span"); gm.textContent = f.game;
      cap.append(nm, gm);
      const check = document.createElement("span");
      check.className = "mvl-check" + (on ? " on" : "");
      check.innerHTML = on ? '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>' : "";
      tile.append(live, v, cap, check);
      if (f.login === this._mvAudio && on) {
        // "sound plays from here" badge: same speaker icon + accent as MultiView's audible-stream button
        const snd = document.createElement("span");
        snd.className = "mvl-sound";
        snd.title = `Sound from ${f.name}`;
        snd.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H3v6h3l5 4z" fill="currentColor"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/></svg>';
        tile.appendChild(snd);
      }
      tile.addEventListener("click", () => {
        if (on) this._mvExcluded.add(f.login);
        else if (!blocked) this._mvExcluded.delete(f.login);
        else return;
        this._refreshLauncher();
      });
      stage.appendChild(tile);
    }

    // ---- controls ----
    const side = document.createElement("div");
    side.className = "mvl-side";
    side.innerHTML =
      '<div><div class="mvl-h">MultiView</div><div class="mvl-hs">Your live favorites and notified channels on one screen. Click streams to include or leave them out.</div></div>';

    const chipsWrap = document.createElement("div");
    chipsWrap.innerHTML = '<div class="mvl-label">Live now</div>';
    const chips = document.createElement("div");
    chips.className = "mvl-chips";
    const inSet = new Set(inLogins);
    for (const f of favs) {
      // "on" = actually in the preview. a favorite past MultiView's 9-stream cap isn't, even if never
      // unticked, so it shows off (and can't be added until one of the 9 is unticked)
      const on = inSet.has(f.login);
      const full = !on && included.length >= MAX;
      const chip = document.createElement("button");
      chip.className = "mvl-chip" + (on ? " on" : "");
      chip.disabled = full;
      chip.title = full ? "MultiView holds up to 9 streams" : on ? `Leave ${f.name} out` : `Include ${f.name}`;
      const dot = document.createElement("span"); dot.className = "mvl-dot";
      const nm = document.createElement("span"); nm.textContent = f.name;
      const vv = document.createElement("span"); vv.className = "mvl-chip-v"; vv.textContent = formatViewerCount(f.viewers);
      chip.append(dot, nm, vv);
      if (!f.favorite) {
        const bell = document.createElement("span");
        bell.className = "mvl-chip-bell";
        bell.textContent = "🔔";
        bell.title = "Here because you get notified when they go live";
        chip.appendChild(bell);
      }
      chip.addEventListener("click", () => {
        if (on) this._mvExcluded.add(f.login);
        else this._mvExcluded.delete(f.login);
        this._refreshLauncher();
      });
      chips.appendChild(chip);
    }
    chipsWrap.appendChild(chips);
    side.appendChild(chipsWrap);

    // "Sound from": themed dropdown of the included streams (whose audio plays, and the big tile in Focus)
    const sndWrap = document.createElement("div");
    sndWrap.innerHTML = '<div class="mvl-label">Sound from</div>';
    const sndBtn = document.createElement("button");
    sndBtn.type = "button";
    sndBtn.className = "mvl-sound-select";
    sndBtn.disabled = n === 0;
    sndBtn.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H3v6h3l5 4z" fill="currentColor"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/></svg>';
    const sndName = document.createElement("span");
    sndName.className = "mvl-sound-select-name";
    sndName.textContent = audioFav ? audioFav.name : "No stream selected";
    const chev = document.createElement("span");
    chev.className = "mvl-sound-select-chev";
    chev.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';
    sndBtn.append(sndName, chev);
    sndBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this._toggleSoundMenu(sndBtn, included);
    });
    sndWrap.appendChild(sndBtn);
    side.appendChild(sndWrap);

    const layWrap = document.createElement("div");
    layWrap.innerHTML = '<div class="mvl-label">Layout</div>';
    const lay = document.createElement("div");
    lay.className = "mvl-lay";
    for (const [key, label, tip] of [["grid", "Grid", "Every stream the same size"],
                                      ["spotlight", "Focus", "The stream with sound big, the rest in a strip (3+ streams)"]]) {
      const b = document.createElement("button");
      b.className = "mvl-lay-btn" + (this._mvLayout === key ? " on" : "");
      b.textContent = label;
      b.title = tip;
      b.addEventListener("click", () => {
        this._mvLayout = key;
        try { localStorage.setItem("homeMvLayout", key); } catch { /* ignore */ }
        this._refreshLauncher();
      });
      lay.appendChild(b);
    }
    layWrap.appendChild(lay);
    side.appendChild(layWrap);

    // "Last time: a, b, c · Reopen" (from MultiView's saved session), only if 2+ of them are live now
    try {
      const last = JSON.parse(localStorage.getItem("multiviewLastSession") || "null");
      if (last && Array.isArray(last.channels)) {
        const liveNow = this.getLiveLogins();
        const stillLive = last.channels.filter((c) => liveNow.has(String(c).toLowerCase()) && !isHidden(c));
        const sameAsNow = stillLive.length === inLogins.length && stillLive.every((c) => inLogins.includes(c));
        if (stillLive.length >= 2 && !sameAsNow) {
          const row = document.createElement("div");
          row.className = "mvl-last";
          const txt = document.createElement("span");
          txt.textContent = `Last time: ${stillLive.join(", ")}`;
          txt.title = `${stillLive.join(", ")} · ${relativeDate(new Date(last.at).toISOString())}`;
          const re = document.createElement("button");
          re.textContent = "Reopen";
          re.addEventListener("click", () => this.onOpenMultiView(stillLive, { layout: this._mvLayout, audio: stillLive[0] }));
          row.append(txt, re);
          side.appendChild(row);
        }
      }
    } catch { /* ignore a malformed saved session */ }

    const go = document.createElement("button");
    go.className = "mvl-go";
    go.disabled = n === 0;
    const audioName = included.find((f) => f.login === this._mvAudio)?.name || "";
    go.innerHTML = "";
    const goIcon = document.createElement("span");
    goIcon.className = "mvl-go-icon";
    goIcon.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="8" height="8" rx="1.5"/><rect x="13" y="3" width="8" height="8" rx="1.5"/><rect x="3" y="13" width="8" height="8" rx="1.5"/><rect x="13" y="13" width="8" height="8" rx="1.5"/></svg>';
    go.appendChild(goIcon);
    const goT = document.createElement("span"); goT.className = "mvl-go-title"; goT.textContent = `Watch together (${n})`;
    const goS = document.createElement("small"); goS.textContent = audioName ? `Sound from ${audioName}` : "Opens MultiView";
    go.append(goT, goS);
    go.addEventListener("click", () => {
      if (!n) return;
      this.onOpenMultiView(inLogins, { layout: this._mvLayout, audio: this._mvAudio });
    });
    side.appendChild(go);

    panel.append(stage, side);
    section.appendChild(panel);
    return section;
  }

  buildCarousel(streams) {
    streams = filterHidden(streams);
    const wrap = document.createElement("div");
    wrap.className = "home-carousel";

    const track = document.createElement("div");
    track.className = "home-carousel-track";

    for (const s of streams) {
      track.appendChild(this.buildCarouselCard(s));
    }
    wrap.appendChild(track);

    const prevBtn = document.createElement("button");
    prevBtn.className = "home-carousel-nav home-carousel-prev";
    prevBtn.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20"><path d="M15 6l-6 6 6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    prevBtn.addEventListener("click", () => {
      this.carouselIndex = Math.max(0, this.carouselIndex - 1);
      track.scrollTo({ left: this.carouselIndex * 360, behavior: "smooth" });
    });

    const nextBtn = document.createElement("button");
    nextBtn.className = "home-carousel-nav home-carousel-next";
    nextBtn.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20"><path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    nextBtn.addEventListener("click", () => {
      this.carouselIndex = Math.min(streams.length - 1, this.carouselIndex + 1);
      track.scrollTo({ left: this.carouselIndex * 360, behavior: "smooth" });
    });

    wrap.appendChild(prevBtn);
    wrap.appendChild(nextBtn);
    return wrap;
  }

  buildCarouselCard(s) {
    const card = document.createElement("button");
    card.className = "home-carousel-card";
    card.dataset.hypeId = s.user_id || "";
    card.addEventListener("click", () => this.onChannelSelect(s.user_login, s));
    card.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      showHideChannelMenu(e.clientX, e.clientY, s.user_login, s.user_name || s.user_login);
    });

    const thumb = document.createElement("img");
    thumb.className = "home-carousel-thumb";
    thumb.src = thumbnailUrl(s.thumbnail_url, 440, 248);
    thumb.alt = "";
    card.appendChild(thumb);

    // hype trains are shown as a glow on the card (see hype-badges.js), no badge

    const liveBadge = document.createElement("span");
    liveBadge.className = "home-live-badge";
    liveBadge.textContent = "LIVE";
    card.appendChild(liveBadge);

    if (streamHasDropsEnabled(s)) {
      const dropsBadge = document.createElement("span");
      dropsBadge.className = "home-drops-badge";
      dropsBadge.textContent = "Drops Enabled";
      card.appendChild(dropsBadge);
    }

    const info = document.createElement("div");
    info.className = "home-carousel-info";

    const avatar = document.createElement("img");
    avatar.className = "home-carousel-avatar";
    avatar.src = this.avatars.get(s.user_id) || blankAvatarDataUri();
    avatar.alt = "";
    info.appendChild(avatar);

    const text = document.createElement("div");
    text.className = "home-carousel-text";

    const name = document.createElement("div");
    name.className = "home-carousel-name";
    name.textContent = s.user_name;
    text.appendChild(name);

    const game = document.createElement("div");
    game.className = "home-carousel-game";
    game.textContent = s.game_name || "";
    text.appendChild(game);

    const tags = document.createElement("div");
    tags.className = "home-card-tags";
    for (const t of (s.tags || []).slice(0, 2)) {
      const tag = document.createElement("span");
      tag.className = "home-card-tag";
      tag.textContent = t;
      tags.appendChild(tag);
    }
    text.appendChild(tags);

    info.appendChild(text);

    const viewers = document.createElement("div");
    viewers.className = "home-carousel-viewers";
    viewers.textContent = `${formatViewerCount(s.viewer_count)} viewers`;
    info.appendChild(viewers);

    card.appendChild(info);
    return card;
  }

  buildSection(title, streams, collapsedCount, key) {
    streams = filterHidden(streams);
    const section = document.createElement("div");
    section.className = "home-section";

    const heading = document.createElement("div");
    heading.className = "home-section-title";
    heading.textContent = title;
    section.appendChild(heading);

    const grid = document.createElement("div");
    grid.className = "home-grid";

    const expanded = this._expandedSections?.has(key);
    const visible = expanded ? streams : streams.slice(0, collapsedCount);
    for (const s of visible) {
      grid.appendChild(this.buildGridCard(s));
    }
    section.appendChild(grid);

    if (streams.length > collapsedCount) {
      const showMore = document.createElement("button");
      showMore.className = "home-show-more";
      showMore.innerHTML = expanded
        ? 'Show less <svg viewBox="0 0 24 24" width="14" height="14" style="transform:rotate(180deg)"><path d="M7 10l5 5 5-5z" fill="currentColor"/></svg>'
        : 'Show more <svg viewBox="0 0 24 24" width="14" height="14"><path d="M7 10l5 5 5-5z" fill="currentColor"/></svg>';
      showMore.addEventListener("click", () => {
        if (!this._expandedSections) this._expandedSections = new Set();
        if (expanded) this._expandedSections.delete(key);
        else this._expandedSections.add(key);
        this.render();
      });
      section.appendChild(showMore);
    }

    return section;
  }

  buildGridCard(s) {
    const card = document.createElement("button");
    card.className = "home-grid-card";
    card.dataset.hypeId = s.user_id || "";
    card.addEventListener("click", () => this.onChannelSelect(s.user_login, s));
    card.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      showHideChannelMenu(e.clientX, e.clientY, s.user_login, s.user_name || s.user_login);
    });

    const thumbWrap = document.createElement("div");
    thumbWrap.className = "home-grid-thumb-wrap";

    const thumb = document.createElement("img");
    thumb.className = "home-grid-thumb";
    thumb.src = thumbnailUrl(s.thumbnail_url, 320, 180);
    thumb.alt = "";
    thumbWrap.appendChild(thumb);

    // hype trains are shown as a glow on the card (see hype-badges.js), no badge

    const liveBadge = document.createElement("span");
    liveBadge.className = "home-live-badge";
    liveBadge.textContent = "LIVE";
    thumbWrap.appendChild(liveBadge);

    if (streamHasDropsEnabled(s)) {
      const dropsBadge = document.createElement("span");
      dropsBadge.className = "home-drops-badge";
      dropsBadge.textContent = "Drops Enabled";
      thumbWrap.appendChild(dropsBadge);
    }

    const viewers = document.createElement("span");
    viewers.className = "home-grid-viewers";
    viewers.textContent = `${formatViewerCount(s.viewer_count)} viewers`;
    thumbWrap.appendChild(viewers);

    card.appendChild(thumbWrap);

    const meta = document.createElement("div");
    meta.className = "home-grid-meta";

    const avatar = document.createElement("img");
    avatar.className = "home-grid-avatar";
    avatar.src = this.avatars.get(s.user_id) || blankAvatarDataUri();
    avatar.alt = "";
    meta.appendChild(avatar);

    const text = document.createElement("div");
    text.className = "home-grid-text";

    const title = document.createElement("div");
    title.className = "home-grid-title";
    title.textContent = s.title || "";
    title.title = s.title || "";
    text.appendChild(title);

    const name = document.createElement("div");
    name.className = "home-grid-name";
    name.textContent = s.user_name;
    text.appendChild(name);

    const game = document.createElement("div");
    game.className = "home-grid-game";
    game.textContent = s.game_name || "";
    text.appendChild(game);

    const tags = document.createElement("div");
    tags.className = "home-card-tags";
    for (const t of (s.tags || []).slice(0, 3)) {
      const tag = document.createElement("span");
      tag.className = "home-card-tag";
      tag.textContent = t;
      tags.appendChild(tag);
    }
    text.appendChild(tags);

    meta.appendChild(text);
    card.appendChild(meta);

    return card;
  }
}

function thumbnailUrl(template, width, height) {
  if (!template) return blankAvatarDataUri();
  return template.replace("{width}", String(width)).replace("{height}", String(height));
}

function formatViewerCount(n) {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}K`;
  return String(n);
}

function blankAvatarDataUri() {
  return "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";
}
