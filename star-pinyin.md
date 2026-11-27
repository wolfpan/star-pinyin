## 1\. 项目概览与核心约束

* **项目名称**：星际发射指挥官（StarPinyin Commander）
* **目标用户**：7–9 岁小学低中年级儿童（高拟真操控感偏好，拒绝低幼画风）
* **运行环境**：局域网 Node.js Webserver 托管，客户端为 **iPad Safari（PWA 全屏模式）**
* **技术栈约束**：
* **后端**：Node.js（原生 `http` 或轻量 `express`），零编译依赖，数据持久化采用本地 JSON 文件（支持家长直接编辑或后台热更新，避免 SQLite 在不同架构上的编译问题）。
* **前端**：纯原生 HTML5 + CSS3 + Vanilla ES6 Modules（**不引入** React/Vue/Webpack 等构建工具，确保 Agent 修改即生效、部署零摩擦）。
* **图形与动效**：分层 SVG（火箭组件、发射塔架、仪表盘，保证 iPad Retina 屏无损清晰）+ HTML5 Canvas（火焰、浓烟、星空视差、火箭分级粒子效果）。**所有星球/目的地均由 `planet-fx.js` 程序化 Canvas 代码绘制（零图片素材）**：种子随机表面特征 + 球面投影自转 + 昼夜明暗 + 大气辉光，同一渲染器复用于发射巡航段、博物馆星球图鉴与机库等级图标。
* **音频引擎**：双层降级架构——**机械/环境音效**由 Web Audio API 实时程序化合成（零外部素材即可跑通）；**拼音人声**优先读取 `/public/audio/voice/` 本地录制音频，缺失时自动降级调用浏览器 `speechSynthesis` (`zh-CN`)。



### iPad Safari 强制兼容性约束（Agent 必须遵守）

1. **防误触与防页面回弹**：全局 CSS 设置 `touch-action: none; user-select: none; -webkit-user-select: none; overscroll-behavior: none;`，禁用 iPad 下拉刷新、双击缩放与长按选中文本。
2. **统一指针事件**：拖拽交互**严禁使用** HTML5 原生 Drag and Drop API（iPad Safari 兼容性极差），必须统一基于 **Pointer Events**（`pointerdown` / `pointermove` / `pointerup` + `setPointerCapture`）实现。
3. **音频上下文解锁**：iOS 禁止页面自动播放声音，必须在首屏“进入指挥中心”按钮的首次点击事件中显式调用 `AudioContext.resume()` 并触发一次静默语音播报以解锁音频权限。
4. **PWA 伪原生配置**：提供完整的 `manifest.json` 及 Apple Touch Meta 标签（`apple-mobile-web-app-capable`、`viewport-fit=cover`），默认锁定竖屏（Portrait）布局以贴合火箭垂直发射的视觉张力。

\---

## 2\. 目录结构与系统架构

```text
star-pinyin/
├── server.js                  # Node.js HTTP/Express 入口，提供静态资源与 REST API
├── package.json               # 最小依赖清单（仅 express 或零依赖）
├── data/
│   ├── missions.json          # 拼音发射任务词库（内置种子题库 + 家长热注入词条）
│   ├── badges.json            # 太空勋章、真实火箭百科卡片配置表
│   └── progress.json          # 玩家档案（已完成任务、错题权重、已解锁皮肤/勋章）
└── public/
    ├── index.html             # 主游戏 SPA 入口（iPad 端）
    ├── admin.html             # 家长控制面板（错题热注入、词库管理、学习统计）
    ├── manifest.json          # PWA 配置文件
    ├── css/
    │   ├── theme.css          # 深空航天指挥中心暗色主题 + 拟真物理按钮样式
    │   └── layout.css         # iPad 竖屏响应式栅格布局（兼容 9.7"–12.9"）
    ├── js/
    │   ├── main.js            # 启动引导与全局状态机控制器
    │   ├── api.js             # 后端通信封装（含离线降级缓存）
    │   ├── pinyin-rules.js    # 汉语拼音核心规则校验引擎（独立纯逻辑模块）
    │   ├── drag-engine.js     # 基于 Pointer Events 的 iPad 磁吸拖拽引擎
    │   ├── tone-canvas.js     # 声调推力轨迹校准交互模块（Canvas 轨迹识别）
    │   ├── launch-fx.js       # 点火、排烟、升空、一二级分离、巡航转移、抵达入轨 Canvas 粒子系统
    │   ├── planet-fx.js       # 程序化星球 Canvas 渲染器（地球/月球/金星/火星/水星/木星/土星/天王星/海王星/冥王星/奥尔特云，零图片）
    │   ├── destinations.js    # 奖励档位→星际目的地映射与星球元数据（纯逻辑，浏览器/Node 共用）
    │   ├── rewards.js         # 课时奖励系统（课时完成统计 / 2 课时升 1 档 / 14 档目的地，纯逻辑，浏览器/Node 共用）
    │   ├── textbook.js        # 课文同步（进度→累计字集 / 抽题过滤 / 文案，纯逻辑，浏览器/Node 共用）
    │   ├── audio-engine.js    # Web Audio 音效合成器 + 人声播放调度器
    │   └── ui-renderer.js     # SVG 火箭组装台、任务简报、太空博物馆渲染
    └── audio/
        └── voice/             # 可选：家长自录 MP3 目录（命名如 chuan2.mp3）

```

