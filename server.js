/**
 * server.js — 星际发射指挥官 后端入口（零编译依赖，原生 Node http）
 * ------------------------------------------------------------------
 * 职责：
 *  - 静态托管 public/（iPad Safari PWA 客户端）。
 *  - 提供 REST API：抽题（加权随机）、作答上报、玩家档案、家长词库管理。
 *  - 数据持久化到本地 JSON 文件，支持家长直接编辑 / 后台热注入（每次请求重新读取）。
 *
 * 运行：node server.js   （默认 0.0.0.0:3000，可用环境变量 PORT 覆盖）
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { validateMission, categoryOf } from './public/js/pinyin-rules.js';
import {
  byUnlockAt, isStarterBadge, ownedRocketIds, ownedRockets, resolveCurrentRocket, canSelectRocket, rocketIdsForUnits,
} from './public/js/rocket-select.js';
import { DESTINATIONS, destinationForLevel } from './public/js/destinations.js';
import {
  rewardLevelForLessons, nextRewardForLessons, lessonProgress, lessonKey,
} from './public/js/rewards.js';
import {
  validateSelection, filterMissionsByTextbook, formatSelection, countAllowed, unitKey,
} from './public/js/textbook.js';
import {
  buildUnitQueue, unitSessionView, updateWrongStat, unitLabel,
  clampUnitTotal, UNIT_TOTAL_MIN, UNIT_TOTAL_MAX, UNIT_TOTAL_DEFAULT,
} from './public/js/unit-session.js';
import {
  collectSyllables, fileKey, renderSyllableWav, ttsFetch,
} from './scripts/syllable-voice-lib.mjs';
import {
  TTS_MODEL_CATALOG, DEFAULT_TTS_MODEL, isTtsModel, ttsModelLabel, voicesForModel, defaultVoiceFor,
} from './public/js/tts-catalog.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
// DATA_DIR 可用环境变量覆盖（测试在隔离副本上跑，不动真实玩家数据）。
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

/* ----------------------------- TTS 真人语音代理 ----------------------------- */
// 全局真人语音：任意文本经 Qwen-Audio-TTS 合成并磁盘缓存，客户端 /api/tts?text= 取用。
// API 地址 / Key / 模型 / 音色可由家长在「发音」页「TTS合成API设置」面板自行填入（data/tts-config.json，
// 已加入 .gitignore 绝不入库）；未填时退回环境变量 / DSH 凭据文件。
const VOICE_CACHE_DIR = path.join(DATA_DIR, 'voice-cache');
const TTS_URL_DEFAULT = 'https://token-plan.cn-beijing.maas.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer';
const TTS_MODEL_DEFAULT = 'qwen-audio-3.0-tts-plus';
const TTS_VOICE_DEFAULT = 'longanhuan_v3.6';
// 音节读音输出目录（默认 public/audio/voice；测试可用 VOICE_OUT_DIR 隔离，不碰真实素材）。
const VOICE_OUT_DIR = process.env.VOICE_OUT_DIR || path.join(PUBLIC_DIR, 'audio', 'voice');
// 双发音源并存：lib/ = 真人录音库（audio-cmn 导入，「重新生成」永不覆盖）；
// 根目录 {音节}.wav = AI TTS 合成（「重新生成」只写这里）。播哪份由 data/voice-source.json 决定。
const VOICE_LIB_DIR = path.join(VOICE_OUT_DIR, 'lib');
fs.mkdirSync(VOICE_CACHE_DIR, { recursive: true });
fs.mkdirSync(VOICE_OUT_DIR, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const loadTtsConfig = () => readJson('tts-config', {});

/** 读取兜底 API Key：环境变量，其次 DSH 凭据文件（绝不写入仓库）。 */
function envTtsKey() {
  if (process.env.QWEN_TOKEN_PLAN_CN_API_KEY) return process.env.QWEN_TOKEN_PLAN_CN_API_KEY;
  if (process.env.TTS_API_KEY) return process.env.TTS_API_KEY;
  const credFile = process.env.TTS_CREDENTIALS_FILE
    || path.join(process.env.DSH_HOME || 'C:\\Users\\panft\\.dsh', '.credentials.yaml');
  try {
    const m = fs.readFileSync(credFile, 'utf8').match(/QWEN_TOKEN_PLAN_CN_API_KEY:\s*(\S+)/);
    if (m) return m[1];
  } catch {}
  return null;
}

/** 当前生效的 TTS 设置：家长后台填写优先，其次环境变量，最后内置默认。 */
function ttsSettings() {
  const cfg = loadTtsConfig();
  const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : '');
  return {
    url: str(cfg.url) || TTS_URL_DEFAULT,
    model: str(cfg.model) || process.env.TTS_MODEL || TTS_MODEL_DEFAULT,
    voice: str(cfg.voice) || process.env.TTS_VOICE || TTS_VOICE_DEFAULT,
    key: str(cfg.key) || envTtsKey(),
  };
}

/** Key 打码（接口只回显掩码，绝不回传完整 Key）。 */
const maskKey = (k) => (!k ? '' : k.length <= 8 ? '****' : k.slice(0, 4) + '****' + k.slice(-4));

/** 家长后台可读取的设置视图（不含明文 Key）。 */
function ttsConfigView() {
  const s = ttsSettings();
  const cfg = loadTtsConfig();
  return {
    url: s.url, model: s.model, voice: s.voice,
    hasKey: !!s.key, keyHint: maskKey(s.key),
    keyFrom: cfg.key ? 'admin' : (s.key ? 'env' : null),
  };
}

const voiceCachePath = (text, voice) => path.join(VOICE_CACHE_DIR, crypto.createHash('sha1').update(`${voice}|${text}`).digest('hex') + '.mp3');

/** 调用 TTS 合成并返回音频 Buffer（默认 mp3；音节重新生成用 wav）。 */
async function synthesizeVoice(text, voice, format = 'mp3') {
  const s = ttsSettings();
  if (!s.key) throw new Error('未配置 TTS API Key（请在家长端「TTS合成API设置」填入 API 与 Key）');
  return ttsFetch({ url: s.url, key: s.key, model: s.model, voice: voice || s.voice, text, format });
}

/** 取缓存或合成，返回 mp3 Buffer。 */
async function getVoice(text, voice) {
  const file = voiceCachePath(text, voice);
  try { if (fs.statSync(file).size > 1000) return fs.readFileSync(file); } catch {}
  const buf = await synthesizeVoice(text, voice);
  if (buf.length > 1000) { fs.writeFileSync(file + '.tmp', buf); fs.renameSync(file + '.tmp', file); }
  return buf;
}

