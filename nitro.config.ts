import { join } from "path";
import pkg from "./package.json";

// https://nitro.unjs.io/config
//
// One codebase, many targets: `NITRO_PRESET=netlify_edge|cloudflare_module|
// node-server` picks the deploy target at build time (see package.json scripts).
// Netlify/Cloudflare auto-detect their preset from the connected repo, so the
// `build` script with no preset is what their git integration runs.
export default defineNitroConfig({
  // We serve no static assets — this is a pure function. Skip the public dir so
  // the build doesn't expect one (and so a stray file can't be served).
  noPublicDir: true,
  compatibilityDate: "2025-06-01",
  srcDir: "./src",
  runtimeConfig: {
    version: pkg.version,
    // Overridden at runtime by the matching env vars (NITRO_PROXY_SECRET, etc).
    // Kept here so they're typed and discoverable. See src/utils/config.ts.
    proxySecret: "",
    defaultUserAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    // Jellyfin edge token injection (NITRO_JELLYFIN_HOSTS / NITRO_JELLYFIN_TOKEN).
    // jellyfinHosts is a comma-separated allow-list of the Jellyfin hostname(s) we
    // may inject the token for; jellyfinToken is the access token (an EDGE secret,
    // never sent to the browser). Both empty => injection disabled. See utils/inject.ts.
    jellyfinHosts: "",
    jellyfinToken: "",
  },
  alias: {
    "@": join(__dirname, "src"),
  },
});
