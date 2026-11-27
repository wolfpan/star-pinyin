/**
 * main.js — 启动引导与全局状态机控制器
 * ------------------------------------------------------------------
 * Milestone 1：首屏音频解锁 + 机库占位 + 拼音规则自检。
 * Milestone 2：IDLE_HANGAR → MISSION_BRIEFING → STAGE_1_ASSEMBLY 闭环，
 *              含 Pointer Events 拖拽落点判定与 j/q/x+ü「摘墨镜」交互。
 * 声调校准 / 点火 / 完整音效引擎将在 Milestone 3–4 接入。
 *
 * 注意：本文件的音效/语音为轻量占位实现（复用已解锁的 AudioContext 与 speechSynthesis），
 *       Milestone 4 会替换为独立的 audio-engine.js（程序化合成 + 本地人声降级）。
 */
import { removeDots, buildSyllable } from './pinyin-rules.js';
import { renderBriefing, renderAssembly, renderMuseum } from './ui-renderer.js';
import { createDragEngine, resolveDrop } from './drag-engine.js';
import { createToneCalibration } from './tone-canvas.js';
import { createLaunchFX } from './launch-fx.js';
import { destinationForLevel, DESTINATIONS } from './destinations.js';
import { rewardLevelForLessons, nextRewardForLessons } from './rewards.js';
import {
  normalizeSelection, selectionKey, getGrade, getBook, formatSelection, formatBook, formatLessonSource,
  unitKey, GRADE_LABELS, TERM_LABELS,
} from './textbook.js';
import AudioEngine from './audio-engine.js';
import { iconHTML, iconUrl, destIconHTML, destIconUrl, applyIconStyle, ICON_STYLES } from './icons.js';

const $ = (sel) => document.querySelector(sel);

/* ============================ 皮肤（家长后台可选，三套） ============================ */
const SKINS = ['hud', 'daylight', 'nebula'];
function applySkin(s) {
  document.documentElement.dataset.skin = SKINS.includes(s) ? s : 'hud';
}
try { applySkin(localStorage.getItem('sp_skin')); } catch { applySkin(null); }
try { applyIconStyle(localStorage.getItem('sp_iconstyle')); } catch { applyIconStyle(null); }
// 家长后台在同设备其他标签页保存后，本页立即同步
window.addEventListener('storage', (e) => {
  if (e.key === 'sp_skin') { applySkin(e.newValue); fitHangar(); }
  else if (e.key === 'sp_iconstyle') { applyIconStyle(e.newValue); }
});

/* ============================ 全局状态 ============================ */
const State = {
  mode: 'all',
  // 课时奖励系统（难度已取消）：完成课时 → 奖励档位 → 星际目的地
  reward: { level: 1, lessons: 0, total: 0, next: null },
  destination: null,       // 最新目的地（机库右上角 / 本次发射终点）
  launchDestination: null, // 本局发射时锁定的目的地（上报到访用）
  currentRocket: null, // 当前出战座驾（机库自选 / 默认最新一枚；默认土星五号）
  rockets: [],         // 已拥有火箭（机库可选，按解锁门槛升序）
  rocketAuto: true,    // true = 尚未自选，跟随最新火箭；false = 已自选并锁定
  mission: null,
  assembly: null,      // ui-renderer 返回的组装台 API
  tone: null,          // tone-canvas 实例
  fx: null,            // launch-fx 实例
  roar: null,          // 引擎轰鸣句柄
  assemblyErrors: 0,
  toneErrors: 0,
  missionDone: false,
  missionStartAt: 0,
  visitedDestinations: {}, // 目的地到访计数（星球图鉴点亮）
  textbook: { catalog: null, selection: null, poolSize: null }, // 课文同步（年级/学期/课文进度）
  medialMode: 'required',  // 介母装配（家长后台「学习管理」）：required 孩子填入 / auto 自动预装
};

/** 切换关卡前清理上一局的交互模块，避免监听器/rAF 泄漏。 */
function teardownStage() {
  if (State.tone) { State.tone.destroy(); State.tone = null; }
  if (State.fx) { State.fx.destroy(); State.fx = null; }
  if (State.roar) { State.roar.stop(); State.roar = null; }
  AudioEngine.stopVoice();
  State.assembly = null;
}

function showScreen(id) {
  for (const s of ['boot', 'hangar', 'game']) {
    const el = document.getElementById(s);
    if (el) el.hidden = s !== id;
  }
}

