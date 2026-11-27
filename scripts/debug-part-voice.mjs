/**
 * debug-part-voice.mjs — 无头 Chrome 端到端校验零件读音：
 *  1) 47 个 part/*.mp3 均可解码播放；
 *  2) speakPart('a') 走本地分支、无异常；
 *  3) 「沙」(m_126) 慢读 slowSplit 实际请求 part/sh.mp3 + part/a.mp3 + sha1.mp3。
 * 依赖本机服务 http://127.0.0.1:3000 已启动。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
const CHROME = 'C:\\Users\\panft\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9261;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=' + PORT, '--autoplay-policy=no-user-gesture-required',
  '--user-data-dir=C:\\Codes\\star-pinyin\\.chrome-debugP', 'http://127.0.0.1:3000/'], { stdio: 'ignore', detached: true });
async function getTarget() { for (let i = 0; i < 60; i++) { try { const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); const p = l.find((t) => t.type === 'page' && t.url.includes('127.0.0.1:3000')); if (p) return p; } catch {} await sleep(250); } throw new Error('no target'); }
const ws = new WebSocket((await getTarget()).webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let idc = 0; const pending = new Map(); const errors = [];
ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails?.exception?.description || 'exc'); });
const send = (method, params = {}) => new Promise((res) => { const id = ++idc; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
async function ev(expression) { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.result?.exceptionDetails) errors.push('EVAL ' + (r.result.exceptionDetails.exception?.description || '')); return r.result?.result?.value; }
await send('Runtime.enable'); await sleep(600);

// 1) 所有零件文件可解码
const files = fs.readdirSync('public/audio/voice/part').filter((f) => f.endsWith('.mp3'));
const decode = await ev(`(async () => {
  const files = ${JSON.stringify(files)}; const out = [];
  for (const f of files) {
    const a = new Audio('/audio/voice/part/' + f);
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
const bad = decode.filter((r) => !r.ok || !(r.dur > 0));
console.log(`[1] 零件 MP3 ${decode.length} 个 · 可播放 ${decode.filter((r) => r.ok && r.dur > 0).length} · 异常 ${bad.length ? JSON.stringify(bad) : 'none'}`);

// 2) speakPart 本地分支
await ev(`document.getElementById('enterBtn').click()`); await sleep(400);
const sp = await ev(`(async()=>{ try { await window.__audio.speakPart('a'); return 'ok ctx='+window.__audio.contextState(); } catch(e){ return 'ERR '+e.message; } })()`);
console.log('[2] speakPart(a):', sp);

// 3) 沙 m_126 慢读请求了正确的零件文件
await ev(`window.__debugStart('m_126')`); await sleep(500);
await ev(`window.__audio.slowSplit(window.__currentMission)`);
await sleep(3600);
const reqs = await ev(`performance.getEntriesByType('resource').map(e=>e.name).filter(n=>n.includes('/audio/voice/'))`);
const need = ['part/sh.mp3', 'part/a.mp3', 'sha1.mp3'];
const hit = need.map((n) => ({ n, ok: reqs.some((u) => u.includes(n)) }));
console.log('[3] 沙慢读请求:', JSON.stringify(hit));
console.log('    全部音频请求:', JSON.stringify(reqs.map((u) => u.split('/audio/voice/')[1])));
console.log('ERRORS:', errors.length ? errors : 'none');
const pass = bad.length === 0 && String(sp).startsWith('ok') && hit.every((h) => h.ok) && errors.length === 0;
console.log(pass ? '\n✅ 零件读音端到端校验通过' : '\n❌ 校验未通过');
ws.close(); try { process.kill(-chrome.pid); } catch {} try { chrome.kill(); } catch {}
process.exit(pass ? 0 : 1);