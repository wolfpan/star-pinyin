/**
 * debug-launchfx.mjs — 发射动画选项「每单元仅首次」UI 验收（自包含，不碰真实玩家数据）。
 * 临时 DATA_DIR 副本上起服务 + 无头 Chrome CDP 真实拖拽组装 / 声调点击，验证：
 *  1) 家长后台「发射动画」面板点选 unit-first → 保存成功、档案同步；
 *  2) 同单元第一次发射：完整动画（.launch-canvas 出现）→ 结算；
 *  3) 同单元第二次发射：跳过动画（无 canvas）快速直达结算；
 *  4) 换一单元的第一次发射：动画恢复播放；
 *  5) 无单元归属词条（汉语拼音课）：每次都播放；
 *  6) 切回 always：同单元重复发射也播放动画。
 * 截图输出 .ui-shots/launchfx-*.png。运行：node scripts/debug-launchfx.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { unitKey } from '../public/js/textbook.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const CHROME = 'C:\\Users\\panft\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 3101;
const CDP = 9252;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = path.join(ROOT, '.ui-shots');
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 隔离数据副本：全新档案（无作答记录），发射动画选项由后台 UI 现场切换 */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'star-pinyin-launchfx-ui-'));
for (const f of ['missions.json', 'textbook.json', 'badges.json']) {
  fs.copyFileSync(path.join(ROOT, 'data', f), path.join(tmp, f));
}
fs.writeFileSync(path.join(tmp, 'progress.json'), JSON.stringify({
  callsign: '验收指挥官', totalLaunches: 0, unlockedBadges: [], recentMissionIds: [], stats: {},
}, null, 2));
const server = spawn(process.execPath, ['server.js'], {
  cwd: ROOT, env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: tmp }, stdio: 'ignore',
});

/* 用例取材：同一单元两个词条 / 另一单元一个 / 无单元归属一个 */
const missions = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'missions.json'), 'utf8'));
const byId = (a, b) => String(a.id).localeCompare(String(b.id));
const unitA = missions.filter((m) => unitKey(m.textbook) === '1-1-1').sort(byId);
const unitB = missions.filter((m) => unitKey(m.textbook) === '1-1-2').sort(byId);
const noUnit = missions.filter((m) => !m.isParentInjected && !unitKey(m.textbook)).sort(byId);
if (unitA.length < 2 || !unitB.length || !noUnit.length) throw new Error('词库里找不到可构造用例的词条');
const [A1, A2] = unitA;
const B1 = unitB[0];
const N1 = noUnit[0];
console.log(`用例: 单元A ${A1.id}(${A1.hanzi}) / ${A2.id}(${A2.hanzi}) · 单元B ${B1.id}(${B1.hanzi}) · 无单元 ${N1.id}(${N1.hanzi})`);

async function waitServer() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) return; } catch {}
    await sleep(250);
  }
  throw new Error('服务器未就绪');
}
await waitServer();

const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=' + CDP, '--window-size=820,1180', '--autoplay-policy=no-user-gesture-required',
  `--user-data-dir=${path.join(ROOT, '.chrome-debugLaunchFx')}`, `${BASE}/admin.html`], { stdio: 'ignore', detached: true });
