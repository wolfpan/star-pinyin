/**
 * rewards-api.test.mjs — 课时奖励系统服务端集成验收（零依赖）
 * 运行：node test/rewards-api.test.mjs
 *
 * 在隔离的临时 DATA_DIR 副本上启动真实 server.js（不碰真实玩家数据），验证：
 *  - GET /api/profile 返回课时奖励进度（lessonsCompleted / lessonsTotal / rewardLevel / currentDestination / nextReward）
 *    与已完成课时键 completedLessons（机库单元芯片置灰用）；
 *  - POST /api/progress/record 补完一课时 → lessonCompleted + 跨档解锁新目的地（newlyReachedDestination）；
 *  - 火箭收藏按完成单元数解锁（每 3 个单元一枚）：发射次数不再解锁火箭，旧规则多发自动校准收回，补完第 3 个单元才发新火箭；
 *  - 只练了部分生字的课时不算完成（不推进奖励）；
 *  - 难度接口已下线（/api/difficulty/select → 404），旧客户端的 ?difficulty= 被忽略。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { groupMissionsByLesson, lessonKey } from '../public/js/rewards.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.TEST_PORT) || 3201;
const BASE = `http://127.0.0.1:${PORT}`;

const missions = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'missions.json'), 'utf8'));
const groups = [...groupMissionsByLesson(missions).values()].sort((a, b) => a.missions.length - b.missions.length);
// 取生字最少的两个课时：A 预先练完（= 已完成 1 课时），B 待逐字补完
const lessonA = groups[0];
const lessonB = groups[1];
const lessonC = groups[2];
const lessonBig = groups[groups.length - 1];
if (!lessonA || !lessonB || !lessonC || lessonB.missions.length < 2) throw new Error('词库里找不到三个可构造用例的课时');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'star-pinyin-reward-'));
for (const f of ['missions.json', 'textbook.json', 'badges.json']) {
  fs.copyFileSync(path.join(ROOT, 'data', f), path.join(tmp, f));
}
const seededStats = {};
for (const m of lessonA.missions) seededStats[m.id] = { attempts: 1, errors: 0, weight: 1 };
// 旧规则多发：7 次发射曾解锁 3 枚火箭，但只完成 1 个单元 → 档案按单元数校准收回多发部分
const badges = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'badges.json'), 'utf8'));
const seededBadges = badges.filter((b) => Number(b.unlockAt) <= 7).map((b) => b.id);
fs.writeFileSync(path.join(tmp, 'progress.json'), JSON.stringify({
  callsign: '测试指挥官', totalLaunches: 7, unlockedBadges: seededBadges, recentMissionIds: [], stats: seededStats,
}, null, 2));

const child = spawn(process.execPath, ['server.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: tmp },
  stdio: 'ignore',
});
const cleanup = () => { try { child.kill(); } catch {} try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} };
process.on('exit', cleanup);
const watchdog = setTimeout(() => { console.error('❌ 集成测试超时'); cleanup(); process.exit(1); }, 60000);

let pass = 0, fail = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; failures.push([name, e]); console.log('  ✗ ' + name + ' → ' + e.message); }
}
const eq = assert.equal;
const ok = assert.ok;
const get = async (p) => { const r = await fetch(BASE + p); return { status: r.status, body: await r.json() }; };
const post = async (p, body) => {
  const r = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};
const record = (missionId, destinationId, extra = {}) => post('/api/progress/record', {
  missionId, assemblyErrors: 0, toneErrors: 0, durationMs: 12000, destinationId, ...extra,
});

async function waitReady() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('服务器未就绪');
}

try {
  await waitReady();
  const totalLessons = groupMissionsByLesson(missions).size;

  console.log('\n[1] 档案：课时奖励进度');
  let profile;
  await test('profile 返回课时 / 档位 / 最新目的地', async () => {
    const { status, body } = await get('/api/profile');
    eq(status, 200);
    profile = body;
    eq(body.lessonsCompleted, 1);
    eq(body.lessonsTotal, totalLessons);
    // 已完成课时键（机库单元芯片置灰用）：只含预先练完的课时 A
    ok(Array.isArray(body.completedLessons));
    eq(body.completedLessons.length, 1);
    eq(body.completedLessons[0], lessonA.key);
    eq(body.rewardLevel, 1);
    eq(body.currentDestination.id, 'earth_low');
    eq(body.nextReward.level, 2);
    eq(body.nextReward.need, 1);
    eq(body.nextReward.destination.id, 'earth_high');
  });
  await test('难度字段已从档案移除', () => {
    eq(profile.maxDifficulty, undefined);
    eq(profile.selectedDifficulty, undefined);
  });
  await test('火箭按单元校准：7 次发射 / 1 单元 → 收回旧多发，仅初始座驾', () => {
    eq(profile.totalLaunches, 7);
    eq(profile.ownedRockets.length, 1);
    eq(profile.nextBadge.id, 'long_march_1');
    eq(profile.nextBadge.unlockAt, 3);
  });

  console.log('\n[2] 上报补完课时 → 跨档解锁新目的地');
  const bCount = lessonB.missions.length;
  await test(`补完前 ${bCount - 1} 个生字：课时还没完成，不推进奖励`, async () => {
    for (let i = 0; i < bCount - 1; i++) {
      const { status, body } = await record(lessonB.missions[i].id, 'earth_low');
      eq(status, 200);
      eq(body.lessonCompleted, null);
      eq(body.lessonsCompleted, 1);
      eq(body.rewardLevel, 1);
      eq(body.newlyReachedDestination, null);
      eq(body.firstVisit, i === 0); // 第一次到访低空轨道
      eq(body.totalLaunches, 8 + i);
    }
  });
  await test('补完最后一个生字：完成课时 + 跨档解锁高空轨道', async () => {
    const { body } = await record(lessonB.missions[bCount - 1].id, 'earth_low');
    eq(lessonKey(body.lessonCompleted), lessonB.key);
    eq(body.lessonCompleted.title, lessonB.ref.title);
    eq(body.lessonsCompleted, 2);
    eq(body.rewardLevel, 2);
    eq(body.newlyReachedDestination.id, 'earth_high');
    eq(body.destinationId, 'earth_low');
    eq(body.firstVisit, false); // 重复到访低空轨道
    eq(body.totalLaunches, 7 + bCount);
    eq(body.newlyUnlockedBadges.length, 0); // 2 个单元 < 3，还不发新火箭
  });
  await test('重复上报同一题 → 不再重复解锁', async () => {
    const { body } = await record(lessonB.missions[bCount - 1].id, 'earth_high');
    eq(body.lessonCompleted, null);
    eq(body.newlyReachedDestination, null);
    eq(body.lessonsCompleted, 2);
    eq(body.rewardLevel, 2);
    eq(body.firstVisit, true); // 第一次到访高空轨道
    eq(body.totalLaunches, 8 + bCount);
  });
  await test('档案刷新：最新目的地 = 高空轨道，下一份还差 2 课时', async () => {
    const { body } = await get('/api/profile');
    eq(body.rewardLevel, 2);
    eq(body.currentDestination.id, 'earth_high');
    eq(body.nextReward.level, 3);
    eq(body.nextReward.need, 2);
    eq(body.nextReward.destination.id, 'earth_far');
    // 补完课时 B 后，completedLessons 同步含 A + B（机库两课芯片置灰）
    eq(body.completedLessons.length, 2);
    ok(body.completedLessons.includes(lessonA.key) && body.completedLessons.includes(lessonB.key));
  });
  await test('上报进度已落盘（stats / 发射数）', () => {
    const saved = JSON.parse(fs.readFileSync(path.join(tmp, 'progress.json'), 'utf8'));
    ok(saved.stats[lessonB.missions[0].id]?.attempts >= 1);
    ok(saved.stats[lessonB.missions[bCount - 1].id]?.attempts >= 1);
    eq(saved.totalLaunches, 8 + bCount);
    eq(saved.visitedDestinations.earth_low, bCount);
  });

  console.log('\n[3] 只练部分生字不推进奖励');
  await test('长课时只练 1 个字：不算完成', async () => {
    const { body } = await record(lessonBig.missions[0].id, 'earth_high', { assemblyErrors: 1 });
    eq(body.lessonCompleted, null);
    eq(body.lessonsCompleted, 2); // 仍是 2 课时
    eq(body.rewardLevel, 2);
    const { body: p } = await get('/api/profile');
    ok(!p.completedLessons.includes(lessonBig.key)); // 部分练习的课时不置灰
    eq(p.completedLessons.length, 2);
  });

  console.log('\n[4] 完成第 3 个单元 → 奖励一枚新火箭');
  const cCount = lessonC.missions.length;
  await test(`补完第 3 个单元（${cCount} 字）：解锁长征一号（unlockAt 3）`, async () => {
    for (let i = 0; i < cCount; i++) {
      const { status, body } = await record(lessonC.missions[i].id, 'earth_high');
      eq(status, 200);
      if (i < cCount - 1) {
        eq(body.lessonsCompleted, 2);
        eq(body.newlyUnlockedBadges.length, 0);
      } else {
        eq(lessonKey(body.lessonCompleted), lessonC.key);
        eq(body.lessonsCompleted, 3);
        eq(body.newlyUnlockedBadges.length, 1);
        eq(body.newlyUnlockedBadges[0].id, 'long_march_1');
        eq(body.newlyReachedDestination, null); // 3 单元仍在 Lv2，不跨目的地档
      }
    }
    const { body: p } = await get('/api/profile');
    eq(p.ownedRockets.length, 2);
    eq(p.nextBadge.id, 'long_march_2f');
    eq(p.completedLessons.length, 3);
  });

  console.log('\n[5] 难度接口下线');
  await test('POST /api/difficulty/select → 404', async () => {
    const { status } = await post('/api/difficulty/select', { difficulty: 5 });
    eq(status, 404);
  });
  await test('GET /api/missions/next 忽略旧 difficulty 参数', async () => {
    const { status, body } = await get('/api/missions/next?mode=all&difficulty=14');
    eq(status, 200);
    ok(body.id && body.hanzi, '应正常返回题目');
  });
} catch (e) {
  fail++;
  failures.push(['运行', e]);
  console.error('❌ ' + e.message);
} finally {
  clearTimeout(watchdog);
  cleanup();
}

console.log(`\n课时奖励 API 测试结果: ${pass} 通过, ${fail} 失败`);
if (fail) {
  console.error('\n失败明细:');
  for (const [name, e] of failures) console.error(`  - ${name}: ${e.message}`);
  process.exit(1);
}
