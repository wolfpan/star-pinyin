/**
 * debug-ui-flat.mjs — 扁平化 UI 改版截图验收：逐屏截图 + 发射动画关键帧（含入轨文字间距）。
 * 临时诊断脚本：输出 PNG 到 .ui-shots/，并收集页面 JS 错误。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
const CHROME = 'C:\\Users\\panft\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9243;
const OUT = 'C:\\Codes\\star-pinyin\\.ui-shots';
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=' + PORT, '--window-size=820,1180', '--autoplay-policy=no-user-gesture-required',
  '--user-data-dir=C:\\Codes\\star-pinyin\\.chrome-debugUI2', 'http://127.0.0.1:3000/'], { stdio: 'ignore', detached: true });

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
const waitFor = async (sel, ms = 4000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await ev(`!!document.querySelector('${sel}')`)) return true; await sleep(120); } return false; };
const shot = async (name) => { const r = await send('Page.captureScreenshot', { format: 'png' }); if (r.result?.data) { fs.writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.result.data, 'base64')); console.log('shot', name); } else errors.push('shot failed: ' + name); };
const stubVoice = () => ev(`window.__audio && Object.assign(window.__audio, { speakText(){}, slowSplit(){}, speakPinyin(){} })`);

await send('Runtime.enable'); await send('Page.enable'); await sleep(900);
await stubVoice();
await shot('01-boot');
await ev(`document.getElementById('enterBtn').click()`); await sleep(600);
await shot('02-hangar');

function activeGroups(m) {
  if (m.type === 'whole_syllable') return ['whole'];
  if (m.type === 'zero_initial') return ['final'];
  if (m.type === 'two_part') return ['initial', 'final'];
  return ['initial', 'medial', 'final'];
}
async function assemble(id, { stopAtDots = false } = {}) {
  await ev(`window.__debugStart('${id}')`); await sleep(400);
  await ev(`document.querySelector('#game .briefing .phys-btn.primary')?.click()`); await sleep(400);
  const m = await ev(`window.__currentMission`);
  for (const g of activeGroups(m)) {
    const v = m.parts[g];
    const mc = await modCenter(g, v); const sc = await slotCenter(g);
    if (!mc || !sc) { errors.push(`assemble ${id}: missing module/slot ${g}=${v}`); return m; }
    await drag(mc.x, mc.y, sc.x, sc.y);
    if (m.specialRule === 'j_q_x_drop_dots' && g !== 'initial' && String(v).includes('ü')) {
      await waitFor('.dot-overlay', 2000);
      if (stopAtDots) return m;
      const d0 = await rect('.dot-btn:nth-child(1)'); const d1 = await rect('.dot-btn:nth-child(2)');
      if (d0) await tap(d0.x, d0.y); await sleep(150);
      if (d1) await tap(d1.x, d1.y); await sleep(650);
    }
  }
  return m;
}
async function clickTone(tone) {
  if (!await waitFor(`.curve-btn[data-tone="${tone}"]`, 3000)) { errors.push(`clickTone ${tone}: button missing`); return; }
  const b = await rect(`.curve-btn[data-tone="${tone}"]`);
  await tap(b.x, b.y);
}

/* ---- 用例 1：m_011 chuán 全流程 + 动画关键帧 ---- */
await ev(`window.__fxTimeScale = 1`);
let m = await assemble('m_011');
await shot('04b-assembly-complete'); // 组装完成横幅（950ms 后自动进声调）
await waitFor('.tone', 3000);
await shot('05-tone');
await clickTone(m.tone);
if (!await waitFor('.launch-canvas', 3000)) errors.push('no launch canvas');
const t0 = Date.now();
await sleep(Math.max(0, t0 + 2200 - Date.now())); await shot('06-launch-countdown');
await sleep(Math.max(0, t0 + 3700 - Date.now())); await shot('07-launch-ascent');
await sleep(Math.max(0, t0 + 6350 - Date.now())); await shot('08-launch-release');
await sleep(Math.max(0, t0 + 7150 - Date.now())); await shot('09-launch-orbit');
await waitFor('.reward', 4000); await sleep(300);
await shot('10-reward');

/* ---- 用例 2：简报 + 组装台 + 摘墨镜 ---- */
await ev(`window.__debugStart('m_033')`); await sleep(450);
await shot('03-briefing');
await ev(`document.querySelector('#game .briefing .phys-btn.primary')?.click()`); await sleep(450);
await shot('04-assembly');
m = await ev(`window.__currentMission`);
for (const g of activeGroups(m)) {
  const v = m.parts[g];
  const mc = await modCenter(g, v); const sc = await slotCenter(g);
  if (!mc || !sc) continue;
  await drag(mc.x, mc.y, sc.x, sc.y);
  if (m.specialRule === 'j_q_x_drop_dots' && g !== 'initial' && String(v).includes('ü')) {
    await waitFor('.dot-overlay', 2000);
    await shot('11-dots');
    const d0 = await rect('.dot-btn:nth-child(1)'); const d1 = await rect('.dot-btn:nth-child(2)');
    if (d0) await tap(d0.x, d0.y); await sleep(150);
    if (d1) await tap(d1.x, d1.y); await sleep(650);
  }
}
await waitFor('.tone', 3000);

/* ---- 博物馆 / 家长面板 ---- */
await send('Page.navigate', { url: 'http://127.0.0.1:3000/' }); await sleep(900);
await stubVoice();
await ev(`document.getElementById('enterBtn').click()`); await sleep(600);
await ev(`document.getElementById('museumBtn').click()`);
await waitFor('.museum-overlay', 3000); await sleep(500);
await shot('12-museum');
await send('Page.navigate', { url: 'http://127.0.0.1:3000/admin.html' }); await sleep(1200);
await shot('13-admin');

/* ---- 用例 3：矮屏（1024×768 横屏）入轨文字间距 ---- */
await send('Emulation.setDeviceMetricsOverride', { width: 1024, height: 768, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: 'http://127.0.0.1:3000/' }); await sleep(900);
await stubVoice();
await ev(`document.getElementById('enterBtn').click()`); await sleep(500);
await ev(`window.__fxTimeScale = 1`);
m = await assemble('m_007');
await waitFor('.tone', 3000);
await clickTone(m.tone);
if (!await waitFor('.launch-canvas', 3000)) errors.push('no launch canvas (short)');
const t1 = Date.now();
await sleep(Math.max(0, t1 + 7150 - Date.now())); await shot('14-launch-orbit-short');
await waitFor('.reward', 4000); await sleep(200);
await shot('15-reward-short');

console.log('ERRORS:', errors.length ? errors : 'none');
ws.close(); try { process.kill(-chrome.pid); } catch {} try { chrome.kill(); } catch {}
process.exit(0);