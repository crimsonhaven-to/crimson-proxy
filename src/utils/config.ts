import type { H3Event } from "h3";

export interface ProxyConfig {
  /** Shared HMAC secret. Empty string => open mode (dev only). */
  secret: string;
  /** Whether signed requests are enforced. False only when no secret is set. */
  requireSignature: boolean;
  /** UA used when a signed request doesn't pin one. */
  defaultUserAgent: string;
  version: string;
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
  };
}
