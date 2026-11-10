'use strict';
/* ================= 机甲实体：状态机 / 二段跳 / 下跳 / 多敌人 / 像素绘制 ================= */

class Mecha {
  /* id：唯一标识（网络对战用于同步）；idx：配色索引 */
  constructor(game, id, idx) {
    this.game = game;
    this.id = id;
    this.name = 'P' + (idx + 1);
    this.idx = idx;
    this.palette = PALETTES[idx % PALETTES.length];
    this.animT = Math.random() * 9;
    this.reset(200, 1);
  }

  reset(x, facing) {
    this.x = x; this.y = WORLD.groundY;
    this.vx = 0; this.vy = 0; this.facing = facing;
    this.hp = CFG.maxHp;
    this.onGround = true; this.jumps = 0;
    this.state = 'idle'; this.stateTime = 0; this.walkPhase = 0;
    this.hitstun = 0; this.cooldown = 0; this.meleeHit = false;
    this.dropT = 0;
    this.dead = false;
    this.weapon = WEAPONS.blade; this.ammo = 0;
    this.buffs = { shield: 0, boost: 0 };
    this._lastHp = CFG.maxHp;
    this._tx = null; this._ty = null;
    this._koFall = false;  // KO 倒地动画
    /* 技能状态 */
    this.skill = null;            // 技能ID
    this._flyT = 0;               // 飞行计时器（飞鼠）
    this._jumpHoldT = 0;          // 跳跃键长按时间（飞鼠）
    this._medikitUsed = 0;        // 随身血包使用次数
    this._escapeUsed = false;     // 溜之大吉是否已触发
    this._reviveUsed = false;     // 复活图腾是否已使用
    this._invincibleT = 0;        // 无敌时间
    this._bomberT = 0;            // 轰炸机计时器
    this._pet = null;             // 宠物（驯兽大师）
    this._flightT = 0;           // 飞行剩余时间
  }

  /* 应用技能被动效果（在 newRound 时调用） */
  applySkill() {
    const s = this.skill;
    if (!s) return;
    switch (s) {
      case 'glasscannon': this.hp = 75; this._maxHp = 75; break;
      case 'ironhide': this._maxHp = CFG.maxHp; break;
      default: this._maxHp = CFG.maxHp; break;
    }
  }

  get hurtbox() { return { x: this.x - 9, y: this.y - 40, w: 18, h: 40 }; }

  equip(w) {
    this.weapon = w;
    let ammo = w.ammo || 0;
    /* 精打细算：射击次数+3~5 */
    if (this.skill === 'thrifty' && ammo > 0) {
      ammo += 3 + Math.floor(Math.random() * 3);  // +3~5
    }
    /* 小帮手：射击次数-60% */
    if (this.skill === 'homing' && ammo > 0) {
      ammo = Math.max(1, Math.round(ammo * 0.4));
    }
    this.ammo = ammo;
  }

  applyItem(it) {
    let heal = it.heal || 0;
    let dur = it.dur || 0;
    /* 能量控制：护盾持续时间+27%~40% */
    if (this.skill === 'energy_ctrl' && it.id === 'shield') {
      dur *= (1.27 + Math.random() * 0.13);
    }
    if (heal) this.hp = Math.min(this._maxHp || CFG.maxHp, this.hp + heal);
    if (dur) this.buffs[it.id === 'shield' ? 'shield' : 'boost'] = dur;
  }

