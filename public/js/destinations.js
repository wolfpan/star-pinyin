/**
 * destinations.js — 「奖励档位 = 星际目的地」纯逻辑（浏览器 / Node 共用，零依赖）
 * ------------------------------------------------------------------
 * 规则：
 *  - Lv1–Lv3 地球三层轨道（低空 / 高空 / 远地，释放卫星，地球按轨道高度呈现不同视角）；
 *    Lv4 起逐級飞向更远的星球，Lv13 奥尔特云 / Lv14 飞出太阳系。
 *  - 档位由「课文同步完成的课时数」决定（每 2 课时升 1 档，见 rewards.js / server.js），
 *    与火箭收藏解耦：火箭只是收集 / 座驾，不再决定能飞哪颗星球。
 *    本模块只负责 档位 → 目的地 的映射与星球元数据（名称 / 百科 / 字幕 / 载荷）。
 *  - 星球视觉全部由 planet-fx.js 代码绘制；小图标用 AI 生成的透明 PNG
 *    （/images/icons/{style}/dest/{id}.png，见 icons.js / scripts/gen-ui-icons.mjs），本模块不含图片资源。
 *  - 抵达字幕/播报只用短名（「抵达火星」），不带「入轨/穿环/飞掠爱心区」等后缀描述。
 */

export const MAX_LEVEL = 14;

/** 等级 → 目的地 id。Lv1–3 为地球三层轨道（低空 / 高空 / 远地）。 */
export const DESTINATION_BY_LEVEL = {
  1: 'earth_low', 2: 'earth_high', 3: 'earth_far',
  4: 'moon', 5: 'venus', 6: 'mars', 7: 'mercury',
  8: 'jupiter', 9: 'saturn', 10: 'uranus', 11: 'neptune',
  12: 'pluto', 13: 'oort', 14: 'interstellar',
};

/**
 * 目的地元数据。
 * kind: orbit=地球轨道（卫星）· planet=行星/矮行星（探测器入轨）· beyond=太阳系外（飞掠）
 * payload: satellite=真实卫星模型 · probe=代码绘制探测器
 * orbitView: 地球轨道视角 low=低空（地球弧线铺满下方）· high=高空（大地球+轨道环）· far=远地（小地球+大轨道环）
 * caption: 抵达字幕/真人播报（短名，无入轨等后缀）
 */
