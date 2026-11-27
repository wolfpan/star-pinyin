/**
 * audio-engine.js — Web Audio 拟真音效合成器 + 人声播放调度器
 * ------------------------------------------------------------------
 * 双层降级架构：
 *  - 机械/环境音效：Web Audio API 实时程序化合成（零外部素材）。
 *      · 金属液压锁定声（低通滤波脉冲 + 金属咔哒）
 *      · 电火花警报声（高频锯齿下滑 + 噪声爆裂）
 *      · 倒计时蜂鸣音
 *      · 火箭引擎轰鸣声（滤波粉红噪声渐变）
 *  - 拼音人声：优先 /audio/voice/{pinyin}{tone}.mp3 本地录音；404 无缝降级 speechSynthesis(zh-CN)。
 *      · 提供慢速拆读（声母/介母/韵母分读 + 整体慢读）。
 *
 * iOS 约束：必须在首次用户手势内调用 unlock()（AudioContext.resume + 静默语音）。
 * 所有方法均做异常防护，确保「无静音或报错卡死」。
 */
import { buildSyllable } from './pinyin-rules.js';

let ctx = null;
let master = null;
let pinkBuffer = null;
let unlocked = false;
let currentAudio = null;
const voiceStatus = new Map(); // key -> 'local' | 'tts'

function ensureCtx() {
  if (ctx) return ctx;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  ctx = new Ctx();
  master = ctx.createGain();
  master.gain.value = 0.9;
  master.connect(ctx.destination);
  pinkBuffer = makePinkNoise(ctx, 2);
  return ctx;
}

/** Paul Kellet 粉红噪声滤波，生成可循环噪声缓冲。 */
function makePinkNoise(ac, seconds) {
  const len = Math.floor(ac.sampleRate * seconds);
  const buf = ac.createBuffer(1, len, ac.sampleRate);
  const d = buf.getChannelData(0);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < len; i++) {
    const w = Math.random() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.96900 * b2 + w * 0.1538520;
    b3 = 0.86650 * b3 + w * 0.3104856;
    b4 = 0.55000 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.0168980;
    d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
    b6 = w * 0.115926;
  }
  return buf;
}

const now = () => ctx.currentTime;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** 首次手势内解锁音频（AudioContext + speechSynthesis）。 */
async function unlock() {
  try {
    const ac = ensureCtx();
    if (ac) {
      await ac.resume();
      const buf = ac.createBuffer(1, Math.floor(ac.sampleRate * 0.05), ac.sampleRate);
      const src = ac.createBufferSource();
      src.buffer = buf; src.connect(master); src.start(0);
    }
  } catch (e) { console.warn('[audio] unlock ctx', e); }
  try {
    if ('speechSynthesis' in window) {
      const u = new SpeechSynthesisUtterance('进入指挥中心');
      u.lang = 'zh-CN'; u.volume = 0;
      window.speechSynthesis.speak(u);
    }
  } catch (e) { console.warn('[audio] unlock speech', e); }
  unlocked = true;
}

/* ----------------------------- 音效合成 ----------------------------- */

function safe(fn) { try { if (ensureCtx()) fn(); } catch (e) { console.warn('[audio]', e); } }