/** 测试合成试读文本：「测试成功」+ 单韵母 a o e i u ü（TTS 读同音字 啊噢鹅衣乌鱼，ü 取「鱼」音）。 */
const TTS_TEST_TEXT = '测试成功。啊、噢、鹅、衣、乌、鱼。';
/** 按魔数判音频容器（个别接口请求 mp3 仍回 wav），供家长端以正确 MIME 播放。 */
const audioMime = (buf) => (buf.length > 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WAVE') ? 'audio/wav' : 'audio/mpeg';

/* ------------------------- TTS 接口自发现（模型 / 音色） ------------------------- */
// 家长在「TTS合成API设置」填好 API 地址 + Key 后，服务端替他去问接口要模型与音色：
//  · 模型：OpenAI 兼容的 GET {origin}/compatible-mode/v1/models、{origin}/v1/models
//    （百炼业务空间域名用前者，多数自建网关用后者），只读、不消耗合成额度；
//  · 音色：系统音色没有查询接口（百炼只有文档表格），所以用 public/js/tts-catalog.js 的
//    内置音色表兜底，再合并接口能列出的「自建 / 复刻音色」（百炼 customization action=list）。
// 返回给家长端时绝不回显明文 Key，也不落盘（保存仍走 /api/admin/tts-config）。
const DISCOVER_TIMEOUT_MS = 6000;

/** 由合成地址推导「模型列表」候选地址（按优先级）。 */
function modelListEndpoints(apiUrl) {
  let u;
  try { u = new URL(apiUrl); } catch { return []; }
  const out = [u.origin + '/compatible-mode/v1/models', u.origin + '/v1/models'];
  const m = u.pathname.match(/^(.*?\/v1)(?:\/|$)/);
  if (m) out.push(u.origin + m[1] + '/models');
  return [...new Set(out)];
}

/** 从各家 /models 返回里提取模型 id（兼容 OpenAI / 百炼 / 自研网关的常见形状）。 */
function extractModelIds(json) {
  const arr = Array.isArray(json) ? json
    : Array.isArray(json?.data) ? json.data
      : Array.isArray(json?.models) ? json.models
        : Array.isArray(json?.result) ? json.result : null;
  if (!arr) return [];
  const ids = arr.map((it) => (typeof it === 'string' ? it : (it?.id || it?.name || it?.model || '')));
  return [...new Set(ids.map((s) => String(s).trim()).filter(Boolean))];
}

const authJsonHeaders = (key) => ({ Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' });

/** 探测模型列表：并发试候选地址取第一个成功的；都失败时区分「Key 不对」与「接口不支持」。 */
async function probeTtsModels(apiUrl, key) {
  const endpoints = modelListEndpoints(apiUrl);
  const results = await Promise.all(endpoints.map(async (endpoint) => {
    try {
      const res = await fetch(endpoint, { headers: authJsonHeaders(key), signal: AbortSignal.timeout(DISCOVER_TIMEOUT_MS) });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch {}
      if (!res.ok) {
        return { endpoint, status: res.status, error: json?.message || json?.error?.message || text.slice(0, 120) };
      }
      return { endpoint, status: res.status, ids: extractModelIds(json) };
    } catch (e) {
      return { endpoint, status: 0, error: String(e?.message || e) };
    }
  }));
  const hit = results.find((r) => r.ids && r.ids.length);
  if (hit) return { ok: true, endpoint: hit.endpoint, ids: hit.ids, tried: results };
  const auth = results.find((r) => r.status === 401 || r.status === 403);
  if (auth) return { ok: false, auth: true, status: auth.status, endpoint: auth.endpoint, error: auth.error, tried: results };
  return { ok: false, tried: results };
}

/** 只有百炼系地址才有「自建 / 复刻音色列表」接口，别拿别家 API 乱打。 */
function looksLikeBailian(apiUrl) {
  try {
    const u = new URL(apiUrl);
    return /(^|\.)maas\.aliyuncs\.com$/i.test(u.hostname) || /aliyuncs\.com$/i.test(u.hostname)
      || /\/api\/v1\/services\/audio\/tts\//.test(u.pathname);
  } catch { return false; }
}

/** 尽力列出家长账号下的定制 / 复刻音色（接口不支持时静默返回空）。 */
async function probeTtsLiveVoices(apiUrl, key) {
  if (!looksLikeBailian(apiUrl)) return [];
  const endpoint = new URL(apiUrl).origin + '/api/v1/services/audio/tts/customization';
  for (const model of ['qwen-voice-enrollment', 'voice-enrollment']) {
    try {
      const res = await fetch(endpoint, {
        method: 'POST', headers: authJsonHeaders(key), signal: AbortSignal.timeout(DISCOVER_TIMEOUT_MS),
        body: JSON.stringify({ model, input: { action: 'list', page_index: 0, page_size: 100 } }),
      });
      if (!res.ok) continue;
      const j = await res.json();
      const list = j?.output?.voice_list || j?.output?.voices || [];
      const voices = list
        .map((v) => ({ id: v.voice || v.voice_id || v.id || '', label: v.prefix || v.name || '', model: v.target_model || '', source: 'api' }))
        .filter((v) => v.id);
      if (voices.length) return voices;
    } catch { /* 不支持就算了 */ }
  }
  return [];
}

/** 按音色 id 合并去重（内置表在前，接口音色在后）。 */
function mergeVoices(...groups) {
  const out = [], seen = new Set();
  for (const group of groups) {
    for (const v of group || []) {
      if (!v || !v.id || seen.has(v.id)) continue;
      seen.add(v.id);
      out.push(v);
    }
  }
  return out;
}

/** 选一个音色：家长原来的还在列表里就保留，否则用该模型默认音色，再否则列表首项。 */
function pickDiscoveredVoice(voices, requested, model) {
  const ids = new Set(voices.map((v) => v.id));
  if (requested && ids.has(requested)) return requested;
  const def = defaultVoiceFor(model);
  if (def && ids.has(def)) return def;
  return voices[0]?.id || (requested || '');
}

/* ----------------------------- 音节发音：双源（真人库 / AI）+ 状态与重新生成 ----------------------------- */

/** 发音源配置：default 全局默认源；keys 逐音节覆盖（fileKey → 'lib'|'tts'）。 */
function voiceSourceConfig() {
  const cfg = readJson('voice-source', {});
  return {
    default: cfg.default === 'tts' ? 'tts' : 'lib',
    keys: (cfg.keys && typeof cfg.keys === 'object' && !Array.isArray(cfg.keys)) ? cfg.keys : {},
  };
}

/** 某音节当前生效源（逐音节覆盖 > 全局默认）。 */
function voiceSourceFor(fk, cfg = voiceSourceConfig()) {
  const s = cfg.keys[fk];
  return (s === 'lib' || s === 'tts') ? s : cfg.default;
}

const wavOk = (file) => { try { return fs.statSync(file).size > 2000; } catch { return false; } };

/**
 * 解析音节 wav 的实际文件：首选源优先，缺了退回另一份（绝不留缺）。
 * explicit 供 ?src=lib|tts 强制试听某一源（家长 A/B 对比），不改配置。
 */
function resolveVoiceWav(fk, explicit) {
  const sel = (explicit === 'lib' || explicit === 'tts') ? explicit : voiceSourceFor(fk);
  const lib = path.join(VOICE_LIB_DIR, fk + '.wav');
  const tts = path.join(VOICE_OUT_DIR, fk + '.wav');
  const order = sel === 'lib' ? [lib, tts] : [tts, lib];
  for (const f of order) if (wavOk(f)) return f;
  return null;
}

/** 某音节当前本地文件状态（按生效源）：wav / mp3（旧版）/ tts（需现场合成）。 */
function syllableFileStatus(key) {
  const fk = fileKey(key);
  if (resolveVoiceWav(fk)) return 'wav';
  try { if (fs.statSync(path.join(VOICE_OUT_DIR, fk + '.mp3')).size > 1000) return 'mp3'; } catch {}
  return 'tts';
}

/** 全库音节发音状态 + 人工标记 + 双源信息（家长后台「发音自检」用，一次请求拿全）。 */
function voiceStatusView() {
  const syllables = collectSyllables(loadMissions());
  const files = {};
  const libKeys = [];
  const ttsKeys = [];
  for (const key of syllables.keys()) {
    files[key] = syllableFileStatus(key);
    const fk = fileKey(key);
    if (wavOk(path.join(VOICE_LIB_DIR, fk + '.wav'))) libKeys.push(key);
    if (wavOk(path.join(VOICE_OUT_DIR, fk + '.wav'))) ttsKeys.push(key);
  }
  const flags = readJson('voice-flags', { keys: [] }).keys || [];
  return { files, flags, source: voiceSourceConfig(), libKeys, ttsKeys };
}

/** 把用户传入的音节键归一到词库真实键（兼容 ü/v 两种写法）。 */
function canonicalKey(syllables, raw) {
  const k = String(raw || '').trim();
  if (syllables.has(k)) return k;
  const alt = k.replace(/v/g, 'ü');
  return syllables.has(alt) ? alt : null;
}

/**
 * 解析重新生成范围：显式 keys 优先；否则 scope = flagged（已标记）/ missing（缺 wav）/ all（全部）。
 * @returns {{keys?:string[], error?:string}}
 */
function resolveRegenKeys(body) {
  const syllables = collectSyllables(loadMissions());
  if (Array.isArray(body.keys) && body.keys.length) {
    const keys = [];
    const unknown = [];
    for (const raw of new Set(body.keys)) {
      const k = canonicalKey(syllables, raw);
      if (k) { if (!keys.includes(k)) keys.push(k); }
      else unknown.push(String(raw));
    }
    if (unknown.length) return { error: `词库里没有这些音节: ${unknown.join(', ')}` };
    return { keys };
  }
  const scope = body.scope || 'flagged';
  if (scope === 'flagged') {
    const flags = readJson('voice-flags', { keys: [] }).keys || [];
    const keys = [];
    for (const raw of flags) {
      const k = canonicalKey(syllables, raw);
      if (k && !keys.includes(k)) keys.push(k);
    }
    return { keys };
  }
  if (scope === 'missing') {
    return { keys: [...syllables.keys()].filter((k) => syllableFileStatus(k) !== 'wav') };
  }
  if (scope === 'all') return { keys: [...syllables.keys()] };
  return { error: `未知 scope: ${scope}（可选 flagged / missing / all，或直接传 keys）` };
}

// 重新生成任务（同一时刻只跑一个；进度可查询、可中止）。
let regenJob = null;

function regenJobView() {
  if (!regenJob) return { running: false, idle: true };
  const { running, cancelled, total, done, ok, fail, current, results, startedAt, finishedAt } = regenJob;
  return { running, cancelled, total, done, ok, fail, current, results, startedAt, finishedAt };
}

/** 后台逐个音节重新生成（与 scripts/gen-syllable-voice.mjs 同一套内核）。
 *  只写根目录 {音节}.wav（AI 源）；lib/ 真人录音绝不触碰。 */
async function runRegenJob(job, settings) {
  const syllables = collectSyllables(loadMissions());
  const overrides = readJson('voice-overrides', {});
  const tts = (text) => ttsFetch({
    url: settings.url, key: settings.key, model: settings.model, voice: settings.voice, text, format: 'wav',
  });
  for (const key of job.keys) {
    if (job.cancelled) break;
    job.current = key;
    const rec = syllables.get(key);
    const ov = overrides[key] || overrides[fileKey(key)] || null;
    const t0 = Date.now();
    let result = { key, ok: false, error: '未执行' };
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const built = await renderSyllableWav(rec, { tts, override: ov, carrier: false });
        const file = path.join(VOICE_OUT_DIR, fileKey(key) + '.wav');
        fs.writeFileSync(file + '.tmp', built.buf);
        fs.renameSync(file + '.tmp', file);
        result = { key, ok: true, ms: Date.now() - t0, durMs: built.durMs, mode: built.mode, text: built.label };
        break;
      } catch (e) {
        result = { key, ok: false, error: String(e?.message || e) };
        if (attempt === 1) await sleep(600);
      }
    }
    job.results.push(result);
    job.done += 1;
    if (result.ok) job.ok += 1; else job.fail += 1;
    await sleep(120); // 礼貌限速
  }
  job.current = null;
  job.running = false;
  job.finishedAt = new Date().toISOString();
}

/* ----------------------------- 数据读写 ----------------------------- */

function dataPath(name) {
  return path.join(DATA_DIR, `${name}.json`);
}

function readJson(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(dataPath(name), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT' && fallback !== undefined) return fallback;
    throw err;
  }
}

/** 原子写入：先写临时文件再 rename，避免家长/孩子同时读写时损坏 JSON。 */
function writeJson(name, value) {
  const target = dataPath(name);
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, target);
}

