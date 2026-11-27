/**
 * pinyin-rules.js — 汉语拼音核心规则校验引擎（独立纯逻辑模块）
 * ------------------------------------------------------------------
 * 设计目标：
 *  - 纯 ES Module，无任何 DOM / window / Node 依赖，浏览器与 Node 测试脚本共用同一份逻辑。
 *  - 覆盖小学拼音 4 种结构形态：two_part / three_part / zero_initial / whole_syllable。
 *  - 实现：声韵母拼接校验、j/q/x 去点（摘墨镜）检测、标调位置计算。
 *  - 标调口诀：“有 a 找 a，无 a 找 o/e，i/u 并列标在后”。
 *
 * 重要教学约定（防止教错孩子）：
 *  - 整体认读音节（whole_syllable）绝不拆分声韵母，直接整体认读。
 *  - j/q/x 与 ü 相拼时，ü 上两点必须省略（写成 u），但底层数据仍保留 ü 以驱动“摘墨镜”交互。
 *  - n/l 与 ü 相拼时两点保留（nǚ / lǜ），本引擎同样支持。
 */

/** 23 个声母（含 y/w，用于零声母音节的书写界定）。 */
export const INITIALS = Object.freeze([
  'b', 'p', 'm', 'f', 'd', 't', 'n', 'l', 'g', 'k', 'h',
  'j', 'q', 'x', 'zh', 'ch', 'sh', 'r', 'z', 'c', 's', 'y', 'w',
]);

/** 24 个韵母：6 单韵母 + 8 复韵母 + 1 特殊韵母(er) + 5 前鼻韵母 + 4 后鼻韵母。 */
export const FINALS = Object.freeze([
  'a', 'o', 'e', 'i', 'u', 'ü',
  'ai', 'ei', 'ui', 'ao', 'ou', 'iu', 'ie', 'üe', 'er',
  'an', 'en', 'in', 'un', 'ün',
  'ang', 'eng', 'ing', 'ong',
]);

/** 三拼音节允许的介母。 */
export const MEDIALS = Object.freeze(['i', 'u', 'ü']);

/** 16 个整体认读音节（不可拆分）。 */
export const WHOLE_SYLLABLES = Object.freeze([
  'zhi', 'chi', 'shi', 'ri', 'zi', 'ci', 'si',
  'yi', 'wu', 'yu', 'ye', 'yue', 'yuan', 'yin', 'yun', 'ying',
]);

/** 任务结构形态枚举。 */
export const TYPES = Object.freeze(['two_part', 'three_part', 'zero_initial', 'whole_syllable']);

/** 触发“摘墨镜”特殊规则的声母。 */
export const JQX = Object.freeze(['j', 'q', 'x']);

/**
 * 合口呼韵母：j/q/x 不能与它们相拼（只能撮口呼 ü 或齐齿呼 i）。
 * 注意 `iu` 是齐齿呼（iou 的缩写），jiu / qiu / xiu 完全合法，不能因为“含 u”就判错。
 */
export const KOU_HU_FINALS = Object.freeze(['u', 'ui', 'un']);

/** 特殊规则标记常量。 */
export const RULE_DROP_DOTS = 'j_q_x_drop_dots';

/**
 * 标调符号表：每个元音 × 四个声调。
 * 轻声（0/5）不加符号。
 */
const TONE_MARKS = Object.freeze({
  a: ['ā', 'á', 'ǎ', 'à'],
  o: ['ō', 'ó', 'ǒ', 'ò'],
  e: ['ē', 'é', 'ě', 'è'],
  i: ['ī', 'í', 'ǐ', 'ì'],
  u: ['ū', 'ú', 'ǔ', 'ù'],
  ü: ['ǖ', 'ǘ', 'ǚ', 'ǜ'],
});

