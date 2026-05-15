# Streamline

A static streaming UI that searches a local VidAPI catalog database and plays titles through VidAPI embeds.

## Files

- `index.html` - application shell
- `styles.css` - responsive UI theme
- `app.js` - local shard search, TV episode browsing, playback, subtitles, progress, saved titles
- `scripts/build-catalog-db.mjs` - builds the project catalog database under `data/catalog`

## Run

```bash
python3 -m http.server 5173
```

Then visit `http://localhost:5173`.

## Build The Local DB

Build all movies, TV shows, and episodes:

```bash
npm run build:catalog
```

If VidAPI returns temporary `503` or rate-limit style errors, use the safer slower build:

```bash
npm run build:catalog:safe
```

Faster movie/show-only build:

```bash
npm run build:catalog:shows
```

Build movies and TV shows, then generate episode season/episode lists from VidAPI's official episode ID file:

```bash
npm run build:catalog:episode-ids
```

This is faster than syncing every `/episodes/latest/page-*.json` page, but episode titles and air dates will be generic until you run the full metadata build.

Small test build:

```bash
node scripts/build-catalog-db.mjs --max-pages 2
```

The builder caches each successfully fetched API page in `data/.catalog-cache`, so rerunning the command resumes from cached pages instead of starting every network request over. Use `--fresh-cache` if you deliberately want to discard that cache.

If you have cached pages but no finished `data/catalog/manifest.json`, create a cache manifest:

```bash
npm run build:cache-manifest
```

In that mode the browser searches `data/.catalog-cache` first, then falls back to the old VidAPI latest-page approach.

The full build writes:

- `data/catalog/manifest.json`
- `data/catalog/shards/*.json` - title partitions for movie/show search
- `data/catalog/episodes/*/*.json` - per-show episode partitions
- `data/catalog/indexes/*.json` - shard and genre indexes
- `data/catalog/clusters/*.json` - genre clusters

The browser loads `manifest.json` on startup, then only fetches the title shard needed for the current search. TV episode lists load from the per-show episode file when you select a show.

## Playback

VidAPI endpoints used by the app:

- `https://vidapi.ru/movies/latest/page-{PAGE}.json`
- `https://vidapi.ru/tvshows/latest/page-{PAGE}.json`
- `https://vidapi.ru/episodes/latest/page-{PAGE}.json`
- `https://vidapi.ru/imdb/api/?action=stats`
- `https://vaplayer.ru/embed/movie/{id}`
- `https://vaplayer.ru/embed/tv/{id}/{season}/{episode}`

Subtitle settings are passed as VidAPI player query parameters, including `ds_lang`, `sub_url`, `sub_label`, `sub_lang`, and `sub_default`.

Playback progress is stored in browser storage. Movies resume by ID, and TV shows remember the last episode plus the saved timeline position.

The download button opens the current VidAPI player source. VidAPI embeds do not expose a direct MP4/HLS download URL to the app.

## Cast

The Cast button is present, but VidAPI is an iframe provider. True Chromecast playback requires a direct HLS/MP4 stream or a cast-compatible provider. With VidAPI embeds, use Chrome's browser-level `Cast tab`.

Use the API and embedded content only for content and domains you are authorized to use.
