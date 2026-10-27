const SHELL_CACHE = 'shell-v2';
const DATA_CACHE = 'data-v1';
const SHELL = ['./', 'index.html', 'app.js', 'style.css', 'wav_paths.txt'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Audio and provisional click files: cache-first, cache once fetched.
  if (/\.(wav|txt)$/i.test(url.pathname) && url.origin !== self.location.origin) {
    e.respondWith(
      caches.open(DATA_CACHE).then(async (cache) => {
        const hit = await cache.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok) cache.put(req, res.clone());
        return res;
      })
    );
    return;
  }

  // App shell (same origin): serve from cache, refresh in the background.
  if (url.origin === self.location.origin) {
    e.respondWith(
      caches.open(SHELL_CACHE).then(async (cache) => {
        const hit = await cache.match(req, { ignoreSearch: true }) ||
          (req.mode === 'navigate' ? await cache.match('index.html') : undefined);
        const network = fetch(req).then((res) => {
          if (res.ok) cache.put(req, res.clone());
          return res;
        });
        if (hit) {
          network.catch(() => {});
          return hit;
        }
        return network;
      })
    );
  }
});