const INITIAL_SET = new Set(INITIALS);
const FINAL_SET = new Set(FINALS);
const MEDIAL_SET = new Set(MEDIALS);
const WHOLE_SET = new Set(WHOLE_SYLLABLES);
const KOU_HU_SET = new Set(KOU_HU_FINALS);

/** 把 ü 的两点摘掉（ü → u）。仅用于 j/q/x 之后的书写形。 */
export function removeDots(str) {
  return String(str).replace(/ü/g, 'u');
}

/**
 * 判定是否触发 j/q/x 去点规则：
 * 声母为 j/q/x，且介母或韵母中含 ü。
 * @returns {string|null} 'j_q_x_drop_dots' 或 null
 */
export function detectSpecialRule(parts = {}) {
  const { initial, medial, final } = parts;
  if (!JQX.includes(initial)) return null;
  const hasUmlaut = (medial && medial.includes('ü')) || (final && final.includes('ü'));
  return hasUmlaut ? RULE_DROP_DOTS : null;
}

/**
 * 由零件拼出“书写形”音节（不带声调符号）。
 * @param {{initial?:string|null, medial?:string|null, final?:string|null, whole?:string|null}} parts
 * @param {string} type 结构形态
 * @returns {string} 例如 'chuan' / 'ju' / 'xue' / 'an' / 'zhi'
 */
export function buildSyllable(parts = {}, type) {
  if (type === 'whole_syllable') {
    return parts.whole ?? '';
  }
  if (type === 'zero_initial') {
    // 零声母：直接写韵母（种子题库使用 an/er 等无需 y/w 改写的韵母）。
    return parts.final ?? '';
  }
  const initial = parts.initial ?? '';
  const medial = parts.medial ?? '';
  const final = parts.final ?? '';
  let syllable = initial + medial + final;
  // j/q/x 之后的 ü 一律摘点写成 u（ü→u, üe→ue, üan→uan, ün→un）。
  if (JQX.includes(initial)) {
    syllable = removeDots(syllable);
  }
  return syllable;
}

/**
 * 计算标调目标元音的下标（口诀：有 a 找 a，无 a 找 o/e，i/u 并列标在后）。
 * @param {string} base 书写形音节（不含声调符号）
 * @returns {number} 目标元音下标；找不到返回 -1
 */
export function toneTargetIndex(base) {
  const s = String(base).toLowerCase();
  // 1) 有 a 找 a
  const a = s.indexOf('a');
  if (a !== -1) return a;
  // 2) 无 a 找 o / e
  const o = s.indexOf('o');
  if (o !== -1) return o;
  const e = s.indexOf('e');
  if (e !== -1) return e;
  // 3) i/u 并列标在后（iu 标 u，ui 标 i）
  const i = s.lastIndexOf('i');
  const u = s.lastIndexOf('u');
  if (i !== -1 && u !== -1) return Math.max(i, u);
  // 4) 其余：唯一元音（i / u / ü）
  for (let k = 0; k < s.length; k++) {
    if (s[k] === 'i' || s[k] === 'u' || s[k] === 'ü') return k;
  }
  return -1;
}

/**
 * 给书写形音节标上调号。
 * @param {string} base 例如 'chuan'
 * @param {number} tone 1..4（0/5 为轻声，返回原形）
 * @returns {string} 例如 'chuán'
 */
export function markTone(base, tone) {
  const s = String(base);
  const t = Number(tone);
  if (!Number.isInteger(t) || t <= 0 || t >= 5) return s; // 轻声/非法 → 原样
  const idx = toneTargetIndex(s);
  if (idx < 0) return s;
  const ch = s[idx];
  const table = TONE_MARKS[ch];
  if (!table) return s;
  return s.slice(0, idx) + table[t - 1] + s.slice(idx + 1);
}

/** 一步到位：拼形 + 标调。 */
export function assembleAndMark(parts, type, tone) {
  return markTone(buildSyllable(parts, type), tone);
}

