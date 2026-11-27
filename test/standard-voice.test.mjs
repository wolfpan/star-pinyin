/**
 * standard-voice.test.mjs — audio-cmn 真人音节库导入映射测试（零依赖，不联网）。
 * 验证音节键 → 库文件名/URL 的映射（ü→v 与 fileKey 一致），
 * 以及词库全部音节键都能映射为合法的 ASCII 库文件名。
 * 真实下载/转码由 scripts/import-standard-voice.mjs 执行，报告落盘 data/voice-import-report.json。
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { libFileName, libUrl, LIB_RAW, LIB_LICENSE, resolveLibName } from '../scripts/import-standard-voice.mjs';
import { collectSyllables, fileKey } from '../scripts/syllable-voice-lib.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0, fail = 0;
const check = (name, fn) => { try { fn(); console.log('  ✓ ' + name); pass++; } catch (e) { console.log('  ✗ ' + name + ' — ' + e.message); fail++; } };

console.log('真人音节库导入映射');

check('ju4 → cmn-ju4.mp3', () => assert.strictEqual(libFileName('ju4'), 'cmn-ju4.mp3'));
check('zhi1 → cmn-zhi1.mp3', () => assert.strictEqual(libFileName('zhi1'), 'cmn-zhi1.mp3'));
check('lü4 → cmn-lv4.mp3（ü→v）', () => assert.strictEqual(libFileName('lü4'), 'cmn-lv4.mp3'));
check('nü3 → cmn-nv3.mp3', () => assert.strictEqual(libFileName('nü3'), 'cmn-nv3.mp3'));
check('lüe4 → cmn-lve4.mp3', () => assert.strictEqual(libFileName('lüe4'), 'cmn-lve4.mp3'));
check('libUrl = RAW + 文件名', () => assert.strictEqual(libUrl('lv4'), LIB_RAW + 'cmn-lv4.mp3'));
check('授权标注为 CC-BY-SA-3.0', () => assert.strictEqual(LIB_LICENSE, 'CC-BY-SA-3.0'));

// 库命名异类解析（ju4 存成 cmn-jv4.mp3；n/l 的 v 不做 u 回退，避免 lü→lu 读错）
const fakeSet = new Set(['cmn-jv4.mp3', 'cmn-ju1.mp3', 'cmn-qu1.mp3', 'cmn-lv3.mp3', 'cmn-lu3.mp3', 'cmn-zhu4.mp3']);
check('ju4 缺失时解析到 jv4 变体', () => assert.strictEqual(resolveLibName('ju4', fakeSet), 'cmn-jv4.mp3'));
check('ju1 正常命名优先', () => assert.strictEqual(resolveLibName('ju1', fakeSet), 'cmn-ju1.mp3'));
check('qu1 正常命名', () => assert.strictEqual(resolveLibName('qu1', fakeSet), 'cmn-qu1.mp3'));
check('lü3 → lv3（不回退 lu3）', () => assert.strictEqual(resolveLibName('lü3', fakeSet), 'cmn-lv3.mp3'));
check('lü3 缺 lv3 时绝不拿 lu3 顶替', () => assert.strictEqual(resolveLibName('lü3', new Set(['cmn-lu3.mp3'])), null));
check('库里没有 → null', () => assert.strictEqual(resolveLibName('zhuang9', fakeSet), null));

// 词库全量音节键 → 合法 ASCII 库文件名
const missions = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'missions.json'), 'utf8'));
const keys = [...collectSyllables(missions).keys()];
check('词库音节键非空（>900）', () => assert.ok(keys.length > 900, String(keys.length)));
check('全部键映射为 cmn-{a-z}{1-4}.mp3', () => {
  for (const k of keys) {
    assert.match(libFileName(k), /^cmn-[a-z]+[1-4]\.mp3$/, `${k} → ${libFileName(k)}`);
  }
});
check('映射无碰撞（键数 = 文件名数）', () => {
  assert.strictEqual(new Set(keys.map(libFileName)).size, keys.length);
});
check('映射与 fileKey 一致（ü→v）', () => {
  for (const k of keys) assert.strictEqual(libFileName(k), `cmn-${fileKey(k)}.mp3`);
});

console.log(`\n通过 ${pass} · 失败 ${fail}`);
process.exit(fail ? 1 : 0);