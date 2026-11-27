/**
 * gen-part-voice.mjs — 预生成声母/介母/韵母「零件呼读音」MP3（AI 合成 + 可选 ASR 校验）。
 * ------------------------------------------------------------------
 * 背景：单个汉字让 TTS 读呼读音并不总可靠——
 *   · 啊→hā(哈)、喔→wa(哇)、勒→lēi(累)、得→děi、鞥→téng(疼)、迂→「雨克」…
 * 因此每个零件都用「海选 + ASR 校验」挑出的最佳来源合成：
 *   · 多数声母/韵母：用发音唯一的汉字（德/乐/雌…）；
 *   · 纯元音 a/o/ei：直接用带调拼音文本（ā/ō/ēi），TTS 能准确读出；
 *   · ao/en/eng/ün/ü：合成载波词（凹陷/恩典/灯/晕倒/迂回）后按帧裁出目标音段。
 * 输出：public/audio/voice/part/{key}.mp3（ü→v），audio-engine.speakPart 优先播放。
 *
 * 用法：node scripts/gen-part-voice.mjs [--force] [--verify] [--only a,o,sh]
 *   --verify 生成后逐个送 ASR 转写打印（人工复核）；--force 重新生成。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { trimMp3 } from './mp3-trim.mjs';
import { INITIALS, FINALS, MEDIALS } from '../public/js/pinyin-rules.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'public', 'audio', 'voice', 'part');
fs.mkdirSync(OUT, { recursive: true });
const args = process.argv.slice(2);
const FORCE = args.includes('--force');
const VERIFY = args.includes('--verify');
const getArg = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const ONLY = getArg('only', '');
const VOICE = getArg('voice', 'longanhuan_v3.6');
const BASE = 'https://token-plan.cn-beijing.maas.aliyuncs.com';
const cred = fs.readFileSync(path.join(process.env.DSH_HOME || 'C:\\Users\\panft\\.dsh', '.credentials.yaml'), 'utf8');
const KEY = (cred.match(/QWEN_TOKEN_PLAN_CN_API_KEY:\s*(\S+)/) || [])[1];
if (!KEY) { console.error('未找到 API Key'); process.exit(1); }
const H = { 'Authorization': 'Bearer ' + KEY, 'Content-Type': 'application/json' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fileKey = (p) => String(p).replace(/ü/g, 'v');

/** 每个零件的合成配方（均经 TTS→ASR 海选校验）。 */
const RECIPES = {
  // 声母：发音唯一的呼读音汉字
  b: { text: '玻' }, p: { text: '坡' }, m: { text: '摸' }, f: { text: '佛' },
  d: { text: '德' }, t: { text: '特' }, n: { text: '讷' }, l: { text: '乐' },
  g: { text: '哥' }, k: { text: '科' }, h: { text: '喝' },
  j: { text: '基' }, q: { text: '欺' }, x: { text: '希' },
  zh: { text: '知' }, ch: { text: '吃' }, sh: { text: '诗' }, r: { text: '日' },
  z: { text: '资' }, c: { text: '雌' }, s: { text: '思' }, y: { text: '衣' }, w: { text: '乌' },
  // 介母
  i: { text: '衣' }, u: { text: '乌' }, ü: { carrier: '迂回', s: 0, e: 420 },
  // 单韵母：a/o 用带调拼音文本（汉字 啊/喔 会被读成 hā/wa）
  a: { text: 'ā' }, o: { text: 'ō' }, e: { text: '鹅' },
  // 复韵母
  ai: { text: '哀' }, ei: { text: 'ēi' }, ui: { text: '威' },
  ao: { carrier: '凹陷', s: 0, e: 420 }, ou: { text: '欧' }, iu: { text: '忧' },
  ie: { text: '耶' }, üe: { text: '约' }, er: { text: '儿' },
  // 鼻韵母
  an: { text: '安' }, en: { carrier: '恩典', s: 0, e: 380 }, in: { text: '因' },
  un: { text: '温' }, ün: { carrier: '晕倒', s: 0, e: 420 },
  ang: { text: '昂' }, eng: { carrier: '灯', s: 240, e: 624 }, ing: { text: '英' }, ong: { text: '翁' },
};

async function tts(text) {
  const r = await fetch(BASE + '/api/v1/services/audio/tts/SpeechSynthesizer', { method: 'POST', headers: H,
    body: JSON.stringify({ model: 'qwen-audio-3.0-tts-plus', input: { text, voice: VOICE, format: 'mp3', sample_rate: 24000 } }) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.message || 'TTS HTTP ' + r.status);
  const u = j.output?.audio?.url; if (!u) throw new Error('TTS 无 url');
  const a = await fetch(u); if (!a.ok) throw new Error('下载 HTTP ' + a.status);
  return Buffer.from(await a.arrayBuffer());
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
  return j.text ?? j.output?.text ?? '';
}

const parts = [...new Set([...INITIALS, ...MEDIALS, ...FINALS])];
const onlySet = ONLY ? new Set(ONLY.split(',')) : null;
let ok = 0, skip = 0, fail = 0; const failures = []; const verifyRows = [];
console.log(`音色 ${VOICE} · 待生成 ${parts.length} 个零件读音${VERIFY ? '（含 ASR 校验）' : ''}`);
for (const p of parts) {
  if (onlySet && !onlySet.has(p)) continue;
  const recipe = RECIPES[p];
  const file = path.join(OUT, fileKey(p) + '.mp3');
  if (!recipe) { fail++; failures.push([p, '无配方']); console.log(`✗ ${p} 无配方`); continue; }
  if (!FORCE && fs.existsSync(file) && fs.statSync(file).size > 800) {
    skip++;
    if (VERIFY) { try { const t = await asr(fs.readFileSync(file)); verifyRows.push([p, t]); console.log(`… ${p.padEnd(4)} ${t}`); } catch (e) { console.log(`… ${p} 校验失败 ${e.message}`); } }
    continue;
  }
  let done = false;
  for (let attempt = 1; attempt <= 2 && !done; attempt++) {
    try {
      let buf;
      if (recipe.text) buf = await tts(recipe.text);
      else { const full = await tts(recipe.carrier); buf = trimMp3(full, recipe.s, recipe.e); }
      if (buf.length < 800) throw new Error('音频过小 ' + buf.length);
      fs.writeFileSync(file + '.tmp', buf); fs.renameSync(file + '.tmp', file);
      ok++; done = true;
      let v = '';
      if (VERIFY) { try { v = await asr(buf); verifyRows.push([p, v]); } catch (e) { v = '校验失败:' + e.message; } }
      console.log(`✓ ${p.padEnd(4)} ${fileKey(p)}.mp3  ${buf.length}b  ${recipe.text ? '「' + recipe.text + '」' : recipe.carrier + '[' + recipe.s + ',' + recipe.e + ']'}${VERIFY ? '  → ' + v : ''}`);
    } catch (e) {
      if (attempt === 2) { fail++; failures.push([p, e.message]); console.log(`✗ ${p} ${e.message}`); }
      else await sleep(800);
    }
  }
  await sleep(200);
}
console.log(`\n完成：新生成 ${ok} · 跳过 ${skip} · 失败 ${fail}`);
if (failures.length) { console.error('失败明细：', failures); process.exit(1); }