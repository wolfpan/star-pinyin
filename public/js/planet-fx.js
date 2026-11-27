/**
 * planet-fx.js — 程序化星球 Canvas 渲染器（零图片素材，浏览器端）
 * ------------------------------------------------------------------
 * 设计要点：
 *  - 所有星球由代码绘制：径向渐变球体 + 种子随机表面特征 + 昼夜明暗 + 大气辉光。
 *  - 特征用「经纬度 → 球面投影」定位，随时间经度偏移实现自转；背面特征自动剔除，
 *    靠近 limb（边缘）的特征水平压缩，产生真实球面感。
 *  - 种子随机（mulberry32）保证每颗星球特征稳定可复现；特征表按 id 懒加载缓存。
 *  - 逐帧不使用 shadowBlur；辉光用 'lighter' 叠加，保 60fps。
 *
 * 已实现全部目的地：earth（低空/高空/远地三层轨道视角）/ moon / venus / mars / mercury /
 * jupiter / saturn / uranus / neptune / pluto / oort（奥尔特云为场景式绘制，无球体）。
 * 星球元数据（名称 / 等级 / 百科）由别处管理，本模块只负责绘制。
 * 同一渲染器复用于：发射巡航段、博物馆星球图鉴缩略图、机库等级按钮小图标。
 */

const TAU = Math.PI * 2;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/** 确定性伪随机（同一 seed 永远同一序列）。 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 经纬度 → 屏幕投影；返回 null 表示在背面不可见。rot 为当前自转经度偏移。 */
function project(cx, cy, r, lon, lat, rot) {
  const L = lon + rot;
  const cosL = Math.cos(L);
  if (cosL <= 0.03) return null;
  return {
    x: cx + r * Math.cos(lat) * Math.sin(L),
    y: cy - r * Math.sin(lat),
    squash: cosL,          // 水平压缩（球面 foreshortening）
    depth: cosL,           // 可见度（越靠边缘越淡）
  };
}

/** 球体底色（高光偏左上）。 */
function baseSphere(ctx, cx, cy, r, cLight, cMid, cDark) {
  const g = ctx.createRadialGradient(cx - r * 0.42, cy - r * 0.42, r * 0.08, cx, cy, r * 1.02);
  g.addColorStop(0, cLight);
  g.addColorStop(0.55, cMid);
  g.addColorStop(1, cDark);
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, TAU); ctx.fill();
}

/** 昼夜明暗：光来自左上，右下渐暗。strength 0..1。 */
function terminator(ctx, cx, cy, r, strength) {
  ctx.save();
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, TAU); ctx.clip();
  const g = ctx.createLinearGradient(cx - r * 0.9, cy - r * 0.9, cx + r * 0.95, cy + r * 0.95);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(0.5, 'rgba(0,0,0,0)');
  g.addColorStop(0.78, `rgba(3,5,12,${strength * 0.5})`);
  g.addColorStop(1, `rgba(2,3,8,${strength})`);
  ctx.fillStyle = g;
  ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
  ctx.restore();
}

/** 大气辉光（叠加混合），limb 外一圈柔光。 */
function atmosphere(ctx, cx, cy, r, color, intensity) {
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const g = ctx.createRadialGradient(cx, cy, r * 0.9, cx, cy, r * 1.28);
  g.addColorStop(0, `rgba(${color},0)`);
  g.addColorStop(0.42, `rgba(${color},${0.32 * intensity})`);
  g.addColorStop(0.62, `rgba(${color},${0.12 * intensity})`);
  g.addColorStop(1, `rgba(${color},0)`);
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(cx, cy, r * 1.28, 0, TAU); ctx.fill();
  ctx.restore();
}

