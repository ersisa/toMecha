'use strict';
/* ================= 全局配置与工具 ================= */

const WORLD = { w: 1600, h: 720, groundY: 660 };  // 大地图
const VIEW_H = 216;                                // 内部渲染高度（宽度随屏幕比例变化）
let VIEW_W = 384;

const CFG = {
  maxSpeed: 150, accel: 1100, friction: 1500,
  jumpSpeed: 330, jump2Speed: 300, gravity: 800,
  maxHp: 100, hitstun: 0.2, knockback: 220,
};

/* 武器定义：拳刃（近战）/ 光线枪（射线）/ 等离子炮（投射物） */
const WEAPONS = {
  blade:  { id: 'blade',  name: '拳刃',   type: 'melee', dmg: 12, cooldown: 0.45,
            duration: 0.24, active: [0.06, 0.17], reach: 28, hw: 26, hh: 34 },
  ray:    { id: 'ray',    name: '光线枪', type: 'ray',   dmg: 9,  cooldown: 0.55, ammo: 10, range: 430 },
  plasma: { id: 'plasma', name: '等离子炮', type: 'proj', dmg: 16, cooldown: 0.9, ammo: 6, speed: 300 },
};

/* 随机道具定义 */
const ITEMS = {
  medkit: { id: 'medkit', name: '维修包', heal: 30 },
  shield: { id: 'shield', name: '能量盾', dur: 5 },
  boost:  { id: 'boost',  name: '推进剂', dur: 6 },
};

/* 机甲配色（支持多名玩家按序分配） */
const PALETTES = [
  { body: '#2f8cff', dark: '#1b5bb8', light: '#a8dcff', core: '#ffd23f', eye: '#c9fffd', weapon: '#eaf6ff', shield: '#4fd8ff', flame: '#ff9a3d' },
  { body: '#ff5a5a', dark: '#b82222', light: '#ffb1b1', core: '#ffd23f', eye: '#ffe27a', weapon: '#fff0d0', shield: '#ff8f3d', flame: '#ffd23f' },
  { body: '#38d47a', dark: '#1a8a4e', light: '#a8ffcd', core: '#ffd23f', eye: '#c9ffd9', weapon: '#eafff2', shield: '#4fffab', flame: '#ffd23f' },
  { body: '#c07bff', dark: '#7a3bc8', light: '#e3c8ff', core: '#ffd23f', eye: '#ffd9ff', weapon: '#f6ecff', shield: '#c07bff', flame: '#ff9a3d' },
];

/* 多人房间人数上限 */
const MAX_PLAYERS = 4;

/* 房间 BGM 本地上传上限（与 server.js 的 BGM_MAX 保持一致） */
const BGM_MAX_FILE = 20 * 1024 * 1024;

/* 是否以本地文件方式打开（双击 index.html / file:// 协议）
 * 该模式下没有 Node 服务器：单人可玩，多人联机不可用 */
const IS_LOCAL_FILE = (typeof location !== 'undefined') && location.protocol === 'file:';

function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
function rand(a, b) { return a + Math.random() * (b - a); }
function choice(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

/* 种子随机数生成器（房主生成种子，各端生成完全相同的地图） */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function aabb(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}
/* 射线与 AABB 求交：返回命中距离 t，未命中返回 null */
function rayAABB(x, y, dx, dy, b) {
  let tmin = 0, tmax = 1e9;
  if (Math.abs(dx) < 1e-6) { if (x < b.x || x > b.x + b.w) return null; }
  else {
    let t1 = (b.x - x) / dx, t2 = (b.x + b.w - x) / dx;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
    tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
    if (tmin > tmax) return null;
  }
  if (Math.abs(dy) < 1e-6) { if (y < b.y || y > b.y + b.h) return null; }
  else {
    let t1 = (b.y - y) / dy, t2 = (b.y + b.h - y) / dy;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
    tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
    if (tmin > tmax) return null;
  }
  return tmin >= 0 ? tmin : null;
}
function genRoom() {
  const c = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 4; i++) s += c[Math.floor(Math.random() * c.length)];
  return s;
}
function genId() {
  return Math.random().toString(36).slice(2, 8);
}
