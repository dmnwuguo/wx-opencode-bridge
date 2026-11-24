// Unit checks for WeChat quoted-message relay (message_id -> text cache and prompt injection).
import assert from "node:assert/strict"

import { createWeChatSender } from "../src/ilink/sender.mjs"

const sender = createWeChatSender({ token: "t", baseUrl: "https://example.invalid" })
const sends = []
sender.api.sendMessage = async ({ msg }) => {
  sends.push(msg)
  return { message_id: `m-${sends.length}`, ret: 0 }
}

sender.recordMessageText("in-1", "我自己的上一条消息")
assert.equal(sender.getSentText("in-1"), "我自己的上一条消息")

await sender.sendText({ ilinkUserId: "u1", contextToken: "ctx", text: "机器人回复一" })
assert.equal(sender.getSentText("m-1"), "机器人回复一")
await sender.sendText({ ilinkUserId: "u1", contextToken: "ctx", text: "机器人回复二" })
assert.equal(sender.getSentText("m-2"), "机器人回复二")

for (let i = 0; i < 205; i++) sender.recordMessageText(`old-${i}`, `正文${i}`)
assert.equal(sender.getSentText("old-0"), undefined)
assert.equal(sender.getSentText("old-204"), "正文204")

// --- bridge: inject quoted text into the prompt ---

import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { WeChatOpenCodeBridge } from "../src/bridge.mjs"
import { WECHAT_SESSION_RULE } from "../src/form-relay.mjs"

function makeBridge() {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "wcob-quote-test-"))
  const cache = new Map()
  const prompts = []
  const opencode = {
    session: {
      prompt: async (input) => { prompts.push(input); return { time: { created: Date.now() } } },
    },
    message: {
      list: async () => ({
        data: [{
          type: "assistant",
          time: { created: Date.now() + 100, completed: Date.now() + 200 },
          finish: "stop",
          content: [{ type: "text", text: "最终答复" }],
        }],
      }),
    },
  }
  const runtime = {
    ilink: {},
    sender: {
      sendText: async () => {},
      startTyping: () => () => {},
      sendImage: async () => {},
      sendVideo: async () => {},
      sendFile: async () => {},
      recordMessageText: (id, text) => cache.set(String(id), String(text)),
      getSentText: (id) => cache.get(String(id)),
    },
  }
  const bridge = new WeChatOpenCodeBridge({
    runtime, opencode, stateDir, accountId: "a", log: () => {},
    replyTimeoutMs: 500, pollIntervalMs: 10, streaming: false,
  })
  bridge.sessionMap.set("user1", "ses_test")
  return { bridge, prompts, cache }
}

function quotedMessage(text, refs, messageId = `in-${Math.random()}`) {
  return {
    message_id: messageId,
    from_user_id: "user1",
    message_type: 1,
    context_token: "ctx",
    item_list: [{
      type: 1,
      text_item: { text },
      ...(refs?.length ? { ref_msg: { message_item: { type: 0, msg_id: refs[0] } } } : {}),
    }],
  }
}

async function inbound(bridge, msg) {
  bridge.onInbound(msg)
  await new Promise((resolve) => setTimeout(resolve, 30))
}

{
  const { bridge, prompts, cache } = makeBridge()
  cache.set("7530974072824459016", "这是被引用的旧消息")
  await inbound(bridge, quotedMessage("有看到引用的消息吗", ["7530974072824459016"], "new-1"))
  assert.equal(prompts.length, 1)
  assert.match(prompts[0].text, /（引用消息：这是被引用的旧消息）/)
  assert.match(prompts[0].text, /有看到引用的消息吗/)
  assert.ok(prompts[0].text.startsWith(WECHAT_SESSION_RULE))
}

{
  const { bridge, prompts } = makeBridge()
  await inbound(bridge, quotedMessage("这个问题", ["unknown-id"], "new-2"))
  assert.equal(prompts.length, 1)
  assert.doesNotMatch(prompts[0].text, /（引用消息：/)
  assert.match(prompts[0].text, /这个问题/)
}

{
  const { bridge, prompts, cache } = makeBridge()
  await inbound(bridge, quotedMessage("上一条", [], "my-own-1"))
  assert.equal(cache.get("my-own-1"), "上一条")
  cache.set("my-own-1", "上一条")
  await inbound(bridge, quotedMessage("解释一下", ["my-own-1"], "new-3"))
  assert.equal(prompts.length, 2)
  assert.match(prompts[1].text, /（引用消息：上一条）/)
}

{
  const { bridge, prompts, cache } = makeBridge()
  cache.set("r1", "引用一")
  cache.set("r2", "引用二")
  await inbound(bridge, {
    message_id: "new-4",
    from_user_id: "user1",
    message_type: 1,
    context_token: "ctx",
    item_list: [
      { type: 1, text_item: { text: "第一行" }, ref_msg: { message_item: { msg_id: "r1" } } },
      { type: 1, text_item: { text: "第二行" }, ref_msg: { message_item: { msg_id: "r2" } } },
      { type: 1, text_item: { text: "第三行" }, ref_msg: { message_item: { msg_id: "r1" } } },
    ],
  })
  assert.equal(prompts.length, 1)
  assert.match(prompts[0].text, /（引用消息：引用一）\n（引用消息：引用二）/)
}

// --- cache persists across sender instances / restarts ---

{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wcob-cache-test-"))
  const cacheFile = path.join(dir, "message-text-cache.json")
  const s1 = createWeChatSender({ token: "t", baseUrl: "https://example.invalid", cacheFile })
  s1.recordMessageText("quoted-1", "持久化正文")
  const s2 = createWeChatSender({ token: "t", baseUrl: "https://example.invalid", cacheFile })
  assert.equal(s2.getSentText("quoted-1"), "持久化正文")
}
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wcob-cache-test-"))
  const cacheFile = path.join(dir, "message-text-cache.json")
  fs.writeFileSync(cacheFile, "not json")
  const s = createWeChatSender({ token: "t", baseUrl: "https://example.invalid", cacheFile })
  assert.equal(s.getSentText("anything"), undefined)
  s.recordMessageText("ok", "仍然可写")
  assert.equal(s.getSentText("ok"), "仍然可写")
}
