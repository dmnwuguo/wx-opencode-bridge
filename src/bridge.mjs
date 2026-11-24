// WeChat <-> OpenCode bridge.
//
// Flow per inbound WeChat message:
//   iLink getUpdates (long poll) -> dedup -> per-user serial queue ->
//     [slash command?] -> download inbound media -> OpenCode session.prompt ->
//     SSE session.text.delta -> throttled streaming replies to WeChat ->
//     polling message.list?type=assistant as the authoritative completion signal ->
//     send final remainder + any generated media back via iLink sendMessage.
//
// Reference implementations:
//   - @tencent-weixin/openclaw-weixin: monitor/inbound/cdn/messaging
//   - wechat-claude-code: queue, typing keepalive, rate limiting, chunking
//   - @opencode/client V2: event.subscribe, session.*, message.*

import fs from "node:fs"
import path from "node:path"

import * as ilink from "./ilink/client.mjs"
import { StaleSessionError } from "./ilink/sender.mjs"
import { loadGetUpdatesBuf, saveGetUpdatesBuf } from "./ilink/accounts.mjs"
import { extractTextFromItems, MessageState } from "./ilink/client.mjs"
import {
  downloadInboundMedia,
  findMediaPathsInText,
  mediaTypeFromFile,
  uploadLocalFile,
} from "./ilink/media.mjs"
import { routeCommand } from "./commands.mjs"
import { formatFormMessage, parseFormAnswer, WECHAT_SESSION_RULE } from "./form-relay.mjs"
import { TerminalSync } from "./terminal-sync.mjs"

const MAX_MESSAGE_LENGTH = 4000
const REPLY_POLL_INTERVAL_MS = 2000
const REPLY_TIMEOUT_MS = 10 * 60_000
const FORM_TIMEOUT_MS = 10 * 60_000
const MAX_RECENT_MSG_IDS = 1000
const STREAM_EVENT_TYPES = [
  "session.text.delta",
  "session.text.ended",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.idle",
  "form.created",
  "form.replied",
  "form.cancelled",
]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Longest suffix of `flushed` that is also a prefix of `finalText`. */
function streamedPrefixOverlap(flushed, finalText) {
  const max = Math.min(flushed.length, finalText.length - 1)
  if (max < 1) return 0
  const min = Math.max(1, Math.min(12, Math.floor(finalText.length / 2)))
  for (let k = max; k >= min; k--) {
    if (flushed.slice(-k) === finalText.slice(0, k)) return k
  }
  return 0
}
const unwrap = (x) => (x && typeof x === "object" && "data" in x ? x.data : x)

export function sessionTitle(userId) {
  return `wechat-${userId}`
}

function sessionMapPath(stateDir) {
  return path.join(stateDir, "opencode-sessions.json")
}

function loadSessionMap(stateDir) {
  try {
    const file = sessionMapPath(stateDir)
    if (fs.existsSync(file)) return new Map(Object.entries(JSON.parse(fs.readFileSync(file, "utf-8"))))
  } catch {}
  return new Map()
}

function saveSessionMap(stateDir, map) {
  try {
    const file = sessionMapPath(stateDir)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(Object.fromEntries(map), null, 2))
  } catch {}
}

function contextTokensPath(stateDir) {
  return path.join(stateDir, "context-tokens.json")
}

export function loadContextTokens(stateDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(contextTokensPath(stateDir), "utf8"))
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return new Map(Object.entries(parsed).filter(([, v]) => typeof v === "string" && v))
    }
  } catch {}
  return new Map()
}

export function saveContextTokens(stateDir, map) {
  try {
    const file = contextTokensPath(stateDir)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(Object.fromEntries(map), null, 2))
  } catch {}
}

export function extractAssistantText(message) {
  const texts = (message.content ?? [])
    .filter((c) => c?.type === "text")
    .map((c) => c.text)
  return texts.join("\n").trim()
}

