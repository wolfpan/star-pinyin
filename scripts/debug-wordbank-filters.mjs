/**
 * debug-wordbank-filters.mjs — 家长端「词库管理 → 显示筛选 / 分页增强」UI 冒烟验收。
 * ------------------------------------------------------------------
 * 隔离环境：临时 DATA_DIR（不碰真实数据），headless Chrome + CDP 走一遍：
 * 年级/构型/来源/标记/搜索筛选 → 组合筛选 → 无结果提示 → 清除筛选 →
 * 每页条数（含本机记忆）→ 页码跳转 / 首末页 / 越界钳制，并截图 .ui-shots/wordbank-filters.png。
 *
 * 运行：node scripts/debug-wordbank-filters.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSyllable } from '../public/js/pinyin-rules.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const CHROME = 'C:\\Users\\panft\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 3102, CDP = 9282;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* -------- 隔离数据 -------- */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'star-pinyin-wordbank-'));
for (const f of ['missions.json', 'progress.json', 'badges.json', 'textbook.json', 'voice-flags.json', 'voice-overrides.json']) {
  const src = path.join(ROOT, 'data', f);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(tmp, f));
}
const missions = JSON.parse(fs.readFileSync(path.join(tmp, 'missions.json'), 'utf8'));
const keyOf = (m) => buildSyllable(m.parts, m.type) + m.tone;
// 预置前 3 条的音节标记，供「已标记」筛选验收
const flagKeys = [...new Set(missions.slice(0, 3).map(keyOf))];
fs.writeFileSync(path.join(tmp, 'voice-flags.json'), JSON.stringify({ updatedAt: new Date().toISOString(), keys: flagKeys }));

/* -------- 期望值（与前端同一套规则） -------- */
const sourceKey = (m) => {
  if (m.isParentInjected) return 'injected';
  const n = Number(String(m.id).replace(/^m_/, ''));
  if (!Number.isInteger(n) || n < 41) return 'seed';
  if (n >= 1001) return 'textbook';
  if (n <= 140) return 'grade3';
  return n <= 500 ? 'extend' : 'advanced';
};
const stripTone = (s) => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const searchCount = (q) => missions.filter((m) => (m.hanzi || '').includes(q) || (m.word || '').includes(q) || stripTone(m.displayPinyin || '').includes(stripTone(q))).length;
const expected = {
  total: missions.length,
  grade1: missions.filter((m) => m.textbook?.grade === 1).length,
  three: missions.filter((m) => m.type === 'three_part').length,
  grade1Three: missions.filter((m) => m.textbook?.grade === 1 && m.type === 'three_part').length,
  flagged: missions.filter((m) => flagKeys.includes(keyOf(m))).length,
  noTextbook: missions.filter((m) => !m.textbook).length,
  textbookSrc: missions.filter((m) => sourceKey(m) === 'textbook').length,
  chuan: searchCount('chuan'),
  船: searchCount('船'),
};

/* -------- 服务器 -------- */
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
  '--remote-debugging-port=' + CDP, '--window-size=1000,1500', '--autoplay-policy=no-user-gesture-required',
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
const setSelect = (id, v) => ev(`(()=>{const s=document.getElementById('${id}');s.value='${v}';s.dispatchEvent(new Event('change'));})()`);
const rowCount = () => ev(`document.querySelectorAll('#missionBody tr').length`);
const fltCount = () => ev(`document.getElementById('fltCount').textContent`);
const pagerInfo = () => ev(`document.querySelector('.pager-info')?.textContent || ''`);
const clickPagerBtn = (text) => ev(`[...document.querySelectorAll('.pager button')].find((b)=>b.textContent==='${text}')?.click()`);
const setSearch = (q) => ev(`(()=>{const s=document.getElementById('fltSearch');s.value=${JSON.stringify(q)};s.dispatchEvent(new Event('input'));})()`);
async function waitFor(expr, tries = 40) {
  for (let i = 0; i < tries; i++) { if (await ev(expr)) return true; await sleep(250); }
  return false;
}