\---

## 3\. 核心数据结构设计（Schema）

### 3.1 拼音任务数据结构 (`data/missions.json`)

必须覆盖小学拼音的 4 种结构形态，防止引擎把“整体认读音节”强行拆开教错孩子：

```json
{
  "id": "m\_001",
  "hanzi": "船",
  "word": "宇宙飞船",
  "hint": "在太空里航行的交通工具",
  "type": "three\_part",
  "parts": {
    "initial": "ch",
    "medial": "u",
    "final": "an"
  },
  "tone": 2,
  "displayPinyin": "chuán",
  "distractors": {
    "initial": \["c", "zh", "sh"],
    "medial": \["i", "ü"],
    "final": \["ang", "en", "ai"]
  },
  "specialRule": null,
  "tags": \["三拼音节", "翘舌音", "前鼻音"],
  "priority": 1,
  "isParentInjected": false
}

```

**`type` 枚举值与对应火箭构型规则**：

|`type` 值|拼音类型|火箭组装规则|示例|
|-|-|-|-|
|`two\_part`|两拼音节|激活 `\[一级:声母]` + `\[整流罩:韵母]`，不渲染介母舱段|`mā` (`m` + `a`)|
|`three\_part`|三拼音节|激活全部 3 槽：`\[一级:声母]` + `\[二级:介母 i/u/ü]` + `\[整流罩:韵母]`|`chuán` (`ch` + `u` + `an`)|
|`zero\_initial`|零声母音节|单仓一体箭体（同整体认读），仅拖入 `\[整流罩:韵母]`|`ān` (`an`)、`ér` (`er`)|
|`whole\_syllable`|整体认读音节|切换为“一体式单级入轨火箭（SSTO）”，不拆分声韵母，从零件库拖入单个完整箭体|`yuán`、`zhī`、`yīng`|

**`specialRule` 特殊规则标记**：

* `j\_q\_x\_drop\_dots`：当 `initial` 为 `j/q/x` 且 `medial` 或 `final` 含 `ü`（如 `jū`、`quán`、`xuě`）时触发专属“摘墨镜”交互机制。

### 3.2 玩家档案与自适应错题权重 (`data/progress.json`)

```json
{
  "callsign": "火箭号指挥官",
  "totalLaunches": 12,
  "unlockedBadges": \["long\_march\_5", "falcon\_9"],
  "visitedDestinations": { "earth": 9, "moon": 3 },
  "stats": {
    "m\_001": {
      "attempts": 3,
      "errors": 1,
      "lastPlayedAt": "2026-11-24T10:00:00Z",
      "weight": 1.5
    }
  }
}

```

\---

## 4\. 核心游戏状态机（FSM）与交互规格

Agent 需严格按以下 6 个状态实现主流程，单局耗时控制在 **40–60 秒**：

### 课时奖励 = 星际目的地（Lv1–14，核心 progression）