/** 横向正弦扰动纬度带（条带类行星共用；随 rot 漂移）。b.fill 为带色。 */
function drawBand(ctx, cx, cy, r, b, rot) {
  const yBase = cy - r * Math.sin(b.lat);
  const half = r * b.w;
  ctx.fillStyle = b.fill;
  ctx.beginPath();
  const steps = 40;
  // 上缘
  for (let i = 0; i <= steps; i++) {
    const x = cx - r + (2 * r * i) / steps;
    const nx = (x - cx) / r;
    const wave = Math.sin(nx * 3.1 + b.phase + rot * 1.6) * r * b.amp
      + Math.sin(nx * 6.7 + b.phase * 1.7 + rot * 2.3) * r * b.amp * 0.4;
    const y = yBase - half + wave;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  // 下缘（反向）
  for (let i = steps; i >= 0; i--) {
    const x = cx - r + (2 * r * i) / steps;
    const nx = (x - cx) / r;
    const wave = Math.sin(nx * 3.1 + b.phase + rot * 1.6 + 0.6) * r * b.amp
      + Math.sin(nx * 6.7 + b.phase * 1.7 + rot * 2.3) * r * b.amp * 0.4;
    const y = yBase + half + wave;
    ctx.lineTo(x, y);
  }
  ctx.closePath(); ctx.fill();
}

/* ----------------------------- 特征表（懒加载缓存） ----------------------------- */
const featureCache = new Map();

function moonFeatures() {
  const rnd = mulberry32(20240401);
  // 月海（暗色大斑块）
  const maria = [
    { lon: -0.5, lat: 0.45, s: 0.34 }, { lon: 0.25, lat: 0.62, s: 0.26 },
    { lon: 0.55, lat: 0.18, s: 0.30 }, { lon: -0.15, lat: -0.1, s: 0.22 },
    { lon: 0.9, lat: -0.35, s: 0.2 }, { lon: -0.85, lat: 0.05, s: 0.18 },
  ];
  // 陨石坑
  const craters = [];
  for (let i = 0; i < 46; i++) {
    craters.push({
      lon: (rnd() * 2 - 1) * Math.PI,
      lat: (rnd() * 2 - 1) * 1.25,
      s: 0.03 + rnd() * 0.075,
      bright: 0.4 + rnd() * 0.5,
    });
  }
  return { maria, craters };
}

function venusFeatures() {
  const rnd = mulberry32(20240502);
  // 硫酸云涡旋带（纬度带 + 相位扰动）
  const bands = [];
  for (let i = 0; i < 9; i++) {
    bands.push({
      lat: -1.15 + i * 0.29 + (rnd() - 0.5) * 0.06,
      w: 0.1 + rnd() * 0.1,
      phase: rnd() * TAU,
      amp: 0.05 + rnd() * 0.09,
      tone: rnd(),
    });
  }
  return { bands };
}

function earthFeatures() {
  const rnd = mulberry32(20240603);
  // 陆块：每块大陆 = 主斑块 + 若干子斑块（绿 / 棕绿）
  const tones = ['74,124,66', '88,134,72', '112,126,70', '96,116,64'];
  const lands = [];
  for (let i = 0; i < 6; i++) {
    const s = 0.19 + rnd() * 0.16;
    const blobs = [{ dl: 0, dt: 0, k: 1 }];
    const n = 2 + ((rnd() * 2) | 0);
    for (let j = 0; j < n; j++) {
      blobs.push({
        dl: (rnd() - 0.5) * s * 2.6,
        dt: (rnd() - 0.5) * s * 1.7,
        k: 0.45 + rnd() * 0.5,
      });
    }
    lands.push({
      // 经度分层散布：任意自转相位都有陆块朝向观察者
      lon: -Math.PI + (i + 0.15 + rnd() * 0.7) * (TAU / 6),
      lat: (rnd() * 2 - 1) * 1.05,
      s,
      tone: tones[(rnd() * tones.length) | 0],
      blobs,
    });
  }
  // 白色云涡旋
  const clouds = [];
  for (let i = 0; i < 9; i++) {
    clouds.push({
      lon: -Math.PI + (i + rnd()) * (TAU / 9),
      lat: (rnd() * 2 - 1) * 1.15,
      s: 0.09 + rnd() * 0.14,
      stretch: 1.7 + rnd() * 1.6,
      swirl: rnd() > 0.45,
      phase: rnd() * TAU,
    });
  }
  return { lands, clouds };
}

function marsFeatures() {
  const rnd = mulberry32(20240704);
  // 暗色高原斑块
  const plateaus = [];
  for (let i = 0; i < 8; i++) {
    plateaus.push({
      lon: -Math.PI + (i + rnd()) * (TAU / 8),
      lat: (rnd() * 2 - 1) * 1.0,
      s: 0.14 + rnd() * 0.2,
    });
  }
  return { plateaus };
}

function mercuryFeatures() {
  const rnd = mulberry32(20240805);
  // 陨石坑：比月球更密更小
  const craters = [];
  for (let i = 0; i < 60; i++) {
    craters.push({
      lon: (rnd() * 2 - 1) * Math.PI,
      lat: (rnd() * 2 - 1) * 1.3,
      s: 0.02 + rnd() * 0.05,
      bright: 0.35 + rnd() * 0.45,
    });
  }
  return { craters };
}

function jupiterFeatures() {
  const rnd = mulberry32(20240906);
  // 横向湍流条带：奶白 / 棕褐 / 铁锈交替
  const palette = [
    'rgba(240,228,202,0.85)',
    'rgba(198,152,106,0.8)',
    'rgba(180,108,72,0.78)',
    'rgba(228,208,172,0.82)',
  ];
  const bands = [];
  for (let i = 0; i < 11; i++) {
    bands.push({
      lat: -1.28 + i * 0.256 + (rnd() - 0.5) * 0.05,
      w: 0.08 + rnd() * 0.07,
      phase: rnd() * TAU,
      amp: 0.04 + rnd() * 0.06,
      fill: palette[i % palette.length],
    });
  }
  // 大红斑（南纬）
  const spot = { lon: 0.5, lat: -0.42, s: 0.24 };
  // 伽利略卫星：左右边缘小点（小幅摆动，不会凌日到球面上）
  const moons = [];
  for (let i = 0; i < 4; i++) {
    moons.push({
      side: i % 2 ? Math.PI : 0,
      off: (rnd() - 0.5) * 0.8,
      phase: rnd() * TAU,
      dist: 1.3 + rnd() * 0.42,
      s: 0.032 + rnd() * 0.02,
      tone: ['210,205,195', '228,210,170', '190,185,175', '215,220,225'][i],
    });
  }
  return { bands, spot, moons };
}

function saturnFeatures() {
  const rnd = mulberry32(20241007);
  // 淡金横向条带（扰动比木星更弱）
  const palette = [
    'rgba(236,218,170,0.7)',
    'rgba(208,182,132,0.6)',
    'rgba(242,228,188,0.65)',
  ];
  const bands = [];
  for (let i = 0; i < 7; i++) {
    bands.push({
      lat: -1.15 + i * 0.38 + (rnd() - 0.5) * 0.06,
      w: 0.12 + rnd() * 0.09,
      phase: rnd() * TAU,
      amp: 0.025 + rnd() * 0.035,
      fill: palette[i % palette.length],
    });
  }
  return { bands };
}

function uranusFeatures() {
  const rnd = mulberry32(20241108);
  // 极淡条带（近乎无特征）
  const bands = [];
  for (let i = 0; i < 3; i++) {
    bands.push({
      lat: -0.7 + i * 0.7 + (rnd() - 0.5) * 0.1,
      w: 0.16 + rnd() * 0.1,
      phase: rnd() * TAU,
      amp: 0.02 + rnd() * 0.02,
      fill: 'rgba(214,242,246,0.16)',
    });
  }
  return { bands };
}

function neptuneFeatures() {
  const rnd = mulberry32(20241209);
  // 深蓝条带（较弱）
  const bands = [];
  for (let i = 0; i < 4; i++) {
    bands.push({
      lat: -0.95 + i * 0.62 + (rnd() - 0.5) * 0.08,
      w: 0.12 + rnd() * 0.09,
      phase: rnd() * TAU,
      amp: 0.035 + rnd() * 0.04,
      fill: i % 2 ? 'rgba(120,162,240,0.32)' : 'rgba(22,38,108,0.38)',
    });
  }
  // 大暗斑
  const spot = { lon: 0.3, lat: -0.28, s: 0.2 };
  // 白色卷云细条
  const cirrus = [];
  for (let i = 0; i < 5; i++) {
    cirrus.push({
      lon: -Math.PI + (i + rnd()) * (TAU / 5),
      lat: (rnd() * 2 - 1) * 0.9,
      s: 0.05 + rnd() * 0.06,
      stretch: 2.6 + rnd() * 1.4,
    });
  }
  return { bands, spot, cirrus };
}

function plutoFeatures() {
  const rnd = mulberry32(20250110);
  // 暗色斑块（避开汤博区中心经度）
  const patches = [];
  for (let i = 0; i < 5; i++) {
    patches.push({
      lon: -Math.PI + (i + rnd()) * (TAU / 5),
      lat: (rnd() * 2 - 1) * 1.0,
      s: 0.12 + rnd() * 0.16,
    });
  }
  // 明亮「爱心」汤博区
  const heart = { lon: 0.15, lat: 0.02, s: 0.62 };
  return { patches, heart };
}

function oortFeatures() {
  const rnd = mulberry32(20250211);
  // 冰质小天体：极坐标散布（短条 / 小点）
  const bodies = [];
  for (let i = 0; i < 74; i++) {
    bodies.push({
      ang: rnd() * TAU,
      dist: 0.16 + rnd() * 0.98,
      s: 0.008 + rnd() * 0.02,
      dash: rnd() > 0.62,
      a: 0.3 + rnd() * 0.5,
      drift: 0.12 + rnd() * 0.3,
    });
  }
  // 更密的远星野（球外区域）
  const farStars = [];
  for (let i = 0; i < 40; i++) {
    farStars.push({
      ang: rnd() * TAU,
      dist: 1.06 + rnd() * 0.5,
      s: 0.004 + rnd() * 0.008,
      a: 0.18 + rnd() * 0.35,
    });
  }
  return { bodies, farStars };
}

/** 星际空间：极密星野 + 银河带 + 极暗远日（无冰质天体，已飞出奥尔特云）。 */
function interstellarFeatures() {
  const rnd = mulberry32(20260114);
  const stars = [];
  for (let i = 0; i < 150; i++) {
    stars.push({ ang: rnd() * TAU, dist: 0.1 + rnd() * 1.5, s: 0.004 + rnd() * 0.012, a: 0.25 + rnd() * 0.7 });
  }
  const band = [];
  for (let i = 0; i < 60; i++) {
    band.push({ u: rnd(), v: (rnd() - 0.5) * 0.3, s: 0.003 + rnd() * 0.008, a: 0.1 + rnd() * 0.3 });
  }
  return { stars, band };
}

const FEATURE_BUILDERS = {
  interstellar: interstellarFeatures,
  moon: moonFeatures,
  venus: venusFeatures,
  earth: earthFeatures,
  mars: marsFeatures,
  mercury: mercuryFeatures,
  jupiter: jupiterFeatures,
  saturn: saturnFeatures,
  uranus: uranusFeatures,
  neptune: neptuneFeatures,
  pluto: plutoFeatures,
  oort: oortFeatures,
};

function featuresFor(id) {
  if (featureCache.has(id)) return featureCache.get(id);
  const build = FEATURE_BUILDERS[id];
  const f = build ? build() : {};
  featureCache.set(id, f);
  return f;
}

/* ----------------------------- 月球 ----------------------------- */
function drawMoon(ctx, cx, cy, r, rot) {
  const { maria, craters } = featuresFor('moon');
  baseSphere(ctx, cx, cy, r, '#d9d9d2', '#a9a9a2', '#5c5c58');

  ctx.save();
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, TAU); ctx.clip();

  // 月海
  for (const m of maria) {
    const p = project(cx, cy, r, m.lon, m.lat, rot);
    if (!p) continue;
    const rad = r * m.s;
    const g = ctx.createRadialGradient(p.x, p.y, rad * 0.1, p.x, p.y, rad);
    g.addColorStop(0, `rgba(96,96,104,${0.55 * p.depth})`);
    g.addColorStop(0.7, `rgba(104,104,112,${0.32 * p.depth})`);
    g.addColorStop(1, 'rgba(104,104,112,0)');
    ctx.fillStyle = g;
    ctx.save();
    ctx.translate(p.x, p.y); ctx.scale(Math.max(0.2, p.squash), 1);
    ctx.beginPath(); ctx.arc(0, 0, rad, 0, TAU); ctx.fill();
    ctx.restore();
  }

  // 陨石坑：暗底 + 亮环（受光侧）
  for (const c of craters) {
    const p = project(cx, cy, r, c.lon, c.lat, rot);
    if (!p) continue;
    const rad = r * c.s;
    const sq = Math.max(0.18, p.squash);
    ctx.save();
    ctx.translate(p.x, p.y); ctx.scale(sq, 1);
    // 坑底
    ctx.fillStyle = `rgba(70,70,68,${0.5 * p.depth})`;
    ctx.beginPath(); ctx.arc(0, 0, rad, 0, TAU); ctx.fill();
    // 环形山亮边（左上受光）
    ctx.strokeStyle = `rgba(235,235,228,${c.bright * p.depth})`;
    ctx.lineWidth = Math.max(0.6, rad * 0.22);
    ctx.beginPath(); ctx.arc(0, 0, rad * 0.92, Math.PI * 0.85, Math.PI * 1.95); ctx.stroke();
    // 坑内阴影（右下）
    ctx.strokeStyle = `rgba(40,40,40,${0.4 * p.depth})`;
    ctx.lineWidth = Math.max(0.5, rad * 0.18);
    ctx.beginPath(); ctx.arc(0, 0, rad * 0.8, Math.PI * 1.95, Math.PI * 2.85); ctx.stroke();
    ctx.restore();
  }
  ctx.restore();

  terminator(ctx, cx, cy, r, 0.82);
  // 月球几乎无大气，仅极淡冷光
  atmosphere(ctx, cx, cy, r, '200,210,230', 0.18);
}

