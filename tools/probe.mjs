/**
 * 调试探针：把一段 Lua 直接送进 CE 执行并打印结果。
 *   node tools/probe.mjs 'return getCEVersion()'
 */
import { loadConfig } from "../dist/config.js";
import { CeBridge } from "../dist/ipc/client.js";

const code = process.argv.slice(2).join(" ");
if (!code) {
  console.error("用法: node tools/probe.mjs '<lua code>'");
  process.exit(1);
}

const config = loadConfig([]);
const bridge = new CeBridge(config.ipcDir, config.timeoutMs);
try {
  const res = await bridge.call("lua", { code: Buffer.from(code, "utf8").toString("hex") }, { gated: true, timeoutMs: 15000 });
  console.log(res.result ?? JSON.stringify(res, null, 2));
} catch (e) {
  console.error(`探针失败: ${e.code ?? ""} ${e.message}`);
  process.exit(2);
}
