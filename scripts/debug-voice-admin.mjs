/**
 * debug-voice-admin.mjs — 家长端「发音」页（读音来源 / TTS合成API设置 / 发音自检 / 重新生成）UI 冒烟验收。
 * ------------------------------------------------------------------
 * 隔离环境：临时 DATA_DIR + VOICE_OUT_DIR + 本地 mock TTS（不碰真实数据/素材/外网）。
 * 用 headless Chrome + CDP 走一遍：填 API/Key → 保存 → 测试合成 → 标记 →
 * 重新生成标记 → 状态变 wav → 试听 → 依次自检/停止，并截图 .ui-shots/voice-admin.png。
 *
 * 运行：node scripts/debug-voice-admin.mjs
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeWav } from './syllable-voice-lib.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const CHROME = 'C:\\Users\\panft\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 3100, MOCK_PORT = 3101, CDP = 9281;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// CDP 端口被占用即快速失败：避免连到上次崩溃残留的 Chrome、验收旧页面
try {
  await fetch(`http://127.0.0.1:${CDP}/json/version`);
  throw new Error(`CDP 端口 ${CDP} 被占用（可能有残留 Chrome 进程），请先清理再跑`);
} catch (e) { if (String(e?.message).includes('被占用')) throw e; }

/* -------- mock TTS -------- */
const RATE = 24000, DUR = 0.45;
const samples = new Float32Array(Math.round(RATE * DUR));
for (let i = 0; i < samples.length; i++) {
  const t = i / RATE;
  samples[i] = 0.6 * Math.sin(2 * Math.PI * 440 * t) * Math.sin(Math.PI * t / DUR);
}
const WAV = encodeWav(samples, RATE);
const mock = http.createServer((req, res) => {
  // 模型列表（自动获取模型用）：OpenAI 兼容 GET /v1/models
  if (req.method === 'GET' && req.url === '/v1/models') {
    if (req.headers.authorization !== 'Bearer sk-ui-smoke-key-001') {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Incorrect API key provided.' } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-model' }] }));
  } else if (req.method === 'POST' && req.url === '/tts') {
    req.on('data', () => {});
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ output: { audio: { url: `http://127.0.0.1:${MOCK_PORT}/a.wav` } } }));
    });
  } else if (req.url === '/a.wav') {
    res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': WAV.length });
    res.end(WAV);
  } else { res.writeHead(404); res.end(); }
});
await new Promise((r) => mock.listen(MOCK_PORT, '127.0.0.1', r));

/* -------- 隔离数据 + 服务器 -------- */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'star-pinyin-voiceui-'));
for (const f of ['missions.json', 'progress.json', 'badges.json', 'textbook.json', 'voice-flags.json', 'voice-overrides.json']) {
  const src = path.join(ROOT, 'data', f);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(tmp, f));
}
// 清掉历史标记，冒烟从干净状态开始
fs.writeFileSync(path.join(tmp, 'voice-flags.json'), JSON.stringify({ updatedAt: null, keys: [] }));
const server = spawn(process.execPath, ['server.js'], {
  cwd: ROOT,
  env: {
    ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: tmp, VOICE_OUT_DIR: path.join(tmp, 'out'),
    QWEN_TOKEN_PLAN_CN_API_KEY: '', TTS_API_KEY: '', TTS_CREDENTIALS_FILE: path.join(tmp, 'none.yaml'), DSH_HOME: tmp,
  },
  stdio: 'ignore',
});
for (let i = 0; i < 60; i++) {
  try { if ((await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok) break; } catch {}
  await sleep(250);
}

/* -------- headless Chrome + CDP -------- */
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=' + CDP, '--window-size=900,1400', '--autoplay-policy=no-user-gesture-required',
  '--user-data-dir=' + path.join(tmp, 'chrome'), `http://127.0.0.1:${PORT}/admin.html`], { stdio: 'ignore', detached: true });
async function getTarget() {
  for (let i = 0; i < 60; i++) {
    try { const l = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json(); const p = l.find((t) => t.type === 'page'); if (p) return p; } catch {}
    await sleep(250);
  }
  throw new Error('no target');
}
const ws = new WebSocket((await getTarget()).webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let idc = 0; const pending = new Map(); const errors = [];
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails?.exception?.description || 'exc');
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push('console.error ' + m.params.args.map((a) => a.value || a.description).join(' '));
});
const send = (method, params = {}) => new Promise((res) => { const id = ++idc; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
async function ev(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) errors.push('EVAL ' + (r.result.exceptionDetails.exception?.description || '') + ' @ ' + expression.slice(0, 80));
  return r.result?.result?.value;
}
const click = (sel) => ev(`document.querySelector('${sel}')?.click()`);

await send('Runtime.enable'); await send('Page.enable'); await sleep(1500);
// 面板已分页：发音自检 / 词库表格在「发音」页（需繁体数字家长校验，冒烟自动作答）
await click('.admin-tab[data-page="voice"]'); await sleep(300);
await ev(`(()=>{const map={一:'壹',二:'貳',三:'參',四:'肆',五:'伍',六:'陸',七:'柒',八:'捌',九:'玖',十:'拾'};const g=document.getElementById('adminGate');if(g&&!g.hidden){document.getElementById('gateInput').value=map[document.getElementById('gateChar').textContent]||'';document.getElementById('gateBtn').click();}})()`);
await sleep(200);

let pass = 0, fail = 0;
const check = (name, cond) => { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name); } };

