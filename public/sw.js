// Service worker: caches the app shell so it opens fast and can be installed.
// The API is never cached.
const CACHE = 'shareit-v11';
const SHELL = [
  '/', '/index.html', '/app.css', '/app.js', '/manifest.webmanifest',
  '/vendor/marked.umd.js', '/vendor/purify.min.js',
  '/icons/icon-192.png', '/icons/icon-512.png', '/icons/maskable-512.png',
  '/icons/apple-touch-icon.png', '/icons/favicon-32.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;

  // Network first (so updates show up right away), cache as fallback when offline.
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req.mode === 'navigate' ? '/index.html' : req, copy));
        }
        return res;
      })
      .catch(async () => (await caches.match(req.mode === 'navigate' ? '/index.html' : req)) || Response.error()),
  );
});
