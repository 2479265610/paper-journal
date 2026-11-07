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
    const payload = JSON.stringify(report);
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
