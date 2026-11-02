/**
 * 把 ce-mcp 注册进 WorkBuddy 的 MCP 配置。
 *
 *   node tools/install-workbuddy.mjs            # 写入 / 更新
 *   node tools/install-workbuddy.mjs --remove   # 移除
 *
 * 目标文件：<WorkBuddy 配置目录>/connectors/default/mcp.json
 *   Windows 默认 %USERPROFILE%\.workbuddy
 *   也接受 WORKBUDDY_CONFIG_DIR / CODEBUDDY_CONFIG_DIR 覆盖
 *
 * 落地两条记录：
 *   ce-mcp        stdio（WorkBuddy 自己拉起进程，推荐）
 *   ce-mcp-http    Streamable HTTP http://127.0.0.1:8770/mcp（需要手动 `npm run http`，默认 disabled）
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const entryPoint = join(root, "dist", "index.js");
const nodeExe = process.execPath;

const wbDir =
  process.env.WORKBUDDY_CONFIG_DIR?.trim() ||
  process.env.CODEBUDDY_CONFIG_DIR?.trim() ||
  join(homedir(), ".workbuddy");
const cfgPath = join(wbDir, "connectors", "default", "mcp.json");

if (!existsSync(entryPoint)) {
  console.error(`找不到 ${entryPoint}，先运行 npm run build`);
  process.exit(1);
}
if (!existsSync(cfgPath)) {
  console.error(`找不到 WorkBuddy 配置文件：${cfgPath}`);
  process.exit(1);
}

const raw = readFileSync(cfgPath, "utf8");
const cfg = JSON.parse(raw);
cfg.mcpServers ??= {};

if (process.argv.includes("--remove")) {
  delete cfg.mcpServers["ce-mcp"];
  delete cfg.mcpServers["ce-mcp-http"];
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n", "utf8");
  console.log(`已从 ${cfgPath} 移除 ce-mcp`);
  process.exit(0);
}

// 备份（保留原始文件，便于回滚）
const backupDir = join(root, ".backup");
mkdirSync(backupDir, { recursive: true });
const stamp = new Date()
  .toISOString()
  .replace(/[-:]/g, "")
  .replace("T", "-")
  .slice(0, 15);
const backup = join(backupDir, `workbuddy-mcp-${stamp}.json`);
copyFileSync(cfgPath, backup);

cfg.mcpServers["ce-mcp"] = {
  type: "stdio",
  command: nodeExe,
  args: [entryPoint, "--stdio"],
  env: { CE_MCP_PROFILE: "safe" },
  runtime: { type: "node", version: ">=20" },
  timeout: 120000,
};

cfg.mcpServers["ce-mcp-http"] = {
  type: "streamableHttp",
  url: "http://127.0.0.1:8770/mcp",
  disabled: true,
  timeout: 120000,
};

writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n", "utf8");
console.log(`✓ 已写入 ${cfgPath}`);
console.log(`  备份：${backup}`);
console.log(`  ce-mcp        stdio  ${nodeExe} ${entryPoint} --stdio`);
console.log(`  ce-mcp-http   http://127.0.0.1:8770/mcp （默认 disabled，需先 npm run http）`);