const loadMissions = () => readJson('missions', []);
const loadBadges = () => readJson('badges', []);
// 课文同步目录（2026 最新统编版一~三年级）；缺失时退化为自由巡航（不过滤）。
const loadTextbook = () => readJson('textbook', { version: null, grades: [] });
const loadProgress = () => readJson('progress', {
  callsign: '火箭指挥官', totalLaunches: 0, unlockedBadges: [], recentMissionIds: [], stats: {},
});

/* ----------------------------- 火箭拥有状态 ----------------------------- */
// 拥有判定 / 座驾解析见 public/js/rocket-select.js（与浏览器共用的纯逻辑）。

/* ----------------------------- 工具函数 ----------------------------- */

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** 历史错误率加权系数（1~3）。 */
function errorFactor(stat) {
  if (!stat || !stat.attempts) return 1;
  const rate = stat.errors / stat.attempts;
  return clamp(1 + 2 * rate, 1, 3);
}

/** 易混音特训筛选标签。 */
const CONFUSION_TAGS = new Set(['平舌音', '翘舌音', '前鼻音', '后鼻音', 'j/q/x去点']);

function filterByMode(missions, mode) {
  if (mode === 'three') return missions.filter((m) => m.type === 'three_part');
  if (mode === 'confusion') return missions.filter((m) => (m.tags || []).some((t) => CONFUSION_TAGS.has(t)));
  if (mode === 'emergency') return missions.filter((m) => m.isParentInjected);
  return missions; // all
}

/**
 * 加权随机抽题：家长热注入 ×5、错误率 ×1~3、跳过最近 5 题。
 * 不再有「任务难度」加权——出题范围完全由课文同步进度（progress.textbook）决定，
 * 同一进度内的三拼 / 易混音自然混在池子里；紧急任务模式不受进度限制，
 * 进度内某模式无题时退回进度内综合巡航。
 */
function pickNext(missions, progress, mode, catalog = null) {
  const inProgress = mode === 'emergency'
    ? missions
    : filterMissionsByTextbook(missions, catalog, progress.textbook || null);
  let pool0 = filterByMode(inProgress, mode);
  if (pool0.length === 0 && mode !== 'all' && mode !== 'emergency') {
    pool0 = inProgress; // 进度内该模式无题 → 退回进度内全部题型
  }
  if (pool0.length === 0) return null;
  const recent = new Set((progress.recentMissionIds || []).slice(-5));
  let pool = pool0.filter((m) => !recent.has(m.id));
  if (pool.length === 0) pool = pool0; // 全被跳过则放开去重

  const stats = progress.stats || {};
  const weighted = pool.map((m) => {
    const parentBoost = m.isParentInjected ? 5 : 1;
    const priority = Number(m.priority) || 1;
    const w = priority * parentBoost * errorFactor(stats[m.id]);
    return { m, w };
  });
  const total = weighted.reduce((s, x) => s + x.w, 0);
  let r = Math.random() * total;
  for (const { m, w } of weighted) {
    r -= w;
    if (r <= 0) return m;
  }
  return weighted[weighted.length - 1].m;
}

/**
 * 单元任务模式抽题：沿固定题单（progress.unitSession）逐题发射。
 *  - 题单已完成（cursor 到底）→ 重新生成一份新题单（复习重抽），继续本单元练习；
 *  - 跳过词库里已不存在的词条（家长可能改过词库）；
 *  - 返回的词条附带 unitSession 进度视图与本题 kind（new/review）。
 * 无单元任务或题单空 → 返回 null，调用方退回常规加权抽题。
 */
function serveUnitMission(missions, progress, catalog) {
  const s = progress.unitSession;
  if (!s || !Array.isArray(s.queue)) return null;
  if (s.cursor >= s.queue.length) {
    const built = buildUnitQueue(missions, catalog, s.grade, s.term, s.seq, progress.stats || {}, { total: unitTotal(progress) });
    s.queue = built.queue; s.newCount = built.newCount; s.reviewCount = built.reviewCount; s.cursor = 0;
    writeJson('progress', progress);
  }
  while (s.cursor < s.queue.length) {
    const item = s.queue[s.cursor];
    const m = missions.find((x) => x.id === item.missionId);
    if (m) return { ...m, unitSession: { ...unitSessionView(s), kind: item.kind } };
    s.cursor++; // 词条缺失 → 跳过
  }
  writeJson('progress', progress);
  return null;
}

/** 各拼音标签掌握度统计。 */
function tagMastery(missions, progress) {
  const agg = {};
  const stats = progress.stats || {};
  for (const m of missions) {
    const s = stats[m.id];
    if (!s) continue;
    for (const tag of m.tags || []) {
      agg[tag] = agg[tag] || { attempts: 0, errors: 0 };
      agg[tag].attempts += s.attempts || 0;
      agg[tag].errors += s.errors || 0;
    }
  }
  const out = {};
  for (const [tag, v] of Object.entries(agg)) {
    out[tag] = { ...v, mastery: v.attempts ? Number((1 - v.errors / v.attempts).toFixed(3)) : null };
  }
  return out;
}

