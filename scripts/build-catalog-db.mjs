#!/usr/bin/env node

import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const API_BASE = "https://vidapi.ru";
const PLAYER_BASE = "https://vaplayer.ru";
const OUT_DIR = path.resolve(readArg("--out", "data/catalog"));
const CACHE_DIR = path.resolve(readArg("--cache-dir", "data/.catalog-cache"));
const CONCURRENCY = Number(readArg("--concurrency", "2"));
const RETRIES = Number(readArg("--retries", "8"));
const RETRY_DELAY = Number(readArg("--retry-delay", "1200"));
const MAX_PAGES = Number(readArg("--max-pages", "0"));
const MAX_EPISODE_LINES = Number(readArg("--max-episode-lines", "0"));
const SKIP_EPISODES = hasFlag("--skip-episodes");
const EPISODES_FROM_IDS = hasFlag("--episodes-from-ids");
const EPISODE_ID_SOURCE = readArg("--episode-id-source", "tmdb").toLowerCase();
const NO_PAGE_CACHE = hasFlag("--no-page-cache");
const FRESH_CACHE = hasFlag("--fresh-cache");

const counters = {
  movies: 0,
  tv: 0,
  episodes: 0,
};

const totals = {
  movies: 0,
  tv: 0,
  episodes: 0,
};

const pageTotals = {
  movies: 0,
  tv: 0,
  episodes: 0,
};

const shards = new Map();
const episodeGroups = new Map();
const genreClusters = new Map();
const tvShowsByTmdb = new Map();
const tvShowsByImdb = new Map();
const buildErrors = [];

async function main() {
  console.log("Preparing catalog output...");
  if (FRESH_CACHE) await rm(CACHE_DIR, { recursive: true, force: true });
  await rm(OUT_DIR, { recursive: true, force: true });
  await mkdir(path.join(OUT_DIR, "shards"), { recursive: true });
  await mkdir(path.join(OUT_DIR, "episodes"), { recursive: true });
  await mkdir(path.join(OUT_DIR, "indexes"), { recursive: true });
  await mkdir(path.join(OUT_DIR, "clusters"), { recursive: true });
  await mkdir(CACHE_DIR, { recursive: true });

  await collectKind("movies");
  await collectKind("tv");
  if (!SKIP_EPISODES) {
    if (EPISODES_FROM_IDS) await collectEpisodesFromIdList();
    else await collectKind("episodes");
  }

  await writeShards();
  await writeEpisodeGroups();
  await writeClusters();
  await writeManifest();
  await writeCacheManifest();
  console.log("Catalog DB complete.");
}

async function collectKind(kind) {
  const first = await fetchPage(kind, 1);
  totals[kind] = Number(first.total) || 0;
  pageTotals[kind] = Number(first.total_pages) || 1;
  ingestPage(kind, first);

  const totalPages = MAX_PAGES ? Math.min(MAX_PAGES, pageTotals[kind]) : pageTotals[kind];
  const pages = [];
  for (let page = 2; page <= totalPages; page += 1) pages.push(page);

  console.log(`${kind}: ${totalPages} pages`);
  const failed = [];
  await pool(pages, CONCURRENCY, async (page) => {
    try {
      const data = await fetchPage(kind, page);
      ingestPage(kind, data);
      if (page % 100 === 0 || page === totalPages) {
        console.log(`${kind}: page ${page}/${totalPages}`);
      }
    } catch (error) {
      failed.push({ page, error });
      console.warn(`${kind}: page ${page} failed after retries, will retry slowly later (${error.message})`);
    }
  });

  if (failed.length) await retryFailedPages(kind, failed, totalPages);
}

async function fetchPage(kind, page) {
  const cached = await readCachedPage(kind, page);
  if (cached) return cached;

  const url = `${API_BASE}${endpoint(kind, page)}`;
  const data = await requestJSONWithRetry(url);
  await writeCachedPage(kind, page, data);
  return data;
}

