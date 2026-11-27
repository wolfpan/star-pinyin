/**
 * debug-medial-mode.mjs — 介母装配选项「孩子填入 / 自动预装」UI 验收（自包含，不碰真实玩家数据）。
 * 临时 DATA_DIR 副本上起服务 + 无头 Chrome CDP 真实拖拽组装，验证：
 *  1) 家长后台「学习管理」页出现介母装配面板，默认 required；点选 auto → 保存成功、档案同步；
 *  2) 孩子端 auto：三拼（船 ch-u-an）介母舱段预装 'u'，托盘无介母行，只拖声母+韵母即可完成；
 *  3) 孩子端 auto：j/q/x+ü 三拼介母预装去点书写形 'u'，不弹摘墨镜；
 *  4) 家长切回 required（孩子页不刷新）→ 下一题立即恢复介母填入（startMission 拉档案同步）；
 *  5) auto 不影响两拼（无介母舱段）；
 *  6) 零声母：单仓一体箭体，只拖韵母即可完成；
 *  7) 整体认读：单仓一体箭体，无中间环缝，拖一次完整音节即完成。
 * 截图输出 .ui-shots/medial-*.png。运行：node scripts/debug-medial-mode.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const CHROME = 'C:\\Users\\panft\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 3107, CDP = 9287;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = path.join(ROOT, '.ui-shots');
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TRAD = { 一: '壹', 二: '貳', 三: '參', 四: '肆', 五: '伍', 六: '陸', 七: '柒', 八: '捌', 九: '玖', 十: '拾' };

/* -------- 隔离数据 + 服务器 -------- */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'star-pinyin-medial-ui-'));
for (const f of ['missions.json', 'textbook.json', 'badges.json']) {
  fs.copyFileSync(path.join(ROOT, 'data', f), path.join(tmp, f));
}
fs.writeFileSync(path.join(tmp, 'progress.json'), JSON.stringify({
  callsign: '验收指挥官', totalLaunches: 0, unlockedBadges: [], recentMissionIds: [], stats: {},
}, null, 2));
const server = spawn(process.execPath, ['server.js'], {
  cwd: ROOT, env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: tmp }, stdio: 'ignore',
});

/* 用例取材：三拼（介母 u）/ j-q-x+ü 三拼 / 两拼 */
const missions = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'missions.json'), 'utf8'));
const byId = (id) => missions.find((m) => m.id === id);
const THREE = byId('m_011'); // 船 ch-u-an
const JQX = missions.find((m) => m.type === 'three_part' && m.parts.medial === 'ü');
const TWO = byId('m_001'); // 组 z-u（两拼）
const ZERO = missions.find((m) => m.type === 'zero_initial');
const WHOLE = byId('m_034'); // 知 zhi（整体认读）
if (!THREE || !JQX || !TWO || !ZERO || !WHOLE) throw new Error('词库里找不到可构造用例的词条');
console.log(`用例: 三拼 ${THREE.id}(${THREE.hanzi} ${THREE.displayPinyin}) · jqx+ü ${JQX.id}(${JQX.hanzi} ${JQX.displayPinyin}) · 两拼 ${TWO.id}(${TWO.hanzi})`);

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
  `--user-data-dir=${path.join(tmp, 'chrome')}`, `${BASE}/admin.html#study`], { stdio: 'ignore', detached: true });
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
const nav = async (url) => { await send('Page.navigate', { url }); await sleep(1200); };
const mouse = (type, x, y) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 });
async function tap(x, y) { await mouse('mousePressed', x, y); await sleep(25); await mouse('mouseReleased', x, y); }
async function drag(fx, fy, tx, ty) {
  await mouse('mousePressed', fx, fy); await sleep(80);
  for (let i = 1; i <= 6; i++) { await mouse('mouseMoved', fx + (tx - fx) * i / 6, fy + (ty - fy) * i / 6); await sleep(25); }
  await mouse('mouseReleased', tx, ty); await sleep(380);
}
const rect = (sel) => ev(`(() => { const e = document.querySelector('${sel}'); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 }; })()`);
const modCenter = (g, v) => ev(`(() => { const e = [...document.querySelectorAll('.module')].find(m => m.dataset.group === '${g}' && m.dataset.value === '${v}'); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 }; })()`);
const slotCenter = (id) => rect(`.slot[data-slot="${id}"] .slot-hit`);
const profile = () => ev(`(async()=>await (await fetch('/api/profile')).json())()`);
const setMedialMode = (mode) => ev(`(async()=>{ const r = await fetch('/api/medialmode', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ medialMode:'${mode}' }) }); return r.status; })()`);
const answerGate = () => ev(`(()=>{const map=${JSON.stringify(TRAD)};const cur=map[document.getElementById('gateChar').textContent];document.getElementById('gateInput').value=cur;document.getElementById('gateBtn').click();})()`);

