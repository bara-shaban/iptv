window.STREAMLINE_CONFIG = {
  // Public backend base URL for hosted static builds such as GitHub Pages.
  // Leave blank for local dev, or set to an HTTPS tunnel/server URL such as ngrok.
  backendBaseUrl: "https://steelless-tetartohedrally-terina.ngrok-free.dev",

  // Optional: put your own stream resolver here when your server can return a direct HLS/MP4 source.
  // Example: "https://your-server.example/api.php"
  // The app calls it with id/type/season/episode plus imdb/tmdb when available.
  // It can return:
  // - plain text: https://example.com/master.m3u8
  // - JSON: { "url": "https://example.com/master.m3u8" }
  // - JSON HLS hint: { "hls": "https://example.com/api.php?id=..." }
  // - an actual #EXTM3U playlist response
  // When running `npm run dev`, this hits the dev server's /__streamline-resolve
  // endpoint, which calls streamdata.vaplayer.ru server-side and returns the
  // raw HLS .m3u8 URL the embedded player would have loaded.
  streamResolverUrl: "/__streamline-resolve",
  preferDirectResolver: true,
  directPlayerEngine: "auto",
  chromeCastReceiverAppId: "CC1AD845",
  // Leave this off for rotating/signed HLS links. Turn it on only for stable streams.
  autoUseCapturedSources: false,
  trustedPlayerOrigins: [],
  autoPlayPostedStreams: true,

  // Optional: paste known direct streams here by ID. These are tried before streamResolverUrl.
  // Examples:
  // "movie:tt1234567": "https://example.com/movie/master.m3u8"
  // "movie:123456": "https://example.com/movie/master.m3u8"
  // "tv:tt0944947:1:1": "https://example.com/game-of-thrones/s01e01/master.m3u8"
  streamOverrides: {},

  // Local dev capture. Run `npm run dev` and this app will append app-owned
  // .m3u8/.mp4/.webm/.mov URLs to data/dev-media-urls.ndjson.
  mediaCapture: {
    enabled: true,
    endpoint: "/__streamline-media-log",
    logToConsole: true,
    useLocalProxy: true,
  },

  // Local dev network timing capture. This logs browser-visible resource URLs
  // and timing metadata to data/dev-network-traffic.ndjson.
  networkCapture: {
    enabled: true,
    endpoint: "/__streamline-network-log",
    logToConsole: true,
    includeExisting: true,
    maxEntries: 1000,
  },
};
