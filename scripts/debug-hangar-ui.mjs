/**
 * debug-hangar-ui.mjs — 指挥官（机库）界面改版截图验收。
 * 用法：node scripts/debug-hangar-ui.mjs <标签> [early]
 *   标签：输出文件名前缀（before / after）
 *   early：可选，模拟「刚开局」档案（仅初始座驾、2 颗入轨），验证下一枚火箭进度条。
 * 输出：.ui-shots/<标签>-hangar.png / <标签>-hangar-bottom.png（early 时另存 -early 版本）。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
const CHROME = 'C:\\Users\\panft\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9247;
const TAG = process.argv[2] || 'hangar';
const EARLY = process.argv.includes('early');
const SMOKE = process.argv.includes('smoke');
const SIZE = (process.argv.find((a) => a.startsWith('--size=')) || '').slice(7);
const OUT = 'C:\\Codes\\star-pinyin\\.ui-shots';
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=' + PORT, '--window-size=820,1180', '--autoplay-policy=no-user-gesture-required',
  '--user-data-dir=C:\\Codes\\star-pinyin\\.chrome-debugHangar', 'http://127.0.0.1:3000/'], { stdio: 'ignore', detached: true });

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

await send('Runtime.enable'); await send('Page.enable'); await sleep(900);
if (SIZE) { const [w, h] = SIZE.split('x').map(Number); await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false }); await sleep(300); }
await ev(`window.__audio && Object.assign(window.__audio, { speakText(){}, slowSplit(){}, speakPinyin(){} })`);

if (EARLY) {
  // 拦截 /api/profile：仅保留初始座驾，2 颗入轨，下一枚 = 第一枚解锁火箭
  await ev(`(() => { const orig = window.fetch.bind(window); window.fetch = async (url, opts) => {
    const res = await orig(url, opts);
    if (String(url).startsWith('/api/profile')) {
      const p = await res.json();
      const starter = (p.badges || []).find((b) => b.starter || Number(b.unlockAt) === 0);
      const next = (p.badges || []).filter((b) => !(b.starter || Number(b.unlockAt) === 0)).sort((a, b) => a.unlockAt - b.unlockAt)[0] || null;
      Object.assign(p, { totalLaunches: 2, unlockedBadges: [starter.id], museum: [starter], ownedRockets: [starter],
        currentRocket: starter, rocketAuto: true, selectedRocketId: null, nextBadge: next, emergencyCount: 0,
        lessonsCompleted: 0, lessonsTotal: 180, rewardLevel: 1 });
      delete p.nextReward; // 让客户端按课时自己算「下一份奖励」
      return new Response(JSON.stringify(p), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return res; }; })()`);
}

await ev(`document.getElementById('enterBtn').click()`); await sleep(800);
const suffix = EARLY ? '-early' : '';
await shot(`${TAG}-hangar${suffix}`);
const metrics = await ev(`(() => { const h = document.getElementById('hangar'); const b = document.getElementById('hangarBody'); const p = document.getElementById('rocketPicker');
  const br = b.getBoundingClientRect();
  return { visualH: Math.round(br.height), availH: h.clientHeight, visualW: Math.round(br.width), availW: h.clientWidth, bodyTransform: b.style.transform || 'none', pickerScrollable: p.scrollWidth > p.clientWidth + 4 }; })()`);
console.log('hangar metrics', JSON.stringify(metrics));
// 火箭选择器是有意做成单行横滑的：可滑动不算溢出，只检查机库本体是否超屏
if (metrics && (metrics.visualH > metrics.availH + 1 || metrics.visualW > metrics.availW + 1)) errors.push('overflow detected: ' + JSON.stringify(metrics));
if (SMOKE) {
  // 冒烟测试：点「发射」应进入任务简报（GET 抽题只读，不写进度）
  await ev(`document.getElementById('hangar').scrollTop = 0`); await sleep(200);
  await ev(`document.getElementById('launchBtn').click()`); await sleep(1000);
  const brief = await ev(`!!document.querySelector('#game .briefing')`);
  console.log('briefing rendered:', brief);
  if (!brief) errors.push('launch flow: briefing not rendered');
  await shot(`${TAG}-briefing${suffix}`);
}
console.log('ERRORS:', errors.length ? errors : 'none');
ws.close(); try { process.kill(-chrome.pid); } catch {} try { chrome.kill(); } catch {}
process.exit(0);
