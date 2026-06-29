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
  };
}
