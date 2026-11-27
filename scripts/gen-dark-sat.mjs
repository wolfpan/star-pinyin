import fs from 'node:fs';
const cred = fs.readFileSync('C:\\Users\\panft\\.dsh\\.credentials.yaml', 'utf8');
const key = (cred.match(/QWEN_TOKEN_PLAN_CN_API_KEY:\s*(\S+)/) || [])[1];
const URL = 'https://token-plan.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';
fs.mkdirSync('public/images/launch', { recursive: true });
fs.mkdirSync('public/images/sat', { recursive: true });
async function gen(prompt, size, out) {
  const res = await fetch(URL, { method: 'POST', headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'wan2.7-image', input: { messages: [{ role: 'user', content: [{ text: prompt }] }] }, parameters: { size, n: 1, watermark: false } }) });
  const j = await res.json();
  if (!res.ok) { console.log('FAIL', out, j.code, (j.message || '').slice(0, 100)); return; }
  const u = j.output?.choices?.[0]?.message?.content?.find((c) => c.image)?.image;
  if (!u) { console.log('NOIMG', out); return; }
  const a = await fetch(u); const buf = Buffer.from(await a.arrayBuffer());
  fs.writeFileSync(out, buf); console.log('OK', out, (buf.length / 1024).toFixed(0) + 'KB');
}
// 发射场背景改为 launch-fx.js 代码绘制（Canvas），不再生成照片背景。
// 绿幕真实卫星
await gen('一颗真实通信卫星的精致3D模型，金色箔包裹的立方体星体，两侧展开深蓝色太阳能帆板，顶部白色抛物面天线与馈源，纯绿色背景(#00FF00)，无阴影无地面，居中，柔和灯光，写实渲染，无文字', '1024*1024', 'public/images/sat/_raw_sat.png');