let pass = 0, fail = 0;
const check = (name, cond) => { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name); errors.push(name); } };

await send('Runtime.enable'); await send('Page.enable'); await sleep(1500);

/* ---------- 1. 家长后台「学习管理」：介母装配面板 ---------- */
console.log('\n[1] 家长后台「学习管理」介母装配面板');
await answerGate(); await sleep(300);
check('学习管理页已解锁', await ev(`!document.querySelector('#page-study .page-body').hidden`));
check('介母装配面板在学习管理页', await ev(`document.getElementById('page-study').contains(document.getElementById('medialModePicker'))`));
await waitFor('#medialModePicker .skin-card[data-medialmode="required"][aria-checked="true"]', 4000);
check('默认选中「孩子装配」', await ev(`document.querySelector('#medialModePicker .skin-card[data-medialmode="required"]').getAttribute('aria-checked') === 'true'`));
await ev(`document.getElementById('medialModePicker').scrollIntoView({ block: 'center' })`); await sleep(300);
await shot('medial-admin-required');
await ev(`document.querySelector('#medialModePicker .skin-card[data-medialmode="auto"]').click()`);
await waitFor('#medialModePicker .skin-card[data-medialmode="auto"][aria-checked="true"]', 4000);
await sleep(400);
const adminStatus = await ev(`document.getElementById('medialModeStatus').textContent`);
console.log('  保存状态 =', adminStatus);
check('点选 auto 保存成功', String(adminStatus).includes('已保存'));
check('档案同步 medialMode=auto', (await profile()).medialMode === 'auto');
await shot('medial-admin-auto');

/* ---------- 孩子端：真实组装 ---------- */
await nav(BASE + '/');
await ev(`window.__audio && Object.assign(window.__audio, { speakText(){}, slowSplit(){}, speakPinyin(){} })`);
await ev(`document.getElementById('enterBtn').click()`); await sleep(800);
await ev(`window.__fxTimeScale = 12`); // 快进发射动画
// 拦截抽题接口 → 固定用例词条（其余请求原样放行，档案同步走真实接口）
await ev(`(() => {
  const real = window.fetch.bind(window);
  window.__forceMission = null;
  window.fetch = (url, opts) => {
    if (String(url).startsWith('/api/missions/next') && window.__forceMission) {
      return Promise.resolve(new Response(JSON.stringify(window.__forceMission), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    }
    return real(url, opts);
  };
})()`);
const forceMission = async (m) => { await ev(`window.__forceMission = ${JSON.stringify(m)}`); };
const trayGroups = () => ev(`[...document.querySelectorAll('.tray-row')].map(r => r.dataset.group)`);
const medialSlot = () => ev(`(() => { const g = document.querySelector('.slot[data-slot="medial"]'); if (!g) return null; return { filled: g.classList.contains('is-filled'), locked: g.classList.contains('is-locked'), value: g.querySelector('.slot-value')?.textContent || '' }; })()`);

