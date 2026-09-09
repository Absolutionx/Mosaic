// browse/directory page (twitch.tv/directory-style): pills, a Categories/Live switcher,
// search, sort, grid. routed through Rust like home.js/sidebar.js

import { invoke } from "@tauri-apps/api/core";
import { feedInvoke, isKick } from "./platform.js";
import { streamHasDropsEnabled } from "./drops.js";

// every category is shown now (see get_top_games pagination in main.rs)
const CATEGORIES_COLLAPSED_COUNT = 18;

const SEARCH_DEBOUNCE_MS = 300;

// distance from the bottom of #browse-page that triggers the next page load
const SCROLL_TRIGGER_PX = 600;

// sub-directory pills, each a real Twitch category. "Games" is omitted (it shows the grid),
// and no "Esports" (a tag aggregate with no Helix endpoint). names must match exactly
const PILL_CATEGORIES = {
  irl: "IRL",
  music: "Music",
  creative: "Talk Shows & Podcasts",
  // Kick-only: Kick's directory has Gambling as a first-class group with no Twitch equivalent, resolved via kick_streams_for_game_names
  gambling: "Gambling",
};

// inline SVGs, simpler than separate files and no asset dependency
const PILL_ICONS = {
  games: '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M7 7h2v2h2v2H9v2H7v-2H5v-2h2V7zm9 1.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zm-3 4a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zM6 3h12a4 4 0 0 1 4 4v8a4 4 0 0 1-4 4h-1.5l-2-3h-9l-2 3H2a4 4 0 0 1-4-4V7a4 4 0 0 1 4-4h2z" opacity="0"/><path d="M6.5 4A4.5 4.5 0 0 0 2 8.5v7A4.5 4.5 0 0 0 6.5 20c.97 0 1.86-.33 2.57-.88L11 17h2l1.93 2.12c.71.55 1.6.88 2.57.88A4.5 4.5 0 0 0 22 15.5v-7A4.5 4.5 0 0 0 17.5 4h-11zM8 8v2h2v2H8v2H6v-2H4v-2h2V8h2zm9 .5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zM14 12.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z"/></svg>',
  irl: '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M12 2a5 5 0 0 1 5 5v3a5 5 0 0 1-10 0V7a5 5 0 0 1 5-5z"/><path d="M5 11a1 1 0 0 1 2 0 5 5 0 0 0 10 0 1 1 0 0 1 2 0 7 7 0 0 1-6 6.93V21h2a1 1 0 0 1 0 2H9a1 1 0 0 1 0-2h2v-3.07A7 7 0 0 1 5 11z"/></svg>',
  music: '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M9 3v12.55A4 4 0 1 0 11 19V8h7V5h-7V3H9z"/></svg>',
  creative: '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M12 1a3.5 3.5 0 0 0-3.5 3.5v6a3.5 3.5 0 0 0 7 0v-6A3.5 3.5 0 0 0 12 1z"/><path d="M5.5 10a1 1 0 0 1 1 1 5.5 5.5 0 0 0 11 0 1 1 0 1 1 2 0 7.5 7.5 0 0 1-6.5 7.43V21h3a1 1 0 0 1 0 2h-8a1 1 0 0 1 0-2h3v-2.57A7.5 7.5 0 0 1 4.5 11a1 1 0 0 1 1-1z"/></svg>',
};

// per-platform pill bars: the two directories differ (Kick has Gambling and labels groups
// differently), so sharing one bar gave Kick browse Twitch's shape
PILL_ICONS.gambling = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zm3 3.5A1.5 1.5 0 1 0 8 9.5a1.5 1.5 0 0 0 0-3zm8 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zm-4 4a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zm-4 4a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zm8 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3z"/></svg>';

const PILL_DEFS_TWITCH = [
  { key: "games", label: "Games" },
  { key: "irl", label: "IRL" },
  { key: "music", label: "Music & DJs" },
  { key: "creative", label: "Talk Shows & Podcasts" },
];
const PILL_DEFS_KICK = [
  { key: "games", label: "Games" },
  { key: "irl", label: "IRL" },
  { key: "music", label: "Music" },
  { key: "gambling", label: "Slots & Casino" },
  { key: "creative", label: "Creative" },
];

