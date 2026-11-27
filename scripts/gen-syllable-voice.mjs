/**
 * gen-syllable-voice.mjs — 为词库里每个音节预生成「标准读音」WAV（载波裁剪）
 * ------------------------------------------------------------------
 * 为什么不再直接用单字合成：
 *   把单个汉字丢给 TTS，引擎会按「孤立字」的方式发音（元音拖长、声调夸张、偶发送气偏差），
 *   实测「聚」被读得近似「去」，孩子听了会以为错了。正确做法是让它在一个词里自然说出，
 *   再从音频里把目标音节切出来——这也是词典 App 的通行做法。
 *
 * 做法（共享内核见 scripts/syllable-voice-lib.mjs，家长后台在线重新生成走同一套逻辑）：
 *   1. 遍历 data/missions.json，收集所有「声母+介母+韵母+声调」组合（音节）及其汉字。
 *   2. 为每个音节挑一个载波词（词库自带的词组，目标字在词中位置已知）：
 *        · 目标字在词首 → 取第一个音节；在词尾 → 取最后一个音节；在中间 → 取中间音节。
 *   3. 合成载波词 WAV → 由能量包络找出音节间的静音谷 → 按目标位置切出该音节（带淡入淡出）。
 *   4. 切不出清晰谷（连读太紧）时退回单字合成并裁掉首尾静音，记录告警。
 *
 * 输出：public/audio/voice/{音节}{声调}.wav（如 ju4.wav / lv4.wav，ü→v 与 part/ 一致）
 * 这是 AI 源：只写根目录，lib/ 真人录音绝不触碰（双源切换见 server.js voice-source）。
 * 客户端 audio-engine 优先加载本地 wav，其次旧 mp3，最后才现场 TTS。
 *
 * 用法：
 *   node scripts/gen-syllable-voice.mjs                 # 生成缺失的音节
 *   node scripts/gen-syllable-voice.mjs --force         # 全部重新生成
 *   node scripts/gen-syllable-voice.mjs --only ju4,zhi1 --dry-run
 *   node scripts/gen-syllable-voice.mjs --verify        # 生成后抽样 ASR 回读（人工复核）
 *   --voice <音色>  默认 longanhuan_v3.6
 *   --carrier       载波模式（从词组里切音节；默认单字模式）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  collectSyllables, fileKey, planLabel, renderSyllableWav, ttsFetch,
} from './syllable-voice-lib.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'public', 'audio', 'voice');
fs.mkdirSync(OUT, { recursive: true });

const args = process.argv.slice(2);
const getArg = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const VOICE = getArg('voice', 'longanhuan_v3.6');
const ONLY = getArg('only', '');
const FORCE = args.includes('--force');
const VERIFY = args.includes('--verify');
const DRY = args.includes('--dry-run');
/** 载波模式：从词组里切出音节（语流更自然，但连读紧时可能切不准；默认关闭走单字）。 */
const CARRIER = args.includes('--carrier');

const BASE = 'https://token-plan.cn-beijing.maas.aliyuncs.com';
const MODEL = 'qwen-audio-3.0-tts-plus';
const credFile = path.join(process.env.DSH_HOME || 'C:\\Users\\panft\\.dsh', '.credentials.yaml');
const cred = fs.existsSync(credFile) ? fs.readFileSync(credFile, 'utf8') : '';
const KEY = process.env.QWEN_TOKEN_PLAN_CN_API_KEY || (cred.match(/QWEN_TOKEN_PLAN_CN_API_KEY:\s*(\S+)/) || [])[1];
if (!KEY && !DRY) { console.error('未找到 TTS API Key（QWEN_TOKEN_PLAN_CN_API_KEY）'); process.exit(1); }

