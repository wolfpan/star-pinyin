/**
 * rules.test.mjs — 拼音规则引擎单元测试（零依赖，node:assert）
 * 运行：node test/rules.test.mjs
 */
import assert from 'node:assert/strict';
import {
  INITIALS, FINALS, WHOLE_SYLLABLES, MEDIALS, KOU_HU_FINALS,
  buildSyllable, markTone, toneTargetIndex, detectSpecialRule,
  assembleAndMark, validateMission, removeDots, RULE_DROP_DOTS,
} from '../public/js/pinyin-rules.js';

let pass = 0, fail = 0;
const failures = [];
function test(name, fn) {
  try { fn(); pass++; console.log('  \u2713 ' + name); }
  catch (e) { fail++; failures.push([name, e]); console.log('  \u2717 ' + name + ' \u2192 ' + e.message); }
}
const eq = assert.equal;

console.log('\n[1] 常量表完整性');
test('23 个声母', () => eq(INITIALS.length, 23));
test('24 个韵母', () => eq(FINALS.length, 24));
test('16 个整体认读音节', () => eq(WHOLE_SYLLABLES.length, 16));
test('3 个介母 i/u/ü', () => eq(MEDIALS.length, 3));
test('合口呼韵母只算 u/ui/un（iu 属齐齿呼）', () => eq(KOU_HU_FINALS.join('/'), 'u/ui/un'));

console.log('\n[2] 标调口诀：有 a 找 a，无 a 找 o/e，i/u 并列标在后');
test('ma 四声', () => { eq(markTone('ma', 1), 'mā'); eq(markTone('ma', 2), 'má'); eq(markTone('ma', 3), 'mǎ'); eq(markTone('ma', 4), 'mà'); });
test('有 a 找 a: chuan→chuán', () => eq(markTone('chuan', 2), 'chuán'));
test('有 a 找 a: huai→huái', () => eq(markTone('huai', 2), 'huái'));
test('有 a 找 a: qiao→qiáo', () => eq(markTone('qiao', 2), 'qiáo'));
test('无 a 找 o: huo→huǒ', () => eq(markTone('huo', 3), 'huǒ'));
test('无 a 找 o: gou→gǒu', () => eq(markTone('gou', 3), 'gǒu'));
test('无 a 找 e: sheng→shēng', () => eq(markTone('sheng', 1), 'shēng'));
test('无 a 找 e: lei→léi', () => eq(markTone('lei', 2), 'léi'));
test('i/u 并列标在后: ui→i (gui→guì)', () => eq(markTone('gui', 4), 'guì'));
test('i/u 并列标在后: ui→i (dui→duì)', () => eq(markTone('dui', 4), 'duì'));
test('i/u 并列标在后: iu→u (liu→liú)', () => eq(markTone('liu', 2), 'liú'));
test('i/u 并列标在后: iu→u (jiu→jiǔ)', () => eq(markTone('jiu', 3), 'jiǔ'));
test('i/u 并列标在后: iu→u (qiu→qiū)', () => eq(markTone('qiu', 1), 'qiū'));
test('i/u 并列标在后: iu→u (niu→niú)', () => eq(markTone('niu', 2), 'niú'));
test('单元音 i: pin→pīn', () => eq(markTone('pin', 1), 'pīn'));
test('单元音 i: ping→píng', () => eq(markTone('ping', 2), 'píng'));
test('单元音 u: jun→jūn', () => eq(markTone('jun', 1), 'jūn'));
test('单元音 u: xun→xún', () => eq(markTone('xun', 2), 'xún'));
test('n/l 后 ü 保留两点: nü→nǚ', () => eq(markTone('nü', 3), 'nǚ'));
test('n/l 后 ü 保留两点: lü→lǜ', () => eq(markTone('lü', 4), 'lǜ'));
test('轻声不标调', () => { eq(markTone('ma', 0), 'ma'); eq(markTone('ma', 5), 'ma'); });
test('标调下标: chuan→a(3)', () => eq(toneTargetIndex('chuan'), 3));
test('标调下标: gui→i(2)', () => eq(toneTargetIndex('gui'), 2));
test('标调下标: liu→u(2)', () => eq(toneTargetIndex('liu'), 2));

console.log('\n[3] 声韵母拼接 buildSyllable');
test('两拼 m+a→ma', () => eq(buildSyllable({ initial: 'm', medial: null, final: 'a' }, 'two_part'), 'ma'));
test('三拼 ch+u+an→chuan', () => eq(buildSyllable({ initial: 'ch', medial: 'u', final: 'an' }, 'three_part'), 'chuan'));
test('j+ü→ju（摘点）', () => eq(buildSyllable({ initial: 'j', medial: null, final: 'ü' }, 'two_part'), 'ju'));
test('q+ü+an→quan（摘点）', () => eq(buildSyllable({ initial: 'q', medial: 'ü', final: 'an' }, 'three_part'), 'quan'));
test('x+üe→xue（摘点）', () => eq(buildSyllable({ initial: 'x', medial: null, final: 'üe' }, 'two_part'), 'xue'));
test('j+ün→jun（摘点）', () => eq(buildSyllable({ initial: 'j', medial: null, final: 'ün' }, 'two_part'), 'jun'));
test('n+ü→nü（保留两点）', () => eq(buildSyllable({ initial: 'n', medial: null, final: 'ü' }, 'two_part'), 'nü'));
test('零声母 an→an', () => eq(buildSyllable({ initial: null, medial: null, final: 'an' }, 'zero_initial'), 'an'));
test('零声母 er→er', () => eq(buildSyllable({ initial: null, medial: null, final: 'er' }, 'zero_initial'), 'er'));
test('整体认读 yuan→yuan', () => eq(buildSyllable({ whole: 'yuan' }, 'whole_syllable'), 'yuan'));
test('removeDots üe→ue', () => eq(removeDots('üe'), 'ue'));

