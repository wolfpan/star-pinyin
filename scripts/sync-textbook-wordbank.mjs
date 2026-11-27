/**
 * sync-textbook-wordbank.mjs — 词库与课文同步（2026 最新统编版一~三年级）
 * ------------------------------------------------------------------
 * 数据源（data/textbook-src/）：
 *   grade{1,2,3}.json   — 写字表（会写字），含单元号与官方 writeTotal
 *   rows-{一上,一下,…}.json — 识字表（会认字），按课本真实学习顺序逐课分行
 *
 * 流程：
 *  1. 汇编 + 校验：写字表 ∪ 识字表 → data/textbook.json（目录，字源 = 会认 ∪ 会写）。
 *  2. 给词库中每个教材生字打 textbook 引用（首次教学位置）。
 *  3. 读音与教材冲突的旧条目（非种子、非家长注入）按教材读音重建。
 *  4. 补齐缺失生字：m_1001+ 教材扩展块，按教材学习顺序生成。
 *
 * 为什么字源含「会认」：本游戏练的是拼音读音/拼读，拼音本就跟着识字走。
 * 只认不写的课（《天地人》、各略读课文、汉语拼音单元）因此同样能出题。
 *
 * 幂等：重复运行只重建 m_1001+ 与 textbook 引用，不动 m_001–m_040 种子、
 *       m_041–m_1000 三批扩展、m_p_* 家长注入。
 *
 * 用法：
 *   node scripts/sync-textbook-wordbank.mjs            # 写入 data/textbook.json + data/missions.json
 *   node scripts/sync-textbook-wordbank.mjs --dry-run  # 只体检不落盘
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSyllable, validateMission, categoryOf } from '../public/js/pinyin-rules.js';
import { buildMissions } from './wordbank-lib.mjs';
import { mergeBook } from './textbook-merge.mjs';
import {
  TEXTBOOK_VERSION, GRADE_LABELS, buildHanziIndex, lessonRef, flattenLessons, lessonChars,
} from '../public/js/textbook.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
// TEXTBOOK_SRC_DIR 可覆盖调研源目录（测试用隔离副本）
const SRC_DIR = process.env.TEXTBOOK_SRC_DIR || path.join(ROOT, 'data', 'textbook-src');
const CATALOG_PATH = path.join(ROOT, 'data', 'textbook.json');
const MISSIONS_PATH = path.join(ROOT, 'data', 'missions.json');
const DRY = process.argv.includes('--dry-run');
const NEW_FIRST_ID = 1001; // 教材扩展块起始 id（m_1001+）

const errors = [];
const warnings = [];
const HANZI_RE = /^[\u3400-\u4DBF\u4E00-\u9FFF]$/;
const TONE_RE = /[āáǎàōóǒòēéěèīíǐìūúǔùǖǘǚǜ]/;
const BOOK_LABEL = { 1: { 1: '一上', 2: '一下' }, 2: { 1: '二上', 2: '二下' }, 3: { 1: '三上', 2: '三下' } };

/* ----------------------------- 1. 读取调研源 ----------------------------- */

const readJsonFile = (file) => {
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { errors.push(`${path.basename(file)} 不是合法 JSON: ${e.message}`); return null; }
};

const sources = [];
for (const grade of [1, 2, 3]) {
  const d = readJsonFile(path.join(SRC_DIR, `grade${grade}.json`));
  if (!d) { errors.push(`缺少调研源 grade${grade}.json`); continue; }
  if (d.grade !== grade) errors.push(`grade${grade}.json: grade 字段应为 ${grade}`);
  if (!Array.isArray(d.books) || d.books.length !== 2) errors.push(`grade${grade}: 应有上下两册`);
  for (const b of d.books || []) {
    const label = BOOK_LABEL[grade]?.[b.term];
    b.rows = label ? readJsonFile(path.join(SRC_DIR, `rows-${label}.json`)) : null;
    if (!b.rows) warnings.push(`${label || grade + '年级'}：缺少识字表调研源 rows-${label}.json，该册只用写字表出题`);
  }
  sources.push(d);
}

