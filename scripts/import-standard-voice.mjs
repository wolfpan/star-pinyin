/**
 * import-standard-voice.mjs — 导入 audio-cmn 真人音节库，替代 TTS 合成的音节读音
 * ------------------------------------------------------------------
 * 为什么换源：TTS 读孤立音节会声调漂移/误读，载波连读又切不干净（见 gen-syllable-voice.mjs）。
 * 拼音音节是封闭集合，直接用现成真人录音库一次性根治：
 *   · 音源：https://github.com/hugolpz/audio-cmn （64k/syllabs，1707 个带调音节全覆盖）
 *   · 录音：王晨 Chen Wang（母语者），Shtooka 项目 · 授权 CC-BY-SA 3.0（需署名，见 CREDITS.md）
 *   · 命名 cmn-{拼音}{声调}.mp3，ü→v 与本项目 fileKey 完全一致（如 lü4 → cmn-lv4.mp3）
 *
 * 流程：下载 mp3 缓存到 data/voice-lib/cmn-64k/ → ffmpeg 解码 24kHz 单声道 WAV →
 *       裁首尾静音（segmentFor）→ 归一化响度 → 700ms 封顶淡出 → 16-bit PCM WAV。
 * 输出：public/audio/voice/lib/{拼音}{声调}.wav —— 真人源独立目录，
 *       后台「重新生成」（AI TTS）只写根目录，永不覆盖这里；播哪份由 voice-source 配置决定。
 * 库里缺失的音节（404）保留现有 TTS 读音兜底，绝不留缺文件。
 *
 * 构建期依赖 ffmpeg（tools/ffmpeg/ffmpeg.exe 或 PATH 或 --ffmpeg 指定）；运行时仍零依赖。
 *
 * 用法：
 *   node scripts/import-standard-voice.mjs                 # 导入缺失的音节（跳过已有 wav）
 *   node scripts/import-standard-voice.mjs --force         # 全部换成库录音
 *   node scripts/import-standard-voice.mjs --only ju4,sen1 --force
 *   node scripts/import-standard-voice.mjs --dry-run       # 只报覆盖率，不联网不写盘
 *
 * 报告落盘 data/voice-import-report.json（覆盖率 / 缺失 / 失败明细）。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  collectSyllables, fileKey, parseWav, encodeWav,
  normalizeSamples, capDuration, segmentFor, sliceWithFade,
} from './syllable-voice-lib.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

export const LIB_REPO = 'https://github.com/hugolpz/audio-cmn';
export const LIB_RAW = 'https://raw.githubusercontent.com/hugolpz/audio-cmn/master/64k/syllabs/';
export const LIB_LICENSE = 'CC-BY-SA-3.0';
export const LIB_SPEAKER = 'Chen Wang (王晨)';

/** 音节键 → 库文件名（ü→v 后加 cmn- 前缀），如 lü4 → cmn-lv4.mp3。 */
export const libFileName = (key) => `cmn-${fileKey(key)}.mp3`;
export const libUrl = (key) => LIB_RAW + libFileName(key);
export const libUrlFor = (name) => LIB_RAW + name;

/**
 * 在库文件清单里解析实际文件名。库命名基本与 fileKey 一致，仅个别异类
 * （如 ju4 存成 cmn-jv4.mp3）：j/q/x/y 后的 u 只能是 ü，u↔v 两种写法都试。
 * n/l 后的 v（nü/lü）不做 u 回退——lu/nv 是不同音节，回退会读错。
 * @returns {string|null} 库文件名；null = 库里没有
 */
export function resolveLibName(key, nameSet) {
  const fk = fileKey(key);
  const canon = `cmn-${fk}.mp3`;
  if (nameSet.has(canon)) return canon;
  const base = fk.slice(0, -1), tone = fk.slice(-1);
  if (/^[jqxy]/.test(base)) {
    const alt = `cmn-${base.replace(/u/g, 'V').replace(/v/g, 'u').replace(/V/g, 'v')}${tone}.mp3`;
    if (nameSet.has(alt)) return alt;
  }
  return null;
}

