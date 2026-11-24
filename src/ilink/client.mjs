// iLink (ClawBot) client — pure fetch implementation.
// Adapted from the public source of @tencent-weixin/openclaw-weixin
// (src/api/api.ts, src/auth/login-qr.ts, src/api/types.ts) and the
// wechat-claude-code case study (src/wechat/api.ts, src/wechat/send.ts).

import crypto from "node:crypto"

// These constants must match @tencent-weixin/openclaw-weixin v2.4.10
// (package.json: ilink_appid="bot", version="2.4.10"). A wrong app id causes
// the WeChat client to reject the QR flow with a network error.
export const ILINK_APP_ID = "bot"
export const ILINK_CLIENT_VERSION = "2.4.10"
export const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com"
export const CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c"

export const MessageType = { NONE: 0, USER: 1, BOT: 2 }
export const MessageItemType = {
  NONE: 0,
  TEXT: 1,
  IMAGE: 2,
  VOICE: 3,
  FILE: 4,
  VIDEO: 5,
  TOOL_CALL_START: 11,
  TOOL_CALL_RESULT: 12,
}
export const MessageState = { NEW: 0, GENERATING: 1, FINISH: 2 }
/** proto: UploadMediaType (mirrors openclaw-weixin src/api/types.ts). */
export const UploadMediaType = { IMAGE: 1, VIDEO: 2, FILE: 3, VOICE: 4 }
/** TypingStatus: 1 = typing, 2 = cancel. */
export const TypingStatus = { TYPING: 1, CANCEL: 2 }

let clientCounter = 0
export function generateClientId() {
  return `wcob-${Date.now().toString(36)}-${++clientCounter}`
}

function randomWechatUin() {
  const buf = crypto.randomBytes(4).readUInt32BE(0)
  return Buffer.from(String(buf), "utf-8").toString("base64")
}

function buildClientVersion(version) {
  const [major = 0, minor = 0, patch = 0] = String(version).split(".").map((p) => Number.parseInt(p, 10) || 0)
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff)
}
export const ILINK_APP_CLIENT_VERSION = buildClientVersion(ILINK_CLIENT_VERSION)

function baseInfo() {
  return { channel_version: ILINK_CLIENT_VERSION, bot_agent: "wechat-opencode-bridge/0.2.0" }
}

function buildHeaders(token) {
  const headers = {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": randomWechatUin(),
    "iLink-App-Id": ILINK_APP_ID,
    "iLink-App-ClientVersion": String(ILINK_APP_CLIENT_VERSION),
  }
  if (token?.trim()) headers.Authorization = `Bearer ${token.trim()}`
  return headers
}

function ensureTrailingSlash(url) {
  return url.endsWith("/") ? url : `${url}/`
}

async function apiPostFetch({ baseUrl, endpoint, body, token, timeoutMs, abortSignal }) {
  const url = new URL(endpoint, ensureTrailingSlash(baseUrl))
  const controller = timeoutMs != null ? new AbortController() : undefined
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : undefined
  const signals = [controller?.signal, abortSignal].filter(Boolean)
  const onAbort = () => controller?.abort()
  abortSignal?.addEventListener("abort", onAbort, { once: true })
  try {
    const res = await fetch(url.toString(), {
      method: "POST",
      headers: buildHeaders(token),
      body,
      signal: controller?.signal ?? abortSignal,
    })
    const rawText = await res.text()
    if (!res.ok) throw new Error(`POST ${endpoint} ${res.status}: ${rawText}`)
    return rawText
  } finally {
    clearTimeout(timer)
    abortSignal?.removeEventListener("abort", onAbort)
  }
}

async function apiGetFetch({ baseUrl, endpoint, timeoutMs, abortSignal }) {
  const url = new URL(endpoint, ensureTrailingSlash(baseUrl))
  const controller = timeoutMs != null ? new AbortController() : undefined
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : undefined
  const onAbort = () => controller?.abort()
  abortSignal?.addEventListener("abort", onAbort, { once: true })
  try {
    const res = await fetch(url.toString(), { method: "GET", headers: buildHeaders(), signal: controller?.signal ?? abortSignal })
    const rawText = await res.text()
    if (!res.ok) throw new Error(`GET ${endpoint} ${res.status}: ${rawText}`)
    return rawText
  } finally {
    clearTimeout(timer)
    abortSignal?.removeEventListener("abort", onAbort)
  }
}

/** Quote uint64 fields losslessly so JSON.parse never loses precision (same trick as the plugin). */
const LOSSLESS_ID_FIELDS = new Set(["message_id", "msg_id", "svr_id"])

