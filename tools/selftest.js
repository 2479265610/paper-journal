/* ═══════════════════════════════════════════════
   selftest.js — 页面自检（仅 ?selftest 时加载）
   把运行时状态回传到 /__log，方便无头环境下排查
   ═══════════════════════════════════════════════ */
(function () {
  'use strict';

  const report = { ok: [], fail: [], errors: [], info: {} };

  const log = (k, v) => { report.info[k] = v; };
  const pass = (m) => report.ok.push(m);
  const fail = (m) => report.fail.push(m);

  function check(name, cond, extra) {
    if (cond) pass(name);
    else fail(name + (extra ? ' → ' + extra : ''));
  }

  function send() {
    report.errors = (window.__PJERR || []).slice(0, 12);
    report.info.desktop = typeof window.PJDesktop !== 'undefined';
    report.info.android = typeof window.PJNative !== 'undefined';
    report.info.protocol = location.protocol;
    const payload = JSON.stringify(report);
    // 无头/桌面环境下直接打到控制台，主进程可捕获
    try { console.log('[SELFTEST]', payload); } catch (e) {}
    const url = '/__log?d=' + encodeURIComponent(payload);
    fetch(url).catch(() => {});
    // 同时写进标题，便于任何方式读取
    document.title = (report.fail.length ? 'FAIL:' + report.fail.length : 'PASS') +
      ' | ' + (report.errors[0] || 'no error');
  }

  async function run() {
    // 心跳：把当前进度写进标题，便于无头环境定位卡点
    const hb = setInterval(() => {
      document.title = 'ST… ok=' + report.ok.length + ' fail=' + report.fail.length +
        (report.info.heartbeat ? ' | ' + report.info.heartbeat : '');
    }, 1500);
    const beat = (tag) => { report.info.heartbeat = tag; };
    window.__beat = beat;

    try {
      check('PJ 命名空间', !!window.PJ);
      check('Store 模块', !!(window.PJ && window.PJ.Store));
      check('Flip 模块', !!(window.PJ && window.PJ.Flip));
      check('Sync 模块', !!(window.PJ && window.PJ.Sync));
      check('Sound 模块', !!(window.PJ && window.PJ.Sound));
      check('工具函数', !!(window.PJ && window.PJ.uid && window.PJ.sanitize));

      const app = document.getElementById('app');
      check('#app 存在', !!app);
      log('view', app && app.dataset.view);
      log('theme', app && app.dataset.theme);

      // 书架（3D cover flow）
      const cards = document.querySelectorAll('.flow-item');
      check('书架渲染出书本', cards.length >= 1, 'cards=' + cards.length);
      const active = document.querySelector('.flow-item.active');
      check('有一本处于居中态', !!active);
      check('浮动操作按钮齐全',
        !!document.querySelector('#btnNewBook') &&
        !!document.querySelector('#btnBookMore') &&
        !!document.querySelector('#btnBookDel'));
      log('flowTransform', active && active.style.transform);
      log('flowTitle', (document.querySelector('#flowTitle') || {}).textContent);

      // 关键 DOM
      ['#leaf', '#leafFront', '#leafBack', '#pageUnder', '#bookCover',
       '#edgePrev', '#edgeNext', '#writerBar', '#drawer'].forEach(sel => {
        check('元素 ' + sel, !!document.querySelector(sel));
      });

      const b = document.querySelector('#book');
      log('bookSize', b ? b.clientWidth + 'x' + b.clientHeight : 'none');

      // 打开书 → 进入 reader
      const activeEl = document.querySelector('.flow-item.active');
      if (activeEl) {
        activeEl.click();
        await new Promise(r => setTimeout(r, 2200));
        log('viewAfterOpen', app.dataset.view);
        check('已进入阅读视图', app.dataset.view === 'reader');

        const sheet = document.querySelector('.sheet');
        check('渲染出纸页', !!sheet);
        log('pageIndicator', (document.querySelector('#pageIndicator') || {}).textContent);

        /* 跨页几何：纸宽应正好是半本宽，左页同理 */
        const bookEl = document.querySelector('#book');
        const leafEl = document.querySelector('#leaf');
        const leftEl = document.querySelector('#pageLeft');
        const bw = bookEl ? bookEl.getBoundingClientRect().width : 0;
        const lw = leafEl ? leafEl.getBoundingClientRect().width : 0;
        const plw = leftEl ? leftEl.getBoundingClientRect().width : 0;
        log('spreadGeom', `book=${Math.round(bw)} leaf=${Math.round(lw)} left=${Math.round(plw)}`);
        check('双页：纸宽 = 半本宽', bw > 200 && Math.abs(lw - bw / 2) < 6, `${Math.round(bw)}/${Math.round(lw)}`);
        check('双页：左页宽 = 半本宽', bw > 200 && Math.abs(plw - bw / 2) < 6, `${Math.round(plw)}`);
        check('左页有内容', !!document.querySelector('#pageLeft .sheet'));
        check('侧边翻页按钮', !!document.querySelector('.side-btn.left') && !!document.querySelector('.side-btn.right'));
        check('页内版式（日期/胶囊/页码）',
          !!document.querySelector('#leafFront .pg-date') &&
          document.querySelectorAll('#leafFront .pg-chip').length >= 1 &&
          !!document.querySelector('#leafFront .pg-num'));

        const cover = document.querySelector('#bookCover');
        log('coverHidden', cover && cover.hidden);
        log('coverOpen', cover && cover.classList.contains('open'));

        const leaf = document.querySelector('#leaf');
        log('leafTransform', leaf && leaf.style.transform);
        log('leafHTMLlen', leaf && leaf.innerHTML.length);

        // 新建一篇，验证写入 + 翻页
        const before = document.querySelectorAll('.sheet').length;
        document.querySelector('#fabNew').click();
        await new Promise(r => setTimeout(r, 900));
        log('writerBarHidden', document.querySelector('#writerBar').hidden);
        check('新建后进入编辑态', document.querySelector('#writerBar').hidden === false);

        // 直接构造第二篇，测试翻页
        if (window.__PJ && window.__PJ.newEntry) {
          await window.__PJ.newEntry(null);
          await new Promise(r => setTimeout(r, 600));
          document.querySelector('#btnPrev').click();
          await new Promise(r => setTimeout(r, 1100));
          const leaf2 = document.querySelector('#leaf');
          log('afterPrevTransform', leaf2 && leaf2.style.transform);
          log('afterPrevIndicator', (document.querySelector('#pageIndicator') || {}).textContent);
          check('上一页翻动后回到 0 度', leaf2 && leaf2.style.transform === 'rotateY(0deg)');
        }

        // 主题切换
        const themeBefore = app.dataset.theme;
        document.querySelector('#btnTheme').click();
        await new Promise(r => setTimeout(r, 300));
        log('themeAfterCycle', app.dataset.theme);
        check('主题可切换', app.dataset.theme !== themeBefore);

        /* ══ 附件全链路：图片 / PDF / HTML → 页面渲染 → 相册 → 清理 ══ */
        try {
          const Store = window.PJ.Store;
          // 1. canvas 画一张真 PNG
          const cv = document.createElement('canvas');
          cv.width = 160; cv.height = 110;
          const ctx = cv.getContext('2d');
          const gr = ctx.createLinearGradient(0, 0, 160, 110);
          gr.addColorStop(0, '#b1553c'); gr.addColorStop(1, '#2b2723');
          ctx.fillStyle = gr; ctx.fillRect(0, 0, 160, 110);
          ctx.fillStyle = '#fff'; ctx.font = '20px serif';
          ctx.fillText('纸间', 58, 62);
          const blob = await new Promise(r => cv.toBlob(r, 'image/png'));
          const f1 = new File([blob], '自检图片.png', { type: 'image/png' });

          // 2. 最小合法头 PDF（浏览器只做嵌入，不解析内容）
          const pdfText = '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n%%EOF';
          const f2 = new File([pdfText], '自检文档.pdf', { type: 'application/pdf' });

          // 3. HTML 卡片
          const f3 = new File(
            ['<h2 style="font-family:serif">纸间附件</h2><p>HTML 以沙箱 iframe 渲染。</p>'],
            '自检页面.html', { type: 'text/html' });

          const m1 = await Store.putMedia(f1);
          const m2 = await Store.putMedia(f2);
          const m3 = await Store.putText(await f3.text(), f3.name, 'text/html');
          check('媒体入库（图片）', !!(m1 && m1.id));
          check('媒体入库（PDF）', !!(m2 && m2.id));
          check('媒体入库（HTML）', !!(m3 && m3.id));

          const d = new Date();
          const dk = d.getFullYear() + '-' +
            String(d.getMonth() + 1).padStart(2, '0') + '-' +
            String(d.getDate()).padStart(2, '0');
          const e = {
            id: 'selftest-attach-' + Date.now(),
            bookId: (window.__PJ.S.books[0] || {}).id,
            day: dk, ts: Date.now(),
            title: '附件自检',
            body: '<p>下面依次是照片、PDF、HTML：</p>',
            attachments: [
              { id: 'sa1', type: 'image', mediaId: m1.id, name: f1.name, size: f1.size },
              { id: 'sa2', type: 'pdf', mediaId: m2.id, name: f2.name, size: f2.size },
              { id: 'sa3', type: 'html', mediaId: m3.id, name: f3.name, size: f3.size }
            ],
            tags: [], mood: '', weather: '', starred: 0,
            createdAt: Date.now(), updatedAt: Date.now()
          };
          await Store.putEntry(e);
          await window.__PJ.openEntry(e);
          await new Promise(r => setTimeout(r, 800));

          check('照片渲染出 <img>', !!document.querySelector('#leafFront .pg-fig img, #leafFront .att-img img'));
          const imgEl = document.querySelector('#leafFront .pg-fig img, #leafFront .att-img img');
          log('imgSrc', imgEl && imgEl.getAttribute('src'));
          check('PDF 卡片渲染', !!document.querySelector('#leafFront .att-file .af-ico.pdf'));
          check('HTML 沙箱 iframe 渲染', !!document.querySelector('#leafFront .att-html iframe'));

          // 相册
          document.querySelector('[data-tab="gallery"]').click();
          await new Promise(r => setTimeout(r, 800));
          check('相册收录了照片', document.querySelectorAll('#gallery .gal-item').length >= 1);

          // 清理测试数据（gcMedia 连带删媒体）
          await Store.purgeEntry(e.id);
          check('测试条目已清理', !(await Store.getEntry(e.id)));
        } catch (err) {
          fail('附件链路异常: ' + (err && err.message));
          report.errors.push(String(err && err.stack));
        }

        /* ══ 文件导入：HTML → 一篇日记；PDF → 一本日记（每页 = 一页） ══ */
        try {
          const Store = window.PJ.Store;
          const books0 = window.__PJ.S.books;

          // HTML 导入
          const fh = new File(
            ['<html><head><title>导入自检</title></head><body><h1>大标题</h1><p>段落一</p><table><tr><th>列A</th><td>1</td></tr></table><img src="https://example.com/pic.png"><script>alert(1)<\/script></body></html>'],
            '导入自检.html', { type: 'text/html' });
          const rh = await window.PJ.Importer.importFiles(fh, { bookId: books0[0].id });
          check('HTML 导入为日记', rh.type === 'entry');
          check('HTML 标题自动提取', rh.entry.title === '导入自检', 'title=' + rh.entry.title);
          check('HTML 表格保留', /<table/i.test(rh.entry.body));
          check('HTML 图片保留', /<img/i.test(rh.entry.body));
          check('HTML script 被剥除', !/<script/i.test(rh.entry.body));
          await Store.purgeEntry(rh.entry.id);

          // PDF 导入（2 页样例，pdf.js 真实渲染）
          window.__beat && window.__beat('import:pdf-fetch');
          const resp = await fetch('js/vendor/sample-2p.pdf');
          const buf = await resp.arrayBuffer();
          const fp = new File([buf], '自检课本.pdf', { type: 'application/pdf' });
          window.__beat && window.__beat('import:pdf-convert');
          const rp = await window.PJ.Importer.importFiles(fp, { nextCover: 1 });
          window.__beat && window.__beat('import:pdf-done');
          check('PDF 导入为一本日记', rp.type === 'book');
          const pe = await Store.listEntries({ bookId: rp.bookId });
          check('PDF 每页 = 一页日记（2 页）', pe.length === 2, 'len=' + pe.length);
          const first = pe[pe.length - 1];   // 逆序数组末尾 = 第 1 页
          check('PDF 页含整页图像', first.attachments.length === 1 && first.attachments[0].type === 'image');
          for (const e of pe) await Store.purgeEntry(e.id);
          await Store.delBook(rp.bookId);
          check('PDF 导入测试已清理', (await Store.listBooks()).every(b => b.id !== rp.bookId));
        } catch (err) {
          fail('导入链路异常: ' + (err && err.message));
          report.errors.push(String(err && err.stack));
        }

        /* ══ 原样 HTML 书：站点导入 + SW 虚拟文件系统 ══ */
        try {
          const Store = window.PJ.Store;

          // 确保 SW 就绪并接管页面（?reset=1 会先注销 SW）
          if ('serviceWorker' in navigator) {
            try {
              let reg = await navigator.serviceWorker.getRegistration();
              if (!reg) reg = await navigator.serviceWorker.register('sw.js');
              await navigator.serviceWorker.ready;
              if (!navigator.serviceWorker.controller) {
                await new Promise((r) => {
                  navigator.serviceWorker.addEventListener('controllerchange', r, { once: true });
                  setTimeout(r, 4000);
                });
              }
            } catch (e) { /* SW 不可用时跳过路由断言 */ }
          }

          const fa = new File(
            ['<html><head><title>原样书自检</title></head><body><h1>书架</h1><a href="vol-b.html">go</a></body></html>'],
            'index.html', { type: 'text/html' });
          const fb = new File(
            ['<html><head><title>册一</title></head><body style="background:#e7f0e9"><h1>原样式保留</h1></body></html>'],
            'vol-b.html', { type: 'text/html' });

          const rs = await window.PJ.Importer.importSite([fa, fb], { nextCover: 1 });
          check('HTML 站点原样成书', rs.type === 'site' && rs.files === 2 && rs.missing.length === 0,
            JSON.stringify(rs));
          const bk = (await Store.listBooks()).find(b => b.id === rs.bookId);
          check('书架出现网页书', !!bk && bk.kind === 'html' && bk.title === '原样书自检');

          const got = await Store.getRawFile(rs.bookId, 'vol-b.html');
          check('子页原样保留', !!got && got.blob &&
            (await got.blob.text()).includes('background:#e7f0e9'));

          if (navigator.serviceWorker && navigator.serviceWorker.controller) {
            const swResp = await fetch('/raw/' + rs.bookId + '/vol-b.html');
            const swText = await swResp.text();
            check('SW 虚拟路径可访问', swResp.ok && swText.includes('原样式保留'));
            const swResp2 = await fetch('/raw/' + rs.bookId + '/');
            check('SW 默认入口 index.html',
              swResp2.ok && (await swResp2.text()).includes('go'));
          } else {
            log('swRaw', 'skipped（SW 未接管）');
          }

          await Store.delRawFiles(rs.bookId);
          await Store.delBook(rs.bookId);
          check('原样书测试已清理',
            !(await Store.getRawFile(rs.bookId, 'index.html')));
        } catch (err) {
          fail('原样书链路异常: ' + (err && err.message));
          report.errors.push(String(err && err.stack));
        }
      }
    } catch (e) {
      fail('运行异常: ' + (e && e.message));
      report.errors.push(String(e && e.stack));
    } finally {
      clearInterval(hb);
      send();
    }
  }

  // 等 app 完成 boot
  setTimeout(run, 1200);
})();
