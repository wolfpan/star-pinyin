/**
 * debug-assembly-help.mjs — 组装界面「复读 + 两次填错自动高亮」UI 验收（自包含，不碰真实玩家数据）。
 * 临时 DATA_DIR 副本上起服务 + 无头 Chrome CDP，验证：
 *  1) 托盘标题行只有「复读」按钮（无提示按钮；竖屏 / iPad 横屏 / 手机横屏均可见）；
 *  2) 复读 = 无线电滋滋声 + 重读「XX的X」（不带「载荷确认」前缀）；
 *  3) 第 1 次填错不高亮；第 2 次填错自动点亮下一待装舱段 + 托盘正确零件（sticky 慢呼吸），
 *     3s 后仍高亮（持续到装对）；装对即清除；之后每次填错继续帮扶；只点亮不读音；
 *  4) j/q/x+ü 先拖 ü（need-initial）两次 → 帮扶点亮声母；整体认读两次填错 → 点亮一体箭体；
 *  5) 三套皮肤下按钮与辉光正常渲染（截图人工复核）。
 * 截图输出 .ui-shots/help-*.png。运行：node scripts/debug-assembly-help.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const CHROME = 'C:\\Users\\panft\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 3112, CDP = 9292;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = path.join(ROOT, '.ui-shots');
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* -------- 隔离数据 + 服务器 -------- */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'star-pinyin-help-ui-'));
for (const f of ['missions.json', 'textbook.json', 'badges.json']) {
  fs.copyFileSync(path.join(ROOT, 'data', f), path.join(tmp, f));
}
fs.writeFileSync(path.join(tmp, 'progress.json'), JSON.stringify({
  callsign: '验收指挥官', totalLaunches: 0, unlockedBadges: [], recentMissionIds: [], stats: {},
}, null, 2));
const server = spawn(process.execPath, ['server.js'], {
  cwd: ROOT, env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: tmp }, stdio: 'ignore',
});

/* 用例取材：三拼（船 ch-u-an）/ j-q-x+ü（居 j-ü）/ 整体认读（知 zhi） */
const missions = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'missions.json'), 'utf8'));
const byId = (id) => missions.find((m) => m.id === id);
const THREE = byId('m_011');
const JQX = byId('m_026');
const WHOLE = byId('m_034');
if (!THREE || !JQX || !WHOLE) throw new Error('词库里找不到可构造用例的词条');
console.log(`用例: 三拼 ${THREE.id}(${THREE.hanzi}) · jqx+ü ${JQX.id}(${JQX.hanzi}) · 整体 ${WHOLE.id}(${WHOLE.hanzi})`);

const cleanup = () => {
  try { chrome.kill(); } catch {}
  try { server.kill(); } catch {}
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
};
process.on('exit', cleanup);
const watchdog = setTimeout(() => { console.error('❌ 验收超时'); cleanup(); process.exit(1); }, 180000);

async function waitServer() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) return; } catch {}
    await sleep(250);
  }
  throw new Error('服务器未就绪');
}
await waitServer();

/* -------- headless Chrome + CDP -------- */
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=' + CDP, '--window-size=820,1180', '--autoplay-policy=no-user-gesture-required',
  `--user-data-dir=${path.join(tmp, 'chrome')}`, `${BASE}/`], { stdio: 'ignore', detached: true });
async function getTarget() {
  for (let i = 0; i < 80; i++) {
    try {
      const l = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
      const p = l.find((t) => t.type === 'page' && t.url.includes(`127.0.0.1:${PORT}`));
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
  if (r.result?.data) { fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(r.result.data, 'base64')); console.log('  截图 → .ui-shots/' + name + '.png'); }
  else errors.push('shot failed: ' + name);
};
const waitFor = async (sel, ms = 6000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await ev(`!!document.querySelector('${sel}')`)) return true; await sleep(80); } return false; };
const mouse = (type, x, y) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 });
async function drag(fx, fy, tx, ty) {
  await mouse('mousePressed', fx, fy); await sleep(80);
  for (let i = 1; i <= 6; i++) { await mouse('mouseMoved', fx + (tx - fx) * i / 6, fy + (ty - fy) * i / 6); await sleep(25); }
  await mouse('mouseReleased', tx, ty); await sleep(380);
}
const rect = (sel) => ev(`(() => { const e = document.querySelector('${sel}'); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 }; })()`);
const modCenter = (g, v) => ev(`(() => { const e = [...document.querySelectorAll('.module')].find(m => m.dataset.group === '${g}' && m.dataset.value === '${v}'); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 }; })()`);
const slotCenter = (id) => rect(`.slot[data-slot="${id}"] .slot-hit`);
const metrics = (width, height) => send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });

let pass = 0, fail = 0;
const check = (name, cond) => { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name); errors.push(name); } };

await send('Runtime.enable'); await send('Page.enable'); await sleep(1200);