console.log('\n[1] 页面加载');
check('无 JS 报错', errors.length === 0);
check('发音状态总览已渲染', /音节 \d+/.test(await ev(`document.getElementById('voiceStatus').textContent`)));
check('表头 8 列（含读音来源 / 发音）', await ev(`document.querySelectorAll('.mission-table thead th').length`) === 8);
check('首行有 试听/标记/重生成', await ev(`document.querySelector('#missionBody tr .voice-cell')?.textContent || ''`).then((t) => t.includes('试听') && t.includes('标记') && t.includes('重生成')));
check('读音来源已单列渲染', await ev(`!!document.querySelector('#missionBody tr .src-cell .v-src')`));

console.log('\n[2] TTS合成API设置：自填 API / Key → 自动获取模型与音色');
await ev(`document.getElementById('ttsUrl').value='http://127.0.0.1:${MOCK_PORT}/tts'; document.getElementById('ttsKey').value='sk-ui-smoke-key-001';`);
await click('#ttsDiscoverBtn'); await sleep(900);
check('自动获取模型成功（下拉框出现 mock-model）', await ev(`[...document.querySelectorAll('#ttsModelSel option')].some(o=>o.value==='mock-model')`));
check('提示行显示已获取数量', /已获取 1 个模型/.test(await ev(`document.getElementById('ttsPickHint').textContent`)));
// 音色：mock 没提供音色列表 → 用「手动填写…」入口自填（同时验证手填链路）
await ev(`(()=>{const s=document.getElementById('ttsVoiceSel');s.value='__custom__';s.dispatchEvent(new Event('change'));document.getElementById('ttsVoice').value='mock-voice';})()`);
await click('#ttsSaveBtn'); await sleep(600);
check('保存成功提示', (await ev(`document.getElementById('ttsMsg').textContent`)).includes('已保存'));
check('Key 状态显示已保存', (await ev(`document.getElementById('ttsKeyState').textContent`)).includes('已保存'));
check('Key 输入框已清空（不回显）', await ev(`document.getElementById('ttsKey').value`) === '');
check('手填音色已落盘（下拉框保留 mock-voice）', await ev(`[...document.querySelectorAll('#ttsVoiceSel option')].some(o=>o.value==='mock-voice') && document.getElementById('ttsVoiceSel').value==='mock-voice'`));
// 试播验收：合成成功后必须真实播放返回音频（测试成功 + a o e i u ü）。
// 用可信鼠标点击（.click() 无用户手势，会自触 autoplay 拦截）；__forceBlock 模拟 Safari 式拦截验兜底按钮。
await ev(`(()=>{if(window.__playWrapped)return;window.__playWrapped=true;window.__medias=[];window.__playErr=[];window.__forceBlock=false;const op=HTMLMediaElement.prototype.play;HTMLMediaElement.prototype.play=function(...a){window.__medias.push(this);if(window.__forceBlock&&this.src.startsWith('blob:'))return Promise.reject(new DOMException('simulated autoplay block','NotAllowedError'));const p=op.apply(this,a);if(p&&p.catch)p.catch(e=>window.__playErr.push(String(e&&e.name||e)));return p;};})()`);
const clickTrusted = async (sel) => {
  const r = await ev(`(()=>{const el=document.querySelector('${sel}');if(!el)return null;el.scrollIntoView({block:'center'});const b=el.getBoundingClientRect();return {x:b.x+b.width/2,y:b.y+b.height/2};})()`);
  if (!r) throw new Error('selector not found: ' + sel);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.x, y: r.y, clickCount: 1, button: 'left', buttons: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r.x, y: r.y, clickCount: 1, button: 'left', buttons: 0 });
};
await clickTrusted('#ttsTestBtn'); await sleep(1500);
check('测试合成成功', (await ev(`document.getElementById('ttsMsg').textContent`)).includes('合成成功'));
check('成功后试播真实出声（media 已推进）', await ev(`window.__medias.some(m=>m.duration>0.2&&m.currentTime>0.05)`));
// 兜底链路：模拟自动播被拒 → 显形「播放试音」→ 手势点击后出声并收起按钮
await ev(`window.__forceBlock=true;`);
await clickTrusted('#ttsTestBtn'); await sleep(1200);
check('自动播被拒时显形播放试音按钮', await ev(`!!document.getElementById('ttsReplayBtn')`));
await ev(`window.__forceBlock=false;`);
await clickTrusted('#ttsReplayBtn'); await sleep(600);
check('兜底按钮手势内播放出声并收起', await ev(`!document.getElementById('ttsReplayWrap') && window.__medias.some(m=>m.duration>0.2&&m.currentTime>0.05)`));
// 旧服务端兼容：响应不带 audio 字段时走 /api/tts 兜底取音，仍须出声
await ev(`(()=>{const of=window.fetch;window.__origFetch=of;window.fetch=async(u,o)=>{const r=await of(u,o);if(String(u).includes('/tts-config/test')){const j=await r.json();delete j.audio;return new Response(JSON.stringify(j),{status:200,headers:{'Content-Type':'application/json'}});}return r;};})()`);
await clickTrusted('#ttsTestBtn'); await sleep(1800);
check('旧服务端（无 audio 字段）兜底取音仍出声', await ev(`(()=>{const m=window.__medias[window.__medias.length-1];return !!m&&m.duration>0.2&&m.currentTime>0.05;})()`));
await ev(`window.fetch=window.__origFetch;`);

