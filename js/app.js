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

    if ('serviceWorker' in navigator &&
        (location.protocol.startsWith('http') || location.protocol === 'app:')) {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }

    // AI 桥（MCP 数据代理执行端）
    if (window.PJ && window.PJ.AI && window.PJ.AI.init) window.PJ.AI.init();
    window.addEventListener('pj-ai-ready', (ev) => {
      const st = $('#aiState');
      if (st) {
        const m = ev.detail && ev.detail.mode;
        st.className = 'sync-state ok';
        st.textContent = m === 'ipc'
          ? '桌面版 AI 桥已就绪（本机通道，MCP 可连接）'
          : m === 'sse'
            ? 'AI 桥已连接（网页模式，MCP 可连接）'
            : 'AI 桥未启用';
      }
    });
    // AI 写入数据后刷新界面
    window.addEventListener('pj-data-changed', debounce(async () => {
      await refreshAll();
      if (S.view === 'shelf') renderShelf();
      else if (S.view === 'timeline') renderTimeline();
      else if (S.view === 'calendar') renderCalendar();
      else if (S.view === 'gallery') renderGallery();
      else if (S.view === 'reader' && !S.editing) { htmlCache.clear(); await renderCurrent(false); }
      updateSub();
    }, 250));
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
    const fs = { s: '15.5px', m: '17.5px', l: '19.5px' }[S.cfg.font] || '17.5px';
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
    back.hidden = !(v === 'reader' || v === 'search' || v === 'raw');

    if (v === 'shelf') {
      // 离开网页书时释放 iframe
      const rf = $('#rawFrame');
      if (rf && rf.getAttribute('src') && rf.getAttribute('src') !== 'about:blank') {
        rf.src = 'about:blank';
      }
      $('#viewTitle').textContent = '纸间';
      renderShelf();
    }
    if (v === 'raw') {
      const b = S.rawBook;
      $('#viewTitle').textContent = b ? b.title : '网页书';
      $('#viewSub').textContent = b ? '网页书 · 原样' : '';
    }
    if (v === 'timeline') { $('#viewTitle').textContent = '时间轴'; renderTimeline(); }
    if (v === 'calendar') { $('#viewTitle').textContent = '日历'; renderCalendar(); }
    if (v === 'gallery') { $('#viewTitle').textContent = '相册'; renderGallery(); }
    if (v === 'search') { $('#viewTitle').textContent = '搜索'; setTimeout(() => $('#searchInput').focus(), 220); }
    syncEditBtn();
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
    'linear-gradient(150deg,#a9dcbc 0%,#7cbe95 44%,#4f9670 100%)',
    'linear-gradient(150deg,#b6d9c4 0%,#6aa87f 50%,#3f7a5b 100%)',
    'linear-gradient(150deg,#9ecdb2 0%,#63a482 48%,#457a5f 100%)',
    'linear-gradient(150deg,#c8d9b6 0%,#8fae74 50%,#5f7d4e 100%)',
    'linear-gradient(150deg,#a7c8be 0%,#6d9b91 50%,#47706a 100%)',
    'linear-gradient(150deg,#b8c9dc 0%,#7f9ab8 50%,#546c88 100%)'
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
      const isHtml = b.kind === 'html';
      const items = isHtml ? [] : S.all.filter(e => e.bookId === b.id);
      const el = document.createElement('div');
      el.className = 'flow-item';
      el.dataset.id = b.id;
      el.style.background = COVERS[(b.cover || i) % COVERS.length];
      el.innerHTML = `<i class="fi-shadow" aria-hidden="true"></i>
        <div class="fi-face">
          <i class="fi-spine" aria-hidden="true"></i>
          <b class="fi-frame" aria-hidden="true"></b>
          <i class="fi-leaf tl" aria-hidden="true">🍃</i>
          <i class="fi-leaf tr" aria-hidden="true">🌸</i>
          <i class="fi-leaf bl" aria-hidden="true">🌼</i>
          <i class="fi-leaf br" aria-hidden="true">🌿</i>
          <div class="fi-center">
            <div class="fi-name">${escapeHtml(b.title)}</div>
            <div class="fi-flower">✿ ❀ ✿</div>
            <div class="fi-range">${isHtml
              ? '网页书 · 原样'
              : (items.length ? `${items[items.length - 1].day.slice(5)} – ${items[0].day.slice(5)}` : '空白本子')}</div>
            <div class="fi-count">${isHtml ? (b.fileCount || 0) + ' 个文件' : items.length + ' 页'}</div>
          </div>
          <div class="fi-grass" aria-hidden="true">
            <i>🌿</i><i>🌱</i><i>🍃</i><i>🌿</i><i>🌱</i><i>🍃</i><i>🌿</i>
          </div>
        </div>`;
      el.style.setProperty('--fd', (-(i % 7) * 0.85).toFixed(2) + 's');
      // 书名越长字号越小，保证竖排不溢出封面
      const nl = (b.title || '').length;
      el.style.setProperty('--fs-name', nl <= 2 ? '.15' : nl <= 4 ? '.118' : nl <= 6 ? '.095' : '.076');

      el.addEventListener('click', () => {
        if (Date.now() - lastShelfDrag < 350) return;
        if (b.kind === 'html') { openRawBook(b); return; }
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
    // 新开一本：直接摊开并进入书写，不用再点一次笔
    await openBook(b.id);
    await newEntry(b.id);
    toast('新本子已摊开，直接写吧');
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
    const isHtml = b.kind === 'html';
    const n = isHtml ? (b.fileCount || 0) : S.all.filter(e => e.bookId === b.id).length;
    const ok = await pickOption(
      isHtml
        ? `删除网页书《${b.title}》？其中 ${n} 个文件将一并删除，不可恢复。`
        : `删除「${b.title}」？${n ? `其中 ${n} 篇日记也会一并删除，不可恢复。` : ''}`,
      [{ label: '取消', value: 0 }, { label: '确认删除', value: 1 }]
    );
    if (!ok) return;
    if (isHtml) {
      await Store.addRawTomb(b.id);   // 删除墓碑：跨设备同步时不再拉回
      await Store.delRawFiles(b.id);
    }
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

  /** 原样 HTML 书：封面掀开 → 沉浸显示（就是那本书，不是网页外壳） */
  async function openRawBook(book) {
    if (S.editing) { S.editing = false; $('#writerBar').hidden = true; }

    // SW 接管保障（未接管时 /raw/ 会 404）
    if ('serviceWorker' in navigator && !navigator.serviceWorker.controller) {
      try {
        await navigator.serviceWorker.ready;
        await new Promise((r) => {
          navigator.serviceWorker.addEventListener('controllerchange', r, { once: true });
          setTimeout(r, 5000);
        });
      } catch (e) { /* ignore */ }
    }

    S.rawBook = book;
    const url = new URL(
      '/raw/' + book.id + '/' + (book.entryPath ? encodeURI(book.entryPath) : 'index.html'),
      location.href
    ).href;

    // 先借 reader 的书放封面，掀开的瞬间切入网页书内容
    setView('reader');
    await ensureFlip();
    Flip.setPage(`<div class="sheet"><div class="sheet-empty">
      <div class="se-ico">❊</div>
      <div class="se-text">正在翻开《${escapeHtml(book.title)}》…</div>
    </div></div>`);
    updatePager();
    await showCover(book);
    $('#rawFrame').src = url;          // 掀封面的同时后台加载
    await sleep(150);
    await openCover();
    setView('raw');                    // 沉浸进入
  }

  async function openBook(bookId) {
    const book = S.books.find(b => b.id === bookId);
    if (book && book.kind === 'html') { openRawBook(book); return; }
    const bookUsedForCover = book;
    S.bookId = bookId;
    S.entries = (await Store.listEntries({ bookId })).slice().reverse();  // 时间正序
    htmlCache.clear();
    setView('reader');
    await ensureFlip();

    if (S.entries.length) S.idx = S.entries.length - 1;

    await showCover(bookUsedForCover);
    if (S.entries.length) await renderCurrent(true);
    else Flip.setSpread(emptySheetHTML(), blankLeafHTML());

    await sleep(150);
    await openCover();
    updatePager();
    updateSub();
  }

  /** 扉页（跨页左侧没有内容时） */
  function blankLeafHTML() {
    return `<div class="sheet">
      <div class="sheet-empty">
        <div class="se-ico">❊</div>
        <div class="se-text">扉页</div>
      </div>
    </div>`;
  }

  /** 空本子的第一页 */
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
      getPriorHTML: () => htmlCache.get(S.idx - 2) || '',
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
    await paintSpread();
    updatePager();
    updateSub();
  }

  /** 取某一页的 HTML（带缓存） */
  async function getPageHTML(i, fresh) {
    const e = S.entries[i];
    if (!e) return emptySheetHTML();
    if (!fresh && htmlCache.has(i)) return htmlCache.get(i);
    const h = await renderSheet(e, { fresh, index: i });
    htmlCache.set(i, h);
    return h;
  }

  /** 绘制跨页：右页 = 当前，左页 = 上一篇（没有就扉页） */
  async function paintSpread() {
    const cur = S.entries.length ? await getPageHTML(S.idx) : emptySheetHTML();
    const prev = S.idx > 0 ? await getPageHTML(S.idx - 1) : blankLeafHTML();
    Flip.setSpread(cur, prev);
    Flip.setUnder('');
  }

  async function renderCurrent(fresh) {
    if (fresh) htmlCache.delete(S.idx);
    await paintSpread();
    await warmCache();
    updatePager();
    updateSub();
  }

  async function warmCache() {
    for (const i of [S.idx - 2, S.idx - 1, S.idx + 1]) {
      if (i < 0 || i >= S.entries.length) continue;
      if (htmlCache.has(i)) continue;
      htmlCache.set(i, await renderSheet(S.entries[i], { index: i }));
    }
  }

  function syncEditBtn() {
    const b = $('#btnEdit');
    if (!b) return;
    b.hidden = !(S.view === 'reader' && S.entries.length > 0);
    document.getElementById('app').dataset.editing = S.editing ? '1' : '';
    b.title = S.editing ? '完成，回到阅读' : '继续写这一页';
    b.setAttribute('aria-label', S.editing ? '完成' : '写');
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
    const next = await getPageHTML(S.idx + 1);
    Sound.rustle({ strength: 0.7 });
    Flip.goNext(next, next, async () => { await onFlipDone(1); });
  }

  async function goPrev() {
    if (S.editing || S.idx <= 0) return;
    await ensureFlip();
    const prev = await getPageHTML(S.idx - 1);
    const prior = S.idx - 2 >= 0 ? await getPageHTML(S.idx - 2) : emptySheetHTML();
    Sound.rustle({ strength: 0.55, low: true });
    Flip.goPrev(prev, prior, async () => { await onFlipDone(-1); });
  }

  /* ══════════ 页面渲染 ══════════ */
  /** 把附件图片内嵌到正文段落之间（浮动，文字环绕） */
  async function inlineFigureHTML(imgs) {
    const figs = [];
    for (let i = 0; i < imgs.length; i++) {
      const u = await mediaURL(imgs[i].mediaId);
      figs.push(`<figure class="pg-fig${i % 2 ? ' alt' : ''}">${u
        ? `<img src="${u}" alt="" loading="lazy">`
        : '<div class="att-empty">照片待同步</div>'}</figure>`);
    }
    return figs;
  }

  function weaveFigures(bodyHtml, figs) {
    if (!figs.length) return bodyHtml || '';
    const tmp = document.createElement('div');
    tmp.innerHTML = bodyHtml || '';
    const nodes = Array.from(tmp.childNodes);
    const out = [];
    let fi = 0, pCount = 0;

    for (const node of nodes) {
      if (node.nodeType === 3) {
        const t = (node.textContent || '').trim();
        if (t) out.push(`<p>${escapeHtml(t)}</p>`);
        continue;
      }
      out.push(node.outerHTML);
      if (node.nodeType === 1 && ['P', 'DIV'].includes(node.tagName)) {
        pCount++;
        if (fi < figs.length && pCount % 2 === 0) out.push(figs[fi++]);
      }
    }
    while (fi < figs.length) out.push(figs[fi++]);
    return out.join('');
  }

  async function renderSheet(e, opt) {
    opt = opt || {};
    if (!e) return emptySheetHTML();
    const d = new Date(e.ts);
    const wc = wordCount(e.body);
    const total = S.entries.length || 1;
    const num = typeof opt.index === 'number' ? `${opt.index + 1} / ${total}` : '';

    const tags = (e.tags || []).map(t => `<span class="sf-tag" data-tag="${escapeHtml(t)}">#${escapeHtml(t)}</span>`).join('');

    const allAtts = e.attachments || [];
    const imgs = allAtts.filter(a => a.type === 'image');
    const others = allAtts.filter(a => a.type !== 'image');

    // 编辑态把图片留在文末（可删除），阅读态内嵌到正文里环绕排版
    let bodyHtml = e.body || '';
    let attHTML = '';
    if (S.editing) {
      attHTML = await renderAttachments(e);
    } else {
      const figs = await inlineFigureHTML(imgs);
      bodyHtml = weaveFigures(bodyHtml, figs);
      attHTML = others.length
        ? await renderAttachments(Object.assign({}, e, { attachments: others }))
        : '';
    }

    return `<div class="sheet" data-id="${e.id}">
      <header class="pg-head">
        <h2 class="pg-date">${d.getMonth() + 1} 月 ${d.getDate()} 日</h2>
        <div class="pg-meta">
          <span class="pg-chip">${WEEK[d.getDay()]}</span>
          ${e.weather ? `<span class="pg-chip t">${escapeHtml(e.weather)}</span>` : ''}
          ${wc ? `<span class="pg-chip c">${wc} 字</span>` : ''}
        </div>
      </header>
      <h3 class="pg-title" data-ed="title">${escapeHtml(e.title || '')}</h3>
      <div class="sh-body" data-ed="body">${bodyHtml}</div>
      ${attHTML}
      <footer class="pg-foot">
        ${tags}
        ${e.starred ? '<span style="color:var(--accent)">★</span>' : ''}
        <span class="pg-num">${num}</span>
      </footer>
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
    const html = await renderSheet(S.entries[S.idx], { index: S.idx });
    const prev = S.idx > 0 ? await getPageHTML(S.idx - 1) : blankLeafHTML();
    Flip.setSpread(html, prev);
    const sheet = $('#leafFront .sheet');
    if (!sheet) return;
    const title = sheet.querySelector('.pg-title');
    const body = sheet.querySelector('.sh-body');
    if (title) title.setAttribute('contenteditable', 'true');
    if (body) body.setAttribute('contenteditable', 'true');
    $('#writerBar').hidden = false;
    updatePager();
    syncMetaChips();
    readMetaFromDom();
    const focusEl = (body && body.textContent.trim()) ? body : (title || body);
    if (focusEl) focusEl.focus();
    Sound.tap();
    markDirty();
    syncEditBtn();
  }

  async function exitEdit() {
    if (!S.editing) return;
    await saveNow();
    S.editing = false;
    $('#writerBar').hidden = true;
    const e = S.entries[S.idx];
    htmlCache.delete(S.idx);
    const html = await renderSheet(e, { index: S.idx });
    htmlCache.set(S.idx, html);
    const prev = S.idx > 0 ? await getPageHTML(S.idx - 1) : blankLeafHTML();
    Flip.setSpread(html, prev);
    await warmCache();
    updatePager();
    syncEditBtn();
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
    const t = sheet.querySelector('.pg-title');
    const b = sheet.querySelector('.sh-body');
    const newTitle = (t ? t.innerText : '').replace(/\n+/g, ' ').trim();
    const newBody = sanitize(b ? b.innerHTML : '');
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
      let msg = `同步完成 · 拉取 ${st.pulled} 篇，上传 ${st.pushed} 篇，附件 ${st.mediaUp} 个`;
      if (st.rawUp || st.rawDown) msg += `\n网页书：上传 ${st.rawUp || 0} 个文件，下载 ${st.rawDown || 0} 本`;
      msg += (st.conflicts ? `\n${st.conflicts} 处冲突已另存副本` : '') +
        `\n${fmtFull(st.at)} ${fmtTime(st.at)}`;
      state.textContent = msg;
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

    // 导入：PDF → 转成一本日记本；HTML → 原样成书（或转成一篇日记）
    const doImportFile = (file) => {
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

    const importSiteFlow = (files) => {
      PJ.Importer.importSite(files, { nextCover: S.books.length })
        .then(async (r) => {
          await refreshAll();
          shelfIndex = Math.max(0, S.books.findIndex(b => b.id === r.bookId));
          renderShelf();
          if (r.missing && r.missing.length) {
            toast(`《${r.title}》已导入，但缺少被引用的文件：${r.missing.slice(0, 2).join('、')}${r.missing.length > 2 ? '…' : ''}`, 5000);
          } else {
            toast(`《${r.title}》已原样导入 · ${r.files} 个文件`);
          }
          const b = S.books.find(x => x.id === r.bookId);
          if (b) await openRawBook(b);
        })
        .catch((e) => {
          console.warn('site import fail', e);
          toast('导入失败：' + (e.message || e).slice(0, 60));
        });
    };

    const startImport = () => {
      Sound.unlock();
      PJ.Importer.onFiles = async (files) => {
        // 选中 .md（可连同图片一起选）→ 走日记导入
        const mdFiles = files.filter(f => /\.(md|markdown)$/i.test(f.name));
        if (mdFiles.length) {
          const mdsData = [];
          for (const f of mdFiles) mdsData.push({ rel: f.name, text: await f.text() });
          const imgsSel = files.filter(f => /\.(jpe?g|png|gif|webp|mp4|webm)$/i.test(f.name));
          await runImportSource({
            mds: mdsData,
            images: imgsSel.map(f => f.name),
            getImage: async (rel) => imgsSel.find(x => x.name === rel) || null
          });
          return;
        }

        const pdfs = files.filter(f => /\.pdf$/i.test(f.name) || f.type === 'application/pdf');
        const htmls = files.filter(f => /\.x?html?$/i.test(f.name) || /html/i.test(f.type || ''));
        if (pdfs.length + htmls.length < files.length) { toast('仅支持 PDF 与 HTML 文件'); return; }
        if (pdfs.length && htmls.length) { toast('PDF 和 HTML 请分开导入'); return; }
        if (pdfs.length > 1) { toast('一次导入一个 PDF'); return; }
        if (pdfs.length === 1) { doImportFile(pdfs[0]); return; }

        if (htmls.length === 1) {
          // 检测内部引用：引用了其他本地 .html 时引导用户一起选中
          let refs = [];
          try { refs = await PJ.Importer.detectRefs(htmls[0]); } catch (e) { /* ignore */ }
          const choices = [
            { label: '原样成书（推荐）', value: 'raw' },
            { label: '转成一篇日记', value: 'entry' }
          ];
          let msg = `《${htmls[0].name}》怎么导入？`;
          if (refs.length) {
            choices.unshift({ label: '重新选择文件', value: 'again' });
            msg = `《${htmls[0].name}》还引用了 ${refs.length} 个内部文件` +
              `（${refs.slice(0, 2).join('、')}${refs.length > 2 ? '…' : ''}）。` +
              `要完整原样成书，请点「重新选择文件」，把这些文件一起选中。`;
          }
          const choice = await pickOption(msg, choices);
          if (choice === 'again') { PJ.Importer.pickImport(true); return; }
          if (choice === 'entry') { doImportFile(htmls[0]); return; }
        }
        importSiteFlow(htmls);
      };
      PJ.Importer.pickImport(true);
    };
    $('#btnImport').onclick = startImport;
    $('#btnImportSetting').onclick = startImport;

    /* ── 导入日记文件夹：YYYY-MM-DD.md + 图片，按月自动装订 ── */
    function b64ToBlob(b64, mime) {
      const bin = atob(b64);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      return new Blob([arr], { type: mime || 'application/octet-stream' });
    }

    async function runImportSource(source) {
      try {
        const r = await PJ.Importer.importDiaryFolder(source, { nextCover: S.books.length });
        await refreshAll();
        shelfIndex = Math.max(0, S.books.findIndex(b => r.books[0] && b.id === r.books[0].id));
        renderShelf();
        toast(`已导入 ${r.entries} 篇日记` +
          (r.skipped ? `（跳过 ${r.skipped} 篇已存在）` : '') +
          ` · ${r.books.map(b => b.title).join('、')}`, 4200);
      } catch (e) {
        console.warn('diary folder import fail', e);
        toast('导入失败：' + ((e && e.message) || e).slice(0, 60));
      }
    }

    const startDiaryImport = async () => {
      Sound.unlock();
      if (window.PJDesktop && window.PJDesktop.pickDiaryFolder) {
        const res = await window.PJDesktop.pickDiaryFolder();
        if (!res) return;
        if (res.mds && !res.mds.length) { toast('这个文件夹里没有 YYYY-MM-DD.md 日记'); return; }
        await runImportSource({
          mds: res.mds,
          images: res.images,
          getImage: async (rel) => {
            const x = await window.PJDesktop.readDiaryMedia(rel);
            return x ? b64ToBlob(x.b64, x.mime) : null;
          }
        });
        return;
      }
      // 网页版：选择文件夹（webkitdirectory）
      const inp = document.createElement('input');
      inp.type = 'file';
      inp.webkitdirectory = true;
      inp.multiple = true;
      inp.onchange = async () => {
        const files = Array.from(inp.files || []);
        const mds = [], imgs = new Map();
        for (const f of files) {
          const rel = (f.webkitRelativePath || f.name).split('/').slice(1).join('/');
          if (/\.(md|markdown)$/i.test(f.name)) mds.push({ rel, text: await f.text() });
          else if (/\.(jpe?g|png|gif|webp|mp4|webm)$/i.test(f.name)) imgs.set(rel, f);
        }
        if (!mds.length) { toast('没有找到 .md 日记文件'); return; }
        await runImportSource({
          mds,
          images: [...imgs.keys()],
          getImage: async (rel) => imgs.get(rel) || null
        });
      };
      inp.click();
    };

    const btnDiary = $('#btnImportDiarySetting');
    if (btnDiary) btnDiary.onclick = startDiaryImport;
    const btnDiary2 = $('#btnImportDiary');
    if (btnDiary2) btnDiary2.onclick = startDiaryImport;

    // 启动参数 PJ_IMPORT_DIR：启动即批量导入
    if (window.PJDesktop && window.PJDesktop.onAutoImport) {
      window.PJDesktop.onAutoImport(async (root) => {
        const res = await window.PJDesktop.pickDiaryFolder(root);
        if (!res || !res.mds || !res.mds.length) {
          toast('自动导入：该目录没有 .md 日记');
          return;
        }
        await runImportSource({
          mds: res.mds,
          images: res.images,
          getImage: async (rel) => {
            const x = await window.PJDesktop.readDiaryMedia(rel);
            return x ? b64ToBlob(x.b64, x.mime) : null;
          }
        });
      });
    }

    // 滚轮 / 触控板翻页：横滑直接翻；纵滚到页底（页顶）再继续才翻
    let readWheelAt = 0;
    const bookEl = $('#book');
    bookEl.addEventListener('wheel', (ev) => {
      if (S.view !== 'reader' || S.editing) return;
      const now = Date.now();
      const dx = ev.deltaX, dy = ev.deltaY;

      // 横向手势（触控板双指横滑 / Shift+滚轮）
      if (Math.abs(dx) > Math.abs(dy) * 1.2) {
        ev.preventDefault();
        if (now - readWheelAt < 300) return;
        if (Math.abs(dx) < 6) return;
        readWheelAt = now;
        if (dx > 0) goPrev(); else goNext();
        return;
      }

      // 纵向：只在内容已滚到边界时接管，避免和正文滚动打架
      const sc = $('#leafFront');
      if (!sc) return;
      const atBottom = sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 4;
      const atTop = sc.scrollTop <= 2;
      if (dy > 0 && atBottom) {
        ev.preventDefault();
        if (now - readWheelAt < 420) return;
        readWheelAt = now;
        goNext();
      } else if (dy < 0 && atTop) {
        ev.preventDefault();
        if (now - readWheelAt < 420) return;
        readWheelAt = now;
        goPrev();
      }
    }, { passive: false });

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

    // 书写开关：阅读是默认状态，点右上角的笔才进入书写
    const toggleEditMode = async () => {
      if (S.view !== 'reader' || !S.entries.length) return;
      Sound.unlock(); Sound.tap();
      if (S.editing) await exitEdit();
      else await enterEdit();
    };
    $('#btnEdit').onclick = toggleEditMode;

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
        if (S.view === 'raw' && (ev.key === 'Escape' || ev.key === 'Backspace')) {
          ev.preventDefault();
          setView('shelf');
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
      // 书写入口只走右上角的笔（或 Ctrl/⌘+E），避免翻页手滑误触进入编辑
      if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 'e') {
        ev.preventDefault();
        toggleEditMode();
        return;
      }
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
