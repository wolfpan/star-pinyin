/**
 * debug-drag.mjs — 用无头 Chrome (CDP) 复现拖拽问题。临时诊断脚本。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const CHROME = 'C:\\Users\\panft\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9225;
const URL = 'http://127.0.0.1:3000/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=' + PORT, '--window-size=820,1180',
  '--user-data-dir=C:\\Codes\\star-pinyin\\.chrome-debug4', URL,
], { stdio: 'ignore', detached: true });

async function getTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page' && t.url.includes('127.0.0.1:3000'));
      if (page) return page;
    } catch {}
    await sleep(250);
  }
  throw new Error('no chrome target');
}

const target = await getTarget();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));

let idc = 0; const pending = new Map(); const errors = [];
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  if (msg.method === 'Runtime.exceptionThrown') errors.push(JSON.stringify(msg.params.exceptionDetails?.exception?.description || msg.params));
  if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') errors.push('console.error: ' + msg.params.args.map((a) => a.value || a.description).join(' '));
});
function send(method, params = {}) {
  const id = ++idc;
  return new Promise((resolve) => { pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
}
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) errors.push('EVAL: ' + JSON.stringify(r.result.exceptionDetails));
  return r.result?.result?.value;
}
const mouse = (type, x, y) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 });

await send('Runtime.enable'); await send('Page.enable');
await sleep(800);

// 进入 → 领取任务 → 开始组装
await evaluate(`document.getElementById('enterBtn').click()`); await sleep(400);
await evaluate(`document.getElementById('launchBtn').click()`); await sleep(700);
await evaluate(`document.querySelector('#game .briefing .phys-btn.primary')?.click()`); await sleep(500);

const info = await evaluate(`(() => {
  const mods = [...document.querySelectorAll('.module')].map(m => {
    const r = m.getBoundingClientRect();
    return { group: m.dataset.group, value: m.dataset.value, cx: r.left + r.width/2, cy: r.top + r.height/2, w: r.width, h: r.height };
  });
  const slots = [...document.querySelectorAll('.slot')].map(s => {
    const hit = s.querySelector('.slot-hit'); const r = hit.getBoundingClientRect();
    return { id: s.dataset.slot, cx: r.left + r.width/2, cy: r.top + r.height/2, filled: s.classList.contains('is-filled') };
  });
  const rect = (sel) => { const e = document.querySelector(sel); if (!e) return null; const r = e.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top) }; };
  const boxes = { app: rect('#app'), game: rect('#game'), assembly: rect('.assembly'), stage: rect('.stage-area'), tray: rect('.tray-area'), svg: rect('.rocket-svg') };
  return { modCount: mods.length, mods, slots, boxes, gameHidden: document.getElementById('game').hidden };
})()`);
console.log('ASSEMBLY INFO:', JSON.stringify(info, null, 2));

const mission = await evaluate(`window.__currentMission`);
console.log('MISSION:', mission && mission.id, mission && mission.displayPinyin, mission && mission.type);

if (info && info.mods.length) {
  // 选「正确」的零件（优先 initial，其次 whole/final），拖到对应槽
  const groupOrder = ['initial', 'medial', 'final', 'whole'];
  let mod, slot;
  for (const g of groupOrder) {
    const correct = mission?.parts?.[g];
    const cand = info.mods.find((m) => m.group === g && m.value === correct);
    if (cand) { mod = cand; slot = info.slots.find((s) => s.id === g); break; }
  }
  if (!mod) { mod = info.mods[0]; slot = info.slots.find((s) => s.id === mod.group); }
  console.log(`DRAG module[${mod.group}=${mod.value}] from (${mod.cx.toFixed(0)},${mod.cy.toFixed(0)}) to slot[${slot.id}] (${slot.cx.toFixed(0)},${slot.cy.toFixed(0)})`);
  await mouse('mousePressed', mod.cx, mod.cy); await sleep(120);
  const steps = 8;
  for (let i = 1; i <= steps; i++) {
    const x = mod.cx + (slot.cx - mod.cx) * i / steps;
    const y = mod.cy + (slot.cy - mod.cy) * i / steps;
    await mouse('mouseMoved', x, y); await sleep(40);
  }
  const during = await evaluate(`(() => {
    const m = [...document.querySelectorAll('.module')].find(x => x.dataset.group === '${mod.group}' && x.dataset.value === '${mod.value}');
    const magnet = [...document.querySelectorAll('.slot.magnet')].map(s => s.dataset.slot);
    return { transform: m.style.transform, dragging: m.classList.contains('dragging'), magnet };
  })()`);
  console.log('DURING DRAG:', JSON.stringify(during));
  await mouse('mouseReleased', slot.cx, slot.cy); await sleep(500);
  const after = await evaluate(`(() => {
    const m = [...document.querySelectorAll('.module')].find(x => x.dataset.group === '${mod.group}' && x.dataset.value === '${mod.value}');
    const s = document.querySelector('.slot[data-slot="${slot.id}"]');
    return { transform: m.style.transform, visibility: m.style.visibility, locked: m.classList.contains('locked'), slotFilled: s.classList.contains('is-filled'), slotValue: s.querySelector('.slot-value').textContent };
  })()`);
  console.log('AFTER DROP:', JSON.stringify(after));
}

console.log('ERRORS:', errors.length ? errors : 'none');
ws.close();
try { process.kill(-chrome.pid); } catch {}
try { chrome.kill(); } catch {}
process.exit(0);
