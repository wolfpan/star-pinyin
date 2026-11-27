/**
 * preview-b-candy-variants.mjs — 第二套皮肤改版候选：沿用星云乐园的玩具糖果设计语言
 * （大圆角 / 2px 描边 / 按压硬阴影 / 糖果分类色 / 氛围渐变底），换其他色系 + 偏亮护眼底。
 * 候选：mint 薄荷汽水 / peach 蜜桃奶油 / sky 天空积木。
 * 用法：node scripts/preview-b-candy-variants.mjs
 * 输出：.ui-shots/daylight2-{mint,peach,sky}.png；临时产物 design-mocks/preview-b2-*.{html,css}
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'C:\\Codes\\star-pinyin';
const MOCKS = path.join(ROOT, 'design-mocks');
const OUT = path.join(ROOT, '.ui-shots');
const CHROME = 'C:\\Users\\panft\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9253;
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const baseHtml = fs.readFileSync(path.join(MOCKS, 'mock-b.html'), 'utf8');

/* 糖果色（与星云同语言）：亮色做填充/圆点，深色做亮底上的文字 */
const CANDY = {
  coral: '#ff7a8a', coralDeep: '#d94f63',
  mint: '#4fe3c1', mintDeep: '#0e8f74',
  sunny: '#ffd166', sunnyDeep: '#a06e00',
  sky: '#6fc3ff', skyDeep: '#2b76ad',
};

const VARIANTS = [
  {
    key: 'mint', name: '候选 1 · 薄荷汽水', en: 'MINT SODA',
    desc: '星云式玩具糖果语言 + 薄荷绿色系：浅薄荷纸底、糖果按压按钮、大圆角，偏亮护眼。',
    bodyBg: '#d9ece2', headBg: '#f7fcf9', cap: '#5f7d72',
    glows: ['rgba(79, 227, 193, .20)', 'rgba(111, 195, 255, .16)', 'rgba(255, 209, 102, .18)'],
    grad: ['#f1fbf6', '#e4f4eb 45%', '#d9ece2'],
    ink: '#143830', inkDim: '#4c6b60', enColor: '#7d9a8e',
    card: '#fbfefc', edge: '#bfe3d2', shadow: 'rgba(20, 56, 48, .10)',
    accentDeep: '#0e8f74',
    launch: ['#6fe0c0', '#2bbf9e'], launchHard: '#1e8f74', launchInk: '#0b3d31', launchGlow: 'rgba(43, 191, 158, .30)', launchEn: '#eafff7',
    avatar: ['#6fe0c0', '#2bbf9e'], avatarInk: '#0b3d31',
    step: ['#1e9f80', '#2b76ad'],
    tower: '#7fc4ad', towerEdge: '#5aa88f', towerArm: '#93cfbb', towerBrace: '#6bb59c',
    pad: '#6fa894', flange: '#5f8f7d', hullEdge: '#23433a', bezel: '#8fbcae',
    slotBg: '#fbfefc', slotEdge: '#7fb5a2', slotLabel: '#143830', slotQ: '#0e8f74', slotLocked: '#4c6b60',
    glow: 'rgba(43, 191, 158, .25)',
  },
  {
    key: 'peach', name: '候选 2 · 蜜桃奶油', en: 'PEACH CREAM',
    desc: '星云式玩具糖果语言 + 蜜桃粉色系：奶油蜜桃底、草莓按压按钮、大圆角，偏亮护眼。',
    bodyBg: '#f3ddcd', headBg: '#fffaf5', cap: '#8a6a58',
    glows: ['rgba(255, 157, 107, .22)', 'rgba(255, 122, 138, .16)', 'rgba(255, 209, 102, .20)'],
    grad: ['#fdf6ef', '#fbeade 45%', '#f3ddcd'],
    ink: '#4a2b1e', inkDim: '#7a5c4a', enColor: '#a18672',
    card: '#fffaf5', edge: '#f0d4bf', shadow: 'rgba(74, 43, 30, .10)',
    accentDeep: '#d94f63',
    launch: ['#ff9d8a', '#f2697c'], launchHard: '#c94f60', launchInk: '#fff', launchGlow: 'rgba(242, 105, 124, .30)', launchEn: '#ffe1e6',
    avatar: ['#ff9d8a', '#f2697c'], avatarInk: '#fff',
    step: ['#e05a6d', '#d96a35'],
    tower: '#e0a183', towerEdge: '#c07f5f', towerArm: '#ecb49b', towerBrace: '#cf8f6d',
    pad: '#c98f6f', flange: '#a8765a', hullEdge: '#4a2b1e', bezel: '#d9a68c',
    slotBg: '#fffaf5', slotEdge: '#d9a68c', slotLabel: '#4a2b1e', slotQ: '#d94f63', slotLocked: '#7a5c4a',
    glow: 'rgba(242, 105, 124, .25)',
  },
  {
    key: 'sky', name: '候选 3 · 天空积木', en: 'SKY BLOCKS',
    desc: '星云式玩具糖果语言 + 天空蓝色系：浅天蓝底、天蓝按压按钮、大圆角，偏亮护眼。',
    bodyBg: '#d5e7f5', headBg: '#fbfdff', cap: '#5a7488',
    glows: ['rgba(111, 195, 255, .24)', 'rgba(79, 227, 193, .16)', 'rgba(255, 209, 102, .18)'],
    grad: ['#f3faff', '#e4f1fb 45%', '#d5e7f5'],
    ink: '#16324a', inkDim: '#4a6478', enColor: '#7d94a6',
    card: '#fbfdff', edge: '#bcd9ef', shadow: 'rgba(22, 50, 74, .10)',
    accentDeep: '#2b76ad',
    launch: ['#7cc4ff', '#3d9be0'], launchHard: '#2b76ad', launchInk: '#fff', launchGlow: 'rgba(61, 155, 224, .30)', launchEn: '#e3f2ff',
    avatar: ['#7cc4ff', '#3d9be0'], avatarInk: '#fff',
    step: ['#2b76ad', '#1e8f74'],
    tower: '#8fb8d9', towerEdge: '#6a96bb', towerArm: '#a5c6e2', towerBrace: '#7ba6c8',
    pad: '#7fa3c4', flange: '#64809c', hullEdge: '#16324a', bezel: '#9dbdd8',
    slotBg: '#fbfdff', slotEdge: '#8fb8d9', slotLabel: '#16324a', slotQ: '#2b76ad', slotLocked: '#4a6478',
    glow: 'rgba(61, 155, 224, .25)',
  },
];

