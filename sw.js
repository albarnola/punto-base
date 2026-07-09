// Punto Base service worker.
// Cache-first for the app shell (HTML/CSS/JS/fonts/images) so the app opens
// offline; network-only for Supabase so data is never stale-cached.
// Bump CACHE_VERSION whenever shell files change (matches cache-bust bumps).
const CACHE_VERSION = 'punto-base-v9';

const SHELL = [
  './',
  './index.html',
  './css/styles.css?v=21',
  './js/app.js?v=18',
  './js/api.js?v=4',
  './js/auth.js?v=3',
  './js/supabase-client.js?v=3',
  './assets/logo.png',
  './assets/favicon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Never intercept Supabase (auth/data) or non-GET requests.
  if (event.request.method !== 'GET' || url.hostname.endsWith('.supabase.co')) return;

  // Network-first for navigations so deploys show up promptly; fall back to
  // the cached shell when offline.
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((c) => c.put('./index.html', copy));
          return res;
        })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }

  // Cache-first for everything else (shell assets, fonts, CDN scripts).
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((res) => {
        if (res.ok && (url.origin === location.origin ||
                       url.hostname === 'fonts.googleapis.com' ||
                       url.hostname === 'fonts.gstatic.com' ||
                       url.hostname === 'cdn.jsdelivr.net')) {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((c) => c.put(event.request, copy));
        }
        return res;
      });
    })
  );
});
