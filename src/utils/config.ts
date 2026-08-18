import type { H3Event } from "h3";

export interface ProxyConfig {
  /** Shared HMAC secret. Empty string => open mode (dev only). */
  secret: string;
  /** Whether signed requests are enforced. False only when no secret is set. */
  requireSignature: boolean;
  /** UA used when a signed request doesn't pin one. */
  defaultUserAgent: string;
  version: string;
  /**
   * Jellyfin edge token injection (New System §4/§8 — edge-held secret). The edge
   * authenticates to the user's Jellyfin server itself (username+password, mirroring
   * the backend) and injects the resulting access token for requests to that host.
   * The credentials/token are EDGE secrets — never sent to the browser. See
   * utils/inject.ts + utils/jellyfin-auth.ts.
   *   jellyfinUrl       — base URL of the Jellyfin server (also the inject host).
   *   jellyfinUsername  — login user.
   *   jellyfinPassword  — login password (may be empty).
   *   jellyfinToken     — OPTIONAL shortcut: a pre-minted access token; when set we
   *                       skip username/password auth and use it directly.
   */
  jellyfinUrl: string;
  jellyfinUsername: string;
  jellyfinPassword: string;
  jellyfinToken: string;
  /**
   * ee3 edge resolution (New System §4/§8 — edge-held secret). ee3's torrent-stream
   * uuid is session-bound and the stream is gated on Sec-Fetch-Site:same-origin, so
   * the edge can't just inject a header into a pre-resolved URL (the Jellyfin model)
   * — it owns the whole flow: log in, search by title, read the movie's
   * torrentStreamUrl, and relay it with the session cookie + same-origin headers.
   *   ee3Host      — ee3 base host (rotates; the stable `/__ee3` marker maps to it).
   *   ee3Username  — login user (empty => ee3 resolution disabled).
   *   ee3Password  — login password.
   */
  ee3Host: string;
  ee3Username: string;
  ee3Password: string;
}

// Read once per request from Nitro's runtime config. The values come from
// `nitro.config.ts` defaults, overridden by env at runtime: Nitro maps
// `NITRO_PROXY_SECRET` -> runtimeConfig.proxySecret and
// `NITRO_DEFAULT_USER_AGENT` -> runtimeConfig.defaultUserAgent automatically.
export function getConfig(event: H3Event): ProxyConfig {
  const rc = useRuntimeConfig(event);
  const secret = (rc.proxySecret ?? "").toString();
  return {
    secret,
    requireSignature: secret.length > 0,
    defaultUserAgent: (rc.defaultUserAgent ?? "").toString(),
    version: (rc.version ?? "0.0.0").toString(),
    jellyfinUrl: (rc.jellyfinUrl ?? "").toString().replace(/\/+$/, ""),
    jellyfinUsername: (rc.jellyfinUsername ?? "").toString(),
    jellyfinPassword: (rc.jellyfinPassword ?? "").toString(),
    jellyfinToken: (rc.jellyfinToken ?? "").toString(),
    ee3Host: ((rc.ee3Host ?? "ee3.me").toString() || "ee3.me").replace(/\/+$/, ""),
    ee3Username: (rc.ee3Username ?? "").toString(),
    ee3Password: (rc.ee3Password ?? "").toString(),
  };
}
