/**
 * debug-ipad-ui.mjs — iPad 视口可读性审计（无头 Chrome 截图 + 字号/点按热区测量）
 * ------------------------------------------------------------------
 * 用法：node scripts/debug-ipad-ui.mjs <标签> [--sizes=768x1024,1024x768,834x1194]
 * 输出：.ui-shots/<标签>-<宽x高>-[hangar|museum-top|museum-rockets|briefing|assembly].png
 * 报告：每个视口下 ①机库整体缩放系数 ②最小字号文本（有效像素，含 fitHangar 缩放）
 *       ③点按热区 < 40px 的控件 ④横向溢出。
 *
 * 判定标准（iPad 竖屏 7–9 岁儿童）：
 *  - 正文/次要文字有效字号 ≥ 12px，控件名 ≥ 13px；
 *  - 可点按控件高度 ≥ 40px；
 *  - 无横向溢出，机库不出滚动条（内容超出时由 fitHangar 等比缩小）。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const CHROME = 'C:\\Users\\panft\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9261;
const OUT = 'C:\\Codes\\star-pinyin\\.ui-shots';
const TAG = process.argv[2] || 'ipad';
const SIZES = ((process.argv.find((a) => a.startsWith('--sizes=')) || '').slice(8) || '768x1024,1024x768,834x1194')
  .split(',').map((s) => s.split('x').map(Number));
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=' + PORT, '--window-size=834,1194', '--autoplay-policy=no-user-gesture-required',
  '--user-data-dir=C:\\Codes\\star-pinyin\\.chrome-debugIpad', 'about:blank'], { stdio: 'ignore', detached: true });

async function getTarget() {
  for (let i = 0; i < 80; i++) {
    try {
      const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const p = l.find((t) => t.type === 'page');
      if (p) return p;
    } catch {}
    await sleep(250);
  }
  throw new Error('no target');
}
const ws = new WebSocket((await getTarget()).webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let idc = 0; const pending = new Map(); const errors = [];
ws.addEventListener('message', (evt) => {
  const m = JSON.parse(evt.data);
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
  if (r.result?.data) { fs.writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.result.data, 'base64')); }
  else errors.push('shot failed: ' + name);
};

await send('Runtime.enable'); await send('Page.enable');

/** 页面内审计（按作用域）：字号（含祖先 transform 缩放）+ 点按热区 + 溢出。 */
const auditExpr = (scopeSel) => `(() => {
  const scaleOf = (el) => {
    let s = 1, n = el;
    while (n && n !== document.documentElement) {
      const t = getComputedStyle(n).transform;
      if (t && t !== 'none') {
        const m = t.match(/matrix\\(([^)]+)\\)/);
        if (m) { const p = m[1].split(',').map(Number); s *= Math.abs(p[0]) || 1; }
      }
      n = n.parentElement;
    }
    return s;
  };
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1 && getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).display !== 'none';
  };
  const label = (el) => (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 26);
  const path = (el) => {
    const parts = [];
    let n = el;
    for (let i = 0; i < 4 && n && n !== document.body; i++) {
      parts.unshift(n.className && typeof n.className === 'string' ? '.' + n.className.trim().split(/\\s+/)[0] : n.tagName.toLowerCase());
      n = n.parentElement;
    }
    return parts.join('>');
  };
  const scope = document.querySelector('${scopeSel}');
  if (!scope) return { missing: true };
  const texts = [];
  for (const el of scope.querySelectorAll('*')) {
    if (!visible(el)) continue;
    const own = [...el.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim());
    if (!own) continue;
    const px = parseFloat(getComputedStyle(el).fontSize) * scaleOf(el);
    if (!isFinite(px)) continue;
    texts.push({ t: label(el), px: Math.round(px * 10) / 10, sel: path(el) });
  }
  texts.sort((a, b) => a.px - b.px);
  const taps = [];
  for (const el of scope.querySelectorAll('button, [role="button"], a, input, select')) {
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.height < 40 || r.width < 40) taps.push({ t: label(el), w: Math.round(r.width), h: Math.round(r.height), sel: path(el) });
  }
  taps.sort((a, b) => a.h - b.h);
  const out = {
    docOverflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
    smallText: texts.filter((x) => x.px < 12).slice(0, 22),
    minText: texts.slice(0, 8),
    smallTaps: taps.slice(0, 18),
  };
  const hangar = document.getElementById('hangar');
  const body = document.getElementById('hangarBody');
  if (hangar && body && !hangar.hidden) {
    const br = body.getBoundingClientRect();
    const partH = (sel) => { const e = document.querySelector(sel); return e ? Math.round(e.getBoundingClientRect().height) : null; };
    const raw = (() => {
      const t = body.style.transform, w = body.style.width, m = body.style.minHeight;
      body.style.transform = ''; body.style.width = '100%'; body.style.minHeight = '';
      const h = body.scrollHeight;
      const kids = [...body.children].map((c) => ({ cls: String(c.className || c.id).slice(0, 22), h: Math.round(c.getBoundingClientRect().height), hidden: !!c.hidden }));
      const res = { scrollH: h, kids };
      body.style.transform = t; body.style.width = w; body.style.minHeight = m;
      return res;
    })();
    Object.assign(out, {
      scale: Math.round(scaleOf(body) * 1000) / 1000,
      bodyW: Math.round(br.width), bodyH: Math.round(br.height),
      availW: hangar.clientWidth, availH: hangar.clientHeight,
      display: getComputedStyle(body).display,
      landscape: matchMedia('(orientation: landscape)').matches,
      innerW: window.innerWidth, innerH: window.innerHeight,
      parts: { head: partH('.hangar-head'), p1: partH('.hangar-step:nth-of-type(1)'), p2: partH('.hangar-step:nth-of-type(2)'), launch: partH('.launch-btn'), picker: partH('#rocketPicker'), lessons: partH('#tbLessons') },
      raw,
    });
  }
  return out;
})()`;

