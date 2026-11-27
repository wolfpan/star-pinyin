/**
 * parse.test.mjs — 拼音自动拆分 parseSyllable 测试（零依赖）
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSyllable, validateMission } from '../public/js/pinyin-rules.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const missions = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'missions.json'), 'utf8'));
let pass = 0, fail = 0;
function test(name, fn) { try { fn(); pass++; console.log('  \u2713 ' + name); } catch (e) { fail++; console.log('  \u2717 ' + name + ' \u2192 ' + e.message); } }
const eq = assert.equal;

console.log('\n[1] 自动拆分基本用例');
const P = parseSyllable;
test('chuán → 三拼 ch/u/an 2', () => { const r = P('chuán'); eq(r.type, 'three_part'); eq(r.parts.initial, 'ch'); eq(r.parts.medial, 'u'); eq(r.parts.final, 'an'); eq(r.tone, 2); eq(r.displayPinyin, 'chuán'); });
test('chuan2 数字后缀同上', () => { const r = P('chuan2'); eq(r.type, 'three_part'); eq(r.tone, 2); eq(r.displayPinyin, 'chuán'); });
test('mā → 两拼 m/a 1', () => { const r = P('mā'); eq(r.type, 'two_part'); eq(r.parts.final, 'a'); eq(r.tone, 1); });
test('xue3 → x/üe 3 去点', () => { const r = P('xue3'); eq(r.parts.final, 'üe'); eq(r.specialRule, 'j_q_x_drop_dots'); eq(r.displayPinyin, 'xuě'); });
test('ju1 → j/ü 1 去点', () => { const r = P('ju1'); eq(r.parts.final, 'ü'); eq(r.specialRule, 'j_q_x_drop_dots'); eq(r.displayPinyin, 'jū'); });
test('quan2 → q/ü/an 2 去点', () => { const r = P('quan2'); eq(r.type, 'three_part'); eq(r.parts.medial, 'ü'); eq(r.parts.final, 'an'); eq(r.displayPinyin, 'quán'); });
test('jun1 → j/ün 1', () => { const r = P('jun1'); eq(r.parts.final, 'ün'); eq(r.displayPinyin, 'jūn'); });
test('zhi1 → 整体认读', () => { const r = P('zhi1'); eq(r.type, 'whole_syllable'); eq(r.parts.whole, 'zhi'); eq(r.displayPinyin, 'zhī'); });
test('yuan2 → 整体认读', () => { const r = P('yuan2'); eq(r.type, 'whole_syllable'); eq(r.displayPinyin, 'yuán'); });
test('an1 → 零声母', () => { const r = P('an1'); eq(r.type, 'zero_initial'); eq(r.parts.final, 'an'); eq(r.displayPinyin, 'ān'); });
test('er2 → 零声母', () => { const r = P('er2'); eq(r.type, 'zero_initial'); eq(r.displayPinyin, 'ér'); });
test('lü4 → l/ü 保留两点', () => { const r = P('lü4'); eq(r.parts.final, 'ü'); eq(r.specialRule, null); eq(r.displayPinyin, 'lǜ'); });
test('nv3 → n/ü（v=ü）', () => { const r = P('nv3'); eq(r.parts.final, 'ü'); eq(r.displayPinyin, 'nǚ'); });
test('gui4 → 两拼 g/ui（非三拼）', () => { const r = P('gui4'); eq(r.type, 'two_part'); eq(r.parts.final, 'ui'); eq(r.displayPinyin, 'guì'); });
test('liu2 → 两拼 l/iu', () => { const r = P('liu2'); eq(r.type, 'two_part'); eq(r.parts.final, 'iu'); eq(r.displayPinyin, 'liú'); });
test('jiang1 → 三拼 j/i/ang', () => { const r = P('jiang1'); eq(r.type, 'three_part'); eq(r.parts.medial, 'i'); eq(r.parts.final, 'ang'); eq(r.displayPinyin, 'jiāng'); });
test('zhuo1 → 三拼 zh/u/o', () => { const r = P('zhuo1'); eq(r.type, 'three_part'); eq(r.parts.initial, 'zh'); eq(r.parts.medial, 'u'); eq(r.parts.final, 'o'); eq(r.displayPinyin, 'zhuō'); });

console.log(`\n[2] 全库 ${missions.length} 条 displayPinyin 往返拆分一致`);
let roundTrip = 0;
for (const m of missions) {
  const r = P(m.displayPinyin);
  const ok = r.displayPinyin === m.displayPinyin && r.tone === m.tone && r.specialRule === (m.specialRule ?? null) && r.type === m.type;
  if (ok) roundTrip++;
  else test(`往返 ${m.id} ${m.displayPinyin}`, () => assert.fail(`got ${r.type}/${r.displayPinyin}/${r.tone}/${r.specialRule}`));
}
test(`${missions.length}/${missions.length} 往返一致（实际 ${roundTrip}）`, () => eq(roundTrip, missions.length));

console.log('\n[3] 拆分结果可通过 validateMission');
let valid = 0;
for (const m of missions) {
  const r = P(m.displayPinyin);
  const mission = { id: 'x', hanzi: m.hanzi, word: m.word, type: r.type, parts: r.parts, tone: r.tone, displayPinyin: r.displayPinyin, specialRule: r.specialRule, distractors: {} };
  if (validateMission(mission).ok) valid++;
}
test(`${missions.length}/${missions.length} 拆分校验通过（实际 ${valid}）`, () => eq(valid, missions.length));

console.log(`\n自动拆分测试结果: ${pass} 通过, ${fail} 失败`);
if (fail) process.exit(1);
