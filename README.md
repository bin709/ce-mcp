# ce-mcp

把 **Cheat Engine 7.x** 包装成一个 **MCP（Model Context Protocol）服务**，让任意 agent（WorkBuddy、Claude Desktop、Cursor、自研 agent……）通过标准 MCP 协议读写目标进程内存、反汇编、AOB 扫描、执行 Auto Assembler。

**默认全开**（读写内存、执行 Lua、注入 DLL、变速都直接可用）；想收紧就显式设 `CE_MCP_PROFILE=safe` 或 `standard`。

```
Agent ──MCP(stdio / HTTP 8770)──> ce-mcp(Node) ──文件信箱──> ce_mcp_agent.lua(CE autorun)
                                                              └─ 直接调用 CE Lua API
```

## 为什么是纯 Lua agent，而不是 CE 插件 DLL

另一条可行路线是给 CE 写插件 DLL（走 CE 的 C SDK 函数表）。评估后没有采纳：

1. **工具链成本**：需要 MSVC 编译，32 位和 64 位各一份产物，每次改动都要重编、再进 CE 验证。
2. **会干扰自动化**：插件里做交互（弹窗、同步提示）会占用 CE 主线程，长任务容易卡死。
3. **分帧要自己兜**：TCP 上的粘包、半包、超时都得手写，出了问题很难复现。

纯 Lua agent 把这些都省掉了：`ce_mcp_agent.lua` 放进 `autorun` 目录，CE 启动时自动加载，用 `createTimer` 在主线程轮询文件信箱。零编译、无弹窗，分帧由「一次请求一个文件」天然保证，而且能直接调用 CE 的**全部** Lua API。

## 目录

```
├── agent/ce_mcp_agent.lua      CE 侧 agent（唯一需要放进 CE 的文件）
├── src/
│   ├── index.ts                入口：--stdio / --http / --status / --smoke
│   ├── config.ts               配置加载（默认 < 文件 < 环境变量 < 命令行）
│   ├── policy.ts               权限闸门（safe / standard / full）
│   ├── ipc/client.ts           文件信箱客户端（串行往返 + 心跳）
│   └── mcp/{server,tools}.ts   MCP 工具注册与实现
├── tools/
│   ├── install-agent.mjs       备份 autorun → 安装 agent
│   ├── uninstall-agent.mjs     只删 agent，保留备份
│   ├── install-workbuddy.mjs   写 WorkBuddy 的 mcp.json
│   └── probe.mjs               调试探针：把一段 Lua 送进 CE 执行
└── .backup/                    每次安装/改配置前的备份（不入库）
```

## 安装

前提：Node ≥ 20，Cheat Engine 7.x 已安装。

```bash
cd D:\tools\ce-mcp
npm install
npm run build

# 1) 安装 CE 侧 agent（会把整个 autorun 目录备份到 .backup/ 再复制）
npm run install-agent

# 2) 重启 Cheat Engine（autorun 只在启动时执行）
# 3) 看心跳是否正常
npm run status
```

`npm run status` 里 `agentAlive: true` 就说明链路通了。通信用的信箱目录默认是 `D:\ce-mcp-ipc`（请求 `/req`、响应 `/res`、心跳 `/agent`）。

## CE 主界面上的 MCP 标识

装好 agent 并重启 CE 后，主界面底部那条工具栏上、「表格附加功能」按钮的**左边**，会多出三个字母 `MCP`。
它是挂进 `Panel4` 的原生 `TLabel`（`Align=alRight`，透明背景，跟着 CE 的布局自动排位），不是悬浮窗体：

| 显示 | 含义 |
| --- | --- |
| 字母**绿色** | 有 MCP 服务端在跑：WorkBuddy 已连着，或者 `npm run http` 正在运行 |
| 字母**红色** | 没有服务端：WorkBuddy 没开 / HTTP 没启动 / 超过 10 秒没收到心跳 |

判断依据是服务端每 4 秒写一次的 `D:\ce-mcp-ipc\agent\bridge.txt`（带 unix 时间戳），所以：

- 在 WorkBuddy 里启用 `ce-mcp`（它会拉起 stdio 进程）→ 字母变绿
- 关掉 WorkBuddy → 进程退出 → 10 秒内变红
- `npm run http` 启停同理；端口被占用时会直接报错退出，不会假装在线

**单击 `MCP`** 会弹出一个面板，列出当前全部 17 个 MCP 接口和各自的权限等级。清单由服务端启动时写进 `agent\tools.txt`，所以永远和 `src/mcp/tools.ts` 一致，不用手工同步。

> 万一哪天 CE 换了版本、底部控件改名找不到，agent 会自动退回"右下角浮动小灯"的旧样式，不会静默失效。

想确认标识的真实状态（不靠肉眼）：

```bash
node tools/probe.mjs 'return mcpUiDebug()'
# mode=inline parent=Panel4 align=alRight rect=622,1 48x34 caption=MCP  color=0x78DC5A online=true why=http 模式
```

## 接入 WorkBuddy

```bash
npm run install-workbuddy     # 备份并写入 ~/.workbuddy/connectors/default/mcp.json
```

会写两条记录：

| 名字 | 类型 | 说明 |
| --- | --- | --- |
| `ce-mcp` | stdio | 推荐。WorkBuddy 自己拉起 `node dist/index.js --stdio` |
| `ce-mcp-http` | streamableHttp | 默认 `disabled`，需要先 `npm run http` |

写入后重启 WorkBuddy，在 MCP 列表里应该能看到 `ce-mcp` 和它的 17 个工具。移除：`npm run uninstall-workbuddy`。

## 接入其他 agent

**stdio**（Claude Desktop / Cursor / 大多数客户端）：

