#!/usr/bin/env node
/**
 * 把 CE 侧 agent 装进 Cheat Engine 的 autorun 目录（会先备份整个 autorun）。
 *
 *   node tools/install-agent.mjs                 # 自动探测 CE 路径
 *   node tools/install-agent.mjs "E:\app\CE\Cheat Engine"
 */
import { existsSync, mkdirSync, readdirSync, copyFileSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const AGENT_SRC = join(ROOT, "agent", "ce_mcp_agent.lua");
const AGENT_NAME = "ce_mcp_agent.lua";
const IPC_DIR = "D:\\ce-mcp-ipc";

const CANDIDATES = [
  process.argv[2],
  process.env.CE_PATH,
  "E:\\app\\CE\\Cheat Engine",
  "C:\\Program Files\\Cheat Engine 7.7",
  "C:\\Program Files\\Cheat Engine 7.5",
  "C:\\Program Files (x86)\\Cheat Engine 7.7",
].filter(Boolean);

function findCe() {
  for (const dir of CANDIDATES) {
    if (existsSync(join(dir, "cheatengine-x86_64.exe")) || existsSync(join(dir, "cheatengine-i386.exe"))) {
      return dir;
    }
  }
  return null;
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

const ceDir = findCe();
if (!ceDir) {
  console.error("找不到 Cheat Engine 目录。请显式传入，例如：");
  console.error('  node tools/install-agent.mjs "E:\\app\\CE\\Cheat Engine"');
  process.exit(2);
}

if (!existsSync(AGENT_SRC)) {
  console.error(`缺少 agent 源文件：${AGENT_SRC}`);
  process.exit(2);
}

const autorun = join(ceDir, "autorun");
if (!existsSync(autorun)) {
  console.error(`CE 目录下没有 autorun 文件夹：${autorun}`);
  process.exit(2);
}

// 1) 备份整个 autorun
const backupDir = join(ROOT, ".backup", `autorun-${stamp()}`);
mkdirSync(backupDir, { recursive: true });
let copied = 0;
for (const name of readdirSync(autorun)) {
  const src = join(autorun, name);
  try {
    if (statSync(src).isFile()) {
      copyFileSync(src, join(backupDir, name));
      copied++;
    }
  } catch {
    /* 忽略无法读取的条目（dll 被占用等） */
  }
}
console.log(`已备份 autorun：${backupDir}（${copied} 个文件）`);

// 2) 装 agent
const target = join(autorun, AGENT_NAME);
const existed = existsSync(target);
if (existed) {
  copyFileSync(target, join(backupDir, `${AGENT_NAME}.old`));
  console.log("检测到旧版本 agent，已一并备份为 .old");
}
copyFileSync(AGENT_SRC, target);
console.log(`已安装 agent → ${target}`);

// 3) 准备 IPC 信箱
for (const sub of ["", "req", "res", "agent"]) {
  mkdirSync(sub ? join(IPC_DIR, sub) : IPC_DIR, { recursive: true });
}
console.log(`已准备信箱目录 → ${IPC_DIR}\\{req,res,agent}`);

console.log("\n下一步：完全退出 Cheat Engine 再重新打开（autorun 只在启动时执行）。");
console.log("验证：等 2 秒后查看 " + IPC_DIR + "\\agent\\heartbeat.txt 是否出现。");
