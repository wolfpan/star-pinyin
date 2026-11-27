/**
 * debug-lesson-done-gray.mjs — 指挥中心（机库）「已完成单元芯片置灰」无头 Chrome 截图验收。
 * 复用 3000 端口服务（只读；课时完成状态用 fetch 拦截模拟，不写玩家进度）。
 * 产出：.ui-shots/lesson-gray-none.png / lesson-gray-two.png / lesson-gray-active.png / lesson-gray-other-grade.png
 *       / lesson-gray-hud.png / lesson-gray-daylight.png
 *
 * 验收点：
 *  1. 无已完成课时 → 没有任何灰色芯片；
 *  2. 一年级上册前 2 课完成 → 对应 2 个芯片带 .done，文字颜色 = --text-mute（灰），title 含「（已完成）」；
 *     未完成芯片颜色不变；「全册」芯片永不置灰；
 *  3. 选中已完成课时（复习）→ 选中态完全接管置灰：外观与同皮肤普通选中芯片一致（.done.active 类并存）；
 *  4. 完成键按 grade-term-seq 隔离：一年级的完成键不影响二年级芯片；
 *  5. 三套皮肤（hud / daylight / nebula）灰字都取各自 --text-mute，自动适配；
 *  6. 状态行约定（AGENTS.md）：无单元任务留空；有单元任务只显示 新字 + 复习 + 进度。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const CHROME = 'C:\\Users\\panft\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9254;
const OUT = 'C:\\Codes\\star-pinyin\\.ui-shots';
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 真实教材目录：取一年级上册前 2 课构造完成键（grade-term-seq，与 rewards.js lessonKey 一致） */
const catalog = await (await fetch('http://127.0.0.1:3000/api/textbook')).json();
const book11 = catalog.catalog.grades.find((g) => g.grade === 1).books.find((b) => b.term === 1);
const firstTwo = book11.lessons.slice(0, 2);
const KEYS2 = firstTwo.map((l) => `1-1-${l.seq}`);
const SEQ1 = firstTwo[0].seq;

const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=' + PORT, '--window-size=820,1180', '--autoplay-policy=no-user-gesture-required',
  '--user-data-dir=C:\\Codes\\star-pinyin\\.chrome-debugLessonDoneGray', 'http://127.0.0.1:3000/'], { stdio: 'ignore', detached: true });

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

/** 每个场景：重新导航 → 静音 → 档案/目录拦截（完成键 + 进度选择 + 可选皮肤/单元任务）→ 进入指挥中心 → 等芯片渲染。 */
async function fresh({ keys, sel, skin, us }) {
  await send('Page.navigate', { url: 'http://127.0.0.1:3000/' }); await sleep(900);
  await ev(`window.__audio && Object.assign(window.__audio, { speakText(){}, slowSplit(){}, speakPinyin(){} })`);
  await ev(`(() => { const orig = window.fetch.bind(window); window.fetch = async (url, opts) => {
    const res = await orig(url, opts);
    if (String(url).startsWith('/api/profile')) {
      const p = await res.json();
      Object.assign(p, { completedLessons: ${JSON.stringify(keys)}, textbook: ${JSON.stringify(sel)}, unitSession: ${JSON.stringify(us ?? null)}${skin ? `, skin: ${JSON.stringify(skin)}` : ''} });
      return new Response(JSON.stringify(p), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (String(url) === '/api/textbook') {
      const t = await res.json();
      t.selection = ${JSON.stringify(sel)};
      return new Response(JSON.stringify(t), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return res; }; })()`);
  await ev(`document.getElementById('enterBtn').click()`);
  for (let i = 0; i < 40; i++) {
    if (await ev(`document.querySelectorAll('#tbLessons .tb-lesson').length`) > 0) break;
    await sleep(150);
  }
  await sleep(350); // 等 loadProfile / loadTextbook 两路渲染都落定
}

/** 芯片快照 + 皮肤变量解析值（--text-mute 灰）+ 同皮肤普通选中芯片外观探针，颜色比较与皮肤无关。 */
const chipInfo = () => ev(`(() => {
  const probe = document.createElement('span');
  probe.style.color = 'var(--text-mute)';
  document.body.append(probe);
  const mute = getComputedStyle(probe).color;
  probe.remove();
  const act = document.createElement('button');
  act.type = 'button'; act.className = 'tb-lesson active';
  act.innerHTML = '<span class="tb-lesson-no">1</span><span class="tb-lesson-title">探针</span>';
  document.getElementById('tbLessons').append(act);
  const activeLook = { noColor: getComputedStyle(act.querySelector('.tb-lesson-no')).color, border: getComputedStyle(act).borderTopColor };
  act.remove();
  const chips = [...document.querySelectorAll('#tbLessons .tb-lesson')].map((c) => {
    const no = c.querySelector('.tb-lesson-no');
    return { seq: c.dataset.seq, done: c.classList.contains('done'), active: c.classList.contains('active'),
      all: c.classList.contains('tb-lesson-all'), title: c.title,
      noColor: no ? getComputedStyle(no).color : null, border: getComputedStyle(c).borderTopColor };
  });
  return { mute, activeLook, chips };
})()`);