  /* enemies：同场所有其他机甲（数组） */
  update(dt, inp, enemies) {
    const g = this.game, fx = g.fx;
    this.animT += dt;
    this.cooldown = Math.max(0, this.cooldown - dt);
    this.buffs.shield = Math.max(0, this.buffs.shield - dt);
    this.buffs.boost = Math.max(0, this.buffs.boost - dt);
    this._invincibleT = Math.max(0, this._invincibleT - dt);
    this._flightT = Math.max(0, this._flightT - dt);

    /* 技能：随身血包 — 血量低于一半时恢复 */
    if (this.skill === 'medipack' && !this.dead && this._medikitUsed < 2) {
      if (this.hp < (this._maxHp || CFG.maxHp) / 2) {
        const heal = Math.round((this._maxHp || CFG.maxHp) / 4);
        this.hp = Math.min(this._maxHp || CFG.maxHp, this.hp + heal);
        this._medikitUsed++;
        fx.popup(this.x, this.y - 52, '+' + heal + ' 随身血包', '#38d47a');
        fx.burst(this.x, this.y - 24, '#38d47a', 12, 100);
      }
    }

    /* 技能：溜之大吉 — 血量≤5%时随机传送 */
    if (this.skill === 'escape' && !this.dead && !this._escapeUsed) {
      if (this.hp <= (this._maxHp || CFG.maxHp) * 0.05 && this.hp > 0) {
        this._escapeUsed = true;
        const oldX = this.x;
        this.x = rand(80, WORLD.w - 80);
        this.y = WORLD.groundY;
        this.vx = 0; this.vy = 0;
        fx.burst(oldX, this.y - 24, '#a08fff', 16, 140);
        fx.burst(this.x, this.y - 24, '#a08fff', 16, 140);
        fx.popup(this.x, this.y - 52, '传送！', '#a08fff');
      }
    }

    /* 技能：飞鼠 — 长按跳跃键2秒后飞行3秒 */
    if (this.skill === 'flysquirrel' && !this.dead) {
      if (inp.jump) {
        this._jumpHoldT += dt;
        if (this._jumpHoldT >= 2 && this._flightT <= 0) {
          this._flightT = 3;
          this._jumpHoldT = 0;
          fx.popup(this.x, this.y - 52, '飞鼠！', '#38d47a');
          fx.burst(this.x, this.y - 24, '#38d47a', 10, 80);
        }
      } else {
        this._jumpHoldT = 0;
      }
      if (this._flightT > 0) {
        this.vy = -50;  // 缓慢上升
        this.onGround = false;
        if (Math.random() < 0.3) {
          fx.spawn(this.x - this.facing * 8, this.y - 10, {
            color: '#38d47a', vx: rand(-20, 20), vy: rand(10, 40),
            life: 0.3, maxLife: 0.3, size: 2,
          });
        }
      }
    }

    /* 技能：轰炸机 — 每隔10秒触发一次 */
    if (this.skill === 'bomber' && !this.dead) {
      this._bomberT += dt;
      if (this._bomberT >= 10) {
        this._bomberT = 0;
        this._spawnBomber(g);
      }
    }

    /* 技能：驯兽大师 — 召唤宠物 */
    if (this.skill === 'beastmaster' && !this.dead && !this._pet) {
      const petHp = Math.round((this._maxHp || CFG.maxHp) * 2 / 3);
      this._pet = {
        x: this.x, y: this.y, hp: petHp, maxHp: petHp,
        cooldown: 0, facing: this.facing,
        state: 'idle', stateTime: 0, animT: 0, vy: 0, onGround: true,
      };
      fx.burst(this.x, this.y - 12, '#38d47a', 14, 120);
      fx.popup(this.x, this.y - 52, '召唤宠物！', '#38d47a');
    }
    /* 宠物AI（仅权威端 bot/net-host 运行；客户端走快照插值） */
    if (this._pet && this.game.mode !== 'net-client') {
      this._updatePet(dt, enemies, g, fx);
    }

    /* KO 动画：倒地下落，直到碰到地面或平台 */
    if (this.dead) {
      this.vy += CFG.gravity * 1.2 * dt;
      this.y += this.vy * dt;
      if (this.y >= WORLD.groundY) { this.y = WORLD.groundY; this.vy = 0; }
      else {
        for (const p of g.world.platforms) {
          if (this.x > p.x - 8 && this.x < p.x + p.w + 8 &&
              this.y >= p.y && this.y - this.vy * dt <= p.y + 1) {
            this.y = p.y; this.vy = 0;
          }
        }
      }
      this.stateTime += dt;
      return;
    }

    if (this.hitstun > 0) this.hitstun -= dt;
    if (this.state === 'hit' && this.hitstun <= 0) this.state = 'idle';

    /* 面向最近存活敌人 */
    let nearest = null, nd = 1e9;
    for (const e of enemies) {
      if (e.dead) continue;
      const d = Math.abs(e.x - this.x);
      if (d < nd) { nd = d; nearest = e; }
    }
    if (nearest) this.facing = nearest.x >= this.x ? 1 : -1;

    /* 攻击输入（按当前武器类型分流） */
    if (inp.attackEdge && this.cooldown <= 0 && this.state !== 'hit') {
      const w = this.weapon;
      if (w.type === 'melee') {
        this.state = 'attack'; this.stateTime = 0; this.meleeHit = false;
        let cd = w.cooldown;
        /* 快速装填：冷却-35% */
        if (this.skill === 'quickload') cd *= 0.65;
        this.cooldown = cd; this.vx *= 0.3;
      } else if (this.ammo > 0) {
        let cd = w.cooldown;
        /* 快速装填 */
        if (this.skill === 'quickload') cd *= 0.65;
        /* 重炮手：冷却+20% */
        if (this.skill === 'gunner') cd *= 1.2;
        this.cooldown = cd;
        /* 如有神助：概率不消耗次数 */
        if (this.skill === 'divine_aid' && Math.random() < 0.25) {
          fx.popup(this.x, this.y - 48, '神助！', '#38d47a');
        } else {
          this.ammo--;
        }
        if (w.type === 'ray') g.world.fireRay(this, enemies, fx);
        else g.world.firePlasma(this);
        if (this.ammo <= 0) {
          fx.popup(this.x, this.y - 52, '弹药耗尽', '#ffb14f');
          this.weapon = WEAPONS.blade;
        }
      } else {
        this.weapon = WEAPONS.blade;
        this.state = 'attack'; this.stateTime = 0; this.meleeHit = false;
        let cd = WEAPONS.blade.cooldown;
        if (this.skill === 'quickload') cd *= 0.65;
        this.cooldown = cd;
      }
    }

    const canAct = this.state !== 'attack' && this.state !== 'hit' && this.hitstun <= 0;
    const blocking = inp.block && this.onGround && canAct;

    /* 水平移动：更流畅的加速/减速 */
    if (canAct) {
      let dir = (inp.right ? 1 : 0) - (inp.left ? 1 : 0);
      if (blocking) dir = 0;
      let spdMult = this.buffs.boost > 0 ? 1.45 : 1;
      /* 疾风步：速度+25% */
      if (this.skill === 'swift') spdMult *= 1.25;
      const sp = CFG.maxSpeed * spdMult;
      if (dir !== 0) this.vx = clamp(this.vx + dir * CFG.accel * dt, -sp, sp);
      else {
        const f = CFG.friction * 1.4 * dt;  /* 更强摩擦，停止更快 */
        this.vx = Math.abs(this.vx) <= f ? 0 : this.vx - Math.sign(this.vx) * f;
      }
    } else {
      this.vx *= 0.92;  /* 平滑减速，无卡顿感 */
    }

    /* 跳跃（支持二段跳）/ 下跳：站在平台上时按 下防+跳 直接穿落到下方 */
    if (inp.jumpEdge && canAct) {
      const plats = g.world.platforms;
      if (blocking && this.onGround && this.y < WORLD.groundY - 1 &&
          plats.some((p) => Math.abs(this.y - p.y) < 1 && this.x > p.x - 8 && this.x < p.x + p.w + 8)) {
        this.dropT = 0.22; this.onGround = false; this.jumps = 1;
        this.vy = 90;
        fx.burst(this.x, this.y, '#8899bb', 5, 60);
      } else if (!blocking) {
        let jumpS = CFG.jumpSpeed, jump2S = CFG.jump2Speed;
        /* 疾风步：跳跃高度+15% */
        if (this.skill === 'swift') { jumpS *= 1.15; jump2S *= 1.15; }
        if (this.onGround) {
          this.vy = -jumpS; this.jumps = 1; this.onGround = false;
          fx.burst(this.x, this.y, '#8899bb', 5, 60);
        } else if (this.jumps < 2) {
          this.vy = -jump2S; this.jumps = 2;
          fx.burst(this.x, this.y - 8, this.palette.shield, 8, 90);
        }
      }
    }

    /* 物理 + 平台/地面碰撞（单向平台；下跳期间忽略平台） */
    const prevY = this.y;
    this.dropT = Math.max(0, this.dropT - dt);
    this.vy += CFG.gravity * dt;
    this.x += this.vx * dt; this.y += this.vy * dt;
    let landed = false;
    if (this.vy >= 0) {
      if (this.y >= WORLD.groundY) { this.y = WORLD.groundY; landed = true; }
      else if (this.dropT <= 0) for (const p of g.world.platforms) {
        if (this.x > p.x - 8 && this.x < p.x + p.w + 8 && prevY <= p.y + 0.01 && this.y >= p.y) {
          this.y = p.y; landed = true; break;
        }
      }
    }
    if (landed) {
      if (!this.onGround) fx.burst(this.x, this.y, '#8899bb', 6, 70);
      this.vy = 0; this.onGround = true; this.jumps = 0;
    } else this.onGround = false;
    this.x = clamp(this.x, 14, WORLD.w - 14);

    /* 状态机 */
    this.stateTime += dt;
    if (this.state === 'attack' && this.stateTime >= WEAPONS.blade.duration) this.state = 'idle';
    if (this.state !== 'attack' && this.state !== 'hit') {
      if (!this.onGround) this.state = 'jump';
      else if (blocking) this.state = 'block';
      else if (Math.abs(this.vx) > 10) { this.state = 'walk'; this.walkPhase += dt * 14; }
      else this.state = 'idle';
    }

    /* 近战判定（拳刃，命中范围内所有敌人） */
    if (this.state === 'attack' && !this.meleeHit) {
      const w = WEAPONS.blade, st = this.stateTime;
      if (st >= w.active[0] && st <= w.active[1]) {
        const hb = { x: this.x + this.facing * w.reach * 0.5 - w.hw / 2, y: this.y - w.hh, w: w.hw, h: w.hh };
        let meleeDmg = w.dmg;
        /* 玻璃大炮：伤害+50% */
        if (this.skill === 'glasscannon') meleeDmg = Math.round(meleeDmg * 1.5);
        /* 背水一战：血量<30%时攻击+60% */
        if (this.skill === 'laststand' && this.hp < (this._maxHp || CFG.maxHp) * 0.3) meleeDmg = Math.round(meleeDmg * 1.6);
        /* 双连击：50%概率连击 */
        const doubleHit = this.skill === 'doublestrike' && Math.random() < 0.5;
        for (const e of enemies) {
          if (e.dead) continue;
          if (aabb(hb, e.hurtbox)) {
            this.meleeHit = true;
            e.takeHit(meleeDmg, this, {});
            /* 吸血 */
            if (this.skill === 'lifesteal') {
              const hl = Math.round(meleeDmg * 0.3);
              this.hp = Math.min(this._maxHp || CFG.maxHp, this.hp + hl);
              fx.popup(this.x, this.y - 48, '+' + hl, '#ff5a5a');
            }
            /* 神秘人士 */
            if (this.skill === 'mystery' && Math.random() < 0.3) {
              const mysteryDmg = Math.round(meleeDmg * 0.5);
              e.takeHit(mysteryDmg, this, {});
              fx.popup(e.x, e.y - 52, '神秘 ' + mysteryDmg, '#c07bff');
              fx.burst(e.x, e.y - 24, '#c07bff', 10, 120);
            }
            /* 双连击 */
            if (doubleHit) {
              e.takeHit(meleeDmg, this, {});
              fx.popup(e.x, e.y - 52, '连击！', '#ff9a3d');
            }
            break;   // 单次挥击只命中一人
          }
        }
      }
    }

    /* 推进剂尾焰粒子 */
    if (this.buffs.boost > 0 && Math.abs(this.vx) > 40 && Math.random() < 0.5) {
      fx.spawn(this.x - this.facing * 8, this.y - 18, {
        color: '#ff9a3d', vx: -this.facing * 40, vy: rand(-20, 20), life: 0.3, maxLife: 0.3, size: 2,
      });
    }
  }

