/**
 * unit-session.js — 单元完成规则纯逻辑（浏览器 / Node 共用，零依赖）
 * ------------------------------------------------------------------
 * 「单元」= 教材目录里的一课（识字1 / 识字2 / 第1课 / 语文园地 / 汉语拼音…），以 seq 标识。
 * 「每单元完成规则」：点一个课文芯片 → 生成一份固定题单，逐题发射：
 *   题单 = 本课所有新出现的字（按教材顺序） + 过往复习字（错题优先）。
 *   复习名额 = 单元总字数 − 本课新字数；总字数由家长后台「学习管理」可选 10~20（默认 15）。
 * 同一个汉字在本单元只出现一次（新字唯一、复习字与新字不重叠），答错也不在本题单内重复。
 * 错题生命周期（修正分散在后续不同单元，不是在当前单元练三次）：
 *   - 一次作答有错（组装/声调任一出错）→ 进入错题池（wrong=true），连续全对计数清零；
 *   - 错题池中的字在后续单元复习里「错题优先」被再次抽到，每全对一次算「修正 1 次」（fixes+1）；
 *   - 连续修正满 WRONG_FIX_TARGET（3）次 → 毕业（wrong=false），不再错题优先，
 *     但仍可作为普通过往字被随机抽进复习名额；中途再错则计数清零。
 * 「过往的字」= 教材顺序上本课之前学过的全部字（累计含之前年级/册），
 *   错题优先、其余随机；过往字不足复习名额则有几个抽几个。
 * 发射动画：仅题单第一题与「做完整份题单的最后一题」播放完整动画，中间题跳过（见 main.js enterLaunch）。
 *
 * 本文件只做纯逻辑，不读文件 / 不发请求；数据由调用方注入。
 */
import { getBook, lessonChars, lessonRef, formatLessonSource } from './textbook.js';

/** 连续全对修正满 3 次即从错题池毕业。 */
export const WRONG_FIX_TARGET = 3;
/** 单元练习总字数（家长后台「学习管理」可选 10~20）：复习名额 = 总字数 − 本课新字数。 */
export const UNIT_TOTAL_MIN = 10;
export const UNIT_TOTAL_MAX = 20;
export const UNIT_TOTAL_DEFAULT = 15;

/** 规范化单元总字数到 10~20 的整数（非法回默认）。 */
export function clampUnitTotal(value) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return UNIT_TOTAL_DEFAULT;
  return Math.min(UNIT_TOTAL_MAX, Math.max(UNIT_TOTAL_MIN, n));
}

/* ============================ 课文（单元）访问 ============================ */

/** 某课的可出题新字数（不含轻声 skip 字）。 */
export function lessonNewCount(catalog, grade, term, seq) {
  const lesson = (getBook(catalog, grade, term)?.lessons || []).find((l) => l.seq === Number(seq));
  return lessonChars(lesson).filter((c) => !c.skip).length;
}

/** 单元（课文）标签：一年级上册 · 识字2《金木水火土》。 */
export function unitLabel(catalog, grade, term, seq) {
  return formatLessonSource(lessonRef(catalog, grade, term, seq));
}

/** 任务上的教材位置（grade/term/seq）；无教材引用（扩展/紧急载荷）返回 null。 */
function missionPos(m) {
  const t = m?.textbook;
  if (!t || t.grade == null || t.term == null || t.seq == null) return null;
  return { grade: Number(t.grade), term: Number(t.term), seq: Number(t.seq) };
}

/** 是否为本课之前学过的字（累计教材顺序，严格早于本课）。 */
export function isPastMission(m, grade, term, seq) {
  const p = missionPos(m);
  if (!p || m.isParentInjected || seq == null) return false;
  const g = Number(grade), t = Number(term), s = Number(seq);
  return p.grade < g || (p.grade === g && p.term < t) || (p.grade === g && p.term === t && p.seq < s);
}

/** Fisher–Yates 洗牌（原地），rng 可注入以便测试确定性。 */
function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/* ============================ 题单构建 ============================ */

