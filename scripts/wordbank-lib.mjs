/**
 * wordbank-lib.mjs — 词库批量生成/体检的共用内核
 * ------------------------------------------------------------------
 * 被 `expand-missions-grade3.mjs`（m_041–m_140）与 `expand-missions-primary.mjs`
 * （m_141–m_500）共用，避免两套干扰项/标签规则漂移。
 *
 * 设计要点：
 *  - 拼音拆分与标调一律由 pinyin-rules.js 推导（parseSyllable），再交 validateMission 终审，
 *    词条表里只写「汉字 + 词组 + 带调拼音 + 提示」，标调抄错会立刻报错。
 *  - 干扰项按「平翘舌 / 前后鼻音 / j-q-x 限制」规则生成，每槽 1–3 个、绝不含正确答案。
 *  - 幂等：按本次表格的 id 区间 + 汉字集合替换旧条目，不动家长注入的 m_p_*。
 *
 * 用法：
 *   runWordbank({ entries, firstId: 41, source: '三年级' });
 *   命令行追加 --dry-run 只体检不写盘。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseSyllable, validateMission, categoryOf, KOU_HU_FINALS,
  INITIALS, FINALS, MEDIALS, WHOLE_SYLLABLES,
} from '../public/js/pinyin-rules.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const MISSIONS_PATH = path.join(__dirname, '..', 'data', 'missions.json');

const JQX = ['j', 'q', 'x'];

/* ============================ 干扰项规则 ============================ */

/** 声母易混表：平翘舌、n/l、f/h、b/p/d/t、j/q/x 互混。 */
const INITIAL_CONFUSIONS = {
  b: ['p', 'd', 'f'], p: ['b', 't', 'f'], m: ['n', 'f', 'b'], f: ['h', 'b', 'p'],
  d: ['t', 'g', 'b'], t: ['d', 'k', 'p'], n: ['l', 'm', 'r'], l: ['n', 'r', 'd'],
  g: ['k', 'h', 'j'], k: ['g', 'h', 'q'], h: ['f', 'k', 'g'],
  j: ['q', 'x', 'z'], q: ['j', 'x', 'c'], x: ['j', 'q', 's'],
  zh: ['z', 'ch', 'sh'], ch: ['c', 'zh', 'sh'], sh: ['s', 'zh', 'ch'], r: ['l', 'n', 'j'],
  z: ['zh', 'c', 's'], c: ['ch', 'z', 's'], s: ['sh', 'z', 'c'],
};

/** 介母易混表。 */
const MEDIAL_CONFUSIONS = { i: ['u', 'ü'], u: ['i', 'ü'], ü: ['i', 'u'] };

/** 韵母易混表：前后鼻音、复韵母、单韵母、ü 系列。 */
const FINAL_CONFUSIONS = {
  a: ['ai', 'ao', 'an'], o: ['ou', 'ao', 'e'], e: ['ei', 'en', 'er'],
  i: ['ie', 'in', 'ing'], u: ['ü', 'ou', 'o'], ü: ['u', 'üe', 'iu'],
  ai: ['ei', 'ao', 'ie'], ei: ['ai', 'ie', 'ui'], ui: ['iu', 'ei', 'un'],
  ao: ['ou', 'ai', 'an'], ou: ['ao', 'o', 'iu'], iu: ['ui', 'ie', 'u'],
  ie: ['ei', 'üe', 'i'], üe: ['ie', 'ü', 'ün'], er: ['ei', 'e', 'en'],
  an: ['ang', 'en', 'ai'], en: ['eng', 'an', 'in'], in: ['ing', 'en', 'ün'],
  un: ['ong', 'ün', 'ui'], ün: ['un', 'in', 'ü'],
  ang: ['an', 'eng', 'ong'], eng: ['en', 'ang', 'ing'],
  ing: ['in', 'eng', 'ong'], ong: ['eng', 'ang', 'un'],
};

/**
 * 韵母兜底候选（保证每槽凑够 3 个干扰项）。
 * 顺序有意为之：单韵母 i 最靠前，让 j/q/x+ü 的题优先出现「ju vs ji」这类高价值干扰；
 * 其余按单韵母 → 复韵母 → 鼻韵母排列，读起来更像真音节。
 */
const FILL_FINALS = [
  'i', 'ie', 'in', 'ing', 'a', 'o', 'e', 'u', 'ü', 'ai', 'ei', 'ao', 'ou',
  'an', 'en', 'ang', 'eng', 'ong', 'ui', 'iu', 'un', 'ün', 'üe', 'er',
];

