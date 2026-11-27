/**
 * verify-sky-blocks.mjs — 天空积木（daylight 皮肤）真实应用截图验收。
 * 用法：node scripts/verify-sky-blocks.mjs   （需先启动 node server.js，端口 3000）
 * 输出：.ui-shots/skyblocks-{hangar,briefing,assembly}.png
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
const CHROME = 'C:\\Users\\panft\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9254;
const OUT = 'C:\\Codes\\star-pinyin\\.ui-shots';
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=' + PORT, '--window-size=1024,768', '--autoplay-policy=no-user-gesture-required',
  '--user-data-dir=C:\\Codes\\star-pinyin\\.chrome-verifySky', 'http://127.0.0.1:3000/'], { stdio: 'ignore', detached: true });

async function getTarget() {
  for (let i = 0; i < 60; i++) {
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
const shot = async (name) => { const r = await send('Page.captureScreenshot', { format: 'png' }); if (r.result?.data) { fs.writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.result.data, 'base64')); console.log('shot', name); } else errors.push('shot failed: ' + name); };

await send('Runtime.enable'); await send('Page.enable'); await sleep(900);
await send('Emulation.setDeviceMetricsOverride', { width: 1024, height: 768, deviceScaleFactor: 1, mobile: false });
// 指定天空积木皮肤并重载（首帧脚本读 localStorage.sp_skin）
await ev(`localStorage.setItem('sp_skin', 'daylight')`);
await send('Page.reload'); await sleep(1200);
const skin = await ev(`document.documentElement.dataset.skin`);
console.log('skin =', skin);
if (skin !== 'daylight') errors.push('skin not daylight: ' + skin);
await ev(`window.__audio && Object.assign(window.__audio, { speakText(){}, slowSplit(){}, speakPinyin(){} })`);
// 档案里的 skin 会覆盖 localStorage（main.js），验收时拦截 /api/profile 指定 daylight
await ev(`(() => { const orig = window.fetch.bind(window); window.fetch = async (url, opts) => {
  const res = await orig(url, opts);
  if (String(url).startsWith('/api/profile')) {
    const p = await res.json(); p.skin = 'daylight';
    return new Response(JSON.stringify(p), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  return res; }; })()`);
await ev(`document.getElementById('enterBtn').click()`); await sleep(900);
const skin2 = await ev(`document.documentElement.dataset.skin`);
console.log('skin after enter =', skin2);
if (skin2 !== 'daylight') errors.push('skin after enter not daylight: ' + skin2);
await shot('skyblocks-hangar');
await ev(`document.getElementById('launchBtn').click()`); await sleep(1000);
await shot('skyblocks-briefing');
await ev(`document.querySelector('#game .briefing .phys-btn.primary')?.click()`); await sleep(900);
const asm = await ev(`!!document.querySelector('#game .assembly')`);
console.log('assembly rendered:', asm);
if (!asm) errors.push('assembly not rendered');
await shot('skyblocks-assembly');
console.log('ERRORS:', errors.length ? errors : 'none');
ws.close(); try { process.kill(-chrome.pid); } catch {} try { chrome.kill(); } catch {}
process.exit(0);