/**
 * 构建单元（课文）题单。
 * @param {object[]} missions 全量词库
 * @param {object} catalog 教材目录
 * @param {number} grade @param {number} term @param {number} seq 课文序号（单元）
 * @param {Record<string,{wrong?:boolean}>} stats 作答统计（错题优先依据）
 * @param {{rng?:()=>number,total?:number}} opts rng 可注入（默认 Math.random）；total 单元总字数（默认 15）
 * @returns {{queue:Array<{missionId:string,kind:'new'|'review'}>, newCount:number, reviewCount:number}}
 */
export function buildUnitQueue(missions, catalog, grade, term, seq, stats = {}, opts = {}) {
  const rng = typeof opts.rng === 'function' ? opts.rng : Math.random;
  const total = clampUnitTotal(opts.total ?? UNIT_TOTAL_DEFAULT);
  const g = Number(grade), t = Number(term), s = Number(seq);
  const lesson = (getBook(catalog, grade, term)?.lessons || []).find((l) => l.seq === s);
  // 课内字序（教材顺序），用于新字排题
  const order = new Map();
  let i = 0;
  for (const c of lessonChars(lesson)) if (!order.has(c.hanzi)) order.set(c.hanzi, i++);

  // 新字：本课首次教学的可出题任务，按教材顺序（全部收入，不受总字数限制）。
  const newMissions = (missions || [])
    .filter((m) => {
      const p = missionPos(m);
      return p && !m.isParentInjected && p.grade === g && p.term === t && p.seq === s;
    })
    .sort((a, b) => (order.get(a.hanzi) ?? 0) - (order.get(b.hanzi) ?? 0));

  // 复习名额 = 总字数 − 新字数（新字已超总字数时为 0）；过往字池错题优先、其余随机，不足则全取。
  const slots = Math.max(0, total - newMissions.length);
  const past = (missions || []).filter((m) => isPastMission(m, g, t, s));
  const wrong = shuffle(past.filter((m) => stats?.[m.id]?.wrong === true), rng);
  const rest = shuffle(past.filter((m) => stats?.[m.id]?.wrong !== true), rng);
  const review = [];
  for (const m of wrong) { if (review.length >= slots) break; review.push(m); }
  for (const m of rest) { if (review.length >= slots) break; review.push(m); }

  const queue = [
    ...newMissions.map((m) => ({ missionId: m.id, kind: 'new' })),
    ...review.map((m) => ({ missionId: m.id, kind: 'review' })),
  ];
  return { queue, newCount: newMissions.length, reviewCount: review.length };
}

/* ============================ 错题池 ============================ */

/**
 * 按一次作答结果更新错题池状态（原地修改 stat）。
 * 有错 → wrong=true、fixes=0（连续计数清零）；
 * 全对且仍在错题池 → fixes+1，满 WRONG_FIX_TARGET 次毕业（wrong=false）。
 * 全对且不在错题池 → 不变。
 * @param {{wrong?:boolean,fixes?:number}} stat
 * @param {boolean} perfect 本次作答是否零错误
 */
export function updateWrongStat(stat, perfect) {
  stat.wrong = !!stat.wrong;
  stat.fixes = Number(stat.fixes) || 0;
  if (!perfect) {
    stat.wrong = true;
    stat.fixes = 0;
  } else if (stat.wrong) {
    stat.fixes += 1;
    if (stat.fixes >= WRONG_FIX_TARGET) stat.wrong = false; // 毕业：不再错题优先
  }
  return stat;
}

/* ============================ 视图 ============================ */

/** 单元任务进度视图（供 API / 机库 / 结算展示）；无任务返回 null。label 在建单时写入。 */
export function unitSessionView(session) {
  if (!session || !Array.isArray(session.queue)) return null;
  const total = session.queue.length;
  const cursor = Number(session.cursor) || 0;
  return {
    grade: session.grade, term: session.term, seq: session.seq,
    label: session.label || '',
    total, cursor,
    remaining: Math.max(0, total - cursor),
    done: cursor >= total,
    newCount: session.newCount || 0,
    reviewCount: session.reviewCount || 0,
  };
}

/**
 * 单元题单发射动画判定：仅第一题（cursor 0）与「做完整份题单的最后一题」（cursor total-1）
 * 播放完整火箭发射动画，中间各题跳过。单题题单（total 1）首尾重合 → 播一次。
 * @param {{cursor:number,total:number}|null} view 单元进度视图
 */
export function unitFxPlays(view) {
  if (!view || !view.total) return true;
  return view.cursor === 0 || view.cursor === view.total - 1;
}