/* ---- 单个生字条目校验（写字表 / 识字表共用） ---- */
const seenHanzi = new Map(); // hanzi -> {grade, where}
function checkChar(c, where, grade, { allowSkip = true } = {}) {
  if (!HANZI_RE.test(String(c.hanzi ?? ''))) { errors.push(`${where}: hanzi 非法「${c.hanzi}」`); return 0; }
  const prev = seenHanzi.get(c.hanzi);
  if (prev) {
    // 新版教材确实会在同册/同学段重复收录同一字（已目验：永 在二上园地二与二下第16课都有）。
    // 目录保留各册完整写字/识字表，任务归首次教学位置；此处只提示不报错。
    const scope = prev.grade === grade ? '同年级' : '跨年级';
    warnings.push(`${scope}重复「${c.hanzi}」: ${prev.where} 与 ${where}（任务归首次教学位置）`);
  } else {
    seenHanzi.set(c.hanzi, { grade, where });
  }
  if (!String(c.word ?? '').includes(c.hanzi)) errors.push(`${where}「${c.hanzi}」: word「${c.word}」不含该字`);
  if (c.skip) {
    if (!allowSkip) errors.push(`${where}「${c.hanzi}」: 识字表不应出现 skip`);
    if (c.pinyin && TONE_RE.test(c.pinyin)) errors.push(`${where}「${c.hanzi}」: skip 字不应带声调`);
    return 0;
  }
  const p = parseSyllable(String(c.pinyin ?? ''));
  if (p.displayPinyin !== c.pinyin) errors.push(`${where}「${c.hanzi}」: 标调不符 ${c.pinyin} → ${p.displayPinyin}`);
  for (const w of p.warnings) errors.push(`${where}「${c.hanzi}」: 拆分告警 ${w}`);
  if (!(p.tone >= 1 && p.tone <= 4)) errors.push(`${where}「${c.hanzi}」: 声调应为 1–4`);
  return 1;
}

const booksMeta = [];
for (const d of sources) {
  for (const b of d.books || []) {
    const label = b.label || `${GRADE_LABELS[d.grade]}${b.term === 1 ? '上册' : '下册'}`;
    // 写字表：结构校验（逐字校验统一放到目录汇编之后，避免同一字重复登记）
    const writeLessons = b.lessons || [];
    writeLessons.forEach((l, i) => {
      if (l.seq !== i + 1) errors.push(`${label}《${l.title}》: 写字表 seq 应为 ${i + 1}`);
      if (!['识字', '课文', '语文园地'].includes(l.kind)) errors.push(`${label}《${l.title}》: 写字表 kind 非法 ${l.kind}`);
    });
    const writeEntries = writeLessons.reduce((s, l) => s + (l.chars || []).length, 0);
    if (b.writeTotal != null && b.writeTotal !== writeEntries) {
      errors.push(`${label}: 写字表官方 ${b.writeTotal} ≠ 实际条目 ${writeEntries}`);
    }
    // 识字表的逐字校验放到目录汇编之后（轻声字要先规范化成本音再校验）
    const recognRows = b.rows?.rows || [];
    recognRows.forEach((r, i) => {
      if (r.order != null && r.order !== i + 1) errors.push(`${label}: 识字表 order 应为 ${i + 1}（${r.title}）`);
      if (!['识字', '课文', '汉语拼音', '语文园地'].includes(r.kind)) {
        errors.push(`${label}《${r.title}》: 识字表 kind 非法 ${r.kind}`);
      }
    });
    if (b.rows?.recognPrintedTotal != null) {
      const recognEntries = recognRows.reduce(
        (s, r) => s + (r.chars || []).filter((c) => !c.multiReading).length, 0);
      if (recognEntries !== b.rows.recognPrintedTotal) {
        errors.push(`${label}: 识字表页脚 ${b.rows.recognPrintedTotal} ≠ 实际认字条目 ${recognEntries}`);
      }
    }
    booksMeta.push({ grade: d.grade, book: b, label });
  }
}

if (errors.length) {
  console.error('❌ 教材调研源校验未通过：');
  for (const e of errors) console.error('  - ' + e);
  process.exit(1);
}

/* ----------------------------- 2. 汇编目录 ----------------------------- */

// 跨册去重：按册顺序累积「已教过的字」，避免前册认读、本册会写的字被重复建课
const taught = new Set();

const catalog = {
  version: TEXTBOOK_VERSION,
  edition: '统编版2024年修订（2024秋一年级启用，2025秋二三年级启用，2026秋全面覆盖）',
  generatedAt: new Date().toISOString(),
  source: '字源 = 识字表（会认）∪ 写字表（会写）；每字落在首次教学位置；顺序按课本真实学习顺序',
  grades: [1, 2, 3].map((grade) => {
    const d = sources.find((x) => x.grade === grade);
    return {
      grade,
      label: GRADE_LABELS[grade],
      books: (d.books || []).map((b) => {
        const { lessons, stats } = mergeBook(b, b.rows, { alreadyTaught: taught, warnings });
        const label = b.label || `${GRADE_LABELS[grade]}${b.term === 1 ? '上册' : '下册'}`;
        if (b.rows?.recognPrintedTotal != null && stats.total !== b.rows.recognPrintedTotal) {
          warnings.push(`${label}: 识字表页脚 ${b.rows.recognPrintedTotal} ≠ 目录生字 ${stats.total}`);
        }
        for (const l of lessons) for (const c of l.chars) taught.add(c.hanzi);
        return {
          term: b.term,
          label,
          writeTotal: b.writeTotal ?? null,
          recognTotal: b.rows?.recognPrintedTotal ?? null,
          lessons: lessons.map((l) => ({
            seq: l.seq, kind: l.kind, no: l.no, unit: l.unit, title: l.title,
            chars: l.chars.map((c) => ({
              hanzi: c.hanzi, pinyin: c.pinyin, word: c.word,
              ...(c.writing ? { writing: true } : {}),
              ...(c.writeSeq != null ? { writeSeq: c.writeSeq } : {}),
              ...(c.skip ? { skip: c.skip } : {}),
              ...(c.note ? { note: c.note } : {}),
            })),
          })),
        };
      }),
    };
  }),
};

