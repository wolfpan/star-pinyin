/**
 * destinations.test.mjs — 「奖励档位 = 星际目的地」纯逻辑测试（零依赖）
 *
 * 验收点：
 *  1. Lv1–3 低空/高空/远地轨道；Lv4 月球 … Lv13 奥尔特云 / Lv14 星际空间，映射与策划一致；
 *  2. 档位回夹 / 下一站 / 图鉴列表（14 档一一对应 14 种目的地）；
 *  3. 与 rewards.js 档位上限一致（14）；
 *  4. 与课时奖励门槛自洽：第 L 档 = 完成 2*(L-1) 课时，与发射次数 / 火箭数量无关；
 *  5. 载荷类型：地球三层轨道=卫星，行星/矮行星=探测器入轨，奥尔特=飞掠。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  MAX_LEVEL, DESTINATION_BY_LEVEL, DESTINATIONS, clampLevel, destinationForLevel, nextDestinationForMax, destinationList,
} from '../public/js/destinations.js';
import { MAX_REWARD_LEVEL, LESSONS_PER_REWARD, rewardLadder, lessonsForRewardLevel, rewardLevelForLessons } from '../public/js/rewards.js';
import { isStarterBadge } from '../public/js/rocket-select.js';

let pass = 0, fail = 0;
function test(name, fn) { try { fn(); pass++; console.log('  ✓ ' + name); } catch (e) { fail++; console.log('  ✗ ' + name + ' → ' + e.message); } }
const eq = assert.equal;

const root = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const badges = JSON.parse(fs.readFileSync(path.join(root, '..', 'data', 'badges.json'), 'utf8'));

console.log('\n奖励档位 → 目的地映射');
const EXPECT = { 1: 'earth_low', 2: 'earth_high', 3: 'earth_far', 4: 'moon', 5: 'venus', 6: 'mars', 7: 'mercury', 8: 'jupiter', 9: 'saturn', 10: 'uranus', 11: 'neptune', 12: 'pluto', 13: 'oort', 14: 'interstellar' };
for (const [lv, id] of Object.entries(EXPECT)) {
  test(`Lv${lv} → ${id}`, () => eq(destinationForLevel(Number(lv)).id, id));
}
test('映射表与逐条查询一致', () => {
  for (let lv = 1; lv <= MAX_LEVEL; lv++) eq(DESTINATION_BY_LEVEL[lv], destinationForLevel(lv).id);
});
test('档位回夹到 1..14', () => {
  eq(clampLevel(0), 1); eq(clampLevel(99), 14); eq(clampLevel('abc'), 1); eq(clampLevel(6), 6);
  eq(destinationForLevel(99).id, 'interstellar'); eq(destinationForLevel(-3).id, 'earth_low');
});
test('与 rewards.js 档位上限一致', () => eq(MAX_LEVEL, MAX_REWARD_LEVEL));
test('下一站：Lv4 上限 → 金星；满级 → null', () => {
  eq(nextDestinationForMax(4).id, 'venus');
  eq(nextDestinationForMax(13).id, 'interstellar');
  eq(nextDestinationForMax(14), null);
});
test('图鉴列表 14 档一一对应 14 种目的地', () => {
  const list = destinationList();
  eq(list.length, 14);
  eq(list[0].id, 'earth_low');
  eq(new Set(list.map((d) => d.id)).size, 14);
});

console.log('\n载荷 / 类型');
test('地球三层轨道 = 卫星 + 对应视角', () => {
  for (const [id, view] of [['earth_low', 'low'], ['earth_high', 'high'], ['earth_far', 'far']]) {
    eq(DESTINATIONS[id].kind, 'orbit'); eq(DESTINATIONS[id].payload, 'satellite'); eq(DESTINATIONS[id].orbitView, view);
  }
});
test('行星/矮行星 = 探测器入轨', () => {
  for (const id of ['moon', 'venus', 'mars', 'mercury', 'jupiter', 'saturn', 'uranus', 'neptune', 'pluto']) {
    eq(DESTINATIONS[id].kind, 'planet'); eq(DESTINATIONS[id].payload, 'probe');
  }
});
test('奥尔特云 = 进入云区场景', () => { eq(DESTINATIONS.oort.kind, 'cloud'); eq(DESTINATIONS.oort.payload, 'probe'); });
test('星际空间 = 飞出太阳系', () => { eq(DESTINATIONS.interstellar.kind, 'beyond'); eq(DESTINATIONS.interstellar.payload, 'probe'); });
test('抵达字幕统一为「抵达XX」短名', () => {
  for (const d of Object.values(DESTINATIONS)) eq(d.caption.startsWith('抵达'), true);
});
test('每个目的地都有名称/百科/字幕', () => {
  for (const d of Object.values(DESTINATIONS)) {
    eq(typeof d.name, 'string'); eq(typeof d.fact, 'string'); eq(typeof d.caption, 'string');
  }
});

console.log('\n与课时奖励门槛自洽（火箭与星体解耦）');
test('第 L 档 = 完成 2*(L-1) 课时（Lv1 起步 / Lv14 = 26 课时）', () => {
  eq(LESSONS_PER_REWARD, 2);
  for (let lv = 2; lv <= MAX_LEVEL; lv++) {
    eq(lessonsForRewardLevel(lv), 2 * (lv - 1));
    eq(rewardLevelForLessons(2 * (lv - 1)), lv);
  }
  eq(lessonsForRewardLevel(14), 26);
  for (let lv = 1; lv <= MAX_LEVEL; lv++) eq(destinationForLevel(lv).level, lv);
});
test('奖励阶梯 14 档、门槛单调递增、目的地不重复', () => {
  const ladder = rewardLadder();
  eq(ladder.length, MAX_LEVEL);
  eq(ladder[0].lessons, 0); eq(ladder[0].destination.id, 'earth_low');
  eq(new Set(ladder.map((t) => t.destination.id)).size, MAX_LEVEL);
  for (let i = 1; i < ladder.length; i++) eq(ladder[i].lessons > ladder[i - 1].lessons, true);
});
test('火箭收藏与星体解耦：15 枚可解锁火箭 ≠ 13 个奖励门槛', () => {
  const earned = badges.filter((b) => !isStarterBadge(b));
  eq(earned.length, 15);
  eq(earned.length > MAX_LEVEL - 1, true);
  eq(rewardLevelForLessons(999), MAX_LEVEL); // 课时再多也不会出现 Lv15/16
});

console.log(`\n目的地测试结果: ${pass} 通过, ${fail} 失败`);
if (fail) process.exit(1);