/* 语音桩：记录调用，不真播（验收只关心调度正确） */
await ev(`(() => {
  window.__voiceLog = [];
  const L = window.__voiceLog;
  Object.assign(window.__audio, {
    speakText(t, r) { L.push(['speakText', t, r]); },
    speakPart(p, r) { L.push(['speakPart', p, r]); },
    speakPinyin(o) { L.push(['speakPinyin', o]); },
    slowSplit() { L.push(['slowSplit']); },
    playRadioStatic() { L.push(['radio']); },
  });
})()`);
await ev(`document.getElementById('enterBtn').click()`); await sleep(700);

/** __debugStart 强制某题 → 简报 → 组装台。 */
async function startAssembly(id) {
  await ev(`window.__debugStart('${id}')`);
  if (!await waitFor('#game .briefing', 5000)) { errors.push('startAssembly: 简报未出现'); return false; }
  await ev(`document.querySelector('#game .briefing .phys-btn.primary')?.click()`);
  if (!await waitFor('#game .assembly', 5000)) { errors.push('startAssembly: 组装台未出现'); return false; }
  await sleep(250);
  return true;
}
const toolButtons = () => ev(`[...document.querySelectorAll('.tray-tools .phys-btn')].map(b => b.textContent.trim())`);
const replayBtn = () => ev(`(() => { const b = [...document.querySelectorAll('.tray-tools .phys-btn')].find(x => x.textContent.includes('复读')); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2, w: r.width, h: r.height, visible: r.width > 0 && r.height > 0 }; })()`);
const hintState = () => ev(`(() => ({
  slots: [...document.querySelectorAll('.slot.hint')].map(g => ({ id: g.dataset.slot, sticky: g.classList.contains('sticky') })),
  modules: [...document.querySelectorAll('.module.hint')].map(m => ({ group: m.dataset.group, value: m.dataset.value, sticky: m.classList.contains('sticky') })),
}))()`);
const voiceLog = () => ev(`window.__voiceLog.slice()`);
const clearLog = () => ev(`window.__voiceLog.length = 0`);
/** 把 group 组的 value 零件拖到 slotId 槽（value 可为干扰项）。 */
async function drop(g, v, slotId) {
  const mc = await modCenter(g, v); const sc = await slotCenter(slotId || g);
  if (!mc || !sc) { errors.push(`drop: 缺零件/槽位 ${g}=${v} → ${slotId || g}`); return false; }
  await drag(mc.x, mc.y, sc.x, sc.y);
  return true;
}
const wrongOf = (m, g) => m.distractors[g][0];
/** 断言当前帮扶高亮 = 某槽位正确零件（sticky）。 */
async function checkHelp(m, slotId, label) {
  const hs = await hintState();
  check(`${label}：点亮 ${slotId} 舱段（sticky）`, hs.slots.length === 1 && hs.slots[0].id === slotId && hs.slots[0].sticky);
  check(`${label}：点亮托盘正确零件 ${m.parts[slotId]}`, hs.modules.length === 1 && hs.modules[0].group === slotId && hs.modules[0].value === m.parts[slotId] && hs.modules[0].sticky);
}

/* ---------- 1. 竖屏：只有复读按钮 + 复读内容 ---------- */
console.log('\n[1] 竖屏：托盘工具条只有「复读」+ 重读目标词（无载荷确认前缀）');
await metrics(820, 1180);
check('进入组装台（船 ch-u-an）', await startAssembly(THREE.id));
check('工具条只有「复读」一枚按钮（提示按钮已删除）', JSON.stringify(await toolButtons()) === JSON.stringify(['复读']));
const rb = await replayBtn();
check('「复读」按钮可见可点', rb && rb.visible && rb.h >= 36);
await shot('help-portrait-buttons');
await clearLog();
await mouse('mousePressed', rb.x, rb.y); await mouse('mouseReleased', rb.x, rb.y);
await sleep(200);
let log = await voiceLog();
check('复读：先无线电滋滋声', log.some((e) => e[0] === 'radio'));
check(`复读：重读「${THREE.word}的${THREE.hanzi}」`, log.some((e) => e[0] === 'speakText' && e[1] === `${THREE.word}的${THREE.hanzi}`));
check('复读：不再带「载荷确认」前缀', !log.some((e) => e[0] === 'speakText' && String(e[1]).includes('载荷确认')));

/* ---------- 2. 两次填错自动高亮（sticky 直到装对） ---------- */
console.log('\n[2] 错两次自动帮扶：声母 → 介母 → 韵母 逐段点亮，装对即清除');
await clearLog();
check('第 1 次错拖声母干扰项', await drop('initial', wrongOf(THREE, 'initial'), 'initial'));
let hs = await hintState();
check('第 1 次填错：不高亮', hs.slots.length === 0 && hs.modules.length === 0);
check('第 2 次错拖声母干扰项', await drop('initial', wrongOf(THREE, 'initial'), 'initial'));
await checkHelp(THREE, 'initial', '错两次');
check('自动帮扶只点亮不读音', (await voiceLog()).length === 0);
await shot('help-auto-hint-initial');
await sleep(3000);
hs = await hintState();
check('sticky：3s 后仍高亮（持续到装对）', hs.modules.length === 1 && hs.modules[0].sticky);
check('装对声母', await drop('initial', THREE.parts.initial, 'initial'));
hs = await hintState();
check('装对即清除高亮', hs.slots.length === 0 && hs.modules.length === 0);

