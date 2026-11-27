/**
 * debug-rewards-ui.mjs — 「难度 → 课时奖励系统」无头 Chrome 截图验收。
 * 复用 3000 端口服务（只读；三个课时状态用 fetch 拦截模拟，不写玩家进度）。
 * 产出：.ui-shots/rewards-hangar-0.png / rewards-museum-0.png / rewards-museum-5.png / rewards-museum-2.png / rewards-hangar-full.png
 *
 * 验收点：
 *  1. 指挥官界面不再有难度选择器；右上角是最新目的地（奖励档位 → 目的地）；
 *  2. 博物馆「星球图鉴」（奖励系统已并入）14 张档位卡片 + 课时进度条（累计 0→26 课时、14 档刻度、跨档不归零）+ 下一份奖励提示；
 *  3. 星球图鉴未解锁卡片显示「完成 N 课时解锁」，下一站卡片显示「再完成 N 课时解锁」；
 *  4. 机库 / 博物馆无溢出，窄屏不错位。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const CHROME = 'C:\\Users\\panft\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9253;
const OUT = 'C:\\Codes\\star-pinyin\\.ui-shots';
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=' + PORT, '--window-size=820,1180', '--autoplay-policy=no-user-gesture-required',
  '--user-data-dir=C:\\Codes\\star-pinyin\\.chrome-debugRewards', 'http://127.0.0.1:3000/'], { stdio: 'ignore', detached: true });

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
  if (r.result?.data) { fs.writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.result.data, 'base64')); console.log('shot', name); }
  else errors.push('shot failed: ' + name);
};
const check = (name, cond) => { console.log((cond ? '  ✓ ' : '  ✗ ') + name); if (!cond) errors.push('check failed: ' + name); };

await send('Runtime.enable'); await send('Page.enable');

/** 每个场景：重新导航 → 静音 → 档案拦截（课时状态）→ 进入指挥中心。 */
async function fresh({ lessons, level }) {
  await send('Page.navigate', { url: 'http://127.0.0.1:3000/' }); await sleep(900);
  await ev(`window.__audio && Object.assign(window.__audio, { speakText(){}, slowSplit(){}, speakPinyin(){} })`);
  await ev(`(() => { const orig = window.fetch.bind(window); window.fetch = async (url, opts) => {
    const res = await orig(url, opts);
    if (String(url).startsWith('/api/profile')) {
      const p = await res.json();
      Object.assign(p, { lessonsCompleted: ${lessons}, rewardLevel: ${level} }); // 课时总数用真实档案，避免写死
      delete p.nextReward; // 客户端按课时自己算「下一份奖励」
      return new Response(JSON.stringify(p), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return res; }; })()`);
  await ev(`document.getElementById('enterBtn').click()`); await sleep(800);
}

const hangarMetrics = () => ev(`(() => { const h = document.getElementById('hangar'); const b = document.getElementById('hangarBody');
  const br = b.getBoundingClientRect();
  return { visualH: Math.round(br.height), availH: h.clientHeight, visualW: Math.round(br.width), availW: h.clientWidth }; })()`);
const cornerInfo = () => ev(`(() => { const el = document.getElementById('latestDest');
  const acts = document.querySelector('.hangar-actions');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const h = document.querySelector('.hangar-head').getBoundingClientRect();
  return { text: el.textContent.replace(/\\s+/g, ' '), title: el.title, empty: el.innerHTML.trim() === '',
    isLastAction: acts.lastElementChild === el, right: Math.round(r.right), top: Math.round(r.top),
    headTop: Math.round(h.top), headRight: Math.round(h.right), viewportW: innerWidth }; })()`);
