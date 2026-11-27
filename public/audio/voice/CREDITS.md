# 音节读音素材署名（Credits）

## 整体音节读音 `{拼音}{声调}.wav`

来自开源真人录音库 **[audio-cmn](https://github.com/hugolpz/audio-cmn)**（Shtooka 项目），
由母语者 **王晨 Chen Wang** 录制，覆盖全部汉语拼音带调音节。

- 录音：Chen Wang (王晨)
- 项目整理 / 音频优化：Hugo Lopez（PLIDAM, INALCO）
- 录音软件与技术支持：Nicolas Vion
- 授权：**[CC-BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/)**
- 来源仓库：<https://github.com/hugolpz/audio-cmn>（`64k/syllabs`）

本项目对原始 MP3 做了格式转换（24kHz 单声道 WAV）、首尾静音裁剪、响度归一化与时长封顶。
**转换后的音频文件仍按 CC-BY-SA 3.0 提供**；应用代码与音频素材属聚合使用，各自独立授权。

## 声母/介母/韵母零件 `part/{key}.mp3` 与缺失兜底

由 **AI 语音合成（Qwen-Audio-TTS · qwen-audio-3.0-tts-plus）** 生成，
经 AI 语音识别（qwen-audio-3.0-asr-flash）校验；详见本目录 README.md。

## 旧版种子音节 `{拼音}{声调}.mp3`（40 个）

历史 TTS 合成录音，仅作兼容兜底。