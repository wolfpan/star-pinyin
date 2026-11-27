/**
 * textbook.js — 课文同步纯逻辑（浏览器 / Node 共用，零依赖）
 * ------------------------------------------------------------------
 * 词库与 2026 年最新统编（人教）版语文一~三年级课文同步：
 *  - 教材目录数据在 data/textbook.json（catalog），由 scripts/sync-textbook-wordbank.mjs
 *    从 data/textbook-src/grade{1,2,3}.json 调研源汇编并校验生成。
 *  - 每个任务（mission）带 textbook 引用 {grade, term, seq, no, kind, unit, title}，
 *    指向该字在教材中首次出现的课文（写字表）。
 *  - 学习进度选择 selection = {grade, term, seq}：
 *      grade = null        → 自由巡航（全部词库，不过滤）
 *      grade = 1|2|3       → 按教材顺序累计到所选课文（含之前所有年级/学期/课文）
 *      term  = null        → 整个年级（上下册全部）
 *      seq   = null        → 整个学期（该册全部课文）
 *  - 抽题过滤：家长紧急注入（isParentInjected）永远可抽到，不受进度限制。
 *
 * 本文件只做纯逻辑，不读文件 / 不发请求；数据由调用方注入。
 */

export const GRADE_LABELS = { 1: '一年级', 2: '二年级', 3: '三年级' };
export const TERM_LABELS = { 1: '上册', 2: '下册' };
export const TEXTBOOK_VERSION = 'pep-2024';

/* ============================ 目录访问 ============================ */

/** 取某年级某学期的册对象；不存在返回 null。 */
export function getBook(catalog, grade, term) {
  const g = (catalog?.grades || []).find((x) => x.grade === Number(grade));
  if (!g) return null;
  if (term == null) return null;
  return (g.books || []).find((b) => b.term === Number(term)) || null;
}

/** 取某年级对象（含 books）；不存在返回 null。 */
export function getGrade(catalog, grade) {
  return (catalog?.grades || []).find((x) => x.grade === Number(grade)) || null;
}

/**
 * 一课的生字。目录按「首次教学位置」去重，每个字只出现一次；
 * `writing: true` 表示该字同时属于写字表（会写），`writeSeq` 是它的会写课序号。
 * 返回 [{hanzi, pinyin, word, skip?, note?, writing?, writeSeq?}]
 */
export function lessonChars(lesson) {
  return (lesson?.chars || []).map((c) => ({ ...c, writing: !!c.writing }));
}

/** 按教材学习顺序展平全部课文：[{grade, term, seq, kind, no, unit, title, chars}]。 */
export function flattenLessons(catalog) {
  const out = [];
  for (const g of catalog?.grades || []) {
    for (const b of g.books || []) {
      for (const l of b.lessons || []) {
        out.push({ grade: g.grade, term: b.term, ...l });
      }
    }
  }
  return out;
}

/**
 * 汉字 → 教材位置索引（首次教学位置：认读课优先，会写课更晚时写在此处）。
 * Map<hanzi, {grade, term, seq, no, kind, unit, title, pinyin, word, skip, writing, writeSeq}>
 */
export function buildHanziIndex(catalog) {
  const idx = new Map();
  for (const l of flattenLessons(catalog)) {
    for (const c of lessonChars(l)) {
      if (!idx.has(c.hanzi)) {
        idx.set(c.hanzi, {
          grade: l.grade, term: l.term, seq: l.seq, no: l.no,
          kind: l.kind, unit: l.unit, title: l.title,
          pinyin: c.pinyin, word: c.word, skip: c.skip || null,
          writing: !!c.writing, writeSeq: c.writeSeq ?? null,
        });
      }
    }
  }
  return idx;
}

/** 任务上 denormalized 的教材引用（与 buildHanziIndex 同口径）。 */
export function lessonRef(catalog, grade, term, seq) {
  const book = getBook(catalog, grade, term);
  const lesson = (book?.lessons || []).find((l) => l.seq === Number(seq));
  if (!lesson) return null;
  return {
    grade: Number(grade), term: Number(term), seq: lesson.seq,
    no: lesson.no, kind: lesson.kind, unit: lesson.unit, title: lesson.title,
  };
}

/**
 * 教材引用 → 单元键（grade-term-unit）；缺字段返回 null。
 * 用于「每单元仅首次发射播放动画」：同一册同一单元共享一个键。
 * 汉语拼音课（unit=null）、无教材引用的扩展词条 / 紧急载荷没有单元归属，返回 null。
 */
export function unitKey(ref) {
  if (!ref || ref.grade == null || ref.term == null || ref.unit == null || ref.unit === '') return null;
  return `${Number(ref.grade)}-${Number(ref.term)}-${Number(ref.unit)}`;
}

/* ============================ 进度选择 ============================ */

/**
 * 规范化进度选择：非法输入夹回合法值。
 * 返回 {grade, term, seq}（grade=null 表示自由巡航）；完全无效返回 null。
 */