export class WeChatOpenCodeBridge {
  constructor({
    runtime,
    opencode,
    stateDir,
    accountId,
    log = (...args) => console.log(...args),
    replyTimeoutMs = REPLY_TIMEOUT_MS,
    pollIntervalMs = 2000,
    streaming = true,
    streamFlushMs = 3000,
    streamMinChars = 120,
    cdnBaseUrl = ilink.CDN_BASE_URL,
    formTimeoutMs = FORM_TIMEOUT_MS,
  }) {
    // runtime: { ilink, sender }
    this.runtime = runtime
    this.opencode = opencode
    this.stateDir = stateDir
    this.accountId = accountId
    this.log = log
    this.replyTimeoutMs = replyTimeoutMs
    this.pollIntervalMs = pollIntervalMs
    this.streaming = streaming
    this.streamFlushMs = streamFlushMs
    this.streamMinChars = streamMinChars
    this.cdnBaseUrl = cdnBaseUrl
    this.formTimeoutMs = formTimeoutMs
    this.startedAt = Date.now()
    this.streamFlushCount = 0

    this.sessionMap = loadSessionMap(stateDir)
    saveSessionMap(stateDir, this.sessionMap)
    this.contextTokenMap = loadContextTokens(stateDir)
    this.sessionOwners = new Map() // sessionID -> userId
    for (const [userId, sessionID] of this.sessionMap) this.sessionOwners.set(sessionID, userId)
    this.pendingForms = new Map() // userId -> [{ sessionID, formID, form, expiresAt, timer }]
    this.recentMsgIds = new Set()
    this.queue = new Map()
    this.streamWaiters = new Map() // sessionID -> { onDelta, onEnd }
    this.eventController = null
    this.stopped = false
    this.monitorPromise = null
    this.eventPromise = null
    this.eventReadyPromise = null
    this.eventReadyResolve = null

    this.terminalSync = new TerminalSync({
      opencode: this.opencode,
      sessionOwners: this.sessionOwners,
      contextTokenMap: this.contextTokenMap,
      sendText: async (args) => {
        try {
          await this.runtime.sender.sendText(args)
        } catch (err) {
          if (err instanceof StaleSessionError) {
            // Drop the token so polling pauses until a fresh WeChat message
            // refreshes it, instead of driving the shared sender's long pause.
            this.contextTokenMap.delete(args.ilinkUserId)
            saveContextTokens(this.stateDir, this.contextTokenMap)
          }
          throw err
        }
      },
      stateDir: this.stateDir,
      log: this.log,
      pollIntervalMs: this.pollIntervalMs,
    })
  }

  start() {
    if (this.monitorPromise) throw new Error("bridge already started")
    this.monitorPromise = this.monitorLoop()
    this.monitorPromise.catch((err) => this.log("monitor error:", err))
    if (this.streaming) {
      this.eventReadyPromise = new Promise((resolve) => { this.eventReadyResolve = resolve })
      this.eventPromise = this.eventStreamLoop()
      this.eventPromise.catch((err) => this.log("event stream error:", err))
    }
    this.terminalSync.start()
    return this.monitorPromise
  }

  stop() {
    this.stopped = true
    this.eventController?.abort()
    this.terminalSync.stop()
  }

  // -------------------------------------------------------------------------
  // iLink monitor loop
  // -------------------------------------------------------------------------

  async monitorLoop() {
    const buf = loadGetUpdatesBuf(this.stateDir, this.accountId)
    let getUpdatesBuf = buf || ""
    if (buf) this.log(`[bridge] resuming from previous sync buf (${buf.length} bytes)`)

    while (!this.stopped) {
      try {
        const resp = await this.runtime.ilink.getUpdates({ getUpdatesBuf })
        if (resp.longpolling_timeout_ms) this.longPollTimeout = resp.longpolling_timeout_ms
        if (resp.errcode === -14 || resp.ret === -14) {
          this.log("[bridge] token stale (errcode -14); pausing 30s")
          await sleep(30_000)
          continue
        }
        if (resp.get_updates_buf) {
          saveGetUpdatesBuf(this.stateDir, this.accountId, resp.get_updates_buf)
          getUpdatesBuf = resp.get_updates_buf
        }
        for (const msg of resp.msgs ?? []) {
          if (this.recentMsgIds.has(msg.message_id)) continue
          if (msg.message_id) {
            this.recentMsgIds.add(msg.message_id)
            if (this.recentMsgIds.size > MAX_RECENT_MSG_IDS) {
              for (const id of [...this.recentMsgIds].slice(0, MAX_RECENT_MSG_IDS / 2)) this.recentMsgIds.delete(id)
            }
          }
          this.onInbound(msg)
        }
      } catch (err) {
        if (this.stopped) break
        this.log("[bridge] getUpdates error:", err instanceof Error ? err.message : String(err))
        await sleep(2000)
      }
    }
    this.log("[bridge] monitor stopped")
  }

