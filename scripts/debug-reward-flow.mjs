/**
 * debug-reward-flow.mjs — 课时奖励结算界面验收（无头 Chrome，只读 + fetch 拦截）。
 * 不写玩家进度：/api/progress/record 用拦截返回「补完一课 + 跨档解锁月球」的结果，
 * /api/profile 模拟 5 课时（Lv3 远地轨道）。
 * 产出：.ui-shots/rewards-completion.png
 *
 * 验收点：结算页只保留顶部目的地（远地轨道）+ 汉字+拼音卡片 + 按钮；
 *        课时奖励（完成课时 / 新目的地解锁 / 课时进度 / 火箭徽章 / 累计发射）全部不展示；
 *        卡片占游戏画面 ≥30%；发射 canvas 已清理；无 JS 异常。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const CHROME = 'C:\\Users\\panft\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9255;
const OUT = 'C:\\Codes\\star-pinyin\\.ui-shots';
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=' + PORT, '--window-size=' + (process.env.WINDOW_SIZE || '820,1180'), '--autoplay-policy=no-user-gesture-required',
  '--user-data-dir=C:\\Codes\\star-pinyin\\.chrome-debugRewardFlow', 'http://127.0.0.1:3000/'], { stdio: 'ignore', detached: true });

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
const mouse = (type, x, y) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 });
async function tap(x, y) { await mouse('mousePressed', x, y); await sleep(25); await mouse('mouseReleased', x, y); }
async function drag(fx, fy, tx, ty) {
  await mouse('mousePressed', fx, fy); await sleep(80);
  for (let i = 1; i <= 6; i++) { await mouse('mouseMoved', fx + (tx - fx) * i / 6, fy + (ty - fy) * i / 6); await sleep(25); }
  await mouse('mouseReleased', tx, ty); await sleep(380);
}
const rect = (sel) => ev(`(() => { const e = document.querySelector('${sel}'); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 }; })()`);
const modCenter = (g, v) => ev(`(() => { const e = [...document.querySelectorAll('.module')].find(m => m.dataset.group === '${g}' && m.dataset.value === '${v}'); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 }; })()`);
const waitFor = async (sel, ms = 6000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await ev(`!!document.querySelector('${sel}')`)) return true; await sleep(120); } return false; };

await send('Runtime.enable'); await send('Page.enable'); await sleep(900);
await ev(`window.__audio && Object.assign(window.__audio, { speakText(){}, slowSplit(){}, speakPinyin(){} })`);
// 拦截：进度上报返回「补完一课 + 解锁月球」，档案固定 5 课时（Lv3 远地轨道）
await ev(`(() => { const orig = window.fetch.bind(window);
  window.__lessonTotal = 0;
  orig('/api/profile').then((r) => r.json()).then((p) => { window.__lessonTotal = p.lessonsTotal || 0; }).catch(() => {});
  const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } });
  window.fetch = async (url, opts) => {
    const u = String(url);
    if (u.startsWith('/api/progress/record')) {
      return json({ ok: true, perfect: true, totalLaunches: 12, newlyUnlockedBadges: [],
        destinationId: 'earth_far', firstVisit: true, visitedDestinations: { earth_far: 1 },
        lessonCompleted: { grade: 1, term: 1, seq: 2, no: 2, kind: '识字', unit: 1, title: '金木水火土' },
        lessonsCompleted: 6, lessonsTotal: window.__lessonTotal || 0, rewardLevel: 4,
        newlyReachedDestination: { id: 'moon', name: '月球', icon: '🌙', rewardTitle: '抵达月球' } });
    }
    if (u.startsWith('/api/profile')) {
      const p = await (await orig(url, opts)).json();
      Object.assign(p, { lessonsCompleted: 5, rewardLevel: 3 });
      delete p.nextReward;
      return json(p);
    }
    return orig(url, opts);
  }; })()`);
await ev(`document.getElementById('enterBtn').click()`); await sleep(400);
await ev(`window.__fxTimeScale = 12`);

const destText = await ev(`document.getElementById('latestDest')?.textContent.replace(/\\s+/g, ' ') || ''`);
check('机库最新目的地 = 远地轨道（5 课时 / Lv3）：' + destText, destText.includes('远地轨道'));

await ev(`window.__debugStart('m_011')`); await sleep(350);
await ev(`document.querySelector('#game .briefing .phys-btn.primary')?.click()`); await sleep(350);
const m = await ev(`window.__currentMission`);
for (const g of ['initial', 'medial', 'final']) {
  const v = m.parts[g];
  const mc = await modCenter(g, v); const sc = await rect(`.slot[data-slot="${g}"] .slot-hit`);
  if (!mc || !sc) { errors.push(`missing module/slot ${g}=${v}`); continue; }
  await drag(mc.x, mc.y, sc.x, sc.y);
}
check('组装完成进入声调校准', await waitFor('.tone', 4000));
const toneBtn = await rect(`.curve-btn[data-tone="${m.tone}"]`);
check('声调按钮存在', !!toneBtn);
if (toneBtn) await tap(toneBtn.x, toneBtn.y);
check('结算页出现', await waitFor('.reward', 12000));
await sleep(300);

const info = await ev(`(() => {
  const card = document.querySelector('.completion-card');
  const game = document.getElementById('game');
  const cr = card && card.getBoundingClientRect();
  const gr = game && game.getBoundingClientRect();
  const ratio = cr && gr && gr.width * gr.height > 0 ? (cr.width * cr.height) / (gr.width * gr.height) : 0;
  const rewardSel = ['.reward-dest', '.reward-fact', '.reward-lesson', '.reward-next-dest', '.reward-lesson-progress', '.reward-badge', '.reward-next'];
  return {
    tag: document.querySelector('.completion-tag')?.textContent || '',
    hanzi: document.querySelector('.completion-hanzi')?.textContent || '',
    pinyin: document.querySelector('.completion-pinyin')?.textContent || '',
    cardW: cr ? Math.round(cr.width) : 0, cardH: cr ? Math.round(cr.height) : 0,
    gameW: gr ? Math.round(gr.width) : 0, gameH: gr ? Math.round(gr.height) : 0,
    ratio: Math.round(ratio * 1000) / 1000,
    rewardLeftovers: rewardSel.filter((s) => document.querySelector(s)),
    canvas: document.querySelectorAll('.launch-canvas').length,
  };
})()`);
check('结算目的地 = 最新目的地（远地轨道）：' + info.tag, info.tag.includes('远地轨道'));
check('汉字+拼音卡片：' + info.hanzi + ' / ' + info.pinyin, !!info.hanzi && !!info.pinyin);
check('课时奖励已全部移除（残留：' + (info.rewardLeftovers.join(',') || '无') + '）', info.rewardLeftovers.length === 0);
check('卡片占画面 ≥30%：' + info.cardW + '×' + info.cardH + ' / ' + info.gameW + '×' + info.gameH + ' = ' + (info.ratio * 100).toFixed(1) + '%', info.ratio >= 0.30);
check('发射 canvas 已清理', info.canvas === 0);
await shot(process.env.SHOT_NAME || 'rewards-completion');

console.log('\nERRORS:', errors.length ? errors : 'none');
ws.close(); try { process.kill(-chrome.pid); } catch {} try { chrome.kill(); } catch {}
process.exit(errors.length ? 1 : 0);
