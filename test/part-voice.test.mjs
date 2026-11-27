/**
 * part-voice.test.mjs — 零件读音播放调度纯逻辑测试（零依赖，Node 内模拟浏览器环境）。
 * 验证 audio-engine.speakPart / slowSplit 请求正确的本地零件文件，无需真实浏览器。
 * 读音一律 fetch(cache:'no-store')→blob→Audio 播放（绕过浏览器媒体缓存，
 * 保证家长端「重新生成」覆盖同名文件后立刻听到新读音）。
 */
import assert from 'node:assert';

// ---- 模拟浏览器全局 ----
const played = [];        // 记录实际播放的音频源地址（blob URL 还原为源 URL）
const headReqs = [];      // 记录 fetch HEAD
const getReqs = [];       // 记录 fetch GET（取音频字节）及其 cache 模式
class FakeAudio {
  constructor(url) { this.url = url; this.playbackRate = 1; played.push(String(url).replace(/^blob:/, '')); }
  addEventListener() {}
  play() { return Promise.resolve(); }
  pause() {}
}
globalThis.Audio = FakeAudio;
globalThis.URL.createObjectURL = (b) => 'blob:' + b.src;
globalThis.URL.revokeObjectURL = () => {};
globalThis.window = {
  speechSynthesis: { cancel() {}, speak() {}, getVoices: () => [] },
};
globalThis.fetch = async (url, opts = {}) => {
  if (opts.method === 'HEAD') { headReqs.push(url); return { ok: true }; }
  getReqs.push({ url, cache: opts.cache });
  return { ok: true, blob: async () => ({ size: 2048, src: url }) };
};

const { default: AudioEngine } = await import('../public/js/audio-engine.js');

let pass = 0, fail = 0;
const check = (name, fn) => { try { fn(); console.log('  ✓ ' + name); pass++; } catch (e) { console.log('  ✗ ' + name + ' — ' + e.message); fail++; } };

console.log('零件读音播放调度');

// speakPart 走本地零件文件
played.length = 0;
await AudioEngine.speakPart('a');
check('speakPart(a) → part/a.mp3', () => assert.ok(played.includes('/audio/voice/part/a.mp3'), JSON.stringify(played)));

played.length = 0;
await AudioEngine.speakPart('sh');
check('speakPart(sh) → part/sh.mp3', () => assert.ok(played.includes('/audio/voice/part/sh.mp3')));

// ü 系文件名映射 ü→v
played.length = 0;
await AudioEngine.speakPart('ü');
check('speakPart(ü) → part/v.mp3', () => assert.ok(played.includes('/audio/voice/part/v.mp3'), JSON.stringify(played)));
played.length = 0;
await AudioEngine.speakPart('üe');
check('speakPart(üe) → part/ve.mp3', () => assert.ok(played.includes('/audio/voice/part/ve.mp3')));
played.length = 0;
await AudioEngine.speakPart('ün');
check('speakPart(ün) → part/vn.mp3', () => assert.ok(played.includes('/audio/voice/part/vn.mp3')));

// slowSplit（沙 m_126：sh + a + 整体 shā）
// 注意：整体音节优先本地 wav（离线预生成、响度归一），旧 mp3 只作兜底
played.length = 0;
const sha = { id: 'm_126', hanzi: '沙', type: 'two_part', parts: { initial: 'sh', medial: null, final: 'a' }, tone: 1 };
await AudioEngine.slowSplit(sha);
check('slowSplit(沙) 含 part/sh.mp3', () => assert.ok(played.includes('/audio/voice/part/sh.mp3'), JSON.stringify(played)));
check('slowSplit(沙) 含 part/a.mp3', () => assert.ok(played.includes('/audio/voice/part/a.mp3')));
check('slowSplit(沙) 整体优先 sha1.wav', () => assert.ok(played.includes('/audio/voice/sha1.wav'), JSON.stringify(played)));

// slowSplit 三拼（花 hua：h + u + a）
played.length = 0;
const hua = { id: 'x', hanzi: '花', type: 'three_part', parts: { initial: 'h', medial: 'u', final: 'a' }, tone: 1 };
await AudioEngine.slowSplit(hua);
check('slowSplit(花) 含 part/h.mp3 + part/u.mp3 + part/a.mp3', () => {
  for (const p of ['h', 'u', 'a']) assert.ok(played.includes('/audio/voice/part/' + p + '.mp3'), JSON.stringify(played));
});

// 缓存回归：所有音频都必须 no-store 取字节，绝不让浏览器媒体缓存播旧读音
check('音频一律 cache:no-store 取字节（重新生成后不播旧缓存）', () => {
  assert.ok(getReqs.length > 0, '应有音频 GET 请求');
  for (const r of getReqs) assert.equal(r.cache, 'no-store', JSON.stringify(r));
});

console.log(`\n零件读音调度测试结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);