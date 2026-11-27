/**
 * voice-source.test.mjs — 音节读音「真人库 / AI 双源并存可切换」服务端集成验收（零依赖）
 * 运行：node test/voice-source.test.mjs
 *
 * 在隔离的临时 DATA_DIR + VOICE_OUT_DIR 上启动真实 server.js + mock TTS，验证：
 *  - lib/ 真人录音与根目录 AI 录音并存，同一 URL 按 voice-source 配置解析生效源；
 *  - 全局默认切换 + 逐音节覆盖（null 恢复跟随默认）+ ?src= 强制 A/B 试听；
 *  - 首选源缺失时自动退回另一份（绝不留缺）；
 *  - 「重新生成」只写 AI 那份，lib/ 真人录音字节级不被触碰；
 *  - 切换来源后 ETag 变化（浏览器立刻听到新源）；
 *  - 非法参数 422。
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { collectSyllables, fileKey, encodeWav, parseWav } from '../scripts/syllable-voice-lib.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.TEST_PORT) || 3206;
const MOCK_PORT = Number(process.env.MOCK_PORT) || 3207;
const BASE = `http://127.0.0.1:${PORT}`;
const MOCK = `http://127.0.0.1:${MOCK_PORT}`;
const KEY = 'sk-test-source-123456';

/* ----------------------------- 三份可区分的 WAV ----------------------------- */
const RATE = 24000, DUR = 0.45;
const tone = (freq) => {
  const s = new Float32Array(Math.round(RATE * DUR));
  for (let i = 0; i < s.length; i++) {
    const t = i / RATE;
    s[i] = 0.6 * Math.sin(2 * Math.PI * freq * t) * Math.sin(Math.PI * t / DUR);
  }
  return encodeWav(s, RATE);
};
const LIB_WAV = tone(880);   // 真人源（lib/）
const TTS_WAV = tone(440);   // AI 源（根目录）
const MOCK_WAV = tone(660);  // mock TTS 重新生成产物

const mock = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/tts') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ output: { audio: { url: MOCK + '/a.wav' } } }));
    });
  } else if (req.method === 'GET' && req.url === '/a.wav') {
    res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': MOCK_WAV.length });
    res.end(MOCK_WAV);
  } else { res.writeHead(404); res.end(); }
});
await new Promise((r) => mock.listen(MOCK_PORT, '127.0.0.1', r));

/* ----------------------------- 隔离数据 ----------------------------- */
const realMissions = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'missions.json'), 'utf8'));
const missions = realMissions.slice(0, 40);
const syllables = collectSyllables(missions);
const allKeys = [...syllables.keys()].sort();
const kBoth = allKeys[0];    // 两份都有
const kLibOnly = allKeys[1]; // 只有真人
const kTtsOnly = allKeys[2]; // 只有 AI

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'star-pinyin-source-'));
const outDir = path.join(tmp, 'voice-out');
const libDir = path.join(outDir, 'lib');
fs.mkdirSync(libDir, { recursive: true });
fs.writeFileSync(path.join(tmp, 'missions.json'), JSON.stringify(missions, null, 2));
fs.writeFileSync(path.join(libDir, fileKey(kBoth) + '.wav'), LIB_WAV);
fs.writeFileSync(path.join(outDir, fileKey(kBoth) + '.wav'), TTS_WAV);
fs.writeFileSync(path.join(libDir, fileKey(kLibOnly) + '.wav'), LIB_WAV);
fs.writeFileSync(path.join(outDir, fileKey(kTtsOnly) + '.wav'), TTS_WAV);

const child = spawn(process.execPath, ['server.js'], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: tmp, VOICE_OUT_DIR: outDir,
    QWEN_TOKEN_PLAN_CN_API_KEY: '', TTS_API_KEY: '',
    TTS_CREDENTIALS_FILE: path.join(tmp, 'no-such-creds.yaml'), DSH_HOME: tmp,
  },
  stdio: 'ignore',
});
const cleanup = () => {
  try { child.kill(); } catch {}
  try { mock.close(); } catch {}
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
};
process.on('exit', cleanup);
const watchdog = setTimeout(() => { console.error('❌ 集成测试超时'); cleanup(); process.exit(1); }, 90000);

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
const bytes = async (p) => Buffer.from(await (await fetch(BASE + p)).arrayBuffer());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wavUrl = (k, src) => `/audio/voice/${fileKey(k)}.wav${src ? '?src=' + src : ''}`;

async function waitReady() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) return; } catch {}
    await sleep(250);
  }
  throw new Error('服务器未就绪');
}
async function waitRegen(timeoutMs = 30000) {
  const t0 = Date.now();
  for (;;) {
    const { body } = await get('/api/admin/voice/regenerate');
    if (!body.running) return body;
    if (Date.now() - t0 > timeoutMs) throw new Error('重新生成任务超时');
    await sleep(150);
  }
}

