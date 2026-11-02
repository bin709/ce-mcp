/**
 * 工具表：每个工具 = 一个 MCP 工具 + 一个 CE 侧动词。
 * 等级（level）决定默认是否放行：
 *   read    —— 只读，任何时候都安全
 *   write   —— 改目标进程内存
 *   execute —— 让 CE 执行代码（AA / Lua）
 *   danger  —— 注入、变速等越界操作
 */
import { z } from "zod";
import type { CeBridge } from "../ipc/client.js";
import type { Config } from "../config.js";
import type { RiskLevel } from "../policy.js";

export interface ToolContext {
  bridge: CeBridge;
  config: Config;
}

export interface ToolResult {
  /** 给 Agent 看的文本 */
  text: string;
  /** 结构化数据（会作为 structuredContent 一起返回） */
  data?: unknown;
}

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  level: RiskLevel;
  schema: z.ZodRawShape;
  timeoutMs?: number;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

// ───────────────────────────── 小工具 ─────────────────────────────

const toHex = (s: string): string => Buffer.from(s, "utf8").toString("hex");
const fromHex = (h: string): string => Buffer.from(h.replace(/\s+/g, ""), "hex").toString("utf8");
const hexToBuffer = (h: string): Buffer => Buffer.from(h.replace(/\s+/g, ""), "hex");

function asciiDump(hex: string, baseAddr?: string, width = 16): string {
  const buf = hexToBuffer(hex);
  const base = baseAddr ? BigInt(baseAddr) : 0n;
  const lines: string[] = [];
  for (let off = 0; off < buf.length; off += width) {
    const chunk = buf.subarray(off, off + width);
    const hexPart = [...chunk].map((b) => b.toString(16).padStart(2, "0")).join(" ").padEnd(width * 3 - 1, " ");
    const ascii = [...chunk].map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : ".")).join("");
    const addr = baseAddr ? `0x${(base + BigInt(off)).toString(16).toUpperCase()}` : `+0x${off.toString(16).toUpperCase()}`;
    lines.push(`${addr}  ${hexPart}  |${ascii}|`);
  }
  return lines.join("\n");
}

function needString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || v.length === 0) throw new Error(`参数 ${key} 必须是非空字符串`);
  return v;
}