export function parseWeixinApiJson(rawText) {
  let output = ""
  let index = 0
  while (index < rawText.length) {
    if (rawText[index] !== '"') {
      output += rawText[index++]
      continue
    }
    const stringStart = index
    index++
    let escaped = false
    while (index < rawText.length) {
      const char = rawText[index++]
      if (escaped) escaped = false
      else if (char === "\\") escaped = true
      else if (char === '"') break
    }
    const stringToken = rawText.slice(stringStart, index)
    output += stringToken
    let cursor = index
    while (/\s/.test(rawText[cursor] ?? "")) cursor++
    if (rawText[cursor] !== ":") continue
    let key
    try {
      key = JSON.parse(stringToken)
    } catch {
      continue
    }
    if (typeof key !== "string" || !LOSSLESS_ID_FIELDS.has(key)) continue
    output += rawText.slice(index, cursor + 1)
    cursor++
    while (/\s/.test(rawText[cursor] ?? "")) output += rawText[cursor++]
    const numberStart = cursor
    if (rawText[cursor] === "-") cursor++
    while (/\d/.test(rawText[cursor] ?? "")) cursor++
    if (cursor > numberStart && !(cursor === numberStart + 1 && rawText[numberStart] === "-")) {
      output += `"${rawText.slice(numberStart, cursor)}"`
      index = cursor
    } else {
      index = numberStart
    }
  }
  return JSON.parse(output)
}

export function createClient({ baseUrl = DEFAULT_BASE_URL, token }) {
  const apiBase = baseUrl.replace(/\/+$/, "")

  async function getUpdates({ getUpdatesBuf = "", timeoutMs = 35000, abortSignal } = {}) {
    const raw = await apiPostFetch({
      baseUrl: apiBase,
      endpoint: "ilink/bot/getupdates",
      body: JSON.stringify({ get_updates_buf: getUpdatesBuf, base_info: baseInfo() }),
      token,
      timeoutMs,
      abortSignal,
    })
    return parseWeixinApiJson(raw)
  }

  async function sendMessage({ msg, timeoutMs = 15000 } = {}) {
    const raw = await apiPostFetch({
      baseUrl: apiBase,
      endpoint: "ilink/bot/sendmessage",
      body: JSON.stringify({ msg, base_info: baseInfo() }),
      token,
      timeoutMs,
    })
    // Return the raw envelope so callers can implement -2 rate-limit backoff.
    return parseWeixinApiJson(raw)
  }

  async function getConfig({ ilinkUserId, contextToken, timeoutMs = 10000 } = {}) {
    const raw = await apiPostFetch({
      baseUrl: apiBase,
      endpoint: "ilink/bot/getconfig",
      body: JSON.stringify({ ilink_user_id: ilinkUserId, context_token: contextToken, base_info: baseInfo() }),
      token,
      timeoutMs,
    })
    return JSON.parse(raw)
  }

  async function sendTyping({ ilinkUserId, typingTicket, status, timeoutMs = 10000 } = {}) {
    await apiPostFetch({
      baseUrl: apiBase,
      endpoint: "ilink/bot/sendtyping",
      body: JSON.stringify({ ilink_user_id: ilinkUserId, typing_ticket: typingTicket, status, base_info: baseInfo() }),
      token,
      timeoutMs,
    })
  }

  /** Pre-signed CDN upload URL for media (mirrors getUploadUrl in openclaw-weixin). */
  async function getUploadUrl({ filekey, mediaType, toUserId, rawsize, rawfilemd5, filesize, aeskey, noNeedThumb = true, timeoutMs = 15000 } = {}) {
    const raw = await apiPostFetch({
      baseUrl: apiBase,
      endpoint: "ilink/bot/getuploadurl",
      body: JSON.stringify({
        filekey,
        media_type: mediaType,
        to_user_id: toUserId,
        rawsize,
        rawfilemd5,
        filesize,
        no_need_thumb: noNeedThumb,
        aeskey,
        base_info: baseInfo(),
      }),
      token,
      timeoutMs,
    })
    return JSON.parse(raw)
  }

  async function notifyStart({ timeoutMs = 10000 } = {}) {
    await apiPostFetch({ baseUrl: apiBase, endpoint: "ilink/bot/msg/notifystart", body: JSON.stringify({ base_info: baseInfo() }), token, timeoutMs })
  }

  async function notifyStop({ timeoutMs = 10000 } = {}) {
    await apiPostFetch({ baseUrl: apiBase, endpoint: "ilink/bot/msg/notifystop", body: JSON.stringify({ base_info: baseInfo() }), token, timeoutMs })
  }

  return { getUpdates, sendMessage, getConfig, sendTyping, getUploadUrl, notifyStart, notifyStop }
}

