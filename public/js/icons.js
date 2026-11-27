/**
 * icons.js — AI 生成图标素材统一入口（全面替代 emoji 图标）。
 * ------------------------------------------------------------------
 * 三套可切换风格（家长后台「图标风格」选择，镜像皮肤系统，全设备同步）：
 *   a=写实航天渲染 · b=扁平几何仪表 · c=复古丝网海报
 * 素材由 scripts/gen-ui-icons.mjs（wan2.7-image 品红绿幕）+ chroma-key-icons.py 抠透明：
 *   /images/icons/{style}/{name}.png      UI 图标
 *   /images/icons/{style}/dest/{id}.png   14 个星际目的地星球图标
 * 每个图标 img 带 data-icon / data-dest，applyIconStyle() 据此整体换肤。
 * 图标均为装饰性：alt 空 + aria-hidden，语义由相邻文字承担。
 */

export const ICON_STYLES = ['a', 'b', 'c'];

/** 当前风格（html[data-icon-style]，首帧前由启动脚本写入）。 */
export function currentIconStyle() {
  const s = document.documentElement.dataset.iconStyle;
  return ICON_STYLES.includes(s) ? s : 'a';
}

export const iconUrl = (name) => `/images/icons/${currentIconStyle()}/${name}.png`;
export const destIconUrl = (id) => `/images/icons/${currentIconStyle()}/dest/${id}.png`;

/** 内联图标 HTML（模板字符串场景）。cls 为附加类名，尺寸由 CSS 控制。 */
export function iconHTML(name, cls = '') {
  return `<img class="ui-icon${cls ? ' ' + cls : ''}" src="${iconUrl(name)}" data-icon="${name}" alt="" aria-hidden="true" draggable="false">`;
}
export function destIconHTML(id, cls = '') {
  return `<img class="ui-icon${cls ? ' ' + cls : ''}" src="${destIconUrl(id)}" data-dest="${id}" alt="" aria-hidden="true" draggable="false">`;
}

/** DOM 版图标（h() 构造器 / createElement 场景）。 */
export function iconEl(name, cls = '') {
  const img = document.createElement('img');
  img.className = 'ui-icon' + (cls ? ' ' + cls : '');
  img.src = iconUrl(name);
  img.dataset.icon = name;
  img.alt = '';
  img.setAttribute('aria-hidden', 'true');
  img.draggable = false;
  return img;
}
export function destIconEl(id, cls = '') {
  const img = document.createElement('img');
  img.className = 'ui-icon' + (cls ? ' ' + cls : '');
  img.src = destIconUrl(id);
  img.dataset.dest = id;
  img.alt = '';
  img.setAttribute('aria-hidden', 'true');
  img.draggable = false;
  return img;
}

/**
 * 应用图标风格：写 html[data-icon-style] + localStorage，并把页面上所有
 * 已渲染图标（data-icon / data-dest）的 src 换成新风格。孩子端/后台共用。
 */
export function applyIconStyle(style) {
  const s = ICON_STYLES.includes(style) ? style : 'a';
  document.documentElement.dataset.iconStyle = s;
  try { localStorage.setItem('sp_iconstyle', s); } catch {}
  for (const img of document.querySelectorAll('img[data-icon]')) img.src = iconUrl(img.dataset.icon);
  for (const img of document.querySelectorAll('img[data-dest]')) img.src = destIconUrl(img.dataset.dest);
  return s;
}
