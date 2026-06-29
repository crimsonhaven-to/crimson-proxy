import type { ProxyConfig } from "@/utils/config";

/*
 * Edge token injection (New System §4/§8 — the `/mw`-style "edge holds the secret"
 * pattern, here for Jellyfin). The user's Jellyfin access token lives ONLY in this
 * proxy's env (NITRO_JELLYFIN_TOKEN), never in the browser. When a signed request
 * targets the configured Jellyfin host, we add the token to the upstream fetch
 * (query `api_key` + an Authorization header), so the bytes flow
 * Jellyfin → edge → viewer with the token never leaving the edge.
 *
 * Jellyfin bakes `api_key` into the children of the HLS playlists it returns, so
 * when we rewrite a playlist we STRIP the token from each child first (it would
 * otherwise be baked into the browser-visible signed link) — the edge re-injects
 * it when that child is fetched. Net: the token is present on exactly the
 * edge→Jellyfin hop and nowhere a client can see.
 */

const API_KEY_PARAMS = ["api_key", "apikey"];

/** Is this upstream URL a Jellyfin host we hold a token for? */
export function jellyfinInjectable(url: string, cfg: ProxyConfig): boolean {
  if (!cfg.jellyfinToken || cfg.jellyfinHosts.length === 0) return false;
  try {
    return cfg.jellyfinHosts.includes(new URL(url).hostname.toLowerCase());
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
