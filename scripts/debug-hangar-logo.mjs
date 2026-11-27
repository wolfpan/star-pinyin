/**
 * debug-hangar-logo.mjs — 指挥中心左上角 LOGO + 呼号放大验收（只读，不改玩家进度）。
 * 复用 3000 端口服务。产出：.ui-shots/hangar-logo.png（整屏）/ hangar-logo-head.png（顶栏特写）
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
const CHROME = 'C:\\Users\\panft\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9267;
const OUT = 'C:\\Codes\\star-pinyin\\.ui-shots';
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=' + PORT, '--window-size=820,1180', '--autoplay-policy=no-user-gesture-required',
  '--user-data-dir=C:\\Codes\\star-pinyin\\.chrome-debugLogo', 'http://127.0.0.1:3000/'], { stdio: 'ignore', detached: true });

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
const shot = async (name, clip) => { const r = await send('Page.captureScreenshot', clip ? { format: 'png', clip: { ...clip, scale: 2 } } : { format: 'png' });
  if (r.result?.data) { fs.writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.result.data, 'base64')); console.log('shot', name); } else errors.push('shot failed: ' + name); };
const check = (name, cond) => { console.log((cond ? '  ✓ ' : '  ✗ ') + name); if (!cond) errors.push('check failed: ' + name); };

await send('Runtime.enable'); await send('Page.enable');
await send('Page.navigate', { url: 'http://127.0.0.1:3000/' }); await sleep(900);
await ev(`window.__audio && Object.assign(window.__audio, { speakText(){}, slowSplit(){}, speakPinyin(){} })`);
await ev(`document.getElementById('enterBtn').click()`); await sleep(900);

const m = await ev(`(() => {
  const icon = document.querySelector('.hangar-id-icon');
  const cs = document.getElementById('callsign');
  const head = document.querySelector('.hangar-head');
  const act = document.querySelector('.hangar-actions .launch-count');
  const ir = icon.getBoundingClientRect(), cr = cs.getBoundingClientRect(), hr = head.getBoundingClientRect();
  const body = document.getElementById('hangarBody').getBoundingClientRect();
  const hangar = document.getElementById('hangar');
  return {
    icon: { w: +ir.width.toFixed(1), h: +ir.height.toFixed(1) },
    callsign: { fontPx: +getComputedStyle(cs).fontSize.replace('px',''), textH: +cr.height.toFixed(1), text: cs.textContent },
    headH: +hr.height.toFixed(1), actionH: act ? +act.getBoundingClientRect().height.toFixed(1) : null,
    headRect: { x: hr.x, y: hr.y, w: hr.width, h: hr.height },
    overflow: { visualH: Math.round(body.height), availH: hangar.clientHeight, visualW: Math.round(body.width), availW: hangar.clientWidth }
  };
})()`);
console.log(JSON.stringify(m, null, 2));
check('LOGO 放大到 44px（2.75rem）', m.icon.w >= 43 && m.icon.h >= 43);
check('呼号字号放大到 ≈29.6px（1.85rem）', m.callsign.fontPx >= 29);
check('左侧身份块与右侧 48px 信息块同量级（图标 44px ≤ 48px）', m.icon.h <= (m.actionH ?? 48) + 1);
check('顶栏高度仍由右侧信息块决定（≈48px + padding）', m.headH <= 72);
check('机库无溢出 ' + JSON.stringify(m.overflow), m.overflow.visualH <= m.overflow.availH + 1 && m.overflow.visualW <= m.overflow.availW + 1);

await shot('hangar-logo');
await shot('hangar-logo-head', { x: Math.max(0, m.headRect.x - 8), y: Math.max(0, m.headRect.y - 8), width: m.headRect.w + 16, height: m.headRect.h + 16 });

console.log('\nERRORS:', errors.length ? errors : 'none');
ws.close(); try { process.kill(-chrome.pid); } catch {} try { chrome.kill(); } catch {}
process.exit(errors.length ? 1 : 0);