/**
 * carrier-voice.mjs — 载波词裁剪实验：合成含目标音素的词，裁出目标段，再用 ASR 验证。
 * 用法：
 *   node scripts/carrier-voice.mjs <part> <词> word [词序号=0]     按 ASR 词时间戳裁第 n 个词
 *   node scripts/carrier-voice.mjs <part> <词> offset 80,120,160   从指定 ms 处裁到词尾（去声母）
 * 例：
 *   node scripts/carrier-voice.mjs a 阿姨 word
 *   node scripts/carrier-voice.mjs o 波 offset 60,90,120
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { trimMp3, parseFrames } from './mp3-trim.mjs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const BASE = 'https://token-plan.cn-beijing.maas.aliyuncs.com';
const VOICE = 'longanhuan_v3.6';
const cred = fs.readFileSync(path.join(process.env.DSH_HOME || 'C:\\Users\\panft\\.dsh', '.credentials.yaml'), 'utf8');
const KEY = (cred.match(/QWEN_TOKEN_PLAN_CN_API_KEY:\s*(\S+)/) || [])[1];
const H = { 'Authorization': 'Bearer ' + KEY, 'Content-Type': 'application/json' };
const TMP = path.join(ROOT, 'data', 'voice-tmp');
fs.mkdirSync(TMP, { recursive: true });

async function tts(text) {
  const r = await fetch(BASE + '/api/v1/services/audio/tts/SpeechSynthesizer', { method: 'POST', headers: H,
    body: JSON.stringify({ model: 'qwen-audio-3.0-tts-plus', input: { text, voice: VOICE, format: 'mp3', sample_rate: 24000 } }) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.message || 'TTS HTTP ' + r.status);
  const u = j.output?.audio?.url; if (!u) throw new Error('TTS 无 url');
  const a = await fetch(u); return Buffer.from(await a.arrayBuffer());
}
async function asr(buf) {
  const dataUri = 'data:audio/mp3;base64,' + buf.toString('base64');
  const r = await fetch(BASE + '/api/v1/services/aigc/multimodal-generation/generation', { method: 'POST', headers: H,
    body: JSON.stringify({ model: 'qwen-audio-3.0-asr-flash',
      input: { messages: [{ role: 'user', content: [
        { type: 'text', text: '这是普通话拼音教学录音，请逐字转写为中文汉字。' },
        { type: 'audio', audio: dataUri, format: 'mp3' }] }] },
      parameters: { format: 'mp3', sample_rate: 24000, asr_options: { enable_itn: false } } }) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.message || 'ASR HTTP ' + r.status);
  return { text: j.text ?? j.output?.text, words: (j.sentence?.words ?? j.output?.sentence?.words ?? []).map((w) => ({ t: w.text, b: w.begin_time, e: w.end_time })) };
}

const [part, carrier, mode, arg] = process.argv.slice(2);
const buf = await tts(carrier);
const full = await asr(buf);
const frames = parseFrames(buf);
const totalMs = frames.length ? frames[frames.length - 1].ms + frames[frames.length - 1].dur : 0;
console.log(`「${carrier}」 ${buf.length}b ${totalMs.toFixed(0)}ms → ${full.text}  ${JSON.stringify(full.words)}`);
fs.writeFileSync(path.join(TMP, `${part}-carrier.mp3`), buf);

const cuts = [];
if (mode === 'word') {
  const idx = Number(arg || 0);
  const w = full.words[idx];
  if (!w) { console.log('无该词时间戳'); process.exit(1); }
  cuts.push({ label: `word${idx}[${w.b},${w.e}]`, s: Math.max(0, w.b - 30), e: Math.min(totalMs, w.e + 40) });
} else if (mode === 'range') {
  for (const r of String(arg).split(',')) { const [s, e] = r.split('-').map(Number); cuts.push({ label: `r${s}_${e}`, s, e: Math.min(totalMs, e) }); }
} else {
  for (const off of String(arg).split(',').map(Number)) cuts.push({ label: `off${off}`, s: off, e: totalMs });
}
for (const c of cuts) {
  try {
    const out = trimMp3(buf, c.s, c.e);
    const r = await asr(out);
    const f = path.join(TMP, `${part}-${c.label.replace(/[\[\],]/g, '_')}.mp3`);
    fs.writeFileSync(f, out);
    console.log(`  ${c.label} ${c.s.toFixed(0)}-${c.e.toFixed(0)}ms ${out.length}b → ${r.text}`);
  } catch (e) { console.log(`  ${c.label} ERR ${e.message}`); }
}