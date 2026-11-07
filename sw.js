/* 纸间 · Service Worker
   策略：network-first（保证更新即时生效），离线时回退缓存
   特殊路由：/raw/<bookId>/<path> —— 原样 HTML 书的虚拟文件系统（从 IndexedDB 取文件） */
const CACHE = 'paper-journal-v3';
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

/* ══════════ 原样书虚拟文件系统 ══════════ */
const RAW_MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff',
  '.ttf': 'font/ttf', '.mp3': 'audio/mpeg', '.mp4': 'video/mp4',
  '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8'
};

let rawDbPromise = null;
function rawDB() {
  if (!rawDbPromise) {
    rawDbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open('paper-journal', 2);
      req.onupgradeneeded = (e) => {
        const d = e.target.result;
        if (!d.objectStoreNames.contains('books'))
          d.createObjectStore('books', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('entries')) {
          const s = d.createObjectStore('entries', { keyPath: 'id' });
          s.createIndex('bookId', 'bookId');
          s.createIndex('day', 'day');
          s.createIndex('ts', 'ts');
          s.createIndex('updatedAt', 'updatedAt');
        }
        if (!d.objectStoreNames.contains('media')) {
          const m = d.createObjectStore('media', { keyPath: 'id' });
          m.createIndex('hash', 'hash');
        }
        if (!d.objectStoreNames.contains('meta'))
          d.createObjectStore('meta', { keyPath: 'k' });
        if (!d.objectStoreNames.contains('rawFiles')) {
          const r = d.createObjectStore('rawFiles', { keyPath: 'id' });
          r.createIndex('bookId', 'bookId');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return rawDbPromise;
}

async function serveRaw(pathname) {
  try {
    const rest = pathname.replace(/^\/raw\//, '');
    const slash = rest.indexOf('/');
    if (slash < 0) return new Response('bad raw path', { status: 400 });
    const bookId = rest.slice(0, slash);
    let p = decodeURIComponent(rest.slice(slash + 1));
    if (p === '' || p.endsWith('/')) p += 'index.html';

    const db = await rawDB();
    const rec = await new Promise((resolve, reject) => {
      const r = db.transaction('rawFiles').objectStore('rawFiles')
        .get(bookId + '/' + p);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });

    if (!rec || !rec.blob) {
      const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<body style="font-family:system-ui,'PingFang SC','Microsoft YaHei';background:#efe9dd;color:#2b2723;
display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
<div style="max-width:420px;padding:28px 34px;background:#fcfaf5;border-radius:12px;
box-shadow:0 10px 40px rgba(40,32,20,.18);line-height:1.9">
<p style="margin:0 0 8px;font-size:17px">这本书缺一页：${'`'}${p.replace(/</g,'&lt;')}${'`'}</p>
<p style="margin:0;font-size:13px;color:#6d655b">导入时需要把网页引用的<b>所有文件一起选中</b>（书架 index.html + 各分册）。
回到纸间书架，删掉这本网页书后重新导入，把列出的文件一次选全即可。</p>
</div></body></html>`;
      return new Response(html, {
        status: 404,
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
      });
    }
    const ext = p.slice(p.lastIndexOf('.')).toLowerCase();
    return new Response(rec.blob, {
      headers: {
        'Content-Type': rec.type || RAW_MIME[ext] || 'application/octet-stream',
        'Cache-Control': 'no-cache'
      }
    });
  } catch (e) {
    return new Response('raw error: ' + e.message, { status: 500 });
  }
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // 原样书：无论同源与否，只要路径是 /raw/ 就接管（必须在缓存逻辑之前）
  if (url.pathname.startsWith('/raw/')) {
    e.respondWith(serveRaw(url.pathname));
    return;
  }

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
