/**
 * debug-voice.mjs — 无头 Chrome 校验 40 个本地读音 MP3 可解码播放，并验证 speakPinyin 走本地分支。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
const CHROME = 'C:\\Users\\panft\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9260;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=' + PORT, '--autoplay-policy=no-user-gesture-required',
  '--user-data-dir=C:\\Codes\\star-pinyin\\.chrome-debugV', 'http://127.0.0.1:3000/'], { stdio: 'ignore', detached: true });
async function getTarget() { for (let i = 0; i < 60; i++) { try { const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); const p = l.find((t) => t.type === 'page' && t.url.includes('127.0.0.1:3000')); if (p) return p; } catch {} await sleep(250); } throw new Error('no target'); }
const ws = new WebSocket((await getTarget()).webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let idc = 0; const pending = new Map(); const errors = [];
ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails?.exception?.description || 'exc'); });
const send = (method, params = {}) => new Promise((res) => { const id = ++idc; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
async function ev(expression) { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.result?.exceptionDetails) errors.push('EVAL ' + (r.result.exceptionDetails.exception?.description || '')); return r.result?.result?.value; }
await send('Runtime.enable'); await sleep(600);

const files = fs.readdirSync('public/audio/voice').filter((f) => f.endsWith('.mp3'));
const result = await ev(`(async () => {
  const files = ${JSON.stringify(files)};
  const out = [];
  for (const f of files) {
    const a = new Audio('/audio/voice/' + f);
    const r = await new Promise((resolve) => {
      const to = setTimeout(() => resolve({ ok: false, err: 'timeout' }), 4000);
      a.addEventListener('loadedmetadata', () => { clearTimeout(to); resolve({ ok: true, dur: +a.duration.toFixed(2) }); }, { once: true });
      a.addEventListener('error', () => { clearTimeout(to); resolve({ ok: false, err: 'decode' }); }, { once: true });
      a.load();
    });
    out.push({ f, ...r });
  }
  return out;
})()`);
const bad = result.filter((r) => !r.ok || !(r.dur > 0));
console.log('校验 MP3 数:', result.length, '可播放:', result.filter((r) => r.ok && r.dur > 0).length);
console.log('样例时长:', JSON.stringify(result.slice(0, 6)));
console.log('异常文件:', bad.length ? JSON.stringify(bad) : 'none');

// 验证 speakPinyin 本地分支：进入后调用，检查无异常且 AudioContext running
await ev(`document.getElementById('enterBtn').click()`); await sleep(400);
const sp = await ev(`(async()=>{ try { await window.__audio.speakPinyin({base:'chuan',tone:2,hanzi:'船'}); return 'ok ctx='+window.__audio.contextState(); } catch(e){ return 'ERR '+e.message; } })()`);
console.log('speakPinyin(船):', sp);
console.log('ERRORS:', errors.length ? errors : 'none');
ws.close(); try { process.kill(-chrome.pid); } catch {} try { chrome.kill(); } catch {}
process.exit(0);