export class BrowsePage {
  constructor({ containerEl, onChannelSelect }) {
    this.containerEl = containerEl;
    this.onChannelSelect = onChannelSelect || (() => {});
    this.avatars = new Map();
    this.games = [];
    this.categoryCounts = new Map();
    // currently drilled-into category, or null at the top-level grid
    this.activeGame = null;
    // "games" (Categories/Live view) or a PILL_CATEGORIES key
    this.activePill = "games";
    this.activeTab = "categories";
    // "recommended" (get_top_games' own order) | "viewers" (re-sorted by count)
    this.sortMode = "recommended";
    this.searchQuery = "";
    this._searchDebounceTimer = null;
    this.searchResults = null;
    this.topLiveStreams = [];
    this.videoFrameEl = document.getElementById("video-frame");
    this.loaded = false;
    // null = not loaded yet OR no more categories; hasMoreGames distinguishes the two
    this.nextGamesCursor = null;
    this.hasMoreGames = true;
    // guards loadMoreGames() against a duplicate request while a page is loading
    this.loadingMoreGames = false;
    // consecutive all-duplicate pages after dedupe. Kick's walk overlaps by design, so a few are
    // normal; many means the endpoint ignores its page param, so stop paging
    this._allDupGamePages = 0;
    // same, for the Live Channels tab's own scroll (get_live_streams_page)
    this.nextLiveCursor = null;
    this.hasMoreLive = true;
    this.loadingMoreLive = false;
    // bound once so the listener is a stable reference; containerEl persists for the page's lifetime
    this._onScroll = () => this._handleScroll();
    this.containerEl.addEventListener("scroll", this._onScroll);
    // true while the FIRST page load is in flight. without it, scrollTop = 0 fires a synchronous
    // 'scroll' that could kick off a second redundant page-1 fetch
    this._initialLoadInProgress = false;
  }

  show() {
    this.containerEl.style.display = "block";
    if (this.videoFrameEl) this.videoFrameEl.style.display = "none";
    if (!this.loaded) {
      this.loaded = true;
      this.loadTopGames();
    } else {
      this.render();
    }
  }

  hide() {
    this.containerEl.style.display = "none";
    if (this.videoFrameEl) this.videoFrameEl.style.display = "";
  }

  // reload now if showing, else mark stale for the next show()
  reloadForPlatformChange() {
    this.games = [];
    this.topLiveStreams = [];
    this.categoryCounts = new Map();
    this.activeGame = null;
    this.activePill = "games";
    this.activeTab = "categories";
    this.searchQuery = "";
    this.searchResults = null;
    this.nextGamesCursor = null;
    this.hasMoreGames = true;
    this._allDupGamePages = 0;
    this.nextLiveCursor = null;
    this.hasMoreLive = true;
    if (this.containerEl.style.display !== "none" && this.loaded) {
      this.loadTopGames();
    } else {
      this.loaded = false;
    }
  }

  async loadTopGames() {
    this._initialLoadInProgress = true;
    this.containerEl.innerHTML = '<div class="home-section-title">Loading categories…</div>';
    try {
      const { games, cursor } = JSON.parse(await feedInvoke("get_top_games", { cursor: null }));
      this.games = dedupeGamesById(games);
      this.nextGamesCursor = cursor;
      this.hasMoreGames = Boolean(cursor);
      this._allDupGamePages = 0;
    } catch (err) {
      console.error("Failed to load top games:", err);
      this.containerEl.innerHTML = '<div class="home-section-title">Failed to load categories.</div>';
      this._initialLoadInProgress = false;
      return;
    }
    this._initialLoadInProgress = false;
    this.activeGame = null;
    this.render();
    // viewer counts load in the background and re-render, rather than blocking the grid paint on the much heavier get_category_viewer_counts
    this.loadCategoryCounts();
  }