/**
 * 机库自适应：内容超出视口时把 .hangar-body 整体等比缩小（宽度反向补偿保持满宽），
 * 内容不足时撑满视口让发射按钮贴底。全程无滚动条。
 *
 * 缩放系数用二分搜索求出「刚好放下」的最大值：等比缩放会让文字换行数变少，
 * 内容高度并不是线性的，早先的单次估算会过度缩小（768×1024 下被压到 0.83，
 * 课文标题只剩 10px）。二分 7 次即可稳定收敛，字号损失最小。
 */
function fitHangar() {
  const hangar = $('#hangar');
  const body = $('#hangarBody');
  if (!hangar || !body || hangar.hidden) return;
  const avail = hangar.clientHeight;
  if (!avail) return;

  // 1) 先按满宽量自然高度（不留上一次的内联样式；align-self:flex-start 必须显式给 100% 宽）
  body.style.transform = '';
  body.style.width = '100%';
  body.style.minHeight = '';
  const natural = body.scrollHeight;
  if (natural <= avail + 1) {
    body.style.minHeight = avail + 'px'; // 内容不满屏：撑满，发射按钮贴底
    refreshHangarFades();
    return;
  }
  // 2) 二分：找最大 scale 使「视觉高度 = scale × 该宽度下的内容高度」不超屏
  let lo = 0.4;
  let hi = 1;
  for (let i = 0; i < 7; i++) {
    const s = (lo + hi) / 2;
    body.style.width = (100 / s) + '%';
    body.style.minHeight = '';
    if (body.scrollHeight * s <= avail + 1) lo = s;
    else hi = s;
  }

  // 3) 应用：宽度反向补偿 + 等比缩放，min-height 让内容铺满可视高度
  const s = lo;
  body.style.width = (100 / s) + '%';
  body.style.minHeight = (avail / s) + 'px';
  body.style.transform = s < 0.999 ? `scale(${s})` : '';
  refreshHangarFades();
}

/* ============================ 音效/语音（M4：AudioEngine） ============================ */
const unlockAudio = () => AudioEngine.unlock();
const playLock = () => AudioEngine.playLock();
const playError = () => AudioEngine.playError();
const playSpark = () => AudioEngine.playSpark();
const playSuccess = () => AudioEngine.playSuccess();
const speak = (text, rate = 1) => AudioEngine.speakText(text, rate);

/* ============================ 机库 ============================ */
async function loadProfile() {
  try {
    const p = await (await fetch('/api/profile')).json();
    State.profile = p;
    // 皮肤以服务端档案为准（家长在任意设备保存后，孩子端进入/刷新即同步）
    if (SKINS.includes(p.skin)) {
      applySkin(p.skin);
      try { localStorage.setItem('sp_skin', p.skin); } catch {}
    }
    if (ICON_STYLES.includes(p.iconStyle)) applyIconStyle(p.iconStyle);
    $('#callsign').textContent = p.callsign || '指挥官';
    $('#launchCount').textContent = p.totalLaunches ?? 0;
    renderNextRocket(p);
    $('#emergencyLight').hidden = !(p.emergencyCount > 0);
    State.rockets = p.ownedRockets || p.museum || [];
    State.rocketAuto = p.rocketAuto !== false;
    State.currentRocket = p.currentRocket || State.rockets[State.rockets.length - 1] || null;
    State.visitedDestinations = p.visitedDestinations || {};
    State.medialMode = p.medialMode === 'auto' ? 'auto' : 'required';
    applyReward(p);
    syncTextbookSelection(p.textbook);
    renderCurrentRocket();
    renderRocketPicker();
    fitHangar();
  } catch (e) { console.warn('[profile]', e); }
}

/**
 * 奖励档位同步：课时完成量 → 奖励档位 → 最新目的地。
 * 难度选择器已取消，孩子学到哪一课就飞到哪一颗星球（每 2 课时解锁 1 档）。
 */
function applyReward(p) {
  const lessons = Math.max(0, Math.floor(Number(p?.lessonsCompleted) || 0));
  const level = Math.max(1, Math.floor(Number(p?.rewardLevel) || rewardLevelForLessons(lessons)));
  State.reward = {
    level,
    lessons,
    total: Math.max(0, Math.floor(Number(p?.lessonsTotal) || 0)),
    next: p?.nextReward !== undefined ? p.nextReward : nextRewardForLessons(lessons),
  };
  State.destination = destinationForLevel(level);
  renderLatestDest();
}

/** 机库右上角「最新目的地」：最新打通的星球，点击可打开博物馆看奖励进度。 */
function renderLatestDest() {
  const el = $('#latestDest');
  if (!el) return;
  const dest = State.destination || destinationForLevel(1);
  const next = State.reward.next;
  const hint = next
    ? `下一份奖励：再完成 ${next.need} 课时解锁 ${next.destination.name}`
    : '全部星际目的地已解锁';
  el.innerHTML = `<span class="dest-corner-label">最新目的地</span>`
    + `<span class="dest-corner-main"><img class="dest-corner-icon" src="${destIconUrl(dest.id)}" alt="" aria-hidden="true" draggable="false"><b>${dest.name}</b></span>`;
  el.title = `${dest.name} · ${hint}`;
  el.setAttribute('aria-label', `最新目的地 ${dest.name}，${hint}`);
}

