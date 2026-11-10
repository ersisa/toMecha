'use strict';
/* ================= 输入层：键盘 + 触摸虚拟按键 ================= */

const KEYMAP = {
  left:   ['KeyA', 'ArrowLeft'],
  right:  ['KeyD', 'ArrowRight'],
  jump:   ['KeyW', 'ArrowUp', 'Space'],
  attack: ['KeyJ', 'KeyF', 'KeyL'],
  block:  ['KeyK', 'KeyS', 'ArrowDown'],
};

class KeyInput {
  constructor() {
    this.down = new Set();
    this.pressed = new Set();
    addEventListener('keydown', (e) => {
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
      if (e.repeat) return;
      this.down.add(e.code);
      this.pressed.add(e.code);
    });
    addEventListener('keyup', (e) => this.down.delete(e.code));
    addEventListener('blur', () => this.down.clear());
  }
  anyDown(codes) { return codes.some((c) => this.down.has(c)); }
  anyPressed(codes) {
    let hit = false;
    for (const c of codes) if (this.pressed.has(c)) { this.pressed.delete(c); hit = true; }
    return hit;
  }
  consume(code) {
    if (this.pressed.has(code)) { this.pressed.delete(code); return true; }
    return false;
  }
}

class TouchInput {
  constructor() {
    this.held = { left: false, right: false, block: false };
    this.jumpEdgeFlag = false;
    this.attackEdgeFlag = false;
    this._safetyTimer = null;
    const isTouch = ('ontouchstart' in window) || navigator.maxTouchPoints > 0;
    if (isTouch) document.body.classList.add('touch');

    // 全局 stage 级 pointerup/cancel：防止手指滑出按钮后无法释放
    const stage = document.getElementById('stage');
    stage.addEventListener('pointerup', () => this._releaseAll());
    stage.addEventListener('pointercancel', () => this._releaseAll());

    document.querySelectorAll('#touch .tbtn').forEach((btn) => {
      const act = btn.dataset.act;
      const dn = (e) => {
        e.preventDefault();
        if (btn.setPointerCapture) { try { btn.setPointerCapture(e.pointerId); } catch (err) {} }
        btn.classList.add('on');
        if (act === 'jump') this.jumpEdgeFlag = true;
        else if (act === 'attack') this.attackEdgeFlag = true;
        else if (act in this.held) this.held[act] = true;
        this._resetSafetyTimer();
      };
      const up = (e) => {
        if (e && e.cancelable) e.preventDefault();
        btn.classList.remove('on');
        if (act in this.held) this.held[act] = false;
        this._resetSafetyTimer();
      };
      btn.addEventListener('pointerdown', dn);
      btn.addEventListener('pointerup', up);
      btn.addEventListener('pointercancel', up);
      btn.addEventListener('contextmenu', (e) => e.preventDefault());
    });
    stage.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  /* 安全释放：2.5 秒内无 pointerup 则强制释放所有按键，防止卡键 */
  _releaseAll() {
    this.held.left = false;
    this.held.right = false;
    this.held.block = false;
    document.querySelectorAll('#touch .tbtn.on').forEach((b) => b.classList.remove('on'));
    if (this._safetyTimer) { clearTimeout(this._safetyTimer); this._safetyTimer = null; }
  }
  _resetSafetyTimer() {
    if (this._safetyTimer) clearTimeout(this._safetyTimer);
    this._safetyTimer = setTimeout(() => this._releaseAll(), 2500);
  }
}

/* 统一本地输入：每帧 poll 出一个 InputState */
class LocalInput {
  constructor() { this.k = new KeyInput(); this.t = new TouchInput(); }
  poll() {
    const k = this.k, t = this.t;
    const s = {
      left:  k.anyDown(KEYMAP.left) || t.held.left,
      right: k.anyDown(KEYMAP.right) || t.held.right,
      block: k.anyDown(KEYMAP.block) || t.held.block,
      jumpEdge: false, attackEdge: false,
    };
    if (k.anyPressed(KEYMAP.jump) || t.jumpEdgeFlag) { s.jumpEdge = true; t.jumpEdgeFlag = false; }
    if (k.anyPressed(KEYMAP.attack) || t.attackEdgeFlag) { s.attackEdge = true; t.attackEdgeFlag = false; }
    return s;
  }
}
