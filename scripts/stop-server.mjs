/**
 * stop-server.mjs — 停止监听 PORT（默认 3000）的 star-pinyin 服务。
 * 供 npm stop / npm restart 使用：先停旧进程并等端口释放，随后 npm start 才能立即绑定。
 * 零依赖：Windows 解析 netstat -ano，macOS/Linux 用 lsof。
 */
import { execSync } from 'node:child_process';

const PORT = Number(process.env.PORT) || 3000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 当前监听 PORT 的进程 PID 列表。 */
function listeningPids() {
  if (process.platform === 'win32') {
    let out = '';
    try { out = execSync('netstat -ano -p TCP', { encoding: 'utf8' }); } catch { return []; }
    const pids = [];
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(/^\s*TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i);
      if (m && Number(m[2]) === PORT) pids.push(Number(m[3]));
    }
    return [...new Set(pids)];
  }
  try {
    return [...new Set(execSync(`lsof -ti tcp:${PORT} -sTCP:LISTEN`, { encoding: 'utf8' })
      .trim().split(/\s+/).filter(Boolean).map(Number))];
  } catch { return []; }
}

const pids = listeningPids().filter((p) => p > 0 && p !== process.pid);
if (!pids.length) {
  console.log(`端口 ${PORT} 上没有运行中的服务，无需停止。`);
  process.exit(0);
}
for (const pid of pids) {
  try { process.kill(pid); console.log(`已停止服务进程 PID ${pid}（端口 ${PORT}）`); }
  catch (e) { console.error(`停止 PID ${pid} 失败：${e.message}`); process.exit(1); }
}
// 等端口释放（最多 3 秒），npm start 紧接着就能绑定
for (let i = 0; i < 12 && listeningPids().length; i++) await sleep(250);
if (listeningPids().length) {
  console.error(`端口 ${PORT} 仍被占用，请手动检查。`);
  process.exit(1);
}