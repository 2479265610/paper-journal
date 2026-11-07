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

          check('照片渲染出 <img>', !!document.querySelector('#leafFront .att-img img'));
          const imgEl = document.querySelector('#leafFront .att-img img');
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
      }
    } catch (e) {
      fail('运行异常: ' + (e && e.message));
      report.errors.push(String(e && e.stack));
    } finally {
      send();
    }
  }

  // 等 app 完成 boot
  setTimeout(run, 1200);
})();
