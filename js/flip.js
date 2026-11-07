/* ═══════════════════════════════════════════════
   flip.js — 3D 纸张翻页引擎（弹簧物理版）
   · 半隐式欧拉弹簧积分（Apple 弹簧参数映射）
   · 拖拽跟手 / 松手速度移交 / 动量投射判定
   · 动画可中断：连点连翻（队列）
   · 拖拽回弹同样携带松手速度，纸面回弹自然
   ═══════════════════════════════════════════════ */
(function (global) {
  'use strict';

  const { clamp } = global.PJ;

  // Apple 官方参数映射：response(s) → 自然频率；zeta → 阻尼比
  const SPRING = {
    flip:   { zeta: 0.8,  response: 0.5  },  // 旋转动画：少量过冲，纸的"落定"感
    settle: { zeta: 0.9,  response: 0.42 },  // 回弹：更收敛
    cover:  { zeta: 0.8,  response: 0.6  }   // 封面：更大更慢
  };
  const THRESHOLD = 0.26;   // 位移阈值
  const MOMENTUM = 0.42;    // 动量投射系数（0.998 速率的等效位移秒数）

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
      this._queued = 0;
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

    /* ── 弹簧积分（半隐式欧拉，支持初速度 = 速度移交） ── */
    _spring(from, to, v0, cfg, cb) {
      this._cancel();
      this.leaf.style.transition = 'none';

      if (this.reduced) {
        this._apply(to);
        this.busy = false;
        cb && cb();
        return;
      }

      const w0 = (2 * Math.PI) / cfg.response;      // 自然频率 rad/s
      const k = w0 * w0;                             // 刚度（质量=1）
      const c = 2 * cfg.zeta * w0;                   // 阻尼

      let x = from;
      let v = v0 || 0;
      let last = performance.now();
      let elapsed = 0;

      const step = (now) => {
        const dt = Math.min((now - last) / 1000, 1 / 30);  // 步长上限防穿透
        last = now;
        elapsed += dt;

        const a = -k * (x - to) - c * v;
        v += a * dt;
        x += v * dt;
        this._apply(x);

        // 收敛：接近目标且速度衰减
        const settled = Math.abs(x - to) < 0.2 && Math.abs(v) < 15;
        // 兜底：极端参数下防永不收敛
        const timeout = elapsed > 2.2;
        if (settled || timeout) {
          this._apply(to);
          this.busy = false;
          cb && cb();
          return;
        }
        this.raf = requestAnimationFrame(step);
      };
      this.raf = requestAnimationFrame(step);
    }

    /* ── 下一页（按钮 / 键盘 / 队列）。busy 时排队 → 连点连翻 ── */
    goNext(nextHTML, underHTML, cb) {
      if (this.busy) { this._queued++; this._pendingDir = 1; return true; }
      this.busy = true;
      this._set(this.back, nextHTML);
      if (underHTML != null) this.setUnder(underHTML);
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

    /* ── 上一页 ── */
    goPrev(prevHTML, underHTML, cb) {
      if (this.busy) { this._queued++; this._pendingDir = -1; return true; }
      this.busy = true;

      // 当前页瞬时摆到背面：-180 时视觉内容不变，无闪烁
      this._set(this.back, this._curHTML);
      this._set(this.front, prevHTML);
      if (underHTML != null) this.setUnder(underHTML);
      this._apply(-180);

      this._spring(-180, 0, 0, SPRING.flip, () => {
        this._curHTML = prevHTML || '';
        this._set(this.back, '');
        cb && cb();
        this._drainQueue();
      });
      return true;
    }

    _drainQueue() {
      if (this._queued > 0) {
        this._queued--;
        const dir = this._pendingDir || 1;
        setTimeout(() => {
          this.opts.onQueued && this.opts.onQueued(dir);
        }, 24);
      }
    }

    /* ── 拖拽 ── */
    _bindDrag() {
      let active = false, dir = 0, startX = 0, startY = 0, W = 1;
      let moved = false;
      let lastT = 0, lastAngle = 0, vel = 0;   // deg/s

      const down = (e) => {
        if (this.busy) return;
        active = true; dir = 0; moved = false; vel = 0;
        startX = e.clientX; startY = e.clientY;
        W = this.book.clientWidth || 1;
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
          this._prepare(dir);
        }

        const p = dir === 1
          ? clamp(-dx / (W * 0.92), 0, 1)
          : clamp(dx / (W * 0.92), 0, 1);

        const angle = dir === 1 ? -180 * p : -180 + 180 * p;
        this._apply(angle);

        // 角速度采样（deg/s）
        const now = performance.now();
        const dt = now - lastT;
        if (dt > 12) {
          const inst = (angle - lastAngle) / (dt / 1000);
          vel = vel * 0.72 + inst * 0.28;    // 平滑
          lastAngle = angle;
          lastT = now;
        }
        if (e.cancelable) e.preventDefault();
      };

      const up = () => {
        if (!active) return;
        active = false;
        if (!moved) return;
        this.lastInteract = performance.now();

        const p = Math.abs(this.angle) / 180;
        const progress = dir === 1 ? p : 1 - p;

        // 动量投射：松手速度决定"看起来会停在哪"
        const projected = this.angle + vel * MOMENTUM;
        const passesMid = dir === 1 ? projected < -95 : projected > -85;
        const complete = progress > THRESHOLD || passesMid;

        if (complete) {
          if (dir === 1) this._finishNext(vel);
          else this._finishPrev(vel);
        } else {
          // 回弹：同样携带松手速度，纸会先顺着惯性走再弹回来
          const target = dir === 1 ? 0 : -180;
          this._spring(this.angle, target, vel, SPRING.settle, () => {
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

    _finishNext(vel) {
      const next = this.opts.getNextHTML ? this.opts.getNextHTML() : '';
      this._spring(this.angle, -180, vel, SPRING.flip, () => {
        this._curHTML = next || '';
        this._set(this.front, this._curHTML);
        this._set(this.back, '');
        this._apply(0);
        this.busy = false;
        this.opts.onFlip && this.opts.onFlip(1);
        this._drainQueue();
      });
    }

    _finishPrev(vel) {
      const prev = this.opts.getPrevHTML ? this.opts.getPrevHTML() : '';
      this._spring(this.angle, 0, vel, SPRING.flip, () => {
        this._curHTML = prev || '';
        this._set(this.back, '');
        this.busy = false;
        this.opts.onFlip && this.opts.onFlip(-1);
        this._drainQueue();
      });
    }

    /** 封面掀开：更大、更慢的弹簧 */
    springCover(el, openCls, ms) {
      el.classList.add(openCls);
      return new Promise(r => setTimeout(r, ms || 620));
    }
  }

  global.PJ = global.PJ || {};
  global.PJ.Flip = Flip;
})(window);
