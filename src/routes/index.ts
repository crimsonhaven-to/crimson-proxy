import { getConfig } from "@/utils/config";
import { parseFields } from "@/utils/links";
import { verify } from "@/utils/signing";
import { isSafeUpstream } from "@/utils/ssrf";
import { looksLikePlaylist, rewritePlaylist } from "@/utils/hls";
import {
  jellyfinInjectable,
  withJellyfinToken,
  stripJellyfinToken,
} from "@/utils/inject";
import {
  CORS_HEADERS,
  buildResponseHeaders,
  buildUpstreamHeaders,
} from "@/utils/headers";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

export default defineEventHandler(async (event): Promise<Response> => {
  // CORS preflight — answer before doing any work.
  if (event.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (event.method !== "GET" && event.method !== "HEAD") {
    return json({ error: "Method not allowed" }, 405);
  }

  const cfg = getConfig(event);
  const query = getQuery(event) as Record<string, any>;
  const { fields, sig } = parseFields(query);

  // No target => health check (also confirms the secret is wired without leaking it).
  if (!fields.url) {
    return json({
      ok: true,
      service: "crimson-proxy",
      version: cfg.version,
      signed: cfg.requireSignature,
    });
  }

  // Gate: only serve URLs the backend signed (unless running open in dev).
  if (cfg.requireSignature) {
    if (!(await verify(cfg.secret, fields, sig))) {
      return json({ error: "Bad or missing signature" }, 401);
    }
  }

  if (!isSafeUpstream(fields.url)) {
    return json({ error: "Refused upstream URL" }, 400);
  }

  const rangeHeader = getHeader(event, "range") ?? null;
  const upstreamHeaders = buildUpstreamHeaders(
    fields,
    cfg.defaultUserAgent,
    rangeHeader,
  );

  // Edge token injection: if this is the configured Jellyfin host, add the token
  // (query + Authorization) to the upstream fetch. The token stays on the edge —
  // it's never in `fields.url` (what the browser signed/sees).
  const injectJellyfin = jellyfinInjectable(fields.url, cfg);
  let fetchUrl = fields.url;
  if (injectJellyfin) {
    fetchUrl = withJellyfinToken(fields.url, cfg.jellyfinToken);
    upstreamHeaders.set("Authorization", `MediaBrowser Token="${cfg.jellyfinToken}"`);
  }

  let upstream: Response;
  try {
    upstream = await fetch(fetchUrl, {
      method: event.method,
      headers: upstreamHeaders,
      redirect: "follow",
    });
  } catch (e) {
    return json({ error: "Upstream fetch failed", detail: String(e) }, 502);
  }

  const finalUrl = upstream.url || fields.url;
  const contentType = upstream.headers.get("content-type") ?? "";

  // HLS playlist: buffer it (playlists are tiny), rewrite every sub-resource back
  // through us, and hand it back as a proper m3u8. This is what keeps segment
  // bytes off the backend — the player fetches them from us, not the CDN.
  if (event.method === "GET" && looksLikePlaylist(finalUrl, contentType)) {
    const body = await upstream.text();
    const rewritten = await rewritePlaylist(
      body,
      finalUrl,
      fields,
      cfg.secret,
      cfg.requireSignature,
      // For Jellyfin children, strip the api_key Jellyfin bakes in so the token is
      // never in a browser-visible link; the edge re-injects it on the child fetch.
      injectJellyfin
        ? (abs) => (jellyfinInjectable(abs, cfg) ? stripJellyfinToken(abs) : abs)
        : undefined,
    );
    const headers = buildResponseHeaders(
      upstream,
      finalUrl,
      "application/vnd.apple.mpegurl",
    );
    // The rewritten body's length differs from upstream's — drop the stale one.
    headers.delete("Content-Length");
    return new Response(rewritten, { status: upstream.status, headers });
  }

  // Everything else (media segments, mp4, keys): stream straight through with
  // Range/partial-content semantics preserved. Returning the upstream body
  // ReadableStream means we never buffer the whole segment in memory.
  const headers = buildResponseHeaders(upstream, finalUrl);
  return new Response(event.method === "HEAD" ? null : upstream.body, {
    status: upstream.status,
    headers,
  });
});
