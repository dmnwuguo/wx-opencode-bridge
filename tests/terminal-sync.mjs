// Terminal-origin messages are mirrored to WeChat without duplicating replies.
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"

import { TerminalSync, loadSyncState, saveSyncState } from "../src/terminal-sync.mjs"
import { WECHAT_SESSION_RULE } from "../src/form-relay.mjs"

const tmp = fs.mkdtempSync(path.join("/tmp/opencode", "wcob-ts-"))
const stateDir = path.join(tmp, "state")

// Missing state file starts empty.
assert.deepEqual(loadSyncState(stateDir), { sessions: {} })

// Corrupt state file must not break polling.
fs.mkdirSync(stateDir, { recursive: true })
fs.writeFileSync(path.join(stateDir, "terminal-sync-state.json"), "{not json", "utf8")
assert.deepEqual(loadSyncState(stateDir), { sessions: {} })

// State round-trips through disk.
const roundTrip = { sessions: { ses_a: { seen: ["m1", "m2"], initialized: true, pendingReply: false } } }
saveSyncState(stateDir, roundTrip)
assert.deepEqual(loadSyncState(stateDir), roundTrip)

// First poll only seeds history; it never back-fills WeChat.
const seedDir = path.join(tmp, "seed-state")
const sent = []
const history = [
  { id: "m1", type: "user", text: "旧消息1", time: { created: 1 } },
  { id: "m2", type: "user", text: "旧消息2", time: { created: 2 } },
]
const sync = new TerminalSync({
  opencode: { message: { list: async () => ({ data: history.slice().reverse() }) } },
  sessionOwners: new Map([["ses_seed", "user1"]]),
  contextTokenMap: new Map([["user1", "tok"]]),
  sendText: async (args) => { sent.push(args) },
  stateDir: seedDir,
  log: () => {},
  pollIntervalMs: 1000,
})
await sync.pollOnce()
assert.equal(sent.length, 0, "首次轮询不应转发历史消息")
const seeded = loadSyncState(seedDir)
assert.equal(seeded.sessions.ses_seed.initialized, true)
assert.deepEqual(seeded.sessions.ses_seed.seen, ["m1", "m2"])

function harness(dir) {
  let messages = []
  const sent = []
  const sync = new TerminalSync({
    opencode: { message: { list: async ({ limit }) => {
      assert.ok(limit <= 200, `OpenCode message.list limit 上限 200，收到 ${limit}`)
      return { data: messages.slice().reverse() }
    } } },
    sessionOwners: new Map([["ses_t", "user1"]]),
    contextTokenMap: new Map([["user1", "tok"]]),
    sendText: async (args) => { sent.push(args) },
    stateDir: dir,
    log: () => {},
    pollIntervalMs: 1000,
  })
  return {
    sync,
    sent,
    setMessages: (next) => { messages = next },
    state: () => loadSyncState(dir).sessions.ses_t,
  }
}

const seedUser = (id = "seed", text = "历史消息") => ({ id, type: "user", text, time: { created: 1 } })

// Terminal-origin user text is mirrored with a marker and arms reply forwarding.
{
  const h = harness(path.join(tmp, "t-user"))
  h.setMessages([seedUser()])
  await h.sync.pollOnce()
  h.setMessages([seedUser(), { id: "u1", type: "user", text: "帮我看下日志", time: { created: 2 } }])
  await h.sync.pollOnce()
  assert.equal(h.sent.length, 1)
  assert.equal(h.sent[0].text, "【终端】帮我看下日志")
  assert.equal(h.sent[0].ilinkUserId, "user1")
  assert.equal(h.sent[0].contextToken, "tok")
  assert.equal(h.state().pendingReply, true)
}

// Bridge-origin (WeChat) user text is never echoed back.
{
  const h = harness(path.join(tmp, "t-wechat"))
  h.setMessages([seedUser()])
  await h.sync.pollOnce()
  h.setMessages([seedUser(), { id: "w1", type: "user", text: WECHAT_SESSION_RULE, time: { created: 2 } }])
  await h.sync.pollOnce()
  assert.equal(h.sent.length, 0)
  assert.equal(h.state().pendingReply, false)
}

