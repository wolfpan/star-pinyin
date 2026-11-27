/**
 * debug-launch.mjs — 无头 Chrome 验收 M3 全流程：组装→声调校准(点击/手势)→点火→结算→上报，
 * 并重复发射验证稳定性（canvas 清理、无异常）。临时诊断脚本。
 */
import { spawn } from 'node:child_process';
const CHROME = 'C:\\Users\\panft\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9242;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=' + PORT, '--window-size=820,1180',
  '--user-data-dir=C:\\Codes\\star-pinyin\\.chrome-debugL3', 'http://127.0.0.1:3000/'], { stdio: 'ignore', detached: true });

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

await send('Runtime.enable'); await send('Page.enable'); await sleep(700);
await ev(`document.getElementById('enterBtn').click()`); await sleep(300);
await ev(`window.__fxTimeScale = 12`); // 快进发射动画

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
  const toneOk = await waitFor('.tone', 3000);
  if (!toneOk) {
    errors.push(`assemble ${id}: no .tone; slots=${JSON.stringify(await ev(`[...document.querySelectorAll('.slot')].map(s=>({id:s.dataset.slot,f:s.classList.contains('is-filled')}))`))} gameHead=${await ev(`document.getElementById('game').innerHTML.slice(0,80)`)}`);
  }
  return m;
}
async function clickTone(tone) {
  if (!await waitFor(`.curve-btn[data-tone="${tone}"]`, 3000)) { errors.push(`clickTone ${tone}: button missing`); return; }
  const b = await rect(`.curve-btn[data-tone="${tone}"]`);
  await tap(b.x, b.y);
}
async function gestureTone(tone) {
  const p = await rect('.tone-pad');
  const L = p.left + 20, R = p.left + p.w - 20, T = p.top + 25, B = p.top + p.h - 25, M = p.top + p.h / 2;
  let pts;
  if (tone === 1) pts = [[L, M], [R, M]];
  else if (tone === 2) pts = [[L, B], [R, T]];
  else if (tone === 4) pts = [[L, T], [R, B]];
  else pts = [[L, T], [(L + R) / 2, B], [R, T + 10]]; // 3 v
  await mouse('mousePressed', pts[0][0], pts[0][1]); await sleep(60);
  for (let i = 1; i < pts.length; i++) {
    const [px, py] = pts[i - 1], [cx, cy] = pts[i];
    for (let j = 1; j <= 5; j++) { await mouse('mouseMoved', px + (cx - px) * j / 5, py + (cy - py) * j / 5); await sleep(20); }
  }
  const last = pts[pts.length - 1];
  await mouse('mouseReleased', last[0], last[1]);
}
async function waitReward() {
  await waitFor('.launch-canvas', 2000);
  const ok = await waitFor('.reward', 5000);
  const pinyin = await ev(`document.querySelector('.completion-pinyin')?.textContent`);
  const canvasLeft = await ev(`document.querySelectorAll('.launch-canvas').length`);
  return { ok, pinyin, canvasLeft };
}
const profileLaunches = () => ev(`(async()=>{const j=await (await fetch('/api/profile')).json();return j.totalLaunches;})()`);
const launchesBefore = await profileLaunches();

// 用例 1：点击校准 chuán（三拼 tone2）
let m = await assemble('m_011');
await clickTone(m.tone);
let r = await waitReward();
console.log('[点击校准 chuán]', JSON.stringify(r));

// 用例 2：手势校准 fān（两拼 tone1 水平）
m = await assemble('m_007');
await gestureTone(m.tone);
r = await waitReward();
console.log('[手势校准 fān tone1]', JSON.stringify(r));

// 用例 3：手势校准 雪 xuě（jqx tone3 v 形）
m = await assemble('m_033');
await gestureTone(m.tone);
r = await waitReward();
console.log('[手势校准 xuě tone3]', JSON.stringify(r));

// 用例 4：重复发射稳定性（5 局）
const ids = ['m_001', 'm_034', 'm_012', 'm_026', 'm_011'];
let stable = 0;
for (const id of ids) {
  const mm = await assemble(id);
  await clickTone(mm.tone);
  const rr = await waitReward();
  if (rr.ok && rr.canvasLeft === 0) stable++;
  else errors.push(`stability ${id}: ${JSON.stringify(rr)}`);
}
console.log(`[重复发射稳定性] ${stable}/${ids.length} 局结算且 canvas 已清理`);

const launchesAfter = await profileLaunches();
console.log(`[上报] totalLaunches ${launchesBefore} → ${launchesAfter}（应 +8）`);
console.log('ERRORS:', errors.length ? errors : 'none');
ws.close(); try { process.kill(-chrome.pid); } catch {} try { chrome.kill(); } catch {}
process.exit(0);