/* ---- 会写标记回填：某字在前册认读、本册才要求会写时，把 writing 标到前册那条上 ---- */
{
  const charObjs = new Map();
  for (const g of catalog.grades) for (const b of g.books) for (const l of b.lessons) {
    for (const c of l.chars) if (!charObjs.has(c.hanzi)) charObjs.set(c.hanzi, { char: c, grade: g.grade, term: b.term, title: l.title });
  }
  for (const g of sources) for (const b of g.books || []) {
    const label = b.label || `${GRADE_LABELS[g.grade]}${b.term === 1 ? '上册' : '下册'}`;
    for (const l of b.lessons || []) {
      for (const c of l.chars || []) {
        const hit = charObjs.get(c.hanzi);
        if (!hit || hit.char.writing) continue;
        hit.char.writing = true;
        hit.char.writeIn = label;
      }
    }
  }
}

const index = buildHanziIndex(catalog);
const totalChars = index.size;
const skipChars = [...index.values()].filter((v) => v.skip).length;
const totalWriting = [...index.values()].filter((v) => v.writing).length;

/* ---- 目录逐字终审（每字只出现一次；轻声已由 textbook-merge 规范化）
 * 会写/会认的官方总数在「1. 读取调研源」里已按册核对，此处只做字级规则校验。 ---- */
for (const g of catalog.grades) {
  for (const b of g.books) {
    for (const l of b.lessons) {
      for (const c of l.chars) checkChar(c, `${b.label}《${l.title}》`, g.grade, { allowSkip: true });
    }
  }
}

/* ----------------------------- 3. 同步词库 ----------------------------- */

const missions = JSON.parse(fs.readFileSync(MISSIONS_PATH, 'utf8'));
const isSeed = (m) => {
  const n = Number(String(m.id).replace(/^m_/, ''));
  return Number.isFinite(n) && n >= 1 && n <= 40;
};
const numericId = (m) => Number(String(m.id).replace(/^m_/, ''));

let tagged = 0, rebuilt = 0, untagged = 0;
const kept = [];
const existingHanzi = new Set();

function hintFor(ref) {
  const book = `${GRADE_LABELS[ref.grade]}${ref.term === 1 ? '上册' : '下册'}`;
  return `${book}《${ref.title}》生字`;
}

for (const m of missions) {
  // 教材扩展块（m_1001+）每次整体重建；家长注入不动
  if (!m.isParentInjected && numericId(m) >= NEW_FIRST_ID) continue;
  const ref = index.get(m.hanzi);
  if (m.isParentInjected) { kept.push(m); existingHanzi.add(m.hanzi); continue; }
  if (!ref) {
    if (m.textbook) { delete m.textbook; untagged++; }
    kept.push(m); existingHanzi.add(m.hanzi);
    continue;
  }
  const tb = lessonRef(catalog, ref.grade, ref.term, ref.seq);
  if (m.displayPinyin !== ref.pinyin) {
    if (isSeed(m)) {
      warnings.push(`种子 ${m.id}「${m.hanzi}」读音 ${m.displayPinyin} 与教材 ${ref.pinyin} 不一致（种子保留原样）`);
      m.textbook = tb;
      kept.push(m); existingHanzi.add(m.hanzi); tagged++;
      continue;
    }
    // 非种子读音冲突 → 按教材重建（保留 id 与 priority）
    const entry = { hanzi: m.hanzi, word: ref.word, pinyin: ref.pinyin, hint: hintFor(ref) };
    const { missions: [fresh], errors: errs } = buildMissions([entry], numericId(m));
    if (errs.length) { errors.push(...errs.map((e) => `重建 ${m.id}: ${e}`)); kept.push(m); existingHanzi.add(m.hanzi); continue; }
    fresh.priority = m.priority ?? 1;
    fresh.textbook = tb;
    kept.push(fresh); existingHanzi.add(fresh.hanzi);
    rebuilt++; tagged++;
    warnings.push(`${m.id}「${m.hanzi}」按教材重建：${m.displayPinyin} → ${ref.pinyin}（${ref.word}）`);
    continue;
  }
  m.textbook = tb;
  kept.push(m); existingHanzi.add(m.hanzi); tagged++;
}