/* ----------------------------- 金星 ----------------------------- */
function drawVenus(ctx, cx, cy, r, rot) {
  const { bands } = featuresFor('venus');
  baseSphere(ctx, cx, cy, r, '#f6e7c4', '#e3c489', '#a9793f');

  ctx.save();
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, TAU); ctx.clip();

  // 涡旋云带：沿纬度起伏的横向带，随自转漂移
  for (const b of bands) {
    const yBase = cy - r * Math.sin(b.lat);
    const half = r * b.w;
    const light = b.tone > 0.5;
    ctx.fillStyle = light ? 'rgba(250,240,214,0.5)' : 'rgba(196,158,98,0.42)';
    ctx.beginPath();
    const steps = 40;
    // 上缘
    for (let i = 0; i <= steps; i++) {
      const x = cx - r + (2 * r * i) / steps;
      const nx = (x - cx) / r;
      const wave = Math.sin(nx * 3.1 + b.phase + rot * 1.6) * r * b.amp
        + Math.sin(nx * 6.7 + b.phase * 1.7 + rot * 2.3) * r * b.amp * 0.4;
      const y = yBase - half + wave;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    // 下缘（反向）
    for (let i = steps; i >= 0; i--) {
      const x = cx - r + (2 * r * i) / steps;
      const nx = (x - cx) / r;
      const wave = Math.sin(nx * 3.1 + b.phase + rot * 1.6 + 0.6) * r * b.amp
        + Math.sin(nx * 6.7 + b.phase * 1.7 + rot * 2.3) * r * b.amp * 0.4;
      const y = yBase + half + wave;
      ctx.lineTo(x, y);
    }
    ctx.closePath(); ctx.fill();
  }

  // 高层云抹平：整体柔化（半透明奶白覆盖，弱化硬边）
  const haze = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.3, r * 0.1, cx, cy, r);
  haze.addColorStop(0, 'rgba(255,248,228,0.28)');
  haze.addColorStop(1, 'rgba(255,240,210,0.05)');
  ctx.fillStyle = haze;
  ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
  ctx.restore();

  // 浓大气 → 明暗过渡更柔
  terminator(ctx, cx, cy, r, 0.6);
  atmosphere(ctx, cx, cy, r, '255,224,160', 1.0);
}