难度等级已取消：出题范围完全由**课文同步进度**决定（学到哪一课就从已学生字里抽题），
原来的 Lv1–14 难度阶梯改造为**课时奖励系统**——每完成 2 课时解锁 1 档奖励，一档 = 一个星际目的地。
奖励进度只跟「完成课时」走：每 2 课时升 1 档目的地；**火箭收藏按完成单元数**（每 3 个单元一枚，与目的地解耦）。
孩子想飞得更远，就跟着课本一课一课把生字练全（没有难度滑块，也没有「选错难度就重来」的挫败感）。

|Lv|目的地|动画终点|解锁门槛(完成课时)|
|-|-|-|-|
|1|低空轨道|释放刻字卫星（地球弧线铺满下方）|0|
|2|高空轨道|释放刻字卫星（大地球 + 轨道环）|2|
|3|远地轨道|释放刻字卫星（小地球 + 大轨道环）|4|
|4|月球|巡航转移 → 绕月入轨|6|
|5|金星|巡航转移 → 绕金星入轨|8|
|6|火星|巡航转移 → 绕火星入轨|10|
|7|水星|巡航转移 → 绕水星入轨|12|
|8|木星|巡航转移 → 绕木星入轨|14|
|9|土星|巡航转移 → 穿环入轨|16|
|10|天王星|巡航转移 → 绕天王星入轨|18|
|11|海王星|巡航转移 → 绕海王星入轨|20|
|12|冥王星|巡航转移 → 飞掠爱心区|22|
|13|奥尔特云|抵达奥尔特云（冰质云区）|24|
|14|星际空间|飞出太阳系|26|

* 完成一课 = 该课全部可出题生字都至少练过一次（`progress.stats` 按 missionId 记 attempts）；认读课（无可写生字）不计入课时总数（课时总数随词库增长，见 `/api/profile.lessonsTotal`）。
* 奖励门槛集中在 `rewards.js`（`rewardLevelForLessons` / `lessonsForRewardLevel` / `nextRewardForLessons` / `lessonProgress`）；
  目的地映射与元数据集中在 `destinations.js`（`DESTINATION_BY_LEVEL` / `DESTINATIONS` / `destinationForLevel`），
  星球视觉集中在 `planet-fx.js`（`drawPlanet(ctx,id,cx,cy,r,t)`）。
* 载荷：地球三层轨道（低空/高空/远地）= 真实卫星模型，地球按轨道高度呈现三种视角（`drawOrbitEarth`）；Lv4+ = **代码绘制探测器**（金色主体 + 抛物面天线 + 太阳帆板，保留汉字铭牌）；奥尔特云为飞掠而非入轨。
* 到访记录存 `progress.visitedDestinations`（id → 次数），驱动博物馆「星球图鉴」点亮与结算「首次抵达」庆祝。
* 奖励进度在**太空博物馆**查看（14 档阶梯 + 课时进度条 + 下一份奖励提示）；指挥官界面右上角只显示**最新目的地**（点击进博物馆）。

### 状态 1：`IDLE\_HANGAR`（发射指挥中心主页）

* 展示当前待命火箭、累计入轨卫星数、**右上角「最新目的地」**、太空博物馆入口。
* **无难度选择器**：① 课文同步（年级 / 学期 / 课文进度）→ ② 出战座驾 → 发射。
* 顶部提供 3 个训练模式切换开关：`综合巡航` / `三拼音节特训` / `易混音特训`（若存在家长热注入的紧急任务，主页亮起橙色“紧急载荷任务”呼吸灯）。

### 状态 2：`MISSION\_BRIEFING`（载荷任务简报）

* 播放目标字词语音（例如：“载荷确认：宇宙飞船的‘船’”），展示大号汉字、词组与简短航天风提示。
* 提供**随时可点击的“塔台重播”按钮**（带无线电滋滋声效，支持慢速拆读与常速朗读两档）。

### 状态 3：`STAGE\_1\_ASSEMBLY`（分段组装火箭 — 拼读核心）