/* ----------------------------- 发射动画选项 ----------------------------- */
// 家长后台可选：always = 每次发射都播放完整动画（默认）；
// unit-first = 每个课文单元的第一次发射播放动画，同单元后续发射跳过动画直接结算。
const LAUNCH_FX_MODES = ['always', 'unit-first'];
const launchFxMode = (progress) => (LAUNCH_FX_MODES.includes(progress.launchFx) ? progress.launchFx : 'always');

/* ----------------------------- 介母装配选项 ----------------------------- */
// 家长后台「学习管理」可选：required = 三拼音节的介母由孩子从托盘挑出并装配（默认）；
// auto = 介母自动预装（j/q/x 后直接显示去点书写形 u），孩子只拼声母 + 韵母，降低三拼难度。
const MEDIAL_MODES = ['required', 'auto'];
const medialMode = (progress) => (MEDIAL_MODES.includes(progress.medialMode) ? progress.medialMode : 'required');

/* ----------------------------- 单元练习总字数选项 ----------------------------- */
// 家长后台「学习管理」可选 10~20（默认 15）：单元题单总字数，复习名额 = 总字数 − 本课新字数。
const unitTotal = (progress) => clampUnitTotal(progress.unitTotal ?? UNIT_TOTAL_DEFAULT);

/**
 * 已发射过的课文单元键（grade-term-unit）：单元内任一词条练过（attempts>0）即算。
 * 直接由作答统计推导，无需额外记录；清空学习记录后自然归零。
 * 没有单元归属的词条（汉语拼音课 / 无教材引用扩展 / 紧急载荷）不参与。
 */
function launchedUnitKeys(missions, stats = {}) {
  const set = new Set();
  for (const m of missions) {
    const key = unitKey(m.textbook);
    if (key && (Number(stats?.[m.id]?.attempts) || 0) > 0) set.add(key);
  }
  return [...set];
}

/* ----------------------------- API 路由 ----------------------------- */

