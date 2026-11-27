/**
 * debug-assembly-orient.mjs — 组装台横竖屏自适应验收。
 * 竖屏（上火箭下托盘）/ iPad 横屏（左托盘右火箭）/ 手机横屏（矮屏收紧），
 * 并在横屏下真实拖拽装配，验证落点判定随布局实时生效。输出 PNG 到 .ui-shots/。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
const CHROME = 'C:\\Users\\panft\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9249;
const OUT = 'C:\\Codes\\star-pinyin\\.ui-shots';
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=' + PORT, '--window-size=820,1180', '--autoplay-policy=no-user-gesture-required',
  '--user-data-dir=C:\\Codes\\star-pinyin\\.chrome-debugOrient', 'http://127.0.0.1:3000/'], { stdio: 'ignore', detached: true });

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
const metrics = (width, height) => send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });

await send('Runtime.enable'); await send('Page.enable'); await sleep(1000);
await ev(`window.__audio && Object.assign(window.__audio, { speakText(){}, slowSplit(){}, speakPinyin(){} })`);
await ev(`document.getElementById('enterBtn').click()`); await sleep(600);

function activeGroups(m) {
  if (m.type === 'whole_syllable') return ['whole'];
  if (m.type === 'zero_initial') return ['final'];
  if (m.type === 'two_part') return ['initial', 'final'];
  return ['initial', 'medial', 'final'];
}
async function startAssembly(id) {
  await ev(`window.__debugStart('${id}')`); await sleep(400);
  await ev(`document.querySelector('#game .briefing .phys-btn.primary')?.click()`); await sleep(400);
  return ev(`window.__currentMission`);
}
async function assembleAll(m) {
  for (const g of activeGroups(m)) {
    const v = m.parts[g];
    const mc = await modCenter(g, v); const sc = await slotCenter(g);
    if (!mc || !sc) { errors.push(`missing module/slot ${g}=${v}`); continue; }
    await drag(mc.x, mc.y, sc.x, sc.y);
    if (m.specialRule === 'j_q_x_drop_dots' && g !== 'initial' && String(v).includes('ü')) {
      await waitFor('.dot-overlay', 2000);
      const d0 = await rect('.dot-btn:nth-child(1)'); const d1 = await rect('.dot-btn:nth-child(2)');
      if (d0) { await mouse('mousePressed', d0.x, d0.y); await mouse('mouseReleased', d0.x, d0.y); } await sleep(150);
      if (d1) { await mouse('mousePressed', d1.x, d1.y); await mouse('mouseReleased', d1.x, d1.y); } await sleep(650);
    }
  }
}
const filledCount = () => ev(`document.querySelectorAll('.slot.is-filled').length`);
const trayLeftOfStage = () => ev(`(() => { const t = document.querySelector('.tray-area').getBoundingClientRect(); const s = document.querySelector('.stage-area').getBoundingClientRect(); return t.right <= s.left + 1; })()`);

/* 竖屏：上火箭下托盘 */
await metrics(820, 1180);
let m = await startAssembly('m_011');
await shot('orient-assembly-portrait');
await assembleAll(m);
console.log('portrait filled slots:', await filledCount(), '(expect 3)');
await waitFor('.tone', 3000); // 等自动进声调，避免上一局定时器冲掉下一局组装台

/* iPad 横屏：左托盘右火箭 + 真实拖拽 */
await metrics(1180, 820); await sleep(400);
m = await startAssembly('m_011');
console.log('landscape tray left of stage:', await trayLeftOfStage(), '(expect true)');
await shot('orient-assembly-landscape');
await assembleAll(m);
console.log('landscape filled slots:', await filledCount(), '(expect 3)');
await shot('orient-assembly-landscape-filled');
await waitFor('.tone', 3000);

/* 手机横屏（矮屏）：三拼任务三行零件 */
await metrics(844, 390); await sleep(400);
m = await startAssembly('m_011');
console.log('phone-landscape tray left of stage:', await trayLeftOfStage(), '(expect true)');
await shot('orient-assembly-phone-landscape');
await assembleAll(m);
console.log('phone-landscape filled slots:', await filledCount(), '(expect 3)');

console.log('ERRORS:', errors.length ? errors : 'none');
ws.close(); try { process.kill(-chrome.pid); } catch {} try { chrome.kill(); } catch {}
process.exit(0);
