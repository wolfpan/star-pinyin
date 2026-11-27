/**
 * preview-planets.mjs — 无头 Chrome 截取「星球画风样板」预览页（月球 / 金星）。
 * 用法：node scripts/preview-planets.mjs [url] [outPng]
 * 默认 url=http://127.0.0.1:3000/planet-preview.html，out=.ui-shots/planet-samples.png
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const CHROME = 'C:\\Users\\panft\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9251;
const URL = process.argv[2] || 'http://127.0.0.1:3000/planet-preview.html';
const OUT = process.argv[3] || path.join(ROOT, '.ui-shots', 'planet-samples.png');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--hide-scrollbars', '--force-device-scale-factor=2', '--remote-debugging-port=' + PORT,
  '--window-size=820,1180', '--user-data-dir=C:\\Codes\\star-pinyin\\.chrome-debugPlanets', URL],
  { stdio: 'ignore', detached: true });

async function getTarget() {
  for (let i = 0; i < 80; i++) {
    try {
      const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const p = l.find((t) => t.type === 'page' && t.url.includes('planet-preview'));
      if (p) return p;
    } catch {}
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
  if (r.result?.exceptionDetails) errors.push('EVAL ' + (r.result.exceptionDetails.exception?.description || 'err'));
  return r.result?.result?.value;
}

await send('Runtime.enable'); await send('Page.enable');
// 等待渲染就绪
for (let i = 0; i < 40; i++) { if (await ev('window.__ready === true')) break; await sleep(150); }
await ev('window.__render && window.__render()');
await sleep(400);

const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, Buffer.from(shot.result.data, 'base64'));
console.log('saved', OUT, (fs.statSync(OUT).size / 1024).toFixed(0) + 'KB');
console.log('ERRORS:', errors.length ? errors : 'none');
ws.close(); try { process.kill(-chrome.pid); } catch {} try { chrome.kill(); } catch {}
process.exit(errors.length ? 1 : 0);