function css(v) {
  const c = CANDY;
  return `/* ${v.name} — 星云式玩具糖果语言 / ${v.en} / 偏亮护眼 */
:root {
  --ink: ${v.ink}; --ink-dim: ${v.inkDim};
  --coral: ${c.coral}; --mint: ${c.mint}; --sunny: ${c.sunny}; --sky: ${c.sky};
  --card-bg: ${v.card}; --card-edge: ${v.edge};
  /* SVG 火箭（不锈钢保持金属感，塔架随色系） */
  --st1: #6a7684; --st2: #c6cfd9; --st3: #f6f9fc; --st4: #b4bec9; --st5: #59636f;
  --sd1: #4a545f; --sd2: #8b95a1; --sd3: #b9c2cc; --sd4: #77818d; --sd5: #39424d;
  --nz1: #39424d; --nz2: #171c24;
  --tile-a: #232a34; --tile-b: #39424e;
  --tower: ${v.tower}; --tower-edge: ${v.towerEdge}; --tower-arm: ${v.towerArm}; --tower-brace: ${v.towerBrace};
  --pad: ${v.pad}; --flange: ${v.flange}; --hull-edge: ${v.hullEdge}; --bezel: ${v.bezel};
  --glow: ${v.glow}; --beacon: ${c.coral};
  --slot-bg: ${v.slotBg}; --slot-edge: ${v.slotEdge};
  --slot-label: ${v.slotLabel}; --slot-q: ${v.slotQ}; --slot-locked: ${v.slotLocked};
}
body { background: ${v.bodyBg}; }
.mock-head { background: ${v.headBg}; border-color: ${v.edge}; }
.mock-name { color: ${v.ink}; }
.mock-name em { color: ${v.accentDeep}; opacity: .9; }
.mock-desc { color: ${v.inkDim}; }
.frame-cap { background: ${v.bodyBg}; color: ${v.cap}; }

.frame { background:
  radial-gradient(700px 420px at 85% 8%, ${v.glows[0]}, transparent 65%),
  radial-gradient(800px 520px at 8% 92%, ${v.glows[1]}, transparent 60%),
  radial-gradient(1000px 700px at 50% 45%, ${v.glows[2]}, transparent 70%),
  linear-gradient(160deg, ${v.grad[0]}, ${v.grad[1]}, ${v.grad[2]});
  color: ${v.ink}; }
/* 糖果纸屑点缀（亮底版星星） */
.frame::before { content: ''; position: absolute; inset: 0; pointer-events: none; background-image:
  radial-gradient(2.5px 2.5px at 12% 20%, rgba(255, 122, 138, .40), transparent 100%),
  radial-gradient(2px 2px at 30% 70%, rgba(79, 227, 193, .40), transparent 100%),
  radial-gradient(2.5px 2.5px at 55% 15%, rgba(255, 209, 102, .45), transparent 100%),
  radial-gradient(2px 2px at 72% 55%, rgba(111, 195, 255, .40), transparent 100%),
  radial-gradient(2.5px 2.5px at 90% 30%, rgba(255, 122, 138, .35), transparent 100%),
  radial-gradient(2px 2px at 44% 88%, rgba(79, 227, 193, .35), transparent 100%),
  radial-gradient(2px 2px at 8% 52%, rgba(255, 209, 102, .40), transparent 100%),
  radial-gradient(2.5px 2.5px at 66% 82%, rgba(111, 195, 255, .35), transparent 100%); }
.frame-tag { color: ${v.accentDeep}; }

.panel, .tray { background: var(--card-bg); border: 2px solid var(--card-edge); border-radius: 22px; box-shadow: 0 4px 0 ${v.shadow}; }
.h-id .avatar { background: linear-gradient(135deg, ${v.avatar[0]}, ${v.avatar[1]}); color: ${v.avatarInk}; border: 3px solid rgba(255, 255, 255, .65); box-shadow: 0 4px 0 ${v.shadow}; }
.callsign { color: ${v.ink}; }
.stat-chip { border: 2px solid var(--card-edge); border-radius: 999px; background: ${v.card}; color: ${v.inkDim}; box-shadow: 0 3px 0 ${v.shadow}; }
.stat-chip b { color: ${v.accentDeep}; }
.stat-chip .ic { color: ${c.coralDeep}; }
.btn.ghost { border: 2px solid var(--card-edge); border-radius: 999px; background: ${v.card}; color: ${v.ink}; box-shadow: 0 3px 0 ${v.shadow}; }
.btn.ghost .ic { color: ${c.skyDeep}; }
.btn.dest { border: 2px solid rgba(111, 195, 255, .55); border-radius: 16px; background: rgba(111, 195, 255, .14); color: ${v.ink}; box-shadow: 0 3px 0 ${v.shadow}; }
.dest-k { color: ${c.skyDeep}; font-weight: 700; }
.dest-v .ic { color: ${c.mintDeep}; }

.p-title { color: ${v.ink}; }
.step-num { background: linear-gradient(135deg, ${v.step[0]}, ${v.step[1]}); color: #fff; border-radius: 10px; box-shadow: 0 3px 0 ${v.shadow}; }
.p-en { color: ${v.enColor}; }
.tb-status { color: ${v.inkDim}; }
.tb-status .ic { color: ${c.sunnyDeep}; }
.tb-status b { color: ${c.sunnyDeep}; }

.btn.grade, .btn.term, .btn.lesson { border: 2px solid var(--card-edge); border-radius: 14px; background: ${v.card}; color: ${v.inkDim}; box-shadow: 0 3px 0 ${v.shadow}; }
.btn.grade.sel { background: ${c.sunny}; border-color: #ffe49a; color: #4a3208; box-shadow: 0 4px 0 #c99b3f; }
.btn.term.sel { background: ${c.sunny}; border-color: #ffe49a; color: #4a3208; box-shadow: 0 4px 0 #c99b3f; }
.btn.lesson.sel { background: ${c.sky}; border-color: #a5d9ff; color: #0d3a5c; box-shadow: 0 4px 0 #3d84bd; }
.btn.lesson.sel span { opacity: .8; }
.btn.auto-tag { border: 2px solid var(--card-edge); border-radius: 999px; color: ${v.inkDim}; background: ${v.card}; box-shadow: 0 3px 0 ${v.shadow}; }
.btn.auto-tag .ic { color: ${c.mintDeep}; }

.current-rocket { background: ${v.card}; border: 2px solid rgba(255, 209, 102, .55); border-radius: 18px; box-shadow: 0 4px 0 ${v.shadow}; }
.cr-meta b { color: ${v.ink}; }
.cr-meta span { color: ${v.inkDim}; }
.cr-flag { background: ${c.coral}; color: #fff; border-radius: 999px; box-shadow: 0 3px 0 rgba(217, 79, 99, .45); }
.hint { color: ${v.inkDim}; }
.btn.pick { border: 2px solid var(--card-edge); border-radius: 16px; background: ${v.card}; color: ${v.inkDim}; box-shadow: 0 3px 0 ${v.shadow}; }
.btn.pick.sel { border-color: ${c.sunny}; background: rgba(255, 209, 102, .18); color: ${v.ink}; box-shadow: 0 4px 0 #c99b3f; }
.unlock-badge { background: rgba(79, 227, 193, .16); border: 2px solid rgba(79, 227, 193, .5); color: ${c.mintDeep}; border-radius: 999px; }
.unlock-badge .ic { color: ${c.sunnyDeep}; }

.btn.launch { border-radius: 999px; color: ${v.launchInk}; background: linear-gradient(180deg, ${v.launch[0]}, ${v.launch[1]}); border: 3px solid rgba(255, 255, 255, .55); box-shadow: 0 6px 0 ${v.launchHard}, 0 12px 26px ${v.launchGlow}; text-shadow: 0 2px 0 rgba(0, 0, 0, .12); }
.btn.launch .en { color: ${v.launchEn}; opacity: .85; }

/* 组装：糖果发射场 */
.tray-head { border-bottom: 2px dashed ${v.edge}; }
.tray-head b { color: ${v.ink}; }
.tray-head span { color: ${v.enColor}; }
.g-initial .tg-dot { background: ${c.coral}; box-shadow: 0 0 8px ${c.coral}; }
.g-final .tg-dot { background: ${c.sky}; box-shadow: 0 0 8px ${c.sky}; }
.g-initial .tg-label { color: ${c.coralDeep}; }
.g-final .tg-label { color: ${c.skyDeep}; }
.part { border: 2px solid ${v.edge}; border-radius: 16px; background: linear-gradient(180deg, #ffffff, ${v.card}); color: ${v.ink}; box-shadow: 0 4px 0 ${v.shadow}; }
.g-initial .part { border-color: rgba(255, 122, 138, .6); }
.g-final .part { border-color: rgba(111, 195, 255, .6); }
.tray-hint { color: ${v.inkDim}; }
.slot-body { fill: var(--slot-bg); stroke: var(--slot-edge); }
.slot-group { fill: var(--slot-label); }
.slot-value { fill: var(--slot-q); }
.slot-value.locked-note { fill: var(--slot-locked); }
.slot-light { fill: ${v.bezel}; }
.beacon { filter: drop-shadow(0 0 6px ${c.coral}); }
`;
}

