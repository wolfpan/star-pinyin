/**
 * wordbank.test.mjs — 词库结构性验收（零依赖）
 * 运行：node test/wordbank.test.mjs
 *
 * 校验范围（种子 + 三年级扩展 + 家长注入全量）：
 *  - 汉字唯一、id 唯一；hanzi 为单个汉字且被 word 包含。
 *  - 提示语（hint）非空且不过长，声调 1–4（轻声不进词库）。
 *  - 每个活动槽的干扰项：1~3 个、互不重复、绝不含正确答案（validateMission 复核）。
 *  - j/q/x 音节不得带合口呼 u：既不能出现在正确拆分里，也不能作为干扰项。
 *  - 构型覆盖下限：两拼 / 三拼 / 整体认读 / 零声母 / j·q·x+ü 均需成规模。
 *  - 三年级扩展词条数量 ≥ 100，且都是「可用整库抽题」的正常条目。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateMission, categoryOf, RULE_DROP_DOTS, KOU_HU_FINALS } from '../public/js/pinyin-rules.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const missions = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'missions.json'), 'utf8'));

let pass = 0, fail = 0;
const failures = [];
function test(name, fn) {
  try { fn(); pass++; console.log('  \u2713 ' + name); }
  catch (e) { fail++; failures.push([name, e]); console.log('  \u2717 ' + name + ' \u2192 ' + e.message); }
}
const eq = assert.equal;
const ok = assert.ok;

const JQX = ['j', 'q', 'x'];
const HANZI_RE = /^[\u3400-\u4DBF\u4E00-\u9FFF]$/;
const TAGS = new Set([
  '两拼音节', '三拼音节', '零声母音节', '整体认读音节',
  '平舌音', '翘舌音', '前鼻音', '后鼻音', 'j/q/x去点', '家长注入',
]);

/** 该题真正需要孩子拖动的槽位。 */
function activeGroups(m) {
  if (m.type === 'whole_syllable') return ['whole'];
  if (m.type === 'zero_initial') return ['final'];
  if (m.type === 'two_part') return ['initial', 'final'];
  return ['initial', 'medial', 'final'];
}

const extendIds = missions
  .filter((m) => {
    if (m.isParentInjected) return false;
    const n = Number(String(m.id).replace(/^m_/, ''));
    return Number.isFinite(n) && n >= 41; // m_041–m_1000 三批扩展 + m_1001+ 课文同步扩展
  })
  .map((m) => m.id);

console.log(`\n[1] 词库规模（共 ${missions.length} 条）`);
test(`词库 ≥ 1000 条（实际 ${missions.length}）`, () => ok(missions.length >= 1000, `实际 ${missions.length}`));
test(`扩展词条 ≥ 960（实际 ${extendIds.length}）`, () => ok(extendIds.length >= 960, `实际 ${extendIds.length}`));

console.log('\n[2] 标识与文本字段');
const dupIds = [];
const dupHanzi = [];
const seenId = new Set();
const seenHanzi = new Set();
for (const m of missions) {
  if (seenId.has(m.id)) dupIds.push(m.id);
  seenId.add(m.id);
  if (seenHanzi.has(m.hanzi)) dupHanzi.push(m.hanzi);
  seenHanzi.add(m.hanzi);
}
test('id 唯一', () => eq(dupIds.join(','), ''));
test('汉字唯一（同一字不重复出题）', () => eq(dupHanzi.join(','), ''));

const badHanzi = missions.filter((m) => !HANZI_RE.test(String(m.hanzi ?? ''))).map((m) => m.id);
test('hanzi 均为单个汉字', () => eq(badHanzi.join(','), ''));

const badWord = missions.filter((m) => typeof m.word !== 'string' || !m.word.includes(m.hanzi)).map((m) => m.id);
test('word 包含 hanzi', () => eq(badWord.join(','), ''));

const badHint = missions
  .filter((m) => typeof m.hint !== 'string' || m.hint.trim().length < 2 || m.hint.length > 30)
  .map((m) => m.id);
test('hint 存在且 2–30 字', () => eq(badHint.join(','), ''));

const badTone = missions.filter((m) => !(Number(m.tone) >= 1 && Number(m.tone) <= 4)).map((m) => m.id);
test('声调均为 1–4（不含轻声）', () => eq(badTone.join(','), ''));