export const DESTINATIONS = {
  earth_low: {
    id: 'earth_low', name: '低空轨道', nameEn: 'Low Orbit', level: 1,
    kind: 'orbit', payload: 'satellite', orbitView: 'low',
    caption: '抵达低空轨道', rewardTitle: '抵达低空轨道',
    fact: '离地面几百公里的近地轨道，空间站和大多数卫星都在这里飞行，绕地球一圈只要约一个半小时。',
  },
  earth_high: {
    id: 'earth_high', name: '高空轨道', nameEn: 'High Orbit', level: 2,
    kind: 'orbit', payload: 'satellite', orbitView: 'high',
    caption: '抵达高空轨道', rewardTitle: '抵达高空轨道',
    fact: '更高的轨道上卫星绕地球一圈更慢，导航卫星和气象卫星常在这里工作，看得更远更久。',
  },
  earth_far: {
    id: 'earth_far', name: '远地轨道', nameEn: 'Distant Orbit', level: 3,
    kind: 'orbit', payload: 'satellite', orbitView: 'far',
    caption: '抵达远地轨道', rewardTitle: '抵达远地轨道',
    fact: '远离地球的轨道，卫星在这里能长时间凝视深空，是通往月球和行星际航线的出发点。',
  },
  moon: {
    id: 'moon', name: '月球', nameEn: 'Moon', level: 4,
    kind: 'planet', payload: 'probe',
    caption: '抵达月球', rewardTitle: '抵达月球',
    fact: '地球唯一的天然卫星，表面布满环形山与暗色月海，人类曾乘土星五号登月。',
  },
  venus: {
    id: 'venus', name: '金星', nameEn: 'Venus', level: 5,
    kind: 'planet', payload: 'probe',
    caption: '抵达金星', rewardTitle: '抵达金星',
    fact: '被浓厚硫酸云包裹，是太阳系最热的行星，自转方向与多数行星相反。',
  },
  mars: {
    id: 'mars', name: '火星', nameEn: 'Mars', level: 6,
    kind: 'planet', payload: 'probe',
    caption: '抵达火星', rewardTitle: '抵达火星',
    fact: '铁锈红色的荒漠星球，有白色极冠与太阳系最高的火山，祝融号曾在此巡视。',
  },
  mercury: {
    id: 'mercury', name: '水星', nameEn: 'Mercury', level: 7,
    kind: 'planet', payload: 'probe',
    caption: '抵达水星', rewardTitle: '抵达水星',
    fact: '离太阳最近、最小的行星，表面像月球一样布满陨石坑，昼夜温差极大。',
  },
  jupiter: {
    id: 'jupiter', name: '木星', nameEn: 'Jupiter', level: 8,
    kind: 'planet', payload: 'probe',
    caption: '抵达木星', rewardTitle: '抵达木星',
    fact: '太阳系最大的行星，条纹云带中有刮了几百年的大红斑风暴，拥有众多卫星。',
  },
  saturn: {
    id: 'saturn', name: '土星', nameEn: 'Saturn', level: 9,
    kind: 'planet', payload: 'probe',
    caption: '抵达土星', rewardTitle: '抵达土星',
    fact: '戴着壮丽冰粒光环的气态巨行星，光环中有著名的卡西尼缝。',
  },
  uranus: {
    id: 'uranus', name: '天王星', nameEn: 'Uranus', level: 10,
    kind: 'planet', payload: 'probe',
    caption: '抵达天王星', rewardTitle: '抵达天王星',
    fact: '躺着自转的冰巨星，自转轴倾角约 98°，淡青色来自大气中的甲烷。',
  },
  neptune: {
    id: 'neptune', name: '海王星', nameEn: 'Neptune', level: 11,
    kind: 'planet', payload: 'probe',
    caption: '抵达海王星', rewardTitle: '抵达海王星',
    fact: '离太阳最远的行星，深蓝色大气中有太阳系最快的风暴。',
  },
  pluto: {
    id: 'pluto', name: '冥王星', nameEn: 'Pluto', level: 12,
    kind: 'planet', payload: 'probe',
    caption: '抵达冥王星', rewardTitle: '抵达冥王星',
    fact: '柯伊伯带里的矮行星，表面有一片明亮的「爱心」形氮冰平原（汤博区）。',
  },
  oort: {
    id: 'oort', name: '奥尔特云', nameEn: 'Oort Cloud', level: 13,
    kind: 'cloud', payload: 'probe',
    caption: '抵达奥尔特云', rewardTitle: '抵达奥尔特云',
    fact: '太阳系边缘的冰质天体壳层，长周期彗星的故乡，再往外就是星际空间。',
  },
  interstellar: {
    id: 'interstellar', name: '星际空间', nameEn: 'Interstellar', level: 14,
    kind: 'beyond', payload: 'probe',
    caption: '抵达星际空间', rewardTitle: '抵达星际空间',
    fact: '飞出太阳系后的星际空间，太阳只是远处一颗暗星——指挥官的征途是星辰大海。',
  },
};

/** 规范化等级到 1..MAX_LEVEL 整数。 */
export function clampLevel(value) {
  return Math.min(MAX_LEVEL, Math.max(1, Math.floor(Number(value) || 1)));
}

/** 等级 → 目的地元数据（越界回夹）。 */
export function destinationForLevel(level) {
  const lv = clampLevel(level);
  return DESTINATIONS[DESTINATION_BY_LEVEL[lv]];
}

/** 当前上限的「下一站」（满级返回 null）。 */
export function nextDestinationForMax(max) {
  const m = clampLevel(max);
  return m < MAX_LEVEL ? destinationForLevel(m + 1) : null;
}

/** 全部目的地按等级升序（14 级一一对应 14 种目的地），供博物馆星球图鉴。 */
export function destinationList() {
  const out = [];
  for (let lv = 1; lv <= MAX_LEVEL; lv++) out.push(destinationForLevel(lv));
  return out;
}
