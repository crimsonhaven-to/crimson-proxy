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
  getToken as getJellyfinToken,
  clearToken as clearJellyfinToken,
} from "@/utils/jellyfin-auth";
import {
  isEe3Marker,
  resolveEe3,
  invalidateEe3,
  ee3StreamHeaders,
} from "@/utils/ee3";
import {
  getSession as getEe3Session,
  clearSession as clearEe3Session,
} from "@/utils/ee3-auth";
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

  // ee3 edge resolution: the signed `/__ee3?title=&year=` marker isn't a fetchable
  // URL — the edge logs in, searches, reads the movie's torrentStreamUrl, and relays
  // the (session + same-origin gated) stream. The session-bound uuid is cached so
  // the many Range requests of a 20GB file reuse one resolve. See utils/ee3.ts.
  if (isEe3Marker(fields.url, cfg)) {
    const streamOnce = async (refresh: boolean): Promise<Response | null> => {
      const resolved = await resolveEe3(cfg, fields.url, refresh);
      if (!resolved) return null;
      const session = await getEe3Session(cfg);
      if (!session) return null;
      const streamUrl = `https://${cfg.ee3Host}${resolved.streamPath}`;
      return fetch(streamUrl, {
        method: event.method,
        headers: ee3StreamHeaders(cfg, session, resolved.slug, rangeHeader),
        redirect: "follow",
      });
    };
    let upstream: Response | null;
    try {
      upstream = await streamOnce(false);
      // Stale session / expired torrent mount → drop caches, re-auth + re-resolve once.
      if (upstream && [401, 403, 404, 410].includes(upstream.status)) {
        invalidateEe3(fields.url);
        clearEe3Session();
        upstream = await streamOnce(true);
      }
    } catch (e) {
      return json({ error: "ee3 upstream fetch failed", detail: String(e) }, 502);
    }
    if (!upstream) return json({ error: "ee3 resolve failed" }, 502);
    const ct = upstream.headers.get("content-type") ?? "";
    // ee3 serves the file as application/force-download (would download, not play);
    // relabel as video so the <video> element streams it. Files are MKV in practice.
    const override = /force-download|octet-stream/i.test(ct) ? "video/x-matroska" : undefined;
    const headers = buildResponseHeaders(upstream, upstream.url || fields.url, override);
    return new Response(event.method === "HEAD" ? null : upstream.body, {
      status: upstream.status,
      headers,
    });
  }
  const upstreamHeaders = buildUpstreamHeaders(
    fields,
    cfg.defaultUserAgent,
    rangeHeader,
  );

  // Edge token injection: if this is the configured Jellyfin host, the edge
  // authenticates (cached) and adds the token (query + Authorization) to the
  // upstream fetch. The token stays on the edge — never in `fields.url` (what the
  // browser signed/sees).
  const injectJellyfin = jellyfinInjectable(fields.url, cfg);

  const fetchUpstream = async (token: string | null): Promise<Response> => {
    let url = fields.url;
    if (token) {
      url = withJellyfinToken(fields.url, token);
      upstreamHeaders.set("Authorization", `MediaBrowser Token="${token}"`);
    }
    return fetch(url, {
      method: event.method,
      headers: upstreamHeaders,
      redirect: "follow",
    });
  };

  let upstream: Response;
  try {
    if (injectJellyfin) {
      upstream = await fetchUpstream(await getJellyfinToken(cfg));
      // Cached session expired/invalidated → re-auth once and retry.
      if (upstream.status === 401) {
        clearJellyfinToken();
        upstream = await fetchUpstream(await getJellyfinToken(cfg));
      }
    } else {
      upstream = await fetchUpstream(null);
    }
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
