# Bara Al-Wa7sh

A static streaming UI that searches a local VidAPI catalog database and plays titles through VidAPI embeds.

## Files

- `index.html` - browse page
- `watch.html` - full-screen playback page
- `styles.css` - responsive UI theme
- `watch.css` - full-screen player styling
- `app.js` - local shard search, TV episode browsing, recommendations, saved titles
- `watch.js` - watch-session loading and playback progress storage
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

The watch page supports two playback modes:

- Iframe mode uses the existing VidAPI/Vaplayer embed URLs.
- Direct source mode plays an authorized `.mp4`, `.webm`, or browser-supported `.m3u8` URL in the app's own `<video>` player.

Open `watch.html?src={ENCODED_MEDIA_URL}&title={TITLE}` or use the watch page's `Source` button to paste a direct media URL. Safari supports HLS `.m3u8` playback natively, and Chromium/Firefox use HLS.js when available.

For browser and app playback, the media host must allow direct playback from your app. For web builds that means CORS headers on the HLS playlist and segment files. For native app builds, use the same direct URLs with a native video component such as `react-native-video`, but signed URLs can still expire or be blocked by the media host.

The local `yt-dlp/` checkout can inspect URLs you are authorized to access, but it must run locally or server-side, not inside the browser:

```bash
python3 yt-dlp/yt_dlp/__main__.py -g "https://example.com/video-page"
python3 yt-dlp/yt_dlp/__main__.py -J "https://example.com/video-page"
```

Paste a direct URL from `-g` into the `Source` panel when it is an authorized playable stream. Cross-origin iframe internals are not readable by the static app, and signed stream URLs may expire or fail browser or app playback checks.

## Cast

The watch page shows `Cast` and `PiP` controls when direct source mode is active. `Cast` tries Chrome Cast first, then Safari AirPlay, then the browser Remote Playback API, then Picture in Picture as a fallback. Chrome Cast devices must be able to reach the media URL, so hosted builds should set `STREAMLINE_CONFIG.backendBaseUrl` to a public HTTPS backend or tunnel. VidAPI iframe mode cannot be cast as a direct video stream from this app; use browser-level `Cast tab` for iframes.

Use the API and embedded content only for content and domains you are authorized to use.
