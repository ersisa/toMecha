'use strict';
/* ================= 机器人 AI（导航系统） =================
 * 输出与玩家一致的 InputState，直接喂给 Mecha.update
 *
 * 移动 bug 修复要点：
 *  1. 旧版起跳与二段跳共用 jumpCd(0.7~0.8s)，单跳顶点在 0.41s、滞空仅 0.83s，
 *     冷却结束时人已在下落 → 二段跳(+56px)无法补偿 → 120px+ 高差经常失败。
 *     现在二段跳改为独立判定：空中 >0.12s 且接近顶点(vy>-120)即可触发。
 *  2. 旧版无路径规划：只会朝目标直跳，中央平台距地面 330px 而二段跳极限仅
 *     124px → 永远上不了高层。现在 findStep() 在 [me.y-118, me.y-28] 高度带内
 *     找"垫脚石"平台，逐层攀爬抵达任意高度。
 *  3. 旧版拾取走位用固定 dirHold(0.25s) + 12px 阈值，接近目标时来回震荡。
 *     现在改为逐帧小死区(12px)直接逼近。
 *  4. 空中攀爬时对上方敌人挥拳：攻击锁定 0.24s 恰好吞掉二段跳窗口
 *    （单跳顶点 0.41s，窗口仅约 5 帧）→ 差一步够不着，无限弹跳。
 *     现在攀爬途中（空中+二段跳未用+敌人在上方）禁用近战起手。
 *  5. 二段跳抑制条件 me.y > gy+18 在层差 69~85px 时无触发窗口
 *    （单跳 68px 不够、抑制又生效）→ 永久卡死。现改为 me.y > gy-6，
 *     并把 vy 窗口放宽到 (-60,150) 以覆盖回落初段与失足恢复。
 */
class Bot {
  constructor() {
    this.jumpCd = 0;    // 起跳间隔冷却（仅控制起跳频率）
    this.blockT = 0;    // 格挡反应冷却
    this.airT = 0;      // 空中滞空时间（二段跳防抖）
    this.navT = 0;      // 垫脚石重规划计时
    this.step = null;   // 当前垫脚石平台
  }

  /* 当前所站的平台（站在主地面或空中时返回 null） */
  standPlat(m, plats) {
    if (!m.onGround || m.y >= WORLD.groundY - 0.5) return null;
    for (const p of plats) {
      if (Math.abs(m.y - p.y) < 1 && m.x > p.x - 8 && m.x < p.x + p.w + 8) return p;
    }
    return null;
  }

  /* 找向上垫脚石：高度在二段跳实际可达带（离散物理极限≈117px，取114）内、
   * 朝目标方向的平台（地图层差上限 112px，保证每个平台都有可达垫脚石） */
  findStep(me, gx, gy, plats) {
    let best = null, bs = 1e9;
    for (const p of plats) {
      const rise = me.y - p.y;             // 平台高于当前站位多少
      if (rise < 8 || rise > 114) continue; // 同层微高(≥8px)也走台阶；超出实际极限排除
      const pcx = p.x + p.w / 2;
      /* 贪心评分：优先朝目标方向、更接近目标高度、离自己不太远的台阶 */
      const s = Math.abs(pcx - gx) + Math.abs(p.y - gy) * 0.6 + Math.abs(pcx - me.x) * 0.25;
      if (s < bs) { bs = s; best = p; }
    }
    return best;
  }

