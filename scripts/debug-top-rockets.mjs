/**
 * debug-top-rockets.mjs — 「火箭与星体解耦 + 猎鹰21号/星舰9号」无头 Chrome 截图验收。
 * 复用 3000 端口服务（只读；早期/全收藏档案用 fetch 拦截模拟，不写玩家进度）。
 * 产出：.ui-shots/top-hangar.png / top-museum-locked.png / top-hangar-early.png / top-museum-full.png
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
const CHROME = 'C:\\Users\\panft\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9261;
const OUT = 'C:\\Codes\\star-pinyin\\.ui-shots';
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=' + PORT, '--window-size=820,1180', '--autoplay-policy=no-user-gesture-required',
  '--user-data-dir=C:\\Codes\\star-pinyin\\.chrome-debugTop', 'http://127.0.0.1:3000/'], { stdio: 'ignore', detached: true });

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
const check = (name, cond) => { console.log((cond ? '  ✓ ' : '  ✗ ') + name); if (!cond) errors.push('check failed: ' + name); };

await send('Runtime.enable'); await send('Page.enable');

/** 每个场景：重新导航 → 静音 → 可选档案拦截 → 进入指挥中心。 */
async function fresh(mockJs = null) {
  await send('Page.navigate', { url: 'http://127.0.0.1:3000/' }); await sleep(900);
  await ev(`window.__audio && Object.assign(window.__audio, { speakText(){}, slowSplit(){}, speakPinyin(){} })`);
  if (mockJs) await ev(mockJs);
  await ev(`document.getElementById('enterBtn').click()`); await sleep(800);
}
const hangarMetrics = () => ev(`(() => { const h = document.getElementById('hangar'); const b = document.getElementById('hangarBody');
  const br = b.getBoundingClientRect();
  return { visualH: Math.round(br.height), availH: h.clientHeight, visualW: Math.round(br.width), availW: h.clientWidth }; })()`);

/* ---- 场景 1：真实档案机库：简洁布局（无难度面板）+ 右上角最新目的地 + 下一枚火箭收藏进度 ---- */
console.log('\n[1] 真实档案机库（简洁布局）');
await fresh();
const noDifficulty = await ev(`!document.getElementById('difficultySwitch') && document.querySelectorAll('.diff-btn').length === 0`);
const corner = await ev(`(() => { const el = document.getElementById('latestDest');
  if (!el) return null;
  const acts = document.querySelector('.hangar-actions');
  const r = el.getBoundingClientRect();
  return { text: el.textContent.replace(/\\s+/g, ' '), title: el.title,
    isLastAction: acts.lastElementChild === el, right: Math.round(r.right), viewport: window.innerWidth,
    label: el.querySelector('.dest-corner-label')?.textContent }; })()`);
const nr = await ev(`document.getElementById('nextBadge')?.textContent || ''`);
check('难度选择器已从指挥官界面移除', noDifficulty === true);
check('右上角「最新目的地」：' + corner?.text, corner?.text?.includes('最新目的地') && corner?.label === '最新目的地');
check('最新目的地是机库顶栏最右侧元素（右上角）', corner?.isLastAction === true && corner?.right > corner?.viewport * 0.6);
check('「下一枚火箭」收藏进度（不绑定星球）：' + nr.replace(/\s+/g, ' ').trim(), nr.includes('火箭') && !nr.includes('之旅'));
const m1 = await hangarMetrics();
check('机库无溢出 ' + JSON.stringify(m1), m1.visualH <= m1.availH + 1 && m1.visualW <= m1.availW + 1);
await shot('top-hangar');

/* ---- 场景 2：真实档案博物馆：星球图鉴（课时奖励已并入）+ 概念旗舰压轴 ---- */
console.log('\n[2] 博物馆星球图鉴 + 火箭图鉴');
await ev(`document.getElementById('museumBtn').click()`); await sleep(700);
const rewardInfo = await ev(`(() => { const tiers = [...document.querySelectorAll('.planet-grid .badge-card')];
  return { subtitle: [...document.querySelectorAll('.museum-subtitle')].map(s => s.textContent).find(t => t.startsWith('星球图鉴')),
    count: tiers.length, current: tiers.filter(t => t.classList.contains('current')).length,
    texts: tiers.map(t => t.textContent.replace(/\\s+/g, ' ')),
    progress: document.querySelector('.reward-progress')?.textContent.replace(/\\s+/g, ' ') || '' }; })()`);
