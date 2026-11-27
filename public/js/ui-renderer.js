/**
 * ui-renderer.js — SVG 火箭组装台 / 任务简报 / 零件托盘 / 摘墨镜交互渲染
 * ------------------------------------------------------------------
 * 扁平暗色风 SVG（Retina 无损），支持四种拼音构型动态切换：
 *   three_part     → 三级：一级声母 + 二级介母 + 整流罩韵母
 *                    （家长选项「介母自动预装」时介母预装，孩子只拼声母 + 韵母）
 *   two_part       → 一级声母 + 整流罩韵母；二级“直连锁定/无需介母”
 *   zero_initial   → 一级预装“零声母推进器”；仅装配整流罩韵母
 *   whole_syllable → 一体式单级入轨火箭（SSTO），单个完整箭体
 *
 * 渲染层只负责 DOM/SVG 与视觉状态；拖拽物理在 drag-engine.js，落点判定在 main.js。
 */

import { drawPlanet, drawOrbitEarth } from './planet-fx.js';
import { destinationList } from './destinations.js';
import { rewardLadder, nextRewardForLessons, lessonsForRewardLevel } from './rewards.js';
import { iconEl, iconUrl, destIconEl } from './icons.js';
import { JQX, removeDots } from './pinyin-rules.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** HTML 元素构造器。 */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (v != null) el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null) continue;
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return el;
}

/** SVG 元素构造器。 */
function s(tag, attrs = {}, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'text') el.textContent = v;
    else if (v != null) el.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null) el.append(c);
  return el;
}

const GROUP_LABEL = { initial: '声母', medial: '介母', final: '韵母', whole: '整体' };

/** 槽位布局：声母在上、介母居中、韵母在下（符合拼读顺序）。
 * medialAuto = 家长选项「介母自动预装」：三拼的介母改为预装段，直接显示正确介母的
 * 书写形（j/q/x 后 ü 去点写成 u），托盘不再出介母零件，孩子只拼声母 + 韵母。
 * 纯逻辑（无 DOM），导出供 Node 单元测试。 */
export function layoutFor(mission, { medialAuto = false } = {}) {
  const type = mission.type;
  const initial = { id: 'initial', group: 'initial', y0: 70, y1: 200 };
  const medial = { id: 'medial', group: 'medial', y0: 200, y1: 320 };
  const final = { id: 'final', group: 'final', y0: 320, y1: 450 };
  if (type === 'three_part') {
    if (medialAuto) {
      const value = mission.parts?.medial || '';
      const display = JQX.includes(mission.parts?.initial) ? removeDots(value) : value;
      return { active: [initial, final], locked: [], prefilled: [{ ...medial, note: display || '已预装' }] };
    }
    return { active: [initial, medial, final], locked: [], prefilled: [] };
  }
  if (type === 'two_part') return { active: [initial, final], locked: [{ ...medial, note: '无需介母' }], prefilled: [] };
  if (type === 'zero_initial') return {
    active: [final],
    locked: [{ ...medial, note: '无需介母' }],
    prefilled: [{ ...initial, note: '零声母' }],
  };
  // whole_syllable：单级 SSTO
  return { active: [{ id: 'whole', group: 'whole', y0: 70, y1: 450 }], locked: [], prefilled: [] };
}

/** 纯逻辑：按拼读顺序（声母→介母→韵母 / 整体）找下一个待装配槽位，全装完返回 null。
 * isFilled(id) 报告槽位是否已安装。导出供 Node 单元测试（错两次自动帮扶的目标选择）。 */
export function nextHintSlot(layout, isFilled) {
  for (const r of layout.active) if (!isFilled(r.id)) return { id: r.id, group: r.group };
  return null;
}

/* ----------------------------- 任务简报 ----------------------------- */

export function renderBriefing(container, mission, { onReplay, onSlowReplay, onStart }) {
  container.innerHTML = '';
  const screen = h('section', { class: 'screen briefing' },
    h('div', { class: 'brief-hanzi', text: mission.hanzi }),
    h('div', { class: 'brief-word', text: mission.word }),
    h('div', { class: 'brief-replay' },
      h('button', { class: 'phys-btn small', type: 'button', onclick: () => onReplay?.() }, iconEl('radio'), ' 重播'),
      h('button', { class: 'phys-btn small', type: 'button', onclick: () => onSlowReplay?.() }, iconEl('turtle'), ' 慢读'),
    ),
    h('button', { class: 'phys-btn primary', type: 'button', onclick: () => onStart?.() }, '组装 ▸'),
  );
  container.append(screen);
  return screen;
}

