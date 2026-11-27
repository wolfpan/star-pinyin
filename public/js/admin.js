/**
 * admin.js — 家长控制面板：学习统计 / 紧急载荷注入（自动辅助拆分）/ 词库管理
 *            / 发音自检与重新生成（TTS API 与 Key 由家长自行填入）。
 *            分页：学习管理 / 界面 / 发音 / 系统（hash 直达 + 记住上次停留页，默认界面页）。
 *            除界面外各页需繁体数字家长校验（会话级），防孩子错触。
 */
import {
  parseSyllable, validateMission, buildSyllable, markTone, detectSpecialRule,
  INITIALS, FINALS, MEDIALS, TYPES, WHOLE_SYLLABLES, categoryOf,
} from './pinyin-rules.js';
import { iconHTML, applyIconStyle, currentIconStyle, ICON_STYLES } from './icons.js';
import { voicesForModel, defaultVoiceFor } from './tts-catalog.js';

const $ = (id) => document.getElementById(id);
const TYPE_LABEL = { two_part: '两拼', three_part: '三拼', zero_initial: '零声母', whole_syllable: '整体认读' };
const pick3 = (arr, exclude) => arr.filter((x) => x !== exclude).slice(0, 3);

/* ----------------------------- 学习统计 ----------------------------- */
async function loadStats() {
  const box = $('stats');
  try {
    const p = await (await fetch('/api/profile')).json();
    const entries = Object.entries(p.tagMastery || {})
      .map(([tag, v]) => ({ tag, attempts: v.attempts, errors: v.errors, rate: v.attempts ? v.errors / v.attempts : 0 }))
      .filter((e) => e.attempts > 0)
      .sort((a, b) => b.rate - a.rate)
      .slice(0, 8);
    if (!entries.length) { box.innerHTML = '<div class="stats-empty">暂无作答记录，孩子完成发射后这里会显示薄弱标签。</div>'; return; }
    box.innerHTML = '';
    for (const e of entries) {
      const pct = Math.round(e.rate * 100);
      const row = document.createElement('div');
      row.className = 'stat-row';
      row.innerHTML = `<span class="stat-tag">${e.tag}</span><span class="stat-bar"><span class="stat-fill" style="width:${pct}%"></span></span><span class="stat-rate">${pct}%</span>`;
      box.append(row);
    }
  } catch (e) { box.innerHTML = '<div class="stats-empty">加载统计失败。</div>'; }
}

/* ----------------------------- 词库管理（筛选 + 分页） ----------------------------- */
const PAGE_SIZES = [20, 50, 100, 200];
let pageSize = 20;
try { const s = Number(localStorage.getItem('sp_admin_page_size')); if (PAGE_SIZES.includes(s)) pageSize = s; } catch {}
let allMissions = [];
let page = 1;
/** 显示筛选：标记 / 年级 / 构型 / 来源 / 关键词（仅影响表格展示，不影响发音自检队列）。 */
const filters = { flag: 'all', grade: 'all', type: 'all', source: 'all', q: '' };

/** 扩展词条来源键：m_041–m_140 三年级专项，m_141–m_500 小学扩展，m_501–m_1000 进阶扩展，m_1001+ 课文同步。 */
function sourceKey(m) {
  if (m.isParentInjected) return 'injected';
  const n = Number(String(m.id).replace(/^m_/, ''));
  if (!Number.isInteger(n) || n < 41) return 'seed';
  if (n >= 1001) return 'textbook';
  if (n <= 140) return 'grade3';
  return n <= 500 ? 'extend' : 'advanced';
}
const SOURCE_LABEL = { injected: '紧急', seed: '种子', grade3: '三年级', extend: '扩展', advanced: '进阶', textbook: '课文' };
function sourceLabel(m) {
  const k = sourceKey(m);
  return k === 'injected' ? `<span class="tag-injected">${iconHTML('beacon')} 紧急</span>` : SOURCE_LABEL[k];
}

/** 教材来源提示（悬停可见）：一年级上册 · 识字2《金木水火土》。 */
function textbookTitle(m) {
  const t = m.textbook;
  if (!t) return '';
  const grade = { 1: '一年级', 2: '二年级', 3: '三年级' }[t.grade] || `${t.grade}年级`;
  const term = t.term === 1 ? '上册' : '下册';
  const lesson = t.kind === '语文园地' ? t.title : `${t.kind === '识字' ? '识字' : '第'}${t.no}课《${t.title}》`;
  return `${grade}${term} · ${lesson}`;
}

async function loadMissions() {
  try {
    const data = await (await fetch('/api/admin/missions')).json();
    allMissions = data.missions || [];
    $('missionCount').textContent = data.count;
    renderMissionPage();
    if (!voicePlaying) renderVoiceSummary();
  } catch (e) {
    $('missionBody').innerHTML = '<tr class="empty-row"><td colspan="8">加载词库失败。</td></tr>';
    $('pager').innerHTML = '';
    $('fltCount').textContent = '';
  }
}

/** 去调拼音（chuán → chuan），搜索时不区分声调。 */
const stripTone = (s) => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

function filteredMissions() {
  const q = filters.q.trim().toLowerCase();
  const qPlain = stripTone(q);
  return allMissions.filter((m) => {
    if (filters.flag !== 'all') {
      const flagged = voiceFlags.has(missionKey(m));
      if ((filters.flag === 'flagged') !== flagged) return false;
    }
    if (filters.grade !== 'all') {
      const g = m.textbook?.grade ?? null;
      if (filters.grade === 'none' ? g !== null : String(g) !== filters.grade) return false;
    }
    if (filters.type !== 'all' && m.type !== filters.type) return false;
    if (filters.source !== 'all' && sourceKey(m) !== filters.source) return false;
    if (q && !((m.hanzi || '').includes(q) || (m.word || '').includes(q) || stripTone(m.displayPinyin || '').includes(qPlain))) return false;
    return true;
  });
}
const filtersActive = () => filters.flag !== 'all' || filters.grade !== 'all' || filters.type !== 'all' || filters.source !== 'all' || filters.q.trim() !== '';

function renderMissionPage() {
  const body = $('missionBody');
  const list = filteredMissions();
  const totalPages = Math.max(1, Math.ceil(list.length / pageSize));
  page = Math.min(Math.max(1, page), totalPages);
  const slice = list.slice((page - 1) * pageSize, page * pageSize);
  body.innerHTML = '';
  if (!slice.length) body.innerHTML = '<tr class="empty-row"><td colspan="8">没有符合筛选条件的词条。</td></tr>';
  for (const m of slice) {
    const tr = document.createElement('tr');
    const rate = Math.round((m.errorRate || 0) * 100);
    const tbTitle = textbookTitle(m);
    tr.innerHTML = `
      <td${tbTitle ? ` title="${tbTitle}"` : ''}>${m.hanzi}</td>
      <td class="py">${m.displayPinyin}</td>
      <td class="ctr">${TYPE_LABEL[m.type] || m.type}</td>
      <td class="num">${m.attempts ? rate + '%' : '—'}</td>
      <td class="ctr"${tbTitle ? ` title="${tbTitle}"` : ''}>${sourceLabel(m)}${tbTitle ? ` ${iconHTML('book')}` : ''}</td>
      <td class="ctr src-cell"></td>
      <td class="voice-cell"></td>
      <td class="actions-cell"></td>`;
    fillSourceCell(tr.children[5], m);
    fillVoiceCell(tr.children[6], m);
    const actions = document.createElement('div');
    actions.className = 'cell-actions';
    tr.lastElementChild.append(actions);
    if (m.isParentInjected) {
      const arch = document.createElement('button');
      arch.className = 'row-btn'; arch.textContent = '取消紧急';
      arch.onclick = async () => { await fetch(`/api/admin/missions/${m.id}?archive=1`, { method: 'DELETE' }); loadMissions(); };
      actions.append(arch);
    }
    const del = document.createElement('button');
    del.className = 'row-btn danger'; del.textContent = '删除';
    del.onclick = async () => { if (confirm(`删除「${m.hanzi} ${m.displayPinyin}」？`)) { await fetch(`/api/admin/missions/${m.id}`, { method: 'DELETE' }); loadMissions(); } };
    actions.append(del);
    body.append(tr);
  }
  // 筛选计数
  $('fltCount').textContent = filtersActive()
    ? `筛选后 ${list.length} / 共 ${allMissions.length} 条`
    : `共 ${allMissions.length} 条`;
  // 翻页控件：首页 / 上一页 / 页码信息 / 下一页 / 末页 + 页码跳转 + 每页条数
  const pager = $('pager');
  pager.innerHTML = '';
  const go = (p) => { page = p; renderMissionPage(); };
  const mkBtn = (text, disabled, onclick) => {
    const b = document.createElement('button');
    b.className = 'row-btn'; b.textContent = text; b.disabled = disabled; b.onclick = onclick;
    return b;
  };
  const first = mkBtn('« 首页', page <= 1, () => go(1));
  const prev = mkBtn('‹ 上一页', page <= 1, () => go(page - 1));
  const info = document.createElement('span');
  info.className = 'pager-info';
  info.textContent = `第 ${page} / ${totalPages} 页 · 共 ${list.length} 条`;
  const next = mkBtn('下一页 ›', page >= totalPages, () => go(page + 1));
  const last = mkBtn('末页 »', page >= totalPages, () => go(totalPages));
  // 页码跳转（输入后点「跳转」或按回车）
  const jump = document.createElement('span');
  jump.className = 'pager-jump';
  const jumpInput = document.createElement('input');
  jumpInput.type = 'number'; jumpInput.min = '1'; jumpInput.max = String(totalPages);
  jumpInput.value = String(page); jumpInput.setAttribute('aria-label', '跳转页码');
  const doJump = () => {
    const n = Number(jumpInput.value);
    if (Number.isInteger(n) && n >= 1) go(Math.min(n, totalPages));
    else jumpInput.value = String(page);
  };
  jumpInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doJump(); });
  jump.append(jumpInput, mkBtn('跳转', false, doJump));
  // 每页条数（本机记忆）
  const sizeSel = document.createElement('select');
  sizeSel.className = 'pager-size'; sizeSel.setAttribute('aria-label', '每页条数');
  for (const n of PAGE_SIZES) {
    const o = document.createElement('option'); o.value = String(n); o.textContent = `${n} 条/页`; sizeSel.append(o);
  }
  sizeSel.value = String(pageSize);
  sizeSel.addEventListener('change', () => {
    pageSize = Number(sizeSel.value);
    try { localStorage.setItem('sp_admin_page_size', String(pageSize)); } catch {}
    go(1);
  });
  pager.append(first, prev, info, next, last, jump, sizeSel);
}

