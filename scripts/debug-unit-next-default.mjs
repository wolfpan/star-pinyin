/**
 * debug-unit-next-default.mjs — 单元完成后指挥中心默认选中下一课 验收（无头 Chrome，只读 + fetch 拦截）。
 * 不写玩家进度：/api/progress/record、/api/unit/select、/api/profile 全部拦截伪造；
 * /api/textbook 透传真实目录（仅替换 selection），下一课逻辑用真实教材顺序。
 * 产出：.ui-shots/unit-next-default.png / unit-next-cross-book.png / unit-next-boot.png
 *
 * 验收点：
 *  1) 单元已完成 → 点「返回指挥中心」→ 机库默认选中下一课（芯片高亮 + 新题单，unit/select 落到下一课）。
 *  2) 单元进行中 → 点「机库」→ 不前进，仍停在当前课。
 *  3) 已是目录最后一课 → 完成后返回不前进（保持当前课，可复习重抽）。
 *  4) 上册最后一课完成 → 自动跨册选中下册第 1 课（学期芯片同步切换）。
 *  5) 做完单元后直接刷新重进（profile 里题单已完成）→ 进指挥中心即默认选中下一课。
 *  6) 家长在别处改过进度（selection 不在已完成课）→ 尊重其选择，不自动前进。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { flattenLessons } from '../public/js/textbook.js';

const CHROME = 'C:\\Users\\panft\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9258;
const OUT = 'C:\\Codes\\star-pinyin\\.ui-shots';
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 真实教材目录 → 计算边界课（最后一课 / 上册最后一课及其下一课）。 */
const catalog = (await (await fetch('http://127.0.0.1:3000/api/textbook')).json()).catalog;
const flat = flattenLessons(catalog);
const lastLesson = flat[flat.length - 1];
const g1t1 = flat.filter((l) => l.grade === 1 && l.term === 1);
const bookLast = g1t1[g1t1.length - 1];
const afterBook = flat[flat.indexOf(bookLast) + 1];
const pos = (l) => ({ grade: l.grade, term: l.term, seq: l.seq });
console.log('目录最后一课 =', pos(lastLesson), '；一上最后一课 =', pos(bookLast), '→ 下一课 =', pos(afterBook));

const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=' + PORT, '--window-size=' + (process.env.WINDOW_SIZE || '820,1180'), '--autoplay-policy=no-user-gesture-required',
  '--user-data-dir=C:\\Codes\\star-pinyin\\.chrome-debugUnitNextDefault', 'http://127.0.0.1:3000/'], { stdio: 'ignore', detached: true });

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

/** 伪造单元进度视图。 */
const usView = (l, cursor, total = 15) => ({
  grade: l.grade, term: l.term, seq: l.seq, label: `验收 · ${l.grade}-${l.term}-${l.seq}`,
  cursor, total, remaining: Math.max(0, total - cursor), done: cursor >= total,
  newCount: 6, reviewCount: 9,
});

/**
 * 每个场景：重新导航 → 静音 → fetch 拦截 → 进入指挥中心。
 * lesson   = 当前课；recordDone = 结算时伪造的题单状态（'done'/'ongoing'/null）；
 * profileDone = profile 里题单是否已完成（模拟做完后直接刷新）；selOverride = 家长改过的进度。
 */