for (const v of VARIANTS) {
  fs.writeFileSync(path.join(MOCKS, `preview-b2-${v.key}.css`), css(v));
  const html = baseHtml
    .replace('href="theme-b.css"', `href="preview-b2-${v.key}.css"`)
    .replace(/<title>.*?<\/title>/, `<title>${v.name} · 第二套皮肤候选</title>`)
    .replace(/<div class="mock-name">.*?<\/div>/, `<div class="mock-name">${v.name}<em>${v.en}</em></div>`)
    .replace(/<div class="mock-desc">.*?<\/div>/, `<div class="mock-desc">${v.desc}</div>`);
  fs.writeFileSync(path.join(MOCKS, `preview-b2-${v.key}.html`), html);
}
console.log('variants written:', VARIANTS.map((v) => v.key).join(', '));

const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=' + PORT, '--window-size=1024,900', '--allow-file-access-from-files',
  '--user-data-dir=' + path.join(ROOT, '.chrome-previewCandy'), 'about:blank'], { stdio: 'ignore', detached: true });

async function newTarget(url) {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
      if (r.ok) return await r.json();
    } catch {}
    await sleep(250);
  }
  throw new Error('no target for ' + url);
}

for (const v of VARIANTS) {
  const url = 'file:///' + path.join(MOCKS, `preview-b2-${v.key}.html`).replace(/\\/g, '/');
  const t = await newTarget(url);
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  let idc = 0; const pending = new Map();
  ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  const send = (method, params = {}) => new Promise((res) => { const id = ++idc; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
  await send('Page.enable'); await send('Runtime.enable');
  await sleep(900);
  const h = (await send('Runtime.evaluate', { expression: 'document.body.scrollHeight', returnByValue: true })).result?.result?.value || 1688;
  await send('Emulation.setDeviceMetricsOverride', { width: 1024, height: h, deviceScaleFactor: 1, mobile: false });
  await sleep(300);
  const r = await send('Page.captureScreenshot', { format: 'png' });
  if (r.result?.data) {
    fs.writeFileSync(path.join(OUT, `daylight2-${v.key}.png`), Buffer.from(r.result.data, 'base64'));
    console.log('shot', `daylight2-${v.key}.png`, `1024x${h}`);
  } else console.error('shot failed', v.key);
  ws.close();
  try { await fetch(`http://127.0.0.1:${PORT}/json/close/${t.id}`); } catch {}
}
try { process.kill(-chrome.pid); } catch {} try { chrome.kill(); } catch {}
process.exit(0);