/** 库文件清单（1707 个文件名）：优先本地缓存，缺失时经 GitHub API 拉取并落盘。 */
export async function loadLibIndex(cacheFile) {
  if (fs.existsSync(cacheFile)) {
    return new Set(JSON.parse(fs.readFileSync(cacheFile, 'utf8')));
  }
  const dirRes = await fetch('https://api.github.com/repos/hugolpz/audio-cmn/contents/64k');
  if (!dirRes.ok) throw new Error('GitHub API HTTP ' + dirRes.status);
  const dir = (await dirRes.json()).find((x) => x.name === 'syllabs');
  if (!dir) throw new Error('库里找不到 64k/syllabs 目录');
  const treeRes = await fetch('https://api.github.com/repos/hugolpz/audio-cmn/git/trees/' + dir.sha);
  if (!treeRes.ok) throw new Error('GitHub trees API HTTP ' + treeRes.status);
  const tree = await treeRes.json();
  if (tree.truncated) throw new Error('文件清单被截断，无法对账');
  const names = tree.tree.map((x) => x.path).filter((n) => n.endsWith('.mp3'));
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  fs.writeFileSync(cacheFile, JSON.stringify(names));
  return new Set(names);
}

/* ----------------------------- ffmpeg ----------------------------- */

/** 找可用的 ffmpeg：--ffmpeg 参数 / FFMPEG 环境变量 / tools/ffmpeg/ / PATH。 */
export function findFfmpeg(explicit) {
  const candidates = [
    explicit, process.env.FFMPEG,
    path.join(ROOT, 'tools', 'ffmpeg', 'ffmpeg.exe'),
    path.join(ROOT, 'tools', 'ffmpeg', 'ffmpeg'),
    'ffmpeg',
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      // stdio:'ignore'：受限沙箱里管道捕获会 EPERM，探测只需退出码
      const r = spawnSync(c, ['-version'], { stdio: 'ignore', timeout: 10000 });
      if (r.status === 0) return c;
    } catch { /* 下一个候选 */ }
  }
  return null;
}

/** mp3 → 标准音节 WAV（裁静音 + 归一化 + 封顶），与 TTS 流水线同一套后处理。 */
export function wavFromMp3File(mp3Path, ffmpeg, tmpDir = os.tmpdir()) {
  const tmpWav = path.join(tmpDir, `star-pinyin-import-${process.pid}-${Date.now()}.wav`);
  const r = spawnSync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', mp3Path, '-ar', '24000', '-ac', '1', '-c:a', 'pcm_s16le', '-f', 'wav', tmpWav,
  ], { stdio: 'ignore', timeout: 30000 });
  if (r.status !== 0) throw new Error(`ffmpeg 解码失败 (exit ${r.status}${r.error ? ' ' + r.error.message : ''})`);
  try {
    const { rate, s } = parseWav(fs.readFileSync(tmpWav));
    const seg = segmentFor(s, rate, 1, 0);
    let samples = sliceWithFade(s, rate, seg.from, seg.to);
    samples = normalizeSamples(samples);
    samples = capDuration(samples, rate);
    const durMs = Math.round(samples.length / rate * 1000);
    if (durMs < 120 || durMs > 1200) throw new Error(`时长异常 ${durMs}ms`);
    return { buf: encodeWav(samples, rate), durMs };
  } finally {
    fs.rmSync(tmpWav, { force: true });
  }
}

/* ----------------------------- 下载 ----------------------------- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 下载一个音节 mp3 到缓存；name 为清单解析出的实际库文件名。
 *  主通道 raw.githubusercontent（重试 2 次）；网络抖动时兜底走 GitHub contents API（base64）。
 *  404 → {missing:true}（库里没有，保留 TTS 兜底）。 */
