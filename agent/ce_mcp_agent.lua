--[[============================================================================
  ce_mcp_agent.lua —— 运行在 Cheat Engine 内部的 MCP 桥接 agent
  ----------------------------------------------------------------------------
  放哪里：<Cheat Engine>\autorun\ce_mcp_agent.lua （即可，CE 启动时自动执行）

  它做什么：
    每 30ms 轮询一个本地文件信箱（默认 D:\ce-mcp-ipc\req\*.req），
    读一条请求 → 在本线程用 CE 的 Lua API 执行 → 把结果写回 res\<id>.res。

  为什么用文件而不是 socket：
    CE 的 createServerSocket 需要阻塞式 accept + 线程，且接口不稳定；
    文件信箱是纯同步的，不会卡死 CE 主线程，出错也容易排查（文件就在那儿）。

  安全：
    所有破坏性动词（写内存 / AutoAssemble / 执行 Lua / 注入 DLL / 加速）
    都要求请求里带 gate=1，只有 MCP 服务端在用户显式开启后才会填这个字段。

  本文件不需要编译，改完重启 CE 即生效。
============================================================================]]

local AGENT_VERSION = "0.1.0"
local IPC_DIR   = [[D:\ce-mcp-ipc]]
local REQ_DIR   = IPC_DIR .. [[\req]]
local RES_DIR   = IPC_DIR .. [[\res]]
local AGT_DIR   = IPC_DIR .. [[\agent]]
local TICK_MS   = 30
local LOG_MAX   = 200          -- 保留最近 200 行日志

-- 需要 gate=1 才允许的动词
local GATED = {
  write = true, writetype = true, aa = true, lua = true,
  inject = true, speed = true, dealloc = true,
}

-- ───────────────────────────── 基础工具 ─────────────────────────────

local function ensureDir(p)
  -- CE 没有 mkdir 接口；目录由 Node 侧创建。这里只做存在性检查。
  return p
end