/** 整体认读易混表（同组发音接近）。 */
const WHOLE_CONFUSIONS = {
  zhi: ['chi', 'shi', 'zi'], chi: ['zhi', 'shi', 'ci'], shi: ['zhi', 'chi', 'si'],
  ri: ['zhi', 'yi', 'zi'], zi: ['zhi', 'ci', 'si'], ci: ['zi', 'chi', 'si'],
  si: ['shi', 'zi', 'ci'], yi: ['ye', 'yue', 'wu'], wu: ['yi', 'yu', 'ye'],
  yu: ['yue', 'yuan', 'wu'], ye: ['yue', 'yuan', 'yi'], yue: ['ye', 'yuan', 'yu'],
  yuan: ['yue', 'ye', 'yun'], yin: ['ying', 'yun', 'yi'], yun: ['yin', 'ying', 'yu'],
  ying: ['yin', 'yun', 'yuan'],
};

const uniq = (arr) => [...new Set(arr)];

/** 按构型生成干扰项：每槽 1–3 个，互不重复，绝不含正确答案。 */
export function buildDistractors(type, parts) {
  if (type === 'whole_syllable') {
    const correct = parts.whole;
    const pool = uniq([...(WHOLE_CONFUSIONS[correct] || []), ...WHOLE_SYLLABLES]);
    return { whole: pool.filter((w) => w !== correct).slice(0, 3) };
  }
  const isJqx = JQX.includes(parts.initial);
  // j/q/x 不能带合口呼（u/ui/un）；iu 是齐齿呼，可以当干扰项。
  const noU = (v) => !(isJqx && KOU_HU_FINALS.includes(v));
  const out = { initial: [], medial: [], final: [] };

  if (parts.initial) {
    out.initial = uniq([...(INITIAL_CONFUSIONS[parts.initial] || []), ...INITIALS])
      .filter((v) => v !== parts.initial).slice(0, 3);
  }
  if (parts.medial) {
    // 介母槽照常给出 i/u/ü 三选（j/q/x 题也一样，正好练「只能配 i 或 ü」）。
    out.medial = uniq([...(MEDIAL_CONFUSIONS[parts.medial] || []), ...MEDIALS])
      .filter((v) => v !== parts.medial).slice(0, 3);
  }
  if (parts.final) {
    // 韵母槽对 j/q/x 排除带 u 的韵母：否则会出现「选 u 判错、但写成 ju 又是对的」的歧义。
    out.final = uniq([...(FINAL_CONFUSIONS[parts.final] || []), ...FILL_FINALS])
      .filter((v) => v !== parts.final && noU(v)).slice(0, 3);
  }
  return out;
}

/* ============================ 标签规则 ============================ */

const RETROFLEX = new Set(['zh', 'ch', 'sh', 'r']);
const SIBILANT = new Set(['z', 'c', 's']);
const FRONT_NASAL = new Set(['an', 'en', 'in', 'un', 'ün']);
const BACK_NASAL = new Set(['ang', 'eng', 'ing', 'ong']);
export const TYPE_LABEL = {
  two_part: '两拼音节', three_part: '三拼音节',
  zero_initial: '零声母音节', whole_syllable: '整体认读音节',
};

/** 生成与种子题库一致口径的标签。 */
export function buildTags(type, parts, specialRule) {
  const tags = [TYPE_LABEL[type]];
  let initial = parts.initial ?? null;
  let final = parts.final ?? null;

  if (type === 'whole_syllable') {
    const w = parts.whole;
    if (['zhi', 'chi', 'shi', 'ri'].includes(w)) tags.push('翘舌音');
    if (['zi', 'ci', 'si'].includes(w)) tags.push('平舌音');
    initial = null;
    final = w;
  } else {
    if (RETROFLEX.has(initial)) tags.push('翘舌音');
    if (SIBILANT.has(initial)) tags.push('平舌音');
  }
  if (specialRule) tags.push('j/q/x去点');
  if (FRONT_NASAL.has(final)) tags.push('前鼻音');
  if (BACK_NASAL.has(final)) tags.push('后鼻音');
  return tags;
}

/* ============================ 构建与合并 ============================ */

/**
 * 把「汉字 + 词组 + 带调拼音 + 提示」表格展开成完整任务对象，并逐条终审。
 * @param {Array<{hanzi:string, word:string, hint:string, pinyin:string}>} entries
 * @param {number} firstId 起始编号（不含 m_ 前缀的数字）
 * @returns {{missions:object[], errors:string[]}}
 */
