#!/usr/bin/env node
// wechat-opencode-bridge CLI
//
//   setup                 扫码绑定微信 ClawBot（支持验证码 / IDC 重定向）
//   start [--account ID]  前台运行桥接 daemon
//   daemon start|stop|restart|status   后台运行（nohup + PID 文件）
//   doctor                连通性自检：账号 / iLink / OpenCode / SSE / CDN
//   status                查看本地状态与会话映射
//   install-service       生成 systemd user 单元（Linux）或 launchd plist（macOS）
//
// 环境变量：
//   WCOB_STATE_DIR          状态目录（默认 ~/.wechat-opencode-bridge）
//   WCOB_OPENCODE_URL       OpenCode 服务地址（默认 http://127.0.0.1:49374）
//   WCOB_OPENCODE_PASSWORD  OpenCode Basic auth 密码
//   WCOB_STREAMING=0|1      是否启用 SSE 流式分片发送（默认 0；iLink 每次
//                          sendMessage 都是独立新消息，分片会在微信里显示成多条，
//                          正常回复应保持关闭，等完整答复一次发出）
//   WCOB_STREAM_FLUSH_MS    流式分片间隔（默认 3000）
//   WCOB_CDN_BASE_URL       微信 CDN base（默认官方地址）

import fs from "node:fs"
import path from "node:path"
import readline from "node:readline/promises"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { homedir, platform } from "node:os"
import process from "node:process"

import * as ilink from "./ilink/client.mjs"
import {
  startQrLogin,
  saveAccount,
  listAccountIds,
  loadAccount,
  resolveStateDir,
} from "./ilink/accounts.mjs"
import { createWeChatSender } from "./ilink/sender.mjs"
import { defaultOpenCodePassword, createOpenCodeClient } from "./opencode/client.mjs"
import { WeChatOpenCodeBridge, sessionTitle } from "./bridge.mjs"

const SELF = fileURLToPath(import.meta.url)
const STATE_DIR = process.env.WCOB_STATE_DIR ?? resolveStateDir()
const OPENCODE_URL = process.env.WCOB_OPENCODE_URL ?? "http://127.0.0.1:49374"
const STREAMING = process.env.WCOB_STREAMING === "1"
const STREAM_FLUSH_MS = Number.parseInt(process.env.WCOB_STREAM_FLUSH_MS ?? "3000", 10) || 3000
const CDN_BASE_URL = process.env.WCOB_CDN_BASE_URL ?? ilink.CDN_BASE_URL
const PID_FILE = path.join(STATE_DIR, "bridge.pid")
const LOG_FILE = path.join(STATE_DIR, "bridge.log")
const LOG = (msg, ...rest) => console.log(`[bridge ${new Date().toLocaleTimeString()}]`, msg, ...rest)

function argValue(name, fallback = undefined) {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : fallback
}

function pickAccount(explicit) {
  const accounts = listAccountIds(STATE_DIR)
  const id = explicit ?? argValue("--account")
  if (id) {
    if (!accounts.includes(id)) throw new Error(`账号 ${id} 不存在；已登录账号: ${accounts.join(", ") || "(无)"}`)
    return id
  }
  if (!accounts.length) throw new Error("没有找到已登录的账号，请先运行 node main.mjs setup")
  return accounts[0]
}

async function prompt(text) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    return (await rl.question(text)).trim()
  } finally {
    rl.close()
  }
}

function loadToken(accountId) {
  return loadAccount(STATE_DIR, accountId)?.token
}

// ---------------------------------------------------------------------------
// setup
// ---------------------------------------------------------------------------

