'use strict';
/* ================= 场景 / 背景墙 / 随机地图生成 / 空投 / 投射物 / 特效 =================
 * 地图由种子（mulberry32）确定：房主生成种子并广播，所有客户端生成完全一致的
 * 平台布局 + 塔身结构 + 背景墙元素 + 武器点位。
 */

/* ---------- 粒子与飘字特效 ---------- */
class FX {
  constructor() { this.particles = []; this.popups = []; }
  spawn(x, y, opts) {
    this.particles.push(Object.assign({
      x, y, vx: 0, vy: 0, life: 0.4, maxLife: 0.4, size: 3, color: '#fff', gravity: 0, drag: 0.9,
    }, opts));
  }
  burst(x, y, color, n, speed) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = speed * (0.4 + Math.random() * 0.8);
      this.spawn(x, y, {
        color, vx: Math.cos(a) * s, vy: Math.sin(a) * s,
        life: 0.35, maxLife: 0.35, size: 1.5 + Math.random() * 2.5, gravity: 300,
      });
    }
  }
  popup(x, y, text, color) { this.popups.push({ x, y, text, color, life: 0.7, maxLife: 0.7 }); }
  update(dt) {
    for (const p of this.particles) {
      p.life -= dt; p.vy += p.gravity * dt;
      p.x += p.vx * dt; p.y += p.vy * dt;
      p.vx *= p.drag; p.vy *= p.drag;
    }
    this.particles = this.particles.filter((p) => p.life > 0);
    for (const t of this.popups) { t.life -= dt; t.y -= 24 * dt; }
    this.popups = this.popups.filter((t) => t.life > 0);
  }
  draw(ctx) {
    for (const p of this.particles) {
      ctx.globalAlpha = Math.max(0, p.life / p.maxLife);
      ctx.fillStyle = p.color;
      ctx.fillRect(Math.round(p.x - p.size / 2), Math.round(p.y - p.size / 2), p.size, p.size);
    }
    ctx.globalAlpha = 1;
    for (const t of this.popups) {
      ctx.globalAlpha = Math.max(0, t.life / t.maxLife);
      ctx.font = 'bold 9px "Courier New", monospace';
      ctx.textAlign = 'center';
      ctx.fillStyle = t.color;
      ctx.fillText(t.text, t.x, t.y);
    }
    ctx.globalAlpha = 1;
  }
}

/* ---------- 背景墙元素（多样化装饰，地图生成的原子单位） ---------- */
const WALL_KINDS = ['panel', 'window', 'pipe', 'vent', 'screen', 'tank', 'lamp'];

