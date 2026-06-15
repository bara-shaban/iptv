import { createServer } from "node:http";
import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const port = Number(process.env.PORT) || 5173;
const mediaLogFile = join(root, "data", "dev-media-urls.ndjson");
const networkLogFile = join(root, "data", "dev-network-traffic.ndjson");

const mimeTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".ico", "image/x-icon"],
  [".vtt", "text/vtt; charset=utf-8"],
]);

const server = createServer(async (request, response) => {
  try {
    const requestUrl = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);

    if (request.method === "POST" && requestUrl.pathname === "/__streamline-media-log") {
      await handleMediaLog(request, response);
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/__streamline-network-log") {
      await handleNetworkLog(request, response);
      return;
    }

    if (requestUrl.pathname === "/__streamline-resolve") {
      if (request.method === "OPTIONS") {
        sendResolveOptions(response);
        return;
      }
      if (request.method === "GET") {
        await handleStreamResolve(requestUrl, response);
        return;
      }
      send(response, 405, "Method not allowed");
      return;
    }

    if (requestUrl.pathname === "/__streamline-proxy") {
      if (request.method === "OPTIONS") {
        sendProxyOptions(response);
        return;
      }

      if (request.method === "GET" || request.method === "HEAD") {
        await handleStreamProxy(requestUrl, response, request);
        return;
      }

      send(response, 405, "Method not allowed");
      return;
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      send(response, 405, "Method not allowed");
      return;
    }

    await serveStatic(request, response);
  } catch (error) {
    console.error(error);
    send(response, 500, "Internal server error");
  }
});

await ensureLogFile();

server.listen(port, () => {
  console.log(`Streamline dev server: http://localhost:${port}`);
  console.log(`Media URL log: ${mediaLogFile}`);
  console.log(`Network traffic log: ${networkLogFile}`);
});

async function ensureLogFile() {
  await mkdir(join(root, "data"), { recursive: true });
  await writeFile(mediaLogFile, "", { flag: "a" });
  await writeFile(networkLogFile, "", { flag: "a" });
}

async function handleMediaLog(request, response) {
  const body = await readBody(request);
  const payload = JSON.parse(body || "{}");
  const url = String(payload.url || "");

  if (!isMediaUrl(url)) {
    sendJSON(response, 400, { ok: false, error: "Not a media URL" });
    return;
  }

  await mkdir(join(root, "data"), { recursive: true });
  await appendFile(mediaLogFile, `${JSON.stringify({
    url,
    source: payload.source || "app",
    page: payload.page || "",
    selected: payload.selected || null,
    capturedAt: payload.capturedAt || new Date().toISOString(),
  })}\n`);

  sendJSON(response, 200, { ok: true });
}

async function handleNetworkLog(request, response) {
  const body = await readBody(request);
  const payload = JSON.parse(body || "{}");
  const entry = sanitizeNetworkEntry(payload);

  if (!entry) {
    sendJSON(response, 400, { ok: false, error: "Not a network timing entry" });
    return;
  }

  await mkdir(join(root, "data"), { recursive: true });
  await appendFile(networkLogFile, `${JSON.stringify(entry)}\n`);
  sendJSON(response, 200, { ok: true });
}

