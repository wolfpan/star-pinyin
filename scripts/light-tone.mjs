/**
 * light-tone.mjs — 识字表里的「轻声字」规范化
 * ------------------------------------------------------------------
 * 识字表按课文注音，会把 了/的/着/子/头 这类字标成轻声（le/de/zhe/zi/tou）。
 * 但本游戏要求每道题都有确定的「声母+介母+韵母+声调(1–4)」，轻声无法出题。
 *
 * 处理口径与写字表一致：
 *  - 有常用本音的字 → 换成**本音** + 该本音的常用词（词组必须含本字），并加 note 说明课文读轻声；
 *  - 纯轻声字（们/么 等，无常用本音词）→ 标 skip，不入词库。
 *
 * 这样既不丢字，也不会因为轻声让规则引擎报「声调应为 1–4」。
 */

/** 轻声 → 本音（按汉字索引，词必须含该字且与该本音匹配）。 */
export const LIGHT_TONE_FIX = {
  了: { pinyin: 'liǎo', word: '了不起' },
  的: { pinyin: 'dí', word: '的确' },
  得: { pinyin: 'dé', word: '得到' },
  着: { pinyin: 'zháo', word: '着急' },
  地: { pinyin: 'dì', word: '土地' },
  子: { pinyin: 'zǐ', word: '子女' },
  头: { pinyin: 'tóu', word: '头发' },
  巴: { pinyin: 'bā', word: '尾巴' },
  吗: { pinyin: 'má', word: '干吗' },
  呀: { pinyin: 'yā', word: '咿呀' },
  吧: { pinyin: 'bā', word: '吧台' },
  呢: { pinyin: 'ní', word: '呢子' },
  啊: { pinyin: 'ā', word: '啊哈' },
  啦: { pinyin: 'lā', word: '啦啦队' },
  哪: { pinyin: 'nǎ', word: '哪里' },
  哟: { pinyin: 'yō', word: '哎哟' },
  夫: { pinyin: 'fū', word: '农夫' },
  和: { pinyin: 'hé', word: '和气' },
  候: { pinyin: 'hòu', word: '时候' },
  服: { pinyin: 'fú', word: '衣服' },
  亮: { pinyin: 'liàng', word: '明亮' },
  上: { pinyin: 'shàng', word: '上面' },
  个: { pinyin: 'gè', word: '一个' },
  些: { pinyin: 'xiē', word: '一些' },
  儿: { pinyin: 'ér', word: '儿童' },
  匙: { pinyin: 'chí', word: '汤匙' },
};

/** 纯轻声、无常用本音词的字 → 不入词库。 */
export const LIGHT_TONE_SKIP = new Set(['们', '么', '裳']);

const TONE_RE = /[āáǎàōóǒòēéěèīíǐìūúǔùǖǘǚǜ]/;

/** 带调拼音？ */
export const hasToneMark = (pinyin) => TONE_RE.test(String(pinyin || ''));

/**
 * 规范化一个生字条目。返回 {char, action}：
 *  action = 'ok'（本来就有声调）/ 'fixed'（改成本音）/ 'skip'（纯轻声不入库）
 * @param {{hanzi:string, pinyin:string, word:string, note?:string}} c
 */
export function normalizeLightTone(c) {
  if (hasToneMark(c.pinyin)) return { char: { ...c }, action: 'ok' };
  const fix = LIGHT_TONE_FIX[c.hanzi];
  if (fix) {
    const note = c.note
      || `课文读轻声 ${c.pinyin || '(轻声)'}；此处按本音 ${fix.pinyin} 出题`;
    return {
      char: { ...c, pinyin: fix.pinyin, word: fix.word, note },
      action: 'fixed',
    };
  }
  if (LIGHT_TONE_SKIP.has(c.hanzi)) {
    return { char: { ...c, skip: c.skip || '轻声字，不入拼音词库' }, action: 'skip' };
  }
  return { char: { ...c, skip: c.skip || '轻声字，无常用本音词，不入词库' }, action: 'skip' };
}