async function requestJSONWithRetry(url) {
  let lastError;

  for (let attempt = 1; attempt <= RETRIES; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          accept: "application/json",
          "user-agent": "streamline-catalog-builder/1.0",
        },
      });

      if (response.ok) return response.json();

      const retryable = [408, 425, 429, 500, 502, 503, 504, 520, 522, 524].includes(response.status);
      const message = `${response.status} ${url}`;
      if (!retryable || attempt === RETRIES) throw new Error(message);

      await delay(getRetryDelay(response, attempt));
      continue;
    } catch (error) {
      lastError = error;
      if (attempt === RETRIES) break;
      await delay(getRetryDelay(null, attempt));
    }
  }

  throw lastError;
}

async function requestTextWithRetry(url) {
  let lastError;

  for (let attempt = 1; attempt <= RETRIES; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          accept: "text/plain",
          "user-agent": "streamline-catalog-builder/1.0",
        },
      });

      if (response.ok) return response.text();

      const retryable = [408, 425, 429, 500, 502, 503, 504, 520, 522, 524].includes(response.status);
      const message = `${response.status} ${url}`;
      if (!retryable || attempt === RETRIES) throw new Error(message);

      await delay(getRetryDelay(response, attempt));
      continue;
    } catch (error) {
      lastError = error;
      if (attempt === RETRIES) break;
      await delay(getRetryDelay(null, attempt));
    }
  }

  throw lastError;
}

async function retryFailedPages(kind, failed, totalPages) {
  const pages = [...new Set(failed.map((entry) => entry.page))].sort((a, b) => a - b);
  const stillFailed = [];
  console.warn(`${kind}: retrying ${pages.length} failed pages slowly`);

  for (const page of pages) {
    try {
      await delay(RETRY_DELAY * 2);
      const data = await fetchPage(kind, page);
      ingestPage(kind, data);
      if (page % 100 === 0 || page === totalPages) {
        console.log(`${kind}: page ${page}/${totalPages}`);
      }
    } catch (error) {
      stillFailed.push({ page, error });
      console.warn(`${kind}: page ${page} still failed (${error.message})`);
    }
  }

  if (stillFailed.length) {
    stillFailed.forEach((entry) => {
      buildErrors.push({
        kind,
        page: entry.page,
        message: entry.error?.message || "Unknown error",
      });
    });
    const preview = stillFailed.slice(0, 12).map((entry) => entry.page).join(", ");
    console.warn(`${kind}: skipped ${stillFailed.length} pages after slow retry. First pages: ${preview}`);
  }
}