  // a real Helix request each time, so scrolling walks every live category
  async loadMoreGames() {
    if (this.loadingMoreGames || !this.hasMoreGames) return;
    this.loadingMoreGames = true;
    let pageAddedNothing = false;
    this.render(); // shows the loading indicator immediately
    try {
      const { games, cursor } = JSON.parse(
        await feedInvoke("get_top_games", { cursor: this.nextGamesCursor })
      );
      // dedupe by id across pages: Kick's walk overlaps by design and Twitch cursor pages can
      // overlap at boundaries, so a card could otherwise render twice
      const before = this.games.length;
      this.games = dedupeGamesById(this.games.concat(games));
      pageAddedNothing = this.games.length === before;
      this.nextGamesCursor = cursor;
      this.hasMoreGames = Boolean(cursor);
      if (pageAddedNothing) {
        // a few dup pages in a row are expected; many means the endpoint is ignoring its page param, so stop
        this._allDupGamePages += 1;
        if (this._allDupGamePages >= 5) this.hasMoreGames = false;
      } else {
        this._allDupGamePages = 0;
      }
    } catch (err) {
      console.error("Failed to load more categories:", err);
      // leave hasMoreGames as-is so a transient failure doesn't permanently stop future scroll attempts
    }
    this.loadingMoreGames = false;
    this.render();
    // an all-dup page re-renders identical DOM, so no new 'scroll' fires, chain into the next page
    // to hop the expected overlap, bounded by the dup-stop and page cap
    if (pageAddedNothing && this.hasMoreGames) this.loadMoreGames();
  }

  // the Live tab's loadMoreGames(), backed by get_live_streams_page
  async loadMoreLiveStreams() {
    if (this.loadingMoreLive || !this.hasMoreLive) return;
    this.loadingMoreLive = true;
    this.render();
    try {
      const { streams, cursor } = JSON.parse(
        await feedInvoke("get_live_streams_page", { cursor: this.nextLiveCursor })
      );
      await this.hydrateAvatars(streams);
      this.topLiveStreams = this.topLiveStreams.concat(streams);
      this.nextLiveCursor = cursor;
      this.hasMoreLive = Boolean(cursor);
    } catch (err) {
      console.error("Failed to load more live streams:", err);
    }
    this.loadingMoreLive = false;
    this.render();
  }

  // loads the next page within SCROLL_TRIGGER_PX of the bottom for whichever grid is showing.
  // only the two server-paginated views (Categories, Live); search and a drilled-in category are complete one-shot lists
  _handleScroll() {
    if (this.activeGame) return; // drilled into one category, nothing more to page
    if (this._initialLoadInProgress) return; // first page still loading
    const el = this.containerEl;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distanceFromBottom > SCROLL_TRIGGER_PX) return;