  takeHit(dmg, from, opts) {
    const g = this.game, fx = g.fx;
    let d = dmg;

    /* 技能：铁壁 — 受伤减少20% */
    if (this.skill === 'ironhide') d *= 0.8;

    const blocked = this.state === 'block';
    if (this.buffs.shield > 0) d *= 0.4;
    if (blocked) d *= 0.25;
    d = Math.max(1, Math.round(d));

    /* 无敌期间不受伤害 */
    if (this._invincibleT > 0) d = 0;

    this.hp = Math.max(0, this.hp - d);
    this.hitstun = CFG.hitstun;

    /* 技能：荆棘反伤 — 反弹30%伤害 */
    if (this.skill === 'thorns' && d > 0 && from && !from.dead) {
      const refl = Math.max(1, Math.round(d * 0.3));
      from.hp = Math.max(0, from.hp - refl);
      fx.burst(from.x, from.y - 24, '#38d47a', 6, 80);
      fx.popup(from.x, from.y - 48, '反-' + refl, '#38d47a');
    }

    if (blocked) {
      fx.burst(this.x, this.y - 26, this.palette.shield, 8, 90);
      fx.popup(this.x, this.y - 46, '格挡', '#9fd8ff');
    } else {
      const dir = from.x >= this.x ? -1 : 1;
      this.vx = dir * CFG.knockback; this.vy = -120; this.onGround = false; this.state = 'hit';
      fx.burst(this.x, this.y - 24, from.palette.weapon, 14, 150);
      fx.popup(this.x, this.y - 48, '-' + d, '#ff5a5a');
      g.shake = 6;
    }

    /* 技能：震荡波 — 落地时释放冲击波 */
    if (this.skill === 'shockwave' && this.onGround && d > 5) {
      for (const e of g.mechs || []) {
        if (e === this || e.dead) continue;
        if (Math.abs(e.x - this.x) < 60) {
          const dir = e.x >= this.x ? 1 : -1;
          e.vx = dir * 200; e.vy = -80; e.onGround = false;
        }
      }
      fx.burst(this.x, this.y, '#a08fff', 20, 160);
    }

    if (this.hp <= 0 && !this.dead) {
      /* 技能：复活图腾 — 给予一次复活 */
      if (this.skill === 'revive' && !this._reviveUsed) {
        this._reviveUsed = true;
        this.hp = Math.round((this._maxHp || CFG.maxHp) * 0.5);
        this._invincibleT = 1.5;
        this.state = 'idle'; this.hitstun = 0;
        this.vx = 0; this.vy = 0;
        fx.popup(this.x, this.y - 60, '复活！', '#ffd23f');
        fx.burst(this.x, this.y - 24, '#ffd23f', 30, 200);
        fx.burst(this.x, this.y - 24, '#ffffff', 15, 140);
        return;
      }
      this.dead = true; this.state = 'ko';
      this._koFall = true;
      fx.burst(this.x, this.y - 20, '#ffd23f', 26, 180);
      fx.burst(this.x, this.y - 20, '#ffffff', 12, 120);
      fx.popup(this.x, this.y - 60, 'KO', '#ff5a5a');
    }
  }