  onInbound(msg) {
    if (msg.message_type !== ilink.MessageType.USER) return
    const text = extractTextFromItems(msg.item_list)
    const hasMedia = (msg.item_list ?? []).some((i) =>
      [ilink.MessageItemType.IMAGE, ilink.MessageItemType.FILE, ilink.MessageItemType.VIDEO, ilink.MessageItemType.VOICE].includes(i.type),
    )
    if (!text && !hasMedia) return
    const userId = msg.from_user_id
    if (!userId) return
    if (msg.context_token) {
      this.contextTokenMap.set(userId, msg.context_token)
      saveContextTokens(this.stateDir, this.contextTokenMap)
    }
    // Cache inbound text so a later quote of the user's own message resolves.
    this.runtime.sender.recordMessageText?.(msg.message_id, extractTextFromItems(msg.item_list))
    this.log(`[bridge] inbound: user=${userId} text=${JSON.stringify(text.slice(0, 60))}${hasMedia ? " [media]" : ""}`)

    const prev = this.queue.get(userId) ?? Promise.resolve()
    const next = prev.catch(() => {}).then(() => this.processInbound({ userId, text, msg }))
    this.queue.set(userId, next.catch(() => {}))
    next.finally(() => {
      if (this.queue.get(userId) === next) this.queue.delete(userId)
    })
  }

  // -------------------------------------------------------------------------
  // SSE event stream (streaming replies)
  // -------------------------------------------------------------------------

  async eventStreamLoop() {
    while (!this.stopped) {
      const controller = new AbortController()
      this.eventController = controller
      try {
        for await (const ev of this.opencode.event.subscribe({ types: STREAM_EVENT_TYPES }, { signal: controller.signal })) {
          if (this.stopped) break
          if (ev.type === "server.connected") {
            this.eventReadyResolve?.()
            continue
          }
          if (ev.type === "form.created" || ev.type === "form.replied" || ev.type === "form.cancelled") {
            await this.handleFormEvent(ev)
            continue
          }
          const sid = ev.data?.sessionID
          if (!sid) continue
          const waiter = this.streamWaiters.get(sid)
          if (!waiter) continue
          if (ev.type === "session.text.delta" && typeof ev.data.delta === "string") {
            waiter.onDelta(ev.data.delta)
          } else if (ev.type === "session.text.ended") {
            // One text block ended; the turn may still be calling tools.
            waiter.onTextEnd?.(ev)
          } else if (["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted", "session.idle"].includes(ev.type)) {
            waiter.onEnd?.(ev)
          }
        }
      } catch (err) {
        if (!this.stopped) this.log("[bridge] event stream error:", err instanceof Error ? err.message : String(err))
      } finally {
        if (this.eventController === controller) this.eventController = null
      }
      if (!this.stopped) await sleep(2000)
    }
    this.log("[bridge] event stream stopped")
  }

  async waitForEventStreamReady(timeoutMs = 2000) {
    if (!this.eventReadyPromise) return
    await Promise.race([
      this.eventReadyPromise,
      sleep(timeoutMs),
    ])
  }

  registerWaiter(sessionId, waiter) {
    this.streamWaiters.set(sessionId, waiter)
    return () => {
      if (this.streamWaiters.get(sessionId) === waiter) this.streamWaiters.delete(sessionId)
    }
  }

  // -------------------------------------------------------------------------
  // OpenCode form events (question tool) -> WeChat
  // -------------------------------------------------------------------------

  async handleFormEvent(ev) {
    if (ev.type === "form.created") {
      const form = ev.data?.form
      const sessionID = form?.sessionID
      if (!form?.id || !sessionID) return
      const userId = this.sessionOwners.get(sessionID)
      if (!userId) {
        this.log(`[bridge] form.created for untracked session ${sessionID}; ignored`)
        return
      }
      const waiter = this.streamWaiters.get(sessionID)
      if (waiter) {
        if (waiter.endedRef) waiter.endedRef.formCreated = true
        waiter.onEnd?.(ev)
      }
      await this.relayFormToWeChat(userId, sessionID, form)
      return
    }

    // form.replied / form.cancelled use ev.data.{id,sessionID} (not ev.data.form).
    const sessionID = ev.data?.sessionID
    const formID = ev.data?.id
    if (!sessionID || !formID) return
    const userId = this.sessionOwners.get(sessionID)
    if (userId) this.clearPendingForm(userId, formID)
  }

