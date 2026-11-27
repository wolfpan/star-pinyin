/**
 * tone.test.mjs — 声调手势识别纯逻辑测试（零依赖）
 */
import assert from 'node:assert/strict';
import { recognizeTone } from '../public/js/tone-canvas.js';

let pass = 0, fail = 0;
function test(name, fn) { try { fn(); pass++; console.log('  \u2713 ' + name); } catch (e) { fail++; console.log('  \u2717 ' + name + ' \u2192 ' + e.message); } }
const eq = assert.equal;
const line = (x0, y0, x1, y1, n = 5) => Array.from({ length: n }, (_, i) => ({ x: x0 + (x1 - x0) * i / (n - 1), y: y0 + (y1 - y0) * i / (n - 1) }));

console.log('\n声调手势识别');
test('一声 水平 → 1', () => eq(recognizeTone(line(10, 50, 90, 50)), 1));
test('一声 轻微抖动水平 → 1', () => eq(recognizeTone([{ x: 10, y: 50 }, { x: 50, y: 56 }, { x: 90, y: 51 }]), 1));
test('二声 上升 → 2', () => eq(recognizeTone(line(10, 80, 90, 20)), 2));
test('三声 v 形蓄力 → 3', () => eq(recognizeTone([{ x: 10, y: 20 }, { x: 50, y: 70 }, { x: 90, y: 25 }]), 3));
test('四声 下降 → 4', () => eq(recognizeTone(line(10, 20, 90, 80)), 4));
test('笔画太短 → null', () => eq(recognizeTone(line(10, 10, 14, 12)), null));
test('点数不足 → null', () => eq(recognizeTone([{ x: 0, y: 0 }]), null));

console.log(`\n声调识别测试结果: ${pass} 通过, ${fail} 失败`);
if (fail) process.exit(1);