export function normalizeSelection(catalog, sel) {
  if (!sel || sel.grade == null || sel.grade === '' || sel.grade === 'all') return null;
  const grade = Number(sel.grade);
  const g = getGrade(catalog, grade);
  if (!g) return null;
  let term = sel.term == null || sel.term === '' ? null : Number(sel.term);
  if (term != null && !g.books.some((b) => b.term === term)) term = null;
  let seq = sel.seq == null || sel.seq === '' ? null : Math.floor(Number(sel.seq));
  if (term != null && seq != null) {
    const book = getBook(catalog, grade, term);
    const max = (book?.lessons || []).length;
    if (!Number.isFinite(seq) || seq < 1) seq = 1;
    if (seq > max) seq = max;
  } else {
    seq = null;
  }
  return { grade, term, seq };
}

/** 校验进度选择（API 用）：返回 {ok, selection, error}。 */
export function validateSelection(catalog, sel) {
  if (sel == null || sel.grade == null || sel.grade === 'all') {
    return { ok: true, selection: null, error: null };
  }
  const grade = Number(sel.grade);
  if (!Number.isInteger(grade) || !getGrade(catalog, grade)) {
    return { ok: false, selection: null, error: `年级需为 1..3（收到 ${sel.grade}）` };
  }
  const g = getGrade(catalog, grade);
  let term = null;
  if (sel.term != null && sel.term !== '') {
    term = Number(sel.term);
    if (!Number.isInteger(term) || !g.books.some((b) => b.term === term)) {
      return { ok: false, selection: null, error: `学期需为 1（上册）或 2（下册）（收到 ${sel.term}）` };
    }
  }
  let seq = null;
  if (term != null && sel.seq != null && sel.seq !== '') {
    seq = Math.floor(Number(sel.seq));
    const max = (getBook(catalog, grade, term)?.lessons || []).length;
    if (!Number.isFinite(seq) || seq < 1 || seq > max) {
      return { ok: false, selection: null, error: `课文进度需为 1..${max}（收到 ${sel.seq}）` };
    }
  }
  return { ok: true, selection: { grade, term, seq }, error: null };
}

/** 进度比较键（用于判断是否变化）。 */
export function selectionKey(sel) {
  if (!sel || sel.grade == null) return 'all';
  return `${sel.grade}-${sel.term ?? 'all'}-${sel.seq ?? 'all'}`;
}

/**
 * 进度 → 允许汉字集合（累计：从一年级上册第1课到所选课文）。
 * 拼音练的是「读音 / 拼读」，字源 = 识字表（会认）∪ 写字表（会写）——
 * 只要求会认、不要求会写的课（如《天地人》、各略读课文、汉语拼音单元）同样出题。
 * 返回 Set<hanzi>；null 表示不过滤（自由巡航）。
 */
export function allowedHanzi(catalog, sel) {
  const n = normalizeSelection(catalog, sel);
  if (!n) return null;
  const allowed = new Set();
  for (const l of flattenLessons(catalog)) {
    if (l.grade > n.grade) break;
    if (l.grade === n.grade) {
      if (n.term != null && l.term > n.term) break;
      if (n.term != null && l.term === n.term && n.seq != null && l.seq > n.seq) break;
    }
    for (const c of lessonChars(l)) allowed.add(c.hanzi);
  }
  return allowed;
}

/** 进度内可出题的生字数（不含轻声 skip 字）。 */
export function countAllowed(catalog, sel) {
  const set = allowedHanzi(catalog, sel);
  if (!set) return null;
  const idx = buildHanziIndex(catalog);
  let n = 0;
  for (const h of set) if (!idx.get(h)?.skip) n++;
  return n;
}

/**
 * 按进度过滤任务池。
 *  - 自由巡航（sel=null）→ 原样返回。
 *  - 家长紧急注入（isParentInjected）不受进度限制，永远保留。
 */
export function filterMissionsByTextbook(missions, catalog, sel) {
  const allowed = allowedHanzi(catalog, sel);
  if (!allowed) return missions.slice();
  return missions.filter((m) => m.isParentInjected || allowed.has(m.hanzi));
}

/* ============================ 文案 ============================ */

/** 单课短标签：识字3《口耳目手足》 / 第5课《铺满金色巴掌的水泥道》 / 语文园地一。 */
export function formatLesson(ref) {
  if (!ref) return '';
  if (ref.kind === '语文园地') return ref.title;
  const head = ref.kind === '识字' ? `识字${ref.no}` : `第${ref.no}课`;
  return `${head}《${ref.title}》`;
}

/** 册标签：一年级上册。 */
export function formatBook(grade, term) {
  return `${GRADE_LABELS[grade] || grade + '年级'}${TERM_LABELS[term] || ''}`;
}

/** 任务简报用完整来源：一年级上册 · 识字2《金木水火土》。 */
export function formatLessonSource(ref) {
  if (!ref) return '';
  return `${formatBook(ref.grade, ref.term)} · ${formatLesson(ref)}`;
}

/** 进度选择文案：自由巡航 · 全部词库 / 一年级上册 · 学到识字3《口耳目手足》。 */
export function formatSelection(catalog, sel) {
  const n = normalizeSelection(catalog, sel);
  if (!n) return '自由巡航 · 全部词库';
  if (n.term == null) return `${GRADE_LABELS[n.grade]} · 全年级`;
  const book = getBook(catalog, n.grade, n.term);
  if (n.seq == null) return `${formatBook(n.grade, n.term)} · 全册`;
  const lesson = (book?.lessons || []).find((l) => l.seq === n.seq);
  return `${formatBook(n.grade, n.term)} · 学到${formatLesson(lesson)}`;
}