const WallElem = {
  /* 铆钉金属板 */
  panel(ctx, x, y, w, h) {
    ctx.fillStyle = '#191930'; ctx.fillRect(x, y, w, h);
    ctx.fillStyle = '#232342'; ctx.fillRect(x + 2, y + 2, w - 4, 2);
    ctx.fillStyle = '#101024'; ctx.fillRect(x + 2, y + h - 4, w - 4, 2);
    ctx.fillStyle = '#31315c';
    ctx.fillRect(x + 3, y + 3, 2, 2);
    ctx.fillRect(x + w - 5, y + 3, 2, 2);
    ctx.fillRect(x + 3, y + h - 5, 2, 2);
    ctx.fillRect(x + w - 5, y + h - 5, 2, 2);
  },
  /* 发光窗户 */
  window(ctx, x, y, w, h, t, ph) {
    ctx.fillStyle = '#101024'; ctx.fillRect(x, y, w, h);
    const on = 0.5 + 0.5 * Math.sin(t * 1.2 + ph * 7);
    ctx.globalAlpha = 0.45 + 0.3 * on;
    ctx.fillStyle = ph % 2 < 1 ? '#3d8bff' : '#ff8f4f';
    const mw = (w - 6) / 2, mh = (h - 6) / 2;
    ctx.fillRect(x + 3, y + 3, mw - 1, mh - 1);
    ctx.fillRect(x + 4 + mw, y + 3, mw - 1, mh - 1);
    ctx.fillRect(x + 3, y + 4 + mh, mw - 1, mh - 1);
    ctx.globalAlpha = 0.85;
    ctx.fillRect(x + 4 + mw, y + 4 + mh, mw - 1, mh - 1);
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#2a2a50'; ctx.fillRect(x + 2, y + h / 2 - 1, w - 4, 2);
  },
  /* 管道 */
  pipe(ctx, x, y, w, h) {
    ctx.fillStyle = '#23233f'; ctx.fillRect(x, y, w, h);
    ctx.fillStyle = '#33335c'; ctx.fillRect(x, y + 1, w, 2);
    ctx.fillStyle = '#14142c'; ctx.fillRect(x, y + h - 3, w, 2);
    ctx.fillStyle = '#3a3a68';
    ctx.fillRect(x + 2, y + h / 2 - 2, 4, 4);
    ctx.fillRect(x + w - 6, y + h / 2 - 2, 4, 4);
    if (h > 40) {
      ctx.fillStyle = '#2a2a4c';
      ctx.fillRect(x, y + h * 0.3, w, 3);
      ctx.fillRect(x, y + h * 0.65, w, 3);
    }
  },
  /* 通风扇（旋转动画） */
  vent(ctx, x, y, w, h, t, ph) {
    ctx.fillStyle = '#15152a'; ctx.fillRect(x, y, w, h);
    const cx = x + w / 2, cy = y + h / 2, r = Math.min(w, h) / 2 - 3;
    ctx.fillStyle = '#0c0c1a';
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
    const a = t * (2 + ph) + ph * 3;
    ctx.strokeStyle = '#3d3d6e'; ctx.lineWidth = 2;
    for (let i = 0; i < 3; i++) {
      const ang = a + (i * Math.PI * 2) / 3;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(ang) * r * 0.85, cy + Math.sin(ang) * r * 0.85);
      ctx.stroke();
    }
    ctx.fillStyle = '#4a4a7c'; ctx.fillRect(cx - 2, cy - 2, 4, 4);
    ctx.strokeStyle = '#2a2a4e'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
  },
  /* 数据大屏（闪烁） */
  screen(ctx, x, y, w, h, t, ph) {
    ctx.fillStyle = '#0c0c1c'; ctx.fillRect(x, y, w, h);
    const on = Math.sin(t * 3 + ph * 5) > -0.4;
    ctx.fillStyle = on ? '#0f4a3a' : '#0c2a24';
    ctx.fillRect(x + 2, y + 2, w - 4, h - 4);
    if (on) {
      ctx.fillStyle = '#2fdba0';
      for (let i = 0; i < 4; i++) {
        const bw = ((w - 8) * ((Math.sin(t * 2 + i * 1.7 + ph) + 1) / 2)) | 0;
        ctx.fillRect(x + 4, y + 5 + i * ((h - 10) / 4), Math.max(2, bw), 2);
      }
      ctx.fillStyle = '#9fffd8'; ctx.fillRect(x + 4, y + 4, 3, 2);
    }
    ctx.fillStyle = '#2a2a50'; ctx.fillRect(x, y, w, 2); ctx.fillRect(x, y + h - 2, w, 2);
  },
  /* 储气罐 */
  tank(ctx, x, y, w, h) {
    ctx.fillStyle = '#1d1d38'; ctx.fillRect(x + 2, y, w - 4, h);
    ctx.fillStyle = '#2c2c52'; ctx.fillRect(x + 2, y + 1, w - 4, 2);
    ctx.fillStyle = '#111124'; ctx.fillRect(x + 2, y + h - 3, w - 4, 2);
    ctx.strokeStyle = '#34345e'; ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x + 2, y + h / 2); ctx.lineTo(x + w - 2, y + h / 2);
    ctx.moveTo(x + 2, y + h / 4); ctx.lineTo(x + w - 2, y + h / 4);
    ctx.stroke();
    ctx.fillStyle = '#ffd23f'; ctx.fillRect(x + w / 2 - 2, y + h / 2 - 2, 4, 4);
    ctx.fillStyle = '#15152a'; ctx.fillRect(x, y + h * 0.2, 3, h * 0.6);
    ctx.fillRect(x + w - 3, y + h * 0.2, 3, h * 0.6);
  },
  /* 灯柱 */
  lamp(ctx, x, y, w, h, t, ph) {
    ctx.fillStyle = '#1a1a30'; ctx.fillRect(x + w / 2 - 2, y + 4, 4, h - 4);
    ctx.fillStyle = '#262644'; ctx.fillRect(x + w / 2 - 4, y, 8, 5);
    const on = 0.6 + 0.4 * Math.sin(t * 5 + ph * 9);
    ctx.globalAlpha = on;
    ctx.fillStyle = '#ffe9a0';
    ctx.fillRect(x + w / 2 - 3, y + 5, 6, 3);
    ctx.globalAlpha = on * 0.25;
    ctx.fillRect(x + w / 2 - 6, y + 8, 12, 8);
    ctx.globalAlpha = 1;
  },
};