const HEADERS = { 'Authorization': 'Bearer ' + KEY, 'Content-Type': 'application/json' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ttsWav = (text) => ttsFetch({ url: BASE + '/api/v1/services/audio/tts/SpeechSynthesizer', key: KEY, model: MODEL, voice: VOICE, text, format: 'wav' });

/* ----------------------------- ASR 回读校验 ----------------------------- */

async function asrText(wavBuf) {
  const dataUri = 'data:audio/wav;base64,' + wavBuf.toString('base64');
  const r = await fetch(BASE + '/api/v1/services/aigc/multimodal-generation/generation', {
    method: 'POST', headers: HEADERS,
    body: JSON.stringify({
      model: 'qwen-audio-3.0-asr-flash',
      input: { messages: [{ role: 'user', content: [
        { type: 'text', text: '这是普通话拼音教学录音，请逐字转写为中文汉字。' },
        { type: 'audio', audio: dataUri, format: 'wav' }] }] },
      parameters: { format: 'wav', sample_rate: 24000, asr_options: { enable_itn: false } },
    }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.message || ('ASR HTTP ' + r.status));
  return String(j.text ?? j.output?.text ?? '').replace(/[。，、！？\s]/g, '');
}

/* ----------------------------- 音节与载波词 ----------------------------- */

const missions = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'missions.json'), 'utf8'));
const bySyllable = collectSyllables(missions);

/* ----------------------------- 主流程 ----------------------------- */

const onlySet = ONLY ? new Set(ONLY.split(',').map((x) => x.trim())) : null;

/** 人工兜底表：data/voice-overrides.json，可为个别音节指定更合适的读音来源。 */
const OVERRIDE_PATH = path.join(ROOT, 'data', 'voice-overrides.json');
const OVERRIDES = fs.existsSync(OVERRIDE_PATH) ? JSON.parse(fs.readFileSync(OVERRIDE_PATH, 'utf8')) : {};

const rows = [];
let ok = 0, skip = 0, fail = 0;
const failures = [];
const warnings = [];

const targets = [...bySyllable.values()]
  .filter((r) => !onlySet || onlySet.has(r.key) || onlySet.has(fileKey(r.key)))
  .sort((a, b) => a.key.localeCompare(b.key));

console.log(`音色 ${VOICE} · 音节 ${targets.length} 个${CARRIER ? ' · 载波模式' : ' · 单字模式'}${DRY ? ' · dry-run' : ''}`);

for (const rec of targets) {
  const file = path.join(OUT, fileKey(rec.key) + '.wav');
  if (!FORCE && fs.existsSync(file) && fs.statSync(file).size > 2000) { skip++; continue; }
  const ov = OVERRIDES[rec.key] || OVERRIDES[fileKey(rec.key)] || null;
  const plan = planLabel(rec, ov, CARRIER);

  if (DRY) { rows.push({ key: rec.key, file: fileKey(rec.key) + '.wav', text: plan, note: 'dry-run' }); continue; }

  let done = false;
  for (let attempt = 1; attempt <= 2 && !done; attempt++) {
    try {
      const built = await renderSyllableWav(rec, { tts: ttsWav, override: ov, carrier: CARRIER });
      fs.writeFileSync(file + '.tmp', built.buf);
      fs.renameSync(file + '.tmp', file);
      ok++; done = true;
      rows.push({ key: rec.key, file: fileKey(rec.key) + '.wav', text: built.label, note: `${built.mode} ${built.durMs}ms` });
      if (built.warning) warnings.push(built.warning);

      if (VERIFY) {
        try {
          const got = await asrText(fs.readFileSync(file));
          const hit = got.includes(rec.hanzi) || [...rec.hanziSet].some((h) => got.includes(h));
          rows[rows.length - 1].asr = `${hit ? '✓' : '✗'}${got}`;
        } catch (e) { rows[rows.length - 1].asr = '校验失败'; }
      }
    } catch (e) {
      if (attempt === 2) { fail++; failures.push([rec.key, e.message]); }
      else await sleep(600);
    }
  }
  await sleep(120);
}

/* ----------------------------- 报告 ----------------------------- */

if (rows.length && (process.env.VERBOSE || rows.length <= 40)) {
  console.log('\n音节    文件         载波                      备注');
  for (const r of rows) {
    console.log(`${r.key.padEnd(7)} ${r.file.padEnd(12)} ${String(r.text).padEnd(24)} ${r.note}${r.asr ? '  ASR:' + r.asr : ''}`);
  }
}
console.log(`\n完成：新生成 ${ok} · 跳过 ${skip} · 失败 ${fail} · 目标 ${targets.length}${DRY ? '（dry-run 未写盘）' : ''}`);
if (warnings.length) console.log(`告警 ${warnings.length} 条（连读太紧按比例切）: ${warnings.slice(0, 8).join('；')}${warnings.length > 8 ? ' …' : ''}`);
if (failures.length) {
  console.error('失败明细:');
  for (const [k, msg] of failures) console.error(`  ${k}: ${msg}`);
  process.exit(1);
}
