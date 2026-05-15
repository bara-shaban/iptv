(() => {
  const API_BASE = "https://vidapi.ru";
  const PLAYER_BASE = "https://vaplayer.ru";
  const DB_BASE = "data/catalog";
  const CARD_LIMIT = 180;
  const SEARCH_LIMIT = 240;
  const SEARCH_DEBOUNCE = 180;
  const CACHE_SEARCH_PAGES = 5000;

  const STORAGE = {
    subtitles: "streamline:subtitles",
    watchlist: "streamline:watchlist",
    watchItems: "streamline:watchItems",
    continueItems: "streamline:continueItems",
    progress: "streamline:progress:",
    cache: "streamline:cache:",
  };

  const state = {
    view: "all",
    category: "all",
    query: "",
    sort: "relevance",
    selected: null,
    selectedPlayable: null,
    currentUrl: "",
    latestPage: {
      movies: 1,
      tv: 1,
      episodes: 1,
    },
    totals: {
      movies: 0,
      tv: 0,
      episodes: 0,
    },
    datasets: {
      latest: [],
      search: [],
      episodes: [],
    },
    db: {
      manifest: null,
      shardCache: new Map(),
      pageCache: new Map(),
      episodeCache: new Map(),
      cacheManifest: null,
      cacheSearchItems: null,
      cachedPageHits: 0,
      ready: false,
      searching: false,
      searchTimer: null,
      searchRun: 0,
      generatedAt: "",
    },
    itemMap: new Map(),
    activeSeason: 1,
    activeShow: null,
    watchlist: new Set(),
    watchItems: new Map(),
    continueItems: new Map(),
    subtitles: {
      lang: "en",
      url: "",
      label: "Custom",
      code: "en",
      isDefault: true,
      color: "#4fc3b1",
    },
    toastTimer: null,
  };

  const els = {};

  document.addEventListener("DOMContentLoaded", init);

  async function init() {
    collectElements();
    loadStoredState();
    bindEvents();
    syncSubtitleForm();
    syncManualFields();
    renderIcons();
    renderShell();

    await Promise.allSettled([
      loadManifest(),
      loadLatest(),
      loadStats(),
    ]);

    selectOpeningTitle();
    renderShell();
    renderIcons();
  }

  function collectElements() {
    Object.assign(els, {
      navTabs: [...document.querySelectorAll(".nav-tab")],
      genreList: document.querySelector("#genreList"),
      resetFilters: document.querySelector("#resetFilters"),
      searchForm: document.querySelector("#searchForm"),
      searchInput: document.querySelector("#searchInput"),
      sortSelect: document.querySelector("#sortSelect"),
      refreshCatalog: document.querySelector("#refreshCatalog"),
      dbTitle: document.querySelector("#dbTitle"),
      dbStatus: document.querySelector("#dbStatus"),
      loadMore: document.querySelector("#loadMore"),
      playerFrame: document.querySelector("#playerFrame"),
      iframeShell: document.querySelector("#iframeShell"),
      posterBackdrop: document.querySelector("#posterBackdrop"),
      nowType: document.querySelector("#nowType"),
      nowTitle: document.querySelector("#nowTitle"),
      nowMeta: document.querySelector("#nowMeta"),
      progressTime: document.querySelector("#progressTime"),
      durationTime: document.querySelector("#durationTime"),
      progressFill: document.querySelector("#progressFill"),
      playSelected: document.querySelector("#playSelected"),
      toggleWatchlist: document.querySelector("#toggleWatchlist"),
      copyLink: document.querySelector("#copyLink"),
      downloadButton: document.querySelector("#downloadButton"),
      castButton: document.querySelector("#castButton"),
      subtitleForm: document.querySelector("#subtitleForm"),
      subtitleLang: document.querySelector("#subtitleLang"),
      subtitleUrl: document.querySelector("#subtitleUrl"),
      subtitleLabel: document.querySelector("#subtitleLabel"),
      subtitleCode: document.querySelector("#subtitleCode"),
      subtitleDefault: document.querySelector("#subtitleDefault"),
      playerColor: document.querySelector("#playerColor"),
      clearSubtitles: document.querySelector("#clearSubtitles"),
      manualForm: document.querySelector("#manualForm"),
      manualType: document.querySelector("#manualType"),
      manualId: document.querySelector("#manualId"),
      manualSeason: document.querySelector("#manualSeason"),
      manualEpisode: document.querySelector("#manualEpisode"),
      continueSection: document.querySelector("#continueSection"),
      continueRail: document.querySelector("#continueRail"),
      showDetail: document.querySelector("#showDetail"),
      showHero: document.querySelector("#showHero"),
      showEyebrow: document.querySelector("#showEyebrow"),
      showTitle: document.querySelector("#showTitle"),
      showMeta: document.querySelector("#showMeta"),
      resumeShow: document.querySelector("#resumeShow"),
      seasonTabs: document.querySelector("#seasonTabs"),
      episodeBrowser: document.querySelector("#episodeBrowser"),
      resultEyebrow: document.querySelector("#resultEyebrow"),
      resultTitle: document.querySelector("#resultTitle"),
      resultCount: document.querySelector("#resultCount"),
      catalogGrid: document.querySelector("#catalogGrid"),
      cardTemplate: document.querySelector("#cardTemplate"),
      statMovies: document.querySelector("#statMovies"),
      statShows: document.querySelector("#statShows"),
      statEpisodes: document.querySelector("#statEpisodes"),
    });
  }

  function loadStoredState() {
    state.subtitles = {
      ...state.subtitles,
      ...parseStoredJSON(STORAGE.subtitles, {}),
    };
    state.watchlist = new Set(parseStoredJSON(STORAGE.watchlist, []));
    state.watchItems = new Map(Object.entries(parseStoredJSON(STORAGE.watchItems, {})));
    state.continueItems = new Map(Object.entries(parseStoredJSON(STORAGE.continueItems, {})));
  }

  function bindEvents() {
    els.navTabs.forEach((button) => {
      button.addEventListener("click", () => {
        state.view = button.dataset.view;
        state.category = "all";
        els.navTabs.forEach((tab) => {
          tab.classList.toggle("is-active", tab.dataset.view === state.view);
        });
        renderShell();
      });
    });

    els.genreList.addEventListener("click", (event) => {
      const chip = event.target.closest("[data-category]");
      if (!chip) return;
      state.category = chip.dataset.category;
      renderShell();
    });

    els.resetFilters.addEventListener("click", () => {
      state.category = "all";
      state.query = "";
      els.searchInput.value = "";
      state.datasets.search = [];
      renderShell();
    });

    els.searchForm.addEventListener("submit", (event) => {
      event.preventDefault();
      state.query = els.searchInput.value.trim();
      queueSearch(0);
    });

    els.searchInput.addEventListener("input", () => {
      state.query = els.searchInput.value.trim();
      queueSearch();
      renderShell();
    });

    els.sortSelect.addEventListener("change", () => {
      state.sort = els.sortSelect.value;
      renderShell();
    });

    els.refreshCatalog.addEventListener("click", async () => {
      state.latestPage = { movies: 1, tv: 1, episodes: 1 };
      state.datasets.latest = [];
      state.datasets.episodes = [];
      await Promise.allSettled([loadLatest(), loadStats()]);
      selectOpeningTitle();
      renderShell();
      toast("Latest catalog refreshed.");
    });

    els.loadMore.addEventListener("click", async () => {
      await loadLatest();
      renderShell();
    });

    els.catalogGrid.addEventListener("click", (event) => {
      const watchButton = event.target.closest(".watch-button");
      if (watchButton) {
        const item = state.itemMap.get(watchButton.dataset.key);
        if (item) toggleWatchlist(item);
        return;
      }
      const posterButton = event.target.closest(".poster-button");
      if (!posterButton) return;
      const item = state.itemMap.get(posterButton.dataset.key);
      if (item) selectItem(item, item.kind !== "tv");
    });

    els.playSelected.addEventListener("click", () => playSelected());
    els.toggleWatchlist.addEventListener("click", () => {
      if (state.selected) toggleWatchlist(state.selected);
    });
    els.copyLink.addEventListener("click", () => {
      if (state.currentUrl) copyToClipboard(state.currentUrl);
    });
    els.downloadButton.addEventListener("click", openDownloadSource);
    els.castButton.addEventListener("click", castSelected);

    els.subtitleForm.addEventListener("submit", (event) => {
      event.preventDefault();
      readSubtitleForm();
      storeSubtitleState();
      applyAccentColor();
      if (state.selectedPlayable) playSelected();
      toast("Subtitle settings applied.");
    });

    els.clearSubtitles.addEventListener("click", () => {
      state.subtitles.url = "";
      syncSubtitleForm();
      storeSubtitleState();
      if (state.selectedPlayable) playSelected();
    });

    els.manualType.addEventListener("change", syncManualFields);
    els.manualForm.addEventListener("submit", (event) => {
      event.preventDefault();
      openManualItem();
    });

    els.continueRail.addEventListener("click", (event) => {
      const button = event.target.closest("[data-continue-key]");
      if (!button) return;
      const entry = state.continueItems.get(button.dataset.continueKey);
      if (entry?.item) selectItem(entry.item, true);
    });

    els.resumeShow.addEventListener("click", () => {
      const entry = getShowProgress(state.activeShow);
      if (entry?.item) selectItem(entry.item, true);
    });

    els.seasonTabs.addEventListener("click", (event) => {
      const button = event.target.closest("[data-season]");
      if (!button) return;
      state.activeSeason = Number(button.dataset.season) || 1;
      renderShowDetail();
    });

    els.episodeBrowser.addEventListener("click", (event) => {
      const button = event.target.closest("[data-key]");
      if (!button) return;
      const item = state.itemMap.get(button.dataset.key);
      if (item) selectItem(item, true);
    });

    window.addEventListener("message", handlePlayerMessage);
  }

  async function loadManifest() {
    try {
      const manifest = await fetchJSON(`${DB_BASE}/manifest.json`, "manifest", {
        cacheLocal: false,
      });
      state.db.manifest = manifest;
      state.db.ready = true;
      state.db.generatedAt = manifest.generatedAt || "";
      state.totals.movies = Number(manifest.counts?.movies) || state.totals.movies;
      state.totals.tv = Number(manifest.counts?.tv) || state.totals.tv;
      state.totals.episodes = Number(manifest.counts?.episodes) || state.totals.episodes;
      if (manifest.partial) await loadCacheManifest(false);
    } catch {
      state.db.ready = false;
      await loadCacheManifest();
    }
  }

  async function loadCacheManifest(updateTotals = true) {
    try {
      const manifest = await fetchJSON("data/.catalog-cache/manifest.json", "cache-manifest", {
        cacheLocal: false,
      });
      state.db.cacheManifest = normalizeCacheManifest(manifest);
      if (updateTotals) {
        state.totals.movies = Number(manifest.totals?.movies) || state.totals.movies;
        state.totals.tv = Number(manifest.totals?.tv) || state.totals.tv;
        state.totals.episodes = Number(manifest.totals?.episodes) || state.totals.episodes;
      }
    } catch {
      state.db.cacheManifest = null;
    }
  }

  async function loadLatest() {
    const [movies, tv, episodes] = await Promise.allSettled([
      loadLatestPage("movies"),
      loadLatestPage("tv"),
      loadLatestPage("episodes"),
    ]);

    [movies, tv].forEach((result) => {
      if (result.status === "fulfilled") {
        result.value.forEach((item) => addItem(item, "latest"));
      }
    });
    if (episodes.status === "fulfilled") {
      episodes.value.forEach((item) => addItem(item, "episodes"));
    }
  }

  async function loadLatestPage(kind) {
    const page = state.latestPage[kind] || 1;
    const endpoint = getLatestEndpoint(kind, page);
    const data = await fetchProjectCachedPage(kind, page) ||
      await fetchJSON(`${API_BASE}${endpoint}`, `latest:${kind}:${page}`);
    state.latestPage[kind] = (Number(data.page) || page) + 1;
    if (kind === "movies") state.totals.movies = Number(data.total) || state.totals.movies;
    if (kind === "tv") state.totals.tv = Number(data.total) || state.totals.tv;
    if (kind === "episodes") state.totals.episodes = Number(data.total) || state.totals.episodes;
    return (data.items || []).map((item, index) => normalizeVidItem(item, kind, index));
  }

  async function fetchProjectCachedPage(kind, page) {
    const cacheKind = kind === "movies" ? "movies" : kind;
    const key = `${cacheKind}:${page}`;
    if (state.db.pageCache.has(key)) return state.db.pageCache.get(key);
    try {
      const data = await fetchJSON(`data/.catalog-cache/${cacheKind}/${page}.json`, `project-cache:${cacheKind}:${page}`, {
        cacheLocal: false,
      });
      state.db.pageCache.set(key, data);
      state.db.cachedPageHits += 1;
      return data;
    } catch {
      state.db.pageCache.set(key, null);
      return null;
    }
  }

  async function loadProjectCacheSearchPages() {
    if (state.db.cacheSearchItems) return state.db.cacheSearchItems;
    const all = [];
    const pagesByKind = getCacheSearchPagePlan();

    await Promise.all(["movies", "tv"].map(async (kind) => {
      let misses = 0;
      const pages = pagesByKind[kind] || [];
      for (const page of pages) {
        const data = await fetchProjectCachedPage(kind, page);
        if (!data) {
          misses += 1;
          if (!state.db.cacheManifest && misses >= 5) break;
          continue;
        }
        misses = 0;
        const normalized = (data.items || []).map((item, index) => normalizeVidItem(item, kind, index));
        normalized.forEach((item) => state.itemMap.set(item.key, item));
        all.push(...normalized);
        if (page % 25 === 0) await new Promise((resolve) => window.requestAnimationFrame(resolve));
      }
    }));

    state.db.cacheSearchItems = mergeUniqueItems(all);
    return state.db.cacheSearchItems;
  }

  function getCacheSearchPagePlan() {
    const pages = state.db.cacheManifest?.pages || {};
    const fallbackPages = Array.from({ length: CACHE_SEARCH_PAGES }, (_, index) => index + 1);
    if (state.db.cacheManifest) {
      return {
        movies: pages.movies || [],
        tv: pages.tv || [],
      };
    }
    return {
      movies: fallbackPages,
      tv: fallbackPages,
    };
  }

  async function loadStats() {
    try {
      const stats = await fetchJSON(`${API_BASE}/imdb/api/?action=stats`, "stats");
      const library = stats.content_library || {};
      state.totals.movies = Number(library.movies) || state.totals.movies;
      state.totals.tv = Number(library.tv_shows) || state.totals.tv;
      state.totals.episodes = Number(library.episodes) || state.totals.episodes;
    } finally {
      renderStats();
    }
  }

  function getLatestEndpoint(kind, page) {
    const safePage = Math.max(1, Number(page) || 1);
    if (kind === "movies") return `/movies/latest/page-${safePage}.json`;
    if (kind === "tv") return `/tvshows/latest/page-${safePage}.json`;
    return `/episodes/latest/page-${safePage}.json`;
  }

  function queueSearch(delay = SEARCH_DEBOUNCE) {
    window.clearTimeout(state.db.searchTimer);
    const query = state.query.trim();
    if (query.length < 2) {
      state.db.searching = false;
      state.datasets.search = [];
      renderShell();
      return;
    }
    state.db.searchTimer = window.setTimeout(() => searchCatalog(query), delay);
  }

  async function searchCatalog(query) {
    const run = ++state.db.searchRun;
    state.db.searching = true;
    renderShell();

    try {
      let items = [];
      const directItems = getDirectIdSearchItems(query);
      if (state.db.ready) {
        const shardNames = pickSearchShards(query);
        const shards = await Promise.all(shardNames.map((name) => loadShard(name)));
        const cachedPages = state.db.manifest?.partial ? await loadProjectCacheSearchPages() : [];
        items = [...shards.flat(), ...cachedPages, ...state.datasets.latest];
      } else {
        const cachedPages = await loadProjectCacheSearchPages();
        items = [...cachedPages, ...state.datasets.latest];
      }

      const scored = items
        .map((item) => ({ item, score: scoreItem(item, query) }))
        .filter((entry) => entry.score > 0)
        .sort((a, b) => b.score - a.score || toNumber(b.item.popularity) - toNumber(a.item.popularity))
        .slice(0, SEARCH_LIMIT)
        .map(({ item, score }) => ({ ...item, _score: score }));

      if (run !== state.db.searchRun) return;
      const merged = mergeUniqueItems([...directItems, ...scored]);
      state.datasets.search = merged;
      merged.forEach((item) => state.itemMap.set(item.key, item));
    } catch (error) {
      console.error(error);
      if (run === state.db.searchRun) toast("Search is having trouble. Try again in a moment.");
    } finally {
      if (run === state.db.searchRun) {
        state.db.searching = false;
        renderShell();
        renderIcons();
      }
    }
  }

  function pickSearchShards(query) {
    const manifest = state.db.manifest || {};
    const available = new Set(manifest.shards || []);
    const tokens = normalizeText(query).split(" ").filter(Boolean);
    const picks = new Set();

    tokens.forEach((token) => {
      const prefix = shardName(token);
      if (available.has(prefix)) picks.add(prefix);
      if (token.length > 4) {
        const shortPrefix = shardName(token.slice(0, 3));
        if (available.has(shortPrefix)) picks.add(shortPrefix);
      }
    });

    if (!picks.size && available.has("misc")) picks.add("misc");
    return [...picks].slice(0, 8);
  }

  function getDirectIdSearchItems(query) {
    return extractDirectIds(query).flatMap((id) => {
      const cleanId = id.toLowerCase();
      const isImdb = cleanId.startsWith("tt");
      const idLabel = isImdb ? "IMDB" : "TMDB";
      const movie = {
        kind: "movie",
        source: "direct",
        title: `Movie ${cleanId}`,
        imdb_id: isImdb ? cleanId : "",
        tmdb_id: isImdb ? "" : cleanId,
        year: "",
        genre: `Direct ${idLabel}`,
        rating: "",
        popularity: "999999",
        poster_url: "",
        embed_url: `${PLAYER_BASE}/embed/movie/${encodeURIComponent(cleanId)}`,
        _score: 999,
      };
      movie.key = getItemKey(movie);
      movie.search = normalizeText(`${movie.title} ${cleanId}`);

      const tv = {
        kind: "tv",
        source: "direct",
        title: `TV ${cleanId}`,
        imdb_id: isImdb ? cleanId : "",
        tmdb_id: isImdb ? "" : cleanId,
        year: "",
        genre: `Direct ${idLabel}`,
        rating: "",
        popularity: "999998",
        poster_url: "",
        embed_url: `${PLAYER_BASE}/embed/tv/${encodeURIComponent(cleanId)}`,
        _score: 998,
      };
      tv.key = getItemKey(tv);
      tv.search = normalizeText(`${tv.title} ${cleanId}`);
      return [movie, tv];
    });
  }

  function extractDirectIds(query) {
    const text = query.trim();
    const imdbMatch = text.match(/tt\d{5,}/i);
    if (imdbMatch) return [imdbMatch[0].toLowerCase()];

    const tmdbUrlMatch = text.match(/themoviedb\.org\/(?:movie|tv)\/(\d+)/i);
    if (tmdbUrlMatch) return [tmdbUrlMatch[1]];

    const tmdbLabelMatch = text.match(/\btmdb\s*[:#-]?\s*(\d+)\b/i);
    if (tmdbLabelMatch) return [tmdbLabelMatch[1]];

    if (/^\d+$/.test(text)) return [text];
    return [];
  }

  function mergeUniqueItems(items) {
    const seen = new Set();
    const merged = [];
    items.forEach((item) => {
      const key = item.key || getItemKey(item);
      if (seen.has(key)) return;
      seen.add(key);
      merged.push(item);
    });
    return merged;
  }

  function normalizeCacheManifest(manifest) {
    const normalizePages = (items) => [...new Set((items || [])
      .map((page) => Number(page))
      .filter((page) => Number.isInteger(page) && page > 0))]
      .sort((a, b) => a - b);
    return {
      ...manifest,
      pages: {
        movies: normalizePages(manifest.pages?.movies),
        tv: normalizePages(manifest.pages?.tv),
        episodes: normalizePages(manifest.pages?.episodes),
      },
    };
  }

  function getCachedPageCount() {
    const pages = state.db.cacheManifest?.pages;
    if (!pages) return state.db.cachedPageHits;
    return (pages.movies?.length || 0) + (pages.tv?.length || 0) + (pages.episodes?.length || 0);
  }

  async function loadShard(name) {
    if (state.db.shardCache.has(name)) return state.db.shardCache.get(name);
    let normalized = [];
    try {
      const items = await fetchJSON(`${DB_BASE}/shards/${name}.json`, `shard:${name}`, {
        cacheLocal: false,
      });
      normalized = (Array.isArray(items) ? items : []).map((item) => normalizeStoredItem(item));
    } catch {
      normalized = [];
    }
    state.db.shardCache.set(name, normalized);
    normalized.forEach((item) => state.itemMap.set(item.key, item));
    return normalized;
  }

  async function loadShowEpisodes(show) {
    const ids = getShowIdCandidates(show);
    if (!ids.length) return [];

    const cached = ids.find((id) => state.db.episodeCache.has(id));
    if (cached) return state.db.episodeCache.get(cached);

    for (const showId of ids) {
      const bucket = episodeBucket(showId);
      try {
        const data = await fetchJSON(`${DB_BASE}/episodes/${bucket}/${encodeURIComponent(showId)}.json`, `episodes:${showId}`, {
          cacheLocal: false,
        });
        const episodes = (data.episodes || data || []).map((episode, index) => {
          const item = normalizeStoredEpisode(show, episode, index);
          state.itemMap.set(item.key, item);
          return item;
        });
        ids.forEach((id) => state.db.episodeCache.set(id, episodes));
        return episodes;
      } catch {
        state.db.episodeCache.set(showId, []);
      }
    }

    ids.forEach((id) => state.db.episodeCache.set(id, []));
    return [];
  }

  function scoreItem(item, query) {
    const haystack = item.search || normalizeText(`${item.title} ${item.genre || ""} ${item.year || ""}`);
    const title = normalizeText(item.title || "");
    const tokens = normalizeText(query).split(" ").filter(Boolean);
    if (!tokens.length) return 0;

    let score = 0;
    if (title === tokens.join(" ")) score += 120;
    if (title.startsWith(tokens.join(" "))) score += 80;
    if (haystack.includes(tokens.join(" "))) score += 60;

    const titleTokens = title.split(" ").filter(Boolean);
    tokens.forEach((token) => {
      if (titleTokens.includes(token)) score += 28;
      else if (haystack.includes(token)) score += 14;
      else if (titleTokens.some((word) => isCloseToken(word, token))) score += 12;
    });

    if (tokens.every((token) => haystack.includes(token) || titleTokens.some((word) => isCloseToken(word, token)))) {
      score += 30;
    }

    score += Math.min(8, toNumber(item.rating));
    score += Math.min(12, toNumber(item.popularity) / 20);
    return score;
  }

  function isCloseToken(word, query) {
    if (query.length < 4 || word.length < 4) return false;
    return levenshtein(word, query) <= (query.length > 6 ? 2 : 1);
  }

  function renderShell() {
    applyAccentColor();
    renderStats();
    renderDbStatus();
    renderContinueWatching();
    renderShowDetail();
    renderCategories(getScopedItems());
    const visible = getVisibleItems();
    renderResultHeader(visible.length);
    renderCards(visible);
    updatePlayerChrome();
    renderIcons();
  }

  function getScopedItems() {
    if (state.view === "watchlist") return getWatchlistItems();
    if (state.query.trim().length >= 2) return state.datasets.search;
    if (state.view === "episodes") return state.datasets.episodes;
    if (state.view === "movies") return state.datasets.latest.filter((item) => item.kind === "movie");
    if (state.view === "tv") return state.datasets.latest.filter((item) => item.kind === "tv");
    return state.datasets.latest;
  }

  function getVisibleItems() {
    let items = getScopedItems();
    if (state.view === "movies") items = items.filter((item) => item.kind === "movie");
    if (state.view === "tv") items = items.filter((item) => item.kind === "tv");
    if (state.view === "episodes") items = items.filter((item) => item.kind === "episode");

    if (state.category !== "all") {
      items = items.filter((item) => getCategories(item).includes(state.category));
    }

    return sortItems(items);
  }

  function sortItems(items) {
    const sorted = [...items];
    if (state.sort === "rating") sorted.sort((a, b) => toNumber(b.rating) - toNumber(a.rating));
    else if (state.sort === "popularity") sorted.sort((a, b) => toNumber(b.popularity) - toNumber(a.popularity));
    else if (state.sort === "year") sorted.sort((a, b) => Number(b.year || 0) - Number(a.year || 0));
    else if (state.sort === "az") sorted.sort((a, b) => getDisplayTitle(a).localeCompare(getDisplayTitle(b)));
    else if (state.sort === "latest") sorted.sort((a, b) => (a._index || 0) - (b._index || 0));
    else sorted.sort((a, b) => (b._score || 0) - (a._score || 0));
    return sorted;
  }

  function renderDbStatus() {
    if (state.db.ready) {
      els.dbTitle.textContent = "Ready to watch";
      const parts = [`${compactNumber(state.totals.movies)} movies`, `${compactNumber(state.totals.tv)} shows`];
      if (state.totals.episodes) parts.push(`${compactNumber(state.totals.episodes)} episodes`);
      els.dbStatus.textContent = parts.join(" • ");
      return;
    }

    els.dbTitle.textContent = "Loading library";
    if (state.db.cacheManifest || state.db.cachedPageHits) {
      els.dbStatus.textContent = "Search is available while more titles load.";
      return;
    }
    els.dbStatus.textContent = "Movies, shows, and episodes are loading.";
  }

  function renderResultHeader(count) {
    const labels = {
      all: ["Explore", "Latest Picks"],
      movies: ["Movies", "Movie Results"],
      tv: ["TV Shows", "TV Results"],
      episodes: ["Episodes", "Recent Episodes"],
      watchlist: ["Saved", "Watchlist"],
    };
    const [eyebrow, title] = labels[state.view] || labels.all;
    els.resultEyebrow.textContent = state.db.searching ? "Searching" : eyebrow;
    els.resultTitle.textContent = state.query ? `Results for "${state.query}"` : title;
    els.resultCount.textContent = `${compactNumber(count)} ${count === 1 ? "title" : "titles"}`;
  }

  function renderStats() {
    els.statMovies.textContent = compactNumber(state.totals.movies);
    els.statShows.textContent = compactNumber(state.totals.tv);
    els.statEpisodes.textContent = compactNumber(state.totals.episodes);
  }

  function renderCategories(items) {
    const counts = new Map();
    items.forEach((item) => {
      getCategories(item).forEach((category) => {
        counts.set(category, (counts.get(category) || 0) + 1);
      });
    });
    if (state.category !== "all" && !counts.has(state.category)) state.category = "all";

    const chips = [["all", "All", items.length], ...[...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 28)
      .map(([name, count]) => [name, name, count])];

    els.genreList.replaceChildren(...chips.map(([value, label, count]) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `genre-chip${state.category === value ? " is-active" : ""}`;
      button.dataset.category = value;
      button.innerHTML = `<span>${escapeHTML(label)}</span><small>${count}</small>`;
      return button;
    }));
  }

  function renderCards(items) {
    if (state.db.searching) {
      els.catalogGrid.innerHTML = `<div class="empty-state">Searching...</div>`;
      return;
    }
    if (!items.length) {
      const message = state.query
        ? "No match found. Try a title, IMDB ID, or TMDB ID."
        : "No titles found.";
      els.catalogGrid.innerHTML = `<div class="empty-state">${message}</div>`;
      return;
    }

    const fragment = document.createDocumentFragment();
    items.slice(0, CARD_LIMIT).forEach((item) => {
      const card = els.cardTemplate.content.firstElementChild.cloneNode(true);
      const posterButton = card.querySelector(".poster-button");
      const image = card.querySelector("img");
      const fallback = card.querySelector(".poster-fallback");
      const title = card.querySelector("h3");
      const meta = card.querySelector(".meta-line");
      const tags = card.querySelector(".tag-line");
      const watchButton = card.querySelector(".watch-button");

      posterButton.dataset.key = item.key;
      watchButton.dataset.key = item.key;
      card.classList.toggle("is-active", state.selected?.key === item.key);
      if (item.poster_url) {
        image.src = item.poster_url;
        image.alt = `${getDisplayTitle(item)} poster`;
      } else {
        image.removeAttribute("src");
        image.alt = "";
      }
      fallback.textContent = getInitials(getDisplayTitle(item));
      title.textContent = getDisplayTitle(item);
      meta.textContent = getMetaLine(item);
      watchButton.classList.toggle("is-active", state.watchlist.has(item.key));

      getTags(item).forEach((tag) => {
        const span = document.createElement("span");
        span.className = "tag";
        span.innerHTML = `<span>${escapeHTML(tag)}</span>`;
        tags.appendChild(span);
      });
      fragment.appendChild(card);
    });

    if (items.length > CARD_LIMIT) {
      const note = document.createElement("div");
      note.className = "empty-state result-note";
      note.textContent = `Showing first ${CARD_LIMIT} of ${compactNumber(items.length)} matches.`;
      fragment.appendChild(note);
    }

    els.catalogGrid.replaceChildren(fragment);
  }

  async function selectItem(item, shouldPlay = false) {
    if (!item) return;
    state.selected = item;
    state.selectedPlayable = getPlayableItem(item);
    state.currentUrl = state.selectedPlayable ? buildPlayerUrl(state.selectedPlayable) : "";
    updatePlayerChrome();

    if (item.kind === "tv") {
      state.activeShow = item;
      await prepareShowDetail(item);
      shouldPlay = false;
    }

    renderShell();
    if (shouldPlay) playSelected();
  }

  async function prepareShowDetail(show) {
    const episodes = await loadShowEpisodes(show);
    if (episodes.length) {
      const saved = getShowProgress(show);
      state.activeSeason = Number(saved?.item?.season) || episodes[0].season || 1;
    } else {
      state.activeSeason = 1;
    }
  }

  function renderShowDetail() {
    const show = state.activeShow;
    if (!show || show.kind !== "tv") {
      els.showDetail.hidden = true;
      return;
    }

    els.showDetail.hidden = false;
    els.showTitle.textContent = show.title || "TV Show";
    els.showEyebrow.textContent = "TV Show";
    const saved = getShowProgress(show);
    els.resumeShow.disabled = !saved?.item;

    const episodes = getCachedShowEpisodes(show);
    const seasons = [...new Set(episodes.map((episode) => Number(episode.season)).filter(Boolean))]
      .sort((a, b) => a - b);

    const parts = [];
    if (show.year) parts.push(show.year);
    if (episodes.length) parts.push(`${episodes.length} episodes`);
    if (saved?.item) parts.push(`resume S${saved.item.season} E${saved.item.episode} at ${formatTime(saved.progress)}`);
    els.showMeta.textContent = parts.join(" • ") || "Choose a season and episode.";

    const image = show.backdrop_url || show.poster_url || "";
    els.showHero.style.backgroundImage = image
      ? `linear-gradient(90deg, rgba(7, 12, 14, 0.96), rgba(7, 12, 14, 0.58)), url("${String(image).replace(/["\\\n\r]/g, "")}")`
      : "";

    els.seasonTabs.replaceChildren(...(seasons.length ? seasons : [1]).map((season) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `season-tab${season === state.activeSeason ? " is-active" : ""}`;
      button.dataset.season = String(season);
      button.textContent = `Season ${season}`;
      return button;
    }));

    const selectedEpisodes = episodes
      .filter((episode) => Number(episode.season) === Number(state.activeSeason))
      .sort((a, b) => a.episode - b.episode);

    if (!selectedEpisodes.length) {
      els.episodeBrowser.innerHTML = `<div class="empty-state">No episodes found for this season yet.</div>`;
      return;
    }

    const fragment = document.createDocumentFragment();
    selectedEpisodes.forEach((episode) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `episode-tile${state.selected?.key === episode.key ? " is-active" : ""}`;
      button.dataset.key = episode.key;
      const progress = getSavedProgressForItem(episode);
      const percent = progress.duration
        ? Math.min(100, Math.round((progress.progress / progress.duration) * 100))
        : 0;
      button.innerHTML = `
        <span class="episode-number">E${String(episode.episode).padStart(2, "0")}</span>
        <span class="episode-copy">
          <strong>${escapeHTML(episode.title || `Episode ${episode.episode}`)}</strong>
          <small>Season ${episode.season || 1} • Episode ${episode.episode || 1}${progress.progress ? ` • ${formatTime(progress.progress)}` : ""}</small>
        </span>
        <span class="mini-progress"><span style="width: ${percent}%"></span></span>
      `;
      fragment.appendChild(button);
    });
    els.episodeBrowser.replaceChildren(fragment);
  }

  function getPlayableItem(item) {
    if (!item) return null;
    if (item.kind === "tv") {
      const saved = getShowProgress(item);
      if (saved?.item) return getPlayableItem(saved.item);
      const episodes = getCachedShowEpisodes(item);
      if (episodes[0]) return getPlayableItem(episodes[0]);
      return makeEpisodeItem(item, 1, 1);
    }
    return {
      ...item,
      playableTitle: getDisplayTitle(item),
      playableMeta: getMetaLine(item),
      embedUrl: getEmbedUrl(item),
      progressKey: getProgressKey(item),
    };
  }

  function makeEpisodeItem(show, season, episode) {
    const showId = getShowId(show);
    const item = {
      kind: "episode",
      title: `Episode ${episode}`,
      showTitle: show.title || "TV Show",
      show_tmdb_id: show.tmdb_id || "",
      show_imdb_id: show.imdb_id || "",
      tmdb_id: show.tmdb_id || "",
      imdb_id: show.imdb_id || "",
      season,
      episode,
      poster_url: show.backdrop_url || show.poster_url || "",
      embed_url: `${PLAYER_BASE}/embed/tv/${encodeURIComponent(showId)}/${season}/${episode}`,
    };
    item.key = getItemKey(item);
    return getPlayableItem(item);
  }

  function playSelected() {
    if (!state.selectedPlayable) return;
    state.currentUrl = buildPlayerUrl(state.selectedPlayable);
    els.playerFrame.src = state.currentUrl;
    els.iframeShell.classList.add("has-player");
    updatePlayerChrome();
  }

  function updatePlayerChrome() {
    const hasItem = Boolean(state.selectedPlayable);
    els.playSelected.disabled = !hasItem;
    els.toggleWatchlist.disabled = !state.selected;
    els.copyLink.disabled = !state.currentUrl;
    els.downloadButton.disabled = !hasItem;
    els.castButton.disabled = !hasItem;

    if (!hasItem) {
      els.nowType.textContent = "Ready";
      els.nowTitle.textContent = "Pick something to watch";
      els.nowMeta.textContent = "Search or pick a title to start watching.";
      els.posterBackdrop.classList.remove("has-poster");
      els.posterBackdrop.style.backgroundImage = "";
      return;
    }

    const item = state.selectedPlayable;
    els.nowType.textContent = getTypeLabel(item);
    els.nowTitle.textContent = item.playableTitle || getDisplayTitle(item);
    els.nowMeta.textContent = item.playableMeta || getMetaLine(item);
    const poster = item.poster_url || state.selected?.poster_url || "";
    if (poster) {
      els.posterBackdrop.classList.add("has-poster");
      els.posterBackdrop.style.backgroundImage = `
        linear-gradient(90deg, rgba(5, 10, 12, 0.9), rgba(5, 10, 12, 0.32)),
        url("${String(poster).replace(/["\\\n\r]/g, "")}")
      `;
    } else {
      els.posterBackdrop.classList.remove("has-poster");
      els.posterBackdrop.style.backgroundImage = "";
    }

    const saved = state.selected && state.watchlist.has(state.selected.key);
    els.toggleWatchlist.innerHTML = saved
      ? '<i data-lucide="bookmark-check"></i>'
      : '<i data-lucide="bookmark-plus"></i>';
    renderIcons();
  }

  function buildPlayerUrl(item) {
    const url = new URL(item.embedUrl || getEmbedUrl(item));
    const params = url.searchParams;
    const saved = getSavedProgressForItem(item);
    params.set("primaryColor", state.subtitles.color || "#4fc3b1");
    params.set("title", getDisplayTitle(item));
    params.set("showTitle", "true");
    if (item.poster_url) params.set("poster", item.poster_url);
    if (saved.progress > 15) params.set("resumeAt", String(Math.floor(saved.progress)));
    if (state.subtitles.lang) params.set("ds_lang", state.subtitles.lang);
    if (state.subtitles.url) {
      params.set("sub_url", state.subtitles.url);
      params.set("sub_label", state.subtitles.label || "Custom");
      params.set("sub_lang", state.subtitles.code || state.subtitles.lang || "en");
      params.set("sub_default", state.subtitles.isDefault ? "true" : "false");
    }
    return url.toString();
  }

  function openDownloadSource() {
    if (!state.selectedPlayable) return;
    const url = state.currentUrl || buildPlayerUrl(state.selectedPlayable);
    window.open(url, "_blank", "noopener,noreferrer");
    toast("Opened the player in a new tab.");
  }

  function handlePlayerMessage(event) {
    if (!String(event.origin || "").includes("vaplayer.ru")) return;
    if (!event.data || event.data.type !== "PLAYER_EVENT") return;
    const data = event.data.data || {};
    const progress = Number(data.player_progress) || 0;
    const duration = Number(data.player_duration) || 0;
    if (progress > 0) saveContinueProgress(progress, duration);
    updateProgress(progress, duration);
    if (data.player_status === "completed") loadNextEpisode();
  }

  function loadNextEpisode() {
    const current = state.selectedPlayable;
    if (!current || current.kind !== "episode") return;
    const showId = getShowId(current);
    const episodes = state.db.episodeCache.get(showId) || [];
    const next = episodes.find((episode) =>
      Number(episode.season) === Number(current.season) &&
      Number(episode.episode) === Number(current.episode) + 1
    );
    if (next) selectItem(next, true);
  }

  function updateProgress(progress, duration) {
    els.progressTime.textContent = formatTime(progress);
    els.durationTime.textContent = formatTime(duration);
    const percent = duration ? Math.min(100, Math.max(0, (progress / duration) * 100)) : 0;
    els.progressFill.style.width = `${percent}%`;
  }

  function saveContinueProgress(progress, duration) {
    const item = state.selectedPlayable || state.selected;
    if (!item) return;
    const entry = {
      key: getContinueKey(item),
      item: snapshotItem(item),
      progress,
      duration,
      updatedAt: Date.now(),
    };
    state.continueItems.set(entry.key, entry);
    if (item.kind === "episode") {
      state.continueItems.set(getContinueShowKey(item), { ...entry, key: getContinueShowKey(item) });
    }
    localStorage.setItem(STORAGE.continueItems, JSON.stringify(Object.fromEntries(state.continueItems.entries())));
    localStorage.setItem(getProgressKey(item), String(progress));
    renderContinueWatching();
    renderShowDetail();
  }

  function renderContinueWatching() {
    const entries = [...state.continueItems.values()]
      .filter((entry) => entry.item && entry.progress > 5 && !String(entry.key).startsWith("episode:"))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 10);

    els.continueSection.hidden = !entries.length;
    if (!entries.length) return;
    els.continueRail.replaceChildren(...entries.map((entry) => {
      const item = entry.item;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "continue-card";
      button.dataset.continueKey = entry.key;
      const percent = entry.duration ? Math.min(100, Math.round((entry.progress / entry.duration) * 100)) : 0;
      button.innerHTML = `
        <span class="continue-poster">${item.poster_url ? `<img src="${escapeHTML(item.poster_url)}" alt="">` : escapeHTML(getInitials(getDisplayTitle(item)))}</span>
        <span class="continue-copy">
          <strong>${escapeHTML(getDisplayTitle(item))}</strong>
          <small>${escapeHTML(getTypeLabel(item))} • ${formatTime(entry.progress)}</small>
          <span class="mini-progress"><span style="width: ${percent}%"></span></span>
        </span>
      `;
      return button;
    }));
  }

  function toggleWatchlist(item) {
    if (!item) return;
    if (state.watchlist.has(item.key)) {
      state.watchlist.delete(item.key);
      state.watchItems.delete(item.key);
      toast("Removed from saved.");
    } else {
      state.watchlist.add(item.key);
      state.watchItems.set(item.key, snapshotItem(item));
      toast("Saved.");
    }
    localStorage.setItem(STORAGE.watchlist, JSON.stringify([...state.watchlist]));
    localStorage.setItem(STORAGE.watchItems, JSON.stringify(Object.fromEntries(state.watchItems.entries())));
    renderShell();
  }

  function getWatchlistItems() {
    return [...state.watchlist]
      .map((key) => state.itemMap.get(key) || state.watchItems.get(key))
      .filter(Boolean);
  }

  function addItem(item, dataset) {
    const list = state.datasets[dataset];
    if (!list.some((existing) => existing.key === item.key)) list.push(item);
    state.itemMap.set(item.key, item);
  }

  function normalizeVidItem(item, kind, index = 0) {
    if (kind === "episodes") {
      const normalized = {
        ...item,
        kind: "episode",
        title: item.episode_title || `Episode ${item.episode_number || ""}`.trim(),
        showTitle: item.show_title || "Untitled Show",
        show_tmdb_id: item.show_tmdb_id ? String(item.show_tmdb_id) : "",
        show_imdb_id: item.show_imdb_id ? String(item.show_imdb_id) : "",
        season: Number(item.season_number) || 1,
        episode: Number(item.episode_number) || 1,
        year: getYear(item.air_date),
        poster_url: "",
        _index: index,
      };
      normalized.key = getItemKey(normalized);
      normalized.search = normalizeText(`${normalized.showTitle} ${normalized.title}`);
      return normalized;
    }

    const normalized = {
      ...item,
      kind: kind === "movies" ? "movie" : "tv",
      title: item.title || "Untitled",
      tmdb_id: item.tmdb_id ? String(item.tmdb_id) : "",
      imdb_id: item.imdb_id ? String(item.imdb_id) : "",
      year: item.year ? String(item.year) : "",
      poster_url: item.poster_url || "",
      genre: item.genre || "",
      rating: item.rating || "",
      popularity: item.popularity || "",
      _index: index,
    };
    normalized.key = getItemKey(normalized);
    normalized.search = normalizeText(`${normalized.title} ${normalized.year} ${normalized.genre} ${normalized.imdb_id} ${normalized.tmdb_id}`);
    return normalized;
  }

  function normalizeStoredItem(item) {
    const normalized = {
      ...item,
      tmdb_id: item.tmdb_id ? String(item.tmdb_id) : "",
      imdb_id: item.imdb_id ? String(item.imdb_id) : "",
      key: item.key || getItemKey(item),
      search: item.search || normalizeText(`${item.title} ${item.year || ""} ${item.genre || ""}`),
    };
    return normalized;
  }

  function normalizeStoredEpisode(show, episode, index) {
    const normalized = {
      ...episode,
      kind: "episode",
      showTitle: episode.showTitle || episode.show_title || show.title || "TV Show",
      show_tmdb_id: episode.show_tmdb_id ? String(episode.show_tmdb_id) : show.tmdb_id || "",
      show_imdb_id: episode.show_imdb_id ? String(episode.show_imdb_id) : show.imdb_id || "",
      tmdb_id: episode.show_tmdb_id ? String(episode.show_tmdb_id) : show.tmdb_id || "",
      imdb_id: episode.show_imdb_id ? String(episode.show_imdb_id) : show.imdb_id || "",
      title: episode.title || episode.episode_title || `Episode ${episode.episode || episode.episode_number || index + 1}`,
      season: Number(episode.season || episode.season_number) || 1,
      episode: Number(episode.episode || episode.episode_number) || index + 1,
      poster_url: episode.poster_url || show.backdrop_url || show.poster_url || "",
    };
    normalized.key = episode.key || getItemKey(normalized);
    normalized.embed_url = episode.embed_url || getEmbedUrl(normalized);
    return normalized;
  }

  function snapshotItem(item) {
    return {
      ...item,
      key: item.key || getItemKey(item),
      embed_url: item.embed_url || getEmbedUrl(item),
      progressKey: undefined,
      embedUrl: undefined,
    };
  }

  function openManualItem() {
    const type = els.manualType.value;
    const id = els.manualId.value.trim();
    const cleanId = /^tt/i.test(id) ? id.toLowerCase() : id;
    const season = Math.max(1, Number(els.manualSeason.value) || 1);
    const episode = Math.max(1, Number(els.manualEpisode.value) || 1);
    if (!/^(tt\d+|\d+)$/i.test(cleanId)) {
      toast("Enter a valid IMDB or TMDB ID.");
      return;
    }

    const item = type === "movie"
      ? {
          kind: "movie",
          title: `Movie ${cleanId}`,
          imdb_id: cleanId.startsWith("tt") ? cleanId : "",
          tmdb_id: cleanId.startsWith("tt") ? "" : cleanId,
          embed_url: `${PLAYER_BASE}/embed/movie/${encodeURIComponent(cleanId)}`,
        }
      : {
          kind: "episode",
          title: `Episode ${episode}`,
          showTitle: `TV ${cleanId}`,
          show_imdb_id: cleanId.startsWith("tt") ? cleanId : "",
          show_tmdb_id: cleanId.startsWith("tt") ? "" : cleanId,
          season,
          episode,
          embed_url: `${PLAYER_BASE}/embed/tv/${encodeURIComponent(cleanId)}/${season}/${episode}`,
        };
    item.key = getItemKey(item);
    state.itemMap.set(item.key, item);
    selectItem(item, true);
  }

  function syncManualFields() {
    const isMovie = els.manualType.value === "movie";
    els.manualSeason.disabled = isMovie;
    els.manualEpisode.disabled = isMovie;
  }

  function readSubtitleForm() {
    state.subtitles = {
      lang: els.subtitleLang.value,
      url: els.subtitleUrl.value.trim(),
      label: els.subtitleLabel.value || "Custom",
      code: els.subtitleCode.value || els.subtitleLang.value,
      isDefault: els.subtitleDefault.checked,
      color: els.playerColor.value || "#4fc3b1",
    };
  }

  function syncSubtitleForm() {
    els.subtitleLang.value = state.subtitles.lang;
    els.subtitleUrl.value = state.subtitles.url;
    els.subtitleLabel.value = state.subtitles.label;
    els.subtitleCode.value = state.subtitles.code;
    els.subtitleDefault.checked = state.subtitles.isDefault;
    els.playerColor.value = state.subtitles.color;
    applyAccentColor();
  }

  function storeSubtitleState() {
    localStorage.setItem(STORAGE.subtitles, JSON.stringify(state.subtitles));
  }

  function applyAccentColor() {
    document.documentElement.style.setProperty("--accent", state.subtitles.color || "#4fc3b1");
  }

  function getEmbedUrl(item) {
    if (item.embed_url) return item.embed_url;
    if (item.kind === "movie") {
      const id = item.imdb_id || item.tmdb_id;
      return `${PLAYER_BASE}/embed/movie/${encodeURIComponent(id)}`;
    }
    const id = getShowId(item);
    return `${PLAYER_BASE}/embed/tv/${encodeURIComponent(id)}/${item.season || 1}/${item.episode || 1}`;
  }

  function getItemKey(item) {
    if (item.kind === "episode") {
      const id = getShowId(item);
      return `episode:${id}:${item.season || item.season_number || 1}:${item.episode || item.episode_number || 1}`;
    }
    return `${item.kind}:${item.imdb_id || item.tmdb_id || normalizeTitle(item.title)}`;
  }

  function getShowId(item) {
    return String(item.show_imdb_id || item.show_tmdb_id || item.imdb_id || item.tmdb_id || normalizeTitle(item.showTitle || item.title || ""));
  }

  function getShowIdCandidates(item) {
    const ids = [
      item?.show_imdb_id,
      item?.show_tmdb_id,
      item?.imdb_id,
      item?.tmdb_id,
      normalizeTitle(item?.showTitle || item?.title || ""),
    ];
    return [...new Set(ids.map((id) => String(id || "").trim()).filter(Boolean))];
  }

  function getCachedShowEpisodes(show) {
    const ids = getShowIdCandidates(show);
    for (const id of ids) {
      const episodes = state.db.episodeCache.get(id);
      if (episodes?.length) return episodes;
    }
    return [];
  }

  function getProgressKey(item) {
    if (item.kind === "episode") return `${STORAGE.progress}${getItemKey(item)}`;
    return `${STORAGE.progress}${item.kind}:${item.imdb_id || item.tmdb_id || normalizeTitle(item.title)}`;
  }

  function getContinueKey(item) {
    if (item.kind === "episode") return getItemKey(item);
    return `movie:${item.imdb_id || item.tmdb_id || normalizeTitle(item.title)}`;
  }

  function getContinueShowKey(item) {
    return `show:${getShowId(item)}`;
  }

  function getShowProgress(show) {
    if (!show) return null;
    return state.continueItems.get(`show:${getShowId(show)}`);
  }

  function getSavedProgressForItem(item) {
    const entry = state.continueItems.get(getContinueKey(item));
    return {
      progress: entry?.progress || Number(localStorage.getItem(getProgressKey(item))) || 0,
      duration: entry?.duration || 0,
    };
  }

  function getDisplayTitle(item) {
    if (item.kind === "episode") return `${item.showTitle || "TV Show"}: ${item.title || `Episode ${item.episode}`}`;
    return item.title || "Untitled";
  }

  function getTypeLabel(item) {
    if (item.kind === "movie") return "Movie";
    if (item.kind === "tv") return "TV Show";
    return `S${String(item.season || 1).padStart(2, "0")} E${String(item.episode || 1).padStart(2, "0")}`;
  }

  function getMetaLine(item) {
    if (item.kind === "episode") {
      const date = item.air_date ? ` • ${item.air_date}` : "";
      return `Season ${item.season || 1}, Episode ${item.episode || 1}${date}`;
    }
    const parts = [];
    if (item.year) parts.push(item.year);
    if (toNumber(item.rating) > 0) parts.push(`Rating ${item.rating}`);
    if (item.genre) parts.push(item.genre);
    return parts.join(" • ") || "Details unavailable";
  }

  function getTags(item) {
    if (item.kind === "episode") {
      return [`S${String(item.season || 1).padStart(2, "0")}`, `E${String(item.episode || 1).padStart(2, "0")}`];
    }
    return [item.kind === "movie" ? "Movie" : "TV", ...splitGenres(item.genre).slice(0, 2)];
  }

  function getCategories(item) {
    if (item.kind === "episode") return [item.showTitle || "Episodes"];
    const genres = splitGenres(item.genre);
    return genres.length ? genres : ["Uncategorized"];
  }

  function splitGenres(value = "") {
    return String(value).split(",").map((genre) => genre.trim()).filter(Boolean);
  }

  function selectOpeningTitle() {
    if (state.selected) return;
    const first = state.datasets.latest.find((item) => item.poster_url) || state.datasets.latest[0];
    if (first) selectItem(first, false);
  }

  async function fetchJSON(url, cacheKey, options = {}) {
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      if (options.cacheLocal !== false) safeSetLocalJSON(STORAGE.cache + cacheKey, data);
      return data;
    } catch (error) {
      if (options.cacheLocal !== false) {
        const cached = parseStoredJSON(STORAGE.cache + cacheKey, null);
        if (cached) return cached;
      }
      throw error;
    }
  }

  function castSelected() {
    toast("VidAPI is an iframe player. For Chromecast, use Chrome's Cast tab or add a direct HLS/MP4 provider.");
  }

  async function copyToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
      toast("Embed link copied.");
    } catch {
      toast("Could not copy link.");
    }
  }

  function toast(message) {
    let node = document.querySelector(".toast");
    if (!node) {
      node = document.createElement("div");
      node.className = "toast";
      document.body.appendChild(node);
    }
    node.textContent = message;
    node.classList.add("is-visible");
    window.clearTimeout(state.toastTimer);
    state.toastTimer = window.setTimeout(() => node.classList.remove("is-visible"), 2600);
  }

  function parseStoredJSON(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  }

  function safeSetLocalJSON(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Project DB shards handle large data; browser cache is optional.
    }
  }

  function normalizeText(value = "") {
    return String(value)
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/&/g, " and ")
      .replace(/[^a-z0-9]+/g, " ")
      .trim()
      .replace(/\s+/g, " ");
  }

  function normalizeTitle(value = "") {
    return normalizeText(value).replace(/\s+/g, "-");
  }

  function shardName(value = "") {
    const text = normalizeText(value).replace(/[^a-z0-9]/g, "");
    return text ? text.slice(0, 2).padEnd(2, "_") : "misc";
  }

  function episodeBucket(showId = "") {
    const id = String(showId).toLowerCase().replace(/[^a-z0-9]/g, "");
    return id ? id.slice(0, 2).padEnd(2, "_") : "misc";
  }

  function levenshtein(a, b) {
    const matrix = Array.from({ length: b.length + 1 }, (_, i) => [i]);
    for (let j = 0; j <= a.length; j += 1) matrix[0][j] = j;
    for (let i = 1; i <= b.length; i += 1) {
      for (let j = 1; j <= a.length; j += 1) {
        matrix[i][j] = b[i - 1] === a[j - 1]
          ? matrix[i - 1][j - 1]
          : Math.min(matrix[i - 1][j - 1] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j] + 1);
      }
    }
    return matrix[b.length][a.length];
  }

  function isCloseToken(word, query) {
    if (word.length < 4 || query.length < 4) return false;
    return levenshtein(word, query) <= (query.length > 6 ? 2 : 1);
  }

  function compactNumber(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return "...";
    if (number === 0) return "0";
    return new Intl.NumberFormat(undefined, {
      notation: "compact",
      maximumFractionDigits: 1,
    }).format(number);
  }

  function formatTime(seconds) {
    const safe = Math.max(0, Number(seconds) || 0);
    const h = Math.floor(safe / 3600);
    const m = Math.floor((safe % 3600) / 60);
    const s = Math.floor(safe % 60);
    return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
  }

  function getYear(value = "") {
    const match = String(value).match(/\d{4}/);
    return match ? match[0] : "";
  }

  function toNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
  }

  function getInitials(title) {
    return String(title)
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((word) => word[0])
      .join("")
      .toUpperCase();
  }

  function escapeHTML(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function renderIcons() {
    if (window.lucide) window.lucide.createIcons();
  }
})();