/* ----------------------------- 地球 ----------------------------- */
function drawEarth(ctx, cx, cy, r, rot) {
  const { lands, clouds } = featuresFor('earth');
  baseSphere(ctx, cx, cy, r, '#7db8e8', '#2f6fc0', '#123a78');

  ctx.save();
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, TAU); ctx.clip();

  // 陆块（投影椭圆斑块，绿 / 棕绿）
  for (const land of lands) {
    for (const blob of land.blobs) {
      const p = project(cx, cy, r, land.lon + blob.dl, land.lat + blob.dt, rot);
      if (!p) continue;
      const rad = r * land.s * blob.k;
      ctx.save();
      ctx.translate(p.x, p.y); ctx.scale(Math.max(0.2, p.squash), 1);
      const g = ctx.createRadialGradient(0, 0, rad * 0.1, 0, 0, rad);
      g.addColorStop(0, `rgba(${land.tone},${0.95 * p.depth})`);
      g.addColorStop(0.72, `rgba(${land.tone},${0.82 * p.depth})`);
      g.addColorStop(1, `rgba(${land.tone},0)`);
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(0, 0, rad, 0, TAU); ctx.fill();
      ctx.restore();
    }
  }

  // 白色云涡旋（拉长软斑 + 部分涡旋弧）
  for (const c of clouds) {
    const p = project(cx, cy, r, c.lon, c.lat, rot);
    if (!p) continue;
    const rad = r * c.s;
    const sq = Math.max(0.2, p.squash);
    ctx.save();
    ctx.translate(p.x, p.y); ctx.scale(sq * c.stretch, 1);
    const g = ctx.createRadialGradient(0, 0, rad * 0.1, 0, 0, rad);
    g.addColorStop(0, `rgba(255,255,255,${0.62 * p.depth})`);
    g.addColorStop(0.7, `rgba(255,255,255,${0.34 * p.depth})`);
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(0, 0, rad, 0, TAU); ctx.fill();
    if (c.swirl) {
      ctx.strokeStyle = `rgba(255,255,255,${0.5 * p.depth})`;
      ctx.lineWidth = Math.max(0.6, rad * 0.16);
      ctx.beginPath(); ctx.arc(0, 0, rad * 0.62, c.phase, c.phase + 3.6); ctx.stroke();
    }
    ctx.restore();
  }
  ctx.restore();

  terminator(ctx, cx, cy, r, 0.62);
  // 明显蓝白大气辉光
  atmosphere(ctx, cx, cy, r, '150,200,255', 1.15);
}

