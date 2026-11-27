/**
 * debug-admin.mjs — M5 验收：admin 自动拆分注入 → 主页紧急灯 → 优先抽到 → 太空博物馆。
 */
import { spawn } from 'node:child_process';
const CHROME = 'C:\\Users\\panft\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9280;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=' + PORT, '--window-size=820,1180', '--autoplay-policy=no-user-gesture-required',
  '--user-data-dir=C:\\Codes\\star-pinyin\\.chrome-debugM', 'http://127.0.0.1:3000/admin.html'], { stdio: 'ignore', detached: true });
async function getTarget() { for (let i = 0; i < 60; i++) { try { const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); const p = l.find((t) => t.type === 'page'); if (p) return p; } catch {} await sleep(250); } throw new Error('no target'); }
const ws = new WebSocket((await getTarget()).webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let idc = 0; const pending = new Map(); const errors = [];
ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails?.exception?.description || 'exc'); if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push('console.error ' + m.params.args.map(a => a.value || a.description).join(' ')); });
const send = (method, params = {}) => new Promise((res) => { const id = ++idc; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
async function ev(expression) { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.result?.exceptionDetails) errors.push('EVAL ' + (r.result.exceptionDetails.exception?.description || '')); return r.result?.result?.value; }
const nav = async (url) => { await send('Page.navigate', { url }); await sleep(1000); };
const click = (sel) => ev(`document.querySelector('${sel}')?.click()`);

await send('Runtime.enable'); await send('Page.enable'); await sleep(800);

// 1) admin 自动拆分 + 注入
await ev(`document.getElementById('fHanzi').value='妈'; const p=document.getElementById('fPinyin'); p.value='ma1'; p.dispatchEvent(new Event('input'));`);
await sleep(600);
console.log('[admin] 预览拼音 =', await ev(`document.getElementById('previewPinyin').textContent`), '构型 =', await ev(`document.getElementById('sType').value`));
await click('#submitBtn'); await sleep(700);
console.log('[admin] 注入结果 =', await ev(`document.getElementById('injectMsg').textContent`));
const inj = await ev(`(async()=>{ const j=await (await fetch('/api/admin/missions')).json(); const m=j.missions.find(x=>x.hanzi==='妈'&&x.isParentInjected); return { count:j.count, id:m&&m.id, py:m&&m.displayPinyin }; })()`);
console.log('[admin] 词库 =', JSON.stringify(inj));

// 2) 主页紧急灯 + 优先抽到
await nav('http://127.0.0.1:3000/');
await click('#enterBtn'); await sleep(600);
console.log('[主页] 紧急灯可见 =', await ev(`!document.getElementById('emergencyLight').hidden`));
await click('#emergencyLight'); await sleep(800);
console.log('[主页] 优先抽到汉字 =', await ev(`document.querySelector('.brief-hanzi')?.textContent`), '（期望 妈）');

// 3) 太空博物馆
await nav('http://127.0.0.1:3000/');
await click('#enterBtn'); await sleep(500);
await click('#museumBtn'); await sleep(600);
console.log('[博物馆] overlay =', await ev(`!!document.querySelector('.museum-overlay')`), '卡片数 =', await ev(`document.querySelectorAll('.badge-card').length`), '解锁卡 =', await ev(`document.querySelectorAll('.badge-card.unlocked').length`));

// 4) 清理注入，恢复 40 种子
if (inj.id) { await ev(`(async()=>{ await fetch('/api/admin/missions/${inj.id}', {method:'DELETE'}); })()`); await sleep(300); }
console.log('[清理] 词库恢复 =', await ev(`(async()=>(await (await fetch('/api/admin/missions')).json()).count)()`));
console.log('ERRORS:', errors.length ? errors : 'none');
ws.close(); try { process.kill(-chrome.pid); } catch {} try { chrome.kill(); } catch {}
process.exit(0);
