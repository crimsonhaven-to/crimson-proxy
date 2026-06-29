import type { ProxyConfig } from "@/utils/config";

/*
 * Edge-side Jellyfin authentication. The user runs Jellyfin with a username +
 * password (not a long-lived API token), so — mirroring the backend resolver — the
 * edge logs in itself via `POST /Users/AuthenticateByName` and caches the returned
 * AccessToken. The token is then injected on upstream Jellyfin fetches
 * (utils/inject.ts), never reaching the browser.
 *
 * Caching: the token is held in module scope, which survives within a warm
 * serverless instance and is simply re-minted on a cold start. `clearToken()` drops
 * it so the route can re-auth once on a 401 (expired/invalidated session).
 *
 * If `jellyfinToken` is set in config it's used directly (the auth call is skipped)
 * — a pre-minted-token shortcut for setups that have one.
 */

// Stable device identity Jellyfin ties the session to (matches the backend's shape).
const AUTH_HEADER =
  'MediaBrowser Client="Crimson", Device="Crimson Proxy", DeviceId="crimson-proxy", Version="1.0"';

let cachedToken: string | null = null;
let inFlight: Promise<string | null> | null = null;

export function clearToken(): void {
  cachedToken = null;
  inFlight = null;
}

async function authenticate(cfg: ProxyConfig): Promise<string | null> {
  try {
    const resp = await fetch(`${cfg.jellyfinUrl}/Users/AuthenticateByName`, {
      method: "POST",
      headers: { Authorization: AUTH_HEADER, "Content-Type": "application/json" },
      body: JSON.stringify({ Username: cfg.jellyfinUsername, Pw: cfg.jellyfinPassword }),
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as { AccessToken?: string };
    cachedToken = data?.AccessToken ?? null;
    return cachedToken;
  } catch {
    return null;
  }
}

/**
 * The Jellyfin access token to inject, authenticating if needed. Returns null when
 * Jellyfin isn't configured or auth fails (the route then proxies un-injected — the
 * request 401s upstream, exactly as it would without the feature).
 */
export async function getToken(cfg: ProxyConfig): Promise<string | null> {
  if (cfg.jellyfinToken) return cfg.jellyfinToken; // explicit pre-minted token
  if (!cfg.jellyfinUrl || !cfg.jellyfinUsername) return null;
  if (cachedToken) return cachedToken;
  // Collapse concurrent first-hit auths (a master + its variants resolve together).
  if (!inFlight) {
    inFlight = authenticate(cfg).finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}
