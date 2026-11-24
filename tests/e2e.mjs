// End-to-end test of the bridge:
//   mock iLink server (tests/mock-ilink.mjs)  ->  WeChatOpenCodeBridge  ->  real OpenCode server (127.0.0.1:49374)
//
// Verifies:
//   1. the bridge receives the canned inbound WeChat message from the mock,
//   2. it creates/reuses an OpenCode session (title: wechat-<userId>),
//   3. session.prompt runs and the reply comes back through the bridge,
//   4. the mock iLink server records a sendmessage (the reply delivered to the user).

import { spawn, execSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

import { WeChatOpenCodeBridge } from "../src/bridge.mjs"
import * as ilink from "../src/ilink/client.mjs"
import { createWeChatSender } from "../src/ilink/sender.mjs"
import { createOpenCodeClient } from "../src/opencode/client.mjs"

const BRIDGE_DIR = path.resolve(import.meta.dirname, "..")
const MOCK_STATE = path.join(BRIDGE_DIR, "tests", ".mock-state")
const BRIDGE_STATE = path.join(BRIDGE_DIR, "tests", ".e2e-state")
const RECORDS_PATH = path.join(MOCK_STATE, "sent-messages.json")
const MOCK_PORT = 9771

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function cleanState() {
  fs.rmSync(MOCK_STATE, { recursive: true, force: true })
  fs.rmSync(BRIDGE_STATE, { recursive: true, force: true })
}

async function waitFor(fn, { timeoutMs, intervalMs = 1000, label }) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const v = await fn()
    if (v) return v
    await sleep(intervalMs)
  }
  throw new Error(`timeout waiting for: ${label ?? fn.toString()}`)
}

async function main() {
  cleanState()
  fs.mkdirSync(MOCK_STATE, { recursive: true })
  fs.writeFileSync(path.join(MOCK_STATE, "inbound.json"), JSON.stringify([{
    message_id: "mock-inbound-1",
    from_user_id: "o-test-user",
    client_id: "mock-client-1",
    message_type: 1,
    message_state: 0,
    item_list: [{ type: 1, text_item: { text: "你好，帮我做个简短自我介绍" } }],
    context_token: "mock-context-token",
    create_time_ms: Date.now(),
  }]))
  // Kill any stale mock servers from previous runs so the port is free.
  try {
    execSync("pkill -f '[m]ock-ilink' 2>/dev/null || true")
    await sleep(500)
  } catch {}
  const mock = spawn(process.execPath, [path.join(BRIDGE_DIR, "tests", "mock-ilink.mjs"), String(MOCK_PORT), MOCK_STATE], {
    stdio: ["ignore", "pipe", "pipe"],
  })
  mock.stderr.on("data", (d) => process.stderr.write(`[mock] ${d}`))
  await waitFor(async () => {
    try {
      const r = await fetch(`http://127.0.0.1:${MOCK_PORT}/ilink/bot/getconfig`, { method: "POST", body: "{}" })
      return r.ok ? r : null
    } catch {
      return null
    }
  }, { label: "mock server listening", timeoutMs: 5000, intervalMs: 200 })

  const opencode = createOpenCodeClient()
  const api = ilink.createClient({ baseUrl: `http://127.0.0.1:${MOCK_PORT}`, token: "mock-token" })
  const sender = createWeChatSender({ token: "mock-token", baseUrl: `http://127.0.0.1:${MOCK_PORT}`, accountId: "wcob-e2e" })

  const bridge = new WeChatOpenCodeBridge({
    runtime: { ilink: api, sender },
    opencode,
    stateDir: BRIDGE_STATE,
    accountId: "wcob-e2e",
    replyTimeoutMs: 5 * 60_000,
  })
  bridge.start()

  let createdSessionId = null
  const records = await waitFor(
    () => {
      if (!fs.existsSync(RECORDS_PATH)) return null
      const recs = JSON.parse(fs.readFileSync(RECORDS_PATH, "utf-8"))
      return recs.length > 0 ? recs : null
    },
    { timeoutMs: 360_000, label: "bridge sends reply via ilink sendMessage" },
  )

  const record = records[0]
  const { data: sessions } = await opencode.session.list({ limit: 100 })
  const created = sessions.find((s) => s.title === "wechat-o-test-user")
  createdSessionId = created?.id
  bridge.stop()

  const failures = []
  if (!record?.text || !record.text.trim()) failures.push(`sendMessage recorded empty text`)
  if (record?.to_user_id !== "o-test-user") failures.push(`sendMessage to_user_id=${record?.to_user_id} (expected o-test-user)`)
  if (!createdSessionId) failures.push("opencode session 'wechat-o-test-user' was not created/found")
  console.log("\n=== e2e result ===")
  console.log("sendMessage record:", JSON.stringify(record, null, 2).slice(0, 800))
  console.log("opencode session:", createdSessionId)
  if (createdSessionId) {
    try {
      await opencode.session.remove({ sessionID: createdSessionId })
    } catch {}
  }

  if (failures.length) {
    console.error("FAIL:", failures.join("; "))
    process.exitCode = 1
  } else {
    console.log("PASS: WeChat -> OpenCode bridge round trip")
  }
  mock.kill("SIGTERM")
  process.exit(process.exitCode ?? 0)
}

main().catch((err) => {
  console.error("e2e error:", err)
  process.exit(1)
})