/* ============================ 课文同步（年级 / 学期 / 课文进度） ============================ */

/** 加载教材目录 + 当前进度（进入指挥中心时取一次；目录不随每局刷新）。 */
async function loadTextbook() {
  try {
    const d = await (await fetch('/api/textbook')).json();
    State.textbook.catalog = d.catalog || null;
    State.textbook.selection = d.selection || null;
    State.textbook.poolSize = d.poolSize ?? null;
    renderTextbook();
    fitHangar();
  } catch (e) { console.warn('[textbook]', e); }
}

/** 档案刷新时同步进度选择（家长可能在别的设备改过；目录已加载则不重取）。 */
function syncTextbookSelection(sel) {
  if (!State.textbook.catalog) return;
  if (selectionKey(sel) === selectionKey(State.textbook.selection)) return;
  State.textbook.selection = sel || null;
  renderTextbook();
}

/** 渲染课文同步面板：年级芯片 → 学期芯片 → 课文进度芯片（横向滑动）。 */
function renderTextbook() {
  const gradesBox = $('#tbGrades');
  const detail = $('#tbDetail');
  const termsBox = $('#tbTerms');
  const lessonsBox = $('#tbLessons');
  const status = $('#tbStatus');
  if (!gradesBox || !detail || !termsBox || !lessonsBox || !status) return;
  const { catalog, selection, poolSize } = State.textbook;
  const sel = normalizeSelection(catalog, selection);

  /* 年级行：自由巡航 + 一~三年级 */
  gradesBox.innerHTML = '';
  const gradeOptions = [{ grade: null, label: '自由巡航' }];
  for (const g of catalog?.grades || []) gradeOptions.push({ grade: g.grade, label: GRADE_LABELS[g.grade] || `${g.grade}年级` });
  for (const opt of gradeOptions) {
    const on = opt.grade == null ? !sel : sel?.grade === opt.grade;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tb-chip' + (on ? ' active' : '');
    btn.dataset.grade = opt.grade == null ? 'all' : String(opt.grade);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    btn.textContent = opt.label;
    gradesBox.append(btn);
  }

  /* 学期 + 课文进度（选了年级才展开） */
  detail.hidden = !sel;
  termsBox.innerHTML = '';
  lessonsBox.innerHTML = '';
  if (sel) {
    const g = getGrade(catalog, sel.grade);
    for (const b of g?.books || []) {
      const on = sel.term === b.term;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tb-chip' + (on ? ' active' : '');
      btn.dataset.term = String(b.term);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      btn.textContent = TERM_LABELS[b.term] || (b.term === 1 ? '上册' : '下册');
      termsBox.append(btn);
    }
    const book = getBook(catalog, sel.grade, sel.term ?? 1);
    for (const l of book?.lessons || []) {
      const on = sel.seq === l.seq;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tb-lesson' + (on ? ' active' : '');
      btn.dataset.seq = String(l.seq);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      btn.title = l.kind === '语文园地' ? l.title : `${l.kind === '识字' ? '识字' : '第'}${l.no}课《${l.title}》`;
      const no = document.createElement('span');
      no.className = 'tb-lesson-no';
      no.textContent = l.kind === '识字' ? `识字${l.no}` : l.kind === '语文园地' ? '园地' : String(l.no);
      const title = document.createElement('span');
      title.className = 'tb-lesson-title';
      title.textContent = l.title;
      btn.append(no, title);
      lessonsBox.append(btn);
    }
    // 全册（整册生字）放在最后：课序在前、全册垫底，滑到底才是「整册复习」
    const all = document.createElement('button');
    all.type = 'button';
    all.className = 'tb-lesson tb-lesson-all' + (sel.seq == null ? ' active' : '');
    all.dataset.seq = 'all';
    all.setAttribute('aria-pressed', sel.seq == null ? 'true' : 'false');
    all.title = `${formatBook(sel.grade, sel.term ?? 1)} 整册生字`;
    all.innerHTML = '<span class="tb-lesson-no">全册</span><span class="tb-lesson-title">整册生字</span>';
    lessonsBox.append(all);
    // 选中「某一课」才滚到可见位置（尽量少滚，保留左侧上下文）；
    // 全册是末尾的整册汇总，选中它时列表停在最左，孩子从第 1 课往下看。
    if (sel.seq != null) ensureVisible(lessonsBox.querySelector('.tb-lesson.active'), lessonsBox);
  }

  /* 状态行：当前进度 + 字池规模 */
  const label = formatSelection(catalog, sel);
  const size = sel ? (poolSize != null ? ` · 已学生字 <b>${poolSize}</b> 个` : '') : '';
  status.innerHTML = `${iconHTML('book')} ${label}${size}`;
  updateScrollFade(lessonsBox);
}

