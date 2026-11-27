/**
 * textbook-api.test.mjs — 课文同步服务端集成验收（零依赖）
 * 运行：node test/textbook-api.test.mjs
 *
 * 在隔离的临时 DATA_DIR 副本上启动真实 server.js（不碰真实玩家数据），验证：
 *  - GET /api/textbook 返回目录 + 当前进度
 *  - POST /api/textbook/select 校验与持久化（非法 422）
 *  - GET /api/missions/next 按进度过滤字池（含 mode 过滤与退回）
 *  - 紧急注入不受进度限制；emergency 模式直取注入题
 *  - GET /api/profile 携带 textbook 进度
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { allowedHanzi } from '../public/js/textbook.js';
import { buildMissions } from '../scripts/wordbank-lib.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.TEST_PORT) || 3199;
const BASE = `http://127.0.0.1:${PORT}`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'star-pinyin-test-'));
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
const ok = assert.ok;
const get = async (p) => { const r = await fetch(BASE + p); return { status: r.status, body: await r.json() }; };
const post = async (p, body) => {
  const r = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};

async function waitReady() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('服务器未就绪');
}

const catalog = JSON.parse(fs.readFileSync(path.join(tmp, 'textbook.json'), 'utf8'));
const missions = JSON.parse(fs.readFileSync(path.join(tmp, 'missions.json'), 'utf8'));

try {
  await waitReady();

  console.log('\n[1] 目录与进度选择');
  await test('GET /api/textbook 返回三册年级目录', async () => {
    const { status, body } = await get('/api/textbook');
    eq(status, 200);
    eq(body.catalog.grades.map((g) => g.grade).join(','), '1,2,3');
    eq(body.selection, null);
  });
  await test('POST select 一年级上册第2课 → 持久化', async () => {
    const { status, body } = await post('/api/textbook/select', { grade: 1, term: 1, seq: 2 });
    eq(status, 200);
    eq(body.selection.grade, 1); eq(body.selection.term, 1); eq(body.selection.seq, 2);
    ok(body.poolSize > 0);
    const saved = JSON.parse(fs.readFileSync(path.join(tmp, 'progress.json'), 'utf8'));
    eq(saved.textbook.seq, 2);
  });
  await test('非法选择 → 422', async () => {
    eq((await post('/api/textbook/select', { grade: 9 })).status, 422);
    eq((await post('/api/textbook/select', { grade: 1, term: 3 })).status, 422);
    eq((await post('/api/textbook/select', { grade: 1, term: 1, seq: 0 })).status, 422);
    eq((await post('/api/textbook/select', { grade: 1, term: 1, seq: 999 })).status, 422);
  });

  console.log('\n[2] 抽题按进度过滤');
  const sel = { grade: 1, term: 1, seq: 2 };
  const allowed = allowedHanzi(catalog, sel);
  await test('40 次抽题全部落在进度字池内', async () => {
    for (let i = 0; i < 40; i++) {
      const { status, body } = await get('/api/missions/next?mode=all&difficulty=3');
      eq(status, 200);
      ok(allowed.has(body.hanzi) || body.isParentInjected, `${body.id}「${body.hanzi}」超出进度`);
    }
  });
  await test('mode=three 进度内无三拼时退回综合巡航（仍限进度）', async () => {
    const pool = missions.filter((m) => allowed.has(m.hanzi));
    const hasThree = pool.some((m) => m.type === 'three_part');
    for (let i = 0; i < 15; i++) {
      const { body } = await get('/api/missions/next?mode=three&difficulty=5');
      ok(allowed.has(body.hanzi), `${body.id} 超出进度`);
      if (hasThree) eq(body.type, 'three_part');
    }
  });
  await test('GET /api/profile 携带进度', async () => {
    const { body } = await get('/api/profile');
    eq(body.textbook.seq, 2);
  });

  console.log('\n[3] 紧急注入豁免进度');
  const { missions: [inj] } = buildMissions([{ hanzi: '鑫', word: '鑫鑫', pinyin: 'xīn', hint: '测试注入字' }], 9001);
  await test('注入进度外生字（家长热注入）', async () => {
    const { status } = await post('/api/admin/missions', { ...inj, id: 'm_p_test1' });
    eq(status, 201);
  });
  await test('emergency 模式直取注入题（不受进度限制）', async () => {
    const { status, body } = await get('/api/missions/next?mode=emergency');
    eq(status, 200);
    eq(body.hanzi, '鑫');
  });
  await test('综合巡航仍可抽到紧急注入（豁免）', async () => {
    let sawInjected = false;
    for (let i = 0; i < 60; i++) {
      const { body } = await get('/api/missions/next?mode=all&difficulty=1');
      ok(allowed.has(body.hanzi) || body.isParentInjected, `${body.id} 超出进度且非注入`);
      if (body.hanzi === '鑫') sawInjected = true;
    }
    ok(sawInjected, '60 次未抽到注入题（权重 ×5 应大概率出现）');
  });

  console.log('\n[4] 改回自由巡航');
  await test('grade=null → 清除进度，全库可抽', async () => {
    const { status, body } = await post('/api/textbook/select', { grade: null });
    eq(status, 200);
    eq(body.selection, null);
    const seen = new Set();
    for (let i = 0; i < 30; i++) {
      const { body: m } = await get('/api/missions/next?mode=all&difficulty=14');
      seen.add(m.hanzi);
    }
    ok(seen.size > allowed.size, '自由巡航应能抽到进度外的字');
  });
} catch (e) {
  fail++;
  failures.push(['运行', e]);
  console.error('❌ ' + e.message);
} finally {
  clearTimeout(watchdog);
  cleanup();
}

console.log(`\n课文同步 API 测试结果: ${pass} 通过, ${fail} 失败`);
if (fail) {
  console.error('\n失败明细:');
  for (const [name, e] of failures) console.error(`  - ${name}: ${e.message}`);
  process.exit(1);
}
