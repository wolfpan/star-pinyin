/**
 * gen-ui-icons.mjs — wan2.7-image 生成三套可切换图标风格（家长后台可选，镜像皮肤系统）。
 * 每套 32 枚：18 UI + 14 目的地星球。统一用「品红绿幕(#FF00FF)」抠透明，
 * 避免绿色主体（乌龟/对勾/地球大陆）被绿幕误抠。
 * 输出：public/images/icons/{style}/{name}.png 与 {style}/dest/{id}.png
 * 风格：a=写实航天渲染 · b=扁平几何仪表 · c=复古丝网海报
 * 用法：node scripts/gen-ui-icons.mjs [--force] [--style a,b,c] [--only name1,name2]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const IDIR = path.join(ROOT, 'public', 'images', 'icons');
const args = process.argv.slice(2);
const FORCE = args.includes('--force');
const si = args.indexOf('--style'); const STYLES_SEL = si >= 0 ? args[si + 1].split(',') : ['a', 'b', 'c'];
const oi = args.indexOf('--only'); const ONLY = oi >= 0 ? new Set(args[oi + 1].split(',')) : null;
const URL = 'https://token-plan.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';
const cred = fs.readFileSync(path.join(process.env.DSH_HOME || 'C:\\Users\\panft\\.dsh', '.credentials.yaml'), 'utf8');
const KEY = (cred.match(/QWEN_TOKEN_PLAN_CN_API_KEY:\s*(\S+)/) || [])[1];
if (!KEY) { console.error('无 Key'); process.exit(1); }

const MAG = '，主体居中占满画面，纯品红背景(#FF00FF)，无阴影无地面，无文字无标志';
/* 中性主体描述（不含风格词），风格由后缀注入。 */
const UI = {
  astronaut: '宇航员半身像，白色宇航服，面罩反射星空',
  rocket: '一枚小火箭向右上方45度飞行，白色箭体红色鼻锥与尾翼蓝色舷窗，尾部橙色火焰',
  museum: '太空博物馆建筑，白色柱廊与蓝色玻璃天文穹顶，门前台阶',
  book: '摊开的精装书，蓝色封面米白书页微微翘起',
  radio: '复古橙色收音机，顶部银色天线，正面圆形喇叭格栅与两个旋钮',
  turtle: '绿色小乌龟，龟壳带六边形花纹，探头微笑',
  spark: '金黄色立体闪电符号',
  lock: '银灰色金属挂锁，锁梁闭合，锁体带钥匙孔',
  medal: '金色圆形奖牌，中央浮雕五角星，上方红色V形绶带',
  party: '金色礼花筒斜向上喷出五彩纸屑与彩带',
  eyes: '一双友善的大眼睛，蓝色虹膜长睫毛',
  pencil: '黄色铅笔笔尖朝下斜立，画出一条蓝色上扬弧线',
  check: '不透明实心圆形徽章，圆盘整体纯绿色(#00C853)，中央白色粗对勾',
  cross: '不透明实心圆形徽章，圆盘整体纯红色(#E53935)，中央白色粗叉号',
  satellite: '人造卫星，金色方形主体两侧蓝色太阳能板顶部白色抛物面天线',
  warning: '黄色圆角三角形警告标志，中央黑色粗感叹号',
  beacon: '橙色圆形警示灯，半球形灯罩发光银色底座',
  search: '放大镜，蓝色手柄银色镜框镜片透亮',
};
const DEST = {
  earth_low: '地球特写占据整个画面，蓝色海洋绿色大陆白色气旋云带',
  earth_high: '蓝色地球居中，外围一条明亮浅蓝色圆形轨道环，环上一颗银色小卫星',
  earth_far: '较小的蓝色地球居中，外围一条很大的淡金色椭圆轨道环，环上一颗银色卫星',
  moon: '灰白色月球，表面布满环形山与暗色月海',
  venus: '金黄色金星，浓厚奶油色漩涡状硫酸云纹理',
  mars: '铁锈红色火星，白色北极极冠与暗色峡谷纹理',
  mercury: '灰褐色水星，表面密布陨石坑',
  jupiter: '木星，橙白棕相间横向条纹云带，南半球大红斑风暴',
  saturn: '土星，淡金色球体与倾斜冰粒光环，光环中有卡西尼缝',
  uranus: '天王星，淡青色光滑冰巨星，一条细窄倾斜光环',
  neptune: '海王星，深蓝色大气，暗色大风暴斑与白色云带',
  pluto: '冥王星，棕褐色矮行星，表面一片明亮爱心形氮冰平原',
  oort: '彗星，蓝白色冰核拖着长长蓝白渐变彗尾，周围细小冰晶',
  interstellar: '一簇闪烁星光，中央一颗明亮金色四角星，周围蓝色与白色小星星',
};
const STYLES = {
  a: {
    ui: '，微缩实物模型质感，电影级写实3D渲染，金属与玻璃真实材质，柔和影棚光，无卡通表情' + MAG,
    dest: '，写实行星3D渲染，柔和太空光照，球体居中占满画面' + MAG,
  },
  b: {
    ui: '，现代扁平矢量插画，简洁几何形，细腻渐变，冰蓝/银白/琥珀橙配色，细线仪表刻度点缀，无立体高光' + MAG,
    dest: '，现代扁平矢量插画，简洁几何正圆与椭圆光环，细腻渐变，保留星球天然色彩，细线轨道刻度点缀，无立体高光' + MAG,
  },
  c: {
    ui: '，1960年代NASA旅行海报丝网印刷风格，颗粒质感，限定复古配色(奶油白/航天橙/湖蓝/深海军蓝)，大胆色块简洁轮廓，主体独立无海报边框无矩形背景' + MAG,
    dest: '，1960年代NASA旅行海报丝网印刷风格，颗粒质感，复古配色但保留星球辨识特征，大胆色块，只画球体与光环本身，绝对不要矩形边框/画框/海报边/方形背景，主体独立抠出' + MAG,
  },
};

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

