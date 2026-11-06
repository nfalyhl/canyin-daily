/* 餐饮日报 · Service Worker
   Shell 走缓存优先（离线也能打开），data/ 下的 JSON 与 enc/ 走网络优先。

   enc/latest.json 是「应急口令通道」的密文，挂了就只剩它一条路，
   绝对不能被 SW 缓存钉住 —— 所以和 data/ 一样走网络优先 + no-store。

   ！！改过前端文件（index.html / app.js / auth.js / style.css / mobile.js / mobile.css）后，
   一定要把下面的 CACHE 版本号 +1（并且把 index.html 里那几个 ?v= 也一起 +1），
   否则装过 SW 的访客会一直吃旧缓存。 */
const CACHE = 'canyin-daily-v37';
const SHELL = [
  './', './index.html', './style.css', './app.js', './auth.js', './auth-config.json',
  './mobile.css', './mobile.js',
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

  const path = new URL(req.url).pathname;

  // 导航请求（打开页面）走**网络优先**：否则改了前端，老访客会被 SW 缓存钉在旧版本上——
  // 「我改了但用户看不到」就是这么来的。离线时才回退缓存。
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req, { cache: 'no-store' })
        .then((res) => {
          const cp = res.clone();
          caches.open(CACHE).then((c) => c.put('./index.html', cp));
          return res;
        })
        .catch(() => caches.match(req).then((h) => h || caches.match('./index.html')))
    );
    return;
  }

  if (path.indexOf('/data/') !== -1 || path.indexOf('/enc/') !== -1) {
    e.respondWith(
      fetch(req, { cache: 'no-store' })
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
