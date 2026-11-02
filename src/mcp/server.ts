/**
 * MCP 服务端：把 tools.ts 里的工具注册成 MCP 工具，并在调用前过权限闸门。
 *
 * 一个进程可以给 stdio 和 HTTP 共用同一套注册逻辑。
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Config } from "../config.js";
import { CeBridge } from "../ipc/client.js";
import { Policy } from "../policy.js";
import { TOOLS } from "./tools.js";

export const SERVER_NAME = "ce-mcp";
export const SERVER_VERSION = "0.1.0";

export interface ServerBundle {
  server: McpServer;
  bridge: CeBridge;
  policy: Policy;
}

function fail(text: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text }] };
}

export function createServer(config: Config): ServerBundle {
  const bridge = new CeBridge(config.ipcDir, config.timeoutMs);
  const policy = new Policy(config);
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.schema,
        annotations: {
          readOnlyHint: tool.level === "read",
          destructiveHint: tool.level === "write" || tool.level === "danger",
          openWorldHint: tool.level === "execute" || tool.level === "danger",
        },
      },
      async (args: Record<string, unknown>): Promise<CallToolResult> => {
        const decision = policy.decide(tool.name, tool.level);
        if (!decision.allowed) {
          return fail(`已拒绝：${decision.reason}`);
        }
        try {
          const result = await tool.run(args ?? {}, { bridge, config });
          return {
            content: [{ type: "text", text: result.text }],
            ...(result.data === undefined ? {} : { structuredContent: { result: result.data } }),
          };
        } catch (e) {
          const err = e as Error & { code?: string };
          const code = err.code ? `[${err.code}] ` : "";
          let hint = "";
          if (err.code === "CE_OFFLINE") {
            hint = "\n\n提示：先确认 Cheat Engine 正在运行，且 autorun\\ce_mcp_agent.lua 存在（npm run install-agent 后重启 CE）。";
          } else if (err.code === "CE_TIMEOUT") {
            hint = "\n\n提示：CE 可能弹了模态框或在处理长任务；检查 CE 主窗口。";
          } else if (err.code === "PERMISSION_DENIED") {
            hint = "\n\n提示：CE 侧闸门拒绝了该请求，通常意味着 Node 侧权限档位不匹配。";
          }
          return fail(`${code}${err.message}${hint}`);
        }
      },
    );
  }

  return { server, bridge, policy };
}
