// OpenCode client factory — connects to a running `opencode serve` (or an
// embedded instance via the @opencode/sdk `create()`), using the published
// @opencode/client (OpenCode.make -> generated client, POST /api/session...,
// GET /api/session/:id/message?type=assistant, etc.).
//
// The V1 documentation (opencode.ai/docs/zh-cn/sdk/) describes this layer as
// `createOpencodeClient({ baseUrl })`; the current @opencode/client exposes
// the same thing as `OpenCode.make({ baseUrl })`.

import { execSync } from "node:child_process"

import { OpenCode } from "@opencode/client"

export function basicAuth(username, password) {
  if (!password) return undefined
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
}

export function defaultOpenCodePassword() {
  // Prefer an explicit env var; then ask the local background service.
  if (process.env.WCOB_OPENCODE_PASSWORD) return process.env.WCOB_OPENCODE_PASSWORD
  try {
    const out = execSync("opencode service get password 2>/dev/null", { encoding: "utf-8", stdio: ["pipe", "pipe", "ignore"] }).trim()
    return out || undefined
  } catch {
    return undefined
  }
}

export function createOpenCodeClient({ baseUrl = "http://127.0.0.1:49374", password } = {}) {
  const resolved = password ?? defaultOpenCodePassword()
  const auth = basicAuth("opencode", resolved)
  return OpenCode.make({ baseUrl, headers: auth ? { Authorization: auth } : undefined })
}
