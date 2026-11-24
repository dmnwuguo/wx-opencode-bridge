// Unit checks for relaying OpenCode form events to WeChat and answering them.
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { WeChatOpenCodeBridge } from "../src/bridge.mjs"
import { WECHAT_SESSION_RULE } from "../src/form-relay.mjs"

const form = {
  id: "frm_test",
  sessionID: "ses_test",
  title: "澄清需求",
  fields: [
    {
      key: "q1",
      type: "string",
      title: "你指的是哪方面？",
      options: [
        { value: "risk", label: "后续风险与关注点" },
        { value: "final", label: "给个最终结论" },
      ],
    },
    { key: "q2", type: "boolean", title: "需要止损建议？" },
  ],
}

function makeBridge(overrides = {}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "wcob-form-test-"))
  const sent = []
  const replies = []
  const cancels = []
  const prompts = []
  const opencode = {
    session: {
      form: {
        reply: async (input) => { replies.push(input) },
        cancel: async (input) => { cancels.push(input) },
      },
      prompt: async (input) => {
        prompts.push(input)
        return { time: { created: Date.now() } }
      },
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
      sendText: async (input) => { sent.push(input) },
      startTyping: () => () => {},
      sendImage: async () => {},
      sendVideo: async () => {},
      sendFile: async () => {},
    },
  }
  const bridge = new WeChatOpenCodeBridge({
    runtime,
    opencode,
    stateDir,
    accountId: "test-account",
    log: () => {},
    replyTimeoutMs: 500,
    pollIntervalMs: 10,
    streaming: false,
    ...overrides,
  })
  return { bridge, sent, replies, cancels, prompts, stateDir }
}

// --- form.created ---

{
  const { bridge, sent } = makeBridge()
  bridge.sessionOwners.set("ses_test", "user1")
  await bridge.handleFormEvent({ type: "form.created", data: { form } })
  assert.equal(sent.length, 1)
  assert.match(sent[0].text, /❓ 需要你确认/)
  assert.match(sent[0].text, /后续风险与关注点/)
  assert.equal(sent[0].ilinkUserId, "user1")
  assert.equal(bridge.pendingForms.get("user1")[0].formID, "frm_test")
}

{
  const { bridge, sent } = makeBridge()
  await bridge.handleFormEvent({ type: "form.created", data: { form } })
  assert.equal(sent.length, 0)
  assert.equal(bridge.pendingForms.size, 0)
}

// --- waiter release while a form is pending ---

{
  const { bridge } = makeBridge()
  bridge.sessionOwners.set("ses_test", "user1")
  const endedRef = {}
  let ended = false
  bridge.registerWaiter("ses_test", { onDelta() {}, onEnd() { ended = true }, endedRef })
  await bridge.handleFormEvent({ type: "form.created", data: { form } })
  assert.equal(endedRef.formCreated, true)
  assert.equal(ended, true)

  const started = Date.now()
  const text = await bridge.waitForAssistantReply({
    sessionId: "ses_test", afterTime: 0, userId: "user1", endedRef,
  })
  assert.equal(text, "")
  assert.ok(Date.now() - started < 300, "提问期间不应等待超时")
}

// --- form.replied / form.cancelled ---

for (const type of ["form.replied", "form.cancelled"]) {
  const { bridge } = makeBridge()
  bridge.sessionOwners.set("ses_test", "user1")
  await bridge.handleFormEvent({ type: "form.created", data: { form } })
  assert.equal(bridge.pendingForms.get("user1").length, 1)
  await bridge.handleFormEvent({
    type,
    data: { id: "frm_test", sessionID: "ses_test" },
  })
  assert.equal(bridge.pendingForms.get("user1").length, 0)
}

// --- timeout cancels and notifies ---

{
  const { bridge, sent, cancels } = makeBridge({ formTimeoutMs: 20 })
  bridge.sessionOwners.set("ses_test", "user1")
  await bridge.handleFormEvent({ type: "form.created", data: { form } })
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.equal(cancels.length, 1)
  assert.equal(cancels[0].formID, "frm_test")
  assert.match(sent[sent.length - 1].text, /超时/)
  assert.equal(bridge.pendingForms.get("user1").length, 0)
}

// --- a WeChat reply answers the pending form instead of starting a new prompt ---

