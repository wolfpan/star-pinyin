/**
 * debug-admin-tabs.mjs — 家长控制面板分页 UI 冒烟验收。
 * ------------------------------------------------------------------
 * 四个页签：学习管理（紧急载荷/薄弱拼音标签）/ 界面（皮肤/图标/发射动画，默认打开）
 *          / 发音（发音自检/词库表格）/ 系统（系统自检/学习记录管理）。
 * 除界面外各页需「繁体数字」家长校验（会话级），防孩子错触。
 * 隔离环境：临时 DATA_DIR（不碰真实数据）。headless Chrome + CDP 验证：
 * 默认界面页 / 点选切页 / 内容分组 / 校验锁与解锁 / hash 直达 / 本机记忆 / 键盘切换 / 跨页状态不丢，
 * 并逐页截图 .ui-shots/admin-tabs-*.png（含校验面板 admin-tabs-gate.png）。
 *
 * 运行：node scripts/debug-admin-tabs.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const CHROME = 'C:\\Users\\panft\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 3103, CDP = 9283;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TRAD = { 一: '壹', 二: '貳', 三: '參', 四: '肆', 五: '伍', 六: '陸', 七: '柒', 八: '捌', 九: '玖', 十: '拾' };

/* -------- 隔离数据 + 服务器 -------- */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'star-pinyin-admintabs-'));
for (const f of ['missions.json', 'progress.json', 'badges.json', 'textbook.json', 'voice-flags.json', 'voice-overrides.json']) {
  const src = path.join(ROOT, 'data', f);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(tmp, f));
}
const server = spawn(process.execPath, ['server.js'], {
  cwd: ROOT,
  env: {
    ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: tmp, VOICE_OUT_DIR: path.join(tmp, 'out'),
    QWEN_TOKEN_PLAN_CN_API_KEY: '', TTS_API_KEY: '', TTS_CREDENTIALS_FILE: path.join(tmp, 'none.yaml'), DSH_HOME: tmp,
  },
  stdio: 'ignore',
});
for (let i = 0; i < 60; i++) {
  try { if ((await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok) break; } catch {}
  await sleep(250);
}

/* -------- headless Chrome + CDP -------- */
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=' + CDP, '--window-size=1000,1400', '--autoplay-policy=no-user-gesture-required',
  '--user-data-dir=' + path.join(tmp, 'chrome'), `http://127.0.0.1:${PORT}/admin.html`], { stdio: 'ignore', detached: true });
async function getTarget() {
  for (let i = 0; i < 60; i++) {
    try { const l = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json(); const p = l.find((t) => t.type === 'page'); if (p) return p; } catch {}
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
  if (r.result?.exceptionDetails) errors.push('EVAL ' + (r.result.exceptionDetails.exception?.description || ''));
  return r.result?.result?.value;
}
const click = (sel) => ev(`document.querySelector('${sel}')?.click()`);
const nav = async (url) => { await send('Page.navigate', { url }); await sleep(1200); };
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  if (r.result?.data) { fs.writeFileSync(path.join(ROOT, '.ui-shots', name + '.png'), Buffer.from(r.result.data, 'base64')); console.log('  截图 → .ui-shots/' + name + '.png'); }
  else errors.push('shot failed: ' + name);
};
// 校验面板自动作答：wrong=true 故意答错
const answerGate = (wrong = false) => ev(`(()=>{const map=${JSON.stringify(TRAD)};const cur=map[document.getElementById('gateChar').textContent];const i=document.getElementById('gateInput');i.value=${wrong ? '(cur==="壹"?"貳":"壹")' : 'cur'};document.getElementById('gateBtn').click();})()`);

await send('Runtime.enable'); await send('Page.enable'); await sleep(1500);

let pass = 0, fail = 0;
const check = (name, cond) => { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name); } };
const PAGES = ['study', 'ui', 'voice', 'reset'];
const visiblePage = () => ev(`(${JSON.stringify(PAGES)}).find((k)=>!document.getElementById('page-'+k).hidden) || null`);
const selectedTab = () => ev(`(${JSON.stringify(PAGES)}).find((k)=>document.getElementById('tab-'+k).getAttribute('aria-selected')==='true') || null`);

console.log('\n[1] 默认加载：界面页（无需校验）');
check('无 JS 报错', errors.length === 0);
check('4 个页签（学习管理/界面/发音/系统）', await ev(`[...document.querySelectorAll('.admin-tab')].map((b)=>b.textContent).join('/')`) === '学习管理/界面/发音/系统');
check('默认显示界面页', await visiblePage() === 'ui');
check('hash 同步为 #ui', await ev(`location.hash`) === '#ui');
check('其余 3 页隐藏', await ev(`['study','voice','reset'].every((k)=>document.getElementById('page-'+k).hidden)`));
check('校验面板未出现', await ev(`document.getElementById('adminGate').hidden`));
check('受保护页内容默认上锁', await ev(`['study','voice','reset'].every((k)=>document.querySelector('#page-'+k+' .page-body').hidden)`));
check('受保护页签带校验提示', await ev(`document.getElementById('tab-study').title.includes('需家长校验')`));

console.log('\n[2] 内容分组');
check('学习管理：紧急载荷 + 薄弱标签', await ev(`['submitBtn','stats'].every((id)=>document.getElementById('page-study').contains(document.getElementById(id))) && !document.getElementById('page-study').contains(document.getElementById('selfTestBtn'))`));
check('界面：皮肤 + 图标 + 发射动画', await ev(`['skinPicker','iconStylePicker','launchFxPicker'].every((id)=>document.getElementById('page-ui').contains(document.getElementById(id)))`));
check('发音：发音自检 + 词库表格', await ev(`['voicePlayAll','ttsConfigBox','missionBody','pager'].every((id)=>document.getElementById('page-voice').contains(document.getElementById(id)))`));
check('系统：系统自检 + 一键清除学习记录', await ev(`['selfTestBtn','resetProgressBtn'].every((id)=>document.getElementById('page-reset').contains(document.getElementById(id)))`));

