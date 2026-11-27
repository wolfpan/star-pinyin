/**
 * tone-canvas.js — 声调推力轨迹校准交互模块
 * ------------------------------------------------------------------
 * 4 条发亮飞行姿态曲线：一声水平巡航 — / 二声仰角爬升 / / 三声俯冲蓄力再拉起 v / 四声高速俯冲 \。
 * 双模式兼容：
 *   1) 手指在轨迹校准仪上一笔画过 → 起止点 + 中点斜率识别（高容错）；
 *   2) 直接点击对应曲线图标（保底，降低挫败感）。
 * 纯交互模块，校准成功回调 onSuccess；错误回调 onError（由控制器计数）。
 */

import { iconHTML } from './icons.js';

const CURVES = {
  1: { label: '一声', mark: 'ā', path: 'M12,32 L88,32' },
  2: { label: '二声', mark: 'á', path: 'M12,46 L88,16' },
  3: { label: '三声', mark: 'ǎ', path: 'M12,18 L50,46 L88,22' },
  4: { label: '四声', mark: 'à', path: 'M12,16 L88,46' },
};

/** 由采样点识别声调（高容错）。返回 1..4 或 null（笔画太短）。 */
export function recognizeTone(points) {
  if (!points || points.length < 3) return null;
  const start = points[0];
  const end = points[points.length - 1];
  const mid = points[Math.floor(points.length / 2)];
  const dx = end.x - start.x, dy = end.y - start.y;
  const span = Math.hypot(dx, dy);
  if (span < 22) return null;
  // 三声：中点明显低于两端（v 形蓄力）
  const dip = mid.y - Math.max(start.y, end.y);
  if (dip > 12 && Math.abs(dy) < span * 0.65) return 3;
  // 一声：近似水平
  if (Math.abs(dy) <= Math.max(18, Math.abs(dx) * 0.35)) return 1;
  // 二声上升（屏幕 y 向下，故 dy<0）/ 四声下降
  return dy < 0 ? 2 : 4;
}

function curveSVG(tone) {
  const c = CURVES[tone];
  return `<svg viewBox="0 0 100 60" class="curve-svg" aria-hidden="true">
    <path d="${c.path}" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
}

/**
 * @param {HTMLElement} container
 * @param {{hanzi:string, base:string, tone:number, displayPinyin:string}} opts
 * @param {{onSuccess:Function, onError:Function}} handlers
 */
export function createToneCalibration(container, { hanzi, base, tone, displayPinyin }, { onSuccess, onError }) {
  container.innerHTML = '';
  const screen = document.createElement('section');
  screen.className = 'screen tone';
  screen.innerHTML = `
    <div class="tone-tag">声调</div>
    <div class="tone-target"><span class="tone-hanzi">${hanzi}</span><span class="tone-base">${base}</span></div>
    <div class="tone-pad-wrap"><canvas class="tone-pad"></canvas><div class="pad-guide">画一画 ${iconHTML('pencil')}</div></div>
    <div class="tone-curves">
      ${[1, 2, 3, 4].map((t) => `
        <button class="curve-btn" type="button" data-tone="${t}">
          ${curveSVG(t)}
          <span class="curve-mark">${CURVES[t].mark}</span>
          <span class="curve-label">${CURVES[t].label}</span>
        </button>`).join('')}
    </div>
    <div class="tone-feedback" aria-live="polite"></div>`;
  container.append(screen);

  const pad = screen.querySelector('.tone-pad');
  const guide = screen.querySelector('.pad-guide');
  const feedback = screen.querySelector('.tone-feedback');
  const ctx = pad.getContext('2d');
  let done = false;
  let drawing = false;
  let points = [];
  let dpr = Math.min(2, window.devicePixelRatio || 1);

  function sizePad() {
    const r = pad.getBoundingClientRect();
    pad.width = Math.max(1, Math.round(r.width * dpr));
    pad.height = Math.max(1, Math.round(r.height * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  sizePad();
  const onResize = () => { sizePad(); };
  window.addEventListener('resize', onResize);

  function clearPad() { ctx.clearRect(0, 0, pad.width, pad.height); }

  function drawSegment(a, b) {
    // 笔迹色跟随皮肤 --text（深空=白 / 天空积木=墨蓝 / 星云=奶白）
    ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--text').trim() || '#e8eef7';
    ctx.lineWidth = 6;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }

  function localPoint(e) {
    const r = pad.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function judge(guessed) {
    if (done || guessed == null) return;
    if (guessed === tone) {
      done = true;
      screen.classList.add('tone-ok');
      feedback.innerHTML = `<span class="ok">${iconHTML('check')} ${displayPinyin}</span>`;
      guide.textContent = '校准完成';
      setTimeout(() => onSuccess?.(), 700);
    } else {
      screen.classList.add('tone-bad');
      setTimeout(() => screen.classList.remove('tone-bad'), 450);
      feedback.innerHTML = `<span class="bad">再试一次</span>`;
      onError?.(guessed);
      clearPad();
    }
  }

  // 手势模式
  const down = (e) => {
    if (done) return;
    e.preventDefault();
    drawing = true;
    points = [localPoint(e)];
    guide.style.opacity = '0';
    pad.setPointerCapture(e.pointerId);
    clearPad();
  };
  const move = (e) => {
    if (!drawing || done) return;
    e.preventDefault();
    const p = localPoint(e);
    const prev = points[points.length - 1];
    points.push(p);
    drawSegment(prev, p);
  };
  const up = (e) => {
    if (!drawing) return;
    drawing = false;
    try { pad.releasePointerCapture(e.pointerId); } catch {}
    const g = recognizeTone(points);
    if (g == null) { feedback.innerHTML = '<span class="bad">画长一点</span>'; clearPad(); guide.style.opacity = '1'; return; }
    judge(g);
    if (!done) { guide.style.opacity = '1'; }
  };
  pad.addEventListener('pointerdown', down);
  pad.addEventListener('pointermove', move);
  pad.addEventListener('pointerup', up);
  pad.addEventListener('pointercancel', up);

  // 点击保底模式
  const onCurveClick = (e) => {
    const btn = e.target.closest('.curve-btn');
    if (!btn || done) return;
    judge(Number(btn.dataset.tone));
  };
  screen.querySelector('.tone-curves').addEventListener('click', onCurveClick);

  return {
    destroy() {
      window.removeEventListener('resize', onResize);
      pad.removeEventListener('pointerdown', down);
      pad.removeEventListener('pointermove', move);
      pad.removeEventListener('pointerup', up);
      pad.removeEventListener('pointercancel', up);
      container.innerHTML = '';
    },
  };
}