/** 选择进度并持久化（服务端校验；抽题按进度过滤在服务端完成）。 */
async function selectTextbook(sel) {
  const prev = selectionKey(State.textbook.selection);
  try {
    const res = await fetch('/api/textbook/select', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sel && sel.grade != null ? sel : { grade: null }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error || ('HTTP ' + res.status));
    State.textbook.selection = data.selection || null;
    State.textbook.poolSize = data.poolSize ?? null;
    renderTextbook();
    fitHangar();
    if (selectionKey(data.selection) !== prev) playLock();
  } catch (e) { console.warn('[textbook]', e); }
}

/** 「下一枚火箭」解锁进度：进度条 + 还差几次发射（纯收藏奖励，与目的地解耦）。 */
function renderNextRocket(p) {
  const el = $('#nextBadge');
  if (!el) return;
  const next = p.nextBadge;
  if (!next) {
    el.innerHTML = `<div class="next-rocket-done">${iconHTML('party')} 火箭已全部解锁</div>`;
    return;
  }
  const total = p.totalLaunches || 0;
  const unlockAt = Number(next.unlockAt) || 0;
  const need = Math.max(0, unlockAt - total);
  // 上一档门槛 = 已拥有火箭里最高的解锁要求（初始座驾为 0）
  const prev = Math.max(0, ...(p.ownedRockets || []).map((r) => Number(r.unlockAt) || 0));
  const span = Math.max(1, unlockAt - prev);
  const pct = Math.round(Math.min(1, Math.max(0, (total - prev) / span)) * 100);
  el.innerHTML = `
    <div class="next-rocket-row">
      <span class="next-rocket-label">下一枚火箭</span>
      <b class="next-rocket-name">${next.name}</b>
      <span class="next-rocket-need">${need > 0 ? `再发射 ${need} 次` : '即将解锁'}</span>
    </div>
    <div class="next-rocket-bar" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100" aria-label="下一枚火箭解锁进度"><i style="width:${pct}%"></i></div>`;
}

/** 火箭模型图：优先透明模型 PNG，加载失败回退 AI 火箭图标。 */
function rocketImageEl(rocket, className) {
  const img = document.createElement('img');
  img.className = className;
  img.src = rocket.image || `/images/rockets/${rocket.id}.png`;
  img.alt = rocket.name || '火箭';
  img.loading = 'lazy';
  img.addEventListener('error', () => {
    const fb = document.createElement('img');
    fb.className = className + ' fallback';
    fb.src = iconUrl('rocket');
    fb.dataset.icon = 'rocket';
    fb.alt = rocket.name || '火箭';
    img.replaceWith(fb);
  }, { once: true });
  return img;
}

/** 当前出战座驾：模型图 + 名称 + 状态（自动跟随 / 已自选）。 */
function renderCurrentRocket() {
  const box = $('#currentRocket');
  const r = State.currentRocket;
  const tag = $('#rocketAutoTag');
  if (tag) {
    tag.textContent = State.rocketAuto ? '自动 · 最新火箭' : '已自选';
    tag.classList.toggle('is-auto', State.rocketAuto);
  }
  box.innerHTML = '';
  if (!r) { box.textContent = '尚未获得火箭'; return; }
  const meta = document.createElement('div');
  meta.className = 'current-rocket-meta';
  const name = document.createElement('b');
  name.textContent = r.name;
  const sub = document.createElement('span');
  sub.className = 'current-rocket-sub';
  sub.textContent = r.starter ? '初始座驾 · 默认拥有' : (r.category || '运载火箭');
  meta.append(name, sub);
  box.append(rocketImageEl(r, 'current-rocket-img'), meta);
}

/** 机库座驾选择器：横向滑动列出已获得的火箭，点一枚即换座驾。 */
function renderRocketPicker() {
  const box = $('#rocketPicker');
  if (!box) return;
  box.innerHTML = '';
  const owned = State.rockets.slice().sort((a, b) => (Number(a.unlockAt) || 0) - (Number(b.unlockAt) || 0));
  for (const r of owned) {
    const on = State.currentRocket?.id === r.id;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'rocket-chip' + (on ? ' active' : '');
    btn.dataset.id = r.id;
    btn.dataset.name = r.name || '';
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    btn.title = r.name || '';
    const label = document.createElement('span');
    label.className = 'rocket-chip-name';
    label.textContent = r.name || r.id;
    btn.append(rocketImageEl(r, 'rocket-chip-img'), label);
    box.append(btn);
  }
  box.hidden = owned.length === 0;
  syncPickerScroll(box);
}

