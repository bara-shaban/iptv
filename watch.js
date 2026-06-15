(() => {
  const PLAYER_BASE = "https://vaplayer.ru";
  const DB_BASE = "data/catalog";
  const STORAGE = {
    continueItems: "streamline:continueItems",
    watchSession: "streamline:watchSession",
    progress: "streamline:progress:",
  };

  const els = {};
  let session = readSession();
  let episodes = [];
  let activeSeason = 1;
  let sourceCandidates = [];
  let sourceIndex = 0;

  document.addEventListener("DOMContentLoaded", init);

  async function init() {
    Object.assign(els, {
      frame: document.querySelector("#watchFrame"),
      empty: document.querySelector("#watchEmpty"),
      title: document.querySelector("#watchTitle"),
      type: document.querySelector("#watchType"),
      episodeToggle: document.querySelector("#watchEpisodeToggle"),
      sourceToggle: document.querySelector("#watchSourceToggle"),
      retry: document.querySelector("#watchRetry"),
      episodePanel: document.querySelector("#episodePanel"),
      closeEpisodePanel: document.querySelector("#closeEpisodePanel"),
      episodePanelTitle: document.querySelector("#episodePanelTitle"),
      seasonTabs: document.querySelector("#watchSeasonTabs"),
      episodeList: document.querySelector("#watchEpisodeList"),
      manualEpisodeJump: document.querySelector("#manualEpisodeJump"),
      manualSeason: document.querySelector("#watchSeasonInput"),
      manualEpisode: document.querySelector("#watchEpisodeInput"),
    });

    bindEvents();

    if (!session?.playable || !session?.url) {
      els.frame.hidden = true;
      els.empty.hidden = false;
      return;
    }

    setCurrentItem(session.playable, session.url);
    if (session.playable.kind === "episode") {
      els.episodeToggle.hidden = false;
      episodes = normalizeEpisodes(session.episodes || [], session.playable);
      if (!episodes.length) episodes = await loadEpisodes(session.playable);
      activeSeason = Number(session.playable.season) || episodes[0]?.season || 1;
      session.episodes = episodes.map((episode) => snapshotItem(episode));
      writeSession();
      renderEpisodePanel();
    }
    window.addEventListener("message", handlePlayerMessage);
  }

  function bindEvents() {
    els.episodeToggle.addEventListener("click", toggleEpisodePanel);
    els.closeEpisodePanel.addEventListener("click", closeEpisodePanel);
    els.sourceToggle.addEventListener("click", cycleSource);
    els.retry.addEventListener("click", retryPlayback);
    els.seasonTabs.addEventListener("click", (event) => {
      const button = event.target.closest("[data-season]");
      if (!button) return;
      activeSeason = Number(button.dataset.season) || 1;
      renderEpisodePanel();
    });
    els.episodeList.addEventListener("click", (event) => {
      const button = event.target.closest("[data-key]");
      if (!button) return;
      const episode = episodes.find((item) => item.key === button.dataset.key);
      if (episode) switchEpisode(episode);
    });
    els.manualEpisodeJump.addEventListener("submit", (event) => {
      event.preventDefault();
      const season = Math.max(1, Number(els.manualSeason.value) || 1);
      const episode = Math.max(1, Number(els.manualEpisode.value) || 1);
      switchEpisode(makeEpisodeItem(session.show || session.selected || session.playable, season, episode));
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !els.episodePanel.hidden) closeEpisodePanel();
    });
  }

  function setCurrentItem(item, url = buildPlayerUrl(item)) {
    session.playable = snapshotItem(item);
    session.url = url;
    document.title = `${getDisplayTitle(item)} - Bara Al-Wa7sh`;
    els.title.textContent = getDisplayTitle(item);
    els.type.textContent = getTypeLabel(item);
    els.frame.src = url;
    sourceCandidates = buildSourceCandidates(item);
    sourceIndex = getSourceIndex(url, sourceCandidates);
    syncSourceToggle();
    writeSession();
  }

  function toggleEpisodePanel() {
    const shouldOpen = els.episodePanel.hidden;
    els.episodePanel.hidden = !shouldOpen;
    els.episodeToggle.classList.toggle("is-active", shouldOpen);
  }

  function closeEpisodePanel() {
    els.episodePanel.hidden = true;
    els.episodeToggle.classList.remove("is-active");
  }

  function renderEpisodePanel() {
    const current = session.playable;
    els.episodePanelTitle.textContent = session.show?.title || current.showTitle || "TV Show";
    els.manualSeason.value = String(current.season || activeSeason || 1);
    els.manualEpisode.value = String(current.episode || 1);

    const seasons = [...new Set(episodes.map((episode) => Number(episode.season)).filter(Boolean))]
      .sort((a, b) => a - b);
    els.seasonTabs.replaceChildren(...seasons.map((season) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `watch-season-tab${season === activeSeason ? " is-active" : ""}`;
      button.dataset.season = String(season);
      button.textContent = `Season ${season}`;
      return button;
    }));

    const selectedEpisodes = episodes
      .filter((episode) => Number(episode.season) === Number(activeSeason))
      .sort((a, b) => a.episode - b.episode);

    if (!selectedEpisodes.length) {
      els.episodeList.innerHTML = `<div class="episode-empty">No local episode list for this show yet.</div>`;
      els.manualEpisodeJump.hidden = false;
      return;
    }

    els.manualEpisodeJump.hidden = true;
    els.episodeList.replaceChildren(...selectedEpisodes.map((episode) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `watch-episode-row${episode.key === current.key ? " is-active" : ""}`;
      button.dataset.key = episode.key;
      button.innerHTML = `
        <span class="watch-episode-number">E${String(episode.episode).padStart(2, "0")}</span>
        <span class="watch-episode-copy">
          <strong>${escapeHTML(episode.title || `Episode ${episode.episode}`)}</strong>
          <small>Season ${episode.season || 1} • Episode ${episode.episode || 1}</small>
        </span>
      `;
      return button;
    }));
  }

  function switchEpisode(episode) {
    activeSeason = Number(episode.season) || activeSeason || 1;
    setCurrentItem(episode, buildPlayerUrl(episode));
    renderEpisodePanel();
  }

  function cycleSource() {
    if (sourceCandidates.length < 2) return;
    sourceIndex = (sourceIndex + 1) % sourceCandidates.length;
    const candidate = sourceCandidates[sourceIndex];
    setCurrentItem(session.playable, buildPlayerUrl(session.playable, candidate.id));
  }

  function retryPlayback() {
    if (!session?.url) return;
    els.frame.src = session.url;
  }

  function syncSourceToggle() {
    els.sourceToggle.hidden = sourceCandidates.length < 2;
    if (sourceCandidates.length < 2) return;
    const next = sourceCandidates[(sourceIndex + 1) % sourceCandidates.length];
    els.sourceToggle.textContent = `Try ${next.label}`;
  }

  async function loadEpisodes(item) {
    for (const showId of getShowIdCandidates(item)) {
      try {
        const response = await fetch(`${DB_BASE}/episodes/${episodeBucket(showId)}/${encodeURIComponent(showId)}.json`);
        if (!response.ok) continue;
        const data = await response.json();
        const normalized = normalizeEpisodes(data.episodes || data || [], item);
        if (normalized.length) return normalized;
      } catch {
        // A missing local show file should not prevent manual episode jumping.
      }
    }
    return [];
  }

  function normalizeEpisodes(items, fallback) {
    return (Array.isArray(items) ? items : []).map((episode, index) => {
      const normalized = {
        ...episode,
        kind: "episode",
        showTitle: episode.showTitle || episode.show_title || session.show?.title || fallback.showTitle || "TV Show",
        show_tmdb_id: String(episode.show_tmdb_id || session.show?.tmdb_id || fallback.show_tmdb_id || fallback.tmdb_id || ""),
        show_imdb_id: String(episode.show_imdb_id || session.show?.imdb_id || fallback.show_imdb_id || fallback.imdb_id || ""),
        tmdb_id: String(episode.show_tmdb_id || session.show?.tmdb_id || fallback.show_tmdb_id || fallback.tmdb_id || ""),
        imdb_id: String(episode.show_imdb_id || session.show?.imdb_id || fallback.show_imdb_id || fallback.imdb_id || ""),
        title: episode.title || episode.episode_title || `Episode ${episode.episode || episode.episode_number || index + 1}`,
        season: Number(episode.season || episode.season_number) || 1,
        episode: Number(episode.episode || episode.episode_number) || index + 1,
        poster_url: episode.poster_url || session.show?.backdrop_url || session.show?.poster_url || fallback.poster_url || "",
      };
      normalized.key = episode.key || getItemKey(normalized);
      normalized.embed_url = episode.embed_url || getEmbedUrl(normalized);
      return normalized;
    });
  }

  function makeEpisodeItem(show, season, episode) {
    const item = {
      kind: "episode",
      title: `Episode ${episode}`,
      showTitle: show?.title || show?.showTitle || "TV Show",
      show_tmdb_id: String(show?.tmdb_id || show?.show_tmdb_id || ""),
      show_imdb_id: String(show?.imdb_id || show?.show_imdb_id || ""),
      tmdb_id: String(show?.tmdb_id || show?.show_tmdb_id || ""),
      imdb_id: String(show?.imdb_id || show?.show_imdb_id || ""),
      season,
      episode,
      poster_url: show?.backdrop_url || show?.poster_url || "",
    };
    item.key = getItemKey(item);
    item.embed_url = getEmbedUrl(item);
    return item;
  }

  function buildPlayerUrl(item, sourceId = "") {
    const url = new URL(getEmbedUrl(item, sourceId));
    const inherited = session?.url ? new URL(session.url) : null;
    inherited?.searchParams.forEach((value, key) => {
      if (!["title", "resumeAt", "poster"].includes(key)) url.searchParams.set(key, value);
    });
    const progress = getSavedProgressForItem(item);
    url.searchParams.set("title", getDisplayTitle(item));
    url.searchParams.set("showTitle", "true");
    if (item.poster_url) url.searchParams.set("poster", item.poster_url);
    if (progress > 15) url.searchParams.set("resumeAt", String(Math.floor(progress)));
    return url.toString();
  }

  function buildSourceCandidates(item) {
    const ids = [
      getSourceIdFromUrl(item.embed_url || ""),
      item.kind === "episode" ? item.show_imdb_id : item.imdb_id,
      item.kind === "episode" ? item.show_tmdb_id : item.tmdb_id,
      item.imdb_id,
      item.tmdb_id,
    ];
    const unique = [...new Set(ids.map((id) => String(id || "").trim()).filter(Boolean))];
    return unique.map((id) => ({
      id,
      label: id.startsWith("tt") ? "IMDb" : "TMDB",
    }));
  }

  function getSourceIndex(url, candidates) {
    const currentId = getSourceIdFromUrl(url);
    const index = candidates.findIndex((candidate) => candidate.id === currentId);
    return index >= 0 ? index : 0;
  }

  function getSourceIdFromUrl(value) {
    if (!value) return "";
    try {
      const parts = new URL(value).pathname.split("/").filter(Boolean);
      const embedIndex = parts.indexOf("embed");
      return embedIndex >= 0 ? String(parts[embedIndex + 2] || "") : "";
    } catch {
      return "";
    }
  }

  function getEmbedUrl(item, sourceId = "") {
    const id = sourceId || (item.kind === "episode"
      ? getShowId(item)
      : item.imdb_id || item.tmdb_id);
    if (!sourceId && item.embed_url) return item.embed_url;
    if (item.kind === "movie") return `${PLAYER_BASE}/embed/movie/${encodeURIComponent(id)}`;
    return `${PLAYER_BASE}/embed/tv/${encodeURIComponent(id)}/${item.season || 1}/${item.episode || 1}`;
  }

  function readSession() {
    try {
      return JSON.parse(sessionStorage.getItem(STORAGE.watchSession) || "null");
    } catch {
      return null;
    }
  }

  function writeSession() {
    sessionStorage.setItem(STORAGE.watchSession, JSON.stringify({
      ...session,
      playable: snapshotItem(session.playable),
      episodes: episodes.map((episode) => snapshotItem(episode)),
      storedAt: Date.now(),
    }));
  }

  function handlePlayerMessage(event) {
    if (!String(event.origin || "").includes("vaplayer.ru")) return;
    if (!event.data || event.data.type !== "PLAYER_EVENT") return;
    const data = event.data.data || {};
    const progress = Number(data.player_progress) || 0;
    const duration = Number(data.player_duration) || 0;
    if (progress > 0) saveContinueProgress(progress, duration);
  }

  function saveContinueProgress(progress, duration) {
    const item = session.playable;
    const entry = {
      key: getContinueKey(item),
      item: snapshotItem(item),
      progress,
      duration,
      updatedAt: Date.now(),
    };
    const items = parseStoredJSON(localStorage.getItem(STORAGE.continueItems), {});
    items[entry.key] = entry;
    if (item.kind === "episode") {
      items[getContinueShowKey(item)] = { ...entry, key: getContinueShowKey(item) };
    }
    localStorage.setItem(STORAGE.continueItems, JSON.stringify(items));
    localStorage.setItem(getProgressKey(item), String(progress));
  }

  function snapshotItem(item) {
    return {
      ...item,
      key: item.key || getItemKey(item),
      progressKey: undefined,
      embedUrl: undefined,
    };
  }

  function parseStoredJSON(raw, fallback) {
    try {
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  }

  function getSavedProgressForItem(item) {
    return Number(localStorage.getItem(getProgressKey(item))) || 0;
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

  function getItemKey(item) {
    if (item.kind === "episode") {
      return `episode:${getShowId(item)}:${item.season || 1}:${item.episode || 1}`;
    }
    return `${item.kind}:${item.imdb_id || item.tmdb_id || normalizeTitle(item.title)}`;
  }

  function getShowId(item) {
    return String(item.show_imdb_id || item.show_tmdb_id || item.imdb_id || item.tmdb_id || normalizeTitle(item.showTitle || item.title || ""));
  }

  function getShowIdCandidates(item) {
    return [...new Set([
      item?.show_imdb_id,
      item?.show_tmdb_id,
      item?.imdb_id,
      item?.tmdb_id,
      normalizeTitle(item?.showTitle || item?.title || ""),
    ].map((id) => String(id || "").trim()).filter(Boolean))];
  }

  function episodeBucket(showId) {
    return String(showId || "misc").slice(0, 2).toLowerCase() || "misc";
  }

  function normalizeTitle(value = "") {
    return String(value).trim().toLowerCase().replace(/\s+/g, "-");
  }

  function escapeHTML(value = "") {
    return String(value).replace(/[&<>"']/g, (char) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[char]));
  }
})();