/* ----------------------------- 组装台 ----------------------------- */

export function renderAssembly(container, mission, { medialAuto = false, onReplay } = {}) {
  container.innerHTML = '';
  const layout = layoutFor(mission, { medialAuto });

  const root = h('section', { class: 'screen assembly' });
  const stageArea = h('div', { class: 'stage-area' });
  const trayArea = h('div', { class: 'tray-area' });
  root.append(stageArea, trayArea);
  container.append(root);

  /* ---- SVG 火箭与发射塔架 ----
   * 不锈钢星舰语言：金属圆柱箭体 + 隔热瓦带 + 法兰焊缝 + 前后翼 flap + 三喷管发动机群；
   * 每级舱段中央是凹陷「货舱面板」（.slot-body），拼音 dock 后直接写在面板里，不另画零件框。 */
  const svg = s('svg', { class: 'rocket-svg', viewBox: '0 0 360 560', preserveAspectRatio: 'xMidYMid meet' });

  const defs = s('defs', {},
    /* 调色板走 CSS 变量（skins.css 按皮肤覆盖），fallback = 深空经典 */
    s('linearGradient', { id: 'steel', x1: '0', y1: '0', x2: '1', y2: '0' },
      s('stop', { offset: '0', style: 'stop-color:var(--rk-st1,#59636f)' }),
      s('stop', { offset: '.3', style: 'stop-color:var(--rk-st2,#cfd6df)' }),
      s('stop', { offset: '.48', style: 'stop-color:var(--rk-st3,#f2f5f8)' }),
      s('stop', { offset: '.62', style: 'stop-color:var(--rk-st4,#b9c2cc)' }),
      s('stop', { offset: '1', style: 'stop-color:var(--rk-st5,#47505b)' })),
    s('linearGradient', { id: 'steelDim', x1: '0', y1: '0', x2: '1', y2: '0' },
      s('stop', { offset: '0', style: 'stop-color:var(--rk-sd1,#39424d)' }),
      s('stop', { offset: '.35', style: 'stop-color:var(--rk-sd2,#8b95a1)' }),
      s('stop', { offset: '.5', style: 'stop-color:var(--rk-sd3,#b9c2cc)' }),
      s('stop', { offset: '.65', style: 'stop-color:var(--rk-sd4,#77818d)' }),
      s('stop', { offset: '1', style: 'stop-color:var(--rk-sd5,#2b333d)' })),
    s('linearGradient', { id: 'nozzle', x1: '0', y1: '0', x2: '0', y2: '1' },
      s('stop', { offset: '0', style: 'stop-color:var(--rk-nz1,#2b333d)' }),
      s('stop', { offset: '1', style: 'stop-color:var(--rk-nz2,#0a0d12)' })),
    s('pattern', { id: 'tiles', width: '6', height: '6', patternUnits: 'userSpaceOnUse' },
      s('rect', { width: '6', height: '6', style: 'fill:var(--rk-tile-a,#0b0e13)' }),
      s('rect', { x: '.4', y: '.4', width: '5.2', height: '5.2', rx: '1', style: 'fill:var(--rk-tile-b,#151a22)' })),
    s('radialGradient', { id: 'padGlow' },
      s('stop', { offset: '0', style: 'stop-color:var(--rk-glow,rgba(190,215,255,0.32))' }),
      s('stop', { offset: '1', 'stop-color': 'rgba(190,215,255,0)' })),
  );
  svg.append(defs);

  // 发射台泛光
  svg.append(s('ellipse', { cx: '200', cy: '514', rx: '96', ry: '16', fill: 'url(#padGlow)' }));

  // 格构勤务塔（剪影 + 摆臂 + 拉索 + 航空障碍灯）
  const tower = s('g', { class: 'tower' },
    s('rect', { x: '58', y: '36', width: '14', height: '476', style: 'fill:var(--rk-tower,#161d29);stroke:var(--rk-tower-edge,rgba(255,255,255,0.08))', 'stroke-width': '1' }),
    s('rect', { x: '50', y: '512', width: '30', height: '10', style: 'fill:var(--rk-tower,#161d29)' }),
    s('polygon', { points: '72,148 140,156 140,164 72,160', style: 'fill:var(--rk-tower-arm,#1a2230);stroke:var(--rk-tower-edge,rgba(255,255,255,0.06))', 'stroke-width': '1' }),
    s('polygon', { points: '72,298 140,306 140,314 72,310', style: 'fill:var(--rk-tower-arm,#1a2230);stroke:var(--rk-tower-edge,rgba(255,255,255,0.06))', 'stroke-width': '1' }),
    s('line', { x1: '65', y1: '36', x2: '65', y2: '148', style: 'stroke:var(--rk-tower-brace,#1d2635)', 'stroke-width': '1' }),
    s('circle', { class: 'beacon', cx: '65', cy: '30', r: '3', style: 'fill:var(--danger,#ff5d5d)' }),
  );
  let brace = '';
  for (let y = 60; y < 448; y += 32) brace += `M58 ${y} L72 ${y + 32} M72 ${y + 32} L58 ${y + 64} `;
  tower.append(s('path', { d: brace, style: 'stroke:var(--rk-tower-brace,#232c38)', 'stroke-width': '1.5', fill: 'none' }));
  svg.append(tower);

  // 发射台 + 夹持器 + 导流槽支腿
  svg.append(s('g', { class: 'pad' },
    s('rect', { x: '118', y: '512', width: '164', height: '10', rx: '2', style: 'fill:var(--rk-pad,#202a3a)' }),
    s('rect', { x: '130', y: '522', width: '14', height: '16', style: 'fill:var(--rk-tower,#161d29)' }),
    s('rect', { x: '256', y: '522', width: '14', height: '16', style: 'fill:var(--rk-tower,#161d29)' }),
    s('rect', { x: '146', y: '506', width: '10', height: '8', style: 'fill:var(--rk-bezel,#2a323d)' }),
    s('rect', { x: '244', y: '506', width: '10', height: '8', style: 'fill:var(--rk-bezel,#2a323d)' }),
  ));

  // 发动机裙 + 三喷管（中钟 + 两侧钟）
  svg.append(s('path', { d: 'M150 450 L250 450 L262 486 L138 486 Z', fill: 'url(#steelDim)', style: 'stroke:var(--rk-hull-edge,#0a0d12)', 'stroke-width': '1' }));
  svg.append(s('polygon', { points: '148,486 172,486 178,506 142,506', fill: 'url(#nozzle)', style: 'stroke:var(--rk-hull-edge,#0a0d12)', 'stroke-width': '1' }));
  svg.append(s('polygon', { points: '228,486 252,486 258,506 222,506', fill: 'url(#nozzle)', style: 'stroke:var(--rk-hull-edge,#0a0d12)', 'stroke-width': '1' }));
  svg.append(s('polygon', { points: '182,486 218,486 228,512 172,512', fill: 'url(#nozzle)', style: 'stroke:var(--rk-hull-edge,#0a0d12)', 'stroke-width': '1' }));
  svg.append(s('ellipse', { cx: '200', cy: '510', rx: '24', ry: '4.5', fill: '#05070c' }));
  // aft 翼 flap
  svg.append(s('polygon', { points: '140,430 108,446 108,458 140,452', fill: 'url(#steelDim)', style: 'stroke:var(--rk-hull-edge,#0a0d12)', 'stroke-width': '1' }));
  svg.append(s('polygon', { points: '260,430 292,446 292,458 260,452', fill: 'url(#steelDim)', style: 'stroke:var(--rk-hull-edge,#0a0d12)', 'stroke-width': '1' }));

  const slots = new Map();

  function drawSegment(region, { locked = false, prefilled = false } = {}) {
    const { id, group, y0, y1 } = region;
    const height = y1 - y0;
    const g = s('g', { class: 'slot', 'data-slot': id });
    // 金属圆柱舱段 + 左侧隔热瓦带
    const hull = s('rect', {
      x: '140', y: String(y0), width: '120', height: String(height), rx: '4',
      fill: locked ? 'url(#steelDim)' : 'url(#steel)', style: 'stroke:var(--rk-hull-edge,#0a0d12)', 'stroke-width': '1',
    });
    const tiles = s('rect', { x: '143', y: String(y0 + 3), width: '24', height: String(height - 6), fill: 'url(#tiles)', opacity: '.85' });
    // 凹陷货舱面板 = 拖拽落点高亮载体（.slot-body）
    const body = s('rect', {
      class: 'slot-body', x: '160', y: String(y0 + 32), width: '80', height: String(height - 48), rx: '3',
      style: 'fill:var(--rk-slot-bg,#0b0f16);stroke:var(--rk-slot-edge,rgba(255,255,255,0.28))', 'stroke-width': '1.5',
      ...(locked ? { 'stroke-dasharray': '4 3' } : {}),
    });
    const hit = s('rect', { class: 'slot-hit', x: '166', y: String(y0 + 38), width: '68', height: String(height - 60), rx: '3', fill: 'transparent' });
    const groupLabel = s('text', { class: 'slot-group', x: '200', y: String(y0 + 21), 'text-anchor': 'middle', text: GROUP_LABEL[group] });
    const valueLabel = s('text', { class: 'slot-value', x: '200', y: String((y0 + y1) / 2 + 10), 'text-anchor': 'middle', text: '' });
    const bezel = s('circle', { cx: '246', cy: String(y0 + 18), r: '6', style: 'fill:var(--rk-bezel,#2a323d)' });
    const light = s('circle', { class: 'slot-light', cx: '246', cy: String(y0 + 18), r: '3.5' });
    g.append(hull, tiles, body, hit, groupLabel, bezel, light);

    if (locked) {
      valueLabel.setAttribute('class', 'slot-value locked-note');
      valueLabel.textContent = region.note || '锁定';
      g.classList.add('is-locked');
      g.append(valueLabel);
    } else if (prefilled) {
      g.append(valueLabel);
      valueLabel.textContent = region.note || '已预装';
      g.classList.add('is-filled');
      light.classList.add('on');
    } else {
      valueLabel.textContent = '?';
      valueLabel.setAttribute('class', 'slot-value placeholder');
      g.append(valueLabel);
    }
    svg.append(g);

    slots.set(id, {
      id, group, y0, y1, hitEl: hit, bodyEl: body, valueEl: valueLabel, lightEl: light, gEl: g,
      filled: locked || prefilled, active: !locked && !prefilled,
    });
  }

  // 先画锁定/预装段，再画活动段（顺序无关，按区域定位）
  for (const r of layout.locked) drawSegment(r, { locked: true });
  for (const r of layout.prefilled) drawSegment(r, { prefilled: true });
  for (const r of layout.active) drawSegment(r, {});

  // 法兰焊缝（舱段交界）+ 鼻锥 ogive + forward 翼 flap（盖在舱段之上）
  for (const y of [70, 200, 320, 450]) {
    svg.append(s('rect', { x: '136', y: String(y - 3), width: '128', height: '6', rx: '2', style: 'fill:var(--rk-flange,#39424e);stroke:var(--rk-hull-edge,#0a0d12)', 'stroke-width': '.5' }));
    svg.append(s('rect', { x: '136', y: String(y - 3), width: '128', height: '1.5', fill: 'rgba(255,255,255,0.25)' }));
  }
  svg.append(s('path', { d: 'M140 72 C146 42 172 20 200 14 C228 20 254 42 260 72 Z', fill: 'url(#steel)', style: 'stroke:var(--rk-hull-edge,#0a0d12)', 'stroke-width': '1' }));
  svg.append(s('ellipse', { cx: '188', cy: '42', rx: '7', ry: '16', fill: '#ffffff', opacity: '.28' }));
  svg.append(s('polygon', { points: '140,46 116,60 116,72 140,68', fill: 'url(#steelDim)', style: 'stroke:var(--rk-hull-edge,#0a0d12)', 'stroke-width': '1' }));
  svg.append(s('polygon', { points: '260,46 284,60 284,72 260,68', fill: 'url(#steelDim)', style: 'stroke:var(--rk-hull-edge,#0a0d12)', 'stroke-width': '1' }));

  stageArea.append(svg);
  const banner = h('div', { class: 'assembly-banner', hidden: true });
  stageArea.append(banner);

  /* ---- 零件库托盘 ---- */
  trayArea.append(h('div', { class: 'tray-title' },
    h('span', { text: '零件托盘' }),
    h('div', { class: 'tray-tools' },
      h('button', { class: 'phys-btn small', type: 'button', 'aria-label': '复读：再听一遍目标词', onclick: () => onReplay?.() }, iconEl('radio'), ' 复读'),
    ),
  ));
  const modules = [];
  const activeGroups = layout.active.map((r) => r.group);

  for (const group of activeGroups) {
    const correct = mission.parts[group];
    const distractors = (mission.distractors?.[group] || []).slice(0, 3);
    const values = shuffle([correct, ...distractors]);
    const row = h('div', { class: 'tray-row', 'data-group': group }, h('div', { class: 'tray-row-label', text: GROUP_LABEL[group] }));
    const cells = h('div', { class: 'tray-cells' });
    for (const value of values) {
      const isUmlaut = typeof value === 'string' && value.includes('ü');
      const mod = h('div', {
        class: 'module' + (isUmlaut ? ' umlaut' : ''),
        'data-group': group, 'data-value': value, text: value,
      });
      cells.append(mod);
      modules.push({ el: mod, group, value, isUmlaut });
    }
    row.append(cells);
    trayArea.append(row);
  }

  /* ---- 正确零件高亮：舱段 + 托盘正确零件同步点亮 ----
   * 默认闪烁约 2.6s 自动清除；sticky = 两次填错后的自动帮扶，持续点亮直到装对。
   * 只加 .hint 类（描边/辉光动画），不动 transform，与拖拽引擎的位移互不干扰。 */
  let hintTimer = 0;
  let hinted = [];
  function clearHint() {
    clearTimeout(hintTimer);
    hintTimer = 0;
    for (const el of hinted) el.classList.remove('hint', 'sticky');
    hinted = [];
  }

  /* ---- 对外 API ---- */
  function centerOf(slot) {
    const r = slot.hitEl.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }

  return {
    root, svg, modules, banner,
    getSlots() {
      return [...slots.values()].filter((sl) => sl.active).map((sl) => ({
        id: sl.id, group: sl.group, el: sl.bodyEl, center: () => centerOf(sl),
      }));
    },
    getSlot(id) { return slots.get(id); },
    isFilled(id) { return slots.get(id)?.filled; },
    /** 下一个待装配槽位（拼读顺序）；全装完返回 null。 */
    nextEmpty() { return nextHintSlot(layout, (id) => slots.get(id)?.filled); },
    /** 点亮指定舱段 + 托盘里对应的正确零件（已取走的空插座不点亮）。
     * sticky=true 时不自动清除（两次填错后的自动帮扶），直到装对 / 下一次高亮 / 销毁。 */
    flashHint(id, value, { sticky = false } = {}) {
      clearHint();
      const sl = slots.get(id);
      if (!sl || sl.filled) return;
      sl.gEl.classList.add('hint');
      hinted.push(sl.gEl);
      const mod = modules.find((mo) => mo.group === sl.group && mo.value === value && !mo.el.classList.contains('docked'));
      if (mod) { mod.el.classList.add('hint'); hinted.push(mod.el); }
      if (sticky) {
        sl.gEl.classList.add('sticky');
        mod?.el.classList.add('sticky');
      } else {
        hintTimer = setTimeout(clearHint, 2600);
      }
    },
    setMagnet(id, on) { slots.get(id)?.gEl.classList.toggle('magnet', !!on); },
    clearMagnets() { for (const sl of slots.values()) sl.gEl.classList.remove('magnet'); },
    setSlotFilled(id, displayValue) {
      const sl = slots.get(id);
      if (!sl) return;
      clearHint(); // 零件已装上，提示高亮即失效
      sl.filled = true;
      sl.gEl.classList.add('is-filled');
      // 拼音直接写进货舱面板，不再另画带框金属牌（避免与火箭舱段框叠框）
      sl.valueEl.setAttribute('class', 'slot-value');
      sl.valueEl.textContent = displayValue;
      sl.lightEl.classList.add('on');
    },
    flashError(id) {
      const sl = slots.get(id);
      if (!sl) return;
      sl.gEl.classList.add('is-error');
      setTimeout(() => sl.gEl.classList.remove('is-error'), 550);
    },
    allActiveFilled() { return [...slots.values()].filter((sl) => sl.active).every((sl) => sl.filled); },
    complete(displayPinyin) {
      banner.hidden = false;
      banner.innerHTML = '';
      banner.append(h('span', { class: 'banner-pinyin', text: displayPinyin }), h('span', { class: 'banner-text', text: '完成!' }));
      svg.classList.add('is-complete');
    },
    /**
     * 摘墨镜交互：返回 Promise，孩子点按两个圆点后 resolve。
     * @param {string} value 带两点的韵母/介母（ü / üe / ün / üan）
     */
    showDotRemoval(value) {
      return new Promise((resolve) => {
        const overlay = h('div', { class: 'dot-overlay' });
        const card = h('div', { class: 'dot-card' });
        card.append(
          h('img', { class: 'dot-spark', src: iconUrl('spark'), alt: '', 'aria-hidden': 'true', draggable: 'false' }),
          h('div', { class: 'dot-msg', text: 'j/q/x 后面 ü 要去点！' }),
        );
        const glyph = h('div', { class: 'dot-glyph' });
        // 去点后的书写形（ü→u、üe→ue、ün→un、üan→uan），首字母单独成块，供两点定位
        const plain = String(value).replace(/ü/g, 'u');
        const head = h('span', { class: 'dot-head', text: plain.slice(0, 1) });
        const baseLetter = h('span', { class: 'dot-base' }, head, h('span', { class: 'dot-tail', text: plain.slice(1) }));
        // 两点定位在首个字母（u）正上方，尺寸由 .dot-btn 控制（便于小手点按）
        const dotWrap = h('div', { class: 'dot-wrap' });
        let removed = 0;
        const dots = [0, 1].map((i) => {
          const dot = h('button', { class: 'dot-btn', type: 'button', 'aria-label': `摘除第 ${i + 1} 个点` });
          dot.addEventListener('pointerdown', (e) => {
            e.preventDefault();
            if (dot.classList.contains('gone')) return;
            dot.classList.add('gone');
            removed++;
            if (removed === 2) {
              glyph.classList.add('done');
              setTimeout(() => { overlay.remove(); resolve(); }, 480);
            }
          });
          return dot;
        });
        dotWrap.append(...dots);
        head.append(dotWrap); // 两点挂在首字母内部 → 绝对定位相对它居中
        glyph.append(baseLetter);
        card.append(glyph, h('div', { class: 'dot-tip', text: '点两下圆点' }));
        overlay.append(card);
        root.append(overlay);
      });
    },
    destroy() { clearHint(); container.innerHTML = ''; },
  };
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** 勋章视觉：优先火箭模型图，加载失败回退 AI 火箭图标。 */
function badgeImage(b, className) {
  const img = h('img', { class: className, src: b.image || `/images/badges/${b.id}.png`, alt: b.name, loading: 'lazy' });
  img.addEventListener('error', () => {
    img.replaceWith(h('img', { class: className + ' fallback', src: iconUrl('rocket'), 'data-icon': 'rocket', alt: b.name }));
  }, { once: true });
  return img;
}

/** 星球图鉴缩略图：复用 planet-fx 代码绘制（与发射动画同画风）；地球三层轨道用对应视角。 */
function planetThumb(dest, size = 120) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const cv = h('canvas', { class: 'planet-thumb', width: String(size * dpr), height: String(size * dpr) });
  cv.style.width = size + 'px'; cv.style.height = size + 'px';
  const c = cv.getContext('2d');
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  // 深空底（跟随皮肤 --space-0）
  c.fillStyle = (getComputedStyle(document.documentElement).getPropertyValue('--space-0').trim() || '#05070d');
  c.fillRect(0, 0, size, size);
  if (dest.kind === 'orbit') drawOrbitEarth(c, dest.orbitView || 'low', size, size, 0);
  else drawPlanet(c, dest.id, size / 2, size / 2, size * 0.36, 0, { rot: 0.35 });
  return cv;
}

