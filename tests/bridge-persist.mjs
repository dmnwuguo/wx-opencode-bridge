// Bind state must survive a bridge restart, or terminal sync never starts.
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"

import { WeChatOpenCodeBridge, loadContextTokens, saveContextTokens } from "../src/bridge.mjs"
import * as ilink from "../src/ilink/client.mjs"
import { StaleSessionError } from "../src/ilink/sender.mjs"

const dir = fs.mkdtempSync(path.join("/tmp/opencode", "wcob-persist-"))

// Context tokens round-trip through disk.
saveContextTokens(dir, new Map([["u1", "tok1"]]))
assert.deepEqual([...loadContextTokens(dir)], [["u1", "tok1"]])

// Corrupt token file is tolerated.
fs.writeFileSync(path.join(dir, "context-tokens.json"), "{bad")
assert.deepEqual([...loadContextTokens(dir)], [])

function makeBridge(stateDirOverride) {
  const stateDir = stateDirOverride ?? dir
  return new WeChatOpenCodeBridge({
    runtime: {
      ilink: {},
      sender: {
        sendText: async () => {},
        startTyping: () => () => {},
        recordMessageText: () => {},
        sendImage: async () => {},
        sendVideo: async () => {},
        sendFile: async () => {},
      },
    },
    opencode: {
      message: { list: async () => ({ data: [] }) },
      session: { prompt: async () => ({ time: { created: Date.now() } }), get: async () => ({}) },
    },
    stateDir,
    accountId: "test",
    log: () => {},
    streaming: false,
    replyTimeoutMs: 500,
  })
}

// A fresh bridge restores both maps from disk without waiting for WeChat.
fs.writeFileSync(path.join(dir, "opencode-sessions.json"), JSON.stringify({ u1: "ses_u1" }))
saveContextTokens(dir, new Map([["u1", "tok1"]]))
const bridge = makeBridge()
assert.equal(bridge.sessionOwners.get("ses_u1"), "u1", "重启后应从 sessionMap 恢复 sessionOwners")
assert.equal(bridge.contextTokenMap.get("u1"), "tok1", "重启后应恢复 contextToken")

// A new inbound token is persisted for the next restart.
bridge.onInbound({
  message_type: ilink.MessageType.USER,
  from_user_id: "u1",
  context_token: "tok2",
  message_id: "m1",
  item_list: [{ type: ilink.MessageItemType.TEXT, text_item: { text: "hi" } }],
})
assert.equal(bridge.contextTokenMap.get("u1"), "tok2")
assert.equal(loadContextTokens(dir).get("u1"), "tok2", "新 contextToken 应落盘")

// /new must register the new session for terminal sync as well.
bridge.opencode.session.create = async () => ({ id: "ses_new" })
await bridge.commandContext("u1", "tok2").newSession("新会话")
assert.equal(bridge.sessionOwners.get("ses_new"), "u1", "新建会话应绑定给该微信用户")

// A stale token is dropped so the poller stops hitting the paused sender.
{
  const staleDir = fs.mkdtempSync(path.join("/tmp/opencode", "wcob-stale-"))
  const fresh = makeBridge(staleDir)
  fresh.contextTokenMap.set("u1", "tok_stale")
  saveContextTokens(staleDir, fresh.contextTokenMap)
  fresh.runtime.sender.sendText = async () => { throw new StaleSessionError() }
  await assert.rejects(() => fresh.terminalSync.sendText({ ilinkUserId: "u1", contextToken: "tok_stale", text: "x" }))
  assert.equal(fresh.contextTokenMap.get("u1"), undefined, "过期 token 应被丢弃")
  assert.equal(loadContextTokens(staleDir).get("u1"), undefined, "过期 token 应从磁盘移除")
}
