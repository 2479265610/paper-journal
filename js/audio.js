/* ═══════════════════════════════════════════════
   audio.js — 纸张摩擦声（Web Audio 实时合成，无音频文件）
   ═══════════════════════════════════════════════ */
(function (global) {
  'use strict';

  const Sound = {
    ctx: null,
    noise: null,
    enabled: true,
    _last: 0,

    /** 必须在用户手势中调用一次以解锁音频 */
    unlock() {
      if (!this.ctx) {
        const AC = global.AudioContext || global.webkitAudioContext;
        if (!AC) return;
        try { this.ctx = new AC(); } catch (e) { return; }
        this._buildNoise();
      }
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    },

    _buildNoise() {
      const sr = this.ctx.sampleRate;
      const len = Math.floor(sr * 1.2);
      const buf = this.ctx.createBuffer(1, len, sr);
      const d = buf.getChannelData(0);
      // 粉噪声近似 + 轻微颗粒（模拟纤维摩擦）
      let b0 = 0, b1 = 0, b2 = 0;
      for (let i = 0; i < len; i++) {
        const white = Math.random() * 2 - 1;
        b0 = 0.99765 * b0 + white * 0.0990460;
        b1 = 0.96300 * b1 + white * 0.2965164;
        b2 = 0.57000 * b2 + white * 1.0526913;
        let v = (b0 + b1 + b2 + white * 0.1848) * 0.16;
        // 随机微爆点：纸张纤维的爆裂感
        if (Math.random() < 0.0009) v += (Math.random() - 0.5) * 0.55;
        d[i] = Math.max(-1, Math.min(1, v));
      }
      this.noise = buf;
    },

    /**
     * 播放一次翻纸声
     * @param {object} o { strength: 0..1, low: bool }
     */
    rustle(o) {
      if (!this.enabled) return;
      if (!this.ctx) this.unlock();
      if (!this.ctx || !this.noise) return;

      const now = this.ctx.currentTime;
      if (now - this._last < 0.045) return;   // 防抖
      this._last = now;

      const st = Math.max(0.05, Math.min(1, (o && o.strength) || 0.55));
      const low = !!(o && o.low);

      const dur = low ? 0.19 : 0.13 + st * 0.16;

      const src = this.ctx.createBufferSource();
      src.buffer = this.noise;
      src.playbackRate.value = 0.85 + Math.random() * 0.4;

      const bp = this.ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = low ? 1500 + Math.random() * 700 : 2400 + Math.random() * 2200;
      bp.Q.value = 0.7 + Math.random() * 0.5;

      const hp = this.ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 620;

      const g = this.ctx.createGain();
      const peak = 0.055 + st * 0.115;

      g.gain.setValueAtTime(0.0001, now);
      g.gain.exponentialRampToValueAtTime(peak, now + 0.016);
      g.gain.exponentialRampToValueAtTime(peak * 0.42, now + dur * 0.42);
      g.gain.exponentialRampToValueAtTime(0.0001, now + dur);

      src.connect(bp);
      bp.connect(hp);
      hp.connect(g);
      g.connect(this.ctx.destination);

      const off = Math.random() * 0.7;
      src.start(now, off, dur + 0.02);

      // 收尾的一点"落纸"闷响
      if (!low && st > 0.35) {
        const t2 = now + dur * 0.72;
        const s2 = this.ctx.createBufferSource();
        s2.buffer = this.noise;
        s2.playbackRate.value = 0.5;
        const lp = this.ctx.createBiquadFilter();
        lp.type = 'lowpass'; lp.frequency.value = 900;
        const g2 = this.ctx.createGain();
        g2.gain.setValueAtTime(0.0001, t2);
        g2.gain.exponentialRampToValueAtTime(peak * 0.5, t2 + 0.012);
        g2.gain.exponentialRampToValueAtTime(0.0001, t2 + 0.1);
        s2.connect(lp); lp.connect(g2); g2.connect(this.ctx.destination);
        s2.start(t2, Math.random() * 0.5, 0.14);
      }
    },

    /** 轻触反馈 */
    tap() {
      if (!this.enabled) return;
      if (!this.ctx) this.unlock();
      if (!this.ctx) return;
      const now = this.ctx.currentTime;
      const o = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      o.type = 'sine';
      o.frequency.setValueAtTime(680, now);
      o.frequency.exponentialRampToValueAtTime(420, now + 0.07);
      g.gain.setValueAtTime(0.0001, now);
      g.gain.exponentialRampToValueAtTime(0.028, now + 0.006);
      g.gain.exponentialRampToValueAtTime(0.0001, now + 0.09);
      o.connect(g); g.connect(this.ctx.destination);
      o.start(now); o.stop(now + 0.1);
    }
  };

  global.PJ = global.PJ || {};
  global.PJ.Sound = Sound;
})(window);
