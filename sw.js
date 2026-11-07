/* 纸间 · Service Worker
   策略：network-first（保证更新即时生效），离线时回退缓存 */
const CACHE = 'paper-journal-v2';
const ASSETS = [
  './',
  './index.html',
  './css/paper.css',
  './js/util.js',
  './js/audio.js',
  './js/store.js',
  './js/flip.js',
  './js/sync.js',
  './js/import.js',
  './js/app.js',
  './js/vendor/pdf.min.js',
  './js/vendor/pdf.worker.min.js',
  './manifest.webmanifest',
  './icons/icon.svg'
];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS).catch(() => {}))
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // WebDAV / 跨域请求一律直连，不干预
  if (url.origin !== self.location.origin) return;

  e.respondWith(
    fetch(req).then(res => {
      if (res && res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
      }
      return res;
    }).catch(() => caches.match(req).then(hit => hit || caches.match('./index.html')))
  );
});