  async relayFormToWeChat(userId, sessionID, form) {
    const contextToken = this.contextTokenMap.get(userId)
    const entry = {
      sessionID,
      formID: form.id,
      form,
      expiresAt: Date.now() + this.formTimeoutMs,
      timer: null,
    }
    entry.timer = setTimeout(async () => {
      const current = this.pendingForms.get(userId) ?? []
      if (!current.includes(entry)) return
      this.clearPendingForm(userId, form.id)
      try {
        await this.opencode.session.form.cancel({
          sessionID,
          formID: form.id,
          message: "微信端超时未回复，已自动取消",
        })
      } catch (err) {
        this.log(`[bridge] failed to cancel timed-out form ${form.id}:`, err instanceof Error ? err.message : String(err))
      }
      try {
        await this.runtime.sender.sendText({
          ilinkUserId: userId,
          contextToken,
          text: "⏰ 等待回复超时，这次提问已取消。你可以重新说明需求。",
        })
      } catch (err) {
        this.log(`[bridge] failed to notify form timeout for ${userId}:`, err instanceof Error ? err.message : String(err))
      }
    }, this.formTimeoutMs)
    entry.timer.unref?.()

    const list = this.pendingForms.get(userId) ?? []
    list.push(entry)
    this.pendingForms.set(userId, list)
    this.log(`[bridge] form.created ${form.id} relayed to ${userId}`)
    await this.runtime.sender.sendText({
      ilinkUserId: userId,
      contextToken,
      text: formatFormMessage(form),
    })
  }

  clearPendingForm(userId, formID) {
    const list = this.pendingForms.get(userId) ?? []
    for (const entry of list) {
      if (entry.formID === formID) clearTimeout(entry.timer)
    }
    this.pendingForms.set(userId, list.filter((entry) => entry.formID !== formID))
  }

  /** Accumulates SSE text deltas and sends throttled GENERATING chunks to WeChat. */
  createStreamFlusher({ userId, contextToken, endedRef = {} }) {
    let pending = ""
    let flushed = ""
    let timer = null
    let chain = Promise.resolve()

    const flushIfNeeded = () => {
      // Reserve a tail so finish() always has a final (FINISH) message to send.
      const reserve = this.streamMinChars
      if (pending.length < this.streamMinChars + reserve) return
      const region = pending.slice(0, pending.length - reserve)
      // Prefer a sentence boundary in the latter half of the flushable region.
      let end = region.length
      for (let i = region.length - 1; i >= 0; i--) {
        if (/[。！？；\n.!?;]/.test(region[i])) {
          if (i >= region.length / 2) end = i + 1
          break
        }
      }
      const chunk = pending.slice(0, end)
      pending = pending.slice(end)
      flushed += chunk
      this.streamFlushCount++
      chain = chain.catch(() => {}).then(() =>
        this.runtime.sender.sendText({ ilinkUserId: userId, contextToken, text: chunk, state: MessageState.GENERATING }),
      ).catch((err) => this.log(`[bridge] stream flush failed for ${userId}:`, err instanceof Error ? err.message : String(err)))
    }

    timer = setInterval(flushIfNeeded, this.streamFlushMs)
    timer.unref?.()

    return {
      onDelta: (delta) => { pending += delta; flushIfNeeded() },
      onEnd: () => { endedRef.value = true },
      /** Returns the part of the final answer that has not been streamed yet. */
      finish: async (finalText) => {
        clearInterval(timer)
        await chain
        if (!finalText) return ""
        if (!flushed) return finalText
        // Streaming may have covered narration plus a prefix of the final answer;
        // skip exactly that prefix so the FINISH message carries only the tail.
        return finalText.slice(streamedPrefixOverlap(flushed, finalText))
      },
    }
  }

  // -------------------------------------------------------------------------
  // Message processing
  // -------------------------------------------------------------------------

