#!/usr/bin/env node
/**
 * 纸间 · 本地服务 + WebDAV 代理
 * 零依赖，只需要 Node 18+
 *
 *   node server.mjs            # 默认 http://localhost:8787
 *   PORT=9000 node server.mjs  # 自定义端口
 *
 * 代理用法：前端设置里的「跨域代理」填 http://127.0.0.1:8787/dav?url=
 */

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const PORT = Number(process.env.PORT || 8787);
const STRICT_TLS = process.env.STRICT_TLS === '1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.pdf': 'application/pdf'
};

/* ══════════ WebDAV 反向代理 ══════════ */
function proxyDav(req, res, targetUrl) {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,PUT,POST,DELETE,HEAD,OPTIONS,PROPFIND,PROPPATCH,MKCOL,COPY,MOVE,LOCK,UNLOCK',
    'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] || '*',
    'Access-Control-Expose-Headers': 'ETag,Content-Length,Content-Type,DAV,Last-Modified',
    'Access-Control-Max-Age': '86400'
  };

  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors);
    res.end();
    return;
  }

  let target;
  try {
    target = new URL(targetUrl);
  } catch {
    res.writeHead(400, { ...cors, 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('bad target url');
    return;
  }
  if (!/^https?:$/.test(target.protocol)) {
    res.writeHead(400, { ...cors, 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('only http/https allowed');
    return;
  }

  const mod = target.protocol === 'https:' ? https : http;

  const headers = {};
  for (const k of ['authorization', 'depth', 'destination', 'overwrite', 'if', 'if-match',
                   'if-none-match', 'range', 'content-type', 'content-length', 'user-agent',
                   'translate', 'brief', 'cache-control']) {
    if (req.headers[k]) headers[k] = req.headers[k];
  }

  const opts = {
    method: req.method,
    headers,
    timeout: 60000,
    rejectUnauthorized: STRICT_TLS
  };

  const preq = mod.request(target, opts, (pres) => {
    const outHeaders = { ...cors };
    for (const [k, v] of Object.entries(pres.headers)) {
      if (/^(access-control-|connection|transfer-encoding|keep-alive|content-encoding)/i.test(k)) continue;
      outHeaders[k] = v;
    }
    res.writeHead(pres.statusCode || 502, outHeaders);
    pres.pipe(res);
  });

  preq.on('timeout', () => {
    preq.destroy(new Error('upstream timeout'));
  });

  preq.on('error', (err) => {
    if (res.headersSent) { res.end(); return; }
    res.writeHead(502, { ...cors, 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'proxy_failed', message: err.message }));
  });

  // 透传请求体
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    preq.end();
  } else {
    req.pipe(preq);
  }
}

/* ══════════ 静态文件 ══════════ */
/** 给 html 里的 css/js 引用注入 mtime 版本号，避免改了代码浏览器还在用旧缓存 */
function injectVersion(html) {
  return html.replace(/(src|href)="((?:css|js|icons)\/[^"?#]+)"/g, (m, attr, rel) => {
    try {
      const st = fs.statSync(path.join(ROOT, rel));
      return `${attr}="${rel}?v=${Math.floor(st.mtimeMs)}"`;
    } catch {
      return m;
    }
  });
}

async function serveStatic(req, res) {
  let rel = decodeURIComponent((req.url || '/').split('?')[0]);
  if (rel === '/' || rel === '') rel = '/index.html';

  const full = path.normalize(path.join(ROOT, rel));
  if (!full.startsWith(ROOT)) {
    res.writeHead(403); res.end('forbidden'); return;
  }

  try {
    const st = await fsp.stat(full);
    if (st.isDirectory()) {
      const idx = path.join(full, 'index.html');
      const body = injectVersion(await fsp.readFile(idx, 'utf8'));
      res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
      res.end(body);
      return;
    }
    const ext = path.extname(full).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    let body = await fsp.readFile(full);

    if (ext === '.html' || ext === '.htm') {
      body = Buffer.from(injectVersion(body.toString('utf8')), 'utf8');
    }

    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': body.length,
      'ETag': `"${Math.floor(st.mtimeMs)}-${body.length}"`,
      'Cache-Control': 'no-cache, must-revalidate'
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<h1>404</h1><p>没有这个文件。回到 <a href="/">首页</a>。</p>');
  }
}

/* ══════════ AI 桥（MCP 数据代理） ══════════
   MCP server 收到工具调用后经 /api/op 转发，
   由打开了纸间页面的浏览器通过 SSE 领取并执行（数据在它的 IndexedDB 里）。 */
const bridgeClients = new Set();     // SSE 响应对象集合
let opSeq = 0;
const pendingOps = new Map();        // id -> {resolve, timer}

function bridgeBroadcast(op, args) {
  const id = 'op' + (++opSeq) + '-' + Date.now();
  const payload = JSON.stringify({ id, op, args });
  let delivered = false;
  for (const res of bridgeClients) {
    try {
      res.write(`event: op\ndata: ${payload}\n\n`);
      delivered = true;
      break;                          // 一个执行者即可
    } catch { bridgeClients.delete(res); }
  }
  return delivered ? id : null;
}