function drawWallElem(ctx, kind, x, y, w, h, t, ph) {
  (WallElem[kind] || WallElem.panel)(ctx, x, y, w, h, t || 0, ph || 0);
}

/* ---------- 随机地图生成（种子驱动） ----------
 * 结构：分层平台（保证层间高差可二段跳抵达）+ 塔身/悬臂结构装饰 + 背景墙网格
 * 层高约束：离散物理（半隐式欧拉）下二段跳实际最大爬升 ≈117px
 * （理论 124px，积分误差 -7px），故所有层差上限设为 112px，留 5px 落台余量：
 *   地面660 → L1[548,564] 最大差 112 ✓
 *   L1 → L2[462,478] 最大差 102 ✓   L2 → L3[382,398] 最大差 96 ✓
 *   L3 → L4[298,314] 最大差 100 ✓   全部可达
 */
class GameMap {
  constructor(seed) {
    this.seed = seed >>> 0;
    this.platforms = [];   // { x, y, w } 可站立平台（单向）
    this.structs = [];     // { x, y, w, style, cells:[{kind,ox,oy,w,h,ph}] } 平台下方结构装饰
    this.pads = [];        // { x, y, weapon } 固定武器点位
    this.bgWalls = [];     // 背景墙元素（视差层）
    this.generate();
  }

  generate() {
    const R = mulberry32(this.seed);
    const W = WORLD.w;

    /* --- 分层平台生成（上层挂靠下层平台，保证整图可达） ---
     * 底层 L1 靠地面支撑（rise ≤112）；L2~L4 的每个平台挂靠一个下层平台，
     * 中心偏移 ≤130px → 与支撑平台的水平间隙 ≤ ~20px，一跳（水平漂移 ≤200px）必达。 */
    const layers = [
      { y: 556, jit: 8, n: R() < 0.5 ? 3 : 2, edge: true },    // 底层：保证两端有平台
      { y: 470, jit: 8, n: R() < 0.45 ? 3 : 2 },
      { y: 390, jit: 8, n: 2 },
      { y: 306, jit: 8, n: R() < 0.55 ? 2 : 1 },               // 顶层
    ];
    let lower = null;
    for (let li = 0; li < layers.length; li++) {
      const L = layers[li];
      const cur = [];
      for (let i = 0; i < L.n; i++) {
        const w = Math.round(110 + R() * 150);
        let cx;
        if (li === 0) {
          const seg = W / L.n;
          if (L.edge && i === 0) cx = 60 + w / 2 + R() * 40;                 // 左端
          else if (L.edge && i === L.n - 1) cx = W - 60 - w / 2 - R() * 40;  // 右端
          else cx = seg * i + seg / 2 + (R() - 0.5) * seg * 0.34;
        } else {
          /* 挂靠下层平台：间隙 ≤ ~20px */
          const sup = lower[Math.floor(i * lower.length / L.n)];
          cx = sup.x + sup.w / 2 + (R() - 0.5) * 260;
        }
        /* 层内防重叠（保持 ≥36px 间隙，可同层跳跃跨越） */
        for (let k = 0; k < 8; k++) {
          const clash = cur.find((p) => Math.abs(cx - (p.x + p.w / 2)) < (w + p.w) / 2 + 36);
          if (!clash) break;
          const cc = clash.x + clash.w / 2;
          const sgn = cx >= cc ? 1 : -1;
          cx = cc + sgn * ((w + clash.w) / 2 + 40 + R() * 30);
        }
        const x = clamp(cx - w / 2, 24, W - 24 - w);
        const y = L.y + Math.round((R() - 0.5) * L.jit);
        const plat = { x: Math.round(x), y: Math.round(y), w };
        cur.push(plat);
        this.platforms.push(plat);
      }
      lower = cur;
    }

    /* --- 每个平台生成结构装饰（塔身到地面 / 悬臂斜撑） --- */
    for (const p of this.platforms) {
      const style = R() < 0.55 ? 'tower' : 'wing';
      const cells = [];
      if (style === 'tower') {
        /* 塔身：从平台下沿铺墙元素到地面 */
        const tw = Math.max(46, p.w - 16 - Math.round(R() * 30));
        const tx = p.x + Math.round((p.w - tw) / 2);
        const th = WORLD.groundY - (p.y + 8);
        for (let cy = p.y + 12; cy < WORLD.groundY - 8; cy += 44) {
          const ch = Math.min(44, WORLD.groundY - cy - 2);
          const r = R();
          const kind = r < 0.3 ? 'panel' : r < 0.5 ? 'window' : r < 0.65 ? 'pipe'
            : r < 0.78 ? 'vent' : r < 0.88 ? 'screen' : 'tank';
          cells.push({ kind, ox: tx - p.x, oy: cy - p.y, w: tw, h: ch, ph: Math.floor(R() * 10) });
        }
      } else {
        /* 悬臂：平台下方短立柱 + 斜撑梁 */
        const pw = 12 + Math.round(R() * 8);
        const ph1 = 26 + Math.round(R() * 22);
        cells.push({ kind: 'pipe', ox: p.w * 0.2, oy: 8, w: pw, h: ph1, ph: 0 });
        cells.push({ kind: 'pipe', ox: p.w * 0.8 - pw, oy: 8, w: pw, h: ph1, ph: 1 });
        const lw = Math.round(p.w * 0.7);
        cells.push({ kind: 'beam', ox: (p.w - lw) / 2, oy: 8 + ph1 - 6, w: lw, h: 8, ph: 0 });
      }
      this.structs.push({ ...p, style, cells });
    }

    /* --- 固定武器点位：随机挑 3~5 个平台放置（不同层优先） --- */
    const pool = this.platforms.map((p, i) => ({ p, i, layer: Math.floor(i / 1) }))
      .sort(() => R() - 0.5);
    const nPads = 3 + Math.floor(R() * 3);
    const usedIdx = new Set();
    for (let k = 0; k < pool.length && this.pads.length < nPads; k++) {
      const cand = pool[k];
      if (usedIdx.has(cand.i)) continue;
      usedIdx.add(cand.i);
      const p = cand.p;
      const weapon = (this.pads.length % 2 === 0) ? 'ray' : 'plasma';
      this.pads.push({
        x: Math.round(p.x + p.w / 2 + (R() - 0.5) * p.w * 0.4),
        y: p.y, weapon,
      });
    }

    /* --- 背景墙网格（视差 0.65 层，覆盖地图全域） --- */
    const bgW = W * 0.65 + 500;
    const cell = 74;
    for (let gx = -40; gx < bgW; gx += cell) {
      for (let gy = 60; gy < WORLD.groundY - 30; gy += cell) {
        if (R() > 0.42) continue;
        const kind = WALL_KINDS[Math.floor(R() * WALL_KINDS.length)];
        const w = 30 + Math.round(R() * 26);
        const h = 30 + Math.round(R() * 30);
        this.bgWalls.push({
          kind, x: Math.round(gx + R() * 14), y: Math.round(gy + R() * 14),
          w, h, ph: Math.floor(R() * 12),
        });
      }
    }
  }

