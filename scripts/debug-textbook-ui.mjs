/**
 * debug-textbook-ui.mjs — 课文同步面板 UI 验收：机库年级/学期/课文进度选择 + 简报课文来源。
 * 自包含：临时 DATA_DIR 副本上起服务（不碰真实玩家数据）+ 无头 Chrome CDP 截图到 .ui-shots/。
 * 运行：node scripts/debug-textbook-ui.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const CHROME = 'C:\\Users\\panft\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 3100;
const CDP = 9251;
const OUT = path.join(ROOT, '.ui-shots');
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 隔离数据副本 */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'star-pinyin-ui-'));
for (const f of ['missions.json', 'textbook.json', 'badges.json']) {
  fs.copyFileSync(path.join(ROOT, 'data', f), path.join(tmp, f));
}
fs.writeFileSync(path.join(tmp, 'progress.json'), JSON.stringify({
  callsign: '验收指挥官', totalLaunches: 6, unlockedBadges: [], recentMissionIds: [], stats: {},
}, null, 2));
const server = spawn(process.execPath, ['server.js'], {
  cwd: ROOT, env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: tmp }, stdio: 'ignore',
});
/* 端口被别的调试进程 / 开发服占着时，页面会是真实档案——绝不能在那种页面上点课文和发射。 */
let ownServer = false;
for (let i = 0; i < 60; i++) {
  try {
    const p = await (await fetch(`http://127.0.0.1:${PORT}/api/profile`)).json();
    ownServer = p.callsign === '验收指挥官';
    break;
  } catch { await sleep(250); }
}
if (!ownServer) {
  server.kill(); fs.rmSync(tmp, { recursive: true, force: true });
  console.error(`✗ 端口 ${PORT} 上的服务不是本次验收的临时档案，中止（避免改动真实进度）。`);
  process.exit(1);
}
/* 同一个 CDP 端口上若有别人的浏览器，脚本会驱动别人的页面：先探一次。 */
let cdpBusy = false;
try { await fetch(`http://127.0.0.1:${CDP}/json/version`); cdpBusy = true; } catch {}
if (cdpBusy) {
  server.kill(); fs.rmSync(tmp, { recursive: true, force: true });
  console.error(`✗ CDP 端口 ${CDP} 已被占用，先关掉那个调试浏览器再跑。`);
  process.exit(1);
}
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=' + CDP, '--window-size=820,1180', '--autoplay-policy=no-user-gesture-required',
  `--user-data-dir=${path.join(ROOT, '.chrome-debugTextbook')}`, `http://127.0.0.1:${PORT}/`], { stdio: 'ignore', detached: true });
const cleanup = () => {
  try { chrome.kill(); } catch {}
  try { server.kill(); } catch {}
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
};
process.on('exit', cleanup);
setTimeout(() => { console.error('超时'); cleanup(); process.exit(1); }, 120000);

async function getTarget() {
  for (let i = 0; i < 80; i++) {
    try {
      const l = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
      const p = l.find((t) => t.type === 'page' && t.url.includes(`127.0.0.1:${PORT}`));
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
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push('console.error ' + m.params.args.map((a) => a.value || a.description).join(' '));
});
const send = (method, params = {}) => new Promise((res) => { const id = ++idc; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
async function ev(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) errors.push('EVAL ' + (r.result.exceptionDetails.exception?.description || JSON.stringify(r.result.exceptionDetails)));
  return r.result?.result?.value;
}
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  if (r.result?.data) { fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(r.result.data, 'base64')); console.log('shot', name); }
  else errors.push('shot failed: ' + name);
};
const waitFor = async (sel, ms = 6000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await ev(`!!document.querySelector('${sel}')`)) return true; await sleep(120); } return false; };

await send('Runtime.enable'); await send('Page.enable'); await sleep(1200);
await ev(`window.__audio && Object.assign(window.__audio, { speakText(){}, slowSplit(){}, speakPinyin(){} })`);
await ev(`document.getElementById('enterBtn').click()`);
await waitFor('#tbGrades .tb-chip'); await sleep(700);

/* 1. 默认：自由巡航 */
await shot('textbook-hangar-all');

/* 2. 选一年级 → 上册课文进度展开 */
await ev(`[...document.querySelectorAll('#tbGrades .tb-chip')].find(b => b.textContent.includes('一年级'))?.click()`);
await sleep(600);
await shot('textbook-hangar-grade1');

/* 3. 学到第3课 */
await ev(`document.querySelector('#tbLessons .tb-lesson[data-seq="3"]')?.click()`);
await sleep(600);
await shot('textbook-hangar-lesson3');
const status1 = await ev(`document.getElementById('tbStatus').textContent`);
console.log('status:', status1);

/* 3b. 滑到末尾：全册（整册生字）是最后一格 */
await ev(`const b = document.getElementById('tbLessons'); b.scrollLeft = b.scrollWidth`);
await sleep(400);
await shot('textbook-hangar-all-last');
console.log('last chip:', await ev(`document.querySelector('#tbLessons .tb-lesson:last-child')?.dataset.seq`));

/* 4. 发射 → 简报不再显示课文来源 */
await ev(`document.getElementById('launchBtn').click()`);
await waitFor('.briefing'); await sleep(700);
await shot('textbook-briefing');
const src = await ev(`document.querySelector('.brief-source')?.textContent || '(无来源)'`);
console.log('brief-source:', src);

/* 5. 回机库 → 三年级下册（长课文列表横向滚动） */
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` }); await sleep(1200);
await ev(`window.__audio && Object.assign(window.__audio, { speakText(){}, slowSplit(){}, speakPinyin(){} })`);
await ev(`document.getElementById('enterBtn').click()`); await waitFor('#tbGrades .tb-chip'); await sleep(600);
await ev(`[...document.querySelectorAll('#tbGrades .tb-chip')].find(b => b.textContent.includes('三年级'))?.click()`);
await sleep(500);
await ev(`document.querySelector('#tbTerms .tb-chip[data-term="2"]')?.click()`);
await sleep(500);
await ev(`const b = document.querySelector('#tbLessons .tb-lesson[data-seq="5"]'); b?.click(); b?.scrollIntoView({inline:'center'})`);
await sleep(600);
await shot('textbook-hangar-grade3');
console.log('status:', await ev(`document.getElementById('tbStatus').textContent`));

console.log('ERRORS:', errors.length ? errors : 'none');
ws.close(); cleanup();
process.exit(errors.length ? 1 : 0);
