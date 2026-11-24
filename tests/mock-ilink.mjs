// Mock iLink (ClawBot) + CDN server for end-to-end testing of the bridge.
//
// Serves:
//   POST /ilink/bot/getupdates     -> queued inbound messages from <stateDir>/inbound.json
//   POST /ilink/bot/getconfig      -> typing_ticket
//   POST /ilink/bot/sendtyping     -> {"ret":0}
//   POST /ilink/bot/sendmessage    -> records outbound messages
//   POST /ilink/bot/getuploadurl   -> mock upload param
//   POST /c2c/upload               -> stores AES-encrypted bytes, returns x-encrypted-param
//   GET  /c2c/download             -> returns stored AES-encrypted bytes
//
// Usage: node tests/mock-ilink.mjs <port> <stateDir>

import http from "node:http"
import fs from "node:fs"
import path from "node:path"

const [port = "9771", stateDir = "tests/.mock-state"] = process.argv.slice(2)
const recordsPath = path.join(stateDir, "sent-messages.json")
const uploadsPath = path.join(stateDir, "uploads.json")
const downloadsPath = path.join(stateDir, "downloads.json")
const inboundPath = path.join(stateDir, "inbound.json")

const state = {
  index: 0,
  inbound: [],
  cdn: new Map(),
}
try {
  state.inbound = JSON.parse(fs.readFileSync(inboundPath, "utf-8"))
} catch {
  state.inbound = []
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const appendJson = (file, value) => {
  fs.mkdirSync(stateDir, { recursive: true })
  const list = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf-8")) : []
  list.push(value)
  fs.writeFileSync(file, JSON.stringify(list, null, 2))
}

const server = http.createServer(async (req, res) => {
  const chunks = []
  for await (const c of req) chunks.push(c)
  const body = Buffer.concat(chunks)
  const url = new URL(req.url, "http://localhost")
  res.setHeader("Content-Type", "application/json")
  const reply = (obj) => {
    res.writeHead(200)
    res.end(JSON.stringify(obj))
  }

  if (url.pathname === "/ilink/bot/getupdates") {
    await sleep(150)
    const msg = state.inbound[state.index++]
    reply({ ret: 0, msgs: msg ? [msg] : [], get_updates_buf: String(state.index) })
  } else if (url.pathname === "/ilink/bot/getconfig") {
    reply({ ret: 0, typing_ticket: "mock-typing-ticket" })
  } else if (url.pathname === "/ilink/bot/sendtyping") {
    reply({ ret: 0 })
  } else if (url.pathname === "/ilink/bot/sendmessage") {
    const parsed = JSON.parse(body.toString("utf-8") || "{}")
    const record = {
      client_id: parsed.msg?.client_id,
      to_user_id: parsed.msg?.to_user_id,
      context_token: parsed.msg?.context_token,
      text: parsed.msg?.item_list?.map((i) => i.text_item?.text ?? "").join("\n"),
      items: parsed.msg?.item_list,
      type: parsed.msg?.message_type,
      state: parsed.msg?.message_state,
      at: Date.now(),
    }
    appendJson(recordsPath, record)
    reply({ ret: 0, message_id: `srv-${state.index}` })
  } else if (url.pathname === "/ilink/bot/getuploadurl") {
    const parsed = JSON.parse(body.toString("utf-8") || "{}")
    appendJson(uploadsPath, parsed)
    reply({ ret: 0, upload_param: "mock-upload-param" })
  } else if (url.pathname === "/c2c/upload") {
    const filekey = url.searchParams.get("filekey") ?? "unknown"
    state.cdn.set(filekey, body)
    appendJson(uploadsPath, { filekey, bytes: body.length })
    res.setHeader("x-encrypted-param", filekey)
    res.writeHead(200)
    res.end("")
  } else if (url.pathname === "/c2c/download") {
    const key = url.searchParams.get("encrypted_query_param") ?? ""
    appendJson(downloadsPath, { encrypted_query_param: key, at: Date.now() })
    const bytes = state.cdn.get(key) ?? Buffer.from("")
    res.setHeader("Content-Type", "application/octet-stream")
    res.writeHead(200)
    res.end(bytes)
  } else {
    reply({ ret: 0 })
  }
})

server.listen(Number(port), () => console.log(`mock ilink on http://127.0.0.1:${port}`))