const tasks = [];
for (const s of STYLES_SEL) {
  const cfg = STYLES[s]; if (!cfg) continue;
  const udir = path.join(IDIR, s); const ddir = path.join(udir, 'dest');
  fs.mkdirSync(udir, { recursive: true }); fs.mkdirSync(ddir, { recursive: true });
  for (const [name, subj] of Object.entries(UI)) tasks.push({ dir: udir, name, prompt: subj + cfg.ui, tag: s + '/' + name });
  for (const [name, subj] of Object.entries(DEST)) tasks.push({ dir: ddir, name, prompt: subj + cfg.dest, tag: s + '/dest/' + name });
}
let ok = 0, skip = 0, fail = 0; const failures = [];
let idx = 0;
async function worker() {
  while (idx < tasks.length) {
    const t = tasks[idx++];
    if (ONLY && !ONLY.has(t.name)) continue;
    const raw = path.join(t.dir, '_raw_' + t.name + '.png');
    const fin = path.join(t.dir, t.name + '.png');
    if (!FORCE && fs.existsSync(fin) && fs.statSync(fin).size > 2000) { skip++; continue; }
    let done = false;
    for (let att = 1; att <= 2 && !done; att++) {
      try { const buf = await gen(t.prompt, '1024*1024'); fs.writeFileSync(raw, buf); ok++; done = true; console.log('✓', t.tag, (buf.length / 1024).toFixed(0) + 'KB'); }
      catch (e) { if (att === 2) { fail++; failures.push([t.tag, e.message]); console.log('✗', t.tag, e.message); } else await sleep(1500); }
    }
    await sleep(300);
  }
}
await Promise.all([worker(), worker(), worker()]);
console.log(`完成 新生成${ok} 跳过${skip} 失败${fail}`);
if (failures.length) { console.error(failures); process.exit(1); }