  /* 平台顶面绘制（含结构装饰，位于机甲身后） */
  drawStructures(ctx, t) {
    for (const s of this.structs) {
      /* 结构体（背景墙风格） */
      for (const c of s.cells) {
        const cx = s.x + c.ox, cy = s.y + c.oy;
        if (c.kind === 'beam') {
          ctx.fillStyle = '#20203a'; ctx.fillRect(cx, cy, c.w, c.h);
          ctx.fillStyle = '#2c2c4e'; ctx.fillRect(cx, cy, c.w, 2);
          ctx.strokeStyle = '#282848'; ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(s.x + 6, s.y + 12); ctx.lineTo(cx + 8, cy + 4);
          ctx.moveTo(s.x + s.w - 6, s.y + 12); ctx.lineTo(cx + c.w - 8, cy + 4);
          ctx.stroke();
        } else {
          ctx.globalAlpha = 0.9;
          drawWallElem(ctx, c.kind, cx, cy, c.w, c.h, t, c.ph);
          ctx.globalAlpha = 1;
        }
      }
      /* 平台主体：更深更有存在感 */
      ctx.fillStyle = '#2a2a4a'; ctx.fillRect(s.x - 2, s.y, s.w + 4, 12);
      /* 顶部亮边（高对比度，玩家能看清平台位置） */
      ctx.fillStyle = '#5a5a8a'; ctx.fillRect(s.x - 2, s.y, s.w + 4, 3);
      /* 金属高光 */
      ctx.fillStyle = '#7878b8'; ctx.fillRect(s.x - 2, s.y, s.w + 4, 1);
      /* 底部暗边 */
      ctx.fillStyle = '#1a1a32'; ctx.fillRect(s.x - 2, s.y + 10, s.w + 4, 2);
      /* 铆钉装饰 */
      ctx.fillStyle = '#6a6a9a';
      for (let rx = s.x + 8; rx < s.x + s.w - 4; rx += 28) {
        ctx.fillRect(rx, s.y + 5, 3, 3);
      }
      /* 平台底部悬挂装饰线条 */
      ctx.fillStyle = '#33335a';
      ctx.fillRect(s.x, s.y + 12, s.w, 2);
    }
  }

