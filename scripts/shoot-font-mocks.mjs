/**
 * shoot-font-mocks.mjs — 无头 Chrome 渲染「火箭号指挥官」字体方案对比页，逐卡片截图。
 * 用法：node scripts/shoot-font-mocks.mjs
 * 输出：.ui-shots/font-{baseline,a,b,c}.png（976 宽 @2x）
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const CHROME = 'C:\\Users\\panft\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9269;
const OUT = 'C:\\Codes\\star-pinyin\\.ui-shots';
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=' + PORT, '--window-size=1024,2400', '--allow-file-access-from-files',
  '--user-data-dir=C:\\Codes\\star-pinyin\\.chrome-debugFonts', 'about:blank'], { stdio: 'ignore', detached: true });

async function getTarget() {
  for (let i = 0; i < 80; i++) {
    try {
      const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const p = l.find((t) => t.type === 'page');
      if (p) return p;
    } catch {}
    await sleep(250);
  }
  throw new Error('no target');
}
const ws = new WebSocket((await getTarget()).webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let idc = 0; const pending = new Map(); const errors = [];
ws.addEventListener('message', (evt) => {
  const m = JSON.parse(evt.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails?.exception?.description || 'exc');
});
const send = (method, params = {}) => new Promise((res) => { const id = ++idc; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
async function ev(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) errors.push('EVAL ' + (r.result.exceptionDetails.exception?.description || ''));
  return r.result?.result?.value;
}
await send('Runtime.enable'); await send('Page.enable');
await send('Page.navigate', { url: 'file:///C:/Codes/star-pinyin/design-mocks/font-mocks.html' });
await sleep(800);
await ev('document.fonts.ready.then(() => true)');
const loaded = await ev(`[...document.fonts].map(f => f.family + ':' + f.status).join(', ')`);
console.log('fonts:', loaded);

for (const key of ['baseline', 'a', 'b', 'c']) {
  const rect = await ev(`(() => { const r = document.getElementById('${key === 'baseline' ? 'baseline' : 'plan-' + key}').getBoundingClientRect();
    return { x: r.x, y: r.y + window.scrollY, width: r.width, height: r.height }; })()`);
  const r = await send('Page.captureScreenshot', { format: 'png', clip: { ...rect, scale: 2 } });
  if (r.result?.data) {
    fs.writeFileSync(`${OUT}/font-${key}.png`, Buffer.from(r.result.data, 'base64'));
    console.log(`font-${key}.png  (${Math.round(rect.width)}x${Math.round(rect.height)} @2x)`);
  } else errors.push('shot failed: ' + key);
}
console.log('ERRORS:', errors.length ? errors : 'none');
ws.close();
try { process.kill(-chrome.pid); } catch {}
try { chrome.kill(); } catch {}
process.exit(0);
