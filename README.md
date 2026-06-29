# crimson-proxy 🩸

A **signed, HLS-aware CORS relay** for [Crimson Haven](https://crimsonhaven.to).
Its one job: move stream-segment bandwidth **off the backend** and onto free edge
hosting (Netlify / Cloudflare Workers), while staying impossible to abuse as an
open proxy.

## Why this exists

Most Crimson sources stream from CDNs that are gated behind a `Referer`/`Origin`
or simply serve no CORS, so today the backend re-fetches the playlist **and every
segment** server-side (`/voe_proxy`, `/playimdb_proxy`, …). That works, but all
the video bytes flow in and back out of the backend.

This proxy takes over that relaying. The backend keeps doing the clever part —
scraping and resolving the stream — but instead of handing the player a
`/{source}_proxy?…` path on its own origin, it hands a **signed link to this
proxy**. Segment bytes then go `CDN → edge proxy → viewer` and never touch the
backend.

```
            resolve (tiny)                 segments (huge)
 backend ───────────────▶ signed link ──▶  CDN ──▶ crimson-proxy ──▶ viewer
   │                                                   ▲
   └─ shares PROXY_SECRET ─────────────────────────────┘
```

## What makes it tailored (not a generic open proxy)

- **Signed-only.** Every link carries an HMAC over `url + referer + origin +
  user-agent`, signed by the backend with a shared secret. Unsigned/forged links
  get `401`. So nobody can use your free-tier bandwidth as a general-purpose
  proxy.
- **HLS-aware.** When it fetches an `.m3u8` it rewrites every variant / segment /
  `EXT-X-KEY` / `EXT-X-MAP` URI back through itself (re-signed — it holds the same
  secret), exactly like the backend's `rewrite_playlist`. The player only ever
  talks to the proxy.
- **Header injection.** Injects the per-stream `Referer`/`Origin`/`User-Agent`
  the gated CDNs require — the thing a browser can't set on its own media fetches.
- **Range passthrough.** Forwards `Range` and `206` partial content, streaming
  segment bodies without buffering, so seeking works.

## Request shape

```
GET /?u=<encoded upstream url>&r=<referer>&o=<origin>&ua=<user-agent>&s=<sig>
```

| param | meaning | required |
| ----- | --------------------------------- | ------------------------------ |
| `u`   | upstream URL to fetch             | yes                            |
| `r`   | `Referer` to inject               | no                             |
| `o`   | `Origin` to inject                | no                             |
| `ua`  | `User-Agent` to inject            | no (falls back to default UA)  |
| `s`   | signature (see below)             | yes, when a secret is set      |

`GET /` with no `u` is a health check.

## The signature contract

Keep this **byte-for-byte identical** on both sides. Canonical payload is the
four fields joined by `\n`, always in this order, empty string where absent:

```
<url>\n<referer>\n<origin>\n<user-agent>
sig = hex(HMAC-SHA256(secret, payload))[:32]
```

### Backend (Python) reference — drop-in for phase 1

```python
import os, hmac, hashlib, random
from urllib.parse import quote

# Comma-separated list of proxy origins. The SAME signed link works on any of
# them (the signature covers the query fields, not the host), so we just pick
# one per request — that's the load-balancing + failover headroom for free.
#   e.g. "https://crimson-proxy.netlify.app,https://crimson-proxy.<acct>.workers.dev"
PROXY_BASES = [b.strip().rstrip("/") for b in os.getenv("CRIMSON_PROXY_BASE", "").split(",") if b.strip()]
PROXY_SECRET = os.getenv("PROXY_SECRET", "").encode()      # SAME value every proxy has

def crimson_proxy_url(url: str, *, referer="", origin="", user_agent="") -> str:
    payload = "\n".join([url, referer, origin, user_agent])
    sig = hmac.new(PROXY_SECRET, payload.encode(), hashlib.sha256).hexdigest()[:32]
    q = (
        f"u={quote(url, safe='')}"
        f"&r={quote(referer, safe='')}"
        f"&o={quote(origin, safe='')}"
        f"&ua={quote(user_agent, safe='')}"
        f"&s={sig}"
    )
    return f"{random.choice(PROXY_BASES)}/?{q}"
```

A resolver that currently returns `_proxy_path_for(stream_url)` just returns
`crimson_proxy_url(stream_url, referer=…, origin=…, user_agent=…)` instead — when
`CRIMSON_PROXY_BASE` is set. Leave it unset (empty list) and the backend keeps
proxying itself, so this is a safe, flag-gated swap you can A/B per source. Set it
to **one** base to use a single proxy, or **several comma-separated** bases to
spread the load across hosts.

> ⚠️ **Only offload sources whose CDN gating is purely header-based**
> (`Referer`/`Origin`) — e.g. cinema.bz, PlayIMDb. A source whose stream token is
> **bound to the resolving machine's IP/ASN** (VOE: note the `asn=` param) can
> only be fetched from the backend that minted it; routing it through a proxy on
> another network (any edge host) just 403s. Those MUST stay same-origin.

> The proxy only rewrites the **first** playlist's children itself, so you only
> ever sign the top-level stream URL — segments are signed by the proxy.

## Deploy

One-time setup, then it's hands-off (pushes auto-deploy).

> **The one rule for running more than one proxy:** every host must carry the
> **same** `NITRO_PROXY_SECRET` (= the backend's `PROXY_SECRET`). Because the
> signature is over the query fields and not the host, an identical signed link
> is valid on all of them — which is exactly what lets the backend pick a host
> per request for load-balancing/failover (see `CRIMSON_PROXY_BASE` above).

### Netlify (deployed from CI, not git integration)

Netlify's git integration **won't connect a private repo owned by an org**, so we
deploy with the Netlify CLI from the GitHub Action instead — no repo connection,
the repo stays private. One-time setup:

1. Create the site once **without** linking git: `npx netlify-cli sites:create`
   (or "Add new site → Deploy manually" in the dashboard). Note its **Site ID**
   (Site configuration → General).
2. Add two repo **Actions secrets**: `NETLIFY_AUTH_TOKEN` (Netlify → User
   settings → Applications → New access token) and `NETLIFY_SITE_ID`.
3. Set the runtime secret **`NITRO_PROXY_SECRET`** = the backend's `PROXY_SECRET`
   in the Netlify dashboard (Site configuration → Environment variables). This is
   a *runtime* value on the edge, so it lives on Netlify, not in GitHub.
4. Done. Every push to `main` runs `netlify deploy --build --prod` from the Action
   (self-skips if the token is absent). `--build` is required, not `--dir=dist`:
   it runs the build inside the CLI's own pipeline so Nitro's edge function in
   `.netlify/edge-functions/` is detected and shipped — a static-only deploy
   skips it and every route 404s.

### Cloudflare Workers

1. Create a token (Cloudflare → My Profile → API Tokens → **Edit Cloudflare
   Workers** template) and grab your **Account ID** (Workers & Pages sidebar).
2. Add both as repo **Actions secrets**: `CLOUDFLARE_API_TOKEN` and
   `CLOUDFLARE_ACCOUNT_ID`. The GitHub Action in `.github/workflows/deploy.yml`
   then deploys on every push to `main` (and self-skips if the token is absent).
3. Add a third repo **Actions secret** `NITRO_PROXY_SECRET` (= the backend's
   `PROXY_SECRET`). The Action uploads it to the Worker on every deploy (via
   `wrangler-action`'s `secrets:` input), so you **never need a locally
   authenticated wrangler**. If you'd rather set it by hand: Cloudflare dashboard
   → the Worker → Settings → Variables and Secrets → add a *Secret* named
   `NITRO_PROXY_SECRET`. (`wrangler secret put` works too, but only once
   `wrangler login` / `CLOUDFLARE_API_TOKEN` is set in your shell — the CI path
   sidesteps that auth entirely.) For a purely manual deploy:
   `pnpm build:cloudflare && wrangler deploy`.

### Both at once (recommended for headroom)

Do both of the above. Then point the backend at both:

```
CRIMSON_PROXY_BASE="https://<site>.netlify.app,https://crimson-proxy.<acct>.workers.dev"
```

A single push to `main` redeploys both (Netlify builds itself; the Action ships
Cloudflare). The backend round-robins between them per request.

## Local dev

```sh
pnpm install
cp .env.example .env     # leave NITRO_PROXY_SECRET blank for OPEN mode
pnpm dev
# health:  curl 'http://localhost:3000/'
# proxy:   curl 'http://localhost:3000/?u=https%3A%2F%2Fexample.com%2Ffile.m3u8'
```

> ⚠️ Blank secret = **open mode** (no signature required). Fine locally, never in
> production — set `NITRO_PROXY_SECRET` on the host and signing is enforced
> automatically.

## Layout

| File | Role |
| ---- | ---- |
| `src/routes/index.ts` | The handler: verify → guard → fetch → (rewrite playlist \| stream segment). |
| `src/utils/signing.ts` | HMAC sign/verify. The contract with the backend. |
| `src/utils/hls.ts` | m3u8 sub-resource rewriting (re-signed). |
| `src/utils/links.ts` | Query-param shape + proxy-path builder. |
| `src/utils/headers.ts` | Upstream header injection + CORS/response headers. |
| `src/utils/ssrf.ts` | Literal private-host/scheme guard (defence in depth). |
| `src/utils/config.ts` | Runtime config (secret, default UA). |
