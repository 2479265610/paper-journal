/* ═══════════════════════════════════════════════
   aibridge.js — AI 桥（MCP 数据代理的执行端）
   MCP server（mcp-server.mjs）收到 AI 客户端的工具调用后，
   通过本机接口把操作转发到这里，由这里读写真正的数据（IndexedDB）。
   通道自适应：桌面走 IPC，网页走 SSE（server.mjs /bridge）。
   ═══════════════════════════════════════════════ */
(function (global) {
  'use strict';

  const { Store, uid, dayKey, sanitize, excerpt, wordCount } = global.PJ;

  function htmlToText(html) {
    const t = document.createElement('div');
    t.innerHTML = html || '';
    return (t.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
  }

  function changed() {
    global.dispatchEvent(new CustomEvent('pj-data-changed'));
  }

  /* ── 操作实现（数据面） ── */
  const Ops = {

    async 'books.list'() {
      const books = await Store.listBooks();
      const all = await Store.listEntries();
      return {
        books: books.map(b => ({
          id: b.id,
          title: b.title,
          kind: b.kind || 'diary',
          count: b.kind === 'html'
            ? (b.fileCount || 0)
            : all.filter(e => e.bookId === b.id).length
        }))
      };
    },

    async 'books.create'(a) {
      const t = String(a.title || '').trim();
      if (!t) throw new Error('缺少 title');
      const b = {
        id: uid(), title: t,
        cover: Math.floor(Math.random() * 6),
        createdAt: Date.now(), updatedAt: Date.now()
      };
      await Store.putBook(b);
      changed();
      return { id: b.id, title: b.title };
    },

    async 'entries.list'(a) {
      let entries;
      if (a.bookTitle) {
        const books = await Store.listBooks();
        const b = books.find(x => x.title === a.bookTitle);
        if (!b) throw new Error('没有叫「' + a.bookTitle + '」的日记本');
        entries = await Store.listEntries({ bookId: b.id });
      } else {
        entries = await Store.listEntries();
      }
      const total = entries.length;
      const limit = Math.min(Math.max(Number(a.limit) || 20, 1), 100);
      return {
        total,
        entries: entries.slice(0, limit).map(e => ({
          id: e.id, day: e.day, title: e.title || '', ts: e.ts,
          words: wordCount(e.body),
          excerpt: excerpt(e.body, 80)
        }))
      };
    },

    async 'entries.read'(a) {
      const e = await Store.getEntry(a.id);
      if (!e) throw new Error('找不到日记 ' + a.id);
      return { id: e.id, day: e.day, title: e.title || '', text: htmlToText(e.body) };
    },

    /** 原始条目（含附件清单），调试与外部工具用 */
    async 'entries.raw'(a) {
      const e = await Store.getEntry(a.id);
      if (!e) throw new Error('找不到日记 ' + a.id);
      return {
        id: e.id, day: e.day, title: e.title || '',
        body: e.body, weather: e.weather || '', tags: e.tags || [],
        attachments: (e.attachments || []).map(x => ({
          type: x.type, name: x.name, size: x.size, id: x.mediaId
        }))
      };
    },

    async 'entries.write'(a) {
      const books = await Store.listBooks();
      let book = null;
      if (a.bookTitle) {
        book = books.find(b => b.title === a.bookTitle);
        if (!book) throw new Error('没有叫「' + a.bookTitle + '」的日记本');
      }
      if (!book) book = books[0];
      if (!book) throw new Error('还没有日记本，请先在纸间里新建一个');
      const now = Date.now();
      const day = a.day && /^\d{4}-\d{2}-\d{2}$/.test(a.day) ? a.day : dayKey(now);
      const e = {
        id: uid(), bookId: book.id, day, ts: now,
        title: String(a.title || '').slice(0, 80),
        body: sanitize(a.bodyHtml || ''),
        attachments: [],
        tags: Array.isArray(a.tags) ? a.tags.map(String).slice(0, 12) : [],
        mood: String(a.mood || '').slice(0, 8),
        weather: String(a.weather || '').slice(0, 8),
        starred: 0,
        createdAt: now, updatedAt: now
      };
      await Store.putEntry(e);
      changed();
      return { id: e.id, day: e.day, title: e.title, words: wordCount(e.body) };
    },

    async 'entries.append'(a) {
      const e = await Store.getEntry(a.id);
      if (!e) throw new Error('找不到日记 ' + a.id);
      const add = sanitize(a.bodyHtml || '');
      e.body = (e.body ? e.body + '\n' : '') + add;
      await Store.putEntry(e);
      changed();
      return { id: e.id, title: e.title, words: wordCount(e.body) };
    },

    async 'entries.search'(a) {
      const q = String(a.q || '').toLowerCase();
      if (!q) return { total: 0, entries: [] };
      const all = await Store.listEntries();
      const hits = [];
      for (const e of all) {
        const hay = [e.title, excerpt(e.body, 4000), (e.tags || []).join(' ')]
          .join(' ').toLowerCase();
        if (hay.includes(q)) hits.push(e);
        if (hits.length >= 50) break;
      }
      const limit = Math.min(Math.max(Number(a.limit) || 10, 1), 50);
      return {
        total: hits.length,
        entries: hits.slice(0, limit).map(e => ({
          id: e.id, day: e.day, title: e.title || '',
          words: wordCount(e.body), excerpt: excerpt(e.body, 80)
        }))
      };
    },

    /** 清空所有日记本与网页书（本地维护用，谨慎） */
    async 'db.reset'() {
      const books = await Store.listBooks();
      for (const b of books) {
        if (b.kind === 'html') {
          await Store.addRawTomb(b.id);
          await Store.delRawFiles(b.id);
        }
        await Store.delBook(b.id);
      }
      changed();
      return { ok: true, removed: books.length };
    },

    async 'stats'() {
      const all = await Store.listEntries();
      const books = await Store.listBooks();
      const days = new Set(all.map(e => e.day));
      let streak = 0;
      const d = new Date();
      if (!days.has(dayKey(d.getTime()))) d.setDate(d.getDate() - 1);
      while (days.has(dayKey(d.getTime()))) { streak++; d.setDate(d.getDate() - 1); }
      return {
        entries: all.length,
        days: days.size,
        streak,
        books: books.filter(b => b.kind !== 'html').length,
        htmlBooks: books.filter(b => b.kind === 'html').length
      };
    }
  };

  async function exec(op, args) {
    const fn = Ops[op];
    if (!fn) throw new Error('未知操作: ' + op);
    return await fn(args || {});
  }

  /* ── 桌面：主进程 HTTP → IPC → 这里 ── */
  function initDesktop() {
    global.PJDesktop.onOp(({ id, op, args }) => {
      exec(op, args)
        .then(data => global.PJDesktop.opResult({ id, ok: true, data }))
        .catch(err => global.PJDesktop.opResult({ id, ok: false, error: String((err && err.message) || err) }));
    });
    return 'ipc';
  }

  /* ── 网页：SSE 领任务，POST 回结果 ── */
  function initWeb() {
    const es = new EventSource('/bridge/events');
    es.addEventListener('op', (ev) => {
      let p;
      try { p = JSON.parse(ev.data); } catch (e) { return; }
      exec(p.op, p.args)
        .then(data => fetch('/bridge/response', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: p.id, ok: true, data })
        }).catch(() => {}))
        .catch(err => fetch('/bridge/response', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: p.id, ok: false, error: String((err && err.message) || err) })
        }).catch(() => {}));
    });
    return 'sse';
  }

  function init() {
    try {
      if (global.PJDesktop && typeof global.PJDesktop.onOp === 'function') {
        global.PJ.AI.mode = initDesktop();
      } else if (global.EventSource && location.protocol.startsWith('http')) {
        global.PJ.AI.mode = initWeb();
      }
    } catch (e) {
      console.warn('[aibridge] 初始化失败', e);
      global.PJ.AI.mode = 'off';
    }
    global.dispatchEvent(new CustomEvent('pj-ai-ready', {
      detail: { mode: global.PJ.AI.mode }
    }));
  }

  global.PJ = global.PJ || {};
  global.PJ.AI = { exec, init, mode: 'off' };
})(window);
