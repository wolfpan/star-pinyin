/**
 * debug-dots.mjs — 无头 Chrome 验证 j/q/x+ü 摘墨镜全流程 + 三拼全装配。
 */
import { spawn } from 'node:child_process';
const CHROME = 'C:\\Users\\panft\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9232;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=' + PORT, '--window-size=820,1180',
  '--user-data-dir=C:\\Codes\\star-pinyin\\.chrome-debug11', 'http://127.0.0.1:3000/'], { stdio: 'ignore', detached: true });

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
  if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails?.exception?.description || 'exc'); });
const send = (method, params = {}) => new Promise((res) => { const id = ++idc; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
async function ev(expression) { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) errors.push('EVAL ' + JSON.stringify(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails)); return r.result?.result?.value; }
const mouse = (type, x, y) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 });
async function tap(x, y) { await mouse('mousePressed', x, y); await sleep(30); await mouse('mouseReleased', x, y); }
async function drag(fx, fy, tx, ty) {
  await mouse('mousePressed', fx, fy); await sleep(100);
  for (let i = 1; i <= 8; i++) { await mouse('mouseMoved', fx + (tx - fx) * i / 8, fy + (ty - fy) * i / 8); await sleep(30); }
  await mouse('mouseReleased', tx, ty); await sleep(450);
}
const center = (sel) => ev(`(() => { const e = document.querySelector('${sel}'); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 }; })()`);
const modCenter = (g, v) => ev(`(() => { const e = [...document.querySelectorAll('.module')].find(m => m.dataset.group === '${g}' && m.dataset.value === '${v}'); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 }; })()`);
const slotCenter = (id) => center(`.slot[data-slot="${id}"] .slot-hit`);
const slotValue = (id) => ev(`document.querySelector('.slot[data-slot="${id}"] .slot-value')?.textContent`);

await send('Runtime.enable'); await send('Page.enable'); await sleep(700);
await ev(`document.getElementById('enterBtn').click()`); await sleep(300);

async function startById(id) {
  await ev(`window.__debugStart('${id}')`); await sleep(400);
  await ev(`document.querySelector('#game .briefing .phys-btn.primary')?.click()`); await sleep(400);
}

// ---- 用例 1：xuě（x + üe）摘墨镜全流程 ----
await startById('m_033');
let m = await modCenter('initial', 'x'); let s = await slotCenter('initial');
await drag(m.x, m.y, s.x, s.y);
console.log('[xuě] 声母 x 锁定 →', await slotValue('initial'));
console.log('[xuě] screenLog =', JSON.stringify(await ev(`window.__screenLog`)), 'lastDrop =', JSON.stringify(await ev(`window.__lastDrop`)));
console.log('[xuě] SLOTS =', JSON.stringify(await ev(`[...document.querySelectorAll('.slot')].map(s => ({ id: s.dataset.slot, filled: s.classList.contains('is-filled'), locked: s.classList.contains('is-locked'), val: s.querySelector('.slot-value').textContent }))`)));
console.log('[xuě] completion exists =', await ev(`!!document.querySelector('.completion')`), 'banner =', await ev(`document.querySelector('.assembly-banner')?.textContent`));
console.log('[xuě] HANGAR STACK =', JSON.stringify(await ev(`window.__hangarStack`)));
console.log('[xuě] ALL MODULES =', JSON.stringify(await ev(`[...document.querySelectorAll('.module')].map(m => { const r = m.getBoundingClientRect(); return { g: m.dataset.group, v: m.dataset.value, vis: m.style.visibility, x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) }; })`)));
console.log('[xuě] game hidden =', await ev(`document.getElementById('game').hidden`), 'assembly exists =', await ev(`!!document.querySelector('.assembly')`));
m = await modCenter('final', 'üe'); s = await slotCenter('final');
console.log('[xuě] üe module center =', JSON.stringify(m), 'final slot center =', JSON.stringify(s));
await drag(m.x, m.y, s.x, s.y);
console.log('[xuě] __lastDrop =', JSON.stringify(await ev(`window.__lastDrop`)));
const overlay = await ev(`!!document.querySelector('.dot-overlay')`);
const dotCount = await ev(`document.querySelectorAll('.dot-btn').length`);
console.log('[xuě] 拖入 üe → 火花警报 overlay =', overlay, '圆点数 =', dotCount);
const d0 = await center('.dot-btn:nth-child(1)'); const d1 = await center('.dot-btn:nth-child(2)');
if (d0) await tap(d0.x, d0.y); await sleep(200);
if (d1) await tap(d1.x, d1.y); await sleep(800);
console.log('[xuě] 摘点后韵母槽 =', await slotValue('final'), '（期望 ue）');
console.log('[xuě] overlay 已关闭 =', await ev(`!document.querySelector('.dot-overlay')`));
await sleep(1300);
console.log('[xuě] 结算画面 =', await ev(`!!document.querySelector('.completion')`), '拼音 =', await ev(`document.querySelector('.completion-pinyin')?.textContent`));

// ---- 用例 2：chuán 三拼全装配 ----
await ev(`document.getElementById('backHangar')?.click()`); await sleep(300);
await startById('m_011');
for (const [g, v] of [['initial', 'ch'], ['medial', 'u'], ['final', 'an']]) {
  const mc = await modCenter(g, v); const sc = await slotCenter(g);
  await drag(mc.x, mc.y, sc.x, sc.y);
  console.log(`[chuán] ${g}=${v} →`, await slotValue(g));
}
await sleep(1300);
console.log('[chuán] 结算 =', await ev(`!!document.querySelector('.completion')`), '拼音 =', await ev(`document.querySelector('.completion-pinyin')?.textContent`));

console.log('ERRORS:', errors.length ? errors : 'none');
ws.close(); try { process.kill(-chrome.pid); } catch {} try { chrome.kill(); } catch {}
process.exit(0);
