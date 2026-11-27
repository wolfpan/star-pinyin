/**
 * progress-reset-api.test.mjs — 家长端「一键清除学习记录」服务端集成验收（零依赖）
 * 运行：node test/progress-reset-api.test.mjs
 *
 * 在隔离的临时 DATA_DIR 副本上启动真实 server.js（不碰真实玩家数据），验证：
 *  - POST /api/admin/progress/reset 清空作答统计 / 发射次数 / 火箭解锁 / 星球图鉴 / 课时进度；
 *  - 保留呼号与课文同步选择（家长设置），词库 missions.json 一字不动；
 *  - 重置后孩子端可正常重新作答（从零累计）；
 *  - 重复重置幂等。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { groupMissionsByLesson } from '../public/js/rewards.js';
import { isStarterBadge } from '../public/js/rocket-select.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.TEST_PORT) || 3202;
const BASE = `http://127.0.0.1:${PORT}`;

const missions = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'missions.json'), 'utf8'));
const badges = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'badges.json'), 'utf8'));
const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'textbook.json'), 'utf8'));
const groups = [...groupMissionsByLesson(missions).values()].sort((a, b) => a.missions.length - b.missions.length);
const lessonA = groups[0];
if (!lessonA) throw new Error('词库里找不到可构造用例的课时');

// 课文同步选择：取目录里真实存在的一课（家长设置，重置后应保留）
const firstGrade = catalog.grades[0];
const firstBook = firstGrade.books[0];
const selection = { grade: firstGrade.grade, term: firstBook.term, seq: Math.min(2, firstBook.lessons.length) };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'star-pinyin-reset-'));
for (const f of ['missions.json', 'textbook.json', 'badges.json']) {
  fs.copyFileSync(path.join(ROOT, 'data', f), path.join(tmp, f));
}
const missionsBefore = fs.readFileSync(path.join(tmp, 'missions.json'), 'utf8');

// 预置一份「学过一阵子」的档案：7 次发射 + 已解锁火箭 + 自选座驾 + 到访记录 + 作答统计
const seededStats = {};
for (const m of lessonA.missions) seededStats[m.id] = { attempts: 2, errors: 1, weight: 2 };
const seededBadges = badges.filter((b) => Number(b.unlockAt) <= 7).map((b) => b.id);
const chosenRocket = badges.find((b) => !isStarterBadge(b) && Number(b.unlockAt) <= 7)?.id || null;
fs.writeFileSync(path.join(tmp, 'progress.json'), JSON.stringify({
  callsign: '测试指挥官',
  totalLaunches: 7,
  unlockedBadges: seededBadges,
  recentMissionIds: lessonA.missions.map((m) => m.id),
  stats: seededStats,
  visitedDestinations: { earth_low: 5, earth_high: 2 },
  selectedRocketId: chosenRocket,
  textbook: selection,
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
const deepEq = assert.deepEqual;
const get = async (p) => { const r = await fetch(BASE + p); return { status: r.status, body: await r.json() }; };
const post = async (p, body) => {
  const r = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  return { status: r.status, body: await r.json() };
};

async function waitReady() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('服务器未就绪');
}

try {
  await waitReady();

  console.log('\n[1] 重置前：档案确有学习记录');
  await test('profile 有发射数 / 薄弱标签 / 课时进度 / 自选座驾', async () => {
    const { status, body } = await get('/api/profile');
    eq(status, 200);
    eq(body.totalLaunches, 7);
    ok(Object.keys(body.tagMastery).length > 0, '应有薄弱标签统计');
    ok(body.lessonsCompleted >= 1, '预置课时应已完成');
    eq(body.rocketAuto, false);
    ok(body.ownedRockets.length >= 2, '应已解锁多枚火箭');
    deepEq(body.visitedDestinations, { earth_low: 5, earth_high: 2 });
  });

  console.log('\n[2] POST /api/admin/progress/reset');
  await test('重置成功并返回清除前的规模', async () => {
    const { status, body } = await post('/api/admin/progress/reset');
    eq(status, 200);
    eq(body.ok, true);
    eq(body.previousLaunches, 7);
    eq(body.clearedStats, Object.keys(seededStats).length);
  });
  await test('profile 归零：发射 / 统计 / 课时 / 图鉴 / 火箭全部清空', async () => {
    const { body } = await get('/api/profile');
    eq(body.totalLaunches, 0);
    deepEq(body.tagMastery, {});
    eq(body.lessonsCompleted, 0);
    eq(body.rewardLevel, 1);
    eq(body.currentDestination.id, 'earth_low');
    deepEq(body.visitedDestinations, {});
    eq(body.rocketAuto, true);
    eq(body.ownedRockets.length, 1, '只剩初始座驾');
    ok(isStarterBadge(body.ownedRockets[0]), '初始座驾保留');
  });
  await test('呼号与课文同步选择保留（家长设置不算学习记录）', async () => {
    const { body } = await get('/api/profile');
    eq(body.callsign, '测试指挥官');
    deepEq(body.textbook, selection);
  });
  await test('词库一字不动：任务数不变、错误率全部归零', async () => {
    const { status, body } = await get('/api/admin/missions');
    eq(status, 200);
    eq(body.count, missions.length);
    ok(body.missions.every((m) => m.attempts === 0 && m.errors === 0 && m.errorRate === 0));
    eq(fs.readFileSync(path.join(tmp, 'missions.json'), 'utf8'), missionsBefore, 'missions.json 不应被改写');
  });
  await test('progress.json 已落盘为全新档案', () => {
    const saved = JSON.parse(fs.readFileSync(path.join(tmp, 'progress.json'), 'utf8'));
    eq(saved.totalLaunches, 0);
    deepEq(saved.stats, {});
    deepEq(saved.unlockedBadges, []);
    deepEq(saved.recentMissionIds, []);
    eq(saved.selectedRocketId, undefined);
    eq(saved.visitedDestinations, undefined);
    eq(saved.callsign, '测试指挥官');
    deepEq(saved.textbook, selection);
  });

  console.log('\n[3] 重置后孩子端从零开始');
  await test('重新作答正常累计（第 1 次发射）', async () => {
    const { status, body } = await post('/api/progress/record', {
      missionId: lessonA.missions[0].id, assemblyErrors: 0, toneErrors: 0, durationMs: 9000, destinationId: 'earth_low',
    });
    eq(status, 200);
    eq(body.totalLaunches, 1);
    eq(body.firstVisit, true);
    const { body: profile } = await get('/api/profile');
    eq(profile.totalLaunches, 1);
    ok(Object.keys(profile.tagMastery).length > 0, '新作答重新产生统计');
  });

  console.log('\n[4] 幂等：再次重置');
  await test('重复重置仍成功并归零', async () => {
    const { status, body } = await post('/api/admin/progress/reset');
    eq(status, 200);
    eq(body.previousLaunches, 1);
    eq(body.clearedStats, 1);
    const { body: profile } = await get('/api/profile');
    eq(profile.totalLaunches, 0);
    deepEq(profile.tagMastery, {});
  });
} catch (e) {
  fail++;
  failures.push(['运行', e]);
  console.error('❌ ' + e.message);
} finally {
  clearTimeout(watchdog);
  cleanup();
}

console.log(`\n一键清除学习记录 API 测试结果: ${pass} 通过, ${fail} 失败`);
if (fail) {
  console.error('\n失败明细:');
  for (const [name, e] of failures) console.error(`  - ${name}: ${e.message}`);
  process.exit(1);
}
