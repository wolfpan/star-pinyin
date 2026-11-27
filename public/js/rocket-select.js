/**
 * rocket-select.js — 火箭拥有 / 座驾选择的纯逻辑（浏览器 / Node 共用，零依赖）
 * ------------------------------------------------------------------
 * 规则：
 *  - 初始座驾（`starter: true` 或 `unlockAt: 0`，即土星五号）默认拥有，不作为解锁奖励。
 *  - 其余火箭按累计完成单元（课时）数解锁，每 3 个单元一枚；解锁即进入「机库」，可在指挥官界面里自选出战座驾。
 *  - 拥有状态以单元数推导为准（`rocketIdsForUnits`），服务端据此校准档案，旧规则多发的自动收回。
 *  - 火箭收藏与星体目的地解耦：解锁火箭只扩充机库 / 图鉴，不影响课时奖励档位。
 *  - 没自选过时回落到最新获得的一枚（保持旧的「解锁即自动换新」体验）；
 *    一旦自选，就固定用自选的这一枚，之后解锁新火箭也不会抢走座驾。
 */

/** 初始座驾：默认拥有、不需要获得、不作为解锁奖励。 */
export const isStarterBadge = (b) => b?.starter === true || Number(b?.unlockAt) === 0;

/** 按解锁门槛升序（同档保持 badges.json 原始顺序）。 */
export const byUnlockAt = (a, b) => (Number(a?.unlockAt) || 0) - (Number(b?.unlockAt) || 0);

/** 当前拥有的全部火箭 id = 初始座驾 ∪ 已入轨解锁（进度文件可能尚未写入初始座驾）。 */
export function ownedRocketIds(progress, badges) {
  const owned = new Set(progress?.unlockedBadges || []);
  for (const b of badges || []) if (isStarterBadge(b)) owned.add(b.id);
  return owned;
}

/**
 * 按完成单元数推导拥有状态：初始座驾 ∪ unlockAt ≤ 单元数（每 3 单元一枚）。
 * 服务端以此为准校准档案，旧规则（发射次数）多发的火箭自动收回。
 */
export function rocketIdsForUnits(badges, units) {
  const n = Math.max(0, Math.floor(Number(units) || 0));
  const owned = new Set();
  for (const b of badges || []) if (isStarterBadge(b) || Number(b.unlockAt) <= n) owned.add(b.id);
  return owned;
}

/** 已拥有火箭列表（按解锁门槛升序，初始座驾在最前），供机库自选。 */
export function ownedRockets(progress, badges) {
  const owned = ownedRocketIds(progress, badges);
  return (badges || []).filter((b) => owned.has(b.id)).sort(byUnlockAt);
}

/**
 * 当前出战座驾：
 *  - 自选过且仍然拥有 → 用自选的这一枚；
 *  - 没自选 / 自选的已失效（进度被手改）→ 回落到最新获得的一枚。
 * @param {object} progress data/progress.json
 * @param {Array} badges data/badges.json
 * @returns {object|null} 火箭卡片
 */
export function resolveCurrentRocket(progress, badges) {
  const list = ownedRockets(progress, badges);
  if (list.length === 0) return null;
  const chosen = progress?.selectedRocketId;
  return (chosen && list.find((b) => b.id === chosen)) || list[list.length - 1];
}

/** 该火箭是否已获得（可用于自选）。 */
export function canSelectRocket(progress, badges, rocketId) {
  if (!rocketId) return false;
  return ownedRocketIds(progress, badges).has(rocketId);
}
