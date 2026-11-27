/**
 * debug-stat-bars.mjs — 验证「近期薄弱拼音标签」柱状图填充条可见（.stat-fill 需 display:block）。
 * 打开 admin.html#study（会话级预解锁家长校验），量测每根填充条的实际渲染宽度并截图。
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const CHROME = 'C:\\Users\\panft\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9281;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=' + PORT, '--window-size=820,1180',
  '--user-data-dir=C:\\Codes\\star-pinyin\\.chrome-debugStatBars', 'about:blank'], { stdio: 'ignore', detached: true });
async function getTarget() { for (let i = 0; i < 60; i++) { try { const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); const p = l.find((t) => t.type === 'page'); if (p) return p; } catch {} await sleep(250); } throw new Error('no target'); }
const ws = new WebSocket((await getTarget()).webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let idc = 0; const pending = new Map(); const errors = [];
ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails?.exception?.description || 'exc'); });
const send = (method, params = {}) => new Promise((res) => { const id = ++idc; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
async function ev(expression) { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.result?.exceptionDetails) errors.push('EVAL ' + (r.result.exceptionDetails.exception?.description || '')); return r.result?.result?.value; }

await send('Runtime.enable'); await send('Page.enable');
// 预解锁家长校验（仅本调试会话）
await send('Page.addScriptToEvaluateOnNewDocument', { source: `sessionStorage.setItem('sp_admin_unlocked','1');` });
await send('Page.navigate', { url: 'http://127.0.0.1:3000/admin.html#study' });
await sleep(1500);

const rows = await ev(`[...document.querySelectorAll('#stats .stat-row')].map((r)=>{
  const fill = r.querySelector('.stat-fill');
  const bar = r.querySelector('.stat-bar');
  const cs = getComputedStyle(fill);
  return { tag: r.querySelector('.stat-tag').textContent, pct: r.querySelector('.stat-rate').textContent,
    display: cs.display, fillW: Math.round(fill.getBoundingClientRect().width), barW: Math.round(bar.getBoundingClientRect().width),
    fillH: Math.round(fill.getBoundingClientRect().height) };
})`);
console.log('[stats] 行数 =', rows?.length);
for (const r of rows || []) console.log(`  ${r.tag} ${r.pct} → display:${r.display} fill ${r.fillW}x${r.fillH}px / bar ${r.barW}px`);

let fail = 0;
for (const r of rows || []) {
  const pct = parseInt(r.pct, 10);
  const expect = Math.round(r.barW * pct / 100);
  const ok = r.display === 'block' && Math.abs(r.fillW - expect) <= 1 && (pct === 0 || r.fillW > 0) && r.fillH > 0;
  if (!ok) { fail++; console.log(`  ✗ ${r.tag} 期望宽 ≈${expect}px，实际 ${r.fillW}px`); }
}
console.log(fail ? `FAIL：${fail} 根填充条异常` : 'OK：全部填充条宽度与百分比一致');

const shot = await send('Page.captureScreenshot', { format: 'png' });
if (shot.result?.data) { writeFileSync('C:\\Codes\\star-pinyin\\.chrome-debugStatBars\\stats.png', Buffer.from(shot.result.data, 'base64')); console.log('截图 = .chrome-debugStatBars\\stats.png'); }
console.log('ERRORS:', errors.length ? errors : 'none');
ws.close(); try { process.kill(-chrome.pid); } catch {} try { chrome.kill(); } catch {}
process.exit(fail ? 1 : 0);