// ---------------------------------------------------------------------------
// QR login (mirrors login-qr.ts)
// ---------------------------------------------------------------------------

export const LOGIN_STATUS = {
  WAIT: "wait",
  SCANED: "scaned",
  CONFIRMED: "confirmed",
  EXPIRED: "expired",
  SCANED_BUT_REDIRECT: "scaned_but_redirect",
  NEED_VERIFY_CODE: "need_verifycode",
  VERIFY_CODE_BLOCKED: "verify_code_blocked",
  BINDED_REDIRECT: "binded_redirect",
}

export async function fetchQrCode({ baseUrl = DEFAULT_BASE_URL, botType = "3", localTokenList = [] }) {
  const raw = await apiPostFetch({
    baseUrl,
    endpoint: `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`,
    body: JSON.stringify({ local_token_list: localTokenList }),
    timeoutMs: 20000,
  })
  return JSON.parse(raw)
}

export async function pollQrStatus({ baseUrl = DEFAULT_BASE_URL, qrcode, verifyCode, timeoutMs = 35000, abortSignal }) {
  let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`
  if (verifyCode) endpoint += `&verify_code=${encodeURIComponent(verifyCode)}`
  try {
    const raw = await apiGetFetch({ baseUrl, endpoint, timeoutMs, abortSignal })
    return JSON.parse(raw)
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") return { status: LOGIN_STATUS.WAIT }
    return { status: LOGIN_STATUS.WAIT }
  }
}

/** Poll until the user scans; returns the confirmed result or throws on expiry. */
export async function waitForLogin({
  qrcode,
  baseUrl = DEFAULT_BASE_URL,
  botType = "3",
  timeoutMs = 480_000,
  localTokenList = [],
  onStatus,
  promptVerifyCode,
  shouldAbort,
}) {
  const deadline = Date.now() + timeoutMs
  let currentBaseUrl = baseUrl
  let verifyCode = ""
  while (Date.now() < deadline) {
    if (shouldAbort?.()) throw new Error("login aborted")
    const status = await pollQrStatus({
      baseUrl: currentBaseUrl,
      qrcode,
      verifyCode,
      timeoutMs: 35000,
      abortSignal: shouldAbort ? undefined : undefined,
    })
    onStatus?.(status.status, status)
    switch (status.status) {
      case LOGIN_STATUS.CONFIRMED:
        if (!status.ilink_bot_id) throw new Error("login confirmed but ilink_bot_id missing")
        return {
          connected: true,
          botToken: status.bot_token,
          accountId: status.ilink_bot_id,
          baseUrl: status.baseurl,
          userId: status.ilink_user_id,
        }
      case LOGIN_STATUS.EXPIRED:
        throw new Error("二维码已过期")
      case LOGIN_STATUS.BINDED_REDIRECT:
        return { connected: true, alreadyConnected: true, message: "已连接过此账号，无需重复连接。" }
      case LOGIN_STATUS.SCANED_BUT_REDIRECT:
        // Server may redirect us to a different IDC.
        if (status.baseurl?.trim()) currentBaseUrl = status.baseurl.trim()
        break
      case LOGIN_STATUS.NEED_VERIFY_CODE:
        if (!promptVerifyCode) throw new Error("need_verifycode（此账号需要输入验证码）")
        verifyCode = (await promptVerifyCode(status)).trim()
        if (!verifyCode) throw new Error("验证码不能为空")
        break
      case LOGIN_STATUS.VERIFY_CODE_BLOCKED:
        throw new Error("verify_code_blocked（验证码错误次数过多，请重试）")
      default:
        break // wait / scaned
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error("登录超时，请重试。")
}

// ---------------------------------------------------------------------------
// Message helpers
// ---------------------------------------------------------------------------

export function extractTextFromItems(items = []) {
  const parts = []
  for (const item of items) {
    if (item.type === MessageItemType.TEXT && item.text_item?.text != null) parts.push(String(item.text_item.text))
    else if (item.type === MessageItemType.VOICE && item.voice_item?.text) parts.push(String(item.voice_item.text))
    else if (item.type === MessageItemType.IMAGE) parts.push("[图片]")
    else if (item.type === MessageItemType.VIDEO) parts.push("[视频]")
    else if (item.type === MessageItemType.FILE) parts.push(item.file_item?.file_name ? `[文件:${item.file_item.file_name}]` : "[文件]")
  }
  return parts.join("\n").trim()
}