local function readAll(path)
  local ok, fs = pcall(createFileStream, path, 0) -- 0 = fmOpenRead
  if not ok or not fs then return nil end
  local text = ""
  local okr = pcall(function()
    local n = fs.Size
    local pos = 0
    local parts = {}
    local CH = 8192
    while pos < n do
      local take = math.min(CH, n - pos)
      local t = fs.read(take)
      if not t or #t == 0 then break end
      parts[#parts + 1] = string.char(table.unpack(t))
      pos = pos + take
    end
    text = table.concat(parts)
  end)
  pcall(function() fs.destroy() end)
  if not okr then return nil end
  return text
end

local function writeAll(path, text)
  local ok, fs = pcall(createFileStream, path, 0xff00) -- 0xff00 = fmCreate
  if not ok or not fs then return false end
  local okw = pcall(function() fs.writeString(text) end)
  pcall(function() fs.destroy() end)
  return okw
end

local function safeDelete(path)
  pcall(deleteFile, path)
end

local LOG_LINES = {}
local function log(msg)
  local line = os.date("%H:%M:%S") .. " " .. tostring(msg)
  LOG_LINES[#LOG_LINES + 1] = line
  while #LOG_LINES > LOG_MAX do table.remove(LOG_LINES, 1) end
  writeAll(AGT_DIR .. [[\log.txt]], table.concat(LOG_LINES, "\n"))
end

-- 字符串 → 字节表
local function toBytes(s)
  local t = {}
  for i = 1, #s do t[i] = string.byte(s, i) end
  return t
end

local function toHex(s)
  if not s then return "" end
  return (s:gsub(".", function(c) return string.format("%02X", string.byte(c)) end))
end

-- 字节表 → hex（避免对超大表做 unpack）
local function bytesToHex(t)
  if not t then return "" end
  local out = {}
  for i = 1, #t do out[i] = string.format("%02X", t[i]) end
  return table.concat(out)
end

local function fromHex(h)
  h = h:gsub("%s", "")
  if #h % 2 == 1 then h = "0" .. h end
  local out = {}
  for i = 1, #h, 2 do
    out[#out + 1] = string.char(tonumber(h:sub(i, i + 1), 16) or 0)
  end
  return table.concat(out)
end

-- 值转义：反斜杠与换行，保证一行一个键值对
local function esc(v)
  v = tostring(v == nil and "" or v)
  v = v:gsub("\\", "\\\\")
  v = v:gsub("\r", "\\r")
  v = v:gsub("\n", "\\n")
  return v
end

-- 解析 "k=v" 行
local function parseKV(text)
  local kv = {}
  for k, v in text:gmatch("([%w_]+)=([^\n]*)\n?") do
    kv[k] = v
  end
  return kv
end

local function reply(kv)
  local lines = {}
  for k, v in pairs(kv) do
    lines[#lines + 1] = k .. "=" .. esc(v)
  end
  return table.concat(lines, "\n") .. "\n"
end

local function err(code, message)
  return reply({ status = "error", code = code, message = message or code })
end

local function okv(t)
  t.status = t.status or "ok"
  return reply(t)
end

-- ───────────────────────────── CE 操作 ─────────────────────────────

local function currentPid()
  local ok, pid = pcall(getOpenedProcessID)
  if ok and pid then return pid end
  return 0
end

-- 进程表兼容层：CE 7.7 的 getProcesslist() 实测返回 {pid = name} 的 map，
-- 而文档/旧版本描述是 "pid - name" 数组，两种形态都兼容。
local function processEntries()
  local out = {}
  local ok, list = pcall(getProcesslist)
  if not ok or not list then return out end
  local n = 0
  pcall(function() n = #list end)
  if n and n > 0 then
    for i = 1, n do
      local line
      pcall(function() line = list[i] end)
      if type(line) == "string" then
        local pid, name = line:match("^%s*(%d+)%s*%-%s*(.+)$")
        if pid then out[#out + 1] = { pid = tonumber(pid), name = name } end
      end
    end
    return out
  end
  pcall(function()
    for k, v in pairs(list) do
      if type(k) == "number" and type(v) == "string" then
        out[#out + 1] = { pid = k, name = v }
      end
    end
  end)
  pcall(table.sort, out, function(a, b) return a.pid < b.pid end)
  return out
end

local function processNameOf(pid)
  if pid == 0 then return "" end
  for _, e in ipairs(processEntries()) do
    if e.pid == pid then return e.name end
  end
  return ""
end

-- 地址解析：支持 0x... / 十进制 / 模块名+偏移（如 notepad.exe+1A0）
local function resolveAddr(s)
  if type(s) == "number" then return s end
  if type(s) ~= "string" or s == "" then return nil end
  local n = tonumber(s)
  if n then return n end
  local ok, a = pcall(getAddress, s)
  if ok and type(a) == "number" and a ~= 0 then return a end
  a = nil
  ok, a = pcall(getAddressSafe, s)
  if ok and type(a) == "number" and a ~= 0 then return a end
  return nil
end

local HANDLERS = {}

function HANDLERS.ping(kv)
  return okv({ version = AGENT_VERSION, pid = currentPid() })
end

function HANDLERS.info(kv)
  local pid = currentPid()
  local cev = "?"
  pcall(function() cev = getCEVersion() end)
  local is64 = false
  pcall(function() is64 = targetIs64Bit() end)
  local mods = 0
  if pid ~= 0 then pcall(function() mods = #enumModules() end) end
  return okv({
    version = AGENT_VERSION,
    ce = tostring(cev),
    pid = pid,
    process = processNameOf(pid),
    x64 = is64 and "1" or "0",
    modules = mods,
  })
end

function HANDLERS.processes(kv)
  local entries = processEntries()
  local lines = {}
  for _, e in ipairs(entries) do
    lines[#lines + 1] = string.format("%d - %s", e.pid, e.name)
  end
  return okv({ count = #lines, data = table.concat(lines, "\n") })
end

function HANDLERS.open(kv)
  local target = kv.target or ""
  if target == "" then return err("BAD_ARG", "target 不能为空") end
  local num = tonumber(target)
  local ok = pcall(openProcess, num or target)
  if not ok then return err("OPEN_FAILED", "无法打开进程: " .. target) end
  local pid = currentPid()
  if pid == 0 then return err("OPEN_FAILED", "CE 拒绝打开: " .. target) end
  return okv({ pid = pid, process = processNameOf(pid) })
end

function HANDLERS.modules(kv)
  local ok, mods = pcall(enumModules)
  if not ok or not mods then return err("NO_MODULES", "enumModules 失败（是否已附加进程？）") end
  local lines = {}
  for _, m in ipairs(mods) do
    local name = m.Name or m.name or "?"
    local addr = m.Address or m.address or m.BaseAddress or 0
    local size = m.Size or m.size or m.sizeofimage or 0
    lines[#lines + 1] = string.format("%s|0x%X|0x%X", name, addr, size)
  end
  return okv({ count = #lines, data = table.concat(lines, "\n") })
end

function HANDLERS.read(kv)
  local addr = resolveAddr(kv.addr)
  local size = tonumber(kv.size or "16")
  if not addr then return err("BAD_ADDR", "地址无法解析: " .. tostring(kv.addr)) end
  if size > 65536 then return err("TOO_LARGE", "单次读取上限 64KB，请分段读取") end
  local ok, bytes = pcall(readBytes, addr, size, true)
  if not ok or not bytes then return err("READ_FAILED", string.format("读取 0x%X 失败", addr)) end
  return okv({ addr = string.format("0x%X", addr), size = #bytes, data = bytesToHex(bytes) })
end

function HANDLERS.write(kv)
  local addr = resolveAddr(kv.addr)
  if not addr then return err("BAD_ADDR", "地址无法解析") end
  local bytes = toBytes(fromHex(kv.data or ""))
  if #bytes == 0 then return err("BAD_ARG", "data 为空") end
  local ok = pcall(writeBytes, addr, bytes)
  if not ok then return err("WRITE_FAILED", string.format("写入 0x%X 失败", addr)) end
  return okv({ addr = string.format("0x%X", addr), size = #bytes })
end

-- 注意：CE Lua 没有 readWord / readDword：
--   8 位 = readByte，16 位 = readSmallInteger，32 位 = readInteger，指针 = readPointer
local TYPE_READ = {
  byte = readByte,
  word = readSmallInteger,
  dword = readInteger,
  integer = readInteger,
  int = readInteger,
  qword = readQword,
  int64 = readQword,
  pointer = readPointer,
  single = readFloat,
  float = readFloat,
  double = readDouble,
}

local TYPE_WRITE = {
  byte = writeByte,
  word = writeSmallInteger,
  dword = writeInteger,
  integer = writeInteger,
  int = writeInteger,
  qword = writeQword,
  int64 = writeQword,
  pointer = writePointer,
  single = writeFloat,
  float = writeFloat,
  double = writeDouble,
}

function HANDLERS.readtype(kv)
  local addr = resolveAddr(kv.addr)
  local t = (kv.type or "integer"):lower()
  if not addr then return err("BAD_ADDR", "地址无法解析") end
  if t == "string" then
    local len = tonumber(kv.size or "64")
    local ok, s = pcall(readString, addr, len)
    if not ok then return err("READ_FAILED", "读取字符串失败") end
    return okv({ addr = string.format("0x%X", addr), type = "string", data = toHex(s), text = s })
  end
  local fn = TYPE_READ[t]
  if not fn then return err("BAD_TYPE", "不支持的类型: " .. t) end
  local ok, v = pcall(fn, addr)
  if not ok then return err("READ_FAILED", string.format("读取 0x%X 失败", addr)) end
  return okv({ addr = string.format("0x%X", addr), type = t, value = tostring(v) })
end

function HANDLERS.writetype(kv)
  local addr = resolveAddr(kv.addr)
  local t = (kv.type or "integer"):lower()
  local fn = TYPE_WRITE[t]
  if not addr then return err("BAD_ADDR", "地址无法解析") end
  if not fn then return err("BAD_TYPE", "不支持的类型: " .. t) end
  local v = tonumber(kv.value or "")
  if v == nil then return err("BAD_ARG", "value 必须是数字") end
  local ok = pcall(fn, addr, v)
  if not ok then return err("WRITE_FAILED", string.format("写入 0x%X 失败", addr)) end
  return okv({ addr = string.format("0x%X", addr), type = t, value = tostring(v) })
end

local function basename(p)
  return (tostring(p):gsub("^.*[\\/]", "")):lower()
end

-- CE 7.7 只导出 AOBScan / AOBScanUnique / AOBScanModuleUnique，
-- 没有 AOBScanModule；结果是有 .Count、0 基索引、值是 hex 字符串的 userdata。
function HANDLERS.aobscan(kv)
  local pattern = kv.pattern or ""
  if pattern == "" then return err("BAD_ARG", "pattern 不能为空") end
  local module = kv.module or ""
  local lo, hi = nil, nil
  if module ~= "" then
    local okm, mods = pcall(enumModules)
    if okm and mods then
      local want = basename(module)
      for _, m in ipairs(mods) do
        if basename(m.Name or "") == want then
          lo = m.Address or m.BaseAddress
          hi = lo + (m.Size or 0)
          break
        end
      end
    end
    if not lo then return err("NO_MODULE", "找不到模块: " .. module) end
  end
  local ok, res = pcall(AOBScan, pattern)
  if not ok or not res then return err("SCAN_FAILED", "AOB 扫描失败: " .. tostring(res)) end
  local cnt = 0
  pcall(function() cnt = res.Count end)
  local addrs = {}
  for i = 0, cnt - 1 do
    local s
    pcall(function() s = res[i] end)
    if s then
      s = tostring(s):gsub("^0x", "")
      local n = tonumber(s, 16)
      if n and (not lo or (n >= lo and n < hi)) then
        addrs[#addrs + 1] = "0x" .. s
        if #addrs >= 5000 then break end
      end
    end
  end
  pcall(function() res.destroy() end)
  return okv({ count = #addrs, data = table.concat(addrs, "\n") })
end

function HANDLERS.symbol(kv)
  local name = kv.name or ""
  if name == "" then return err("BAD_ARG", "name 不能为空") end
  local ok, addr = pcall(getAddress, name)
  if not ok or not addr or addr == 0 then
    addr = nil
    pcall(function() addr = getAddressSafe(name) end)
  end
  if not addr then return err("NOT_FOUND", "找不到符号: " .. name) end
  return okv({ name = name, addr = string.format("0x%X", addr) })
end

function HANDLERS.disasm(kv)
  local addr = resolveAddr(kv.addr)
  local count = tonumber(kv.count or "10")
  if not addr then return err("BAD_ADDR", "地址无法解析") end
  local lines = {}
  local cur = addr
  for _ = 1, count do
    local s
    local ok = pcall(function() s = disassemble(cur) end)
    local size = 0
    pcall(function() size = getInstructionSize(cur) end)
    if not ok or size == 0 then break end
    lines[#lines + 1] = string.format("0x%X|%s", cur, s or "?")
    cur = cur + size
  end
  return okv({ count = #lines, data = table.concat(lines, "\n") })
end

function HANDLERS.aa(kv)
  local script = fromHex(kv.script or "")
  if script == "" then return err("BAD_ARG", "script 为空") end
  local ok, res = pcall(autoAssemble, script)
  if not ok then return err("AA_FAILED", "AutoAssemble 抛异常") end
  return okv({ success = res and "1" or "0" })
end

function HANDLERS.lua(kv)
  local code = fromHex(kv.code or "")
  if code == "" then return err("BAD_ARG", "code 为空") end
  local chunk, perr = load(code, "ce_mcp_inline")
  if not chunk then return err("LUA_ERROR", perr) end
  local ok, res = pcall(chunk)
  if not ok then return err("LUA_ERROR", tostring(res)) end
  return okv({ result = res == nil and "nil" or tostring(res) })
end

function HANDLERS.inject(kv)
  local path = kv.path or ""
  if path == "" then return err("BAD_ARG", "path 不能为空") end
  local ok, res = pcall(injectDLL, path)
  if not ok then return err("INJECT_FAILED", "injectDLL 抛异常") end
  return okv({ success = res and "1" or "0" })
end

function HANDLERS.speed(kv)
  local v = tonumber(kv.value or "")
  if not v then return err("BAD_ARG", "value 必须是数字") end
  local ok = pcall(speedhack_setSpeed, v)
  if not ok then return err("SPEED_FAILED", "speedhack_setSpeed 失败") end
  return okv({ value = tostring(v) })
end

function HANDLERS.addrlist(kv)
  local ok, al = pcall(getAddressList)
  if not ok or not al then return err("NO_ADDRLIST", "地址列表不可用") end
  local lines = {}
  local cnt = 0
  pcall(function() cnt = al.getCount() end)
  for i = 0, cnt - 1 do
    local r
    local got = pcall(function() r = al.getMemoryRecord(i) end)
    if got and r then
      local a, d, t, v = 0, "", "", ""
      pcall(function() a = r.Address end)
      pcall(function() d = r.Description or "" end)
      pcall(function() t = r.Type or "" end)
      pcall(function() v = r.Value or "" end)
      lines[#lines + 1] = string.format("%s|%s|%s|%s", tostring(a), tostring(t), tostring(v), tostring(d))
    end
  end
  return okv({ count = #lines, data = table.concat(lines, "\n") })
end

-- ───────────────────────────── 主循环 ─────────────────────────────

local busy = false
local tickCount = 0
local lastDiag = "-"

local function listReqFiles()
  local errs = {}
  for _, dir in ipairs({ REQ_DIR .. "\\", REQ_DIR }) do
    local ok, list = pcall(getFileList, dir, "*.req")
    if ok and list then
      local out = {}
      local n = 0
      pcall(function() n = #list end)
      for i = 0, n do
        local v = list[i]
        if type(v) == "string" and v:lower():match("%.req$") then out[#out + 1] = v end
      end
      if #out > 0 then
        lastDiag = string.format("raw=%s", tostring(out[1]))
        return out
      end
      lastDiag = string.format("dir=%s n=%d hits=0", dir, n)
    else
      errs[#errs + 1] = tostring(dir) .. ":" .. tostring(list)
    end
  end
  if #errs > 0 then lastDiag = table.concat(errs, " | ") end
  return {}
end

local function handleOne()
  local files = listReqFiles()
  local name = files[1]
  if not name then return end
  -- getFileList 可能返回纯文件名，也可能带目录；统一取 basename
  name = name:match("([^\\/]+)$") or name

  local path = REQ_DIR .. "\\" .. name
  local text = readAll(path)
  if not text or text == "" then
    safeDelete(path)
    return
  end

  local kv = parseKV(text)
  local out
  local verb = kv.verb or ""
  local handler = HANDLERS[verb]

  if GATED[verb] and kv.gate ~= "1" then
    out = err("PERMISSION_DENIED", "高危动词 " .. verb .. " 需要显式开启")
  elseif not handler then
    out = err("UNKNOWN_VERB", "不认识的动词: " .. verb)
  else
    local hok, result = pcall(handler, kv)
    if not hok then
      out = err("HANDLER_CRASH", tostring(result))
    else
      out = result
    end
  end

  safeDelete(path)
  local id = kv.id or name:gsub("%.req$", "")
  local resPath = RES_DIR .. "\\" .. id .. ".res"
  writeAll(resPath, out)
  writeAll(RES_DIR .. "\\" .. id .. ".done", "")
  if verb ~= "ping" then
    log(verb .. " " .. (out:match("status=(%w+)") or "?"))
  end
end

local lastBeat = 0

local function tick(timer)
  if busy then return end
  busy = true
  tickCount = tickCount + 1
  local ok, e = pcall(function()
    handleOne()
    local now = os.time()
    if now ~= lastBeat then
      lastBeat = now
      local pid = currentPid()
      local cev = "?"
      pcall(function() cev = getCEVersion() end)
      writeAll(AGT_DIR .. [[\heartbeat.txt]],
        string.format("v=%s\npid=%d\nce=%s\nprocess=%s\nticks=%d\ndiag=%s\ntime=%s\n",
          AGENT_VERSION, pid, tostring(cev), processNameOf(pid), tickCount, lastDiag, os.date("%Y-%m-%d %H:%M:%S")))
    end
    if uiTick then uiTick() end
  end)
  if not ok then log("tick error: " .. tostring(e)) end
  busy = false
end

local timer = createTimer(nil, false)
timer.Interval = TICK_MS
timer.OnTimer = tick
timer.Enabled = true

log("agent v" .. AGENT_VERSION .. " started, ipc=" .. IPC_DIR)

--[[==========================================================================
  UI：Cheat Engine 主窗口右下角的 MCP 状态灯
  ---------------------------------------------------------------------------
  绿灯 = MCP 服务端（Node 侧）在向 agent\bridge.txt 写心跳
  红灯 = 没连上（服务端没启动 / 已退出 / 超过 10 秒没心跳）
  单击状态灯 = 打开面板，列出全部 MCP 接口（清单由服务端启动时写入 agent\tools.txt）

  全部 UI 操作都包在 pcall 里：CE 版本差异导致的属性缺失只会让指示灯失效，
  绝不会让 agent 主循环挂掉。
==========================================================================]]

local UI = {
  form = nil,
  label = nil,
  panel = nil,
  memo = nil,
  attempts = 0,
  dead = false,
  online = nil,
}

local BRIDGE_FILE = AGT_DIR .. [[\bridge.txt]]
local TOOLS_FILE = AGT_DIR .. [[\tools.txt]]
local BRIDGE_STALE_S = 10 -- 超过这个秒数没心跳就算离线

--- 读取服务端心跳，返回 online, 说明
function bridgeStatus()
  local text = readAll(BRIDGE_FILE)
  if not text or text == "" then return false, "服务端未启动" end
  local kv = parseKV(text)
  local epoch = tonumber(kv.epoch or "")
  if not epoch then return false, "心跳缺少时间戳" end
  local age = os.time() - epoch
  if age < -5 then return false, "心跳时间异常" end
  if age > BRIDGE_STALE_S then
    return false, string.format("已 %d 秒无心跳", age)
  end
  return true, string.format("%s 模式", tostring(kv.mode or "?"))
end

local function toolManifest()
  local text = readAll(TOOLS_FILE)
  if not text or text == "" then return {}, 0 end
  local list = {}
  for line in (text .. "\n"):gmatch("([^\n]*)\n") do
    if line ~= "" then list[#list + 1] = line end
  end
  return list, #list
end

local function mainForm()
  local ok, mf = pcall(getMainForm)
  if ok and mf then return mf end
  return nil
end

-- ===== 主界面内嵌标识：底部 Panel4 条里的 MCP 三个字母（红/绿） =====
-- TColor 是 0x00BBGGRR：绿 rgb(90,220,120) -> 0x78DC5A，红 rgb(255,95,95) -> 0x5F5FFF
local GREEN_TEXT = 0x78DC5A
local RED_TEXT = 0x5F5FFF
local FLOATING_GREEN = 0x1F7A3D
local FLOATING_RED = 0xB4232B
local BUILD_DELAY_TICKS = 120 -- 等 ~3.6 秒，让 CE 把主窗体布局做完

local function controlName(c)
  local ok, v = pcall(function() return c.Name end)
  if ok and v then return tostring(v) end
  return ""
end

local function childCount(c)
  local n = 0
  pcall(function() n = c.ControlCount end)
  if type(n) ~= "number" then n = 0 end
  if n <= 0 then pcall(function() n = c.getControlCount() end) end
  if type(n) ~= "number" then n = 0 end
  return n
end

local function findChild(parent, name)
  local n = childCount(parent)
  for i = 0, n - 1 do
    local c
    pcall(function() c = parent.Control[i] end)
    if c and controlName(c) == name then return c end
  end
  return nil
end

-- 主界面底部条是 Panel4，右侧那个按钮就是「表格附加功能」
local function bottomBar()
  local mf = mainForm()
  if not mf then return nil, nil end
  local panel = findChild(mf, "Panel4")
  if not panel then return nil, nil end
  return panel, findChild(panel, "CommentButton")
end

local function paint(online)
  if not UI.label then return end
  if UI.mode == "inline" then
    pcall(function() UI.label.Caption = "MCP " end)
    pcall(function() UI.label.Font.Color = online and GREEN_TEXT or RED_TEXT end)
  else
    pcall(function() UI.label.Caption = online and "MCP  ● 在线" or "MCP  ● 未连接" end)
    pcall(function() UI.form.RGBColor = online and FLOATING_GREEN or FLOATING_RED end)
    pcall(function() UI.label.Font.Color = 0xFFFFFF end)
  end
  if UI.online ~= online then
    UI.online = online
    log("mcp indicator: " .. (online and "online" or "offline"))
  end
end

local buildFloatingUi

-- Panel4 是 AutoSize 的自动布局面板，手写坐标会被布局引擎覆盖；
-- 用 Align=alRight 让 VCL 自己把它排到「表格附加功能」左边，缩放也跟着走。
local function placeInline()
  if UI.mode ~= "inline" or not UI.label then return end
  local l, t, w, h = -1, -1, -1, -1
  pcall(function() l, t, w, h = UI.label.Left, UI.label.Top, UI.label.Width, UI.label.Height end)
  if l >= 90 and not UI.placedOnce then
    UI.placedOnce = true
    log(string.format("inline badge placed: rect=%d,%d %dx%d", l, t, w, h))
  end
end

local function placeFloating()
  local mf = mainForm()
  if not mf or not UI.form then return end
  pcall(function()
    local vis = mf.Visible
    UI.form.Visible = vis ~= false
    UI.form.Left = mf.Left + mf.Width - UI.form.Width - 26
    UI.form.Top = mf.Top + mf.Height - UI.form.Height - 48
  end)
end

buildFloatingUi = function()
  local ok, e = pcall(function()
    local f = createForm(false)
    f.Caption = "ce-mcp"
    f.Width = 112
    f.Height = 22
    pcall(function() f.BorderStyle = "bsNone" end)
    pcall(function() f.FormStyle = "fsSystemStayOnTop" end)
    local l = createLabel(f)
    l.Left = 8
    l.Top = 4
    l.Width = 100
    l.Height = 16
    l.Caption = "MCP  ● 连接中"
    pcall(function() l.Transparent = true end)
    pcall(function()
      l.Font.Size = 9
      l.Font.Style = "fsBold"
      l.Font.Color = 0xFFFFFF
    end)
    l.OnClick = function() togglePanel() end
    UI.form, UI.label, UI.mode, UI.parent = f, l, "floating", "Form"
    f.Visible = true
  end)
  if not ok then
    log("floating ui failed: " .. tostring(e))
    UI.form, UI.label = nil, nil
    return
  end
  log("ui ready: 右下角浮动指示灯")
  paint(bridgeStatus())
  placeFloating()
end

function buildUi()
  if UI.dead then return end
  if UI.label or UI.form then return end

  local mf = mainForm()
  if not mf then return end
  local visible = false
  pcall(function() visible = (mf.Visible == true) end)
  if not visible then return end
  if UI.attempts < BUILD_DELAY_TICKS then return end

  local panel, comment = bottomBar()
  if panel and comment then
    local ok, e = pcall(function()
      local l = createLabel(panel)
      l.Caption = "MCP "
      pcall(function() l.Transparent = true end)
      pcall(function() l.Font.Style = "fsBold" end)
      pcall(function() l.Font.Color = RED_TEXT end)
      pcall(function() l.Layout = "tlCenter" end)
      pcall(function() l.Alignment = "taCenter" end)
      pcall(function() l.Cursor = "crHandPoint" end)
      pcall(function() l.Hint = "ce-mcp 状态；点击查看接口清单" end)
      pcall(function() l.ShowHint = true end)
      l.OnClick = function() togglePanel() end
      l.Align = "alRight" -- 交给 Panel4 的自动布局，排在「表格附加功能」左边
      UI.label, UI.mode, UI.parent = l, "inline", "Panel4"
    end)
    if ok then
      paint(bridgeStatus())
      placeInline()
      if UI.mode == "inline" then
        log(string.format("ui ready: 底部条 MCP 标识 rect=%d,%d %dx%d",
          UI.label.Left, UI.label.Top, UI.label.Width, UI.label.Height))
      end
      return
    end
    log("inline badge failed: " .. tostring(e))
    UI.label, UI.mode, UI.parent = nil, nil, nil
  else
    log("bottomBar 未找到（Panel4/CommentButton），改用浮动指示灯")
  end
  buildFloatingUi()
end

function panelText()
  local online, why = bridgeStatus()
  local pid = currentPid()
  local pname = processNameOf(pid)
  if pname == "" then pname = "(未附加)" end
  local cev = "?"
  pcall(function() cev = getCEVersion() end)
  local list, n = toolManifest()

  local out = {
    "ce-mcp  ——  Cheat Engine MCP 桥接  v" .. AGENT_VERSION,
    string.rep("─", 52),
    "服务端  " .. (online and ("在线（" .. why .. "）") or ("未连接（" .. why .. "）")),
    "CE 版本 " .. tostring(cev) .. "      附加进程  " .. pname .. "  (pid " .. tostring(pid) .. ")",
    "已执行  " .. tostring(tickCount) .. " 次轮询      IPC  " .. IPC_DIR,
    "",
    "MCP 接口（" .. tostring(n) .. " 项，服务端启动时写入）",
    string.rep("─", 52),
  }
  if n == 0 then
    out[#out + 1] = "(还没有接口清单：先启动 MCP 服务端 —— npm run http 或让 WorkBuddy 拉起)"
  else
    for i = 1, n do out[#out + 1] = "  " .. list[i] end
  end
  out[#out + 1] = ""
  out[#out + 1] = "主界面底部「表格附加功能」左边的 MCP：字母绿色 = 服务端已连上；红色 = 没连上。"
  out[#out + 1] = "点 MCP 三个字母可以随时调出这个窗口。"
  return table.concat(out, "\r\n")
end

function togglePanel()
  if UI.panel then
    pcall(function() UI.panel.Visible = not UI.panel.Visible end)
    if UI.panel.Visible then
      pcall(function() UI.memo.Lines.Text = panelText() end)
      pcall(function() UI.panel.bringToFront() end)
    end
    return
  end
  local ok, e = pcall(function()
    local p = createForm(false)
    p.Caption = "ce-mcp —— MCP 接口"
    p.Width = 520
    p.Height = 460
    pcall(function() p.Position = "poScreenCenter" end)
    pcall(function() p.FormStyle = "fsStayOnTop" end)

    local m = createMemo(p)
    m.Left = 8
    m.Top = 8
    m.Width = 496
    m.Height = 412
    pcall(function() m.ScrollBars = "ssAutoBoth" end)
    pcall(function() m.WordWrap = false end)
    pcall(function()
      m.Font.Name = "Consolas"
      m.Font.Size = 9
    end)
    m.Lines.Text = panelText()
    UI.panel, UI.memo = p, m
    p.Visible = true
  end)
  if not ok then log("panel failed: " .. tostring(e)) end
end

function uiTick()
  if UI.dead then return end

  local hasUi = (UI.label ~= nil) or (UI.form ~= nil)
  if not hasUi then
    UI.attempts = (UI.attempts or 0) + 1
    if UI.attempts > 900 then
      UI.dead = true
      log("ui disabled: 等不到主窗口")
      return
    end
    buildUi()
    return
  end

  if tickCount % 15 ~= 0 then return end -- ~450ms 刷新一次
  if not UI.label and not UI.form then return end
  paint(bridgeStatus())
  if UI.mode == "inline" then
    placeInline()
  elseif UI.form then
    placeFloating()
  end
end

-- 调试用：probe 'return mcpUiDebug()'
function mcpUiDebug()
  local online, why = bridgeStatus()
  if not UI.label then
    return string.format("label=nil mode=%s online=%s why=%s", tostring(UI.mode), tostring(online), tostring(why))
  end
  local l, t, w, h = -1, -1, -1, -1
  pcall(function() l, t, w, h = UI.label.Left, UI.label.Top, UI.label.Width, UI.label.Height end)
  local cap, col, vis, al = "?", "?", "?", "?"
  pcall(function() cap = tostring(UI.label.Caption) end)
  pcall(function() col = string.format("0x%06X", UI.label.Font.Color) end)
  pcall(function() vis = tostring(UI.label.Visible) end)
  pcall(function() al = tostring(UI.label.Align) end)
  return string.format("mode=%s parent=%s align=%s rect=%d,%d %dx%d caption=%s color=%s visible=%s online=%s why=%s",
    tostring(UI.mode), tostring(UI.parent), al, l, t, w, h, cap, col, vis, tostring(online), tostring(why))
end
