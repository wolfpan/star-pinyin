/**
 * debug-voice-ui-shots.mjs — 「发音自检 · 重新生成」区块视觉验收截图。
 * ------------------------------------------------------------------
 * 隔离环境：临时 DATA_DIR（复制真实数据只读展示，不写回）+ 独立 headless Chrome。
 * 三套皮肤（hud / daylight / nebula）× 三档宽度（1280 / 768 / 390）逐块截图，
 * 输出 .ui-shots/voice-ui-{skin}-{width}.png，供整齐美观目检。
 *
 * 运行：node scripts/debug-voice-ui-shots.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const CHROME = 'C:\\Users\\panft\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 3102, CDP = 9282;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// CDP 端口被占用即快速失败：避免连到上次崩溃残留的 Chrome、截到旧页面
try {
  await fetch(`http://127.0.0.1:${CDP}/json/version`);
  throw new Error(`CDP 端口 ${CDP} 被占用（可能有残留 Chrome 进程），请先清理再跑`);
} catch (e) { if (String(e?.message).includes('被占用')) throw e; }

/* -------- 隔离数据 + 服务器 -------- */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'star-pinyin-voiceshots-'));
for (const f of ['missions.json', 'progress.json', 'badges.json', 'textbook.json', 'voice-flags.json', 'voice-overrides.json', 'voice-source.json']) {
  const src = path.join(ROOT, 'data', f);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(tmp, f));
}
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
  '--remote-debugging-port=' + CDP, '--window-size=1280,1600', '--autoplay-policy=no-user-gesture-required',
  '--user-data-dir=' + path.join(tmp, 'chrome'), `http://127.0.0.1:${PORT}/admin.html#voice`], { stdio: 'ignore', detached: true });
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
});
const send = (method, params = {}) => new Promise((res) => { const id = ++idc; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
async function ev(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) errors.push('EVAL ' + (r.result.exceptionDetails.exception?.description || ''));
  return r.result?.result?.value;
}

await send('Runtime.enable'); await send('Page.enable'); await sleep(1500);
// 家长校验自动作答（与 debug-voice-admin 同）
await ev(`(()=>{const map={一:'壹',二:'貳',三:'參',四:'肆',五:'伍',六:'陸',七:'柒',八:'捌',九:'玖',十:'拾'};const g=document.getElementById('adminGate');if(g&&!g.hidden){document.getElementById('gateInput').value=map[document.getElementById('gateChar').textContent]||'';document.getElementById('gateBtn').click();}})()`);
await sleep(600);

const shotDir = path.join(ROOT, '.ui-shots');
fs.mkdirSync(shotDir, { recursive: true });
const SKINS = ['hud', 'daylight', 'nebula'];
const WIDTHS = [1280, 768, 390];
for (const skin of SKINS) {
  // 直接改 html[data-skin]（boot 的服务端档案同步已完成，不会再覆盖）
  await ev(`document.documentElement.dataset.skin = '${skin}'`);
  for (const width of WIDTHS) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 1600, deviceScaleFactor: 1, mobile: width < 500 });
    await sleep(300);
    // 截取发音页前三块面板（读音来源 / TTS合成API设置 / 发音自检），验证独立分区布局
    const rect = await ev(`(()=>{const first=document.querySelector('#page-voice .page-body .panel');const last=document.querySelector('.voice-admin');const a=first.getBoundingClientRect();const b=last.getBoundingClientRect();return {x:a.x+window.scrollX,y:a.y+window.scrollY,width:a.width,height:b.bottom-a.top};})()`);
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: Math.max(0, rect.x - 8), y: Math.max(0, rect.y - 8), width: rect.width + 16, height: rect.height + 16, scale: 1 } });
    const name = `voice-ui-${skin}-${width}.png`;
    fs.writeFileSync(path.join(shotDir, name), Buffer.from(shot.result.data, 'base64'));
    console.log(`  截图 → .ui-shots/${name} (${Math.round(rect.width)}x${Math.round(rect.height)})`);
  }
}
console.log('ERRORS:', errors.length ? errors : 'none');
ws.close();
try { process.kill(-chrome.pid); } catch {} try { chrome.kill(); } catch {}
try { server.kill(); } catch {}
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
process.exit(errors.length ? 1 : 0);