  /* enemies：同场所有其他机甲 */
  think(dt, me, enemies, world) {
    const inp = { left: false, right: false, block: false, jumpEdge: false, attackEdge: false };
    this.jumpCd -= dt; this.blockT -= dt; this.navT -= dt;
    this.airT = me.onGround ? 0 : this.airT + dt;
    if (me.dead) return inp;

    const plats = world.platforms;
    const alive = enemies.filter((e) => !e.dead);
    if (!alive.length) return inp;

    /* 主目标：最近的存活敌人 */
    let en = alive[0], bd = 1e9;
    for (const e of alive) {
      const d = Math.abs(e.x - me.x);
      if (d < bd) { bd = d; en = e; }
    }

    /* 拾取目标：附近有空投/武器点位且需要时优先 */
    let item = null, idd = 1e9;
    for (const d of world.drops) {
      if (!d.landed) continue;
      const dd = Math.abs(d.x - me.x) + Math.abs(d.y - me.y) * 0.5;
      if (dd < idd) { idd = dd; item = d; }
    }
    for (const p of world.pads) {
      if (p.timer > 0) continue;
      if (me.weapon.id === p.weapon && me.ammo > 3) continue;
      const dd = Math.abs(p.x - me.x) + Math.abs(p.y - me.y) * 0.5;
      if (dd < idd) { idd = dd; item = p; }
    }
    const wantItem = me.hp < 55
      || (me.weapon.type === 'melee' && Math.random() < 0.03)
      || Math.random() < 0.003;

    /* 导航目标 */
    let gx, gy, seeking = false;
    if (item && idd < 420 && wantItem) { gx = item.x; gy = item.y; seeking = true; }
    else { gx = en.x; gy = en.y; }

    const dx = gx - me.x, adx = Math.abs(dx), dy = gy - me.y;
    const plat = this.standPlat(me, plats);

    if (dy > 30) {
      /* ------- 目标在下方 ------- */
      if (me.onGround && plat && this.jumpCd <= 0) {
        /* 站在平台上：任意位置直接下跳穿落 */
        inp.block = true; inp.jumpEdge = true; this.jumpCd = 0.6;
      } else {
        /* 空中/地面：朝目标水平移动（下落中也修正水平） */
        if (dx > 12) inp.right = true; else if (dx < -12) inp.left = true;
      }
    } else if (dy < -8) {
      /* ------- 目标在上方：逐层攀爬 ------- */
      if (me.onGround) {
        if (this.navT <= 0 || !this.step) { this.step = this.findStep(me, gx, gy, plats); this.navT = 0.4; }
        const st = this.step;
        if (st) {
          const dxs = (st.x + st.w / 2) - me.x;
          /* 距台阶中心水平 ≤90px（一跳弧线漂移余量内）即起跳，空中修正自动向中心漂移。
           * 旧版要求先站进台阶中段 50% 再跳——台阶中段可能越出当前平台边缘，
           * 机器人会为走到中段而走下平台 → 坠落重来无限循环（卡死根因之三） */
          if (Math.abs(dxs) <= 90 && this.jumpCd <= 0) {
            inp.jumpEdge = true; this.jumpCd = 0.55;
          } else if (dxs > 8) inp.right = true;
          else if (dxs < -8) inp.left = true;
        } else {
          /* 无台阶可达（目标略高且一步可及 / 或够不着）：直接朝目标跳 */
          if (dx > 14) inp.right = true; else if (dx < -14) inp.left = true;
          if (adx < 70 && dy > -122 && this.jumpCd <= 0) {
            inp.jumpEdge = true; this.jumpCd = 0.55;
          }
        }
      } else {
        /* 空中：始终向"当前垫脚石中心"修正，直至落台。
         * 旧版在越过台阶平面（me.y < st.y）时切向终极目标修正——而越过台阶平面
         * 正是落台的必经过程，中途切换会把机器人水平拉出台阶边缘 → 错过平台坠落 */
        const st = this.step;
        let ax = st ? st.x + st.w / 2 : gx;
        const adx2 = ax - me.x;
        if (adx2 > 10) inp.right = true; else if (adx2 < -10) inp.left = true;
        /* 高度不足时二段跳。窗口放宽为 vy∈(-60,150)（上升末段/顶点/回落初段）：
         * 旧版 me.y > gy + 18 在层差 69~85px 时完全无触发窗口——单跳(68px)不够、
         * 二段跳又被抑制 → 永远卡在平台下。现改为 me.y > gy - 6（仍在目标下方即跳） */
        if (me.jumps < 2 && this.airT > 0.12 && me.vy > -60 && me.vy < 150 && me.y > gy - 6) {
          inp.jumpEdge = true;
        }
      }
    } else {
      /* ------- 同层：拾取接近 / 交战走位 ------- */
      if (seeking) {
        if (dx > 12) inp.right = true; else if (dx < -12) inp.left = true;
      } else {
        const w = me.weapon;
        const idealMin = w.type === 'melee' ? 0 : (w.id === 'ray' ? 190 : 250);
        const idealMax = w.type === 'melee' ? 46 : (w.id === 'ray' ? 380 : 420);
        const edx = en.x - me.x, eadx = Math.abs(edx);
        if (eadx > idealMax) { if (edx > 0) inp.right = true; else inp.left = true; }
        else if (eadx < idealMin) { if (edx > 0) inp.left = true; else inp.right = true; }
        /* 偶尔随机跳，增加不可预测性 */
        if (me.onGround && Math.random() < 0.0015) inp.jumpEdge = true;
      }
    }

    /* ------- 攻击决策（对主目标） ------- */
    const edx = en.x - me.x, eadx = Math.abs(edx), edy = en.y - me.y;
    const w = me.weapon;
    /* 空中攀爬中（敌人在上方且二段跳未用）不挥近战：挥刀会锁定动作 0.24s，
     * 恰好完全覆盖二段跳触发窗口 → 差一步够不着、落回原地无限弹跳（移动bug根因）。
     * 远程武器不锁定动作，不受影响 */
    const climbAir = !me.onGround && me.jumps < 2 && edy < -8;
    if (w.type === 'melee') {
      if (!climbAir && eadx < 42 && Math.abs(edy) < 40) inp.attackEdge = true;
    } else if (me.ammo > 0) {
      if (eadx < w.range * 0.9 && Math.abs(edy) < 28 && me.cooldown <= 0 && Math.random() < 0.8) inp.attackEdge = true;
      else if (eadx < 44 && Math.abs(edy) < 36) inp.attackEdge = true;
    } else if (!climbAir && eadx < 42 && Math.abs(edy) < 36) inp.attackEdge = true;

    /* ------- 防御反应：任一敌人近战起手 ------- */
    for (const e of alive) {
      if (e.state === 'attack' && Math.abs(e.x - me.x) < 70 && this.blockT <= 0 && Math.random() < 0.5) {
        inp.block = true; this.blockT = 0.5; break;
      }
    }
    /* ------- 躲射线：持光线枪的敌人同高度瞄准时跳跃 ------- */
    for (const e of alive) {
      if (e.weapon.id === 'ray' && e.cooldown > e.weapon.cooldown - 0.3 &&
          Math.abs(e.x - me.x) < 340 && Math.abs(e.y - me.y) < 20 &&
          this.jumpCd <= 0 && Math.random() < 0.1) {
        inp.jumpEdge = true; this.jumpCd = 1;
      }
    }
    return inp;
  }
}
