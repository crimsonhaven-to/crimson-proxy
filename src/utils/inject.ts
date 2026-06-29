import type { ProxyConfig } from "@/utils/config";

/*
 * Edge token injection (New System §4/§8 — the `/mw`-style "edge holds the secret"
 * pattern, here for Jellyfin). The edge authenticates to Jellyfin itself
 * (username/password → access token; see utils/jellyfin-auth.ts), and that token
 * lives ONLY in this proxy, never in the browser. When a signed request targets the
 * configured Jellyfin host, we add the token to the upstream fetch (query `api_key`
 * + an Authorization header), so the bytes flow Jellyfin → edge → viewer with the
 * token never leaving the edge.
 *
 * Jellyfin bakes `api_key` into the children of the HLS playlists it returns, so
 * when we rewrite a playlist we STRIP the token from each child first (it would
 * otherwise be baked into the browser-visible signed link) — the edge re-injects
 * it when that child is fetched. Net: the token is present on exactly the
 * edge→Jellyfin hop and nowhere a client can see.
 */

const API_KEY_PARAMS = ["api_key", "apikey"];

/** Is Jellyfin edge injection configured at all (a token, or url+username)? */
export function jellyfinConfigured(cfg: ProxyConfig): boolean {
  return Boolean(cfg.jellyfinToken || (cfg.jellyfinUrl && cfg.jellyfinUsername));
}

/** The Jellyfin host we inject for — the hostname of the configured Jellyfin URL. */
function jellyfinHost(cfg: ProxyConfig): string {
  try {
    return cfg.jellyfinUrl ? new URL(cfg.jellyfinUrl).hostname.toLowerCase() : "";
  } catch {
    return "";
  }
}

/** Is this upstream URL the configured Jellyfin host? */
export function jellyfinInjectable(url: string, cfg: ProxyConfig): boolean {
  const host = jellyfinHost(cfg);
  if (!host || !jellyfinConfigured(cfg)) return false;
  try {
    return new URL(url).hostname.toLowerCase() === host;
  } catch {
    return false;
  }
}

/** Add the Jellyfin token to a URL's query (only on the edge→Jellyfin fetch). */
export function withJellyfinToken(url: string, token: string): string {
  try {
    const u = new URL(url);
    const has = [...u.searchParams.keys()].some((k) =>
      API_KEY_PARAMS.includes(k.toLowerCase()),
    );
    if (!has) u.searchParams.set("api_key", token);
    return u.toString();
  } catch {
    return url;
  }
}

/** Strip any api_key/ApiKey so the token isn't baked into a browser-visible link. */
export function stripJellyfinToken(url: string): string {
  try {
    const u = new URL(url);
    for (const k of [...u.searchParams.keys()]) {
      if (API_KEY_PARAMS.includes(k.toLowerCase())) u.searchParams.delete(k);
    }
    return u.toString();
  } catch {
    return url;
  }
}