check('星球图鉴 14 档（奖励系统已并入）：' + rewardInfo.subtitle, rewardInfo.count === 14 && rewardInfo.subtitle === '星球图鉴');
check('恰好 1 档「当前」奖励', rewardInfo.current === 1);
check('卡片按档位标注 Lv：' + rewardInfo.texts.slice(0, 2).join(' | '), rewardInfo.texts[0].includes('Lv1') && rewardInfo.texts[1].includes('Lv2'));
check('课时进度条：' + rewardInfo.progress, /课时/.test(rewardInfo.progress));
await ev(`document.querySelector('.museum-overlay').scrollTop = 999999`); await sleep(400);
const lockedInfo = await ev(`(() => { const cards = [...document.querySelectorAll('.museum-grid:not(.planet-grid) .badge-card')];
  const last2 = cards.slice(-2).map(c => ({ id: c.dataset.id, locked: c.classList.contains('locked'), text: c.textContent.replace(/\\s+/g, ' ') }));
  return { count: cards.length, last2, subtitle: [...document.querySelectorAll('.museum-subtitle')].map(s => s.textContent).find(t => t.startsWith('火箭')) }; })()`);
check('火箭图鉴共 16 张：' + lockedInfo.subtitle, lockedInfo.count === 16);
const planetCount = await ev(`document.querySelectorAll('.planet-grid .badge-card').length`);
check('星球图鉴共 14 种（含地球三层轨道）', planetCount === 14);
check('压轴两张 = falcon_21 / starship_9', lockedInfo.last2[0]?.id === 'falcon_21' && lockedInfo.last2[1]?.id === 'starship_9');
// 真实档案可能已解锁（玩家进度推进）：锁定态显示门槛，解锁态显示座驾按钮，两者皆合法
const stateOk = lockedInfo.last2.every(c => c.text.includes('未来概念') && (c.locked ? /完成 4[25] 个单元解锁/.test(c.text) : /设为座驾|当前座驾/.test(c.text)));
check('概念标签 + 锁定门槛/解锁座驾：' + JSON.stringify(lockedInfo.last2.map(c => c.text)), stateOk);
await shot('top-museum-locked');
await ev(`document.querySelector('.museum-overlay .phys-btn')?.click()`); await sleep(300);

/* ---- 场景 3：早期档案（0 单元完成）：Lv1 低空轨道 + 火箭收藏进度 ---- */
console.log('\n[3] 早期档案（0 单元完成）');
await fresh(`(() => { const orig = window.fetch.bind(window); window.fetch = async (url, opts) => {
  const res = await orig(url, opts);
  if (String(url).startsWith('/api/profile')) {
    const p = await res.json();
    const starter = (p.badges || []).find((b) => b.starter || Number(b.unlockAt) === 0);
    const next = (p.badges || []).filter((b) => !(b.starter || Number(b.unlockAt) === 0)).sort((a, b) => a.unlockAt - b.unlockAt)[0] || null;
    Object.assign(p, { totalLaunches: 2, unlockedBadges: [starter.id], museum: [starter], ownedRockets: [starter],
      currentRocket: starter, rocketAuto: true, selectedRocketId: null, nextBadge: next, emergencyCount: 0,
      lessonsCompleted: 0, lessonsTotal: 180, rewardLevel: 1 });
    delete p.nextReward;
    return new Response(JSON.stringify(p), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  return res; }; })()`);
const nrEarly = await ev(`document.getElementById('nextBadge')?.textContent.replace(/\\s+/g, ' ') || ''`);
const destEarly = await ev(`document.getElementById('latestDest')?.textContent.replace(/\\s+/g, ' ') || ''`);
const destEarlyTitle = await ev(`document.getElementById('latestDest')?.title || ''`);
check('最新目的地 = 低空轨道（Lv1）：' + destEarly, destEarly.includes('低空轨道'));
check('提示下一份奖励还差课时：' + destEarlyTitle, /再完成 2 课时/.test(destEarlyTitle));
check('下一枚火箭 = 长征一号 · 再完成 3 个单元：' + nrEarly, nrEarly.includes('长征一号') && nrEarly.includes('再完成 3 个单元'));
const m3 = await hangarMetrics();
check('早期机库无溢出 ' + JSON.stringify(m3), m3.visualH <= m3.availH + 1 && m3.visualW <= m3.availW + 1);
await shot('top-hangar-early');

