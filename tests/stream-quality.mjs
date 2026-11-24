import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import * as ilink from "../src/ilink/client.mjs"
import { WeChatOpenCodeBridge } from "../src/bridge.mjs"

function makeBridge({ streamMinChars = 4 } = {}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "wcob-stream-test-"))
  const sent = []
  const opencode = { session: {}, message: {} }
  const runtime = {
    ilink: {},
    sender: {
      sendText: async (args) => { sent.push({ ...args, state: args.state ?? ilink.MessageState.FINISH }) },
      startTyping: () => () => {},
      sendImage: async () => {},
      sendVideo: async () => {},
      sendFile: async () => {},
      recordMessageText: () => {},
      getSentText: () => undefined,
    },
  }
  const bridge = new WeChatOpenCodeBridge({
    runtime, opencode, stateDir, accountId: "a", log: () => {},
    streaming: true, streamMinChars,
  })
  return { bridge, sent }
}

{
  const { bridge, sent } = makeBridge({ streamMinChars: 4 })
  const f = bridge.createStreamFlusher({ userId: "u", contextToken: "c" })
  f.onDelta("第一句话。第二句话还没说完呢。后面还有内容。")
  await new Promise((r) => setTimeout(r, 20))
  assert.ok(sent.length >= 1)
  assert.equal(sent[0].state, ilink.MessageState.GENERATING)
  assert.match(sent[0].text, /。$/)
  const remainder = await f.finish("第一句话。第二句话还没说完呢。后面还有内容。")
  assert.ok(remainder.length > 0)
  await bridge.sendReply("u", "c", remainder)
  assert.equal(sent[sent.length - 1].state, ilink.MessageState.FINISH)
}

{
  const { bridge, sent } = makeBridge({ streamMinChars: 4 })
  const f = bridge.createStreamFlusher({ userId: "u", contextToken: "c" })
  f.onDelta("短文本")
  const remainder = await f.finish("短文本")
  assert.equal(sent.length, 0)
  assert.equal(remainder, "短文本")
}

// --- narration before the final answer must not cause a wholesale resend ---

{
  const { bridge, sent } = makeBridge({ streamMinChars: 120 })
  const f = bridge.createStreamFlusher({ userId: "u", contextToken: "c" })
  const finalText = Array.from({ length: 40 }, (_, i) => `第${i}段说明文字。`).join("")
  f.onDelta("我先看一下日志。" + finalText)
  await new Promise((r) => setTimeout(r, 20))
  const remainder = await f.finish(finalText)
  const streamed = sent.map((s) => s.text).join("")
  assert.ok(streamed.includes(finalText.slice(0, 50)))
  assert.ok(!remainder.includes(finalText.slice(0, 50)))
  assert.ok(finalText.endsWith(remainder))
  assert.ok(remainder.length < finalText.length / 2)
}
