/**
 * launch-fx.js — 点火 / 排烟 / 升空 / 助推器分离 / 整流罩释放卫星 Canvas 粒子系统
 * ------------------------------------------------------------------
 * 设计要点（验收：60fps、重复发射 10 次帧率稳定、无内存泄漏）：
 *  - 单一 requestAnimationFrame 循环，destroy() 必定 cancel 并移除 canvas/监听器。
 *  - 粒子数组有上限（MAX_PARTICLES），按寿命回收，避免无限增长。
 *  - 逐粒子不使用 shadowBlur（昂贵），火焰用 'lighter' 叠加混合。
 *  - devicePixelRatio 上限 2，兼顾 Retina 清晰与性能。
 * 时间轴可用 timeScale 缩放（供自动化验收快进），生产为 1。
 */

import { drawPlanet, drawOrbitEarth } from './planet-fx.js';

const MAX_PARTICLES = 520;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const easeIn = (t) => t * t;
const easeOut = (t) => 1 - (1 - t) * (1 - t);

function lerpColor(c1, c2, t) {
  return [0, 1, 2].map((i) => Math.round(lerp(c1[i], c2[i], t)));
}
const rgb = (c, a = 1) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

// 天空关键色（顶/底）：低空段跟随皮肤 --fx-sky-*（天空积木=晴蓝 / 星云=紫暮），高空段恒为深空实景
const SKY_MID = { top: [8, 13, 34], bot: [12, 20, 42] };      // 平流层夜
const SKY_HIGH = { top: [3, 4, 10], bot: [7, 11, 24] };       // 深空