/* ----------------------------- 地球三层轨道视角 ----------------------------- */
/** 轨道环（淡蓝椭圆，与巡航入轨环同画风）。 */
function orbitRing(ctx, cx, cy, rx, ry) {
  ctx.save();
  ctx.strokeStyle = 'rgba(120,220,255,0.45)';
  ctx.lineWidth = Math.max(1, ry * 0.006);
  ctx.beginPath(); ctx.ellipse(cx, cy, rx, ry, 0, 0, TAU); ctx.stroke();
  ctx.restore();
}

/**
 * 地球轨道场景（低空 / 高空 / 远地），在局部坐标 [0,w]×[0,h] 内绘制：
 *  - low  低空轨道：地球巨大，只露出下方弧线（临边大气辉光），卫星在弧线上方的近处；
 *  - high 高空轨道：大地球沉在画面下方，卫星沿大轨道环运行；
 *  - far  远地轨道：小地球 + 完整大轨道环，卫星在环顶，深空感最强。
 * 卫星本体由调用方绘制在 (w*0.5, h*0.27) 附近（环顶位置与之对齐）。
 * 复用于：发射入轨段（launch-fx）、博物馆星球图鉴缩略图、样板页。
 */
export function drawOrbitEarth(ctx, view, w, h, t = 0) {
  const cx = w * 0.5;
  if (view === 'high') {
    const cy = h * 1.12, r = h * 0.60;
    orbitRing(ctx, cx, cy, w * 0.42, h * 0.85);
    drawPlanet(ctx, 'earth', cx, cy, r, t);
  } else if (view === 'far') {
    const cy = h * 0.70, r = h * 0.13;
    orbitRing(ctx, cx, cy, w * 0.30, h * 0.46);
    drawPlanet(ctx, 'earth', cx, cy, r, t);
  } else { // low（默认）
    const r = h * 2.0;
    drawPlanet(ctx, 'earth', cx, h * 0.62 + r, r, t);
  }
}

/* ----------------------------- 火星 ----------------------------- */
function drawMars(ctx, cx, cy, r, rot) {
  const { plateaus } = featuresFor('mars');
  baseSphere(ctx, cx, cy, r, '#e08a5a', '#b45a38', '#6e2f1e');

  ctx.save();
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, TAU); ctx.clip();

  // 暗色高原
  for (const m of plateaus) {
    const p = project(cx, cy, r, m.lon, m.lat, rot);
    if (!p) continue;
    const rad = r * m.s;
    ctx.save();
    ctx.translate(p.x, p.y); ctx.scale(Math.max(0.2, p.squash), 1);
    const g = ctx.createRadialGradient(0, 0, rad * 0.1, 0, 0, rad);
    g.addColorStop(0, `rgba(110,48,30,${0.5 * p.depth})`);
    g.addColorStop(0.7, `rgba(120,56,36,${0.3 * p.depth})`);
    g.addColorStop(1, 'rgba(120,56,36,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(0, 0, rad, 0, TAU); ctx.fill();
    ctx.restore();
  }

  // 白色极冠（顶部 / 底部小帽，不随自转）
  for (const side of [-1, 1]) {
    const py = cy + side * r * 0.94;
    const rx = r * (side < 0 ? 0.38 : 0.3);
    const ry = r * 0.15;
    const g = ctx.createRadialGradient(cx, py, rx * 0.1, cx, py, rx);
    g.addColorStop(0, 'rgba(250,248,244,0.95)');
    g.addColorStop(0.75, 'rgba(245,242,236,0.75)');
    g.addColorStop(1, 'rgba(245,242,236,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.ellipse(cx, py, rx, ry, 0, 0, TAU); ctx.fill();
  }
  ctx.restore();

  terminator(ctx, cx, cy, r, 0.75);
  // 极稀薄淡橙大气
  atmosphere(ctx, cx, cy, r, '255,170,110', 0.22);
}

/* ----------------------------- 水星 ----------------------------- */
function drawMercury(ctx, cx, cy, r, rot) {
  const { craters } = featuresFor('mercury');
  baseSphere(ctx, cx, cy, r, '#b0a494', '#7d7264', '#443c34');

  ctx.save();
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, TAU); ctx.clip();

  // 密集小陨石坑：暗底 + 亮环（受光侧），与月球同构但更密更小
  for (const c of craters) {
    const p = project(cx, cy, r, c.lon, c.lat, rot);
    if (!p) continue;
    const rad = r * c.s;
    const sq = Math.max(0.18, p.squash);
    ctx.save();
    ctx.translate(p.x, p.y); ctx.scale(sq, 1);
    ctx.fillStyle = `rgba(58,52,46,${0.5 * p.depth})`;
    ctx.beginPath(); ctx.arc(0, 0, rad, 0, TAU); ctx.fill();
    ctx.strokeStyle = `rgba(226,218,204,${c.bright * p.depth})`;
    ctx.lineWidth = Math.max(0.5, rad * 0.22);
    ctx.beginPath(); ctx.arc(0, 0, rad * 0.92, Math.PI * 0.85, Math.PI * 1.95); ctx.stroke();
    ctx.strokeStyle = `rgba(34,30,26,${0.4 * p.depth})`;
    ctx.lineWidth = Math.max(0.4, rad * 0.18);
    ctx.beginPath(); ctx.arc(0, 0, rad * 0.8, Math.PI * 1.95, Math.PI * 2.85); ctx.stroke();
    ctx.restore();
  }
  ctx.restore();

  terminator(ctx, cx, cy, r, 0.85);
  // 水星无大气
}

