/**
 * debug-tts-test-play.mjs — 诊断「测试合成成功后试播无声」：对真实已配置 API 打一次测试合成，
 * 在 headless Chrome（不带 autoplay 豁免）里抓 play() 的拒绝原因 / media 状态 / 容器 MIME。
 * 会消耗一次真实 TTS 配额。运行：node scripts/debug-tts-test-play.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const CHROME = 'C:\\Users\\panft\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 3103, CDP = 9284;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 真实数据目录（只读使用：test 接口不写盘），独立 chrome profile
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'star-pinyin-ttsplay-'));
try {
  await fetch(`http://127.0.0.1:${CDP}/json/version`);
  throw new Error(`CDP 端口 ${CDP} 被占用（可能有残留 Chrome 进程），请先清理再跑`);
} catch (e) { if (String(e?.message).includes('被占用')) throw e; }
const server = spawn(process.execPath, ['server.js'], {
  cwd: ROOT, env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' }, stdio: 'ignore',
});
for (let i = 0; i < 60; i++) {
  try { if ((await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok) break; } catch {}
  await sleep(250);
}
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=' + CDP, '--window-size=1280,1000',
  '--user-data-dir=' + path.join(tmp, 'chrome'), `http://127.0.0.1:${PORT}/admin.html#voice`], { stdio: 'ignore', detached: true });
async function getTarget() {
  for (let i = 0; i < 60; i++) {
    try { const l = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json(); const p = l.find((t) => t.type === 'page'); if (p) return p; } catch {}
    await sleep(250);
  }
  throw new Error('no target');
}
const ws = new WebSocket((await getTarget()).webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let idc = 0; const pending = new Map();
ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}) => new Promise((res) => { const id = ++idc; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.result?.value;

await send('Runtime.enable'); await send('Page.enable'); await sleep(1500);
await ev(`(()=>{const map={一:'壹',二:'貳',三:'參',四:'肆',五:'伍',六:'陸',七:'柒',八:'捌',九:'玖',十:'拾'};const g=document.getElementById('adminGate');if(g&&!g.hidden){document.getElementById('gateInput').value=map[document.getElementById('gateChar').textContent]||'';document.getElementById('gateBtn').click();}})()`);
await sleep(500);
// _instr：抓 play() 拒绝原因与 media 终态
await ev(`window.__playErr=[];window.__medias=[];const op=HTMLMediaElement.prototype.play;HTMLMediaElement.prototype.play=function(...a){window.__medias.push(this);const p=op.apply(this,a);if(p&&p.catch)p.catch(e=>window.__playErr.push(String(e&&e.name||e)));this.addEventListener('error',()=>window.__playErr.push('media-error:'+(this.error&&this.error.code)));return p;};`);
// 可信鼠标点击（.click() 是无手势事件，会自己触发 autoplay 拦截，诊断须用真手势）
const clickTrusted = async (sel) => {
  const r = await ev(`(()=>{const el=document.querySelector('${sel}');if(!el)return null;el.scrollIntoView({block:'center'});const b=el.getBoundingClientRect();const at=document.elementFromPoint(b.x+b.width/2,b.y+b.height/2);return {x:b.x+b.width/2,y:b.y+b.height/2,at:at?(at.id||at.className||at.tagName):'null'};})()`);
  console.log('clickTrusted', sel, JSON.stringify(r));
  if (!r) throw new Error('selector not found: ' + sel);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.x, y: r.y, clickCount: 1, button: 'left', buttons: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r.x, y: r.y, clickCount: 1, button: 'left', buttons: 0 });
};
await clickTrusted('#ttsTestBtn');
await sleep(9000);
console.log('msg:', await ev(`document.getElementById('ttsMsg').textContent`));
console.log('playErr:', await ev(`JSON.stringify(window.__playErr)`));
console.log('medias:', await ev(`JSON.stringify(window.__medias.map(m=>({src:m.src.slice(0,24),paused:m.paused,t:m.currentTime,dur:m.duration,ready:m.readyState,err:m.error&&m.error.code,ended:m.ended})))`));
console.log('replayBtn:', await ev(`!!document.getElementById('ttsReplayBtn')`));
ws.close();
try { process.kill(-chrome.pid); } catch {} try { chrome.kill(); } catch {}
try { server.kill(); } catch {}
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}