* **屏幕布局**：上部 55% 为垂直发射塔架与火箭装配槽；下部 45% 为分格的“零件库托盘”（按当前需要的槽位展示候选拼音模块，每组 3–4 个干扰项，优先纳入易混音如 `zh/z`、`an/ang`、`b/d/p/q`）。
* **拖拽与磁吸**：手指拖起零件模块时，模块略微放大（1.15x）并带金属阴影；拖入正确槽位容差半径（如 60px）内松手，自动磁吸对齐，触发**厚重液压锁定声效** + 绿色状态灯亮起。
* **错误反馈**：拖入错误拼音时，零件弹回托盘，发射架闪黄灯并响起柔和电子提示音，同时语音读出**被错选音节的真实发音**（让孩子听出“哦，我刚才拼成了 cuán，不是 chuán”）。
* **核心彩蛋机制（`j\_q\_x\_drop\_dots`）**：
* 零件库提供带两点的 `ü`（或 `üe`/`üan`/`ün`）。
* 当孩子把带两点的零件拖向已安装 `j/q/x` 的火箭时，界面暂停锁死并冒出卡通电火花，弹出提示：“接口冲突！遇到 j/q/x 时，ü 必须摘掉太空护目镜（两点）才能对接！”
* 孩子用手指**点按两下 `ü` 上的两个圆点**，圆点“啵、啵”飞走变成 `u`，箭体立即“咔哒”合龙锁定。



### 状态 4：`STAGE\_2\_TONE\_CALIBRATION`（推力曲线校准 — 声调核心）

* 组装完成后，右侧或底部切换为“轨迹校准仪”（Canvas 交互区），展示 4 条发亮的飞行姿态曲线按钮/手势区：
* **一声（阴平 `—`）**：高空水平巡航线
* **二声（阳平 `/`）**：仰角加速爬升线
* **三声（上声 `v`）**：俯冲蓄力再拉起曲线
* **四声（去声 `\\`）**：高速俯冲点火线



* **交互方式（双模式兼容）**：既支持**直接用手指沿正确曲线一笔画过**（通过起止点与中点斜率判定手势，容错率高，不苛求画得完美），也支持**直接点击对应曲线图标**，降低操作挫败感。
* 校准成功后，火箭箭体上正式浮现带标调的完整拼音（如 `chuán`），进入发射倒计时准备。

### 状态 5：`STAGE\_3\_COUNTDOWN\_LAUNCH`（点火与入轨 — 爽感核心）

* 屏幕中央亮起带机械保护盖的红色大按钮：**“掀盖并点火（IGNITION）”**。
* 孩子点击后，Web Audio 启动倒计时音效（“5、4、3、2、1，点火！”），Canvas 渲染：
1. 导流槽喷出白色蒸汽与橙红尾焰；
2. 整个视角产生轻微高频震动（CSS transform 抖动）；
3. 火箭加速离架、背景从蓝天渐变到平流层再到深空星海；
4. 三拼音节火箭在半空触发“助推器分离”动画；
5. 整流罩打开，释放载荷：**Lv1–3 为刻着本关汉字（如“船”）的闪亮卫星进入地球低空/高空/远地轨道（地球按轨道高度呈现不同视角，到此结束）**；
6. **Lv4+ 巡航转移**：升空段**不画任何星体**（原发射界面）；到太空后清空发射烟雾、**直接飞向目标星体**——**不强行插入地球**（发射视角朝前/朝上，地球在视角之外），星野拉出光速流线、目标星球从亮点逐渐放大浮现（`planet-fx.js`），代码绘制探测器拖光轨飞向目标；
7. **Lv4+ 抵达**：探测器切入椭圆轨道环、星球缓慢自转，字幕/播报**只用短名「抵达××」**（不带入轨/穿环等后缀）+ 汉字·拼音；土星穿环、冥王星飞掠爱心区、**Lv13 抵达奥尔特云（停驻冰质云区）、Lv14 飞出太阳系「抵达星际空间」**。巡航只留音效，抵达播报统一为「抵达XX」。



### 状态 6：`MISSION\_COMPLETE\_REWARD`（入轨报告与收集）

