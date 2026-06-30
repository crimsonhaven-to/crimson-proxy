import type { ProxyConfig } from "@/utils/config";
import { getSession, ee3SameOrigin } from "@/utils/ee3-auth";

/*
 * ee3 edge resolution (New System §4/§8). Unlike Jellyfin (inject a token into a
 * pre-resolved URL), ee3's playable URL can't be resolved by anyone but the streamer:
 * the `/api/torrent/proxy/{uuid}` is bound to the SESSION that read it (the uuid
 * rotates per session) and the stream is gated on `Sec-Fetch-Site: same-origin`. So
 * the edge owns the whole flow on its own session:
 *
 *   marker  https://<host>/__ee3?title=…&year=…   (signed by the backend /sign grant)
 *     → GET /api/movies?title=…           → match by title+year → movie slug (item.id)
 *     → GET /movies/{slug}/__data.json    → the `torrentStreamUrl` (/api/torrent/proxy/{uuid})
 *     → GET that, with session cookie + Referer:/movies/{slug} + same-origin headers
 *
 * The (slug, streamPath) is cached per marker (short TTL): a 20GB file is fetched as
 * many Range requests, and re-resolving each one would be slow AND re-mint the uuid.
 * The route invalidates + re-auths once on a 401/403/404 (expired session / dropped
 * torrent mount). Creds + session never reach the browser.
 */

const MARKER_PATH = "/__ee3";
const PROXY_RE = /\/api\/torrent\/proxy\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

export interface Ee3Resolved {
  slug: string;
  streamPath: string; // "/api/torrent/proxy/{uuid}"
}

// marker URL -> resolved (slug, streamPath). Module scope: warm-instance cache.
const cache = new Map<string, { v: Ee3Resolved; ts: number }>();
const TTL_MS = 2 * 60 * 60 * 1000; // 2h — long enough to outlive a full playthrough

/** Is ee3 configured AND is this the `/__ee3` resolve marker? */
export function isEe3Marker(url: string, cfg: ProxyConfig): boolean {
  if (!cfg.ee3Username) return false;
  try {
    return new URL(url).pathname === MARKER_PATH;
  } catch {
    return false;
  }
}

export function parseMarker(url: string): { title: string; year: number | null } {
  const u = new URL(url);
  const y = u.searchParams.get("year");
  return {
    title: u.searchParams.get("title") || "",
    year: y && /^\d{4}$/.test(y) ? parseInt(y, 10) : null,
  };
}

export function invalidateEe3(markerUrl: string): void {
  cache.delete(markerUrl);
}

function norm(s: string): string {
  return (s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

async function searchSlug(
  cfg: ProxyConfig,
  session: string,
  title: string,
  year: number | null,
): Promise<string | null> {
  const base = `https://${cfg.ee3Host}`;
  const resp = await fetch(`${base}/api/movies?title=${encodeURIComponent(title)}`, {
    headers: {
      Cookie: `session=${session}`,
      "User-Agent": cfg.defaultUserAgent,
      Accept: "application/json",
      ...ee3SameOrigin(cfg.ee3Host, `${base}/search`),
    },
    redirect: "manual",
  });
  if (!resp.ok) return null;
  let data: { items?: Array<{ id?: string; tmdb_data?: { title?: string; release_date?: string } }> };
  try {
    data = (await resp.json()) as typeof data;
  } catch {
    return null;
  }
  const items = data.items ?? [];
  const want = norm(title);
  let loose: string | null = null;
  for (const it of items) {
    if (!it.id) continue;
    const td = it.tmdb_data ?? {};
    if (norm(td.title || "") !== want) continue;
    if (!loose) loose = it.id; // title matches; keep as year-agnostic fallback
    if (year != null && td.release_date) {
      const y = parseInt(String(td.release_date).slice(0, 4), 10);
      if (y && Math.abs(y - year) > 1) continue;
    }
    return it.id;
  }
  return loose;
}

async function resolveStreamPath(
  cfg: ProxyConfig,
  session: string,
  slug: string,
): Promise<string | null> {
  const base = `https://${cfg.ee3Host}`;
  const resp = await fetch(`${base}/movies/${slug}/__data.json`, {
    headers: {
      Cookie: `session=${session}`,
      "User-Agent": cfg.defaultUserAgent,
      ...ee3SameOrigin(cfg.ee3Host, `${base}/movies/${slug}`),
    },
    redirect: "manual",
  });
  if (!resp.ok) return null;
  const body = await resp.text();
  const m = body.match(PROXY_RE);
  return m ? m[0] : null;
}

/**
 * Resolve a `/__ee3` marker to (slug, streamPath), cached. `forceRefresh` skips the
 * cache after a stale-session/expired-mount error so the caller can retry once.
 */
export async function resolveEe3(
  cfg: ProxyConfig,
  markerUrl: string,
  forceRefresh = false,
): Promise<Ee3Resolved | null> {
  if (!forceRefresh) {
    const hit = cache.get(markerUrl);
    if (hit && Date.now() - hit.ts < TTL_MS) return hit.v;
  }
  const { title, year } = parseMarker(markerUrl);
  if (!title) return null;
  const session = await getSession(cfg);
  if (!session) return null;

  const slug = await searchSlug(cfg, session, title, year);
  if (!slug) return null;
  const streamPath = await resolveStreamPath(cfg, session, slug);
  if (!streamPath) return null;

  const v: Ee3Resolved = { slug, streamPath };
  cache.set(markerUrl, { v, ts: Date.now() });
  return v;
}

/** Headers for the actual torrent-proxy stream fetch (session + same-origin + Range). */
export function ee3StreamHeaders(
  cfg: ProxyConfig,
  session: string,
  slug: string,
  rangeHeader: string | null,
): Headers {
  const base = `https://${cfg.ee3Host}`;
  const h = new Headers();
  h.set("Cookie", `session=${session}`);
  h.set("User-Agent", cfg.defaultUserAgent);
  h.set("Accept", "*/*");
  h.set("Referer", `${base}/movies/${slug}`);
  h.set("Origin", base);
  h.set("Sec-Fetch-Site", "same-origin");
  h.set("Sec-Fetch-Mode", "cors");
  h.set("Sec-Fetch-Dest", "video");
  if (rangeHeader) h.set("Range", rangeHeader);
  return h;
}
