/**
 * unit-session.test.mjs — 单元完成规则纯逻辑验收（零依赖）
 * 运行：node test/unit-session.test.mjs
 *
 * 「单元」= 一课（识字N / 第N课 / 语文园地 / 汉语拼音），以 seq 标识。
 * 校验范围：
 *  - 课新字数 / 单元标签与教材目录一致。
 *  - 题单构建：新字按教材顺序全部收入；复习名额 = 总字数 − 新字数（总字数 10~20 可配）；
 *    错题优先、紧急载荷不入单、过往字不足名额全取、首课无复习、新字超总字数时不另抽复习。
 *  - 同一个汉字在本单元只出现一次（新字唯一、复习与新字不重叠）。
 *  - 错题池：有错入池清零、连续全对 3 次毕业、中途再错清零、非错题全对不变。
 *  - 进度视图 / 首尾发射动画判定。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getBook, lessonChars } from '../public/js/textbook.js';
import {
  WRONG_FIX_TARGET, UNIT_TOTAL_MIN, UNIT_TOTAL_MAX, UNIT_TOTAL_DEFAULT, clampUnitTotal,
  lessonNewCount, unitLabel, isPastMission,
  buildUnitQueue, updateWrongStat, unitSessionView, unitFxPlays,
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
const seeded = (seed = 42) => () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const lessonOf = (g, t, s) => (getBook(catalog, g, t)?.lessons || []).find((l) => l.seq === s);
const newHanziOf = (g, t, s) => lessonChars(lessonOf(g, t, s)).filter((c) => !c.skip).map((c) => c.hanzi);
const pastCount = (g, t, s) => missions.filter((m) => m.textbook && isPastMission(m, g, t, s)).length;

console.log('\n[1] 课新字数 / 单元标签 / 总字数规范化');
test('lessonNewCount 与目录可出题字一致（含汉语拼音课）', () => {
  for (const [g, t, s] of [[1, 1, 1], [1, 1, 2], [1, 1, 6], [1, 1, 21], [2, 1, 3], [3, 2, 5]]) {
    eq(lessonNewCount(catalog, g, t, s), newHanziOf(g, t, s).length);
  }
});
test('unitLabel 为课文来源文案', () => {
  eq(unitLabel(catalog, 1, 1, 2), '一年级上册 · 识字2《金木水火土》');
  eq(unitLabel(catalog, 1, 1, 21), '一年级上册 · 第1课《秋天》');
});
test('clampUnitTotal 夹回 10~20，非法回默认 15', () => {
  eq(UNIT_TOTAL_MIN, 10); eq(UNIT_TOTAL_MAX, 20); eq(UNIT_TOTAL_DEFAULT, 15);
  eq(clampUnitTotal(5), 10); eq(clampUnitTotal(25), 20); eq(clampUnitTotal(15), 15);
  eq(clampUnitTotal(12.9), 12); eq(clampUnitTotal('abc'), 15); eq(clampUnitTotal(undefined), 15);
});

console.log('\n[2] 题单构建：复习名额 = 总字数 − 新字数');
const tbMissions = missions.filter((m) => m.textbook && m.textbook.grade != null);
const byId = new Map(missions.map((m) => [m.id, m]));
test('新字 = 本课全部可出题字，按教材顺序，kind=new', () => {
  const built = buildUnitQueue(missions, catalog, 1, 1, 2, {}, { rng: seeded() });
  eq(built.newCount, newHanziOf(1, 1, 2).length);
  const newItems = built.queue.filter((x) => x.kind === 'new');
  eq(newItems.map((x) => byId.get(x.missionId).hanzi).join(''), newHanziOf(1, 1, 2).join(''));
});
test('首课无过往字 → 复习 0（与总字数无关）', () => {
  for (const total of [10, 15, 20]) {
    const b = buildUnitQueue(missions, catalog, 1, 1, 1, {}, { rng: seeded(), total });
    eq(b.reviewCount, 0); eq(b.queue.length, b.newCount);
  }
});
test('默认总字数 15：复习名额 = 15 − 新字（过往字充足时）', () => {
  const b = buildUnitQueue(missions, catalog, 1, 1, 21, {}, { rng: seeded() }); // 秋天 10 新字
  eq(b.newCount, 10);
  eq(b.reviewCount, UNIT_TOTAL_DEFAULT - 10); // 5
  eq(b.queue.length, UNIT_TOTAL_DEFAULT);
});
test('总字数可配 10~20：复习名额随之变化', () => {
  const b20 = buildUnitQueue(missions, catalog, 1, 1, 21, {}, { rng: seeded(), total: 20 });
  eq(b20.reviewCount, 10); eq(b20.queue.length, 20);
  const b10 = buildUnitQueue(missions, catalog, 1, 1, 21, {}, { rng: seeded(), total: 10 });
  eq(b10.reviewCount, 0); eq(b10.queue.length, 10); // 新字已占满
});
test('新字多于总字数 → 只练全部新字，不另抽复习', () => {
  const b = buildUnitQueue(missions, catalog, 1, 1, 23, {}, { rng: seeded(), total: 10 }); // 雪地 11 新字
  eq(b.newCount, 11); eq(b.reviewCount, 0); eq(b.queue.length, 11);
});
test('过往字不足复习名额 → 有几个抽几个', () => {
  // 识字2 之前仅识字1 的 6 字；总字数 15 → 名额 8，但过往只有 6
  const b = buildUnitQueue(missions, catalog, 1, 1, 2, {}, { rng: seeded(), total: 15 });
  eq(b.reviewCount, Math.min(15 - b.newCount, pastCount(1, 1, 2)));
  eq(b.reviewCount, pastCount(1, 1, 2));
});
test('同一个汉字不重复：新字唯一、复习字与新字不重叠', () => {
  const built = buildUnitQueue(missions, catalog, 1, 1, 21, {}, { rng: seeded(), total: 20 });
  const ids = built.queue.map((x) => x.missionId);
  eq(new Set(ids).size, ids.length, '题单内有重复词条');
  const newSet = new Set(built.queue.filter((x) => x.kind === 'new').map((x) => byId.get(x.missionId).hanzi));
  for (const x of built.queue.filter((x) => x.kind === 'review')) ok(!newSet.has(byId.get(x.missionId).hanzi), '复习字与新字重叠');
});
test('过往字严格早于本课，且不含紧急载荷', () => {
  const built = buildUnitQueue(missions, catalog, 1, 1, 21, {}, { rng: seeded() });
  for (const item of built.queue.filter((x) => x.kind === 'review')) {
    const m = byId.get(item.missionId);
    ok(isPastMission(m, 1, 1, 21), `${m.hanzi} 不是过往字`);
    ok(!m.isParentInjected);
  }
});
test('错题优先：错题池中的过往字先占复习名额', () => {
  const past = tbMissions.filter((m) => isPastMission(m, 1, 1, 21));
  const wrongIds = past.slice(0, 3).map((m) => m.id);
  const stats = {};
  for (const id of wrongIds) stats[id] = { wrong: true, fixes: 1 };
  const built = buildUnitQueue(missions, catalog, 1, 1, 21, stats, { rng: seeded(7), total: 15 });
  const review = built.queue.filter((x) => x.kind === 'review').map((x) => x.missionId);
  eq(review.length, 5);
  for (const id of wrongIds) ok(review.slice(0, 3).includes(id), `错题 ${id} 未优先`);
  for (const id of review.slice(3)) ok(!wrongIds.includes(id));
});

console.log('\n[3] 错题池：连续全对 3 次毕业');
test('有错 → 入池且连续计数清零', () => {
  const s = { wrong: true, fixes: 2 };
  updateWrongStat(s, false);
  eq(s.wrong, true); eq(s.fixes, 0);
});
test('错题池中连续全对 3 次 → 毕业（不再优先）', () => {
  const s = {};
  updateWrongStat(s, false); eq(s.wrong, true); eq(s.fixes, 0);
  updateWrongStat(s, true); eq(s.fixes, 1); eq(s.wrong, true);
  updateWrongStat(s, true); eq(s.fixes, 2); eq(s.wrong, true);
  updateWrongStat(s, true); eq(s.fixes, 3); eq(s.wrong, false);
  eq(WRONG_FIX_TARGET, 3);
});
test('中途再错 → 连续计数清零，需重新攒满 3 次', () => {
  const s = {};
  updateWrongStat(s, false);
  updateWrongStat(s, true); updateWrongStat(s, true);
  updateWrongStat(s, false); eq(s.fixes, 0); eq(s.wrong, true);
  updateWrongStat(s, true); updateWrongStat(s, true); eq(s.wrong, true);
  updateWrongStat(s, true); eq(s.wrong, false);
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

console.log('\n[4] 进度视图 / 发射动画');
test('unitSessionView 计算 cursor/total/done/remaining（seq + label）', () => {
  const s = { grade: 1, term: 1, seq: 2, label: '一年级上册 · 识字2《金木水火土》', queue: [{}, {}, {}], cursor: 1, newCount: 2, reviewCount: 1 };
  const v = unitSessionView(s);
  eq(v.seq, 2); eq(v.total, 3); eq(v.cursor, 1); eq(v.remaining, 2); eq(v.done, false);
  s.cursor = 3; eq(unitSessionView(s).done, true); eq(unitSessionView(s).remaining, 0);
  eq(unitSessionView(null), null);
});
test('发射动画：仅首题与末题播放，中间跳过', () => {
  const v = (cursor, total) => ({ cursor, total });
  eq(unitFxPlays(v(0, 12)), true);
  eq(unitFxPlays(v(11, 12)), true);
  eq(unitFxPlays(v(1, 12)), false);
  eq(unitFxPlays(v(6, 12)), false);
  eq(unitFxPlays(v(0, 1)), true);
  eq(unitFxPlays(null), true);
});

console.log(`\n单元完成规则纯逻辑测试结果: ${pass} 通过, ${fail} 失败`);
if (fail) {
  console.error('\n失败明细:');
  for (const [name, e] of failures) console.error(`  - ${name}: ${e.message}`);
  process.exit(1);
}