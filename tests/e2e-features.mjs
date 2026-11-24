// Feature E2E: commands + streaming + inbound media + outbound media.
// Uses mock iLink/CDN and the real OpenCode server.

import { spawn, execSync } from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"

import { WeChatOpenCodeBridge } from "../src/bridge.mjs"
import * as ilink from "../src/ilink/client.mjs"
import { createWeChatSender } from "../src/ilink/sender.mjs"
import { createOpenCodeClient } from "../src/opencode/client.mjs"
import { encryptAesEcb, decryptAesEcb, parseAesKey } from "../src/ilink/media.mjs"

const BRIDGE_DIR = path.resolve(import.meta.dirname, "..")
const MOCK_STATE = path.join(BRIDGE_DIR, "tests", ".feature-mock-state")
const BRIDGE_STATE = path.join(BRIDGE_DIR, "tests", ".feature-e2e-state")
const OUTPUT_DIR = path.join(BRIDGE_DIR, "tests", ".feature-out")
const MOCK_PORT = 9772
const CDN_BASE = `http://127.0.0.1:${MOCK_PORT}/c2c`
const USER = "o-feature-user"
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function clean() {
  for (const d of [MOCK_STATE, BRIDGE_STATE, OUTPUT_DIR]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(MOCK_STATE, { recursive: true })
  fs.mkdirSync(OUTPUT_DIR, { recursive: true })
}

async function waitFor(fn, { timeoutMs, intervalMs = 500, label }) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const v = await fn()
    if (v) return v
    await sleep(intervalMs)
  }
  throw new Error(`timeout waiting for: ${label ?? fn.toString()}`)
}

function msg(id, text, extra = {}) {
  return {
    message_id: id,
    from_user_id: USER,
    to_user_id: "",
    client_id: `c-${id}`,
    message_type: ilink.MessageType.USER,
    message_state: ilink.MessageState.NEW,
    item_list: [{ type: ilink.MessageItemType.TEXT, text_item: { text } }],
    context_token: `ctx-${id}`,
    create_time_ms: Date.now(),
    ...extra,
  }
}