/**
 * 横向火箭选择器：把当前座驾滚进可视范围（尽量少滚，列表起点仍是第一枚），
 * 并按是否还有隐藏内容切换右缘渐隐 / 提示语。
 */
function syncPickerScroll(box = $('#rocketPicker')) {
  if (!box || box.hidden) return;
  ensureVisible(box.querySelector('.rocket-chip.active'), box);
  updatePickerHint(box);
}

/** 把 el 滚进横向容器：只滚到刚好露出（保留左侧上下文，不居中）。
 *  用 rect 差值计算，机库整体缩放（fitHangar）时按缩放比换算回 layout px。 */
function ensureVisible(el, box, pad = 8) {
  if (!el || !box) return;
  const br = box.getBoundingClientRect();
  const er = el.getBoundingClientRect();
  const k = box.offsetWidth ? br.width / box.offsetWidth : 1; // 祖先 scale
  const left = (er.left - br.left) / (k || 1);
  const right = (er.right - br.left) / (k || 1);
  const max = Math.max(0, box.scrollWidth - box.clientWidth);
  let target = box.scrollLeft;
  if (left < pad) target += left - pad; // 被左侧遮住
  else if (right > box.clientWidth - pad) target += right - (box.clientWidth - pad); // 被右侧遮住
  box.scrollLeft = Math.max(0, Math.min(max, target));
}

/** 机库内所有横向列表的可滑动提示（火箭选择器 + 课文进度）。 */
function refreshHangarFades() {
  updatePickerHint($('#rocketPicker'));
  updateScrollFade($('#tbLessons'));
}

/** 横向列表的右缘/左缘渐隐：还有内容可滑时显示。 */
function updateScrollFade(el) {
  if (!el) return;
  const more = el.scrollWidth - el.clientWidth;
  el.classList.toggle('has-more', more > 4 && el.scrollLeft < more - 4);
  el.classList.toggle('has-left', el.scrollLeft > 4);
}

function updatePickerHint(box = $('#rocketPicker'), hint = document.querySelector('.rocket-hint')) {
  if (!box) return;
  updateScrollFade(box);
  if (!hint) return;
  const more = box.scrollWidth - box.clientWidth;
  hint.textContent = more > 4 ? '左右滑动挑火箭，点一枚就换它出战。' : '点下面任意一枚火箭，就换它出战。';
}

/** 只挂一次：横向滑动时刷新右缘渐隐。 */
function bindScrollFades() {
  for (const [sel, fn] of [
    ['#rocketPicker', () => updatePickerHint($('#rocketPicker'))],
    ['#tbLessons', () => updateScrollFade($('#tbLessons'))],
  ]) {
    const el = $(sel);
    if (!el || el.dataset.scrollBound) continue;
    el.dataset.scrollBound = '1';
    el.addEventListener('scroll', fn, { passive: true });
  }
}

/** 切换出战座驾并持久化（服务端校验是否已获得）。 */
async function selectRocket(rocketId) {
  if (!rocketId) return null;
  try {
    const res = await fetch('/api/rocket/select', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rocketId }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error || ('HTTP ' + res.status));
    if (Array.isArray(data.ownedRockets) && data.ownedRockets.length) State.rockets = data.ownedRockets;
    State.currentRocket = data.currentRocket || State.currentRocket;
    State.rocketAuto = data.rocketAuto !== false;
    renderCurrentRocket();
    renderRocketPicker();
    fitHangar();
    return State.currentRocket;
  } catch (e) {
    console.warn('[rocket]', e);
    await loadProfile(); // 拥有列表 / 座驾可能已过期（家长手改了数据），静默同步一次
    return null;
  }
}

async function openMuseum() {
  try {
    const p = await (await fetch('/api/profile')).json();
    renderMuseum(p, {
      onSelect: (rocketId) => selectRocket(rocketId),
    });
  } catch (e) { console.warn('[museum]', e); }
}