function handleApi(req, res, u) {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json; charset=utf-8' };

  if (u.pathname === '/api/ping') {
    res.writeHead(200, cors);
    res.end(JSON.stringify({ ok: true, agent: 'paper-journal-web', mode: bridgeClients.size ? 'bridged' : 'no-browser', ts: Date.now() }));
    return;
  }

  if (u.pathname === '/bridge/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });
    res.write(': connected\n\n');
    bridgeClients.add(res);
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* */ } }, 20000);
    req.on('close', () => { clearInterval(ping); bridgeClients.delete(res); });
    return;
  }

  if (u.pathname === '/bridge/response') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { id, ok, data, error } = JSON.parse(body);
        const p = pendingOps.get(id);
        if (p) {
          clearTimeout(p.timer);
          pendingOps.delete(id);
          if (ok) p.resolve({ ok: true, data });
          else p.resolve({ ok: false, error: error || '执行失败' });
        }
      } catch { /* ignore */ }
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*' });
      res.end();
    });
    return;
  }

  if (u.pathname === '/api/op') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      let op, args;
      try { ({ op, args } = JSON.parse(body)); } catch { }
      if (!op) {
        res.writeHead(400, cors);
        res.end(JSON.stringify({ ok: false, error: '缺少 op' }));
        return;
      }
      const id = bridgeBroadcast(op, args);
      if (!id) {
        res.writeHead(503, cors);
        res.end(JSON.stringify({ ok: false, error: '纸间页面未连接（请打开纸间网页或桌面应用）' }));
        return;
      }
      const timer = setTimeout(() => {
        if (pendingOps.has(id)) {
          pendingOps.delete(id);
          res.writeHead(504, cors);
          res.end(JSON.stringify({ ok: false, error: '执行超时' }));
        }
      }, 15000);
      pendingOps.set(id, {
        resolve: (r) => {
          res.writeHead(r.ok ? 200 : 500, cors);
          res.end(JSON.stringify(r));
        }
      });
    });
    return;
  }

  res.writeHead(404, cors);
  res.end(JSON.stringify({ ok: false, error: 'unknown api path' }));
}

/* ══════════ 启动 ══════════ */
// PNG 图标不入库（.gitignore），首次启动自动生成
async function ensureIcons() {
  const marker = path.join(ROOT, 'icons', 'icon-192.png');
  if (fs.existsSync(marker)) return;
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    await promisify(execFile)(process.execPath, [path.join(ROOT, 'tools', 'gen-icons.mjs')], { cwd: ROOT });
    console.log('  已自动生成 PWA / Android 图标。');
  } catch (e) {
    console.warn('  图标生成失败（不影响使用，仅缺 PWA 图标）：', e.message);
  }
}

const server = http.createServer((req, res) => {
  const u = req.url || '/';

  if (u.startsWith('/dav')) {
    const qs = new URL(u, 'http://x').searchParams;
    const target = qs.get('url');
    if (!target) {
      res.writeHead(400, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'missing url param, use /dav?url=<encoded webdav url>' }));
      return;
    }
    proxyDav(req, res, target);
    return;
  }

  if (u === '/__health') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ ok: true, name: 'paper-journal', ts: Date.now() }));
    return;
  }

  // 页面自检回传（开发用）
  if (u.startsWith('/__log')) {
    const qs = new URL(u, 'http://x').searchParams;
    const msg = qs.get('d') || '';
    console.log('\n[SELFTEST] ' + msg + '\n');
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*' });
    res.end();
    return;
  }

  // AI 桥（MCP 数据代理）
  if (u.startsWith('/api/') || u.startsWith('/bridge/')) {
    handleApi(req, res, new URL(u, 'http://x'));
    return;
  }

  serveStatic(req, res);
});

function localIPs() {
  const out = [];
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const ni of nets[name] || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

server.listen(PORT, '0.0.0.0', () => {
  ensureIcons();
  const ips = localIPs();
  console.log('');
  console.log('  纸间 · Paper Journal');
  console.log('  ────────────────────────────────');
  console.log(`  本机     http://localhost:${PORT}`);
  ips.forEach(ip => console.log(`  局域网   http://${ip}:${PORT}   （手机同一 Wi-Fi 可访问）`));
  console.log(`  代理     http://localhost:${PORT}/dav?url=<WebDAV 地址>`);
  console.log('  ────────────────────────────────');
  console.log('  在「设置 → 同步 · WebDAV」里，跨域代理填：');
  console.log(`  http://127.0.0.1:${PORT}/dav?url=`);
  console.log('');

  if (process.argv.includes('--open') && process.platform === 'win32') {
    import('node:child_process').then(cp => {
      cp.exec(`start "" "http://localhost:${PORT}"`);
    });
  }
});
