/**
 * debug-boot-ui.mjs — 首页 SpaceX 星舰风格改版截图验收。
 * 多视口截图（iPad 竖屏 / 横屏 / 手机）+ 进入机库回归 + 页面 JS 错误收集。
 * 临时诊断脚本：输出 PNG 到 .ui-shots/。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
const CHROME = 'C:\\Users\\panft\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9247;
const OUT = 'C:\\Codes\\star-pinyin\\.ui-shots';
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=' + PORT, '--window-size=820,1180', '--autoplay-policy=no-user-gesture-required',
  '--user-data-dir=C:\\Codes\\star-pinyin\\.chrome-debugBoot', 'http://127.0.0.1:3000/'], { stdio: 'ignore', detached: true });

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
const shot = async (name) => { const r = await send('Page.captureScreenshot', { format: 'png' }); if (r.result?.data) { fs.writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.result.data, 'base64')); console.log('shot', name); } else errors.push('shot failed: ' + name); };
const metrics = (width, height) => send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });

await send('Runtime.enable'); await send('Page.enable');

/* iPad 竖屏 820×1180 */
await metrics(820, 1180);
await send('Page.navigate', { url: 'http://127.0.0.1:3000/' }); await sleep(1600);
await ev(`window.__audio && Object.assign(window.__audio, { speakText(){}, slowSplit(){}, speakPinyin(){} })`);
console.log('font loaded:', await ev(`document.fonts.check('700 16px "D-DIN"')`));
await shot('boot-spacex-portrait');

/* iPad 横屏 1180×820 */
await metrics(1180, 820); await sleep(700);
await shot('boot-spacex-landscape');

/* 手机竖屏 390×844 */
await metrics(390, 844); await sleep(700);
await shot('boot-spacex-phone');

/* 回归：点击进入机库（音频解锁 + 屏幕切换） */
await metrics(820, 1180); await sleep(500);
await ev(`document.getElementById('enterBtn').click()`); await sleep(900);
console.log('hangar visible:', await ev(`!document.getElementById('hangar').hidden && document.getElementById('boot').hidden`));
await shot('boot-spacex-after-enter');

console.log('ERRORS:', errors.length ? errors : 'none');
ws.close(); try { process.kill(-chrome.pid); } catch {} try { chrome.kill(); } catch {}
process.exit(0);
