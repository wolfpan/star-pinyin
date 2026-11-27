/**
 * rewards.test.mjs — 课时奖励系统纯逻辑测试（零依赖）
 * 运行：node test/rewards.test.mjs
 *
 * 验收点：
 *  1. 每 2 课时升 1 档，14 档 1:1 对应 14 个星际目的地（Lv1 0 课时 / Lv14 26 课时）；
 *  2. 已完成课时 → 档位 / 目的地 / 下一份奖励（还差几课时）；
 *  3. 课时完成判定：该课全部可出题生字都练过至少一次才算完成；
 *  4. 家长热注入 / 无 textbook 引用的任务不参与课时统计；
 *  5. 真实词库：课时分组规模与进度数据自洽。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  LESSONS_PER_REWARD, MAX_REWARD_LEVEL, clampRewardLevel, lessonsForRewardLevel, rewardLevelForLessons,
  rewardForLessons, nextRewardForLessons, rewardLadder, lessonKey, groupMissionsByLesson, lessonProgress,
  completedLessonCount,
} from '../public/js/rewards.js';
import { MAX_LEVEL, destinationForLevel } from '../public/js/destinations.js';

let pass = 0, fail = 0;
function test(name, fn) { try { fn(); pass++; console.log('  ✓ ' + name); } catch (e) { fail++; console.log('  ✗ ' + name + ' → ' + e.message); } }
const eq = assert.equal;
const ok = assert.ok;

const root = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const DATA = path.join(root, '..', 'data');

console.log('\n课时门槛 → 奖励档位');
test('每 2 课时升 1 档', () => eq(LESSONS_PER_REWARD, 2));
test('档位上限 = 目的地数 = 14', () => {
  eq(MAX_REWARD_LEVEL, 14);
  eq(MAX_REWARD_LEVEL, MAX_LEVEL);
});
test('档位回夹到 1..14', () => {
  eq(clampRewardLevel(0), 1); eq(clampRewardLevel('abc'), 1); eq(clampRewardLevel(-3), 1);
  eq(clampRewardLevel(7), 7); eq(clampRewardLevel(99), 14);
});
test('档位 → 所需课时（Lv1 = 0 / Lv2 = 2 / Lv14 = 26）', () => {
  eq(lessonsForRewardLevel(1), 0); eq(lessonsForRewardLevel(2), 2);
  eq(lessonsForRewardLevel(7), 12); eq(lessonsForRewardLevel(14), 26);
  eq(lessonsForRewardLevel(99), 26);
});
test('课时 → 档位（0/1 课时 = Lv1，2 课时 = Lv2，26 课时满档）', () => {
  eq(rewardLevelForLessons(0), 1); eq(rewardLevelForLessons(1), 1);
  eq(rewardLevelForLessons(2), 2); eq(rewardLevelForLessons(3), 2);
  eq(rewardLevelForLessons(4), 3); eq(rewardLevelForLessons(24), 13);
  eq(rewardLevelForLessons(25), 13); eq(rewardLevelForLessons(26), 14);
  eq(rewardLevelForLessons(999), 14);
});
test('非法课时回落到 Lv1', () => {
  eq(rewardLevelForLessons(-2), 1); eq(rewardLevelForLessons('abc'), 1); eq(rewardLevelForLessons(undefined), 1);
});
test('档位与目的地一一对应', () => {
  eq(rewardForLessons(0).destination.id, 'earth_low');
  eq(rewardForLessons(26).destination.id, 'interstellar');
  for (let lv = 1; lv <= MAX_REWARD_LEVEL; lv++) eq(rewardLevelForLessons(lessonsForRewardLevel(lv)), lv);
});

console.log('\n下一份奖励');
test('0 课时 → 再 2 课时解锁高空轨道', () => {
  const n = nextRewardForLessons(0);
  eq(n.level, 2); eq(n.lessons, 2); eq(n.need, 2); eq(n.destination.id, 'earth_high');
});
test('1 课时 → 还差 1 课时', () => eq(nextRewardForLessons(1).need, 1));
test('刚跨档 → 下一档还差 2 课时', () => {
  const n = nextRewardForLessons(2);
  eq(n.level, 3); eq(n.destination.id, 'earth_far'); eq(n.need, 2);
});
test('满档（26 课时）→ null', () => {
  eq(nextRewardForLessons(26), null);
  eq(nextRewardForLessons(40), null);
});
test('奖励阶梯 14 档、单调递增、第 1 档 0 课时', () => {
  const ladder = rewardLadder();
  eq(ladder.length, 14);
  eq(ladder[0].lessons, 0);
  eq(ladder[13].destination.id, destinationForLevel(14).id);
  for (let i = 1; i < ladder.length; i++) eq(ladder[i].lessons - ladder[i - 1].lessons, LESSONS_PER_REWARD);
});

console.log('\n课时完成判定');
const tb = (grade, term, seq, title = `课${seq}`) => ({ grade, term, seq, no: seq, kind: '课文', unit: 1, title });
const fakeMissions = [
  { id: 'a1', hanzi: '甲', textbook: tb(1, 1, 1) },
  { id: 'a2', hanzi: '乙', textbook: tb(1, 1, 1) },
  { id: 'b1', hanzi: '丙', textbook: tb(1, 1, 2) },
  { id: 'c1', hanzi: '丁', textbook: tb(2, 1, 1) },
  { id: 'p1', hanzi: '戊', isParentInjected: true, textbook: null },
  { id: 'n1', hanzi: '己' }, // 老词条：无 textbook 引用
];
test('课时键 = grade-term-seq', () => {
  eq(lessonKey(tb(1, 2, 3)), '1-2-3');
  eq(lessonKey(null), null);
  eq(lessonKey({ grade: 1, term: 1 }), null);
});
test('按 textbook 引用分组，注入题 / 无引用题不计入', () => {
  const groups = groupMissionsByLesson(fakeMissions);
  eq(groups.size, 3);
  eq(groups.get('1-1-1').missions.length, 2);
  eq(groups.get('1-1-2').missions.length, 1);
  eq(groups.get('2-1-1').missions.length, 1);
});
test('一课全部生字练过才完成（一章不落）', () => {
  const p1 = lessonProgress(fakeMissions, { a1: { attempts: 1 } });
  eq(p1.total, 3); eq(p1.completed, 0);
  const p2 = lessonProgress(fakeMissions, { a1: { attempts: 1 }, a2: { attempts: 2 }, b1: { attempts: 1 }, c1: { attempts: 1 } });
  eq(p2.completed, 3);
  eq(p2.lessons.every((l) => l.completed), true);
});
test('只练了一部分 → 课时未完成，但 practiced 计数正确', () => {
  const p = lessonProgress(fakeMissions, { a1: { attempts: 1 }, b1: { attempts: 1 } });
  eq(p.completed, 1); // 只有 b1 那一课（单字课）完成
  const a = p.lessons.find((l) => l.key === '1-1-1');
  eq(a.practiced, 1); eq(a.total, 2); eq(a.completed, false);
});
test('attempts 为 0 / 缺字段不算练过', () => {
  const p = lessonProgress(fakeMissions, { a1: { attempts: 0 }, a2: {} });
  eq(p.completed, 0);
  eq(p.lessons.find((l) => l.key === '1-1-1').practiced, 0);
});
test('课时按教材顺序排序', () => {
  const p = lessonProgress(fakeMissions, {});
  eq(p.lessons.map((l) => l.key).join(','), '1-1-1,1-1-2,2-1-1');
});
test('completedLessonCount 与 lessonProgress 一致', () => {
  const stats = { a1: { attempts: 1 }, a2: { attempts: 1 } };
  eq(completedLessonCount(fakeMissions, stats), lessonProgress(fakeMissions, stats).completed);
});

console.log('\n真实词库自洽（data/missions.json + data/progress.json）');
const missions = JSON.parse(fs.readFileSync(path.join(DATA, 'missions.json'), 'utf8'));
const progress = JSON.parse(fs.readFileSync(path.join(DATA, 'progress.json'), 'utf8'));
test('课时分组与任务上的 textbook 引用一致', () => {
  const byRef = new Set();
  for (const m of missions) {
    if (m.isParentInjected || !m.textbook) continue;
    byRef.add(lessonKey(m.textbook));
  }
  const p = lessonProgress(missions, {});
  eq(p.total, byRef.size);
  ok(p.total > 100, `课时总数应 > 100，实际 ${p.total}`);
  eq(p.completed, 0);
});
test('每课至少 1 个可出题生字', () => {
  const p = lessonProgress(missions, {});
  ok(p.lessons.every((l) => l.total > 0));
  for (const l of p.lessons) ok(l.ref.title && l.ref.grade >= 1 && l.ref.term >= 1 && l.ref.seq >= 1);
});
test('真实进度 → 已完成课时 ≤ 总课时，且档位合法', () => {
  const p = lessonProgress(missions, progress.stats || {});
  ok(p.completed <= p.total);
  const lv = rewardLevelForLessons(p.completed);
  ok(lv >= 1 && lv <= MAX_REWARD_LEVEL);
  eq(rewardForLessons(p.completed).destination.level, lv);
});

console.log(`\n课时奖励测试结果: ${pass} 通过, ${fail} 失败`);
if (fail) process.exit(1);