/** 绑定筛选栏：任一条件变化回到第 1 页；搜索防抖 200ms。 */
function bootMissionFilters() {
  const bind = (id, key) => $(id).addEventListener('change', (e) => { filters[key] = e.target.value; page = 1; renderMissionPage(); });
  bind('fltFlag', 'flag');
  bind('fltGrade', 'grade');
  bind('fltType', 'type');
  bind('fltSource', 'source');
  let timer = 0;
  $('fltSearch').addEventListener('input', (e) => {
    clearTimeout(timer);
    const v = e.target.value;
    timer = setTimeout(() => { filters.q = v; page = 1; renderMissionPage(); }, 200);
  });
  $('fltReset').addEventListener('click', () => {
    Object.assign(filters, { flag: 'all', grade: 'all', type: 'all', source: 'all', q: '' });
    for (const id of ['fltFlag', 'fltGrade', 'fltType', 'fltSource']) $(id).value = 'all';
    $('fltSearch').value = '';
    page = 1;
    renderMissionPage();
  });
}

/* ----------------------------- 发音自检 · 重新生成 ----------------------------- */
// 读音文件按「音节」共享（ju4.wav 等），与 kids 端 audio-engine 同一优先级：wav → mp3 → 现场 TTS。
// 标记存服务端 data/voice-flags.json（与 voice-check.html 共用）；重新生成走 /api/admin/voice/regenerate。
let voiceFiles = {};            // key -> 'wav' | 'mp3' | 'tts'（按生效源）
let voiceFlags = new Set();     // 被家长标记「不顺耳」的音节
let voiceSource = { default: 'lib', keys: {} };  // 读音来源：lib=真人录音库 / tts=AI 合成
let voiceLibKeys = new Set();   // 有真人录音的音节
let voiceTtsKeys = new Set();   // 有 AI 录音的音节
let voiceAudio = null;
let voicePlaying = false;
let voiceQueue = [];
let voiceResolve = null;
let regenTimer = 0;
let voiceObjUrl = null;         // 当前试听音频的 blob URL（停止/播完即释放）
let voicePlayToken = 0;         // 播放令牌：fetch 期间被「停止/切歌」作废的播放不再出声

const releaseVoiceObjUrl = () => {
  if (voiceObjUrl) { try { URL.revokeObjectURL(voiceObjUrl); } catch {} voiceObjUrl = null; }
};

/**
 * 先把音频 fetch 成 blob 再播（cache:'no-store' 强制回源）。
 * 不能直接 new Audio(文件URL)：Safari/Chrome 的媒体缓存会按 URL 缓存旧音频、
 * 无视 no-cache，且跨页面刷新仍在——正是「重新生成后还是旧发音」的根源。
 * 取字节播放保证每次试听都是磁盘上最新那份，重新生成后无需刷新。
 */
async function fetchVoiceAudio(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const blob = await res.blob();
  if (!blob.size) throw new Error('空音频');
  releaseVoiceObjUrl();
  voiceObjUrl = URL.createObjectURL(blob);
  const u = voiceObjUrl;
  const a = new Audio(u);
  const release = () => { if (voiceObjUrl === u) releaseVoiceObjUrl(); };
  a.addEventListener('ended', release, { once: true });
  a.addEventListener('error', release, { once: true });
  return a;
}

const missionKey = (m) => buildSyllable(m.parts, m.type) + m.tone;
const voiceFileKey = (k) => String(k).replace(/ü/g, 'v');
/** 多音字兜底带词组上下文（如「长大的长」），与 kids 端 slowSplit 一致。 */
const voiceContext = (m) => (m.word && m.word !== m.hanzi ? `${m.word}的${m.hanzi}` : m.hanzi);

/** 全库去重音节组（自检队列用）。 */
function syllableGroups() {
  const map = new Map();
  for (const m of allMissions) {
    const key = missionKey(m);
    if (!map.has(key)) map.set(key, { key, display: m.displayPinyin, hanziSet: new Set(), context: voiceContext(m) });
    map.get(key).hanziSet.add(m.hanzi);
  }
  return [...map.values()].sort((a, b) => a.key.localeCompare(b.key));
}

function voiceUrlFor(key, context) {
  const st = voiceFiles[key] || 'tts';
  const fk = voiceFileKey(key);
  if (st === 'wav') return `/audio/voice/${fk}.wav`;
  if (st === 'mp3') return `/audio/voice/${fk}.mp3`;
  return `/api/tts?text=${encodeURIComponent(context || key)}`;
}

async function loadVoiceStatus() {
  try {
    const j = await (await fetch('/api/admin/voice/status')).json();
    voiceFiles = j.files || {};
    voiceFlags = new Set(j.flags || []);
    voiceSource = j.source || { default: 'lib', keys: {} };
    voiceLibKeys = new Set(j.libKeys || []);
    voiceTtsKeys = new Set(j.ttsKeys || []);
  } catch { voiceFiles = {}; }
  renderVoiceSummary();
  renderSourceButtons();
  renderMissionPage();
}

/** 全局来源切换按钮态；srcState 平时为空，仅切换失败时显示报错。 */
function renderSourceButtons() {
  const lib = $('srcLib'), tts = $('srcTts');
  if (!lib || !tts) return;
  lib.classList.toggle('primary', voiceSource.default !== 'tts');
  tts.classList.toggle('primary', voiceSource.default === 'tts');
  lib.setAttribute('aria-pressed', String(voiceSource.default !== 'tts'));
  tts.setAttribute('aria-pressed', String(voiceSource.default === 'tts'));
  const state = $('srcState');
  state.textContent = '';
  state.className = 'voice-source-state';
}

async function setVoiceDefault(src) {
  try {
    const r = await fetch('/api/admin/voice/source', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ default: src }),
    });
    if (!r.ok) throw new Error((await r.json()).error || 'HTTP ' + r.status);
    await loadVoiceStatus();
  } catch (e) {
    const state = $('srcState');
    state.textContent = '切换失败：' + e.message;
    state.className = 'voice-source-state bad';
  }
}

/** 状态总览渲染成等距小徽章（点色与表格图例一致）；文案保留「音节 N / 已标记 N」供冒烟脚本断言。 */
function renderVoiceSummary() {
  const groups = syllableGroups();
  const wav = groups.filter((g) => (voiceFiles[g.key] || 'tts') === 'wav').length;
  const mp3 = groups.filter((g) => voiceFiles[g.key] === 'mp3').length;
  const tts = groups.length - wav - mp3;
  const srcName = voiceSource.default === 'tts' ? 'AI合成' : '真人发声';
  const chip = (dot, label, n, title) =>
    `<span class="voice-stat"${title ? ` title="${title}"` : ''}>${dot ? `<i class="v-dot ${dot}"></i>` : ''}${label} <b>${n}</b></span>`;
  $('voiceStatus').innerHTML =
    chip('', '音节', groups.length) +
    chip('v-wav', '本地 wav', wav, `当前来源：${srcName}`) +
    chip('v-mp3', '旧 mp3', mp3) +
    chip('v-tts', '需现场合成', tts) +
    chip('v-flag', '已标记', voiceFlags.size);
}

