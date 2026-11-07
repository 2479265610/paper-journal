/* ═══════════════════════════════════════════════
   sync.js — WebDAV 增量同步
   远端结构：
     <base>/manifest.json        索引（单点真相）
     <base>/entries/<id>.json    单条日记
     <base>/media/<hash>.<ext>   附件（按内容哈希去重）
   ═══════════════════════════════════════════════ */
(function (global) {
  'use strict';

  const { Store, uid, sha256 } = global.PJ;

  /* ── 原生桥（Android WebView 壳用） ── */
  const nativePending = new Map();
  let nativeSeq = 0;

  const hasNative = () =>
    (typeof global.PJNative !== 'undefined' && global.PJNative &&
      typeof global.PJNative.request === 'function') ||
    (typeof global.PJDesktop !== 'undefined' && global.PJDesktop &&
      typeof global.PJDesktop.davRequest === 'function');

  const isDesktop = () =>
    typeof global.PJDesktop !== 'undefined' && !!global.PJDesktop.isDesktop;

  function b64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function bytesToB64(bytes) {
    let bin = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(bin);
  }

  class NativeResponse {
    constructor(status, headers, bytes) {
      this.status = status;
      this.ok = status >= 200 && status < 300;
      this.statusText = '';
      this._headers = headers || {};
      this._bytes = bytes || new Uint8Array(0);
      const lower = {};
      Object.keys(this._headers).forEach(k => { lower[k.toLowerCase()] = this._headers[k]; });
      this.headers = { get: (k) => lower[String(k).toLowerCase()] || null };
    }
    async text() { return new TextDecoder('utf-8').decode(this._bytes); }
    async arrayBuffer() { return this._bytes.buffer.slice(0); }
    async blob() {
      return new Blob([this._bytes], { type: this.headers.get('content-type') || 'application/octet-stream' });
    }
  }

  // 原生侧回调落地
  global.__PJ_DAV = function (id, json) {
    const p = nativePending.get(id);
    if (!p) return;
    nativePending.delete(id);
    let o;
    try { o = JSON.parse(json); } catch (e) { p.reject(new Error('原生响应解析失败')); return; }
    if (o.error) { p.reject(new Error(o.error)); return; }
    const bytes = o.body ? b64ToBytes(o.body) : new Uint8Array(0);
    p.resolve(new NativeResponse(o.status, o.headers, bytes));
  };

  const Sync = {
    cfg: { url: '', user: '', pass: '', proxy: '' },
    running: false,

    setConfig(c) {
      this.cfg = Object.assign(this.cfg, c || {});
    },

    get configured() {
      return !!(this.cfg.url && this.cfg.user);
    },

    _base() {
      let u = (this.cfg.url || '').trim();
      if (!u) throw new Error('未填写服务器地址');
      if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
      if (!u.endsWith('/')) u += '/';
      return u;
    },

    _auth() {
      const raw = `${this.cfg.user}:${this.cfg.pass}`;
      const b64 = btoa(unescape(encodeURIComponent(raw)));
      return 'Basic ' + b64;
    },

    /** 统一请求出口：桌面走 IPC，安卓走 JS 桥，浏览器走代理或直连 */
    async _fetch(method, url, body, headers) {
      const h = Object.assign({}, headers || {});
      h['Authorization'] = this._auth();

      if (isDesktop()) {
        return this._desktopFetch(method, url, h, body);
      }
      if (hasNative()) {
        return this._nativeFetch(method, url, h, body);
      }

      let target = url;
      if (this.cfg.proxy) {
        const p = this.cfg.proxy.trim();
        target = p.includes('{url}')
          ? p.replace('{url}', encodeURIComponent(url))
          : p + (p.includes('?') ? '' : '?url=') + encodeURIComponent(url);
      } else {
        h['X-Requested-With'] = 'paper-journal';
      }

      const res = await fetch(target, {
        method,
        headers: h,
        body,
        mode: 'cors',
        credentials: 'omit',
        cache: 'no-store'
      });
      return res;
    },

    /** 桌面版（Electron）：主进程 IPC 代发，无 CORS */
    async _desktopFetch(method, url, headers, body) {
      let b64 = '';
      if (body != null) {
        let bytes;
        if (typeof body === 'string') bytes = new TextEncoder().encode(body);
        else if (typeof Blob !== 'undefined' && body instanceof Blob) {
          bytes = new Uint8Array(await body.arrayBuffer());
        } else if (body instanceof ArrayBuffer) bytes = new Uint8Array(body);
        else bytes = new TextEncoder().encode(String(body));
        b64 = bytesToB64(bytes);
      }
      const r = await global.PJDesktop.davRequest({
        method, url,
        headersJson: JSON.stringify(headers),
        bodyB64: b64
      });
      if (!r) throw new Error('桌面桥无响应');
      if (r.error) throw new Error(r.error);
      const bytes = r.body ? b64ToBytes(r.body) : new Uint8Array(0);
      return new NativeResponse(r.status, r.headers, bytes);
    },

    _nativeFetch(method, url, headers, body) {
      return new Promise(async (resolve, reject) => {
        const id = 'r' + (++nativeSeq);
        let b64 = '';
        try {
          if (body != null) {
            let bytes;
            if (typeof body === 'string') bytes = new TextEncoder().encode(body);
            else if (typeof Blob !== 'undefined' && body instanceof Blob) {
              bytes = new Uint8Array(await body.arrayBuffer());
            } else if (body instanceof ArrayBuffer) bytes = new Uint8Array(body);
            else bytes = new TextEncoder().encode(String(body));
            b64 = bytesToB64(bytes);
          }
        } catch (e) {
          reject(e); return;
        }

        nativePending.set(id, { resolve, reject });

        const timer = setTimeout(() => {
          if (nativePending.has(id)) {
            nativePending.delete(id);
            reject(new Error('原生请求超时'));
          }
        }, 100000);

        nativePending.set(id, {
          resolve: (r) => { clearTimeout(timer); resolve(r); },
          reject: (e) => { clearTimeout(timer); reject(e); }
        });

        try {
          global.PJNative.request(id, method, url, JSON.stringify(headers), b64);
        } catch (e) {
          nativePending.delete(id);
          clearTimeout(timer);
          reject(e);
        }
      });
    },

    _url(path) {
      return this._base() + path.replace(/^\//, '');
    },

    /* ────────── 基础操作 ────────── */
    async test() {
      const base = this._base();
      try {
        const r = await this._fetch('PROPFIND', base, null, { Depth: '0' });
        if (r.status === 401 || r.status === 403) return { ok: false, msg: '认证失败：请检查账号与应用密码' };
        if (r.status === 404) return { ok: true, msg: '连接正常（目录尚未创建，首次同步会自动建）' };
        if (r.ok || r.status === 207) return { ok: true, msg: '连接正常 · ' + base };
        return { ok: false, msg: `服务器返回 ${r.status} ${r.statusText}` };
      } catch (e) {
        const cors = /Failed to fetch|NetworkError|Load failed/i.test(e.message || '');
        return {
          ok: false,
          msg: cors && !hasNative()
            ? '跨域被拦截（CORS）。运行 node server.mjs 后在设置里填入代理地址，或使用 Android 版（走原生通道，不受限制）。'
            : (e.message || String(e))
        };
      }
    },

    async _ensureDir() {
      const r = await this._fetch('MKCOL', this._base(), null);
      // 405 = 已存在，201 = 创建成功
      if (![201, 200, 204, 301, 405, 409, 403].includes(r.status) && !r.ok) {
        if (r.status === 401) throw new Error('认证失败（401）');
      }
      for (const d of ['entries/', 'media/']) {
        try { await this._fetch('MKCOL', this._url(d), null); } catch (e) { /* ignore */ }
      }
    },

    async _getJSON(path) {
      const r = await this._fetch('GET', this._url(path), null, { 'Cache-Control': 'no-cache' });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`读取 ${path} 失败：${r.status}`);
      const txt = await r.text();
      if (!txt.trim()) return null;
      try { return JSON.parse(txt); } catch (e) { return null; }
    },

    async _putJSON(path, obj) {
      const r = await this._fetch('PUT', this._url(path), JSON.stringify(obj), {
        'Content-Type': 'application/json; charset=utf-8'
      });
      if (!r.ok && r.status !== 201 && r.status !== 204) {
        throw new Error(`写入 ${path} 失败：${r.status} ${r.statusText}`);
      }
      return true;
    },

    /* ────────── 媒体 ────────── */
    _mediaPath(m) {
      const ext = (m.ext || 'bin').replace(/[^a-z0-9]/gi, '');
      return `media/${m.hash}.${ext}`;
    },

    async _uploadMedia(m) {
      const r = await this._fetch('HEAD', this._url(this._mediaPath(m)));
      if (r.ok) return false;                       // 已存在，跳过
      const ct = m.type || 'application/octet-stream';
      const up = await this._fetch('PUT', this._url(this._mediaPath(m)), m.blob, {
        'Content-Type': ct
      });
      if (!up.ok && up.status !== 201 && up.status !== 204) {
        throw new Error(`上传附件失败：${up.status}`);
      }
      return true;
    },

    /** 条目对应的附件若本地缺失，从远端拉回 */
    async ensureMedia(mediaId) {
      const m = await Store.getMedia(mediaId);
      if (m && m.blob) return m;
      if (!this.configured) return null;
      // 本地有记录但无 blob（罕见）
      if (m) {
        try {
          const r = await this._fetch('GET', this._url(this._mediaPath(m)));
          if (r.ok) {
            const blob = await r.blob();
            m.blob = blob;
            await Store.putMediaRaw(m);
            return m;
          }
        } catch (e) { /* ignore */ }
      }
      return null;
    },

    /* ────────── 主同步 ────────── */
    async run(onProgress) {
      if (this.running) return { skipped: true };
      if (!this.configured) throw new Error('请先在设置中填写 WebDAV 服务器与账号');
      this.running = true;

      const stat = { pulled: 0, pushed: 0, mediaUp: 0, conflicts: 0, total: 0, at: Date.now() };
      const say = (s) => onProgress && onProgress(s);

      try {
        say('连接服务器…');
        await this._ensureDir();
        try { await this._fetch('MKCOL', this._url('raw/'), null); } catch (e) { /* ignore */ }

        say('读取远端索引…');
        const remoteManifest = await this._getJSON('manifest.json');
        const remoteMap = (remoteManifest && remoteManifest.entries) || {};

        say('读取本地数据…');
        const localAll = await Store.listEntries({ includeDeleted: true });
        const localMap = {};
        localAll.forEach(e => { localMap[e.id] = e; });

        const ids = new Set([...Object.keys(remoteMap), ...Object.keys(localMap)]);
        stat.total = ids.size;

        const toUpload = [];
        const toDownload = [];
        const conflictCopies = [];

        for (const id of ids) {
          const L = localMap[id];
          const R = remoteMap[id];

          if (L && !R) { toUpload.push(id); continue; }
          if (!L && R) { toDownload.push(id); continue; }

          const lu = L.updatedAt || 0;
          const ru = R.updatedAt || 0;
          if (lu > ru + 400) { toUpload.push(id); }
          else if (ru > lu + 400) { toDownload.push(id); }
          else if (Math.abs(lu - ru) <= 400) {
            // 时间几乎相同但可能在两台设备上各自改过 → 比对摘要
            if (L.hash !== R.hash) {
              if (lu >= ru) { toUpload.push(id); conflictCopies.push({ id, keep: L }); }
              else { toDownload.push(id); conflictCopies.push({ id, keep: R }); }
            }
          }
        }

        // 下载
        let i = 0;
        for (const id of toDownload) {
          say(`下载 ${++i}/${toDownload.length} …`);
          try {
            const e = await this._getJSON(`entries/${id}.json`);
            if (e) {
              e.id = id;
              await Store.putEntry(e);
              stat.pulled++;
            }
          } catch (err) { console.warn('pull fail', id, err); }
        }

        // 上传条目 + 附件
        i = 0;
        for (const id of toUpload) {
          say(`上传 ${++i}/${toUpload.length} …`);
          try {
            const e = localMap[id];
            for (const a of (e.attachments || [])) {
              if (!a.mediaId) continue;
              const m = await Store.getMedia(a.mediaId);
              if (m && m.blob) {
                if (await this._uploadMedia(m)) stat.mediaUp++;
              }
            }
            const payload = Object.assign({}, e);
            payload.hash = entryHash(e);
            await this._putJSON(`entries/${id}.json`, payload);
            stat.pushed++;
          } catch (err) { console.warn('push fail', id, err); }
        }

        // 冲突副本：把被覆盖的一方另存为新条目，绝不丢数据
        for (const c of conflictCopies) {
          try {
            const src = c.keep;
            const copy = JSON.parse(JSON.stringify(src));
            copy.id = uid();
            copy.title = (src.title || '无题') + '（冲突副本）';
            copy.createdAt = Date.now();
            copy.updatedAt = Date.now();
            delete copy.hash;
            await Store.putEntry(copy);
            stat.conflicts++;
          } catch (e) { /* ignore */ }
        }

        // 网页书（原样 HTML）同步
        try {
          const rs = await this.syncRawBooks(say);
          stat.rawUp = rs.up;
          stat.rawDown = rs.down;
          if (rs.skip) stat.rawSkip = rs.skip;
        } catch (e) {
          console.warn('raw books sync fail', e);
        }

        // 重写远端索引
        say('写入索引…');
        const finalAll = await Store.listEntries({ includeDeleted: true });
        const manifest = { v: 1, updatedAt: Date.now(), app: 'paper-journal', entries: {} };
        finalAll.forEach(e => {
          manifest.entries[e.id] = {
            day: e.day,
            updatedAt: e.updatedAt,
            deleted: e.deleted ? 1 : 0,
            title: e.title || '',
            hash: entryHash(e)
          };
        });
        await this._putJSON('manifest.json', manifest);

        stat.at = Date.now();
        say('完成');
        return stat;
      } catch (e) {
        throw e;
      } finally {
        this.running = false;
      }
    }
  };

  /** 条目内容摘要，用于冲突判定 */
  function entryHash(e) {
    const s = JSON.stringify({
      t: e.title || '', b: e.body || '',
      a: (e.attachments || []).map(x => x.mediaId + ':' + x.type),
      g: e.tags || [], m: e.mood || '', d: e.deleted ? 1 : 0
    });
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16);
  }

  /* ────────── 网页书（原样 HTML）同步 ────────── */
  /**
   * 远端结构：
   *   raw/index.json                 { v, books: { id: {title, entryPath, sig, files, tomb?} } }
   *   raw/<bookId>/manifest.json     { v, title, entryPath, files: [{path,hash,size}] }
   *   raw/<bookId>/files/<enc path>  文件本体
   * 策略：sig（路径+哈希签名）不同即整本核对，缺谁补谁；删除用墓碑跨设备传播。
   */
  Sync.syncRawBooks = async function (say) {
    const stat = { up: 0, down: 0, skip: 0 };
    const tombs = new Set(await Store.getRawTombs());

    let index = await this._getJSON('raw/index.json');
    if (!index || !index.books) index = { v: 1, books: {} };

    // 远端墓碑合并进本地，并删除本地残留副本
    for (const id of Object.keys(index.books)) {
      if (!index.books[id].tomb) continue;
      tombs.add(id);
      await Store.addRawTomb(id);
      const has = (await Store.listBooks()).some(b => b.id === id && b.kind === 'html');
      if (has) {
        say('清理已删除的网页书…');
        await Store.delRawFiles(id);
        await Store.delBook(id);
      }
    }

    const localBooks = (await Store.listBooks()).filter(b => b.kind === 'html');

    // 推送 / 核对本地网页书
    for (const b of localBooks) {
      if (tombs.has(b.id)) continue;
      const local = await Store.listRawFiles(b.id);
      const localSig = local.map(f => f.path + ':' + f.hash).sort().join('|');
      const remote = index.books[b.id];
      if (remote && remote.sig === localSig && !remote.tomb) { stat.skip++; continue; }

      say(`同步网页书《${b.title}》…`);
      const remoteByPath = {};
      ((remote && remote.files) || []).forEach(f => { remoteByPath[f.path] = f; });

      for (const f of local) {
        const rf = remoteByPath[f.path];
        if (rf && rf.hash === f.hash) continue;         // 远端已有同内容文件
        const buf = await f.blob.arrayBuffer();
        await this._fetch('PUT',
          this._url(`raw/${b.id}/files/${encodeURIComponent(f.path)}`),
          buf,
          { 'Content-Type': f.type || 'application/octet-stream' });
        stat.up++;
      }
      const manifest = {
        v: 1, title: b.title, entryPath: b.entryPath || 'index.html',
        files: local.map(f => ({ path: f.path, hash: f.hash, size: f.size }))
      };
      await this._putJSON(`raw/${b.id}/manifest.json`, manifest);
      index.books[b.id] = {
        id: b.id, title: b.title, entryPath: manifest.entryPath,
        sig: localSig, files: manifest.files
      };
    }

    // 拉取远端有、本地无的网页书
    for (const id of Object.keys(index.books)) {
      if (tombs.has(id)) continue;
      const info = index.books[id];
      if (info.tomb) continue;
      if (localBooks.some(b => b.id === id)) continue;
      if (!info.files || !info.files.length) continue;

      try {
        say(`下载网页书《${info.title || id}》…`);
        for (const rf of info.files) {
          const resp = await this._fetch('GET',
            this._url(`raw/${id}/files/${encodeURIComponent(rf.path)}`));
          if (!resp.ok) throw new Error(`${rf.path} → ${resp.status}`);
          const blob = await resp.blob();
          await Store.putRawFile({
            id: id + '/' + rf.path, bookId: id, path: rf.path,
            blob, type: '', size: rf.size, hash: rf.hash
          });
        }
        await Store.putBook({
          id, title: info.title || '网页书', kind: 'html',
          entryPath: info.entryPath || 'index.html',
          cover: 0, fileCount: info.files.length,
          createdAt: Date.now(), updatedAt: Date.now()
        });
        stat.down++;
      } catch (e) {
        console.warn('raw pull fail', id, e);
      }
    }

    // 远端索引落盘（若有变化才写）
    await this._putJSON('raw/index.json', index);
    return stat;
  };

  global.PJ = global.PJ || {};
  global.PJ.Sync = Sync;
  global.PJ.entryHash = entryHash;
})(window);
