/**
 * assembly.test.mjs — Milestone 2 落点判定纯逻辑测试（零依赖）
 * 验证：四种拼音构型都能正常装配；j/q/x+ü 触发摘墨镜；错选/错槽回弹计错。
 * 运行：node test/assembly.test.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDrop } from '../public/js/drag-engine.js';
import { layoutFor, nextHintSlot } from '../public/js/ui-renderer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const missions = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'missions.json'), 'utf8'));

let pass = 0, fail = 0; const failures = [];
function test(name, fn) {
  try { fn(); pass++; console.log('  \u2713 ' + name); }
  catch (e) { fail++; failures.push([name, e]); console.log('  \u2717 ' + name + ' \u2192 ' + e.message); }
}
const eq = assert.equal;

function activeGroups(m) {
  if (m.type === 'whole_syllable') return ['whole'];
  if (m.type === 'zero_initial') return ['final'];
  if (m.type === 'two_part') return ['initial', 'final'];
  return ['initial', 'medial', 'final'];
}
const metaOf = (group, value) => ({ group, value, isUmlaut: typeof value === 'string' && value.includes('ü') });

console.log(`\n[1] ${missions.length} 题正确零件均可装配（snap 或 dots，绝不 bounce）`);
let assembled = 0;
const configSeen = new Set();
for (const m of missions) {
  let initialFilled = false;
  let allOk = true;
  for (const group of activeGroups(m)) {
    const value = m.parts[group];
    const d = resolveDrop(m, metaOf(group, value), { id: group, group }, { initialFilled });
    if (d.action === 'bounce') { allOk = false; break; }
    if (group === 'initial') initialFilled = true;
  }
  if (allOk) { assembled++; configSeen.add(m.type); }
  else test(`装配 ${m.id} ${m.hanzi}`, () => assert.fail('正确零件被回弹'));
}
test(`${missions.length}/${missions.length} 正确装配（实际 ${assembled}）`, () => eq(assembled, missions.length));
test('覆盖四种构型', () => {
  for (const t of ['two_part', 'three_part', 'whole_syllable', 'zero_initial']) eq(configSeen.has(t), true, `缺 ${t}`);
});

console.log('\n[2] 各构型落点动作');
const byId = (id) => missions.find((m) => m.id === id);
test('两拼 m_001 组: 声母/韵母 snap', () => {
  const m = byId('m_001');
  eq(resolveDrop(m, metaOf('initial', 'z'), { id: 'initial', group: 'initial' }, { initialFilled: false }).action, 'snap');
  eq(resolveDrop(m, metaOf('final', 'u'), { id: 'final', group: 'final' }, { initialFilled: true }).action, 'snap');
});
test('三拼 m_011 船: 声母/介母/韵母 snap', () => {
  const m = byId('m_011');
  eq(resolveDrop(m, metaOf('medial', 'u'), { id: 'medial', group: 'medial' }, { initialFilled: true }).action, 'snap');
  eq(resolveDrop(m, metaOf('final', 'an'), { id: 'final', group: 'final' }, { initialFilled: true }).action, 'snap');
});
test('整体 m_034 知: 一体箭体 snap', () => {
  const m = byId('m_034');
  eq(resolveDrop(m, metaOf('whole', 'zhi'), { id: 'whole', group: 'whole' }, { initialFilled: false }).action, 'snap');
});
test('j/q/x m_026 居: 先装声母 j，再 ü 触发 dots', () => {
  const m = byId('m_026');
  eq(resolveDrop(m, metaOf('initial', 'j'), { id: 'initial', group: 'initial' }, { initialFilled: false }).action, 'snap');
  eq(resolveDrop(m, metaOf('final', 'ü'), { id: 'final', group: 'final' }, { initialFilled: true }).action, 'dots');
});
test('j/q/x m_033 雪: üe 触发 dots', () => {
  const m = byId('m_033');
  eq(resolveDrop(m, metaOf('final', 'üe'), { id: 'final', group: 'final' }, { initialFilled: true }).action, 'dots');
});
test('j/q/x m_031 军: ün 触发 dots', () => {
  const m = byId('m_031');
  eq(resolveDrop(m, metaOf('final', 'ün'), { id: 'final', group: 'final' }, { initialFilled: true }).action, 'dots');
});

console.log('\n[3] 错误与边界');
test('未落入槽位 → 静默回弹（不计错）', () => {
  const m = byId('m_001');
  const d = resolveDrop(m, metaOf('initial', 'z'), null, { initialFilled: false });
  eq(d.action, 'bounce'); eq(d.error, undefined);
});
test('错槽（声母拖到韵母槽）→ 回弹计错', () => {
  const m = byId('m_001');
  const d = resolveDrop(m, metaOf('initial', 'z'), { id: 'final', group: 'final' }, { initialFilled: false });
  eq(d.action, 'bounce'); eq(d.error, true); eq(d.reason, 'wrong-slot');
});
test('错值（干扰项）→ 回弹计错', () => {
  const m = byId('m_001');
  const d = resolveDrop(m, metaOf('initial', 'zh'), { id: 'initial', group: 'initial' }, { initialFilled: false });
  eq(d.action, 'bounce'); eq(d.error, true); eq(d.reason, 'wrong-value');
});
test('ü 未装声母 → 提示先装声母', () => {
  const m = byId('m_026');
  const d = resolveDrop(m, metaOf('final', 'ü'), { id: 'final', group: 'final' }, { initialFilled: false });
  eq(d.action, 'bounce'); eq(d.reason, 'need-initial'); eq(d.flash, 'initial');
});
test('n/l+ü 不触发摘墨镜（普通 snap）', () => {
  const m = { parts: { initial: 'n', medial: null, final: 'ü' } };
  eq(resolveDrop(m, metaOf('final', 'ü'), { id: 'final', group: 'final' }, { initialFilled: true }).action, 'snap');
});

console.log('\n[4] 介母装配选项（家长后台「学习管理」：孩子填入 / 自动预装）');
const ids = (l) => l.active.map((r) => r.id).join(',');
test('默认（required）：三拼介母为活动槽，托盘出声母/介母/韵母', () => {
  const l = layoutFor(byId('m_011'));
  eq(ids(l), 'initial,medial,final');
  eq(l.prefilled.length, 0);
  eq(l.locked.length, 0);
});
test('自动预装（auto）：介母变预装段，孩子只拼声母+韵母', () => {
  const m = byId('m_011'); // 船 ch-u-an
  const l = layoutFor(m, { medialAuto: true });
  eq(ids(l), 'initial,final');
  eq(l.prefilled.length, 1);
  eq(l.prefilled[0].id, 'medial');
  eq(l.prefilled[0].note, 'u'); // 预装段直接显示正确介母
  eq(l.locked.length, 0);
});
test('auto：i 介母原样预装（家 j-i-a）', () => {
  const l = layoutFor(byId('m_018'), { medialAuto: true });
  eq(l.prefilled[0].note, 'i');
});
test('auto：j/q/x+ü 介母预装去点书写形 u（ü→u）', () => {
  const jqxU = missions.filter((m) => m.type === 'three_part' && m.parts.medial === 'ü');
  assert.ok(jqxU.length > 0, '词库应含 j/q/x+ü 三拼');
  for (const m of jqxU) {
    assert.ok(['j', 'q', 'x'].includes(m.parts.initial), `ü 介母只应出现在 j/q/x 后: ${m.id}`);
    const l = layoutFor(m, { medialAuto: true });
    eq(l.prefilled[0].note, 'u', `${m.id} ${m.displayPinyin}`);
    eq(ids(l), 'initial,final');
  }
});
test('auto：全库三拼预装值 = 正确介母书写形，且活动槽只剩声母+韵母', () => {
  for (const m of missions.filter((x) => x.type === 'three_part')) {
    const l = layoutFor(m, { medialAuto: true });
    eq(ids(l), 'initial,final', m.id);
    const want = ['j', 'q', 'x'].includes(m.parts.initial) ? m.parts.medial.replace(/ü/g, 'u') : m.parts.medial;
    eq(l.prefilled[0].note, want, m.id);
  }
});
test('两拼 / 零声母 / 整体认读不受选项影响', () => {
  const samples = ['two_part', 'zero_initial', 'whole_syllable'].map((t) => missions.find((m) => m.type === t));
  for (const m of samples) {
    eq(JSON.stringify(layoutFor(m)), JSON.stringify(layoutFor(m, { medialAuto: true })), m.id);
  }
});
test('两拼：不渲染介母舱段，箭体两段连续覆盖', () => {
  const m = missions.find((x) => x.type === 'two_part');
  const l = layoutFor(m);
  const all = [...l.active, ...l.locked, ...l.prefilled];
  eq(all.some((r) => r.id === 'medial'), false);
  const ys = [...new Set(all.flatMap((r) => [r.y0, r.y1]))].sort((a, b) => a - b);
  eq(ys.join(','), '70,260,450');
});
test('零声母：单仓一体箭体，仅装配韵母', () => {
  const m = missions.find((x) => x.type === 'zero_initial');
  const l = layoutFor(m);
  eq(l.active.length, 1);
  eq(l.active[0].id, 'final');
  eq(l.active[0].y0, 70);
  eq(l.active[0].y1, 450);
  eq(l.locked.length, 0);
  eq(l.prefilled.length, 0);
});
test('auto 下剩余活动槽正确零件仍可装配（resolveDrop 不变）', () => {
  const m = byId('m_011');
  const l = layoutFor(m, { medialAuto: true });
  let initialFilled = false;
  for (const r of l.active) {
    const d = resolveDrop(m, metaOf(r.group, m.parts[r.group]), { id: r.id, group: r.group }, { initialFilled });
    assert.notEqual(d.action, 'bounce', `${m.id} ${r.group}`);
    if (r.group === 'initial') initialFilled = true;
  }
});

console.log('\n[5] 错两次自动帮扶目标选择（nextHintSlot 纯逻辑）');
const filledSet = (ids) => (id) => ids.includes(id);
test('三拼：未装 → 先帮扶声母；装好声母 → 介母；再装 → 韵母', () => {
  const l = layoutFor(byId('m_011'));
  eq(nextHintSlot(l, filledSet([])).id, 'initial');
  eq(nextHintSlot(l, filledSet(['initial'])).id, 'medial');
  eq(nextHintSlot(l, filledSet(['initial', 'medial'])).id, 'final');
});
test('全装完 → null（完成横幅阶段不再帮扶）', () => {
  const l = layoutFor(byId('m_011'));
  eq(nextHintSlot(l, filledSet(['initial', 'medial', 'final'])), null);
});
test('两拼 / 零声母 / 整体认读：跳过锁定与预装段', () => {
  eq(nextHintSlot(layoutFor(byId('m_001')), filledSet([])).id, 'initial');
  eq(nextHintSlot(layoutFor(byId('m_001')), filledSet(['initial'])).id, 'final');
  const zero = missions.find((m) => m.type === 'zero_initial');
  eq(nextHintSlot(layoutFor(zero), filledSet([])).id, 'final');
  eq(nextHintSlot(layoutFor(byId('m_034')), filledSet([])).id, 'whole');
});
test('介母自动预装：帮扶只走声母→韵母（跳过预装介母）', () => {
  const l = layoutFor(byId('m_011'), { medialAuto: true });
  eq(nextHintSlot(l, filledSet([])).id, 'initial');
  eq(nextHintSlot(l, filledSet(['initial'])).id, 'final');
  eq(nextHintSlot(l, filledSet(['initial', 'final'])), null);
});
test('全库每题：帮扶目标零件 = 该槽位正确答案', () => {
  for (const m of missions) {
    const l = layoutFor(m);
    const filled = [];
    for (;;) {
      const next = nextHintSlot(l, filledSet(filled));
      if (!next) break;
      assert.ok(m.parts[next.group], `${m.id} 提示槽位 ${next.group} 无正确答案`);
      filled.push(next.id);
    }
    eq(filled.length, l.active.length, m.id);
  }
});

console.log(`\nM2 落点判定测试结果: ${pass} 通过, ${fail} 失败`);
if (fail > 0) { for (const [n, e] of failures) console.error(`  - ${n}: ${e.message}`); process.exit(1); }