  /* ---------- 像素绘制 ---------- */
  draw(ctx) {
    const pal = this.palette, f = this.facing, t = this.animT;
    const walk = this.state === 'walk', jumpSt = this.state === 'jump';
    const attack = this.state === 'attack', block = this.state === 'block';
    const hit = this.state === 'hit', ko = this.state === 'ko', idle = this.state === 'idle';

    /* 地面阴影 */
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    if (ko) {
      // KO 状态：阴影在身体旁边（侧身躺地）
      ctx.fillRect(Math.round(this.x - 14), Math.round(this.y - 2), 28, 3);
    } else if (this.onGround) {
      ctx.fillRect(Math.round(this.x - 10), Math.round(this.y), 20, 3);
    }

    /* 队友/敌人标识点（多人模式区分阵营） */
    if (!ko) {
      ctx.fillStyle = pal.body;
      ctx.fillRect(Math.round(this.x) - 2, Math.round(this.y) - 48, 4, 3);
    }

    ctx.save();
    ctx.translate(Math.round(this.x), Math.round(this.y));
    ctx.scale(f, 1);

    if (ko) {
      /* KO 动画：侧身躺地，身体旋转 90° */
      ctx.rotate(Math.PI / 2);  // 侧身倒地
      ctx.translate(0, -8);  // 身体略下沉
    } else if (idle || block) {
      ctx.translate(0, Math.sin(t * 4) * 0.6);
    }

    const swing = walk ? Math.sin(this.walkPhase) * 4 : 0;

    /* 推进器喷焰（仅在非 KO 且空中时） */
    if (!this.onGround && !ko) {
      const fl = 5 + Math.sin(t * 30) * 2;
      ctx.fillStyle = pal.flame; ctx.globalAlpha = 0.85;
      ctx.fillRect(-7, -1, 5, fl); ctx.fillRect(3, -1, 5, fl);
      ctx.globalAlpha = 1;
    }

    /* 腿 + 脚 */
    ctx.fillStyle = pal.dark;
    ctx.fillRect(-8 - swing, -12, 5, 12);
    ctx.fillRect(3 + swing, -12, 5, 12);
    ctx.fillStyle = '#101018';
    ctx.fillRect(-10 - swing, -2, 8, 3);
    ctx.fillRect(1 + swing, -2, 8, 3);

    /* 后臂 */
    ctx.fillStyle = pal.dark;
    ctx.fillRect(-10, -23, 4, 12);
    ctx.fillStyle = '#101018';
    ctx.fillRect(-10, -11, 4, 3);

    /* 躯干 */
    ctx.fillStyle = pal.body; ctx.fillRect(-9, -24, 18, 12);
    ctx.fillStyle = pal.dark; ctx.fillRect(-9, -14, 18, 3);
    ctx.fillStyle = pal.core; ctx.fillRect(-2, -21, 6, 5);
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, -20, 2, 2);

