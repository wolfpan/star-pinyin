/**
 * gen-system-voice.mjs — 预生成「全局真人语音」缓存（系统提示 + 简报短语 + 倒计时 + 呼读音）。
 * 写入 data/voice-cache/{sha1(voice|text)}.mp3，与服务端 /api/tts 缓存命名一致 → 即时播放。
 * 用法：node scripts/gen-system-voice.mjs [--voice <音色>] [--force] [--concurrency 5]
 *   音色按服务端 ttsSettings() 的同一口径解析：--voice > data/tts-config.json.voice >
 *   TTS_VOICE > 默认 longanhuan_v3.6。两边必须一致，否则缓存文件名哈希不同、/api/tts 永远 miss。
 *   --concurrency N  并行合成的条数（默认 1 = 串行，稳妥）；2297 条全量预热建议 5~8
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const CACHE = path.join(ROOT, 'data', 'voice-cache');
fs.mkdirSync(CACHE, { recursive: true });
const args = process.argv.slice(2);
const vi = args.indexOf('--voice');
const FORCE = args.includes('--force');
const ci = args.indexOf('--concurrency');
const CONCURRENCY = Math.max(1, Math.min(16, parseInt(ci >= 0 ? args[ci + 1] : '1', 10) || 1));

/** 与服务端 ttsSettings() 同口径解析音色：显式参数 > 家长后台配置 > 环境变量 > 默认。 */
function resolveVoice() {
  const explicit = vi >= 0 ? (args[vi + 1] || '').trim() : '';
  if (explicit) return [explicit, '--voice 参数'];
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'tts-config.json'), 'utf8'));
    const v = typeof cfg.voice === 'string' ? cfg.voice.trim() : '';
    if (v) return [v, 'data/tts-config.json'];
  } catch { /* 没有配置文件就用下一档 */ }
  const env = (process.env.TTS_VOICE || '').trim();
  if (env) return [env, 'TTS_VOICE 环境变量'];
  return ['longanhuan_v3.6', '默认值'];
}
const [VOICE, VOICE_FROM] = resolveVoice();
const MODEL = 'qwen-audio-3.0-tts-plus';
const URL = 'https://token-plan.cn-beijing.maas.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer';
const cred = fs.readFileSync(path.join(process.env.DSH_HOME || 'C:\\Users\\panft\\.dsh', '.credentials.yaml'), 'utf8');
const KEY = (cred.match(/QWEN_TOKEN_PLAN_CN_API_KEY:\s*(\S+)/) || [])[1];
if (!KEY) { console.error('未找到 API Key'); process.exit(1); }

const missions = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'missions.json'), 'utf8'));
const badges = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'badges.json'), 'utf8'));

// 固定系统提示
const fixed = [
  '进入指挥中心', '组装完成', '姿态不符，再试一次', '请先安装声母',
  '三，二，一，点火！', '校准成功', '入轨成功', '笔画太短，请画长一些',
  '三', '二', '一', '点火',
];
// 呼读音（声母/介母/韵母）——与 audio-engine.PINYIN_READ 保持一致（降级兜底用）。
// 注：零件标准读音已由 gen-part-voice.mjs 预生成到 public/audio/voice/part/（更准确），
//     这里的汉字读音仅作本地零件文件缺失时的服务端兜底缓存。
const reads = ['玻','坡','摸','佛','德','特','讷','乐','哥','科','喝','基','欺','希','知','吃','诗','日','资','雌','思','衣','乌','迂','啊','喔','鹅','哀','诶','威','熬','欧','忧','耶','约','儿','安','恩','因','温','晕','昂','鞥','英','翁'];
// 每题简报短语
const briefings = missions.map((m) => `载荷确认：${m.word}的${m.hanzi}`);
// 机库自选座驾时只播火箭名（不带「准备发射」）
const rocketNames = (badges.badges || badges).map((b) => b.name);

const texts = [...new Set([...rocketNames, ...fixed, ...reads, ...briefings])];
const cachePath = (t) => path.join(CACHE, crypto.createHash('sha1').update(`${VOICE}|${t}`).digest('hex') + '.mp3');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function synth(text) {
  const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), 45000);
  try {
    const res = await fetch(URL, { method: 'POST', signal: ctrl.signal, headers: { 'Authorization': 'Bearer ' + KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, input: { text, voice: VOICE, format: 'mp3', sample_rate: 24000 } }) });
    const j = await res.json();
    if (!res.ok) throw new Error(j.message || ('HTTP ' + res.status));
    const u = j.output?.audio?.url; if (!u) throw new Error('无 audio.url');
    const a = await fetch(u, { signal: ctrl.signal }); if (!a.ok) throw new Error('下载 HTTP ' + a.status);
    return Buffer.from(await a.arrayBuffer());
  } finally { clearTimeout(timer); }
}

let ok = 0, skip = 0, fail = 0; const failures = [];
console.log(`音色 ${VOICE}（来源：${VOICE_FROM}）· 待生成 ${texts.length} 条语音缓存 · 并发 ${CONCURRENCY}`);

async function handleOne(t) {
  const f = cachePath(t);
  if (!FORCE && fs.existsSync(f) && fs.statSync(f).size > 1000) { skip++; return; }
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const buf = await synth(t);
      if (buf.length < 1000) throw new Error('音频过小');
      fs.writeFileSync(f + '.tmp', buf); fs.renameSync(f + '.tmp', f);
      ok++; console.log(`✓ ${t}  (${buf.length}b)`);
      return;
    } catch (e) {
      if (attempt === 3) { fail++; failures.push([t, e.message]); console.log(`✗ ${t}  ${e.message}`); }
      else await sleep(800 * attempt);
    }
  }
}

let cursor = 0;
const workers = Array.from({ length: CONCURRENCY }, async () => {
  while (cursor < texts.length) {
    const t = texts[cursor++];
    await handleOne(t);
    if (CONCURRENCY === 1) await sleep(200);
  }
});
await Promise.all(workers);
console.log(`\n完成：新生成 ${ok} · 跳过 ${skip} · 失败 ${fail} · 共 ${texts.length}`);
if (failures.length) { console.error('失败：', failures); process.exit(1); }