const museumInfo = () => ev(`(() => {
  const tiers = [...document.querySelectorAll('.planet-grid .badge-card')];
  return {
    subtitle: [...document.querySelectorAll('.museum-subtitle')].map(s => s.textContent).find(t => t.startsWith('星球图鉴')),
    tierCount: tiers.length,
    done: tiers.filter(t => t.classList.contains('done')).length,
    current: tiers.filter(t => t.classList.contains('current')).map(t => t.textContent.replace(/\\s+/g, ' ')),
    next: tiers.filter(t => t.classList.contains('next')).map(t => t.textContent.replace(/\\s+/g, ' ')),
    progress: document.querySelector('.reward-progress')?.textContent.replace(/\\s+/g, ' ') || '',
    barPct: document.querySelector('.reward-bar i')?.style.width || '',
    planetLocked: [...document.querySelectorAll('.planet-grid .badge-card.locked')].map(c => ({ level: Number(c.dataset.level), text: c.querySelector('.badge-card-sum')?.textContent || '' })),
  }; })()`);

/* ---- 场景 1：0 课时（刚开局）---- */
console.log('\n[1] 0 课时 / Lv1 低空轨道');
await fresh({ lessons: 0, level: 1 });
const noDifficulty = await ev(`!document.getElementById('difficultySwitch') && document.querySelectorAll('.diff-btn').length === 0`);
check('指挥官界面已无难度选择器', noDifficulty === true);
const c1 = await cornerInfo();
check('右上角「最新目的地」= 低空轨道：' + c1?.text, c1?.text?.includes('最新目的地') && c1?.text?.includes('低空轨道'));
check('最新目的地位于机库顶栏最右（右上角）', c1?.isLastAction === true && Math.abs(c1?.right - c1?.headRight) <= 12 && c1?.top <= c1?.headTop + 70);
check('提示下一份奖励：' + c1?.title, /再完成 2 课时解锁 高空轨道/.test(c1?.title || ''));
const m1 = await hangarMetrics();
check('机库无溢出 ' + JSON.stringify(m1), m1.visualH <= m1.availH + 1 && m1.visualW <= m1.availW + 1);
await shot('rewards-hangar-0');