/**
 * 某词条的读音来源详情（「读音来源」列用）：
 * sel = 配置生效源（逐音节覆盖 > 全局默认）；actual = 实际播放源
 * （与服务端 resolveVoiceWav 同规则：首选源缺失时回退另一份，绝不留缺）。
 */
function voiceSourceInfo(m) {
  const key = missionKey(m);
  const fk = voiceFileKey(key);
  const st = voiceFiles[key] || 'tts';
  const ov = voiceSource.keys[fk];
  const sel = (ov === 'lib' || ov === 'tts') ? ov : voiceSource.default;
  const hasLib = voiceLibKeys.has(key);
  const hasTts = voiceTtsKeys.has(key);
  const order = sel === 'lib' ? ['lib', 'tts'] : ['tts', 'lib'];
  const actual = st === 'wav' ? (order.find((s) => (s === 'lib' ? hasLib : hasTts)) || 'tts') : null;
  return { key, st, sel, ov, hasLib, hasTts, actual };
}

/** 表格「读音来源」列：状态点 + 真人 / AI / 旧 mp3 / 缺失（悬停看双源库存与覆盖详情）。 */
function fillSourceCell(td, m) {
  const info = voiceSourceInfo(m);
  let cls, label, title;
  if (info.st === 'wav') {
    const isLib = info.actual === 'lib';
    cls = isLib ? 'src-lib' : 'src-tts';
    label = isLib ? '真人' : 'AI';
    title = `当前播放：${isLib ? '真人录音库' : 'AI 合成'}`;
    if (info.actual !== info.sel) title += `（首选${info.sel === 'lib' ? '真人' : 'AI'}缺失，已回退另一份）`;
  } else if (info.st === 'mp3') {
    cls = 'src-mp3'; label = '旧 mp3';
    title = '旧版 mp3 兼容兜底，建议重新生成';
  } else {
    cls = 'src-none'; label = '缺失';
    title = '本地无录音，试听时现场 AI 合成';
  }
  title += `\n真人录音：${info.hasLib ? '有' : '无'} · AI 合成：${info.hasTts ? '有' : '无'}`;
  if (info.ov) title += `\n逐音节覆盖：${info.ov === 'lib' ? '真人' : 'AI'}（在音节自检页设置）`;
  const tag = document.createElement('span');
  tag.className = 'v-src ' + cls;
  tag.title = title;
  const dot = document.createElement('i');
  dot.className = `v-dot v-${info.st}` + (info.st === 'wav' ? ` s-${info.actual}` : '');
  tag.append(dot, document.createTextNode(label));
  td.append(tag);
  if (info.ov) {
    const ov = document.createElement('span');
    ov.className = 'v-override';
    ov.textContent = '覆盖';
    ov.title = '该音节已单独指定读音来源（在音节自检页设置）';
    td.append(ov);
  }
}

/** 表格「发音」列：试听 / 标记 / 重新生成（读音来源已单列，见 fillSourceCell）。 */
function fillVoiceCell(td, m) {
  const key = missionKey(m);
  const flagged = voiceFlags.has(key);
  const box = document.createElement('div');
  box.className = 'cell-actions';
  const play = document.createElement('button');
  play.className = 'row-btn'; play.textContent = '▶ 试听';
  play.onclick = () => playMissionVoice(m);
  box.append(play);
  const flag = document.createElement('button');
  flag.className = 'row-btn' + (flagged ? ' flagged' : '');
  flag.textContent = flagged ? '取消标记' : '标记';
  flag.title = '听着不顺耳就标记，随后可一键重新生成';
  flag.onclick = () => toggleVoiceFlag(key);
  box.append(flag);
  const regen = document.createElement('button');
  regen.className = 'row-btn'; regen.textContent = '↻ 重生成';
  regen.title = `重新生成「${m.displayPinyin}」的 AI 读音（不覆盖真人录音）`;
  regen.onclick = () => startRegen({ keys: [key] }, `「${m.displayPinyin}」`);
  box.append(regen);
  td.append(box);
}

function stopVoicePlayback() {
  voicePlayToken++;
  voicePlaying = false;
  voiceQueue = [];
  if (voiceAudio) { try { voiceAudio.pause(); } catch {} voiceAudio = null; }
  releaseVoiceObjUrl();
  if (voiceResolve) { voiceResolve(); voiceResolve = null; }
}

async function playMissionVoice(m) {
  stopVoicePlayback();
  const token = voicePlayToken;
  try {
    const a = await fetchVoiceAudio(voiceUrlFor(missionKey(m), voiceContext(m)));
    if (token !== voicePlayToken) return; // 取音频期间已被停止/切换
    voiceAudio = a;
    await a.play().catch(() => {});
  } catch { /* 试听失败静默，不影响其它操作 */ }
}

/** 依次自检：逐个音节播放，播完自动继续；「停止」随时打断。 */
async function playVoiceQueue(list) {
  stopVoicePlayback();
  voiceQueue = list.slice();
  voicePlaying = true;
  const token = voicePlayToken;
  while (voicePlaying && voiceQueue.length) {
    const g = voiceQueue.shift();
    $('voiceStatus').textContent = `正在播放 ${g.display}（${[...g.hanziSet].slice(0, 3).join('')}）· 剩余 ${voiceQueue.length}`;
    await new Promise((resolve) => {
      voiceResolve = resolve;
      fetchVoiceAudio(voiceUrlFor(g.key, g.context)).then((a) => {
        if (!voicePlaying || token !== voicePlayToken) { releaseVoiceObjUrl(); resolve(); return; }
        voiceAudio = a;
        a.addEventListener('ended', resolve, { once: true });
        a.addEventListener('error', resolve, { once: true });
        a.play().catch(resolve);
      }).catch(resolve);
      setTimeout(resolve, 4000);
    });
    voiceResolve = null;
  }
  if (voicePlaying) { voicePlaying = false; renderVoiceSummary(); }
}

async function toggleVoiceFlag(key) {
  if (voiceFlags.has(key)) voiceFlags.delete(key); else voiceFlags.add(key);
  renderMissionPage();
  renderVoiceSummary();
  try {
    await fetch('/api/voice/flags', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys: [...voiceFlags] }),
    });
  } catch { /* 离线时仅本页生效 */ }
}

/* -------- 重新生成（服务端后台任务 + 进度轮询） -------- */