/** 点「发射」→ 简报 → 组装（走真实 startMission：抽题 + 拉档案同步家长选项）。 */
async function startForced() {
  // 机库页点发射按钮；结算页点「下一题」（隐藏按钮不可点，避免双触发）
  const clicked = await ev(`(() => {
    const next = document.getElementById('nextMission');
    if (next && !next.closest('[hidden]')) { next.click(); return 'next'; }
    const launch = document.getElementById('launchBtn');
    if (launch && !launch.closest('[hidden]')) { launch.click(); return 'launch'; }
    return null;
  })()`);
  if (!clicked) { errors.push('startForced: 找不到可点的发射/下一题按钮'); return false; }
  if (!await waitFor('#game .briefing', 6000)) { errors.push('startForced: 简报未出现'); return false; }
  await ev(`document.querySelector('#game .briefing .phys-btn.primary')?.click()`);
  if (!await waitFor('#game .assembly', 6000)) { errors.push('startForced: 组装台未出现'); return false; }
  await sleep(250);
  return true;
}
/** 按当前模式拖拽正确零件；auto 三拼只拖声母+韵母。返回是否进入声调界面。 */
async function assemble(m, mode) {
  const groups = m.type === 'three_part' && mode === 'auto' ? ['initial', 'final']
    : m.type === 'three_part' ? ['initial', 'medial', 'final']
    : m.type === 'two_part' ? ['initial', 'final']
    : m.type === 'whole_syllable' ? ['whole'] : ['final'];
  for (const g of groups) {
    const v = m.parts[g];
    const mc = await modCenter(g, v); const sc = await slotCenter(g);
    if (!mc || !sc) { errors.push(`assemble ${m.id}: 缺零件/槽位 ${g}=${v}`); return false; }
    await drag(mc.x, mc.y, sc.x, sc.y);
    if (await ev(`!!document.querySelector('.dot-overlay')`)) await ev(`window.__dotSeen = true`);
    if (m.specialRule === 'j_q_x_drop_dots' && g !== 'initial' && String(v).includes('ü')) {
      await waitFor('.dot-overlay', 2000);
      const d0 = await rect('.dot-btn:nth-child(1)'); const d1 = await rect('.dot-btn:nth-child(2)');
      if (d0) await tap(d0.x, d0.y); await sleep(150);
      if (d1) await tap(d1.x, d1.y); await sleep(650);
    }
  }
  return waitFor('.tone', 4000);
}
/** 点正确声调 → 快进发射 → 等结算页。 */
async function toneToReward(m) {
  const btn = await rect(`.curve-btn[data-tone="${m.tone}"]`);
  if (!btn) { errors.push(`tone ${m.id}: 声调按钮缺失`); return false; }
  await tap(btn.x, btn.y);
  return waitFor('.reward', 10000);
}

/* ---------- 2. auto：三拼介母自动预装 ---------- */
console.log('\n[2] 孩子端 auto：三拼介母自动预装（船 ch-u-an）');
await forceMission(THREE);
check('进入组装台', await startForced());
check('托盘只有声母+韵母（无介母行）', JSON.stringify(await trayGroups()) === JSON.stringify(['initial', 'final']));
let ms = await medialSlot();
check('介母舱段已预装 u', ms && ms.filled && ms.value === 'u');
await shot('medial-auto-assembly');
check('只拖声母+韵母即完成组装', await assemble(THREE, 'auto'));
check('进入声调 → 结算', await toneToReward(THREE));

/* ---------- 3. auto：j/q/x+ü 三拼预装去点 u ---------- */
console.log(`\n[3] 孩子端 auto：j/q/x+ü 三拼（${JQX.hanzi} ${JQX.displayPinyin}）`);
await forceMission(JQX);
check('下一题进入组装台', await startForced());
ms = await medialSlot();
check('ü 介母预装为去点书写形 u', ms && ms.filled && ms.value === 'u');
check('托盘无介母行', JSON.stringify(await trayGroups()) === JSON.stringify(['initial', 'final']));
await shot('medial-auto-jqx');
await ev(`window.__dotSeen = false`);
check('组装完成（无摘墨镜弹窗）', await assemble(JQX, 'auto'));
check('全程未出现摘墨镜交互', await ev(`!window.__dotSeen`));
check('进入声调 → 结算', await toneToReward(JQX));

