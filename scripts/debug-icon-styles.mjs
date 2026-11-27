/**
 * debug-icon-styles.mjs — 三套图标风格上线验收截图。
 * 用法：node scripts/debug-icon-styles.mjs [标签]
 * 输出：.ui-shots/<标签>-{a,b,c}-[hangar|museum|briefing].png 与 <标签>-admin-picker.png
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
const CHROME = 'C:\\Users\\panft\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9271;
const TAG = process.argv[2] || 'icons';
const OUT = 'C:\\Codes\\star-pinyin\\.ui-shots';
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=' + PORT, '--window-size=820,1180', '--autoplay-policy=no-user-gesture-required',
  '--user-data-dir=C:\\Codes\\star-pinyin\\.chrome-debugIcons', 'about:blank'], { stdio: 'ignore', detached: true });
async function getTarget() {
  for (let i = 0; i < 60; i++) {
    try { const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const p = l.find((t) => t.type === 'page'); if (p) return p; } catch {}
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
  if (r.result?.exceptionDetails) errors.push('EVAL ' + (r.result.exceptionDetails.exception?.description || '')); return r.result?.result?.value; }
const shot = async (name) => { const r = await send('Page.captureScreenshot', { format: 'png' }); if (r.result?.data) { fs.writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.result.data, 'base64')); console.log('shot', name); } else errors.push('shot failed ' + name); };
const goto = async (url) => { await send('Page.navigate', { url }); await sleep(1200); };
await send('Runtime.enable'); await send('Page.enable');

for (const style of ['a', 'b', 'c']) {
  // 孩子端以服务端档案为准（镜像皮肤），先写服务端再刷新
  await fetch('http://127.0.0.1:3000/api/iconstyle', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ iconStyle: style }) });
  await goto('http://127.0.0.1:3000/');
  await ev(`localStorage.setItem('sp_iconstyle','${style}');localStorage.setItem('sp_skin','nebula');location.reload();`);
  await sleep(1400);
  await ev(`window.__audio && Object.assign(window.__audio,{speakText(){},slowSplit(){},speakPinyin(){}})`);
  await ev(`document.getElementById('enterBtn').click()`); await sleep(900);
  await shot(`${TAG}-${style}-hangar`);
  await ev(`document.getElementById('museumBtn').click()`); await sleep(900);
  await shot(`${TAG}-${style}-museum`);
  await ev(`document.querySelector('.museum-overlay .phys-btn')?.click()`); await sleep(400);
  await ev(`document.getElementById('launchBtn').click()`); await sleep(1000);
  await shot(`${TAG}-${style}-briefing`);
}
// 后台选择器（恢复默认 a）
await fetch('http://127.0.0.1:3000/api/iconstyle', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ iconStyle: 'a' }) });
await goto('http://127.0.0.1:3000/admin.html');
await ev(`localStorage.setItem('sp_iconstyle','a');location.reload();`); await sleep(1200);
await ev(`document.querySelector('.admin-tab[data-page="ui"]')?.click()`); await sleep(300); // 面板已分页：图标风格在「界面」页
await ev(`document.getElementById('iconStylePicker').scrollIntoView({block:'center'})`); await sleep(400);
await shot(`${TAG}-admin-picker`);
console.log('ERRORS:', errors.length ? errors : 'none');
chrome.kill();
process.exit(0);
