#!/usr/bin/env node
/**
 * 入口：
 *   ce-mcp --stdio                 给 WorkBuddy / Claude Desktop 这类 stdio 客户端用
 *   ce-mcp --http [--port 8770]    给能连 HTTP 的 agent 用（Streamable HTTP，stateless）
 *   ce-mcp --status                打印配置 + CE 心跳，然后退出
 *   ce-mcp --smoke                 直接对 CE 跑一遍最小自检，不启动 MCP
 */
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { loadConfig } from "./config.js";
import { CeBridge } from "./ipc/client.js";
import { Policy } from "./policy.js";
import { TOOLS } from "./mcp/tools.js";
import { startBridgeBeacon, writeToolsManifest } from "./ipc/beacon.js";
import { createServer, SERVER_NAME, SERVER_VERSION } from "./mcp/server.js";

const log = (msg: string): void => console.error(`[ce-mcp] ${msg}`);

async function runStdio(argv: string[]): Promise<void> {
  const config = loadConfig(argv);
  const { server, bridge } = createServer(config);
  bridge.sweep();
  writeToolsManifest(config.ipcDir, TOOLS);
  const stopBeacon = startBridgeBeacon(config.ipcDir, "stdio", TOOLS.length);
  process.on("exit", stopBeacon);
  const hb = bridge.heartbeat();
  log(
    `stdio 模式启动，profile=${config.profile}，IPC=${config.ipcDir}，` +
      `CE=${hb.alive ? "在线" : "离线（工具调用会返回 CE_OFFLINE）"}`,
  );
  await server.connect(new StdioServerTransport());
}

async function runHttp(argv: string[]): Promise<void> {
  const config = loadConfig(argv);
  const bridge = new CeBridge(config.ipcDir, config.timeoutMs);
  bridge.sweep();
  writeToolsManifest(config.ipcDir, TOOLS);
  const stopBeacon = startBridgeBeacon(config.ipcDir, "http", TOOLS.length);
  process.on("exit", stopBeacon);

  const http = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);

    if (url.pathname === "/health") {
      const hb = bridge.heartbeat();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          server: SERVER_NAME,
          version: SERVER_VERSION,
          agentAlive: hb.alive,
          heartbeatAgeMs: hb.ageMs,
          profile: config.profile,
          tools: TOOLS.length,
        }),
      );
      return;
    }

    if (url.pathname !== "/mcp") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not_found" }));
      return;
    }

    // 鉴权：配了 token 就必须带 Authorization: Bearer <token>
    if (config.token) {
      const auth = req.headers.authorization ?? "";
      const expected = `Bearer ${config.token}`;
      if (auth !== expected) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "unauthorized" }, id: null }));
        return;
      }
    }

    if (req.method !== "POST") {
      // stateless 模式不提供服务端推送流
      res.writeHead(405, { "content-type": "application/json", allow: "POST" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Method not allowed. This endpoint is stateless; use POST." },
          id: null,
        }),
      );
      return;
    }

    const raw = await readBody(req);
    let body: unknown;
    try {
      body = raw.length ? JSON.parse(raw) : {};
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null }));
      return;
    }

    // 每条请求一个独立的 server + transport（stateless，天然支持多客户端并发）
    const { server } = createServer(config);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      log(`HTTP 请求处理失败：${(e as Error).message}`);
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null }));
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    http.once("error", (err: NodeJS.ErrnoException) => reject(err));
    http.listen(config.httpPort, config.httpHost, resolve);
  }).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      log(
        `端口 ${config.httpPort} 已被占用：可能已经有一个 ce-mcp --http 在跑。` +
          `先关掉旧的（或换个端口 --port 8771）再启动。`,
      );
      process.exit(1);
    }
    throw err;
  });
  const hb = bridge.heartbeat();
  log(
    `HTTP 模式启动：http://${config.httpHost}:${config.httpPort}/mcp （/health 可探活）` +
      `，profile=${config.profile}，CE=${hb.alive ? "在线" : "离线"}` +
      (config.token ? "，已启用 Bearer token" : "，未启用 token（仅监听本机）"),
  );
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function runStatus(argv: string[]): Promise<void> {
  const config = loadConfig(argv);
  const bridge = new CeBridge(config.ipcDir, config.timeoutMs);
  const hb = bridge.heartbeat();
  const policy = new Policy(config);
  console.log(
    JSON.stringify(
      {
        ipcDir: config.ipcDir,
        profile: config.profile,
        allowedLevels: policy.allowedLevels(),
        http: `http://${config.httpHost}:${config.httpPort}/mcp`,
        tokenRequired: Boolean(config.token),
        agentAlive: hb.alive,
        heartbeatAgeMs: hb.ageMs,
        heartbeat: hb.fields,
        tools: TOOLS.map((t) => `${t.name}(${t.level})`),
      },
      null,
      2,
    ),
  );
}

async function runSmoke(argv: string[]): Promise<void> {
  const config = loadConfig(argv);
  const bridge = new CeBridge(config.ipcDir, config.timeoutMs);
  const hb = bridge.heartbeat();
  if (!hb.alive) {
    console.error("✗ CE agent 心跳缺失：先启动 Cheat Engine（autorun 里要有 ce_mcp_agent.lua）");
    process.exit(2);
  }
  console.log(`✓ 心跳正常（${hb.ageMs}ms 前，${JSON.stringify(hb.fields)}）`);

  const info = await bridge.call("info", {}, { timeoutMs: 8000 });
  console.log(`✓ info: ${JSON.stringify(info)}`);

  const procs = await bridge.call("processes", {}, { timeoutMs: 20000 });
  const count = (procs.data ?? "").split("\n").filter(Boolean).length;
  console.log(`✓ processes: ${count} 个`);

  const target = process.argv.find((a) => a.startsWith("--target="))?.slice("--target=".length);
  if (target) {
    const opened = await bridge.call("open", { target }, { timeoutMs: 20000 });
    console.log(`✓ open ${target}: ${JSON.stringify(opened)}`);
    const mods = await bridge.call("modules", {}, { timeoutMs: 20000 });
    const n = (mods.data ?? "").split("\n").filter(Boolean).length;
    console.log(`✓ modules: ${n} 个`);
  }
  bridge.sweep();
}

const argv = process.argv.slice(2);
const mode = argv.find((a) => ["--stdio", "--http", "--status", "--smoke"].includes(a)) ?? "--stdio";

if (mode === "--stdio") {
  await runStdio(argv);
} else if (mode === "--http") {
  await runHttp(argv);
} else if (mode === "--status") {
  await runStatus(argv);
} else {
  await runSmoke(argv);
}
