// Mirrors terminal-origin messages (and their replies) into the WeChat user's
// chat. The bridge shares one OpenCode session with the terminal; messages
// carrying the WeChat session rule are bridge-origin and must not be echoed.

import fs from "node:fs"
import path from "node:path"

import { WECHAT_RULE_PREFIX } from "./form-relay.mjs"

const STATE_FILE = "terminal-sync-state.json"
const MAX_SEEN = 500
const MAX_CHARS = 4000
const TERMINAL_PREFIX = "【终端】"
const TERMINAL_REPLY_PREFIX = "【终端回复】"

function assistantText(message) {
  return (message.content ?? [])
    .filter((c) => c?.type === "text")
    .map((c) => c.text)
    .join("\n")
    .trim()
}

export function classifyMessage(message, sessionState) {
  if (!message?.id) return "skip"
  if (message.type === "user") {
    if (typeof message.text !== "string" || !message.text.trim()) return "skip"
    if (message.text.startsWith(WECHAT_RULE_PREFIX)) return "wechat-user"
    return "terminal-user"
  }
  if (message.type === "assistant") {
    // Only a settled answer is a reply; an in-progress message can still gain
    // more text under the same ID, so it must not be marked seen or forwarded.
    if (message.finish == null || message.finish === "tool-calls") return "skip"
    if (!assistantText(message) || sessionState.pendingReply !== true) return "skip"
    return "terminal-reply"
  }
  return "skip"
}

export function emptySyncState() {
  return { sessions: {} }
}

function normalizeSessionState(raw) {
  return {
    seen: Array.isArray(raw?.seen) ? raw.seen.filter((id) => typeof id === "string") : [],
    initialized: raw?.initialized === true,
    pendingReply: raw?.pendingReply === true,
  }
}

export function loadSyncState(stateDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(stateDir, STATE_FILE), "utf8"))
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed) &&
        parsed.sessions && typeof parsed.sessions === "object" && !Array.isArray(parsed.sessions)) {
      const sessions = {}
      for (const [sessionID, raw] of Object.entries(parsed.sessions)) {
        sessions[sessionID] = normalizeSessionState(raw)
      }
      return { sessions }
    }
  } catch {
    // Missing or corrupt state must not stop the poller.
  }
  return emptySyncState()
}

export function saveSyncState(stateDir, state) {
  fs.mkdirSync(stateDir, { recursive: true })
  const file = path.join(stateDir, STATE_FILE)
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(state), "utf8")
  fs.renameSync(tmp, file)
}

function chunksOf(text) {
  const chunks = []
  for (let i = 0; i < text.length; i += MAX_CHARS) chunks.push(text.slice(i, i + MAX_CHARS))
  return chunks
}

export class TerminalSync {
  constructor({
    opencode,
    sessionOwners,
    contextTokenMap,
    sendText,
    stateDir,
    log = () => {},
    pollIntervalMs = 2000,
  }) {
    this.opencode = opencode
    this.sessionOwners = sessionOwners
    this.contextTokenMap = contextTokenMap
    this.sendText = sendText
    this.stateDir = stateDir
    this.log = log
    this.pollIntervalMs = pollIntervalMs
    this.stopped = false
    this.timer = null
  }

  start() {
    if (this.timer) return
    const schedule = () => {
      if (this.stopped) return
      this.timer = setTimeout(async () => {
        try {
          await this.pollOnce()
        } catch (err) {
          this.log("[terminal-sync] poll error:", err instanceof Error ? err.message : String(err))
        }
        schedule()
      }, this.pollIntervalMs)
    }
    schedule()
  }

  stop() {
    this.stopped = true
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  async pollOnce() {
    const state = loadSyncState(this.stateDir)
    let changed = false
    for (const [sessionID, userId] of this.sessionOwners) {
      const contextToken = this.contextTokenMap.get(userId)
      if (!contextToken) continue
      let sessionState = state.sessions[sessionID]
      if (!sessionState) {
        sessionState = normalizeSessionState()
        state.sessions[sessionID] = sessionState
      }
      const res = await this.opencode.message.list({ sessionID, limit: Math.min(MAX_SEEN, 200), order: "desc" })
      const messages = (Array.isArray(res) ? res : (res?.data ?? [])).slice().reverse()
      if (!sessionState.initialized) {
        sessionState.initialized = true
        sessionState.seen = messages.map((m) => m?.id).filter(Boolean).slice(-MAX_SEEN)
        changed = true
        continue
      }
      const seen = new Set(sessionState.seen)
      for (const message of messages) {
        if (!message?.id || seen.has(message.id)) continue
        const kind = classifyMessage(message, sessionState)
        if (kind === "skip" && message.type === "assistant" && message.finish == null) continue
        if (kind !== "terminal-user" && kind !== "terminal-reply") {
          seen.add(message.id)
          changed = true
          continue
        }
        const text = kind === "terminal-user"
          ? `${TERMINAL_PREFIX}${message.text}`
          : `${TERMINAL_REPLY_PREFIX}${assistantText(message)}`
        try {
          for (const chunk of chunksOf(text)) {
            await this.sendText({ ilinkUserId: userId, contextToken, text: chunk })
          }
        } catch (err) {
          this.log("[terminal-sync] send failed:", err instanceof Error ? err.message : String(err))
          // Leave the message unseen so a later poll retries it, and keep
          // pendingReply intact so the real answer is still forwarded.
          continue
        }
        seen.add(message.id)
        sessionState.pendingReply = kind === "terminal-user"
        changed = true
      }
      sessionState.seen = [...seen].slice(-MAX_SEEN)
    }
    if (changed) saveSyncState(this.stateDir, state)
  }
}