async function readCachedPage(kind, page) {
  if (NO_PAGE_CACHE) return null;
  try {
    const raw = await readFile(cachePath(kind, page), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function writeCachedPage(kind, page, data) {
  if (NO_PAGE_CACHE) return;
  const file = cachePath(kind, page);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(data)}\n`, "utf8");
}

function cachePath(kind, page) {
  return path.join(CACHE_DIR, kind, `${page}.json`);
}

async function fetchIdList(filename) {
  const cached = await readCachedText("ids", filename);
  if (cached) return cached;

  const text = await requestTextWithRetry(`${API_BASE}/ids/${filename}`);
  await writeCachedText("ids", filename, text);
  return text;
}

async function readCachedText(kind, filename) {
  if (NO_PAGE_CACHE) return null;
  try {
    return await readFile(path.join(CACHE_DIR, kind, filename), "utf8");
  } catch {
    return null;
  }
}

async function writeCachedText(kind, filename, text) {
  if (NO_PAGE_CACHE) return;
  const file = path.join(CACHE_DIR, kind, filename);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text.endsWith("\n") ? text : `${text}\n`, "utf8");
}

function getRetryDelay(response, attempt) {
  const retryAfter = response?.headers?.get("retry-after");
  const retrySeconds = retryAfter && Number(retryAfter);
  if (Number.isFinite(retrySeconds) && retrySeconds > 0) {
    return retrySeconds * 1000;
  }

  const jitter = Math.floor(Math.random() * RETRY_DELAY);
  return RETRY_DELAY * attempt * attempt + jitter;
}

function endpoint(kind, page) {
  if (kind === "movies") return `/movies/latest/page-${page}.json`;
  if (kind === "tv") return `/tvshows/latest/page-${page}.json`;
  return `/episodes/latest/page-${page}.json`;
}

function ingestPage(kind, data) {
  const perPage = Number(data.per_page) || 24;
  const page = Number(data.page) || 1;
  (data.items || []).forEach((raw, index) => {
    const order = (page - 1) * perPage + index;
    if (kind === "episodes") {
      const episode = normalizeEpisode(raw, order);
      addEpisode(episode);
      return;
    }

    const item = normalizeTitleItem(raw, kind, order);
    counters[kind === "movies" ? "movies" : "tv"] += 1;
    if (item.kind === "tv") indexTvShow(item);
    const shard = shardName(item.title);
    if (!shards.has(shard)) shards.set(shard, []);
    shards.get(shard).push(item);
    splitGenres(item.genre).forEach((genre) => {
      const key = slug(genre);
      if (!genreClusters.has(key)) {
        genreClusters.set(key, {
          key,
          name: genre,
          count: 0,
          items: [],
        });
      }
      const cluster = genreClusters.get(key);
      cluster.count += 1;
      if (cluster.items.length < 300) {
        cluster.items.push({
          key: item.key,
          kind: item.kind,
          title: item.title,
          year: item.year,
          poster_url: item.poster_url,
          rating: item.rating,
          popularity: item.popularity,
        });
      }
    });
  });
}

function normalizeTitleItem(item, kind, order) {
  const normalized = {
    key: "",
    kind: kind === "movies" ? "movie" : "tv",
    title: item.title || "Untitled",
    tmdb_id: item.tmdb_id ? String(item.tmdb_id) : "",
    imdb_id: item.imdb_id ? String(item.imdb_id) : "",
    year: item.year ? String(item.year) : "",
    poster_url: item.poster_url || "",
    backdrop_url: "",
    rating: item.rating || "",
    genre: item.genre || "",
    popularity: item.popularity || "",
    embed_url: item.embed_url || "",
    _index: order,
  };
  normalized.key = `${normalized.kind}:${normalized.imdb_id || normalized.tmdb_id || slug(normalized.title)}`;
  normalized.search = normalizeText(`${normalized.title} ${normalized.year} ${normalized.genre} ${normalized.imdb_id} ${normalized.tmdb_id}`);
  return normalized;
}

function normalizeEpisode(item, order) {
  const normalized = {
    key: "",
    kind: "episode",
    title: item.episode_title || `Episode ${item.episode_number || ""}`.trim(),
    showTitle: item.show_title || "Untitled Show",
    show_tmdb_id: item.show_tmdb_id ? String(item.show_tmdb_id) : "",
    show_imdb_id: item.show_imdb_id ? String(item.show_imdb_id) : "",
    season: Number(item.season_number) || 1,
    episode: Number(item.episode_number) || 1,
    air_date: item.air_date || "",
    embed_url: item.embed_url || "",
    _index: order,
  };
  normalized.key = `episode:${getShowId(normalized)}:${normalized.season}:${normalized.episode}`;
  normalized.search = normalizeText(`${normalized.showTitle} ${normalized.title} ${normalized.air_date}`);
  return normalized;
}

async function collectEpisodesFromIdList() {
  if (!["tmdb", "imdb"].includes(EPISODE_ID_SOURCE)) {
    throw new Error(`Unsupported --episode-id-source "${EPISODE_ID_SOURCE}". Use "tmdb" or "imdb".`);
  }

  const filename = `eps_list_${EPISODE_ID_SOURCE}.txt`;
  console.log(`episodes: building from ${filename}`);
  const text = await fetchIdList(filename);
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const limit = MAX_EPISODE_LINES ? Math.min(MAX_EPISODE_LINES, lines.length) : lines.length;
  let skipped = 0;

  for (let index = 0; index < limit; index += 1) {
    const episode = normalizeEpisodeIdLine(lines[index], index, EPISODE_ID_SOURCE);
    if (!episode) {
      skipped += 1;
      continue;
    }
    addEpisode(episode);
  }

  totals.episodes = lines.length;
  pageTotals.episodes = 0;
  if (skipped) {
    buildErrors.push({
      kind: "episodes",
      page: 0,
      message: `Skipped ${skipped} malformed episode ID lines from ${filename}`,
    });
  }
  console.log(`episodes: ${counters.episodes} generated from ID list${MAX_EPISODE_LINES ? ` (limited to ${limit})` : ""}`);
}

function normalizeEpisodeIdLine(line, order, source) {
  const match = line.match(/^(tt\d+|\d+)_(\d+)x(\d+)$/i);
  if (!match) return null;

  const rawShowId = source === "imdb" ? match[1].toLowerCase() : match[1];
  const season = Number(match[2]);
  const episode = Number(match[3]);
  if (!season || !episode) return null;

  const show = source === "imdb" ? tvShowsByImdb.get(rawShowId) : tvShowsByTmdb.get(rawShowId);
  const showId = show ? getShowIdFromTitle(show) : rawShowId;
  const showTitle = show?.title || `TV ${rawShowId}`;

  const normalized = {
    key: "",
    kind: "episode",
    title: `Episode ${episode}`,
    showTitle,
    show_tmdb_id: source === "tmdb" ? rawShowId : show?.tmdb_id || "",
    show_imdb_id: source === "imdb" ? rawShowId : show?.imdb_id || "",
    season,
    episode,
    air_date: "",
    embed_url: `${PLAYER_BASE}/embed/tv/${encodeURIComponent(showId)}/${season}/${episode}`,
    _index: order,
  };
  normalized.key = `episode:${showId}:${season}:${episode}`;
  normalized.search = normalizeText(`${showTitle} Episode ${episode}`);
  return normalized;
}

function addEpisode(episode) {
  const showId = getShowId(episode);
  if (!episodeGroups.has(showId)) {
    episodeGroups.set(showId, {
      showId,
      showTitle: episode.showTitle,
      episodes: [],
    });
  }

  const group = episodeGroups.get(showId);
  if (group.episodes.some((existing) => existing.key === episode.key)) return;
  group.episodes.push(episode);
  counters.episodes += 1;
}

function indexTvShow(show) {
  if (show.tmdb_id) tvShowsByTmdb.set(String(show.tmdb_id), show);
  if (show.imdb_id) tvShowsByImdb.set(String(show.imdb_id).toLowerCase(), show);
}

async function writeShards() {
  const shardNames = [...shards.keys()].sort();
  for (const name of shardNames) {
    const items = shards.get(name).sort((a, b) => {
      const popularity = Number(b.popularity || 0) - Number(a.popularity || 0);
      return popularity || String(a.title).localeCompare(String(b.title));
    });
    await writeJSON(path.join(OUT_DIR, "shards", `${name}.json`), items);
  }

  await writeJSON(path.join(OUT_DIR, "indexes", "title-shards.json"), {
    shards: shardNames,
    count: shardNames.length,
  });
}

async function writeEpisodeGroups() {
  for (const [showId, group] of episodeGroups) {
    const bucket = episodeBucket(showId);
    const dir = path.join(OUT_DIR, "episodes", bucket);
    await mkdir(dir, { recursive: true });
    group.episodes.sort((a, b) => a.season - b.season || a.episode - b.episode);
    await writeJSON(path.join(dir, `${showId}.json`), group);
  }
}

async function writeClusters() {
  const clusters = [...genreClusters.values()]
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  await writeJSON(path.join(OUT_DIR, "indexes", "genres.json"), clusters.map(({ items, ...cluster }) => cluster));
  for (const cluster of clusters) {
    await writeJSON(path.join(OUT_DIR, "clusters", `${cluster.key}.json`), cluster);
  }
}

async function writeManifest() {
  await writeJSON(path.join(OUT_DIR, "manifest.json"), {
    version: 1,
    generatedAt: new Date().toISOString(),
    source: API_BASE,
    partial: buildErrors.length > 0,
    errors: buildErrors,
    partitioning: {
      titleShards: "first two normalized title characters",
      episodeBuckets: "first two normalized show ID characters",
      clusters: "genre cluster files",
    },
    episodeSource: SKIP_EPISODES ? "skipped" : EPISODES_FROM_IDS ? `ids:${EPISODE_ID_SOURCE}` : "latest-pages",
    counts: counters,
    totals,
    pages: pageTotals,
    shards: [...shards.keys()].sort(),
    episodeGroups: episodeGroups.size,
  });
}

async function writeCacheManifest() {
  const manifest = {
    version: 1,
    generatedAt: new Date().toISOString(),
    pages: {},
    counts: {},
    totals: {},
    pageTotals: {},
    errors: [],
  };

  for (const kind of ["movies", "tv", "episodes"]) {
    const pages = await listCachedPages(kind);
    manifest.pages[kind] = pages;
    manifest.counts[kind] = 0;
    manifest.totals[kind] = 0;
    manifest.pageTotals[kind] = pages.length ? Math.max(...pages) : 0;

    for (const page of pages) {
      try {
        const data = JSON.parse(await readFile(cachePath(kind, page), "utf8"));
        manifest.counts[kind] += Array.isArray(data.items) ? data.items.length : 0;
        manifest.totals[kind] = Math.max(manifest.totals[kind], Number(data.total) || 0);
        manifest.pageTotals[kind] = Math.max(manifest.pageTotals[kind], Number(data.total_pages) || 0);
      } catch (error) {
        manifest.errors.push({
          kind,
          page,
          message: error?.message || "Could not read cached page",
        });
      }
    }
  }

  await writeJSON(path.join(CACHE_DIR, "manifest.json"), manifest);
}

async function listCachedPages(kind) {
  try {
    const entries = await readdir(path.join(CACHE_DIR, kind));
    return entries
      .map((entry) => entry.match(/^(\d+)\.json$/)?.[1])
      .filter(Boolean)
      .map((page) => Number(page))
      .filter((page) => Number.isInteger(page) && page > 0)
      .sort((a, b) => a - b);
  } catch {
    return [];
  }
}

async function pool(items, concurrency, worker) {
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor];
      cursor += 1;
      await worker(item);
    }
  });
  await Promise.all(workers);
}

function getShowId(item) {
  return String(item.show_imdb_id || item.show_tmdb_id || slug(item.showTitle || "unknown"));
}

function getShowIdFromTitle(item) {
  return String(item.imdb_id || item.tmdb_id || slug(item.title || "unknown"));
}

function shardName(value = "") {
  const text = normalizeText(value).replace(/[^a-z0-9]/g, "");
  return text ? text.slice(0, 2).padEnd(2, "_") : "misc";
}

function episodeBucket(showId = "") {
  const text = String(showId).toLowerCase().replace(/[^a-z0-9]/g, "");
  return text ? text.slice(0, 2).padEnd(2, "_") : "misc";
}

function splitGenres(value = "") {
  return String(value).split(",").map((genre) => genre.trim()).filter(Boolean);
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

function slug(value = "") {
  return normalizeText(value).replace(/\s+/g, "-") || "unknown";
}

function readArg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || fallback : fallback;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function writeJSON(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value)}\n`, "utf8");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
