// Rate-limited WeChat sender built on the iLink client.
// Adapted from wechat-claude-code src/wechat/send.ts and api.ts;
// media item shapes mirror @tencent-weixin/openclaw-weixin src/messaging/send.ts.

import fs from "node:fs"
import path from "node:path"

import * as ilink from "./client.mjs"
import { formatForWeChat } from "../text-format.mjs"

const MIN_SEND_INTERVAL_MS = 2500
const STALE_SESSION_PAUSE_MS = 10 * 60_000
const CIRCUIT_WINDOW_MS = 30_000
const CIRCUIT_OPEN_MS = 30_000
const MAX_RETRIES = 2
const MESSAGE_TEXT_CACHE_LIMIT = 200

class StaleSessionError extends Error {
  constructor() {
    super("stale session — user must send a message to refresh context_token")
  }
}

export function createWeChatSender({ token, baseUrl, accountId, cdnBaseUrl = ilink.CDN_BASE_URL, log = () => {}, cacheFile = null }) {
  const api = ilink.createClient({ baseUrl, token })
  const typingTicketCache = new Map()
  const nextSendTime = new Map()
  const rateLimitEvents = []
  const messageTextCache = new Map() // message_id (string) -> text
  let circuitUntil = 0

  // Load persisted cache (best effort — a corrupt/missing file is not fatal).
  if (cacheFile) {
    try {
      const loaded = JSON.parse(fs.readFileSync(cacheFile, "utf-8"))
      for (const [key, value] of Object.entries(loaded ?? {})) {
        if (typeof key === "string" && typeof value === "string") messageTextCache.set(key, value)
      }
      while (messageTextCache.size > MESSAGE_TEXT_CACHE_LIMIT) {
        const oldest = messageTextCache.keys().next().value
        if (oldest === undefined) break
        messageTextCache.delete(oldest)
      }
    } catch {}
  }

  function persistCache() {
    if (!cacheFile) return
    try {
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true })
      const tmp = `${cacheFile}.${process.pid}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(messageTextCache)))
      fs.renameSync(tmp, cacheFile)
    } catch {}
  }

  function recordMessageText(messageId, text) {
    if (!messageId || !text) return
    const key = String(messageId)
    messageTextCache.delete(key)
    messageTextCache.set(key, String(text))
    while (messageTextCache.size > MESSAGE_TEXT_CACHE_LIMIT) {
      const oldest = messageTextCache.keys().next().value
      if (oldest === undefined) break
      messageTextCache.delete(oldest)
    }
    persistCache()
  }

  function getSentText(messageId) {
    if (!messageId) return undefined
    return messageTextCache.get(String(messageId))
  }

  function isCircuitOpen() {
    if (circuitUntil === 0) return false
    if (Date.now() >= circuitUntil) {
      circuitUntil = 0
      rateLimitEvents.length = 0
      return false
    }
    return true
  }

  function tripCircuit() {
    const now = Date.now()
    while (rateLimitEvents.length > 0 && rateLimitEvents[0] < now - CIRCUIT_WINDOW_MS) rateLimitEvents.shift()
    rateLimitEvents.push(now)
    circuitUntil = Math.max(circuitUntil, now + CIRCUIT_OPEN_MS)
  }

  async function getTypingTicket({ ilinkUserId, contextToken }) {
    const cached = typingTicketCache.get(ilinkUserId)
    if (cached && Date.now() - cached.fetchedAt < 24 * 60 * 60_000) return cached.ticket
    try {
      const resp = await api.getConfig({ ilinkUserId, contextToken })
      if (resp?.ret === 0 && resp.typing_ticket) {
        typingTicketCache.set(ilinkUserId, { ticket: resp.typing_ticket, fetchedAt: Date.now() })
        return resp.typing_ticket
      }
    } catch {
      // typing is best-effort; swallow
    }
    return ""
  }

  /** Returns a stop() function that cancels the typing keepalive. */
  function startTyping({ ilinkUserId, contextToken }) {
    let cancelled = false
    let ticket = ""
    let interval
    ;(async () => {
      try {
        ticket = await getTypingTicket({ ilinkUserId, contextToken })
        if (!ticket || cancelled) return
        await api.sendTyping({ ilinkUserId, typingTicket: ticket, status: ilink.TypingStatus.TYPING })
        if (cancelled) return
        interval = setInterval(async () => {
          if (cancelled) {
            clearInterval(interval)
            return
          }
          try {
            await api.sendTyping({ ilinkUserId, typingTicket: ticket, status: ilink.TypingStatus.TYPING })
          } catch {
            clearInterval(interval)
          }
        }, 5000)
      } catch {
        // best-effort typing
      }
    })()
    return () => {
      cancelled = true
      if (interval) clearInterval(interval)
      if (ticket) {
        api.sendTyping({ ilinkUserId, typingTicket: ticket, status: ilink.TypingStatus.CANCEL }).catch(() => {})
      }
    }
  }

  /** Send one outbound WeixinMessage with per-user rate limiting, retry, and circuit breaker. */
  async function sendMsg({ ilinkUserId, contextToken, itemList, state = ilink.MessageState.FINISH }) {
    const msg = {
      from_user_id: accountId,
      to_user_id: ilinkUserId,
      client_id: ilink.generateClientId(),
      message_type: ilink.MessageType.BOT,
      message_state: state,
      context_token: contextToken,
      item_list: itemList,
    }
    const userId = ilinkUserId
    const now = Date.now()
    const next = (nextSendTime.get(userId) ?? 0) + MIN_SEND_INTERVAL_MS
    nextSendTime.set(userId, Math.max(now, next))
    if (nextSendTime.get(userId) > now) await new Promise((r) => setTimeout(r, nextSendTime.get(userId) - now))

    let delay = 3000
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (isCircuitOpen()) throw new Error(`circuit breaker open (${Math.ceil((circuitUntil - Date.now()) / 1000)}s remaining)`)
      try {
        const resp = await api.sendMessage({ msg })
        log(`[sender] sendMessage attempt=${attempt + 1} ret=${resp.ret ?? 0} errmsg=${resp.errmsg ?? "-"} to=${userId}`)
        if (resp.ret === -2) {
          const errmsg = (resp.errmsg ?? "").toLowerCase()
          if (errmsg === "unknown error" || errmsg.includes("prepare failed")) {
            nextSendTime.set(userId, Date.now() + STALE_SESSION_PAUSE_MS)
            throw new StaleSessionError()
          }
          tripCircuit()
          nextSendTime.set(userId, Date.now() + 30_000)
          if (attempt === MAX_RETRIES) throw new Error("sendMessage rate-limited after retries")
          await new Promise((r) => setTimeout(r, delay))
          delay = Math.min(delay * 2, 15_000)
          continue
        }
        if (resp.ret !== undefined && resp.ret !== 0) throw new Error(`sendMessage ret=${resp.ret} errmsg=${resp.errmsg ?? "(none)"}`)
        const sentText = itemList
          .filter((item) => item.type === ilink.MessageItemType.TEXT && item.text_item?.text != null)
          .map((item) => String(item.text_item.text))
          .join("\n")
        if (sentText) recordMessageText(resp.message_id, sentText)
        return resp
      } catch (err) {
        log(`[sender] sendMessage error attempt=${attempt + 1}: ${err instanceof Error ? err.message : String(err)}`)
        if (err instanceof StaleSessionError) throw err
        if (attempt === MAX_RETRIES) throw err
        await new Promise((r) => setTimeout(r, delay))
        delay = Math.min(delay * 2, 15_000)
      }
    }
  }

  function sendText({ ilinkUserId, contextToken, text, state }) {
    const clean = formatForWeChat(text)
    return sendMsg({
      ilinkUserId,
      contextToken,
      state,
      itemList: [{ type: ilink.MessageItemType.TEXT, text_item: { text: clean } }],
    })
  }

  const cdnRef = (uploaded) => ({
    encrypt_query_param: uploaded.downloadEncryptedQueryParam,
    aes_key: uploaded.aeskeyBase64,
    encrypt_type: 1,
  })

  // The official plugin sends the caption and the media item as two separate
  // sendMessage requests (one item per request), so we mirror that here.
  async function sendMedia({ ilinkUserId, contextToken, caption, item }) {
    if (caption) {
      await sendText({ ilinkUserId, contextToken, text: caption })
    }
    return sendMsg({ ilinkUserId, contextToken, itemList: [item] })
  }

  function sendImage({ ilinkUserId, contextToken, uploaded, caption }) {
    return sendMedia({
      ilinkUserId,
      contextToken,
      caption,
      item: {
        type: ilink.MessageItemType.IMAGE,
        image_item: { media: cdnRef(uploaded), mid_size: uploaded.fileSizeCiphertext },
      },
    })
  }

  function sendFile({ ilinkUserId, contextToken, uploaded, caption }) {
    return sendMedia({
      ilinkUserId,
      contextToken,
      caption,
      item: {
        type: ilink.MessageItemType.FILE,
        file_item: { media: cdnRef(uploaded), file_name: uploaded.fileName, len: String(uploaded.fileSize) },
      },
    })
  }

  function sendVideo({ ilinkUserId, contextToken, uploaded, caption }) {
    return sendMedia({
      ilinkUserId,
      contextToken,
      caption,
      item: {
        type: ilink.MessageItemType.VIDEO,
        video_item: { media: cdnRef(uploaded), video_size: uploaded.fileSizeCiphertext },
      },
    })
  }

  return { api, cdnBaseUrl, startTyping, sendText, sendImage, sendFile, sendVideo, isCircuitOpen, recordMessageText, getSentText }
}

export { StaleSessionError }
export const TypingStatus = ilink.TypingStatus