function optString(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function num(args: Record<string, unknown>, key: string, def: number): number {
  const v = args[key];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return def;
}

const okJson = (fields: Record<string, unknown>, extra?: Record<string, unknown>): string =>
  JSON.stringify({ ok: true, ...fields, ...(extra ?? {}) }, null, 2);

// ───────────────────────────── 工具定义 ─────────────────────────────

export const TOOLS: ToolDef[] = [
  {
    name: "ce_status",
    title: "CE 状态",
    description:
      "检查这个 MCP 服务是否能和 Cheat Engine 通信：返回 CE 版本、当前附加的进程、agent 版本、心跳延迟，以及当前权限档位。任何其他工具报错时先调它。",
    level: "read",
    schema: {},
    timeoutMs: 8000,
    async run(_args, { bridge, config }) {
      const hb = bridge.heartbeat();
      if (!hb.alive) {
        return {
          text: JSON.stringify(
            {
              ok: false,
              agentAlive: false,
              ipcDir: config.ipcDir,
              hint: "CE 未运行，或 autorun 里没有 ce_mcp_agent.lua。运行 npm run install-agent 后重启 Cheat Engine。",
            },
            null,
            2,
          ),
          data: { agentAlive: false },
        };
      }
      const info = await bridge.call("info", {}, { timeoutMs: 8000 });
      return {
        text: JSON.stringify(
          {
            ok: true,
            agentAlive: true,
            heartbeatAgeMs: hb.ageMs,
            profile: config.profile,
            ipcDir: config.ipcDir,
            info,
          },
          null,
          2,
        ),
        data: { agentAlive: true, ...info },
      };
    },
  },

  {
    name: "list_processes",
    title: "列出进程",
    description: "列出系统里所有进程（pid - 名称），可用 filter 做子串过滤、limit 截断。用来找要附加的目标。",
    level: "read",
    schema: {
      filter: z.string().optional().describe("按名称子串过滤，不区分大小写"),
      limit: z.number().int().min(1).max(2000).optional().describe("最多返回多少条，默认 200"),
    },
    timeoutMs: 20000,
    async run(args, { bridge }) {
      const res = await bridge.call("processes", {}, { timeoutMs: 20000 });
      const all = (res.data ?? "").split("\n").filter(Boolean);
      const filter = optString(args, "filter")?.toLowerCase();
      const filtered = filter ? all.filter((l) => l.toLowerCase().includes(filter)) : all;
      const limit = num(args, "limit", 200);
      const shown = filtered.slice(0, limit);
      return {
        text: okJson({ total: all.length, matched: filtered.length, shown: shown.length }, { processes: shown }),
        data: shown,
      };
    },
  },

  {
    name: "attach_process",
    title: "附加进程",
    description:
      "让 Cheat Engine 附加到一个进程。target 可以是进程名（如 notepad.exe）、pid（如 4321），或 CE 能识别的路径。附加后所有读写工具都作用于该进程。",
    level: "read",
    schema: {
      target: z.string().describe("进程名 / pid"),
    },
    timeoutMs: 20000,
    async run(args, { bridge }) {
      const target = needString(args, "target");
      const res = await bridge.call("open", { target }, { timeoutMs: 20000 });
      return { text: okJson(res), data: res };
    },
  },

  {
    name: "list_modules",
    title: "列出模块",
    description: "列出当前进程已加载的模块（名称、基址、大小），用于算 module+offset 形式的地址。",
    level: "read",
    schema: {},
    timeoutMs: 20000,
    async run(_args, { bridge }) {
      const res = await bridge.call("modules", {}, { timeoutMs: 20000 });
      const lines = (res.data ?? "").split("\n").filter(Boolean).map((l) => {
        const [name, base, size] = l.split("|");
        return { name, base, size };
      });
      return { text: okJson({ count: lines.length }, { modules: lines }), data: lines };
    },
  },

  {
    name: "read_memory",
    title: "读内存（原始字节）",
    description:
      "读取目标进程的一段原始字节并返回 hex + ASCII 转储。address 支持 0x 十六进制、十进制、或 '模块名+偏移'（如 notepad.exe+1A0）。单次最多 64KB。",
    level: "read",
    schema: {
      address: z.string().describe("地址：0x... / 十进制 / 模块名+偏移"),
      size: z.number().int().min(1).max(65536).default(64).describe("字节数，默认 64"),
    },
    timeoutMs: 20000,
    async run(args, { bridge }) {
      const address = needString(args, "address");
      const size = num(args, "size", 64);
      const res = await bridge.call("read", { addr: address, size }, { timeoutMs: 20000 });
      const hex = res.data ?? "";
      const resolved = res.addr;
      return {
        text: `地址 ${resolved}（${size} 字节）:\n${asciiDump(hex, resolved)}`,
        data: { address: resolved, size: hexToBuffer(hex).length, hex },
      };
    },
  },

  {
    name: "read_value",
    title: "读数值",
    description: "按类型读取一个值。type 支持 byte/word/dword/integer/qword/single(float)/double/string（string 用 maxLength）。",
    level: "read",
    schema: {
      address: z.string().describe("地址"),
      type: z.enum(["byte", "word", "dword", "integer", "qword", "single", "double", "string"]).default("integer"),
      maxLength: z.number().int().min(1).max(4096).optional().describe("仅 string 用，默认 64"),
    },
    timeoutMs: 20000,
    async run(args, { bridge }) {
      const address = needString(args, "address");
      const type = (optString(args, "type") ?? "integer") as string;
      const params: Record<string, string | number> = { addr: address, type };
      if (type === "string") params.size = num(args, "maxLength", 64);
      const res = await bridge.call("readtype", params, { timeoutMs: 20000 });
      const value = type === "string" ? fromHex(res.data ?? "") : res.value;
      return {
        text: JSON.stringify({ ok: true, address: res.addr, type: res.type, value }, null, 2),
        data: { address: res.addr, type: res.type, value },
      };
    },
  },

  {
    name: "disassemble",
    title: "反汇编",
    description: "从 address 开始反汇编 count 条指令，返回 '地址|指令' 列表。",
    level: "read",
    schema: {
      address: z.string().describe("起始地址"),
      count: z.number().int().min(1).max(200).default(10).describe("指令条数，默认 10"),
    },
    timeoutMs: 20000,
    async run(args, { bridge }) {
      const address = needString(args, "address");
      const count = num(args, "count", 10);
      const res = await bridge.call("disasm", { addr: address, count }, { timeoutMs: 20000 });
      const lines = (res.data ?? "").split("\n").filter(Boolean);
      return { text: lines.join("\n"), data: lines };
    },
  },

  {
    name: "resolve_symbol",
    title: "解析符号",
    description: "把 CE 的符号/模块偏移（如 'notepad.exe+1A0'、'kernel32.dll:CreateFileW'）解析成绝对地址。",
    level: "read",
    schema: { name: z.string().describe("符号名") },
    timeoutMs: 15000,
    async run(args, { bridge }) {
      const name = needString(args, "name");
      const res = await bridge.call("symbol", { name }, { timeoutMs: 15000 });
      return { text: okJson(res), data: res };
    },
  },

  {
    name: "aob_scan",
    title: "AOB 特征码扫描",
    description:
      "在当前进程里按字节特征码扫描，如 '48 8B ?? ?? 89'。module 可限定单个模块。返回命中地址列表。大范围扫描较慢，超时上限 120 秒。",
    level: "read",
    schema: {
      pattern: z.string().describe("特征码，空格分隔，?? 为通配"),
      module: z.string().optional().describe("限定模块名，如 notepad.exe"),
      limit: z.number().int().min(1).max(5000).default(100).describe("最多返回多少条，默认 100"),
    },
    timeoutMs: 120000,
    async run(args, { bridge }) {
      const pattern = needString(args, "pattern");
      const module = optString(args, "module");
      const res = await bridge.call("aobscan", { pattern, module }, { timeoutMs: 120000 });
      const all = (res.data ?? "").split("\n").filter(Boolean);
      const limit = num(args, "limit", 100);
      return {
        text: okJson({ total: all.length, shown: Math.min(limit, all.length) }, { addresses: all.slice(0, limit) }),
        data: { total: all.length, addresses: all.slice(0, limit) },
      };
    },
  },

  {
    name: "address_list",
    title: "CE 地址列表",
    description: "读取 Cheat Engine 当前地址列表里的记录（地址|类型|值|描述）。",
    level: "read",
    schema: {},
    timeoutMs: 15000,
    async run(_args, { bridge }) {
      const res = await bridge.call("addrlist", {}, { timeoutMs: 15000 });
      const records = (res.data ?? "").split("\n").filter(Boolean).map((l) => {
        const [address, type, value, description] = l.split("|");
        return { address, type, value, description };
      });
      return { text: okJson({ count: records.length }, { records }), data: records };
    },
  },

  {
    name: "read_pointer_chain",
    title: "读多级指针",
    description:
      "读多级指针链：先读 baseAddress 处的指针，逐级加 offsets 并解引用，最后一次解引用后按 valueType 读值。pointerSize 默认 8（64 位进程）。",
    level: "read",
    schema: {
      address: z.string().describe("起始地址（通常是指针的存放位置）"),
      offsets: z.array(z.number().int()).min(1).max(16).describe("偏移链，按层顺序"),
      pointerSize: z.number().int().min(4).max(8).default(8).describe("指针宽度，32 位进程填 4"),
      valueType: z.enum(["byte", "word", "dword", "integer", "qword", "single", "double"]).default("integer"),
    },
    timeoutMs: 60000,
    async run(args, { bridge }) {
      const address = needString(args, "address");
      const offsets = (args.offsets as number[]) ?? [];
      const pointerSize = num(args, "pointerSize", 8);
      const valueType = (optString(args, "valueType") ?? "integer") as string;
      const chain: Array<{ step: string; address: string; pointer?: string }> = [];
      let current = address;
      for (let i = 0; i < offsets.length; i++) {
        const r = await bridge.call(
          "readtype",
          { addr: current, type: pointerSize === 4 ? "integer" : "qword" },
          { timeoutMs: 15000 },
        );
        const ptr = BigInt(r.value ?? "0");
        const next = `0x${(ptr + BigInt(offsets[i]!)).toString(16).toUpperCase()}`;
        chain.push({ step: `读 [${current}]`, address: current, pointer: next });
        current = next;
      }
      const final = await bridge.call("readtype", { addr: current, type: valueType }, { timeoutMs: 15000 });
      return {
        text: JSON.stringify({ ok: true, chain, final: { address: current, type: valueType, value: final.value } }, null, 2),
        data: { chain, final: { address: current, type: valueType, value: final.value } },
      };
    },
  },

  // ── 写 ──
  {
    name: "write_memory",
    title: "写内存（原始字节）",
    description: "把 hex 字节写入目标地址。危险操作：地址错了会让目标进程崩溃。",
    level: "write",
    schema: {
      address: z.string().describe("目标地址"),
      data: z.string().describe("要写入的字节，hex 字符串，如 '90 90' 或 '9090'"),
    },
    timeoutMs: 20000,
    async run(args, { bridge }) {
      const address = needString(args, "address");
      const data = needString(args, "data").replace(/\s+/g, "");
      if (data.length % 2 !== 0) throw new Error("data 的 hex 长度必须是偶数");
      const res = await bridge.call("write", { addr: address, data }, { gated: true, timeoutMs: 20000 });
      return { text: okJson(res), data: res };
    },
  },

  {
    name: "write_value",
    title: "写数值",
    description: "按类型写入一个数值。危险操作：写错地址会破坏目标进程状态。",
    level: "write",
    schema: {
      address: z.string().describe("目标地址"),
      type: z.enum(["byte", "word", "dword", "integer", "qword", "single", "double"]).default("integer"),
      value: z.number().describe("要写入的数值"),
    },
    timeoutMs: 20000,
    async run(args, { bridge }) {
      const address = needString(args, "address");
      const type = (optString(args, "type") ?? "integer") as string;
      const value = num(args, "value", 0);
      const res = await bridge.call("writetype", { addr: address, type, value }, { gated: true, timeoutMs: 20000 });
      return { text: okJson(res), data: res };
    },
  },

  // ── 执行 ──
  {
    name: "auto_assemble",
    title: "Auto Assembler",
    description:
      "把一段 Auto Assembler 脚本交给 CE 执行（alloc/label/aobscanmodule/代码注入等都支持）。脚本可以多行。这是高危工具：脚本内容等同于在目标进程里执行代码。",
    level: "execute",
    schema: {
      script: z.string().describe("完整的 AA 脚本（支持换行）"),
    },
    timeoutMs: 120000,
    async run(args, { bridge }) {
      const script = needString(args, "script");
      const res = await bridge.call("aa", { script: toHex(script) }, { gated: true, timeoutMs: 120000 });
      return {
        text: JSON.stringify({ ok: true, success: res.success === "1", raw: res.success }, null, 2),
        data: { success: res.success === "1" },
      };
    },
  },

  {
    name: "execute_lua",
    title: "执行 CE Lua",
    description:
      "在 Cheat Engine 的 Lua 引擎里执行任意 Lua 代码并返回结果。这是最高危的工具：CE 的 Lua 拥有本机文件与进程权限，等价于在本机执行代码。默认关闭。",
    level: "execute",
    schema: {
      code: z.string().describe("Lua 代码，最后一行可 return 一个值"),
    },
    timeoutMs: 60000,
    async run(args, { bridge }) {
      const code = needString(args, "code");
      const res = await bridge.call("lua", { code: toHex(code) }, { gated: true, timeoutMs: 60000 });
      return { text: JSON.stringify({ ok: true, result: res.result }, null, 2), data: { result: res.result } };
    },
  },

  // ── 危险 ──
  {
    name: "inject_dll",
    title: "注入 DLL",
    description: "把指定路径的 DLL 注入当前进程并加载。同样会被杀毒软件重点关注，默认关闭。",
    level: "danger",
    schema: { path: z.string().describe("DLL 绝对路径") },
    timeoutMs: 60000,
    async run(args, { bridge }) {
      const path = needString(args, "path");
      const res = await bridge.call("inject", { path }, { gated: true, timeoutMs: 60000 });
      return { text: okJson(res), data: res };
    },
  },

  {
    name: "set_speedhack",
    title: "变速",
    description: "设置 CE 的 speedhack 倍速（1.0 为正常，0.5 减速，2 加速）。默认关闭。",
    level: "danger",
    schema: { speed: z.number().describe("倍速，必须 > 0") },
    timeoutMs: 20000,
    async run(args, { bridge }) {
      const speed = num(args, "speed", 1);
      if (speed <= 0) throw new Error("speed 必须大于 0");
      const res = await bridge.call("speed", { value: speed }, { gated: true, timeoutMs: 20000 });
      return { text: okJson(res), data: res };
    },
  },
];
