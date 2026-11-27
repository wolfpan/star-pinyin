/**
 * syllable-voice-lib.mjs — 音节标准读音生成共享内核（零依赖，纯 Node）
 * ------------------------------------------------------------------
 * 被两处共用，保证「脚本离线生成」与「家长后台在线重新生成」产出完全一致：
 *   · scripts/gen-syllable-voice.mjs  （命令行批量预生成）
 *   · server.js /api/admin/voice/regenerate （后台按标记/缺失/全部重新生成）
 *
 * 流程：TTS 合成载波/单字 WAV → 能量包络切出目标音节 → 归一化响度 →
 *       超长截断淡出 → 时长校验 → 编码 16-bit PCM WAV。
 */
import { buildSyllable } from '../public/js/pinyin-rules.js';

/** 音节文件名键：ü → v（避免非 ASCII 文件名），如 lü4 → lv4。 */
export const fileKey = (key) => String(key).replace(/ü/g, 'v');

/* ----------------------------- WAV 读写 ----------------------------- */

/** 解析 16-bit PCM WAV → {rate, s}。 */
export function parseWav(buf) {
  if (buf.toString('latin1', 0, 4) !== 'RIFF') throw new Error('不是 RIFF/WAV');
  let off = 12, fmt = null, data = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString('latin1', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = buf.subarray(off + 8, off + 8 + size);
    if (id === 'fmt ') fmt = { rate: body.readUInt32LE(4), channels: body.readUInt16LE(2), bits: body.readUInt16LE(14) };
    else if (id === 'data') data = body;
    off += 8 + size + (size & 1);
  }
  if (!fmt || !data) throw new Error('WAV 缺 fmt/data');
  if (fmt.bits !== 16 || fmt.channels !== 1) throw new Error(`只支持 16bit 单声道，实际 ${fmt.bits}bit/${fmt.channels}ch`);
  const n = Math.floor(data.length / 2);
  const s = new Float32Array(n);
  for (let i = 0; i < n; i++) s[i] = data.readInt16LE(i * 2) / 32768;
  return { rate: fmt.rate, s };
}

/** Float32 采样 → 16-bit PCM WAV。 */
export function encodeWav(samples, rate) {
  const n = samples.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0, 'latin1'); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8, 'latin1');
  buf.write('fmt ', 12, 'latin1'); buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);      // PCM / mono
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'latin1'); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  return buf;
}

/* ----------------------------- 能量包络切分 ----------------------------- */

const rms = (s, a, b) => {
  let x = 0;
  for (let i = Math.max(0, a); i < Math.min(s.length, b); i++) x += s[i] * s[i];
  return Math.sqrt(x / Math.max(1, Math.min(s.length, b) - Math.max(0, a)));
};

/**
 * 找出音节分界：先定位「音节核」（能量峰），相邻峰之间的最低点就是分界。
 * 汉语连读时音节之间很少有真正的静音，所以不能用绝对阈值，必须用峰-谷相对关系。
 * @param {number} sylCount 整词期望音节数
 * @param {number} sylIndex 取第几个音节（从 0 开始）
 * @returns {{from:number,to:number,quality:number,fellBack:boolean}}
 */
export function segmentFor(s, rate, sylCount, sylIndex) {
  const hop = Math.max(1, Math.round(rate * 0.01));
  const win = Math.max(1, Math.round(rate * 0.025));
  const dur = s.length / rate;
  const raw = [];
  for (let a = 0; a + win < s.length; a += hop) raw.push({ t: a / rate, e: rms(s, a, a + win) });
  const frames = raw.map((f, i) => ({
    t: f.t,
    e: (raw[Math.max(0, i - 1)].e + f.e + raw[Math.min(raw.length - 1, i + 1)].e) / 3,
  }));
  const peak = Math.max(...frames.map((f) => f.e)) || 1e-9;
  const voiced = frames.filter((f) => f.e > peak * 0.12);
  const t0 = voiced.length ? voiced[0].t : 0;
  const t1 = voiced.length ? Math.min(dur, voiced[voiced.length - 1].t + win / rate) : dur;

  // 音节核：局部极大且能量足够，60ms 内合并
  const cands = [];
  for (let i = 1; i < frames.length - 1; i++) {
    if (frames[i].e >= frames[i - 1].e && frames[i].e >= frames[i + 1].e && frames[i].e > peak * 0.25) cands.push(frames[i]);
  }
  const peaks = [];
  for (const c of cands) {
    const last = peaks[peaks.length - 1];
    if (last && c.t - last.t < 0.06) { if (c.e > last.e) peaks[peaks.length - 1] = c; }
    else peaks.push(c);
  }

  const valley = (a, b) => {
    let best = { e: Infinity, t: (a.t + b.t) / 2 };
    for (const f of frames) if (f.t > a.t && f.t < b.t && f.e < best.e) best = f;
    return best;
  };

  if (peaks.length >= sylCount) {
    const chosen = [...peaks].sort((a, b) => b.e - a.e).slice(0, sylCount).sort((a, b) => a.t - b.t);
    const vals = chosen.slice(1).map((p, i) => valley(chosen[i], p));
    const quality = vals.map((v, i) => v.e / Math.max(1e-9, Math.min(chosen[i].e, chosen[i + 1].e)));
    // 段界用「发声起点 / 终点 + 谷底」：首段从起音开始，末段到收音结束，中间以谷为界
    const bounds = [t0, ...vals.map((v) => v.t), t1];
    return { from: bounds[sylIndex], to: bounds[sylIndex + 1], quality: Math.max(...quality, 0), fellBack: false };
  }

  // 峰不够：按时间均分（标记不可靠，主流程会改用单字合成）
  const step = (t1 - t0) / sylCount;
  return { from: t0 + step * sylIndex, to: t0 + step * (sylIndex + 1), quality: Infinity, fellBack: true };
}