async function startRegen(payload, label) {
  const box = $('regenProgress');
  try {
    const r = await fetch('/api/admin/voice/regenerate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    const j = await r.json();
    if (!r.ok) { box.innerHTML = `<span class="bad">无法重新生成：${j.error || 'HTTP ' + r.status}</span>`; return; }
    if (!j.total) { box.innerHTML = '<span class="ok">没有需要重新生成的音节。</span>'; return; }
    box.textContent = `已开始重新生成 ${label || j.total + ' 个音节'}…`;
    pollRegen();
  } catch (e) { box.innerHTML = `<span class="bad">网络错误：${e.message}</span>`; }
}

function pollRegen() {
  clearInterval(regenTimer);
  const tick = async () => {
    let j;
    try { j = await (await fetch('/api/admin/voice/regenerate')).json(); } catch { return; }
    renderRegenProgress(j);
    if (!j.running) { clearInterval(regenTimer); regenTimer = 0; loadVoiceStatus(); }
  };
  tick();
  regenTimer = setInterval(tick, 1200);
}

function renderRegenProgress(j) {
  const box = $('regenProgress');
  if (!j || j.idle) { box.innerHTML = ''; return; }
  const pct = j.total ? Math.round((j.done / j.total) * 100) : 0;
  const fails = (j.results || []).filter((r) => !r.ok);
  let html = `<div class="regen-bar"><span style="width:${pct}%"></span></div>`;
  html += `<div>${j.running ? `正在生成 ${j.current || ''} · ${j.done}/${j.total}` : (j.cancelled ? '已停止' : '生成完成')} · 成功 ${j.ok} · 失败 ${j.fail}</div>`;
  if (fails.length) html += `<div class="bad">失败：${fails.slice(0, 6).map((f) => `${f.key}（${f.error}）`).join('；')}${fails.length > 6 ? ' …' : ''}</div>`;
  if (!j.running && j.ok) html += '<div class="ok">新读音已就绪，请再试听确认；满意后可取消标记。</div>';
  box.innerHTML = html;
}

async function stopRegen() {
  const box = $('regenProgress');
  try {
    const r = await fetch('/api/admin/voice/regenerate/stop', { method: 'POST' });
    const j = await r.json();
    box.innerHTML = j.cancelling ? '正在停止（当前音节做完即停）…' : '<span class="ok">当前没有运行中的生成任务。</span>';
  } catch (e) { box.innerHTML = `<span class="bad">停止失败：${e.message}</span>`; }
}

/* -------- TTS合成API设置（API 地址 + Key → 自动获取模型与音色） -------- */
// 家长只填 API 地址与 Key：点「自动获取」（或 Key 失焦 / 首次打开「发音」页）后，
// 服务端去问接口要模型列表（OpenAI 兼容 /v1/models），音色用内置音色表 + 接口定制音色合并。
// 下拉框保留「手动填写…」入口，音色随模型变化（跨模型混用接口会直接报错）。
const TTS_CUSTOM = '__custom__';
const ttsState = {
  models: [], voices: [], live: [], model: '', voice: '', endpoint: '',
  hasKey: false, sig: '',
};
const ttsPickEls = (name) => ({ sel: $(name + 'Sel'), input: $(name) });

/** 当前值：选「手动填写」时取输入框，否则取下拉框。 */
function ttsPickValue(name) {
  const { sel, input } = ttsPickEls(name);
  if (!sel || !sel.value) return input ? input.value.trim() : '';
  return sel.value === TTS_CUSTOM ? input.value.trim() : sel.value;
}

/** 重建下拉框：items = [{ id, label, group }]；已保存但列表里没有的值也保留（标「已保存」）。 */
function fillTtsPick(name, items, value) {
  const { sel, input } = ttsPickEls(name);
  const list = [];
  const seen = new Set();
  const push = (id, label, group) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    list.push({ id, label: label || '', group: group || '' });
  };
  if (value && !items.some((it) => it.id === value)) push(value, '已保存', '当前设置');
  for (const it of items) push(it.id, it.label, it.group);
  sel.innerHTML = '';
  if (!list.length) {
    // 一条都没有（还没获取 / 接口没给）：仍留「手动填写…」，接口不配合时家长也能自己填
    const o = document.createElement('option');
    o.value = ''; o.disabled = true; o.selected = true;
    o.textContent = '（还没获取，点下方「自动获取模型 / 音色」）';
    sel.append(o);
    const custom = document.createElement('option');
    custom.value = TTS_CUSTOM;
    custom.textContent = '✎ 手动填写…';
    sel.append(custom);
    input.hidden = true;
    return;
  }
  const groups = new Map();
  for (const it of list) {
    if (!groups.has(it.group)) groups.set(it.group, []);
    groups.get(it.group).push(it);
  }
  for (const [group, groupItems] of groups) {
    const host = group ? sel.appendChild(document.createElement('optgroup')) : sel;
    if (group) host.label = group;
    for (const it of groupItems) {
      const o = document.createElement('option');
      o.value = it.id;
      o.textContent = it.label ? `${it.id} · ${it.label}` : it.id;
      host.append(o);
    }
  }
  const custom = document.createElement('option');
  custom.value = TTS_CUSTOM;
  custom.textContent = '✎ 手动填写…';
  sel.append(custom);
  sel.value = list.some((it) => it.id === value) ? value : list[0].id;
  ttsSyncPick(name);
}

/** 选「手动填写…」时露出输入框；选回列表项时收起。 */
function ttsSyncPick(name, { focus = false } = {}) {
  const { sel, input } = ttsPickEls(name);
  const custom = sel.value === TTS_CUSTOM;
  input.hidden = !custom;
  if (custom && focus) input.focus();
}

function ttsModelItems() {
  // 只列语音合成模型（接口通常还会返回一堆聊天 / 画图模型，容易误选）；
  // 一个都识别不出来时退回全量列表，家长仍可选「手动填写…」。
  const tts = ttsState.models.filter((m) => m.recommended);
  const pool = tts.length ? tts : ttsState.models;
  return pool.map((m) => ({
    id: m.id,
    label: m.label || '',
    group: m.recommended ? '语音合成模型（推荐）' : '接口里的其他模型',
  }));
}

/** 某模型可用的音色：内置音色表 + 接口返回的定制音色（按 model 过滤）。 */
function ttsVoiceItems(model) {
  const items = voicesForModel(model).map((v) => ({ id: v.id, label: v.label, group: '内置音色表' }));
  for (const v of ttsState.live) {
    if (v.model && v.model !== model) continue;
    items.push({ id: v.id, label: v.label || '定制 / 复刻音色', group: '接口里的定制音色' });
  }
  if (!items.length && model && model === ttsState.model) {
    for (const v of ttsState.voices) {
      items.push({ id: v.id, label: v.label || '', group: v.source === 'api' ? '接口里的定制音色' : '内置音色表' });
    }
  }
  return items;
}

/** 按当前状态重画两个下拉框（model / voice 为要选中的值）。 */
function renderTtsPicks({ model = '', voice = '' } = {}) {
  fillTtsPick('ttsModel', ttsModelItems(), model);
  const pickedModel = ttsPickValue('ttsModel');
  fillTtsPick('ttsVoice', ttsVoiceItems(pickedModel), voice);
  updateTtsHint();
}

function updateTtsHint() {
  const hint = $('ttsPickHint');
  if (!hint) return;
  const model = ttsPickValue('ttsModel');
  const voiceCount = ttsVoiceItems(model).length;
  const ttsCount = ttsState.models.filter((m) => m.recommended).length;
  hint.textContent = ttsState.models.length
    ? `已获取 ${ttsState.models.length} 个模型（其中 ${ttsCount} 个语音合成）· ${voiceCount} 个音色${ttsState.endpoint ? `（模型来自 ${ttsState.endpoint}）` : ''}；改完点「保存设置」生效。`
    : '还没获取：填好 API 地址与 Key 后点「自动获取模型 / 音色」。';
}

function setTtsMsg(text, kind = '') {
  const msg = $('ttsMsg');
  msg.className = 'inject-msg' + (kind ? ' ' + kind : '');
  msg.textContent = text;
}

async function loadTtsConfig() {
  try {
    const j = await (await fetch('/api/admin/tts-config')).json();
    $('ttsUrl').value = j.url || '';
    $('ttsKey').value = '';
    $('ttsKey').placeholder = j.hasKey ? `已保存 ${j.keyHint} · 留空则沿用` : '填入你的 API Key';
    ttsState.hasKey = !!j.hasKey;
    const state = $('ttsKeyState');
    state.textContent = j.hasKey ? (j.keyFrom === 'admin' ? '✓ Key 已保存' : '✓ Key 来自环境变量') : '✗ 未配置 Key';
    state.className = 'tts-key-state ' + (j.hasKey ? 'ok' : 'bad');
    renderTtsPicks({ model: j.model, voice: j.voice });
  } catch { /* 服务未连接 */ }
}

async function saveTtsConfig({ silent = false } = {}) {
  const body = {
    url: $('ttsUrl').value.trim(),
    model: ttsPickValue('ttsModel'),
    voice: ttsPickValue('ttsVoice'),
    key: $('ttsKey').value.trim(),
  };
  try {
    const r = await fetch('/api/admin/tts-config', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status);
    if (!silent) setTtsMsg('已保存。可点「测试合成」验证 API 与 Key。', 'ok');
    await loadTtsConfig();
    return true;
  } catch (e) {
    setTtsMsg('保存失败：' + e.message, 'bad');
    return false;
  }
}

/* 自动获取：同一个「地址 + Key」只自动问一次（失败也算问过，点按钮可重试）。 */
let ttsDiscoverRun = null;
function discoverTts(opts = {}) {
  if (ttsDiscoverRun) return ttsDiscoverRun;
  ttsDiscoverRun = runTtsDiscover(opts).finally(() => { ttsDiscoverRun = null; });
  return ttsDiscoverRun;
}

