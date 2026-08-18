import type { SignedFields } from "@/utils/signing";

// CORS: the whole point of this proxy is to let the browser's hls.js / <video>
// read a cross-origin stream, so every response is fully permissive. Range +
// the headers hls.js inspects are exposed so seeking works.
export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Range, Content-Type",
  "Access-Control-Expose-Headers":
    "Content-Length, Content-Range, Accept-Ranges, Content-Type, X-Final-Destination",
  "Access-Control-Max-Age": "86400",
  Vary: "Origin",
};

// Headers we build for the *upstream* fetch. We never forward the browser's own
// headers (which would leak cf-*/x-forwarded-* and the viewer's UA); instead we
// send only the minimal, deterministic set the gated CDNs expect — mirroring the
// backend resolvers' `_PROXY_UPSTREAM_HEADERS`.
export function buildUpstreamHeaders(
  fields: SignedFields,
  defaultUserAgent: string,
  rangeHeader: string | null,
): Headers {
  const h = new Headers();
  h.set("User-Agent", fields.userAgent || defaultUserAgent);
  if (fields.referer) h.set("Referer", fields.referer);
  if (fields.origin) h.set("Origin", fields.origin);
  h.set("Accept", "*/*");
  h.set("Accept-Language", "en-US,en;q=0.9");
  // Pass the viewer's Range straight through so the CDN can serve partial
  // content and the player can seek. Segment bytes then stream CDN -> proxy ->
  // viewer without ever buffering the whole file.
  if (rangeHeader) h.set("Range", rangeHeader);
  return h;
}

// Subset of upstream response headers worth forwarding to the viewer for media
// playback. Content-Type is handled separately (rewritten for playlists).
const FORWARD_RESPONSE_HEADERS = [
  "content-range",
  "accept-ranges",
  "content-length",
  "cache-control",
  "expires",
  "last-modified",
  "etag",
];

export function buildResponseHeaders(
  upstream: Response,
  finalUrl: string,
  contentTypeOverride?: string,
): Headers {
  const h = new Headers(CORS_HEADERS);
  for (const name of FORWARD_RESPONSE_HEADERS) {
    const v = upstream.headers.get(name);
    if (v) h.set(name, v);
  }
  h.set(
    "Content-Type",
    contentTypeOverride ||
      upstream.headers.get("content-type") ||
      "application/octet-stream",
  );
  h.set("X-Final-Destination", finalUrl);
  return h;
}
