/**
 * expand-missions-grade3.mjs — 三年级扩展词库（m_041–m_140，100 条）
 * ------------------------------------------------------------------
 * 表格只写「汉字 + 词组 + 带调拼音 + 提示」，拆分 / 标调 / 干扰项 / 标签全部由
 * wordbank-lib.mjs 推导，并交 validateMission 终审。
 *
 * 用法：
 *   node scripts/expand-missions-grade3.mjs            # 写入 data/missions.json
 *   node scripts/expand-missions-grade3.mjs --dry-run  # 只体检不落盘
 *   npm run wordbank                                   # 依次写入三年级 + 小学扩展词库
 */
import { runWordbank, isDryRun } from './wordbank-lib.mjs';

const TABLE = [
  /* ---- 整体认读音节（16 个整体认读中三年级常考的） ---- */
  { hanzi: '智', word: '智慧', pinyin: 'zhì', hint: '聪明，能想出好办法' },
  { hanzi: '时', word: '时间', pinyin: 'shí', hint: '钟表不停往前走的东西' },
  { hanzi: '事', word: '事情', pinyin: 'shì', hint: '要做的一件件事' },
  { hanzi: '纸', word: '纸张', pinyin: 'zhǐ', hint: '写字画画的薄片' },
  { hanzi: '止', word: '停止', pinyin: 'zhǐ', hint: '不再继续' },
  { hanzi: '蜘', word: '蜘蛛', pinyin: 'zhī', hint: '会结网的小虫' },
  { hanzi: '湿', word: '潮湿', pinyin: 'shī', hint: '沾了水，不干燥' },
  { hanzi: '迟', word: '迟到', pinyin: 'chí', hint: '来晚了' },
  { hanzi: '思', word: '思考', pinyin: 'sī', hint: '动脑筋想问题' },
  { hanzi: '字', word: '汉字', pinyin: 'zì', hint: '记录语言的方块字' },
  { hanzi: '紫', word: '紫色', pinyin: 'zǐ', hint: '红和蓝调出来的颜色' },
  { hanzi: '词', word: '词语', pinyin: 'cí', hint: '说话用的一个个词' },
  { hanzi: '医', word: '医生', pinyin: 'yī', hint: '给病人看病的人' },
  { hanzi: '屋', word: '老屋', pinyin: 'wū', hint: '能住人的旧房子' },
  { hanzi: '舞', word: '跳舞', pinyin: 'wǔ', hint: '跟着音乐摆动身体' },
  { hanzi: '雨', word: '下雨', pinyin: 'yǔ', hint: '云里落下来的水滴' },
  { hanzi: '原', word: '原来', pinyin: 'yuán', hint: '起初、本来' },
  { hanzi: '月', word: '月亮', pinyin: 'yuè', hint: '晚上挂在天上的圆盘' },

  /* ---- 零声母音节（a/o/e 开头，无需声母） ---- */
  { hanzi: '爱', word: '爱心', pinyin: 'ài', hint: '关心别人的心意' },
  { hanzi: '安', word: '安静', pinyin: 'ān', hint: '没有一点声音' },
  { hanzi: '岸', word: '河岸', pinyin: 'àn', hint: '河边的地' },
  { hanzi: '按', word: '按时', pinyin: 'àn', hint: '按规定的时间' },
  { hanzi: '矮', word: '矮小', pinyin: 'ǎi', hint: '个子不高' },
  { hanzi: '欧', word: '欧洲', pinyin: 'ōu', hint: '地球上一个大洲' },
  { hanzi: '偶', word: '偶然', pinyin: 'ǒu', hint: '不经常发生' },
  { hanzi: '而', word: '而且', pinyin: 'ér', hint: '表示并列的词' },
  { hanzi: '尔', word: '偶尔', pinyin: 'ěr', hint: '有时候，不经常' },
  { hanzi: '饿', word: '饥饿', pinyin: 'è', hint: '肚子空了想吃' },

  /* ---- j / q / x + ü 规则题（摘墨镜） ---- */
  { hanzi: '举', word: '举手', pinyin: 'jǔ', hint: '把手抬起来' },
  { hanzi: '具', word: '工具', pinyin: 'jù', hint: '干活用的器具' },
  { hanzi: '句', word: '句子', pinyin: 'jù', hint: '说完整意思的话' },
  { hanzi: '决', word: '决定', pinyin: 'jué', hint: '拿定主意不再改' },
  { hanzi: '剧', word: '剧场', pinyin: 'jù', hint: '演戏的地方' },
  { hanzi: '群', word: '一群', pinyin: 'qún', hint: '聚在一起的一些' },
  { hanzi: '全', word: '全部', pinyin: 'quán', hint: '一点儿也不剩' },
  { hanzi: '确', word: '确实', pinyin: 'què', hint: '真实可靠' },
  { hanzi: '学', word: '学习', pinyin: 'xué', hint: '读书学本领' },
  { hanzi: '选', word: '选择', pinyin: 'xuǎn', hint: '从几个里挑一个' },
  { hanzi: '训', word: '训练', pinyin: 'xùn', hint: '反复练习本领' },
  { hanzi: '循', word: '遵循', pinyin: 'xún', hint: '照着规矩去做' },
  { hanzi: '趣', word: '有趣', pinyin: 'qù', hint: '让人喜欢、有意思' },
  { hanzi: '虚', word: '虚心', pinyin: 'xū', hint: '不自满，肯听意见' },

  /* ---- 三拼音节（声母 + 介母 i/u/ü + 韵母） ---- */
  { hanzi: '双', word: '双手', pinyin: 'shuāng', hint: '两只手' },
  { hanzi: '装', word: '装扮', pinyin: 'zhuāng', hint: '装饰、打扮' },
  { hanzi: '窗', word: '窗户', pinyin: 'chuāng', hint: '透光通风的口' },
  { hanzi: '黄', word: '黄色', pinyin: 'huáng', hint: '像金子一样的颜色' },
  { hanzi: '荒', word: '荒凉', pinyin: 'huāng', hint: '冷清没有人烟' },
  { hanzi: '兄', word: '兄弟', pinyin: 'xiōng', hint: '哥哥和弟弟' },
  { hanzi: '江', word: '长江', pinyin: 'jiāng', hint: '我国最长的大河' },
  { hanzi: '想', word: '想法', pinyin: 'xiǎng', hint: '心里动脑筋' },
  { hanzi: '亮', word: '明亮', pinyin: 'liàng', hint: '光线很足' },
  { hanzi: '两', word: '两个', pinyin: 'liǎng', hint: '数量，一双' },
  { hanzi: '讲', word: '讲话', pinyin: 'jiǎng', hint: '用嘴说话' },
  { hanzi: '巧', word: '巧妙', pinyin: 'qiǎo', hint: '办法好得出人意料' },
  { hanzi: '跳', word: '跳高', pinyin: 'tiào', hint: '用力跃过横杆' },
  { hanzi: '鸟', word: '小鸟', pinyin: 'niǎo', hint: '会飞的动物' },
  { hanzi: '笑', word: '笑话', pinyin: 'xiào', hint: '让人发笑的话' },
  { hanzi: '叫', word: '叫声', pinyin: 'jiào', hint: '喊出来的声音' },
  { hanzi: '飘', word: '飘动', pinyin: 'piāo', hint: '随风轻轻移动' },
  { hanzi: '尖', word: '笔尖', pinyin: 'jiān', hint: '又细又锐的一头' },
  { hanzi: '千', word: '一千', pinyin: 'qiān', hint: '十个一百' },
  { hanzi: '浅', word: '浅色', pinyin: 'qiǎn', hint: '颜色很淡' },
  { hanzi: '天', word: '天空', pinyin: 'tiān', hint: '头顶上高高的地方' },
  { hanzi: '田', word: '田野', pinyin: 'tián', hint: '种庄稼的平地' },
  { hanzi: '连', word: '连接', pinyin: 'lián', hint: '接在一起' },
  { hanzi: '脸', word: '笑脸', pinyin: 'liǎn', hint: '含笑的面孔' },
  { hanzi: '变', word: '变化', pinyin: 'biàn', hint: '跟原来不一样' },
  { hanzi: '画', word: '画画', pinyin: 'huà', hint: '用笔作出图形' },
  { hanzi: '虾', word: '小虾', pinyin: 'xiā', hint: '水里的节肢小动物' },
  { hanzi: '果', word: '水果', pinyin: 'guǒ', hint: '树上结的甜果实' },
  { hanzi: '活', word: '生活', pinyin: 'huó', hint: '人活着的日子' },
  { hanzi: '阔', word: '辽阔', pinyin: 'kuò', hint: '宽广没有边' },
  { hanzi: '算', word: '计算', pinyin: 'suàn', hint: '数一数多少' },

  /* ---- 两拼音节（平翘舌 / 前后鼻音 / ü） ---- */
  { hanzi: '皂', word: '肥皂', pinyin: 'zào', hint: '洗手用的东西' },
  { hanzi: '草', word: '小草', pinyin: 'cǎo', hint: '地上绿色的小植物' },
  { hanzi: '速', word: '速度', pinyin: 'sù', hint: '快慢的程度' },
  { hanzi: '虽', word: '虽然', pinyin: 'suī', hint: '表示让步的词' },
  { hanzi: '奏', word: '演奏', pinyin: 'zòu', hint: '用乐器表演' },
  { hanzi: '聪', word: '聪明', pinyin: 'cōng', hint: '脑子灵，学得快' },
  { hanzi: '苏', word: '苏醒', pinyin: 'sū', hint: '醒过来' },
  { hanzi: '嘴', word: '嘴巴', pinyin: 'zuǐ', hint: '吃东西说话的地方' },
  { hanzi: '松', word: '松树', pinyin: 'sōng', hint: '四季常青的大树' },
  { hanzi: '站', word: '站立', pinyin: 'zhàn', hint: '直着身子站好' },
  { hanzi: '找', word: '寻找', pinyin: 'zhǎo', hint: '到处找' },
  { hanzi: '尝', word: '尝试', pinyin: 'cháng', hint: '试着做一做' },
  { hanzi: '沙', word: '沙子', pinyin: 'shā', hint: '细小的石粒' },
  { hanzi: '树', word: '大树', pinyin: 'shù', hint: '高大的树' },
  { hanzi: '睡', word: '睡觉', pinyin: 'shuì', hint: '闭上眼睛休息' },
  { hanzi: '然', word: '然后', pinyin: 'rán', hint: '接着后面' },
  { hanzi: '让', word: '让开', pinyin: 'ràng', hint: '躲到一边' },
  { hanzi: '山', word: '高山', pinyin: 'shān', hint: '又高又大的山' },
  { hanzi: '忙', word: '帮忙', pinyin: 'máng', hint: '帮别人做事' },
  { hanzi: '房', word: '房子', pinyin: 'fáng', hint: '住人的房屋' },
  { hanzi: '蓝', word: '蓝天', pinyin: 'lán', hint: '晴朗的天空' },
  { hanzi: '冷', word: '寒冷', pinyin: 'lěng', hint: '很冷' },
  { hanzi: '风', word: '风雨', pinyin: 'fēng', hint: '风和雨' },
  { hanzi: '新', word: '新年', pinyin: 'xīn', hint: '一年的开头' },
  { hanzi: '星', word: '星星', pinyin: 'xīng', hint: '天上闪亮的光点' },
  { hanzi: '绿', word: '绿色', pinyin: 'lǜ', hint: '像草叶的颜色' },
  { hanzi: '旅', word: '旅行', pinyin: 'lǚ', hint: '到外地去游玩' },
];

const result = runWordbank({ entries: TABLE, firstId: 41, source: '三年级', dryRun: isDryRun() });
process.exit(result.ok ? 0 : 1);