/* ----------------------------- 木星 ----------------------------- */
function drawJupiter(ctx, cx, cy, r, rot) {
  const { bands, spot, moons } = featuresFor('jupiter');
  baseSphere(ctx, cx, cy, r, '#efe3c8', '#d8b98a', '#9a6b44');

  ctx.save();
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, TAU); ctx.clip();

  // 横向湍流条带
  for (const b of bands) drawBand(ctx, cx, cy, r, b, rot);

  // 大红斑（南纬椭圆涡旋）
  const p = project(cx, cy, r, spot.lon, spot.lat, rot);
  if (p) {
    const rad = r * spot.s;
    ctx.save();
    ctx.translate(p.x, p.y); ctx.scale(Math.max(0.2, p.squash), 1);
    const g = ctx.createRadialGradient(0, 0, rad * 0.1, 0, 0, rad);
    g.addColorStop(0, `rgba(206,92,56,${0.95 * p.depth})`);
    g.addColorStop(0.62, `rgba(188,80,50,${0.8 * p.depth})`);
    g.addColorStop(1, 'rgba(188,80,50,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.ellipse(0, 0, rad, rad * 0.62, 0, 0, TAU); ctx.fill();
    // 涡旋亮缘
    ctx.strokeStyle = `rgba(240,214,180,${0.5 * p.depth})`;
    ctx.lineWidth = Math.max(0.6, rad * 0.1);
    ctx.beginPath(); ctx.ellipse(0, 0, rad * 0.78, rad * 0.46, 0, Math.PI * 0.7, Math.PI * 1.9); ctx.stroke();
    ctx.restore();
  }
  ctx.restore();

  terminator(ctx, cx, cy, r, 0.6);
  atmosphere(ctx, cx, cy, r, '230,200,150', 0.3);

  // 伽利略卫星：边缘 4 颗小点（缓慢公转，不随表面自转）
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (const m of moons) {
    const a = m.side + m.off + Math.sin(rot * 0.6 + m.phase) * 0.16;
    const mx = cx + Math.cos(a) * r * m.dist;
    const my = cy + Math.sin(a) * r * m.dist * 0.42;
    const mr = Math.max(1, r * m.s);
    const g = ctx.createRadialGradient(mx, my, 0, mx, my, mr * 2.2);
    g.addColorStop(0, `rgba(${m.tone},0.95)`);
    g.addColorStop(0.45, `rgba(${m.tone},0.5)`);
    g.addColorStop(1, `rgba(${m.tone},0)`);
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(mx, my, mr * 2.2, 0, TAU); ctx.fill();
  }
  ctx.restore();
}

/* ----------------------------- 土星 ----------------------------- */
// 光环几何：倾角 + 纵向压缩；环带半径（r 的倍数），1.94–2.02 为卡西尼缝（留空）。
const SATURN_TILT = -0.32;
const SATURN_SQUASH = 0.34;
const SATURN_RINGS = [
  { r0: 1.24, r1: 1.52, fill: 'rgba(178,158,120,0.3)' },   // C 环（淡）
  { r0: 1.54, r1: 1.94, fill: 'rgba(228,208,162,0.62)' },  // B 环（亮）
  { r0: 2.02, r1: 2.26, fill: 'rgba(206,186,142,0.46)' },  // A 环
];

/** 画半个光环（a0..a1 为环平面局部角度）。环对称，不随自转变化。 */
function saturnRingHalf(ctx, cx, cy, r, a0, a1) {
  ctx.save();
  ctx.translate(cx, cy); ctx.rotate(SATURN_TILT); ctx.scale(1, SATURN_SQUASH);
  for (const g of SATURN_RINGS) {
    ctx.fillStyle = g.fill;
    ctx.beginPath();
    ctx.arc(0, 0, r * g.r1, a0, a1);
    ctx.arc(0, 0, r * g.r0, a1, a0, true);
    ctx.closePath(); ctx.fill();
  }
  ctx.restore();
}

function drawSaturn(ctx, cx, cy, r, rot) {
  const { bands } = featuresFor('saturn');

  // 1) 后半环（被球体遮挡的部分）
  saturnRingHalf(ctx, cx, cy, r, Math.PI, TAU);

  // 2) 球体 + 淡金条带
  baseSphere(ctx, cx, cy, r, '#f0e2ba', '#dcc290', '#a3824e');
  ctx.save();
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, TAU); ctx.clip();
  for (const b of bands) drawBand(ctx, cx, cy, r, b, rot);
  ctx.restore();
  terminator(ctx, cx, cy, r, 0.6);
  atmosphere(ctx, cx, cy, r, '232,212,164', 0.32);

  // 3) 前半环（遮挡球体）
  saturnRingHalf(ctx, cx, cy, r, 0, Math.PI);
}

/* ----------------------------- 天王星 ----------------------------- */
// 自转轴约 98° → 环几乎竖立（横向压缩的细环）。
const URANUS_TILT = 0.16;
const URANUS_SQUASH = 0.16;
const URANUS_RINGS = [
  { r0: 1.52, r1: 1.6, fill: 'rgba(190,226,234,0.4)' },
  { r0: 1.68, r1: 1.73, fill: 'rgba(170,210,220,0.3)' },
];

function uranusRingHalf(ctx, cx, cy, r, a0, a1) {
  ctx.save();
  ctx.translate(cx, cy); ctx.rotate(URANUS_TILT); ctx.scale(URANUS_SQUASH, 1);
  for (const g of URANUS_RINGS) {
    ctx.fillStyle = g.fill;
    ctx.beginPath();
    ctx.arc(0, 0, r * g.r1, a0, a1);
    ctx.arc(0, 0, r * g.r0, a1, a0, true);
    ctx.closePath(); ctx.fill();
  }
  ctx.restore();
}