    /* 头部 */
    ctx.fillStyle = pal.body; ctx.fillRect(-6, -35, 13, 10);
    ctx.fillStyle = pal.dark; ctx.fillRect(-6, -35, 13, 2);
    ctx.fillStyle = pal.light; ctx.fillRect(-11, -38, 3, 4);
    ctx.fillStyle = attack ? '#ffffff' : pal.eye; ctx.fillRect(-3, -31, 8, 3);
    ctx.fillStyle = pal.light; ctx.fillRect(-1, -33, 3, 2);

    /* 防御状态：持枪手放到盾后面 */
    if (block) {
      /* 护盾（更突出、更大） */
      ctx.fillStyle = pal.shield; ctx.globalAlpha = 0.85;
      ctx.fillRect(7, -30, 6, 22);
      ctx.fillStyle = '#ffffff'; ctx.fillRect(8, -28, 3, 18);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = pal.light; ctx.lineWidth = 1;
      ctx.strokeRect(7, -30, 6, 22);
      /* 武器手：缩到护盾后面（不露出） */
      ctx.fillStyle = pal.dark; ctx.fillRect(10, -23, 3, 8);
      /* 武器：仅露出一小部分在盾顶 */
      if (this.weapon.id === 'ray') {
        ctx.fillStyle = pal.weapon; ctx.fillRect(10, -30, 4, 2);
      } else if (this.weapon.id === 'plasma') {
        ctx.fillStyle = '#ff9a3d'; ctx.fillRect(10, -30, 3, 3);
      }
    } else {
      /* 前臂分支：拳刃 / 光线枪 / 等离子炮 */
      const wid = this.weapon.id;
      if (wid === 'ray') {
        ctx.fillStyle = pal.body; ctx.fillRect(7, -24, 4, 9);
        ctx.fillStyle = pal.dark; ctx.fillRect(7, -25, 12, 4);
        ctx.fillStyle = pal.weapon; ctx.fillRect(19, -25, 8, 2);
        ctx.fillStyle = '#fff'; ctx.fillRect(19, -25, 2, 2);
        if (this.cooldown > this.weapon.cooldown - 0.1) {
          ctx.fillStyle = '#ffffff'; ctx.fillRect(27, -27, 5, 6);
        }
      } else if (wid === 'plasma') {
        ctx.fillStyle = pal.body; ctx.fillRect(7, -24, 4, 9);
        ctx.fillStyle = pal.dark; ctx.fillRect(7, -26, 10, 6);
        ctx.fillStyle = '#ff9a3d'; ctx.fillRect(17, -25, 4, 4);
        ctx.fillStyle = '#fff'; ctx.fillRect(18, -24, 2, 2);
        if (this.cooldown > this.weapon.cooldown - 0.15) {
          ctx.fillStyle = '#ffd23f'; ctx.fillRect(21, -27, 4, 8);
        }
      } else if (attack) {
        ctx.fillStyle = pal.body; ctx.fillRect(6, -22, 6, 5);
        ctx.fillRect(6, -21, 12, 6);
        ctx.fillStyle = pal.weapon; ctx.globalAlpha = 0.9;
        ctx.fillRect(17, -20, 16, 3);
        ctx.fillStyle = '#ffffff'; ctx.fillRect(17, -20, 16, 1);
        ctx.globalAlpha = 1;
        const prog = clamp(this.stateTime / WEAPONS.blade.duration, 0, 1);
        if (prog < 0.55) {
          ctx.globalAlpha = 0.22; ctx.fillStyle = pal.shield;
          ctx.fillRect(8, -28, 26, 16);
          ctx.globalAlpha = 1;
        }
      } else {
        const armSwing = walk ? -swing : 0;
        const lift = jumpSt ? 4 : 0;
        ctx.fillStyle = pal.body; ctx.fillRect(8, -23 - lift, 4, 12);
        ctx.fillStyle = pal.dark; ctx.fillRect(8, -12 - lift + armSwing, 4, 4);
      }
    }