async function runTtsDiscover({ auto = false } = {}) {
  const url = $('ttsUrl').value.trim();
  const key = $('ttsKey').value.trim();
  const sig = url + '|' + (key ? key.slice(-6) : 'saved');
  if (auto && ttsState.sig === sig) return;
  if (!/^https?:\/\//i.test(url)) {
    if (!auto) setTtsMsg('先填 API 地址（http:// 或 https:// 开头）', 'bad');
    return;
  }
  if (!key && !ttsState.hasKey) {
    if (!auto) setTtsMsg('先填 API Key（保存过的 Key 留空即可沿用）', 'bad');
    return;
  }
  const btn = $('ttsDiscoverBtn');
  const label = btn.textContent;
  ttsState.sig = sig;
  btn.disabled = true;
  btn.textContent = '获取中…';
  if (!auto) setTtsMsg('正在问接口要模型与音色…');
  try {
    const r = await fetch('/api/admin/tts-config/discover', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, key, model: ttsPickValue('ttsModel'), voice: ttsPickValue('ttsVoice') }),
    });
    const j = await r.json();
    if (!r.ok || !j.ok) throw new Error(j.error || 'HTTP ' + r.status);
    ttsState.models = j.models || [];
    ttsState.voices = j.voices || [];
    ttsState.live = j.liveVoices || [];
    ttsState.model = j.model || '';
    ttsState.voice = j.voice || '';
    ttsState.endpoint = j.endpoint || '';
    renderTtsPicks({ model: j.model, voice: j.voice });
    // 数量与来源已在提示行，这里只说结果 + 需要家长注意的事（换音色、手填音色等）
    const notes = (j.notes || []).filter((n) => !n.startsWith('模型列表来自'));
    setTtsMsg(notes.length ? `已自动获取：${notes.join('；')}` : '已自动获取模型与音色，选好后点「保存设置」生效。', 'ok');
  } catch (e) {
    setTtsMsg('自动获取失败：' + e.message, 'bad');
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

/* 换模型 → 音色列表跟着换（保留仍然可用的旧音色，否则回落到该模型默认音色）。 */
function onTtsModelChange() {
  ttsSyncPick('ttsModel', { focus: true });
  const model = ttsPickValue('ttsModel');
  const items = ttsVoiceItems(model);
  const current = ttsPickValue('ttsVoice');
  let next = items.some((it) => it.id === current) ? current : '';
  if (!next) next = defaultVoiceFor(model) || (model === ttsState.model ? ttsState.voice : '');
  if (!items.some((it) => it.id === next)) next = items[0] ? items[0].id : '';
  fillTtsPick('ttsVoice', items, next);
  updateTtsHint();
}

/* -------- 测试合成试播（测试成功 + a o e i u ü） --------
 * 浏览器 autoplay 限制：fetch 回来再 play() 会被拒（iPad Safari 尤甚）。
 * 对策：点击手势内先用 0.1s 静音 WAV 解锁同一个 Audio 元素（iOS 按元素解锁），
 * 音频到达后换 src 再播；仍被拒时显形「播放试音」按钮兜底（手势内必能播）。
 * 元素挂全局引用：防 Safari 回收脱离文档的 Audio 导致播一半断声。 */
let testAudio = null;
let testObjUrl = null;
const releaseTestObjUrl = () => {
  if (testObjUrl) { try { URL.revokeObjectURL(testObjUrl); } catch {} testObjUrl = null; }
};

/** 0.1s 静音 WAV blob URL（手势内解锁用）。 */
function silentWavUrl() {
  const n = 2400, rate = 24000;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const wstr = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  wstr(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); wstr(8, 'WAVE'); wstr(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  wstr(36, 'data'); v.setUint32(40, n * 2, true);
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}

function ensureTestAudio() {
  if (!testAudio) {
    testAudio = new Audio();
    testAudio.addEventListener('error', () => offerTestReplay('试音解码失败'));
  }
  return testAudio;
}

/** 点击手势内同步调用：播一次静音解锁该元素（拒绝也静默，后面还有兜底按钮）。 */
function armTestAudio() {
  const a = ensureTestAudio();
  const u = silentWavUrl();
  a.src = u;
  const p = a.play();
  if (p && p.catch) p.catch(() => {});
  setTimeout(() => { try { URL.revokeObjectURL(u); } catch {} }, 2000);
}

/** 自动播被拒 / 解码失败时：在提示行显形手动播放按钮（手势内播放必被允许）。 */
function offerTestReplay(note) {
  const msg = $('ttsMsg');
  if (document.getElementById('ttsReplayWrap')) return;
  const wrap = document.createElement('span');
  wrap.id = 'ttsReplayWrap';
  const tip = document.createElement('span');
  tip.className = 'bad';
  tip.textContent = ' · ' + note;
  const b = document.createElement('button');
  b.id = 'ttsReplayBtn'; b.className = 'row-btn'; b.type = 'button';
  b.textContent = '▶ 播放试音';
  b.onclick = () => {
    const p = ensureTestAudio().play();
    if (p && p.then) p.then(() => wrap.remove()).catch((e) => { tip.textContent = ' · 播放失败：' + (e?.name || e); });
    else wrap.remove();
  };
  wrap.append(tip, b);
  msg.append(wrap);
}

/** 与服务端 TTS_TEST_TEXT 一致的试读文本（旧服务端兜底走 /api/tts 时用）。 */
const TTS_TEST_TEXT = '测试成功。啊、噢、鹅、衣、乌、鱼。';

/** 字节 → blob：按魔数纠正容器（个别接口请求 mp3 仍回 wav），MIME 错会解码失败。 */
function audioBlob(bytes, mime) {
  const magic = (o, n) => String.fromCharCode(...bytes.subarray(o, o + n));
  const isWav = bytes.length > 12 && magic(0, 4) === 'RIFF' && magic(8, 4) === 'WAVE';
  return new Blob([bytes], { type: isWav ? 'audio/wav' : (mime || 'audio/mpeg') });
}

function playTestAudio(j) {
  releaseTestObjUrl();
  const start = (bytes, mime) => {
    testObjUrl = URL.createObjectURL(audioBlob(bytes, mime));
    const a = ensureTestAudio();
    a.src = testObjUrl;
    a.load();
    const p = a.play();
    if (p && p.catch) p.catch((e) => offerTestReplay(`自动播放被浏览器拦截（${e?.name || '未知'}），点按钮听试音`));
    // 出声自检：play() resolve 后 400ms 仍不推进 = 没出声（静音/卡死/假成功），显形兜底按钮
    setTimeout(() => {
      if (testObjUrl && a.src === testObjUrl && !a.ended && (a.paused || a.currentTime === 0)) {
        offerTestReplay('试播未出声，点按钮听试音');
      }
    }, 400);
  };
  if (j.audio) {
    try {
      const bin = atob(j.audio);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      start(bytes, j.mime);
    } catch (e) { offerTestReplay('试播失败：' + e.message); }
    return;
  }
  // 旧服务端响应不带 audio：走 /api/tts 合成同一句试读文本再播（服务端无需重启也有声）
  fetch(`/api/tts?text=${encodeURIComponent(TTS_TEST_TEXT)}`, { cache: 'no-store' })
    .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer(); })
    .then((buf) => start(new Uint8Array(buf), 'audio/mpeg'))
    .catch((e) => offerTestReplay('试播取音失败：' + e.message));
}

/* 测试合成 = 先保存当前选择再试合成：「自动获取 → 选音色 → 测试」不该听到旧音色。 */
async function testTts() {
  const btn = $('ttsTestBtn');
  btn.disabled = true;
  setTtsMsg('正在保存设置并试合成一句…');
  armTestAudio(); // 手势内同步解锁试播元素（autoplay 限制对策）
  try {
    if (!(await saveTtsConfig({ silent: true }))) return;
    const r = await fetch('/api/admin/tts-config/test', { method: 'POST' });
    const j = await r.json();
    if (!r.ok || !j.ok) throw new Error(j.error || 'HTTP ' + r.status);
    setTtsMsg(`合成成功 · ${(j.bytes / 1024).toFixed(1)} KB · ${j.ms} ms · 试播：测试成功 + a o e i u ü`, 'ok');
    stopVoicePlayback(); // 避免与依次自检叠音
    playTestAudio(j);
  } catch (e) { setTtsMsg('测试失败：' + e.message, 'bad'); }
  finally { btn.disabled = false; }
}

