// Minimal service worker: makes the app installable and serves the shell offline.
// The API is deliberately never cached - a stale chat would be worse than none.
const SHELL = 'fauxr-shell-v1';
const ASSETS = ['/', '/index.html', '/icon.svg', '/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
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
    fetch(event.request).catch(() => caches.match(event.request).then((hit) => hit ?? caches.match('/index.html'))),
  );
});
