/**
 * textbook-merge.mjs — 把「写字表」与「识字表」合并成教材目录
 * ------------------------------------------------------------------
 * 输入（data/textbook-src/）：
 *   grade{1,2,3}.json     写字表（会写字），books[].lessons[].chars，含单元号与官方 writeTotal
 *   rows-{一上,…}.json    识字表（会认字），rows[].chars，含页脚官方 recognPrintedTotal
 *
 * 关键事实（一上实测）：写字表 100 字全部落在识字表 280 字内，但其中 34 字的
 * 「认读课」与「会写课」不同（如「天」在《天地人》认读、在《四季》才要求会写）。
 *
 * 因此每册目录按**首次教学位置**去重：一个字只出现一次，落在它最先被教的课
 * （识字表顺序），并用 `writing` 标注它是否属于写字表、`writeSeq` 记录会写课的序号。
 * 这样：
 *   · 进度字池 = 累计「已教」的字（认 ∪ 写），不会重复也不会漏；
 *   · 会写字总数仍可按 writing 标记校验回 writeTotal；
 *   · 天地人这类只认不写的课，也能练到天地人你我他。
 */

import { normalizeLightTone } from './light-tone.mjs';

export const KIND_OK = ['识字', '课文', '汉语拼音', '语文园地'];

/** 「识字表」栏目名 → 统一 kind（书上印「阅读」，目录统一记「课文」）。 */
export function normalizeKind(kind) {
  if (kind === '阅读') return '课文';
  return kind;
}

/**
 * 合并一册的写字表与识字表。
 * @param {{term:number,label:string,writeTotal:number,lessons:Array}} writing 写字表册数据
 * @param {{label:string,term:number,recognPrintedTotal?:number,rows:Array}|null} recogn 识字表册数据
 * @param {{alreadyTaught?:Set<string>, warnings?:string[]}} opts
 *        alreadyTaught：此前各册已出现过的字（跨册去重，避免「上学年认读、本册会写」的字被重复补挂）
 * @returns {{lessons:Array, warnings:string[], stats:object}}
 */
export function mergeBook(writing, recogn, opts = {}) {
  const warnings = opts.warnings || [];
  const alreadyTaught = opts.alreadyTaught || new Set();
  const writeLessons = writing?.lessons || [];
  const rows = recogn?.rows || [];

  /* ---- 写字表：汉字 → {seq 序号(in rows 顺序), unit, chars} ---- */
  const writeByTitle = new Map();
  for (const l of writeLessons) if (!writeByTitle.has(l.title)) writeByTitle.set(l.title, l);

  // 先确定 rows 顺序（识字表顺序 = 课本真实顺序）
  const rowSeq = new Map(); // title -> seq
  rows.forEach((r, i) => rowSeq.set(r.title, i + 1));

  // 写字表每课的字 → (hanzi -> {writeSeq, writing:true})
  const writingMeta = new Map(); // hanzi -> {writeSeq, writeTitle}
  for (const l of writeLessons) {
    const seq = rowSeq.get(l.title) ?? null;
    for (const c of l.chars || []) {
      if (!writingMeta.has(c.hanzi)) {
        writingMeta.set(c.hanzi, { writeSeq: seq, writeTitle: l.title, char: c });
      }
    }
  }

  const merged = [];
  const coveredWriting = new Set();

  if (rows.length) {
    /* 以识字表顺序建课，认字逐字挂上会写标记 */
    for (const row of rows) {
      const src = writeByTitle.get(row.title) || null;
      const chars = [];
      for (const raw of row.chars || []) {
        if (raw.multiReading) continue; // 蓝色多音字复现：不计入生字总数
        const meta = writingMeta.get(raw.hanzi);
        let char;
        let action;
        if (meta && meta.writeSeq === rowSeq.get(row.title)) {
          // 本课既是认读课也是会写课：直接用写字表条目（有 skip/note 等口径）
          char = { ...raw, ...(meta.char.pinyin ? { pinyin: meta.char.pinyin, word: meta.char.word } : {}) };
          action = 'ok';
        } else {
          ({ char, action } = normalizeLightTone(raw));
        }
        if (action === 'fixed') warnings.push(`《${row.title}》「${raw.hanzi}」读轻声 ${raw.pinyin || '(轻声)'} → 按本音 ${char.pinyin} 出题`);
        else if (action === 'skip') warnings.push(`《${row.title}》「${raw.hanzi}」纯轻声，未入词库`);
        if (meta) { char.writing = true; char.writeSeq = meta.writeSeq; coveredWriting.add(raw.hanzi); }
        chars.push(char);
      }
      merged.push({
        seq: merged.length + 1,
        kind: normalizeKind(row.kind),
        no: row.no ?? null,
        unit: src?.unit ?? null,
        title: row.title,
        chars,
      });
    }
  } else {
    /* 没有识字表：退回只用写字表（跨册已教过的字不重复建课） */
    for (const l of writeLessons) {
      const chars = [];
      for (const c of l.chars || []) {
        if (alreadyTaught.has(c.hanzi)) continue; // 前册已教，不重复
        chars.push({ ...c, writing: true });
        coveredWriting.add(c.hanzi);
      }
      merged.push({
        seq: merged.length + 1,
        kind: normalizeKind(l.kind),
        no: l.no ?? null,
        unit: l.unit ?? null,
        title: l.title,
        chars,
      });
    }
    const dropped = writeLessons.reduce((s, l) => s + (l.chars || []).length, 0)
      - [...coveredWriting].length;
    if (dropped > 0) warnings.push(`${writing?.label || ''}: ${dropped} 个会写字此前册已教，未重复建课`);
  }

  /* ---- 写字表里存在、但识字表没列出的字 ----
   * 分两种：此前册已教过（跨册去重，不重复建课）／本册确实漏收（补挂到会写课）。 */
  const missing = [...writingMeta.keys()].filter((h) => !coveredWriting.has(h));
  const crossBook = missing.filter((h) => alreadyTaught.has(h));
  const localMissing = missing.filter((h) => !alreadyTaught.has(h));
  if (crossBook.length) {
    warnings.push(`${writing?.label || ''}: ${crossBook.length} 字此前册已认读、本册要求会写（不重复建课，会写标记稍后回填）：${crossBook.slice(0, 30).join('、')}`);
  }
  if (localMissing.length) {
    warnings.push(`${writing?.label || ''}: 写字表有 ${localMissing.length} 字未在识字表出现，已补挂到其会写课：${localMissing.slice(0, 30).join('、')}`);
    for (const h of localMissing) {
      const meta = writingMeta.get(h);
      const target = merged.find((l) => l.title === meta.writeTitle) || merged[merged.length - 1];
      if (!target) continue;
      target.chars.push({ ...meta.char, writing: true, writeSeq: meta.writeSeq });
      coveredWriting.add(h);
    }
  }

  const stats = {
    lessons: merged.length,
    total: merged.reduce((s, l) => s + l.chars.length, 0),
    writing: merged.reduce((s, l) => s + l.chars.filter((c) => c.writing).length, 0),
    recognPrintedTotal: recogn?.recognPrintedTotal ?? null,
    writingPrintedTotal: writing?.writeTotal ?? null,
    crossBookWriting: crossBook.length,
  };
  return { lessons: merged, warnings, stats };
}
