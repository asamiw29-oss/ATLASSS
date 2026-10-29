/* Atlas — service worker (offline support).

   Design goal: offline must NOT cost freshness. The previous caching worker
   served the HTML shell cache-first, so the app could get stuck on an old
   version and "needed a full restart to work". This version fixes that:

   - HTML / navigation  → NETWORK-FIRST (always get the latest app when online;
                          fall back to the cached shell only when offline).
   - CDN libs & fonts   → stale-while-revalidate (fast, refreshes in background).
   - Map tiles          → cache-first with a capped runtime cache, so areas you
                          have already viewed still render offline.
   - Data (Sheet CSV,   → network-only, never cached. Store data is already kept
     Apps Script, APIs)   in localStorage by the app, so the list works offline.

   Bump VERSION to force a clean rollover; activate() deletes all older caches. */

const VERSION = "v2";
const SHELL = "atlas-shell-" + VERSION;   // app shell + core CDN libs
const TILES = "atlas-tiles-" + VERSION;   // map tiles (capped)
const TILE_LIMIT = 300;                   // max tiles kept offline

const CORE = ["./", "./index.html", "./manifest.json"];
const CDN = [
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css",
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js",
];

self.addEventListener("install", e => {
  e.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    // Core same-origin files must cache; CDN libs are best-effort so one bad
    // response can't abort the whole install.
    await cache.addAll(CORE);
    await Promise.all(CDN.map(u =>
      cache.add(new Request(u, { cache: "reload" })).catch(() => {})
    ));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter(k => k.startsWith("atlas-") && k !== SHELL && k !== TILES)
      .map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

const isTile = u => u.hostname.endsWith("stadiamaps.com");
// Live data that must never be served stale.
const isData = u =>
  u.hostname === "docs.google.com" ||
  u.hostname === "script.google.com" ||
  u.hostname === "script.googleusercontent.com" ||
  u.hostname.endsWith("googleapis.com");
const isCDN = u =>
  u.hostname === "unpkg.com" ||
  u.hostname === "fonts.googleapis.com" ||
  u.hostname === "fonts.gstatic.com";

async function trimCache(name, max) {
  const cache = await caches.open(name);
  const keys = await cache.keys();
  if (keys.length <= max) return;
  // Evict oldest-inserted first (keys() preserves insertion order).
  await Promise.all(keys.slice(0, keys.length - max).map(k => cache.delete(k)));
}

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;               // writes always hit the network
  let url;
  try { url = new URL(req.url); } catch (_) { return; }

  // Live data: never intercept — straight to the network.
  if (isData(url)) return;

  // App shell / page navigations: network-first, cached shell as offline fallback.
  if (req.mode === "navigate" ||
      (url.origin === self.location.origin && req.destination === "document")) {
    e.respondWith((async () => {
      try {
        const net = await fetch(req);
        const cache = await caches.open(SHELL);
        cache.put("./index.html", net.clone()).catch(() => {});
        return net;
      } catch (_) {
        return (await caches.match(req)) ||
               (await caches.match("./index.html")) ||
               Response.error();
      }
    })());
    return;
  }

  // Map tiles: cache-first, fill the capped tile cache in the background.
  if (isTile(url)) {
    e.respondWith((async () => {
      const cached = await caches.match(req);
      if (cached) return cached;
      try {
        const net = await fetch(req);
        if (net && net.ok) {
          const cache = await caches.open(TILES);
          await cache.put(req, net.clone());
          trimCache(TILES, TILE_LIMIT);
        }
        return net;
      } catch (_) {
        return cached || Response.error();
      }
    })());
    return;
  }

  // CDN libraries & fonts: stale-while-revalidate.
  if (isCDN(url)) {
    e.respondWith((async () => {
      const cache = await caches.open(SHELL);
      const cached = await cache.match(req);
      const net = fetch(req).then(res => {
        if (res && res.ok) cache.put(req, res.clone()).catch(() => {});
        return res;
      }).catch(() => null);
      return cached || (await net) || Response.error();
    })());
    return;
  }

  // Everything else same-origin: cache-first with network fallback.
  if (url.origin === self.location.origin) {
    e.respondWith((async () => {
      const cached = await caches.match(req);
      if (cached) return cached;
      try {
        const net = await fetch(req);
        if (net && net.ok) {
          const cache = await caches.open(SHELL);
          cache.put(req, net.clone()).catch(() => {});
        }
        return net;
      } catch (_) {
        return cached || Response.error();
      }
    })());
  }
});
