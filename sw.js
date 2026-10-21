/* Atlas — self-destructing service worker.
   The previous caching SW caused stale-cache problems (app needing a full
   restart to work), so offline support is disabled. This version unregisters
   itself and clears all old caches, then does nothing (requests go straight to
   the network). If offline support is wanted again later, replace this with a
   fresh, well-tested worker. */
self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k.startsWith("atlas-")).map(k => caches.delete(k)));
    await self.clients.claim();
    try { await self.registration.unregister(); } catch (err) {}
  })());
});

// No fetch handler on purpose — every request goes to the network as normal.
