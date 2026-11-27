/**
 * verify-destinations.mjs — 无头 Chrome 验收「等级=目的地」：机库/博物馆 UI + 逐目的地发射动画截图。
 * 复用 3000 端口服务。动画用 timeScale=4 快进，直接调 createLaunchFX 指定目的地（不改玩家进度）。
 * 产出：.ui-shots/ui-hangar.png / ui-museum.png / dest-<id>.png（抵达段）/ cruise-<id>.png（巡航段）。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const SHOTS = path.join(ROOT, '.ui-shots');
const CHROME = 'C:\\Users\\panft\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9255;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(SHOTS, { recursive: true });

const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--hide-scrollbars', '--force-device-scale-factor=2', '--remote-debugging-port=' + PORT,
  '--window-size=820,1180', '--user-data-dir=C:\\Codes\\star-pinyin\\.chrome-debugDest', 'http://127.0.0.1:3000/'],
  { stdio: 'ignore', detached: true });

async function getTarget() {
  for (let i = 0; i < 80; i++) {
    try { const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const p = l.find((t) => t.type === 'page' && t.url.includes('127.0.0.1:3000')); if (p) return p; } catch {}
    await sleep(250);
  } throw new Error('no target');
}
const ws = new WebSocket((await getTarget()).webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let idc = 0; const pending = new Map(); const errors = [];
ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails?.exception?.description || 'exc');
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push('console.error ' + m.params.args.map(a => a.value || a.description).join(' ')); });
const send = (method, params = {}) => new Promise((res) => { const id = ++idc; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
async function ev(expression) { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) errors.push('EVAL ' + (r.result.exceptionDetails.exception?.description || JSON.stringify(r.result.exceptionDetails))); return r.result?.result?.value; }
async function shot(name) { const s = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(SHOTS, name), Buffer.from(s.result.data, 'base64')); console.log('shot', name); }

await send('Runtime.enable'); await send('Page.enable'); await sleep(800);

// 机库 UI（目的地横幅 + 13 级按钮）
await ev(`document.getElementById('enterBtn').click()`); await sleep(600);
await shot('ui-hangar.png');
// 博物馆（星球图鉴）
await ev(`document.getElementById('museumBtn').click()`); await sleep(700);
await shot('ui-museum.png');
await ev(`document.querySelector('.museum-overlay .phys-btn')?.click()`); await sleep(300);

// 逐目的地发射动画（直接调 createLaunchFX，timeScale=4）
const IDS = ['earth_low', 'earth_high', 'earth_far', 'moon', 'venus', 'mars', 'mercury', 'jupiter', 'saturn', 'uranus', 'neptune', 'pluto', 'oort', 'interstellar'];
await ev(`window.__mod = (async () => { const fx = await import('/js/launch-fx.js'); const d = await import('/js/destinations.js'); return { createLaunchFX: fx.createLaunchFX, DESTINATIONS: d.DESTINATIONS }; })()`);
for (const id of IDS) {
  await ev(`(async () => {
    const { createLaunchFX, DESTINATIONS } = await window.__mod;
    document.getElementById('game').hidden = false;
    const box = document.createElement('div'); box.style.cssText = 'position:fixed;inset:0;z-index:99';
    document.body.append(box);
    window.__fx = createLaunchFX(box, { hanzi: '船', type: 'three_part', displayPinyin: 'chuán', timeScale: 4, rocketImage: null, destination: DESTINATIONS['${id}'], onEvent: () => {}, onDone: () => {} });
    window.__fxBox = box; window.__fx.start();
  })()`);
  // 3s 倒计时时间轴 ×timeScale4：升空 t5000→real1250；地球浮现 t7800→real1950；
  // 远离地球+目标出现 t9200→real2300；抵达 t11200→real2800；地球轨道入轨 t8000→real2000。
  if (id === 'moon') {
    await sleep(1250); await shot('ascent-moon.png');
    await sleep(550); await shot('cruise-moon.png');
    await sleep(700); await shot('dest-moon.png');
  } else if (id.startsWith('earth_')) {
    await sleep(2000); await shot(`dest-${id}.png`);
  } else {
    await sleep(2300); await shot(`cruise-${id}.png`);
    await sleep(500); await shot(`dest-${id}.png`);
  }
  await ev(`window.__fx.destroy(); window.__fxBox.remove();`);
  await sleep(200);
}
console.log('ERRORS:', errors.length ? errors : 'none');
ws.close(); try { process.kill(-chrome.pid); } catch {} try { chrome.kill(); } catch {}
process.exit(errors.length ? 1 : 0);
