// Minimal service worker: makes the app installable and serves the shell offline.
// The API is deliberately never cached - a stale chat would be worse than none.
const SHELL = 'fauxr-shell-v3';
const ASSETS = [
  '/icon.svg', '/manifest.webmanifest',
  '/icon-192.png', '/icon-512.png', '/icon-maskable-512.png', '/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    const index = await fetch('/index.html', { cache: 'no-store' });
    const html = await index.clone().text();
    // Vite fingerprints production bundles, so their names cannot live in this source file.
    // Discover them from the built index during install; caching HTML without the JS/CSS it
    // references produced an installable shell that was blank on a real offline reload.
    const built = [...html.matchAll(/(?:src|href)="(\/assets\/[^"?#]+(?:\?[^"#]*)?)"/g)]
      .map((match) => match[1]);
    await Promise.all([
      cache.put('/index.html', index.clone()),
      cache.put('/', index),
      cache.addAll([...ASSETS, ...new Set(built)]),
    ]);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET') return;
  if (url.pathname.startsWith('/api') || url.pathname.startsWith('/ws') || url.pathname.startsWith('/media')) return;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok && url.origin === self.location.origin) {
          void caches.open(SHELL).then((cache) => cache.put(event.request, response.clone()));
        }
        return response;
      })
      .catch(() => caches.match(event.request).then((hit) => hit ?? caches.match('/index.html'))),
  );
});