// Assistant reply to a WeChat message is already sent by processInbound.
{
  const h = harness(path.join(tmp, "t-wechat-reply"))
  h.setMessages([seedUser()])
  await h.sync.pollOnce()
  h.setMessages([seedUser(), {
    id: "a1", type: "assistant", finish: "stop", time: { created: 2 },
    content: [{ type: "text", text: "微信问题的回复" }],
  }])
  await h.sync.pollOnce()
  assert.equal(h.sent.length, 0)
  assert.equal(h.state().pendingReply, false)
}

// Terminal-origin assistant reply is mirrored once, then disarms.
{
  const h = harness(path.join(tmp, "t-reply"))
  h.setMessages([seedUser()])
  await h.sync.pollOnce()
  const term = seedUser("u1", "终端提问")
  h.setMessages([seedUser(), term])
  await h.sync.pollOnce()
  h.setMessages([seedUser(), term, {
    id: "a1", type: "assistant", finish: "stop", time: { created: 3 },
    content: [{ type: "text", text: "终端问题的回复" }, { type: "tool", name: "bash" }],
  }])
  await h.sync.pollOnce()
  assert.equal(h.sent.length, 2)
  assert.equal(h.sent[1].text, "【终端回复】终端问题的回复")
  assert.equal(h.state().pendingReply, false)
}

// Interim tool-calls narration is not a standalone WeChat bubble.
{
  const h = harness(path.join(tmp, "t-toolcalls"))
  h.setMessages([seedUser()])
  await h.sync.pollOnce()
  const term = seedUser("u1", "终端提问")
  h.setMessages([seedUser(), term])
  await h.sync.pollOnce()
  const interim = { id: "a0", type: "assistant", finish: "tool-calls", time: { created: 3 }, content: [{ type: "text", text: "我先查一下" }] }
  h.setMessages([seedUser(), term, interim])
  await h.sync.pollOnce()
  assert.equal(h.sent.length, 1)
  assert.equal(h.state().pendingReply, true)
  h.setMessages([seedUser(), term, interim, {
    id: "a1", type: "assistant", finish: "stop", time: { created: 4 },
    content: [{ type: "text", text: "查完了" }],
  }])
  await h.sync.pollOnce()
  assert.equal(h.sent.length, 2)
  assert.equal(h.sent[1].text, "【终端回复】查完了")
}

// Polling the same batch twice never sends the same message twice.
{
  const h = harness(path.join(tmp, "t-dedup"))
  h.setMessages([seedUser()])
  await h.sync.pollOnce()
  h.setMessages([seedUser(), seedUser("u1", "只发一次")])
  await h.sync.pollOnce()
  await h.sync.pollOnce()
  assert.equal(h.sent.length, 1)
}

// A restarted poller seeds existing messages instead of replaying them.
{
  const dir = path.join(tmp, "t-restart")
  const messages = [seedUser("seed", "历史消息")]
  const sent = []
  const make = () => new TerminalSync({
    opencode: { message: { list: async ({ limit }) => {
      assert.ok(limit <= 200, `OpenCode message.list limit 上限 200，收到 ${limit}`)
      return { data: messages.slice().reverse() }
    } } },
    sessionOwners: new Map([["ses_t", "user1"]]),
    contextTokenMap: new Map([["user1", "tok"]]),
    sendText: async (args) => { sent.push(args) },
    stateDir: dir,
    log: () => {},
    pollIntervalMs: 1000,
  })
  const first = make()
  await first.pollOnce()
  messages.push(seedUser("u1", "终端消息"))
  await first.pollOnce()
  assert.equal(sent.length, 1)
  first.stop()
  const restarted = make()
  await restarted.pollOnce()
  assert.equal(sent.length, 1, "重启后不得重发历史消息")
}

