/**
 * unit-session.test.mjs — 单元完成规则纯逻辑验收（零依赖）
 * 运行：node test/unit-session.test.mjs
 *
 * 校验范围：
 *  - 有效单元：一上汉语拼音课（unit=null）归入其后园地所在单元（2/3/4），其余册不变。
 *  - 单元列表 / 新字数与教材目录一致。
 *  - 题单构建：新字按教材顺序、过往字抽 5 个、错题优先、紧急载荷不入单、不足 5 个全取。
 *  - 错题池：有错入池清零、连续全对 3 次毕业、中途再错清零、非错题全对不变。
 *  - 进度视图 cursor/total/done/remaining。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getBook, lessonChars } from '../public/js/textbook.js';
import {
  WRONG_FIX_TARGET, UNIT_REVIEW_COUNT,
  effectiveUnitMap, unitList, unitFirstSeq, isPastMission,
  buildUnitQueue, updateWrongStat, unitSessionView, formatUnitLabel,
} from '../public/js/unit-session.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, '..', 'data');
const catalog = JSON.parse(fs.readFileSync(path.join(DATA, 'textbook.json'), 'utf8'));
const missions = JSON.parse(fs.readFileSync(path.join(DATA, 'missions.json'), 'utf8'));

let pass = 0, fail = 0;
const failures = [];
function test(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; failures.push([name, e]); console.log('  ✗ ' + name + ' → ' + e.message); }
}
const eq = assert.equal;
const ok = assert.ok;
// 确定性 rng（LCG），便于断言洗牌结果
const seeded = (seed = 42) => () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;

console.log('\n[1] 有效单元（汉语拼音课归入其后园地单元）');
test('一上拼音3/4→单元2，5-9→单元3，10-14→单元4', () => {
  const map = effectiveUnitMap(catalog, 1, 1);
  eq(map.get(6), 2); eq(map.get(7), 2);            // 汉语拼音3/4
  eq(map.get(9), 3); eq(map.get(13), 3);           // 汉语拼音5..9
  eq(map.get(15), 4); eq(map.get(19), 4);          // 汉语拼音10..14
  eq(map.get(1), 1); eq(map.get(5), 1);            // 识字1 / 园地一
  eq(map.get(8), 2); eq(map.get(14), 3); eq(map.get(20), 4); // 园地二/三/四
  eq(map.get(21), 5); eq(map.get(38), 8);          // 课文单元5..8
});
test('其余各册单元号与目录原值一致（无 null 课）', () => {
  for (const [g, t] of [[1, 2], [2, 1], [2, 2], [3, 1], [3, 2]]) {
    const map = effectiveUnitMap(catalog, g, t);
    for (const l of getBook(catalog, g, t).lessons) eq(map.get(l.seq), Number(l.unit));
  }
});
test('每册 8 个单元，新字数与目录可出题字一致', () => {
  for (const g of catalog.grades) for (const b of g.books) {
    const units = unitList(catalog, g.grade, b.term);
    eq(units.length, 8);
    eq(units.map((u) => u.unit).join(','), '1,2,3,4,5,6,7,8');
    for (const u of units) {
      const map = effectiveUnitMap(catalog, g.grade, b.term);
      const expect = b.lessons.filter((l) => map.get(l.seq) === u.unit)
        .flatMap((l) => lessonChars(l)).filter((c) => !c.skip).length;
      eq(u.newCount, expect);
    }
  }
});

console.log('\n[2] 题单构建');
const tbMissions = missions.filter((m) => m.textbook && m.textbook.grade != null);
test('新字 = 本单元全部可出题字，按教材顺序，kind=new', () => {
  const built = buildUnitQueue(missions, catalog, 1, 1, 5, {}, { rng: seeded() });
  const u5 = unitList(catalog, 1, 1).find((x) => x.unit === 5);
  eq(built.newCount, u5.newCount);
  const newItems = built.queue.filter((x) => x.kind === 'new');
  eq(newItems.length, built.newCount);
  // 教材顺序：课序升序，课内按字序
  const map = effectiveUnitMap(catalog, 1, 1);
  const order = [];
  for (const l of getBook(catalog, 1, 1).lessons) {
    if (map.get(l.seq) !== 5) continue;
    for (const c of lessonChars(l)) if (!c.skip) order.push(c.hanzi);
  }
  const byId = new Map(missions.map((m) => [m.id, m]));
  eq(newItems.map((x) => byId.get(x.missionId).hanzi).join(''), order.join(''));
});
test('第一单元无过往字 → 复习 0；后续单元复习满 5', () => {
  const u1 = buildUnitQueue(missions, catalog, 1, 1, 1, {}, { rng: seeded() });
  eq(u1.reviewCount, 0);
  const u5 = buildUnitQueue(missions, catalog, 1, 1, 5, {}, { rng: seeded() });
  eq(u5.reviewCount, UNIT_REVIEW_COUNT);
  eq(u5.queue.length, u5.newCount + UNIT_REVIEW_COUNT);
});
test('过往字严格早于本单元第一课，且不含紧急载荷', () => {
  const first = unitFirstSeq(catalog, 1, 1, 5);
  const built = buildUnitQueue(missions, catalog, 1, 1, 5, {}, { rng: seeded() });
  const byId = new Map(missions.map((m) => [m.id, m]));
  for (const item of built.queue.filter((x) => x.kind === 'review')) {
    const m = byId.get(item.missionId);
    ok(isPastMission(m, 1, 1, first), `${m.hanzi} 不是过往字`);
    ok(!m.isParentInjected);
  }
});
test('错题优先：错题池中的过往字先占满复习名额', () => {
  const first = unitFirstSeq(catalog, 1, 1, 5);
  const past = tbMissions.filter((m) => isPastMission(m, 1, 1, first));
  const wrongIds = past.slice(0, 3).map((m) => m.id);
  const stats = {};
  for (const id of wrongIds) stats[id] = { wrong: true, fixes: 1 };
  const built = buildUnitQueue(missions, catalog, 1, 1, 5, stats, { rng: seeded(7) });
  const review = built.queue.filter((x) => x.kind === 'review').map((x) => x.missionId);
  eq(review.length, UNIT_REVIEW_COUNT);
  // 前 3 个复习名额恰为错题池（顺序可洗牌），后 2 个为非错题
  eq(new Set(review.slice(0, 3)).size, 3);
  for (const id of wrongIds) ok(review.slice(0, 3).includes(id), `错题 ${id} 未优先`);
  for (const id of review.slice(3)) ok(!wrongIds.includes(id));
});
test('错题不足 5 个时用普通过往字补满；过往字总数不足 5 则全取', () => {
  const first = unitFirstSeq(catalog, 1, 1, 5);
  const past = tbMissions.filter((m) => isPastMission(m, 1, 1, first));
  const stats = { [past[0].id]: { wrong: true } };
  const built = buildUnitQueue(missions, catalog, 1, 1, 5, stats, { rng: seeded(3) });
  eq(built.reviewCount, UNIT_REVIEW_COUNT);
  ok(built.queue.filter((x) => x.kind === 'review').some((x) => x.missionId === past[0].id));
});

console.log('\n[3] 错题池：连续全对 3 次毕业');
test('有错 → 入池且连续计数清零', () => {
  const s = { wrong: true, fixes: 2 };
  updateWrongStat(s, false);
  eq(s.wrong, true); eq(s.fixes, 0);
});
test('错题池中连续全对 3 次 → 毕业（不再优先）', () => {
  const s = {};
  updateWrongStat(s, false);            // 出错入池
  eq(s.wrong, true); eq(s.fixes, 0);
  updateWrongStat(s, true); eq(s.fixes, 1); eq(s.wrong, true);
  updateWrongStat(s, true); eq(s.fixes, 2); eq(s.wrong, true);
  updateWrongStat(s, true); eq(s.fixes, 3); eq(s.wrong, false); // 第 3 次毕业
  eq(WRONG_FIX_TARGET, 3);
});
test('中途再错 → 连续计数清零，需重新攒满 3 次', () => {
  const s = {};
  updateWrongStat(s, false);
  updateWrongStat(s, true); updateWrongStat(s, true); // fixes 2
  updateWrongStat(s, false); eq(s.fixes, 0); eq(s.wrong, true); // 再错清零
  updateWrongStat(s, true); updateWrongStat(s, true); eq(s.wrong, true); // 仅 2 次未毕业
  updateWrongStat(s, true); eq(s.wrong, false); // 重新攒满 3 次毕业
});
test('非错题全对 → 不入池、不计数', () => {
  const s = { attempts: 5, errors: 0 };
  updateWrongStat(s, true);
  eq(s.wrong, false); eq(s.fixes, 0);
});
test('毕业后再错 → 重新入池', () => {
  const s = { wrong: false, fixes: 3 };
  updateWrongStat(s, false);
  eq(s.wrong, true); eq(s.fixes, 0);
});

console.log('\n[4] 进度视图 / 文案');
test('unitSessionView 计算 cursor/total/done/remaining', () => {
  const s = { grade: 1, term: 1, unit: 5, queue: [{}, {}, {}], cursor: 1, newCount: 2, reviewCount: 1 };
  const v = unitSessionView(s);
  eq(v.total, 3); eq(v.cursor, 1); eq(v.remaining, 2); eq(v.done, false);
  eq(v.label, '一年级上册 · 第5单元');
  s.cursor = 3; eq(unitSessionView(s).done, true); eq(unitSessionView(s).remaining, 0);
  eq(unitSessionView(null), null);
});
test('formatUnitLabel 含年级/学期/单元', () => {
  eq(formatUnitLabel(2, 2, 3), '二年级下册 · 第3单元');
});

console.log(`\n单元完成规则纯逻辑测试结果: ${pass} 通过, ${fail} 失败`);
if (fail) {
  console.error('\n失败明细:');
  for (const [name, e] of failures) console.error(`  - ${name}: ${e.message}`);
  process.exit(1);
}