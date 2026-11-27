/**
 * launchfx-api.test.mjs — 发射动画选项「每单元仅首次」服务端集成验收（零依赖）
 * 运行：node test/launchfx-api.test.mjs
 *
 * 在隔离的临时 DATA_DIR 副本上启动真实 server.js（不碰真实玩家数据），验证：
 *  - GET /api/profile 默认 launchFx='always'，launchedUnits 由作答统计推导（单元内任一词条练过即算）；
 *  - POST /api/launchfx 切换 always / unit-first（非法值 422），落盘 progress.json；
 *  - 上报新单元 → launchedUnits 增加该单元键；同单元重复上报不重复；
 *  - 无单元归属的词条（汉语拼音课 / 无教材引用扩展）不影响 launchedUnits；
 *  - 一键清除学习记录保留 launchFx（家长设置），launchedUnits 随 stats 归零。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { unitKey } from '../public/js/textbook.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.TEST_PORT) || 3203;
const BASE = `http://127.0.0.1:${PORT}`;

const missions = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'missions.json'), 'utf8'));
// 用例取材：一年级上册第 1 单元预置练过 1 字；第 2 单元取两个不同词条待上报；
// 再取一个无单元归属的词条（汉语拼音课 / 无教材引用扩展）。
const inUnit = (u) => missions.filter((m) => unitKey(m.textbook) === `1-1-${u}`);
const unitA = inUnit(1);
const unitB = inUnit(2);
const noUnit = missions.filter((m) => !m.isParentInjected && !unitKey(m.textbook));
if (!unitA.length || unitB.length < 2 || !noUnit.length) throw new Error('词库里找不到可构造用例的单元');
const keyA = '1-1-1';
const keyB = '1-1-2';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'star-pinyin-launchfx-'));
for (const f of ['missions.json', 'textbook.json', 'badges.json']) {
  fs.copyFileSync(path.join(ROOT, 'data', f), path.join(tmp, f));
}
// 预置：第 1 单元练过 1 个字（attempts>0），其余为零
fs.writeFileSync(path.join(tmp, 'progress.json'), JSON.stringify({
  callsign: '测试指挥官', totalLaunches: 1, unlockedBadges: [], recentMissionIds: [],
  stats: { [unitA[0].id]: { attempts: 1, errors: 0, weight: 1 } },
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
  const r = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  return { status: r.status, body: await r.json() };
};
const record = (missionId) => post('/api/progress/record', {
  missionId, assemblyErrors: 0, toneErrors: 0, durationMs: 12000, destinationId: 'earth_low',
});
const launchedUnits = async () => (await get('/api/profile')).body.launchedUnits;

async function waitReady() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('服务器未就绪');
}

try {
  await waitReady();

  console.log('\n[1] 默认选项与已发射单元推导');
  await test('profile 默认 launchFx=always', async () => {
    const { status, body } = await get('/api/profile');
    eq(status, 200);
    eq(body.launchFx, 'always');
  });
  await test('launchedUnits 由作答统计推导（练过的单元在列）', async () => {
    const units = await launchedUnits();
    ok(Array.isArray(units));
    ok(units.includes(keyA), '预置练过的第 1 单元应在列');
    ok(!units.includes(keyB), '没练过的第 2 单元不应在列');
  });

  console.log('\n[2] POST /api/launchfx 切换与校验');
  await test('切换 unit-first 成功并落盘', async () => {
    const { status, body } = await post('/api/launchfx', { launchFx: 'unit-first' });
    eq(status, 200);
    eq(body.ok, true);
    eq(body.launchFx, 'unit-first');
    eq((await get('/api/profile')).body.launchFx, 'unit-first');
    const saved = JSON.parse(fs.readFileSync(path.join(tmp, 'progress.json'), 'utf8'));
    eq(saved.launchFx, 'unit-first');
  });
  await test('非法值 422，原选项不变', async () => {
    const { status } = await post('/api/launchfx', { launchFx: 'sometimes' });
    eq(status, 422);
    eq((await get('/api/profile')).body.launchFx, 'unit-first');
  });
  await test('切回 always 成功', async () => {
    const { status, body } = await post('/api/launchfx', { launchFx: 'always' });
    eq(status, 200);
    eq(body.launchFx, 'always');
    await post('/api/launchfx', { launchFx: 'unit-first' }); // 后续用例在 unit-first 下验证
  });

  console.log('\n[3] 上报作答 → 已发射单元集合');
  await test('新单元首次上报 → 单元键加入', async () => {
    const { status } = await record(unitB[0].id);
    eq(status, 200);
    const units = await launchedUnits();
    ok(units.includes(keyB), '第 2 单元首次发射后应在列');
    ok(units.includes(keyA));
  });
  await test('同单元再次上报 → 不重复', async () => {
    await record(unitB[1].id);
    const units = await launchedUnits();
    eq(units.filter((k) => k === keyB).length, 1);
  });
  await test('无单元归属的词条上报 → 集合不变', async () => {
    const before = await launchedUnits();
    const { status } = await record(noUnit[0].id);
    eq(status, 200);
    const after = await launchedUnits();
    eq(after.length, before.length);
    ok(!after.some((k) => k.endsWith('-null') || k.endsWith('-undefined')));
  });

  console.log('\n[4] 一键清除学习记录：保留选项、单元归零');
  await test('reset 保留 launchFx（家长设置），launchedUnits 清空', async () => {
    const { status } = await post('/api/admin/progress/reset');
    eq(status, 200);
    const { body } = await get('/api/profile');
    eq(body.launchFx, 'unit-first');
    eq(body.launchedUnits.length, 0);
    const saved = JSON.parse(fs.readFileSync(path.join(tmp, 'progress.json'), 'utf8'));
    eq(saved.launchFx, 'unit-first');
  });
  await test('重置后重新发射 → 单元键重新出现（每单元又是第一次）', async () => {
    await record(unitA[0].id);
    const units = await launchedUnits();
    ok(units.includes(keyA));
    eq(units.length, 1);
  });
} catch (e) {
  fail++;
  failures.push(['运行', e]);
  console.error('❌ ' + e.message);
} finally {
  clearTimeout(watchdog);
  cleanup();
}

console.log(`\n发射动画选项 API 测试结果: ${pass} 通过, ${fail} 失败`);
if (fail) {
  console.error('\n失败明细:');
  for (const [name, e] of failures) console.error(`  - ${name}: ${e.message}`);
  process.exit(1);
}