  /* 背景墙（视差层） */
  drawBgWalls(ctx, cam, t) {
    const off = cam.x * 0.65, offY = cam.y * 0.5;
    ctx.save();
    ctx.translate(-Math.round(off), -Math.round(offY));
    ctx.globalAlpha = 0.55;
    for (const w of this.bgWalls) {
      drawWallElem(ctx, w.kind, w.x, w.y, w.w, w.h, t, w.ph);
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }
}

/* ---------- 游戏世界（多机甲） ---------- */
class World {
  constructor(game, map) {
    this.game = game;
    this.map = map;
    this.drops = [];   // 空投箱
    this.projs = [];   // 等离子投射物
    this.beams = [];   // 光线枪射线
    this.pads = map.pads.map((p) => ({ ...p, timer: 0 }));
    this.spawnT = rand(3, 6);
  }

  get platforms() { return this.map.platforms; }

  /* 空投箱落地高度检测（py→ny 之间是否落在平台顶或地面） */
  dropLandY(x, py, ny) {
    if (ny >= WORLD.groundY) return WORLD.groundY;
    for (const pl of this.map.platforms) {
      if (x > pl.x && x < pl.x + pl.w && py <= pl.y && ny >= pl.y) return pl.y;
    }
    return null;
  }

  spawnDrop() {
    const r = Math.random();
    let content;
    if (r < 0.45) content = { kind: 'weapon', id: choice(['ray', 'plasma']) };
    else if (r < 0.75) content = { kind: 'item', id: 'medkit' };
    else if (r < 0.9) content = { kind: 'item', id: 'shield' };
    else content = { kind: 'item', id: 'boost' };
    this.drops.push({ x: rand(80, WORLD.w - 80), y: -16, vy: 0, landed: false, life: 12, content });
  }

  applyDrop(m, d, fx) {
    const c = d.content;
    if (c.kind === 'weapon') {
      m.equip(WEAPONS[c.id]);
      fx.popup(m.x, m.y - 52, WEAPONS[c.id].name + '!', '#9fe8ff');
    } else {
      const it = ITEMS[c.id];
      m.applyItem(it);
      fx.popup(m.x, m.y - 52, it.name + '!', '#9fdba0');
    }
    fx.burst(d.x, d.y, '#ffd23f', 8, 90);
  }

  /* 光线枪：对所有敌人求最近命中 */
  fireRay(m, enemies, fx) {
    const w = m.weapon, ox = m.x + m.facing * 17, oy = m.y - 27;
    let range = w.range;
    /* 远射：射程+50% */
    if (m.skill === 'longshot') range *= 1.5;
    let len = range, hit = null;
    for (const e of enemies) {
      if (e.dead) continue;
      const t = rayAABB(ox, oy, m.facing, 0, e.hurtbox);
      if (t != null && t < len) { len = t; hit = e; }
    }
    this.beams.push({ x1: ox, y1: oy, x2: ox + m.facing * len, y2: oy, life: 0.12, color: m.palette.weapon });
    fx.burst(ox, oy, m.palette.weapon, 4, 60);
    if (hit) {
      let dmg = w.dmg;
      if (m.skill === 'glasscannon') dmg = Math.round(dmg * 1.5);
      if (m.skill === 'laststand' && m.hp < (m._maxHp || CFG.maxHp) * 0.3) dmg = Math.round(dmg * 1.6);
      hit.takeHit(dmg, m, {});
      /* 吸血 */
      if (m.skill === 'lifesteal') {
        const hl = Math.round(dmg * 0.3);
        m.hp = Math.min(m._maxHp || CFG.maxHp, m.hp + hl);
        fx.popup(m.x, m.y - 48, '+' + hl, '#ff5a5a');
      }
      /* 神秘人士 */
      if (m.skill === 'mystery' && Math.random() < 0.3) {
        const md = Math.round(dmg * 0.5);
        hit.takeHit(md, m, {});
        fx.popup(hit.x, hit.y - 52, '神秘 ' + md, '#c07bff');
        fx.burst(hit.x, hit.y - 24, '#c07bff', 10, 120);
      }
    }
  }