function drawUranus(ctx, cx, cy, r, rot) {
  const { bands } = featuresFor('uranus');

  // 后半细环（右半，被球体遮挡）
  uranusRingHalf(ctx, cx, cy, r, -Math.PI / 2, Math.PI / 2);

  baseSphere(ctx, cx, cy, r, '#d8f2f4', '#9fd8de', '#5a98a6');
  ctx.save();
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, TAU); ctx.clip();
  for (const b of bands) drawBand(ctx, cx, cy, r, b, rot);
  ctx.restore();
  terminator(ctx, cx, cy, r, 0.55);
  atmosphere(ctx, cx, cy, r, '160,225,235', 0.5);

  // 前半细环（左半，遮挡球体）
  uranusRingHalf(ctx, cx, cy, r, Math.PI / 2, Math.PI * 1.5);
}

/* ----------------------------- 海王星 ----------------------------- */
function drawNeptune(ctx, cx, cy, r, rot) {
  const { bands, spot, cirrus } = featuresFor('neptune');
  baseSphere(ctx, cx, cy, r, '#5a86e8', '#3455c0', '#1a2a78');

  ctx.save();
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, TAU); ctx.clip();

  for (const b of bands) drawBand(ctx, cx, cy, r, b, rot);

  // 大暗斑
  const p = project(cx, cy, r, spot.lon, spot.lat, rot);
  if (p) {
    const rad = r * spot.s;
    ctx.save();
    ctx.translate(p.x, p.y); ctx.scale(Math.max(0.2, p.squash), 1);
    const g = ctx.createRadialGradient(0, 0, rad * 0.1, 0, 0, rad);
    g.addColorStop(0, `rgba(10,18,60,${0.85 * p.depth})`);
    g.addColorStop(0.7, `rgba(14,24,72,${0.6 * p.depth})`);
    g.addColorStop(1, 'rgba(14,24,72,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.ellipse(0, 0, rad, rad * 0.6, 0, 0, TAU); ctx.fill();
    ctx.restore();
  }

  // 白色卷云细条
  for (const c of cirrus) {
    const q = project(cx, cy, r, c.lon, c.lat, rot);
    if (!q) continue;
    const rad = r * c.s;
    ctx.save();
    ctx.translate(q.x, q.y); ctx.scale(Math.max(0.2, q.squash) * c.stretch, 1);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, rad);
    g.addColorStop(0, `rgba(245,250,255,${0.75 * q.depth})`);
    g.addColorStop(1, 'rgba(245,250,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.ellipse(0, 0, rad, rad * 0.3, 0, 0, TAU); ctx.fill();
    ctx.restore();
  }
  ctx.restore();

  terminator(ctx, cx, cy, r, 0.65);
  atmosphere(ctx, cx, cy, r, '90,140,255', 0.9);
}