/* ---- 补齐缺失生字（按教材顺序：会写在前、只认在后，m_1001 起） ---- */
const missing = [];
const seenNew = new Set();
for (const l of flattenLessons(catalog)) {
  for (const c of lessonChars(l)) {
    if (c.skip || existingHanzi.has(c.hanzi) || seenNew.has(c.hanzi)) continue;
    seenNew.add(c.hanzi);
    missing.push({
      hanzi: c.hanzi, word: c.word, pinyin: c.pinyin,
      hint: hintFor({ grade: l.grade, term: l.term, title: l.title }),
      ref: { grade: l.grade, term: l.term, seq: l.seq },
    });
  }
}
const { missions: newMissions, errors: newErrors } = buildMissions(missing, NEW_FIRST_ID);
errors.push(...newErrors);
newMissions.forEach((m, i) => {
  const r = missing[i].ref;
  m.textbook = lessonRef(catalog, r.grade, r.term, r.seq);
});

const merged = [...kept, ...newMissions];

/* ---- 全库终审 ---- */
const seenId = new Set();
const seenHz = new Map();
for (const m of merged) {
  if (seenId.has(m.id)) errors.push(`id 重复: ${m.id}`);
  seenId.add(m.id);
  if (seenHz.has(m.hanzi)) errors.push(`汉字重复: ${m.hanzi}（${seenHz.get(m.hanzi)} 与 ${m.id}）`);
  seenHz.set(m.hanzi, m.id);
  for (const e of validateMission(m).errors) errors.push(`${m.id}: ${e}`);
}

/* ---- 覆盖率 ---- */
let covered = 0;
const uncovered = [];
for (const [hanzi, ref] of index) {
  if (ref.skip) continue;
  if (seenHz.has(hanzi)) covered++;
  else uncovered.push(`${hanzi}（${GRADE_LABELS[ref.grade]}${ref.term === 1 ? '上' : '下'}《${ref.title}》）`);
}
if (uncovered.length) errors.push(`教材生字未覆盖: ${uncovered.join('、')}`);

/* ----------------------------- 4. 报告与写盘 ----------------------------- */

console.log('\n【课文同步 · 2026 最新统编版一~三年级 · 会认 ∪ 会写】');
for (const g of catalog.grades) {
  for (const b of g.books) {
    const src = sources.find((s) => s.grade === g.grade)?.books.find((x) => x.term === b.term) || {};
    const wCount = (src.lessons || []).reduce((s, l) => s + (l.chars || []).length, 0);
    const rCount = (src.rows?.rows || []).reduce(
      (s, r) => s + (r.chars || []).filter((c) => !c.multiReading).length, 0);
    const inCatalog = b.lessons.reduce((s, l) => s + l.chars.length, 0);
    const skips = b.lessons.reduce((s, l) => s + l.chars.filter((c) => c.skip).length, 0);
    console.log(`  ${b.label}: ${b.lessons.length} 课 · 目录生字 ${inCatalog}（可出题 ${inCatalog - skips}）`
      + ` · 官方 会认 ${rCount || '—'} / 会写 ${wCount}`);
  }
}
console.log(`\n教材生字 ${totalChars}（其中会写 ${totalWriting}，轻声 skip ${skipChars}）· 词库覆盖 ${covered}/${totalChars - skipChars}`);
console.log(`标注旧条目 ${tagged} · 读音重建 ${rebuilt} · 新增 m_${NEW_FIRST_ID}–m_${String(NEW_FIRST_ID + newMissions.length - 1).padStart(3, '0')} 共 ${newMissions.length} 条`);
console.log(`词库总量：${merged.length} 条（原 ${missions.length}）`);
const counts = {};
for (const m of merged) { const c = categoryOf(m); counts[c] = (counts[c] || 0) + 1; }
console.log(`构型分布：两拼 ${counts.two || 0} · 三拼 ${counts.three || 0} · j/q/x+ü ${counts.jqx || 0} · 整体认读 ${counts.whole || 0} · 零声母 ${counts.zero || 0}`);
if (warnings.length) {
  console.log('\n⚠️ 提示：');
  for (const w of warnings) console.log('  - ' + w);
}
if (errors.length) {
  console.error('\n❌ 校验未通过：');
  for (const e of errors) console.error('  - ' + e);
  process.exit(1);
}
if (DRY) {
  console.log('\n🟡 --dry-run：未写入 data/textbook.json / data/missions.json');
  process.exit(0);
}
fs.writeFileSync(CATALOG_PATH, JSON.stringify(catalog, null, 2) + '\n', 'utf8');
fs.writeFileSync(MISSIONS_PATH, JSON.stringify(merged, null, 2) + '\n', 'utf8');
console.log('\n✅ 已写入 data/textbook.json 与 data/missions.json');