  firePlasma(m) {
    let speed = WEAPONS.plasma.speed;
    let dmg = WEAPONS.plasma.dmg;
    /* 远射：投射物速度+50% */
    if (m.skill === 'longshot') speed *= 1.5;
    /* 重炮手：投射物伤害+40% */
    if (m.skill === 'gunner') dmg = Math.round(dmg * 1.4);
    /* 玻璃大炮 */
    if (m.skill === 'glasscannon') dmg = Math.round(dmg * 1.5);
    /* 背水一战 */
    if (m.skill === 'laststand' && m.hp < (m._maxHp || CFG.maxHp) * 0.3) dmg = Math.round(dmg * 1.6);
    this.projs.push({
      x: m.x + m.facing * 18, y: m.y - 26,
      vx: m.facing * speed, vy: -50,
      dmg, owner: m, life: 3,
      homing: m.skill === 'homing',
    });
  }

  update(dt, mechs, fx) {
    /* 武器点位冷却 */
    for (const p of this.pads) if (p.timer > 0) p.timer -= dt;

    /* 空投生成（幸运拾取：频率+50%） */
    this.spawnT -= dt;
    if (this.spawnT <= 0) {
      let minT = 6, maxT = 10;
      if (mechs.some((m) => m.skill === 'luckydrop')) { minT = 4; maxT = 7; }
      this.spawnT = rand(minT, maxT);
      this.spawnDrop();
    }

    /* 空投下落 / 落地 / 过期 */
    for (const d of this.drops) {
      if (!d.landed) {
        const py = d.y;
        d.vy += 400 * dt; d.y += d.vy * dt;
        const top = this.dropLandY(d.x, py, d.y);
        if (top != null) { d.y = top; d.landed = true; fx.burst(d.x, d.y, '#c9a86a', 6, 60); }
      } else d.life -= dt;
    }
    this.drops = this.drops.filter((d) => d.life > 0);

    /* 拾取：空投箱 + 武器点位 */
    for (const m of mechs) {
      if (m.dead) continue;
      /* 幸运拾取：拾取范围+50% */
      const pickRange = m.skill === 'luckydrop' ? 24 : 16;
      for (const d of this.drops) {
        if (d.got) continue;
        if (Math.abs(m.x - d.x) < pickRange && Math.abs((m.y - 20) - d.y) < 26) {
          d.got = true; this.applyDrop(m, d, fx);
        }
      }
      this.drops = this.drops.filter((d) => !d.got);
      for (const p of this.pads) {
        if (p.timer > 0) continue;
        if (Math.abs(m.x - p.x) < 20 && Math.abs(m.y - p.y) < 8) {
          p.timer = 12;
          const w = WEAPONS[p.weapon];
          m.equip(w);
          fx.popup(m.x, m.y - 52, w.name + '!', '#9fe8ff');
          fx.burst(m.x, m.y - 8, '#4fd8ff', 8, 80);
        }
      }
    }

    /* 投射物（命中所有非 owner 机甲） */
    for (const pr of this.projs) {
      /* 小帮手：自动追击最近敌人 */
      if (pr.homing && pr.owner && !pr.owner.dead) {
        let tgt = null, td = 1e9;
        for (const m of mechs) {
          if (m === pr.owner || m.dead) continue;
          const d = Math.hypot(m.x - pr.x, (m.y - 20) - pr.y);
          if (d < td) { td = d; tgt = m; }
        }
        if (tgt && td < 300) {
          const dx = tgt.x - pr.x, dy = (tgt.y - 20) - pr.y;
          const dist = Math.hypot(dx, dy) || 1;
          const sp = Math.hypot(pr.vx, pr.vy);
          pr.vx += (dx / dist) * 400 * dt;
          pr.vy += (dy / dist) * 400 * dt;
          const ns = Math.hypot(pr.vx, pr.vy);
          if (ns > sp * 1.1) { pr.vx = (pr.vx / ns) * sp * 1.1; pr.vy = (pr.vy / ns) * sp * 1.1; }
        }
      }
      pr.vy += 260 * dt; pr.x += pr.vx * dt; pr.y += pr.vy * dt; pr.life -= dt;
      let boom = false;
      if (pr.x < 0 || pr.x > WORLD.w || pr.y > WORLD.groundY) boom = true;
      if (!boom) for (const pl of this.map.platforms) {
        if (pr.x > pl.x && pr.x < pl.x + pl.w && pr.y > pl.y && pr.y < pl.y + 8) { boom = true; break; }
      }
      if (!boom) for (const m of mechs) {
        if (m === pr.owner || m.dead) continue;
        if (aabb({ x: pr.x - 5, y: pr.y - 5, w: 10, h: 10 }, m.hurtbox)) {
          m.takeHit(pr.dmg, pr.owner, {}); boom = true; break;
        }
      }
      if (boom || pr.life <= 0) { pr.dead = true; fx.burst(pr.x, pr.y, '#ff9a3d', 10, 120); }
    }
    this.projs = this.projs.filter((p) => !p.dead);

    /* 射线衰减 */
    for (const b of this.beams) b.life -= dt;
    this.beams = this.beams.filter((b) => b.life > 0);
  }