console.log('\n[3] 标记 → 重新生成');
const firstPy = await ev(`document.querySelector('#missionBody tr .py')?.textContent`);
await ev(`document.querySelector('#missionBody tr .voice-cell .row-btn:nth-of-type(2)')?.click()`); // 标记
await sleep(600);
check('标记后计数 +1', (await ev(`document.getElementById('voiceStatus').textContent`)).includes('已标记 1'));
await click('#voiceRegenFlagged');
let done = false;
for (let i = 0; i < 30; i++) {
  await sleep(500);
  const t = await ev(`document.getElementById('regenProgress').textContent`);
  if (t.includes('生成完成')) { done = true; break; }
}
check('重新生成完成（' + firstPy + '）', done);
check('成功 1 · 失败 0', (await ev(`document.getElementById('regenProgress').textContent`)).includes('成功 1'));
await sleep(1600); // 等 loadVoiceStatus 刷新表格
check('该行状态点变 wav', await ev(`!!document.querySelector('#missionBody tr .v-dot.v-wav')`));
check('读音来源列显示 AI（隔离环境无真人库，回退 AI 份）', await ev(`document.querySelector('#missionBody tr .v-src')?.textContent`) === 'AI');

console.log('\n[4] 试听 / 依次自检 / 停止');
await ev(`document.querySelector('#missionBody tr .voice-cell .row-btn')?.click()`); // ▶ 试听
await sleep(800);
check('试听无报错', errors.length === 0);

// 缓存回归：媒体缓存会按 URL 复用旧音频（无视 no-cache、跨刷新仍在）。
// 修复后每次试听都 fetch(no-store) 回源——同一 wav 点两次必须产生两次网络请求。
const wavReqs = [];
ws.addEventListener('message', (ev2) => {
  const m = JSON.parse(ev2.data);
  if (m.method === 'Network.requestWillBeSent' && /\/audio\/voice\/[^/]+\.wav$/.test(m.params.request.url)) wavReqs.push(m.params.request.url);
});
await send('Network.enable');
await ev(`document.querySelector('#missionBody tr .voice-cell .row-btn')?.click()`);
await sleep(900);
await ev(`document.querySelector('#missionBody tr .voice-cell .row-btn')?.click()`);
await sleep(900);
check('同一音节试听两次均回源取新字节（不走媒体缓存）', wavReqs.length >= 2);

await click('#voicePlayAll'); await sleep(1200);
check('依次自检进行中', (await ev(`document.getElementById('voiceStatus').textContent`)).includes('正在播放'));
await click('#voiceStop'); await sleep(400);
check('停止后恢复总览', /音节 \d+/.test(await ev(`document.getElementById('voiceStatus').textContent`)));

console.log('\n[5] 截图');
await ev(`document.getElementById('page-voice').scrollIntoView()`);
await sleep(400);
const shot = await send('Page.captureScreenshot', { format: 'png' });
const shotDir = path.join(ROOT, '.ui-shots');
fs.mkdirSync(shotDir, { recursive: true });
fs.writeFileSync(path.join(shotDir, 'voice-admin.png'), Buffer.from(shot.result.data, 'base64'));
console.log('  截图 → .ui-shots/voice-admin.png');

console.log('ERRORS:', errors.length ? errors : 'none');
console.log(`\nUI 冒烟结果: ${pass} 通过, ${fail} 失败`);
ws.close();
try { process.kill(-chrome.pid); } catch {} try { chrome.kill(); } catch {}
try { server.kill(); } catch {} try { mock.close(); } catch {}
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
process.exit(fail || errors.length ? 1 : 0);