* 结算画面大字展示 `船 — chuán` 并清晰播报一次标准读音。
* **目的地结算**：标题改为「抵达××!/ 卫星入轨!」，附该星球一句百科；首次到访显示「首次抵达」庆祝；若本局解锁新火箭使等级提升，额外提示「下一站解锁：××」。
* 每完成 3 个单元（课时），解锁 1 枚**新火箭 / 真实航天知识卡**（如长征五号、猎鹰九号、土星五号、祝融号、天宫空间站等图文小百科），存入“太空博物馆”供随时翻看。
* 太空博物馆**星球图鉴**（课时奖励系统已并入，不再单独设「奖励系统」区块）：14 种目的地代码绘制缩略图 + 百科，已到访点亮并计数；
  每张卡片带奖励档位徽章（Lv× · 当前目的地 / 下一站 / 已解锁 / 未解锁），未解锁显示「完成 N 课时解锁」（下一站显示「再完成 N 课时解锁」）；
  图鉴顶部保留课时进度条 + 下一份奖励提示 + 课时判定说明；火箭图鉴保留。

\---

## 5\. REST API 契约（Node.js 后端）

所有接口均返回标准 JSON 格式，无需登录鉴权（纯家庭局域网使用）。

|方法与路径|用途|核心请求/响应逻辑|
|-|-|-|
|`GET /api/missions/next?mode=all`|获取下一道发射任务|**加权随机抽题算法**：优先级权重 = `isParentInjected (x5)` + `历史错误率加权 (x1\~x3)` + `防连抽去重（跳过最近 5 题）`；出题范围由档案里的课文同步进度决定（`?difficulty=` 已废弃、被忽略）。|
|`POST /api/progress/record`|上报单局作答结果|请求体 `{ missionId, assemblyErrors, toneErrors, durationMs, destinationId }`；后端更新 `progress.json` 错题权重、`visitedDestinations` 到访计数与课时完成度，若全对则衰减错误权重，判定是否解锁新航天勋章 / 新奖励档位；返回 `firstVisit`、`lessonCompleted`、`lessonsCompleted`、`rewardLevel` 与跨档解锁的 `newlyReachedDestination`。|
|`GET /api/profile`|获取玩家档案与博物馆|返回总发射次数、已解锁勋章列表、各拼音标签掌握度、课时奖励进度 `lessonsCompleted` / `lessonsTotal` / `rewardLevel`、`currentDestination`（最新目的地）、`nextReward`、`visitedDestinations`。|
|`GET /api/admin/missions`|家长端获取全部词库|返回 `missions.json` 全量列表及各词条历史错题率。|
|`POST /api/admin/missions`|家长端热注入错题|家长输入汉字、词组、拼音拆分及声调，写入 `missions.json` 并标记 `isParentInjected: true`，iPad 端下一局立即生效。|
|`DELETE /api/admin/missions/:id`|家长端删除或归档词条|从词库移除或取消紧急标记。|

\---

## 6\. Agent 分阶段实现路线图（Milestones）

建议让 Coding Agent 按以下 5 个里程碑**逐步推进、逐阶段验收**，不要一次性让它生成全部文件（容易在拖拽和 Canvas 动画处堆叠 Bug）：

### Milestone 1：工程骨架、PWA 壳与拼音规则内核

* **目标**：跑通 Node.js 服务与纯逻辑单元测试，iPad 能全屏打开空白主界面。
* **交付物**：
* `server.js` 静态托管 + 基础 API 路由跑通。
* `data/missions.json` 预置 **40 个精选种子任务**（覆盖：10个两拼音节含平翘舌/前后鼻音、15个三拼音节、8个 `j/q/x+ü` 规则题、7个整体认读音节）；
  后续迭代已扩充至 **1000 条**：追加 100 个三年级专项汉字（`scripts/expand-missions-grade3.mjs`）、
  360 个小学常见常考汉字（`scripts/expand-missions-primary.mjs`）与 500 个进阶扩展汉字
  （`scripts/expand-missions-1000.mjs`），三者共用 `scripts/wordbank-lib.mjs` 生成与校验。
* `data/badges.json` 预置 10 张真实火箭/航天器百科卡片。
* `pinyin-rules.js` 实现完整的声韵母拼接校验、`j/q/x` 去点检测、标调位置计算（遵循“有a找a，无a找o/e，i/u并列标在后”口诀）。



* **验收标准**：通过命令行脚本或浏览器控制台验证 40 个种子任务（当前全库 1000 条）的拆分、标调和规则判定 100% 准确。

### Milestone 2：SVG 火箭组装台与 iPad 触控拖拽引擎

