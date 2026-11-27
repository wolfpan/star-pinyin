/**
 * debug-globalvoice.mjs — 验证全局真人语音：系统提示/简报/倒计时均经 /api/tts 代理播放。
 */
import { spawn } from 'node:child_process';
const CHROME = 'C:\\Users\\panft\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9270;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=' + PORT, '--window-size=820,1180', '--autoplay-policy=no-user-gesture-required',
  '--user-data-dir=C:\\Codes\\star-pinyin\\.chrome-debugG', 'http://127.0.0.1:3000/'], { stdio: 'ignore', detached: true });
async function getTarget() { for (let i = 0; i < 60; i++) { try { const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); const p = l.find((t) => t.type === 'page' && t.url.includes('127.0.0.1:3000')); if (p) return p; } catch {} await sleep(250); } throw new Error('no target'); }
const ws = new WebSocket((await getTarget()).webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let idc = 0; const pending = new Map(); const errors = [];
ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails?.exception?.description || 'exc'); if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push('console.error ' + m.params.args.map(a => a.value || a.description).join(' ')); });
const send = (method, params = {}) => new Promise((res) => { const id = ++idc; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
async function ev(expression) { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.result?.exceptionDetails) errors.push('EVAL ' + (r.result.exceptionDetails.exception?.description || '')); return r.result?.result?.value; }
const mouse = (type, x, y) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 });
async function tap(x, y) { await mouse('mousePressed', x, y); await sleep(25); await mouse('mouseReleased', x, y); }
async function drag(fx, fy, tx, ty) { await mouse('mousePressed', fx, fy); await sleep(80); for (let i = 1; i <= 6; i++) { await mouse('mouseMoved', fx + (tx - fx) * i / 6, fy + (ty - fy) * i / 6); await sleep(25); } await mouse('mouseReleased', tx, ty); await sleep(380); }
const rect = (sel) => ev(`(() => { const e = document.querySelector('${sel}'); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 }; })()`);
const modCenter = (g, v) => ev(`(() => { const e = [...document.querySelectorAll('.module')].find(m => m.dataset.group === '${g}' && m.dataset.value === '${v}'); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 }; })()`);
const slotCenter = (id) => rect(`.slot[data-slot="${id}"] .slot-hit`);
const waitFor = async (sel, ms = 6000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await ev(`!!document.querySelector('${sel}')`)) return true; await sleep(120); } return false; };

await send('Runtime.enable'); await send('Page.enable'); await sleep(600);
// 拦截 Audio 构造，记录所有播放源
await ev(`window.__srcs = []; const OA = window.Audio; window.Audio = function(src){ const a = new OA(src); window.__srcs.push(src); return a; }; window.Audio.prototype = OA.prototype;`);

const enter = await rect('#enterBtn'); await tap(enter.x, enter.y); await sleep(600);
console.log('[进入] 播放源含 /api/tts 进入指挥中心 =', await ev(`window.__srcs.some(s => s.includes('/api/tts') && s.includes(decodeURIComponent('%E8%BF%9B%E5%85%A5')))`));

await ev(`window.__fxTimeScale = 3`);
await ev(`window.__debugStart('m_011')`); await sleep(700);
console.log('[简报] 播放源含 载荷确认 代理 =', await ev(`window.__srcs.some(s => s.includes('/api/tts') && s.includes('%E8%BD%BD%E8%8D%B7'))`));
await ev(`document.querySelector('#game .briefing .phys-btn.primary')?.click()`); await sleep(400);
const m = await ev(`window.__currentMission`);
for (const g of ['initial', 'medial', 'final']) { const mc = await modCenter(g, m.parts[g]); const sc = await slotCenter(g); await drag(mc.x, mc.y, sc.x, sc.y); }
await waitFor('.tone', 3000);
const cb = await rect(`.curve-btn[data-tone="${m.tone}"]`); await tap(cb.x, cb.y);
await waitFor('.launch-canvas', 2000);
console.log('[倒计时] 播放源含 点火 代理 =', await ev(`window.__srcs.some(s => s.includes('/api/tts') && s.includes('%E7%82%B9%E7%81%AB'))`));
const rewardOk = await waitFor('.reward', 6000);
console.log('[结算] reward =', rewardOk, '拼音 =', await ev(`document.querySelector('.completion-pinyin')?.textContent`));
console.log('[结算] 读音用本地音节文件 =', await ev(`window.__srcs.some(s => s.includes('/audio/voice/chuan2.mp3'))`));
const proxyCount = await ev(`window.__srcs.filter(s => s.includes('/api/tts')).length`);
console.log('[统计] /api/tts 真人语音播放次数 =', proxyCount, '总播放源 =', await ev(`window.__srcs.length`));
// 校验代理音频可解码
const dur = await ev(`(async()=>{ const a=new (Object.getPrototypeOf(window.Audio).constructor)('/api/tts?text='+encodeURIComponent('进入指挥中心')); return await new Promise(r=>{const t=setTimeout(()=>r(-1),4000);a.addEventListener('loadedmetadata',()=>{clearTimeout(t);r(+a.duration.toFixed(2));},{once:true});a.addEventListener('error',()=>{clearTimeout(t);r(-2);},{once:true});a.load();}); })()`);
console.log('[代理音频] 进入指挥中心 时长 =', dur, 's');
console.log('ERRORS:', errors.length ? errors : 'none');
ws.close(); try { process.kill(-chrome.pid); } catch {} try { chrome.kill(); } catch {}
process.exit(0);
