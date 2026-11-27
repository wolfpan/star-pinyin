/**
 * voice-admin-api.test.mjs — 家长端「发音自检 / 重新生成 / TTS合成API设置」服务端集成验收（零依赖）
 * 运行：node test/voice-admin-api.test.mjs
 *
 * 在隔离的临时 DATA_DIR + VOICE_OUT_DIR 上启动真实 server.js，并用本地 mock TTS
 * 服务冒充家长自填的 API（不碰真实玩家数据、不碰真实音频素材、不打真实外网接口），验证：
 *  - GET/POST /api/admin/tts-config：API/Key 自填落盘、接口只回显打码 Key、留空沿用旧 Key；
 *  - POST /api/admin/tts-config/test：用当前设置真实打一遍合成接口；
 *  - GET /api/admin/voice/status：全库音节 wav/mp3/tts 状态 + 标记；
 *  - POST /api/admin/voice/regenerate：按标记 / 显式 keys / 缺失 / 全部重新生成，
 *    产物与 scripts/gen-syllable-voice.mjs 同一内核（16-bit PCM WAV）；
 *  - 任务并发 409、进度查询、中途停止；
 *  - /api/tts 代理改用家长自填的 API 与 Key，且磁盘缓存命中；
 *  - 发音文件 HTTP 缓存语义：ETag/304、重新生成覆盖同 URL 后必须返回新字节
 *    （回归「重新生成后试听还是旧发音、刷新也没用」）。
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
const PORT = Number(process.env.TEST_PORT) || 3204;
const MOCK_PORT = Number(process.env.MOCK_PORT) || 3205;
const BASE = `http://127.0.0.1:${PORT}`;
const MOCK = `http://127.0.0.1:${MOCK_PORT}`;
const KEY = 'sk-test-abcdef123456';

/* ----------------------------- mock TTS 服务 ----------------------------- */
// 合成一段 0.45s 440Hz 正弦（带起音/收音包络），足够通过「时长 120~1200ms」校验。
const RATE = 24000, DUR = 0.45;
const samples = new Float32Array(Math.round(RATE * DUR));
for (let i = 0; i < samples.length; i++) {
  const t = i / RATE;
  samples[i] = 0.6 * Math.sin(2 * Math.PI * 440 * t) * Math.sin(Math.PI * t / DUR);
}
const WAV = encodeWav(samples, RATE);

let mockHits = [];
const mock = http.createServer((req, res) => {
  // OpenAI 兼容模型列表（「自动获取模型」用）
  if (req.method === 'GET' && req.url === '/v1/models') {
    if (req.headers.authorization !== 'Bearer ' + KEY) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Incorrect API key provided.' } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-model' }, { id: 'mock-tts-model' }, { id: 'mock-chat' }] }));
    return;
  }
  // 百炼「自建 / 复刻音色列表」（音色自动获取的另一来源）
  if (req.method === 'POST' && req.url === '/api/v1/services/audio/tts/customization') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.headers.authorization !== 'Bearer ' + KEY) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end('{}'); return; }
      mockHits.push({ kind: 'voices', body: JSON.parse(body) });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ output: { voice_list: [{ voice: 'mock-clone-1', prefix: '我的复刻', target_model: 'mock-model' }] } }));
    });
    return;
  }
  if (req.method === 'POST' && req.url === '/tts') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      mockHits.push({ auth: req.headers.authorization, body: JSON.parse(body) });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ output: { audio: { url: MOCK + '/a.wav' } } }));
    });
  } else if (req.method === 'GET' && req.url === '/a.wav') {
    res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': WAV.length });
    res.end(WAV);
  } else {
    res.writeHead(404); res.end();
  }
});
await new Promise((r) => mock.listen(MOCK_PORT, '127.0.0.1', r));

/* ----------------------------- 隔离数据 ----------------------------- */
const realMissions = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'missions.json'), 'utf8'));
const missions = realMissions.slice(0, 40); // 小词库足够覆盖全部逻辑，跑得快
const syllables = collectSyllables(missions);
const allKeys = [...syllables.keys()].sort();
const firstKey = allKeys[0];

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'star-pinyin-voice-'));
const outDir = path.join(tmp, 'voice-out');
fs.writeFileSync(path.join(tmp, 'missions.json'), JSON.stringify(missions, null, 2));

const child = spawn(process.execPath, ['server.js'], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: tmp, VOICE_OUT_DIR: outDir,
    // 屏蔽真实凭据，确保只走「家长自填」的 mock API
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitReady() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) return; } catch {}
    await sleep(250);
  }
  throw new Error('服务器未就绪');
}

