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
  end)
  if not ok then log("tick error: " .. tostring(e)) end
  busy = false
end

local timer = createTimer(nil, false)
timer.Interval = TICK_MS
timer.OnTimer = tick
timer.Enabled = true

log("agent v" .. AGENT_VERSION .. " started, ipc=" .. IPC_DIR)
