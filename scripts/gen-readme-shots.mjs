/**
 * gen-readme-shots.mjs — README「界面预览」配图生成（只读，不写玩家进度/设置）。
 * 复用 3000 端口真实服务与真实档案（画面更丰满）：
 *  - 三套皮肤机库：fetch 拦截仅改 profile.skin（不落盘），820×1180 竖屏；
 *  - 家长后台四页签：真实数据 + 会话级家长校验预解锁（sessionStorage，与 debug-stat-bars 同），1000×1400；
 *    发音页隐藏 TTS 配置面板（公开配图不含 API 地址 / 模型 / 音色 / Key 信息）。
 * 产出（进仓库）：docs/screenshots/skin-{hud,daylight,nebula}.png / admin-{study,ui,voice,reset}.png
 * 运行：node scripts/gen-readme-shots.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = 'C:\\Users\\panft\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9261;
const OUT = path.join(ROOT, 'docs', 'screenshots');
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=' + PORT, '--window-size=820,1180', '--autoplay-policy=no-user-gesture-required',
  '--user-data-dir=' + path.join(ROOT, '.chrome-debugReadmeShots'), 'http://127.0.0.1:3000/'], { stdio: 'ignore', detached: true });

async function getTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const p = l.find((t) => t.type === 'page' && t.url.includes('127.0.0.1:3000'));
      if (p) return p;
    } catch {}
    await sleep(250);
  }
  throw new Error('no target');
}
const ws = new WebSocket((await getTarget()).webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let idc = 0; const pending = new Map(); const errors = [];
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails?.exception?.description || 'exc');
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push('console.error ' + m.params.args.map((a) => a.value || a.description).join(' '));
});
const send = (method, params = {}) => new Promise((res) => { const id = ++idc; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
async function ev(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) errors.push('EVAL ' + (r.result.exceptionDetails.exception?.description || JSON.stringify(r.result.exceptionDetails)));
  return r.result?.result?.value;
}
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  if (r.result?.data) { fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(r.result.data, 'base64')); console.log('shot', name); }
  else errors.push('shot failed: ' + name);
};
// 按内容高度裁切（短页不留视口空白尾；长页最多 1400 高）
const shotClip = async (name, width, height) => {
  const r = await send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width, height, scale: 1 } });
  if (r.result?.data) { fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(r.result.data, 'base64')); console.log('shot', name, height + 'px'); }
  else errors.push('shot failed: ' + name);
};
const waitFor = async (expr, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await ev(expr)) return true; await sleep(150); } return false; };

await send('Runtime.enable'); await send('Page.enable');
// 家长后台受保护页签：会话级预解锁（仅 sessionStorage，不答校验也不落盘）
await send('Page.addScriptToEvaluateOnNewDocument', { source: `try{sessionStorage.setItem('sp_admin_unlocked','1')}catch{}` });

/* ---- 三套皮肤机库（只改拦截里的 skin，真实进度/火箭收藏保留） ---- */
for (const skin of ['hud', 'daylight', 'nebula']) {
  console.log('\n[skin] ' + skin);
  await send('Page.navigate', { url: 'http://127.0.0.1:3000/' }); await sleep(900);
  await ev(`window.__audio && Object.assign(window.__audio, { speakText(){}, slowSplit(){}, speakPinyin(){} })`);
  await ev(`(() => { const orig = window.fetch.bind(window); window.fetch = async (url, opts) => {
    const res = await orig(url, opts);
    if (String(url).startsWith('/api/profile')) {
      const p = await res.json(); p.skin = ${JSON.stringify(skin)};
      return new Response(JSON.stringify(p), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return res; }; })()`);
  await ev(`document.getElementById('enterBtn').click()`);
  if (!await waitFor(`document.querySelectorAll('#rocketPicker .rocket-chip').length > 0 && document.querySelectorAll('#tbLessons .tb-lesson').length > 0`)) {
    errors.push(skin + ': hangar not rendered');
  }
  await sleep(500); // 等自适应缩放与横滑渐隐落定
  await shot('skin-' + skin);
}

/* ---- 家长后台四页签（桌面视口） ---- */
await send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 1400, deviceScaleFactor: 1, mobile: false, screenWidth: 1000, screenHeight: 1400 });
for (const page of ['study', 'ui', 'voice', 'reset']) {
  console.log('\n[admin] ' + page);
  await send('Page.navigate', { url: 'http://127.0.0.1:3000/admin.html#' + page }); await sleep(1200);
  const ok = await ev(`(() => { const p = document.getElementById('page-${page}');
    const body = p.querySelector('.page-body'); // 界面页不受校验，无 .page-body 包装
    return !p.hidden && (!body || !body.hidden) && document.getElementById('adminGate').hidden; })()`);
  if (!ok) errors.push('admin ' + page + ': page locked or hidden');
  // 公开配图不泄露服务信息：发音页隐藏 TTS API / 模型 / 音色配置面板
  if (page === 'voice') await ev(`document.getElementById('ttsConfigBox')?.remove()`);
  await sleep(400);
  const h = await ev(`Math.min(Math.ceil(document.getElementById('page-${page}').getBoundingClientRect().bottom) + 28, 1400)`);
  await shotClip('admin-' + page, 1000, h);
}

console.log('\nERRORS:', errors.length ? errors : 'none');
ws.close(); try { process.kill(-chrome.pid); } catch {} try { chrome.kill(); } catch {}
process.exit(errors.length ? 1 : 0);