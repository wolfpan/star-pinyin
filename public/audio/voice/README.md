# 拼音人声目录

## 两类读音

### 1. 整体音节 `{拼音}{声调}.wav`（双源并存，可切换）
- **`lib/{拼音}{声调}.wav` = 真人录音库**：来自开源库 **[audio-cmn](https://github.com/hugolpz/audio-cmn)**（Shtooka 项目），
  母语者 **王晨 Chen Wang** 录制，覆盖全部汉语拼音带调音节，**CC-BY-SA 3.0** 授权（署名见 [CREDITS.md](CREDITS.md)）。
  导入命令 `npm run voice:import`（构建期用 ffmpeg 转 24kHz 单声道 WAV，裁静音 + 统一响度 + 700ms 封顶）。
  **「重新生成」永不覆盖这份。**
- **根目录 `{拼音}{声调}.wav` = AI 合成**：Qwen-Audio-TTS 预生成（`npm run voice:syllable`，经 ASR 校验），
  后台「重新生成」只更新这份。
- 播哪份由 `data/voice-source.json` 决定（全局默认 + 逐音节覆盖），服务端解析同一 URL；
  家长后台切全局默认，音节自检页逐音节切换 + A/B 对比（`?src=lib|tts`）。
- 文件名中 `ü → v`（如 `lv4.wav`=lü4）。

另有 40 个种子任务的历史 TTS 录音 `{拼音}{声调}.mp3`（如 `chuan2.mp3`），仅作兼容兜底。

### 2. 声母/介母/韵母零件 `part/{key}.mp3`
47 个零件的「呼读音」，供慢速拆读（`audio-engine.speakPart` / `slowSplit`）使用。
文件名中 `ü → v`（如 `part/v.mp3`=ü、`part/ve.mp3`=üe、`part/vn.mp3`=ün）。

**为什么零件读音要单独精修？** 让 TTS 读单个汉字并不可靠，实测会读错：
`啊→hā(哈)`、`喔→wa(哇)`、`勒→lēi(累)`、`得→děi`、`鞥→téng(疼)`、`迂→「雨克」`…
因此每个零件都用「候选海选 + ASR 校验」挑出最佳来源（见 `scripts/gen-part-voice.mjs` 的 `RECIPES`）：

| 来源方式 | 适用零件 | 说明 |
| --- | --- | --- |
| 发音唯一的汉字 | 多数声母/韵母（德/乐/雌/玻/坡…） | 避开多音字与生僻字 |
| 带调拼音文本 | a→`ā`、o→`ō`、ei→`ēi` | TTS 能准确读出纯元音 |
| 载波词 + 帧级裁剪 | ao(凹陷)、en(恩典)、eng(灯)、ün(晕倒)、ü(迂回) | 合成词后裁出目标音段（`scripts/mp3-trim.mjs`） |

> 注：ASR 对孤立单音节的转写存在同音/声调近似（如 j→「7」、r→「是」、ü→「吁」、eng→「嗯」），
> 这些已在词语语境中复核确认 TTS 发音正确，属识别近似而非读音错误。

## 播放降级链
- 零件：`part/{key}.mp3` 本地录音 → `/api/tts` 读呼读音汉字 → 浏览器 `speechSynthesis(zh-CN)`。
- 整体：`{拼音}{声调}.wav`（按 voice-source 配置解析真人 lib/ 或 AI 根目录，缺则退回另一份）→ 同名旧 `.mp3` → `/api/tts` 读汉字 → 浏览器 `speechSynthesis`。

## 重新生成 / 扩充

```bash
npm run voice:import          # 导入真人音节库到 lib/（幂等，跳过已有；--force 全部换源）
npm run voice:import:check    # 只报覆盖计划，不联网不写盘
npm run voice:syllable        # AI 音节读音（只写根目录，不碰 lib/；幂等）
npm run voice:parts           # 47 个零件呼读音（幂等）
npm run voice:parts:verify    # 零件读音 + 逐个 ASR 转写校验
node scripts/gen-part-voice.mjs --force --only a,o,sh   # 强制重生成指定零件
npm run voice:system          # 系统提示 + 简报 + 呼读音兜底缓存
```

辅助工具（研发/扩充用）：
- `scripts/audition-voice.mjs` — 候选文本海选：`node scripts/audition-voice.mjs a=啊,阿,吖`
- `scripts/carrier-voice.mjs` — 载波词裁剪实验：`node scripts/carrier-voice.mjs ao 凹陷 range 0-420`
- `scripts/mp3-trim.mjs` — 纯 Node MP3 帧级裁剪（零依赖）
- `scripts/debug-part-voice.mjs` — 无头 Chrome 端到端校验（需本机服务 + 非受限环境）

## 接口与密钥
- TTS：`POST https://token-plan.cn-beijing.maas.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer`
- ASR：`POST …/api/v1/services/aigc/multimodal-generation/generation`（model `qwen-audio-3.0-asr-flash`，音频以 base64 data URI 传入）
- API Key 运行时从本机凭据 `QWEN_TOKEN_PLAN_CN_API_KEY` 读取，**不写入仓库**。
- 家长也可手动放入自录 MP3（同名覆盖即可），无需调用接口。