* **目标**：跑通 `MISSION\_BRIEFING` → `STAGE\_1\_ASSEMBLY` 核心闭环。
* **交付物**：
* `ui-renderer.js` 绘制分层航天暗黑科技风 SVG 火箭与发射架（支持 2/3/1 级形态动态切换）。
* `drag-engine.js` 基于 Pointer Events 实现流畅拖拽、磁吸高亮、错选回弹。
* 实现 `j/q/x + ü` 触发火花警报与“点按摘除两点”的专属动画交互。



* **验收标准**：在 iPad Safari（或 Chrome DevTools 触摸模拟）中拖动顺滑无页面滚动卡顿；四种拼音构型都能正常装配完成。

### Milestone 3：声调轨迹校准与发射粒子大秀

* **目标**：跑通 `STAGE\_2\_TONE\_CALIBRATION` → `STAGE\_3\_COUNTDOWN\_LAUNCH` → `MISSION\_COMPLETE\_REWARD`。
* **交付物**：
* `tone-canvas.js` 实现 4 条声调曲线可视化 + 手指滑动轨迹方向识别（含点击保底模式）。
* `launch-fx.js` 实现 60fps 的 Canvas 尾焰粒子、白烟扩散、屏幕震动、天空渐变与助推器分离动画。



* **验收标准**：从组装到卫星入轨全流程闭环顺畅，无内存泄漏（重复发射 10 次帧率稳定）。

### Milestone 4：Web Audio 拟真音效合成与语音引擎

* **目标**：赋予“火箭发射视频级”的听觉沉浸感。
* **交付物**：
* `audio-engine.js` 用 Web Audio API 合成：金属液压锁定声（低通滤波脉冲）、电火花警报声、倒计时蜂鸣音、火箭引擎轰鸣声（滤波粉红噪声渐变）。
* 接入人声播放逻辑：优先检测 `/audio/voice/{pinyin}{tone}.mp3`，404 时无缝回退至 `window.speechSynthesis` 中文女声/男声，并提供“慢速拆读”功能。



* **验收标准**：iPad Safari 首次点击后所有音效正常发声，无静音或报错卡死。

### Milestone 5：太空博物馆、自适应错题与家长后台 (`/admin.html`)

* **目标**：形成长期可玩性与家庭教学闭环。
* **交付物**：
* 主游戏内增加“太空博物馆”抽屉页，可查看已解锁火箭卡片与卫星星图。
* 实现 `admin.html` 极简管理页：支持家长用手机或电脑打开，输入汉字后自动辅助拆分拼音字段（家长微调确认即可一键提交为“紧急载荷”），并能直观看到孩子近期出错最多的拼音标签（如“前后鼻音错误率 35%”）。



* **验收标准**：在 `/admin.html` 录入一个新错字后，iPad 刷新主页立刻出现橙色紧急载荷提示并优先抽到该题。

### Milestone 6：星际目的地 progression（Lv1–14，已交付）

* **目标**：把「难度等级」升级为「星际目的地」，从地球轨道一路飞到太阳系外，星球全部代码绘制。
* **交付物**：
* `destinations.js` 等级→目的地映射 + 星球元数据；`difficulty.js` 上限 14；`badges.json` 增至 14 枚火箭（新增火神/阿丽亚娜6/新格伦/朱雀三号，unlockAt 30/33/36/39）。
* `planet-fx.js` 程序化星球渲染器（12 种目的地，零图片）；`launch-fx.js` 巡航转移 + 抵达入轨/云区/飞掠段；`audio-engine.js` 巡航/抵达音效。
* 机库 13 级目的地图标 + 「本次目的地」横幅；简报目的地行；结算目的地百科/首次抵达/下一站；博物馆星球图鉴。
* `server.js` profile/record 目的地字段与到访记录；`test/destinations.test.mjs` 映射/门槛自洽验收。
* **验收标准**：`npm test` 全绿；无头截图逐 Lv 确认巡航/抵达画面与字幕正确（`.ui-shots/dest-*.png`），重复发射帧率稳定、canvas 清理无泄漏。

### Milestone 7：火箭与星体解耦 + 两枚顶级概念火箭（已交付）