export function buildMissions(entries, firstId) {
  const errors = [];
  const missions = entries.map((item, i) => {
    const id = 'm_' + String(firstId + i).padStart(3, '0');
    const parsed = parseSyllable(item.pinyin);
    const where = `${id} ${item.hanzi} ${item.pinyin}`;

    if (parsed.displayPinyin !== item.pinyin) {
      errors.push(`${where}: 标调不符 → 引擎算出 "${parsed.displayPinyin}"`);
    }
    for (const w of parsed.warnings) errors.push(`${where}: 拆分告警 ${w}`);
    if (!String(item.word ?? '').includes(item.hanzi)) {
      errors.push(`${where}: word「${item.word}」不含汉字「${item.hanzi}」`);
    }
    if (!(parsed.tone >= 1 && parsed.tone <= 4)) {
      errors.push(`${where}: 声调应为 1–4，实际 ${parsed.tone}`);
    }

    const { type, parts, tone, specialRule, displayPinyin } = parsed;
    const mission = {
      id,
      hanzi: item.hanzi,
      word: item.word,
      hint: item.hint,
      type,
      parts,
      tone,
      displayPinyin,
      distractors: buildDistractors(type, parts),
      specialRule,
      tags: buildTags(type, parts, specialRule),
      priority: 1,
      isParentInjected: false,
    };

    for (const e of validateMission(mission).errors) errors.push(`${where}: ${e}`);
    return mission;
  });
  return { missions, errors };
}

/**
 * 构建 → 合并进 data/missions.json → 报告（含全库 id / 汉字唯一性检查）。
 * @param {{entries:Array, firstId:number, source?:string, dryRun?:boolean}} opts
 */
export function runWordbank({ entries, firstId, source = '扩展', dryRun = false }) {
  const { missions, errors } = buildMissions(entries, firstId);

  const existing = JSON.parse(fs.readFileSync(MISSIONS_PATH, 'utf8'));
  const newIds = new Set(missions.map((m) => m.id));
  const newHanzi = new Set(missions.map((m) => m.hanzi));
  // 幂等：剔除本批 id 与本批汉字的旧条目（不动家长注入的其它条目）
  const kept = existing.filter((m) => !newIds.has(m.id) && !newHanzi.has(m.hanzi));
  const merged = [...kept, ...missions];

  const seenId = new Set();
  const seenHanzi = new Map();
  for (const m of merged) {
    if (seenId.has(m.id)) errors.push(`id 重复: ${m.id}`);
    seenId.add(m.id);
    if (seenHanzi.has(m.hanzi)) {
      errors.push(`汉字重复: ${m.hanzi}（${seenHanzi.get(m.hanzi)} 与 ${m.id}）`);
    }
    seenHanzi.set(m.hanzi, m.id);
  }

  /* ---------------- 报告 ---------------- */
  const counts = {};
  for (const m of missions) {
    const c = categoryOf(m);
    counts[c] = (counts[c] || 0) + 1;
  }
  const LABEL = { two: '两拼', three: '三拼', jqx: 'j/q/x+ü', whole: '整体认读', zero: '零声母' };

  console.log(`\n【${source}】新增词条 ${missions.length} 条（m_${String(firstId).padStart(3, '0')} 起）`);
  console.log('ID      汉字  拼音       构型              拆分                      标签');
  console.log('------  ----  ---------  ----------------  ------------------------  --------------------');
  for (const m of missions) {
    const split = m.type === 'whole_syllable'
      ? `整体:${m.parts.whole}`
      : [m.parts.initial, m.parts.medial, m.parts.final].filter((x) => x != null).join(' + ');
    console.log(
      `${m.id}  ${m.hanzi}    ${m.displayPinyin.padEnd(9)} ${m.type.padEnd(16)}  ${split.padEnd(24)}  ${m.tags.join('·')}`
    );
  }
  console.log(`构型分布：${Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${LABEL[k] || k} ${v}`).join(' · ')}`);
  console.log(`词库总量：${merged.length} 条（原 ${existing.length} + 新增 ${missions.length}，替换 ${existing.length - kept.length}）`);

  if (errors.length) {
    console.error(`\n❌ 【${source}】校验未通过：`);
    for (const e of errors) console.error('  - ' + e);
    return { ok: false, errors, missions, merged };
  }

  if (dryRun) {
    console.log(`🟡 【${source}】--dry-run：未写入 data/missions.json`);
    return { ok: true, errors: [], missions, merged };
  }

  fs.writeFileSync(MISSIONS_PATH, JSON.stringify(merged, null, 2) + '\n', 'utf8');
  console.log(`✅ 【${source}】已写入 data/missions.json`);
  return { ok: true, errors: [], missions, merged };
}

/** 命令行是否带 --dry-run。 */
export const isDryRun = () => process.argv.includes('--dry-run');
