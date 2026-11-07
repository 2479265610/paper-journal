/* ═══════════════════════════════════════════════
   import.js — 文件导入为日记内容
   · PDF → 一本新日记：每一页渲染为图像，一页 = 一页日记，像课本一样翻
   · HTML → 一篇新日记：抽取正文（保留标题/列表/表格/图片），沙箱消毒
   依赖：pdf.js（js/vendor/，懒加载）、util.js 的 sanitize
   ═══════════════════════════════════════════════ */
(function (global) {
  'use strict';

  const { Store, uid, dayKey, sanitize, toast } = global.PJ;

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
      await withTimeout(page.render({ canvasContext: ctx, viewport: vp }).promise, 90000, `渲染第 ${i} 页`);

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

  /* ── 文件选择器（供按钮调用） ── */
  function pickImport() {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = '.pdf,.htm,.html,application/pdf,text/html';
    inp.onchange = () => {
      if (inp.files && inp.files[0] && Importer.onFile) {
        Importer.onFile(inp.files[0]);
      }
    };
    inp.click();
  }

  const Importer = { importFiles, pickImport, onFile: null };
  global.PJ = global.PJ || {};
  global.PJ.Importer = Importer;
})(window);
