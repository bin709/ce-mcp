/**
 * 信箱客户端：和 CE 里的 ce_mcp_agent.lua 通过文件往返。
 *
 *   写 req/<id>.req  → agent 30ms 内轮询到 → 执行 → 写 res/<id>.res + res/<id>.done
 *
 * 为什么要串行：agent 每 tick 只处理一条，并发写只会让它们排队，
 * 但响应顺序会乱；串行化之后「一次调用 = 一次往返」的语义最干净。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export class CeError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly fields?: CeFields,
  ) {
    super(message);
    this.name = "CeError";
  }
}

export type CeFields = Record<string, string>;

export interface CallOptions {
  /** 覆盖默认超时（扫描 / AA 需要更久） */
  timeoutMs?: number;
  /** 高危动词：请求里带 gate=1，agent 侧会二次校验 */
  gated?: boolean;
}

export interface Heartbeat {
  alive: boolean;
  ageMs: number;
  fields: CeFields | null;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function unescapeValue(v: string): string {
  let out = "";
  for (let i = 0; i < v.length; i++) {
    const c = v[i];
    if (c !== "\\") {
      out += c;
      continue;
    }
    const n = v[++i];
    if (n === "n") out += "\n";
    else if (n === "r") out += "\r";
    else if (n === "\\") out += "\\";
    else if (n === undefined) out += "\\";
    else out += n;
  }
  return out;
}

function parseFields(text: string): CeFields {
  const out: CeFields = {};
  for (const line of text.split("\n")) {
    if (!line) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    out[line.slice(0, eq)] = unescapeValue(line.slice(eq + 1));
  }
  return out;
}

/** 心跳文件由 agent 用普通字符串写入，不做反斜杠转义，因此不能解转义 */
function parseRawFields(text: string): CeFields {
  const out: CeFields = {};
  for (const line of text.split("\n")) {
    if (!line) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}

export class CeBridge {
  private seq = 0;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    readonly ipcDir: string,
    readonly defaultTimeoutMs = 15000,
  ) {
    for (const sub of ["", "req", "res", "agent"]) {
      mkdirSync(sub ? join(ipcDir, sub) : ipcDir, { recursive: true });
    }
  }

  private p(...parts: string[]): string {
    return join(this.ipcDir, ...parts);
  }

  /** 读 CE 侧心跳，判断 agent 是否在线 */
  heartbeat(): Heartbeat {
    const hb = this.p("agent", "heartbeat.txt");
    if (!existsSync(hb)) return { alive: false, ageMs: Infinity, fields: null };
    try {
      const st = statSync(hb);
      const ageMs = Date.now() - st.mtimeMs;
      const fields = parseRawFields(readFileSync(hb, "utf8"));
      return { alive: ageMs < 10_000, ageMs, fields };
    } catch {
      return { alive: false, ageMs: Infinity, fields: null };
    }
  }

  /** 清理上次崩溃留下的孤儿文件（超过 60 秒的请求/响应） */
  sweep(maxAgeMs = 60_000): number {
    let n = 0;
    for (const sub of ["req", "res"]) {
      const dir = this.p(sub);
      try {
        for (const name of readdirSafe(dir)) {
          const full = join(dir, name);
          try {
            if (Date.now() - statSync(full).mtimeMs > maxAgeMs) {
              rmSync(full, { force: true });
              n++;
            }
          } catch {
            /* ignore */
          }
        }
      } catch {
        /* ignore */
      }
    }
    return n;
  }

  /** 串行执行一次往返 */
  call(verb: string, params: Record<string, string | number | undefined> = {}, opts: CallOptions = {}): Promise<CeFields> {
    const run = this.chain.then(() => this.doCall(verb, params, opts));
    // 链上吞掉错误，避免一次失败卡死后续调用
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async doCall(
    verb: string,
    params: Record<string, string | number | undefined>,
    opts: CallOptions,
  ): Promise<CeFields> {
    const hb = this.heartbeat();
    if (!hb.alive) {
      throw new CeError(
        "Cheat Engine 侧没有响应。请确认：1) Cheat Engine 已启动；" +
          "2) autorun 目录里有 ce_mcp_agent.lua（运行 npm run install-agent 后重启 CE）。",
        "CE_OFFLINE",
      );
    }

    const id = String(++this.seq).padStart(8, "0");
    const reqPath = this.p("req", `${id}.req`);
    const resPath = this.p("res", `${id}.res`);
    const donePath = this.p("res", `${id}.done`);

    const lines = [`id=${id}`, `verb=${verb}`];
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null || v === "") continue;
      lines.push(`${k}=${String(v)}`);
    }
    if (opts.gated) lines.push("gate=1");

    const tmp = `${reqPath}.tmp`;
    writeFileSync(tmp, lines.join("\n") + "\n", "utf8");
    renameSync(tmp, reqPath); // 原子出现，避免 agent 读到半截

    const timeout = opts.timeoutMs ?? this.defaultTimeoutMs;
    const deadline = Date.now() + timeout;
    try {
      while (Date.now() < deadline) {
        if (existsSync(donePath)) {
          const fields = parseFields(readFileSync(resPath, "utf8"));
          if (fields.status === "error") {
            throw new CeError(fields.message || fields.code || "CE 执行失败", fields.code || "CE_ERROR", fields);
          }
          return fields;
        }
        await sleep(12);
      }
      throw new CeError(
        `Cheat Engine 在 ${timeout}ms 内没有返回结果（动词 ${verb}）。` +
          `如果这是大范围扫描，请放宽 timeout；如果是 CE 卡住，检查 CE 主窗口是否在弹窗。`,
        "CE_TIMEOUT",
      );
    } finally {
      for (const p of [reqPath, resPath, donePath, tmp]) {
        try {
          rmSync(p, { force: true });
        } catch {
          /* ignore */
        }
      }
    }
  }
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