    if (this.activeTab === "live") {
      this.loadMoreLiveStreams();
    } else if (this.searchResults === null) {
      // search results aren't paginated here, searching doesn't scroll-load more
      this.loadMoreGames();
    }
  }

  async loadCategoryCounts() {
    try {
      const raw = await feedInvoke("get_category_viewer_counts");
      const parsed = JSON.parse(raw);
      this.categoryCounts = new Map(Object.entries(parsed));
    } catch (err) {
      console.error("Failed to load category viewer counts:", err);
      return;
    }
    // a re-render while drilled in or on Live is wasted (counts aren't used there)
    if (!this.activeGame && this.activeTab === "categories" && this.activePill === "games") {
      this.render();
    }
  }

  async loadTopLiveStreams() {
    this._initialLoadInProgress = true;
    this.containerEl.innerHTML = '<div class="home-section-title">Loading live channels…</div>';
    let streams = [];
    try {
      const { streams: page, cursor } = JSON.parse(
        await feedInvoke("get_live_streams_page", { cursor: null })
      );
      streams = page;
      this.nextLiveCursor = cursor;
      this.hasMoreLive = Boolean(cursor);
    } catch (err) {
      console.error("Failed to load top live streams:", err);
    }
    this._initialLoadInProgress = false;
    await this.hydrateAvatars(streams);
    this.topLiveStreams = streams;
    this.render();
  }

  async openGame(game) {
    this.activeGame = game;
    this.containerEl.scrollTop = 0;
    this.containerEl.innerHTML = "";
    this.containerEl.appendChild(this.buildBackRow(game.name));
    const loading = document.createElement("div");
    loading.className = "home-section-title";
    loading.textContent = "Loading streams…";
    this.containerEl.appendChild(loading);

    let streams = [];
    try {
      streams = JSON.parse(await feedInvoke("get_streams_for_game_id", { gameId: game.id }));
    } catch (err) {
      console.error("Failed to load streams for game:", err);
    }
    await this.hydrateAvatars(streams);

    this.containerEl.innerHTML = "";
    this.containerEl.appendChild(this.buildBackRow(game.name));

    if (streams.length === 0) {
      const empty = document.createElement("div");
      empty.className = "home-section-title";
      empty.textContent = "No live channels right now.";
      this.containerEl.appendChild(empty);
      return;
    }

    const grid = document.createElement("div");
    grid.className = "home-grid";
    for (const s of streams) {
      grid.appendChild(this.buildStreamCard(s));
    }
    this.containerEl.appendChild(grid);
  }

  // like openGame() but resolves by exact NAME via get_streams_for_game_names, since pills aren't backed by a card
  async openPillCategory(pillKey) {
    const categoryName = PILL_CATEGORIES[pillKey];
    this.activePill = pillKey;
    this.activeGame = { id: null, name: categoryName, isPill: true };
    this.containerEl.innerHTML = "";
    this.containerEl.appendChild(this.buildPillsRow());
    this.containerEl.appendChild(this.buildBackRow(categoryName));
    const loading = document.createElement("div");
    loading.className = "home-section-title";
    loading.textContent = "Loading streams…";
    this.containerEl.appendChild(loading);

    let streams = [];
    try {
      streams = JSON.parse(
        await feedInvoke("get_streams_for_game_names", { gameNames: [categoryName] })
      );
    } catch (err) {
      console.error(`Failed to load streams for ${categoryName}:`, err);
    }
    await this.hydrateAvatars(streams);

    this.containerEl.innerHTML = "";
    this.containerEl.appendChild(this.buildPillsRow());
    this.containerEl.appendChild(this.buildBackRow(categoryName));

    if (streams.length === 0) {
      const empty = document.createElement("div");
      empty.className = "home-section-title";
      empty.textContent = "No live channels right now.";
      this.containerEl.appendChild(empty);
      return;
    }

    const grid = document.createElement("div");
    grid.className = "home-grid";
    for (const s of streams) {
      grid.appendChild(this.buildStreamCard(s));
    }
    this.containerEl.appendChild(grid);
  }

  buildBackRow(gameName) {
    const row = document.createElement("div");
    row.className = "browse-back-row";

    const backBtn = document.createElement("button");
    backBtn.className = "browse-back-btn";
    backBtn.innerHTML =
      '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M15 6l-6 6 6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg> Categories';
    backBtn.addEventListener("click", () => {
      this.containerEl.scrollTop = 0;
      this.activeGame = null;
      this.activePill = "games";
      this.render();
    });
    row.appendChild(backBtn);

    const title = document.createElement("div");
    title.className = "browse-category-title";
    title.textContent = gameName;
    row.appendChild(title);

    return row;
  }

  async hydrateAvatars(streams) {
    // same seeding as home.js: Kick streams carry profile_image_url inline; kick:* ids are excluded from the Twitch batch (Helix would 400)
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
      console.error("Failed to load browse-page avatars:", err);
    }
  }


  buildPageTitle() {
    const title = document.createElement("div");
    title.className = "browse-page-title";
    title.textContent = "Browse";
    return title;
  }

  buildPillsRow() {
    const row = document.createElement("div");
    row.className = "browse-pills-row";
    const defs = isKick() ? PILL_DEFS_KICK : PILL_DEFS_TWITCH;
    for (const def of defs) {
      const pill = document.createElement("button");
      pill.className = "browse-pill" + (this.activePill === def.key ? " is-active" : "");

      const label = document.createElement("span");
      label.textContent = def.label;
      pill.appendChild(label);

      const icon = document.createElement("span");
      icon.innerHTML = PILL_ICONS[def.key];
      pill.appendChild(icon);

      pill.addEventListener("click", () => {
        this.containerEl.scrollTop = 0;
        if (def.key === "games") {
          // "Games" has no single category, return to this page's Categories grid
          this.activePill = "games";
          this.activeGame = null;
          this.render();
        } else {
          this.openPillCategory(def.key);
        }
      });
      row.appendChild(pill);
    }
    return row;
  }

  buildTabsRow() {
    const row = document.createElement("div");
    row.className = "browse-tabs-row";

    const categoriesTab = document.createElement("button");
    categoriesTab.className = "browse-tab" + (this.activeTab === "categories" ? " is-active" : "");
    categoriesTab.textContent = "Categories";
    categoriesTab.addEventListener("click", () => {
      if (this.activeTab === "categories") return;
      this.activeTab = "categories";
      this.containerEl.scrollTop = 0;
      this.render();
    });
    row.appendChild(categoriesTab);

    const liveTab = document.createElement("button");
    liveTab.className = "browse-tab" + (this.activeTab === "live" ? " is-active" : "");
    liveTab.textContent = "Live Channels";
    liveTab.addEventListener("click", () => {
      if (this.activeTab === "live") return;
      this.activeTab = "live";
      this.containerEl.scrollTop = 0;
      this.loadTopLiveStreams();
    });
    row.appendChild(liveTab);

    return row;
  }

  buildControlsRow() {
    const row = document.createElement("div");
    row.className = "browse-controls-row";

    // only on the Categories tab, category search on a live-channels list maps to nothing, same as twitch.tv
    if (this.activeTab === "categories") {
      const searchWrap = document.createElement("div");
      searchWrap.className = "browse-search-wrap";

      const icon = document.createElement("span");
      icon.className = "browse-search-icon";
      icon.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>';
      searchWrap.appendChild(icon);

      const input = document.createElement("input");
      input.className = "browse-search-input";
      input.type = "text";
      input.placeholder = "Search Category Tags";
      input.value = this.searchQuery;
      input.addEventListener("input", () => {
        this.searchQuery = input.value;
        clearTimeout(this._searchDebounceTimer);
        this._searchDebounceTimer = setTimeout(() => this.runSearch(), SEARCH_DEBOUNCE_MS);
      });
      searchWrap.appendChild(input);
      row.appendChild(searchWrap);
    } else {
      // keep the controls row's space-between layout on the Live tab, which has a sort but no search box
      row.appendChild(document.createElement("div"));
    }

    // "Recommended" has no personalization signal so it keeps the feed's own order; "Viewer Count"
    // re-sorts by real/approximated numbers
    const sortRow = document.createElement("div");
    sortRow.className = "browse-sort-row";
    const sortLabel = document.createElement("span");
    sortLabel.textContent = "Sort by";
    sortRow.appendChild(sortLabel);

    const select = document.createElement("select");
    select.className = "browse-sort-select";
    const optRecommended = document.createElement("option");
    optRecommended.value = "recommended";
    optRecommended.textContent = "Recommended For You";
    select.appendChild(optRecommended);
    const optViewers = document.createElement("option");
    optViewers.value = "viewers";
    optViewers.textContent = "Viewer Count";
    select.appendChild(optViewers);
    select.value = this.sortMode;
    select.addEventListener("change", () => {
      this.sortMode = select.value;
      this.render();
    });
    sortRow.appendChild(select);
    row.appendChild(sortRow);

    return row;
  }

  async runSearch() {
    const query = this.searchQuery.trim();
    if (!query) {
      this.searchResults = null;
      this.render();
      return;
    }
    try {
      this.searchResults = JSON.parse(await feedInvoke("search_categories", { query }));
    } catch (err) {
      console.error("Category search failed:", err);
      this.searchResults = [];
    }
    // render() re-derives from current state, so a quick clear-then-retype can't show results for a query no longer in the box
    if (this.searchQuery.trim() === query) this.render();
  }


  render() {
    if (this.activeGame) {
      // openGame()/openPillCategory() manage their own rendering, nothing to do on a plain re-render while drilled in
      return;
    }

    this.containerEl.innerHTML = "";
    this.containerEl.appendChild(this.buildPageTitle());
    this.containerEl.appendChild(this.buildPillsRow());
    this.containerEl.appendChild(this.buildTabsRow());
    this.containerEl.appendChild(this.buildControlsRow());

    if (this.activeTab === "live") {
      this.renderLiveChannelsGrid();
    } else {
      this.renderCategoriesGrid();
    }
  }

  renderLiveChannelsGrid() {
    let streams = this.topLiveStreams;
    if (this.sortMode === "viewers") {
      streams = [...streams].sort((a, b) => (b.viewer_count || 0) - (a.viewer_count || 0));
    }
    if (streams.length === 0) {
      const empty = document.createElement("div");
      empty.className = "home-section-title";
      empty.textContent = "No live channels right now.";
      this.containerEl.appendChild(empty);
      return;
    }
    const grid = document.createElement("div");
    grid.className = "home-grid";
    for (const s of streams) {
      grid.appendChild(this.buildStreamCard(s));
    }
    this.containerEl.appendChild(grid);

    // hidden while sorting by viewers, so a growing list doesn't reshuffle cards already seen
    if (this.sortMode !== "viewers") {
      this.containerEl.appendChild(
        this._buildPaginationFooter(this.hasMoreLive, this.loadingMoreLive, this.topLiveStreams.length)
      );
    }
  }

  renderCategoriesGrid() {
    // a non-empty search box replaces the grid with live results (server-side across the full catalog, not a client filter), like twitch.tv
    const usingSearch = this.searchResults !== null;
    const heading = document.createElement("div");
    heading.className = "home-section-title";
    heading.textContent = usingSearch ? `Results for "${this.searchQuery.trim()}"` : "Categories";
    this.containerEl.appendChild(heading);

    let visible;
    if (usingSearch) {
      visible = this.searchResults;
    } else if (this.sortMode === "viewers") {
      visible = [...this.games].sort((a, b) => {
        const av = this.categoryCounts.get(a.id)?.viewer_count || 0;
        const bv = this.categoryCounts.get(b.id)?.viewer_count || 0;
        return bv - av;
      });
    } else {
      visible = this.games;
    }

    if (visible.length === 0) {
      const empty = document.createElement("div");
      empty.className = "home-section-title";
      empty.textContent = "No categories found.";
      this.containerEl.appendChild(empty);
      return;
    }

    const grid = document.createElement("div");
    grid.className = "browse-games-grid";
    for (const game of visible) {
      grid.appendChild(this.buildGameCard(game));
    }
    this.containerEl.appendChild(grid);

    // the next page is scroll-triggered, not a button. hidden while sorting by viewers, same reason as Live
    if (!usingSearch && this.sortMode !== "viewers") {
      this.containerEl.appendChild(
        this._buildPaginationFooter(this.hasMoreGames, this.loadingMoreGames, this.games.length)
      );
    }
  }

  // spinner while loading, nothing while idle, an end-of-list note once exhausted, never a clickable control
  _buildPaginationFooter(hasMore, isLoading, currentCount) {
    const footer = document.createElement("div");
    footer.className = "browse-pagination-footer";
    if (isLoading) {
      footer.innerHTML = '<span class="browse-pagination-spinner"></span> Loading more…';
    } else if (!hasMore && currentCount > CATEGORIES_COLLAPSED_COUNT) {
      // only worth saying after enough scrolling to be a real confirmation, not noise under a short first page
      footer.textContent = "You've reached the end of the list.";
    }
    return footer;
  }

  buildGameCard(game) {
    const card = document.createElement("button");
    card.className = "browse-game-card";
    card.addEventListener("click", () => this.openGame(game));

    const art = document.createElement("img");
    art.className = "browse-game-art";
    art.src = boxArtUrl(game.box_art_url, 188, 250);
    art.alt = "";
    card.appendChild(art);

    const name = document.createElement("div");
    name.className = "browse-game-name";
    name.textContent = game.name;
    card.appendChild(name);

    // approximated count (get_category_viewer_counts), omitted rather than "0 viewers" for an
    // unmeasured category, which would read as "nobody's watching"
    const counts = this.categoryCounts.get(game.id);
    if (counts && counts.viewer_count > 0) {
      const viewers = document.createElement("div");
      viewers.className = "browse-game-viewers";
      viewers.textContent = `${formatViewerCount(counts.viewer_count)} viewers`;
      card.appendChild(viewers);
    }

    return card;
  }

  // mirrors home.js's buildGridCard for visual consistency across the two grids
  buildStreamCard(s) {
    const card = document.createElement("button");
    card.className = "home-grid-card";
    card.addEventListener("click", () => this.onChannelSelect(s.user_login, s));

    const thumbWrap = document.createElement("div");
    thumbWrap.className = "home-grid-thumb-wrap";

    const thumb = document.createElement("img");
    thumb.className = "home-grid-thumb";
    thumb.src = thumbnailUrl(s.thumbnail_url, 320, 180);
    thumb.alt = "";
    thumbWrap.appendChild(thumb);

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

// first occurrence wins, keyed on game id. entries with no id pass through, better a rare double card than dropping distinct categories
function dedupeGamesById(list) {
  const seen = new Set();
  return list.filter((g) => {
    const id = g && g.id != null ? String(g.id) : "";
    if (!id) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function boxArtUrl(template, width, height) {
  if (!template) return blankAvatarDataUri();
  return template.replace("{width}", String(width)).replace("{height}", String(height));
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
