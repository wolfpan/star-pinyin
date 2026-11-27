/**
 * debug-import-voice.mjs — 真人库导入后的 ASR 抽检（人工复核辅助）
 * ------------------------------------------------------------------
 * 对导入的音节 wav 抽样做 ASR 回读：转写命中该音节的任一词库汉字即 ✓。
 * 默认抽：发音自检标记 + override 表 + ü 系 + 随机，共约 30 个。
 * 注意：ASR 对孤立音节存在同音/声调近似（见 public/audio/voice/README.md），
 *       ✗ 不代表读音一定错，需人工复听；只输出报告，不改任何文件。
 *
 * 用法：node scripts/debug-import-voice.mjs [--sample 20] [--keys ju4,xie1]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectSyllables, fileKey } from './syllable-voice-lib.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const OUT = process.env.VOICE_OUT_DIR || path.join(ROOT, 'public', 'audio', 'voice');

const args = process.argv.slice(2);
const getArg = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const SAMPLE = Number(getArg('sample', '20'));
const KEYS = getArg('keys', '');

const BASE = 'https://token-plan.cn-beijing.maas.aliyuncs.com';
const credFile = path.join(process.env.DSH_HOME || 'C:\\Users\\panft\\.dsh', '.credentials.yaml');
const cred = fs.existsSync(credFile) ? fs.readFileSync(credFile, 'utf8') : '';
const KEY = process.env.QWEN_TOKEN_PLAN_CN_API_KEY || (cred.match(/QWEN_TOKEN_PLAN_CN_API_KEY:\s*(\S+)/) || [])[1];
if (!KEY) { console.error('未找到 ASR API Key（QWEN_TOKEN_PLAN_CN_API_KEY）'); process.exit(1); }

async function asrText(wavBuf) {
  const dataUri = 'data:audio/wav;base64,' + wavBuf.toString('base64');
  const r = await fetch(BASE + '/api/v1/services/aigc/multimodal-generation/generation', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + KEY, 'Content-Type': 'application/json' },
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

const missions = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'missions.json'), 'utf8'));
const bySyllable = collectSyllables(missions);
const flags = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'voice-flags.json'), 'utf8')).keys || [];
const overrides = Object.keys(JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'voice-overrides.json'), 'utf8')));
const vKeys = [...bySyllable.keys()].filter((k) => k.includes('ü'));

const pick = new Set(KEYS ? KEYS.split(',').map((x) => x.trim()) : [...flags, ...overrides, ...vKeys]);
const rest = [...bySyllable.keys()].filter((k) => !pick.has(k));
for (let i = 0; i < SAMPLE && rest.length; i++) {
  pick.add(rest.splice(Math.floor(Math.random() * rest.length), 1)[0]);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let hit = 0, miss = 0, err = 0;
console.log(`ASR 抽检 ${pick.size} 个音节（✓=转写命中词库汉字；✗=需人工复听，不一定是读音错）`);
for (const key of [...pick].sort()) {
  const rec = bySyllable.get(key);
  if (!rec) { console.log(`  ? ${key} 不在词库`); continue; }
  const file = path.join(OUT, fileKey(key) + '.wav');
  if (!fs.existsSync(file)) { console.log(`  ? ${key} 无 wav`); continue; }
  try {
    const got = await asrText(fs.readFileSync(file));
    const ok = [...rec.hanziSet].some((h) => got.includes(h));
    console.log(`  ${ok ? '✓' : '✗'} ${key.padEnd(7)} → ${got || '(空)'}   词库字: ${[...rec.hanziSet].slice(0, 6).join('')}`);
    ok ? hit++ : miss++;
  } catch (e) {
    console.log(`  ! ${key} ASR 失败: ${e.message}`);
    err++;
  }
  await sleep(150);
}
console.log(`\n命中 ${hit} · 待复听 ${miss} · ASR 失败 ${err}`);