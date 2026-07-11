/*
  WC '26 Prediction League - safe transitional service worker
  Purpose: replace the accidentally uploaded backend code without changing
  the live website's network behavior or caching strategy.
*/

const SW_VERSION = 'wc26-safe-sw-v1';

self.addEventListener('install', () => {
  // Activate this corrected worker as soon as possible.
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    (async () => {
      // Remove only caches previously created by WC26 service workers.
      // This worker itself does not cache or intercept requests.
      const names = await caches.keys();
      await Promise.all(
        names
          .filter(name => /^wc26[-_]/i.test(name) && name !== SW_VERSION)
          .map(name => caches.delete(name))
      );
      await self.clients.claim();
    })()
  );
});

// Intentionally no fetch handler.
// All website files and Google Apps Script API calls continue directly
// through the browser/network exactly as they do on the live site.