export function createLaunchFX(container, { hanzi, type, displayPinyin, onEvent, onDone, timeScale = 1, rocketImage = null, destination = null }) {
  // 目的地：orbit=地球三层轨道（低空/高空/远地，卫星入轨）；planet/beyond=巡航转移 + 抵达入轨/飞掠。
  const dest = destination && destination.kind && destination.kind !== 'orbit' ? destination : null;
  const orbitDest = destination && destination.kind === 'orbit' ? destination : null;
  const isOrbit = !dest;
  const canvas = document.createElement('canvas');
  canvas.className = 'launch-canvas';
  container.append(canvas);
  const ctx = canvas.getContext('2d');
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  let W = 0, H = 0;

  // 发射场调色板：读取当前皮肤 CSS 变量（fallback = 深空经典）
  const css = getComputedStyle(document.documentElement);
  const cv = (n, f) => css.getPropertyValue(n).trim() || f;
  const num3 = (n, f) => cv(n, f).split(',').map((x) => Number(x.trim()));
  const PAL = {
    skyTop: num3('--fx-sky-top', '6, 10, 26'), skyBot: num3('--fx-sky-bot', '16, 26, 52'),
    ground: cv('--fx-ground', '#0d1424'), groundLine: cv('--fx-ground-line', 'rgba(76,201,240,0.07)'),
    trench: cv('--fx-trench', '#05070f'), trenchEdge: cv('--fx-trench-edge', '#161d2e'),
    pad: cv('--fx-pad', '#2a3854'), padTop: cv('--fx-pad-top', '#3a4a6b'), clamp: cv('--fx-clamp', '#1a2438'),
    tower: cv('--fx-tower', '#b9c4d6'), towerLine: cv('--fx-tower-line', '#8fa3c8'), mast: cv('--fx-mast', '#dfe6f0'),
    lamp: cv('--fx-lamp', '#3a4a6b'), lampGlow: cv('--fx-lamp-glow', 'rgba(220,240,255,0.85)'),
    count: cv('--fx-count', '#ffd166'), padText: cv('--fx-pad-text', '#d7e3ff'), ignite: cv('--fx-ignite', '#ff7b30'),
  };

  // 预加载拥有的火箭（透明 PNG）与真实发射背景；失败回退矢量绘制。
  const ROCKET_H = 230;
  let rocketReady = false;
  const rocketImg = new Image();
  if (rocketImage) { rocketImg.onload = () => { rocketReady = true; }; rocketImg.src = rocketImage; }
  let satReady = false;
  const satImg = new Image();
  satImg.onload = () => { satReady = true; };
  satImg.src = '/images/sat/sat.png';

  function resize() {
    W = window.innerWidth; H = window.innerHeight;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  resize();
  window.addEventListener('resize', resize);

  // 星空（预生成，视差滚动）
  const stars = Array.from({ length: 140 }, () => ({
    x: Math.random(), y: Math.random(), r: Math.random() * 1.6 + 0.4, tw: Math.random() * Math.PI * 2,
  }));

  const particles = [];
  function spawn(p) { if (particles.length < MAX_PARTICLES) particles.push(p); }

  // 时间轴（基准 ms）：倒计时每位 1s，3→1 共 3s，点火与 liftoff 严格对齐第 3s。
  // 入轨/抵达成功后各多停留约 1s 再结算（orbit 段 2.2s、抵达段 1.6s）。
  const DIGIT_MS = 1000;
  const T = isOrbit ? {
    cdEnd: 3000, ignite: 3000, ascentEnd: 6400,
    sep: 4600, fairing: 5600, release: 6000, orbit: 6600, done: 8800,
  } : {
    cdEnd: 3000, ignite: 3000, ascentEnd: 6400,
    sep: 4600, fairing: 5600, release: 6000, orbit: 6600,
    cruiseStart: 6600, cruiseEnd: 10000, arriveEnd: 12000, done: 13600,
  };
  const three = type === 'three_part';

  let raf = 0, startTs = 0, lastTs = 0, running = false, destroyed = false;
  let lastCount = null, firedIgnite = false, firedSep = false, firedFairing = false, firedOrbit = false;
  let firedCruise = false, firedArrival = false;
  let fairingT = 0;    // 整流罩张开进度
  let satT = 0;        // 卫星释放进度（仅地球轨道）

  function emitFlame(x, y, intensity, dt) {
    const n = Math.min(10, Math.ceil(intensity * dt * 0.12));
    for (let i = 0; i < n; i++) {
      const a = Math.PI / 2 + (Math.random() - 0.5) * 0.7; // 向下喷射
      const sp = 120 + Math.random() * 220 * intensity;
      spawn({ kind: 'flame', x: x + (Math.random() - 0.5) * 14, y, vx: Math.cos(a) * sp * 0.4, vy: Math.sin(a) * sp, life: 0.35 + Math.random() * 0.3, age: 0, size: 6 + Math.random() * 10 * intensity });
    }
  }
  function emitSmoke(x, y, intensity, dt) {
    const n = Math.min(6, Math.ceil(intensity * dt * 0.05));
    for (let i = 0; i < n; i++) {
      spawn({ kind: 'smoke', x: x + (Math.random() - 0.5) * 30, y: y + Math.random() * 10, vx: (Math.random() - 0.5) * 90, vy: 20 + Math.random() * 50, life: 1.2 + Math.random() * 1.2, age: 0, size: 12 + Math.random() * 22 });
    }
  }
  function emitSteam(x, y, dt) {
    if (Math.random() < dt * 0.02) {
      spawn({ kind: 'smoke', x: x + (Math.random() - 0.5) * 80, y, vx: (Math.random() - 0.5) * 40, vy: -10 - Math.random() * 20, life: 1.5, age: 0, size: 10 + Math.random() * 16 });
    }
  }
  function burst(x, y) {
    for (let i = 0; i < 40; i++) {
      const a = Math.random() * Math.PI * 2, sp = 60 + Math.random() * 260;
      spawn({ kind: 'spark', x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 0.5 + Math.random() * 0.5, age: 0, size: 2 + Math.random() * 3 });
    }
  }

  function updateParticles(dt) {
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.age += dt;
      if (p.age >= p.life) { particles.splice(i, 1); continue; }
      p.x += p.vx * dt; p.y += p.vy * dt;
      if (p.kind === 'smoke') { p.size += dt * 26; p.vx *= 0.98; }
      if (p.kind === 'spark') { p.vy += 200 * dt; }
    }
  }
  function drawParticles() {
    // 烟雾（正常混合）
    ctx.globalCompositeOperation = 'source-over';
    for (const p of particles) {
      if (p.kind !== 'smoke') continue;
      const k = 1 - p.age / p.life;
      ctx.globalAlpha = 0.28 * k;
      ctx.fillStyle = '#dfe6f0';
      ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2); ctx.fill();
    }
    // 火焰 / 火花（叠加混合）
    ctx.globalCompositeOperation = 'lighter';
    for (const p of particles) {
      const k = 1 - p.age / p.life;
      if (p.kind === 'flame') {
        ctx.globalAlpha = 0.85 * k;
        ctx.fillStyle = k > 0.6 ? '#ffd166' : (k > 0.3 ? '#ff7b30' : '#e63946');
        ctx.beginPath(); ctx.arc(p.x, p.y, p.size * k, 0, Math.PI * 2); ctx.fill();
      } else if (p.kind === 'spark') {
        ctx.globalAlpha = k;
        ctx.fillStyle = '#ffe08a';
        ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2); ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  function drawSky(skyP) {
    let top, bot;
    if (skyP < 0.5) { const t = skyP / 0.5; top = lerpColor(PAL.skyTop, SKY_MID.top, t); bot = lerpColor(PAL.skyBot, SKY_MID.bot, t); }
    else { const t = (skyP - 0.5) / 0.5; top = lerpColor(SKY_MID.top, SKY_HIGH.top, t); bot = lerpColor(SKY_MID.bot, SKY_HIGH.bot, t); }
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, rgb(top)); g.addColorStop(1, rgb(bot));
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    // 星空（夜空即有稀疏星，入太空更密）
    const starA = clamp(0.35 + skyP * 0.65, 0, 1);
    if (starA > 0) {
      ctx.fillStyle = '#ffffff';
      for (const s of stars) {
        const y = (s.y * H + skyP * 260) % H;
        const tw = 0.6 + 0.4 * Math.sin(s.tw + skyP * 8);
        ctx.globalAlpha = starA * tw;
        ctx.beginPath(); ctx.arc(s.x * W, y, s.r, 0, Math.PI * 2); ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
  }

  /* ---- 代码绘制的发射场（与火箭贴纸同坐标系、同画风，保证对齐） ---- */
  const groundY = () => H * 0.86;
  const padTopY = () => groundY() - 18;
  const RX = () => W * 0.55;

  function drawLaunchScene(alt, skyP) {
    const a = clamp(1 - skyP * 1.1, 0, 1);
    if (a <= 0) return;
    const rx = RX(), gy = groundY(), py = padTopY();
    ctx.save();
    ctx.globalAlpha = a;
    ctx.translate(0, alt * 0.6); // 随高度视差下移

    // 地面
    ctx.fillStyle = PAL.ground;
    ctx.fillRect(-20, gy, W + 40, H - gy + 240);
    ctx.strokeStyle = PAL.groundLine;
    ctx.lineWidth = 1;
    for (let i = 1; i <= 4; i++) { const y = gy + i * i * 14; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
    // 导流槽
    ctx.fillStyle = PAL.trench;
    ctx.fillRect(rx - 42, gy, 84, 70);
    ctx.fillStyle = PAL.trenchEdge;
    ctx.fillRect(rx - 42, gy, 8, 70); ctx.fillRect(rx + 34, gy, 8, 70);
    // 发射台平台 + 固定夹持器
    ctx.fillStyle = PAL.pad;
    ctx.fillRect(rx - 74, py, 148, 18);
    ctx.fillStyle = PAL.padTop;
    ctx.fillRect(rx - 74, py, 148, 4);
    ctx.fillStyle = PAL.clamp;
    ctx.fillRect(rx - 56, py - 16, 10, 16); ctx.fillRect(rx + 46, py - 16, 10, 16);

    // 发射勤务塔架（火箭左侧，格构式，与贴纸同色系）
    const tw = 46, tx = rx - 158, tTop = H * 0.12;
    ctx.fillStyle = PAL.tower;
    ctx.fillRect(tx, tTop, 6, gy - tTop);
    ctx.fillRect(tx + tw - 6, tTop, 6, gy - tTop);
    ctx.strokeStyle = PAL.towerLine; ctx.lineWidth = 3;
    for (let y = tTop; y < gy - 40; y += 56) {
      ctx.beginPath(); ctx.moveTo(tx + 6, y); ctx.lineTo(tx + tw - 6, y + 56); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(tx + tw - 6, y); ctx.lineTo(tx + 6, y + 56); ctx.stroke();
      ctx.fillStyle = PAL.tower; ctx.fillRect(tx, y, tw, 4);
    }
    // 塔顶吊臂 + 摆杆（伸向火箭）
    const armY = H * 0.34;
    ctx.fillStyle = PAL.tower;
    ctx.fillRect(tx + tw, armY, (rx - 34) - (tx + tw), 8);
    ctx.strokeStyle = PAL.towerLine; ctx.lineWidth = 2;
    for (let x = tx + tw; x < rx - 40; x += 22) { ctx.beginPath(); ctx.moveTo(x, armY + 8); ctx.lineTo(x + 12, armY + 20); ctx.stroke(); }
    ctx.beginPath(); ctx.moveTo(tx + tw / 2, tTop); ctx.lineTo(rx - 40, armY); ctx.stroke(); // 拉索
    // 塔顶避雷针
    ctx.fillStyle = PAL.mast; ctx.fillRect(tx + tw / 2 - 2, tTop - 46, 4, 46);

    // 泛光灯
    for (const lx of [rx + 168, rx - 252]) {
      ctx.fillStyle = PAL.lamp; ctx.fillRect(lx, gy - 130, 4, 130);
      const gl = ctx.createRadialGradient(lx + 2, gy - 132, 2, lx + 2, gy - 132, 46);
      gl.addColorStop(0, PAL.lampGlow); gl.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = gl; ctx.beginPath(); ctx.arc(lx + 2, gy - 132, 46, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }

  function drawRocket(x, y, alpha, withBoosters) {
    // 优先使用拥有的火箭透明模型图
    if (rocketReady) {
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.drawImage(rocketImg, x - ROCKET_H / 2, y - ROCKET_H / 2, ROCKET_H, ROCKET_H);
      ctx.restore();
      return;
    }
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(x, y);
    // 助推器
    if (withBoosters) {
      ctx.fillStyle = '#8f2530';
      ctx.fillRect(-30, -20, 14, 60);
      ctx.fillRect(16, -20, 14, 60);
    }
    // 尾翼
    ctx.fillStyle = '#c83c46';
    ctx.beginPath(); ctx.moveTo(-17, 30); ctx.lineTo(-34, 56); ctx.lineTo(-17, 46); ctx.closePath(); ctx.fill();
    ctx.beginPath(); ctx.moveTo(17, 30); ctx.lineTo(34, 56); ctx.lineTo(17, 46); ctx.closePath(); ctx.fill();
    // 箭体
    ctx.fillStyle = '#e2e9f5';
    ctx.fillRect(-17, -40, 34, 86);
    // 整流罩（鼻锥）
    if (fairingT < 1) {
      ctx.fillStyle = '#e64650';
      const spread = fairingT * 26;
      ctx.beginPath(); ctx.moveTo(-17 - spread, -40); ctx.lineTo(0, -78 - fairingT * 10); ctx.lineTo(0, -40); ctx.closePath(); ctx.fill();
      ctx.beginPath(); ctx.moveTo(17 + spread, -40); ctx.lineTo(0, -78 - fairingT * 10); ctx.lineTo(0, -40); ctx.closePath(); ctx.fill();
    }
    // 舷窗
    ctx.fillStyle = '#4cc9f0';
    ctx.beginPath(); ctx.arc(0, -16, 8, 0, Math.PI * 2); ctx.fill();
    // 装饰条
    ctx.fillStyle = '#4cc9f0';
    ctx.fillRect(-17, 20, 34, 7);
    // 喷管
    ctx.fillStyle = '#161d2e';
    ctx.beginPath(); ctx.moveTo(-12, 46); ctx.lineTo(12, 46); ctx.lineTo(9, 58); ctx.lineTo(-9, 58); ctx.closePath(); ctx.fill();
    ctx.restore();
  }

  const SAT_H = 150;
  function drawSatellite(x, y, alpha, t) {
    ctx.save();
    ctx.globalAlpha = alpha;
    // 光晕（叠加）
    ctx.globalCompositeOperation = 'lighter';
    const glow = ctx.createRadialGradient(x, y, 4, x, y, SAT_H * 0.75);
    glow.addColorStop(0, 'rgba(120,220,255,0.5)');
    glow.addColorStop(0.5, 'rgba(80,160,255,0.18)');
    glow.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = glow;
    ctx.beginPath(); ctx.arc(x, y, SAT_H * 0.75, 0, Math.PI * 2); ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
    // 轨道环
    ctx.strokeStyle = 'rgba(120,220,255,0.5)';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.ellipse(x, y + 10, SAT_H * 0.85, SAT_H * 0.3, -0.25, 0, Math.PI * 2); ctx.stroke();
    // 卫星本体（真实模型图，缓慢自转）
    if (satReady) {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(Math.sin(t * 0.0004) * 0.12);
      ctx.drawImage(satImg, -SAT_H / 2, -SAT_H / 2, SAT_H, SAT_H);
      ctx.restore();
    } else {
      ctx.fillStyle = '#2a6f97';
      ctx.fillRect(x - 46, y - 8, 26, 16); ctx.fillRect(x + 20, y - 8, 26, 16);
      ctx.fillStyle = '#ffd166';
      ctx.beginPath(); ctx.arc(x, y, 18, 0, Math.PI * 2); ctx.fill();
    }
    // 汉字铭牌（扁平纯色，无发光）
    ctx.font = 'bold 30px sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = '#eaf6ff';
    ctx.fillText(hanzi, x, y + SAT_H * 0.62);
    ctx.restore();
  }

  /* ---- 代码绘制探测器（金色主体 + 抛物面天线 + 太阳帆板） ---- */
  function drawProbe(x, y, alpha, scale, tilt) {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(x, y); ctx.rotate(tilt || 0); ctx.scale(scale, scale);
    // 太阳帆板
    ctx.fillStyle = '#2a6f97';
    ctx.fillRect(-46, -7, 26, 14); ctx.fillRect(20, -7, 26, 14);
    ctx.strokeStyle = 'rgba(76,201,240,0.7)'; ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      ctx.beginPath(); ctx.moveTo(-46 + i * 6.5, -7); ctx.lineTo(-46 + i * 6.5, 7); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(20 + i * 6.5, -7); ctx.lineTo(20 + i * 6.5, 7); ctx.stroke();
    }
    // 金色主体
    ctx.fillStyle = '#d9a441'; ctx.fillRect(-14, -12, 28, 24);
    ctx.fillStyle = '#f0c060'; ctx.fillRect(-14, -12, 28, 5);
    // 抛物面天线
    ctx.strokeStyle = '#b9c4d6'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(0, -12); ctx.lineTo(0, -19); ctx.stroke();
    ctx.fillStyle = '#e8eef7';
    ctx.beginPath(); ctx.arc(0, -19, 10, Math.PI, 0); ctx.closePath(); ctx.fill();
    ctx.restore();
  }

  /* ---- 巡航转移 + 抵达入轨 / 飞掠（Lv4+） ----
   * 阶段：① 升空段不画任何星体（原发射界面）；
   *       ② 到太空后直接飞向目标星体（cp）：不强行插入地球——发射视角朝前/朝上，
   *          地球在视角之外；目标星体从亮点逐渐放大浮现；
   *       ③ 抵达入轨 / 飞掠（ap）。 */
  function drawCruise(t) {
    const beyond = dest.kind === 'beyond';   // 星际空间：飞掠出画
    const cloud = dest.kind === 'cloud';     // 奥尔特云：进入云区场景
    const scene = beyond || cloud;           // 场景式（无球体）
    const cp = clamp((t - T.orbit) / (T.cruiseEnd - T.orbit), 0, 1);
    const ap = clamp((t - T.cruiseEnd) / (T.arriveEnd - T.cruiseEnd), 0, 1);

    // 光速流线（巡航中段最强）
    const warp = Math.sin(cp * Math.PI);
    if (warp > 0.02) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = `rgba(160,200,255,${0.35 * warp})`;
      ctx.lineWidth = 1.2;
      for (const s of stars) {
        const x = s.x * W, y = s.y * H;
        const dx = x - W * 0.5, dy = y - H * 0.4;
        const d = Math.hypot(dx, dy) || 1;
        const len = 30 + 70 * warp;
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + dx / d * len, y + dy / d * len); ctx.stroke();
      }
      ctx.restore();
    }

    // 目标星体：到太空后从亮点逐渐放大浮现 / 奥尔特云·星际空间场景
    const tx = W * 0.60, ty = lerp(H * 0.20, H * 0.30, cp);
    ctx.save();
    ctx.globalAlpha = clamp(cp * 1.5, 0, 1);
    if (scene) drawPlanet(ctx, dest.id, W * 0.5, H * 0.42, H * 0.34, t);
    else drawPlanet(ctx, dest.id, tx, ty, lerp(2, H * 0.20, easeOut(cp)), t);
    ctx.restore();

    // 探测器：浮现 → 远离地球时直飞 → 抵达绕轨 / 飞掠
    const noseY = rocketReady ? rocketYAt(1) - ROCKET_H * 0.5 : rocketYAt(1) - 70;
    let px, py, pAlpha;
    if (ap <= 0) {
      px = lerp(W * 0.55, scene ? W * 0.5 : tx, easeOut(cp));
      py = lerp(noseY, scene ? H * 0.42 : ty, easeOut(cp));
      pAlpha = clamp(cp * 1.6, 0, 1);
    } else if (beyond) {
      // 飞出太阳系：探测器掠出画面
      px = lerp(W * 0.5, W * 0.86, ap); py = lerp(H * 0.42, H * 0.16, ap); pAlpha = 1;
    } else if (cloud) {
      // 抵达奥尔特云：探测器停驻云区中心
      px = W * 0.5; py = lerp(H * 0.42, H * 0.40, ap); pAlpha = 1;
    } else {
      const ang = -Math.PI / 2 + ap * 2.2;
      px = tx + Math.cos(ang) * H * 0.20 * 1.5;
      py = ty + Math.sin(ang) * H * 0.20 * 0.5; pAlpha = 1;
    }
    // 航迹（巡航阶段拉出）
    if (cp > 0 && ap <= 0) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const trail = ctx.createLinearGradient(W * 0.55, noseY, px, py);
      trail.addColorStop(0, 'rgba(120,220,255,0)');
      trail.addColorStop(1, 'rgba(120,220,255,0.5)');
      ctx.strokeStyle = trail; ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.moveTo(W * 0.55, noseY); ctx.lineTo(px, py); ctx.stroke();
      ctx.restore();
    }
    // 入轨环（仅球体行星；云区/星际空间不画环）
    if (!scene && ap > 0) {
      ctx.save();
      ctx.strokeStyle = `rgba(120,220,255,${0.5 * ap})`; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.ellipse(tx, ty, H * 0.20 * 1.5, H * 0.20 * 0.5, -0.25, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
    }
    drawProbe(px, py, pAlpha, 1, Math.sin(t * 0.0004) * 0.1);
    ctx.font = 'bold 26px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = '#eaf6ff';
    ctx.globalAlpha = pAlpha;
    ctx.fillText(hanzi, px, py + 44);
    ctx.globalAlpha = 1;
  }

  function frame(ts) {
    if (destroyed) return;
    if (!startTs) { startTs = ts; lastTs = ts; }
    const dt = clamp((ts - lastTs) / 1000, 0, 0.05);
    lastTs = ts;
    const t = (ts - startTs) * timeScale;

    const skyP = clamp((t - T.ignite) / (T.orbit - T.ignite), 0, 1);
    const p = clamp((t - T.ignite) / (T.ascentEnd - T.ignite), 0, 1);
    const alt = easeIn(p) * 1400;

    // 事件回调（音效占位，M4 接管）
    if (t < T.cdEnd) {
      const n = 3 - Math.floor(t / DIGIT_MS);
      if (n !== lastCount) { lastCount = n; onEvent?.('countdown', n); }
    } else if (!firedIgnite) { firedIgnite = true; onEvent?.('ignition'); burst(W * 0.5, H * 0.72 + 58); }
    if (three && t >= T.sep && !firedSep) {
      firedSep = true; onEvent?.('separation');
      burst(RX(), rocketYAt(p)); // 分离火花闪爆（不再残留矢量助推器掉落）
    }
    if (t >= T.fairing) fairingT = clamp((t - T.fairing) / 500, 0, 1);
    if (t >= T.fairing && !firedFairing) { firedFairing = true; onEvent?.('fairing'); }
    if (isOrbit && t >= T.release) satT = clamp((t - T.release) / (T.orbit - T.release), 0, 1);
    if (isOrbit && t >= T.orbit && !firedOrbit) {
      firedOrbit = true;
      particles.length = 0; // 入轨瞬间清空发射烟雾，地球三层轨道画面干净（与巡航段一致）
      onEvent?.('orbit');
    }
    if (!isOrbit) {
      if (t >= T.cruiseStart && !firedCruise) {
        firedCruise = true; onEvent?.('cruise');
        particles.length = 0; // 已离开发射场，清空烟雾/火焰，巡航画面干净
      }
      if (t >= T.cruiseEnd && !firedArrival) { firedArrival = true; onEvent?.('arrival'); }
    }

    // 屏幕震动
    let shake = 0;
    if (t >= T.ignite && t < T.ignite + 1400) shake = (1 - (t - T.ignite) / 1400) * 7;
    const sx = (Math.random() - 0.5) * shake, sy = (Math.random() - 0.5) * shake;

    ctx.save();
    ctx.translate(sx, sy);
    drawSky(skyP);
    drawLaunchScene(alt, skyP);

    // 地球三层轨道视角：卫星释放时地球渐显（低空=弧线 / 高空=大地球 / 远地=小地球+轨道环）
    if (isOrbit && orbitDest && satT > 0) {
      ctx.save();
      ctx.globalAlpha = easeOut(satT);
      drawOrbitEarth(ctx, orbitDest.orbitView || 'low', W, H, t);
      ctx.restore();
    }

    // 火箭位置：与背景中央发射塔/发射位对齐
    const ry = rocketYAt(p);
    const rx = W * 0.55;
    const nozzleY = rocketReady ? ry + ROCKET_H * 0.42 : ry + 58;

    // 粒子发射
    if (t < T.ignite) { emitSteam(rx, padTopY() + 8, dt * 1000); }
    else if (t < T.release) {
      const intensity = t < T.ignite + 600 ? 1.6 : 1.0;
      emitFlame(rx, nozzleY, intensity, dt * 1000);
      emitSmoke(rx, nozzleY + 10, intensity, dt * 1000);
    }
    updateParticles(dt);
    drawParticles();

    // 火箭本体（释放卫星后继续上行并淡出，不下坠、无残留掉落物）
    let rocketAlpha = 1, rocketDrawY = ry;
    if (t >= T.release) {
      const coast = (t - T.release) / 1000;
      rocketAlpha = clamp(1 - coast / 1.0, 0, 1);
      rocketDrawY = ry - coast * 90;
    }
    if (rocketAlpha > 0) drawRocket(rx, rocketDrawY, rocketAlpha, three && !firedSep);

    // 卫星入轨：释放光轨 + 星芒粒子 + 真实卫星模型
    if (satT > 0) {
      const noseY = rocketReady ? ry - ROCKET_H * 0.5 : ry - 70;
      const sx2 = lerp(rx, W * 0.5, easeOut(satT));
      const sy2 = lerp(noseY, H * 0.27, easeOut(satT));
      const sa = clamp(satT * 1.5, 0, 1);
      // 释放光轨
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const trail = ctx.createLinearGradient(rx, noseY, sx2, sy2);
      trail.addColorStop(0, 'rgba(120,220,255,0)');
      trail.addColorStop(1, `rgba(120,220,255,${0.5 * sa})`);
      ctx.strokeStyle = trail; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(rx, noseY); ctx.lineTo(sx2, sy2); ctx.stroke();
      ctx.restore();
      // 星芒粒子
      if (Math.random() < dt * 30) {
        const a = Math.random() * Math.PI * 2, sp = 30 + Math.random() * 70;
        spawn({ kind: 'spark', x: sx2 + (Math.random() - 0.5) * 60, y: sy2 + (Math.random() - 0.5) * 40, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 0.6 + Math.random() * 0.6, age: 0, size: 1.5 + Math.random() * 2 });
      }
      drawSatellite(sx2, sy2, sa, t);
    }

    // 巡航转移 + 抵达（Lv4+）：升空段（t<orbit）不画任何星体，恢复原发射界面
    if (!isOrbit && t >= T.orbit) drawCruise(t);

    // 倒计时 / 字幕
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    if (t < T.cdEnd) {
      const n = 3 - Math.floor(t / DIGIT_MS);
      const frac = (t % DIGIT_MS) / DIGIT_MS;      // 每位内的进度
      const pulse = 1 + 0.35 * (1 - frac);          // 每位开始放大后回落
      ctx.save();
      ctx.translate(W * 0.5, H * 0.30);
      ctx.scale(pulse, pulse);
      ctx.globalAlpha = 0.55 + 0.45 * (1 - frac);
      ctx.fillStyle = PAL.count;
      ctx.font = `bold ${Math.round(H * 0.16)}px sans-serif`;
      ctx.fillText(String(Math.max(1, n)), 0, 0);
      ctx.restore();
      ctx.globalAlpha = 1;
      ctx.font = 'bold 18px sans-serif'; ctx.fillStyle = PAL.padText;
      ctx.fillText('倒计时', W * 0.5, H * 0.43);
    } else if (t < T.ignite + 700) {
      ctx.fillStyle = PAL.ignite; ctx.font = `bold ${Math.round(H * 0.09)}px sans-serif`;
      ctx.fillText('点火！', W * 0.5, H * 0.30);
    } else if (t >= (isOrbit ? T.orbit : T.cruiseEnd)) {
      // 两行文字按字号动态计算行距：标题与副标题之间留出明确空隙，避免上下贴在一起
      const titleSize = Math.round(H * 0.05);
      const subSize = Math.max(20, Math.round(H * 0.026));
      const lineGap = Math.max(24, Math.round(H * 0.035));
      // 目的地字幕下移到星球下方，避免压在浅色星球上对比度不足
      const titleY = isOrbit ? H * 0.47 : H * 0.66;
      const subY = titleY + titleSize / 2 + lineGap + subSize / 2;
      ctx.fillStyle = '#3ddc84'; ctx.font = `bold ${titleSize}px sans-serif`;
      ctx.fillText(isOrbit ? (orbitDest?.caption || '抵达低空轨道') : dest.caption, W * 0.5, titleY);
      ctx.fillStyle = '#d7e3ff'; ctx.font = `bold ${subSize}px sans-serif`;
      ctx.fillText(`${hanzi} · ${displayPinyin}`, W * 0.5, subY);
    }
    ctx.restore();

    if (t >= T.done) { running = false; onDone?.(); return; }
    raf = requestAnimationFrame(frame);
  }

  function rocketYAt(p) { return lerp(padTopY() - ROCKET_H * 0.42, H * 0.38, easeIn(p)); }

  return {
    start() { if (running || destroyed) return; running = true; raf = requestAnimationFrame(frame); },
    destroy() {
      destroyed = true; running = false;
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
      particles.length = 0;
      canvas.remove();
    },
  };
}
