/**
 * unit-api.test.mjs — 单元完成规则服务端集成验收（零依赖）
 * 运行：node test/unit-api.test.mjs
 *
 * 「单元」= 一课（seq）。在隔离的临时 DATA_DIR 副本上启动真实 server.js（不碰真实玩家数据），验证：
 *  - POST /api/unit/select {grade,term,seq} 生成题单（本课新字 + 复习名额=总字数−新字）/ 校验 422 / 恢复 / 完成后重抽
 *  - 总字数后台可配 10~20（POST /api/unittotal）；复习名额随之变化；新字超总字数只练新字
 *  - 本单元每字只出现一次（答错不追加）；错题修正分散后续单元，连续 3 次全对毕业
 *  - 复习错题优先；紧急任务绕过题单；选全册/清空记录作废题单（总字数作为家长设置保留）
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { lessonNewCount, isPastMission, unitFxPlays, UNIT_TOTAL_DEFAULT } from '../public/js/unit-session.js';
import { buildMissions } from '../scripts/wordbank-lib.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.TEST_PORT) || 3211;
const BASE = `http://127.0.0.1:${PORT}`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'star-pinyin-unit-'));
for (const f of ['missions.json', 'textbook.json', 'badges.json']) {
  fs.copyFileSync(path.join(ROOT, 'data', f), path.join(tmp, f));
}
fs.writeFileSync(path.join(tmp, 'progress.json'), JSON.stringify({
  callsign: '测试指挥官', totalLaunches: 0, unlockedBadges: [], recentMissionIds: [], stats: {},
}, null, 2));

const child = spawn(process.execPath, ['server.js'], {
  cwd: ROOT, env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: tmp }, stdio: 'ignore',
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
const readProgress = () => JSON.parse(fs.readFileSync(path.join(tmp, 'progress.json'), 'utf8'));
const writeProgress = (p) => fs.writeFileSync(path.join(tmp, 'progress.json'), JSON.stringify(p, null, 2));
const record = (missionId, assemblyErrors = 0, toneErrors = 0) =>
  post('/api/progress/record', { missionId, assemblyErrors, toneErrors, durationMs: 1000, destinationId: 'earth_low' });
const select = (seq) => post('/api/unit/select', { grade: 1, term: 1, seq });

async function waitReady() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('服务器未就绪');
}

const catalog = JSON.parse(fs.readFileSync(path.join(tmp, 'textbook.json'), 'utf8'));
const missions = JSON.parse(fs.readFileSync(path.join(tmp, 'missions.json'), 'utf8'));
const L1_NEW = lessonNewCount(catalog, 1, 1, 1);
const L2_NEW = lessonNewCount(catalog, 1, 1, 2);
const L21_NEW = lessonNewCount(catalog, 1, 1, 21);
const reviewFor = (seq, total = UNIT_TOTAL_DEFAULT) => {
  const past = missions.filter((m) => m.textbook && isPastMission(m, 1, 1, seq)).length;
  return Math.min(Math.max(0, total - lessonNewCount(catalog, 1, 1, seq)), past);
};

try {
  await waitReady();

  console.log('\n[1] 选择课文（单元）→ 生成固定题单');
  await test('POST /api/unit/select 一上识字2 → 新字 + 复习（默认总字数 15）', async () => {
    const { status, body } = await select(2);
    eq(status, 200);
    eq(body.session.seq, 2);
    eq(body.session.newCount, L2_NEW);
    eq(body.session.reviewCount, reviewFor(2));
    eq(body.session.total, L2_NEW + reviewFor(2));
    eq(body.session.label, '一年级上册 · 识字2《金木水火土》');
    const q = readProgress().unitSession.queue;
    eq(new Set(q.map((x) => x.missionId)).size, q.length, '题单内汉字应唯一');
  });
  await test('非法 seq / 年级 / 缺 seq → 422', async () => {
    eq((await post('/api/unit/select', { grade: 1, term: 1, seq: 0 })).status, 422);
    eq((await post('/api/unit/select', { grade: 1, term: 1, seq: 999 })).status, 422);
    eq((await post('/api/unit/select', { grade: 9, term: 1, seq: 1 })).status, 422);
    eq((await post('/api/unit/select', { grade: 1, term: 1 })).status, 422);
  });

  console.log('\n[2] 沿题单逐题发射 + 首尾动画判定数据');
  let firstId;
  await test('next 返回题单第1题（kind=new，cursor 0 → 播动画）', async () => {
    const { status, body } = await get('/api/missions/next?mode=all');
    eq(status, 200);
    firstId = body.id;
    eq(body.unitSession.kind, 'new');
    eq(body.unitSession.cursor, 0);
    eq(unitFxPlays(body.unitSession), true);
  });
  await test('全对上报 → cursor 前进、不入错题池', async () => {
    const { body } = await record(firstId, 0, 0);
    eq(body.unitSession.cursor, 1);
    eq(body.wrongPool.wrong, false);
  });
  await test('中间题跳过动画、末题播动画（cursor 判定）', async () => {
    const total = readProgress().unitSession.queue.length;
    const p = readProgress(); p.unitSession.cursor = 3; writeProgress(p);
    eq(unitFxPlays((await get('/api/missions/next?mode=all')).body.unitSession), false);
    p.unitSession.cursor = total - 1; writeProgress(p);
    eq(unitFxPlays((await get('/api/missions/next?mode=all')).body.unitSession), true);
    p.unitSession.cursor = 1; writeProgress(p);
  });

  console.log('\n[3] 本单元每字只出现一次（答错不追加）');
  let errId;
  await test('第2题出错 → 入池(fixes 0)，但题单不追加、长度不变、无 repeat', async () => {
    const { body: next } = await get('/api/missions/next?mode=all');
    errId = next.id;
    const before = readProgress().unitSession.queue.length;
    const { body } = await record(errId, 2, 0);
    eq(body.wrongPool.wrong, true); eq(body.wrongPool.fixes, 0);
    eq(body.unitSession.cursor, 2);
    const q = readProgress().unitSession.queue;
    eq(q.length, before, '答错不应追加题目');
    ok(!q.some((x) => x.kind === 'repeat'), '不应有 repeat 项');
  });
  await test('错题不在本单元后续重复出现', async () => {
    const p = readProgress();
    ok(!p.unitSession.queue.slice(p.unitSession.cursor).some((x) => x.missionId === errId));
  });

  console.log('\n[4] 错题修正分散到后续不同单元，连续 3 次全对毕业');
  await test('后续单元复习错题优先重抽 errId，跨单元累计修正 3 次毕业', async () => {
    await post('/api/unittotal', { unitTotal: 15 });
    for (const [seq, fix] of [[3, 1], [4, 2], [5, 3]]) {
      await select(seq);
      const review = readProgress().unitSession.queue.filter((x) => x.kind === 'review').map((x) => x.missionId);
      ok(review.includes(errId), `识字${seq} 复习应错题优先抽到 errId`);
      const rec = await record(errId, 0, 0);
      eq(rec.body.wrongPool.fixes, fix);
      const st = readProgress().stats[errId];
      eq(st.fixes, fix); eq(st.wrong, fix < 3);
    }
    eq(readProgress().stats[errId].wrong, false);
  });
  await test('毕业后再错 → 重新入池、计数清零', async () => {
    const { body } = await record(errId, 1, 0);
    eq(body.wrongPool.wrong, true); eq(body.wrongPool.fixes, 0);
  });

  console.log('\n[5] 完成后重抽 / 恢复进度');
  await test('题单做完 → next 重新生成新题单（cursor 归零）', async () => {
    await select(1);
    const q = readProgress().unitSession.queue;
    eq(q.length, L1_NEW);
    for (const item of q) await record(item.missionId, 0, 0);
    eq(readProgress().unitSession.cursor, L1_NEW);
    const { body } = await get('/api/missions/next?mode=all');
    eq(body.unitSession.cursor, 0); eq(body.unitSession.total, L1_NEW);
  });
  await test('未完成时再选同一课 → 恢复进度（不重抽）', async () => {
    await select(2);
    await record(readProgress().unitSession.queue[0].missionId, 0, 0);
    eq((await select(2)).body.session.cursor, 1);
  });

  console.log('\n[6] 复习错题优先');
  await test('错题池中的过往字优先占复习名额', async () => {
    const past = missions.filter((m) => m.textbook && isPastMission(m, 1, 1, 2));
    const wrongIds = [past[0].id, past[1].id];
    const p = readProgress();
    p.stats = p.stats || {};
    for (const id of wrongIds) p.stats[id] = { attempts: 1, errors: 1, weight: 2, wrong: true, fixes: 0 };
    p.unitSession = null;
    writeProgress(p);
    const { body } = await select(2);
    eq(body.session.reviewCount, reviewFor(2));
    const review = readProgress().unitSession.queue.filter((x) => x.kind === 'review').map((x) => x.missionId);
    for (const id of wrongIds) ok(review.slice(0, 2).includes(id), `错题 ${id} 未优先进复习`);
  });

  console.log('\n[7] 退出单元模式 / 紧急任务绕过');
  await test('紧急任务模式绕过题单（直取注入题）', async () => {
    const { missions: [inj] } = buildMissions([{ hanzi: '鑫', word: '鑫鑫', pinyin: 'xīn', hint: '测试注入字' }], 9001);
    eq((await post('/api/admin/missions', { ...inj, id: 'm_p_unit1' })).status, 201);
    const { body } = await get('/api/missions/next?mode=emergency');
    eq(body.hanzi, '鑫'); eq(body.unitSession, undefined);
  });
  await test('选全册 → 作废单元题单，退回随机抽题', async () => {
    eq((await post('/api/textbook/select', { grade: 1, term: 1, seq: null })).status, 200);
    eq(readProgress().unitSession, undefined);
    eq((await get('/api/profile')).body.unitSession, null);
    eq((await get('/api/missions/next?mode=all')).body.unitSession, undefined);
  });

  console.log('\n[8] 总字数后台可配 10~20');
  await test('POST /api/unittotal 校验：10~20 整数，非法 422', async () => {
    eq((await post('/api/unittotal', { unitTotal: 20 })).status, 200);
    eq((await post('/api/unittotal', { unitTotal: 9 })).status, 422);
    eq((await post('/api/unittotal', { unitTotal: 21 })).status, 422);
    eq((await post('/api/unittotal', { unitTotal: 'abc' })).status, 422);
  });
  await test('总字数 20 → 秋天（10 新字）复习 10；总字数 10 → 复习 0', async () => {
    await post('/api/unittotal', { unitTotal: 20 });
    eq((await get('/api/profile')).body.unitTotal, 20);
    const b20 = await select(21);
    eq(b20.body.session.newCount, L21_NEW);
    eq(b20.body.session.reviewCount, 20 - L21_NEW);
    await post('/api/unittotal', { unitTotal: 10 });
    const p = readProgress(); p.unitSession = null; writeProgress(p); // 作废旧题单，按新总字数重建
    const b10 = await select(21);
    eq(b10.body.session.reviewCount, 0);
    eq(b10.body.session.total, L21_NEW);
  });
  await test('清空学习记录 → 题单清空，但总字数（家长设置）保留', async () => {
    await select(2);
    ok(readProgress().unitSession);
    eq((await post('/api/admin/progress/reset', {})).status, 200);
    eq(readProgress().unitSession, undefined);
    eq(readProgress().unitTotal, 10);
  });
} catch (e) {
  fail++; failures.push(['运行', e]); console.error('❌ ' + e.message);
} finally {
  clearTimeout(watchdog);
  cleanup();
}

console.log(`\n单元完成规则 API 测试结果: ${pass} 通过, ${fail} 失败`);
if (fail) {
  console.error('\n失败明细:');
  for (const [name, e] of failures) console.error(`  - ${name}: ${e.message}`);
  process.exit(1);
}