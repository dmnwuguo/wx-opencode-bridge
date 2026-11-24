import assert from "node:assert/strict"

import { createWeChatSender } from "../src/ilink/sender.mjs"

let calls = 0
const s = createWeChatSender({ token: "t", baseUrl: "https://example.invalid" })
s.api.sendMessage = async () => { calls++; return { ret: -2, errmsg: "prepare failed" } }
await assert.rejects(
  () => s.sendText({ ilinkUserId: "u", contextToken: "c", text: "x" }),
  /stale session/,
)
assert.equal(calls, 1)