export async function fetchLib(key, dest, name) {
  const file = name || libFileName(key);
  const save = (buf) => {
    if (buf.length < 500) throw new Error(`文件过小 ${buf.length}B`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest + '.tmp', buf);
    fs.renameSync(dest + '.tmp', dest);
    return { missing: false };
  };
  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const r = await fetch(libUrlFor(file), { signal: AbortSignal.timeout(30000) });
      if (r.status === 404) return { missing: true };
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return save(Buffer.from(await r.arrayBuffer()));
    } catch (e) {
      lastErr = e;
      await sleep(400 * attempt);
    }
  }
  /* 兜底：contents API 返回 base64（<1MB 文件），绕开 raw 域名的连接抖动 */
  try {
    const r = await fetch('https://api.github.com/repos/hugolpz/audio-cmn/contents/64k/syllabs/' + file, { signal: AbortSignal.timeout(30000) });
    if (r.status === 404) return { missing: true };
    if (!r.ok) throw new Error('API HTTP ' + r.status);
    const j = await r.json();
    if (j.encoding !== 'base64' || !j.content) throw new Error('API 无 base64 内容');
    return save(Buffer.from(j.content, 'base64'));
  } catch (e) {
    throw new Error(`${lastErr.message}（API 兜底亦失败: ${e.message}）`);
  }
}

/** 并发池：最多 n 个同时跑，保持结果顺序。 */
async function pool(items, n, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}

/* ----------------------------- 主流程（仅直接运行时执行） ----------------------------- */

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