async function handleStreamProxy(requestUrl, response, request) {
  const source = requestUrl.searchParams.get("url") || "";
  if (!isHttpUrl(source)) {
    sendJSON(response, 400, { ok: false, error: "Missing URL" });
    return;
  }

  const method = request.method || "GET";
  const isHead = method === "HEAD";
  const upstream = await fetch(source, {
    method: isHead ? "HEAD" : "GET",
    headers: getProxyRequestHeaders(request),
  });

  if (!upstream.ok) {
    sendJSON(response, upstream.status, { ok: false, error: `Upstream ${upstream.status}`, source });
    return;
  }

  const contentType = upstream.headers.get("content-type") || "";
  const isPlaylist = contentType.includes("mpegurl") || /\.m3u8(?:$|[?#])/i.test(source);

  if (isPlaylist) {
    response.writeHead(200, {
      "content-type": "application/vnd.apple.mpegurl; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, HEAD, OPTIONS",
    });
    if (isHead) {
      response.end();
      return;
    }

    const text = await upstream.text();
    response.end(rewritePlaylist(text, source));
    return;
  }

  if (isHead) {
    const length = upstream.headers.get("content-length");
    response.writeHead(200, {
      "content-type": getProxyContentType(source, contentType),
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, HEAD, OPTIONS",
      ...(length ? { "content-length": length } : {}),
    });
    response.end();
    return;
  }

  const body = Buffer.from(await upstream.arrayBuffer());
  response.writeHead(200, {
    "content-type": getProxyContentType(source, contentType),
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, HEAD, OPTIONS",
    "content-length": body.length,
  });
  response.end(body);
}

const VAPLAYER_API = "https://streamdata.vaplayer.ru/api.php";
const VAPLAYER_REFERER = "https://nextgencloudfabric.com/";
const VAPLAYER_ORIGIN = "https://nextgencloudfabric.com";
const DEFAULT_BROWSER_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
const resolveCache = new Map();
const RESOLVE_TTL_MS = 5 * 60 * 1000;

async function handleStreamResolve(requestUrl, response) {
  const id = String(requestUrl.searchParams.get("id") || requestUrl.searchParams.get("imdb") || requestUrl.searchParams.get("tmdb") || "").trim();
  if (!id) {
    sendJSON(response, 400, { ok: false, error: "Missing id (imdb or tmdb)" });
    return;
  }

  const type = String(requestUrl.searchParams.get("type") || "movie").toLowerCase() === "tv" ? "tv" : "movie";
  const season = String(requestUrl.searchParams.get("season") || "").trim();
  const episode = String(requestUrl.searchParams.get("episode") || "").trim();
  const idType = id.startsWith("tt") ? "imdb" : "tmdb";

  const cacheKey = `${idType}:${id}:${type}:${season}:${episode}`;
  const cached = resolveCache.get(cacheKey);
  if (cached && Date.now() - cached.at < RESOLVE_TTL_MS) {
    sendJSON(response, 200, { ok: true, cached: true, ...cached.data });
    return;
  }

  const upstream = new URL(VAPLAYER_API);
  upstream.searchParams.set(idType, id);
  upstream.searchParams.set("type", type);
  if (type === "tv" && season && episode) {
    upstream.searchParams.set("season", season);
    upstream.searchParams.set("episode", episode);
  }

  try {
    const res = await fetch(upstream.toString(), {
      headers: {
        "user-agent": DEFAULT_BROWSER_USER_AGENT,
        referer: VAPLAYER_REFERER,
        origin: VAPLAYER_ORIGIN,
        accept: "application/json, text/plain, */*",
      },
    });
    if (!res.ok) {
      sendJSON(response, res.status, { ok: false, error: `Upstream ${res.status}` });
      return;
    }

    const payload = await res.json();
    if (payload.status_code != 200 && payload.status_code !== "200") {
      sendJSON(response, 502, { ok: false, error: "Upstream did not return a 200 status", upstream: payload });
      return;
    }

    const streams = Array.isArray(payload?.data?.stream_urls) ? payload.data.stream_urls : [];
    if (!streams.length) {
      sendJSON(response, 404, { ok: false, error: "No streams in upstream response" });
      return;
    }

    const data = {
      url: streams[0],
      streams,
      title: payload.data.title || "",
      fileName: payload.data.file_name || "",
      backdrop: payload.data.backdrop || "",
      thumbnails: payload.data.thumbnails_url || "",
      type,
      id,
    };
    resolveCache.set(cacheKey, { at: Date.now(), data });
    sendJSON(response, 200, { ok: true, cached: false, ...data });
  } catch (error) {
    sendJSON(response, 502, { ok: false, error: String(error?.message || error) });
  }
}

function sendResolveOptions(response) {
  response.writeHead(204, {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-allow-headers": "*",
    "access-control-max-age": "86400",
  });
  response.end();
}

function sendProxyOptions(response) {
  response.writeHead(204, {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, HEAD, OPTIONS",
    "access-control-allow-headers": "*",
    "access-control-max-age": "86400",
  });
  response.end();
}

function rewritePlaylist(text, source) {
  return text.split(/\r?\n/).map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return line;
    if (trimmed.startsWith("#")) {
      return line.replace(/URI="([^"]+)"/g, (_match, uri) => `URI="${proxyUrl(uri, source)}"`);
    }
    return proxyUrl(trimmed, source);
  }).join("\n");
}