const cleanup = () => {
  try { chrome.kill(); } catch {}
  try { server.kill(); } catch {}
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
};
process.on('exit', cleanup);
const watchdog = setTimeout(() => { console.error('❌ 验收超时'); cleanup(); process.exit(1); }, 180000);

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
const waitFor = async (sel, ms = 6000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await ev(`!!document.querySelector('${sel}')`)) return true; await sleep(80); } return false; };
const nav = async (url) => { await send('Page.navigate', { url }); await sleep(1200); };
const mouse = (type, x, y) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 });
async function tap(x, y) { await mouse('mousePressed', x, y); await sleep(25); await mouse('mouseReleased', x, y); }
async function drag(fx, fy, tx, ty) {
  await mouse('mousePressed', fx, fy); await sleep(80);
  for (let i = 1; i <= 6; i++) { await mouse('mouseMoved', fx + (tx - fx) * i / 6, fy + (ty - fy) * i / 6); await sleep(25); }
  await mouse('mouseReleased', tx, ty); await sleep(380);
}
const rect = (sel) => ev(`(() => { const e = document.querySelector('${sel}'); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2, left: r.left, top: r.top, w: r.width, h: r.height }; })()`);
const modCenter = (g, v) => ev(`(() => { const e = [...document.querySelectorAll('.module')].find(m => m.dataset.group === '${g}' && m.dataset.value === '${v}'); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 }; })()`);
const slotCenter = (id) => rect(`.slot[data-slot="${id}"] .slot-hit`);
const profile = () => ev(`(async()=>await (await fetch('/api/profile')).json())()`);
const setLaunchFx = (mode) => ev(`(async()=>{ const r = await fetch('/api/launchfx', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ launchFx:'${mode}' }) }); return r.status; })()`);

await send('Runtime.enable'); await send('Page.enable'); await sleep(1000);

/* ---------- 1. 家长后台：发射动画面板 ---------- */
console.log('\n[1] 家长后台「发射动画」面板');
const pickerExists = await ev(`!!document.getElementById('launchFxPicker')`);
console.log('面板存在 =', pickerExists);
if (!pickerExists) errors.push('admin: launchFxPicker 缺失');
await ev(`document.querySelector('.admin-tab[data-page="ui"]')?.click()`); await sleep(300); // 面板已分页：发射动画在「界面」页
await ev(`document.getElementById('launchFxPicker').scrollIntoView({ block: 'center' })`); await sleep(300);
await shot('launchfx-admin-always');
await ev(`document.querySelector('#launchFxPicker .skin-card[data-launchfx="unit-first"]').click()`);
await waitFor(`#launchFxPicker .skin-card[data-launchfx="unit-first"][aria-checked="true"]`, 4000);
await sleep(400);
const adminStatus = await ev(`document.getElementById('launchFxStatus').textContent`);
console.log('保存状态 =', adminStatus);
if (!String(adminStatus).includes('已保存')) errors.push('admin: 保存状态异常 ' + adminStatus);
const p0 = await profile();
console.log('档案 launchFx =', p0.launchFx, '（期望 unit-first）');
if (p0.launchFx !== 'unit-first') errors.push('admin: 档案未同步 unit-first');
await shot('launchfx-admin-unit-first');

/* ---------- 孩子端：真实组装 + 声调 ---------- */
await nav(BASE + '/');
await ev(`window.__audio && Object.assign(window.__audio, { speakText(){}, slowSplit(){}, speakPinyin(){} })`);
await ev(`document.getElementById('enterBtn').click()`); await sleep(600);
await ev(`window.__fxTimeScale = 12`); // 快进发射动画（与 debug-launch 一致）