/* ---- 场景 4：全收藏档案（45 单元完成 / 26 课时）：概念旗舰已解锁，目的地已到星际空间 ---- */
console.log('\n[4] 全收藏档案（45 单元完成 / 26 课时）');
await fresh(`(() => { const orig = window.fetch.bind(window); window.fetch = async (url, opts) => {
  const res = await orig(url, opts);
  if (String(url).startsWith('/api/profile')) {
    const p = await res.json();
    const all = (p.badges || []).slice().sort((a, b) => (Number(a.unlockAt) || 0) - (Number(b.unlockAt) || 0));
    Object.assign(p, { totalLaunches: 45, unlockedBadges: all.map(b => b.id), museum: all, ownedRockets: all,
      currentRocket: all[all.length - 1], rocketAuto: true, selectedRocketId: null, nextBadge: null, emergencyCount: 0,
      lessonsCompleted: 45, lessonsTotal: 206, rewardLevel: 14 });
    delete p.nextReward;
    return new Response(JSON.stringify(p), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  return res; }; })()`);
const curName = await ev(`document.querySelector('#currentRocket b')?.textContent || ''`);
const doneText = await ev(`document.getElementById('nextBadge')?.textContent || ''`);
const destFull = await ev(`document.getElementById('latestDest')?.textContent.replace(/\\s+/g, ' ') || ''`);
check('自动座驾 = 星舰9号：' + curName, curName === '星舰9号');
check('火箭全部解锁提示：' + doneText.trim(), doneText.includes('火箭已全部解锁'));
check('满档目的地 = 星际空间：' + destFull, destFull.includes('星际空间'));
await ev(`document.getElementById('museumBtn').click()`); await sleep(700);
const fullReward = await ev(`(() => { const tiers = [...document.querySelectorAll('.planet-grid .badge-card')];
  return { done: tiers.filter(t => t.classList.contains('done')).length, current: tiers.filter(t => t.classList.contains('current')).length,
    currentText: tiers.find(t => t.classList.contains('current'))?.textContent.replace(/\\s+/g, ' '),
    nextText: document.querySelector('.reward-progress-next')?.textContent || '' }; })()`);
check('满档奖励：13 档已完成 + 1 档当前：' + fullReward.currentText, fullReward.done === 13 && fullReward.current === 1);
check('满档提示：' + fullReward.nextText, fullReward.nextText.includes('全部星际目的地已解锁'));
await ev(`document.querySelector('.museum-overlay').scrollTop = 999999`); await sleep(400);
const fullInfo = await ev(`(() => { const cards = [...document.querySelectorAll('.museum-grid:not(.planet-grid) .badge-card')];
  const last = cards[cards.length - 1]; const prev = cards[cards.length - 2];
  return { subtitle: [...document.querySelectorAll('.museum-subtitle')].map(s => s.textContent).find(t => t.startsWith('火箭')),
    lastId: last?.dataset.id, lastUnlocked: last?.classList.contains('unlocked'), lastText: last?.textContent.replace(/\\s+/g, ' '),
    prevId: prev?.dataset.id, prevUnlocked: prev?.classList.contains('unlocked') }; })()`);
check('火箭 16/16：' + fullInfo.subtitle, fullInfo.subtitle?.includes('16/16'));
check('星舰9号已解锁 + 未来概念标签：' + fullInfo.lastText, fullInfo.lastId === 'starship_9' && fullInfo.lastUnlocked && fullInfo.lastText.includes('未来概念'));
check('猎鹰21号已解锁', fullInfo.prevId === 'falcon_21' && fullInfo.prevUnlocked);
await shot('top-museum-full');

console.log('\nERRORS:', errors.length ? errors : 'none');
ws.close(); try { process.kill(-chrome.pid); } catch {} try { chrome.kill(); } catch {}
process.exit(errors.length ? 1 : 0);