/** 轮询重新生成任务直到结束。 */
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

  console.log('\n[1] TTS合成API设置：API / Key 自填');
  await test('默认未配置 Key，URL 为内置默认', async () => {
    const { status, body } = await get('/api/admin/tts-config');
    eq(status, 200);
    eq(body.hasKey, false);
    ok(body.url.includes('SpeechSynthesizer'));
  });
  await test('保存 mock API + Key 成功，接口只回显打码', async () => {
    const { status, body } = await post('/api/admin/tts-config', { url: MOCK + '/tts', key: KEY, model: 'mock-model', voice: 'mock-voice' });
    eq(status, 200);
    eq(body.ok, true);
    eq(body.hasKey, true);
    eq(body.keyFrom, 'admin');
    ok(body.keyHint.includes('****'));
    ok(!JSON.stringify(body).includes(KEY), '接口绝不能回传完整 Key');
    eq(body.url, MOCK + '/tts');
  });
  await test('Key 落盘服务端文件（不入库），GET 仍打码', async () => {
    const saved = JSON.parse(fs.readFileSync(path.join(tmp, 'tts-config.json'), 'utf8'));
    eq(saved.key, KEY);
    const { body } = await get('/api/admin/tts-config');
    ok(!JSON.stringify(body).includes(KEY));
    eq(body.model, 'mock-model');
    eq(body.voice, 'mock-voice');
  });
  await test('Key 留空 = 沿用已保存的', async () => {
    const { body } = await post('/api/admin/tts-config', { key: '' });
    eq(body.hasKey, true);
  });
  await test('非法 API 地址被拒绝', async () => {
    const { status } = await post('/api/admin/tts-config', { url: 'ftp://bad' });
    eq(status, 422);
  });

  console.log('\n[1b] 自动获取模型 / 音色（只读探测，不落盘）');
  await test('模型来自接口 /v1/models，语音模型标记为推荐', async () => {
    const { status, body } = await post('/api/admin/tts-config/discover', {
      url: MOCK + '/tts', key: KEY, model: 'mock-model', voice: 'mock-voice',
    });
    eq(status, 200);
    eq(body.ok, true);
    ok(body.models.some((m) => m.id === 'mock-tts-model' && m.recommended), '语音合成模型应标记推荐');
    ok(body.models.some((m) => m.id === 'mock-chat' && !m.recommended), '非语音模型不应推荐');
    eq(body.modelSource, 'api');
    eq(body.model, 'mock-model');
    ok(body.notes.join(' ').includes('/v1/models'), '应说明模型列表来自哪个地址');
  });
  await test('已知模型带出内置音色表；原音色仍可用则保留', async () => {
    const { body } = await post('/api/admin/tts-config/discover', {
      url: MOCK + '/tts', key: KEY, model: 'qwen-audio-3.0-tts-plus', voice: 'longanlingxin',
    });
    ok(body.voices.length >= 3);
    ok(body.voices.some((v) => v.id === 'longanhuan_v3.6' && v.model === 'qwen-audio-3.0-tts-plus'));
    eq(body.voice, 'longanlingxin');
  });
  await test('换模型后旧音色不可用 → 换成该模型默认音色并说明', async () => {
    const { body } = await post('/api/admin/tts-config/discover', {
      url: MOCK + '/tts', key: KEY, model: 'qwen-audio-3.0-tts-plus', voice: 'mock-voice',
    });
    eq(body.voice, 'longanhuan_v3.6');
    ok(body.notes.join(' ').includes('mock-voice'), '应说明换了音色');
  });
  await test('百炼地址额外合并自建 / 复刻音色', async () => {
    const { status, body } = await post('/api/admin/tts-config/discover', {
      url: MOCK + '/api/v1/services/audio/tts/SpeechSynthesizer', key: KEY, model: 'mock-model', voice: '',
    });
    eq(status, 200);
    ok(body.liveVoices.some((v) => v.id === 'mock-clone-1'), '应列出定制音色');
    ok(body.voices.some((v) => v.id === 'mock-clone-1'), '定制音色应并入可用音色');
  });
  await test('Key 不对 → 502 回显接口报错，绝不回显 Key', async () => {
    const { status, body } = await post('/api/admin/tts-config/discover', { url: MOCK + '/tts', key: 'sk-wrong-000111', model: 'mock-model' });
    eq(status, 502);
    eq(body.ok, false);
    ok(/Key 校验失败/.test(body.error));
    ok(!JSON.stringify(body).includes('sk-wrong-000111'));
  });
  await test('非法地址 422；自动获取不落盘', async () => {
    eq((await post('/api/admin/tts-config/discover', { url: 'ftp://bad', key: KEY })).status, 422);
    const before = fs.readFileSync(path.join(tmp, 'tts-config.json'), 'utf8');
    await post('/api/admin/tts-config/discover', { url: MOCK + '/tts', key: KEY, model: 'qwen-audio-3.0-tts-plus' });
    eq(fs.readFileSync(path.join(tmp, 'tts-config.json'), 'utf8'), before);
  });

  console.log('\n[2] 测试合成：真实打一遍自填接口');
  await test('test 合成成功，且用的是自填 API / Key / 模型', async () => {
    mockHits = [];
    const { status, body } = await post('/api/admin/tts-config/test');
    eq(status, 200);
    eq(body.ok, true);
    ok(body.bytes > 1000);
    eq(mockHits.length, 1);
    eq(mockHits[0].auth, 'Bearer ' + KEY);
    eq(mockHits[0].body.model, 'mock-model');
    eq(mockHits[0].body.input.voice, 'mock-voice');
    // 试读文本 = 测试成功 + 单韵母 a o e i u ü（同音字 啊噢鹅衣乌鱼）；音频随响应返回供家长端试播
    ok(mockHits[0].body.input.text.includes('测试成功') && mockHits[0].body.input.text.includes('鱼'));
    ok(typeof body.audio === 'string' && body.audio.length > 1000);
    eq(body.mime, 'audio/wav'); // mock 回 wav，按魔数识别容器
  });

  console.log('\n[3] 发音状态总览');
  await test('全部音节初始为 tts（无本地文件），无标记', async () => {
    const { status, body } = await get('/api/admin/voice/status');
    eq(status, 200);
    eq(Object.keys(body.files).length, allKeys.length);
    ok(allKeys.every((k) => body.files[k] === 'tts'));
    eq(body.flags.length, 0);
  });

  console.log('\n[4] 标记 → 重新生成标记音节');
  await test('标记落盘（与 voice-check 共用 /api/voice/flags）', async () => {
    const { status, body } = await post('/api/voice/flags', { keys: [firstKey] });
    eq(status, 200);
    eq(body.keys.length, 1);
  });
  await test('scope=flagged 只生成被标记的音节', async () => {
    const { status, body } = await post('/api/admin/voice/regenerate', { scope: 'flagged' });
    eq(status, 202);
    eq(body.total, 1);
    eq(body.keys[0], firstKey);
    const job = await waitRegen();
    eq(job.ok, 1);
    eq(job.fail, 0);
    eq(job.results[0].key, firstKey);
    ok(job.results[0].ok);
    const file = path.join(outDir, fileKey(firstKey) + '.wav');
    ok(fs.existsSync(file), '应产出 wav 文件');
    const { rate } = parseWav(fs.readFileSync(file));
    eq(rate, RATE);
    ok(job.results[0].durMs >= 120 && job.results[0].durMs <= 1200);
  });
  await test('状态总览里该音节变为 wav', async () => {
    const { body } = await get('/api/admin/voice/status');
    eq(body.files[firstKey], 'wav');
    eq(body.flags[0], firstKey);
  });

  console.log('\n[5] 参数校验与显式 keys');
  await test('未知音节 / 未知 scope 被拒绝', async () => {
    eq((await post('/api/admin/voice/regenerate', { keys: ['nope9'] })).status, 422);
    eq((await post('/api/admin/voice/regenerate', { scope: 'bogus' })).status, 422);
  });
  await test('显式 keys 重新生成（覆盖已有文件）', async () => {
    const { status, body } = await post('/api/admin/voice/regenerate', { keys: [firstKey] });
    eq(status, 202);
    eq(body.total, 1);
    const job = await waitRegen();
    eq(job.ok, 1);
  });

  console.log('\n[6] 全部重新生成：并发 409 / 进度 / 停止 / 补齐缺失');
  await test('scope=all 启动；运行中再启动 → 409', async () => {
    const { status, body } = await post('/api/admin/voice/regenerate', { scope: 'all' });
    eq(status, 202);
    eq(body.total, allKeys.length);
    const again = await post('/api/admin/voice/regenerate', { scope: 'all' });
    eq(again.status, 409);
  });
  await test('中途停止：cancelled=true 且未做完', async () => {
    const { status, body } = await post('/api/admin/voice/regenerate/stop');
    eq(status, 200);
    eq(body.cancelling, true);
    const job = await waitRegen();
    eq(job.cancelled, true);
    ok(job.done < job.total, `停止后应只做了一部分（done=${job.done}/${job.total}）`);
  });
  await test('scope=missing 补齐剩余音节，全部变为 wav', async () => {
    const { status, body } = await post('/api/admin/voice/regenerate', { scope: 'missing' });
    eq(status, 202);
    ok(body.total > 0);
    const job = await waitRegen(60000);
    eq(job.fail, 0);
    const { body: st } = await get('/api/admin/voice/status');
    ok(allKeys.every((k) => st.files[k] === 'wav'), '全部音节都应有本地 wav');
    for (const k of allKeys) ok(fs.existsSync(path.join(outDir, fileKey(k) + '.wav')));
  });

  console.log('\n[7] /api/tts 代理走自填 API + 磁盘缓存');
  await test('首次合成 miss，二次命中缓存', async () => {
    mockHits = [];
    const r1 = await fetch(BASE + '/api/tts?text=' + encodeURIComponent('测试'));
    eq(r1.status, 200);
    eq(r1.headers.get('x-voice-cache'), 'miss');
    ok((await r1.arrayBuffer()).byteLength > 1000);
    eq(mockHits.length, 1);
    eq(mockHits[0].auth, 'Bearer ' + KEY);
    const r2 = await fetch(BASE + '/api/tts?text=' + encodeURIComponent('测试'));
    eq(r2.headers.get('x-voice-cache'), 'hit');
    await r2.arrayBuffer();
    eq(mockHits.length, 1, '命中缓存不应再打接口');
    const h = await fetch(BASE + '/api/tts?text=' + encodeURIComponent('测试'), { method: 'HEAD' });
    eq(h.status, 200);
  });

  console.log('\n[8] 发音文件 HTTP 缓存：重新生成后必须听到新读音');
  const voiceUrl = '/audio/voice/' + fileKey(firstKey) + '.wav';
  const voiceFile = path.join(outDir, fileKey(firstKey) + '.wav');
  await test('静态 wav 带 ETag / Last-Modified / no-cache，条件请求回 304', async () => {
    const r1 = await fetch(BASE + voiceUrl);
    eq(r1.status, 200);
    eq(r1.headers.get('cache-control'), 'no-cache');
    const etag = r1.headers.get('etag');
    const lm = r1.headers.get('last-modified');
    ok(etag, '应有 ETag');
    ok(lm, '应有 Last-Modified');
    await r1.arrayBuffer();
    const r2 = await fetch(BASE + voiceUrl, { headers: { 'If-None-Match': etag } });
    eq(r2.status, 304, '文件未变 → 304');
    const r3 = await fetch(BASE + voiceUrl, { headers: { 'If-Modified-Since': lm } });
    eq(r3.status, 304, 'If-Modified-Since 未变 → 304');
  });
  await test('重新生成覆盖文件后 ETag 变化：旧 ETag 条件请求不再 304', async () => {
    const before = (await fetch(BASE + voiceUrl)).headers.get('etag');
    const { status } = await post('/api/admin/voice/regenerate', { keys: [firstKey] });
    eq(status, 202);
    const job = await waitRegen();
    eq(job.ok, 1);
    const r = await fetch(BASE + voiceUrl, { headers: { 'If-None-Match': before } });
    eq(r.status, 200, '文件已更新，浏览器必须拿到新内容而不是 304 旧缓存');
    await r.arrayBuffer();
  });
  await test('同 URL 覆盖为新音频：GET 立即返回新字节（试听不播旧缓存）', async () => {
    const old = fs.readFileSync(voiceFile);
    // 模拟重新生成落盘（与 runRegenJob 相同的 tmp+rename 原子写），内容换成 660Hz
    const s2 = new Float32Array(Math.round(RATE * DUR));
    for (let i = 0; i < s2.length; i++) {
      const t = i / RATE;
      s2[i] = 0.6 * Math.sin(2 * Math.PI * 660 * t) * Math.sin(Math.PI * t / DUR);
    }
    const newWav = encodeWav(s2, RATE);
    ok(!newWav.equals(old), '新旧音频应不同');
    fs.writeFileSync(voiceFile + '.tmp', newWav);
    fs.renameSync(voiceFile + '.tmp', voiceFile);
    const r = await fetch(BASE + voiceUrl);
    eq(r.status, 200);
    const bytes = Buffer.from(await r.arrayBuffer());
    ok(bytes.equals(newWav), '同一 URL 必须返回磁盘上最新的音频字节');
  });
  await test('/api/tts 不再让浏览器长缓存（no-cache，音色/设置变更即时生效）', async () => {
    const r = await fetch(BASE + '/api/tts?text=' + encodeURIComponent('缓存回归'));
    eq(r.status, 200);
    eq(r.headers.get('cache-control'), 'no-cache');
    await r.arrayBuffer();
    const etag = r.headers.get('etag');
    ok(etag);
    const r2 = await fetch(BASE + '/api/tts?text=' + encodeURIComponent('缓存回归'), { headers: { 'If-None-Match': etag } });
    eq(r2.status, 304, '命中磁盘缓存时条件请求可 304');
  });
} catch (e) {
  fail++;
  failures.push(['运行', e]);
  console.error('❌ ' + e.message);
} finally {
  clearTimeout(watchdog);
  cleanup();
}

console.log(`\n发音自检 / 重新生成 API 测试结果: ${pass} 通过, ${fail} 失败`);
if (fail) {
  console.error('\n失败明细:');
  for (const [name, e] of failures) console.error(`  - ${name}: ${e.message}`);
  process.exit(1);
}