/**
 * 把任务归入种子题库的统计类别（用于验收计数）。
 * 优先级：整体认读 > j/q/x 规则题 > 三拼 > 两拼 > 零声母。
 */
export function categoryOf(mission) {
  if (mission.type === 'whole_syllable') return 'whole';
  if (mission.specialRule === RULE_DROP_DOTS) return 'jqx';
  if (mission.type === 'three_part') return 'three';
  if (mission.type === 'two_part') return 'two';
  if (mission.type === 'zero_initial') return 'zero';
  return 'unknown';
}

/**
 * 校验单个任务：结构一致性、拼形、标调、特殊规则判定。
 * @param {object} m 任务对象（missions.json 中的一条）
 * @returns {{ok:boolean, errors:string[], computed:{base:string, displayPinyin:string, specialRule:string|null, category:string}}}
 */
export function validateMission(m) {
  const errors = [];
  const parts = m.parts ?? {};
  const type = m.type;

  if (!TYPES.includes(type)) {
    errors.push(`非法 type: ${type}`);
  }
  const tone = Number(m.tone);
  if (!Number.isInteger(tone) || tone < 0 || tone > 5) {
    errors.push(`非法 tone: ${m.tone}`);
  }

  let base = '';
  if (type === 'whole_syllable') {
    if (!WHOLE_SET.has(parts.whole)) {
      errors.push(`整体认读音节不在 16 个之内: ${parts.whole}`);
    }
    if (parts.initial != null || parts.medial != null || parts.final != null) {
      errors.push('整体认读音节不应拆分 initial/medial/final');
    }
    base = parts.whole ?? '';
  } else if (type === 'zero_initial') {
    if (parts.initial != null) errors.push('零声母音节 initial 应为 null');
    if (parts.medial != null) errors.push('零声母音节 medial 应为 null');
    if (!FINAL_SET.has(parts.final)) errors.push(`非法韵母: ${parts.final}`);
    base = parts.final ?? '';
  } else if (type === 'two_part') {
    if (!INITIAL_SET.has(parts.initial)) errors.push(`非法声母: ${parts.initial}`);
    if (parts.medial != null) errors.push('两拼音节 medial 应为 null');
    if (!FINAL_SET.has(parts.final)) errors.push(`非法韵母: ${parts.final}`);
    base = buildSyllable(parts, type);
  } else if (type === 'three_part') {
    if (!INITIAL_SET.has(parts.initial)) errors.push(`非法声母: ${parts.initial}`);
    if (!MEDIAL_SET.has(parts.medial)) errors.push(`非法介母: ${parts.medial}`);
    if (!FINAL_SET.has(parts.final)) errors.push(`非法韵母: ${parts.final}`);
    base = buildSyllable(parts, type);
  }

  // j/q/x 不能与合口呼韵母相拼（只能撮口呼 ü 或齐齿呼 i；iu 属齐齿呼，合法）。
  if (JQX.includes(parts.initial)) {
    const rawU = parts.medial === 'u' || KOU_HU_SET.has(parts.final);
    if (rawU) errors.push(`j/q/x 不能与合口呼 u 相拼（应使用 ü）: ${parts.initial}+${parts.medial ?? ''}+${parts.final}`);
  }

  // 标调校验
  const expectedDisplay = markTone(base, tone);
  if (m.displayPinyin !== expectedDisplay) {
    errors.push(`标调不符: 期望 "${expectedDisplay}"，实际 "${m.displayPinyin}"（base=${base}, tone=${tone}）`);
  }

  // 特殊规则校验
  const expectedRule = detectSpecialRule(parts);
  const actualRule = m.specialRule ?? null;
  if (actualRule !== expectedRule) {
    errors.push(`specialRule 不符: 期望 ${expectedRule ?? 'null'}，实际 ${actualRule ?? 'null'}`);
  }

  // 干扰项不应包含本槽正确答案
  const dis = m.distractors ?? {};
  for (const slot of ['initial', 'medial', 'final']) {
    const correct = parts[slot];
    if (correct != null && Array.isArray(dis[slot]) && dis[slot].includes(correct)) {
      errors.push(`干扰项 ${slot} 含正确答案 "${correct}"`);
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    computed: {
      base,
      displayPinyin: expectedDisplay,
      specialRule: expectedRule,
      category: categoryOf(m),
    },
  };
}

/* ----------------------------- 自动拆分（家长后台辅助） ----------------------------- */

// 反查表：带调元音 → [基础元音, 声调]
const TONE_REVERSE = (() => {
  const map = new Map();
  for (const [vowel, marks] of Object.entries(TONE_MARKS)) {
    marks.forEach((m, i) => map.set(m, [vowel, i + 1]));
  }
  return map;
})();

/**
 * 把一个拼音音节自动拆分为声母/介母/韵母/声调/构型（家长后台辅助输入）。
 * 支持带调符号（chuán）或数字后缀（chuan2），v 视为 ü。结果为辅助建议，家长可微调。
 * @param {string} input 例如 'chuán' / 'chuan2' / 'xue3' / 'lü4'
 * @returns {{type:string, parts:object, tone:number, specialRule:string|null, displayPinyin:string, base:string, warnings:string[]}}
 */
export function parseSyllable(input) {
  const warnings = [];
  let raw = String(input || '').trim().toLowerCase().replace(/v/g, 'ü');
  let tone = 0;
  // 数字后缀声调
  const numMatch = raw.match(/([1-5])$/);
  if (numMatch) { tone = Number(numMatch[1]); raw = raw.slice(0, -1); }
  // 带调符号声调
  let base = '';
  for (const ch of raw) {
    const hit = TONE_REVERSE.get(ch);
    if (hit) { base += hit[0]; if (!tone) tone = hit[1]; }
    else base += ch;
  }
  base = base.normalize('NFC');

  const finish = (type, parts) => {
    const specialRule = detectSpecialRule(parts);
    const syllable = buildSyllable(parts, type);
    return { type, parts, tone, specialRule, base: syllable, displayPinyin: markTone(syllable, tone), warnings };
  };

  if (!base) { warnings.push('未识别到拼音'); return finish('two_part', { initial: null, medial: null, final: null }); }

  // 整体认读
  if (WHOLE_SET.has(base)) {
    return finish('whole_syllable', { initial: null, medial: null, final: null, whole: base });
  }
  // 零声母（a/o/e 开头）
  if ('aoe'.includes(base[0])) {
    if (!FINAL_SET.has(base)) warnings.push(`韵母 "${base}" 不在标准韵母表，请微调`);
    return finish('zero_initial', { initial: null, medial: null, final: base });
  }
  // 提取声母（优先 zh/ch/sh）
  let initial = '';
  for (const cand of ['zh', 'ch', 'sh']) { if (base.startsWith(cand)) { initial = cand; break; } }
  if (!initial) { for (const c of INITIALS) { if (base.startsWith(c)) { initial = c; break; } } }
  if (!initial) {
    warnings.push(`未识别声母，按零声母处理`);
    return finish('zero_initial', { initial: null, medial: null, final: base });
  }
  let remainder = base.slice(initial.length);
  // j/q/x 后书写 u 还原为 ü
  if (JQX.includes(initial)) remainder = remainder.replace(/^u/, 'ü');

  if (FINAL_SET.has(remainder)) {
    return finish('two_part', { initial, medial: null, final: remainder });
  }
  if (MEDIAL_SET.has(remainder[0]) && FINAL_SET.has(remainder.slice(1))) {
    return finish('three_part', { initial, medial: remainder[0], final: remainder.slice(1) });
  }
  warnings.push(`韵母 "${remainder}" 无法识别，请微调`);
  return finish('two_part', { initial, medial: null, final: remainder });
}
