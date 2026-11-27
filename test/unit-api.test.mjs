/**
 * unit-api.test.mjs — 单元完成规则服务端集成验收（零依赖）
 * 运行：node test/unit-api.test.mjs
 *
 * 在隔离的临时 DATA_DIR 副本上启动真实 server.js（不碰真实玩家数据），验证：
 *  - POST /api/unit/select 生成题单（本单元新字 + 抽5个过往字）/ 校验 422 / 恢复进度 / 完成后重抽
 *  - GET /api/missions/next 沿题单逐题出题（附 unitSession 进度与 kind）
 *  - POST /api/progress/record 错题入池、队尾重复、连续全对3次毕业、毕业后不再追加
 *  - 复习错题优先；紧急任务绕过题单；选课文/清空记录作废题单
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { unitList, unitFirstSeq, isPastMission } from '../public/js/unit-session.js';
import { buildMissions } from '../scripts/wordbank-lib.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.TEST_PORT) || 3211;
const BASE = `http://127.0.0.1:${PORT}`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'star-pinyin-unit-'));
for (const f of ['missions.json', 'textbook.json', 'badges.json']) {
  fs.copyFileSync(path.join(ROOT, 'data', f), path.join(tmp, f));
}
const freshProgress = { callsign: '测试指挥官', totalLaunches: 0, unlockedBadges: [], recentMissionIds: [], stats: {} };
fs.writeFileSync(path.join(tmp, 'progress.json'), JSON.stringify(freshProgress, null, 2));

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

async function waitReady() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('服务器未就绪');
}

const catalog = JSON.parse(fs.readFileSync(path.join(tmp, 'textbook.json'), 'utf8'));
const missions = JSON.parse(fs.readFileSync(path.join(tmp, 'missions.json'), 'utf8'));
const byId = new Map(missions.map((m) => [m.id, m]));
const U5_NEW = unitList(catalog, 1, 1).find((x) => x.unit === 5).newCount;

try {
  await waitReady();

  console.log('\n[1] 选择单元 → 生成固定题单');
  await test('POST /api/unit/select 一上第5单元 → 新字 + 5 复习', async () => {
    const { status, body } = await post('/api/unit/select', { grade: 1, term: 1, unit: 5 });
    eq(status, 200);
    eq(body.session.newCount, U5_NEW);
    eq(body.session.reviewCount, 5);
    eq(body.session.total, U5_NEW + 5);
    eq(body.session.cursor, 0);
    eq(body.session.label, '一年级上册 · 第5单元');
    eq(body.selection.seq, null); // 进度同步到该册
    const saved = readProgress();
    eq(saved.unitSession.queue.length, U5_NEW + 5);
    eq(saved.unitSession.queue.filter((x) => x.kind === 'new').length, U5_NEW);
  });
  await test('非法单元 / 年级 → 422', async () => {
    eq((await post('/api/unit/select', { grade: 1, term: 1, unit: 99 })).status, 422);
    eq((await post('/api/unit/select', { grade: 9, term: 1, unit: 1 })).status, 422);
    eq((await post('/api/unit/select', { grade: 1, term: 3, unit: 1 })).status, 422);
  });
  await test('GET /api/profile 携带 unitSession', async () => {
    const { body } = await get('/api/profile');
    eq(body.unitSession.unit, 5); eq(body.unitSession.total, U5_NEW + 5);
  });

  console.log('\n[2] 沿题单逐题发射');
  let firstId;
  await test('next 返回题单第1题（kind=new，cursor 0）', async () => {
    const { status, body } = await get('/api/missions/next?mode=all');
    eq(status, 200);
    firstId = body.id;
    eq(body.unitSession.kind, 'new');
    eq(body.unitSession.cursor, 0);
    eq(body.unitSession.total, U5_NEW + 5);
    eq(body.id, readProgress().unitSession.queue[0].missionId);
  });
  await test('全对上报 → cursor 前进、不入错题池', async () => {
    const { body } = await record(firstId, 0, 0);
    eq(body.unitSession.cursor, 1);
    eq(body.unitSession.done, false);
    eq(body.wrongPool.wrong, false);
    eq(readProgress().stats[firstId].wrong, false);
  });

  console.log('\n[3] 错题入池 + 队尾重复 + 连续全对3次毕业');
  let errId;
  await test('第2题出错 → 入池(fixes 0)、队尾追加 repeat', async () => {
    const { body: next } = await get('/api/missions/next?mode=all');
    errId = next.id;
    const before = readProgress().unitSession.queue.length;
    const { body } = await record(errId, 2, 0);
    eq(body.wrongPool.wrong, true); eq(body.wrongPool.fixes, 0);
    eq(body.unitSession.kind, 'new');
    const q = readProgress().unitSession.queue;
    eq(q.length, before + 1);
    eq(q[q.length - 1].missionId, errId);
    eq(q[q.length - 1].kind, 'repeat');
  });
  await test('错题重复出现：每次全对修正+1并再追加，满3次毕业不再追加', async () => {
    // 把游标移到队尾的 repeat 项，逐次「重练 → 全对」，验证 3 次毕业
    for (let fix = 1; fix <= 3; fix++) {
      const p = readProgress();
      p.unitSession.cursor = p.unitSession.queue.length - 1; // 指向最新 repeat
      writeProgress(p);
      const { body: next } = await get('/api/missions/next?mode=all');
      eq(next.id, errId); eq(next.unitSession.kind, 'repeat');
      const lenBefore = readProgress().unitSession.queue.length;
      const { body } = await record(errId, 0, 0);
      eq(body.wrongPool.fixes, fix);
      const q = readProgress().unitSession.queue;
      if (fix < 3) {
        eq(body.wrongPool.wrong, true);
        eq(q.length, lenBefore + 1); // 未毕业 → 继续追加重复
        eq(q[q.length - 1].missionId, errId);
      } else {
        eq(body.wrongPool.wrong, false); // 第3次毕业
        eq(q.length, lenBefore);         // 毕业 → 不再追加
        eq(body.unitSession.done, true);
      }
    }
    eq(readProgress().stats[errId].wrong, false);
    eq(readProgress().stats[errId].fixes, 3);
  });
  await test('中途再错 → 连续计数清零、重新入池', async () => {
    const { body } = await record(errId, 1, 0); // 毕业后又错（非当前项，仅更新错题池）
    eq(body.wrongPool.wrong, true); eq(body.wrongPool.fixes, 0);
  });

  console.log('\n[4] 完成后重抽 / 恢复进度');
  await test('题单已完成 → next 重新生成新题单（cursor 归零）', async () => {
    const { body } = await get('/api/missions/next?mode=all');
    eq(body.unitSession.cursor, 0);
    eq(body.unitSession.total, U5_NEW + 5);
    eq(readProgress().unitSession.cursor, 0);
  });
  await test('未完成时再选同一单元 → 恢复进度（不重抽）', async () => {
    await record(readProgress().unitSession.queue[0].missionId, 0, 0); // cursor → 1
    const { body } = await post('/api/unit/select', { grade: 1, term: 1, unit: 5 });
    eq(body.session.cursor, 1); // 恢复，而非归零
  });

  console.log('\n[5] 复习错题优先');
  await test('错题池中的过往字优先占复习名额', async () => {
    const first = unitFirstSeq(catalog, 1, 1, 5);
    const past = missions.filter((m) => m.textbook && isPastMission(m, 1, 1, first));
    const wrongIds = [past[0].id, past[1].id];
    const p = readProgress();
    p.stats = p.stats || {};
    for (const id of wrongIds) p.stats[id] = { attempts: 1, errors: 1, weight: 2, wrong: true, fixes: 0 };
    p.unitSession = null; // 作废当前题单，重新选择以触发重抽
    writeProgress(p);
    const { body } = await post('/api/unit/select', { grade: 1, term: 1, unit: 5 });
    eq(body.session.reviewCount, 5);
    const review = readProgress().unitSession.queue.filter((x) => x.kind === 'review').map((x) => x.missionId);
    for (const id of wrongIds) ok(review.slice(0, 2).includes(id), `错题 ${id} 未优先进复习`);
  });

  console.log('\n[6] 退出单元模式 / 紧急任务绕过 / 清空');
  await test('紧急任务模式绕过题单（直取注入题）', async () => {
    const { missions: [inj] } = buildMissions([{ hanzi: '鑫', word: '鑫鑫', pinyin: 'xīn', hint: '测试注入字' }], 9001);
    eq((await post('/api/admin/missions', { ...inj, id: 'm_p_unit1' })).status, 201);
    const { body } = await get('/api/missions/next?mode=emergency');
    eq(body.hanzi, '鑫');
    eq(body.unitSession, undefined);
  });
  await test('选具体课文 → 作废单元题单', async () => {
    eq((await post('/api/textbook/select', { grade: 1, term: 1, seq: 2 })).status, 200);
    eq(readProgress().unitSession, undefined);
    const { body } = await get('/api/profile');
    eq(body.unitSession, null);
    const { body: m } = await get('/api/missions/next?mode=all');
    eq(m.unitSession, undefined); // 退回常规加权抽题
  });
  await test('清空学习记录 → 单元题单随之清空', async () => {
    await post('/api/unit/select', { grade: 1, term: 1, unit: 5 });
    ok(readProgress().unitSession);
    eq((await post('/api/admin/progress/reset', {})).status, 200);
    eq(readProgress().unitSession, undefined);
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