async function main() {
  const args = process.argv.slice(2);
  const getArg = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
  const ONLY = getArg('only', '');
  const FORCE = args.includes('--force');
  const DRY = args.includes('--dry-run');
  const OUT = process.env.VOICE_OUT_DIR || path.join(ROOT, 'public', 'audio', 'voice');
  const LIB_OUT = path.join(OUT, 'lib');   // 真人源独立目录（AI 重新生成不触碰）
  const LIB_DIR = path.join(ROOT, 'data', 'voice-lib', 'cmn-64k');
  fs.mkdirSync(LIB_OUT, { recursive: true });

  const missions = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'missions.json'), 'utf8'));
  const bySyllable = collectSyllables(missions);
  const onlySet = ONLY ? new Set(ONLY.split(',').map((x) => x.trim())) : null;
  const targets = [...bySyllable.values()]
    .filter((r) => !onlySet || onlySet.has(r.key) || onlySet.has(fileKey(r.key)))
    .sort((a, b) => a.key.localeCompare(b.key));

  const wavPath = (key) => path.join(LIB_OUT, fileKey(key) + '.wav');
  const mp3Path = (key) => path.join(LIB_DIR, fileKey(key) + '.mp3');
  const hasWav = (key) => fs.existsSync(wavPath(key)) && fs.statSync(wavPath(key)).size > 2000;
  const hasMp3 = (key) => fs.existsSync(mp3Path(key)) && fs.statSync(mp3Path(key)).size > 500;

  console.log(`音源 audio-cmn（${LIB_SPEAKER} · ${LIB_LICENSE}）· 音节 ${targets.length} 个${FORCE ? ' · 强制覆盖' : ''}${DRY ? ' · dry-run' : ''}`);

  const INDEX_CACHE = path.join(ROOT, 'data', 'voice-lib', 'syllabs-filelist.json');

  /* dry-run：只报本地状态；有清单缓存时顺带报真实库覆盖率，不联网不写盘 */
  if (DRY) {
    let skip = 0, cached = 0, need = 0;
    for (const rec of targets) {
      if (!FORCE && hasWav(rec.key)) { skip++; continue; }
      if (hasMp3(rec.key)) cached++; else need++;
    }
    console.log(`覆盖计划：已有 wav 跳过 ${skip} · 本地缓存可转 ${cached} · 需下载 ${need} · 目标 ${targets.length}`);
    if (fs.existsSync(INDEX_CACHE)) {
      const nameSet = new Set(JSON.parse(fs.readFileSync(INDEX_CACHE, 'utf8')));
      const gaps = targets.filter((rec) => !resolveLibName(rec.key, nameSet)).map((r) => r.key);
      console.log(`库覆盖率：${targets.length - gaps.length}/${targets.length}${gaps.length ? ' · 缺失 ' + gaps.join(', ') : '（全覆盖）'}`);
    } else {
      console.log('（无清单缓存，库覆盖率以实际导入报告为准）');
    }
    return;
  }

  const ffmpeg = findFfmpeg(getArg('ffmpeg', ''));
  if (!ffmpeg) {
    console.error('未找到 ffmpeg：请放到 tools/ffmpeg/ffmpeg.exe，或 PATH，或 --ffmpeg <路径> 指定');
    process.exit(1);
  }

  /* 库文件清单对账：解析每个音节的实际文件名（含 ju4→jv4 一类命名异类） */
  const nameSet = await loadLibIndex(INDEX_CACHE);
  const work = targets.filter((rec) => FORCE || !hasWav(rec.key));
  const skipped = targets.length - work.length;
  const nameMap = new Map();
  const missing = new Set();
  const variants = [];
  for (const rec of work) {
    const name = resolveLibName(rec.key, nameSet);
    if (!name) { missing.add(rec.key); continue; }
    nameMap.set(rec.key, name);
    if (name !== libFileName(rec.key)) variants.push({ key: rec.key, name });
  }

  /* 阶段 1：补齐 mp3 缓存（并发 6；404 记为缺失） */
  const toDownload = work.filter((rec) => nameMap.has(rec.key) && !hasMp3(rec.key));
  console.log(`需导入 ${work.length} · 跳过 ${skipped} · 待下载 ${toDownload.length} · 库缺失 ${missing.size}${variants.length ? ' · 命名变体 ' + variants.map((v) => v.key + '→' + v.name).join(', ') : ''}`);
  const dlFail = new Map();
  await pool(toDownload, 6, async (rec) => {
    try {
      const r = await fetchLib(rec.key, mp3Path(rec.key), nameMap.get(rec.key));
      if (r.missing) missing.add(rec.key);
    } catch (e) {
      dlFail.set(rec.key, e.message);
    }
  });

  /* 阶段 2：逐个解码转 WAV（与现有流水线同一套后处理） */
  const imported = [];
  const failed = [];
  for (const [key, msg] of dlFail) failed.push({ key, error: '下载失败: ' + msg });
  let done = 0;
  for (const rec of work) {
    if (missing.has(rec.key) || dlFail.has(rec.key)) continue;
    try {
      const built = wavFromMp3File(mp3Path(rec.key), ffmpeg);
      const file = wavPath(rec.key);
      fs.writeFileSync(file + '.tmp', built.buf);
      fs.renameSync(file + '.tmp', file);
      imported.push({ key: rec.key, durMs: built.durMs });
    } catch (e) {
      failed.push({ key: rec.key, error: e.message });
    }
    done++;
    if (done % 100 === 0) console.log(`  转码进度 ${done}/${work.length - missing.size - dlFail.size}`);
  }

  /* 报告 */
  const report = {
    updatedAt: new Date().toISOString(),
    source: LIB_REPO, license: LIB_LICENSE, speaker: LIB_SPEAKER,
    totals: { targets: targets.length, imported: imported.length, skipped, missing: missing.size, failed: failed.length },
    missing: [...missing].sort(),
    variants,
    failed,
    importedKeys: imported.map((r) => r.key),
  };
  fs.writeFileSync(path.join(ROOT, 'data', 'voice-import-report.json'), JSON.stringify(report, null, 2));

  console.log(`\n完成：导入 ${imported.length} · 跳过 ${skipped} · 库缺失 ${missing.size} · 失败 ${failed.length} · 目标 ${targets.length}`);
  if (missing.size) console.log(`库缺失（保留现有 TTS 读音兜底）: ${[...missing].sort().join(', ')}`);
  if (failed.length) {
    console.error('失败明细:');
    for (const f of failed) console.error(`  ${f.key}: ${f.error}`);
    process.exit(1);
  }
}

if (isMain) {
  main().catch((e) => { console.error(e); process.exit(1); });
}