const badTags = missions
  .filter((m) => !Array.isArray(m.tags) || m.tags.length === 0 || m.tags.some((t) => !TAGS.has(t)))
  .map((m) => m.id);
test('tags 非空且用词规范', () => eq(badTags.join(','), ''));

console.log('\n[3] 干扰项质量');
const disProblems = [];
for (const m of missions) {
  for (const group of activeGroups(m)) {
    const correct = m.parts[group];
    const list = m.distractors?.[group];
    const where = `${m.id}/${group}`;
    if (!Array.isArray(list) || list.length < 1 || list.length > 3) {
      disProblems.push(`${where}: 干扰项数量 ${Array.isArray(list) ? list.length : 'N/A'}`);
      continue;
    }
    if (list.includes(correct)) disProblems.push(`${where}: 含正确答案`);
    if (new Set(list).size !== list.length) disProblems.push(`${where}: 干扰项重复`);
    if (list.some((v) => typeof v !== 'string' || !v)) disProblems.push(`${where}: 空干扰项`);
  }
  // 不活动的槽位应留空，避免 UI 误导
  for (const group of ['initial', 'medial', 'final', 'whole']) {
    if (activeGroups(m).includes(group)) continue;
    const list = m.distractors?.[group];
    if (Array.isArray(list) && list.length) disProblems.push(`${m.id}/${group}: 非活动槽位不应有干扰项`);
  }
}
test('每槽 1–3 个干扰项且不含答案', () => eq(disProblems.join(' | '), ''));

console.log('\n[4] j/q/x 合口呼约束（不能与 u/ui/un 相拼）');
const jqxProblems = [];
for (const m of missions) {
  if (!JQX.includes(m.parts?.initial)) continue;
  if (m.parts.medial && m.parts.medial.includes('u')) jqxProblems.push(`${m.id}: 介母为 u`);
  if (KOU_HU_FINALS.includes(m.parts.final)) jqxProblems.push(`${m.id}: 韵母为合口呼 ${m.parts.final}`);
}
test('j/q/x 题的正确拆分不含合口呼', () => eq(jqxProblems.join(' | '), ''));

// 三年级/小学扩展词条的韵母干扰项由引擎生成，额外排除「j/q/x + 合口呼」这种写法歧义
// （选 u 判错、但写成 ju 又是对的）。介母槽保留 i/u/ü 三选，正是 j/q/x 的考点。
// 种子题库保留原始设计，不做此约束。
const EXT = new Set(extendIds);
const jqxDisProblems = [];
for (const m of missions) {
  if (!EXT.has(m.id) || !JQX.includes(m.parts?.initial)) continue;
  for (const v of m.distractors?.final || []) {
    if (KOU_HU_FINALS.includes(v)) jqxDisProblems.push(`${m.id}: 韵母干扰项为合口呼 (${v})`);
  }
}
test('扩展词条 j/q/x 韵母干扰项不含合口呼', () => eq(jqxDisProblems.join(' | '), ''));

console.log('\n[5] 规则引擎终审与构型覆盖');
const invalid = missions.map((m) => [m.id, validateMission(m)]).filter(([, r]) => !r.ok);
test('全库通过 validateMission', () => {
  const msg = invalid.map(([id, r]) => `${id}: ${r.errors.join(' | ')}`).join(' ; ');
  eq(msg, '');
});

const counts = {};
for (const m of missions) {
  const c = categoryOf(m);
  counts[c] = (counts[c] || 0) + 1;
}
const floor = { two: 380, three: 240, jqx: 60, whole: 120, zero: 28 };
for (const [k, min] of Object.entries(floor)) {
  test(`${k} 类 ≥ ${min}（实际 ${counts[k] || 0}）`, () => ok((counts[k] || 0) >= min, `实际 ${counts[k] || 0}`));
}

const dropDotsButNoRule = missions
  .filter((m) => JQX.includes(m.parts?.initial)
    && ((m.parts.medial ?? '').includes('ü') || (m.parts.final ?? '').includes('ü'))
    && m.specialRule !== RULE_DROP_DOTS)
  .map((m) => m.id);
test('j/q/x + ü 均标记摘墨镜规则', () => eq(dropDotsButNoRule.join(','), ''));

console.log(`\n词库结构测试结果: ${pass} 通过, ${fail} 失败`);
if (fail) {
  console.error('\n失败明细:');
  for (const [name, e] of failures) console.error(`  - ${name}: ${e.message}`);
  process.exit(1);
}
