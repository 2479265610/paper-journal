/* ═══════════════════════════════════════════════
   flip.js — 3D 翻页引擎（双页摊开 · 弹簧物理）
   几何：纸绕中缝（书脊）翻转
     · 下一页：纸在右半，绕左边缘（中缝）0° → -180°，落在左半
     · 上一页：纸在左半，绕右边缘（中缝）0° → -180°，落回右半
   窄屏退化为单页翻页（纸占满整页，走独立分支）
   弹簧：Apple 参数（ζ=0.8/0.5s），拖拽松手速度移交 + 动量投射
   ═══════════════════════════════════════════════ */
(function (global) {
  'use strict';

  const { clamp } = global.PJ;

  const SPRING = {
    flip:   { zeta: 0.8, response: 0.5 },
    settle: { zeta: 0.9, response: 0.42 }
  };
  const THRESHOLD = 0.26;
  const MOMENTUM = 0.42;

  class Flip {
    constructor(bookEl, opts) {
      this.book = bookEl;
      this.opts = opts || {};
      this.leaf = bookEl.querySelector('.leaf');
      this.front = bookEl.querySelector('.leaf-front');
      this.back = bookEl.querySelector('.leaf-back');
      this.left = bookEl.querySelector('.page-left');
      this.under = bookEl.querySelector('.page-under');
      this.shadow = bookEl.querySelector('.flip-shadow');

      this.angle = 0;
      this.busy = false;
      this.raf = null;
      this._curHTML = '';
      this._queued = 0;
      this.lastInteract = 0;
      this.reduced = global.matchMedia &&
        global.matchMedia('(prefers-reduced-motion: reduce)').matches;

      this.leaf.style.transition = 'none';
      this._apply(0);
      this._bindDrag();
    }

    get spread() { return global.innerWidth > 820; }

    /* ── 内容 ── */
    _set(el, html) {
      if (!el) return;
      el.innerHTML = (html || '') + '<div class="curve"></div>';
    }

    _apply(angle) {
      this.angle = angle;
      const p = Math.abs(angle) / 180;
      this.leaf.style.transform = `rotateY(${angle}deg)`;
      this.leaf.style.setProperty('--flip', p.toFixed(3));

      const shade = Math.sin(p * Math.PI);
      if (this.shadow) {
        this.shadow.style.opacity = (shade * 0.5).toFixed(3);
      }
      this.leaf.style.boxShadow =
        `${(-14 * shade).toFixed(1)}px 0 ${(30 * shade).toFixed(0)}px rgba(45,35,20,${(0.22 * shade).toFixed(3)})`;
    }

    /** 设置跨页：右页（当前页）+ 左页（上一篇） */
    setSpread(currentHTML, leftHTML) {
      this._cancel();
      this._curHTML = currentHTML || '';
      this.leaf.classList.remove('to-left');
      this._set(this.front, this._curHTML);
      this._set(this.back, '');
      this._set(this.left, leftHTML || '');
      this._set(this.under, '');
      this._apply(0);
      this.busy = false;
    }

    /** 兼容旧调用：只设右页 */
    setPage(html) { this.setSpread(html, ''); }
    setUnder(html) { this._set(this.under, html || ''); }

    _cancel() {
      if (this.raf) { cancelAnimationFrame(this.raf); this.raf = null; }
    }

    _spring(from, to, v0, cfg, cb) {
      this._cancel();
      this.leaf.style.transition = 'none';

      if (this.reduced) {
        this._apply(to);
        this.busy = false;
        cb && cb();
        return;
      }

      const w0 = (2 * Math.PI) / cfg.response;
      const k = w0 * w0;
      const c = 2 * cfg.zeta * w0;

      let x = from;
      let v = v0 || 0;
      let last = performance.now();
      let elapsed = 0;

      const step = (now) => {
        const dt = Math.min((now - last) / 1000, 1 / 30);
        last = now;
        elapsed += dt;

        const a = -k * (x - to) - c * v;
        v += a * dt;
        x += v * dt;
        this._apply(x);

        if ((Math.abs(x - to) < 0.2 && Math.abs(v) < 15) || elapsed > 2.2) {
          this._apply(to);
          this.busy = false;
          cb && cb();
          return;
        }
        this.raf = requestAnimationFrame(step);
      };
      this.raf = requestAnimationFrame(step);
    }

    /* ── 下一页：纸从右翻到左 ── */
    goNext(nextHTML, underHTML, cb) {
      if (this.busy) { this._queued++; this._pendingDir = 1; return true; }
      this.busy = true;

      this.leaf.classList.remove('to-left');
      this._set(this.back, nextHTML);
      if (underHTML != null) this._set(this.under, underHTML);
      this._apply(0);

      this._spring(0, -180, 0, SPRING.flip, () => {
        this._curHTML = nextHTML || '';
        this._set(this.front, this._curHTML);
        this._set(this.back, '');
        this._apply(0);
        cb && cb();
        this._drainQueue();
      });
      return true;
    }

    /* ── 上一页：纸从左翻回右 ── */
    goPrev(prevHTML, priorHTML, cb) {
      if (this.busy) { this._queued++; this._pendingDir = -1; return true; }

      if (!this.spread) {
        this.busy = true;
        this.leaf.classList.remove('to-left');
        this._set(this.back, this._curHTML);
        this._set(this.front, prevHTML);
        this._apply(-180);
        this._spring(-180, 0, 0, SPRING.flip, () => {
          this._curHTML = prevHTML || '';
          this._set(this.back, '');
          cb && cb();
          this._drainQueue();
        });
        return true;
      }

      this.busy = true;
      // 纸移到左半，正面盖住左页（内容相同，无闪烁），翻过中缝后背面仍是这一页
      this.leaf.classList.add('to-left');
      this._set(this.front, prevHTML);
      this._set(this.back, prevHTML);
      if (priorHTML != null) this._set(this.left, priorHTML);
      this._apply(0);

      this._spring(0, -180, 0, SPRING.flip, () => {
        this._curHTML = prevHTML || '';
        cb && cb();
        this._drainQueue();
      });
      return true;
    }

    _drainQueue() {
      if (this._queued > 0) {
        this._queued--;
        const dir = this._pendingDir || 1;
        setTimeout(() => { this.opts.onQueued && this.opts.onQueued(dir); }, 24);
      }
    }

    /* ── 拖拽 ── */
    _bindDrag() {
      let active = false, dir = 0, startX = 0, startY = 0, span = 1;
      let moved = false;
      let lastT = 0, lastAngle = 0, vel = 0;
      let fromAngle = 0, toAngle = 0;

      const down = (e) => {
        if (this.busy) return;
        active = true; dir = 0; moved = false; vel = 0;
        startX = e.clientX; startY = e.clientY;
        span = this.spread ? (this.book.clientWidth / 2) : this.book.clientWidth;
        lastT = performance.now();
        lastAngle = this.angle;
      };

      const move = (e) => {
        if (!active) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;

        if (!moved) {
          if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
          if (Math.abs(dy) > Math.abs(dx) * 1.2) { active = false; return; }
          moved = true;
          dir = dx < 0 ? 1 : -1;
          const can = dir === 1
            ? (this.opts.canNext && this.opts.canNext())
            : (this.opts.canPrev && this.opts.canPrev());
          if (!can) { active = false; return; }
          this.busy = true;
          fromAngle = (!this.spread && dir === -1) ? -180 : 0;
          toAngle = (!this.spread && dir === -1) ? 0 : -180;
          this._prepare(dir);
        }

        const p = clamp(Math.abs(dx) / span, 0, 1);
        this._apply(fromAngle + (toAngle - fromAngle) * p);

        const now = performance.now();
        const dt = now - lastT;
        if (dt > 12) {
          const inst = (this.angle - lastAngle) / (dt / 1000);
          vel = vel * 0.72 + inst * 0.28;
          lastAngle = this.angle;
          lastT = now;
        }
        if (e.cancelable) e.preventDefault();
      };

      const up = () => {
        if (!active) return;
        active = false;
        if (!moved) return;
        this.lastInteract = performance.now();

        const p = Math.abs(this.angle - fromAngle) / Math.abs((toAngle - fromAngle) || 1);
        const projected = this.angle + vel * MOMENTUM;
        const passes = toAngle === -180 ? projected < -95 : projected > -85;
        const complete = p > THRESHOLD || passes;

        if (complete) {
          this._spring(this.angle, toAngle, vel, SPRING.flip, () => {
            this.busy = false;
            if (this.opts.onFlip) this.opts.onFlip(dir);
            this._drainQueue();
          });
        } else {
          this._spring(this.angle, fromAngle, vel, SPRING.settle, () => {
            this.leaf.classList.remove('to-left');
            this._set(this.back, '');
            this._set(this.under, '');
            this._apply(0);
            this.busy = false;
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
        this.leaf.classList.remove('to-left');
        const next = this.opts.getNextHTML ? this.opts.getNextHTML() : '';
        this._set(this.back, next);
        this.setUnder(next);
        this._apply(0);
      } else {
        const prev = this.opts.getPrevHTML ? this.opts.getPrevHTML() : '';
        const prior = this.opts.getPriorHTML ? this.opts.getPriorHTML() : '';
        if (this.spread) {
          this.leaf.classList.add('to-left');
          this._set(this.front, prev);
          this._set(this.back, prev);
          this._set(this.left, prior);
          this._apply(0);
        } else {
          this.leaf.classList.remove('to-left');
          this._set(this.back, this._curHTML);
          this._set(this.front, prev);
          this._apply(-180);
        }
      }
    }
  }

  global.PJ = global.PJ || {};
  global.PJ.Flip = Flip;
})(window);
