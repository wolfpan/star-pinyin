/**
 * audition-voice.mjs — 呼读音「海选」：候选文本 → TTS 合成 → ASR 转写，人工挑出发音正确的候选。
 * 用法：node scripts/audition-voice.mjs <part>=<候选1>,<候选2> ...
 *   例：node scripts/audition-voice.mjs a=啊,阿,吖 o=喔,噢,哦
 * 输出每个候选的 ASR 文本与词时间戳（供载波词裁剪用）。结果存 data/voice-audition.json。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const BASE = 'https://token-plan.cn-beijing.maas.aliyuncs.com';
const VOICE = 'longanhuan_v3.6';
const cred = fs.readFileSync(path.join(process.env.DSH_HOME || 'C:\\Users\\panft\\.dsh', '.credentials.yaml'), 'utf8');
const KEY = (cred.match(/QWEN_TOKEN_PLAN_CN_API_KEY:\s*(\S+)/) || [])[1];
if (!KEY) { console.error('未找到 API Key'); process.exit(1); }
const H = { 'Authorization': 'Bearer ' + KEY, 'Content-Type': 'application/json' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
        { type: 'text', text: '这是普通话拼音教学录音，请逐字转写为中文汉字，保留声调对应的汉字。' },
        { type: 'audio', audio: dataUri, format: 'mp3' }] }] },
      parameters: { format: 'mp3', sample_rate: 24000, asr_options: { enable_itn: false } } }) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.message || 'ASR HTTP ' + r.status);
  return { text: j.text ?? j.output?.text, words: (j.sentence?.words ?? j.output?.sentence?.words ?? []).map((w) => ({ t: w.text, b: w.begin_time, e: w.end_time })) };
}

const specs = process.argv.slice(2).map((a) => { const [p, cs] = a.split('='); return { part: p, candidates: cs.split(',') }; });
const out = [];
for (const { part, candidates } of specs) {
  for (const c of candidates) {
    try {
      const buf = await tts(c);
      const r = await asr(buf);
      console.log(`${part.padEnd(4)} 候选「${c}」 ${buf.length}b → ${r.text}   ${JSON.stringify(r.words)}`);
      out.push({ part, candidate: c, bytes: buf.length, ...r });
    } catch (e) { console.log(`${part.padEnd(4)} 候选「${c}」 ERR ${e.message}`); out.push({ part, candidate: c, error: e.message }); }
    await sleep(200);
  }
}
fs.writeFileSync(path.join(ROOT, 'data', 'voice-audition.json'), JSON.stringify(out, null, 2));
console.log('\n结果已写入 data/voice-audition.json');