function activeGroups(m) {
  if (m.type === 'whole_syllable') return ['whole'];
  if (m.type === 'zero_initial') return ['final'];
  if (m.type === 'two_part') return ['initial', 'final'];
  return ['initial', 'medial', 'final'];
}
async function assemble(id) {
  await ev(`window.__debugStart('${id}')`); await sleep(350);
  await ev(`document.querySelector('#game .briefing .phys-btn.primary')?.click()`); await sleep(350);
  const m = await ev(`window.__currentMission`);
  for (const g of activeGroups(m)) {
    const v = m.parts[g];
    const mc = await modCenter(g, v); const sc = await slotCenter(g);
    if (!mc || !sc) { errors.push(`assemble ${id}: missing module/slot ${g}=${v}`); return m; }
    await drag(mc.x, mc.y, sc.x, sc.y);
    if (m.specialRule === 'j_q_x_drop_dots' && g !== 'initial' && String(v).includes('ü')) {
      await waitFor('.dot-overlay', 2000);
      const d0 = await rect('.dot-btn:nth-child(1)'); const d1 = await rect('.dot-btn:nth-child(2)');
      if (d0) await tap(d0.x, d0.y); await sleep(150);
      if (d1) await tap(d1.x, d1.y); await sleep(650);
    }
  }
  if (!await waitFor('.tone', 3000)) errors.push(`assemble ${id}: no .tone`);
  return m;
}
/** 点声调 → 观察是否出现发射动画 canvas → 等结算。返回 {canvas, reward, ms}。 */
async function launchAndWatch(m, shotName) {
  const btn = await rect(`.curve-btn[data-tone="${m.tone}"]`);
  if (!btn) { errors.push(`launch ${m.id}: tone button missing`); return { canvas: false, reward: false, ms: -1 }; }
  const t0 = Date.now();
  await tap(btn.x, btn.y);
  let canvas = false, shotTaken = false;
  let reward = false;
  while (Date.now() - t0 < 8000) {
    if (!canvas && await ev(`!!document.querySelector('.launch-canvas')`)) {
      canvas = true;
      if (shotName && !shotTaken) { await shot(shotName); shotTaken = true; }
    }
    if (await ev(`!!document.querySelector('.reward')`)) {
      reward = true;
      if (shotName && !shotTaken) { await shot(shotName); shotTaken = true; } // 跳过路径：结算画面
      break;
    }
    await sleep(40);
  }
  const ms = Date.now() - t0;
  const canvasLeft = await ev(`document.querySelectorAll('.launch-canvas').length`);
  if (canvasLeft !== 0) errors.push(`launch ${m.id}: canvas 残留 ${canvasLeft}`);
  return { canvas, reward, ms };
}
const expect = (label, r, wantCanvas) => {
  const ok = r.reward && r.canvas === wantCanvas;
  console.log(`${ok ? '✓' : '✗'} ${label}: canvas=${r.canvas}（期望 ${wantCanvas}） reward=${r.reward} 耗时=${r.ms}ms`);
  if (!ok) errors.push(`${label}: ${JSON.stringify(r)} 期望 canvas=${wantCanvas}`);
};

/* ---------- 2. 单元 A 第一次发射：完整动画 ---------- */
console.log('\n[2] 单元 A 第一次发射（应播放动画）');
let m = await assemble(A1.id);
let r = await launchAndWatch(m, 'launchfx-first-launch');
expect(`单元A首次 ${A1.id}`, r, true);

/* ---------- 3. 单元 A 第二次发射：跳过动画 ---------- */
console.log('\n[3] 单元 A 第二次发射（应跳过动画）');
m = await assemble(A2.id);
r = await launchAndWatch(m, 'launchfx-skip-reward');
expect(`单元A后续 ${A2.id}`, r, false);
if (r.ms > 2500) errors.push(`跳过路径过慢: ${r.ms}ms`);

/* ---------- 4. 单元 B 第一次发射：动画恢复 ---------- */
console.log('\n[4] 单元 B 第一次发射（应播放动画）');
m = await assemble(B1.id);
r = await launchAndWatch(m);
expect(`单元B首次 ${B1.id}`, r, true);

/* ---------- 5. 无单元归属词条：每次都播放 ---------- */
console.log('\n[5] 无单元归属词条（应每次都播放）');
m = await assemble(N1.id);
r = await launchAndWatch(m);
expect(`无单元首次 ${N1.id}`, r, true);
m = await assemble(N1.id);
r = await launchAndWatch(m);
expect(`无单元重复 ${N1.id}`, r, true);

/* ---------- 6. 切回 always：同单元重复也播放 ---------- */
console.log('\n[6] 切回 always（同单元重复应播放）');
const st = await setLaunchFx('always');
console.log('POST /api/launchfx always →', st);
m = await assemble(A1.id);
r = await launchAndWatch(m);
expect(`always 重复 ${A1.id}`, r, true);

const p1 = await profile();
console.log('\n档案: launchFx =', p1.launchFx, '· launchedUnits =', JSON.stringify(p1.launchedUnits), '· totalLaunches =', p1.totalLaunches);
console.log('ERRORS:', errors.length ? errors : 'none');
clearTimeout(watchdog);
ws.close(); cleanup();
process.exit(errors.length ? 1 : 0);