// HMAC signing — the contract that makes this a *tailored* relay rather than an
// open proxy. The backend mints every link with a signature over the exact
// upstream URL + the headers it wants injected; we recompute it here with the
// shared secret and refuse anything that doesn't match. Because we hold the same
// secret, we can also re-sign the sub-resource links we rewrite into HLS
// playlists (segments/variants/keys), so the whole playlist tree stays signed
// without the backend pre-enumerating it.
//
// The canonical payload is the four fields joined by "\n", always in this order,
// empty string where absent:
//
//     <url>\n<referer>\n<origin>\n<userAgent>
//
// sig = hex(HMAC-SHA256(secret, payload))[:32]
//
// This MUST stay byte-for-byte identical to the backend's signer. Python:
//
//     payload = "\n".join([url, referer, origin, user_agent])
//     sig = hmac.new(secret.encode(), payload.encode(), hashlib.sha256).hexdigest()[:32]

export interface SignedFields {
  url: string;
  referer: string;
  origin: string;
  userAgent: string;
}

const SIG_LEN = 32;

function canonical(f: SignedFields): string {
  return [f.url, f.referer, f.origin, f.userAgent].join("\n");
}

// Web Crypto is available on every target runtime (Netlify edge, Cloudflare
// Workers, Node 18+). We import the key per call — cheap, and avoids module-load
// ordering issues with runtime config.
async function hmacHex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  const bytes = new Uint8Array(mac);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

export async function sign(secret: string, f: SignedFields): Promise<string> {
  return (await hmacHex(secret, canonical(f))).slice(0, SIG_LEN);
}

// Constant-time-ish compare over the fixed-length hex signatures. Returns false
// on any length mismatch, so a short/garbage sig can't short-circuit.
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verify(
  secret: string,
  f: SignedFields,
  presented: string,
): Promise<boolean> {
  if (!presented || presented.length !== SIG_LEN) return false;
  const expected = await sign(secret, f);
  return safeEqual(expected, presented);
}
