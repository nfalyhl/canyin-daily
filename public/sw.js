/* 餐饮日报 · Service Worker
   Shell 走缓存优先（离线也能打开），data/ 下的 JSON 走网络优先。 */
const CACHE = 'canyin-daily-v1';
const SHELL = [
  './', './index.html', './style.css', './app.js',
  './manifest.webmanifest', './icon-192.png', './icon-512.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => Promise.all(SHELL.map((u) => c.add(u).catch(() => null))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;

  if (new URL(req.url).pathname.indexOf('/data/') !== -1) {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const cp = res.clone();
          caches.open(CACHE).then((c) => c.put(req, cp));
          return res;
        })
        .catch(() => caches.match(req))
    );
    return;
  }

  e.respondWith(
    caches.match(req).then((hit) => {
      if (hit) return hit;
      return fetch(req).then((res) => {
        const cp = res.clone();
        caches.open(CACHE).then((c) => c.put(req, cp));
        return res;
      });
    })
  );
});
