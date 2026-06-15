(() => {
  const PLAYER_BASE = "https://vaplayer.ru";
  const DB_BASE = "data/catalog";
  const STORAGE = {
    continueItems: "streamline:continueItems",
    watchSession: "streamline:watchSession",
    progress: "streamline:progress:",
  };
  const NEXT_PROMPT_SECONDS = 60;
  const NEXT_PROMPT_RATIO = 0.88;
  const MIN_VISIBLE_NEXT_FILL = 6;
  const AUTO_ADVANCE_COOLDOWN_MS = 5000;
  const DIRECT_SOURCE_TIMEOUT_MS = 9000;

  const els = {};
  let session = readSession();
  let episodes = [];
  let activeSeason = 1;
  let sourceCandidates = [];
  let sourceIndex = 0;
  let autoAdvanceKey = "";
  let autoAdvanceCooldownUntil = 0;
  let hlsPlayer = null;
  let videoResetUntil = 0;
  let directSourceTimer = null;
  let chromeCastAvailable = false;
  let chromeCastContext = null;

  window.__onGCastApiAvailable = (isAvailable) => {
    chromeCastAvailable = Boolean(isAvailable);
    configureChromeCast();
  };

  document.addEventListener("DOMContentLoaded", init);

  async function init() {
    Object.assign(els, {
      frame: document.querySelector("#watchFrame"),
      video: document.querySelector("#watchVideo"),
      status: document.querySelector("#watchStatus"),
      empty: document.querySelector("#watchEmpty"),
      emptyTitle: document.querySelector("#watchEmptyTitle"),
      emptyCopy: document.querySelector("#watchEmptyCopy"),
      title: document.querySelector("#watchTitle"),
      type: document.querySelector("#watchType"),
      episodeToggle: document.querySelector("#watchEpisodeToggle"),
      nextButton: document.querySelector("#watchNextEpisode"),
      directToggle: document.querySelector("#watchDirectToggle"),
      castButton: document.querySelector("#watchCast"),
      pipButton: document.querySelector("#watchPip"),
      sourceToggle: document.querySelector("#watchSourceToggle"),
      retry: document.querySelector("#watchRetry"),
      directPanel: document.querySelector("#directSourcePanel"),
      closeDirectPanel: document.querySelector("#closeDirectSourcePanel"),
      directForm: document.querySelector("#directSourceForm"),
      directInput: document.querySelector("#directSourceInput"),
      useIframeSource: document.querySelector("#useIframeSource"),
      episodePanel: document.querySelector("#episodePanel"),
      closeEpisodePanel: document.querySelector("#closeEpisodePanel"),
      episodePanelTitle: document.querySelector("#episodePanelTitle"),
      seasonTabs: document.querySelector("#watchSeasonTabs"),
      episodeList: document.querySelector("#watchEpisodeList"),
      manualEpisodeJump: document.querySelector("#manualEpisodeJump"),
      manualSeason: document.querySelector("#watchSeasonInput"),
      manualEpisode: document.querySelector("#watchEpisodeInput"),
      nextCard: document.querySelector("#nextEpisodeCard"),
      nextTitle: document.querySelector("#nextEpisodeTitle"),
      nextMeta: document.querySelector("#nextEpisodeMeta"),
      nextProgress: document.querySelector("#nextEpisodeProgress"),
      nextButtonProgress: document.querySelector("#watchNextProgress"),
      nextNow: document.querySelector("#nextEpisodeNow"),
    });

    bindEvents();
    configureChromeCast();

    const querySession = getDirectSessionFromQuery();
    if (querySession) {
      session = querySession;
    }

    if (!session?.playable || !session?.url) {
      showEmptyState("No video selected", "Choose a movie or episode from the browse page.");
      return;
    }

    await setInitialPlayback(session.playable, session.url);
    if (session.playable.kind === "episode") {
      els.episodeToggle.hidden = false;
      episodes = normalizeEpisodes(session.episodes || [], session.playable);
      if (!episodes.length) episodes = await loadEpisodes(session.playable);
      activeSeason = Number(session.playable.season) || episodes[0]?.season || 1;
      session.episodes = episodes.map((episode) => snapshotItem(episode));
      writeSession();
      renderEpisodePanel();
      syncNextButton();
    }
    window.addEventListener("message", handlePlayerMessage);
  }

  function bindEvents() {
    els.episodeToggle?.addEventListener("click", toggleEpisodePanel);
    els.closeEpisodePanel?.addEventListener("click", closeEpisodePanel);
    els.nextButton?.addEventListener("click", playNextEpisodeNow);
    els.nextNow?.addEventListener("click", playNextEpisodeNow);
    els.directToggle?.addEventListener("click", toggleDirectPanel);
    els.closeDirectPanel?.addEventListener("click", closeDirectPanel);
    els.directForm?.addEventListener("submit", (event) => {
      event.preventDefault();
      openDirectSourceFromForm();
    });
    els.useIframeSource?.addEventListener("click", useIframePlayback);
    els.castButton?.addEventListener("click", castCurrentVideo);
    els.pipButton?.addEventListener("click", togglePictureInPicture);
    els.sourceToggle?.addEventListener("click", cycleSource);
    els.retry?.addEventListener("click", retryPlayback);
    els.video?.addEventListener("timeupdate", handleVideoTimeUpdate);
    els.video?.addEventListener("ended", handleVideoEnded);
    els.video?.addEventListener("error", handleVideoError);
    els.video?.addEventListener("loadedmetadata", () => showWatchStatus("Video ready. Press play if it does not start."));
    els.video?.addEventListener("playing", hideWatchStatus);
    els.seasonTabs?.addEventListener("click", (event) => {
      const button = event.target.closest("[data-season]");
      if (!button) return;
      activeSeason = Number(button.dataset.season) || 1;
      renderEpisodePanel();
    });
    els.episodeList?.addEventListener("click", (event) => {
      const button = event.target.closest("[data-key]");
      if (!button) return;
      const episode = episodes.find((item) => item.key === button.dataset.key);
      if (episode) switchEpisode(episode);
    });
    els.manualEpisodeJump?.addEventListener("submit", (event) => {
      event.preventDefault();
      const season = Math.max(1, Number(els.manualSeason.value) || 1);
      const episode = Math.max(1, Number(els.manualEpisode.value) || 1);
      switchEpisode(makeEpisodeItem(session.show || session.selected || session.playable, season, episode));
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !els.episodePanel.hidden) closeEpisodePanel();
      if (event.key === "Escape" && !els.directPanel.hidden) closeDirectPanel();
    });
  }

  async function setInitialPlayback(item, url = buildPlayerUrl(item)) {
    if (session?.sourceMode === "direct" || isDirectMediaUrl(url)) {
      setCurrentItem(item, url, { mode: "direct" });
      return;
    }

    await setPreferredCurrentItem(item, url);
  }

  async function setPreferredCurrentItem(item, fallbackUrl = buildPlayerUrl(item)) {
    const directSource = await resolvePreferredDirectSource(item, fallbackUrl);
    if (directSource?.playbackUrl) {
      setCurrentItem(item, directSource.playbackUrl, {
        mode: "direct",
        resolvedSourceUrl: directSource.sourceUrl,
      });
      return;
    }

    prepareIframeFallback(item, fallbackUrl, directSource?.error || "The backend did not return a playable direct stream.");
  }

  function setCurrentItem(item, url = buildPlayerUrl(item), options = {}) {
    const previousKey = session?.playable ? getItemKey(session.playable) : "";
    const mode = options.mode || (isDirectMediaUrl(url) ? "direct" : "iframe");
    session.playable = snapshotItem(item);
    session.url = url;
    session.sourceMode = mode;
    if (mode === "direct") {
      session.directSourceUrl = url;
      session.resolvedSourceUrl = options.resolvedSourceUrl || getUnproxiedSourceUrl(url) || url;
    } else {
      delete session.directSourceUrl;
      delete session.resolvedSourceUrl;
    }
    if (previousKey !== getItemKey(item)) autoAdvanceKey = "";
    hideNextPrompt();
    setNextProgressFill(0);
    document.title = `${getDisplayTitle(item)} - Bara Al-Wa7sh`;
    els.title.textContent = getDisplayTitle(item);
    els.type.textContent = getTypeLabel(item);
    applyPlaybackSurface(item, url, mode);
    sourceCandidates = buildSourceCandidates(item);
    sourceIndex = getSourceIndex(url, sourceCandidates);
    syncDirectPanel();
    syncCastButtons();
    syncSourceToggle();
    syncNextButton();
    writeSession();
  }

  function applyPlaybackSurface(item, url, mode) {
    els.empty.hidden = true;
    if (mode === "direct") {
      if (els.frame.src !== "about:blank") els.frame.src = "about:blank";
      els.frame.hidden = true;
      setVideoSource(item, url);
      return;
    }

    clearVideoSource();
    hideWatchStatus();
    els.video.hidden = true;
    els.frame.hidden = false;
    els.frame.src = url;
  }

  function setVideoSource(item, url) {
    clearVideoSource();
    els.video.hidden = false;
    els.video.poster = item.poster_url || "";
    showWatchStatus(isHlsUrl(url) ? "Loading HLS stream..." : "Loading video...", true);
    if (isHlsUrl(url)) {
      if (!isSafariBrowser() && window.Hls?.isSupported()) {
        attachHlsSource(url);
        return;
      }

      if (canPlayNativeHls()) {
        els.video.src = url;
        els.video.load();
        startDirectSourceTimer("This HLS stream is not starting. The source may block direct browser playback.");
        playDirectVideo();
        syncCastButtons();
        return;
      }

      if (window.Hls?.isSupported()) {
        attachHlsSource(url);
        return;
      }

      showDirectError("HLS.js did not load. Check your connection or try Safari.");
      return;
    }

    els.video.src = url;
    els.video.load();
    startDirectSourceTimer("The video is taking too long to start.");
    playDirectVideo();
    syncCastButtons();
  }

  function attachHlsSource(url) {
    let recoveredMediaError = false;
    hlsPlayer = new window.Hls({
      enableWorker: true,
      lowLatencyMode: false,
      xhrSetup(xhr, url) {
        xhr.withCredentials = false;
        addBackendRequestHeaders(xhr, url);
      },
    });
    hlsPlayer.on(window.Hls.Events.MEDIA_ATTACHED, () => {
      showWatchStatus("Loading HLS playlist...", true);
      startDirectSourceTimer("The HLS playlist or video segments are blocked by the source server.");
      hlsPlayer.loadSource(url);
    });
    hlsPlayer.on(window.Hls.Events.MANIFEST_PARSED, () => {
      clearDirectSourceTimer();
      showWatchStatus("Loading video segments...", true);
      startDirectSourceTimer("The HLS playlist loaded, but the video segments are blocked or too slow.");
      playDirectVideo();
      syncCastButtons();
    });
    hlsPlayer.on(window.Hls.Events.FRAG_LOADED, () => {
      clearDirectSourceTimer();
      hideWatchStatus();
    });
    hlsPlayer.on(window.Hls.Events.ERROR, (_event, data) => {
      const detail = data?.details || data?.type || "stream failed";
      if (!data?.fatal) {
        if (data?.type === window.Hls.ErrorTypes.NETWORK_ERROR) {
          showWatchStatus(describeHlsError(data), true);
        }
        return;
      }
      if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR && !recoveredMediaError) {
        recoveredMediaError = true;
        showWatchStatus("Media hiccup. Recovering stream...", true);
        startDirectSourceTimer("The stream could not recover in this browser.");
        hlsPlayer.recoverMediaError();
        return;
      }
      clearDirectSourceTimer();
      showDirectError(describeHlsError(data));
    });
    hlsPlayer.attachMedia(els.video);
  }

  function describeHlsError(data = {}) {
    const detail = data.details || data.type || "stream failed";
    const code = data.response?.code || data.response?.status || "";
    const suffix = code ? ` (${code})` : "";
    if (detail === "manifestLoadError" || detail === "manifestLoadTimeOut") {
      return `The HLS playlist could not load${suffix}. The full link was read, but the source server is blocking direct browser playback from this page.`;
    }
    if (detail === "fragLoadError" || detail === "fragLoadTimeOut") {
      return `The HLS video segments could not load${suffix}. The playlist loaded, but the source server blocked the media files.`;
    }
    return `Direct playback blocked or failed: ${detail}${suffix}`;
  }

  function playDirectVideo() {
    els.video.play().catch(() => {
      // Browser autoplay rules may require the user to press play.
    });
  }

  function clearVideoSource() {
    if (!els.video) return;
    clearDirectSourceTimer();
    videoResetUntil = Date.now() + 1200;
    if (hlsPlayer) {
      hlsPlayer.destroy();
      hlsPlayer = null;
    }
    els.video.pause();
    els.video.removeAttribute("src");
    els.video.removeAttribute("poster");
    els.video.load();
  }

  function showEmptyState(title, copy) {
    hideWatchStatus();
    if (els.emptyTitle) els.emptyTitle.textContent = title;
    if (els.emptyCopy) els.emptyCopy.textContent = copy;
    if (els.frame) {
      els.frame.hidden = true;
      if (els.frame.src !== "about:blank") els.frame.src = "about:blank";
    }
    if (els.video) {
      clearVideoSource();
      els.video.hidden = true;
    }
    if (els.title) els.title.textContent = title;
    if (els.type) els.type.textContent = "Ready";
    if (els.empty) els.empty.hidden = false;
    syncCastButtons();
  }

  function showDirectError(message) {
    clearDirectSourceTimer();
    stopDirectPlayerAfterError();
    showIframeFallbackStatus(message);
    if (els.emptyTitle) els.emptyTitle.textContent = "Direct source failed";
    if (els.emptyCopy) els.emptyCopy.textContent = message;
  }

  function stopDirectPlayerAfterError() {
    if (!els.video) return;
    videoResetUntil = Date.now() + 1200;
    if (hlsPlayer) {
      const player = hlsPlayer;
      hlsPlayer = null;
      player.destroy();
    }
    els.video.pause();
    els.video.removeAttribute("src");
    els.video.removeAttribute("poster");
    els.video.load();
    els.video.hidden = true;
    syncCastButtons();
  }

  function showWatchStatus(message, isLoading = false) {
    if (!els.status) return;
    els.status.innerHTML = isLoading
      ? `<span class="watch-spinner" aria-hidden="true"></span><span>${escapeHTML(message)}</span>`
      : `<span>${escapeHTML(message)}</span>`;
    els.status.classList.toggle("is-loading", isLoading);
    els.status.hidden = false;
  }

  function showIframeFallbackStatus(message) {
    if (!els.status) return;
    els.status.replaceChildren();
    const copy = document.createElement("span");
    copy.textContent = message;
    els.status.append(copy);

    if (canUseIframePlayback(session?.playable)) {
      const button = document.createElement("button");
      button.className = "watch-button compact";
      button.type = "button";
      button.textContent = "Use Iframe";
      button.addEventListener("click", useIframePlayback);
      els.status.append(button);
    }

    els.status.classList.remove("is-loading");
    els.status.hidden = false;
  }

  function hideWatchStatus() {
    clearDirectSourceTimer();
    if (els.status) {
      els.status.hidden = true;
      els.status.classList.remove("is-loading");
      els.status.textContent = "";
    }
  }

  function startDirectSourceTimer(message) {
    clearDirectSourceTimer();
    directSourceTimer = window.setTimeout(() => {
      showDirectError(message);
    }, DIRECT_SOURCE_TIMEOUT_MS);
  }

  function clearDirectSourceTimer() {
    window.clearTimeout(directSourceTimer);
    directSourceTimer = null;
  }

  function toggleEpisodePanel() {
    if (!els.episodePanel || !els.episodeToggle) return;
    const shouldOpen = els.episodePanel.hidden;
    els.episodePanel.hidden = !shouldOpen;
    els.episodeToggle.classList.toggle("is-active", shouldOpen);
  }

  function closeEpisodePanel() {
    if (!els.episodePanel || !els.episodeToggle) return;
    els.episodePanel.hidden = true;
    els.episodeToggle.classList.remove("is-active");
  }

  function toggleDirectPanel() {
    if (!els.directPanel || !els.directToggle) return;
    const shouldOpen = els.directPanel.hidden;
    els.directPanel.hidden = !shouldOpen;
    els.directToggle.classList.toggle("is-active", shouldOpen);
    if (shouldOpen) {
      closeEpisodePanel();
      syncDirectPanel();
      els.directInput?.focus();
    }
  }

  function closeDirectPanel() {
    if (!els.directPanel || !els.directToggle) return;
    els.directPanel.hidden = true;
    els.directToggle.classList.remove("is-active");
  }

  function syncDirectPanel() {
    if (!els.directInput) return;
    els.directInput.value = session?.sourceMode === "direct" ? getPresentedSourceUrl() || session.url || "" : "";
    if (els.useIframeSource) els.useIframeSource.hidden = !canUseIframePlayback(session?.playable);
  }

  function prepareIframeFallback(item, fallbackUrl, message) {
    session = {
      ...(session || {}),
      playable: snapshotItem(item),
      url: fallbackUrl,
      sourceMode: "iframe-pending",
      storedAt: Date.now(),
    };
    delete session.directSourceUrl;
    delete session.resolvedSourceUrl;
    document.title = `${getDisplayTitle(item)} - Bara Al-Wa7sh`;
    els.title.textContent = getDisplayTitle(item);
    els.type.textContent = getTypeLabel(item);
    sourceCandidates = buildSourceCandidates(item);
    sourceIndex = getSourceIndex(fallbackUrl, sourceCandidates);
    clearVideoSource();
    if (els.video) els.video.hidden = true;
    if (els.frame) {
      els.frame.hidden = true;
      if (els.frame.src !== "about:blank") els.frame.src = "about:blank";
    }
    syncDirectPanel();
    syncCastButtons();
    syncSourceToggle();
    syncNextButton();
    writeSession();
    showIframeFallbackStatus(message);
  }

  function getPresentedSourceUrl() {
    if (!session || session.sourceMode !== "direct") return "";
    return normalizeDirectSourceUrl(session.resolvedSourceUrl) ||
      getUnproxiedSourceUrl(session.directSourceUrl || session.url || "") ||
      normalizeDirectSourceUrl(session.directSourceUrl || session.url);
  }

  function openDirectSourceFromForm() {
    const sourceUrl = normalizeDirectSourceUrl(els.directInput?.value);
    if (!sourceUrl) {
      window.alert("Paste an authorized MP4, WebM, or HLS URL.");
      return;
    }
    const playable = session?.playable || makeDirectItem(sourceUrl);
    session = session || {
      selected: playable,
      playable,
      show: null,
      episodes: [],
      url: sourceUrl,
      storedAt: Date.now(),
    };
    setCurrentItem(playable, sourceUrl, { mode: "direct" });
    closeDirectPanel();
  }

  function useIframePlayback() {
    if (!session?.playable) return;
    if (!canUseIframePlayback(session.playable)) {
      window.alert("This direct source does not have an IMDb or TMDB ID for iframe playback.");
      return;
    }
    setCurrentItem(session.playable, buildPlayerUrl(session.playable), { mode: "iframe" });
    closeDirectPanel();
  }

  function canUseIframePlayback(item) {
    if (!item) return false;
    if (item.embed_url) return true;
    if (item.kind === "episode") return Boolean(item.show_imdb_id || item.show_tmdb_id || item.imdb_id || item.tmdb_id);
    return Boolean(item.imdb_id || item.tmdb_id);
  }

  function renderEpisodePanel() {
    if (!els.episodePanelTitle || !els.manualSeason || !els.manualEpisode || !els.seasonTabs || !els.episodeList || !els.manualEpisodeJump) {
      return;
    }
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

  async function switchEpisode(episode) {
    activeSeason = Number(episode.season) || activeSeason || 1;
    autoAdvanceCooldownUntil = Date.now() + AUTO_ADVANCE_COOLDOWN_MS;
    await setPreferredCurrentItem(episode, buildPlayerUrl(episode));
    renderEpisodePanel();
  }

  function cycleSource() {
    if (sourceCandidates.length < 2) return;
    sourceIndex = (sourceIndex + 1) % sourceCandidates.length;
    const candidate = sourceCandidates[sourceIndex];
    setCurrentItem(session.playable, buildPlayerUrl(session.playable, candidate.id), { mode: "iframe" });
  }

  function retryPlayback() {
    if (!session?.url) return;
    if (session.sourceMode === "direct") {
      setCurrentItem(session.playable, session.url, { mode: "direct" });
      return;
    }
    els.frame.src = session.url;
  }

  function playNextEpisodeNow() {
    if (!session?.playable || session.playable.kind !== "episode") return;
    const next = getNextEpisode(session.playable);
    if (next) switchEpisode(next);
  }

  function syncNextButton() {
    if (!els.nextButton) return;
    const current = session.playable;
    const next = current?.kind === "episode" ? getNextEpisode(current) : null;
    els.nextButton.hidden = !next;
    hideNextPrompt();
  }

  function syncSourceToggle() {
    if (!els.sourceToggle) return;
    if (session?.sourceMode === "direct") {
      els.sourceToggle.hidden = true;
      return;
    }
    els.sourceToggle.hidden = sourceCandidates.length < 2;
    if (sourceCandidates.length < 2) return;
    const next = sourceCandidates[(sourceIndex + 1) % sourceCandidates.length];
    els.sourceToggle.textContent = `Try ${next.label}`;
  }

  function syncCastButtons() {
    const hasDirectVideo = session?.sourceMode === "direct" && Boolean(els.video?.src || session?.url);
    if (els.castButton) els.castButton.hidden = !hasDirectVideo;
    if (els.pipButton) els.pipButton.hidden = !hasDirectVideo;
  }

  function handleVideoTimeUpdate() {
    if (session?.sourceMode !== "direct" || !session?.playable) return;
    const progress = Number(els.video.currentTime) || 0;
    const duration = Number(els.video.duration) || 0;
    if (progress > 0) saveContinueProgress(progress, duration);
    updateNextPrompt(progress, duration);
  }

  function handleVideoEnded() {
    if (session?.sourceMode !== "direct" || session.playable?.kind !== "episode") return;
    const next = getNextEpisode(session.playable);
    if (next) switchEpisode(next);
  }

  function handleVideoError() {
    if (session?.sourceMode !== "direct") return;
    if (Date.now() < videoResetUntil || hlsPlayer) return;
    clearDirectSourceTimer();
    showDirectError("The media URL may be expired, blocked by CORS, or unsupported by this browser.");
  }

  async function castCurrentVideo() {
    if (session?.sourceMode !== "direct" || !(els.video?.src || session?.url)) {
      window.alert("Casting needs a direct MP4, WebM, or HLS source.");
      return;
    }

    if (await startChromeCast()) return;

    if (typeof els.video.webkitShowPlaybackTargetPicker === "function") {
      els.video.webkitShowPlaybackTargetPicker();
      return;
    }

    if (els.video.remote && typeof els.video.remote.prompt === "function") {
      try {
        await els.video.remote.prompt();
        return;
      } catch {
        // Fall through to the PiP fallback.
      }
    }

    await togglePictureInPicture();
  }

  function configureChromeCast() {
    if (!chromeCastAvailable || !window.cast?.framework || !window.chrome?.cast) return false;
    try {
      chromeCastContext = window.cast.framework.CastContext.getInstance();
      chromeCastContext.setOptions({
        receiverApplicationId: getConfig().chromeCastReceiverAppId || window.chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID,
        autoJoinPolicy: window.chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED,
      });
      return true;
    } catch (error) {
      console.warn("Chrome Cast setup failed", error);
      return false;
    }
  }

  async function startChromeCast() {
    if (!configureChromeCast()) return false;
    const mediaUrl = getCastMediaUrl();
    if (!mediaUrl) return false;

    try {
      await chromeCastContext.requestSession();
      const castSession = chromeCastContext.getCurrentSession();
      if (!castSession) return false;

      const mediaInfo = new window.chrome.cast.media.MediaInfo(mediaUrl, getCastContentType(mediaUrl));
      mediaInfo.metadata = new window.chrome.cast.media.GenericMediaMetadata();
      mediaInfo.metadata.title = getDisplayTitle(session.playable);
      if (session.playable?.poster_url) mediaInfo.metadata.images = [{ url: session.playable.poster_url }];

      const request = new window.chrome.cast.media.LoadRequest(mediaInfo);
      const progress = Number(els.video?.currentTime) || getSavedProgressForItem(session.playable);
      if (progress > 15) request.currentTime = progress;
      await castSession.loadMedia(request);
      showWatchStatus("Casting to Chrome Cast.");
      return true;
    } catch (error) {
      console.warn("Chrome Cast failed", error);
      return false;
    }
  }

  function getCastMediaUrl() {
    const sourceUrl = session?.url || els.video?.src || "";
    if (!sourceUrl) return "";
    return getPublicPlaybackUrl(sourceUrl);
  }

  function getCastContentType(url) {
    return isHlsUrl(url) ? "application/vnd.apple.mpegurl" : "video/mp4";
  }

  async function togglePictureInPicture() {
    if (!document.pictureInPictureEnabled || !els.video?.src) {
      window.alert("Picture in Picture is not available for this video.");
      return;
    }
    try {
      if (document.pictureInPictureElement === els.video) {
        await document.exitPictureInPicture();
        return;
      }
      await els.video.requestPictureInPicture();
    } catch {
      window.alert("Picture in Picture could not start.");
    }
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
    const inherited = getInheritablePlayerUrl();
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

  function getInheritablePlayerUrl() {
    if (!session?.url) return null;
    try {
      const url = new URL(session.url);
      return url.hostname.includes("vaplayer.ru") ? url : null;
    } catch {
      return null;
    }
  }

  async function resolvePreferredDirectSource(item, fallbackUrl = "") {
    const override = getStreamOverride(item);
    if (override) {
      return {
        sourceUrl: override,
        playbackUrl: proxifyDirectUrlIfNeeded(override),
      };
    }

    const config = getConfig();
    if (!config.preferDirectResolver || !config.streamResolverUrl || isDirectMediaUrl(fallbackUrl)) {
      return { error: "The direct stream resolver is not configured." };
    }

    const resolverUrl = buildStreamResolverUrl(item, config.streamResolverUrl);
    if (!resolverUrl) return { error: "This title does not have an ID the backend can resolve." };

    showWatchStatus("Finding direct stream...", true);
    try {
      const response = await fetch(resolverUrl, {
        headers: {
          accept: "application/json, text/plain, */*",
          ...getBackendRequestHeaders(resolverUrl),
        },
      });
      if (!response.ok) {
        showWatchStatus("Direct stream unavailable. Loading embedded player...", true);
        return { error: `The backend responded with ${response.status}.` };
      }

      const sourceUrl = await readResolverSourceUrl(response);
      if (sourceUrl) {
        return {
          sourceUrl,
          playbackUrl: proxifyDirectUrlIfNeeded(sourceUrl),
        };
      }
      showWatchStatus("Direct stream unavailable. Loading embedded player...", true);
    } catch (error) {
      console.warn("Direct stream resolver failed", error);
      showWatchStatus("Direct stream unavailable. Loading embedded player...", true);
      return { error: "The public backend did not respond." };
    }

    return { error: "The backend response did not include a playable stream URL." };
  }

  function getStreamOverride(item) {
    const overrides = getConfig().streamOverrides || {};
    if (!overrides || typeof overrides !== "object") return "";
    for (const key of getStreamOverrideKeys(item)) {
      const sourceUrl = normalizeDirectSourceUrl(overrides[key]);
      if (sourceUrl) return sourceUrl;
    }
    return "";
  }

  function getStreamOverrideKeys(item) {
    const ids = getResolverIdCandidates(item);
    if (item.kind === "episode") {
      const season = Number(item.season) || 1;
      const episode = Number(item.episode) || 1;
      return ids.map((id) => `tv:${id}:${season}:${episode}`);
    }
    return ids.map((id) => `movie:${id}`);
  }

  function buildStreamResolverUrl(item, resolverBase) {
    const id = getResolverIdCandidates(item)[0];
    if (!id) return "";

    const url = new URL(resolverBase, getBackendBaseUrl() || window.location.href);
    const imdb = item.kind === "episode" ? item.show_imdb_id || item.imdb_id : item.imdb_id;
    const tmdb = item.kind === "episode" ? item.show_tmdb_id || item.tmdb_id : item.tmdb_id;
    url.searchParams.set("id", id);
    url.searchParams.set("type", item.kind === "episode" ? "tv" : "movie");
    if (imdb) url.searchParams.set("imdb", imdb);
    if (tmdb) url.searchParams.set("tmdb", tmdb);
    if (item.kind === "episode") {
      url.searchParams.set("season", String(Number(item.season) || 1));
      url.searchParams.set("episode", String(Number(item.episode) || 1));
    }
    return url.toString();
  }

  function getResolverIdCandidates(item) {
    const ids = item.kind === "episode"
      ? [item.show_imdb_id, item.show_tmdb_id, item.imdb_id, item.tmdb_id, getSourceIdFromUrl(item.embed_url || "")]
      : [item.imdb_id, item.tmdb_id, getSourceIdFromUrl(item.embed_url || "")];
    return [...new Set(ids.map((id) => String(id || "").trim()).filter(Boolean))];
  }

  async function readResolverSourceUrl(response) {
    const text = (await response.text()).trim();
    if (!text) return "";

    if (text.startsWith("{") || response.headers.get("content-type")?.includes("json")) {
      try {
        return getSourceUrlFromResolverPayload(JSON.parse(text));
      } catch {
        return "";
      }
    }

    return normalizeDirectSourceUrl(text);
  }

  function getSourceUrlFromResolverPayload(payload) {
    const candidates = [
      payload?.url,
      payload?.hls,
      payload?.src,
      payload?.source,
      payload?.stream_url,
      payload?.streamUrl,
      payload?.data?.url,
      payload?.data?.hls,
      payload?.data?.stream_url,
      payload?.data?.streamUrl,
      ...(Array.isArray(payload?.streams) ? payload.streams : []),
      ...(Array.isArray(payload?.data?.stream_urls) ? payload.data.stream_urls : []),
    ];
    for (const candidate of candidates) {
      const sourceUrl = normalizeDirectSourceUrl(candidate);
      if (sourceUrl) return sourceUrl;
    }
    return "";
  }

  function proxifyDirectUrlIfNeeded(sourceUrl) {
    const normalized = normalizeDirectSourceUrl(sourceUrl);
    if (!normalized || !getConfig().mediaCapture?.useLocalProxy) return normalized;

    try {
      const parsed = new URL(normalized);
      if (parsed.origin === window.location.origin || parsed.pathname === "/__streamline-proxy") {
        return normalized;
      }

      const proxied = new URL("/__streamline-proxy", getBackendBaseUrl() || window.location.href);
      proxied.searchParams.set("url", normalized);
      return proxied.toString();
    } catch {
      return normalized;
    }
  }

  function getUnproxiedSourceUrl(sourceUrl = "") {
    const normalized = normalizeDirectSourceUrl(sourceUrl);
    if (!normalized) return "";
    try {
      const url = new URL(normalized);
      if (url.pathname !== "/__streamline-proxy") return normalized;
      return normalizeDirectSourceUrl(url.searchParams.get("url") || "");
    } catch {
      return "";
    }
  }

  function getPublicPlaybackUrl(sourceUrl = "") {
    const normalized = normalizeDirectSourceUrl(sourceUrl);
    if (!normalized) return "";
    try {
      const url = new URL(normalized);
      const backendBase = getBackendBaseUrl();
      if (!backendBase || url.origin !== window.location.origin || url.pathname !== "/__streamline-proxy") {
        return normalized;
      }
      const publicUrl = new URL(`${url.pathname}${url.search}`, backendBase);
      return publicUrl.toString();
    } catch {
      return normalized;
    }
  }

  function getConfig() {
    return window.STREAMLINE_CONFIG || {};
  }

  function getBackendBaseUrl() {
    const config = getConfig();
    const value = String(config.backendBaseUrl || config.apiBaseUrl || "").trim();
    if (!value) return "";
    try {
      return new URL(value).toString().replace(/\/$/, "/");
    } catch {
      return "";
    }
  }

  function getBackendRequestHeaders(url = "") {
    return isBackendUrl(url) ? { "ngrok-skip-browser-warning": "true" } : {};
  }

  function addBackendRequestHeaders(xhr, url = "") {
    if (!isBackendUrl(url) || typeof xhr?.setRequestHeader !== "function") return;
    xhr.setRequestHeader("ngrok-skip-browser-warning", "true");
  }

  function isBackendUrl(url = "") {
    const backendBase = getBackendBaseUrl();
    if (!backendBase) return false;
    try {
      return new URL(url, window.location.href).origin === new URL(backendBase).origin;
    } catch {
      return false;
    }
  }

  function getDirectSessionFromQuery() {
    const params = new URLSearchParams(window.location.search);
    const sourceUrl = normalizeDirectSourceUrl(getQueryValue(params, ["src", "source", "url"]));
    if (!sourceUrl) return null;
    const item = makeDirectItem(sourceUrl, {
      title: getQueryValue(params, ["title"]) || "Direct Source",
      poster_url: getQueryValue(params, ["poster"]) || "",
    });
    return {
      selected: snapshotItem(item),
      playable: snapshotItem(item),
      show: null,
      episodes: [],
      url: sourceUrl,
      sourceMode: "direct",
      directSourceUrl: sourceUrl,
      storedAt: Date.now(),
    };
  }

  function getQueryValue(params, keys) {
    for (const key of keys) {
      const raw = getRawQueryValue(key);
      if (raw) return raw;
      const parsed = params.get(key);
      if (parsed) return parsed;
    }
    return "";
  }

  function getRawQueryValue(key) {
    const search = window.location.search || "";
    const marker = `${key}=`;
    const start = search.indexOf(marker);
    if (start < 0) return "";
    const valueStart = start + marker.length;
    const nextParam = ["src", "source", "url"].includes(key)
      ? getNextKnownAppParamIndex(search, valueStart)
      : search.indexOf("&", valueStart);
    const raw = search.slice(valueStart, nextParam >= 0 ? nextParam : undefined);
    try {
      return decodeURIComponent(raw.replace(/\+/g, "%20"));
    } catch {
      return raw;
    }
  }

  function getNextKnownAppParamIndex(search, valueStart) {
    return ["&title=", "&poster="].reduce((best, marker) => {
      const index = search.indexOf(marker, valueStart);
      if (index < 0) return best;
      return best < 0 ? index : Math.min(best, index);
    }, -1);
  }

  function makeDirectItem(sourceUrl, details = {}) {
    const item = {
      kind: "movie",
      source: "direct",
      title: details.title || getDirectSourceTitle(sourceUrl),
      poster_url: details.poster_url || "",
      direct_url: sourceUrl,
    };
    item.key = getItemKey(item);
    return item;
  }

  function getDirectSourceTitle(sourceUrl) {
    try {
      const path = new URL(sourceUrl).pathname.split("/").filter(Boolean).pop() || "Direct Source";
      return decodeURIComponent(path).replace(/\.(m3u8|mp4|m4v|mov|webm)$/i, "") || "Direct Source";
    } catch {
      return "Direct Source";
    }
  }

  function normalizeDirectSourceUrl(value = "") {
    const raw = String(value || "").trim();
    if (!raw) return "";
    try {
      const url = new URL(raw);
      if (!["http:", "https:"].includes(url.protocol)) return "";
      return url.toString();
    } catch {
      return "";
    }
  }

  function isDirectMediaUrl(value = "") {
    const url = normalizeDirectSourceUrl(value);
    if (!url) return false;
    try {
      const parsed = new URL(url);
      return !parsed.hostname.includes("vaplayer.ru");
    } catch {
      return false;
    }
  }

  function isHlsUrl(value = "") {
    try {
      const url = new URL(value, window.location.href);
      return `${url.pathname}${url.search}`.toLowerCase().includes(".m3u8");
    } catch {
      return String(value).toLowerCase().includes(".m3u8");
    }
  }

  function canPlayNativeHls() {
    return Boolean(els.video?.canPlayType("application/vnd.apple.mpegurl") ||
      els.video?.canPlayType("application/x-mpegURL"));
  }

  function isSafariBrowser() {
    return /^((?!chrome|android|crios|fxios|edg).)*safari/i.test(navigator.userAgent);
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
    if (session?.sourceMode === "direct") return;
    if (!String(event.origin || "").includes("vaplayer.ru")) return;
    const data = getPlayerEventData(event.data);
    if (!data) return;
    const progress = pickNumber(data, ["player_progress", "progress", "currentTime", "current_time", "time"]);
    const duration = pickNumber(data, ["player_duration", "duration", "totalDuration", "total_duration", "length"]);
    if (progress > 0) saveContinueProgress(progress, duration);
    updateNextPrompt(progress, duration);
    maybePlayNextEpisode(progress, duration);
  }

  function getPlayerEventData(message) {
    const parsed = typeof message === "string" ? parseMessageString(message) : message;
    if (!parsed) return null;
    const type = String(parsed.type || parsed.event || parsed.name || "").toLowerCase();
    if (type && !type.includes("player")) return null;
    return parsed.data && typeof parsed.data === "object" ? parsed.data : parsed;
  }

  function parseMessageString(message) {
    try {
      return JSON.parse(message);
    } catch {
      return null;
    }
  }

  function pickNumber(data, keys) {
    for (const key of keys) {
      const value = Number(data?.[key]);
      if (Number.isFinite(value) && value >= 0) return value;
    }
    return 0;
  }

  function maybePlayNextEpisode(progress, duration) {
    const current = session.playable;
    if (Date.now() < autoAdvanceCooldownUntil) return;
    if (current.kind !== "episode" || !isLastSecond(progress, duration)) return;

    const currentKey = getItemKey(current);
    if (autoAdvanceKey === currentKey) return;
    autoAdvanceKey = currentKey;

    const next = getNextEpisode(current);
    if (next) switchEpisode(next);
  }

  function isLastSecond(progress, duration) {
    if (!duration || duration < 20) return false;
    const remaining = duration - progress;
    return remaining <= 1;
  }

  function updateNextPrompt(progress, duration) {
    const current = session.playable;
    if (current.kind !== "episode") {
      hideNextPrompt();
      setNextProgressFill(0);
      return;
    }

    const next = getNextEpisode(current);
    if (!next) {
      hideNextPrompt();
      setNextProgressFill(0);
      return;
    }

    if (!duration || duration < 20) {
      renderNextPrompt(next, current, 0);
      return;
    }

    const remaining = Math.max(0, duration - progress);
    const ratio = progress / duration;
    const shouldShowPrompt = remaining <= NEXT_PROMPT_SECONDS || ratio >= NEXT_PROMPT_RATIO;
    if (!shouldShowPrompt) {
      hideNextPrompt();
      setNextProgressFill(0);
      return;
    }

    const timeFill = remaining <= NEXT_PROMPT_SECONDS
      ? ((NEXT_PROMPT_SECONDS - remaining) / NEXT_PROMPT_SECONDS) * 100
      : 0;
    const ratioFill = ratio >= NEXT_PROMPT_RATIO
      ? ((ratio - NEXT_PROMPT_RATIO) / (1 - NEXT_PROMPT_RATIO)) * 100
      : 0;
    const fill = Math.min(100, Math.max(0, timeFill, ratioFill));
    renderNextPrompt(next, current, fill);
  }

  function renderNextPrompt(next, current, fill) {
    if (!els.nextCard || !els.nextTitle || !els.nextMeta || !els.nextProgress) return;
    els.nextTitle.textContent = next.title || `Episode ${next.episode}`;
    els.nextMeta.textContent = `${next.showTitle || current.showTitle || "TV Show"} • S${String(next.season || 1).padStart(2, "0")} E${String(next.episode || 1).padStart(2, "0")}`;
    setNextProgressFill(fill);
    els.nextCard.hidden = false;
  }

  function hideNextPrompt() {
    if (!els.nextCard || !els.nextProgress) return;
    els.nextCard.hidden = true;
    setNextProgressFill(0);
  }

  function setNextProgressFill(fill) {
    const safeFill = Math.min(100, Math.max(0, fill));
    const visibleFill = safeFill > 0 ? Math.max(MIN_VISIBLE_NEXT_FILL, safeFill) : MIN_VISIBLE_NEXT_FILL;
    const width = `${visibleFill}%`;
    if (els.nextProgress) els.nextProgress.style.width = width;
    if (els.nextButtonProgress) els.nextButtonProgress.style.width = width;
  }

  function getNextEpisode(current) {
    if (episodes.length) {
      const sorted = [...episodes].sort((a, b) => a.season - b.season || a.episode - b.episode);
      const index = sorted.findIndex((episode) => isSameEpisode(episode, current));
      return index >= 0 ? sorted[index + 1] || null : sorted.find((episode) =>
        episode.season > current.season ||
        (episode.season === current.season && episode.episode > current.episode)
      ) || null;
    }

    return makeEpisodeItem(
      session.show || session.selected || current,
      Number(current.season) || 1,
      (Number(current.episode) || 1) + 1
    );
  }

  function isSameEpisode(a, b) {
    return getShowId(a) === getShowId(b) &&
      Number(a.season) === Number(b.season) &&
      Number(a.episode) === Number(b.episode);
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