  /* ---------- 绘制 ---------- */
  drawBG(ctx, cam, t) {
    if (!this._sky) {
      const g = ctx.createLinearGradient(0, 0, 0, VIEW_H);
      g.addColorStop(0, '#0a0a1e'); g.addColorStop(1, '#1a1a3c');
      this._sky = g;
    }
    ctx.fillStyle = this._sky;
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);

    /* 星空（视差 0.15） */
    const span = 640;
    ctx.fillStyle = '#cfe8ff';
    for (let i = 0; i < 50; i++) {
      const bx = (i * 97) % span, by = (i * 61) % 190;
      const x = ((bx - cam.x * 0.15) % span + span) % span;
      ctx.globalAlpha = 0.2 + 0.3 * (0.5 + 0.5 * Math.sin(t * 2 + i));
      ctx.fillRect(Math.round(x), Math.round(by), 2, 2);
    }
    ctx.globalAlpha = 1;

    /* 城市剪影（视差 0.35） */
    const cityY = VIEW_H * 0.62 - cam.y * 0.25;
    const off = cam.x * 0.35;
    for (let i = 0; i < 24; i++) {
      const bx = Math.round(i * 80 - (off % 1920));
      if (bx < -80 || bx > VIEW_W + 80) continue;
      const bh = 50 + ((i * 53) % 80);
      ctx.fillStyle = '#12122a';
      ctx.fillRect(bx, cityY - bh, 56, bh + 240);
      ctx.fillStyle = '#1d1d3f';
      ctx.fillRect(bx, cityY - bh, 56, 4);
      ctx.fillStyle = '#2a2a55';
      ctx.fillRect(bx + 8, cityY - bh + 10, 4, 4);
      ctx.fillRect(bx + 30, cityY - bh + 22, 4, 4);
      ctx.fillRect(bx + 44, cityY - bh + 8, 4, 4);
    }

    /* 背景墙层（视差 0.65） */
    this.map.drawBgWalls(ctx, cam, t);
  }