await send('Runtime.enable'); await send('Page.enable');
await waitFor(`document.querySelectorAll('#missionBody tr').length > 0 && document.getElementById('fltCount').textContent !== ''`);
await waitFor(`/音节 \\d+/.test(document.getElementById('voiceStatus').textContent)`); // 标记数据就绪
// 面板已分页：词库表格 / 筛选在「发音」页（需繁体数字家长校验，冒烟自动作答）
await ev(`document.querySelector('.admin-tab[data-page="voice"]')?.click()`); await sleep(300);
await ev(`(()=>{const map={一:'壹',二:'貳',三:'參',四:'肆',五:'伍',六:'陸',七:'柒',八:'捌',九:'玖',十:'拾'};const g=document.getElementById('adminGate');if(g&&!g.hidden){document.getElementById('gateInput').value=map[document.getElementById('gateChar').textContent]||'';document.getElementById('gateBtn').click();}})()`);
await sleep(200);

let pass = 0, fail = 0;
const check = (name, cond) => { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name); } };

console.log('\n[1] 默认加载');
check('无 JS 报错', errors.length === 0);
check('默认每页 20 行', await rowCount() === 20);
check(`计数「共 ${expected.total} 条」`, (await fltCount()) === `共 ${expected.total} 条`);
check('页码信息正确', (await pagerInfo()) === `第 1 / ${Math.ceil(expected.total / 20)} 页 · 共 ${expected.total} 条`);
check('筛选栏 5 控件 + 清除按钮', await ev(`document.querySelectorAll('.mission-filters select').length === 4 && !!document.getElementById('fltSearch') && !!document.getElementById('fltReset')`));

console.log('\n[2] 年级筛选（一年级）');
await setSelect('fltGrade', '1');
check(`筛选后 ${expected.grade1} 条`, (await fltCount()) === `筛选后 ${expected.grade1} / 共 ${expected.total} 条`);
check('本页 20 行', await rowCount() === 20);
check('所有行教材提示均为一年级', await ev(`[...document.querySelectorAll('#missionBody tr td:first-child')].every((td)=>(td.title||'').startsWith('一年级'))`));

console.log('\n[3] 构型筛选（三拼）');
await ev(`document.getElementById('fltReset').click()`);
await setSelect('fltType', 'three_part');
check(`筛选后 ${expected.three} 条`, (await fltCount()) === `筛选后 ${expected.three} / 共 ${expected.total} 条`);
check('所有行构型为三拼', await ev(`[...document.querySelectorAll('#missionBody tr td:nth-child(3)')].every((td)=>td.textContent==='三拼')`));

console.log('\n[4] 组合筛选（一年级 + 三拼）');
await setSelect('fltGrade', '1');
check(`筛选后 ${expected.grade1Three} 条`, (await fltCount()) === `筛选后 ${expected.grade1Three} / 共 ${expected.total} 条`);
check('回到第 1 页', (await pagerInfo()).startsWith('第 1 /'));

console.log('\n[5] 标记筛选');
await ev(`document.getElementById('fltReset').click()`);
await setSelect('fltFlag', 'flagged');
check(`筛选后 ${expected.flagged} 条（预置 ${flagKeys.length} 个音节）`, (await fltCount()) === `筛选后 ${expected.flagged} / 共 ${expected.total} 条`);
check('所有行均为「取消标记」态', await ev(`[...document.querySelectorAll('#missionBody .voice-cell .row-btn:nth-of-type(2)')].every((b)=>b.textContent==='取消标记')`));
await setSelect('fltFlag', 'unflagged');
check(`未标记 ${expected.total - expected.flagged} 条`, (await fltCount()) === `筛选后 ${expected.total - expected.flagged} / 共 ${expected.total} 条`);

console.log('\n[6] 来源筛选（课文同步 / 无教材归属）');
await ev(`document.getElementById('fltReset').click()`);
await setSelect('fltSource', 'textbook');
check(`课文同步 ${expected.textbookSrc} 条`, (await fltCount()) === `筛选后 ${expected.textbookSrc} / 共 ${expected.total} 条`);
await ev(`document.getElementById('fltReset').click()`);
await setSelect('fltGrade', 'none');
check(`无教材归属 ${expected.noTextbook} 条`, (await fltCount()) === `筛选后 ${expected.noTextbook} / 共 ${expected.total} 条`);