console.log('\n[3] 点选切页 + hash');
for (const k of PAGES) {
  await click(`.admin-tab[data-page="${k}"]`); await sleep(250);
  check(`切到「${k}」页`, await visiblePage() === k && await selectedTab() === k);
  check(`「${k}」hash 同步`, await ev(`location.hash`) === '#' + k);
  check(`「${k}」其余页隐藏`, await ev(`(${JSON.stringify(PAGES)}).filter((x)=>x!=='${k}').every((x)=>document.getElementById('page-'+x).hidden)`));
}

console.log('\n[4] 家长校验（繁体数字）');
await click('.admin-tab[data-page="study"]'); await sleep(250);
check('学习管理页出现校验面板', await ev(`!document.getElementById('adminGate').hidden && document.getElementById('page-study').contains(document.getElementById('adminGate'))`));
check('学习内容隐藏（防孩子错触）', await ev(`document.querySelector('#page-study .page-body').hidden`));
check('界面页不受校验影响', await ev(`!document.getElementById('page-ui').contains(document.getElementById('adminGate'))`));
await shot('admin-tabs-gate');
await click('.admin-tab[data-page="reset"]'); await sleep(250);
check('校验面板随页移动（系统页）', await ev(`document.getElementById('page-reset').contains(document.getElementById('adminGate'))`));
await click('.admin-tab[data-page="study"]'); await sleep(250);
await answerGate(true); await sleep(200);
check('答错仍上锁', await ev(`document.querySelector('#page-study .page-body').hidden && !document.getElementById('adminGate').hidden`));
check('答错提示 + 换新题', (await ev(`document.getElementById('gateMsg').textContent`)).includes('不对哦'));
await answerGate(); await sleep(200);
check('答对繁体数字后解锁', await ev(`document.getElementById('adminGate').hidden && !document.querySelector('#page-study .page-body').hidden`));
check('会话级解锁已记录', await ev(`sessionStorage.getItem('sp_admin_unlocked')`) === '1');
check('解锁后页签去掉校验提示', await ev(`!document.getElementById('tab-study').title.includes('需家长校验')`));
await click('.admin-tab[data-page="voice"]'); await sleep(250);
check('解锁后发音页直接可见', await ev(`document.getElementById('adminGate').hidden && !document.querySelector('#page-voice .page-body').hidden`));
await nav(`http://127.0.0.1:${PORT}/admin.html`); // 同会话刷新：解锁保持 + 恢复上次停留页
check('刷新后解锁保持（会话级）', await ev(`document.getElementById('adminGate').hidden && !document.querySelector('#page-voice .page-body').hidden`));
check('无 hash 打开恢复上次停留页（发音）', await visiblePage() === 'voice');

console.log('\n[5] hash 直达');
await nav(`http://127.0.0.1:${PORT}/admin.html#reset`);
check('hash 直达 #reset', await visiblePage() === 'reset' && await selectedTab() === 'reset');
await nav(`http://127.0.0.1:${PORT}/admin.html#voice`);
check('hash 直达 #voice', await visiblePage() === 'voice');

console.log('\n[6] 键盘切换');
await ev(`document.getElementById('tab-voice').focus(); document.querySelector('.admin-tabs').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}))`);
await sleep(250);
check('ArrowRight：发音 → 系统', await visiblePage() === 'reset');
await ev(`document.querySelector('.admin-tabs').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}))`);
await sleep(250);
check('ArrowRight 循环：系统 → 学习管理', await visiblePage() === 'study');
await ev(`document.querySelector('.admin-tabs').dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true}))`);
await sleep(250);
check('End → 系统', await visiblePage() === 'reset');
await ev(`document.querySelector('.admin-tabs').dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true}))`);
await sleep(250);
check('Home → 学习管理', await visiblePage() === 'study');

console.log('\n[7] 跨页签状态不丢（面板常驻 DOM）');
await click('.admin-tab[data-page="voice"]'); await sleep(400);
const rows = await ev(`document.querySelectorAll('#missionBody tr').length`);
const voiceStatus = await ev(`document.getElementById('voiceStatus').textContent`);
check('词库表格已渲染', rows > 0);
check('发音状态总览已渲染', /音节 \d+/.test(voiceStatus));
await click('.admin-tab[data-page="study"]'); await sleep(250);
await click('.admin-tab[data-page="voice"]'); await sleep(250);
check('切走再切回：表格行数不变', await ev(`document.querySelectorAll('#missionBody tr').length`) === rows);
check('切走再切回：发音状态不变', await ev(`document.getElementById('voiceStatus').textContent`) === voiceStatus);

console.log('\n[8] 逐页截图');
fs.mkdirSync(path.join(ROOT, '.ui-shots'), { recursive: true });
for (const k of PAGES) {
  await click(`.admin-tab[data-page="${k}"]`); await sleep(400);
  await ev(`document.activeElement?.blur?.()`); // 模拟指针使用：截图不带键盘焦点框
  await shot('admin-tabs-' + k);
}

console.log('ERRORS:', errors.length ? errors : 'none');
console.log(`\n分页 UI 冒烟结果: ${pass} 通过, ${fail} 失败`);
ws.close();
try { process.kill(-chrome.pid); } catch {} try { chrome.kill(); } catch {}
try { server.kill(); } catch {}
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
process.exit(fail || errors.length ? 1 : 0);