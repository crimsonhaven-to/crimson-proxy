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
import hmac, hashlib
from urllib.parse import quote

PROXY_BASE = os.getenv("CRIMSON_PROXY_BASE", "")          # e.g. https://proxy.crimsonhaven.to
PROXY_SECRET = os.getenv("PROXY_SECRET", "").encode()      # SAME value the proxy has

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
    return f"{PROXY_BASE}/?{q}"
```

A resolver that currently returns `_proxy_path_for(stream_url)` just returns
`crimson_proxy_url(stream_url, referer="https://voe.sx/", user_agent=_VOE_USER_AGENT)`
instead — when `CRIMSON_PROXY_BASE` is set. Leave it unset and the backend keeps
proxying itself, so this is a safe, flag-gated swap you can A/B per source.

> The proxy only rewrites the **first** playlist's children itself, so you only
> ever sign the top-level stream URL — segments are signed by the proxy.

## Deploy

One-time setup, then it's hands-off (pushes auto-deploy).

### Netlify (recommended, simplest)

1. "Add new site → Import from Git", pick this repo. Netlify reads
   `netlify.toml` and runs `pnpm build:netlify` (edge functions).
2. Set env var **`NITRO_PROXY_SECRET`** = the backend's `PROXY_SECRET`.
3. Done. Every push to `main` redeploys.

### Cloudflare Workers (alternative)

1. `pnpm build:cloudflare`
2. `wrangler secret put NITRO_PROXY_SECRET` (same value as the backend)
3. `wrangler deploy` — or add `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`
   repo secrets and the GitHub Action in `.github/workflows/deploy.yml` deploys
   on every push.

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
