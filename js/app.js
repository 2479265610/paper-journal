/* ═══════════════════════════════════════════════
   app.js — 主控
   ═══════════════════════════════════════════════ */
(function () {
  'use strict';

  const {
    $, $$, uid, dayKey, parseDay, fmtTime, fmtFull, relTime, fmtBytes,
    escapeHtml, sanitize, excerpt, wordCount, debounce, clamp, toast,
    promptText, pickOption, WEEK, pad
  } = PJ;

  const Store = PJ.Store;
  const Sync = PJ.Sync;
  const Sound = PJ.Sound;
  let Flip = null;

  const MON = ['一月', '二月', '三月', '四月', '五月', '六月',
               '七月', '八月', '九月', '十月', '十一月', '十二月'];

  const MOODS = ['😊', '😌', '🥲', '😔', '😤', '🥰', '😴', '🤔', '😭', '🎉'];
  const WEATHER = ['☀️', '⛅', '☁️', '🌧️', '⛈️', '❄️', '🌫️', '🌙'];

  const S = {
    view: 'shelf',
    bookId: null,
    books: [],
    entries: [],
    all: [],
    idx: 0,
    editing: false,
    cfg: {},
    calY: new Date().getFullYear(),
    calM: new Date().getMonth(),
    searchQ: '',
    searchTag: ''
  };

  const htmlCache = new Map();
  let saveTimer = null;
  let autoSyncTimer = null;

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  /* ══════════ 启动 ══════════ */
  async function boot() {
    await Store.init();
    await loadSettings();
    await refreshAll();

    const pin = await Store.getMeta('pin', '');
    if (pin) { showLock(pin); }

    bindGlobal();
    renderShelf();
    setView('shelf');

    if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
    if (S.cfg.autoSync && Sync.configured) {
      autoSyncTimer = setInterval(() => doSync(true), 10 * 60 * 1000);
      setTimeout(() => doSync(true), 4000);
    }
  }

  async function loadSettings() {
    S.cfg = {
      theme: await Store.getMeta('theme', 'paper'),
      font: await Store.getMeta('font', 'm'),
      sound: await Store.getMeta('sound', true),
      grain: await Store.getMeta('grain', true),
      autoSync: await Store.getMeta('autoSync', false),
      davUrl: await Store.getMeta('davUrl', ''),
      davUser: await Store.getMeta('davUser', ''),
      davPass: await Store.getMeta('davPass', ''),
      davProxy: await Store.getMeta('davProxy', '')
    };
    applySettings();
  }

  function applySettings() {
    document.getElementById('app').dataset.theme = S.cfg.theme;
    document.documentElement.style.setProperty('--grain-opacity', S.cfg.grain ? '.5' : '0');
    const fs = { s: '15px', m: '16px', l: '18px' }[S.cfg.font] || '16px';
    document.documentElement.style.setProperty('--fs-body', fs);
    Sound.enabled = !!S.cfg.sound;
    Sync.setConfig({ url: S.cfg.davUrl, user: S.cfg.davUser, pass: S.cfg.davPass, proxy: S.cfg.davProxy });

    const tc = document.querySelector('meta[name="theme-color"]');
    if (tc) tc.content = { paper: '#efe9dd', kraft: '#cfbfa4', ink: '#14161a' }[S.cfg.theme] || '#efe9dd';
  }

  async function refreshAll() {
    S.books = await Store.listBooks();
    S.all = await Store.listEntries();
  }

  /* ══════════ 视图路由 ══════════ */
  function setView(v) {
    S.view = v;
    document.getElementById('app').dataset.view = v;
    $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === v));

    const back = $('#btnBack');
    back.hidden = !(v === 'reader' || v === 'search');

    if (v === 'shelf') { $('#viewTitle').textContent = '纸间'; renderShelf(); }
    if (v === 'timeline') { $('#viewTitle').textContent = '时间轴'; renderTimeline(); }
    if (v === 'calendar') { $('#viewTitle').textContent = '日历'; renderCalendar(); }
    if (v === 'gallery') { $('#viewTitle').textContent = '相册'; renderGallery(); }
    if (v === 'search') { $('#viewTitle').textContent = '搜索'; setTimeout(() => $('#searchInput').focus(), 220); }
    updateSub();
  }

  function updateSub() {
    const sub = $('#viewSub');
    if (S.view === 'reader') {
      const b = S.books.find(x => x.id === S.bookId);
      sub.textContent = b ? `${b.title} · 第 ${S.idx + 1} / ${S.entries.length} 页` : '';
      return;
    }
    if (S.view === 'shelf') {
      const n = S.all.length;
      const streak = calcStreak(S.all);
      sub.textContent = `${n} 篇记录 · 连续 ${streak} 天`;
      return;
    }
    if (S.view === 'timeline') { sub.textContent = `${S.all.length} 篇`; return; }
    if (S.view === 'calendar') { sub.textContent = `${new Set(S.all.map(e => e.day)).size} 天有记录`; return; }
    if (S.view === 'gallery') { sub.textContent = '所有照片与视频'; return; }
    if (S.view === 'search') { sub.textContent = '全文与标签'; }
  }

  function calcStreak(list) {
    if (!list.length) return 0;
    const days = new Set(list.map(e => e.day));
    let n = 0;
    const d = new Date();
    // 若今天没写，从昨天开始算
    if (!days.has(dayKey(d.getTime()))) d.setDate(d.getDate() - 1);
    while (days.has(dayKey(d.getTime()))) {
      n++;
      d.setDate(d.getDate() - 1);
    }
    return n;
  }

  /* ══════════ 书架 ══════════ */
  const COVERS = [
    'linear-gradient(150deg,#3c5a4e,#22352d)',
    'linear-gradient(150deg,#6b3f34,#40241c)',
    'linear-gradient(150deg,#3a4a63,#1f2a3b)',
    'linear-gradient(150deg,#7a6540,#4a3c22)',
    'linear-gradient(150deg,#5b4258,#372535)',
    'linear-gradient(150deg,#4a4a4a,#282828)'
  ];

  let shelfIndex = 0;
  let lastShelfDrag = 0;

  function renderShelf() {
    const track = $('#flowTrack');
    const dots = $('#flowDots');
    if (!track) return;
    track.innerHTML = '';
    dots.innerHTML = '';

    S.books.forEach((b, i) => {
      const items = S.all.filter(e => e.bookId === b.id);
      const el = document.createElement('div');
      el.className = 'flow-item';
      el.dataset.id = b.id;
      el.style.background = COVERS[(b.cover || i) % COVERS.length];
      el.innerHTML = `<div class="fi-face">
        <div class="fi-title">${escapeHtml(b.title)}</div>
        <div class="fi-bottom">
          <span class="fi-count">${items.length} 页</span>
          <span class="fi-date">${items.length ? relTime(items[0].updatedAt) : '空白本子'}</span>
        </div>
      </div>`;
      el.querySelector('.fi-face').style.animationDelay = `${i * 55}ms`;

      el.addEventListener('click', () => {
        if (Date.now() - lastShelfDrag < 350) return;
        if (i === shelfIndex) openBook(b.id);
        else focusBook(i);
      });
      el.addEventListener('contextmenu', (ev) => {
        ev.preventDefault();
        focusBook(i);
      });

      track.appendChild(el);

      const dot = document.createElement('i');
      dot.addEventListener('click', () => focusBook(i));
      dots.appendChild(dot);
    });

    layoutFlow();
  }

  function layoutFlow() {
    const items = $$('#flowTrack .flow-item');
    if (!items.length) return;
    shelfIndex = clamp(shelfIndex, 0, items.length - 1);

    const w = items[0].offsetWidth || 180;
    const gap = w * 0.76;

    items.forEach((el, i) => {
      const off = i - shelfIndex;
      const abs = Math.abs(off);
      const sign = Math.sign(off);

      const x = off * gap;
      const z = -Math.min(abs, 4) * (w * 0.4);
      const ry = sign === 0 ? 0 : -sign * 36;
      const sc = off === 0 ? 1 : 0.95;
      const op = abs > 4 ? 0 : 1 - Math.min(abs, 4) * 0.12;

      el.style.transform =
        `translate3d(${x.toFixed(1)}px, 0, ${z.toFixed(1)}px) rotateY(${ry}deg) scale(${sc})`;
      el.style.opacity = op.toFixed(2);
      el.style.zIndex = String(100 - abs);
      el.classList.toggle('active', off === 0);
      el.style.pointerEvents = abs > 5 ? 'none' : 'auto';
    });

    const b = S.books[shelfIndex];
    const titleEl = $('#flowTitle');
    const subEl = $('#flowSub');
    const newTitle = b ? b.title : '书架';
    const newSub = b
      ? `${S.all.filter(e => e.bookId === b.id).length} 页`
      : '还没有日记本';
    if (titleEl.textContent !== newTitle) {
      titleEl.style.opacity = '0';
      subEl.style.opacity = '0';
      clearTimeout(layoutFlow._tt);
      layoutFlow._tt = setTimeout(() => {
        titleEl.textContent = newTitle;
        subEl.textContent = newSub;
        titleEl.style.opacity = '1';
        subEl.style.opacity = '1';
      }, 130);
    } else {
      subEl.textContent = newSub;
    }

    $$('#flowDots i').forEach((d, i) => d.classList.toggle('on', i === shelfIndex));
  }

  function focusBook(i) {
    if (!S.books.length) return;
    const next = clamp(i, 0, S.books.length - 1);
    if (next === shelfIndex) return;
    shelfIndex = next;
    Sound.tap();
    layoutFlow();
  }

  async function createBook() {
    const t = await promptText('给它起个名字', '', '例如：2026 旅行、工作手记');
    if (!t || !t.trim()) return;
    const b = {
      id: uid(), title: t.trim(), cover: S.books.length,
      createdAt: Date.now(), updatedAt: Date.now()
    };
    await Store.putBook(b);
    await refreshAll();
    shelfIndex = S.books.length - 1;
    renderShelf();
    toast('日记本已创建');
  }

  async function renameBook() {
    const b = S.books[shelfIndex];
    if (!b) return;
    const t = await promptText('重命名日记本', b.title);
    if (!t || !t.trim()) return;
    b.title = t.trim();
    await Store.putBook(b);
    await refreshAll();
    renderShelf();
  }

  async function deleteBook() {
    const b = S.books[shelfIndex];
    if (!b) return;
    if (S.books.length <= 1) { toast('至少保留一个日记本'); return; }
    const n = S.all.filter(e => e.bookId === b.id).length;
    const ok = await pickOption(
      `删除「${b.title}」？${n ? `其中 ${n} 篇日记也会一并删除，不可恢复。` : ''}`,
      [{ label: '取消', value: 0 }, { label: '确认删除', value: 1 }]
    );
    if (!ok) return;
    await Store.delBook(b.id);
    await refreshAll();
    shelfIndex = clamp(shelfIndex, 0, S.books.length - 1);
    renderShelf();
    toast('已删除');
  }

  /* ── 封面：盖上 → 掀开 ── */
  async function showCover(book) {
    const c = $('#bookCover');
    if (!c) return;
    $('#bcvTitle').textContent = book ? book.title : '我的日记';
    const d = book && book.createdAt ? new Date(book.createdAt) : new Date();
    $('#bcvFoot').textContent = `${d.getFullYear()}`;
    c.hidden = false;
    c.classList.remove('open');
    void c.offsetWidth;
  }

  async function openCover(fast) {
    const c = $('#bookCover');
    if (!c || c.hidden) return;
    Sound.rustle({ strength: 0.85, low: true });
    c.classList.add('open');
    await sleep(fast ? 240 : 760);
    c.hidden = true;
  }

  async function openBook(bookId) {
    const book = S.books.find(b => b.id === bookId);
    S.bookId = bookId;
    S.entries = (await Store.listEntries({ bookId })).slice().reverse();  // 时间正序
    htmlCache.clear();
    setView('reader');
    await ensureFlip();

    if (S.entries.length) S.idx = S.entries.length - 1;

    await showCover(book);
    if (S.entries.length) await renderCurrent(true);
    else Flip.setPage(emptySheetHTML());

    await sleep(150);
    await openCover();
    updatePager();
    updateSub();
  }

  function emptySheetHTML() {
    return `<div class="sheet">
      <div class="sheet-empty">
        <div class="se-ico">✎</div>
        <div class="se-text">这个本子还是空的<br>写下的第一句，就是开始</div>
        <button class="btn primary" style="max-width:180px" data-act="newEntry">写第一篇</button>
      </div>
    </div>`;
  }

  /* ══════════ 阅读 / 翻页 ══════════ */
  async function ensureFlip() {
    if (Flip) return Flip;
    Flip = new PJ.Flip($('#book'), {
      canNext: () => !S.editing && S.idx < S.entries.length - 1,
      canPrev: () => !S.editing && S.idx > 0,
      getNextHTML: () => htmlCache.get(S.idx + 1) || '',
      getPrevHTML: () => htmlCache.get(S.idx - 1) || '',
      getUnderHTML: (dir) => htmlCache.get(S.idx + dir) || '',
      onFlip: (dir) => onFlipDone(dir),
      // 连点连翻：弹簧动画落定后立即处理排队的那一次
      onQueued: (dir) => { dir > 0 ? goNext() : goPrev(); }
    });
    return Flip;
  }

  async function onFlipDone(dir) {
    S.idx = clamp(S.idx + dir, 0, Math.max(0, S.entries.length - 1));
    Sound.rustle({ strength: 0.5, low: dir < 0 });
    await warmCache();
    updatePager();
    updateSub();
  }

  async function renderCurrent(fresh) {
    const e = S.entries[S.idx];
    const html = await renderSheet(e, { fresh });
    htmlCache.set(S.idx, html);
    Flip.setPage(html);
    Flip.setUnder('');
    await warmCache();
    updatePager();
    updateSub();
  }

  async function warmCache() {
    for (const i of [S.idx - 1, S.idx + 1]) {
      if (i < 0 || i >= S.entries.length) continue;
      if (htmlCache.has(i)) continue;
      htmlCache.set(i, await renderSheet(S.entries[i]));
    }
  }

  function updatePager() {
    const total = S.entries.length || 1;
    const atFirst = S.idx <= 0;
    const atLast = S.idx >= S.entries.length - 1;
    $('#pageIndicator').textContent = `${S.idx + 1} / ${total}`;
    $('#btnPrev').disabled = atFirst;
    $('#btnNext').disabled = atLast;
    $('#edgePrev').disabled = atFirst || S.editing;
    $('#edgeNext').disabled = atLast || S.editing;
    $('#pgDot').classList.toggle('on', S.editing);
  }

  async function goNext() {
    if (S.editing || S.idx >= S.entries.length - 1) return;
    await ensureFlip();
    if (!htmlCache.has(S.idx + 1)) htmlCache.set(S.idx + 1, await renderSheet(S.entries[S.idx + 1]));
    Sound.rustle({ strength: 0.7 });
    Flip.goNext(htmlCache.get(S.idx + 1), htmlCache.get(S.idx + 1), async () => {
      await onFlipDone(1);
    });
  }

  async function goPrev() {
    if (S.editing || S.idx <= 0) return;
    await ensureFlip();
    if (!htmlCache.has(S.idx - 1)) htmlCache.set(S.idx - 1, await renderSheet(S.entries[S.idx - 1]));
    Sound.rustle({ strength: 0.55, low: true });
    Flip.goPrev(htmlCache.get(S.idx - 1), htmlCache.get(S.idx - 1), async () => {
      await onFlipDone(-1);
    });
  }

  /* ══════════ 页面渲染 ══════════ */
  async function renderSheet(e, opt) {
    opt = opt || {};
    if (!e) return emptySheetHTML();
    const d = new Date(e.ts);
    const attHTML = await renderAttachments(e);

    const tags = (e.tags || []).map(t => `<span class="sf-tag" data-tag="${escapeHtml(t)}">#${escapeHtml(t)}</span>`).join('');
    const wc = wordCount(e.body);

    return `<div class="sheet${opt.fresh ? ' enter' : ''}" data-id="${e.id}">
      <div class="sheet-head">
        <div class="sh-date">
          <span class="sh-day">${d.getDate()}</span>
          <span class="sh-ym">${d.getFullYear()} · ${MON[d.getMonth()]}</span>
          <span class="sh-week">${WEEK[d.getDay()]} ${e.mood || ''} ${e.weather || ''}</span>
        </div>
        <div class="sh-line"></div>
        <h2 class="sh-title" data-ed="title">${escapeHtml(e.title || '')}</h2>
      </div>
      <div class="sh-body" data-ed="body">${e.body || ''}</div>
      ${attHTML}
      <div class="sheet-foot">
        ${tags}
        ${e.starred ? '<span style="color:var(--accent)">★</span>' : ''}
        <span class="sf-spacer"></span>
        ${wc ? `<span class="sf-num">${wc} 字</span>` : ''}
        <span class="sf-num">${fmtTime(e.ts)}</span>
      </div>
    </div>`;
  }

  async function renderAttachments(e) {
    const atts = e.attachments || [];
    if (!atts.length) return '';
    const imgs = atts.filter(a => a.type === 'image');
    const others = atts.filter(a => a.type !== 'image');
    let out = '<div class="attachments">';

    if (imgs.length) {
      const single = imgs.length === 1;
      out += `<div class="att-grid">`;
      for (const a of imgs) {
        const u = await mediaURL(a.mediaId);
        out += `<div class="att-img${single ? ' single' : ''}" data-act="view" data-mid="${a.mediaId}">
          ${u ? `<img src="${u}" alt="" loading="lazy">` : '<div class="att-empty">照片待同步</div>'}
          ${S.editing ? `<button class="att-del" data-act="delAtt" data-aid="${a.id}">×</button>` : ''}
        </div>`;
      }
      out += `</div>`;
    }

    for (const a of others) {
      const u = await mediaURL(a.mediaId);
      if (a.type === 'video') {
        out += `<div class="att-video" style="position:relative">
          ${u ? `<video controls playsinline preload="metadata" src="${u}"></video>` : '<div class="att-empty" style="padding:24px">视频待同步</div>'}
          ${S.editing ? `<button class="att-del" data-act="delAtt" data-aid="${a.id}">×</button>` : ''}
        </div>`;
      } else if (a.type === 'audio') {
        out += `<div class="att-audio">
          <span class="at-label">录音 ${a.dur ? Math.round(a.dur) + '″' : ''}</span>
          ${u ? `<audio controls preload="metadata" src="${u}"></audio>` : '<span style="font-size:12px;color:var(--ink-3)">待同步</span>'}
          ${S.editing ? `<button class="att-del" data-act="delAtt" data-aid="${a.id}">×</button>` : ''}
        </div>`;
      } else if (a.type === 'pdf') {
        out += `<div class="att-file" data-act="openPdf" data-mid="${a.mediaId}" style="position:relative">
          <div class="af-ico pdf">PDF</div>
          <div class="af-meta">
            <div class="af-name">${escapeHtml(a.name || '文档.pdf')}</div>
            <div class="af-sub">${a.size ? fmtBytes(a.size) : ''} · 点击查阅</div>
          </div>
          ${S.editing ? `<button class="att-del" data-act="delAtt" data-aid="${a.id}">×</button>` : ''}
        </div>`;
      } else if (a.type === 'html') {
        const m = await Store.getMedia(a.mediaId);
        let src = '';
        if (m && m.blob) { try { src = await m.blob.text(); } catch (err) { src = ''; } }
        out += `<div class="att-html" style="position:relative">
          <div class="ah-bar">
            <span>${escapeHtml(a.name || '页面')}</span>
            <button data-act="fullHtml" data-mid="${a.mediaId}" style="font-size:11.5px;color:var(--accent)">全屏 ↗</button>
          </div>
          ${src
            ? `<iframe sandbox="allow-scripts allow-popups allow-forms" srcdoc="${escapeHtml(src)}"></iframe>`
            : '<div class="att-empty" style="padding:30px">页面待同步</div>'}
          ${S.editing ? `<button class="att-del" data-act="delAtt" data-aid="${a.id}">×</button>` : ''}
        </div>`;
      } else {
        out += `<div class="att-file" style="position:relative">
          <div class="af-ico">FILE</div>
          <div class="af-meta">
            <div class="af-name">${escapeHtml(a.name || '附件')}</div>
            <div class="af-sub">${a.size ? fmtBytes(a.size) : ''}</div>
          </div>
        </div>`;
      }
    }
    out += '</div>';
    return out;
  }

  async function mediaURL(mid) {
    let u = await Store.mediaUrl(mid);
    if (u) return u;
    if (Sync.configured) {
      const m = await Sync.ensureMedia(mid);
      if (m && m.blob) return URL.createObjectURL(m.blob);
    }
    return '';
  }

  /* ══════════ 编辑 ══════════ */
  async function enterEdit() {
    if (!S.entries.length) return;
    if (S.editing) return;
    S.editing = true;
    const html = await renderSheet(S.entries[S.idx]);
    Flip.setPage(html);
    const sheet = $('#leafFront .sheet');
    if (!sheet) return;
    const title = sheet.querySelector('.sh-title');
    const body = sheet.querySelector('.sh-body');
    title.setAttribute('contenteditable', 'true');
    body.setAttribute('contenteditable', 'true');
    $('#writerBar').hidden = false;
    updatePager();
    syncMetaChips();
    readMetaFromDom();
    (body.textContent.trim() ? body : title).focus();
    Sound.tap();
    markDirty();
  }

  async function exitEdit() {
    if (!S.editing) return;
    await saveNow();
    S.editing = false;
    $('#writerBar').hidden = true;
    const e = S.entries[S.idx];
    const html = await renderSheet(e);
    htmlCache.set(S.idx, html);
    Flip.setPage(html);
    await warmCache();
    updatePager();
    Sound.tap();
  }

  function markDirty() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 900);
  }

  async function saveNow() {
    if (!S.editing) return;
    const sheet = $('#leafFront .sheet');
    if (!sheet) return;
    const e = S.entries[S.idx];
    if (!e) return;
    const t = sheet.querySelector('.sh-title');
    const b = sheet.querySelector('.sh-body');
    const newTitle = (t.innerText || '').replace(/\n+/g, ' ').trim();
    const newBody = sanitize(b.innerHTML);
    if (newTitle === (e.title || '') && newBody === (e.body || '')) return;
    e.title = newTitle;
    e.body = newBody;
    await Store.putEntry(e);
    htmlCache.delete(S.idx);
    await refreshAll();
    updateSub();
  }

  function readMetaFromDom() {
    const sheet = $('#leafFront .sheet');
    if (!sheet) return;
    const bodyEl = sheet.querySelector('.sh-body');
    if (bodyEl) {
      bodyEl.addEventListener('input', markDirty);
      bodyEl.addEventListener('blur', saveNow);
    }
    const titleEl = sheet.querySelector('.sh-title');
    if (titleEl) {
      titleEl.addEventListener('input', markDirty);
      titleEl.addEventListener('blur', saveNow);
      titleEl.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') { ev.preventDefault(); sheet.querySelector('.sh-body').focus(); }
      });
    }
  }

  async function newEntry(bookId, dayOverride) {
    const bid = bookId || S.bookId || (S.books[0] && S.books[0].id);
    const now = Date.now();
    const e = {
      id: uid(),
      bookId: bid,
      day: dayOverride || dayKey(now),
      ts: now,
      title: '',
      body: '',
      attachments: [],
      tags: [],
      mood: '',
      weather: '',
      starred: 0,
      createdAt: now,
      updatedAt: now
    };
    await Store.putEntry(e);
    await refreshAll();
    S.bookId = bid;
    S.entries = (await Store.listEntries({ bookId: bid })).slice().reverse();
    S.idx = S.entries.findIndex(x => x.id === e.id);
    if (S.idx < 0) S.idx = S.entries.length - 1;
    htmlCache.clear();
    setView('reader');
    await ensureFlip();
    await renderCurrent(true);
    await enterEdit();
    return e;
  }

  async function openEntry(entry) {
    if (S.editing) { S.editing = false; $('#writerBar').hidden = true; }
    await refreshAll();
    S.bookId = entry.bookId;
    S.entries = (await Store.listEntries({ bookId: entry.bookId })).slice().reverse();
    S.idx = S.entries.findIndex(x => x.id === entry.id);
    if (S.idx < 0) S.idx = 0;
    htmlCache.clear();
    setView('reader');
    await ensureFlip();
    await renderCurrent(true);
  }

  /* ══════════ 附件添加 ══════════ */
  const ACCEPT = {
    image: 'image/*',
    video: 'video/*',
    audio: 'audio/*',
    pdf: '.pdf,application/pdf',
    html: '.html,.htm,text/html'
  };

  let pendingType = null;
  function pickFiles(type) {
    if (!S.editing) return;
    pendingType = type;
    const fp = $('#filePicker');
    fp.accept = ACCEPT[type] || '*/*';
    fp.value = '';
    fp.click();
  }

  async function handleFiles(files) {
    if (!S.editing || !files.length) return;
    const e = S.entries[S.idx];
    if (!e) return;
    toast('正在处理…');
    for (const f of files) {
      try {
        const rec = await Store.putMedia(f);
        let type = pendingType || 'file';
        if (f.type.startsWith('image/')) type = 'image';
        else if (f.type.startsWith('video/')) type = 'video';
        else if (f.type.startsWith('audio/')) type = 'audio';
        else if (/pdf/i.test(f.type) || /\.pdf$/i.test(f.name)) type = 'pdf';
        else if (/html/i.test(f.type) || /\.html?$/i.test(f.name)) type = 'html';
        e.attachments.push({
          id: uid(), type, mediaId: rec.id,
          name: f.name, size: f.size
        });
      } catch (err) {
        console.warn(err);
        toast('这个文件读取失败：' + f.name);
      }
    }
    await Store.putEntry(e);
    htmlCache.delete(S.idx);
    await refreshAll();
    const html = await renderSheet(e);
    Flip.setPage(html);
    const sheet = $('#leafFront .sheet');
    if (sheet) {
      sheet.querySelector('.sh-title').setAttribute('contenteditable', 'true');
      sheet.querySelector('.sh-body').setAttribute('contenteditable', 'true');
      readMetaFromDom();
    }
    toast('已添加到这一页');
  }

  async function delAttachment(aid) {
    const e = S.entries[S.idx];
    if (!e) return;
    const i = e.attachments.findIndex(a => a.id === aid);
    if (i < 0) return;
    const mid = e.attachments[i].mediaId;
    e.attachments.splice(i, 1);
    await Store.putEntry(e);
    await Store.gcMedia(mid);
    htmlCache.delete(S.idx);
    const html = await renderSheet(e);
    Flip.setPage(html);
    const sheet = $('#leafFront .sheet');
    if (sheet) {
      sheet.querySelector('.sh-title').setAttribute('contenteditable', 'true');
      sheet.querySelector('.sh-body').setAttribute('contenteditable', 'true');
      readMetaFromDom();
    }
    toast('已移除');
  }

  /* ══════════ 时间轴 ══════════ */
  function renderTimeline() {
    const box = $('#timeline');
    box.innerHTML = '';
    if (!S.all.length) {
      box.innerHTML = `<div class="sheet-empty" style="padding:60px 20px">
        <div class="se-ico">✎</div><div class="se-text">还没有记录</div></div>`;
      return;
    }
    let lastYear = null;
    S.all.forEach((e, i) => {
      const y = e.day.slice(0, 4);
      if (y !== lastYear) {
        lastYear = y;
        const h = document.createElement('div');
        h.className = 'tl-year';
        h.textContent = y;
        box.appendChild(h);
      }
      const d = new Date(e.ts);
      const el = document.createElement('div');
      el.className = 'tl-item';
      el.style.animationDelay = `${Math.min(i, 12) * 30}ms`;
      const badges = [];
      if (e.attachments && e.attachments.length) badges.push(`${e.attachments.length} 个附件`);
      (e.tags || []).forEach(t => badges.push('#' + t));
      el.innerHTML = `<div class="tl-card">
        <div class="tl-top">
          <span class="tl-date">${d.getMonth() + 1} 月 ${d.getDate()} 日</span>
          <span class="tl-time">${fmtTime(e.ts)}</span>
          <span class="tl-mood">${e.mood || ''}</span>
        </div>
        <div class="tl-title">${escapeHtml(e.title || '无题')}</div>
        <div class="tl-excerpt">${escapeHtml(excerpt(e.body, 110)) || '（只有附件）'}</div>
        ${badges.length ? `<div class="tl-badges">${badges.map(b => `<span class="tl-badge">${escapeHtml(b)}</span>`).join('')}</div>` : ''}
      </div>`;
      el.onclick = () => openEntry(e);
      box.appendChild(el);
    });
  }

  /* ══════════ 日历 ══════════ */
  function renderCalendar() {
    const y = S.calY, m = S.calM;
    $('#calLabel').textContent = `${y} 年 ${m + 1} 月`;
    const week = $('#calWeek');
    week.innerHTML = ['日', '一', '二', '三', '四', '五', '六']
      .map(d => `<span>${d}</span>`).join('');

    const days = new Set(S.all.map(e => e.day));
    const first = new Date(y, m, 1);
    const startPad = first.getDay();
    const total = new Date(y, m + 1, 0).getDate();
    const today = dayKey(Date.now());

    const grid = $('#calGrid');
    grid.innerHTML = '';
    for (let i = 0; i < startPad; i++) {
      const c = document.createElement('div');
      c.className = 'cal-cell pad';
      grid.appendChild(c);
    }
    for (let d = 1; d <= total; d++) {
      const key = `${y}-${pad(m + 1)}-${pad(d)}`;
      const c = document.createElement('div');
      c.className = 'cal-cell';
      if (days.has(key)) c.classList.add('has');
      if (key === today) c.classList.add('today');
      c.innerHTML = `<span>${d}</span>`;
      if (days.has(key)) {
        const hit = S.all.find(e => e.day === key);
        if (hit && hit.mood) {
          const mo = document.createElement('span');
          mo.className = 'cc-mood';
          mo.textContent = hit.mood;
          c.appendChild(mo);
        }
        c.onclick = () => {
          const all = S.all.filter(e => e.day === key);
          if (all.length === 1) openEntry(all[0]);
          else pickOption(`那天有 ${all.length} 篇`, all.map(e => ({
            label: (e.title || excerpt(e.body, 8) || '无题').slice(0, 8),
            value: e
          }))).then(v => v && openEntry(v));
        };
      }
      grid.appendChild(c);
    }
    const st = calcStreak(S.all);
    $('#calStreak').textContent = st ? `连续 ${st} 天` : '';
  }

  /* ══════════ 相册 ══════════ */
  async function renderGallery() {
    const box = $('#gallery');
    box.innerHTML = '';
    const items = [];
    for (const e of S.all) {
      for (const a of (e.attachments || [])) {
        if (a.type === 'image' || a.type === 'video') items.push({ a, e });
      }
    }
    if (!items.length) {
      box.innerHTML = `<div class="sheet-empty" style="grid-column:1/-1;padding:60px 20px">
        <div class="se-ico">▣</div><div class="se-text">还没有照片<br>在日记里添加照片后会出现在这里</div></div>`;
      return;
    }
    box.style.columns = '';
    for (const { a, e } of items) {
      const u = await mediaURL(a.mediaId);
      if (!u) continue;
      const el = document.createElement('div');
      el.className = 'gal-item' + (a.type === 'video' ? ' vid' : '');
      const d = new Date(e.ts);
      el.innerHTML = `${a.type === 'video' ? `<video src="${u}" muted preload="metadata"></video>` : `<img src="${u}" loading="lazy" alt="">`}
        <span class="gi-date">${d.getMonth() + 1}.${d.getDate()}</span>`;
      el.onclick = () => openViewer(a);
      box.appendChild(el);
    }
  }

  /* ══════════ 搜索 ══════════ */
  function renderSearch() {
    const q = S.searchQ.trim().toLowerCase();
    const tag = S.searchTag;

    // 标签云
    const counts = {};
    S.all.forEach(e => (e.tags || []).forEach(t => counts[t] = (counts[t] || 0) + 1));
    const cloud = $('#tagCloud');
    cloud.innerHTML = Object.keys(counts)
      .sort((a, b) => counts[b] - counts[a])
      .slice(0, 14)
      .map(t => `<button class="tag-chip${t === tag ? ' on' : ''}" data-tag="${escapeHtml(t)}">#${escapeHtml(t)} <span style="opacity:.5">${counts[t]}</span></button>`)
      .join('');

    const box = $('#searchResult');
    if (!q && !tag) {
      box.innerHTML = `<div class="sheet-empty" style="padding:40px 20px">
        <div class="se-text">输入关键词，或点上方标签</div></div>`;
      return;
    }

    const hits = S.all.filter(e => {
      if (tag && !(e.tags || []).includes(tag)) return false;
      if (!q) return true;
      const hay = [e.title, excerpt(e.body, 5000), (e.tags || []).join(' '), e.mood, e.weather]
        .join(' ').toLowerCase();
      return hay.includes(q);
    });

    if (!hits.length) {
      box.innerHTML = `<div class="sheet-empty" style="padding:40px 20px"><div class="se-text">没有找到相关记录</div></div>`;
      return;
    }

    box.innerHTML = '';
    hits.forEach(e => {
      const d = new Date(e.ts);
      let text = excerpt(e.body, 100);
      if (q) {
        const tmp = document.createElement('div');
        tmp.innerHTML = e.body || '';
        const raw = tmp.textContent || '';
        const p = raw.toLowerCase().indexOf(q);
        if (p >= 0) text = raw.slice(Math.max(0, p - 26), p + 74);
        text = escapeHtml(text);
      } else {
        text = escapeHtml(text);
      }
      let hl = text;
      if (q) {
        const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
        hl = text.replace(re, m => `<mark>${m}</mark>`);
      }
      const el = document.createElement('div');
      el.className = 'sr-item';
      el.innerHTML = `<div class="sr-date">${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日 · ${fmtTime(e.ts)}</div>
        <div class="sr-title">${escapeHtml(e.title || '无题')}</div>
        <div class="sr-text">${hl}…</div>`;
      el.onclick = () => openEntry(e);
      box.appendChild(el);
    });
  }

  /* ══════════ 查看器 ══════════ */
  async function openViewer(a) {
    const u = await mediaURL(a.mediaId);
    if (!u) { toast('附件还没有同步下来'); return; }
    const v = $('#viewer');
    const body = $('#viewerBody');
    body.innerHTML = a.type === 'video'
      ? `<video src="${u}" controls autoplay playsinline></video>`
      : `<img src="${u}" alt="">`;
    v.hidden = false;
  }

  async function openPdf(mid) {
    const u = await mediaURL(mid);
    if (!u) { toast('文件还没有同步下来'); return; }
    const v = $('#viewer');
    $('#viewerBody').innerHTML = `<iframe src="${u}" style="background:#fff"></iframe>`;
    v.hidden = false;
  }

  async function openHtmlFull(mid) {
    const m = await Store.getMedia(mid);
    if (!m || !m.blob) { toast('页面还没有同步下来'); return; }
    const txt = await m.blob.text();
    const v = $('#viewer');
    const iframe = document.createElement('iframe');
    iframe.setAttribute('sandbox', 'allow-scripts allow-popups allow-forms');
    iframe.srcdoc = txt;
    $('#viewerBody').innerHTML = '';
    $('#viewerBody').appendChild(iframe);
    v.hidden = false;
  }

  /* ══════════ 同步 ══════════ */
  async function doSync(silent) {
    const state = $('#syncState');
    if (!Sync.configured) {
      if (!silent) toast('请先在设置里填写 WebDAV 信息');
      return;
    }
    try {
      state.className = 'sync-state';
      state.textContent = '正在同步…';
      const st = await Sync.run(msg => { state.textContent = msg; });
      state.className = 'sync-state ok';
      state.textContent = `同步完成 · 拉取 ${st.pulled} 篇，上传 ${st.pushed} 篇，附件 ${st.mediaUp} 个` +
        (st.conflicts ? ` · ${st.conflicts} 处冲突已另存副本` : '') +
        `\n${fmtFull(st.at)} ${fmtTime(st.at)}`;
      await Store.setMeta('lastSync', st.at);
      await refreshAll();
      if (S.view === 'shelf') renderShelf();
      if (S.view === 'reader') { htmlCache.clear(); await renderCurrent(false); }
      if (!silent) toast('同步完成');
    } catch (e) {
      state.className = 'sync-state err';
      state.textContent = '同步失败：' + (e.message || e);
      if (!silent) toast('同步失败：' + (e.message || e).slice(0, 40));
    }
  }

  /* ══════════ 导出 ══════════ */
  function download(name, text, type) {
    const blob = new Blob([text], { type: type || 'text/plain;charset=utf-8' });
    const u = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = u; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(u), 3000);
  }

  async function exportJSON() {
    const d = await Store.dump();
    download(`纸间备份-${dayKey()}.json`, JSON.stringify(d, null, 2), 'application/json');
    toast('已导出 JSON（附件实体不含在内）');
  }

  async function exportMd() {
    const list = S.all.slice().reverse();
    let out = `# 纸间 · 日记导出\n\n导出时间：${fmtFull(Date.now())}\n共 ${list.length} 篇\n\n---\n\n`;
    for (const e of list) {
      const d = new Date(e.ts);
      out += `## ${e.day} ${WEEK[d.getDay()]} ${e.title || ''}\n\n`;
      const tmp = document.createElement('div');
      tmp.innerHTML = e.body || '';
      out += (tmp.textContent || '').trim() + '\n\n';
      if ((e.attachments || []).length) {
        out += `> 附件 ${e.attachments.length} 个：` +
          e.attachments.map(a => a.name || a.type).join('、') + '\n\n';
      }
      if ((e.tags || []).length) out += `标签：${e.tags.map(t => '#' + t).join(' ')}\n\n`;
      out += '---\n\n';
    }
    download(`纸间日记-${dayKey()}.md`, out, 'text/markdown;charset=utf-8');
    toast('已导出 Markdown');
  }

  /* ══════════ 锁屏 ══════════ */
  let pinBuf = '';
  let savedPin = '';

  function showLock(pin) {
    savedPin = pin;
    pinBuf = '';
    $('#lock').hidden = false;
    $('#lock').dataset.mode = 'unlock';
    $('#lock .lock-sub').textContent = '输入 4 位密码';
    buildPad('unlock');
    paintDots();
  }

  function buildPad(mode) {
    const pad = $('#lockPad');
    pad.innerHTML = '';
    const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '⌫'];
    keys.forEach(k => {
      const b = document.createElement('button');
      if (!k) { b.className = 'blank'; b.textContent = ''; }
      else {
        b.textContent = k;
        b.onclick = () => {
          Sound.tap();
          if (k === '⌫') { pinBuf = pinBuf.slice(0, -1); }
          else if (pinBuf.length < 4) pinBuf += k;
          paintDots();
          if (pinBuf.length === 4) setTimeout(() => checkPin(mode), 140);
        };
      }
      pad.appendChild(b);
    });
  }

  function paintDots() {
    $$('#lockDots i').forEach((d, i) => d.classList.toggle('on', i < pinBuf.length));
  }

  async function checkPin(mode) {
    if (mode === 'unlock') {
      if (pinBuf === savedPin) {
        $('#lock').hidden = true;
        pinBuf = '';
        toast('欢迎回来');
      } else {
        $('#lockDots').classList.add('shake');
        setTimeout(() => $('#lockDots').classList.remove('shake'), 420);
        pinBuf = '';
        paintDots();
      }
    } else {
      // 设置新密码：第一遍
      if (!window.__pinFirst) {
        window.__pinFirst = pinBuf;
        pinBuf = '';
        paintDots();
        $('#lock .lock-sub').textContent = '再输入一次确认';
      } else {
        if (window.__pinFirst === pinBuf) {
          await Store.setMeta('pin', pinBuf);
          $('#lock').hidden = true;
          toast('密码已设置');
        } else {
          toast('两次输入不一致，重来');
          $('#lock .lock-sub').textContent = '输入 4 位密码';
        }
        window.__pinFirst = null;
        pinBuf = '';
        paintDots();
      }
    }
  }

  /* ══════════ 事件绑定 ══════════ */
  function bindGlobal() {
    // 底部导航
    $$('.tab').forEach(t => t.onclick = () => {
      Sound.tap();
      if (S.editing) exitEdit();
      setView(t.dataset.tab);
    });

    $('#btnBack').onclick = () => {
      if (S.editing) { exitEdit(); return; }
      if (S.view === 'search') { $('#searchInput').value = ''; S.searchQ = ''; S.searchTag = ''; setView('shelf'); return; }
      setView('shelf');
    };
    $('#btnSearch').onclick = () => setView('search');
    $('#btnTheme').onclick = cycleTheme;
    $('#btnSettings').onclick = openDrawer;

    // 书架操作
    $('#btnNewBook').onclick = () => { Sound.unlock(); createBook(); };
    $('#btnBookMore').onclick = renameBook;
    $('#btnBookDel').onclick = deleteBook;

    // 导入：PDF → 一本新日记；HTML → 一篇新日记
    const startImport = () => {
      Sound.unlock();
      PJ.Importer.onFile = (file) => {
        PJ.Importer.importFiles(file, {
          nextCover: S.books.length,
          bookId: S.bookId || (S.books[0] && S.books[0].id)
        }).then(async (r) => {
          if (r.type === 'book') {
            await refreshAll();
            shelfIndex = Math.max(0, S.books.findIndex(b => b.id === r.bookId));
            renderShelf();
            toast(`已导入《${r.title}》· ${r.pages} 页`);
            await openBook(r.bookId);
          } else {
            await refreshAll();
            toast(`已导入为日记《${(r.entry.title || '网页').slice(0, 12)}》`);
            await openEntry(r.entry);
          }
        }).catch((e) => {
          console.warn('import fail', e);
          toast('导入失败：' + (e.message || e).slice(0, 60));
        });
      };
      PJ.Importer.pickImport();
    };
    $('#btnImport').onclick = startImport;
    $('#btnImportSetting').onclick = startImport;

    // 书架：滚轮 / 横向拖拽切换
    let wheelAt = 0;
    const stage = $('#viewShelf');
    stage.addEventListener('wheel', (ev) => {
      if (S.view !== 'shelf' || S.books.length < 2) return;
      const d = Math.abs(ev.deltaX) > Math.abs(ev.deltaY) ? ev.deltaX : ev.deltaY;
      if (Math.abs(d) < 24) return;
      const now = Date.now();
      if (now - wheelAt < 220) return;
      wheelAt = now;
      focusBook(shelfIndex + (d > 0 ? 1 : -1));
    }, { passive: true });

    let dragX = 0, dragging = false, moved2 = false;
    stage.addEventListener('pointerdown', (ev) => {
      if (S.view !== 'shelf') return;
      dragging = true; moved2 = false; dragX = ev.clientX;
    });
    window.addEventListener('pointermove', (ev) => {
      if (!dragging) return;
      if (Math.abs(ev.clientX - dragX) > 12) moved2 = true;
    });
    window.addEventListener('pointerup', (ev) => {
      if (!dragging) return;
      dragging = false;
      if (!moved2) return;
      lastShelfDrag = Date.now();
      const dx = ev.clientX - dragX;
      if (Math.abs(dx) < 56) return;
      focusBook(shelfIndex + (dx < 0 ? 1 : -1));
    });

    $('#btnPrev').onclick = goPrev;
    $('#btnNext').onclick = goNext;

    // 点击纸张左右边缘翻页（Paper 式，无按钮也能翻）
    const edgeGuard = (fn) => () => {
      if (Flip && performance.now() - (Flip.lastInteract || 0) < 420) return;
      fn();
    };
    $('#edgePrev').onclick = edgeGuard(goPrev);
    $('#edgeNext').onclick = edgeGuard(goNext);
    $('#corner').onclick = edgeGuard(goNext);
    $('#bookCover').onclick = () => openCover(true);

    $('#fabNew').onclick = () => {
      Sound.unlock(); Sound.tap();
      newEntry(S.bookId || (S.books[0] && S.books[0].id));
    };

    // 页面交互（事件委托）
    $('#leafFront').addEventListener('click', onSheetClick);
    $('#leafFront').addEventListener('dblclick', (ev) => {
      if (S.editing) return;
      if (ev.target.closest('[data-act]')) return;
      enterEdit();
    });

    // 点击正文进入编辑
    $('#book').addEventListener('click', (ev) => {
      if (S.editing) return;
      const body = ev.target.closest('.sh-body, .sh-title');
      if (!body) return;
      if (ev.target.closest('a')) return;
      enterEdit();
    });

    // 键盘
    document.addEventListener('keydown', (ev) => {
      if (!$('#lock').hidden) return;
      if (S.view !== 'reader') {
        if (ev.key === '/' && (ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); setView('search'); }
        if (S.view === 'shelf' && !ev.target.isContentEditable) {
          if (ev.key === 'ArrowLeft') { ev.preventDefault(); focusBook(shelfIndex - 1); }
          if (ev.key === 'ArrowRight') { ev.preventDefault(); focusBook(shelfIndex + 1); }
          if (ev.key === 'Enter' && S.books[shelfIndex]) {
            ev.preventDefault(); openBook(S.books[shelfIndex].id);
          }
        }
        return;
      }
      const tag = (ev.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || ev.target.isContentEditable) {
        if (ev.key === 'Escape' && S.editing) { ev.target.blur(); exitEdit(); }
        return;
      }
      if (ev.key === 'ArrowLeft') { ev.preventDefault(); goPrev(); }
      if (ev.key === 'ArrowRight') { ev.preventDefault(); goNext(); }
      if (ev.key === 'e' || ev.key === 'Enter') { ev.preventDefault(); enterEdit(); }
      if (ev.key === 'Escape') { if (S.editing) exitEdit(); else setView('shelf'); }
      if (ev.key === 'n' || ev.key === 'N') { ev.preventDefault(); newEntry(S.bookId); }
    });

    // 工具条
    $$('#writerBar [data-md]').forEach(b => b.onclick = () => applyMd(b.dataset.md));
    $$('#writerBar [data-add]').forEach(b => b.onclick = () => pickFiles(b.dataset.add));
    $('#wbDone').onclick = exitEdit;
    $('#wbMood').onclick = setMood;
    $('#wbWeather').onclick = setWeather;
    $('#wbTag').onclick = setTags;
    $('#wbStar').onclick = toggleStar;

    // 文件
    $('#filePicker').addEventListener('change', (ev) => {
      handleFiles(Array.from(ev.target.files || []));
    });

    // 设置
    bindSettings();

    // 查看器
    $('#viewerClose').onclick = () => {
      $('#viewer').hidden = true;
      $('#viewerBody').innerHTML = '';
    };
    $('#viewer').addEventListener('click', (ev) => {
      if (ev.target.id === 'viewer') {
        $('#viewer').hidden = true;
        $('#viewerBody').innerHTML = '';
      }
    });

    // 搜索
    $('#searchInput').addEventListener('input', debounce((ev) => {
      S.searchQ = ev.target.value;
      $('#searchClear').hidden = !ev.target.value;
      renderSearch();
    }, 140));
    $('#searchClear').onclick = () => {
      $('#searchInput').value = ''; S.searchQ = ''; S.searchTag = '';
      $('#searchClear').hidden = true; renderSearch();
    };
    $('#tagCloud').addEventListener('click', (ev) => {
      const c = ev.target.closest('[data-tag]');
      if (!c) return;
      S.searchTag = S.searchTag === c.dataset.tag ? '' : c.dataset.tag;
      renderSearch();
    });

    // 日历翻月
    $('#calPrev').onclick = () => {
      S.calM--; if (S.calM < 0) { S.calM = 11; S.calY--; }
      renderCalendar();
    };
    $('#calNext').onclick = () => {
      S.calM++; if (S.calM > 11) { S.calM = 0; S.calY++; }
      renderCalendar();
    };

    // Android 返回键
    window.addEventListener('pj-back', () => {
      if (S.editing) { exitEdit(); return; }
      if (S.view === 'search') {
        $('#searchInput').value = ''; S.searchQ = ''; S.searchTag = '';
        renderSearch();
      }
      if (S.view !== 'shelf') setView('shelf');
    });

    // 拖拽文件到页面导入（仅编辑态）
    let dragDepth = 0;
    document.addEventListener('dragenter', (e) => {
      if (S.editing && S.view === 'reader' &&
          e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')) {
        dragDepth++;
        $('#dropzone').hidden = false;
      }
    });
    document.addEventListener('dragleave', () => {
      if (--dragDepth <= 0) { dragDepth = 0; $('#dropzone').hidden = true; }
    });
    document.addEventListener('dragover', (e) => e.preventDefault());
    document.addEventListener('drop', (e) => {
      e.preventDefault();
      dragDepth = 0; $('#dropzone').hidden = true;
      const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
      if (!files.length) return;
      if (S.editing && S.view === 'reader') {
        handleFiles(files);
      } else {
        toast('先点开一篇日记进入书写，再把文件拖进来');
      }
    });

    // 粘贴截图直接进这一页
    document.addEventListener('paste', (e) => {
      if (!S.editing || S.view !== 'reader') return;
      const files = Array.from((e.clipboardData && e.clipboardData.files) || []);
      const imgs = files.filter(f => f.type && f.type.startsWith('image/'));
      if (imgs.length) {
        e.preventDefault();
        handleFiles(imgs);
        toast('截图已放进这一页');
      }
    });

    // 图片/视频加载完成后渐显（load 事件不冒泡，用捕获）
    document.addEventListener('load', (e) => {
      const t = e.target;
      if (t && (t.tagName === 'IMG' || t.tagName === 'VIDEO') &&
          (t.closest('.attachments') || t.closest('.gallery'))) {
        t.classList.add('loaded');
      }
    }, true);

    // 解锁音频（首次交互）
    const unlock = () => { Sound.unlock(); document.removeEventListener('pointerdown', unlock); };
    document.addEventListener('pointerdown', unlock);

    // 窗口尺寸变化重渲染当前页（避免布局错位）
    let rt;
    window.addEventListener('resize', () => {
      clearTimeout(rt);
      rt = setTimeout(async () => {
        if (S.view === 'shelf') { layoutFlow(); return; }
        if (S.view !== 'reader') return;
        htmlCache.clear();
        await renderCurrent(false);
      }, 260);
    });
  }

  function onSheetClick(ev) {
    const act = ev.target.closest('[data-act]');
    if (!act) return;
    const a = act.dataset.act;
    if (a === 'view') openViewer({ mediaId: act.dataset.mid, type: 'image' });
    if (a === 'openPdf') openPdf(act.dataset.mid);
    if (a === 'fullHtml') openHtmlFull(act.dataset.mid);
    if (a === 'delAtt') { ev.stopPropagation(); delAttachment(act.dataset.aid); }
    if (a === 'newEntry') newEntry(S.bookId);
  }

  /* ══════════ 富文本操作 ══════════ */
  function applyMd(kind) {
    const body = $('#leafFront .sh-body');
    if (!body) return;
    body.focus();
    const sel = window.getSelection();
    if (!sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    if (!body.contains(range.commonAncestorContainer)) return;
    if (range.collapsed && kind !== 'ul' && kind !== 'h2' && kind !== 'quote') {
      // 空选区不做处理
    }
    const cmds = { bold: 'bold', italic: 'italic' };
    if (cmds[kind]) {
      document.execCommand(cmds[kind]);
    } else if (kind === 'h2') {
      document.execCommand('formatBlock', false, '<h2>');
    } else if (kind === 'quote') {
      document.execCommand('formatBlock', false, '<blockquote>');
    } else if (kind === 'ul') {
      document.execCommand('insertUnorderedList');
    }
    markDirty();
  }

  function syncMetaChips() {
    const e = S.entries[S.idx];
    if (!e) return;
    $('#wbMood').textContent = e.mood || '心情';
    $('#wbMood').classList.toggle('on', !!e.mood);
    $('#wbWeather').textContent = e.weather || '天气';
    $('#wbWeather').classList.toggle('on', !!e.weather);
    $('#wbTag').textContent = (e.tags && e.tags.length) ? `#${e.tags[0]}${e.tags.length > 1 ? '+' + (e.tags.length - 1) : ''}` : '标签';
    $('#wbTag').classList.toggle('on', !!(e.tags && e.tags.length));
    $('#wbStar').classList.toggle('on', !!e.starred);
  }

  async function setMood() {
    const v = await pickOption('今天的心情', MOODS.map(m => ({ label: m, value: m })));
    if (v === null) return;
    const e = S.entries[S.idx];
    e.mood = v; await Store.putEntry(e);
    await refreshAfterMeta();
  }

  async function setWeather() {
    const v = await pickOption('天气', WEATHER.map(m => ({ label: m, value: m })));
    if (v === null) return;
    const e = S.entries[S.idx];
    e.weather = v; await Store.putEntry(e);
    await refreshAfterMeta();
  }

  async function setTags() {
    const e = S.entries[S.idx];
    const cur = (e.tags || []).join(', ');
    const v = await promptText('标签（用逗号分隔）', cur, '旅行, 随笔');
    if (v === null) return;
    e.tags = v.split(/[,，\s]+/).map(s => s.trim()).filter(Boolean).slice(0, 12);
    await Store.putEntry(e);
    await refreshAfterMeta();
  }

  async function toggleStar() {
    const e = S.entries[S.idx];
    e.starred = e.starred ? 0 : 1;
    await Store.putEntry(e);
    await refreshAfterMeta();
  }

  async function refreshAfterMeta() {
    const e = S.entries[S.idx];
    htmlCache.delete(S.idx);
    await refreshAll();
    const html = await renderSheet(e);
    Flip.setPage(html);
    const sheet = $('#leafFront .sheet');
    if (sheet) {
      sheet.querySelector('.sh-title').setAttribute('contenteditable', 'true');
      sheet.querySelector('.sh-body').setAttribute('contenteditable', 'true');
      readMetaFromDom();
    }
    syncMetaChips();
  }

  /* ══════════ 主题 ══════════ */
  function cycleTheme() {
    const order = ['paper', 'kraft', 'ink'];
    const i = order.indexOf(S.cfg.theme);
    S.cfg.theme = order[(i + 1) % order.length];
    Store.setMeta('theme', S.cfg.theme);
    applySettings();
    $$('#segTheme button').forEach(b => b.classList.toggle('on', b.dataset.v === S.cfg.theme));
    Sound.tap();
    toast({ paper: '米白纸', kraft: '牛皮纸', ink: '夜墨' }[S.cfg.theme]);
  }

  /* ══════════ 设置面板 ══════════ */
  function openDrawer() {
    $('#mask').hidden = false;
    $('#drawer').hidden = false;
    fillSettingsUI();
    loadStorageInfo();
  }
  function closeDrawer() {
    $('#mask').hidden = true;
    $('#drawer').hidden = true;
  }

  function fillSettingsUI() {
    $('#wdUrl').value = S.cfg.davUrl || '';
    $('#wdUser').value = S.cfg.davUser || '';
    $('#wdPass').value = S.cfg.davPass || '';
    $('#wdProxy').value = S.cfg.davProxy || '';
    $('#optSound').checked = !!S.cfg.sound;
    $('#optGrain').checked = !!S.cfg.grain;
    $('#optAutoSync').checked = !!S.cfg.autoSync;
    $$('#segTheme button').forEach(b => b.classList.toggle('on', b.dataset.v === S.cfg.theme));
    $$('#segFont button').forEach(b => b.classList.toggle('on', b.dataset.v === S.cfg.font));

    const st = $('#syncState');
    if (typeof window.PJDesktop !== 'undefined' && window.PJDesktop && window.PJDesktop.isDesktop) {
      st.className = 'sync-state ok';
      st.textContent = '桌面版 · 同步经主进程直连 WebDAV，无需代理';
    } else if (typeof window.PJNative !== 'undefined' && window.PJNative) {
      st.className = 'sync-state ok';
      st.textContent = '已启用原生通道（Android）· 直连 WebDAV，无需代理';
    } else if (!st.textContent || st.textContent === '') {
      st.textContent = '尚未同步';
    }
  }

  async function loadStorageInfo() {
    const est = await Store.storageEstimate();
    const el = $('#storageInfo');
    let txt = '';
    if (est) {
      txt = `本机数据已用 ${fmtBytes(est.usage)}`;
    }
    if (typeof window.PJDesktop !== 'undefined' && window.PJDesktop && window.PJDesktop.info) {
      try {
        const info = await window.PJDesktop.info();
        txt += `\n数据目录（随软件走）：${info.dataDir}`;
      } catch (e) { /* ignore */ }
    }
    el.textContent = txt;
  }

  function bindSettings() {
    $('#drawerClose').onclick = closeDrawer;
    $('#mask').onclick = closeDrawer;

    $$('#segTheme button').forEach(b => b.onclick = async () => {
      S.cfg.theme = b.dataset.v;
      await Store.setMeta('theme', S.cfg.theme);
      applySettings();
      $$('#segTheme button').forEach(x => x.classList.toggle('on', x === b));
    });

    $$('#segFont button').forEach(b => b.onclick = async () => {
      S.cfg.font = b.dataset.v;
      await Store.setMeta('font', S.cfg.font);
      applySettings();
      $$('#segFont button').forEach(x => x.classList.toggle('on', x === b));
      if (S.view === 'reader' && !S.editing) { htmlCache.clear(); renderCurrent(false); }
    });

    $('#optSound').onchange = async (e) => {
      S.cfg.sound = e.target.checked;
      Sound.enabled = S.cfg.sound;
      await Store.setMeta('sound', S.cfg.sound);
      if (S.cfg.sound) { Sound.unlock(); Sound.rustle({ strength: 0.6 }); }
    };

    $('#optGrain').onchange = async (e) => {
      S.cfg.grain = e.target.checked;
      await Store.setMeta('grain', S.cfg.grain);
      applySettings();
    };

    $('#optAutoSync').onchange = async (e) => {
      S.cfg.autoSync = e.target.checked;
      await Store.setMeta('autoSync', S.cfg.autoSync);
      if (S.cfg.autoSync) {
        if (!autoSyncTimer) autoSyncTimer = setInterval(() => doSync(true), 10 * 60 * 1000);
        doSync(true);
      }
    };

    const saveDav = debounce(async () => {
      S.cfg.davUrl = $('#wdUrl').value.trim();
      S.cfg.davUser = $('#wdUser').value.trim();
      S.cfg.davPass = $('#wdPass').value;
      S.cfg.davProxy = $('#wdProxy').value.trim();
      await Store.setMeta('davUrl', S.cfg.davUrl);
      await Store.setMeta('davUser', S.cfg.davUser);
      await Store.setMeta('davPass', S.cfg.davPass);
      await Store.setMeta('davProxy', S.cfg.davProxy);
      Sync.setConfig({ url: S.cfg.davUrl, user: S.cfg.davUser, pass: S.cfg.davPass, proxy: S.cfg.davProxy });
    }, 500);

    ['#wdUrl', '#wdUser', '#wdPass', '#wdProxy'].forEach(sel => {
      $(sel).addEventListener('input', saveDav);
    });

    $('#btnTestDav').onclick = async () => {
      await saveDav();
      const st = $('#syncState');
      st.className = 'sync-state';
      st.textContent = '测试中…';
      const r = await Sync.test();
      st.className = 'sync-state ' + (r.ok ? 'ok' : 'err');
      st.textContent = r.msg;
    };

    $('#btnSyncNow').onclick = async () => {
      await saveDav();
      Sound.unlock();
      await doSync(false);
      await refreshAll();
      if (S.view === 'shelf') renderShelf();
    };

    $('#btnPin').onclick = () => {
      window.__pinFirst = null;
      pinBuf = '';
      savedPin = '';
      $('#lock').hidden = false;
      $('#lock .lock-sub').textContent = '输入 4 位密码';
      buildPad('set');
      paintDots();
    };

    $('#btnExportJson').onclick = exportJSON;
    $('#btnExportMd').onclick = exportMd;

    $('#btnTrash').onclick = showTrash;
  }

  async function showTrash() {
    const all = await Store.listEntries({ includeDeleted: true });
    const dead = all.filter(e => e.deleted);
    if (!dead.length) { toast('回收站是空的'); return; }
    const v = await pickOption('回收站（30 天后自动清除）',
      dead.slice(0, 12).map(e => ({
        label: (e.title || excerpt(e.body, 8) || e.day).slice(0, 10),
        value: e
      })).concat([{ label: '清空', value: '__all__' }])
    );
    if (!v) return;
    if (v === '__all__') {
      for (const e of dead) await Store.purgeEntry(e.id);
      toast('回收站已清空');
    } else {
      await Store.restoreEntry(v.id);
      toast('已恢复');
    }
    await refreshAll();
    if (S.view === 'timeline') renderTimeline();
    if (S.view === 'shelf') renderShelf();
  }

  /* ── 启动 ── */
  window.addEventListener('DOMContentLoaded', () => {
    boot().catch(err => {
      console.error(err);
      document.body.innerHTML = `<pre style="padding:24px;font-size:13px;line-height:1.8;white-space:pre-wrap">启动失败：${escapeHtml(err.message)}

请用本地服务器打开（运行 start-windows.bat 或 node server.mjs），不要直接双击 index.html。
详细堆栈见浏览器控制台。</pre>`;
    });
  });

  // 暴露给调试
  window.__PJ = { S, get Flip() { return Flip; }, newEntry, openEntry };
})();