/** 金属液压锁定声：低通滤波脉冲 + 金属咔哒。 */
function playLock() {
  safe(() => {
    const t = now();
    const o = ctx.createOscillator(); o.type = 'triangle';
    o.frequency.setValueAtTime(160, t); o.frequency.exponentialRampToValueAtTime(70, t + 0.12);
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 500;
    const g = ctx.createGain(); g.gain.setValueAtTime(0.5, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
    o.connect(f); f.connect(g); g.connect(master); o.start(t); o.stop(t + 0.2);
    const n = ctx.createBufferSource(); n.buffer = pinkBuffer;
    const nf = ctx.createBiquadFilter(); nf.type = 'bandpass'; nf.frequency.value = 2500; nf.Q.value = 2;
    const ng = ctx.createGain(); ng.gain.setValueAtTime(0.25, t); ng.gain.exponentialRampToValueAtTime(0.001, t + 0.06);
    n.connect(nf); nf.connect(ng); ng.connect(master); n.start(t); n.stop(t + 0.07);
  });
}

/** 电火花警报声。 */
function playSpark() {
  safe(() => {
    const t = now();
    const o = ctx.createOscillator(); o.type = 'sawtooth';
    o.frequency.setValueAtTime(1800, t); o.frequency.exponentialRampToValueAtTime(300, t + 0.25);
    const f = ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 400;
    const g = ctx.createGain(); g.gain.setValueAtTime(0.2, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.28);
    o.connect(f); f.connect(g); g.connect(master); o.start(t); o.stop(t + 0.3);
    const n = ctx.createBufferSource(); n.buffer = pinkBuffer;
    const nf = ctx.createBiquadFilter(); nf.type = 'highpass'; nf.frequency.value = 3000;
    const ng = ctx.createGain(); ng.gain.setValueAtTime(0.18, t); ng.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
    n.connect(nf); nf.connect(ng); ng.connect(master); n.start(t); n.stop(t + 0.2);
  });
}

/** 柔和错误提示音。 */
function playError() {
  safe(() => {
    const t = now();
    const o = ctx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(320, t); o.frequency.exponentialRampToValueAtTime(200, t + 0.18);
    const g = ctx.createGain(); g.gain.setValueAtTime(0.18, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
    o.connect(g); g.connect(master); o.start(t); o.stop(t + 0.22);
  });
}

/** 倒计时蜂鸣音（最后一声更高）。 */
function playBeep(n) {
  safe(() => {
    const t = now();
    const o = ctx.createOscillator(); o.type = 'square';
    o.frequency.value = n <= 1 ? 880 : 660;
    const g = ctx.createGain(); g.gain.setValueAtTime(0.18, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.13);
    o.connect(g); g.connect(master); o.start(t); o.stop(t + 0.14);
  });
}

/** 成功琶音。 */
function playSuccess() {
  [523, 659, 784, 1047].forEach((freq, i) => {
    safe(() => {
      const t = now() + i * 0.11;
      const o = ctx.createOscillator(); o.type = 'triangle'; o.frequency.value = freq;
      const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.22, t + 0.02); g.gain.exponentialRampToValueAtTime(0.001, t + 0.24);
      o.connect(g); g.connect(master); o.start(t); o.stop(t + 0.26);
    });
  });
}

/** 助推器分离闷响。 */
function playSeparation() {
  safe(() => {
    const t = now();
    const o = ctx.createOscillator(); o.type = 'square';
    o.frequency.setValueAtTime(200, t); o.frequency.exponentialRampToValueAtTime(90, t + 0.2);
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 600;
    const g = ctx.createGain(); g.gain.setValueAtTime(0.25, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
    o.connect(f); f.connect(g); g.connect(master); o.start(t); o.stop(t + 0.27);
  });
}

/** 整流罩张开轻响。 */
function playFairing() {
  safe(() => {
    const t = now();
    const n = ctx.createBufferSource(); n.buffer = pinkBuffer;
    const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 1800; f.Q.value = 1.5;
    const g = ctx.createGain(); g.gain.setValueAtTime(0.18, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
    n.connect(f); f.connect(g); g.connect(master); n.start(t); n.stop(t + 0.13);
  });
}

/** 巡航转移呼啸：滤波噪声频率上扬，模拟星际转移加速。 */
function playCruise() {
  safe(() => {
    const t = now();
    const n = ctx.createBufferSource(); n.buffer = pinkBuffer; n.loop = true;
    const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = 1.2;
    f.frequency.setValueAtTime(400, t);
    f.frequency.exponentialRampToValueAtTime(2600, t + 1.6);
    f.frequency.exponentialRampToValueAtTime(700, t + 3.0);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.16, t + 0.5);
    g.gain.exponentialRampToValueAtTime(0.001, t + 3.0);
    n.connect(f); f.connect(g); g.connect(master); n.start(t); n.stop(t + 3.1);
  });
}

/** 抵达目的地提示音：上行 shimmer + 柔和确认音。 */
function playArrival() {
  [392, 523, 659, 880, 1175].forEach((freq, i) => {
    safe(() => {
      const t = now() + i * 0.09;
      const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = freq;
      const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.18, t + 0.02); g.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
      o.connect(g); g.connect(master); o.start(t); o.stop(t + 0.32);
    });
  });
}

/** 无线电滋滋声（塔台重播）。 */
function playRadioStatic() {
  safe(() => {
    const t = now();
    const n = ctx.createBufferSource(); n.buffer = pinkBuffer;
    const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 1200; f.Q.value = 0.8;
    const g = ctx.createGain(); g.gain.setValueAtTime(0.12, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
    n.connect(f); f.connect(g); g.connect(master); n.start(t); n.stop(t + 0.23);
  });
}

/**
 * 火箭引擎轰鸣：滤波粉红噪声渐变。返回可提前停止的句柄。
 * @param {{duration?:number, peak?:number}} opts
 */
function startEngineRoar({ duration = 4, peak = 0.45 } = {}) {
  if (!ensureCtx()) return { stop() {} };
  try {
    const t = now();
    const src = ctx.createBufferSource(); src.buffer = pinkBuffer; src.loop = true;
    const f = ctx.createBiquadFilter(); f.type = 'lowpass';
    f.frequency.setValueAtTime(300, t);
    f.frequency.linearRampToValueAtTime(1400, t + 0.6);
    f.frequency.linearRampToValueAtTime(500, t + duration);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + 0.4);
    g.gain.setValueAtTime(peak, t + Math.max(0.5, duration - 0.5));
    g.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    src.connect(f); f.connect(g); g.connect(master);
    src.start(t); src.stop(t + duration + 0.05);
    return {
      stop() {
        try {
          const ct = ctx.currentTime;
          g.gain.cancelScheduledValues(ct);
          g.gain.setTargetAtTime(0.0001, ct, 0.1);
          src.stop(ct + 0.15);
        } catch {}
      },
    };
  } catch (e) { console.warn('[audio] roar', e); return { stop() {} }; }
}

/* ----------------------------- 人声调度 ----------------------------- */

let currentVoiceUrl = null; // 当前人声的 blob URL（停止/播完即释放）

function releaseVoiceUrl() {
  if (currentVoiceUrl) { try { URL.revokeObjectURL(currentVoiceUrl); } catch {} currentVoiceUrl = null; }
}

/**
 * 先把音频 fetch 成 blob 再播（cache:'no-store' 强制回源）。
 * 不能直接 new Audio(文件URL)：浏览器媒体缓存按 URL 缓存旧音频、无视 no-cache，
 * 家长端「重新生成」覆盖同名 wav 后，孩子端必须取最新字节才能听到新读音。
 */
async function fetchVoiceAudio(url, rate = 1) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error('voice HTTP ' + res.status);
  const blob = await res.blob();
  if (!blob.size) throw new Error('空音频');
  releaseVoiceUrl();
  currentVoiceUrl = URL.createObjectURL(blob);
  const u = currentVoiceUrl;
  const a = new Audio(u);
  a.playbackRate = rate;
  if ('preservesPitch' in a) a.preservesPitch = true;
  a.addEventListener('ended', () => { if (currentVoiceUrl === u) releaseVoiceUrl(); }, { once: true });
  return a;
}

