// WeChat account store + QR login flow (mirrors openclaw-weixin auth/accounts.ts,
// auth/login-qr.ts, storage/sync-buf.ts).

import fs from "node:fs"
import path from "node:path"
import { homedir } from "node:os"

import { fetchQrCode, waitForLogin, LOGIN_STATUS } from "./client.mjs"

const TYPING_TICKET_TTL = 24 * 60 * 60 * 1000

export function resolveStateDir(override) {
  return override ?? path.join(homedir(), ".wechat-opencode-bridge")
}

export function normalizeAccountId(raw) {
  return String(raw).replace(/[^a-zA-Z0-9._-]+/g, "-")
}

export function accountsDir(stateDir) {
  return path.join(stateDir, "accounts")
}

export function accountPath(stateDir, accountId) {
  return path.join(accountsDir(stateDir), `${normalizeAccountId(accountId)}.json`)
}

export function syncBufPath(stateDir, accountId) {
  return path.join(accountsDir(stateDir), `${normalizeAccountId(accountId)}.sync-buf.json`)
}

export function contextTokensPath(stateDir, accountId) {
  return path.join(accountsDir(stateDir), `${normalizeAccountId(accountId)}.context-tokens.json`)
}

export function saveAccount(stateDir, accountId, update) {
  const file = accountPath(stateDir, accountId)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const existing = loadAccount(stateDir, accountId) ?? {}
  const data = {
    accountId: normalizeAccountId(accountId),
    token: update.token?.trim() || existing.token,
    baseUrl: update.baseUrl?.trim() || existing.baseUrl,
    userId: update.userId?.trim() || existing.userId,
    savedAt: new Date().toISOString(),
  }
  fs.writeFileSync(file, JSON.stringify(data, null, 2))
  fs.chmodSync(file, 0o600)
}

export function loadAccount(stateDir, accountId) {
  try {
    const file = accountPath(stateDir, accountId)
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf-8"))
  } catch {}
  return null
}

export function listAccountIds(stateDir) {
  try {
    return fs.readdirSync(accountsDir(stateDir))
      .filter((f) => f.endsWith(".json") && !f.endsWith(".sync-buf.json") && !f.endsWith(".context-tokens.json"))
      .map((f) => f.slice(0, -5))
      .filter((id) => id.startsWith("wcob-") || loadAccount(stateDir, id))
  } catch {
    return []
  }
}

export function hasAccountToken(stateDir, accountId) {
  const a = loadAccount(stateDir, accountId)
  return Boolean(a?.token?.trim())
}

export function loadGetUpdatesBuf(stateDir, accountId) {
  try {
    const file = syncBufPath(stateDir, accountId)
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf-8")).buf
  } catch {}
  return ""
}

export function saveGetUpdatesBuf(stateDir, accountId, buf) {
  const file = syncBufPath(stateDir, accountId)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ buf }))
}

export function loadContextTokens(stateDir, accountId) {
  try {
    const file = contextTokensPath(stateDir, accountId)
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf-8"))
  } catch {}
  return {}
}

export function saveContextTokens(stateDir, accountId, map) {
  const file = contextTokensPath(stateDir, accountId)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(map))
}

// ---------------------------------------------------------------------------
// QR login
// ---------------------------------------------------------------------------

export async function startQrLogin({ baseUrl, localTokenList = [] }) {
  const qr = await fetchQrCode({ baseUrl, localTokenList })
  return { qrcode: qr.qrcode, qrcodeUrl: qr.qrcode_img_content, message: qr.ret === 0 ? "请扫码连接" : `登录失败: ${qr.errmsg}` }
}

export async function waitForQrScan({ baseUrl, qrcode, timeoutMs, onStatus }) {
  return waitForLogin({ baseUrl, qrcode, timeoutMs, onStatus })
}