async function load() {
  await send('Page.navigate', { url: 'http://127.0.0.1:3000/' });
  await sleep(1100);
  await ev(`window.__audio && Object.assign(window.__audio, { speakText(){}, slowSplit(){}, speakPinyin(){}, speak(){} })`);
  await ev(`document.getElementById('enterBtn').click()`);
  await sleep(900);
}

const fmtText = (list) => list.map((x) => `${x.px}px "${x.t}"`).join(' | ');
const fmtTaps = (list) => list.map((x) => `${x.w}x${x.h} "${x.t}"`).join(' | ');

const report = [];
for (const [w, h] of SIZES) {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: true, screenWidth: w, screenHeight: h });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true });
  await load();
  const key = `${TAG}-${w}x${h}`;
  await shot(`${key}-hangar`);
  const hangar = await ev(auditExpr('#hangar'));

  await ev(`document.getElementById('museumBtn').click()`);
  await sleep(900);
  await shot(`${key}-museum-top`);
  const museumTop = await ev(auditExpr('.museum-overlay'));
  await ev(`(() => { const o = document.querySelector('.museum-overlay'); o.scrollTop = o.scrollHeight; })()`);
  await sleep(500);
  await shot(`${key}-museum-rockets`);
  const museumBottom = await ev(auditExpr('.museum-overlay'));
  await ev(`(() => { const b = document.querySelector('.museum-head button'); b && b.click(); })()`);
  await sleep(300);

  // 任务简报 → 组装台（只读流程：GET 抽题不写进度）
  await ev(`document.getElementById('launchBtn').click()`);
  await sleep(1400);
  await shot(`${key}-briefing`);
  const briefing = await ev(auditExpr('#game'));
  await ev(`(() => { const b = document.querySelector('#game .briefing .phys-btn.primary'); b && b.click(); })()`);
  await sleep(1200);
  await shot(`${key}-assembly`);
  const assembly = await ev(auditExpr('#game'));

  report.push({ viewport: `${w}x${h}`, hangar, museumTop, museumBottom, briefing, assembly });
}

for (const r of report) {
  console.log(`\n=== ${r.viewport} ===`);
  const hg = r.hangar;
  console.log(`hangar scale=${hg.scale} body=${hg.bodyW}x${hg.bodyH} avail=${hg.availW}x${hg.availH} overflowX=${hg.docOverflowX}`);
  console.log(`  layout: display=${hg.display} landscape=${hg.landscape} parts=${JSON.stringify(hg.parts)} raw=${JSON.stringify(hg.raw)}`);
  console.log(`  minText: ${fmtText(hg.minText)}`);
  if (hg.smallText.length) console.log(`  <12px: ${fmtText(hg.smallText)}`);
  if (hg.smallTaps.length) console.log(`  taps<40: ${fmtTaps(hg.smallTaps)}`);
  for (const [name, m] of [['museum-top', r.museumTop], ['museum-bottom', r.museumBottom], ['briefing', r.briefing], ['assembly', r.assembly]]) {
    if (!m || m.missing) { console.log(`${name}: MISSING`); continue; }
    console.log(`  ${name} minText: ${fmtText(m.minText)}`);
    if (m.smallText.length) console.log(`  ${name} <12px: ${fmtText(m.smallText)}`);
    if (m.smallTaps.length) console.log(`  ${name} taps<40: ${fmtTaps(m.smallTaps)}`);
  }
}
console.log('\nERRORS:', errors.length ? errors : 'none');
ws.close();
try { process.kill(-chrome.pid); } catch {}
try { chrome.kill(); } catch {}
process.exit(0);
