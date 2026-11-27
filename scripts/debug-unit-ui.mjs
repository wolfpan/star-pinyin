/**
 * debug-unit-ui.mjs — 单元完成规则 UI 验收：机库单元芯片行 + 选单元状态 + 发射简报。
 * 自包含：临时 DATA_DIR 副本上起服务（不碰真实玩家数据）+ 无头 Chrome CDP 截图到 .ui-shots/。
 * 运行：node scripts/debug-unit-ui.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const CHROME = 'C:\\Users\\panft\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 3102;
const CDP = 9253;
const OUT = path.join(ROOT, '.ui-shots');
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];
const check = (cond, msg) => { if (!cond) errors.push('ASSERT ' + msg); console.log((cond ? '  ✓ ' : '  ✗ ') + msg); };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'star-pinyin-unitui-'));
for (const f of ['missions.json', 'textbook.json', 'badges.json']) {
  fs.copyFileSync(path.join(ROOT, 'data', f), path.join(tmp, f));
}
fs.writeFileSync(path.join(tmp, 'progress.json'), JSON.stringify({
  callsign: '单元验收指挥官', totalLaunches: 0, unlockedBadges: [], recentMissionIds: [], stats: {},
}, null, 2));
const server = spawn(process.execPath, ['server.js'], {
  cwd: ROOT, env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: tmp }, stdio: 'ignore',
});
let ownServer = false;
for (let i = 0; i < 60; i++) {
  try { const p = await (await fetch(`http://127.0.0.1:${PORT}/api/profile`)).json(); ownServer = p.callsign === '单元验收指挥官'; break; }
  catch { await sleep(250); }
}
if (!ownServer) { server.kill(); fs.rmSync(tmp, { recursive: true, force: true }); console.error('✗ 端口服务非本次验收档案，中止'); process.exit(1); }
let cdpBusy = false;
try { await fetch(`http://127.0.0.1:${CDP}/json/version`); cdpBusy = true; } catch {}
if (cdpBusy) { server.kill(); fs.rmSync(tmp, { recursive: true, force: true }); console.error('✗ CDP 端口被占用'); process.exit(1); }
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=' + CDP, '--window-size=820,1180', '--autoplay-policy=no-user-gesture-required',
  `--user-data-dir=${path.join(ROOT, '.chrome-debugUnit')}`, `http://127.0.0.1:${PORT}/`], { stdio: 'ignore', detached: true });
const cleanup = () => { try { chrome.kill(); } catch {} try { server.kill(); } catch {} try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} };
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
let idc = 0; const pending = new Map();
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
await waitFor('#tbGrades .tb-chip'); await sleep(600);

console.log('\n[1] 选一年级上册 → 单元芯片行');
await ev(`[...document.querySelectorAll('#tbGrades .tb-chip')].find(b => b.textContent.includes('一年级'))?.click()`);
await waitFor('#tbUnits .tb-unit'); await sleep(600);
const unitCount = await ev(`document.querySelectorAll('#tbUnits .tb-unit').length`);
check(unitCount === 8, `一上渲染 8 个单元芯片（实际 ${unitCount}）`);
const unitLabels = await ev(`[...document.querySelectorAll('#tbUnits .tb-unit')].map(b => b.textContent).join(',')`);
check(unitLabels === '1单元,2单元,3单元,4单元,5单元,6单元,7单元,8单元', `单元标签正确（${unitLabels}）`);
await shot('unit-hangar-row');

console.log('\n[2] 点第5单元 → 固定题单状态');
await ev(`document.querySelector('#tbUnits .tb-unit[data-unit="5"]')?.click()`);
await sleep(700);
const status = await ev(`document.getElementById('tbStatus').textContent`);
console.log('  status:', status);
check(status.includes('第5单元') && status.includes('新字') && status.includes('复习'), '状态行显示单元 + 新字 + 复习');
const activeUnit = await ev(`document.querySelector('#tbUnits .tb-unit.active')?.dataset.unit`);
check(activeUnit === '5', `第5单元芯片高亮（实际 ${activeUnit}）`);
const lessonActive = await ev(`document.querySelectorAll('#tbLessons .tb-lesson.active').length`);
check(lessonActive === 0, '单元模式下课文芯片不高亮');
await shot('unit-hangar-selected');
const nextMeta = await ev(`fetch('/api/missions/next?mode=all').then(r => r.json()).then(m => ({ kind: m.unitSession?.kind, cursor: m.unitSession?.cursor, hanzi: m.hanzi }))`);
check(nextMeta.kind === 'new' && nextMeta.cursor === 0, `next 沿题单出第1新字（${JSON.stringify(nextMeta)}）`);

console.log('\n[3] 发射 → 简报来源为本单元第一课');
await ev(`document.getElementById('launchBtn').click()`);
await waitFor('.briefing'); await sleep(700);
const src = await ev(`document.querySelector('.brief-source')?.textContent || '(无来源)'`);
console.log('  brief-source:', src);
check(src.includes('秋天'), `简报来源含单元5第一课《秋天》（${src}）`);
await shot('unit-briefing');

console.log('\n[4] 回机库选具体课文 → 退出单元模式');
await ev(`document.querySelector('.briefing') && [...document.querySelectorAll('button')].find(b => b.textContent.includes('机库'))?.click()`);
await sleep(400);
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` }); await sleep(1200);
await ev(`window.__audio && Object.assign(window.__audio, { speakText(){}, slowSplit(){}, speakPinyin(){} })`);
await ev(`document.getElementById('enterBtn').click()`); await waitFor('#tbGrades .tb-chip'); await sleep(500);
await ev(`[...document.querySelectorAll('#tbGrades .tb-chip')].find(b => b.textContent.includes('一年级'))?.click()`);
await sleep(400);
await ev(`document.querySelector('#tbLessons .tb-lesson[data-seq="2"]')?.click()`);
await sleep(600);
const usAfter = await ev(`fetch('/api/profile').then(r => r.json()).then(p => p.unitSession)`);
check(usAfter === null, '选课文后单元题单作废（profile.unitSession=null）');

console.log('\nERRORS:', errors.length ? errors : 'none');
ws.close(); cleanup();
process.exit(errors.length ? 1 : 0);