/** 带 5ms 淡入 / 20ms 淡出的切片。 */
export function sliceWithFade(s, rate, fromSec, toSec) {
  const a = Math.max(0, Math.round(fromSec * rate));
  const b = Math.min(s.length, Math.round(toSec * rate));
  if (b - a < Math.round(rate * 0.08)) throw new Error(`切片过短 ${(b - a) / rate * 1000}ms`);
  const out = s.slice(a, b);
  const fi = Math.round(rate * 0.005), fo = Math.round(rate * 0.02);
  for (let i = 0; i < fi && i < out.length; i++) out[i] *= i / fi;
  for (let i = 0; i < fo && i < out.length; i++) out[out.length - 1 - i] *= i / fo;
  return out;
}

/** 响度归一化：峰值抬到 0.9（增益超过 4 倍说明疑似静音，放弃）。 */
export function normalizeSamples(samples) {
  let maxAbs = 0;
  for (const v of samples) maxAbs = Math.max(maxAbs, Math.abs(v));
  if (maxAbs < 0.01) throw new Error('疑似静音');
  const gain = 0.9 / maxAbs;
  if (gain < 4) for (let i = 0; i < samples.length; i++) samples[i] = Math.max(-1, Math.min(1, samples[i] * gain));
  return samples;
}

/** 个别单字会被拉得很长（>700ms），统一收到 700ms 并做 120ms 淡出，听起来才不拖沓。 */
export function capDuration(samples, rate, maxSec = 0.7, fadeSec = 0.12) {
  const cap = Math.round(rate * maxSec);
  if (samples.length <= cap) return samples;
  const trimmed = samples.slice(0, cap);
  const fo = Math.round(rate * fadeSec);
  for (let i = 0; i < fo && i < trimmed.length; i++) trimmed[trimmed.length - 1 - i] *= i / fo;
  return trimmed;
}

/* ----------------------------- 音节收集 ----------------------------- */

/**
 * 遍历词库收集所有「声母+介母+韵母+声调」组合（音节）及其汉字/载波词。
 * 同一音节可能对应很多汉字与词组，挑最适合「切出来」的载波：
 * 优先 2 字词，其次 3 字；目标字位置越靠首尾越好切。
 * @returns {Map<string, {key,base,tone,display,hanzi,hanziSet:Set,carriers:Array,carrier:object|null}>}
 */
export function collectSyllables(missions) {
  const bySyllable = new Map();
  for (const m of missions) {
    const base = buildSyllable(m.parts, m.type);
    const key = base + m.tone;
    if (!bySyllable.has(key)) {
      bySyllable.set(key, { key, base, tone: m.tone, display: m.displayPinyin, hanzi: m.hanzi, carriers: [], hanziSet: new Set() });
    }
    const rec = bySyllable.get(key);
    rec.hanziSet.add(m.hanzi);
    const pos = [...m.word].indexOf(m.hanzi);
    const cnt = [...m.word].filter((c) => c === m.hanzi).length;
    if (pos >= 0 && cnt === 1) rec.carriers.push({ word: m.word, pos, len: [...m.word].length, hanzi: m.hanzi });
  }
  for (const rec of bySyllable.values()) {
    rec.carriers.sort((a, b) => {
      const scoreA = (a.len === 2 ? 0 : a.len === 3 ? 1 : 2) + (a.pos === 0 || a.pos === a.len - 1 ? 0 : 0.5);
      const scoreB = (b.len === 2 ? 0 : b.len === 3 ? 1 : 2) + (b.pos === 0 || b.pos === b.len - 1 ? 0 : 0.5);
      return scoreA - scoreB;
    });
    rec.carrier = rec.carriers[0] || null;
  }
  return bySyllable;
}