/* ============================ FSM：简报 ============================ */
async function startMission(opts = {}) {
  const mode = opts.mode || 'all';
  State.mode = mode;
  State.assemblyErrors = 0;
  State.toneErrors = 0;
  State.missionDone = false;
  State.missionStartAt = performance.now();
  teardownStage();
  try {
    // 出题范围完全由课文同步进度决定（服务端按 progress.textbook 过滤），不再有难度参数。
    // 同时拉一次档案同步家长选项（介母装配）：家长在后台改完，孩子下一局即生效，无需刷新。
    const [res, prof] = await Promise.all([
      fetch(`/api/missions/next?mode=${encodeURIComponent(mode)}`),
      fetch('/api/profile').then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]);
    if (prof) State.medialMode = prof.medialMode === 'auto' ? 'auto' : 'required';
    if (!res.ok) throw new Error('无可用任务');
    State.mission = await res.json();
  } catch (e) {
    alert(State.textbook.poolSize === 0
      ? '当前课文进度还没有会写字（如《天地人》只认不写）。请在「课文同步」里往后选一课，或切回自由巡航。'
      : '领取任务失败：' + e.message);
    return;
  }
  enterBriefing();
}

function enterBriefing() {
  const m = State.mission;
  showScreen('game');
  const game = $('#game');
  renderBriefing(game, m, {
    onReplay: () => { AudioEngine.playRadioStatic(); speak(`载荷确认：${m.word}的${m.hanzi}`, 1); },
    onSlowReplay: () => { AudioEngine.playRadioStatic(); AudioEngine.slowSplit(m); },
    onStart: enterAssembly,
  });
  speak(`载荷确认：${m.word}的${m.hanzi}`, 1);
}

/* ============================ FSM：组装 ============================ */
function enterAssembly() {
  const m = State.mission;
  const game = $('#game');
  const api = renderAssembly(game, m, {
    medialAuto: State.medialMode === 'auto',
    // 复读：无线电滋滋声 + 真人语音重读目标词（不带「载荷确认」前缀），组装中随时可再听
    onReplay: () => { AudioEngine.playRadioStatic(); speak(`${m.word}的${m.hanzi}`, 1); },
  });
  State.assembly = api;
  window.__currentMission = m; // 便于控制台/自动化调试

  const engine = createDragEngine({
    tolerance: 60,
    getSlots: () => api.getSlots(),
    highlight: (slot) => {
      api.clearMagnets();
      if (slot) api.setMagnet(slot.id, true);
    },
    onDrop: (meta, slot) => handleDrop(meta, slot),
  });
  for (const mod of api.modules) engine.bind(mod.el, mod);
}

/** 落点判定：纯逻辑 resolveDrop + 视觉/音效副作用。 */
async function handleDrop(meta, slot) {
  const api = State.assembly;
  const m = State.mission;
  const decision = resolveDrop(m, meta, slot, { initialFilled: api.isFilled('initial') });

  if (decision.action === 'bounce') {
    if (decision.error) {
      const flashId = decision.flash || slot?.id;
      if (flashId) api.flashError(flashId);
      State.assemblyErrors++;
      playError();
      if (decision.reason === 'need-initial') speak('请先安装声母', 1);
      // 两次填错后自动帮扶：点亮下一待装段的正确零件，持续高亮直到装对（不计错、不读音）
      if (State.assemblyErrors >= 2) {
        const next = api.nextEmpty();
        if (next) api.flashHint(next.id, m.parts[next.group], { sticky: true });
      }
    }
    return { action: 'bounce' };
  }

  if (decision.action === 'dots') {
    playSpark();
    const complete = api.showDotRemoval(meta.value);
    complete.then(() => {
      api.setSlotFilled(slot.id, removeDots(meta.value)); // 摘点后写成 u/ue/un
      playLock();
      checkComplete();
    });
    return { action: 'dots', slot, complete };
  }

  // 普通磁吸锁定
  api.setSlotFilled(slot.id, meta.value);
  playLock();
  checkComplete();
  return { action: 'snap', slot };
}

function checkComplete() {
  const api = State.assembly;
  if (State.missionDone || !api.allActiveFilled()) return;
  State.missionDone = true;
  api.complete(State.mission.displayPinyin);
  playSuccess();
  speak('组装完成');
  setTimeout(enterToneCalibration, 950);
}

/* ============================ FSM：声调校准（M3） ============================ */
function enterToneCalibration() {
  const m = State.mission;
  const game = $('#game');
  if (State.assembly) { State.assembly = null; }
  game.innerHTML = '';
  State.tone = createToneCalibration(
    game,
    { hanzi: m.hanzi, base: buildSyllable(m.parts, m.type), tone: m.tone, displayPinyin: m.displayPinyin },
    {
      onSuccess: () => { playSuccess(); enterLaunch(); },
      onError: () => { State.toneErrors++; playError(); speak('再试一次'); },
    },
  );
}