function bootVoiceAdmin() {
  $('ttsSaveBtn').addEventListener('click', () => saveTtsConfig());
  $('ttsTestBtn').addEventListener('click', testTts);
  $('ttsDiscoverBtn').addEventListener('click', () => discoverTts());
  $('ttsModelSel').addEventListener('change', onTtsModelChange);
  $('ttsVoiceSel').addEventListener('change', () => ttsSyncPick('ttsVoice', { focus: true }));
  // 填完 Key 失焦 / 改完地址 → 自动获取（同一组设置只问一次，失败点按钮可重试）
  $('ttsKey').addEventListener('blur', () => discoverTts({ auto: true }));
  $('ttsUrl').addEventListener('change', () => discoverTts({ auto: true }));
  let ttsModelTimer = 0;
  $('ttsModel').addEventListener('input', () => { clearTimeout(ttsModelTimer); ttsModelTimer = setTimeout(onTtsModelChange, 300); });
  $('srcLib').addEventListener('click', () => setVoiceDefault('lib'));
  $('srcTts').addEventListener('click', () => setVoiceDefault('tts'));
  $('voicePlayAll').addEventListener('click', () => playVoiceQueue(syllableGroups()));
  $('voicePlayBad').addEventListener('click', () => playVoiceQueue(syllableGroups().filter((g) => voiceFlags.has(g.key) || (voiceFiles[g.key] || 'tts') !== 'wav')));
  $('voiceStop').addEventListener('click', () => { stopVoicePlayback(); renderVoiceSummary(); });
  $('voiceRegenFlagged').addEventListener('click', () => {
    if (!voiceFlags.size) { $('regenProgress').innerHTML = '<span class="bad">还没有标记的音节：先试听，把不顺耳的「标记」出来。</span>'; return; }
    startRegen({ scope: 'flagged' }, `${voiceFlags.size} 个标记音节`);
  });
  $('voiceRegenAll').addEventListener('click', () => {
    const n = syllableGroups().length;
    if (!confirm(`重新生成全部 ${n} 个音节的 AI 读音？\n（只更新 AI 合成那份，真人录音不受影响；当前默认来源为${voiceSource.default === 'tts' ? ' AI' : '真人'}）\n预计耗时 ${Math.max(1, Math.ceil((n * 2.5) / 60))} 分钟，会消耗 TTS 配额。`)) return;
    startRegen({ scope: 'all' }, `全部 ${n} 个音节`);
  });
  $('voiceRegenStop').addEventListener('click', stopRegen);
  loadTtsConfig().then(() => { if (adminPage === 'voice') discoverTts({ auto: true }); });
  loadVoiceStatus();
  // 页面刷新前若有任务在跑，恢复进度显示
  fetch('/api/admin/voice/regenerate').then((r) => r.json()).then((j) => {
    if (j.running) { renderRegenProgress(j); pollRegen(); }
  }).catch(() => {});
}

/* ----------------------------- 自动辅助拆分 ----------------------------- */
function buildSplitControls() {
  const box = $('splitFields');
  const mk = (id, label, options) => {
    const lab = document.createElement('label');
    lab.textContent = label;
    const sel = document.createElement('select');
    sel.id = id;
    for (const [val, txt] of options) { const o = document.createElement('option'); o.value = val; o.textContent = txt; sel.append(o); }
    lab.append(sel);
    lab.dataset.field = id;
    box.append(lab);
    sel.addEventListener('change', () => { toggleVisibility(); updatePreview(); });
    return sel;
  };
  mk('sType', '构型', TYPES.map((t) => [t, TYPE_LABEL[t]]));
  mk('sInitial', '声母', [['', '无'], ...INITIALS.map((x) => [x, x])]);
  mk('sMedial', '介母', [['', '无'], ...MEDIALS.map((x) => [x, x])]);
  mk('sFinal', '韵母', [['', '无'], ...FINALS.map((x) => [x, x])]);
  mk('sWhole', '整体音节', WHOLE_SYLLABLES.map((x) => [x, x]));
  mk('sTone', '声调', [[1, '1 阴平'], [2, '2 阳平'], [3, '3 上声'], [4, '4 去声'], [0, '轻声']]);
}

function toggleVisibility() {
  const type = $('sType').value;
  const show = (id, on) => { document.querySelector(`[data-field="${id}"]`).style.display = on ? '' : 'none'; };
  show('sWhole', type === 'whole_syllable');
  show('sInitial', type === 'two_part' || type === 'three_part');
  show('sMedial', type === 'three_part');
  show('sFinal', type !== 'whole_syllable');
}

function readParts() {
  const type = $('sType').value;
  if (type === 'whole_syllable') return { initial: null, medial: null, final: null, whole: $('sWhole').value };
  return { initial: $('sInitial').value || null, medial: $('sMedial').value || null, final: $('sFinal').value || null };
}

function updatePreview() {
  const parts = readParts();
  const type = $('sType').value;
  const tone = Number($('sTone').value);
  const display = markTone(buildSyllable(parts, type), tone);
  $('previewPinyin').textContent = display || '—';
  const rule = detectSpecialRule(parts);
  $('previewRule').innerHTML = rule ? `${iconHTML('spark')} j/q/x 摘墨镜规则` : '';
}

function applyParsed(parsed) {
  $('sType').value = parsed.type;
  // 韵母可能不在标准表（家长自定义），补一个选项
  const f = parsed.parts.final;
  if (f && !FINALS.includes(f)) { const o = document.createElement('option'); o.value = f; o.textContent = f; $('sFinal').append(o); }
  $('sInitial').value = parsed.parts.initial ?? '';
  $('sMedial').value = parsed.parts.medial ?? '';
  $('sFinal').value = f ?? '';
  $('sWhole').value = parsed.parts.whole ?? '';
  $('sTone').value = parsed.tone || 1;
  toggleVisibility();
  updatePreview();
}

function makeDistractors(parts, type) {
  if (type === 'whole_syllable') return { whole: pick3(WHOLE_SYLLABLES, parts.whole) };
  const dis = { initial: [], medial: [], final: [] };
  if (parts.initial) dis.initial = pick3(INITIALS, parts.initial);
  if (parts.medial) dis.medial = pick3(MEDIALS, parts.medial);
  if (parts.final) dis.final = pick3(FINALS, parts.final);
  return dis;
}