  /** Send a WeChat reply back as the answer to a pending OpenCode form. */
  async answerPendingForm({ userId, contextToken, entry, answer }) {
    this.clearPendingForm(userId, entry.formID)
    const endedRef = {}
    const flusher = this.streaming
      ? this.createStreamFlusher({ userId, contextToken, endedRef })
      : null
    const unregister = flusher
      ? this.registerWaiter(entry.sessionID, { ...flusher, endedRef })
      : () => {}
    try {
      if (this.streaming) await this.waitForEventStreamReady()
      this.log(`[bridge] replying to form ${entry.formID} for ${userId}`)
      await this.opencode.session.form.reply({
        sessionID: entry.sessionID,
        formID: entry.formID,
        answer,
      })
      const followedUp = await this.waitForAssistantReply({
        sessionId: entry.sessionID,
        afterTime: Date.now(),
        userId,
        endedRef,
      })
      const remainder = flusher ? await flusher.finish(followedUp) : followedUp
      if (remainder?.trim()) await this.sendReply(userId, contextToken, remainder.trim())
      for (const filePath of findMediaPathsInText(followedUp ?? "")) {
        try {
          await this.sendLocalFile(userId, contextToken, filePath)
        } catch (err) {
          this.log(`[bridge] failed to send media ${filePath}:`, err instanceof Error ? err.message : String(err))
        }
      }
    } finally {
      unregister()
    }
  }

  async processInbound({ userId, text, msg }) {
    const contextToken = this.contextTokenMap.get(userId)
    const stopTyping = this.runtime.sender.startTyping({ ilinkUserId: userId, contextToken })

    let reply = ""
    let streamFlusher = null
    try {
      // 0) If a form is pending, this message is the user's answer — not a new prompt.
      const pending = (this.pendingForms.get(userId) ?? [])[0]
      if (pending) {
        await this.answerPendingForm({
          userId,
          contextToken,
          entry: pending,
          answer: parseFormAnswer(pending.form, text || ""),
        })
        return
      }

      // 1) Slash commands bypass OpenCode.
      if ((text ?? "").startsWith("/")) {
        const result = await routeCommand({ text, ctx: this.commandContext(userId, contextToken), log: this.log })
        if (result.handled) {
          if (result.reply) await this.sendReply(userId, contextToken, result.reply)
          if (result.sendFilePath) await this.sendLocalFile(userId, contextToken, result.sendFilePath)
          return
        }
      }

      // 2) Download inbound media (images / files / video / voice) from CDN.
      const media = await downloadInboundMedia({
        items: msg.item_list,
        stateDir: this.stateDir,
        cdnBaseUrl: this.cdnBaseUrl,
        log: this.log,
      })
      const files = media.map((m) => ({
        uri: m.mime.startsWith("image/") ? `data:${m.mime};base64,${fs.readFileSync(m.path).toString("base64")}` : m.path,
        source: m.mime.startsWith("image/") ? { type: "inline" } : { type: "uri", uri: m.path },
        name: m.name,
        description: m.kind === "voice" ? `微信语音转写: ${m.text ?? ""}` : `微信${m.kind}附件`,
      }))
      let promptText = text || ""
      if (!promptText && files.length) promptText = "请查看我发送的附件并给出回应。"
      if (files.length && promptText) promptText += `\n（已附上 ${files.length} 个微信媒体文件）`
      // Quoted messages arrive as msg_id only; resolve their text from the cache.
      const quotedTexts = []
      for (const item of msg.item_list ?? []) {
        const refId = item.ref_msg?.message_item?.msg_id
        if (!refId) continue
        const quotedText = this.runtime.sender.getSentText?.(refId)
        if (quotedText && !quotedTexts.includes(quotedText)) quotedTexts.push(quotedText)
      }
      if (quotedTexts.length) {
        const block = quotedTexts.map((quotedText) => `（引用消息：${quotedText}）`).join("\n")
        promptText = `${block}\n\n${promptText}`
      }
      promptText = `${WECHAT_SESSION_RULE}\n\n${promptText}`

      // 3) OpenCode session + prompt, with SSE streaming and polling fallback.
      const sessionId = await this.getSessionIdFor(userId)
      const endedRef = {}
      streamFlusher = this.streaming ? this.createStreamFlusher({ userId, contextToken, endedRef }) : null
      // Always register a waiter: form.created needs it to release the wait,
      // even when streaming is disabled.
      const waiter = streamFlusher
        ? { ...streamFlusher, endedRef }
        : { onEnd: () => { endedRef.value = true }, endedRef }
      const unregister = this.registerWaiter(sessionId, waiter)
      try {
        if (this.streaming) await this.waitForEventStreamReady()
        const promptResult = await this.opencode.session.prompt({
          sessionID: sessionId,
          text: promptText,
          ...(files.length ? { files } : {}),
        })
        reply = await this.waitForAssistantReply({
          sessionId,
          afterTime: promptResult?.time?.created ?? Date.now(),
          userId,
          endedRef,
        })
      } finally {
        unregister()
      }
    } catch (err) {
      this.log(`[bridge] error processing ${userId}:`, err instanceof Error ? err.message : String(err))
      reply = `处理请求时出错: ${err instanceof Error ? err.message : String(err)}`
    } finally {
      stopTyping?.()
    }

    // 4) Send the final (not-yet-streamed) text.
    const remainder = streamFlusher ? await streamFlusher.finish(reply) : reply
    if (remainder?.trim()) await this.sendReply(userId, contextToken, remainder.trim())

    // 5) If the answer mentions local files, send them back as WeChat media.
    if (reply) {
      for (const filePath of findMediaPathsInText(reply)) {
        try {
          await this.sendLocalFile(userId, contextToken, filePath)
        } catch (err) {
          this.log(`[bridge] failed to send media ${filePath}:`, err instanceof Error ? err.message : String(err))
        }
      }
    }
  }

