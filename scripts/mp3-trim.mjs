/**
 * mp3-trim.mjs — 纯 Node 的 MP3 帧级裁剪（零依赖）。
 * ------------------------------------------------------------------
 * 用途：TTS 合成载波词（如「阿姨」）后，按 ASR 词时间戳裁出目标音节（ā）。
 * MP3 每帧独立可解码（MPEG2 LayerIII @24kHz ≈ 24ms/帧），按帧边界裁剪无损。
 * 用法：
 *   import { trimMp3 } from './mp3-trim.mjs';
 *   node scripts/mp3-trim.mjs in.mp3 out.mp3 <startMs> <endMs>
 */
import fs from 'node:fs';

const BITRATES = {
  // [MPEG1 LayerIII, MPEG2/2.5 LayerIII]
  1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0],
  2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0],
};
const RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

/** 跳过 ID3v2 头，返回音频数据起点。 */
function skipId3(buf) {
  if (buf.length > 10 && buf.toString('latin1', 0, 3) === 'ID3') {
    const size = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
    return 10 + size;
  }
  return 0;
}

/** 解析所有帧：返回 [{offset, length, ms}]。 */
export function parseFrames(buf) {
  const frames = [];
  let i = skipId3(buf);
  let ms = 0;
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff || (buf[i + 1] & 0xe0) !== 0xe0) { i++; continue; }
    const verBits = (buf[i + 1] >> 3) & 3;      // 3=MPEG1, 2=MPEG2, 0=MPEG2.5
    const layerBits = (buf[i + 1] >> 1) & 3;    // 1=LayerIII
    if (verBits === 1 || layerBits !== 1) { i++; continue; }
    const brIdx = (buf[i + 2] >> 4) & 15;
    const srIdx = (buf[i + 2] >> 2) & 3;
    const padding = (buf[i + 2] >> 1) & 1;
    const ver = verBits === 3 ? 1 : 2;
    const bitrate = BITRATES[ver][brIdx] * 1000;
    const rate = RATES[verBits === 3 ? 3 : verBits === 2 ? 2 : 0][srIdx];
    if (!bitrate || !rate || srIdx === 3) { i++; continue; }
    const samples = ver === 1 ? 1152 : 576;
    const len = Math.floor((samples / 8) * bitrate / rate) + padding;
    if (len < 4 || i + len > buf.length) break;
    frames.push({ offset: i, length: len, ms, dur: samples / rate * 1000 });
    ms += samples / rate * 1000;
    i += len;
  }
  return frames;
}

/** 裁剪 [startMs, endMs) 区间内的帧，返回新 Buffer（不含 ID3）。 */
export function trimMp3(buf, startMs, endMs) {
  const frames = parseFrames(buf);
  if (!frames.length) throw new Error('未解析到 MP3 帧');
  const keep = frames.filter((f) => f.ms + f.dur > startMs && f.ms < endMs);
  if (!keep.length) throw new Error(`区间 ${startMs}-${endMs}ms 内无帧（总长 ${frames[frames.length - 1].ms + frames[frames.length - 1].dur}ms）`);
  return Buffer.concat(keep.map((f) => buf.subarray(f.offset, f.offset + f.length)));
}

// CLI
if (process.argv[1] && process.argv[1].endsWith('mp3-trim.mjs')) {
  const [inFile, outFile, s, e] = process.argv.slice(2);
  const buf = fs.readFileSync(inFile);
  const out = trimMp3(buf, Number(s), Number(e));
  fs.writeFileSync(outFile, out);
  const frames = parseFrames(buf);
  console.log(`总帧 ${frames.length} · 总时长 ${(frames[frames.length - 1].ms + frames[frames.length - 1].dur).toFixed(0)}ms → 裁出 ${out.length}b`);
}