try {
  await waitReady();
  await post('/api/admin/tts-config', { url: MOCK + '/tts', key: KEY, model: 'mock', voice: 'mock' });

  console.log('\n[1] 默认真人源：同一 URL 播 lib/ 那份');
  await test('默认 default=lib，GET wav 返回真人字节', async () => {
    const { body } = await get('/api/admin/voice/source');
    eq(body.default, 'lib');
    eq(body.counts.lib, 2);
    eq(body.counts.tts, 2);
    ok((await bytes(wavUrl(kBoth))).equals(LIB_WAV));
  });
  await test('状态视图含双源信息（libKeys / ttsKeys / source）', async () => {
    const { body } = await get('/api/admin/voice/status');
    eq(body.files[kBoth], 'wav');
    ok(body.libKeys.includes(kBoth) && body.libKeys.includes(kLibOnly));
    ok(body.ttsKeys.includes(kBoth) && body.ttsKeys.includes(kTtsOnly));
    eq(body.source.default, 'lib');
  });

  console.log('\n[2] ?src= 强制 A/B 试听（不改配置）');
  await test('?src=tts 播 AI，?src=lib 播真人', async () => {
    ok((await bytes(wavUrl(kBoth, 'tts'))).equals(TTS_WAV));
    ok((await bytes(wavUrl(kBoth, 'lib'))).equals(LIB_WAV));
    const { body } = await get('/api/admin/voice/source');
    eq(body.default, 'lib');
    eq(Object.keys(body.keys).length, 0);
  });

  console.log('\n[3] 逐音节覆盖与恢复');
  await test('keys 覆盖为 tts 后，该音节播 AI，其余不受影响', async () => {
    const { status } = await post('/api/admin/voice/source', { keys: { [fileKey(kBoth)]: 'tts' } });
    eq(status, 200);
    ok((await bytes(wavUrl(kBoth))).equals(TTS_WAV));
    ok((await bytes(wavUrl(kLibOnly))).equals(LIB_WAV));
  });
  await test('keys=null 恢复跟随默认', async () => {
    await post('/api/admin/voice/source', { keys: { [fileKey(kBoth)]: null } });
    ok((await bytes(wavUrl(kBoth))).equals(LIB_WAV));
    const { body } = await get('/api/admin/voice/source');
    eq(Object.keys(body.keys).length, 0);
  });

  console.log('\n[4] 全局默认切换');
  await test('default=tts 后全部播 AI；切回 lib 恢复', async () => {
    await post('/api/admin/voice/source', { default: 'tts' });
    ok((await bytes(wavUrl(kBoth))).equals(TTS_WAV));
    await post('/api/admin/voice/source', { default: 'lib' });
    ok((await bytes(wavUrl(kBoth))).equals(LIB_WAV));
  });

  console.log('\n[5] 首选源缺失自动退回另一份');
  await test('default=tts 但只有真人 → 播真人；default=lib 但只有 AI → 播 AI', async () => {
    await post('/api/admin/voice/source', { default: 'tts' });
    ok((await bytes(wavUrl(kLibOnly))).equals(LIB_WAV));
    await post('/api/admin/voice/source', { default: 'lib' });
    ok((await bytes(wavUrl(kTtsOnly))).equals(TTS_WAV));
  });

  console.log('\n[6] 重新生成只动 AI，真人录音字节级不被触碰');
  await test('regenerate 后 lib/ 不变，AI 文件更新，默认仍播真人', async () => {
    const libFile = path.join(libDir, fileKey(kBoth) + '.wav');
    const before = fs.readFileSync(libFile);
    const { status } = await post('/api/admin/voice/regenerate', { keys: [kBoth] });
    eq(status, 202);
    const job = await waitRegen();
    eq(job.ok, 1);
    ok(fs.readFileSync(libFile).equals(before), 'lib/ 真人录音绝不能被覆盖');
    const aiAfter = fs.readFileSync(path.join(outDir, fileKey(kBoth) + '.wav'));
    ok(!aiAfter.equals(TTS_WAV), 'AI 文件应被重新生成更新');
    eq(parseWav(aiAfter).rate, RATE, '产物仍是 24kHz WAV（经归一化/裁剪后处理）');
    ok((await bytes(wavUrl(kBoth))).equals(LIB_WAV), '默认真人源不受重新生成影响');
    ok((await bytes(wavUrl(kBoth, 'tts'))).equals(aiAfter), 'A/B 试听 AI 拿到磁盘新产物');
  });

  console.log('\n[7] 切换来源后 ETag 变化（立刻听到新源）');
  await test('lib 与 tts 的 ETag 不同；旧 ETag 条件请求不再 304', async () => {
    const r1 = await fetch(BASE + wavUrl(kBoth));
    const etagLib = r1.headers.get('etag');
    await r1.arrayBuffer();
    await post('/api/admin/voice/source', { keys: { [fileKey(kBoth)]: 'tts' } });
    const r2 = await fetch(BASE + wavUrl(kBoth), { headers: { 'If-None-Match': etagLib } });
    eq(r2.status, 200);
    ok(r2.headers.get('etag') !== etagLib);
    await r2.arrayBuffer();
    await post('/api/admin/voice/source', { keys: { [fileKey(kBoth)]: null } });
  });

  console.log('\n[8] 参数校验');
  await test('非法 default / 未知音节 / 非法源值 → 422', async () => {
    eq((await post('/api/admin/voice/source', { default: 'bogus' })).status, 422);
    eq((await post('/api/admin/voice/source', { keys: { nope9: 'lib' } })).status, 422);
    eq((await post('/api/admin/voice/source', { keys: { [fileKey(kBoth)]: 'xxx' } })).status, 422);
    eq((await post('/api/admin/voice/source', { keys: ['lib'] })).status, 422);
  });
} catch (e) {
  fail++;
  failures.push(['运行', e]);
  console.error('❌ ' + e.message);
} finally {
  clearTimeout(watchdog);
  cleanup();
}

console.log(`\n双源切换测试结果: ${pass} 通过, ${fail} 失败`);
if (fail) {
  console.error('\n失败明细:');
  for (const [name, e] of failures) console.error(`  - ${name}: ${e.message}`);
  process.exit(1);
}