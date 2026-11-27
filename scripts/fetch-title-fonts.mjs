/**
 * fetch-title-fonts.mjs — 下载标题用开源中文字体（Google Fonts 子集化 woff2 + OFL 许可证）。
 * 用法：node scripts/fetch-title-fonts.mjs
 * 子集只含「火箭号指挥官星际发射」10 字，单文件几 KB，适合 iPad PWA 离线加载。
 * 字体：站酷庆科黄油体 / 站酷快乐体 / 马善政楷书（均 SIL OFL 1.1，可商用）。
 */
import fs from 'node:fs';
import path from 'node:path';

const TEXT = '火箭号指挥官星际发射';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const OUT = path.resolve('public/fonts');
fs.mkdirSync(OUT, { recursive: true });

const FONTS = [
  { fam: 'ZCOOL+QingKe+HuangYou', out: 'zcool-qingke-huangyou-400', dir: 'zcoolqingkehuangyou' },
  { fam: 'ZCOOL+KuaiLe',          out: 'zcool-kuaile-400',          dir: 'zcoolkuaile' },
  { fam: 'Ma+Shan+Zheng',         out: 'ma-shan-zheng-400',         dir: 'mashanzheng' },
];

for (const f of FONTS) {
  const cssUrl = `https://fonts.googleapis.com/css2?family=${f.fam}&text=${encodeURIComponent(TEXT)}`;
  const css = await (await fetch(cssUrl, { headers: { 'User-Agent': UA } })).text();
  const m = css.match(/url\((https:\/\/[^)]+)\)\s*format\('woff2'\)/);
  if (!m) { console.error('FAIL css', f.fam, css.slice(0, 200)); process.exitCode = 1; continue; }
  const buf = Buffer.from(await (await fetch(m[1])).arrayBuffer());
  fs.writeFileSync(path.join(OUT, `${f.out}.woff2`), buf);
  const lic = await (await fetch(`https://raw.githubusercontent.com/google/fonts/main/ofl/${f.dir}/OFL.txt`)).text();
  fs.writeFileSync(path.join(OUT, `${f.out}-OFL.txt`), lic);
  console.log(`✓ ${f.out}.woff2  ${(buf.length / 1024).toFixed(1)}KB`);
}
