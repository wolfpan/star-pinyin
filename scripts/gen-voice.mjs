/**
 * gen-voice.mjs — 用 Qwen-Audio-TTS 预生成种子任务的标准读音 MP3。
 * ------------------------------------------------------------------
 * 接口：POST https://token-plan.cn-beijing.maas.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer
 *   body: { model:'qwen-audio-3.0-tts-plus', input:{ text, voice, format:'mp3', sample_rate:24000 } }
 *   返回 output.audio.url（24h 有效）→ 下载保存为 public/audio/voice/{base}{tone}.mp3
 * 密钥运行时从本地凭据读取，绝不写入仓库或打印。
 *
 * 用法：node scripts/gen-voice.mjs [--voice longanhuan_v3.6] [--force] [--only m_011,m_033]
 *   默认跳过已存在文件（幂等可续跑）；--force 重新生成。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSyllable } from '../public/js/pinyin-rules.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'public', 'audio', 'voice');
fs.mkdirSync(OUT, { recursive: true });

const args = process.argv.slice(2);
const getArg = (name, def) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : def; };
const VOICE = getArg('voice', 'longanhuan_v3.6');
const FORCE = args.includes('--force');
const ONLY = getArg('only', '');
const MODEL = 'qwen-audio-3.0-tts-plus';
const URL = 'https://token-plan.cn-beijing.maas.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer';

const cred = fs.readFileSync('C:\\Users\\panft\\.dsh\\.credentials.yaml', 'utf8');
const KEY = (cred.match(/QWEN_TOKEN_PLAN_CN_API_KEY:\s*(\S+)/) || [])[1];
if (!KEY) { console.error('未找到 API Key'); process.exit(1); }

const missions = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'missions.json'), 'utf8'));
const onlySet = ONLY ? new Set(ONLY.split(',')) : null;

// 按 base+tone 去重（同一音节共用一个读音文件）
const jobs = new Map();
for (const m of missions) {
  if (onlySet && !onlySet.has(m.id)) continue;
  const base = buildSyllable(m.parts, m.type);
  const key = `${base}${m.tone}`;
  if (!jobs.has(key)) jobs.set(key, { key, base, tone: m.tone, text: m.hanzi, hanzi: m.hanzi });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function synth(text) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 45000);
  try {
    const res = await fetch(URL, {
      method: 'POST', signal: ctrl.signal,
      headers: { 'Authorization': 'Bearer ' + KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, input: { text, voice: VOICE, format: 'mp3', sample_rate: 24000 } }),
    });
    const j = await res.json();
    if (!res.ok) throw new Error(j.message || ('HTTP ' + res.status));
    const url = j.output?.audio?.url;
    if (!url) throw new Error('返回无 audio.url');
    const a = await fetch(url, { signal: ctrl.signal });
    if (!a.ok) throw new Error('下载音频 HTTP ' + a.status);
    return Buffer.from(await a.arrayBuffer());
  } finally { clearTimeout(timer); }
}

let ok = 0, skip = 0, fail = 0;
const failures = [];
console.log(`模型 ${MODEL} · 音色 ${VOICE} · 待生成 ${jobs.size} 个音节`);
for (const job of jobs.values()) {
  const file = path.join(OUT, job.key + '.mp3');
  if (!FORCE && fs.existsSync(file) && fs.statSync(file).size > 1000) { skip++; console.log(`跳过 ${job.key} (${job.hanzi}) 已存在`); continue; }
  let done = false;
  for (let attempt = 1; attempt <= 2 && !done; attempt++) {
    try {
      const buf = await synth(job.text);
      if (buf.length < 1000) throw new Error('音频过小 ' + buf.length);
      fs.writeFileSync(file + '.tmp', buf); fs.renameSync(file + '.tmp', file);
      ok++; done = true;
      console.log(`✓ ${job.key}.mp3  ${job.hanzi}  ${buf.length} bytes`);
    } catch (e) {
      if (attempt === 2) { fail++; failures.push([job.key, e.message]); console.log(`✗ ${job.key} (${job.hanzi}) ${e.message}`); }
      else await sleep(800);
    }
  }
  await sleep(250); // 礼貌限速
}
console.log(`\n完成：新生成 ${ok} · 跳过 ${skip} · 失败 ${fail} · 共 ${jobs.size}`);
if (failures.length) { console.error('失败明细：', failures); process.exit(1); }
