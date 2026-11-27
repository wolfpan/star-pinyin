/**
 * debug-audio.mjs — 无头 Chrome 验收 M4：首次手势解锁、各音效合成无异常、人声降级、全流程发声。
 */
import { spawn } from 'node:child_process';
const CHROME = 'C:\\Users\\panft\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9250;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=' + PORT, '--window-size=820,1180', '--autoplay-policy=no-user-gesture-required',
  '--user-data-dir=C:\\Codes\\star-pinyin\\.chrome-debugA', 'http://127.0.0.1:3000/'], { stdio: 'ignore', detached: true });
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
async function drag(fx, fy, tx, ty) { await mouse('mousePressed', fx, fy); await sleep(80); for (let i = 1; i <= 6; i++) { await mouse('mouseMoved', fx + (tx - fx) * i / 6, fy + (ty - fy) * i / 6); await sleep(25); } await mouse('mouseReleased', tx, ty); await sleep(380); }
const rect = (sel) => ev(`(() => { const e = document.querySelector('${sel}'); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 }; })()`);
const modCenter = (g, v) => ev(`(() => { const e = [...document.querySelectorAll('.module')].find(m => m.dataset.group === '${g}' && m.dataset.value === '${v}'); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 }; })()`);
const slotCenter = (id) => rect(`.slot[data-slot="${id}"] .slot-hit`);
const waitFor = async (sel, ms = 5000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await ev(`!!document.querySelector('${sel}')`)) return true; await sleep(120); } return false; };

await send('Runtime.enable'); await send('Page.enable'); await sleep(700);

// 首次手势解锁
const enter = await rect('#enterBtn'); await tap(enter.x, enter.y); await sleep(500);
console.log('[解锁] isUnlocked =', await ev(`window.__audio.isUnlocked()`), 'contextState =', await ev(`window.__audio.contextState()`));

// 各音效合成无异常
const synth = await ev(`(() => { const A = window.__audio; const out = {};
  for (const [k, fn] of [['lock',()=>A.playLock()],['spark',()=>A.playSpark()],['error',()=>A.playError()],['beep',()=>A.playBeep(1)],['success',()=>A.playSuccess()],['sep',()=>A.playSeparation()],['fairing',()=>A.playFairing()],['radio',()=>A.playRadioStatic()],['roar',()=>{const h=A.startEngineRoar({duration:0.3});h.stop();}]]) {
    try { fn(); out[k] = 'ok'; } catch (e) { out[k] = 'ERR ' + e.message; }
  } return out; })()`);
console.log('[音效合成]', JSON.stringify(synth));

// 人声降级（无本地 mp3 → TTS），不抛异常
const voice = await ev(`(async()=>{ try { await window.__audio.speakPinyin({base:'chuan',tone:2,hanzi:'船'}); window.__audio.speakText('测试',1); return 'ok'; } catch(e){ return 'ERR '+e.message; } })()`);
console.log('[人声降级]', voice, 'speechSynthesis 存在 =', await ev(`'speechSynthesis' in window`));

// 全流程发声：组装 chuán → 点击校准 → 发射 → 结算
await ev(`window.__fxTimeScale = 3`);
await ev(`window.__debugStart('m_011')`); await sleep(350);
await ev(`document.querySelector('#game .briefing .phys-btn.primary')?.click()`); await sleep(350);
const m = await ev(`window.__currentMission`);
for (const g of ['initial', 'medial', 'final']) { const mc = await modCenter(g, m.parts[g]); const sc = await slotCenter(g); await drag(mc.x, mc.y, sc.x, sc.y); }
await waitFor('.tone', 3000);
const cb = await rect(`.curve-btn[data-tone="${m.tone}"]`); await tap(cb.x, cb.y);
await waitFor('.launch-canvas', 2000);
const rewardOk = await waitFor('.reward', 6000);
console.log('[全流程] 结算 =', rewardOk, '拼音 =', await ev(`document.querySelector('.completion-pinyin')?.textContent`), 'contextState =', await ev(`window.__audio.contextState()`));

console.log('ERRORS:', errors.length ? errors : 'none');
ws.close(); try { process.kill(-chrome.pid); } catch {} try { chrome.kill(); } catch {}
process.exit(0);
