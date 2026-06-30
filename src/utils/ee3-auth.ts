import type { ProxyConfig } from "@/utils/config";

/*
 * Edge-side ee3 authentication. ee3 (a SvelteKit app) logs in via a form POST that
 * is guarded against cross-site submissions, so we send same-origin headers
 * (Origin/Referer/Sec-Fetch-Site) and read the `session` cookie off the 303 it
 * answers with. The session is cached in module scope (survives a warm instance,
 * re-minted on cold start); `clearSession()` drops it so the route can re-auth once
 * on a 401/403. Credentials + session are EDGE secrets — never sent to the browser.
 *
 * Why the edge (not the backend) holds this: ee3's torrent-stream uuid is bound to
 * the session that read it, so the same session must both resolve AND stream — which
 * only works if one party (the edge) owns the whole flow. See utils/ee3.ts.
 */

let cachedSession: string | null = null;
let inFlight: Promise<string | null> | null = null;

export function clearSession(): void {
  cachedSession = null;
  inFlight = null;
}

/** Same-origin headers ee3's CSRF / anti-hotlink guards require. */
export function ee3SameOrigin(host: string, referer?: string): Record<string, string> {
  const base = `https://${host}`;
  return {
    Origin: base,
    Referer: referer ?? `${base}/`,
    "Sec-Fetch-Site": "same-origin",
    "Sec-Fetch-Mode": "cors",
  };
}

async function authenticate(cfg: ProxyConfig): Promise<string | null> {
  try {
    const base = `https://${cfg.ee3Host}`;
    const body = new URLSearchParams({
      username: cfg.ee3Username,
      password: cfg.ee3Password,
    });
    const resp = await fetch(`${base}/login`, {
      method: "POST",
      headers: {
        ...ee3SameOrigin(cfg.ee3Host, `${base}/`),
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": cfg.defaultUserAgent,
      },
      body: body.toString(),
      // The session cookie is set on the 303 — don't follow it (the final 200
      // wouldn't carry the Set-Cookie).
      redirect: "manual",
    });
    // Prefer getSetCookie() (Node 18.14+/undici) which un-folds multiple cookies;
    // fall back to the combined header on runtimes without it.
    const raw =
      typeof (resp.headers as { getSetCookie?: () => string[] }).getSetCookie === "function"
        ? (resp.headers as unknown as { getSetCookie: () => string[] }).getSetCookie()
        : [resp.headers.get("set-cookie") ?? ""];
    for (const c of raw) {
      const m = /(?:^|[;,\s])session=([^;]+)/.exec(c || "");
      if (m && m[1]) {
        cachedSession = m[1];
        return cachedSession;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** The cached ee3 session, authenticating if needed. null when unconfigured/failed. */
export function getSession(cfg: ProxyConfig): Promise<string | null> {
  if (!cfg.ee3Username) return Promise.resolve(null);
  if (cachedSession) return Promise.resolve(cachedSession);
  if (!inFlight) {
    inFlight = authenticate(cfg).finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}
