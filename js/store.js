/* ═══════════════════════════════════════════════
   store.js — 本地库（IndexedDB）
   ═══════════════════════════════════════════════ */
(function (global) {
  'use strict';

  const { uid, dayKey, sha256 } = global.PJ;
  const DB_NAME = 'paper-journal';
  const DB_VER = 2;

  let db = null;
  const urlCache = new Map();   // mediaId -> objectURL

  function open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = (e) => {
        const d = e.target.result;
        if (!d.objectStoreNames.contains('books')) {
          d.createObjectStore('books', { keyPath: 'id' });
        }
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
        if (!d.objectStoreNames.contains('meta')) {
          d.createObjectStore('meta', { keyPath: 'k' });
        }
        if (!d.objectStoreNames.contains('rawFiles')) {
          const r = d.createObjectStore('rawFiles', { keyPath: 'id' });
          r.createIndex('bookId', 'bookId');
        }
      };
      req.onsuccess = () => { db = req.result; resolve(db); };
      req.onerror = () => reject(req.error);
    });
  }

  function tx(stores, mode) {
    return db.transaction(stores, mode || 'readonly');
  }

  function req2p(r) {
    return new Promise((res, rej) => {
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }

  const Store = {
    async init() {
      if (!db) await open();
      await this.ensureDefaultBook();
      this.cleanTrash();
      return db;
    },

    /* ────────── 本子 ────────── */
    async ensureDefaultBook() {
      const books = await this.listBooks();
      if (!books.length) {
        await this.putBook({
          id: uid(),
          title: '我的日记',
          cover: 0,
          createdAt: Date.now(),
          updatedAt: Date.now()
        });
      }
    },

    async listBooks() {
      const r = await req2p(tx('books').objectStore('books').getAll());
      return (r || []).sort((a, b) => a.createdAt - b.createdAt);
    },

    async putBook(b) {
      b.updatedAt = Date.now();
      await req2p(tx('books', 'readwrite').objectStore('books').put(b));
      return b;
    },

    async delBook(id) {
      const entries = await this.listEntries({ bookId: id, includeDeleted: true });
      const t = tx(['books', 'entries'], 'readwrite');
      entries.forEach(e => t.objectStore('entries').delete(e.id));
      t.objectStore('books').delete(id);
      await new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); });
    },

    /* ────────── 日记条目 ────────── */
    async listEntries(opt) {
      opt = opt || {};
      let arr;
      if (opt.bookId) {
        arr = await req2p(tx('entries').objectStore('entries').index('bookId').getAll(opt.bookId));
      } else {
        arr = await req2p(tx('entries').objectStore('entries').getAll());
      }
      arr = arr || [];
      if (!opt.includeDeleted) arr = arr.filter(e => !e.deleted);
      return arr.sort((a, b) => {
        if (a.day === b.day) return b.ts - a.ts;
        return a.day < b.day ? 1 : -1;   // 新的在前
      });
    },

    async getEntry(id) {
      return req2p(tx('entries').objectStore('entries').get(id));
    },

    async putEntry(e) {
      e.updatedAt = Date.now();
      if (!e.createdAt) e.createdAt = e.updatedAt;
      if (!e.day) e.day = dayKey(e.ts || e.updatedAt);
      await req2p(tx('entries', 'readwrite').objectStore('entries').put(e));
      return e;
    },

    /** 软删除 */
    async delEntry(id) {
      const e = await this.getEntry(id);
      if (!e) return;
      e.deleted = 1;
      e.deletedAt = Date.now();
      await this.putEntry(e);
    },

    async restoreEntry(id) {
      const e = await this.getEntry(id);
      if (!e) return;
      delete e.deleted; delete e.deletedAt;
      await this.putEntry(e);
    },

    /** 彻底删除（同时清理孤立媒体） */
    async purgeEntry(id) {
      const e = await this.getEntry(id);
      await req2p(tx('entries', 'readwrite').objectStore('entries').delete(id));
      if (e && e.attachments) {
        for (const a of e.attachments) {
          if (a.mediaId) await this.gcMedia(a.mediaId);
        }
      }
    },

    /** 30 天后自动清理回收站 */
    async cleanTrash() {
      const all = await req2p(tx('entries').objectStore('entries').getAll());
      const now = Date.now();
      const dead = (all || []).filter(e => e.deleted && now - (e.deletedAt || 0) > 30 * 864e5);
      for (const e of dead) await this.purgeEntry(e.id);
    },

    /* ────────── 媒体 ────────── */
    /** 存文件，按内容哈希去重 */
    async putMedia(file, nameHint) {
      const buf = await file.arrayBuffer();
      const hash = await sha256(buf);
      const exists = await req2p(tx('media').objectStore('media').index('hash').get(hash));
      if (exists) return exists;

      const name = nameHint || file.name || 'file';
      const ext = (name.split('.').pop() || '').toLowerCase();
      const rec = {
        id: uid(),
        hash,
        name,
        type: file.type || guessType(ext),
        ext,
        size: file.size,
        blob: file,
        createdAt: Date.now()
      };
      await req2p(tx('media', 'readwrite').objectStore('media').put(rec));
      return rec;
    },

    /** 存文本类（HTML） */
    async putText(text, name, type) {
      const blob = new Blob([text], { type: type || 'text/html' });
      const file = new File([blob], name, { type: type || 'text/html' });
      return this.putMedia(file, name);
    },

    async getMedia(id) {
      return req2p(tx('media').objectStore('media').get(id));
    },

    async mediaUrl(id) {
      if (urlCache.has(id)) return urlCache.get(id);
      const m = await this.getMedia(id);
      if (!m || !m.blob) return '';
      const u = URL.createObjectURL(m.blob);
      urlCache.set(id, u);
      return u;
    },

    async allMedia() {
      return (await req2p(tx('media').objectStore('media').getAll())) || [];
    },

    async putMediaRaw(rec) {
      await req2p(tx('media', 'readwrite').objectStore('media').put(rec));
      return rec;
    },

    /** 无引用则删除 */
    async gcMedia(mediaId) {
      const all = await req2p(tx('entries').objectStore('entries').getAll());
      const used = new Set();
      (all || []).forEach(e => (e.attachments || []).forEach(a => a.mediaId && used.add(a.mediaId)));
      if (used.has(mediaId)) return false;
      await req2p(tx('media', 'readwrite').objectStore('media').delete(mediaId));
      const u = urlCache.get(mediaId);
      if (u) { URL.revokeObjectURL(u); urlCache.delete(mediaId); }
      return true;
    },

    /* ────────── 设置 ────────── */
    async getMeta(k, def) {
      const r = await req2p(tx('meta').objectStore('meta').get(k));
      return r ? r.v : def;
    },

    async setMeta(k, v) {
      await req2p(tx('meta', 'readwrite').objectStore('meta').put({ k, v }));
      return v;
    },

    async storageEstimate() {
      if (!navigator.storage || !navigator.storage.estimate) return null;
      try { return await navigator.storage.estimate(); } catch (e) { return null; }
    },

    /* ────────── 原样 HTML 书（raw site） ────────── */
    /** rec: { id: `${bookId}/${path}`, bookId, path, blob, type, size, hash? } */
    async putRawFile(rec) {
      if (!rec.hash) {
        try {
          const buf = await rec.blob.arrayBuffer();
          rec.hash = await sha256(buf);
        } catch (e) { rec.hash = ''; }
      }
      await req2p(tx('rawFiles', 'readwrite').objectStore('rawFiles').put(rec));
      return rec;
    },

    async getRawFile(bookId, path) {
      return req2p(tx('rawFiles').objectStore('rawFiles').get(`${bookId}/${path}`));
    },

    async listRawFiles(bookId) {
      const r = await req2p(tx('rawFiles').objectStore('rawFiles').index('bookId').getAll(bookId));
      return r || [];
    },

    async delRawFiles(bookId) {
      const files = await this.listRawFiles(bookId);
      const t = tx('rawFiles', 'readwrite');
      files.forEach(f => t.objectStore('rawFiles').delete(f.id));
      await new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); });
      return files.length;
    },

    /** 删除墓碑：网页书删除后跨设备传播（防同步复活） */
    async getRawTombs() { return this.getMeta('rawTomb', []); },
    async addRawTomb(bookId) {
      const t = await this.getRawTombs();
      if (!t.includes(bookId)) await this.setMeta('rawTomb', [...t, bookId]);
    },

    /** 全量导出数据 */
    async dump() {
      const [books, entries, media] = await Promise.all([
        this.listBooks(),
        req2p(tx('entries').objectStore('entries').getAll()),
        this.allMedia()
      ]);
      return { books, entries: entries || [], mediaCount: (media || []).length, exportedAt: Date.now() };
    }
  };

  function guessType(ext) {
    const map = {
      pdf: 'application/pdf', html: 'text/html', htm: 'text/html',
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
      webp: 'image/webp', heic: 'image/heic', svg: 'image/svg+xml',
      mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', m4v: 'video/mp4',
      mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', ogg: 'audio/ogg',
      webm_a: 'audio/webm'
    };
    return map[ext] || 'application/octet-stream';
  }

  global.PJ = global.PJ || {};
  global.PJ.Store = Store;
})(window);
