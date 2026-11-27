/**
 * build-design-mocks.mjs — 生成三套风格样板页（指挥官界面 + 组装界面）
 * 用法：node scripts/build-design-mocks.mjs
 * 输出：design-mocks/mock-{a,b,c}.html（共享 body.html + mock-base.css + theme-*.css）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'design-mocks');
const body = fs.readFileSync(path.join(DIR, 'body.html'), 'utf8');

const THEMES = [
  { key: 'a', name: '方案 A · 深空座舱 HUD', en: 'COCKPIT HUD', desc: '保留深空底色，演化为全息座舱：青蓝辉光线框 / 四角括线 / 仪表标签 / 状态灯，专业科幻沉浸感。' },
  { key: 'b', name: '方案 B · 天空积木', en: 'SKY BLOCKS', desc: '星云式玩具糖果风（偏亮护眼）：浅天蓝底 + 糖果分类色 / 天蓝按压按钮，大圆角、硬阴影，低龄友好。' },
  { key: 'c', name: '方案 C · 星云乐园', en: 'NEBULA PLAYGROUND', desc: '卡通糖果风：紫星云渐变 + 糖果色分类，大圆角、玩具按压按钮，低龄友好、游戏感强。' },
];

for (const t of THEMES) {
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<title>${t.name} · 星际发射指挥官 风格样板</title>
<link rel="stylesheet" href="mock-base.css" />
<link rel="stylesheet" href="theme-${t.key}.css" />
</head>
<body>
<header class="mock-head">
  <div class="mock-name">${t.name}<em>${t.en}</em></div>
  <div class="mock-desc">${t.desc}</div>
</header>
<div class="frame-cap">▍指挥官界面（机库待命）· iPad 横屏 1024×768</div>
${body.split('<!-- ================= 组装界面 ================= -->')[0]}
<div class="frame-cap">▍组装界面（火箭塔架 + 零件托盘）· iPad 横屏 1024×768</div>
<!-- ================= 组装界面 ================= -->${body.split('<!-- ================= 组装界面 ================= -->')[1]}
</body>
</html>
`;
  fs.writeFileSync(path.join(DIR, `mock-${t.key}.html`), html);
  console.log('built design-mocks/mock-' + t.key + '.html');
}