/**
 * rewards.js — 课时奖励系统纯逻辑（浏览器 / Node 共用，零依赖）
 * ------------------------------------------------------------------
 * 「任务难度」已取消：进度不再按等级抽题，而是按课文同步的课时完成量发奖励。
 *
 * 规则：
 *  - 每完成 LESSONS_PER_REWARD（2）课时，解锁 1 档奖励；共 14 档，一一对应
 *    destinations.js 的 14 个星际目的地（Lv1 低空轨道 … Lv14 星际空间）。
 *  - Lv1 是起步目的地（0 课时即可发射），Lv14 需要 26 课时，剩余课时只累计不越级。
 *  - 一课时 = 教材目录里的一课；「完成」= 该课全部可出题生字都至少练过一次
 *    （progress.stats[missionId].attempts > 0）。认读课（无可写生字）不计入课时总数。
 *  - 课时完成统计以任务上的 textbook 引用（grade/term/seq）分组；家长热注入的
 *    紧急载荷（isParentInjected）不参与统计，避免人为卡住某课。
 *  - 跨年级重复字以「首次教学位置」归属（与课文同步一致），因此同一课不会重复计数。
 *
 * 本文件只做纯逻辑，不读文件 / 不发请求；数据由调用方注入。
 */
import { MAX_LEVEL, destinationForLevel } from './destinations.js';

/** 每档奖励所需的课时数（每 2 课时升 1 档）。 */
export const LESSONS_PER_REWARD = 2;

/** 第 1 档（起步）需要 0 课时；第 14 档需要 (14-1)*2 = 26 课时。 */
export const MAX_REWARD_LEVEL = MAX_LEVEL;

/** 规范化奖励档位到 1..14 的整数。 */
export function clampRewardLevel(value) {
  return Math.min(MAX_REWARD_LEVEL, Math.max(1, Math.floor(Number(value) || 1)));
}

/** 档位 → 解锁所需课时（Lv1 = 0，Lv2 = 2，Lv14 = 26；越界回夹）。 */
export function lessonsForRewardLevel(level) {
  return (clampRewardLevel(level) - 1) * LESSONS_PER_REWARD;
}

/** 已完成课时 → 奖励档位（Lv1 起步，每 2 课时 +1，封顶 Lv14）。 */
export function rewardLevelForLessons(lessons) {
  const n = Math.max(0, Math.floor(Number(lessons) || 0));
  return clampRewardLevel(Math.floor(n / LESSONS_PER_REWARD) + 1);
}

/** 当前课时 → 已解锁的奖励（档位 + 目的地）。 */
export function rewardForLessons(lessons) {
  const n = Math.max(0, Math.floor(Number(lessons) || 0));
  const level = rewardLevelForLessons(n);
  return { level, lessons: n, destination: destinationForLevel(level) };
}

/**
 * 下一份奖励：还差多少课时、解锁哪颗星球。满级（Lv14）返回 null。
 * @param {number} lessons 已完成课时
 * @returns {{level:number, lessons:number, need:number, destination:object}|null}
 */
export function nextRewardForLessons(lessons) {
  const n = Math.max(0, Math.floor(Number(lessons) || 0));
  const level = rewardLevelForLessons(n);
  if (level >= MAX_REWARD_LEVEL) return null;
  const nextLevel = level + 1;
  const threshold = lessonsForRewardLevel(nextLevel);
  return {
    level: nextLevel,
    lessons: threshold,
    need: Math.max(1, threshold - n),
    destination: destinationForLevel(nextLevel),
  };
}

/** 全部奖励档位（博物馆奖励系统列表）：[{level, lessons, destination}]。 */
export function rewardLadder() {
  const out = [];
  for (let level = 1; level <= MAX_REWARD_LEVEL; level++) {
    out.push({ level, lessons: lessonsForRewardLevel(level), destination: destinationForLevel(level) });
  }
  return out;
}

/* ============================ 课时完成统计 ============================ */

/** 教材引用 → 课时键（grade-term-seq）；缺字段返回 null。 */
export function lessonKey(ref) {
  if (!ref || ref.grade == null || ref.term == null || ref.seq == null) return null;
  return `${Number(ref.grade)}-${Number(ref.term)}-${Number(ref.seq)}`;
}

/** 课时排序（年级 → 学期 → 课序号），供奖励 / 统计按教材顺序展示。 */
function byLessonOrder(a, b) {
  const ra = a.ref; const rb = b.ref;
  return (ra.grade - rb.grade) || (ra.term - rb.term) || (ra.seq - rb.seq);
}

/**
 * 按课文引用把任务分组成课时。
 * @returns {Map<string, {key: string, ref: object, missions: object[]}>}
 */
export function groupMissionsByLesson(missions) {
  const groups = new Map();
  for (const m of missions || []) {
    if (!m || m.isParentInjected) continue;
    const key = lessonKey(m.textbook);
    if (!key) continue;
    let g = groups.get(key);
    if (!g) {
      const t = m.textbook;
      g = {
        key,
        ref: { grade: t.grade, term: t.term, seq: t.seq, no: t.no, kind: t.kind, unit: t.unit, title: t.title },
        missions: [],
      };
      groups.set(key, g);
    }
    g.missions.push(m);
  }
  return groups;
}

/**
 * 课时完成度：一课的全部可出题生字都至少练过一次即为完成。
 * @param {object[]} missions 全量词库（含 textbook 引用）
 * @param {Record<string, {attempts?: number}>} stats progress.stats
 * @returns {{completed: number, total: number, lessons: Array<{key:string, ref:object, total:number, practiced:number, completed:boolean}>}}
 */
export function lessonProgress(missions, stats = {}) {
  const groups = groupMissionsByLesson(missions);
  const lessons = [...groups.values()].map((g) => {
    const total = g.missions.length;
    let practiced = 0;
    for (const m of g.missions) {
      if ((Number(stats?.[m.id]?.attempts) || 0) > 0) practiced++;
    }
    return { key: g.key, ref: g.ref, total, practiced, completed: total > 0 && practiced === total };
  }).sort(byLessonOrder);
  return { completed: lessons.filter((l) => l.completed).length, total: lessons.length, lessons };
}

/** 已完成课时数（服务端 / 客户端快速取值）。 */
export function completedLessonCount(missions, stats = {}) {
  return lessonProgress(missions, stats).completed;
}