  async sendReply(userId, contextToken, text) {
    const chunks = text.length > MAX_MESSAGE_LENGTH ? splitChunks(text) : [text]
    for (const chunk of chunks) {
      await this.runtime.sender.sendText({ ilinkUserId: userId, contextToken, text: chunk })
    }
  }

  async sendLocalFile(userId, contextToken, filePath) {
    const resolved = path.resolve(filePath)
    if (!fs.existsSync(resolved)) throw new Error(`文件不存在: ${filePath}`)
    const mediaType = mediaTypeFromFile(resolved)
    const uploaded = await uploadLocalFile({
      client: this.runtime.ilink,
      filePath: resolved,
      toUserId: userId,
      mediaType,
      cdnBaseUrl: this.cdnBaseUrl,
    })
    const caption = `📎 ${path.basename(resolved)}`
    const opts = { ilinkUserId: userId, contextToken, uploaded, caption }
    if (mediaType === ilink.UploadMediaType.IMAGE) return this.runtime.sender.sendImage(opts)
    if (mediaType === ilink.UploadMediaType.VIDEO) return this.runtime.sender.sendVideo(opts)
    return this.runtime.sender.sendFile(opts)
  }

  async getSessionIdFor(userId) {
    if (this.sessionMap.has(userId)) {
      const existingId = this.sessionMap.get(userId)
      this.sessionOwners.set(existingId, userId)
      return existingId
    }
    const { data: sessions } = await this.opencode.session.list({ limit: 100 })
    const wanted = sessionTitle(userId)
    const existing = sessions?.find((s) => s.title === wanted)
    const id = existing?.id ?? unwrap(await this.opencode.session.create({ title: wanted })).id
    this.sessionMap.set(userId, id)
    this.sessionOwners.set(id, userId)
    saveSessionMap(this.stateDir, this.sessionMap)
    return id
  }

  async waitForAssistantReply({ sessionId, afterTime, userId, endedRef = {} }) {
    // A form was created: the session is suspended waiting for the user's
    // answer, so no assistant message will arrive for this turn.
    if (endedRef.formCreated) {
      this.log(`[bridge] form pending for ${sessionId}; stopping reply wait`)
      return ""
    }
    const deadline = Date.now() + this.replyTimeoutMs
    const latestDone = async () => {
      const { data } = await this.opencode.message.list({ sessionID: sessionId, type: "assistant" })
      return (data ?? [])
        .filter((m) => m.type === "assistant" && (m.time?.created ?? 0) > afterTime && (m.time?.completed != null || m.finish != null))
        .sort((a, b) => (b.time?.created ?? 0) - (a.time?.created ?? 0))
    }
    // `tool-calls` steps are intermediate narration before more tools run;
    // only a terminal finish ("stop"/"length"/...) carries the user-facing answer.
    const finalAnswer = (messages) => messages.find((m) =>
      m.finish != null && m.finish !== "tool-calls" && extractAssistantText(m))
    while (Date.now() < deadline) {
      if (this.stopped) return null
      const done = await latestDone()
      const final = finalAnswer(done)
      if (final) return extractAssistantText(final)
      // SSE signals execution end before message.list is guaranteed to be consistent;
      // give storage a brief moment, then do one authoritative final read.
      if (endedRef.value) {
        await sleep(400)
        const last = await latestDone()
        const settled = finalAnswer(last)
        if (settled) return extractAssistantText(settled)
        // Turn is over with no terminal text (e.g. error/abort): keep the last
        // text we have rather than silently dropping it.
        const fallback = last.find((m) => extractAssistantText(m))
        return fallback ? extractAssistantText(fallback) : ""
      }
      await sleep(this.pollIntervalMs)
    }
    this.log(`[bridge] timeout waiting for reply from opencode (user=${userId})`)
    return null
  }