  draw(ctx, t) {
    /* 地面 */
    ctx.fillStyle = '#1c1c30';
    ctx.fillRect(0, WORLD.groundY, WORLD.w, WORLD.h - WORLD.groundY);
    ctx.fillStyle = '#3a3a66';
    ctx.fillRect(0, WORLD.groundY, WORLD.w, 2);
    ctx.strokeStyle = '#26263f'; ctx.lineWidth = 1;
    for (let gx = 0; gx <= WORLD.w; gx += 40) {
      ctx.beginPath(); ctx.moveTo(gx + 0.5, WORLD.groundY + 2); ctx.lineTo(gx + 0.5, WORLD.h); ctx.stroke();
    }
    for (let gy = WORLD.groundY + 8; gy < WORLD.h; gy += 8) {
      ctx.beginPath(); ctx.moveTo(0, gy + 0.5); ctx.lineTo(WORLD.w, gy + 0.5); ctx.stroke();
    }

    /* 平台结构（含塔身装饰） */
    this.map.drawStructures(ctx, t);

    /* 武器点位 */
    for (const p of this.pads) {
      const ready = p.timer <= 0;
      const col = ready ? (p.weapon === 'ray' ? '#4fd8ff' : '#ff6bd6') : '#4a4a6a';
      ctx.fillStyle = '#15152a'; ctx.fillRect(p.x - 14, p.y - 3, 28, 5);
      ctx.fillStyle = col; ctx.fillRect(p.x - 12, p.y - 2, 24, 2);
      const bob = Math.sin(t * 3 + p.x) * 2;
      ctx.globalAlpha = ready ? 0.95 : 0.3;
      ctx.fillStyle = col;
      if (p.weapon === 'ray') {
        ctx.fillRect(p.x - 6, p.y - 15 + bob, 12, 2);
        ctx.fillRect(p.x + 4, p.y - 17 + bob, 2, 6);
      } else {
        ctx.fillRect(p.x - 3, p.y - 17 + bob, 6, 6);
        ctx.fillStyle = '#fff'; ctx.fillRect(p.x - 1, p.y - 15 + bob, 2, 2);
      }
      ctx.globalAlpha = 1;
      if (!ready) {
        const r = 1 - p.timer / 12;
        ctx.fillStyle = '#22223a'; ctx.fillRect(p.x - 12, p.y - 1, 24, 2);
        ctx.fillStyle = col; ctx.fillRect(p.x - 12, p.y - 1, Math.round(24 * r), 2);
      }
    }

    /* 空投箱 */
    for (const d of this.drops) {
      if (!d.landed) {
        ctx.fillStyle = '#4fd8ff'; ctx.fillRect(d.x - 6, d.y - 26, 12, 4);
        ctx.strokeStyle = '#4fd8ff'; ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(d.x - 6, d.y - 24); ctx.lineTo(d.x - 4, d.y - 12);
        ctx.moveTo(d.x + 6, d.y - 24); ctx.lineTo(d.x + 4, d.y - 12);
        ctx.stroke();
      }
      let a = 1;
      if (d.landed && d.life < 3) a = 0.3 + 0.7 * Math.abs(Math.sin(t * 8));
      ctx.globalAlpha = a;
      ctx.fillStyle = '#8a6a3a'; ctx.fillRect(d.x - 7, d.y - 14, 14, 14);
      ctx.fillStyle = '#b08a4a'; ctx.fillRect(d.x - 7, d.y - 14, 14, 3);
      ctx.fillStyle = '#3a2a16'; ctx.fillRect(d.x - 7, d.y - 4, 14, 4);
      ctx.fillStyle = '#ffd23f';
      ctx.font = 'bold 9px "Courier New", monospace'; ctx.textAlign = 'center';
      ctx.fillText('?', d.x, d.y - 4);
      ctx.globalAlpha = 1;
    }

    /* 等离子投射物 */
    for (const p of this.projs) {
      for (let k = 1; k <= 3; k++) {
        ctx.globalAlpha = 0.4 / k;
        ctx.fillStyle = '#ff9a3d';
        ctx.fillRect(p.x - p.vx * 0.015 * k - 2, p.y - p.vy * 0.015 * k - 2, 4, 4);
      }
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#ff9a3d'; ctx.fillRect(p.x - 3, p.y - 3, 6, 6);
      ctx.fillStyle = '#fff'; ctx.fillRect(p.x - 1, p.y - 1, 2, 2);
    }

    /* 光线枪射线 */
    for (const b of this.beams) {
      const a = Math.max(0, b.life / 0.12);
      const x = Math.min(b.x1, b.x2), w = Math.abs(b.x2 - b.x1);
      ctx.globalAlpha = a * 0.45; ctx.fillStyle = b.color; ctx.fillRect(x, b.y1 - 2, w, 4);
      ctx.globalAlpha = a; ctx.fillStyle = '#fff'; ctx.fillRect(x, b.y1 - 1, w, 2);
      ctx.globalAlpha = a * 0.8; ctx.fillStyle = b.color; ctx.fillRect(b.x1 - 3, b.y1 - 3, 6, 6);
      ctx.globalAlpha = 1;
    }
  }

  /* ---------- 网络序列化（平台由种子生成，不传输） ---------- */
  serialize() {
    return {
      drops: this.drops.map((d) => ({ x: Math.round(d.x), y: Math.round(d.y), l: d.landed ? 1 : 0, life: +d.life.toFixed(1), c: d.content })),
      projs: this.projs.map((p) => ({ x: Math.round(p.x), y: Math.round(p.y), vx: Math.round(p.vx), vy: Math.round(p.vy), d: p.dmg, o: p.owner ? p.owner.id : '', life: +p.life.toFixed(1), b: p.bomb ? 1 : 0 })),
      pads: this.pads.map((p) => +Math.max(0, p.timer).toFixed(1)),
      beams: this.beams.map((b) => [Math.round(b.x1), Math.round(b.y1), Math.round(b.x2), Math.round(b.y2), +b.life.toFixed(2), b.color]),
    };
  }
  applySnap(s, mechsById) {
    this.drops = s.drops.map((d) => ({ x: d.x, y: d.y, landed: !!d.l, life: d.life, vy: 0, content: d.c }));
    this.projs = s.projs.map((p) => ({
      x: p.x, y: p.y, vx: p.vx, vy: p.vy, dmg: p.d, life: p.life,
      owner: mechsById[p.o] || null,
      bomb: !!p.b,
    }));
    this.pads.forEach((p, i) => { p.timer = s.pads[i] || 0; });
    this.beams = s.beams.map((b) => ({ x1: b[0], y1: b[1], x2: b[2], y2: b[3], life: b[4], color: b[5] || '#eaf6ff' }));
  }
}
