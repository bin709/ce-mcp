/**
 * 配置加载：默认值 < 配置文件 < 环境变量 < 命令行参数
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Profile = "safe" | "standard" | "full";

export interface Config {
  /** 本机信箱目录，必须和 CE 侧 agent 里的 IPC_DIR 一致 */
  ipcDir: string;
  /** 默认 profile：safe 只读 / standard 可写 / full 全开 */
  profile: Profile;
  /** 额外放行的工具名（无视 profile） */
  allow: string[];
  /** 强制拒绝的工具名（优先于 allow） */
  deny: string[];
  /** HTTP 入口端口 */
  httpPort: number;
  /** HTTP 入口绑定地址 */
  httpHost: string;
  /** 需要 Bearer token 才允许访问 HTTP */
  token: string | null;
  /** 单条请求默认超时（毫秒） */
  timeoutMs: number;
}

export const DEFAULT_IPC = "D:\\ce-mcp-ipc";

function truthy(v: string | undefined): boolean {
  if (!v) return false;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

export function configPath(): string {
  return process.env.CE_MCP_CONFIG || join(homedir(), ".ce-mcp", "config.json");
}

function readConfigFile(): Partial<Config> {
  const p = configPath();
  if (!existsSync(p)) return {};
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
    const out: Partial<Config> = {};
    if (typeof raw.ipcDir === "string") out.ipcDir = raw.ipcDir;
    if (raw.profile === "safe" || raw.profile === "standard" || raw.profile === "full") {
      out.profile = raw.profile;
    }
    if (Array.isArray(raw.allow)) out.allow = raw.allow.map(String);
    if (Array.isArray(raw.deny)) out.deny = raw.deny.map(String);
    if (typeof raw.httpPort === "number") out.httpPort = raw.httpPort;
    if (typeof raw.httpHost === "string") out.httpHost = raw.httpHost;
    if (typeof raw.token === "string" && raw.token) out.token = raw.token;
    if (typeof raw.timeoutMs === "number") out.timeoutMs = raw.timeoutMs;
    return out;
  } catch (e) {
    console.error(`[ce-mcp] 配置文件解析失败，已忽略：${p} (${(e as Error).message})`);
    return {};
  }
}

export function loadConfig(argv: string[]): Config {
  const file = readConfigFile();
  const cfg: Config = {
    ipcDir: file.ipcDir ?? DEFAULT_IPC,
    profile: file.profile ?? "safe",
    allow: file.allow ?? [],
    deny: file.deny ?? [],
    httpPort: file.httpPort ?? 8770,
    httpHost: file.httpHost ?? "127.0.0.1",
    token: file.token ?? null,
    timeoutMs: file.timeoutMs ?? 15000,
  };

  const envProfile = process.env.CE_MCP_PROFILE as Profile | undefined;
  if (envProfile === "safe" || envProfile === "standard" || envProfile === "full") cfg.profile = envProfile;
  if (process.env.CE_MCP_IPC) cfg.ipcDir = process.env.CE_MCP_IPC;
  if (process.env.CE_MCP_TOKEN) cfg.token = process.env.CE_MCP_TOKEN;
  if (process.env.CE_MCP_PORT) cfg.httpPort = Number(process.env.CE_MCP_PORT) || cfg.httpPort;
  if (process.env.CE_MCP_HOST) cfg.httpHost = process.env.CE_MCP_HOST;
  if (process.env.CE_MCP_ALLOW) cfg.allow = process.env.CE_MCP_ALLOW.split(",").map((s) => s.trim()).filter(Boolean);
  if (process.env.CE_MCP_DENY) cfg.deny = process.env.CE_MCP_DENY.split(",").map((s) => s.trim()).filter(Boolean);
  if (truthy(process.env.CE_MCP_ANONYMOUS)) cfg.token = null;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string | undefined => argv[++i];
    if (a === "--ipc") cfg.ipcDir = next() ?? cfg.ipcDir;
    else if (a === "--profile") {
      const p = next();
      if (p === "safe" || p === "standard" || p === "full") cfg.profile = p;
    } else if (a === "--allow") cfg.allow = (next() ?? "").split(",").filter(Boolean);
    else if (a === "--deny") cfg.deny = (next() ?? "").split(",").filter(Boolean);
    else if (a === "--port") cfg.httpPort = Number(next()) || cfg.httpPort;
    else if (a === "--host") cfg.httpHost = next() ?? cfg.httpHost;
    else if (a === "--token") cfg.token = next() ?? cfg.token;
    else if (a === "--anonymous") cfg.token = null;
    else if (a === "--timeout") cfg.timeoutMs = Number(next()) || cfg.timeoutMs;
  }
  return cfg;
}
