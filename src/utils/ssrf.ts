// Defence-in-depth against SSRF. In production every URL we fetch was signed by
// the backend, so the real gate is the signature — but a cheap hostname/scheme
// check stops the proxy being pointed at internal infrastructure if a secret
// ever leaks, and keeps OPEN (dev) mode from being a LAN scanner. Full
// DNS-resolution checking isn't portable to edge runtimes (no DNS API), so this
// is a literal-host check: good enough as a second layer.

const BLOCKED_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "::1",
  "[::1]",
  "metadata.google.internal",
]);

function isPrivateIPv4(host: string): boolean {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // loopback
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 169 && b === 254) return true; // link-local / cloud metadata
  if (a === 0) return true;
  return false;
}

export function isSafeUpstream(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  const host = url.hostname.toLowerCase();
  if (BLOCKED_HOSTS.has(host)) return false;
  if (isPrivateIPv4(host)) return false;
  // Block bare-IP IPv6 private ranges (fc00::/7 unique-local, fe80::/10 link-local).
  if (host.startsWith("[fc") || host.startsWith("[fd") || host.startsWith("[fe8"))
    return false;
  return true;
}
