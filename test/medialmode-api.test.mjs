/**
 * medialmode-api.test.mjs — 介母装配选项「孩子填入 / 自动预装」服务端集成验收（零依赖）
 * 运行：node test/medialmode-api.test.mjs
 *
 * 在隔离的临时 DATA_DIR 副本上启动真实 server.js（不碰真实玩家数据），验证：
 *  - GET /api/profile 默认 medialMode='required'（孩子填入介母，旧体验）；
 *  - POST /api/medialmode 切换 required / auto（非法值 422），落盘 progress.json；
 *  - 选项与发射动画选项互不干扰；
 *  - 一键清除学习记录保留 medialMode（家长设置而非学习记录）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.TEST_PORT) || 3205;
const BASE = `http://127.0.0.1:${PORT}`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'star-pinyin-medialmode-'));
for (const f of ['missions.json', 'textbook.json', 'badges.json']) {
  fs.copyFileSync(path.join(ROOT, 'data', f), path.join(tmp, f));
}
fs.writeFileSync(path.join(tmp, 'progress.json'), JSON.stringify({
  callsign: '测试指挥官', totalLaunches: 0, unlockedBadges: [], recentMissionIds: [], stats: {},
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
const get = async (p) => { const r = await fetch(BASE + p); return { status: r.status, body: await r.json() }; };
const post = async (p, body) => {
  const r = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  return { status: r.status, body: await r.json() };
};
const saved = () => JSON.parse(fs.readFileSync(path.join(tmp, 'progress.json'), 'utf8'));

async function waitReady() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('服务器未就绪');
}

try {
  await waitReady();

  console.log('\n[1] 默认选项');
  await test('profile 默认 medialMode=required（孩子填入介母）', async () => {
    const { status, body } = await get('/api/profile');
    eq(status, 200);
    eq(body.medialMode, 'required');
  });

  console.log('\n[2] POST /api/medialmode 切换与校验');
  await test('切换 auto（介母自动预装）成功并落盘', async () => {
    const { status, body } = await post('/api/medialmode', { medialMode: 'auto' });
    eq(status, 200);
    eq(body.ok, true);
    eq(body.medialMode, 'auto');
    eq((await get('/api/profile')).body.medialMode, 'auto');
    eq(saved().medialMode, 'auto');
  });
  await test('非法值 422，原选项不变', async () => {
    const { status } = await post('/api/medialmode', { medialMode: 'sometimes' });
    eq(status, 422);
    eq((await get('/api/profile')).body.medialMode, 'auto');
    eq(saved().medialMode, 'auto');
  });
  await test('缺字段 422', async () => {
    const { status } = await post('/api/medialmode', {});
    eq(status, 422);
  });
  await test('切回 required 成功', async () => {
    const { status, body } = await post('/api/medialmode', { medialMode: 'required' });
    eq(status, 200);
    eq(body.medialMode, 'required');
    eq((await get('/api/profile')).body.medialMode, 'required');
    await post('/api/medialmode', { medialMode: 'auto' }); // 后续用例在 auto 下验证
  });
  await test('与发射动画选项互不干扰', async () => {
    await post('/api/launchfx', { launchFx: 'unit-first' });
    const { body } = await get('/api/profile');
    eq(body.medialMode, 'auto');
    eq(body.launchFx, 'unit-first');
  });

  console.log('\n[3] 一键清除学习记录：保留家长选项');
  await test('reset 保留 medialMode（家长设置）', async () => {
    const { status } = await post('/api/admin/progress/reset');
    eq(status, 200);
    const { body } = await get('/api/profile');
    eq(body.medialMode, 'auto');
    eq(body.launchFx, 'unit-first');
    eq(saved().medialMode, 'auto');
    eq(body.totalLaunches, 0);
  });

  console.log('\n[4] 非法档案值兜底');
  await test('档案被手改成非法值 → profile 回退 required', async () => {
    const p = saved();
    p.medialMode = 'bogus';
    fs.writeFileSync(path.join(tmp, 'progress.json'), JSON.stringify(p, null, 2));
    eq((await get('/api/profile')).body.medialMode, 'required');
  });
} catch (e) {
  fail++;
  failures.push(['运行', e]);
  console.error('❌ ' + e.message);
} finally {
  clearTimeout(watchdog);
  cleanup();
}

console.log(`\n介母装配选项 API 测试结果: ${pass} 通过, ${fail} 失败`);
if (fail) {
  console.error('\n失败明细:');
  for (const [name, e] of failures) console.error(`  - ${name}: ${e.message}`);
  process.exit(1);
}