async function cmdSetup() {
  const accounts = listAccountIds(STATE_DIR)
  const existing = argValue("--account", accounts[0])
  const localTokenList = existing ? [loadToken(existing)].filter(Boolean) : []
  const { qrcode, qrcodeUrl, message } = await startQrLogin({
    baseUrl: ilink.DEFAULT_BASE_URL,
    localTokenList,
  })
  console.log("请用手机微信扫描以下二维码（或访问链接）：")
  console.log(qrcodeUrl)
  try {
    const qrcodeTerminal = await import("qrcode-terminal")
    qrcodeTerminal.default.generate(qrcodeUrl, { small: true })
  } catch {
    // optional dependency; URL above is the fallback
  }
  console.log("等待扫码...（最长 8 分钟）")
  const result = await ilink.waitForLogin({
    qrcode,
    baseUrl: ilink.DEFAULT_BASE_URL,
    localTokenList,
    onStatus: (status) => {
      if (status === ilink.LOGIN_STATUS.SCANED) console.log("已扫码，请在手机上确认...")
    },
    promptVerifyCode: async () => prompt("此账号需要验证码，请输入手机微信显示的验证码: "),
  })
  if (result.alreadyConnected) {
    LOG("已连接过此账号，无需重复连接")
    return
  }
  if (!result.connected || !result.botToken) throw new Error(result.message ?? "登录未完成")
  saveAccount(STATE_DIR, result.accountId, {
    token: result.botToken,
    baseUrl: result.baseUrl ?? ilink.DEFAULT_BASE_URL,
    userId: result.userId,
  })
  console.log("✅ 已将此账号连接到微信。accountId:", result.accountId, "userId:", result.userId)
  try {
    const api = ilink.createClient({ baseUrl: result.baseUrl, token: result.botToken })
    await api.notifyStart()
  } catch {
    // best effort
  }
}

// ---------------------------------------------------------------------------
// start / daemon
// ---------------------------------------------------------------------------

function buildBridge(accountId) {
  const account = loadAccount(STATE_DIR, accountId)
  if (!account?.token) throw new Error("账号缺少 token，请先运行 node main.mjs setup")
  const password = defaultOpenCodePassword()
  const opencode = createOpenCodeClient({ baseUrl: OPENCODE_URL, password })
  const api = ilink.createClient({ baseUrl: account.baseUrl, token: account.token })
  const sender = createWeChatSender({
    token: account.token,
    baseUrl: account.baseUrl,
    accountId,
    cdnBaseUrl: CDN_BASE_URL,
    log: LOG,
    cacheFile: path.join(STATE_DIR, "message-text-cache.json"),
  })
  const bridge = new WeChatOpenCodeBridge({
    runtime: { ilink: api, sender },
    opencode,
    stateDir: STATE_DIR,
    accountId,
    log: LOG,
    streaming: STREAMING,
    streamFlushMs: STREAM_FLUSH_MS,
    cdnBaseUrl: CDN_BASE_URL,
  })
  return bridge
}

async function cmdStart() {
  const accountId = pickAccount()
  const bridge = buildBridge(accountId)

  // Fail fast if OpenCode is unreachable: the daemon would otherwise be useless.
  try {
    await bridge.opencode.session.list({ limit: 1 })
    LOG(`连接到 OpenCode: ${OPENCODE_URL}`)
  } catch (err) {
    throw new Error(`无法访问 OpenCode (${OPENCODE_URL}): ${err instanceof Error ? err.message : String(err)}`)
  }

  bridge.start()
  const shutdown = () => {
    LOG("正在停止 bridge...")
    bridge.stop()
    setTimeout(() => process.exit(0), 500)
  }
  process.on("SIGTERM", shutdown)
  process.on("SIGINT", shutdown)
  LOG(`bridge 已启动，accountId=${accountId}`)
  LOG(`OpenCode: ${OPENCODE_URL}; 流式回复: ${STREAMING ? "开启" : "关闭"}`)
}

function readPid() {
  try {
    const pid = Number.parseInt(fs.readFileSync(PID_FILE, "utf-8").trim(), 10)
    if (!Number.isFinite(pid) || pid <= 0) return null
    process.kill(pid, 0)
    return pid
  } catch {
    return null
  }
}