  // -------------------------------------------------------------------------
  // Command context
  // -------------------------------------------------------------------------

  commandContext(userId, contextToken) {
    const bridge = this
    const getSession = async () => bridge.getSessionIdFor(userId)
    return {
      accountId: bridge.accountId,
      userId,
      async newSession(title) {
        const wanted = title ? `${sessionTitle(userId)}-${title.replace(/\s+/g, "-").slice(0, 24)}` : sessionTitle(userId)
        const { id } = unwrap(await bridge.opencode.session.create({ title: wanted }))
        bridge.sessionMap.set(userId, id)
        bridge.sessionOwners.set(id, userId)
        saveSessionMap(bridge.stateDir, bridge.sessionMap)
        return `✅ 已新建会话 ${id}${title ? `（${title}）` : ""}`
      },
      async statusText() {
        const sessionID = await getSession()
        const info = unwrap(await bridge.opencode.session.get({ sessionID })) ?? {}
        const model = info.model ? `${info.model.providerID}/${info.model.id}` : "默认"
        const mins = Math.floor((Date.now() - bridge.startedAt) / 60_000)
        return `连接: 微信 ${bridge.accountId} ↔ OpenCode ✅
会话: ${sessionID}
模型: ${model}
队列: ${bridge.queue.get(userId) ? "处理中" : "空闲"}
运行时间: ${mins} 分钟
流式回复: ${bridge.streaming ? "开启" : "关闭"}`
      },
      async listModels() {
        const { data } = await bridge.opencode.model.list()
        const models = (data ?? []).map((m) => `${m.providerID}/${m.id}`)
        return `可用模型（前 20 个）:\n${models.slice(0, 20).join("\n") || "(无)"}`
      },
      async switchModel(name) {
        const sessionID = await getSession()
        let providerID, id
        if (name.includes("/")) [providerID, id] = name.split("/", 2)
        else {
          const { data } = await bridge.opencode.model.list()
          const found = (data ?? []).find((m) => m.id === name)
          if (!found) return `未找到模型 ${name}，请用 /model 查看列表。`
          ;({ providerID, id } = found)
        }
        await bridge.opencode.session.switchModel({ sessionID, model: { providerID, id } })
        return `✅ 已切换模型为 ${providerID}/${id}`
      },
      async history(n = 5) {
        const sessionID = await getSession()
        const { data } = await bridge.opencode.message.list({ sessionID, limit: n, order: "desc" })
        const lines = (data ?? []).slice().reverse().map((m) => {
          const who = m.type === "user" ? "我" : m.type === "assistant" ? "OpenCode" : m.type
          const body = m.type === "user" ? m.text : extractAssistantText(m)
          return `${who}: ${body.slice(0, 120).replace(/\n/g, " ")}`
        })
        return `最近 ${lines.length} 条:\n${lines.join("\n") || "(无)"}`
      },
      async compact() {
        const sessionID = await getSession()
        await bridge.opencode.session.compact({ sessionID })
        return "✅ 已提交上下文压缩请求"
      },
      async revert() {
        const sessionID = await getSession()
        const { data } = await bridge.opencode.message.list({ sessionID, type: "assistant", limit: 1, order: "desc" })
        const last = data?.[0]
        if (!last) return "没有可撤销的助手消息。"
        await bridge.opencode.session.revert.stage({ sessionID, messageID: last.id, files: true })
        await bridge.opencode.session.revert.commit({ sessionID })
        return "✅ 已撤销上一步（含文件改动）"
      },
      async cwd() {
        const info = unwrap(await bridge.opencode.session.get({ sessionID: await getSession() })) ?? {}
        return info.location?.directory ?? process.cwd()
      },
    }
  }
}

export function splitChunks(text, maxLen = MAX_MESSAGE_LENGTH) {
  if (text.length <= maxLen) return text
  const chunks = []
  let i = 0
  while (i < text.length) {
    const end = Math.min(i + maxLen, text.length)
    chunks.push(text.slice(i, end))
    i = end
  }
  return chunks
}
