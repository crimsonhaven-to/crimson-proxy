import { buildProxyPath } from "@/utils/links";
import type { SignedFields } from "@/utils/signing";

// Mirrors the backend resolvers' `rewrite_playlist`: rewrite an m3u8 so every
// sub-resource (variant playlists, segments, and any URI="" attribute — keys via
// EXT-X-KEY, init segments via EXT-X-MAP) is absolutized against the playlist's
// own URL and routed back through this proxy, re-signed. Each proxied variant is
// itself rewritten when fetched, so master -> variant -> segments all stay on
// our origin and the player never has to touch the gated CDN directly.

const URI_ATTR = /URI="([^"]+)"/g;

export function looksLikePlaylist(url: string, contentType: string): boolean {
  const ct = contentType.toLowerCase();
  if (
    ct.includes("mpegurl") || // application/vnd.apple.mpegurl, audio/x-mpegurl
    ct.includes("application/x-mpegurl")
  )
    return true;
  // Fall back to the path: some CDNs serve m3u8 as text/plain or octet-stream.
  try {
    return new URL(url).pathname.toLowerCase().endsWith(".m3u8");
  } catch {
    return false;
  }
}

export async function rewritePlaylist(
  text: string,
  baseUrl: string,
  parent: SignedFields,
  secret: string,
  requireSignature: boolean,
): Promise<string> {
  // Same referer/origin/ua as the parent playlist for every child.
  const route = (raw: string) =>
    buildProxyPath(secret, requireSignature, {
      ...parent,
      url: new URL(raw.trim(), baseUrl).toString(),
    });

  const lines = text.split("\n");
  const out: string[] = new Array(lines.length);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const stripped = line.trim();

    if (stripped === "") {
      out[i] = line;
    } else if (stripped.startsWith("#")) {
      if (stripped.includes('URI="')) {
        // Rewrite each URI="..." in the tag (EXT-X-KEY, EXT-X-MAP, EXT-X-MEDIA…).
        const parts: string[] = [];
        let last = 0;
        URI_ATTR.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = URI_ATTR.exec(line)) !== null) {
          parts.push(line.slice(last, m.index));
          parts.push(`URI="${await route(m[1])}"`);
          last = m.index + m[0].length;
        }
        parts.push(line.slice(last));
        out[i] = parts.join("");
      } else {
        out[i] = line;
      }
    } else {
      // A resource line (variant playlist or media segment).
      out[i] = await route(stripped);
    }
  }

  return out.join("\n");
}