async function handleApi(req, res, url) {
  const p = url.pathname;
  const method = req.method;

  // 健康检查
  if (method === 'GET' && p === '/api/health') {
    return sendJson(res, 200, { ok: true, service: 'star-pinyin', milestone: 4 });
  }

  // 真人语音代理：GET/HEAD /api/tts?text=...&voice=...
  // 浏览器侧 no-cache（服务端磁盘缓存已避免重复合成）：音色/设置变更后不能继续播 24h 旧缓存。
  if ((method === 'GET' || method === 'HEAD') && p === '/api/tts') {
    const text = (url.searchParams.get('text') || '').trim().slice(0, 200);
    const voice = url.searchParams.get('voice') || ttsSettings().voice;
    if (!text) return sendJson(res, 400, { error: '缺少 text 参数' });
    try {
      const file = voiceCachePath(text, voice);
      const etag = '"' + path.basename(file, '.mp3') + '"';
      let cached = false;
      try { cached = fs.statSync(file).size > 1000; } catch {}
      if (method === 'HEAD') {
        if (cached) { res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': fs.statSync(file).size, 'Cache-Control': 'no-cache', 'ETag': etag }); return res.end(); }
        res.writeHead(404); return res.end();
      }
      if (cached && req.headers['if-none-match'] === etag) {
        res.writeHead(304, { 'Cache-Control': 'no-cache', 'ETag': etag }); return res.end();
      }
      const buf = await getVoice(text, voice);
      res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': buf.length, 'Cache-Control': 'no-cache', 'ETag': etag, 'X-Voice-Cache': cached ? 'hit' : 'miss' });
      return res.end(buf);
    } catch (e) {
      return sendJson(res, 502, { error: '语音合成失败', message: String(e?.message || e) });
    }
  }

  // 发音自检：人工标记的音节（voice-check.html 自动上传，落盘 data/voice-flags.json）
  if (p === '/api/voice/flags' && (method === 'GET' || method === 'POST')) {
    if (method === 'GET') return sendJson(res, 200, readJson('voice-flags', { updatedAt: null, keys: [] }));
    let body;
    try { body = await readBody(req); } catch { return sendJson(res, 400, { error: '请求体不是合法 JSON' }); }
    if (!Array.isArray(body.keys)) return sendJson(res, 400, { error: 'keys 必须是音节数组，如 ["ju4","sen1"]' });
    const keys = [...new Set(body.keys.filter((k) => typeof k === 'string' && /^[a-zü]+[1-4]$/.test(k)))];
    const payload = { updatedAt: new Date().toISOString(), keys };
    writeJson('voice-flags', payload);
    return sendJson(res, 200, { ok: true, ...payload });
  }

  // 家长端：TTS合成API设置（API 地址 / Key / 模型 / 音色自行填入；Key 只落盘服务端，接口回显打码）
  if (p === '/api/admin/tts-config' && (method === 'GET' || method === 'POST')) {
    if (method === 'GET') return sendJson(res, 200, ttsConfigView());
    let body;
    try { body = await readBody(req); } catch { return sendJson(res, 400, { error: '请求体不是合法 JSON' }); }
    const next = { ...loadTtsConfig() };
    for (const field of ['url', 'model', 'voice']) {
      if (body[field] === undefined) continue;
      const v = String(body[field] ?? '').trim();
      if (field === 'url' && v && !/^https?:\/\//.test(v)) {
        return sendJson(res, 422, { error: 'API 地址必须以 http:// 或 https:// 开头' });
      }
      if (v) next[field] = v; else delete next[field];
    }
    // Key：填了新的就覆盖；留空 = 沿用已保存的（前端永不回显明文，避免误清空）
    if (typeof body.key === 'string' && body.key.trim()) next.key = body.key.trim();
    writeJson('tts-config', next);
    return sendJson(res, 200, { ok: true, ...ttsConfigView() });
  }

  // 家长端：填好 API + Key 后「自动获取」模型与音色（只读探测，不落盘、不用合成额度）
  if (method === 'POST' && p === '/api/admin/tts-config/discover') {
    let body = {};
    try { body = await readBody(req); } catch { return sendJson(res, 400, { error: '请求体不是合法 JSON' }); }
    const saved = ttsSettings();
    const apiUrl = String(body.url ?? '').trim() || saved.url;
    const key = String(body.key ?? '').trim() || saved.key;
    const wantModel = String(body.model ?? '').trim() || saved.model;
    const wantVoice = String(body.voice ?? '').trim();
    if (!/^https?:\/\//i.test(apiUrl)) return sendJson(res, 422, { error: 'API 地址必须以 http:// 或 https:// 开头' });
    if (!key) return sendJson(res, 422, { error: '还没填 API Key：请在上方填入后重试' });

    const [probe, liveVoices] = await Promise.all([
      probeTtsModels(apiUrl, key),
      probeTtsLiveVoices(apiUrl, key),
    ]);
    if (probe.auth) {
      return sendJson(res, 502, {
        ok: false,
        error: `API Key 校验失败（HTTP ${probe.status}）：${probe.error || 'Key 无效或没有权限'}`,
      });
    }

    const notes = [];
    let models;
    if (probe.ok) {
      models = probe.ids.map((id) => ({ id, recommended: isTtsModel(id), label: ttsModelLabel(id), source: 'api' }));
      const ttsCount = models.filter((m) => m.recommended).length;
      notes.push(`模型列表来自 ${probe.endpoint}：共 ${models.length} 个，其中 ${ttsCount} 个语音合成模型`);
    } else {
      models = TTS_MODEL_CATALOG.map((m) => ({ id: m.id, recommended: m.recommended, label: m.label, source: 'catalog' }));
      notes.push('该接口没有模型列表（找不到 /v1/models），已列出内置语音合成模型，也可以直接手填模型名');
    }

    const model = wantModel || models.find((m) => m.recommended)?.id || models[0]?.id || DEFAULT_TTS_MODEL;
    if (wantModel && probe.ok && !probe.ids.includes(wantModel)) {
      notes.push(`当前模型 ${wantModel} 不在接口列表里（仍保留，可改选）`);
    }
    const catalogVoices = voicesForModel(model);
    const usableLive = liveVoices.filter((v) => !v.model || v.model === model);
    const voices = mergeVoices(catalogVoices, usableLive);
    const voice = pickDiscoveredVoice(voices, wantVoice, model);
    if (!voices.length) notes.push('该模型没有内置音色表：请按服务商文档手填音色名，或换一个语音合成模型');
    if (liveVoices.length && !usableLive.length) notes.push(`另有 ${liveVoices.length} 个定制音色不属于当前模型，换模型后可见`);
    if (voice && wantVoice && voice !== wantVoice) {
      notes.push(`音色 ${wantVoice} 不在 ${model} 的可用列表里，已改为 ${voice}（避免跨模型混用报错）`);
    }
    return sendJson(res, 200, {
      ok: true, model, voice, models, voices, liveVoices, notes,
      modelSource: probe.ok ? 'api' : 'catalog',
      endpoint: probe.ok ? probe.endpoint : null,
    });
  }

  // 家长端：用当前设置试合成一句，验证 API / Key 是否可用（不走缓存，必打真实接口）。
  // 音频随响应 base64 返回，家长端成功后立即播放（测试成功 + a o e i u ü）。
  if (method === 'POST' && p === '/api/admin/tts-config/test') {
    const t0 = Date.now();
    try {
      const buf = await synthesizeVoice(TTS_TEST_TEXT, null, 'mp3');
      if (buf.length <= 1000) throw new Error('返回音频过小 ' + buf.length);
      return sendJson(res, 200, { ok: true, bytes: buf.length, ms: Date.now() - t0, audio: buf.toString('base64'), mime: audioMime(buf) });
    } catch (e) {
      return sendJson(res, 502, { ok: false, error: String(e?.message || e) });
    }
  }

  // 家长端：全库音节发音状态（wav / mp3 / 需现场合成）+ 已标记音节 + 双源信息
  if (method === 'GET' && p === '/api/admin/voice/status') {
    return sendJson(res, 200, voiceStatusView());
  }

  // 家长端：发音来源（真人录音库 / AI 合成）——全局默认 + 逐音节覆盖，两者并存可切换
  if (p === '/api/admin/voice/source' && (method === 'GET' || method === 'POST')) {
    if (method === 'GET') {
      const cfg = voiceSourceConfig();
      let lib = 0, tts = 0;
      for (const key of collectSyllables(loadMissions()).keys()) {
        const fk = fileKey(key);
        if (wavOk(path.join(VOICE_LIB_DIR, fk + '.wav'))) lib++;
        if (wavOk(path.join(VOICE_OUT_DIR, fk + '.wav'))) tts++;
      }
      return sendJson(res, 200, { ...cfg, counts: { lib, tts } });
    }
    let body;
    try { body = await readBody(req); } catch { return sendJson(res, 400, { error: '请求体不是合法 JSON' }); }
    const cfg = voiceSourceConfig();
    if (body.default !== undefined) {
      if (body.default !== 'lib' && body.default !== 'tts') return sendJson(res, 422, { error: 'default 只能是 lib（真人）或 tts（AI）' });
      cfg.default = body.default;
    }
    if (body.keys !== undefined) {
      if (!body.keys || typeof body.keys !== 'object' || Array.isArray(body.keys)) return sendJson(res, 422, { error: 'keys 必须是对象 {音节: lib|tts|null}' });
      const syllables = collectSyllables(loadMissions());
      for (const [raw, val] of Object.entries(body.keys)) {
        const k = canonicalKey(syllables, raw);
        if (!k) return sendJson(res, 422, { error: `词库里没有这个音节: ${raw}` });
        const fk = fileKey(k);
        if (val === null || val === '' || val === 'default') delete cfg.keys[fk];
        else if (val === 'lib' || val === 'tts') cfg.keys[fk] = val;
        else return sendJson(res, 422, { error: `${raw} 的源非法: ${val}（可选 lib / tts / null）` });
      }
    }
    writeJson('voice-source', cfg);
    return sendJson(res, 200, { ok: true, ...cfg });
  }

  // 家长端：重新生成音节读音（后台任务；keys 显式指定，或 scope=flagged/missing/all）
  if (method === 'POST' && p === '/api/admin/voice/regenerate') {
    if (regenJob?.running) return sendJson(res, 409, { error: '已有重新生成任务在运行，请等待完成或先停止', job: regenJobView() });
    let body;
    try { body = await readBody(req); } catch { return sendJson(res, 400, { error: '请求体不是合法 JSON' }); }
    const { keys, error } = resolveRegenKeys(body);
    if (error) return sendJson(res, 422, { error });
    if (!keys.length) return sendJson(res, 200, { ok: true, total: 0, keys: [] });
    const settings = ttsSettings();
    if (!settings.key) return sendJson(res, 422, { error: '未配置 TTS API Key，请先在「TTS合成API设置」填入 API 与 Key' });
    regenJob = {
      running: true, cancelled: false, total: keys.length, done: 0, ok: 0, fail: 0,
      current: null, keys, results: [], startedAt: new Date().toISOString(), finishedAt: null,
    };
    runRegenJob(regenJob, settings).catch((e) => {
      console.error('[regen] 任务异常', e);
      regenJob.running = false;
      regenJob.finishedAt = new Date().toISOString();
    });
    return sendJson(res, 202, { ok: true, total: keys.length, keys });
  }

  // 家长端：重新生成任务进度
  if (method === 'GET' && p === '/api/admin/voice/regenerate') {
    return sendJson(res, 200, regenJobView());
  }

  // 家长端：中止重新生成任务（当前音节做完即停）
  if (method === 'POST' && p === '/api/admin/voice/regenerate/stop') {
    if (!regenJob?.running) return sendJson(res, 200, { ok: true, running: false });
    regenJob.cancelled = true;
    return sendJson(res, 200, { ok: true, running: true, cancelling: true });
  }

  // 抽题（出题范围由课文同步进度决定，不再有难度参数；旧客户端的 difficulty 参数被忽略）
  if (method === 'GET' && p === '/api/missions/next') {
    const mode = url.searchParams.get('mode') || 'all';
    const missions = loadMissions();
    const progress = loadProgress();
    const catalog = loadTextbook();
    // 单元任务模式（紧急任务除外）：沿固定题单逐题发射，不走加权随机。
    if (mode !== 'emergency' && progress.unitSession) {
      const served = serveUnitMission(missions, progress, catalog);
      if (served) return sendJson(res, 200, served);
    }
    const mission = pickNext(missions, progress, mode, catalog);
    if (!mission) return sendJson(res, 404, { error: '当前模式没有可用任务', mode });
    return sendJson(res, 200, mission);
  }

  // 课文同步：教材目录 + 当前学习进度
  if (method === 'GET' && p === '/api/textbook') {
    const catalog = loadTextbook();
    const progress = loadProgress();
    const selection = progress.textbook || null;
    return sendJson(res, 200, {
      catalog,
      selection,
      label: formatSelection(catalog, selection),
      poolSize: countAllowed(catalog, selection),
    });
  }

  // 课文同步：选择年级 / 学期 / 课文进度（grade=null 改回自由巡航）
  if (method === 'POST' && p === '/api/textbook/select') {
    let body;
    try { body = await readBody(req); } catch { return sendJson(res, 400, { error: '请求体不是合法 JSON' }); }
    const catalog = loadTextbook();
    const { ok, selection, error } = validateSelection(catalog, body);
    if (!ok) return sendJson(res, 422, { error });
    const progress = loadProgress();
    if (selection) progress.textbook = selection;
    else delete progress.textbook;
    // 选择具体课文 / 全册 / 自由巡航即退出单元任务模式（题单作废）。
    delete progress.unitSession;
    writeJson('progress', progress);
    return sendJson(res, 200, {
      ok: true,
      selection,
      label: formatSelection(catalog, selection),
      poolSize: countAllowed(catalog, selection),
    });
  }

  // 单元完成规则：选择课文（单元）→ 生成/恢复固定题单（本课全部新字 + 抽5个过往字，错题优先）。
  // 同一课未完成 → 恢复进度；已完成或换课 → 重新生成（复习重抽）。
  if (method === 'POST' && p === '/api/unit/select') {
    let body;
    try { body = await readBody(req); } catch { return sendJson(res, 400, { error: '请求体不是合法 JSON' }); }
    const catalog = loadTextbook();
    const { ok, selection, error } = validateSelection(catalog, body);
    if (!ok || !selection || selection.seq == null) {
      return sendJson(res, 422, { error: error || '单元需为具体一课（grade/term/seq 必填）' });
    }
    const { grade, term, seq } = selection;
    const missions = loadMissions();
    const progress = loadProgress();
    let s = progress.unitSession;
    const resumable = s && s.grade === grade && s.term === term && s.seq === seq
      && Array.isArray(s.queue) && s.cursor < s.queue.length;
    if (!resumable) {
      const built = buildUnitQueue(missions, catalog, grade, term, seq, progress.stats || {}, { total: unitTotal(progress) });
      s = {
        grade, term, seq, label: unitLabel(catalog, grade, term, seq),
        queue: built.queue, newCount: built.newCount, reviewCount: built.reviewCount,
        cursor: 0, createdAt: new Date().toISOString(),
      };
      progress.unitSession = s;
    }
    // 进度选择同步到该课，机库课文芯片保持高亮。
    progress.textbook = { grade, term, seq };
    writeJson('progress', progress);
    return sendJson(res, 200, {
      ok: true,
      session: unitSessionView(s),
      selection: progress.textbook,
      label: formatSelection(catalog, progress.textbook),
      poolSize: countAllowed(catalog, progress.textbook),
    });
  }

  // 上报作答
  if (method === 'POST' && p === '/api/progress/record') {
    let body;
    try { body = await readBody(req); } catch { return sendJson(res, 400, { error: '请求体不是合法 JSON' }); }
    const { missionId, assemblyErrors = 0, toneErrors = 0, durationMs = 0, destinationId = null } = body;
    const missions = loadMissions();
    const mission = missions.find((m) => m.id === missionId);
    if (!mission) return sendJson(res, 404, { error: `任务不存在: ${missionId}` });

    const progress = loadProgress();
    progress.stats = progress.stats || {};
    // 课时奖励：先记下作答前的课时完成度（本局可能刚好补完某一课 → 解锁新目的地）。
    const lessonsBefore = lessonProgress(missions, progress.stats);
    const stat = progress.stats[missionId] || { attempts: 0, errors: 0, weight: 1 };
    const totalErrors = Number(assemblyErrors) + Number(toneErrors);
    const perfect = totalErrors === 0;

    stat.attempts += 1;
    stat.errors += perfect ? 0 : 1;
    stat.lastPlayedAt = new Date().toISOString();
    stat.lastDurationMs = Number(durationMs) || 0;
    // 全对衰减错误权重；否则按错误率抬升（1~3）。
    stat.weight = perfect
      ? Number(clamp((stat.weight || 1) * 0.8, 1, 3).toFixed(3))
      : Number(clamp(1 + 2 * (stat.errors / stat.attempts), 1, 3).toFixed(3));
    // 错题池：有错入池并清零连续计数；错题池中全对累计修正，连续满 3 次毕业。
    // 修正分散在后续不同单元的复习里（错题优先重抽），不在当前单元重复练。
    updateWrongStat(stat, perfect);
    progress.stats[missionId] = stat;

    // 单元任务推进：本题恰为题单当前项 → 前进一格。
    // 题单固定（本课新字 + 5 复习），同一个字在本单元只出现一次，答错也不追加；
    // 错题进入错题池，由后续单元复习「错题优先」再次抽到，连续 3 次全对才毕业。
    let unitSessionMeta = null;
    const us = progress.unitSession;
    if (us && Array.isArray(us.queue) && us.cursor < us.queue.length
      && us.queue[us.cursor].missionId === missionId) {
      const kind = us.queue[us.cursor].kind;
      us.cursor += 1;
      unitSessionMeta = { ...unitSessionView(us), kind, wrong: stat.wrong, fixes: stat.fixes };
    }

    // 每次完成一关 = 一次入轨发射。
    const prevLaunches = progress.totalLaunches || 0;
    progress.totalLaunches = prevLaunches + 1;
    progress.recentMissionIds = [...(progress.recentMissionIds || []), missionId].slice(-5);

    // 课时奖励：本局补完的课时 → 是否跨过奖励档位（每 2 课时解锁 1 个星际目的地）。
    const lessonsAfter = lessonProgress(missions, progress.stats);
    const rewardLevel = rewardLevelForLessons(lessonsAfter.completed);
    const prevRewardLevel = rewardLevelForLessons(lessonsBefore.completed);
    const newlyReachedDestination = rewardLevel > prevRewardLevel ? destinationForLevel(rewardLevel) : null;
    const doneKey = lessonKey(mission.textbook);
    const lessonDoneBefore = doneKey != null && lessonsBefore.lessons.some((l) => l.key === doneKey && l.completed);
    const lessonNow = doneKey != null ? lessonsAfter.lessons.find((l) => l.key === doneKey) : null;
    const lessonCompleted = !lessonDoneBefore && lessonNow?.completed ? lessonNow.ref : null;

    // 每完成 3 个单元解锁一枚新火箭：拥有状态严格按单元数推导（旧规则多发的自动校准收回）。
    // 火箭收藏与目的地奖励解耦：解锁火箭只扩充机库 / 图鉴，不影响奖励档位。
    const badges = loadBadges();
    const ownedBefore = rocketIdsForUnits(badges, lessonsBefore.completed);
    const ownedAfter = rocketIdsForUnits(badges, lessonsAfter.completed);
    const newlyUnlocked = badges.filter((b) => ownedAfter.has(b.id) && !ownedBefore.has(b.id));
    progress.unlockedBadges = [...ownedAfter];

    // 目的地到访记录（星球图鉴点亮）+ 奖励档位解锁的新目的地。
    // 兼容旧客户端上报的 'earth'（地球轨道已拆分为低空/高空/远地三层）。
    const rawDest = destinationId === 'earth' ? 'earth_low' : destinationId;
    const destId = typeof rawDest === 'string' && DESTINATIONS[rawDest] ? rawDest : null;
    progress.visitedDestinations = progress.visitedDestinations || {};
    let firstVisit = false;
    if (destId) {
      const before = progress.visitedDestinations[destId] || 0;
      firstVisit = before === 0;
      progress.visitedDestinations[destId] = before + 1;
    }

    // 旧档案里的难度选择已无意义（难度已改为课时奖励系统），顺手清掉。
    if (progress.selectedDifficulty != null) delete progress.selectedDifficulty;

    writeJson('progress', progress);

    return sendJson(res, 200, {
      ok: true, perfect, totalLaunches: progress.totalLaunches,
      weight: stat.weight, newlyUnlockedBadges: newlyUnlocked,
      // 错题池状态 + 单元任务进度（本题推进后的视图；非单元任务为 null）
      wrongPool: { wrong: stat.wrong, fixes: stat.fixes },
      unitSession: unitSessionMeta,
      destinationId: destId, firstVisit,
      visitedDestinations: progress.visitedDestinations,
      // 课时奖励进度：本局补完的课时 / 累计完成课时 / 档位 / 新解锁目的地
      lessonCompleted,
      lessonsCompleted: lessonsAfter.completed,
      lessonsTotal: lessonsAfter.total,
      rewardLevel,
      newlyReachedDestination,
    });
  }

  // 玩家档案 + 博物馆
  if (method === 'GET' && p === '/api/profile') {
    const progress = loadProgress();
    const missions = loadMissions();
    const badges = loadBadges();
    // 进度 = 课时完成量：每 2 课时升 1 档目的地奖励；每 3 个完成单元解锁 1 枚新火箭。
    const lessons = lessonProgress(missions, progress.stats || {});
    // 火箭拥有状态按单元数校准（收回旧规则多发 / 补上应得），档案与机库 / 图鉴 / 自选保持一致。
    const unlockedSet = rocketIdsForUnits(badges, lessons.completed);
    const storedSet = ownedRocketIds(progress, badges); // 空档案隐含初始座驾，视为等价不写盘
    const calibrated = storedSet.size === unlockedSet.size && [...unlockedSet].every((id) => storedSet.has(id));
    if (!calibrated) {
      progress.unlockedBadges = [...unlockedSet];
      if (progress.selectedRocketId && !unlockedSet.has(progress.selectedRocketId)) delete progress.selectedRocketId;
      writeJson('progress', progress);
    }
    const unlockedBadges = badges.filter((b) => unlockedSet.has(b.id));
    const owned = ownedRockets(progress, badges); // 机库可选座驾（按解锁门槛升序）
    // 当前座驾 = 机库里自选的火箭；没自选时用最新获得的一枚（默认初始座驾土星五号）。
    const currentRocket = resolveCurrentRocket(progress, badges);
    const rewardLevel = rewardLevelForLessons(lessons.completed);
    return sendJson(res, 200, {
      callsign: progress.callsign,
      totalLaunches: progress.totalLaunches || 0,
      unlockedBadges: [...unlockedSet],
      museum: unlockedBadges,
      badges,
      ownedRockets: owned,
      // true = 尚未自选座驾，跟随最新火箭；false = 已自选并锁定
      rocketAuto: !progress.selectedRocketId,
      selectedRocketId: progress.selectedRocketId || null,
      nextBadge: badges
        .filter((b) => !isStarterBadge(b) && !unlockedSet.has(b.id))
        .sort(byUnlockAt)[0] || null,
      tagMastery: tagMastery(missions, progress),
      emergencyCount: missions.filter((m) => m.isParentInjected).length,
      // 课时奖励系统：已完成课时 / 课时总数 / 当前档位 / 最新目的地 / 下一份奖励
      lessonsCompleted: lessons.completed,
      lessonsTotal: lessons.total,
      // 已完成课时键（grade-term-seq）：机库课文（单元）芯片置灰用，与课时奖励同口径
      completedLessons: lessons.lessons.filter((l) => l.completed).map((l) => l.key),
      rewardLevel,
      currentDestination: destinationForLevel(rewardLevel),
      nextReward: nextRewardForLessons(lessons.completed),
      visitedDestinations: progress.visitedDestinations || {},
      currentRocket,
      // 课文同步学习进度（null = 自由巡航 · 全部词库）
      textbook: progress.textbook || null,
      // 单元任务进度（null = 未选单元）：机库单元芯片高亮 / 进度 / 结算用
      unitSession: unitSessionView(progress.unitSession),
      // 界面皮肤（家长后台选择，全设备同步）：hud / daylight / nebula
      skin: progress.skin || 'hud',
      // 图标风格（家长后台选择，全设备同步）：a 写实 / b 扁平 / c 复古
      iconStyle: progress.iconStyle || 'a',
      // 发射动画（家长后台选择）：always 每次播放 / unit-first 每单元仅首次播放
      launchFx: launchFxMode(progress),
      // 已发射过的单元键（unit-first 模式下这些单元的后续发射跳过动画）
      launchedUnits: launchedUnitKeys(missions, progress.stats || {}),
      // 介母装配（家长后台「学习管理」选择）：required 孩子填入 / auto 自动预装
      medialMode: medialMode(progress),
      // 单元练习总字数（家长后台「学习管理」选择，10~20）：复习名额 = 总字数 − 本课新字数
      unitTotal: unitTotal(progress),
    });
  }

  // 家长端：界面皮肤选择 POST /api/skin { skin }（写入档案，孩子端进入/刷新时同步）
  if (method === 'POST' && p === '/api/skin') {
    let body;
    try { body = await readBody(req); } catch { return sendJson(res, 400, { error: '请求体不是合法 JSON' }); }
    const skin = typeof body.skin === 'string' ? body.skin.trim() : '';
    if (!['hud', 'daylight', 'nebula'].includes(skin)) {
      return sendJson(res, 422, { error: '未知皮肤: ' + skin });
    }
    const progress = loadProgress();
    progress.skin = skin;
    writeJson('progress', progress);
    return sendJson(res, 200, { ok: true, skin });
  }

  // 家长端：图标风格选择 POST /api/iconstyle { iconStyle }（写入档案，孩子端进入/刷新时同步）
  if (method === 'POST' && p === '/api/iconstyle') {
    let body;
    try { body = await readBody(req); } catch { return sendJson(res, 400, { error: '请求体不是合法 JSON' }); }
    const iconStyle = typeof body.iconStyle === 'string' ? body.iconStyle.trim() : '';
    if (!['a', 'b', 'c'].includes(iconStyle)) {
      return sendJson(res, 422, { error: '未知图标风格: ' + iconStyle });
    }
    const progress = loadProgress();
    progress.iconStyle = iconStyle;
    writeJson('progress', progress);
    return sendJson(res, 200, { ok: true, iconStyle });
  }

  // 家长端：发射动画选项 POST /api/launchfx { launchFx }（always 每次 / unit-first 每单元仅首次）
  // 写入档案；孩子端每次点火前都会拉档案，下一局发射即生效，无需刷新。
  if (method === 'POST' && p === '/api/launchfx') {
    let body;
    try { body = await readBody(req); } catch { return sendJson(res, 400, { error: '请求体不是合法 JSON' }); }
    const launchFx = typeof body.launchFx === 'string' ? body.launchFx.trim() : '';
    if (!LAUNCH_FX_MODES.includes(launchFx)) {
      return sendJson(res, 422, { error: '未知发射动画选项: ' + launchFx + '（可选 always / unit-first）' });
    }
    const progress = loadProgress();
    progress.launchFx = launchFx;
    writeJson('progress', progress);
    return sendJson(res, 200, { ok: true, launchFx });
  }

  // 家长端：介母装配选项 POST /api/medialmode { medialMode }（required 孩子填入 / auto 自动预装）
  // 写入档案；孩子端每局组装前都会拉档案，下一局即生效，无需刷新。
  if (method === 'POST' && p === '/api/medialmode') {
    let body;
    try { body = await readBody(req); } catch { return sendJson(res, 400, { error: '请求体不是合法 JSON' }); }
    const mode = typeof body.medialMode === 'string' ? body.medialMode.trim() : '';
    if (!MEDIAL_MODES.includes(mode)) {
      return sendJson(res, 422, { error: '未知介母装配选项: ' + mode + '（可选 required / auto）' });
    }
    const progress = loadProgress();
    progress.medialMode = mode;
    writeJson('progress', progress);
    return sendJson(res, 200, { ok: true, medialMode: mode });
  }

  // 家长端：单元练习总字数 POST /api/unittotal { unitTotal }（10~20 整数，默认 15）
  // 复习名额 = 总字数 − 本课新字数；写入档案，孩子端下次选题单即生效。
  if (method === 'POST' && p === '/api/unittotal') {
    let body;
    try { body = await readBody(req); } catch { return sendJson(res, 400, { error: '请求体不是合法 JSON' }); }
    const n = Math.floor(Number(body.unitTotal));
    if (!Number.isInteger(n) || n < UNIT_TOTAL_MIN || n > UNIT_TOTAL_MAX) {
      return sendJson(res, 422, { error: `单元总字数需为 ${UNIT_TOTAL_MIN}~${UNIT_TOTAL_MAX} 的整数（收到 ${body.unitTotal}）` });
    }
    const progress = loadProgress();
    progress.unitTotal = n;
    writeJson('progress', progress);
    return sendJson(res, 200, { ok: true, unitTotal: n });
  }

  // 机库自选座驾：POST /api/rocket/select { rocketId }（rocketId 为 null/'auto' 时改回跟随最新）
  if (method === 'POST' && p === '/api/rocket/select') {
    let body;
    try { body = await readBody(req); } catch { return sendJson(res, 400, { error: '请求体不是合法 JSON' }); }
    const badges = loadBadges();
    const progress = loadProgress();
    // 拥有状态按单元数校准后再校验自选（旧规则多发的火箭不可再选）。
    progress.unlockedBadges = [...rocketIdsForUnits(badges, lessonProgress(loadMissions(), progress.stats || {}).completed)];
    const rocketId = typeof body.rocketId === 'string' ? body.rocketId.trim() : '';
    const auto = !rocketId || rocketId === 'auto';

    if (!auto && !canSelectRocket(progress, badges, rocketId)) {
      return sendJson(res, 403, { error: '尚未获得该火箭，无法选为座驾', rocketId });
    }
    if (auto) delete progress.selectedRocketId;
    else progress.selectedRocketId = rocketId;
    writeJson('progress', progress);

    const currentRocket = resolveCurrentRocket(progress, badges);
    return sendJson(res, 200, {
      ok: true,
      currentRocket,
      selectedRocketId: progress.selectedRocketId || null,
      rocketAuto: !progress.selectedRocketId,
      ownedRockets: ownedRockets(progress, badges),
    });
  }

  // 家长端：全量词库 + 错题率
  if (method === 'GET' && p === '/api/admin/missions') {
    const missions = loadMissions();
    const progress = loadProgress();
    const stats = progress.stats || {};
    const list = missions.map((m) => {
      const s = stats[m.id];
      return {
        ...m,
        category: categoryOf(m),
        attempts: s?.attempts || 0,
        errors: s?.errors || 0,
        errorRate: s?.attempts ? Number((s.errors / s.attempts).toFixed(3)) : 0,
      };
    });
    return sendJson(res, 200, { count: list.length, missions: list });
  }

  // 家长端：热注入错题
  if (method === 'POST' && p === '/api/admin/missions') {
    let body;
    try { body = await readBody(req); } catch { return sendJson(res, 400, { error: '请求体不是合法 JSON' }); }
    const mission = {
      id: body.id || `m_p_${Date.now()}`,
      hanzi: body.hanzi, word: body.word || body.hanzi, hint: body.hint || '',
      type: body.type, parts: body.parts || {}, tone: Number(body.tone),
      displayPinyin: body.displayPinyin,
      distractors: body.distractors || { initial: [], medial: [], final: [] },
      specialRule: body.specialRule ?? null,
      tags: body.tags || ['家长注入'],
      priority: Number(body.priority) || 1,
      isParentInjected: true,
    };
    const result = validateMission(mission);
    if (!result.ok) return sendJson(res, 422, { error: '拼音规则校验未通过', details: result.errors });
    const missions = loadMissions();
    if (missions.some((m) => m.id === mission.id)) return sendJson(res, 409, { error: `id 已存在: ${mission.id}` });
    missions.push(mission);
    writeJson('missions', missions);
    return sendJson(res, 201, { ok: true, mission });
  }

  // 家长端：删除 / 归档
  const delMatch = p.match(/^\/api\/admin\/missions\/([^/]+)$/);
  if (method === 'DELETE' && delMatch) {
    const id = decodeURIComponent(delMatch[1]);
    const archive = url.searchParams.get('archive') === '1';
    let missions = loadMissions();
    const idx = missions.findIndex((m) => m.id === id);
    if (idx === -1) return sendJson(res, 404, { error: `任务不存在: ${id}` });
    if (archive) {
      missions[idx].isParentInjected = false; // 取消紧急标记，保留词条
    } else {
      missions.splice(idx, 1);
    }
    writeJson('missions', missions);
    return sendJson(res, 200, { ok: true, archived: archive, id });
  }

  // 家长端：一键清除学习记录（重置 progress；保留呼号与课文同步选择，词库不动）
  if (method === 'POST' && p === '/api/admin/progress/reset') {
    const progress = loadProgress();
    const previousLaunches = progress.totalLaunches || 0;
    const clearedStats = Object.keys(progress.stats || {}).length;
    const fresh = {
      callsign: progress.callsign,
      totalLaunches: 0,
      unlockedBadges: [],
      recentMissionIds: [],
      stats: {},
    };
    // 课文同步选择、发射动画、介母装配与单元总字数是家长设置而非学习记录，保留；
    // visitedDestinations / selectedRocketId 随重置清空；launchedUnits 由 stats 推导，随之归零。
    if (progress.textbook) fresh.textbook = progress.textbook;
    if (progress.launchFx) fresh.launchFx = progress.launchFx;
    if (progress.medialMode) fresh.medialMode = progress.medialMode;
    if (progress.unitTotal != null) fresh.unitTotal = progress.unitTotal;
    writeJson('progress', fresh);
    return sendJson(res, 200, { ok: true, previousLaunches, clearedStats });
  }

  return sendJson(res, 404, { error: `未知 API: ${method} ${p}` });
}

/* ----------------------------- 静态托管 ----------------------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  // 音节读音文件一律从 VOICE_OUT_DIR（重新生成的落盘目录）读取，
  // 保证「重新生成后试听」拿到的就是磁盘上最新那份音频。
  const isVoice = rel.startsWith('/audio/voice/');
  const baseDir = isVoice ? VOICE_OUT_DIR : PUBLIC_DIR;
  let filePath = path.normalize(path.join(baseDir, isVoice ? rel.slice('/audio/voice/'.length) : rel));
  // 音节 wav 双源解析：/audio/voice/{音节}.wav 按 voice-source 配置播生效源
  // （真人 lib/ 或 AI 根目录），?src=lib|tts 强制试听某一源。客户端 URL 不变。
  if (isVoice) {
    const m = rel.match(/^\/audio\/voice\/([a-z0-9]+)\.wav$/);
    if (m) {
      const resolved = resolveVoiceWav(m[1], url.searchParams.get('src'));
      if (resolved) filePath = resolved;
    }
  }
  // 防目录穿越
  if (!filePath.startsWith(baseDir)) {
    res.writeHead(403); return res.end('Forbidden');
  }
  fs.stat(filePath, (err, st) => {
    if (!err && st.isFile()) {
      const ext = path.extname(filePath).toLowerCase();
      // ETag / Last-Modified：让 no-cache 的「每次回源校验」成立——文件没变回 304，
      // 重新生成覆盖后 ETag 变化，浏览器立刻拿到新音频（而不是继续播旧缓存）。
      const etag = `"${st.mtimeMs.toString(36)}-${st.size.toString(36)}"`;
      const lastModified = st.mtime.toUTCString();
      const headers = {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
        'Content-Length': st.size,
        'ETag': etag,
        'Last-Modified': lastModified,
      };
      const ims = req.headers['if-modified-since'];
      if (req.headers['if-none-match'] === etag
        || (ims && Date.parse(ims) >= Math.floor(st.mtimeMs / 1000) * 1000)) {
        res.writeHead(304, { 'ETag': etag, 'Last-Modified': lastModified, 'Cache-Control': 'no-cache' });
        return res.end();
      }
      if (req.method === 'HEAD') { res.writeHead(200, headers); res.end(); return; }
      res.writeHead(200, headers);
      fs.createReadStream(filePath).pipe(res);
    } else if (req.method === 'GET' && !path.extname(rel)) {
      // SPA 回退
      res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
      fs.createReadStream(path.join(PUBLIC_DIR, 'index.html')).pipe(res);
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
    }
  });
}

/* ----------------------------- 服务器 ----------------------------- */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
    } else {
      serveStatic(req, res, url);
    }
  } catch (err) {
    console.error('[server error]', err);
    if (!res.headersSent) sendJson(res, 500, { error: '服务器内部错误', message: String(err?.message || err) });
    else res.end();
  }
});

server.listen(PORT, HOST, () => {
  const lan = [];
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces || []) {
      if (i.family === 'IPv4' && !i.internal) lan.push(i.address);
    }
  }
  console.log('🚀 星际发射指挥官 服务已启动 (Milestone 1)');
  console.log(`   本机:   http://127.0.0.1:${PORT}`);
  for (const ip of lan) console.log(`   局域网: http://${ip}:${PORT}   ← iPad Safari 打开此地址`);
  console.log(`   家长端: http://127.0.0.1:${PORT}/admin.html  (Milestone 5 实现)`);
});