async function submit() {
  const msg = $('injectMsg');
  const hanzi = $('fHanzi').value.trim();
  const display = $('previewPinyin').textContent;
  if (!hanzi) { msg.className = 'inject-msg bad'; msg.textContent = '请输入汉字。'; return; }
  if (!display || display === '—') { msg.className = 'inject-msg bad'; msg.textContent = '请输入拼音并确认拆分预览。'; return; }
  const type = $('sType').value;
  const parts = readParts();
  const tone = Number($('sTone').value);
  const mission = {
    hanzi, word: $('fWord').value.trim() || hanzi, hint: $('fHint').value.trim(),
    type, parts, tone, displayPinyin: display,
    specialRule: detectSpecialRule(parts),
    tags: ['家长注入'], distractors: makeDistractors(parts, type), priority: 1,
  };
  const v = validateMission(mission);
  if (!v.ok) { msg.className = 'inject-msg bad'; msg.textContent = '规则校验未通过：' + v.errors.join('；'); return; }
  try {
    const res = await fetch('/api/admin/missions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(mission) });
    const j = await res.json();
    if (!res.ok) { msg.className = 'inject-msg bad'; msg.textContent = '提交失败：' + (j.details ? j.details.join('；') : j.error); return; }
    msg.className = 'inject-msg ok';
    msg.innerHTML = `${iconHTML('check')} 已注入紧急载荷「${hanzi} · ${display}」，iPad 刷新主页即可优先抽到。`;
    $('fHanzi').value = ''; $('fPinyin').value = ''; $('fWord').value = ''; $('fHint').value = '';
    loadMissions(); loadStats();
  } catch (e) { msg.className = 'inject-msg bad'; msg.textContent = '网络错误：' + e.message; }
}

/* ----------------------------- 系统自检（全库规则校验） ----------------------------- */
async function runPinyinSelfTest() {
  const box = $('selfTestResult');
  box.innerHTML = '正在校验…';
  let missions;
  try {
    missions = (await (await fetch('/api/admin/missions')).json()).missions;
  } catch (e) {
    box.innerHTML = '<span class="bad">无法获取词库，请确认服务已启动。</span>';
    return { ok: false, error: String(e) };
  }
  const rows = []; let okCount = 0; const counts = {};
  for (const m of missions) {
    const r = validateMission(m);
    if (r.ok) okCount++;
    const c = categoryOf(m); counts[c] = (counts[c] || 0) + 1;
    rows.push({ id: m.id, 汉字: m.hanzi, 拼音: m.displayPinyin, 类别: c, 结果: r.ok ? '✓' : '✗', 错误: r.errors.join(' | ') || '' });
  }
  console.table(rows);
  const allOk = okCount === missions.length;
  console.log(`[拼音规则自检] ${okCount}/${missions.length} 通过`, allOk ? 'OK' : 'FAIL');
  box.innerHTML =
    `<div class="${allOk ? 'ok' : 'bad'}">${iconHTML(allOk ? 'check' : 'cross')} 规则准确性：${okCount} / ${missions.length} 通过</div>` +
    `<div>覆盖：两拼 ${counts.two || 0} · 三拼 ${counts.three || 0} · j/q/x+ü ${counts.jqx || 0} · 整体认读 ${counts.whole || 0}</div>`;
  return { ok: allOk, okCount, total: missions.length, counts, rows };
}
window.runPinyinSelfTest = runPinyinSelfTest;

/* ----------------------------- 界面风格（三套皮肤，孩子端共用） ----------------------------- */
const SKINS = ['hud', 'daylight', 'nebula'];
// 名字只做状态行短标签：卡片标题已带「A · / B · / C ·」，这里不再重复前缀。
const SKIN_NAMES = { hud: '深空座舱 HUD', daylight: '天空积木', nebula: '星云乐园' };
function applySkin(s) {
  document.documentElement.dataset.skin = SKINS.includes(s) ? s : 'hud';
}
function refreshSkinUI(msg) {
  const cur = document.documentElement.dataset.skin;
  for (const card of document.querySelectorAll('#skinPicker .skin-card')) {
    card.setAttribute('aria-checked', String(card.dataset.skin === cur));
  }
  $('skinStatus').textContent = msg || `当前使用：${SKIN_NAMES[cur]}`;
}
function bootSkinPicker() {
  try { applySkin(localStorage.getItem('sp_skin')); } catch { applySkin(null); }
  refreshSkinUI();
  // 服务端档案为准（跨设备同步）
  fetch('/api/profile').then((r) => r.json()).then((p) => {
    if (!SKINS.includes(p.skin)) return;
    applySkin(p.skin);
    try { localStorage.setItem('sp_skin', p.skin); } catch {}
    refreshSkinUI();
  }).catch(() => {});
  $('skinPicker').addEventListener('click', async (e) => {
    const card = e.target.closest('.skin-card');
    if (!card) return;
    const skin = card.dataset.skin;
    applySkin(skin);
    try { localStorage.setItem('sp_skin', skin); } catch {}
    refreshSkinUI(`保存中… ${SKIN_NAMES[skin]}`);
    try {
      const r = await fetch('/api/skin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ skin }) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      refreshSkinUI(`已保存 ✓ ${SKIN_NAMES[skin]}`);
    } catch {
      refreshSkinUI(`已在本机生效 ✓ ${SKIN_NAMES[skin]}（未保存到服务器）`);
    }
  });
  // 孩子端/其他标签页改过时同步本页选中态
  window.addEventListener('storage', (e) => {
    if (e.key !== 'sp_skin') return;
    applySkin(e.newValue);
    refreshSkinUI();
  });
}

/* ----------------------------- 图标风格（三套 AI 素材，孩子端共用） ----------------------------- */
const ICON_STYLE_NAMES = { a: '写实航天渲染', b: '扁平几何仪表', c: '复古丝网海报' };
function refreshIconStyleUI(msg) {
  const cur = currentIconStyle();
  for (const card of document.querySelectorAll('#iconStylePicker .skin-card')) {
    card.setAttribute('aria-checked', String(card.dataset.iconstyle === cur));
  }
  $('iconStyleStatus').textContent = msg || `当前使用：${ICON_STYLE_NAMES[cur]}`;
}
function bootIconStylePicker() {
  try { applyIconStyle(localStorage.getItem('sp_iconstyle')); } catch { applyIconStyle(null); }
  refreshIconStyleUI();
  fetch('/api/profile').then((r) => r.json()).then((p) => {
    if (!ICON_STYLES.includes(p.iconStyle)) return;
    applyIconStyle(p.iconStyle);
    refreshIconStyleUI();
  }).catch(() => {});
  $('iconStylePicker').addEventListener('click', async (e) => {
    const card = e.target.closest('.skin-card');
    if (!card) return;
    const style = card.dataset.iconstyle;
    applyIconStyle(style);
    refreshIconStyleUI(`保存中… ${ICON_STYLE_NAMES[style]}`);
    try {
      const r = await fetch('/api/iconstyle', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ iconStyle: style }) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      refreshIconStyleUI(`已保存 ✓ ${ICON_STYLE_NAMES[style]}`);
    } catch {
      refreshIconStyleUI(`已在本机生效 ✓ ${ICON_STYLE_NAMES[style]}（未保存到服务器）`);
    }
  });
  window.addEventListener('storage', (e) => {
    if (e.key !== 'sp_iconstyle') return;
    applyIconStyle(e.newValue);
    refreshIconStyleUI();
  });
}

/* ----------------------------- 发射动画（每次 / 每单元仅首次） ----------------------------- */
// 存服务端档案 progress.launchFx；孩子端每次点火前拉档案，下一局发射即生效（无需刷新，
// 也不影响本页外观，因此不走 localStorage / storage 事件）。
const LAUNCH_FX_NAMES = { always: '每次完整播放', 'unit-first': '每单元仅首次' };
function refreshLaunchFxUI(mode, msg) {
  for (const card of document.querySelectorAll('#launchFxPicker .skin-card')) {
    card.setAttribute('aria-checked', String(card.dataset.launchfx === mode));
  }
  $('launchFxStatus').textContent = msg || `当前使用：${LAUNCH_FX_NAMES[mode] || LAUNCH_FX_NAMES.always}`;
}
function bootLaunchFxPicker() {
  let saved = 'always';
  refreshLaunchFxUI(saved);
  // 服务端档案为准（跨设备同步）
  fetch('/api/profile').then((r) => r.json()).then((p) => {
    saved = p.launchFx === 'unit-first' ? 'unit-first' : 'always';
    refreshLaunchFxUI(saved);
  }).catch(() => {});
  $('launchFxPicker').addEventListener('click', async (e) => {
    const card = e.target.closest('.skin-card');
    if (!card) return;
    const mode = card.dataset.launchfx;
    refreshLaunchFxUI(mode, `保存中… ${LAUNCH_FX_NAMES[mode]}`);
    try {
      const r = await fetch('/api/launchfx', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ launchFx: mode }) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      saved = mode;
      refreshLaunchFxUI(saved, `已保存 ✓ ${LAUNCH_FX_NAMES[saved]}`);
    } catch {
      refreshLaunchFxUI(saved, '保存失败（服务器未连接），已恢复原选项，请重试');
    }
  });
}

/* ----------------------------- 介母装配（孩子装配 / 自动预装） ----------------------------- */
// 存服务端档案 progress.medialMode；孩子端每局组装前拉档案，下一局即生效（无需刷新，
// 也不影响本页外观，因此不走 localStorage / storage 事件）。
// 名字只做状态行短标签：卡片标题已带「A · / B ·」，这里不再重复前缀与全称。
const MEDIAL_MODE_NAMES = { required: '孩子装配', auto: '自动预装' };
function refreshMedialModeUI(mode, msg) {
  for (const card of document.querySelectorAll('#medialModePicker .skin-card')) {
    card.setAttribute('aria-checked', String(card.dataset.medialmode === mode));
  }
  $('medialModeStatus').textContent = msg || `当前使用：${MEDIAL_MODE_NAMES[mode] || MEDIAL_MODE_NAMES.required}`;
}
function bootMedialModePicker() {
  let saved = 'required';
  refreshMedialModeUI(saved);
  // 服务端档案为准（跨设备同步）
  fetch('/api/profile').then((r) => r.json()).then((p) => {
    saved = p.medialMode === 'auto' ? 'auto' : 'required';
    refreshMedialModeUI(saved);
  }).catch(() => {});
  $('medialModePicker').addEventListener('click', async (e) => {
    const card = e.target.closest('.skin-card');
    if (!card) return;
    const mode = card.dataset.medialmode;
    refreshMedialModeUI(mode, `保存中… ${MEDIAL_MODE_NAMES[mode]}`);
    try {
      const r = await fetch('/api/medialmode', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ medialMode: mode }) });
      if (!r.ok) {
        // 读服务端错误原文：旧进程没这条路由时会回「未知 API」，比「未连接」好排查
        const err = await r.json().then((j) => j?.error).catch(() => null);
        throw new Error(err || ('HTTP ' + r.status));
      }
      saved = mode;
      refreshMedialModeUI(saved, `已保存 ✓ ${MEDIAL_MODE_NAMES[saved]}`);
    } catch (err) {
      const tip = err?.message ? '服务器返回：' + err.message : '服务器未连接';
      refreshMedialModeUI(saved, `保存失败（${tip}），已恢复原选项。若服务是改代码前启动的，重启 node server.js 后重试`);
    }
  });
}

