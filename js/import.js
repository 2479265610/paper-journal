/* ═══════════════════════════════════════════════
   import.js — 文件导入为日记内容
   · PDF → 一本新日记：每一页渲染为图像，一页 = 一页日记，像课本一样翻
   · HTML → 一篇新日记：抽取正文（保留标题/列表/表格/图片），沙箱消毒
   依赖：pdf.js（js/vendor/，懒加载）、util.js 的 sanitize
   ═══════════════════════════════════════════════ */
(function (global) {
  'use strict';

  const { Store, uid, dayKey, sanitize, toast, fmtBytes } = global.PJ;

  /* ── 进度框 ── */
  function ipShow(title) {
    const box = document.getElementById('importBox');
    if (!box) return;
    document.getElementById('ipTitle').textContent = title;
    document.getElementById('ipBarFill').style.width = '4%';
    document.getElementById('ipSub').textContent = '';
    box.hidden = false;
  }
  function ipUpdate(pct, sub) {
    const bar = document.getElementById('ipBarFill');
    const subEl = document.getElementById('ipSub');
    if (bar) bar.style.width = Math.round(pct * 100) + '%';
    if (subEl) subEl.textContent = sub || '';
  }
  function ipHide() {
    const box = document.getElementById('importBox');
    if (box) box.hidden = true;
  }

  /* ── pdf.js 懒加载 ──
     worker.min.js 同时作为普通脚本加载 → 定义 window.pdfjsWorker → pdf.js 自动走主线程
     fake worker。规避个别 WebView/环境里 Worker 创建后渲染 promise 永不返回的问题。 */
  let pdfLibPromise = null;
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error('加载失败: ' + src));
      document.head.appendChild(s);
    });
  }
  function ensurePdfLib() {
    if (global.pdfjsLib) return Promise.resolve(global.pdfjsLib);
    if (pdfLibPromise) return pdfLibPromise;
    pdfLibPromise = (async () => {
      await loadScript('js/vendor/pdf.worker.min.js');   // 先定义 pdfjsWorker（主线程模式）
      await loadScript('js/vendor/pdf.min.js');
      if (!global.pdfjsLib) throw new Error('PDF 组件加载失败');
      global.pdfjsLib.GlobalWorkerOptions.workerSrc = 'js/vendor/pdf.worker.min.js';
      return global.pdfjsLib;
    })().catch(e => { pdfLibPromise = null; throw e; });
    return pdfLibPromise;
  }

  /** 带超时的 promise 包装（防止第三方 promise 永不 settle 导致整页卡死） */
  function withTimeout(p, ms, label) {
    return Promise.race([
      p,
      new Promise((_, rej) => setTimeout(() => rej(new Error(label + ' 超时')), ms))
    ]);
  }

  /* ── 入口：按类型分流 ── */
  async function importFiles(file, opts) {
    const name = (file && file.name) || '导入文件';
    if (/\.pdf$/i.test(name) || file.type === 'application/pdf') {
      return importPDF(file, name, opts);
    }
    if (/\.(html?|xhtml)$/i.test(name) || /html/i.test(file.type || '')) {
      return importHTML(file, name, opts);
    }
    throw new Error('目前支持导入 PDF 与 HTML 文件');
  }

  /* ── PDF → 一本新日记 ── */
  async function importPDF(file, name, opts) {
    opts = opts || {};
    const onProgress = opts.onProgress;

    ipShow('正在准备导入 PDF');
    onProgress && onProgress(0, 1, '加载转换组件…');
    const lib = await ensurePdfLib();

    onProgress && onProgress(0, 1, '解析文件…');
    ipUpdate(0.02, '解析文件…');
    const data = await file.arrayBuffer();
    const pdf = await withTimeout(lib.getDocument({ data }).promise, 60000, 'PDF 解析');
    const total = pdf.numPages;
    if (!total) { ipHide(); throw new Error('这个 PDF 没有可显示的页面'); }

    const book = {
      id: uid(),
      title: name.replace(/\.pdf$/i, '').trim() || '导入的 PDF',
      cover: opts.nextCover || 0,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    await Store.putBook(book);

    const dk = dayKey(Date.now());
    let ts = Date.now() - total * 1000;   // 递增时间戳保证页序

    const cv = document.createElement('canvas');
    const ctx = cv.getContext('2d');

    for (let i = 1; i <= total; i++) {
      ipUpdate(i / total, `转换第 ${i} / ${total} 页…`);
      onProgress && onProgress(i, total, `转换第 ${i} / ${total} 页…`);

      // 让 UI 有机会绘制（每页之间让出主线程；不用 rAF——后台标签页会暂停 rAF 导致卡死）
      await new Promise(r => setTimeout(r, 0));

      const page = await withTimeout(pdf.getPage(i), 20000, `读取第 ${i} 页`);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(2, Math.max(1.2, 1400 / Math.max(base.width, base.height)));
      const vp = page.getViewport({ scale });
      cv.width = Math.floor(vp.width);
      cv.height = Math.floor(vp.height);
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, cv.width, cv.height);

      // 渲染偶发不返回（pdf.js 内部消息丢失），超时后取消并重试一次
      const renderOnce = () => {
        const task = page.render({ canvasContext: ctx, viewport: vp });
        return withTimeout(task.promise, 40000, `渲染第 ${i} 页`).catch((err) => {
          try { task.cancel(); } catch (e) { /* ignore */ }
          throw err;
        });
      };
      try {
        await renderOnce();
      } catch (err) {
        if (/超时/.test(err.message)) {
          await new Promise(r => setTimeout(r, 120));   // 等上一次渲染彻底收尾
          ctx.fillStyle = '#fff';
          ctx.fillRect(0, 0, cv.width, cv.height);
          await renderOnce();
        } else {
          throw err;
        }
      }

      const blob = await new Promise(r => cv.toBlob(r, 'image/jpeg', 0.85));
      const m = await Store.putMedia(new File([blob], `page-${i}.jpg`, { type: 'image/jpeg' }));
      ts += 1000;
      await Store.putEntry({
        id: uid(),
        bookId: book.id,
        day: dk,
        ts,
        title: `第 ${i} 页`,
        body: '',
        attachments: [{
          id: uid(), type: 'image', mediaId: m.id,
          name: `${book.title} · 第 ${i} 页`, size: blob.size
        }],
        tags: [], mood: '', weather: '', starred: 0,
        createdAt: Date.now(), updatedAt: Date.now()
      });
      page.cleanup();
    }

    try { await pdf.destroy(); } catch (e) { /* ignore */ }
    ipHide();
    return { type: 'book', bookId: book.id, pages: total, title: book.title };
  }

  /* ── HTML → 一篇新日记 ── */
  async function importHTML(file, name, opts) {
    opts = opts || {};
    ipShow('正在导入 HTML');
    ipUpdate(0.3, '解析网页…');

    const text = await file.text();
    const doc = new DOMParser().parseFromString(text, 'text/html');

    doc.querySelectorAll('script,style,noscript,link,meta,iframe,object,embed,form,svg,video,audio')
      .forEach(x => x.remove());

    // 图片：保留 http(s) 与 data:image 内联图，其余移除
    doc.querySelectorAll('img').forEach(img => {
      const src = img.getAttribute('src') || '';
      if (/^(https?:\/\/|data:image\/)/i.test(src.trim())) {
        img.setAttribute('loading', 'lazy');
        img.removeAttribute('width');
        img.removeAttribute('height');
        img.removeAttribute('srcset');
        img.removeAttribute('style');
      } else {
        img.remove();
      }
    });

    ipUpdate(0.7, '清洗正文…');
    const body = doc.body ? doc.body.innerHTML : text;
    const title = (doc.title || '').trim().replace(/\s+/g, ' ').slice(0, 60) ||
      name.replace(/\.x?html?$/i, '');

    const e = {
      id: uid(),
      bookId: opts.bookId,
      day: dayKey(Date.now()),
      ts: Date.now(),
      title,
      body: sanitize(body),
      attachments: [],
      tags: [], mood: '', weather: '', starred: 0,
      createdAt: Date.now(), updatedAt: Date.now()
    };
    await Store.putEntry(e);
    ipHide();
    return { type: 'entry', entry: e };
  }

  /* ── HTML 站点 → 原样成书（虚拟文件系统，保留全部样式与交互） ── */
  function guessType(name) {
    const ext = (name.match(/\.[a-z0-9]+$/i) || [''])[0].toLowerCase();
    return ({
      '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
      '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.mp3': 'audio/mpeg',
      '.mp4': 'video/mp4', '.pdf': 'application/pdf'
    })[ext] || 'application/octet-stream';
  }

  async function importSite(files, opts) {
    opts = opts || {};
    const arr = Array.from(files).filter(f => /\.(x?html?|css|js|json|png|jpe?g|gif|webp|svg|ico|woff2?|ttf|mp3|mp4|pdf|txt)$/i.test(f.name));
    if (!arr.length) throw new Error('没有可导入的 HTML/资源文件');

    ipShow('正在导入 HTML 书');

    // 入口：index.html 优先
    const entryFile = arr.find(f => /^index\.html?$/i.test(f.name)) ||
                      arr.find(f => /\.x?html?$/i.test(f.name)) || arr[0];

    // 解析入口引用的内部页面，提示缺失
    let missing = [];
    try {
      const head = await entryFile.slice(0, Math.min(entryFile.size, 2 * 1024 * 1024)).text();
      const refs = (head.match(/[\w\-. %\u4e00-\u9fa5]+\.html?(?![\w])/gi) || [])
        .map(s => s.trim());
      const names = new Set(arr.map(f => f.name));
      missing = [...new Set(refs)].filter(u => !names.has(u));
    } catch (e) { /* ignore */ }

    const bookId = uid();
    let done = 0;
    for (const f of arr) {
      ipUpdate(done / arr.length, `存入 ${f.name}（${(f.size / 1048576).toFixed(1)} MB）`);
      // 让出主线程刷新进度
      await new Promise(r => setTimeout(r, 0));
      await Store.putRawFile({
        id: bookId + '/' + f.name,
        bookId,
        path: f.name,
        blob: f,
        type: f.type || guessType(f.name),
        size: f.size
      });
      done++;
    }

    // 标题：读入口 <title>
    let title = entryFile.name.replace(/\.x?html?$/i, '');
    try {
      const text = await entryFile.text();
      const m = text.match(/<title[^>]*>([^<]*)<\/title>/i);
      if (m && m[1].trim()) title = m[1].trim().replace(/\s+/g, ' ').slice(0, 30);
    } catch (e) { /* ignore */ }

    const book = {
      id: bookId,
      title,
      kind: 'html',
      entryPath: entryFile.name,
      cover: opts.nextCover || 0,
      fileCount: arr.length,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    await Store.putBook(book);
    ipHide();
    return { type: 'site', bookId, title, files: arr.length, missing };
  }

  /** 检测 HTML 内部引用的其他本地页面（引导多选导入） */
  async function detectRefs(file) {
    try {
      const head = await file.slice(0, Math.min(file.size, 2 * 1024 * 1024)).text();
      const refs = (head.match(/[\w\-. %\u4e00-\u9fa5]+\.html?(?![\w])/gi) || [])
        .map(s => s.trim())
        .filter(u => !/^https?:/i.test(u) && !/^\s*$/.test(u));
      return [...new Set(refs)];
    } catch (e) { return []; }
  }

  /* ── 文件选择器（供按钮调用） ── */
  function pickImport(multiple) {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.multiple = !!multiple;
    inp.accept = '.pdf,.htm,.html,application/pdf,text/html';
    inp.onchange = () => {
      if (inp.files && inp.files.length && Importer.onFiles) {
        Importer.onFiles(Array.from(inp.files));
      }
    };
    inp.click();
  }

  const Importer = { importFiles, importSite, pickImport, detectRefs, onFiles: null };
  global.PJ = global.PJ || {};
  global.PJ.Importer = Importer;
})(window);
