/**
 * debug-skins.mjs — 三套皮肤 × 多视口 × 全流程截图验收
 * 用法：node scripts/debug-skins.mjs [skin...]（默认 hud daylight nebula）
 * 输出：.ui-shots/skin-<skin>-<宽x高>-<hangar|museum|briefing|assembly|tone|launch|completion>.png
 *       .ui-shots/skin-<skin>-admin.png
 * 流程：机库 → 博物馆 → 简报 → 组装（自动拖拽解题）→ 声调 → 发射倒计时 → 结算。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const CHROME = 'C:\\Users\\panft\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9268;
const OUT = 'C:\\Codes\\star-pinyin\\.ui-shots';
const SKINS = process.argv.slice(2).length ? process.argv.slice(2) : ['hud', 'daylight', 'nebula'];
const SIZES = [[1024, 768], [768, 1024]];
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=' + PORT, '--window-size=1024,768', '--autoplay-policy=no-user-gesture-required',
  '--user-data-dir=C:\\Codes\\star-pinyin\\.chrome-debugSkins', 'about:blank'], { stdio: 'ignore', detached: true });

async function getTarget() {
  for (let i = 0; i < 80; i++) {
    try {
      const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const p = l.find((t) => t.type === 'page');
      if (p) return p;
    } catch {}
    await sleep(250);
  }
  throw new Error('no target');
}
const ws = new WebSocket((await getTarget()).webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let idc = 0; const pending = new Map(); const errors = [];
ws.addEventListener('message', (evt) => {
  const m = JSON.parse(evt.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails?.exception?.description || 'exc');
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push('console.error ' + m.params.args.map((a) => a.value || a.description).join(' '));
});
const send = (method, params = {}) => new Promise((res) => { const id = ++idc; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
async function ev(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) errors.push('EVAL ' + (r.result.exceptionDetails.exception?.description || ''));
  return r.result?.result?.value;
}
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  if (r.result?.data) fs.writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.result.data, 'base64'));
  else errors.push('shot failed: ' + name);
};
const mouse = (type, x, y) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 });
async function tap(x, y) { await mouse('mousePressed', x, y); await sleep(25); await mouse('mouseReleased', x, y); }
async function drag(fx, fy, tx, ty) {
  await mouse('mousePressed', fx, fy); await sleep(80);
  for (let i = 1; i <= 6; i++) { await mouse('mouseMoved', fx + (tx - fx) * i / 6, fy + (ty - fy) * i / 6); await sleep(25); }
  await mouse('mouseReleased', tx, ty); await sleep(380);
}
const rect = (sel) => ev(`(() => { const e = document.querySelector('${sel}'); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
const modCenter = (g, v) => ev(`(() => { const e = [...document.querySelectorAll('.module')].find(m => m.dataset.group === '${g}' && m.dataset.value === '${v}'); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
const waitFor = async (sel, ms = 6000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await ev(`!!document.querySelector('${sel}')`)) return true; await sleep(120); } return false; };

await send('Runtime.enable'); await send('Page.enable');

for (const skin of SKINS) {
  // 服务端档案皮肤同步设置（孩子端 loadProfile 以服务端为准）
  await fetch('http://127.0.0.1:3000/api/skin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ skin }) });
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `try{localStorage.setItem('sp_skin','${skin}')}catch{}` });
  for (const [w, h] of SIZES) {
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: true, screenWidth: w, screenHeight: h });
    await send('Emulation.setTouchEmulationEnabled', { enabled: true });
    await send('Page.navigate', { url: 'http://127.0.0.1:3000/' });
    await sleep(1100);
    await ev(`window.__audio && Object.assign(window.__audio, { speakText(){}, slowSplit(){}, speakPinyin(){}, speak(){} })`);
    await ev(`document.getElementById('enterBtn').click()`);
    await sleep(900);
    const key = `skin-${skin}-${w}x${h}`;
    await shot(`${key}-hangar`);

    await ev(`document.getElementById('museumBtn').click()`);
    await sleep(800);
    await shot(`${key}-museum`);
    await ev(`(() => { const b = document.querySelector('.museum-head button'); b && b.click(); })()`);
    await sleep(300);

    await ev(`document.getElementById('launchBtn').click()`);
    await sleep(1300);
    await shot(`${key}-briefing`);
    await ev(`(() => { const b = document.querySelector('#game .briefing .phys-btn.primary'); b && b.click(); })()`);
    await sleep(1100);
    await shot(`${key}-assembly`);

    // 自动解题 → 声调 → 发射 → 结算
    const m = await ev(`window.__currentMission`);
    if (m) {
      for (const g of ['initial', 'medial', 'final']) {
        const v = m.parts?.[g];
        if (!v) continue;
        const mc = await modCenter(g, v); const sc = await rect(`.slot[data-slot="${g}"] .slot-hit`);
        if (mc && sc) await drag(mc.x, mc.y, sc.x, sc.y);
      }
      // j/q/x 去点交互：若出现摘墨镜遮罩，点掉两个圆点
      if (await ev(`!!document.querySelector('.dot-overlay')`)) {
        for (const d of await ev(`[...document.querySelectorAll('.dot-btn')].map(b => { const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })`)) {
          await tap(d.x, d.y); await sleep(200);
        }
      }
      if (await waitFor('.tone', 5000)) {
        await sleep(300);
        await shot(`${key}-tone`);
        const tb = await rect(`.curve-btn[data-tone="${m.tone}"]`);
        if (tb) await tap(tb.x, tb.y);
        await waitFor('.launch-canvas', 6000);
        await sleep(1200); // 倒计时段（发射场皮肤色）
        await shot(`${key}-launch`);
        if (await waitFor('.reward', 20000)) { await sleep(400); await shot(`${key}-completion`); }
        else errors.push(`${key}: no reward screen`);
      } else errors.push(`${key}: assembly not solved`);
    } else errors.push(`${key}: no mission`);
    console.log('done', key);
  }
  // 家长后台（桌面视口）
  await send('Emulation.setDeviceMetricsOverride', { width: 1024, height: 900, deviceScaleFactor: 2, mobile: false, screenWidth: 1024, screenHeight: 900 });
  await send('Page.navigate', { url: 'http://127.0.0.1:3000/admin.html' });
  await sleep(1200);
  await ev(`document.querySelector('.admin-tab[data-page="ui"]')?.click()`); await sleep(300); // 面板已分页：皮肤选择器在「界面」页
  await shot(`skin-${skin}-admin`);
  console.log('done admin', skin);
}
console.log('ERRORS:', errors.length ? errors : 'none');
ws.close();
try { process.kill(-chrome.pid); } catch {}
try { chrome.kill(); } catch {}
process.exit(0);