/* ----------------------------- 太空博物馆 ----------------------------- */

/**
 * 太空博物馆抽屉：星球图鉴（课时奖励进度已并入）+ 已解锁/未解锁火箭卡。
 * 已解锁的火箭卡片带「设为座驾」按钮（`onSelect` 负责持久化并返回火箭）。
 * @param {object} profile /api/profile 返回（含 badges / unlockedBadges / rewardLevel / visitedDestinations）
 * @param {{onClose?: Function, onSelect?: (rocketId: string) => Promise<object|null>}} handlers
 */
export function renderMuseum(profile, { onClose, onSelect } = {}) {
  const overlay = h('div', { class: 'museum-overlay' });
  const panel = h('div', { class: 'museum-panel' });
  // 顶部只留标题（累计发射次数在机库顶栏看，博物馆不再重复展示）
  const head = h('div', { class: 'museum-head' },
    h('h2', { class: 'museum-title' }, iconEl('museum'), ' 太空博物馆'),
    h('button', { class: 'phys-btn small', type: 'button', onclick: () => { overlay.remove(); onClose?.(); } }, '✕ 关闭'),
  );
  panel.append(head);

  /* ---- 星球图鉴（原「奖励系统」已并入）：课时进度条 + 14 种目的地卡片 ----
   * 每张卡片同时承载奖励档位（Lv / 当前 / 下一站 / 课时门槛）与图鉴信息
   * （代码绘制缩略图 + 百科 + 到访计数），不再单独渲染一份奖励阶梯。 */
  const ladder = rewardLadder();
  const done = Math.max(0, Math.floor(Number(profile.lessonsCompleted) || 0));
  const lessonTotal = Math.max(0, Math.floor(Number(profile.lessonsTotal) || 0));
  const level = Math.max(1, Math.min(ladder.length, Math.floor(Number(profile.rewardLevel) || 1)));
  const next = profile.nextReward !== undefined ? profile.nextReward : nextRewardForLessons(done);
  // 进度条 = 累计课时在「14 档目的地之旅」（0 → 26 课时）上的位置，只增不清零。
  // 旧版按「距下一档」计算，恰好跨过门槛（如 2 课时解锁 Lv2）时柱子归零，看起来像空白 bug。
  const journeyMax = Math.max(1, lessonsForRewardLevel(ladder.length));
  const pct = Math.round(Math.min(1, done / journeyMax) * 100);

  const visited = profile.visitedDestinations || {};
  const planetGrid = h('div', { class: 'museum-grid planet-grid' });
  for (const d of destinationList()) {
    const count = visited[d.id] || 0;
    const unlocked = count > 0 || d.level <= level;
    // 奖励档位状态：低于当前档 = 已完成；当前档 / 下一档高亮；其余锁定
    let state = 'locked';
    if (d.level < level) state = 'done';
    else if (d.level === level) state = 'current';
    else if (next && d.level === next.level) state = 'next';
    const stateLabel = state === 'current' ? '当前目的地'
      : state === 'next' ? '下一站'
      : unlocked ? '已解锁' : '未解锁';
    planetGrid.append(h('div', {
      class: `badge-card planet-card ${unlocked ? 'unlocked' : 'locked'} ${state}`,
      'data-level': d.level,
      title: `Lv${d.level} · ${d.name} · ${d.fact}`,
    },
      planetThumb(d, 120),
      h('div', { class: 'badge-card-name' }, destIconEl(d.id), ` ${d.name}`),
      h('div', { class: 'badge-card-en', text: d.nameEn }),
      h('div', { class: `planet-card-state ${state}`, text: `Lv${d.level} · ${stateLabel}` }),
      unlocked
        ? h('div', { class: 'badge-card-sum', text: count > 0 ? `已到访 ×${count} · ${d.fact}` : d.fact })
        : h('div', {
          class: 'badge-card-sum',
          text: state === 'next' ? `再完成 ${next.need} 课时解锁` : `完成 ${lessonsForRewardLevel(d.level)} 课时解锁`,
        }),
    ));
  }

  panel.append(
    h('h3', { class: 'museum-subtitle', text: '星球图鉴' }),
    h('div', { class: 'reward-progress' },
      h('div', { class: 'reward-progress-row' },
        h('span', { class: 'reward-progress-label', text: '已完成课时' }),
        h('b', { class: 'reward-progress-value', text: lessonTotal > 0 ? `${done} / ${lessonTotal}` : String(done) }),
        h('span', {
          class: 'reward-progress-next',
        }, ...(next
          ? [`再完成 ${next.need} 课时解锁 `, destIconEl(next.destination.id), ` ${next.destination.name}`]
          : ['全部星际目的地已解锁'])),
      ),
      h('div', {
        class: 'reward-bar', role: 'progressbar',
        'aria-valuenow': pct, 'aria-valuemin': '0', 'aria-valuemax': '100',
        'aria-label': '星际目的地解锁进度（每 2 课时解锁 1 个）',
      }, h('i', { style: `width:${pct}%` })),
    ),
    planetGrid,
  );

  // 火箭图鉴：按首飞年份（时间）排序，未来概念火箭（concept）压轴；已获得的火箭可一键设为出战座驾
  const unlocked = new Set(profile.unlockedBadges || []);
  const badges = (profile.badges || profile.museum || []).slice().sort((a, b) =>
    ((a.concept ? 1 : 0) - (b.concept ? 1 : 0)) || ((a.year || 0) - (b.year || 0)));
  const yearText = (b) => b.concept ? '未来概念' : (b.year || '');
  const yearClass = (b) => 'badge-card-year' + (b.concept ? ' concept' : '');
  const currentId = profile.currentRocket?.id || null;
  const grid = h('div', { class: 'museum-grid' });

  /** 同步「当前座驾」标记：自选后不必重建整个抽屉。 */
  function markCurrent(rocketId) {
    for (const card of grid.querySelectorAll('.badge-card[data-id]')) {
      const on = card.dataset.id === rocketId;
      card.classList.toggle('is-current', on);
      const btn = card.querySelector('.badge-card-action');
      if (!btn) continue;
      btn.classList.toggle('active', on);
      btn.disabled = on;
      btn.textContent = on ? '当前座驾' : '设为座驾';
    }
  }

  for (const b of badges) {
    if (unlocked.has(b.id)) {
      const isCurrent = b.id === currentId;
      const action = h('button', {
        class: 'badge-card-action' + (isCurrent ? ' active' : ''),
        type: 'button',
      }, isCurrent ? '当前座驾' : '设为座驾');
      action.disabled = isCurrent;
      action.addEventListener('click', async () => {
        if (!onSelect) return;
        action.disabled = true;
        action.textContent = '切换中…';
        const rocket = await onSelect(b.id);
        if (!rocket) {
          action.disabled = false;
          action.textContent = '设为座驾';
          action.classList.remove('active');
          return;
        }
        markCurrent(rocket.id);
      });
      grid.append(h('div', { class: 'badge-card unlocked' + (isCurrent ? ' is-current' : ''), 'data-id': b.id },
        badgeImage(b, 'badge-card-img'),
        h('div', { class: yearClass(b), text: yearText(b) }),
        h('div', { class: 'badge-card-name', text: b.name }),
        h('div', { class: 'badge-card-en', text: b.nameEn || '' }),
        b.starter ? h('div', { class: 'badge-card-sum', text: '初始座驾 · 默认拥有' }) : null,
        h('div', { class: 'badge-card-spacer' }),
        action,
      ));
    } else {
      grid.append(h('div', { class: 'badge-card locked', 'data-id': b.id },
        h('img', { class: 'badge-card-icon', src: iconUrl('lock'), alt: '', 'aria-hidden': 'true', draggable: 'false' }),
        h('div', { class: yearClass(b), text: yearText(b) }),
        h('div', { class: 'badge-card-name', text: b.name }),
        h('div', { class: 'badge-card-en', text: b.nameEn || '' }),
        h('div', { class: 'badge-card-sum', text: `发射 ${b.unlockAt} 次解锁` }),
      ));
    }
  }
  panel.append(h('h3', { class: 'museum-subtitle', text: `火箭 ${unlocked.size}/${badges.length}` }), grid);
  overlay.append(panel);
  document.body.append(overlay);
  return { destroy() { overlay.remove(); } };
}