{
  const { bridge, replies, prompts, sent } = makeBridge()
  bridge.sessionMap.set("user1", "ses_test")
  bridge.sessionOwners.set("ses_test", "user1")
  bridge.pendingForms.set("user1", [{
    sessionID: "ses_test",
    formID: "frm_test",
    form,
    expiresAt: Date.now() + 60_000,
    timer: null,
  }])

  await bridge.processInbound({ userId: "user1", text: "A\n否", msg: { item_list: [] } })

  assert.equal(replies.length, 1)
  assert.equal(replies[0].sessionID, "ses_test")
  assert.equal(replies[0].formID, "frm_test")
  assert.deepEqual(replies[0].answer, { q1: "risk", q2: false })
  assert.equal(prompts.length, 0)
  assert.equal(bridge.pendingForms.get("user1").length, 0)
  assert.ok(sent.some((item) => item.text === "最终答复"))
}

// --- the WeChat rule is injected into ordinary prompts ---

{
  const { bridge, prompts } = makeBridge()
  bridge.sessionMap.set("user1", "ses_test")
  await bridge.processInbound({ userId: "user1", text: "继续", msg: { item_list: [] } })
  assert.equal(prompts.length, 1)
  assert.ok(prompts[0].text.startsWith(WECHAT_SESSION_RULE))
}

// --- reply selection: skip intermediate tool-call messages ---

function assistantMessage(created, text, finish) {
  return {
    type: "assistant",
    time: { created, completed: created + 1 },
    finish,
    content: [{ type: "text", text }],
  }
}

{
  const { bridge } = makeBridge()
  let stage = 0
  bridge.opencode.message.list = async () => ({
    data: stage === 0
      ? [assistantMessage(1, "我先看一下日志", "tool-calls")]
      : [assistantMessage(1, "我先看一下日志", "tool-calls"), assistantMessage(3, "最终答复", "stop")],
  })
  setTimeout(() => { stage = 1 }, 50)
  const text = await bridge.waitForAssistantReply({ sessionId: "ses_test", afterTime: 0, userId: "user1" })
  assert.equal(text, "最终答复")
}

{
  const { bridge } = makeBridge()
  bridge.opencode.message.list = async () => ({ data: [assistantMessage(1, "过渡语", "tool-calls")] })
  const text = await bridge.waitForAssistantReply({
    sessionId: "ses_test", afterTime: 0, userId: "user1", endedRef: { value: true },
  })
  assert.equal(text, "过渡语")
}

// --- processInbound always registers a waiter carrying endedRef ---

for (const streaming of [true, false]) {
  const { bridge } = makeBridge({ streaming })
  bridge.sessionMap.set("user1", "ses_test")
  let registered = null
  const original = bridge.registerWaiter.bind(bridge)
  bridge.registerWaiter = (sessionId, waiter) => {
    registered = waiter
    return original(sessionId, waiter)
  }
  await bridge.processInbound({ userId: "user1", text: "继续", msg: { item_list: [] } })
  assert.ok(registered, `streaming=${streaming} 应注册 waiter`)
  assert.ok(registered.endedRef, `streaming=${streaming} 的 waiter 应带 endedRef`)
}

// --- non-streaming mode sends one message for a long final answer ---

{
  const longAnswer = "这是一段较长的最终答复，需要完整送达微信。".repeat(12)
  const { bridge, sent } = makeBridge({ streaming: false })
  bridge.sessionMap.set("user1", "ses_test")
  bridge.opencode.message.list = async () => ({
    data: [{
      type: "assistant",
      time: { created: Date.now() + 100, completed: Date.now() + 200 },
      finish: "stop",
      content: [{ type: "text", text: longAnswer }],
    }],
  })
  await bridge.processInbound({ userId: "user1", text: "长问题", msg: { item_list: [] } })
  assert.equal(sent.length, 1)
  assert.equal(sent[0].text, longAnswer)
}

// --- finish() always returns the authoritative final answer as the terminal FINISH message ---

{
  const { bridge } = makeBridge({ streamMinChars: 2 })
  const flusher = bridge.createStreamFlusher({ userId: "user1", contextToken: "ctx" })
  flusher.onDelta("我先看一下日志\n最终答复")
  assert.equal(await flusher.finish("最终答复"), "最终答复")
}

// --- terminal sync starts and stops with the bridge ---

{
  const { bridge } = makeBridge({ pollIntervalMs: 5 })
  bridge.runtime.ilink.getUpdates = async () => ({ msgs: [] })
  bridge.opencode.message.list = async () => ({ data: [] })
  bridge.start()
  assert.ok(bridge.terminalSync, "bridge 应持有 terminalSync")
  assert.ok(bridge.terminalSync.timer, "start 后应启动轮询定时器")
  bridge.stop()
  assert.equal(bridge.stopped, true)
  assert.equal(bridge.terminalSync.timer, null, "stop 后应清除轮询定时器")
}