console.log('\n[7] 搜索（去调拼音 / 汉字 / 无结果）');
await ev(`document.getElementById('fltReset').click()`);
await setSearch('chuan'); await sleep(450);
check(`chuan（不区分声调）${expected.chuan} 条`, (await fltCount()) === `筛选后 ${expected.chuan} / 共 ${expected.total} 条`);
check('所有行拼音去调后含 chuan', await ev(`[...document.querySelectorAll('#missionBody .py')].every((td)=>td.textContent.normalize('NFD').replace(/[\\u0300-\\u036f]/g,'').toLowerCase().includes('chuan'))`));
await setSearch('船'); await sleep(450);
check(`汉字「船」${expected.船} 条`, (await fltCount()) === `筛选后 ${expected.船} / 共 ${expected.total} 条`);
await setSearch('不存在的词xyz'); await sleep(450);
check('无结果提示', (await ev(`document.getElementById('missionBody').textContent`)).includes('没有符合筛选条件的词条'));
check('筛选后 0 条', (await fltCount()) === `筛选后 0 / 共 ${expected.total} 条`);
await ev(`document.getElementById('fltReset').click()`);
check('清除筛选恢复全量', (await fltCount()) === `共 ${expected.total} 条` && await rowCount() === 20);

console.log('\n[8] 每页条数');
await ev(`(()=>{const s=document.querySelector('.pager select');s.value='50';s.dispatchEvent(new Event('change'));})()`);
check('每页 50 行', await rowCount() === 50);
check('页码信息更新', (await pagerInfo()) === `第 1 / ${Math.ceil(expected.total / 50)} 页 · 共 ${expected.total} 条`);
check('本机记忆 pageSize', await ev(`localStorage.getItem('sp_admin_page_size')`) === '50');

console.log('\n[9] 页码跳转 / 首末页 / 越界钳制');
await ev(`(()=>{const i=document.querySelector('.pager-jump input');i.value='3';})()`);
await clickPagerBtn('跳转');
check('跳转到第 3 页', (await pagerInfo()).startsWith(`第 3 / ${Math.ceil(expected.total / 50)} 页`));
check('第 3 页首行正确', await ev(`document.querySelector('#missionBody tr td')?.textContent`) === missions[100].hanzi);
await clickPagerBtn('末页 »');
const lastPage = Math.ceil(expected.total / 50);
check('末页页码正确', (await pagerInfo()).startsWith(`第 ${lastPage} / ${lastPage} 页`));
check('末页行数正确', await rowCount() === expected.total - (lastPage - 1) * 50);
check('末页时「下一页/末页」禁用', await ev(`[...document.querySelectorAll('.pager button')].filter((b)=>['下一页 ›','末页 »'].includes(b.textContent)).every((b)=>b.disabled)`));
await clickPagerBtn('« 首页');
check('回到首页', (await pagerInfo()).startsWith('第 1 /'));
await ev(`(()=>{const i=document.querySelector('.pager-jump input');i.value='999';})()`);
await clickPagerBtn('跳转');
check('越界页码钳制到末页', (await pagerInfo()).startsWith(`第 ${lastPage} / ${lastPage} 页`));
await ev(`(()=>{const i=document.querySelector('.pager-jump input');i.value='2';i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));})()`);
check('回车跳转生效', (await pagerInfo()).startsWith('第 2 /'));

console.log('\n[10] 截图');
await ev(`document.getElementById('fltReset').click()`);
await setSelect('fltGrade', '1');
await ev(`document.querySelector('.mission-filters').scrollIntoView({block:'start'})`);
await sleep(400);
const shot = await send('Page.captureScreenshot', { format: 'png' });
const shotDir = path.join(ROOT, '.ui-shots');
fs.mkdirSync(shotDir, { recursive: true });
fs.writeFileSync(path.join(shotDir, 'wordbank-filters.png'), Buffer.from(shot.result.data, 'base64'));
console.log('  截图 → .ui-shots/wordbank-filters.png');
await ev(`document.getElementById('fltReset').click(); document.querySelector('.pager').scrollIntoView({block:'end'})`);
await sleep(400);
const shot2 = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync(path.join(shotDir, 'wordbank-pager.png'), Buffer.from(shot2.result.data, 'base64'));
console.log('  截图 → .ui-shots/wordbank-pager.png');

console.log('ERRORS:', errors.length ? errors : 'none');
console.log(`\nUI 冒烟结果: ${pass} 通过, ${fail} 失败`);
try { await send('Browser.close'); } catch {}
ws.close();
try { process.kill(-chrome.pid); } catch {} try { chrome.kill(); } catch {}
try { server.kill(); } catch {}
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
process.exit(fail || errors.length ? 1 : 0);
