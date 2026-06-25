// WC'26 Picks — Service Worker v3
// index.html is intentionally NOT cached — always fetched fresh so JS
// updates and icon changes are picked up immediately on all devices.
// Only truly static assets (icons, manifest) go into cache.
const CACHE = 'wc26-v3';
const STATIC = ['/manifest.json', '/icon-192.png', '/icon-512.png',
                '/favicon-32.png', '/favicon-192.png',
                '/icon-green-192.png', '/icon-red-192.png',
                '/icon-orange-192.png', '/icon-navy-192.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(STATIC)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = e.request.url;
  // Apps Script API — always network, never cache
  if (url.includes('script.google.com')) { e.respondWith(fetch(e.request)); return; }
  // HTML — always network so updates are instant; fall back to cache only if offline
  if (e.request.mode === 'navigate' || url.endsWith('.html') || url.endsWith('/')) {
    e.respondWith(
      fetch(e.request).catch(() => caches.match('/index.html'))
    );
    return;
  }
  // Static assets — cache first
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(res => {
        if (res && res.status === 200 && res.type === 'basic') {
          caches.open(CACHE).then(c => c.put(e.request, res.clone()));
        }
        return res;
      });
    })
  );
});