check('错拖介母两次', (await drop('medial', wrongOf(THREE, 'medial'), 'medial')) && (await drop('medial', wrongOf(THREE, 'medial'), 'medial')));
await checkHelp(THREE, 'medial', '介母错两次');
await shot('help-auto-hint-medial');
check('装对介母', await drop('medial', THREE.parts.medial, 'medial'));
check('错拖韵母两次', (await drop('final', wrongOf(THREE, 'final'), 'final')) && (await drop('final', wrongOf(THREE, 'final'), 'final')));
await checkHelp(THREE, 'final', '韵母错两次');
check('装对韵母（组装完成）', await drop('final', THREE.parts.final, 'final'));
hs = await hintState();
check('完成后高亮已清除', hs.slots.length === 0 && hs.modules.length === 0);
check('完成横幅出现', await waitFor('.assembly-banner:not([hidden])', 2000));
check('自动进入声调校准', await waitFor('.tone', 4000));

/* ---------- 3. j/q/x+ü：need-initial 两次 → 帮扶点亮声母 ---------- */
console.log('\n[3] j/q/x+ü（居 j-ü）：先拖 ü 两次 → 帮扶点亮声母 j');
check('进入组装台（居 j-ü）', await startAssembly(JQX.id));
await clearLog();
check('未装声母先拖 ü 两次', (await drop('final', JQX.parts.final, 'final')) && (await drop('final', JQX.parts.final, 'final')));
await checkHelp(JQX, 'initial', 'need-initial 错两次');
log = await voiceLog();
check('仍播报「请先安装声母」', log.some((e) => e[0] === 'speakText' && e[1] === '请先安装声母'));
check('帮扶不额外读零件音', !log.some((e) => e[0] === 'speakPart' || e[0] === 'speakPinyin'));
await shot('help-auto-hint-jqx');

/* ---------- 4. 整体认读：两次填错点亮一体箭体 ---------- */
console.log('\n[4] 整体认读（知 zhi）：错两次点亮一体箭体正确零件');
check('进入组装台（知 zhi）', await startAssembly(WHOLE.id));
check('错拖整体干扰项两次', (await drop('whole', wrongOf(WHOLE, 'whole'), 'whole')) && (await drop('whole', wrongOf(WHOLE, 'whole'), 'whole')));
await checkHelp(WHOLE, 'whole', '整体错两次');
await shot('help-auto-hint-whole');

/* ---------- 5. 横屏 / 手机横屏 / 三皮肤 ---------- */
console.log('\n[5] iPad 横屏 / 手机横屏 / 三皮肤渲染');
await metrics(1180, 820); await sleep(400);
check('横屏进入组装台', await startAssembly(THREE.id));
const rb5 = await replayBtn();
check('横屏「复读」可见', rb5 && rb5.visible);
check('横屏托盘在火箭左侧', await ev(`(() => { const t = document.querySelector('.tray-area').getBoundingClientRect(); const s = document.querySelector('.stage-area').getBoundingClientRect(); return t.right <= s.left + 1; })()`));
check('横屏错两次', (await drop('initial', wrongOf(THREE, 'initial'), 'initial')) && (await drop('initial', wrongOf(THREE, 'initial'), 'initial')));
await shot('help-landscape-hint');
check('横屏帮扶高亮正常', (await hintState()).modules.length === 1);

await metrics(844, 390); await sleep(400);
check('手机横屏进入组装台', await startAssembly(THREE.id));
const rb6 = await replayBtn();
check('手机横屏按钮可见且紧凑（≤40px 高）', rb6 && rb6.visible && rb6.h <= 40);
check('手机横屏错两次', (await drop('initial', wrongOf(THREE, 'initial'), 'initial')) && (await drop('initial', wrongOf(THREE, 'initial'), 'initial')));
await shot('help-phone-landscape-hint');

await metrics(820, 1180); await sleep(300);
for (const skin of ['daylight', 'nebula', 'hud']) {
  await ev(`document.documentElement.dataset.skin = '${skin}'`);
  await startAssembly(THREE.id);
  check(`皮肤 ${skin} 错两次`, (await drop('initial', wrongOf(THREE, 'initial'), 'initial')) && (await drop('initial', wrongOf(THREE, 'initial'), 'initial')));
  await shot(`help-skin-${skin}`);
  check(`皮肤 ${skin}：帮扶高亮正常`, (await hintState()).modules.length === 1);
}

console.log('\nERRORS:', errors.length ? errors : 'none');
console.log(`\n组装台「复读 + 错两次自动高亮」UI 验收结果: ${pass} 通过, ${fail} 失败`);
clearTimeout(watchdog);
ws.close(); cleanup();
process.exit(fail || errors.length ? 1 : 0);