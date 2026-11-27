/**
 * textbook.test.mjs — 课文同步验收（零依赖）
 * 运行：node test/textbook.test.mjs
 *
 * 校验范围：
 *  - data/textbook.json 目录结构：一~三年级 × 上下册，seq 连续，写字表总数吻合。
 *  - 教材生字全库唯一；拼音经 parseSyllable 终审；word 含字；轻声字带 skip。
 *  - 词库覆盖：每个非 skip 教材生字都有任务，且 textbook 引用与教材位置一致、读音一致。
 *  - 纯逻辑：进度规范化 / 累计字集 / 抽题过滤（紧急注入豁免）/ 文案。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSyllable } from '../public/js/pinyin-rules.js';
import {
  TEXTBOOK_VERSION, GRADE_LABELS, buildHanziIndex, flattenLessons, getBook,
  normalizeSelection, validateSelection, selectionKey, allowedHanzi, countAllowed,
  filterMissionsByTextbook, formatLesson, formatLessonSource, formatSelection, lessonRef,
} from '../public/js/textbook.js';

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

console.log('\n[1] 教材目录结构（2026 最新统编版一~三年级）');
test('版本标记 pep-2024', () => eq(catalog.version, TEXTBOOK_VERSION));
test('覆盖一~三年级', () => eq(catalog.grades.map((g) => g.grade).join(','), '1,2,3'));
for (const g of catalog.grades) {
  test(`${GRADE_LABELS[g.grade]}有上下两册`, () => eq(g.books.map((b) => b.term).join(','), '1,2'));
  for (const b of g.books) {
    const lessons = b.lessons || [];
    test(`${b.label} seq 连续（${lessons.length} 课）`, () => {
      ok(lessons.length > 0, '无课文');
      eq(lessons.map((l) => l.seq).join(','), lessons.map((_, i) => i + 1).join(','));
    });
    const chars = lessons.flatMap((l) => l.chars || []);
    const writeChars = chars.filter((c) => !c.skip);
    test(`${b.label} 生字条目与官方吻合（${chars.length}，可出题 ${writeChars.length}）`, () => {
      // 有识字表时目录条目 = 识字表页脚总数；没有识字表时退回写字表总数
      const official = b.recognTotal ?? b.writeTotal;
      if (official != null) eq(chars.length, official);
      ok(writeChars.length > 0);
    });
  }
}

console.log('\n[2] 教材生字质量');
const index = buildHanziIndex(catalog);
const allChars = flattenLessons(catalog).flatMap((l) => (l.chars || []).map((c) => ({ ...c, grade: l.grade, term: l.term, title: l.title })));
test('每册目录生字条目数 = 官方识字表页脚', () => {
  for (const g of catalog.grades) for (const b of g.books) {
    const n = b.lessons.reduce((s, l) => s + (l.chars || []).length, 0);
    if (b.recognTotal != null) eq(n, b.recognTotal, `${b.label} 条目 ${n} ≠ 识字表 ${b.recognTotal}`);
  }
});
test('重复字只占少数（新版教材存在跨册/同册重复，如实保留）', () => {
  const dup = allChars.length - index.size;
  ok(dup >= 0 && dup <= 40, `重复条目 ${dup}（预期 ≤ 40）`);
});
test('每个字都能定位到首次教学位置', () => {
  for (const [hanzi, ref] of index) {
    ok(ref.grade >= 1 && ref.grade <= 3, `${hanzi} 年级异常`);
    ok(ref.seq >= 1, `${hanzi} seq 异常`);
    ok(typeof ref.title === 'string' && ref.title.length > 0, `${hanzi} 缺课名`);
  }
});
const badPinyin = [];
const badWord = [];
const badSkip = [];
for (const c of allChars) {
  if (!String(c.word ?? '').includes(c.hanzi)) badWord.push(`${c.hanzi}(${c.word})`);
  if (c.skip) {
    if (/[āáǎàōóǒòēéěèīíǐìūúǔùǖǘǚǜ]/.test(c.pinyin || '')) badSkip.push(c.hanzi);
    continue;
  }
  const p = parseSyllable(c.pinyin);
  if (p.displayPinyin !== c.pinyin || p.warnings.length || !(p.tone >= 1 && p.tone <= 4)) {
    badPinyin.push(`${c.hanzi}:${c.pinyin}`);
  }
}
test('word 均含该字', () => eq(badWord.join(','), ''));
test('拼音标调/拆分全部合法', () => eq(badPinyin.join(','), ''));
test('轻声 skip 字不带声调', () => eq(badSkip.join(','), ''));

console.log('\n[3] 词库与课文同步');
const byHanzi = new Map(missions.map((m) => [m.hanzi, m]));
const uncovered = [];
const mismatch = [];
for (const [hanzi, ref] of index) {
  const m = byHanzi.get(hanzi);
  if (ref.skip) continue;
  if (!m) { uncovered.push(hanzi); continue; }
  if (m.isParentInjected) continue; // 家长注入保留自己的读音/词组，不受教材一致性约束
  if (!m.textbook) { mismatch.push(`${hanzi}: 缺 textbook 引用`); continue; }
  if (m.textbook.grade !== ref.grade || m.textbook.term !== ref.term || m.textbook.seq !== ref.seq
    || m.textbook.title !== ref.title || m.textbook.no !== ref.no || m.textbook.kind !== ref.kind) {
    mismatch.push(`${hanzi}: 引用与教材位置不符`);
  }
  if (m.displayPinyin !== ref.pinyin) mismatch.push(`${hanzi}: 读音 ${m.displayPinyin} ≠ 教材 ${ref.pinyin}`);
}
test(`教材生字全覆盖（${index.size} 字，skip ${[...index.values()].filter((v) => v.skip).length}）`, () => eq(uncovered.join(','), ''));
test('任务 textbook 引用与教材一致、读音一致', () => eq(mismatch.join(' | '), ''));
const strayRefs = missions.filter((m) => m.textbook && !index.has(m.hanzi));
test('无悬空 textbook 引用', () => eq(strayRefs.map((m) => m.id).join(','), ''));
const tbBlock = missions.filter((m) => !m.isParentInjected && Number(String(m.id).replace(/^m_/, '')) >= 1001);
test(`教材扩展块 m_1001+ 存在（${tbBlock.length} 条）`, () => ok(tbBlock.length > 0));
test('词库 ≥ 1000 条', () => ok(missions.length >= 1000));

console.log('\n[4] 进度选择纯逻辑（合成目录）');
// 3 年级 × 2 册 × 2 课 × 2 字 = 24 个唯一汉字
const HZ = [...'天地人和山水风云花鸟虫鱼一二三四五六七八九十上下左右大小'];
let hi = 0;
const mini = {
  version: TEXTBOOK_VERSION,
  grades: [1, 2, 3].map((grade) => ({
    grade, label: GRADE_LABELS[grade],
    books: [1, 2].map((term) => ({
      term, label: `${GRADE_LABELS[grade]}${term === 1 ? '上' : '下'}册`, writeTotal: 4,
      lessons: [1, 2].map((seq) => ({
        seq, kind: '课文', no: seq, unit: 1, title: `G${grade}T${term}L${seq}`,
        chars: [0, 1].map(() => {
          const hanzi = HZ[hi++];
          return { hanzi, pinyin: 'tiān', word: hanzi + '天' };
        }),
      })),
    })),
  })),
};
const uniq = HZ;
test('合成目录生字唯一', () => eq(buildHanziIndex(mini).size, 24));

test('自由巡航 → 不过滤', () => {
  eq(allowedHanzi(mini, null), null);
  eq(normalizeSelection(mini, { grade: 'all' }), null);
  eq(selectionKey(null), 'all');
});
test('累计字集：一年级上册第1课 = 2 字', () => {
  const s = allowedHanzi(mini, { grade: 1, term: 1, seq: 1 });
  eq(s.size, 2);
});
test('累计字集：一年级上册全册 = 4 字', () => {
  eq(allowedHanzi(mini, { grade: 1, term: 1, seq: null }).size, 4);
});
test('累计字集：一年级全年级 = 8 字', () => {
  eq(allowedHanzi(mini, { grade: 1, term: null, seq: null }).size, 8);
});
test('累计字集：二年级上册第1课 = 10 字（含一年级全部）', () => {
  eq(allowedHanzi(mini, { grade: 2, term: 1, seq: 1 }).size, 10);
});
test('累计字集：三年级下册第2课 = 24 字（全部）', () => {
  eq(allowedHanzi(mini, { grade: 3, term: 2, seq: 2 }).size, 24);
});
test('seq 越界夹回册内最大值', () => {
  const n = normalizeSelection(mini, { grade: 1, term: 1, seq: 99 });
  eq(n.seq, 2);
});
test('非法年级 → null / 校验报错', () => {
  eq(normalizeSelection(mini, { grade: 9 }), null);
  eq(validateSelection(mini, { grade: 9 }).ok, false);
  eq(validateSelection(mini, { grade: 1, term: 3 }).ok, false);
  eq(validateSelection(mini, { grade: 1, term: 1, seq: 0 }).ok, false);
  eq(validateSelection(mini, { grade: 1, term: 1, seq: 2 }).ok, true);
  eq(validateSelection(mini, { grade: null }).ok, true);
});
test('countAllowed 与字集一致', () => eq(countAllowed(mini, { grade: 2, term: 1, seq: 1 }), 10));

const fakeMissions = [
  { id: 'a', hanzi: uniq[0], isParentInjected: false },   // 一年级上册第1课
  { id: 'b', hanzi: uniq[23], isParentInjected: false },  // 三年级下册第2课
  { id: 'p', hanzi: '紧', isParentInjected: true },       // 紧急注入（不在教材）
];
test('进度过滤：只留进度内 + 紧急注入', () => {
  const out = filterMissionsByTextbook(fakeMissions, mini, { grade: 1, term: 1, seq: 1 });
  eq(out.map((m) => m.id).join(','), 'a,p');
});
test('自由巡航：全部保留', () => {
  eq(filterMissionsByTextbook(fakeMissions, mini, null).length, 3);
});
test('文案：课文来源 / 进度', () => {
  const ref = lessonRef(mini, 1, 1, 2);
  eq(formatLesson(ref), '第2课《G1T1L2》');
  eq(formatLessonSource(ref), '一年级上册 · 第2课《G1T1L2》');
  ok(formatSelection(mini, { grade: 1, term: 1, seq: 2 }).includes('学到'));
  ok(formatSelection(mini, null).includes('自由巡航'));
});
test('文案：语文园地课型（新版园地含会写字）', () => {
  eq(formatLesson({ kind: '语文园地', no: null, title: '语文园地一' }), '语文园地一');
  eq(formatLesson({ kind: '识字', no: 3, title: '口耳目手足' }), '识字3《口耳目手足》');
});

console.log('\n[5] 真实目录进度抽查');
const g1t1 = getBook(catalog, 1, 1);
test('一年级上册第1课字集 ⊂ 全册字集', () => {
  const a = allowedHanzi(catalog, { grade: 1, term: 1, seq: 1 });
  const b = allowedHanzi(catalog, { grade: 1, term: 1, seq: null });
  ok(a.size < b.size);
  for (const h of a) ok(b.has(h));
});
test('三年级全年级字集 = 全部教材生字', () => {
  const all = allowedHanzi(catalog, { grade: 3, term: null, seq: null });
  eq(all.size, index.size);
});
test('每册整册进度字池都能抽到题（非空）', () => {
  for (const g of catalog.grades) for (const b of g.books) {
    const set = allowedHanzi(catalog, { grade: g.grade, term: b.term, seq: null });
    const pool = filterMissionsByTextbook(missions, catalog, { grade: g.grade, term: b.term, seq: null });
    ok(pool.length > 0, `${b.label} 整册无题`);
    ok(set.size > 0);
  }
});
test('首课无会写字时字池为空属正常（天地人）', () => {
  const l1 = getBook(catalog, 1, 1).lessons[0];
  if ((l1.chars || []).length === 0) {
    eq(allowedHanzi(catalog, { grade: 1, term: 1, seq: 1 }).size, 0);
  }
});
test('回归：只认不写的《天地人》也能出拼音题（会认字入池）', () => {
  const l1 = getBook(catalog, 1, 1).lessons[0];
  eq(l1.title, '天地人');
  const chars = (l1.chars || []).map((c) => c.hanzi);
  ok(chars.length > 0, '天地人没有生字');
  for (const h of ['天', '地', '人']) ok(chars.includes(h), `天地人缺「${h}」`);
  const set = allowedHanzi(catalog, { grade: 1, term: 1, seq: 1 });
  ok(set.size >= 3, `字池只有 ${set.size} 字`);
  for (const m of missions.filter((x) => set.has(x.hanzi))) {
    ok(m.displayPinyin && m.parts, `${m.id} 缺拼音数据`);
  }
});
test('只认不写的课都有字（略读课文/汉语拼音单元）', () => {
  for (const g of catalog.grades) for (const b of g.books) for (const l of b.lessons) {
    if (l.kind === '汉语拼音' || l.kind === '识字') {
      ok((l.chars || []).length > 0, `${b.label}《${l.title}》(${l.kind}) 无生字`);
    }
  }
});

console.log(`\n课文同步测试结果: ${pass} 通过, ${fail} 失败`);
if (fail) {
  console.error('\n失败明细:');
  for (const [name, e] of failures) console.error(`  - ${name}: ${e.message}`);
  process.exit(1);
}