/** 生成计划文案（dry-run / 日志用）。 */
export function planLabel(rec, override, carrier) {
  const ov = override;
  if (ov && ov.from != null && ov.to != null) return `${ov.text || rec.hanzi}[人工区间]`;
  if (ov && ov.text) return `${ov.text}[人工]`;
  if (carrier && rec.carrier) return `${rec.carrier.word}[${rec.carrier.pos}/${rec.carrier.len}]`;
  return `${(ov && ov.hanzi) || rec.hanzi}(单字)`;
}

/* ----------------------------- TTS 合成 ----------------------------- */

/**
 * 调用 Qwen-Audio-TTS 合成并下载音频 Buffer。
 * 接口：POST {url}  body: { model, input:{ text, voice, format, sample_rate } }
 *       返回 output.audio.url → 下载。
 * @returns {Promise<Buffer>}
 */
export async function ttsFetch({ url, key, model, voice, text, format = 'wav', sampleRate = 24000, timeoutMs = 45000 }) {
  if (!key) throw new Error('未配置 TTS API Key');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST', signal: ctrl.signal,
      headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input: { text, voice, format, sample_rate: sampleRate } }),
    });
    const j = await res.json();
    if (!res.ok) throw new Error(j.message || ('TTS HTTP ' + res.status));
    const audioUrl = j.output?.audio?.url;
    if (!audioUrl) throw new Error('TTS 返回无 audio.url');
    const a = await fetch(audioUrl, { signal: ctrl.signal });
    if (!a.ok) throw new Error('下载音频 HTTP ' + a.status);
    return Buffer.from(await a.arrayBuffer());
  } finally { clearTimeout(timer); }
}

/* ----------------------------- 单音节生成 ----------------------------- */

/** 单字读音：合成 → 裁静音（最稳，默认）。 */
async function buildSingle(tts, hanzi) {
  const wav = await tts(hanzi);
  const { rate, s } = parseWav(wav);
  const seg = segmentFor(s, rate, 1, 0);
  return { samples: sliceWithFade(s, rate, seg.from, seg.to), rate, mode: '单字' };
}

/** 载波读音：合成词组 → 按峰谷切出目标音节（连读分不开就判失败）。 */
async function buildCarrier(tts, c) {
  const wav = await tts(c.word);
  const { rate, s } = parseWav(wav);
  const seg = segmentFor(s, rate, c.len, c.pos);
  if (!Number.isFinite(seg.quality) || seg.quality > 0.45) {
    throw new Error(`连读分不开(q=${Number(seg.quality).toFixed(2)})`);
  }
  return { samples: sliceWithFade(s, rate, seg.from, seg.to), rate, mode: c.pos === 0 ? '首音节' : '末音节', quality: seg.quality };
}

/** 人工指定毫秒区间。 */
async function buildRange(tts, text, fromMs, toMs) {
  const wav = await tts(text);
  const { rate, s } = parseWav(wav);
  return { samples: sliceWithFade(s, rate, fromMs / 1000, toMs / 1000), rate, mode: `区间${fromMs}-${toMs}ms` };
}

/**
 * 生成一个音节的标准读音 WAV（含人工兜底表 / 载波 / 单字三种来源）。
 * 载波切不干净（连读太紧/时长异常）且无人工指定时，自动退回单字合成并给出 warning。
 * @param {object} rec collectSyllables 里的一条
 * @param {{tts:(text:string)=>Promise<Buffer>, override?:object|null, carrier?:boolean}} opts
 * @returns {Promise<{buf:Buffer, durMs:number, mode:string, label:string, warning?:string}>}
 */
export async function renderSyllableWav(rec, { tts, override = null, carrier = false }) {
  const ov = override;
  const label = planLabel(rec, ov, carrier);
  let built, warning;
  try {
    if (ov && ov.from != null && ov.to != null) built = await buildRange(tts, ov.text || rec.hanzi, ov.from, ov.to);
    else if (ov && ov.text) built = await buildCarrier(tts, { word: ov.text, pos: ov.pos ?? 0, len: [...ov.text].length });
    else if (carrier && rec.carrier) built = await buildCarrier(tts, rec.carrier);
    else built = await buildSingle(tts, (ov && ov.hanzi) || rec.hanzi);
  } catch (e) {
    // 载波切不干净 → 改单字，绝不留缺文件
    if (carrier && rec.carrier && !ov && /连读分不开|时长异常/.test(e.message)) {
      built = await buildSingle(tts, rec.hanzi);
      warning = `${rec.key}(${rec.carrier.word}) ${e.message} → 改用单字`;
    } else throw e;
  }

  const samples = normalizeSamples(built.samples);
  const trimmed = capDuration(samples, built.rate);
  const durMs = Math.round(trimmed.length / built.rate * 1000);
  if (durMs < 120 || durMs > 1200) throw new Error(`时长异常 ${durMs}ms`);
  return {
    buf: encodeWav(trimmed, built.rate), durMs, mode: built.mode,
    label: warning ? `${rec.hanzi}(单字兜底)` : label,
    ...(warning ? { warning } : {}),
  };
}