/* ============================ FSM：点火入轨（M3） ============================ */
async function enterLaunch() {
  const m = State.mission;
  if (State.tone) { State.tone.destroy(); State.tone = null; }
  const game = $('#game');
  game.innerHTML = '';
  const timeScale = window.__fxTimeScale || 1; // 自动化验收可快进
  // 刷新座驾与奖励档位（可能刚从博物馆换了火箭 / 刚补完课时解锁新目的地）
  let rocket = State.currentRocket;
  let profile = State.profile || null;
  try {
    const p = await (await fetch('/api/profile')).json();
    profile = p;
    rocket = p.currentRocket || rocket;
    State.currentRocket = rocket;
    applyReward(p);
  } catch (e) { /* 用缓存 */ }
  const destination = State.destination || destinationForLevel(State.reward.level);
  State.launchDestination = destination; // 本局目的地锁定（结算上报用）

  // 家长选项「每单元仅首次」：本单元已发射过 → 跳过动画直接结算（练习更紧凑）。
  // 没有单元归属的词条（汉语拼音课 / 无教材引用扩展 / 紧急载荷）始终播放完整动画。
  const uk = unitKey(m.textbook);
  if (profile?.launchFx === 'unit-first' && uk && (profile.launchedUnits || []).includes(uk)) {
    playSuccess();
    finishMission();
    return;
  }

  State.fx = createLaunchFX(game, {
    hanzi: m.hanzi, type: m.type, displayPinyin: m.displayPinyin, timeScale,
    rocketImage: rocket?.image || null,
    destination,
    onEvent: (name, n) => {
      if (name === 'countdown') { if (timeScale === 1) speak({ 3: '三', 2: '二', 1: '一' }[n] || ''); }
      else if (name === 'ignition') { if (timeScale === 1) speak('点火'); State.roar = AudioEngine.startEngineRoar({ duration: Math.max(0.3, 3.8 / timeScale), peak: 0.5 }); }
      else if (name === 'separation') AudioEngine.playSeparation();
      else if (name === 'fairing') AudioEngine.playFairing();
      else if (name === 'orbit') { if (State.roar) { State.roar.stop(); State.roar = null; } AudioEngine.playSuccess(); }
      else if (name === 'cruise') {
        if (State.roar) { State.roar.stop(); State.roar = null; }
        AudioEngine.playCruise(); // 巡航只留音效，播报统一为抵达时的「抵达XX」
      }
      else if (name === 'arrival') {
        AudioEngine.playArrival();
        if (timeScale === 1) speak(destination.caption, 1);
      }
    },
    onDone: () => { finishMission(); },
  });
  State.fx.start();
}

/* ============================ FSM：入轨结算（M3） ============================ */
async function finishMission() {
  const m = State.mission;
  if (State.fx) { State.fx.destroy(); State.fx = null; }
  const durationMs = Math.round(performance.now() - State.missionStartAt);
  const destinationId = (State.launchDestination || State.destination || destinationForLevel(1)).id;
  let result = { totalLaunches: 0, newlyUnlockedBadges: [], destinationId };
  try {
    result = await (await fetch('/api/progress/record', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ missionId: m.id, assemblyErrors: State.assemblyErrors, toneErrors: State.toneErrors, durationMs, destinationId }),
    })).json();
  } catch (e) { console.warn('[record]', e); }
  // 同步刚解锁的火箭与奖励档位：本局若补完一课，可能解锁新的星际目的地。
  await loadProfile();
  showReward({ ...result, destinationId: result.destinationId || destinationId });
}

function showReward(result) {
  const m = State.mission;
  const game = $('#game');
  game.innerHTML = '';
  // 结算页只保留：顶部目的地 + 汉字+拼音卡片 + 操作按钮。
  // 课时奖励（新目的地解锁 / 完成课时 / 课时进度 / 火箭徽章 / 累计发射）一律不在此展示，
  // 奖励进度仍照常上报服务端，可在博物馆 / 机库查看。
  const dest = DESTINATIONS[result.destinationId] || State.launchDestination || State.destination || destinationForLevel(1);
  const screen = document.createElement('section');
  screen.className = 'screen completion reward';
  screen.innerHTML = `
    <div class="completion-tag">${dest.rewardTitle}!</div>
    <div class="completion-card" role="button" tabindex="0" title="点一下 · 再读一遍">
      <div class="completion-hanzi">${m.hanzi}</div>
      <div class="completion-pinyin">${m.displayPinyin}</div>
      <div class="completion-note">点卡片 · 再读一遍</div>
    </div>
    <div class="completion-actions">
      <button class="phys-btn" type="button" id="backHangar">机库</button>
      <button class="phys-btn primary" type="button" id="nextMission">下一题 ▸</button>
    </div>`;
  game.append(screen);
  // 卡片显示即直接读整个音节；点卡片（或键盘 Enter/空格）可再读一遍。
  const card = screen.querySelector('.completion-card');
  const read = () => AudioEngine.speakPinyin({ base: buildSyllable(m.parts, m.type), tone: m.tone, hanzi: m.hanzi, rate: 0.95, fallbackText: `${m.word}的${m.hanzi}` });
  card.setAttribute('aria-label', `${m.hanzi} ${m.displayPinyin}，点一下再读一遍`);
  card.addEventListener('click', read);
  card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); read(); } });
  read();
  $('#backHangar').addEventListener('click', async () => { teardownStage(); showScreen('hangar'); await loadProfile(); });
  $('#nextMission').addEventListener('click', () => startMission());
}