/* ---- 场景 1：无已完成课时 → 无灰芯片 ---- */
console.log('\n[1] 0 完成课时：无置灰');
await fresh({ keys: [], sel: { grade: 1, term: 1, seq: null } });
const s1 = await chipInfo();
check('芯片已渲染（' + s1.chips.length + ' 个，含全册）', s1.chips.length > 2);
check('没有任何 .done 芯片', s1.chips.every((c) => !c.done));
await shot('lesson-gray-none');

/* ---- 场景 2：前 2 课完成 → 对应芯片置灰 ---- */
console.log('\n[2] 一年级上册前 2 课完成：' + KEYS2.join(' / '));
await fresh({ keys: KEYS2, sel: { grade: 1, term: 1, seq: null } });
const s2 = await chipInfo();
const done2 = s2.chips.filter((c) => c.done);
check('恰好 2 个 .done 芯片 = 前 2 课', done2.length === 2 && done2.every((c) => firstTwo.some((l) => String(l.seq) === c.seq)));
check('灰字 = --text-mute（' + s2.mute + '）', done2.every((c) => c.noColor === s2.mute));
check('未完成芯片颜色不变（非灰）', s2.chips.filter((c) => !c.done && !c.all).every((c) => c.noColor !== s2.mute));
check('已完成 title 含（已完成）', done2.every((c) => c.title.includes('（已完成）')));
check('「全册」芯片不置灰', s2.chips.filter((c) => c.all).every((c) => !c.done));
check('无单元任务 → 状态行留空', (await ev(`document.getElementById('tbStatus').textContent.trim()`)) === '');
await shot('lesson-gray-two');

/* ---- 场景 3：选中已完成课时（复习）→ 选中态接管置灰 ---- */
console.log('\n[3] 选中已完成第 ' + SEQ1 + ' 课（复习重抽）');
await fresh({ keys: KEYS2, sel: { grade: 1, term: 1, seq: SEQ1 } });
const s3 = await chipInfo();
const sel3 = s3.chips.find((c) => c.seq === String(SEQ1));
check('选中芯片 .done.active 并存', !!sel3 && sel3.done && sel3.active);
check('选中外观 = 同皮肤普通选中芯片（选中态接管置灰）', sel3?.noColor === s3.activeLook.noColor && sel3?.border === s3.activeLook.border);
check('选中芯片 title 仍含（已完成）', sel3?.title.includes('（已完成）'));
check('其余已完成芯片仍灰', s3.chips.filter((c) => c.done && !c.active).every((c) => c.noColor === s3.mute));
await shot('lesson-gray-active');

/* ---- 场景 3b：单元任务进行中 → 状态行只显示 新字 + 复习 + 进度 ---- */
console.log('\n[3b] 单元任务进行中：状态行约定');
await fresh({
  keys: KEYS2, sel: { grade: 1, term: 1, seq: 2 },
  us: { grade: 1, term: 1, seq: 2, label: '一年级上册 · 识字2《金木水火土》', total: 15, cursor: 3, remaining: 12, done: false, newCount: 5, reviewCount: 10 },
});
const st = await ev(`document.getElementById('tbStatus').textContent`);
check('状态行 = 新字 + 复习 + 进度：' + st, st.includes('新字') && st.includes('复习') && st.includes('进度') && st.includes('3/15'));
check('状态行无课文标签 / 年级等附加文字', !st.includes('识字2') && !st.includes('一年级') && !st.includes('金木水火土'));
await shot('lesson-gray-status');

/* ---- 场景 4：完成键按年级隔离 ---- */
console.log('\n[4] 一年级完成键不影响二年级');
await fresh({ keys: [KEYS2[0]], sel: { grade: 2, term: 1, seq: null } });
const s4 = await chipInfo();
check('二年级芯片已渲染（' + s4.chips.length + ' 个）', s4.chips.length > 2);
check('二年级无 .done 芯片', s4.chips.every((c) => !c.done));
await shot('lesson-gray-other-grade');

/* ---- 场景 5：三套皮肤自适应（nebula 已由真实档案覆盖，这里补 hud / daylight）---- */
for (const skin of ['hud', 'daylight']) {
  console.log('\n[5] 皮肤 ' + skin + '：灰字 = 该皮肤 --text-mute');
  await fresh({ keys: KEYS2, sel: { grade: 1, term: 1, seq: null }, skin });
  const s5 = await chipInfo();
  const done5 = s5.chips.filter((c) => c.done);
  check(skin + ' 恰好 2 个 .done 芯片', done5.length === 2);
  check(skin + ' 灰字 = --text-mute（' + s5.mute + '）', done5.every((c) => c.noColor === s5.mute));
  check(skin + ' 未完成芯片非灰', s5.chips.filter((c) => !c.done && !c.all).every((c) => c.noColor !== s5.mute));
  await shot('lesson-gray-' + skin);
}

console.log('\nERRORS:', errors.length ? errors : 'none');
ws.close(); try { process.kill(-chrome.pid); } catch {} try { chrome.kill(); } catch {}
process.exit(errors.length ? 1 : 0);