* **目标**：把「火箭收藏」与「星际目的地」拆成两条独立成长线；收藏上限扩到 16 枚，新增两枚最顶级概念旗舰。
* **交付物**：
* `difficulty.js` 新增 `SATELLITES_PER_LEVEL` / `maxLevelForLaunches` / `launchesForLevel`：难度上限只由累计入轨数决定（每 3 颗升 1 级，Lv14 封顶），与火箭数量无关。
* `server.js` profile / record 改用入轨数判定 `maxDifficulty` 与 `newlyReachedDestination`；火箭解锁逻辑不变（每 3 颗一枚）。
* `badges.json` 新增 **猎鹰21号**（`falcon_21`，42 颗）/ **星舰9号**（`starship_9`，45 颗），`concept: true` 未来概念旗舰；
  博物馆火箭图鉴按首飞年份排序、概念火箭压轴并标「未来概念」；透明模型图由 `npm run rockets:images` 生成。
* 「下一枚火箭」进度不再附带「解锁某星球之旅」；机库保持简洁（难度面板只有等级 + 「前往」横幅）。
* **验收标准**：`npm test` 全绿（difficulty / destinations / rocket / seeds 测试改为入轨门槛自洽 + 解耦断言 + 16 枚卡片）；
  无头截图确认机库布局与博物馆概念旗舰卡片（`.ui-shots/top-*.png`）。

### Milestone 8：地球三层轨道（已交付）

* **目标**：Lv1–3 不再共用「地球轨道」，拆分为 **低空轨道 / 高空轨道 / 远地轨道** 三个独立目的地；机库去掉「下一站」提示保持简洁。
* **交付物**：
* `destinations.js`：`earth_low / earth_high / earth_far`（`orbitView: low/high/far`），14 级一一对应 14 种目的地；移除 `nextNewDestinationForMax`。
* `planet-fx.js` 新增 `drawOrbitEarth(ctx,view,w,h,t)`：低空=地球弧线铺满下方、高空=大地球+轨道环、远地=小地球+大轨道环；
  复用于发射入轨段（`launch-fx.js` 卫星释放时地球渐显）、博物馆星球图鉴缩略图与样板页。
* `launch-fx.js` 入轨字幕改用目的地元数据 `caption`（抵达低空/高空/远地轨道）；`server.js` 兼容旧客户端上报的 `earth` → `earth_low`。
* **验收标准**：`npm test` 全绿；无头截图确认三层轨道入轨画面与字幕（`.ui-shots/dest-earth_*.png`）、博物馆 14 张星球卡。

### Milestone 9：任务难度 → 课时奖励系统（已交付）

* **目标**：有了课文同步就不需要任务难度了。把 Lv1–14 难度阶梯改造为**课时奖励系统**：
  完成课时发奖励（一档 = 一个星际目的地），难度面板从指挥官界面移除，奖励进度放进太空博物馆，
  指挥官界面右上角只保留「最新目的地」。
* **交付物**：
* `public/js/rewards.js`（新）课时奖励纯逻辑：`LESSONS_PER_REWARD=2` / `lessonsForRewardLevel` / `rewardLevelForLessons` /
  `nextRewardForLessons` / `rewardLadder` / `lessonKey` / `groupMissionsByLesson` / `lessonProgress`。
  一课全部可出题生字都练过至少一次 = 完成一课时（认读课不计入，课时总数见 `/api/profile.lessonsTotal`）。
* `public/js/difficulty.js` 删除（难度概念下线）；`destinations.js` 注释与语义改为「奖励档位 → 目的地」；
  `server.js` 抽题去掉难度加权（`missionTier` / `difficultyFactor`）、`/api/difficulty/select` 下线，
  profile / record 改按课时判定 `rewardLevel` 与 `newlyReachedDestination`，并返回 `lessonCompleted` / `lessonsCompleted` / `nextReward`。
* `public/index.html`：删掉「任务难度」面板与目的地横幅，步骤改为 ① 课文同步 → ② 出战座驾；
  顶栏最右侧新增「最新目的地」徽标（点击进博物馆）。
* `public/js/main.js`：删除难度状态 / 选择器 / 持久化，新增 `applyReward` + `renderLatestDest`，
  发射终点 = 最新目的地；结算页新增「完成课时」「新目的地解锁」「课时 X / 总课时 · 奖励 Lv×」。
* `public/js/ui-renderer.js`：博物馆新增「奖励系统」区块（14 档阶梯 + 课时进度条 + 下一份奖励），
  星球图鉴未解锁卡片改显示「完成 N 课时解锁」。