function proxyUrl(value, base) {
  const absolute = new URL(value, base).toString();
  return `/__streamline-proxy?url=${encodeURIComponent(absolute)}`;
}

function getProxyContentType(source, upstreamType) {
  if (/\.(m4s|mp4)(?:$|[?#])/i.test(source)) return "video/mp4";
  if (/\.(ts|html)(?:$|[?#])/i.test(source)) return "video/mp2t";
  return upstreamType || "application/octet-stream";
}

function getProxyRequestHeaders(request) {
  const headers = {
    accept: request.headers.accept || "*/*",
    referer: process.env.STREAMLINE_PROXY_REFERER || VAPLAYER_REFERER,
    origin: process.env.STREAMLINE_PROXY_ORIGIN || VAPLAYER_ORIGIN,
    "user-agent": process.env.STREAMLINE_PROXY_USER_AGENT || DEFAULT_BROWSER_USER_AGENT,
  };

  if (request.headers.range) {
    headers.range = request.headers.range;
  }

  return headers;
}

async function serveStatic(request, response) {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  const pathname = decodeURIComponent(url.pathname);
  const requested = pathname === "/" ? "/index.html" : pathname;
  const normalized = normalize(requested).replace(/^(\.\.[/\\])+/, "");
  const filePath = resolve(join(root, normalized));

  if (!filePath.startsWith(root)) {
    send(response, 403, "Forbidden");
    return;
  }

  const info = await stat(filePath).catch(() => null);
  if (!info?.isFile()) {
    send(response, 404, "Not found");
    return;
  }

  const contentType = mimeTypes.get(extname(filePath).toLowerCase()) || "application/octet-stream";
  response.writeHead(200, {
    "content-type": contentType,
    "cache-control": "no-store",
  });

  if (request.method === "HEAD") {
    response.end();
    return;
  }

  response.end(await readFile(filePath));
}

function readBody(request) {
  return new Promise((resolveBody, rejectBody) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 64 * 1024) {
        request.destroy();
        rejectBody(new Error("Request body too large"));
      }
    });
    request.on("end", () => resolveBody(body));
    request.on("error", rejectBody);
  });
}

function isMediaUrl(value = "") {
  return isHttpUrl(value) && /\.(m3u8|mp4|m4v|mov|webm)(?:$|[?#])/i.test(new URL(value).pathname + new URL(value).search);
}

function sanitizeNetworkEntry(payload = {}) {
  const url = String(payload.url || "");
  if (!isHttpUrl(url)) return null;

  return {
    url,
    source: String(payload.source || "performance").slice(0, 80),
    initiatorType: String(payload.initiatorType || "").slice(0, 80),
    duration: toFiniteNumber(payload.duration),
    startTime: toFiniteNumber(payload.startTime),
    transferSize: toFiniteNumber(payload.transferSize),
    encodedBodySize: toFiniteNumber(payload.encodedBodySize),
    decodedBodySize: toFiniteNumber(payload.decodedBodySize),
    responseStatus: toFiniteNumber(payload.responseStatus),
    nextHopProtocol: String(payload.nextHopProtocol || "").slice(0, 80),
    page: String(payload.page || "").slice(0, 2000),
    selected: payload.selected || null,
    capturedAt: payload.capturedAt || new Date().toISOString(),
  };
}

function toFiniteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function isHttpUrl(value = "") {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol);
  } catch {
    return false;
  }
}

function send(response, status, text) {
  response.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
  });
  response.end(text);
}

function sendJSON(response, status, data) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
  });
  response.end(JSON.stringify(data));
}
