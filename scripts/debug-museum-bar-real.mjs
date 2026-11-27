/**
 * debug-museum-bar-real.mjs — 真实档案（不拦截 /api/profile）博物馆课时进度条截图。
 * 复用 3000 端口服务（只读）。产出：.ui-shots/rewards-museum-real.png
 * 验收：已完成课时 > 0 时进度条非空白（宽度 = round(min(1, done/26)*100)%）。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const CHROME = 'C:\\Users\\panft\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9264;
const OUT = 'C:\\Codes\\star-pinyin\\.ui-shots';
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=' + PORT, '--window-size=820,1180', '--autoplay-policy=no-user-gesture-required',
  '--user-data-dir=C:\\Codes\\star-pinyin\\.chrome-debugStatBars', 'http://127.0.0.1:3000/'], { stdio: 'ignore', detached: true });

async function getTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const p = l.find((t) => t.type === 'page' && t.url.includes('127.0.0.1:3000'));
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
  if (r.result?.exceptionDetails) errors.push('EVAL ' + (r.result.exceptionDetails.exception?.description || JSON.stringify(r.result.exceptionDetails)));
  return r.result?.result?.value;
}
const check = (name, cond) => { console.log((cond ? '  ✓ ' : '  ✗ ') + name); if (!cond) errors.push('check failed: ' + name); };

await send('Runtime.enable'); await send('Page.enable');
await sleep(900);
await ev(`window.__audio && Object.assign(window.__audio, { speakText(){}, slowSplit(){}, speakPinyin(){} })`);
await ev(`document.getElementById('enterBtn').click()`); await sleep(800);
await ev(`document.getElementById('museumBtn').click()`); await sleep(700);

const info = await ev(`(() => {
  const bar = document.querySelector('.reward-bar');
  const fill = bar?.querySelector('i');
  const cs = fill ? getComputedStyle(fill) : null;
  return {
    progress: document.querySelector('.reward-progress')?.textContent.replace(/\\s+/g, ' ') || '',
    width: fill?.style.width || '',
    fillPx: fill ? Math.round(fill.getBoundingClientRect().width) : 0,
    barPx: bar ? Math.round(bar.getBoundingClientRect().width) : 0,
    fillBg: cs?.backgroundImage !== 'none' ? cs?.backgroundImage : cs?.backgroundColor,
    aria: bar?.getAttribute('aria-label'),
  };
})()`);
console.log('真实档案博物馆进度条：', JSON.stringify(info, null, 2));
const done = Number((info.progress.match(/已完成课时(\d+)/) || [])[1] || 0);
const expect = Math.round(Math.min(1, done / 26) * 100) + '%';
check(`已完成 ${done} 课时 → 宽度 ${expect}（非空白）`, info.width === expect && (done === 0 || info.fillPx > 0));
check('填充有颜色/渐变（非透明）', !!info.fillBg && info.fillBg !== 'rgba(0, 0, 0, 0)');
check('aria-label 更新为目的地解锁进度', /星际目的地解锁进度/.test(info.aria || ''));
await ev(`document.querySelector('.museum-overlay').scrollTop = 0`); await sleep(300);
const r = await send('Page.captureScreenshot', { format: 'png' });
if (r.result?.data) { fs.writeFileSync(`${OUT}/rewards-museum-real.png`, Buffer.from(r.result.data, 'base64')); console.log('shot rewards-museum-real'); }
else errors.push('shot failed');

console.log('\nERRORS:', errors.length ? errors : 'none');
ws.close(); try { process.kill(-chrome.pid); } catch {} try { chrome.kill(); } catch {}
process.exit(errors.length ? 1 : 0);