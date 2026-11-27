/**
 * drag-engine.js — 基于 Pointer Events 的 iPad 磁吸拖拽引擎
 * ------------------------------------------------------------------
 * 强制约束：严禁 HTML5 Drag and Drop API；统一 pointerdown/move/up + setPointerCapture。
 * 采用 transform 位移（而非 position:fixed），零件在托盘中的占位不变，避免布局抖动；
 * 拖起时放大 1.15x + 轻微抬升阴影；进入正确槽位容差半径高亮磁吸；错选弹回托盘。
 *
 * 物理层只做位移/高亮/回弹动画；落点是否正确的判定由 onDrop 回调（main.js）决定。
 */

const JQX = ['j', 'q', 'x'];

/**
 * 纯逻辑落点判定（可在 Node 中单元测试，无 DOM 依赖）。
 * @param {object} mission 任务
 * @param {{group:string, value:string, isUmlaut:boolean}} meta 被拖拽零件
 * @param {{id:string, group:string}|null} slot 落入的槽位
 * @param {{initialFilled:boolean}} ctx 声母槽是否已安装
 * @returns {{action:'snap'|'bounce'|'dots', reason:string, error?:boolean, flash?:string}}
 */
export function resolveDrop(mission, meta, slot, { initialFilled }) {
  if (!slot) return { action: 'bounce', reason: 'no-slot' };
  if (slot.group !== meta.group) return { action: 'bounce', reason: 'wrong-slot', error: true };
  const correct = mission.parts[meta.group];
  if (meta.value !== correct) return { action: 'bounce', reason: 'wrong-value', error: true };
  if (meta.isUmlaut && JQX.includes(mission.parts.initial)) {
    if (!initialFilled) return { action: 'bounce', reason: 'need-initial', error: true, flash: 'initial' };
    return { action: 'dots', reason: 'drop-dots' };
  }
  return { action: 'snap', reason: 'ok' };
}

/**
 * @param {object} opts
 * @param {number} [opts.tolerance=60] 磁吸容差半径（px）
 * @param {() => Array<{id,group,el,center:()=>{x,y}}>} opts.getSlots 当前活动槽位
 * @param {(meta, slot|null) => Promise<{action:'snap'|'bounce'|'dots', slot?, complete?:Promise}>} opts.onDrop
 * @param {(slot|null) => void} [opts.highlight] 磁吸高亮回调
 */
export function createDragEngine({ tolerance = 60, getSlots, onDrop, highlight }) {
  const ANIM_MS = 200;

  function nearestSlot(px, py) {
    let best = null, bestD = Infinity;
    for (const sl of getSlots()) {
      const c = sl.center();
      const d = Math.hypot(px - c.x, py - c.y);
      if (d < bestD) { bestD = d; best = sl; }
    }
    return bestD <= tolerance ? best : null;
  }

  function bind(moduleEl, meta) {
    let dragging = false;
    let startX = 0, startY = 0, homeCX = 0, homeCY = 0;

    const setTransform = (dx, dy, scale, animate) => {
      moduleEl.style.transition = animate ? `transform ${ANIM_MS}ms ease` : 'none';
      moduleEl.style.transform = `translate(${dx}px, ${dy}px) scale(${scale})`;
    };

    const onDown = (e) => {
      if (dragging || moduleEl.classList.contains('locked')) return;
      if (e.isPrimary === false) return;
      e.preventDefault();
      dragging = true;
      startX = e.clientX; startY = e.clientY;
      const r = moduleEl.getBoundingClientRect();
      homeCX = r.left + r.width / 2; homeCY = r.top + r.height / 2;
      moduleEl.setPointerCapture(e.pointerId);
      moduleEl.classList.add('dragging');
      setTransform(0, 0, 1.15, false);
    };

    const onMove = (e) => {
      if (!dragging) return;
      e.preventDefault();
      const dx = e.clientX - startX, dy = e.clientY - startY;
      setTransform(dx, dy, 1.15, false);
      const sl = nearestSlot(e.clientX, e.clientY);
      highlight?.(sl && sl.group === meta.group ? sl : null);
    };

    const finish = async (e) => {
      if (!dragging) return;
      dragging = false;
      try { moduleEl.releasePointerCapture(e.pointerId); } catch {}
      moduleEl.classList.remove('dragging');
      highlight?.(null);

      const slot = nearestSlot(e.clientX, e.clientY);
      const decision = (await onDrop(meta, slot)) || { action: 'bounce' };

      if (decision.action === 'snap' || decision.action === 'dots') {
        const target = decision.slot || slot;
        const c = target.center();
        setTransform(c.x - homeCX, c.y - homeCY, 1, true);
        if (decision.action === 'dots' && decision.complete) {
          await decision.complete;
        }
        setTimeout(() => {
          // 回到托盘原位再变空插座：火箭上只留舱段面板里的拼音，不残留零件虚框
          moduleEl.style.transition = 'none';
          moduleEl.style.transform = '';
          moduleEl.classList.add('locked');
          moduleEl.classList.add('docked'); // 空插座视觉（space.css），保留货架占位
        }, ANIM_MS);
      } else {
        // 错选回弹
        setTransform(0, 0, 1, true);
        setTimeout(() => {
          moduleEl.style.transition = 'none';
          moduleEl.style.transform = '';
        }, ANIM_MS);
      }
    };

    moduleEl.addEventListener('pointerdown', onDown);
    moduleEl.addEventListener('pointermove', onMove);
    moduleEl.addEventListener('pointerup', finish);
    moduleEl.addEventListener('pointercancel', finish);
  }

  return { bind };
}