    /* 能量盾增益光环 */
    if (this.buffs.shield > 0) {
      ctx.globalAlpha = 0.16 + 0.06 * Math.sin(t * 10);
      ctx.fillStyle = pal.shield;
      ctx.beginPath(); ctx.arc(0, -20, 23, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 0.5;
      ctx.strokeStyle = pal.shield; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(0, -20, 23, 0, Math.PI * 2); ctx.stroke();
      ctx.globalAlpha = 1;
    }

    /* 受击白闪 */
    if (hit) {
      ctx.globalAlpha = 0.4; ctx.fillStyle = '#ffffff';
      ctx.fillRect(-9, -35, 18, 35);
      ctx.globalAlpha = 1;
    }
    ctx.restore();

    /* 无敌光环 */
    if (this._invincibleT > 0) {
      ctx.globalAlpha = 0.3 + 0.2 * Math.sin(this.animT * 20);
      ctx.strokeStyle = '#ffd23f'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(this.x, this.y - 20, 26, 0, Math.PI * 2); ctx.stroke();
      ctx.globalAlpha = 1;
    }

    /* 飞行光环 */
    if (this._flightT > 0) {
      ctx.globalAlpha = 0.2 + 0.1 * Math.sin(this.animT * 15);
      ctx.fillStyle = '#38d47a';
      ctx.beginPath(); ctx.arc(this.x, this.y - 20, 22, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 1;
    }

    /* 技能图标提示（头顶） */
    if (this.skill && !this.dead) {
      const sk = getSkill(this.skill);
      if (sk) {
        ctx.font = 'bold 7px "Courier New", monospace';
        ctx.textAlign = 'center';
        ctx.fillStyle = sk.color;
        ctx.globalAlpha = 0.8;
        ctx.fillText(sk.icon, this.x, this.y - 52);
        ctx.globalAlpha = 1;
      }
    }

    /* 绘制宠物（驯兽大师） */
    if (this._pet) this._drawPet(ctx);
  }

  /* 轰炸机：从一侧飞过，每0.2秒丢一个10伤害炸弹 */
  _spawnBomber(g) {
    const fromLeft = Math.random() < 0.5;
    const bomber = {
      x: fromLeft ? -20 : WORLD.w + 20,
      y: 100,
      vx: fromLeft ? 120 : -120,
      dropT: 0,
      life: WORLD.w / 120 + 2,
      ownerId: this.id,   /* 记录归属，炸弹不误伤主人 */
    };
    g._bombers = g._bombers || [];
    g._bombers.push(bomber);
    g.fx.popup(this.x, this.y - 52, '轰炸机！', '#ff9a3d');
  }

  /* ---------- 宠物AI（驯兽大师） ---------- */
  _updatePet(dt, enemies, g, fx) {
    const pet = this._pet;
    if (!pet) return;
    /* 主人死亡 → 宠物消失 */
    if (this.dead) {
      fx.burst(pet.x, pet.y - 12, '#38d47a', 12, 120);
      this._pet = null;
      return;
    }
    /* 宠物死亡 */
    if (pet.hp <= 0) {
      fx.burst(pet.x, pet.y - 12, '#38d47a', 16, 140);
      fx.popup(pet.x, pet.y - 30, '宠物倒下', '#ff5a5a');
      this._pet = null;
      return;
    }
    pet.cooldown = Math.max(0, pet.cooldown - dt);
    pet.animT += dt;
    pet.stateTime += dt;

    /* 目标选择：最近存活敌人 */
    let tgt = null, td = 1e9;
    for (const e of enemies) {
      if (e.dead) continue;
      const d = Math.abs(e.x - pet.x);
      if (d < td) { td = d; tgt = e; }
    }

    /* 移动：有目标且较近时追击，否则跟随主人 */
    const chaseRange = 200;
    if (tgt && td < chaseRange) {
      const dx = tgt.x - pet.x;
      const adx = Math.abs(dx);
      if (adx > 30) {
        pet.facing = dx > 0 ? 1 : -1;
        pet.x += pet.facing * 95 * dt;
        pet.state = 'walk';
      } else if (pet.cooldown <= 0) {
        /* 攻击：扑咬 */
        pet.facing = tgt.x >= pet.x ? 1 : -1;
        pet.cooldown = 0.9;
        pet.state = 'attack';
        pet.stateTime = 0;
        const dmg = Math.max(3, Math.round(WEAPONS.blade.dmg * 0.5));
        tgt.takeHit(dmg, this, {});
        fx.burst(tgt.x, tgt.y - 24, this.palette.body, 8, 100);
        fx.popup(tgt.x, tgt.y - 48, '宠物-' + dmg, this.palette.light);
      } else {
        pet.state = 'idle';
      }
    } else {
      /* 跟随主人 */
      const dx = this.x - pet.x;
      const adx = Math.abs(dx);
      if (adx > 40) {
        pet.facing = dx > 0 ? 1 : -1;
        pet.x += pet.facing * 85 * dt;
        pet.state = 'walk';
      } else {
        pet.state = 'idle';
      }
    }

    /* 重置状态 */
    if (pet.state === 'attack' && pet.stateTime > 0.4) pet.state = 'idle';
    if (pet.state === 'walk') pet.animT += dt;

    /* 重力 + 落地 */
    pet.vy += CFG.gravity * dt;
    pet.y += pet.vy * dt;
    if (pet.y >= WORLD.groundY) { pet.y = WORLD.groundY; pet.vy = 0; pet.onGround = true; }
    else {
      /* 单向平台落地 */
      for (const p of g.world.platforms) {
        if (pet.x > p.x && pet.x < p.x + p.w && pet.y >= p.y && pet.y - pet.vy * dt <= p.y) {
          pet.y = p.y; pet.vy = 0; pet.onGround = true; break;
        }
      }
    }
    pet.x = clamp(pet.x, 14, WORLD.w - 14);
  }

  /* ---------- 宠物绘制 ---------- */
  _drawPet(ctx) {
    const pet = this._pet;
    const pal = this.palette;
    const t = pet.animT;
    const walk = pet.state === 'walk';
    const attack = pet.state === 'attack';
    const swing = walk ? Math.sin(t * 16) * 3 : 0;

    /* 阴影 */
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.fillRect(Math.round(pet.x - 7), Math.round(pet.y), 14, 2);

    ctx.save();
    ctx.translate(Math.round(pet.x), Math.round(pet.y));
    ctx.scale(pet.facing, 1);

    /* 尾巴 */
    ctx.fillStyle = pal.dark;
    const tailW = 3 + Math.round(Math.sin(t * 10) * 2);
    ctx.fillRect(-10, -14, 3, tailW);

    /* 身体 */
    ctx.fillStyle = pal.dark; ctx.fillRect(-7, -16, 14, 10);
    ctx.fillStyle = pal.body; ctx.fillRect(-6, -15, 12, 6);

    /* 头部 */
    ctx.fillStyle = pal.body; ctx.fillRect(5, -20, 9, 8);
    ctx.fillStyle = pal.dark; ctx.fillRect(5, -20, 9, 2);
    /* 耳朵 */
    ctx.fillStyle = pal.dark;
    ctx.fillRect(6, -23, 3, 4);
    ctx.fillRect(11, -23, 3, 4);
    /* 眼睛 */
    ctx.fillStyle = attack ? '#ffffff' : pal.eye;
    ctx.fillRect(11, -18, 2, 2);

    /* 腿 */
    ctx.fillStyle = pal.dark;
    ctx.fillRect(-6 + swing, -6, 3, 6);
    ctx.fillRect(3 - swing, -6, 3, 6);

    /* 攻击时露出獠牙 */
    if (attack) {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(12, -15, 2, 3);
    }

    ctx.restore();

    /* 血条（受伤时显示） */
    if (pet.hp < pet.maxHp) {
      const w = 16, x = pet.x - w / 2, y = pet.y - 26;
      ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillRect(x - 1, y - 1, w + 2, 4);
      ctx.fillStyle = '#38d47a'; ctx.fillRect(x, y, Math.round(w * (pet.hp / pet.maxHp)), 2);
    }
  }
}