/** 调试钩子：按 id 强制开始某题（供控制台/自动化验收使用）。 */
window.__debugStart = async (id) => {
  const list = (await (await fetch('/api/admin/missions')).json()).missions;
  const m = list.find((x) => x.id === id);
  if (!m) throw new Error('mission not found: ' + id);
  State.mission = m; State.assemblyErrors = 0; State.toneErrors = 0; State.missionDone = false;
  State.missionStartAt = performance.now();
  teardownStage();
  enterBriefing();
  return m.id;
};

/* ============================ 引导 ============================ */
function boot() {
  window.__audio = AudioEngine; // 便于控制台/自动化验收
  $('#enterBtn').addEventListener('click', () => {
    unlockAudio();        // 在用户手势内触发解锁，但不阻塞界面切换
    showScreen('hangar');
    fitHangar();
    loadProfile();
    loadTextbook();
    speak('进入指挥中心');
  }, { once: true });

  // 课文同步：年级 → 学期 → 课文进度（选择即持久化，抽题按进度过滤）
  $('#tbGrades').addEventListener('click', (e) => {
    const btn = e.target.closest('.tb-chip');
    if (!btn) return;
    if (btn.dataset.grade === 'all') return selectTextbook(null);
    const grade = Number(btn.dataset.grade);
    if (State.textbook.selection?.grade === grade) return;
    selectTextbook({ grade, term: 1, seq: null });
  });
  $('#tbTerms').addEventListener('click', (e) => {
    const btn = e.target.closest('.tb-chip');
    const sel = State.textbook.selection;
    if (!btn || !sel) return;
    const term = Number(btn.dataset.term);
    if (sel.term === term) return;
    selectTextbook({ grade: sel.grade, term, seq: null });
  });
  $('#tbLessons').addEventListener('click', (e) => {
    const btn = e.target.closest('.tb-lesson');
    const sel = State.textbook.selection;
    if (!btn || !sel) return;
    const seq = btn.dataset.seq === 'all' ? null : Number(btn.dataset.seq);
    const term = sel.term ?? 1;
    if ((sel.seq ?? null) === seq && sel.term === term) return;
    selectTextbook({ grade: sel.grade, term, seq });
  });

  // 视口变化（旋转 / 分屏 / 地址栏收放）时重新自适应
  window.addEventListener('resize', fitHangar);
  window.addEventListener('orientationchange', () => setTimeout(fitHangar, 120));
  if (typeof ResizeObserver !== 'undefined') {
    let raf = 0;
    new ResizeObserver(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(fitHangar); }).observe($('#hangar'));
  }

  $('#launchBtn').addEventListener('click', () => startMission());
  $('#museumBtn').addEventListener('click', openMuseum);
  // 右上角「最新目的地」→ 打开博物馆看星球图鉴（课时奖励进度已并入）
  $('#latestDest').addEventListener('click', () => { playLock(); openMuseum(); });
  $('#emergencyLight').addEventListener('click', () => startMission({ mode: 'emergency' }));

  // 机库自选座驾：点一枚已获得的火箭即换座驾（服务端校验拥有状态）
  bindScrollFades();
  $('#rocketPicker').addEventListener('click', async (e) => {
    const btn = e.target.closest('.rocket-chip');
    if (!btn || btn.classList.contains('active')) return;
    const prev = State.currentRocket?.id;
    const r = await selectRocket(btn.dataset.id);
    if (!r) return;
    playLock();
    if (r.id !== prev) speak(r.name, 1);
  });

  // 「已自选」状态可点回「自动 · 最新火箭」：跟着新解锁的火箭走
  $('#rocketAutoTag').addEventListener('click', async () => {
    if (State.rocketAuto) return;
    const prev = State.currentRocket?.id;
    const r = await selectRocket('auto');
    if (!r) return;
    playLock();
    if (r.id !== prev) speak(r.name, 1);
  });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