function cmdDaemon(action = "status") {
  fs.mkdirSync(STATE_DIR, { recursive: true })
  const pid = readPid()
  if (action === "start") {
    if (pid) {
      console.log(`bridge 已在运行 (PID ${pid})`)
      return
    }
    const out = fs.openSync(LOG_FILE, "a")
    const child = spawn(process.execPath, [SELF, "start"], {
      detached: true,
      stdio: ["ignore", out, out],
      env: process.env,
      cwd: process.cwd(),
    })
    child.unref()
    fs.writeFileSync(PID_FILE, String(child.pid))
    console.log(`bridge 已在后台启动，PID=${child.pid}，日志: ${LOG_FILE}`)
    return
  }
  if (action === "stop" || action === "restart") {
    if (pid) {
      try {
        process.kill(pid, "SIGTERM")
      } catch {}
      for (let i = 0; i < 20; i++) {
        if (!readPid()) break
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250)
      }
      if (readPid()) {
        try {
          process.kill(pid, "SIGKILL")
        } catch {}
      }
    }
    try { fs.unlinkSync(PID_FILE) } catch {}
    console.log("bridge 已停止")
    if (action === "restart") cmdDaemon("start")
    return
  }
  console.log(pid ? `bridge 运行中 (PID ${pid})` : "bridge 未运行")
  console.log(`状态目录: ${STATE_DIR}`)
  console.log(`日志文件: ${LOG_FILE}`)
}

// ---------------------------------------------------------------------------
// doctor / status
// ---------------------------------------------------------------------------

async function cmdDoctor() {
  const results = []
  const ok = (name, detail) => results.push({ name, pass: true, detail })
  const fail = (name, detail) => results.push({ name, pass: false, detail })

  fs.mkdirSync(STATE_DIR, { recursive: true })
  ok("状态目录", STATE_DIR)

  const accounts = listAccountIds(STATE_DIR)
  if (accounts.length) ok("微信账号", `已登录 ${accounts.length} 个: ${accounts.join(", ")}`)
  else fail("微信账号", "未登录；请运行 setup")

  const accountId = accounts[0]
  if (accountId) {
    const account = loadAccount(STATE_DIR, accountId)
    try {
      // getConfig is a short request; getUpdates is a 35s long poll and would
      // only time out here, which is not a token failure.
      const api = ilink.createClient({ baseUrl: account.baseUrl, token: account.token })
      const resp = await api.getConfig({ ilinkUserId: account.userId, contextToken: "", timeoutMs: 10000 })
      if (resp.errcode === -14 || resp.ret === -14) fail("iLink token", "已失效，请重新 setup")
      else ok("iLink token", `getConfig ret=${resp.ret ?? 0}${resp.typing_ticket ? "，typing_ticket 可用" : ""}`)
    } catch (err) {
      fail("iLink token", err instanceof Error ? err.message : String(err))
    }
  }

  let opencode
  try {
    opencode = createOpenCodeClient({ baseUrl: OPENCODE_URL, password: defaultOpenCodePassword() })
    const { data } = await opencode.session.list({ limit: 1 })
    ok("OpenCode 服务", `${OPENCODE_URL}（可读 ${Array.isArray(data) ? data.length : "?"} 个会话）`)
  } catch (err) {
    fail("OpenCode 服务", err instanceof Error ? err.message : String(err))
  }

  if (opencode && STREAMING) {
    const controller = new AbortController()
    try {
      const iterator = opencode.event.subscribe({ types: ["server.connected"] }, { signal: controller.signal })[Symbol.asyncIterator]()
      const first = await Promise.race([
        iterator.next(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 5000)),
      ])
      ok("SSE 订阅", first.value?.type === "server.connected" ? "event.subscribe 可用" : JSON.stringify(first.value).slice(0, 80))
      await iterator.return?.()
    } catch (err) {
      fail("SSE 订阅", err instanceof Error ? err.message : String(err))
    } finally {
      controller.abort()
    }
  }

  try {
    const res = await fetch(`${CDN_BASE_URL}/download?encrypted_query_param=probe`, { signal: AbortSignal.timeout(5000) })
    ok("微信 CDN", `HTTP ${res.status}（连通即可）`)
  } catch (err) {
    fail("微信 CDN", err instanceof Error ? err.message : String(err))
  }

  const pid = readPid()
  results.push({ name: "后台 daemon", pass: Boolean(pid), detail: pid ? `运行中 PID=${pid}` : "未运行（可用 daemon start 启动）" })

  console.log("\n=== wechat-opencode-bridge doctor ===")
  for (const r of results) console.log(`${r.pass ? "✅" : "❌"} ${r.name}: ${r.detail}`)
  const failed = results.filter((r) => !r.pass && r.name !== "后台 daemon").length
  if (failed) {
    console.error(`\n${failed} 项检查失败，请按提示修复。`)
    process.exitCode = 1
  } else {
    console.log("\n核心链路检查通过。")
  }
}

