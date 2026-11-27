/**
 * tts-catalog.js — 语音合成（TTS）模型 / 音色内置目录（服务端 + 家长端共用）
 * ------------------------------------------------------------------
 * 为什么需要它？
 *  · 模型：大多数「OpenAI 兼容」接口都能用 GET /v1/models 列出模型（百炼业务空间域名是
 *    /compatible-mode/v1/models），家长端「自动获取」优先用真实列表；
 *  · 音色：百炼的系统音色**没有**查询接口（文档表格给出），只有自建/复刻音色能列出来
 *    （POST /api/v1/services/audio/tts/customization，action=list）。所以音色用本文件的
 *    内置音色表兜底，再和接口返回的定制音色合并。
 *
 * 重要约束：**音色必须属于当前模型**，跨模型混用接口会直接报
 * `InvalidParameter [cosyvoice:]Engine error [411]`。因此音色表按模型分桶，
 * 界面只展示「当前模型」那几个。
 *
 * 数据来源：
 *  · 百炼《Qwen-Audio-TTS 音色列表》 https://help.aliyun.com/zh/model-studio/qwen-audio-tts-voice-list
 *  · qwen-audio-3.0-tts-plus 的 4 个音色已在本机真实接口逐个验证（2026-11 实测可用）。
 * 音色表只是「建议列表」：填错不会坏，只会在「测试合成」时返回错误，界面上也可手填。
 */

/** 内置默认模型（与 server.js 的 TTS_MODEL_DEFAULT 一致）。 */
export const DEFAULT_TTS_MODEL = 'qwen-audio-3.0-tts-plus';

/** 已知语音合成模型（接口列不出模型时给家长的建议列表）。label 写「特点」而非模型全名，避免与 id 重复。 */
export const TTS_MODEL_CATALOG = [
  { id: 'qwen-audio-3.0-tts-plus', label: '旗舰（默认）', note: '真人音色最自然', recommended: true },
  { id: 'qwen-audio-3.0-tts-flash', label: '轻量 · 快', note: '便宜、响应快', recommended: true },
  { id: 'qwen-audio-3.1-tts-plus', label: '新一代旗舰', note: '', recommended: true },
  { id: 'qwen-audio-3.1-tts-flash', label: '新一代轻量', note: '', recommended: true },
];

/**
 * 系统音色表：model → [{ id, label }]，**第一个是该模型的默认音色**。
 * label 只写能确认的中文名，确认不了就留空（界面只显示 voice 参数）。
 */
export const TTS_VOICE_CATALOG = {
  // 实测（本机 2026-11）：这 4 个可用，其余 v3.6 音色会报 Engine error [411]。
  'qwen-audio-3.0-tts-plus': [
    { id: 'longanhuan_v3.6', label: '龙安欢（默认 · 女声）' },
    { id: 'longanlingxin', label: '龙安灵心（温暖女声）' },
    { id: 'longanlufeng', label: '龙安陆风（明朗男声）' },
    { id: 'longanlingxi', label: '龙安灵犀' },
  ],
  'qwen-audio-3.0-tts-flash': [
    { id: 'longanhuan_v3.6', label: '龙安欢（默认）' },
    { id: 'longanlingxin', label: '龙安灵心' },
    { id: 'longanlufeng', label: '龙安陆风' },
    { id: 'longanfengyue', label: '' },
    { id: 'longanyuanfei', label: '' },
    { id: 'longanlingxi', label: '' },
    { id: 'longanxiaoxin', label: '' },
    { id: 'longjielidou_v3.6', label: '' },
    { id: 'longpaopao_v3.6', label: '' },
    { id: 'longhuohuo_v3.6', label: '' },
    { id: 'longchuanshu_v3.6', label: '' },
    { id: 'loongmary', label: '' },
    { id: 'loongeva_v3.6', label: '' },
    { id: 'loongjohn', label: '' },
  ],
  'qwen-audio-3.1-tts-plus': [
    { id: 'longanhuan_v3.1', label: '龙安欢（默认）' },
    { id: 'longanlingxin_v3.1', label: '龙安灵心' },
    { id: 'longanfengyue_v3.1', label: '' },
    { id: 'xunanchuan_v3.1', label: '' },
  ],
  'qwen-audio-3.1-tts-flash': [
    { id: 'longanhuan_v3.1', label: '龙安欢（默认）' },
    { id: 'longanlingxin_v3.1', label: '龙安灵心' },
    { id: 'longanfengyue_v3.1', label: '' },
    { id: 'xunanchuan_v3.1', label: '' },
  ],
};

/** 接口返回的模型 id 是否像「语音合成」模型（实时语音 / 识别模型不能走这个 HTTP 接口）。 */
export function isTtsModel(id) {
  const s = String(id || '');
  if (!/tts|cosyvoice|sambert/i.test(s)) return false;
  return !/realtime|asr/i.test(s);
}

/** 已知模型的目录项（带 label / note），未知返回 null。 */
export function catalogModel(id) {
  return TTS_MODEL_CATALOG.find((m) => m.id === id) || null;
}

/** 模型下拉框里的短标签（未知模型返回空串，界面只显示 id）。 */
export function ttsModelLabel(id) {
  const hit = catalogModel(id);
  if (hit) return hit.label;
  return isTtsModel(id) ? '语音合成模型' : '';
}

/** 音色表按模型查找：精确匹配优先，其次按前缀匹配带日期后缀的同族模型。 */
function voiceBucket(model) {
  const id = String(model || '');
  if (!id) return null;
  if (TTS_VOICE_CATALOG[id]) return TTS_VOICE_CATALOG[id];
  const keys = Object.keys(TTS_VOICE_CATALOG).sort((a, b) => b.length - a.length);
  const hit = keys.find((k) => id.startsWith(k));
  return hit ? TTS_VOICE_CATALOG[hit] : null;
}

/** 某模型的内置音色（含 model / source 字段，便于和接口音色合并去重）。 */
export function voicesForModel(model) {
  const bucket = voiceBucket(model);
  if (!bucket) return [];
  return bucket.map((v) => ({ id: v.id, label: v.label || '', model, source: 'catalog' }));
}

/** 某模型的默认音色（内置表第一项；没有内置表返回空串）。 */
export function defaultVoiceFor(model) {
  const list = voicesForModel(model);
  return list[0]?.id || '';
}