```json
{
  "mcpServers": {
    "ce-mcp": {
      "command": "node",
      "args": ["D:\\tools\\ce-mcp\\dist\\index.js", "--stdio"],
      "env": {}
    }
  }
}
```

**HTTP**（任何能连 HTTP 的 agent，本机 8770 端口，Streamable HTTP，stateless）：

```bash
npm run http
# endpoint: http://127.0.0.1:8770/mcp
# 探活:     http://127.0.0.1:8770/health
```

多客户端可以同时连：每条 HTTP 请求都是独立 session，底层对 CE 的调用自动串行化。

## 工具清单

| 工具 | 等级 | 用途 |
| --- | --- | --- |
| `ce_status` | read | 链路健康检查（CE 版本、附加进程、心跳、当前档位） |
| `list_processes` | read | 列进程，支持 filter / limit |
| `attach_process` | read | 附加到进程（名字或 pid） |
| `list_modules` | read | 模块基址+大小，用于 `模块名+偏移` 寻址 |
| `read_memory` | read | 读原始字节，hex + ASCII 转储，单次 ≤ 64KB |
| `read_value` | read | 按类型读：byte/word/dword/integer/qword/single/double/string |
| `disassemble` | read | 反汇编 N 条 |
| `resolve_symbol` | read | `notepad.exe+1A0`、`kernel32.dll:CreateFileW` → 绝对地址 |
| `aob_scan` | read | 特征码扫描，可限定模块 |
| `address_list` | read | 读 CE 地址列表 |
| `read_pointer_chain` | read | 多级指针解引用 |
| `write_memory` | write | 写 hex 字节 |
| `write_value` | write | 按类型写值 |
| `auto_assemble` | execute | 执行 AA 脚本（支持换行） |
| `execute_lua` | execute | 在 CE 里跑任意 Lua |
| `inject_dll` | danger | 注入 DLL |
| `set_speedhack` | danger | 变速 |

地址参数一律支持三种写法：`0x7FF6C0D50000`、十进制、`Notepad.exe+0x3C`。

## 权限档位

| profile | 放行等级 | 适用 |
| --- | --- | --- |
| `safe` | read | 只看不改 |
| `standard` | + write | 需要改内存 |
| `full`（默认） | + execute + danger | AA / Lua / 注入 / 变速 |

配置优先级：默认 < `~/.ce-mcp/config.json` < 环境变量 < 命令行参数。

```bash
# 临时开到全量
node dist/index.js --stdio --profile full

# 只放行某几个高危工具
CE_MCP_ALLOW=write_value,auto_assemble node dist/index.js --stdio --profile safe

# 拉黑某个工具（优先于 allow）
CE_MCP_DENY=execute_lua ...
```

可用环境变量：`CE_MCP_PROFILE`、`CE_MCP_IPC`、`CE_MCP_ALLOW`、`CE_MCP_DENY`、`CE_MCP_PORT`、`CE_MCP_HOST`、`CE_MCP_TOKEN`、`CE_MCP_ANONYMOUS`、`CE_MCP_CONFIG`。

## 安全边界

- 双层闸门：Node 侧按 profile 拒绝，**agent 侧**对 `write/writetype/aa/lua/inject/speed` 二次校验 `gate=1`，绕过 MCP 直接写请求文件也改不了内存。
- HTTP 只监听 `127.0.0.1`；设了 `CE_MCP_TOKEN` 之后必须带 `Authorization: Bearer <token>`。
- 注意：CE 本身是以当前用户权限运行的，`execute_lua` 等价于本机执行代码。默认就是 `full`，如果你接的是不太信任的 agent，请改成 `safe` 或 `standard`。

## 故障排查

| 现象 | 处理 |
| --- | --- |
| `[CE_OFFLINE]` | CE 没开，或 `autorun\ce_mcp_agent.lua` 不存在。重跑 `npm run install-agent` 并重启 CE |
| `[CE_TIMEOUT]` | CE 主窗口可能有模态框挡住主线程；或 AOB 全量扫描太慢，加大 timeout |
| `已拒绝：工具 … 属于 write 等级` | 档位不够，见上面的「权限档位」 |
| CE 侧报错 | 看 `D:\ce-mcp-ipc\agent\log.txt`（最近 200 行），`agent\heartbeat.txt` 里 `ticks` 不涨说明 timer 被卡住 |
| 想手工验证 | `node tools/probe.mjs 'return getCEVersion()'` |

## 开发

```bash
npm run build      # tsc
npm run smoke      # 不启动 MCP，直接打一遍 CE：心跳 → info → processes → 附加 → modules
npm run status     # 打印配置与心跳
npm run probe 'return getProcesslist()'   # 任意 Lua 直达 CE
```

### 协议（文件信箱）

```
req/<id>.req     id=00000001
                 verb=read
                 addr=Notepad.exe+0x3C
                 size=64
                 gate=1            ← 高危动词必带

res/<id>.res     status=ok
                 addr=0x...
                 data=4d5a...
res/<id>.done    空文件，作为「响应已写完」的完成标志
```

值里的 `\` 转义成 `\\`、换行转义成 `\n`。Node 侧轮询 `<id>.done`（12ms 间隔），拿到后清理三个临时文件；调用串行化，保证「一次调用 = 一次往返」。

### 已知限制

- `aob_scan` 走 `AOBScan` 全量扫描再按模块过滤，大进程上可能要几秒到几十秒；`limit` 只限制返回条数，不减少扫描量。
- CE 是 GUI 单线程：任何模态框都会让 agent 停摆（心跳的 `ticks` 可以用来判断）。
- 每个 agent 请求在 CE 主线程同步执行，长 AA 脚本会短暂卡住 CE 界面，这是 CE 的固有行为。