async function cmdStatus() {
  const accounts = listAccountIds(STATE_DIR)
  console.log(`状态目录: ${STATE_DIR}`)
  console.log(`后台 daemon: ${readPid() ? `运行中 PID=${readPid()}` : "未运行"}`)
  console.log(`OpenCode: ${OPENCODE_URL}  流式: ${STREAMING ? "开启" : "关闭"}`)
  console.log(`已登录账号: ${accounts.join(", ") || "(无)"}`)
  const sessionFile = path.join(STATE_DIR, "opencode-sessions.json")
  if (fs.existsSync(sessionFile)) {
    try {
      const map = JSON.parse(fs.readFileSync(sessionFile, "utf-8"))
      const entries = Object.entries(map)
      console.log(`会话映射 (${entries.length}):`)
      for (const [userId, sid] of entries.slice(0, 20)) console.log(`  ${userId} -> ${sid} (${sessionTitle(userId)})`)
    } catch (err) {
      console.log("会话映射读取失败:", err instanceof Error ? err.message : String(err))
    }
  }
}

// ---------------------------------------------------------------------------
// service install
// ---------------------------------------------------------------------------

function cmdInstallService() {
  const envLines = [
    `WCOB_STATE_DIR=${STATE_DIR}`,
    `WCOB_OPENCODE_URL=${OPENCODE_URL}`,
    `WCOB_STREAMING=${STREAMING ? "1" : "0"}`,
  ]
    .concat(process.env.WCOB_OPENCODE_PASSWORD ? [`WCOB_OPENCODE_PASSWORD=${process.env.WCOB_OPENCODE_PASSWORD}`] : [])
    .map((l) => `Environment=${l}`)
    .join("\n")

  if (platform() === "darwin") {
    const label = "com.wechat-opencode-bridge"
    const file = path.join(homedir(), "Library", "LaunchAgents", `${label}.plist`)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>${process.execPath}</string><string>${SELF}</string><string>start</string></array>
<key>EnvironmentVariables</key><dict>
${envLines.map((l) => l.replace("Environment=", "")).map((l) => { const [k, v] = l.split("="); return `<key>${k}</key><string>${v}</string>` }).join("\n")}
</dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>StandardOutPath</key><string>${LOG_FILE}</string>
<key>StandardErrorPath</key><string>${LOG_FILE}</string>
</dict></plist>\n`)
    console.log(`已生成 ${file}`)
    console.log(`启动: launchctl load ${file}`)
    return
  }

  const dir = path.join(homedir(), ".config", "systemd", "user")
  const file = path.join(dir, "wechat-opencode-bridge.service")
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(file, `[Unit]
Description=WeChat ClawBot <-> OpenCode bridge
After=network-online.target

[Service]
Type=simple
ExecStart=${process.execPath} ${SELF} start
${envLines}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`)
  console.log(`已生成 ${file}`)
  console.log("启用: systemctl --user daemon-reload && systemctl --user enable --now wechat-opencode-bridge")
}

// ---------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------

const cmd = process.argv[2] ?? "start"
const handlers = {
  setup: cmdSetup,
  start: cmdStart,
  daemon: () => cmdDaemon(process.argv[3] ?? "status"),
  doctor: cmdDoctor,
  status: cmdStatus,
  "install-service": cmdInstallService,
}
const handler = handlers[cmd]
if (!handler) {
  console.error(`未知命令: ${cmd}\n可用命令: ${Object.keys(handlers).join(", ")}`)
  process.exit(1)
}
Promise.resolve()
  .then(handler)
  .catch((err) => {
    console.error(`${cmd} 失败:`, err instanceof Error ? err.message : String(err))
    process.exit(1)
  })
