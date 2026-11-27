/**
 * rocket.test.mjs — 机库自选座驾纯逻辑测试（零依赖）
 *
 * 验收点：
 *  1. 初始座驾（土星五号）默认拥有，即使 progress 里没写；
 *  2. 机库列表只列已获得火箭，按解锁门槛升序，初始座驾在最前；
 *  3. 没自选过 → 自动用最新获得的一枚（旧的「解锁即换新」体验）；
 *  4. 自选过 → 固定用自选的那枚，之后解锁新火箭也不会抢走座驾；
 *  5. 未获得 / 已失效（进度被手改）的自选 id 会被忽略并回落到最新；
 *  6. 顶级概念旗舰猎鹰21号 / 星舰9号（42/45 个完成单元解锁）压轴收藏，可自选。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  isStarterBadge, byUnlockAt, ownedRocketIds, ownedRockets, resolveCurrentRocket, canSelectRocket, rocketIdsForUnits,
} from '../public/js/rocket-select.js';

let pass = 0, fail = 0;
function test(name, fn) { try { fn(); pass++; console.log('  \u2713 ' + name); } catch (e) { fail++; console.log('  \u2717 ' + name + ' \u2192 ' + e.message); } }
const eq = assert.equal;

const root = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const badges = JSON.parse(fs.readFileSync(path.join(root, '..', 'data', 'badges.json'), 'utf8'));

/** 构造进度：给定已解锁的火箭 id 与自选座驾。 */
const progressOf = (unlockedBadges = [], selectedRocketId = undefined) => ({
  unlockedBadges, ...(selectedRocketId === undefined ? {} : { selectedRocketId }),
});

console.log('\n火箭拥有 / 座驾选择');
test('初始座驾默认拥有（progress 为空也有）', () => {
  const ids = ownedRocketIds(progressOf(), badges);
  eq(ids.has('saturn_v'), true);
  eq([...ids].length, 1);
});
test('初始座驾判定：starter 或 unlockAt=0', () => {
  eq(isStarterBadge({ id: 'x', starter: true }), true);
  eq(isStarterBadge({ id: 'x', unlockAt: 0 }), true);
  eq(isStarterBadge({ id: 'x', unlockAt: 3 }), false);
  eq(isStarterBadge({}), false);
});
test('机库列表按解锁门槛升序，初始座驾在最前', () => {
  const list = ownedRockets(progressOf(['long_march_5', 'long_march_1']), badges);
  eq(list.map((b) => b.id).join(','), 'saturn_v,long_march_1,long_march_5');
  eq(list.every((b) => Number.isFinite(b.unlockAt)), true);
  eq(byUnlockAt({ unlockAt: 0 }, { unlockAt: 3 }) < 0, true);
});
test('没自选 → 默认用最新获得的一枚', () => {
  eq(resolveCurrentRocket(progressOf(), badges)?.id, 'saturn_v');
  eq(resolveCurrentRocket(progressOf(['long_march_1', 'falcon_9']), badges)?.id, 'falcon_9');
});
test('自选后固定用自选的火箭（即使后来解锁了更新的）', () => {
  const p = progressOf(['long_march_1', 'falcon_9', 'starship'], 'long_march_1');
  eq(resolveCurrentRocket(p, badges)?.id, 'long_march_1');
});
test('自选初始座驾也生效（不被最新火箭抢走）', () => {
  const p = progressOf(['long_march_1', 'starship'], 'saturn_v');
  eq(resolveCurrentRocket(p, badges)?.id, 'saturn_v');
});
test('自选已失效（进度被手改/未拥有）→ 回落到最新', () => {
  eq(resolveCurrentRocket(progressOf(['long_march_1'], 'starship'), badges)?.id, 'long_march_1');
  eq(resolveCurrentRocket(progressOf([], 'long_march_2f'), badges)?.id, 'saturn_v');
});
test('只有已获得的火箭可自选', () => {
  const p = progressOf(['long_march_1']);
  eq(canSelectRocket(p, badges, 'saturn_v'), true);
  eq(canSelectRocket(p, badges, 'long_march_1'), true);
  eq(canSelectRocket(p, badges, 'starship'), false);
  eq(canSelectRocket(p, badges, ''), false);
  eq(canSelectRocket(p, badges, undefined), false);
});
test('空词表 / 空徽章不抛错', () => {
  eq(resolveCurrentRocket({}, []), null);
  eq(ownedRockets({}, []).length, 0);
  eq(ownedRocketIds({}, undefined).size, 0);
});

console.log('\n顶级概念火箭（猎鹰21号 / 星舰9号）');
test('两枚未来概念旗舰：42 / 45 个完成单元解锁', () => {
  const f21 = badges.find((b) => b.id === 'falcon_21');
  const s9 = badges.find((b) => b.id === 'starship_9');
  eq(f21?.name, '猎鹰21号'); eq(f21?.unlockAt, 42); eq(f21?.concept, true);
  eq(s9?.name, '星舰9号'); eq(s9?.unlockAt, 45); eq(s9?.concept, true);
});
test('全收藏共 16 枚，机库排序概念旗舰压轴', () => {
  const all = badges.map((b) => b.id);
  const list = ownedRockets(progressOf(all), badges);
  eq(list.length, 16);
  eq(list[list.length - 2].id, 'falcon_21');
  eq(list[list.length - 1].id, 'starship_9');
});
test('解锁门槛 = 每 3 个完成单元一枚（3/6/9…45）', () => {
  const unlockable = badges.filter((b) => !isStarterBadge(b)).sort(byUnlockAt);
  eq(unlockable.length, 15);
  unlockable.forEach((b, i) => eq(b.unlockAt, (i + 1) * 3));
});
test('拥有状态按单元数推导：0/2 单元仅初始座驾，3 单元 +1，45 单元全收藏', () => {
  eq([...rocketIdsForUnits(badges, 0)].join(','), 'saturn_v');
  eq(rocketIdsForUnits(badges, 2).size, 1);
  eq(rocketIdsForUnits(badges, 3).has('long_march_1'), true);
  eq(rocketIdsForUnits(badges, 3).size, 2);
  eq(rocketIdsForUnits(badges, 45).size, 16);
  eq(rocketIdsForUnits(badges, -5).size, 1);
});
test('没自选时自动跟随到最新旗舰星舰9号', () => {
  const all = badges.map((b) => b.id);
  eq(resolveCurrentRocket(progressOf(all), badges)?.id, 'starship_9');
});
test('未达门槛不可自选概念旗舰', () => {
  const p = progressOf(['long_march_1']);
  eq(canSelectRocket(p, badges, 'falcon_21'), false);
  eq(canSelectRocket(p, badges, 'starship_9'), false);
});

console.log(`\n火箭座驾测试结果: ${pass} 通过, ${fail} 失败`);
if (fail) process.exit(1);
