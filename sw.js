// WC'26 Picks — Service Worker v4
// Shell strategy: stale-while-revalidate.
// index.html is served from cache INSTANTLY and re-fetched in the background,
// so the app opens in well under a second and works offline. Staleness is not
// a problem because the app already has a server-driven update banner
// (getAppVersion → "Bump app version"): an outdated shell shows the banner,
// and the banner's Refresh navigates with ?v=<version>, which this worker
// treats as network-first so the user gets the new shell on that click.
const CACHE = 'wc26-v4';
const ASSETS = 'wc26-assets-v1'; // fonts + flag images, cache-first forever
const ASSET_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com', 'flagcdn.com'];
const STATIC = ['/index.html', '/manifest.json', '/icon-192.png', '/icon-512.png',
                '/favicon-32.png', '/favicon-192.png',
                '/icon-green-192.png', '/icon-red-192.png',
                '/icon-orange-192.png', '/icon-navy-192.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(STATIC)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE && k !== ASSETS).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Fetch the shell from the network and refresh the cached copy.
// Returns the network response, or null when offline/failed.
function refreshShell(request) {
  return fetch(request).then(res => {
    if (res && res.status === 200) {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put('/index.html', copy));
    }
    return res;
  }).catch(() => null);
}

self.addEventListener('fetch', e => {
  const url = e.request.url;

  // Apps Script API — always network, never cache
  if (url.includes('script.google.com')) { e.respondWith(fetch(e.request)); return; }

  // Fonts and flag images — cache first, they effectively never change.
  // Accept opaque responses (no-cors <img> requests return status 0).
  if (ASSET_HOSTS.includes(new URL(url).host)) {
    e.respondWith(
      caches.open(ASSETS).then(c => c.match(e.request).then(cached => {
        if (cached) return cached;
        return fetch(e.request).then(res => {
          if (res && (res.status === 200 || res.type === 'opaque')) c.put(e.request, res.clone());
          return res;
        });
      }))
    );
    return;
  }

  // App shell (any navigation)
  if (e.request.mode === 'navigate' || url.endsWith('.html') || new URL(url).pathname === '/') {
    // The update banner reloads with ?v=<version>: go network-first there so
    // the user's explicit "Refresh" actually fetches the new deploy.
    const forced = new URL(url).searchParams.has('v');
    e.respondWith((async () => {
      const cached = await caches.match('/index.html');
      if (!forced && cached) {
        e.waitUntil(refreshShell(e.request)); // revalidate in the background
        return cached;
      }
      const fresh = await refreshShell(e.request);
      return fresh || cached ||
        new Response('Offline — open the app once online to cache it.',
                     { status: 503, headers: { 'Content-Type': 'text/plain' } });
    })());
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