// An unfinished assistant message must not consume the pending reply.
{
  const h = harness(path.join(tmp, "t-partial"))
  h.setMessages([seedUser()])
  await h.sync.pollOnce()
  const term = seedUser("u1", "终端提问")
  h.setMessages([seedUser(), term])
  await h.sync.pollOnce()
  const partial = { id: "a1", type: "assistant", time: { created: 3 }, content: [{ type: "text", text: "生成到一半" }] }
  h.setMessages([seedUser(), term, partial])
  await h.sync.pollOnce()
  assert.equal(h.sent.length, 1, "未完成的回复不应转发")
  assert.equal(h.state().pendingReply, true)
  h.setMessages([seedUser(), term, { ...partial, finish: "stop", content: [{ type: "text", text: "完整答复" }] }])
  await h.sync.pollOnce()
  assert.equal(h.sent.length, 2)
  assert.equal(h.sent[1].text, "【终端回复】完整答复")
}

// Malformed-but-parseable state is repaired instead of wedging every poll.
{
  const dir = path.join(tmp, "t-malformed")
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "terminal-sync-state.json"), JSON.stringify({
    sessions: { ses_t: { seen: ["seed", 42], initialized: true, pendingReply: "bad" } },
  }))
  const h = harness(dir)
  h.setMessages([seedUser(), seedUser("u1", "终端消息")])
  await h.sync.pollOnce()
  assert.equal(h.sent.length, 1)
}

// Long terminal replies are chunked to the iLink size limit.
{
  const h = harness(path.join(tmp, "t-long"))
  h.setMessages([seedUser()])
  await h.sync.pollOnce()
  const term = seedUser("u1", "提问")
  h.setMessages([seedUser(), term])
  await h.sync.pollOnce()
  const body = "长".repeat(4500)
  h.setMessages([seedUser(), term, {
    id: "a1", type: "assistant", finish: "stop", time: { created: 3 },
    content: [{ type: "text", text: body }],
  }])
  await h.sync.pollOnce()
  assert.equal(h.sent.length, 3)
  const joined = h.sent.slice(1).map((s) => s.text).join("")
  assert.equal(joined, `【终端回复】${body}`)
  assert.ok(h.sent.every((s) => s.text.length <= 4000), "每块不得超过 4000 字")
}

// A burst larger than the old 20-message window is still fully forwarded.
{
  const h = harness(path.join(tmp, "t-burst"))
  const old = Array.from({ length: 25 }, (_, i) => seedUser(`s${i}`, `旧${i}`))
  const fresh = Array.from({ length: 25 }, (_, i) => seedUser(`u${i}`, `新${i}`))
  h.setMessages(old)
  await h.sync.pollOnce()
  h.setMessages([...old, ...fresh])
  await h.sync.pollOnce()
  assert.equal(h.sent.length, 25, " bursts 不应因 20 条窗口丢失")
}

// Empty terminal text does not produce a bare marker bubble.
{
  const h = harness(path.join(tmp, "t-empty"))
  h.setMessages([seedUser()])
  await h.sync.pollOnce()
  h.setMessages([seedUser(), seedUser("u1", "")])
  await h.sync.pollOnce()
  assert.equal(h.sent.length, 0)
}

// pendingReply is tracked independently per session.
{
  const dir = path.join(tmp, "t-multi")
  const sent = []
  const a = [seedUser("sa", "旧A")]
  const b = [seedUser("sb", "旧B")]
  const sync = new TerminalSync({
    opencode: { message: { list: async ({ sessionID }) => ({ data: (sessionID === "ses_a" ? a : b).slice().reverse() }) } },
    sessionOwners: new Map([["ses_a", "u1"], ["ses_b", "u2"]]),
    contextTokenMap: new Map([["u1", "t1"], ["u2", "t2"]]),
    sendText: async (args) => { sent.push(args) },
    stateDir: dir,
    log: () => {},
    pollIntervalMs: 1000,
  })
  await sync.pollOnce()
  a.push(seedUser("ua", "终端A"))
  b.push({ id: "ab", type: "assistant", finish: "stop", time: { created: 2 }, content: [{ type: "text", text: "微信B的回复" }] })
  await sync.pollOnce()
  assert.equal(sent.length, 1)
  assert.equal(sent[0].text, "【终端】终端A")
  const state = loadSyncState(dir).sessions
  assert.equal(state.ses_a.pendingReply, true)
  assert.equal(state.ses_b.pendingReply, false)
}