/* ----------------------------- 单元练习总字数（10~20） ----------------------------- */
// 存服务端档案 progress.unitTotal；复习名额 = 总字数 − 本课新字数。孩子端下次选题单即生效。
const UNIT_TOTAL_MIN = 10, UNIT_TOTAL_MAX = 20, UNIT_TOTAL_DEFAULT = 15;
const clampTotal = (v) => Math.min(UNIT_TOTAL_MAX, Math.max(UNIT_TOTAL_MIN, Math.floor(Number(v) || UNIT_TOTAL_DEFAULT)));
function bootUnitTotalPicker() {
  const range = $('unitTotalRange'), out = $('unitTotalValue'), status = $('unitTotalStatus');
  if (!range || !out || !status) return;
  let saved = UNIT_TOTAL_DEFAULT;
  const show = (v, msg) => { range.value = String(v); out.textContent = String(v); status.textContent = msg || `当前：每单元 ${v} 字`; };
  show(saved);
  fetch('/api/profile').then((r) => r.json()).then((p) => { saved = clampTotal(p.unitTotal); show(saved); }).catch(() => {});
  range.addEventListener('input', () => { out.textContent = range.value; });
  range.addEventListener('change', async () => {
    const v = clampTotal(range.value);
    show(v, `保存中… ${v} 字`);
    try {
      const r = await fetch('/api/unittotal', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ unitTotal: v }) });
      if (!r.ok) {
        const err = await r.json().then((j) => j?.error).catch(() => null);
        throw new Error(err || ('HTTP ' + r.status));
      }
      saved = v;
      show(saved, `已保存 ✓ 每单元 ${saved} 字`);
    } catch (err) {
      const tip = err?.message ? '服务器返回：' + err.message : '服务器未连接';
      show(saved, `保存失败（${tip}），已恢复原值。若服务是改代码前启动的，重启 node server.js 后重试`);
    }
  });
}

/* ----------------------------- 一键清除学习记录 ----------------------------- */
async function resetProgress() {
  const msg = $('resetMsg');
  const btn = $('resetProgressBtn');
  if (!confirm('确定一键清除全部学习记录？\n\n将清空：作答统计 / 错误率、发射次数、火箭解锁与自选座驾、星球图鉴、课时奖励进度。\n保留：呼号、课文同步选择、发射动画与介母装配选项、词库。\n\n此操作不可恢复！')) return;
  btn.disabled = true;
  msg.className = 'inject-msg';
  msg.textContent = '正在清除…';
  try {
    const res = await fetch('/api/admin/progress/reset', { method: 'POST' });
    const j = await res.json();
    if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
    msg.className = 'inject-msg ok';
    msg.innerHTML = `${iconHTML('check')} 学习记录已清除（原 ${j.previousLaunches} 次发射、${j.clearedStats} 条作答统计）。孩子端刷新页面后从零开始。`;
    loadStats();
    loadMissions();
  } catch (e) {
    msg.className = 'inject-msg bad';
    msg.textContent = '清除失败：' + e.message;
  } finally {
    btn.disabled = false;
  }
}

/* ----------------------------- 家长校验（繁体数字，防孩子错触） ----------------------------- */
// 「界面」页只改外观，默认开放；学习管理 / 发音 / 系统 可改动学习数据，
// 需输入简体数字的繁体写法（一→壹 … 十→拾）解锁，仅本次浏览器会话有效（sessionStorage，
// 关闭标签页即重新上锁）。校验面板只有一个，JS 移入当前受保护页；内容仍常驻 DOM 只隐藏。
const TRAD_NUM = { 一: '壹', 二: '貳', 三: '參', 四: '肆', 五: '伍', 六: '陸', 七: '柒', 八: '捌', 九: '玖', 十: '拾' };
const GATED_PAGES = ['study', 'voice', 'reset'];
let adminUnlocked = false;
try { adminUnlocked = sessionStorage.getItem('sp_admin_unlocked') === '1'; } catch {}
let gateAnswer = '';
const tabBaseTitle = {};

function newGateChallenge() {
  const keys = Object.keys(TRAD_NUM);
  const ch = keys[Math.floor(Math.random() * keys.length)];
  gateAnswer = TRAD_NUM[ch];
  $('gateChar').textContent = ch;
  $('gateInput').value = '';
  $('gateMsg').className = 'inject-msg';
  $('gateMsg').textContent = '';
}

/** 未解锁：受保护页只显校验面板、内容隐藏；解锁后恢复内容并去掉页签上的校验提示。 */
function applyGate() {
  const gate = $('adminGate');
  for (const k of GATED_PAGES) {
    document.querySelector('#page-' + k + ' .page-body').hidden = !adminUnlocked;
    $('tab-' + k).title = (tabBaseTitle[k] || '') + (adminUnlocked ? '' : ' · 需家长校验');
  }
  if (!adminUnlocked && GATED_PAGES.includes(adminPage)) {
    $('page-' + adminPage).prepend(gate);
    gate.hidden = false;
    newGateChallenge();
  } else {
    gate.hidden = true;
  }
}

function tryUnlock() {
  if ($('gateInput').value.trim() === gateAnswer) {
    adminUnlocked = true;
    try { sessionStorage.setItem('sp_admin_unlocked', '1'); } catch {}
    applyGate();
  } else {
    newGateChallenge(); // 答错换新题，避免逐个猜中
    $('gateMsg').className = 'inject-msg bad';
    $('gateMsg').textContent = '不对哦，已换新题——请输入上方数字的繁体写法。';
  }
}

function bootAdminGate() {
  $('gateBtn').addEventListener('click', tryUnlock);
  $('gateNew').addEventListener('click', newGateChallenge);
  $('gateInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') tryUnlock(); });
}

/* ----------------------------- 面板分页（学习管理 / 界面 / 发音 / 系统） ----------------------------- */
// 四个页签各对应一个 .admin-page 容器；所有面板始终留在 DOM 中（仅 hidden 切换），
// 因此发音播放 / 重新生成轮询 / 表格渲染跨页签不中断，脚本按 id 操作也不受影响。
// 直达：admin.html#study / #ui / #voice / #reset；无 hash 时恢复上次停留页（本机记忆），
// 首次打开默认「界面」页（外观设置，孩子误开也无风险）。
const ADMIN_PAGES = ['study', 'ui', 'voice', 'reset'];
let adminPage = 'ui';

function showAdminPage(key, { scroll = true } = {}) {
  if (!ADMIN_PAGES.includes(key)) key = 'ui';
  for (const k of ADMIN_PAGES) {
    const on = k === key;
    const tab = $('tab-' + k);
    tab.setAttribute('aria-selected', String(on));
    tab.tabIndex = on ? 0 : -1;
    $('page-' + k).hidden = !on;
  }
  adminPage = key;
  applyGate();
  try { localStorage.setItem('sp_admin_tab', key); } catch {}
  if (location.hash !== '#' + key) history.replaceState(null, '', '#' + key);
  if (scroll) window.scrollTo({ top: 0 });
  // 第一次进「发音」页且已保存 Key → 自动拉一次模型 / 音色（下拉框不再是空的）
  if (key === 'voice') discoverTts({ auto: true });
}

function bootAdminTabs() {
  for (const k of ADMIN_PAGES) tabBaseTitle[k] = $('tab-' + k).title;
  let initial = location.hash.replace(/^#/, '');
  if (!ADMIN_PAGES.includes(initial)) { try { initial = localStorage.getItem('sp_admin_tab'); } catch {} }
  showAdminPage(ADMIN_PAGES.includes(initial) ? initial : 'ui', { scroll: false });
  for (const k of ADMIN_PAGES) $('tab-' + k).addEventListener('click', (e) => {
    showAdminPage(k);
    if (e.detail > 0) e.currentTarget.blur(); // 鼠标/触摸点选后不留焦点框；键盘激活（detail=0）保留焦点
  });
  // 手动改 hash / 前进后退也能切页
  window.addEventListener('hashchange', () => {
    const k = location.hash.replace(/^#/, '');
    if (ADMIN_PAGES.includes(k)) showAdminPage(k);
  });
  // 键盘：左右方向键循环切换，Home / End 跳首末页签
  document.querySelector('.admin-tabs').addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const cur = ADMIN_PAGES.findIndex((k) => $('tab-' + k).getAttribute('aria-selected') === 'true');
    let next = cur;
    if (e.key === 'ArrowLeft') next = (cur + ADMIN_PAGES.length - 1) % ADMIN_PAGES.length;
    if (e.key === 'ArrowRight') next = (cur + 1) % ADMIN_PAGES.length;
    if (e.key === 'Home') next = 0;
    if (e.key === 'End') next = ADMIN_PAGES.length - 1;
    showAdminPage(ADMIN_PAGES[next]);
    $('tab-' + ADMIN_PAGES[next]).focus();
  });
}

/* ----------------------------- 引导 ----------------------------- */
function boot() {
  bootAdminGate();
  bootAdminTabs();
  buildSplitControls();
  toggleVisibility();
  bootSkinPicker();
  bootIconStylePicker();
  bootLaunchFxPicker();
  bootMedialModePicker();
  bootUnitTotalPicker();
  bootMissionFilters();
  bootVoiceAdmin();
  $('selfTestBtn').addEventListener('click', () => { runPinyinSelfTest(); });
  $('resetProgressBtn').addEventListener('click', resetProgress);
  let timer = 0;
  $('fPinyin').addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const val = $('fPinyin').value.trim();
      if (!val) return;
      applyParsed(parseSyllable(val));
    }, 250);
  });
  $('submitBtn').addEventListener('click', submit);
  loadStats();
  loadMissions();
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
