/**
 * 服务端心跳（beacon）与接口清单
 *
 * CE 侧的指示灯靠这两个文件判断"服务端到底在不在"：
 *   agent\bridge.txt  每 4 秒刷新一次 epoch=<unix 秒>，CE 里比对 os.time()
 *   agent\tools.txt   启动时写一次，CE 面板直接把这个清单显示出来
 *
 * 这样 CE 里显示的内容永远和 tools.ts 一致，不用手工同步。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolDef } from "../mcp/tools.js";

export interface ToolsManifestEntry {
  name: string;
  level: string;
  title: string;
}

/** 把接口清单写到 agent\tools.txt（覆盖） */
export function writeToolsManifest(ipcDir: string, tools: readonly Pick<ToolDef, "name" | "level" | "title">[]): number {
  const dir = join(ipcDir, "agent");
  mkdirSync(dir, { recursive: true });
  const lines = tools.map((t) => `${t.name}  [${t.level}]  ${t.title ?? ""}`.trimEnd());
  writeFileSync(join(dir, "tools.txt"), lines.join("\n") + "\n", "utf8");
  return lines.length;
}

/**
 * 启动心跳。返回停止函数。
 * 用 unref 保证不会拖住进程退出（stdio 客户端断开后进程要能正常结束）。
 */
export function startBridgeBeacon(ipcDir: string, mode: "stdio" | "http", toolCount: number): () => void {
  const dir = join(ipcDir, "agent");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "bridge.txt");

  const beat = (): void => {
    const now = Math.floor(Date.now() / 1000);
    writeFileSync(
      file,
      `epoch=${now}\nmode=${mode}\npid=${process.pid}\ntools=${toolCount}\ntime=${new Date().toISOString()}\n`,
      "utf8",
    );
  };

  beat();
  const timer = setInterval(beat, 4000);
  timer.unref?.();

  return () => clearInterval(timer);
}
