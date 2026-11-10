'use strict';
/* ================= 技能卡系统：23 个技能 =================
 * 每名玩家开局从 3 张技能卡中选 1 张：
 *   卡1 = 随机技能A，卡2 = 随机技能B（不与A重复），卡3 = 随机技能（不与A/B重复）
 * 技能在 newRound 时生效，影响游戏内各种机制。
 */

const SKILLS = {
  /* ---- 用户指定的 11 个技能 ---- */
  energy_ctrl: {
    id: 'energy_ctrl', name: '能量控制', icon: '⚡',
    desc: '捡到的护盾持续时间延长27%~40%',
    color: '#4fd8ff',
  },
  thrifty: {
    id: 'thrifty', name: '精打细算', icon: '🎯',
    desc: '捡到的武器射击次数+3~5次',
    color: '#ffd23f',
  },
  divine_aid: {
    id: 'divine_aid', name: '如有神助', icon: '🍀',
    desc: '武器射击时有概率不消耗次数',
    color: '#38d47a',
  },
  escape: {
    id: 'escape', name: '溜之大吉', icon: '💨',
    desc: '血量降至5%时触发随机传送',
    color: '#a08fff',
  },
  medipack: {
    id: 'medipack', name: '随身血包', icon: '💉',
    desc: '血量低于一半时恢复1/4血量，一局2次',
    color: '#ff5a5a',
  },
  flysquirrel: {
    id: 'flysquirrel', name: '飞鼠', icon: '🦔',
    desc: '地面按住跳跃0.8秒飞升至二段跳最高点悬空；空中按住0.3秒或连点3次就地悬空（二段跳保留）',
    color: '#38d47a',
  },
  mystery: {
    id: 'mystery', name: '神秘人士', icon: '❓',
    desc: '命中时有概率召唤神秘人士协同攻击（所有武器通用）',
    color: '#c07bff',
  },
  bomber: {
    id: 'bomber', name: '轰炸机', icon: '✈',
    desc: '每次拾取空投后，轰炸机横穿全图往返轰炸一次',
    color: '#ff9a3d',
  },
  revive: {
    id: 'revive', name: '复活图腾', icon: '🔱',
    desc: '给予一次复活机会，复活后1.5秒无敌',
    color: '#ffd23f',
  },
  homing: {
    id: 'homing', name: '小帮手', icon: '🔍',
    desc: '仅抛射物武器生效：锁定射程内目标追踪至命中；弹药-60%',
    color: '#4fd8ff',
  },
  beastmaster: {
    id: 'beastmaster', name: '驯兽大师', icon: '🐺',
    desc: '召唤会跳跃的宠物，追击主人周围200px内的敌人',
    color: '#38d47a',
  },

  /* ---- 补充的 12 个技能 ---- */
  glasscannon: {
    id: 'glasscannon', name: '玻璃大炮', icon: '💥',
    desc: '伤害+50%，但最大血量降为75',
    color: '#ff5a5a',
  },
  ironhide: {
    id: 'ironhide', name: '铁壁', icon: '🛡',
    desc: '受到伤害减少20%',
    color: '#7878b8',
  },
  doublestrike: {
    id: 'doublestrike', name: '双连击', icon: '⚔',
    desc: '近战攻击有50%概率连击两次',
    color: '#ff9a3d',
  },
  quickload: {
    id: 'quickload', name: '快速装填', icon: '🔄',
    desc: '武器冷却时间减少35%（拳刃除外）',
    color: '#38d47a',
  },
  lifesteal: {
    id: 'lifesteal', name: '吸血', icon: '🩸',
    desc: '造成伤害回复生命：近战20%，远程15%',
    color: '#ff5a5a',
  },
  longshot: {
    id: 'longshot', name: '远射', icon: '📡',
    desc: '武器射程和投射物速度+50%',
    color: '#4fd8ff',
  },
  shockwave: {
    id: 'shockwave', name: '震荡波', icon: '🌊',
    desc: '从空中落地时释放冲击波，落得越高范围越大、击退越远',
    color: '#a08fff',
  },
  thorns: {
    id: 'thorns', name: '荆棘反伤', icon: '🌵',
    desc: '受到攻击时反弹30%伤害给攻击者',
    color: '#38d47a',
  },
  swift: {
    id: 'swift', name: '疾风步', icon: '🌪',
    desc: '移动速度+25%，跳跃高度+15%',
    color: '#38d47a',
  },
  gunner: {
    id: 'gunner', name: '重炮手', icon: '🎇',
    desc: '投射物伤害+40%，但冷却+20%',
    color: '#ff9a3d',
  },
  laststand: {
    id: 'laststand', name: '背水一战', icon: '🔥',
    desc: '血量低于30%时攻击力+60%',
    color: '#ff5a5a',
  },
  luckydrop: {
    id: 'luckydrop', name: '幸运拾取', icon: '🎁',
    desc: '空投箱出现频率+50%，拾取范围提升至32px',
    color: '#ffd23f',
  },
};

/* 技能ID列表（用于随机抽取） */
const SKILL_IDS = Object.keys(SKILLS);

/* 生成 3 张技能卡：前2张随机不重复，第3张从剩余中随机 */
function rollSkillCards(rng) {
  const pool = [...SKILL_IDS];
  const cards = [];
  for (let i = 0; i < 3; i++) {
    const idx = Math.floor(rng() * pool.length);
    cards.push(pool[idx]);
    pool.splice(idx, 1);
  }
  return cards;
}

/* 获取技能数据 */
function getSkill(id) {
  return SKILLS[id] || null;
}