async function setup({ lesson, recordDone = 'ongoing', profileDone = false, selOverride = null }) {
  await send('Page.navigate', { url: 'http://127.0.0.1:3000/' });
  await sleep(1200);
  await ev(`window.__audio && Object.assign(window.__audio, { speakText(){}, slowSplit(){}, speakPinyin(){} })`);
  const sel = selOverride || pos(lesson);
  const profile = {
    callsign: '验收指挥官', totalLaunches: 12, unlockedBadges: [], museum: [], badges: [],
    ownedRockets: [], rocketAuto: true, selectedRocketId: null, currentRocket: null, nextBadge: null,
    tagMastery: {}, emergencyCount: 0, lessonsCompleted: 4, lessonsTotal: 60,
    completedLessons: [`${lesson.grade}-${lesson.term}-${lesson.seq}`],
    rewardLevel: 2, currentDestination: null, nextReward: null, visitedDestinations: {},
    textbook: sel, unitSession: usView(lesson, profileDone ? 15 : 3),
    skin: 'hud', iconStyle: 'a', launchFx: 'always', launchedUnits: [], medialMode: 'required', unitTotal: 15,
  };
  const recordUs = recordDone === 'done' ? usView(lesson, 15) : recordDone === 'ongoing' ? usView(lesson, 4) : null;
  await ev(`(() => { const orig = window.fetch.bind(window);
    const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } });
    window.__unitSelects = [];
    const profile = ${JSON.stringify(profile)};
    const recordUs = ${JSON.stringify(recordUs)};
    const sel = ${JSON.stringify(sel)};
    window.fetch = async (url, opts) => {
      const u = String(url);
      if (u.startsWith('/api/progress/record')) {
        return json({ ok: true, perfect: true, totalLaunches: 12, newlyUnlockedBadges: [],
          destinationId: 'earth_far', unitSession: recordUs });
      }
      if (u.startsWith('/api/unit/select')) {
        const b = JSON.parse(opts.body); window.__unitSelects.push(b);
        return json({ ok: true, session: { grade: b.grade, term: b.term, seq: b.seq, label: '验收新课',
          cursor: 0, total: 15, remaining: 15, done: false, newCount: 6, reviewCount: 9 },
          selection: { grade: b.grade, term: b.term, seq: b.seq }, poolSize: 120 });
      }
      if (u.startsWith('/api/profile')) return json(profile);
      if (u === '/api/textbook' || u.startsWith('/api/textbook?')) {
        const d = await (await orig(url, opts)).json();
        d.selection = sel;
        return json(d);
      }
      return orig(url, opts);
    }; })()`);
  await ev(`document.getElementById('enterBtn').click()`); await sleep(800);
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
    if (!mc || !sc) continue;
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

/** 机库当前选中态 + 自动前进请求记录。 */
const hangarState = () => ev(`(() => ({
  hangar: !document.getElementById('hangar').hidden,
  lesson: document.querySelector('#tbLessons .tb-lesson.active')?.dataset.seq ?? null,
  term: document.querySelector('#tbTerms .tb-chip.active')?.dataset.term ?? null,
  grade: document.querySelector('#tbGrades .tb-chip.active')?.dataset.grade ?? null,
  status: document.getElementById('tbStatus')?.textContent || '',
  selects: window.__unitSelects || [],
}))()`);

/* ---------- 1) 单元完成 → 返回指挥中心默认选中下一课 ---------- */
console.log('\n[1] 单元完成 → 返回指挥中心 → 默认选中下一课');
await setup({ lesson: { grade: 1, term: 1, seq: 2 }, recordDone: 'done' });
if (await playToReward()) {
  await ev(`document.getElementById('backHangar').click()`); await sleep(800);
  const h = await hangarState();
  check('回到机库', h.hangar);
  check('unit/select 请求下一课 1-1-3：' + JSON.stringify(h.selects), h.selects.length === 1 && h.selects[0].grade === 1 && h.selects[0].term === 1 && h.selects[0].seq === 3);
  check('下一课芯片高亮（seq=3）：' + h.lesson, h.lesson === '3');
  check('状态行显示新题单（新字 6）：' + h.status, h.status.includes('新字') && h.status.includes('6'));
  await shot('unit-next-default');
}

/* ---------- 2) 单元进行中 → 机库不前进 ---------- */
console.log('\n[2] 单元进行中 → 点「机库」→ 不前进');
await setup({ lesson: { grade: 1, term: 1, seq: 2 }, recordDone: 'ongoing' });
if (await playToReward()) {
  await ev(`document.getElementById('backHangar').click()`); await sleep(800);
  const h = await hangarState();
  check('无 unit/select 请求', h.selects.length === 0);
  check('仍停在当前课（seq=2）：' + h.lesson, h.lesson === '2');
}

/* ---------- 3) 目录最后一课完成 → 保持不前进 ---------- */
console.log('\n[3] 最后一课完成 → 保持当前课（无下一课）');
await setup({ lesson: pos(lastLesson), recordDone: 'done' });
if (await playToReward()) {
  await ev(`document.getElementById('backHangar').click()`); await sleep(800);
  const h = await hangarState();
  check('无 unit/select 请求', h.selects.length === 0);
  check('仍选中最后一课（seq=' + lastLesson.seq + '）：' + h.lesson, h.lesson === String(lastLesson.seq));
}

/* ---------- 4) 上册最后一课完成 → 跨册选中下册第 1 课 ---------- */
console.log('\n[4] 上册最后一课完成 → 自动跨册到下册第 1 课');
await setup({ lesson: pos(bookLast), recordDone: 'done' });
if (await playToReward()) {
  await ev(`document.getElementById('backHangar').click()`); await sleep(800);
  const h = await hangarState();
  check('unit/select 请求下册第 1 课：' + JSON.stringify(h.selects), h.selects.length === 1 && h.selects[0].grade === afterBook.grade && h.selects[0].term === afterBook.term && h.selects[0].seq === afterBook.seq);
  check('学期芯片切到下册：' + h.term, h.term === String(afterBook.term));
  check('课文芯片高亮第 1 课：' + h.lesson, h.lesson === String(afterBook.seq));
  await shot('unit-next-cross-book');
}

/* ---------- 5) 做完单元直接刷新重进 → 进来即默认下一课 ---------- */
console.log('\n[5] 重进指挥中心（profile 题单已完成）→ 默认选中下一课');
await setup({ lesson: { grade: 1, term: 1, seq: 2 }, profileDone: true });
{
  const h = await hangarState();
  check('unit/select 请求下一课 1-1-3：' + JSON.stringify(h.selects), h.selects.length === 1 && h.selects[0].seq === 3);
  check('下一课芯片高亮（seq=3）：' + h.lesson, h.lesson === '3');
  await shot('unit-next-boot');
}

/* ---------- 6) 家长改过进度 → 尊重其选择，不自动前进 ---------- */
console.log('\n[6] 进度已被家长改到别课 → 不自动前进');
await setup({ lesson: { grade: 1, term: 1, seq: 2 }, profileDone: true, selOverride: { grade: 1, term: 1, seq: 5 } });
{
  const h = await hangarState();
  check('无 unit/select 请求', h.selects.length === 0);
  check('仍选中家长定的课（seq=5）：' + h.lesson, h.lesson === '5');
}

console.log('\nERRORS:', errors.length ? errors : 'none');
ws.close(); try { process.kill(-chrome.pid); } catch {} try { chrome.kill(); } catch {}
process.exit(errors.length ? 1 : 0);