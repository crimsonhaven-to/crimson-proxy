import { sign, type SignedFields } from "@/utils/signing";

// Query-param names. Short, since they end up baked into every segment URL of a
// rewritten playlist. Keep in sync with the backend signer.
//   u  = upstream URL        (required)
//   r  = Referer to inject   (optional)
//   o  = Origin to inject    (optional)
//   ua = User-Agent to inject(optional)
//   s  = signature           (required when the proxy enforces signing)
export const PARAM = {
  url: "u",
  referer: "r",
  origin: "o",
  userAgent: "ua",
  sig: "s",
} as const;

export function parseFields(query: Record<string, any>): {
  fields: SignedFields;
  sig: string;
} {
  const get = (k: string) => {
    const v = query[k];
    return typeof v === "string" ? v : "";
  };
  return {
    fields: {
      url: get(PARAM.url),
      referer: get(PARAM.referer),
      origin: get(PARAM.origin),
      userAgent: get(PARAM.userAgent),
    },
    sig: get(PARAM.sig),
  };
}

// Build a self-referencing proxy path for a sub-resource discovered while
// rewriting a playlist. Carries the SAME referer/origin/ua as the parent (CDN
// gating is per-host, so sub-resources need the same headers) and a fresh
// signature — which we can mint because we hold the shared secret.
export async function buildProxyPath(
  secret: string,
  requireSignature: boolean,
  fields: SignedFields,
): Promise<string> {
  const p = new URLSearchParams();
  p.set(PARAM.url, fields.url);
  if (fields.referer) p.set(PARAM.referer, fields.referer);
  if (fields.origin) p.set(PARAM.origin, fields.origin);
  if (fields.userAgent) p.set(PARAM.userAgent, fields.userAgent);
  if (requireSignature) p.set(PARAM.sig, await sign(secret, fields));
  // Root-relative: resolves against whatever origin the proxy is served from,
  // so the same playlist works on Netlify, Cloudflare, or a custom domain.
  return `/?${p.toString()}`;
}
