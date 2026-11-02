#!/usr/bin/env node
/**
 * 从 Cheat Engine 的 autorun 目录移除 agent（不动其他脚本）。
 *
 *   node tools/uninstall-agent.mjs ["E:\app\CE\Cheat Engine"]
 */
import { existsSync, rmSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const AGENT_NAME = "ce_mcp_agent.lua";

const CANDIDATES = [
  process.argv[2],
  process.env.CE_PATH,
  "E:\\app\\CE\\Cheat Engine",
  "C:\\Program Files\\Cheat Engine 7.7",
  "C:\\Program Files\\Cheat Engine 7.5",
  "C:\\Program Files (x86)\\Cheat Engine 7.7",
].filter(Boolean);

const ceDir = CANDIDATES.find(
  (d) => existsSync(join(d, "cheatengine-x86_64.exe")) || existsSync(join(d, "cheatengine-i386.exe")),
);

if (!ceDir) {
  console.error("找不到 Cheat Engine 目录，请显式传入路径。");
  process.exit(2);
}

const target = join(ceDir, "autorun", AGENT_NAME);
if (!existsSync(target)) {
  console.log(`未安装：${target} 不存在，无需卸载。`);
  process.exit(0);
}

rmSync(target, { force: true });
console.log(`已移除：${target}`);
console.log(`备份仍在：${join(ROOT, ".backup")}（可手动恢复）`);
console.log("重启 Cheat Engine 后生效。");