* 样式：`theme.css` / `space.css` 清理 `.difficulty-switch` / `.diff-btn` / `.dest-banner`，新增 `.dest-corner` 与奖励阶梯样式。
* 测试：`test/rewards.test.mjs`（纯逻辑）、`test/rewards-api.test.mjs`（隔离数据副本上跑真实 server：课时完成 / 跨档解锁 / 难度接口 404）；
  `test/destinations.test.mjs` 改为与奖励门槛自洽；`test/difficulty.test.mjs` 删除。
* 验收脚本：`node scripts/debug-rewards-ui.mjs`（机库右上角 / 博物馆奖励阶梯 / 窄屏）、
  `node scripts/debug-reward-flow.mjs`（结算页完成课时 + 新目的地解锁，拦截上报不写进度）。
* **验收标准**：`npm test` 全绿；无头截图确认难度面板消失、右上角最新目的地、博物馆 14 档奖励与课时进度（`.ui-shots/rewards-*.png`）。

### Milestone 10：博物馆「奖励系统」并入「星球图鉴」（已交付）

* **目标**：博物馆里「奖励系统」14 档阶梯与「星球图鉴」14 张卡片展示的是同一批目的地与课时门槛，信息重复；合并为单一「星球图鉴」区块。
* **交付物**：
* `public/js/ui-renderer.js`：删除独立的奖励阶梯（`reward-grid` / `reward-tier`），星球图鉴卡片新增档位徽章
  `planet-card-state`（Lv× · 当前目的地 / 下一站 / 已解锁 / 未解锁）与 `done/current/next/locked` 状态类；
  课时进度条 + 下一份奖励提示 + 课时判定说明保留在图鉴标题下；小标题改为「星球图鉴 · 已解锁 × / 14 · 已到访 × 种」；
  下一站卡片显示「再完成 N 课时解锁」。博物馆顶部不再显示「累计发射 N 次」（机库顶栏保留），只留标题。
* 样式：`theme.css` / `space.css` 清理 `.reward-grid` / `.reward-tier*`，新增 `.planet-card-state` 与 `.planet-card.current`（高亮）/ `.planet-card.next`（虚线描边）。
* 验收脚本：`scripts/debug-rewards-ui.mjs` / `scripts/debug-top-rockets.mjs` 选择器从 `.reward-tier` 改为 `.planet-grid .badge-card`。
* **验收标准**：`npm test` 全绿；无头截图确认博物馆只剩「星球图鉴 + 火箭」两个区块、14 张卡片带档位状态（`.ui-shots/rewards-museum-*.png`）。

### Milestone 11：火箭收藏改按完成单元奖励（已交付）

* **目标**：新火箭解锁门槛从「累计发射每 3 次一枚」改为「**每完成 3 个单元（课时）一枚**」，
  火箭收藏与目的地奖励统一跟课文进度走；发射次数只作展示，不再用于任何解锁。
* **交付物**：
* `server.js`：火箭拥有状态严格按完成单元数推导（`rocketIdsForUnits`，每 3 单元一枚）；
  `badges.json` 的 `unlockAt` 3/6/…45 数值不变，语义改为完成单元数；profile / record / 座驾自选均按单元数校准档案，
  旧规则（发射次数）多发的火箭自动收回。
* `public/js/main.js` `renderNextRocket`：进度按 `lessonsCompleted` 计算，文案「再完成 N 个单元」；
  `public/js/ui-renderer.js` 博物馆锁定卡片显示「完成 N 个单元解锁」。
* 测试：`test/rewards-api.test.mjs` 新增「7 次发射 / 1 单元 → 收回旧多发仅初始座驾；补完第 3 个单元 → 解锁长征一号」；
  `test/rocket.test.mjs` 新增门槛自洽（每 3 单元一枚，3/6/…45）与单元数推导拥有状态。
* 验收脚本：`scripts/debug-top-rockets.mjs` / `debug-hangar-ui.mjs` 改单元口径。
* **验收标准**：`npm test` 全绿；无头截图确认机库「再完成 N 个单元」与博物馆「完成 N 个单元解锁」（`.ui-shots/top-*.png`）。