async function main() {
  clean()
  try { execSync(`pkill -f '[m]ock-ilink.*${MOCK_PORT}' 2>/dev/null || true`) } catch {}
  await sleep(300)

  // OpenCode's image normalizer rejects some 1x1 PNGs; use a 32x32 fixture.
  const png = fs.readFileSync(path.join(BRIDGE_DIR, "tests", "32x32.png"))
  const sendFile = path.join(OUTPUT_DIR, "sample.png")
  fs.writeFileSync(sendFile, png)

  // Prepare an inbound encrypted image on the mock CDN.
  const aesKey = crypto.randomBytes(16)
  const inboundKey = "inbound-image-1"
  const inbox = [
    msg("cmd-ping", "/ping"),
    msg("inbound-image", "请描述这张图片", {
      item_list: [
        { type: ilink.MessageItemType.TEXT, text_item: { text: "请描述这张图片" } },
        {
          type: ilink.MessageItemType.IMAGE,
          image_item: {
            media: { encrypt_query_param: inboundKey, aes_key: aesKey.toString("base64"), encrypt_type: 1 },
          },
        },
      ],
    }),
    msg("cmd-send", `/send ${sendFile}`),
    msg("stream", "Write a 400-word essay about why bridge systems are useful. Number each paragraph."),
  ]
  fs.writeFileSync(path.join(MOCK_STATE, "inbound.json"), JSON.stringify(inbox))

  const mock = spawn(process.execPath, [path.join(BRIDGE_DIR, "tests", "mock-ilink.mjs"), String(MOCK_PORT), MOCK_STATE], {
    stdio: ["ignore", "pipe", "pipe"],
  })
  mock.stderr.on("data", (d) => process.stderr.write(`[mock] ${d}`))
  await waitFor(async () => {
    try {
      const r = await fetch(`${CDN_BASE}/download?encrypted_query_param=probe`)
      return r.ok ? true : null
    } catch { return null }
  }, { label: "mock listening", timeoutMs: 5000 })

  await fetch(`${CDN_BASE}/upload?encrypted_query_param=x&filekey=${inboundKey}`, {
    method: "POST",
    body: new Uint8Array(encryptAesEcb(png, aesKey)),
  })

  const opencode = createOpenCodeClient()
  const api = ilink.createClient({ baseUrl: `http://127.0.0.1:${MOCK_PORT}`, token: "mock-token" })
  const sender = createWeChatSender({
    token: "mock-token",
    baseUrl: `http://127.0.0.1:${MOCK_PORT}`,
    accountId: "wcob-feature",
    cdnBaseUrl: CDN_BASE,
  })
  const bridge = new WeChatOpenCodeBridge({
    runtime: { ilink: api, sender },
    opencode,
    stateDir: BRIDGE_STATE,
    accountId: "wcob-feature",
    log: (...a) => console.log("[bridge]", ...a),
    replyTimeoutMs: 5 * 60_000,
    streaming: true,
    streamFlushMs: 120,
    streamMinChars: 10,
    cdnBaseUrl: CDN_BASE,
  })
  bridge.start()

  const recordsPath = path.join(MOCK_STATE, "sent-messages.json")
  const records = await waitFor(() => {
    if (!fs.existsSync(recordsPath)) return null
    const recs = JSON.parse(fs.readFileSync(recordsPath, "utf-8"))
    const hasPing = recs.some((r) => r.text?.includes("pong"))
    const hasImageReply = recs.some((r) => r.text && !r.text.includes("pong") && r.text.length > 3)
    const hasSentImage = recs.some((r) => r.items?.some((i) => i.type === ilink.MessageItemType.IMAGE))
    const hasLong = recs.some((r) => r.text?.length > 200)
    return hasPing && hasImageReply && hasSentImage && hasLong ? recs : null
  }, { label: "all feature replies", timeoutMs: 420_000 })

  bridge.stop()
  const failures = []

  const ping = records.find((r) => r.text?.includes("pong"))
  if (!ping) failures.push("no /ping reply")

  const sentImage = records.find((r) => r.items?.some((i) => i.type === ilink.MessageItemType.IMAGE))
  if (!sentImage) {
    failures.push("no outbound image_item from /send")
  } else {
    const item = sentImage.items.find((i) => i.type === ilink.MessageItemType.IMAGE)
    const media = item.image_item?.media
    const key = parseAesKey(media?.aes_key ?? "")
    const cipher = await fetch(`${CDN_BASE}/download?encrypted_query_param=${encodeURIComponent(media?.encrypt_query_param ?? "")}`)
      .then((r) => r.arrayBuffer())
    try {
      const plain = decryptAesEcb(Buffer.from(cipher), key)
      if (!plain.equals(png)) failures.push("outbound image bytes do not decrypt to original PNG")
    } catch (err) {
      failures.push(`outbound image decrypt failed: ${err.message}`)
    }
  }

  const uploads = JSON.parse(fs.readFileSync(path.join(MOCK_STATE, "uploads.json"), "utf-8"))
  if (!uploads.some((u) => u.media_type === ilink.UploadMediaType.IMAGE)) failures.push("getuploadurl was not called for image")

  const downloads = JSON.parse(fs.readFileSync(path.join(MOCK_STATE, "downloads.json"), "utf-8"))
  if (!downloads.some((d) => d.encrypted_query_param === inboundKey)) failures.push("inbound image was not downloaded")

  const longRecords = records.filter((r) => r.text?.length > 100)
  const streamedChunks = records.filter((r) => r.to_user_id === USER && r.text && !r.text.includes("pong"))
  if (bridge.streamFlushCount < 1) failures.push("SSE streaming never flushed a chunk")
  console.log("\n=== feature e2e summary ===")
  console.log("records:", records.length, "long text records:", longRecords.length, "text replies:", streamedChunks.length, "stream flushes:", bridge.streamFlushCount)
  console.log("command reply:", ping?.text)
  console.log("sent image item:", JSON.stringify(sentImage?.items?.[0]).slice(0, 300))
  if (streamedChunks.length < 2) console.log("NOTE: OpenCode produced a single text delta; streaming path still exercised.")

  const { data: sessions } = await opencode.session.list({ limit: 100 })
  const session = sessions.find((s) => s.title === `wechat-${USER}`)
  if (session) {
    try { await opencode.session.remove({ sessionID: session.id }) } catch {}
  }

  if (failures.length) {
    console.error("FAIL:", failures.join("; "))
    process.exitCode = 1
  } else {
    console.log("PASS: commands + streaming + inbound/outbound media")
  }
  mock.kill("SIGTERM")
  process.exit(process.exitCode ?? 0)
}

main().catch((err) => {
  console.error("feature e2e error:", err)
  process.exit(1)
})