console.log('\n[4] j/q/x 去点检测 detectSpecialRule');
test('j+ü 触发', () => eq(detectSpecialRule({ initial: 'j', final: 'ü' }), RULE_DROP_DOTS));
test('q+ü+an 触发', () => eq(detectSpecialRule({ initial: 'q', medial: 'ü', final: 'an' }), RULE_DROP_DOTS));
test('x+üe 触发', () => eq(detectSpecialRule({ initial: 'x', final: 'üe' }), RULE_DROP_DOTS));
test('j+i+a 不触发', () => eq(detectSpecialRule({ initial: 'j', medial: 'i', final: 'a' }), null));
test('ch+u+an 不触发', () => eq(detectSpecialRule({ initial: 'ch', medial: 'u', final: 'an' }), null));
test('n+ü 不触发', () => eq(detectSpecialRule({ initial: 'n', final: 'ü' }), null));

console.log('\n[5] 拼形+标调 assembleAndMark');
test('j+ü 一声→jū', () => eq(assembleAndMark({ initial: 'j', final: 'ü' }, 'two_part', 1), 'jū'));
test('x+üe 三声→xuě', () => eq(assembleAndMark({ initial: 'x', final: 'üe' }, 'two_part', 3), 'xuě'));
test('q+ü+an 二声→quán', () => eq(assembleAndMark({ initial: 'q', medial: 'ü', final: 'an' }, 'three_part', 2), 'quán'));
test('整体 yuan 二声→yuán', () => eq(assembleAndMark({ whole: 'yuan' }, 'whole_syllable', 2), 'yuán'));

console.log('\n[6] validateMission 校验逻辑');
const good = { id: 't1', type: 'two_part', parts: { initial: 'm', medial: null, final: 'a' }, tone: 1, displayPinyin: 'mā', specialRule: null, distractors: {} };
test('合法两拼通过', () => eq(validateMission(good).ok, true));
test('标调错误被拦截', () => eq(validateMission({ ...good, displayPinyin: 'má' }).ok, false));
test('specialRule 误标被拦截', () => eq(validateMission({ ...good, specialRule: RULE_DROP_DOTS }).ok, false));
test('非法整体认读被拦截', () => eq(validateMission({ id: 't2', type: 'whole_syllable', parts: { whole: 'zha' }, tone: 1, displayPinyin: 'zhā', specialRule: null }).ok, false));
test('j+u 非法拼合被拦截', () => eq(validateMission({ id: 't3', type: 'two_part', parts: { initial: 'j', medial: null, final: 'u' }, tone: 1, displayPinyin: 'jū', specialRule: null }).ok, false));
test('j+ui 非法拼合被拦截', () => eq(validateMission({ id: 't4', type: 'two_part', parts: { initial: 'j', medial: null, final: 'ui' }, tone: 1, displayPinyin: 'juī', specialRule: null }).ok, false));
test('j+un 非法拼合被拦截', () => eq(validateMission({ id: 't5', type: 'two_part', parts: { initial: 'j', medial: null, final: 'un' }, tone: 1, displayPinyin: 'jūn', specialRule: null }).ok, false));
test('j+u+a 三拼非法被拦截', () => eq(validateMission({ id: 't6', type: 'three_part', parts: { initial: 'j', medial: 'u', final: 'a' }, tone: 1, displayPinyin: 'juā', specialRule: null }).ok, false));
test('j+iu 合法（齐齿呼）: 九 jiǔ', () => eq(validateMission({ id: 't7', type: 'two_part', parts: { initial: 'j', medial: null, final: 'iu' }, tone: 3, displayPinyin: 'jiǔ', specialRule: null }).ok, true));
test('q+iu 合法（齐齿呼）: 秋 qiū', () => eq(validateMission({ id: 't8', type: 'two_part', parts: { initial: 'q', medial: null, final: 'iu' }, tone: 1, displayPinyin: 'qiū', specialRule: null }).ok, true));
test('x+iu 合法（齐齿呼）: 修 xiū', () => eq(validateMission({ id: 't9', type: 'two_part', parts: { initial: 'x', medial: null, final: 'iu' }, tone: 1, displayPinyin: 'xiū', specialRule: null }).ok, true));

console.log(`\n引擎单元测试结果: ${pass} 通过, ${fail} 失败`);
if (fail > 0) {
  console.error('\n失败明细:');
  for (const [name, e] of failures) console.error(`  - ${name}: ${e.message}`);
  process.exit(1);
}
