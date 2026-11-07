/* ═══════════════════════════════════════════════
   纸间 · 桌面版主进程
   - app://journal  自定义协议（安全上下文，IndexedDB 可用）
   - 便携模式：数据固定在 exe 旁边的 data/ 目录
   - WebDAV：主进程 IPC 代发，绕过 CORS
   ═══════════════════════════════════════════════ */
const { app, BrowserWindow, ipcMain, protocol, Menu } = require('electron');
const path = require('path');
const fs = require('fs');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.pdf': 'application/pdf'
};

/* app:// 必须在 ready 前注册为标准、安全的协议 */
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true
    }
  }
]);

/* ── 便携数据目录：exe 旁边的 data/ ── */
function setupPortableData() {
  try {
    const base = app.isPackaged
      ? path.dirname(app.getPath('exe'))
      : path.join(__dirname, '..');
    const dataDir = path.join(base, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.accessSync(dataDir, fs.constants.W_OK);   // 放在只读位置（如 Program Files）时回退默认
    app.setPath('userData', dataDir);
    app.setPath('sessionData', path.join(dataDir, 'session'));
    return dataDir;
  } catch (e) {
    return app.getPath('userData');
  }
}

let DATA_DIR = '';
let WEB_ROOT = '';

function createWindow() {
  const win = new BrowserWindow({
    width: 1120,
    height: 780,
    minWidth: 400,
    minHeight: 560,
    backgroundColor: '#E9E3D6',
    autoHideMenuBar: true,
    show: false,
    title: '纸间 · Paper Journal',
    icon: path.join(WEB_ROOT, 'icons', 'icon-512.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  });

  Menu.setApplicationMenu(null);
  win.once('ready-to-show', () => win.show());

  // 诊断：页面加载结果与报错都打到主进程 stdout
  win.webContents.on('did-finish-load', () => {
    console.log('[desktop] loaded:', win.webContents.getURL());
  });
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 1) console.log('[web]', message);
  });
  win.webContents.on('preload-error', (_e, p, err) => {
    console.error('[preload-error]', p, err.message);
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    console.error('[render-gone]', JSON.stringify(details));
  });

  // 便于自动化自检：PJ_SELFTEST=1 npm start
  const extra = process.env.PJ_SELFTEST ? '?selftest=1' : '';
  win.loadURL('app://journal/index.html' + extra);

  // 阻止窗口级导航劫持，新窗口一律交给系统浏览器
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) require('electron').shell.openExternal(url);
    return { action: 'deny' };
  });
  return win;
}

/* ── WebDAV 代理（主进程网络栈，无 CORS 概念） ── */
function davRequest(payload) {
  return new Promise((resolve) => {
    const { method = 'GET', url, headersJson = '{}', bodyB64 = '' } = payload || {};
    try {
      const { net } = require('electron');
      const headers = JSON.parse(headersJson || '{}');
      const req = net.request({ method: String(method).toUpperCase(), url });

      for (const [k, v] of Object.entries(headers)) {
        const lk = k.toLowerCase();
        if (lk === 'content-length' || lk === 'host' || lk === 'connection') continue;
        try { req.setHeader(k, String(v)); } catch (e) { /* 跳过非法头 */ }
      }

      const chunks = [];
      let settled = false;
      const finish = (r) => { if (!settled) { settled = true; resolve(r); } };

      req.on('response', (resp) => {
        const respHeaders = {};
        for (const [k, v] of Object.entries(resp.headers)) {
          respHeaders[k] = Array.isArray(v) ? v.join(', ') : String(v);
        }
        const status = resp.statusCode;
        resp.on('data', (c) => chunks.push(c));
        resp.on('end', () => finish({
          status,
          headers: respHeaders,
          body: Buffer.concat(chunks).toString('base64')
        }));
        resp.on('error', (err) => finish({ error: err.message }));
      });

      req.on('error', (err) => finish({ error: err.message }));

      const m = String(method).toUpperCase();
      if (bodyB64 && m !== 'GET' && m !== 'HEAD') {
        req.write(Buffer.from(bodyB64, 'base64'));
      }
      req.end();

      // 超时保护
      setTimeout(() => finish({ error: '请求超时（100s）' }), 100000);
    } catch (err) {
      resolve({ error: err.message });
    }
  });
}

/* ── 单实例锁 ── */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const wins = BrowserWindow.getAllWindows();
    if (wins[0]) { wins[0].show(); wins[0].focus(); }
  });

  app.whenReady().then(() => {
    DATA_DIR = setupPortableData();
    WEB_ROOT = app.isPackaged ? path.join(__dirname, 'app') : path.join(__dirname, '..');

    protocol.handle('app', async (request) => {
      try {
        const u = new URL(request.url);
        let p = decodeURIComponent(u.pathname || '/');
        if (p.endsWith('/')) p += 'index.html';
        const file = path.normalize(path.join(WEB_ROOT, p));
        if (!file.startsWith(path.normalize(WEB_ROOT))) {
          return new Response('forbidden', { status: 403 });
        }
        const data = await fs.promises.readFile(file);
        const ext = path.extname(file).toLowerCase();
        return new Response(data, {
          headers: { 'Content-Type': MIME[ext] || 'application/octet-stream' }
        });
      } catch (e) {
        return new Response('not found', { status: 404 });
      }
    });

    ipcMain.handle('pj:dav', (_e, payload) => davRequest(payload));
    ipcMain.handle('pj:info', () => ({
      dataDir: DATA_DIR,
      version: app.getVersion(),
      platform: process.platform
    }));

    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    app.quit();
  });
}
