/* Atlas — offline support.
   Bump VERSION whenever the caching rules below change; the old caches are
   dropped on activate. index.html itself is NOT versioned here — it is served
   network-first so a fresh Vercel deploy always wins while online. */
const VERSION = "v1";
const SHELL = "atlas-shell-" + VERSION;
const TILES = "atlas-tiles-" + VERSION;
const DATA  = "atlas-data-"  + VERSION;
const OURS  = [SHELL, TILES, DATA];

/* Everything needed to boot the app with no network. */
const SHELL_ASSETS = [
  "./",
  "./index.html",
  "./manifest.json",
  "./apple-touch-icon.png",
  "./favicon-32.png",
  "./icon-192.png",
  "./icon-512.png",
  "./splash-logo-white.png",
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css",
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js",
  "https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Serif:wght@400;500;600&display=swap"
];

/* Cap the tile cache so a few zoomed-out world spins can't fill the disk. */
const TILE_LIMIT = 800;
const TILE_TRIM  = 200;

const isTile  = u => /\.basemaps\.cartocdn\.com$/.test(u.hostname);
const isSheet = u => u.hostname === "docs.google.com" && u.pathname.includes("/gviz/");
const isFont  = u => u.hostname === "fonts.googleapis.com" || u.hostname === "fonts.gstatic.com";
const isCDN   = u => u.hostname === "unpkg.com";

/* Live calls that must never be served from cache. */
const isLive = u =>
  u.hostname === "places.googleapis.com" ||
  u.hostname === "script.google.com" ||
  u.hostname === "nominatim.openstreetmap.org";

self.addEventListener("install", e => {
  e.waitUntil((async () => {
    const c = await caches.open(SHELL);
    // Per-asset so one unreachable CDN file doesn't abort the whole install.
    await Promise.all(SHELL_ASSETS.map(a => c.add(a).catch(() => {})));
    self.skipWaiting();
  })());
});

self.addEventListener("activate", e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k.startsWith("atlas-") && !OURS.includes(k)).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

async function trimTiles() {
  const c = await caches.open(TILES);
  const keys = await c.keys();
  if (keys.length <= TILE_LIMIT) return;
  await Promise.all(keys.slice(0, TILE_TRIM).map(k => c.delete(k)));
}

/* Network first, fall back to whatever we stored last. */
async function networkFirst(req, cacheName) {
  const c = await caches.open(cacheName);
  try {
    const res = await fetch(req);
    if (res && (res.ok || res.type === "opaque")) c.put(req, res.clone());
    return res;
  } catch (err) {
    const hit = await c.match(req);
    if (hit) return hit;
    throw err;
  }
}

/* Cache first; refresh in the background so the next load is current. */
async function cacheFirst(req, cacheName, after) {
  const c = await caches.open(cacheName);
  const hit = await c.match(req);
  if (hit) {
    fetch(req).then(res => {
      if (res && (res.ok || res.type === "opaque")) c.put(req, res.clone());
    }).catch(() => {});
    return hit;
  }
  const res = await fetch(req);
  if (res && (res.ok || res.type === "opaque")) {
    await c.put(req, res.clone());
    if (after) after();
  }
  return res;
}

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;               // writes go straight to the network
  let u;
  try { u = new URL(req.url); } catch (err) { return; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return;
  if (isLive(u)) return;

  // The app shell: always prefer the network so new deploys appear immediately.
  if (req.mode === "navigate" || (u.origin === self.location.origin && u.pathname.endsWith(".html"))) {
    e.respondWith(networkFirst(req, SHELL).catch(() => caches.match("./index.html")));
    return;
  }
  if (isTile(u))  { e.respondWith(cacheFirst(req, TILES, trimTiles)); return; }
  if (isSheet(u)) { e.respondWith(networkFirst(req, DATA)); return; }
  if (isFont(u) || isCDN(u) || u.origin === self.location.origin) {
    e.respondWith(cacheFirst(req, SHELL));
  }
});