/* ----------------------------- 冥王星 ----------------------------- */
function drawPluto(ctx, cx, cy, r, rot) {
  const { patches, heart } = featuresFor('pluto');
  baseSphere(ctx, cx, cy, r, '#d8b894', '#a9825e', '#5f4530');

  ctx.save();
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, TAU); ctx.clip();

  // 暗色斑块
  for (const m of patches) {
    const p = project(cx, cy, r, m.lon, m.lat, rot);
    if (!p) continue;
    const rad = r * m.s;
    ctx.save();
    ctx.translate(p.x, p.y); ctx.scale(Math.max(0.2, p.squash), 1);
    const g = ctx.createRadialGradient(0, 0, rad * 0.1, 0, 0, rad);
    g.addColorStop(0, `rgba(84,58,40,${0.55 * p.depth})`);
    g.addColorStop(0.7, `rgba(92,66,46,${0.32 * p.depth})`);
    g.addColorStop(1, 'rgba(92,66,46,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(0, 0, rad, 0, TAU); ctx.fill();
    ctx.restore();
  }

  // 明亮「爱心」汤博区：两个圆 + 三角拼心形，投影到球面
  const p = project(cx, cy, r, heart.lon, heart.lat, rot);
  if (p) {
    const s = r * heart.s;
    ctx.save();
    ctx.translate(p.x, p.y); ctx.scale(Math.max(0.2, p.squash), 1); ctx.rotate(-0.12);
    ctx.fillStyle = `rgba(240,230,210,${0.92 * p.depth})`;
    ctx.beginPath();
    ctx.arc(-s * 0.24, -s * 0.14, s * 0.27, 0, TAU);
    ctx.arc(s * 0.24, -s * 0.14, s * 0.27, 0, TAU);
    ctx.moveTo(-s * 0.48, -s * 0.04);
    ctx.lineTo(s * 0.48, -s * 0.04);
    ctx.lineTo(0, s * 0.46);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
  ctx.restore();

  terminator(ctx, cx, cy, r, 0.75);
  // 极淡大气
  atmosphere(ctx, cx, cy, r, '200,190,220', 0.2);
}

/* ----------------------------- 奥尔特云（场景式，无球体） ----------------------------- */
/** cx,cy 为场景中心，r 为尺度参考（非球体半径）。 */
function drawOort(ctx, cx, cy, r, rot) {
  const { bodies, farStars } = featuresFor('oort');

  // 远星野（比其它星球更密的星野感）
  for (const s of farStars) {
    const x = cx + Math.cos(s.ang) * r * s.dist;
    const y = cy + Math.sin(s.ang) * r * s.dist * 0.92;
    ctx.fillStyle = `rgba(225,232,245,${s.a})`;
    ctx.beginPath(); ctx.arc(x, y, Math.max(0.4, r * s.s), 0, TAU); ctx.fill();
  }

  // 暗淡很小的远日（左下角，弱光晕）
  const sx = cx - r * 0.82, sy = cy + r * 0.78;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const glow = ctx.createRadialGradient(sx, sy, 0, sx, sy, r * 0.3);
  glow.addColorStop(0, 'rgba(255,240,210,0.5)');
  glow.addColorStop(0.25, 'rgba(255,230,190,0.16)');
  glow.addColorStop(1, 'rgba(255,230,190,0)');
  ctx.fillStyle = glow;
  ctx.beginPath(); ctx.arc(sx, sy, r * 0.3, 0, TAU); ctx.fill();
  ctx.restore();
  ctx.fillStyle = 'rgba(255,246,224,0.9)';
  ctx.beginPath(); ctx.arc(sx, sy, Math.max(1, r * 0.05), 0, TAU); ctx.fill();

  // 冰质小天体：小灰白点 / 短条，随 rot 极慢漂移
  for (const b of bodies) {
    const a = b.ang + rot * b.drift;
    const x = cx + Math.cos(a) * r * b.dist;
    const y = cy + Math.sin(a) * r * b.dist * 0.92;
    const sz = Math.max(0.5, r * b.s);
    if (b.dash) {
      // 短条（切向）
      const ta = a + Math.PI / 2;
      const len = sz * 3.2;
      ctx.strokeStyle = `rgba(208,218,234,${b.a})`;
      ctx.lineWidth = Math.max(0.5, sz * 0.7);
      ctx.beginPath();
      ctx.moveTo(x - Math.cos(ta) * len, y - Math.sin(ta) * len);
      ctx.lineTo(x + Math.cos(ta) * len, y + Math.sin(ta) * len);
      ctx.stroke();
    } else {
      ctx.fillStyle = `rgba(214,224,238,${b.a})`;
      ctx.beginPath(); ctx.arc(x, y, sz, 0, TAU); ctx.fill();
    }
  }
}

/* ----------------------------- 星际空间（场景式，飞出太阳系） ----------------------------- */
/** cx,cy 为场景中心，r 为尺度参考。极密星野 + 银河带 + 极暗远日。 */
function drawInterstellar(ctx, cx, cy, r, rot) {
  const { stars, band } = featuresFor('interstellar');

  // 银河带（对角柔光带 + 带内密星）
  ctx.save();
  ctx.translate(cx, cy); ctx.rotate(-0.5);
  const g = ctx.createLinearGradient(0, -r * 0.5, 0, r * 0.5);
  g.addColorStop(0, 'rgba(180,200,255,0)');
  g.addColorStop(0.5, 'rgba(190,205,240,0.10)');
  g.addColorStop(1, 'rgba(180,200,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(-r * 1.6, -r * 0.5, r * 3.2, r * 1.0);
  ctx.restore();
  for (const b of band) {
    const bx = cx + (b.u - 0.5) * r * 3.0;
    const by = cy + (b.u - 0.5) * r * 3.0 * -0.55 + b.v * r;
    ctx.fillStyle = `rgba(210,220,245,${b.a})`;
    ctx.beginPath(); ctx.arc(bx, by, Math.max(0.3, r * b.s), 0, TAU); ctx.fill();
  }

  // 极密星野
  for (const s of stars) {
    const x = cx + Math.cos(s.ang) * r * s.dist;
    const y = cy + Math.sin(s.ang) * r * s.dist * 0.95;
    ctx.fillStyle = `rgba(235,240,252,${s.a})`;
    ctx.beginPath(); ctx.arc(x, y, Math.max(0.35, r * s.s), 0, TAU); ctx.fill();
  }

  // 极暗极小的远日（角落，几乎只剩一点光）
  const sx = cx - r * 1.05, sy = cy + r * 0.95;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const glow = ctx.createRadialGradient(sx, sy, 0, sx, sy, r * 0.16);
  glow.addColorStop(0, 'rgba(255,240,210,0.35)');
  glow.addColorStop(0.3, 'rgba(255,230,190,0.10)');
  glow.addColorStop(1, 'rgba(255,230,190,0)');
  ctx.fillStyle = glow;
  ctx.beginPath(); ctx.arc(sx, sy, r * 0.16, 0, TAU); ctx.fill();
  ctx.restore();
  ctx.fillStyle = 'rgba(255,246,224,0.75)';
  ctx.beginPath(); ctx.arc(sx, sy, Math.max(0.8, r * 0.025), 0, TAU); ctx.fill();
}

/* ----------------------------- 对外 API ----------------------------- */

const DRAWERS = {
  interstellar: drawInterstellar,
  moon: drawMoon,
  venus: drawVenus,
  earth: drawEarth,
  earth_low: drawEarth,
  earth_high: drawEarth,
  earth_far: drawEarth,
  mars: drawMars,
  mercury: drawMercury,
  jupiter: drawJupiter,
  saturn: drawSaturn,
  uranus: drawUranus,
  neptune: drawNeptune,
  pluto: drawPluto,
  oort: drawOort,
};

/**
 * 绘制一颗星球。
 * @param {CanvasRenderingContext2D} ctx
 * @param {string} id 星球 id（earth / earth_low / earth_high / earth_far / moon / venus /
 *                    mars / mercury / jupiter / saturn / uranus / neptune / pluto / oort）
 * @param {number} cx 圆心 x（oort：场景中心 x）
 * @param {number} cy 圆心 y（oort：场景中心 y）
 * @param {number} r  半径 px（oort：场景尺度参考，非球体半径）
 * @param {number} t  时间（ms），驱动自转；静态样板传固定值
 * @param {{rot?: number}} opts rot 可直接指定自转相位（弧度）
 */
export function drawPlanet(ctx, id, cx, cy, r, t = 0, opts = {}) {
  const rot = opts.rot != null ? opts.rot : t * 0.00006;
  ctx.save();
  const draw = DRAWERS[id];
  if (draw) draw(ctx, cx, cy, r, rot);
  else {
    // 未知 id 的占位
    baseSphere(ctx, cx, cy, r, '#9aa7c7', '#5b6b8c', '#2a3350');
    terminator(ctx, cx, cy, r, 0.7);
  }
  ctx.restore();
}