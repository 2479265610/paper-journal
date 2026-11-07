/* ═══════════════════════════════════════════════
   flip.js — 3D 纸张翻页引擎
   拖拽跟手 / 方向预渲染不闪 / 动态光影 / 回弹
   ═══════════════════════════════════════════════ */
(function (global) {
  'use strict';

  const { clamp } = global.PJ;
  const DUR = 760;
  const THRESHOLD = 0.26;
  const VELOCITY = 0.40;

  const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

  class Flip {
    constructor(bookEl, opts) {
      this.book = bookEl;
      this.opts = opts || {};
      this.leaf = bookEl.querySelector('.leaf');
      this.front = bookEl.querySelector('.leaf-front');
      this.back = bookEl.querySelector('.leaf-back');
      this.under = bookEl.querySelector('.page-under');
      this.shadow = bookEl.querySelector('.flip-shadow');

      this.angle = 0;
      this.busy = false;
      this.raf = null;
      this._curHTML = '';
      this.lastInteract = 0;
      this.reduced = global.matchMedia &&
        global.matchMedia('(prefers-reduced-motion: reduce)').matches;

      this.leaf.style.transition = 'none';
      this._apply(0);
      this._bindDrag();
    }

    /* ── 内容 ── */
    _set(el, html) {
      el.innerHTML = (html || '') + '<div class="curve"></div>';
    }

    _apply(angle) {
      this.angle = angle;
      const p = Math.abs(angle) / 180;
      this.leaf.style.transform = `rotateY(${angle}deg)`;
      this.leaf.style.setProperty('--flip', p.toFixed(3));

      const shade = Math.sin(p * Math.PI);
      if (this.shadow) {
        this.shadow.style.opacity = (shade * 0.62).toFixed(3);
        this.shadow.style.transform = `scaleX(${(1 - shade * 0.12).toFixed(3)})`;
      }
      this.leaf.style.boxShadow =
        `${(-16 * shade).toFixed(1)}px 0 ${(34 * shade).toFixed(0)}px rgba(45,35,20,${(0.24 * shade).toFixed(3)})`;
    }

    setPage(html) {
      this._cancel();
      this._curHTML = html || '';
      this._set(this.front, this._curHTML);
      this._set(this.back, '');
      this._apply(0);
      this.busy = false;
    }

    setUnder(html) {
      if (this.under) this.under.innerHTML = html || '';
    }

    _cancel() {
      if (this.raf) { cancelAnimationFrame(this.raf); this.raf = null; }
    }

    _animate(from, to, cb) {
      this._cancel();
      this.leaf.style.transition = 'none';
      if (this.reduced) {
        this._apply(to);
        this.busy = false;
        cb && cb();
        return;
      }
      const t0 = performance.now();
      const span = to - from;
      const step = (now) => {
        const t = clamp((now - t0) / DUR, 0, 1);
        this._apply(from + span * easeInOut(t));
        if (t < 1) {
          this.raf = requestAnimationFrame(step);
        } else {
          this.raf = null;
          this._apply(to);
          this.busy = false;
          cb && cb();
        }
      };
      this.raf = requestAnimationFrame(step);
    }

    /* ── 下一页（按钮 / 键盘） ── */
    goNext(nextHTML, underHTML, cb) {
      if (this.busy) return false;
      this.busy = true;
      this._set(this.back, nextHTML);
      if (underHTML != null) this.setUnder(underHTML);
      this._apply(0);

      this._animate(0, -180, () => {
        this._curHTML = nextHTML || '';
        this._set(this.front, this._curHTML);
        this._set(this.back, '');
        this._apply(0);
        cb && cb();
      });
      return true;
    }

    /* ── 上一页 ── */
    goPrev(prevHTML, underHTML, cb) {
      if (this.busy) return false;
      this.busy = true;

      // 当前页放到背面：瞬间切到 -180 时视觉内容不变，不会闪
      this._set(this.back, this._curHTML);
      this._set(this.front, prevHTML);
      if (underHTML != null) this.setUnder(underHTML);
      this.leaf.style.transition = 'none';
      this._apply(-180);

      this._animate(-180, 0, () => {
        this._curHTML = prevHTML || '';
        this._set(this.back, '');
        cb && cb();
      });
      return true;
    }

    /* ── 拖拽 ── */
    _bindDrag() {
      let active = false, dir = 0, startX = 0, startY = 0, W = 1;
      let lastT = 0, lastP = 0, moved = false;

      const down = (e) => {
        if (this.busy || e.button === 2) return;
        active = true; dir = 0; moved = false;
        startX = e.clientX; startY = e.clientY;
        W = this.book.clientWidth || 1;
        lastT = performance.now(); lastP = 0;
      };

      const move = (e) => {
        if (!active) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;

        if (!moved) {
          if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
          if (Math.abs(dy) > Math.abs(dx) * 1.2) { active = false; return; }  // 竖向滚动
          moved = true;
          dir = dx < 0 ? 1 : -1;
          const can = dir === 1
            ? (this.opts.canNext && this.opts.canNext())
            : (this.opts.canPrev && this.opts.canPrev());
          if (!can) { active = false; return; }
          this.busy = true;
          this._prepare(dir);
        }

        const p = dir === 1
          ? clamp(-dx / (W * 0.92), 0, 1)
          : clamp(dx / (W * 0.92), 0, 1);

        this._apply(dir === 1 ? -180 * p : -180 + 180 * p);

        const now = performance.now();
        if (now - lastT > 32) { lastP = p; lastT = now; }
        if (e.cancelable) e.preventDefault();
      };

      const up = () => {
        if (!active) return;
        active = false;
        if (!moved) return;
        this.lastInteract = performance.now();

        const p = Math.abs(this.angle) / 180;
        const progress = dir === 1 ? p : 1 - p;
        const now = performance.now();
        const dt = Math.max(1, now - lastT);
        const vel = (p - lastP) / (dt / 1000);

        const complete = progress > THRESHOLD || (vel > VELOCITY && progress > 0.06);

        if (complete) {
          dir === 1 ? this._finishNext() : this._finishPrev();
        } else {
          const from = this.angle;
          this._animate(from, dir === 1 ? 0 : -180, () => {
            // 回到原位：恢复当前页
            this._set(this.front, this._curHTML);
            this._set(this.back, '');
            this._apply(0);
            this.busy = false;
            this.setUnder('');
          });
        }
      };

      this.book.addEventListener('pointerdown', down);
      global.addEventListener('pointermove', move, { passive: false });
      global.addEventListener('pointerup', up);
      global.addEventListener('pointercancel', up);
    }

    _prepare(dir) {
      if (dir === 1) {
        const next = this.opts.getNextHTML ? this.opts.getNextHTML() : '';
        this._set(this.back, next);
        this.setUnder(this.opts.getUnderHTML ? this.opts.getUnderHTML(1) : next);
        this._apply(0);
      } else {
        const prev = this.opts.getPrevHTML ? this.opts.getPrevHTML() : '';
        this._set(this.back, this._curHTML);
        this._set(this.front, prev);
        this.setUnder(this.opts.getUnderHTML ? this.opts.getUnderHTML(-1) : prev);
        this._apply(-180);
      }
    }

    _finishNext() {
      const next = this.opts.getNextHTML ? this.opts.getNextHTML() : '';
      this._animate(this.angle, -180, () => {
        this._curHTML = next || '';
        this._set(this.front, this._curHTML);
        this._set(this.back, '');
        this._apply(0);
        this.busy = false;
        this.opts.onFlip && this.opts.onFlip(1);
      });
    }

    _finishPrev() {
      const prev = this.opts.getPrevHTML ? this.opts.getPrevHTML() : '';
      this._animate(this.angle, 0, () => {
        this._curHTML = prev || '';
        this._set(this.back, '');
        this.busy = false;
        this.opts.onFlip && this.opts.onFlip(-1);
      });
    }
  }

  global.PJ = global.PJ || {};
  global.PJ.Flip = Flip;
})(window);
