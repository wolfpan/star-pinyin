/**
 * seeds.test.mjs — 种子题库验收（零依赖）
 * 运行：node test/seeds.test.mjs   （等价于 npm run validate）
 *
 * 验收标准：
 *  - 40 个种子任务（m_001–m_040）的「拆分 / 标调 / 特殊规则判定」100% 准确。
 *  - 种子覆盖配额：10 两拼（平翘舌+前后鼻音）/ 15 三拼 / 8 j-q-x+ü / 7 整体认读。
 *  - 全库（种子 + 三年级扩展词库 + 家长注入）逐条通过规则校验，无 id 重复。
 *  - badges.json 预置 16 枚火箭卡片（14 真实 + 2 未来概念旗舰）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateMission, categoryOf } from '../public/js/pinyin-rules.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, '..', 'data');
const missions = JSON.parse(fs.readFileSync(path.join(DATA, 'missions.json'), 'utf8'));
const badges = JSON.parse(fs.readFileSync(path.join(DATA, 'badges.json'), 'utf8'));

const SEED_IDS = new Set(Array.from({ length: 40 }, (_, i) => 'm_' + String(i + 1).padStart(3, '0')));
const seeds = missions.filter((m) => SEED_IDS.has(m.id));

let ok = 0;
const bad = [];
const counts = { two: 0, three: 0, jqx: 0, whole: 0, zero: 0, unknown: 0 };
const ids = new Set();

console.log('\n—— 40 个种子任务 ——');
console.log('序号  ID      汉字  拼音      类别        拆分                 结果');
console.log('----  ------  ----  --------  ----------  -------------------  ----');

seeds.forEach((m, i) => {
  const r = validateMission(m);
  const cat = categoryOf(m);
  counts[cat] = (counts[cat] || 0) + 1;

  const partsStr = m.type === 'whole_syllable'
    ? `整体:${m.parts.whole}`
    : [m.parts.initial, m.parts.medial, m.parts.final].filter((x) => x != null).join('+');
  const num = String(i + 1).padStart(2, '0');
  const mark = r.ok ? '✓' : '✗';
  console.log(
    `${num}    ${m.id.padEnd(6)}  ${m.hanzi}    ${m.displayPinyin.padEnd(8)}  ${cat.padEnd(10)}  ${partsStr.padEnd(19)}  ${mark}`
  );
  if (r.ok) ok++;
  else bad.push([m.id, r.errors]);
});

console.log('\n—— 种子覆盖配额检查 ——');
const expected = { two: 10, three: 15, jqx: 8, whole: 7 };
const labels = { two: '两拼音节(平翘舌/前后鼻音)', three: '三拼音节', jqx: 'j/q/x+ü 规则题', whole: '整体认读音节' };
let quotaOk = true;
for (const [k, want] of Object.entries(expected)) {
  const got = counts[k] || 0;
  const good = got === want;
  if (!good) quotaOk = false;
  console.log(`  ${good ? '✓' : '✗'} ${labels[k]}: ${got} / ${want}`);
}
console.log(`  ${seeds.length === 40 ? '✓' : '✗'} 种子任务总数: ${seeds.length} / 40`);

/* ----------------------------- 全库校验 ----------------------------- */

console.log('\n—— 全库规则校验（种子 + 三年级扩展 + 家长注入） ——');
const totalCounts = { two: 0, three: 0, jqx: 0, whole: 0, zero: 0, unknown: 0 };
let totalOk = 0;
const duplicateIds = [];
let extensionCount = 0;
for (const m of missions) {
  if (ids.has(m.id)) duplicateIds.push(m.id);
  ids.add(m.id);

  const r = validateMission(m);
  const cat = categoryOf(m);
  totalCounts[cat] = (totalCounts[cat] || 0) + 1;
  if (r.ok) totalOk++;
  else bad.push([m.id, r.errors]);

  const num = Number(String(m.id).replace(/^m_(?:p_)?/, ''));
  if (Number.isFinite(num) && num >= 41 && !m.isParentInjected) extensionCount++;
}
console.log(`  ${totalOk === missions.length && !duplicateIds.length ? '✓' : '✗'} 规则准确性: ${totalOk} / ${missions.length} 通过`);
console.log(`  ${extensionCount >= 960 ? '✓' : '✗'} 扩展词条（m_041 起）: ${extensionCount} / 960`);
console.log(`  ${duplicateIds.length === 0 ? '✓' : '✗'} id 唯一: ${ids.size} 个`);
console.log(
  `  · 全库构型分布：两拼 ${totalCounts.two} · 三拼 ${totalCounts.three} · j/q/x+ü ${totalCounts.jqx}`
  + ` · 整体认读 ${totalCounts.whole} · 零声母 ${totalCounts.zero}`
);

// 勋章卡片基本校验（16 枚火箭：14 真实 + 2 未来概念旗舰）
const badgeIds = new Set();
let badgeOk = badges.length === 16;
for (const b of badges) {
  if (badgeIds.has(b.id)) badgeOk = false;
  badgeIds.add(b.id);
  if (!b.name || !b.summary || typeof b.unlockAt !== 'number') badgeOk = false;
}
console.log(`  · 勋章卡片: ${badges.length} / 16`);

const allPass = ok === seeds.length && seeds.length === 40 && quotaOk
  && totalOk === missions.length && duplicateIds.length === 0
  && extensionCount >= 960 && badgeOk && bad.length === 0;

console.log('\n—— 验收结论 ——');
if (bad.length) {
  console.error('以下任务规则校验未通过:');
  for (const [id, errs] of bad) console.error(`  ${id}: ${errs.join(' | ')}`);
}
console.log(`种子规则准确性: ${ok}/${seeds.length} 通过 · 全库 ${totalOk}/${missions.length} 通过`);
console.log(allPass ? '✅ 种子题库 + 三年级扩展词库验收通过：拆分 / 标调 / 规则判定 100% 准确。'
                    : '❌ 验收未通过，请修正上述问题。');
process.exit(allPass ? 0 : 1);
