/* ═══════════════════════════════════════════════
   util.js — 基础工具
   ═══════════════════════════════════════════════ */
(function (global) {
  'use strict';

  const $  = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));

  const uid = () =>
    Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 9);

  const pad = (n) => String(n).padStart(2, '0');

  const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

  /** 本地日期键 YYYY-MM-DD */
  function dayKey(ts) {
    const d = ts ? new Date(ts) : new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  function parseDay(key) {
    const [y, m, d] = key.split('-').map(Number);
    return new Date(y, m - 1, d);
  }

  function fmtTime(ts) {
    const d = new Date(ts);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function fmtFull(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日 · ${WEEK[d.getDay()]}`;
  }

  function relTime(ts) {
    const diff = Date.now() - ts;
    const min = Math.floor(diff / 60000);
    if (min < 1) return '刚刚';
    if (min < 60) return `${min} 分钟前`;
    const h = Math.floor(min / 60);
    if (h < 24) return `${h} 小时前`;
    const d = Math.floor(h / 24);
    if (d < 30) return `${d} 天前`;
    return fmtFull(ts);
  }

  function fmtBytes(n) {
    if (!n) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB'];
    let i = 0, v = n;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* ── 富文本消毒：白名单 ── */
  const ALLOWED = new Set([
    'P', 'BR', 'B', 'STRONG', 'I', 'EM', 'U', 'S', 'STRIKE', 'DEL',
    'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'UL', 'OL', 'LI',
    'A', 'SPAN', 'DIV', 'CODE', 'PRE', 'HR',
    'IMG', 'FIGURE', 'FIGCAPTION',
    'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TD', 'TH', 'CAPTION'
  ]);

  /* 各标签允许保留的属性（值还会再校验） */
  const KEEP_ATTRS = {
    IMG: ['src', 'alt', 'loading'],
    A: ['href', 'target', 'rel'],
    TD: ['colspan', 'rowspan'],
    TH: ['colspan', 'rowspan'],
    COL: ['span'],
    COLGROUP: ['span']
  };

  function sanitize(html) {
    if (!html) return '';
    const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');
    const root = doc.body.firstChild;
    walk(root);
    return root.innerHTML;

    function walk(node) {
      const kids = Array.from(node.childNodes);
      for (const n of kids) {
        if (n.nodeType === 3) continue;              // 文本
        if (n.nodeType !== 1) { n.remove(); continue; }
        if (!ALLOWED.has(n.tagName)) {
          // 保留内容，去掉标签
          while (n.firstChild) node.insertBefore(n.firstChild, n);
          n.remove();
          continue;
        }
        // 属性清理
        const keep = KEEP_ATTRS[n.tagName] || [];
        for (const attr of Array.from(n.attributes)) {
          const name = attr.name.toLowerCase();
          const val = attr.value || '';

          if (n.tagName === 'IMG' && name === 'src') {
            if (!/^(https?:\/\/|data:image\/)/i.test(val.trim())) { n.remove(); break; }
            continue;   // 安全来源，保留
          }
          if (n.tagName === 'A' && name === 'href') {
            if (/^\s*(javascript|data):/i.test(val)) n.removeAttribute(attr.name);
            else { n.setAttribute('target', '_blank'); n.setAttribute('rel', 'noopener noreferrer'); }
            continue;
          }
          if (keep.includes(name)) continue;         // 白名单内的普通属性
          n.removeAttribute(attr.name);
        }
        if (n.tagName === 'IMG') {
          n.setAttribute('loading', 'lazy');
          n.setAttribute('alt', n.getAttribute('alt') || '');
        }
        walk(n);
      }
    }
  }

  /* ── 文本摘要 ── */
  function excerpt(html, len) {
    const tmp = document.createElement('div');
    tmp.innerHTML = html || '';
    const t = (tmp.textContent || '').replace(/\s+/g, ' ').trim();
    return t.length > (len || 90) ? t.slice(0, len || 90) + '…' : t;
  }

  function wordCount(html) {
    const tmp = document.createElement('div');
    tmp.innerHTML = html || '';
    const t = (tmp.textContent || '').replace(/\s+/g, '');
    return t.length;
  }

  function debounce(fn, ms) {
    let t;
    return function (...a) {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, a), ms);
    };
  }

  function throttle(fn, ms) {
    let last = 0, timer;
    return function (...a) {
      const now = Date.now();
      const rest = ms - (now - last);
      if (rest <= 0) { last = now; fn.apply(this, a); }
      else if (!timer) {
        timer = setTimeout(() => { timer = null; last = Date.now(); fn.apply(this, a); }, rest);
      }
    };
  }

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  /* ── SHA-256（附件去重命名） ── */
  async function sha256(buf) {
    if (!global.crypto || !global.crypto.subtle) {
      // 退化为简单哈希
      const view = new Uint8Array(buf);
      let h1 = 0x811c9dc5;
      for (let i = 0; i < view.length; i++) {
        h1 ^= view[i];
        h1 = (h1 * 0x01000193) >>> 0;
      }
      return h1.toString(16).padStart(8, '0') + '-' + view.length.toString(16);
    }
    const d = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(d)).slice(0, 12)
      .map(b => b.toString(16).padStart(2, '0')).join('');
  }

  /* ── toast ── */
  let toastTimer;
  function toast(msg, ms) {
    const t = $('#toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('on'), ms || 2400);
  }

  /* ── 简单模态输入 ── */
  function promptText(title, def, placeholder) {
    return new Promise((resolve) => {
      const mask = document.createElement('div');
      mask.className = 'sheet-mask';
      mask.style.zIndex = 90;
      mask.style.display = 'flex';
      mask.style.alignItems = 'center';
      mask.style.justifyContent = 'center';
      mask.style.padding = '24px';

      const box = document.createElement('div');
      box.style.cssText = `
        width:min(360px,100%);background:var(--paper);border-radius:12px;padding:22px;
        box-shadow:0 18px 50px rgba(40,32,20,.28);`;
      box.innerHTML = `
        <p style="margin:0 0 14px;font-size:14px;letter-spacing:.05em;">${escapeHtml(title)}</p>
        <input id="__pt" style="width:100%;height:40px;padding:0 12px;border-radius:8px;
          border:1px solid var(--line);background:transparent;font-size:14px;"
          placeholder="${escapeHtml(placeholder || '')}" value="${escapeHtml(def || '')}">
        <div style="display:flex;gap:8px;margin-top:16px;">
          <button class="btn" id="__pc">取消</button>
          <button class="btn primary" id="__po">确定</button>
        </div>`;
      mask.appendChild(box);
      document.body.appendChild(mask);

      const input = box.querySelector('#__pt');
      setTimeout(() => input.focus(), 60);

      const close = (v) => { mask.remove(); resolve(v); };
      box.querySelector('#__pc').onclick = () => close(null);
      box.querySelector('#__po').onclick = () => close(input.value);
      mask.addEventListener('click', (e) => { if (e.target === mask) close(null); });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') close(input.value);
        if (e.key === 'Escape') close(null);
      });
    });
  }

  /* ── 选择器 ── */
  function pickOption(title, options) {
    return new Promise((resolve) => {
      const mask = document.createElement('div');
      mask.className = 'sheet-mask';
      mask.style.cssText = 'z-index:90;display:flex;align-items:center;justify-content:center;padding:24px;';
      const box = document.createElement('div');
      box.style.cssText = `
        width:min(340px,100%);background:var(--paper);border-radius:12px;padding:20px;
        box-shadow:0 18px 50px rgba(40,32,20,.28);`;
      box.innerHTML = `<p style="margin:0 0 14px;font-size:14px;letter-spacing:.05em;">${escapeHtml(title)}</p>
        <div id="__og" style="display:flex;flex-wrap:wrap;gap:8px;"></div>`;
      const grid = box.querySelector('#__og');
      options.forEach(o => {
        const b = document.createElement('button');
        b.className = 'btn sm';
        b.style.minWidth = '58px';
        b.textContent = o.label;
        b.onclick = () => { mask.remove(); resolve(o.value); };
        grid.appendChild(b);
      });
      mask.appendChild(box);
      mask.addEventListener('click', e => { if (e.target === mask) { mask.remove(); resolve(null); } });
      document.body.appendChild(mask);
    });
  }

  global.PJ = global.PJ || {};
  Object.assign(global.PJ, {
    $, $$, uid, dayKey, parseDay, fmtTime, fmtFull, relTime, fmtBytes,
    escapeHtml, sanitize, excerpt, wordCount, debounce, throttle, clamp,
    sha256, toast, promptText, pickOption, WEEK, pad
  });
})(window);