/* ---------- 4. 家长切回 required：孩子不刷新，下一题立即恢复 ---------- */
console.log('\n[4] 家长切回 required（孩子页不刷新）→ 下一题恢复介母填入');
check('POST /api/medialmode required → 200', await setMedialMode('required') === 200);
await forceMission(THREE);
check('下一题进入组装台', await startForced());
check('托盘恢复声母+介母+韵母', JSON.stringify(await trayGroups()) === JSON.stringify(['initial', 'medial', 'final']));
ms = await medialSlot();
check('介母舱段恢复待填（?）', ms && !ms.filled && !ms.locked && ms.value === '?');
await shot('medial-required-assembly');
check('三件全拖完成组装', await assemble(THREE, 'required'));
check('进入声调 → 结算', await toneToReward(THREE));

/* ---------- 5. auto 不影响两拼 ---------- */
console.log('\n[5] auto 不影响两拼（无介母舱段）');
check('POST /api/medialmode auto → 200', await setMedialMode('auto') === 200);
await forceMission(TWO);
check('下一题进入组装台', await startForced());
check('两拼托盘只有声母+韵母', JSON.stringify(await trayGroups()) === JSON.stringify(['initial', 'final']));
ms = await medialSlot();
check('两拼不显示介母舱段', ms === null);
await shot('medial-two-assembly');
check('两拼只拖声母+韵母即完成组装', await assemble(TWO, 'auto'));
check('进入声调 → 结算', await toneToReward(TWO));

/* ---------- 6. 零声母：单仓一体箭体，只拖韵母 ---------- */
console.log(`\n[6] 零声母（${ZERO.hanzi} ${ZERO.displayPinyin}）：单仓一体箭体`);
await forceMission(ZERO);
check('下一题进入组装台', await startForced());
check('只有一个「韵母」装载仓', await ev(`document.querySelectorAll('.slot').length === 1 && !!document.querySelector('.slot[data-slot="final"]')`));
check('托盘只有韵母', JSON.stringify(await trayGroups()) === JSON.stringify(['final']));
await shot('medial-zero-assembly');
check('只拖韵母即完成组装', await assemble(ZERO, 'auto'));
check('进入声调 → 结算', await toneToReward(ZERO));

/* ---------- 7. 整体认读：单仓一体箭体，无中间环缝 ---------- */
console.log(`\n[7] 整体认读（${WHOLE.hanzi} ${WHOLE.displayPinyin}）：单仓一体箭体`);
await forceMission(WHOLE);
check('下一题进入组装台', await startForced());
check('只有一个「整体」装载仓', await ev(`document.querySelectorAll('.slot').length === 1 && !!document.querySelector('.slot[data-slot="whole"]')`));
check('一体箭体无中间环缝（仅首尾焊缝）', await ev(`document.querySelectorAll('.rocket-svg rect[x="136"][width="128"][height="6"]').length === 2`));
check('托盘只有整体行', JSON.stringify(await trayGroups()) === JSON.stringify(['whole']));
await shot('medial-whole-assembly');
check('拖一次完整音节即完成组装', await assemble(WHOLE, 'auto'));
check('进入声调 → 结算', await toneToReward(WHOLE));

console.log('\nERRORS:', errors.length ? errors : 'none');
console.log(`\n介母装配 UI 验收结果: ${pass} 通过, ${fail} 失败`);
clearTimeout(watchdog);
ws.close(); cleanup();
process.exit(fail || errors.length ? 1 : 0);