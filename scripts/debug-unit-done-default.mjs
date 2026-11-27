/**
 * debug-unit-done-default.mjs — 单元完成结算默认选项验收（无头 Chrome，只读 + fetch 拦截）。
 * 不写玩家进度：/api/progress/record 拦截返回 fabricated unitSession（done / ongoing / none 三场景），
 * /api/unit/select 拦截（「再练一遍」也不落盘）。
 * 产出：.ui-shots/unit-done-default.png / unit-ongoing-default.png
 *
 * 验收点：
 *  1) 单元已完成（🎉 本单元完成！）→ 默认（primary）=「返回指挥中心」(#backHangar)，
 *     「再练一遍 ↻」(#nextMission) 为次选项；点默认 → 回到机库（指挥中心）画面。
 *  2) 单元进行中 → 默认仍为「下一题 ▸」(#nextMission)，「机库」(#backHangar) 次选项（原行为不变）。
 *  3) 非单元题 → 同 2。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const CHROME = 'C:\\Users\\panft\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9257;
const OUT = 'C:\\Codes\\star-pinyin\\.ui-shots';
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=' + PORT, '--window-size=' + (process.env.WINDOW_SIZE || '820,1180'), '--autoplay-policy=no-user-gesture-required',
  '--user-data-dir=C:\\Codes\\star-pinyin\\.chrome-debugUnitDoneDefault', 'http://127.0.0.1:3000/'], { stdio: 'ignore', detached: true });

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

await send('Runtime.enable'); await send('Page.enable');

/** 每个场景：重新导航 → 静音 → fetch 拦截（按场景伪造 unitSession）→ 进入指挥中心。 */
async function setup(scenario) {
  await send('Page.navigate', { url: 'http://127.0.0.1:3000/' });
  await sleep(1200);
  await ev(`window.__audio && Object.assign(window.__audio, { speakText(){}, slowSplit(){}, speakPinyin(){} })`);
  await ev(`(() => { const orig = window.fetch.bind(window);
    const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } });
    const us = ${JSON.stringify(scenario === 'none' ? null : {
      grade: 1, term: 1, seq: 2, label: '一年级上册 · 识字2《金木水火土》',
      cursor: scenario === 'done' ? 15 : 3, total: 15, kind: 'review',
      done: scenario === 'done', wrong: false, fixes: 0,
    })};
    window.fetch = async (url, opts) => {
      const u = String(url);
      if (u.startsWith('/api/progress/record')) {
        return json({ ok: true, perfect: true, totalLaunches: 12, newlyUnlockedBadges: [],
          destinationId: 'earth_far', unitSession: us });
      }
      if (u.startsWith('/api/unit/select')) return json({ ok: true, session: us });
      return orig(url, opts);
    }; })()`);
  await ev(`document.getElementById('enterBtn').click()`); await sleep(400);
  await ev(`window.__fxTimeScale = 12`);
}

/** 强制开一局 → 简报 → 组装 → 声调 → 结算。 */
async function playToReward() {
  await ev(`window.__debugStart('m_011')`); await sleep(350);
  await ev(`document.querySelector('#game .briefing .phys-btn.primary')?.click()`); await sleep(350);
  const m = await ev(`window.__currentMission`);
  for (const g of ['initial', 'medial', 'final']) {
    const v = m.parts[g];
    if (!v) continue;
    const mc = await modCenter(g, v); const sc = await rect(`.slot[data-slot="${g}"] .slot-hit`);
    if (!mc || !sc) continue; // 介母自动预装等场景：缺模块/槽位即跳过
    await drag(mc.x, mc.y, sc.x, sc.y);
  }
  if (!await waitFor('.tone', 5000)) { errors.push('未进入声调校准'); return false; }
  const toneBtn = await rect(`.curve-btn[data-tone="${m.tone}"]`);
  if (!toneBtn) { errors.push('声调按钮缺失'); return false; }
  await tap(toneBtn.x, toneBtn.y);
  if (!await waitFor('.reward', 15000)) { errors.push('未出现结算页'); return false; }
  await sleep(300);
  return true;
}

const buttons = () => ev(`(() => {
  const b = document.getElementById('backHangar');
  const n = document.getElementById('nextMission');
  return {
    backLabel: b?.textContent.trim() || '', backPrimary: !!b?.classList.contains('primary'),
    nextLabel: n?.textContent.trim() || '', nextPrimary: !!n?.classList.contains('primary'),
    banner: !!document.querySelector('.completion-banner'),
  };
})()`);

/* ---------- 1) 单元已完成：默认 = 返回指挥中心 ---------- */
console.log('\n[1] 单元已完成 → 默认选项「返回指挥中心」');
await setup('done');
if (await playToReward()) {
  const b = await buttons();
  check('完成横幅出现', b.banner);
  check('主按钮 = 返回指挥中心：' + b.backLabel, b.backPrimary && b.backLabel === '返回指挥中心');
  check('次选项 = 再练一遍 ↻：' + b.nextLabel, !b.nextPrimary && b.nextLabel === '再练一遍 ↻');
  await shot('unit-done-default');
  await ev(`document.getElementById('backHangar').click()`); await sleep(600);
  const home = await ev(`(() => ({ hangar: !document.getElementById('hangar').hidden, game: !document.getElementById('game').hidden }))()`);
  check('点默认 → 回到指挥中心（机库画面）', home.hangar && !home.game);
}

/* ---------- 2) 单元进行中：默认仍 = 下一题（原行为不变） ---------- */
console.log('\n[2] 单元进行中 → 默认仍「下一题 ▸」');
await setup('ongoing');
if (await playToReward()) {
  const b = await buttons();
  check('无完成横幅', !b.banner);
  check('主按钮 = 下一题 ▸：' + b.nextLabel, b.nextPrimary && b.nextLabel === '下一题 ▸');
  check('次选项 = 机库：' + b.backLabel, !b.backPrimary && b.backLabel === '机库');
  await shot('unit-ongoing-default');
}

/* ---------- 3) 非单元题：默认仍 = 下一题 ---------- */
console.log('\n[3] 非单元题 → 默认仍「下一题 ▸」');
await setup('none');
if (await playToReward()) {
  const b = await buttons();
  check('主按钮 = 下一题 ▸：' + b.nextLabel, b.nextPrimary && b.nextLabel === '下一题 ▸');
  check('次选项 = 机库：' + b.backLabel, !b.backPrimary && b.backLabel === '机库');
}

console.log('\nERRORS:', errors.length ? errors : 'none');
ws.close(); try { process.kill(-chrome.pid); } catch {} try { chrome.kill(); } catch {}
process.exit(errors.length ? 1 : 0);