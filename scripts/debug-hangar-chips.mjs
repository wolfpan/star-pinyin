/**
 * debug-hangar-chips.mjs — 机库右上角三枚信息块（发射次数 / 博物馆 / 最新目的地）
 * 「统一大小」无头 Chrome 验收：三套皮肤（hud / daylight / nebula）逐一测量 + 截图。
 * 复用 3000 端口服务（只读，不写玩家进度）。
 * 产出：.ui-shots/chips-<skin>.png（整屏）/ chips-<skin>-head.png（顶栏特写）
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
const CHROME = 'C:\\Users\\panft\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9263;
const OUT = 'C:\\Codes\\star-pinyin\\.ui-shots';
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=' + PORT, '--window-size=820,1180', '--autoplay-policy=no-user-gesture-required',
  '--user-data-dir=C:\\Codes\\star-pinyin\\.chrome-debugChips', 'http://127.0.0.1:3000/'], { stdio: 'ignore', detached: true });

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
const shot = async (name, clip = null) => {
  const params = { format: 'png' }; if (clip) params.clip = clip;
  const r = await send('Page.captureScreenshot', params);
  if (r.result?.data) { fs.writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.result.data, 'base64')); console.log('  shot', name); }
  else errors.push('shot failed: ' + name);
};
const check = (name, cond) => { console.log((cond ? '  ✓ ' : '  ✗ ') + name); if (!cond) errors.push('check failed: ' + name); };
const near = (a, b, tol = 0.6) => Math.abs(a - b) <= tol;

await send('Runtime.enable'); await send('Page.enable');

/** 进入机库：档案皮肤以服务端为准，这里用 fetch 拦截把 p.skin 强制成被测皮肤（只读，不写进度）。 */
async function enterWithSkin(skin, extraMock = '') {
  await send('Page.navigate', { url: 'http://127.0.0.1:3000/' }); await sleep(800);
  await ev(`localStorage.setItem('sp_skin', '${skin}')`);
  await send('Page.navigate', { url: 'http://127.0.0.1:3000/' }); await sleep(900);
  await ev(`window.__audio && Object.assign(window.__audio, { speakText(){}, slowSplit(){}, speakPinyin(){} })`);
  await ev(`(() => { const orig = window.fetch.bind(window); window.fetch = async (url, opts) => {
    const res = await orig(url, opts);
    if (String(url).startsWith('/api/profile')) {
      const p = await res.json(); p.skin = '${skin}'; ${extraMock}
      return new Response(JSON.stringify(p), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return res; }; })()`);
  await ev(`document.getElementById('enterBtn').click()`); await sleep(900);
  const applied = await ev(`document.documentElement.dataset.skin`);
  check(`皮肤已应用（含档案同步后）：${applied}`, applied === skin);
}

const measure = () => ev(`(() => {
    const els = [
      ['launch', document.querySelector('.hangar-actions .launch-count')],
      ['museum', document.getElementById('museumBtn')],
      ['dest', document.getElementById('latestDest')],
    ];
    const out = els.map(([name, el]) => {
      const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
      return { name, w: +r.width.toFixed(2), h: +r.height.toFixed(2), top: +r.top.toFixed(2),
        radius: cs.borderRadius, border: cs.borderTopWidth + ' ' + cs.borderTopColor,
        bg: cs.backgroundColor, font: cs.fontSize, text: el.textContent.replace(/\\s+/g, ' ').trim() };
    });
    const head = document.querySelector('.hangar-head').getBoundingClientRect();
    const hangar = document.getElementById('hangar'); const body = document.getElementById('hangarBody');
    const br = body.getBoundingClientRect();
    return { chips: out, head: { x: head.x, y: head.y, w: head.width, h: head.height },
      fit: { visualH: Math.round(br.height), availH: hangar.clientHeight, visualW: Math.round(br.width), availW: hangar.clientWidth } };
  })()`);
async function verify(m, label) {
  const [a, b, c] = m.chips;
  console.log('  ' + m.chips.map(x => `${x.name}: ${x.w}×${x.h} @top ${x.top} r=${x.radius} 「${x.text}」`).join('\n  '));
  check('三块高度一致（48px 规格）', near(a.h, b.h) && near(a.h, c.h) && near(a.h, 48, 1.5));
  check('三块顶边对齐', near(a.top, b.top) && near(a.top, c.top));
  check('三块宽度一致', near(a.w, b.w) && near(a.w, c.w));
  check('三块圆角一致：' + a.radius, a.radius === b.radius && a.radius === c.radius);
  check('三块描边一致：' + a.border, a.border === b.border && a.border === c.border);
  check('三块底色一致：' + a.bg, a.bg === b.bg && a.bg === c.bg);
  check('目的地标签保留', c.text.includes('最新目的地'));
  check('机库无溢出 ' + JSON.stringify(m.fit), m.fit.visualH <= m.fit.availH + 1 && m.fit.visualW <= m.fit.availW + 1);
  await shot(`chips-${label}`);
  await shot(`chips-${label}-head`, { x: Math.max(0, m.head.x - 10), y: Math.max(0, m.head.y - 10), width: m.head.w + 20, height: m.head.h + 20, scale: 2 });
}

const SKINS = ['hud', 'daylight', 'nebula'];
for (const skin of SKINS) {
  console.log(`\n[skin=${skin}]`);
  await enterWithSkin(skin);
  await verify(await measure(), skin);
}

/* 两位数发射次数（45 次）：宽度仍应一致（min-width 152 覆盖 0–99 次） */
console.log('\n[skin=hud · 45 次发射（两位数）]');
await enterWithSkin('hud', 'p.totalLaunches = 45;');
await verify(await measure(), 'hud-45');

console.log('\nERRORS:', errors.length ? errors : 'none');
ws.close(); try { process.kill(-chrome.pid); } catch {} try { chrome.kill(); } catch {}
process.exit(errors.length ? 1 : 0);
