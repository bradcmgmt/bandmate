/* Bandmate · service worker
 *
 * Cache strategy:
 *  - HTML (index.html): network-first with cache fallback — always tries
 *    fresh content but falls back to the cached app shell offline.
 *  - Static assets (logo, avatar, bg-loop): cache-first — they don't change
 *    often and we want fast loads + offline support.
 *  - Everything else (Supabase API, Sentry, etc.): bypass the SW entirely.
 *    Those are dynamic / auth-bearing and shouldn't be cached.
 *
 * Bump CACHE_VERSION whenever the shell changes so old caches get purged.
 */

const CACHE_VERSION = 'bandmate-v29-app';
const APP_SHELL = [
  '/',
  '/index.html',
  '/manifest.json',
  '/logo.png',
  '/avatar.png',
  '/icon-192.png',
  '/icon-512.png',
  '/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return; // never cache POST/PATCH/DELETE
  const url = new URL(req.url);

  // Bypass the service worker entirely for any third-party origin
  // (Supabase, Sentry, fonts) — those have their own caching rules
  // and may carry auth that mustn't be cached.
  if (url.origin !== self.location.origin) return;

  const isHtml = req.mode === 'navigate'
    || req.destination === 'document'
    || url.pathname === '/'
    || url.pathname.endsWith('.html');

  if (isHtml) {
    // Network-first for HTML — always try to ship the latest app shell.
    event.respondWith(
      fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE_VERSION).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      }).catch(() => caches.match(req).then((cached) => cached || caches.match('/index.html')))
    );
    return;
  }

  // Cache-first for static assets — fall back to network then cache.
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((res) => {
        if (res && res.status === 200 && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      });
    })
  );
});