function stopVoice() {
  try { if ('speechSynthesis' in window) window.speechSynthesis.cancel(); } catch {}
  try { if (currentAudio) { currentAudio.pause(); currentAudio = null; } } catch {}
  releaseVoiceUrl();
}

/** 浏览器 speechSynthesis 兜底（仅当真人语音不可用时）。 */
function ttsFallback(text, rate = 1) {
  try {
    if (!('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'zh-CN'; u.rate = rate; u.volume = 1;
    const voices = window.speechSynthesis.getVoices();
    const zh = voices.find((v) => /^zh/i.test(v.lang)) || voices.find((v) => /Chinese|中文/i.test(v.name));
    if (zh) u.voice = zh;
    window.speechSynthesis.speak(u);
  } catch (e) { console.warn('[audio] ttsFallback', e); }
}

/**
 * 全局真人语音：经服务端 /api/tts 代理（Qwen-Audio-TTS + 磁盘缓存）播放任意文本。
 * ------------------------------------------------------------------
 * 先把音频取成本地 blob 再播放，而不是让 <audio> 边下边播：
 *   · 服务端首次合成要 1~3 秒，边下边播时 play() 很容易被浏览器拒绝，
 *     旧逻辑会立刻降级到 speechSynthesis —— 那台「机器人腔」忽大忽小，正是听着很奇怪的原因；
 *   · 改成「取完再播」后，只有服务端真的失败才降级，音色始终是同一个真人音色。
 */
async function speakText(text, rate = 1) {
  stopVoice();
  if (!text) return;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch('/api/tts?text=' + encodeURIComponent(text), { signal: ctrl.signal, cache: 'no-store' });
    if (!res.ok) throw new Error('tts ' + res.status);
    const blob = await res.blob();
    if (!blob.size) throw new Error('空音频');
    releaseVoiceUrl();
    currentVoiceUrl = URL.createObjectURL(blob);
    const u = currentVoiceUrl;
    const a = new Audio(u);
    a.playbackRate = rate;
    if ('preservesPitch' in a) a.preservesPitch = true;
    currentAudio = a;
    a.addEventListener('ended', () => { if (currentVoiceUrl === u) releaseVoiceUrl(); }, { once: true });
    await a.play();
  } catch (e) {
    // 只有服务端真的拿不到音频（或超时）才降级到系统语音
    ttsFallback(text, rate);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 播放拼音标准读音：本地预生成录音优先（wav → mp3），都没有才现场合成。
 * 本地文件是离线生成 + 统一响度归一化的，播出来稳定、无延迟。
 * fallbackText：TTS 兜底文本。教材生字含多音字（长/行/重…），孤立读字可能读错音，
 * 兜底时带词组上下文（如「长大的长」）让 TTS 读对。
 * @param {{base:string, tone:number, hanzi:string, rate?:number, fallbackText?:string}} opts
 */
async function speakPinyin({ base, tone, hanzi, rate = 1, fallbackText = '' }) {
  stopVoice();
  const key = `${base}${tone}`;
  const fallback = fallbackText || hanzi;
  const head = async (u) => { try { return (await fetch(u, { method: 'HEAD' })).ok; } catch { return false; } };
  let status = voiceStatus.get(key);
  if (status === undefined) {
    if (await head(`/audio/voice/${key}.wav`)) status = 'wav';
    else if (await head(`/audio/voice/${key}.mp3`)) status = 'mp3';
    else status = 'tts';
    voiceStatus.set(key, status);
  }
  if (status === 'wav' || status === 'mp3') {
    try {
      // fetch→blob：绕过媒体缓存，家长端重新生成后这里立刻听到新读音
      const a = await fetchVoiceAudio(`/audio/voice/${key}.${status}`, rate);
      currentAudio = a;
      a.addEventListener('error', () => speakText(fallback, rate), { once: true });
      await a.play();
      return;
    } catch { /* 自动播放受限 / 取音频失败 → 降级 */ }
  }
  speakText(fallback, rate);
}

/** 声母/介母/韵母呼读音映射（用对应汉字让 TTS 发出正确音素，而非字母名）。 */
export const PINYIN_READ = {
  b: '玻', p: '坡', m: '摸', f: '佛', d: '德', t: '特', n: '讷', l: '乐', g: '哥', k: '科', h: '喝',
  j: '基', q: '欺', x: '希', zh: '知', ch: '吃', sh: '诗', r: '日', z: '资', c: '雌', s: '思', y: '衣', w: '乌',
  i: '衣', u: '乌', ü: '迂',
  a: '啊', o: '喔', e: '鹅', ai: '哀', ei: '诶', ui: '威', ao: '熬', ou: '欧', iu: '忧', ie: '耶', üe: '约', er: '儿',
  an: '安', en: '恩', in: '因', un: '温', ün: '晕', ang: '昂', eng: '鞥', ing: '英', ong: '翁',
};

/** 零件读音文件名：ü → v（避免非 ASCII 文件名），如 üe → ve.mp3。 */
const partFileKey = (p) => String(p).replace(/ü/g, 'v');
const partStatus = new Map(); // key -> 'local' | 'tts'

/**
 * 播放单个声母/介母/韵母的标准呼读音：
 * 优先本地预生成录音 /audio/voice/part/{key}.mp3（AI 合成 + ASR 校验），
 * 缺失时降级 /api/tts 读呼读音汉字，再降级浏览器 speechSynthesis。
 */
async function speakPart(part, rate = 0.85) {
  stopVoice();
  const key = partFileKey(part);
  const url = `/audio/voice/part/${key}.mp3`;
  let status = partStatus.get(key);
  if (status === undefined) {
    try { const r = await fetch(url, { method: 'HEAD' }); status = r.ok ? 'local' : 'tts'; }
    catch { status = 'tts'; }
    partStatus.set(key, status);
  }
  if (status === 'local') {
    try {
      const a = await fetchVoiceAudio(url, rate);
      currentAudio = a;
      a.addEventListener('error', () => speakText(PINYIN_READ[part] || part, rate), { once: true });
      await a.play();
      return;
    } catch { /* 自动播放受限 / 取音频失败 → 降级 */ }
  }
  speakText(PINYIN_READ[part] || part, rate);
}

/** 慢速拆读：声母/介母/韵母按呼读音分读，再整体慢读（均为真人语音）。
 * 整体认读带词组上下文读（多音字如「只/石/似」孤立读可能读错音）。 */
async function slowSplit(mission) {
  stopVoice();
  const context = mission.word ? `${mission.word}的${mission.hanzi}` : mission.hanzi;
  const parts = [];
  if (mission.type === 'whole_syllable') parts.push(context);
  else {
    if (mission.parts.initial) parts.push(mission.parts.initial);
    if (mission.parts.medial) parts.push(mission.parts.medial);
    if (mission.parts.final) parts.push(mission.parts.final);
  }
  for (const p of parts) {
    if (mission.type === 'whole_syllable') speakText(p, 0.85);
    else speakPart(p, 0.85);
    await wait(900);
  }
  await speakPinyin({ base: buildSyllable(mission.parts, mission.type), tone: mission.tone, hanzi: mission.hanzi, rate: 0.8, fallbackText: context });
}

const AudioEngine = {
  unlock,
  isUnlocked: () => unlocked,
  contextState: () => (ctx ? ctx.state : 'none'),
  playLock, playSpark, playError, playBeep, playSuccess, playSeparation, playFairing, playCruise, playArrival, playRadioStatic,
  startEngineRoar,
  speakText, speakPinyin, speakPart, slowSplit, stopVoice,
};

export default AudioEngine;
