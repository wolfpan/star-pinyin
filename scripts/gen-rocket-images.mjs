/**
 * gen-rocket-images.mjs — wan2.7-image 生成火箭绿幕图 + 无火箭真实发射背景。
 * 绿幕图后续由 chroma-key 脚本抠成透明 PNG（public/images/rockets/{id}.png）。
 * 用法：node scripts/gen-rocket-images.mjs [--force] [--only id1,id2]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const RDIR = path.join(ROOT, 'public', 'images', 'rockets');
const LDIR = path.join(ROOT, 'public', 'images', 'launch');
fs.mkdirSync(RDIR, { recursive: true }); fs.mkdirSync(LDIR, { recursive: true });
const args = process.argv.slice(2);
const FORCE = args.includes('--force');
const oi = args.indexOf('--only'); const ONLY = oi >= 0 ? new Set(args[oi + 1].split(',')) : null;
const URL = 'https://token-plan.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';
const cred = fs.readFileSync(path.join(process.env.DSH_HOME || 'C:\\Users\\panft\\.dsh', '.credentials.yaml'), 'utf8');
const KEY = (cred.match(/QWEN_TOKEN_PLAN_CN_API_KEY:\s*(\S+)/) || [])[1];
if (!KEY) { console.error('无 Key'); process.exit(1); }
const G = '，纯绿色背景(#00FF00)，无阴影无地面，竖立居中，柔和灯光，写实3D渲染，无文字无标志';
const PROMPTS = {
  saturn_v: '一枚巨大的三级登月运载火箭，白色箭体带黑色环形滚转条纹与黑色方块标记，竖立' + G,
  long_march_1: '一枚细长的白色三级早期运载火箭，箭体简洁带红色装饰条，竖立' + G,
  long_march_2f: '一枚白色载人运载火箭，顶部尖尖的逃逸塔，捆绑四个助推器，竖立' + G,
  atlas_v: '一枚白色细长运载火箭，底部黑色发动机舱，捆绑两枚白色固体助推器，竖立' + G,
  delta_iv_heavy: '三枚橙色液氢核心并排组成的重型运载火箭，竖立' + G,
  falcon_9: '一枚修长的白色两级运载火箭，底部展开四条着陆支腿与栅格翼，竖立' + G,
  long_march_5: '一枚粗壮的白色重型运载火箭，捆绑四个白色助推器，蓝色装饰条纹，竖立' + G,
  falcon_heavy: '三枚白色猎鹰核心并排组成的可回收重型火箭，竖立' + G,
  sls: '一枚橙色核心加两枚白色固体助推器的登月重型火箭，顶部白色上面级，竖立' + G,
  starship: '一枚不锈钢银色巨型超重型火箭，腹部黑色隔热瓦，上部飞船带小翼，竖立' + G,
  vulcan: '一枚白色两级重型运载火箭，底部两台蓝色甲烷发动机舱，捆绑两枚白色固体助推器，竖立' + G,
  ariane_6: '一枚白色欧洲重型运载火箭，芯级底部一台发动机，捆绑两枚大型白色固体助推器，竖立' + G,
  new_glenn: '一枚粗壮的白色两级可回收重型火箭，直径很大，底部七台发动机舱与着陆支腿，竖立' + G,
  zhuque_3: '一枚不锈钢银色可回收两级运载火箭，箭体金属光泽带蓝色装饰条，底部着陆支腿与栅格翼，竖立' + G,
  falcon_21: '一枚极其修长的白色未来概念超重型运载火箭，底部密集排列大量发动机喷管，黑色栅格翼与着陆支腿，深灰色装饰条，竖立' + G,
  starship_9: '一枚巨大的不锈钢银色未来概念超重型火箭，箭体极高极粗，腹部黑色隔热瓦，顶部飞船带大型翼面，底部密集发动机喷管，金属光泽，竖立' + G,
};
const badges = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'badges.json'), 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function gen(prompt, size) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 150000);
  try {
    const res = await fetch(URL, { method: 'POST', signal: ctrl.signal, headers: { 'Authorization': 'Bearer ' + KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'wan2.7-image', input: { messages: [{ role: 'user', content: [{ text: prompt }] }] }, parameters: { size, n: 1, watermark: false } }) });
    const j = await res.json();
    if (!res.ok) throw new Error(j.code + ': ' + (j.message || '').slice(0, 80));
    const u = j.output?.choices?.[0]?.message?.content?.find((c) => c.image)?.image;
    if (!u) throw new Error('无 image');
    const a = await fetch(u, { signal: ctrl.signal }); if (!a.ok) throw new Error('下载 ' + a.status);
    return Buffer.from(await a.arrayBuffer());
  } finally { clearTimeout(t); }
}
let ok = 0, skip = 0, fail = 0; const failures = [];
for (const b of badges) {
  if (ONLY && !ONLY.has(b.id)) continue;
  const raw = path.join(RDIR, '_raw_' + b.id + '.png');
  const fin = path.join(RDIR, b.id + '.png');
  if (!FORCE && fs.existsSync(fin) && fs.statSync(fin).size > 3000) { skip++; console.log('跳过', b.id); continue; }
  let done = false;
  for (let att = 1; att <= 2 && !done; att++) {
    try { const buf = await gen(PROMPTS[b.id], '1024*1024'); fs.writeFileSync(raw, buf); ok++; done = true; console.log('✓', b.id, (buf.length / 1024).toFixed(0) + 'KB'); }
    catch (e) { if (att === 2) { fail++; failures.push([b.id, e.message]); console.log('✗', b.id, e.message); } else await sleep(1500); }
  }
  await sleep(400);
}
// 无火箭真实发射背景
if (!ONLY || ONLY.has('bg')) {
  const bgRaw = path.join(LDIR, '_raw_bg.png');
  if (FORCE || !fs.existsSync(path.join(LDIR, 'bg.png'))) {
    try { const buf = await gen('真实航天发射场照片风格，竖构图，画面下方混凝土发射台与导流槽冒出白色蒸汽，左侧金属发射塔架，上方晴朗蓝天少量白云，空荡荡的发射台没有任何火箭没有飞行器，电影级写实高细节', '1024*1536'); fs.writeFileSync(bgRaw, buf); console.log('✓ bg', (buf.length / 1024).toFixed(0) + 'KB'); }
    catch (e) { fail++; failures.push(['bg', e.message]); console.log('✗ bg', e.message); }
  } else { skip++; console.log('跳过 bg'); }
}
console.log(`完成 新生成${ok} 跳过${skip} 失败${fail}`);
if (failures.length) { console.error(failures); process.exit(1); }