await ev(`document.getElementById('latestDest').click()`); await sleep(700);
const p1 = await museumInfo();
check('博物馆星球图鉴 14 档（奖励系统已并入）：' + p1.subtitle, p1.tierCount === 14 && p1.subtitle === '星球图鉴');
check('当前档 = 低空轨道：' + p1.current.join(' | '), p1.current.length === 1 && p1.current[0].includes('低空轨道'));
check('下一档 = 高空轨道：' + p1.next.join(' | '), p1.next.length === 1 && p1.next[0].includes('高空轨道'));
check('课时进度：' + p1.progress, /已完成课时0 \//.test(p1.progress) && /再完成 2 课时解锁/.test(p1.progress));
check('进度条宽度 0%：' + p1.barPct, p1.barPct === '0%');
// 星球图鉴里「没到访过且档位未解锁」的星球显示课时门槛（真实档案可能已到访过部分星球，
// 被到访点亮的档位不再锁定，故按每张卡自己的档位校验门槛，不写死「完成 2 课时」必须出现）
check('星球图鉴未解锁显示课时门槛：' + p1.planetLocked.slice(0, 2).map(c => c.text).join(' | '),
  p1.planetLocked.length > 0 && p1.planetLocked.every((c) => {
    const th = (c.level - 1) * 2; // 场景 1 = 0 课时：下一站卡显示「再完成 th 课时解锁」
    return c.text === `完成 ${th} 课时解锁` || c.text === `再完成 ${th} 课时解锁`;
  }));
await ev(`document.querySelector('.museum-overlay').scrollTop = 0`); await sleep(200);
await shot('rewards-museum-0');
await ev(`document.querySelector('.museum-overlay .phys-btn')?.click()`); await sleep(300);

/* ---- 场景 2：5 课时 / Lv3 远地轨道（差 1 课时解锁月球）---- */
console.log('\n[2] 5 课时 / Lv3 远地轨道');
await fresh({ lessons: 5, level: 3 });
const c2 = await cornerInfo();
check('右上角 = 远地轨道：' + c2?.text, c2?.text?.includes('远地轨道'));
check('提示还差 1 课时解锁月球：' + c2?.title, /再完成 1 课时解锁 月球/.test(c2?.title || ''));
await shot('rewards-hangar-5');
await ev(`document.getElementById('museumBtn').click()`); await sleep(700);
const p2 = await museumInfo();
check('已完成 2 档 + 当前 1 档：' + `done=${p2.done} current=${p2.current.length}`, p2.done === 2 && p2.current.length === 1);
check('当前档 = 远地轨道：' + p2.current.join(' | '), p2.current[0]?.includes('远地轨道'));
check('下一档 = 月球：' + p2.next.join(' | '), p2.next[0]?.includes('月球'));
check('进度 5 / 总课时：' + p2.progress, /已完成课时5 \//.test(p2.progress));
check('进度条 19%（累计 5/26 课时）：' + p2.barPct, p2.barPct === '19%');
await ev(`document.querySelector('.museum-overlay').scrollTop = 0`); await sleep(200);
await shot('rewards-museum-5');
await ev(`document.querySelector('.museum-overlay .phys-btn')?.click()`); await sleep(300);

/* ---- 场景 2b：2 课时 / Lv2 高空轨道（恰好跨过门槛：进度条不归零）---- */
console.log('\n[2b] 2 课时 / Lv2 高空轨道（恰好解锁档位）');
await fresh({ lessons: 2, level: 2 });
await ev(`document.getElementById('museumBtn').click()`); await sleep(700);
const p2b = await museumInfo();
check('已完成课时 2：' + p2b.progress, /已完成课时2 \//.test(p2b.progress));
check('恰好解锁档位进度条不归零（累计 2/26 ≈ 8%）：' + p2b.barPct, p2b.barPct === '8%');
check('下一档 = 远地轨道：' + p2b.next.join(' | '), p2b.next.length === 1 && p2b.next[0].includes('远地轨道'));
await ev(`document.querySelector('.museum-overlay').scrollTop = 0`); await sleep(200);
await shot('rewards-museum-2');
await ev(`document.querySelector('.museum-overlay .phys-btn')?.click()`); await sleep(300);

/* ---- 场景 3：26 课时 / Lv14 星际空间（满档）---- */
console.log('\n[3] 26 课时 / Lv14 星际空间');
await fresh({ lessons: 26, level: 14 });
const c3 = await cornerInfo();
check('右上角 = 星际空间：' + c3?.text, c3?.text?.includes('星际空间'));
check('满档提示：' + c3?.title, /全部星际目的地已解锁/.test(c3?.title || ''));
await shot('rewards-hangar-full');
await ev(`document.getElementById('latestDest').click()`); await sleep(700);
const p3 = await museumInfo();
check('满档：13 完成 + 1 当前：' + `done=${p3.done}`, p3.done === 13 && p3.current.length === 1);
check('满档进度 26 / 总课时 + 全部解锁：' + p3.progress, /已完成课时26 \//.test(p3.progress) && p3.progress.includes('全部星际目的地已解锁'));
check('进度条 100%：' + p3.barPct, p3.barPct === '100%');
await shot('rewards-museum-full');
await ev(`document.querySelector('.museum-overlay .phys-btn')?.click()`); await sleep(300);

/* ---- 场景 4：窄屏（手机竖屏）不错位 ---- */
console.log('\n[4] 窄屏 390×844');
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await sleep(400);
await fresh({ lessons: 5, level: 3 });
const narrow = await cornerInfo();
const m4 = await hangarMetrics();
check('窄屏最新目的地仍可见且在右上：' + narrow?.text, narrow && narrow.text.includes('远地轨道') && narrow.right <= narrow.viewportW);
check('窄屏机库无溢出 ' + JSON.stringify(m4), m4.visualH <= m4.availH + 1 && m4.visualW <= m4.availW + 1);
await shot('rewards-hangar-narrow');
await send('Emulation.clearDeviceMetricsOverride'); await sleep(200);

console.log('\nERRORS:', errors.length ? errors : 'none');
ws.close(); try { process.kill(-chrome.pid); } catch {} try { chrome.kill(); } catch {}
process.exit(errors.length ? 1 : 0);
