// WeChat media over the iLink CDN.
// Mirrors @tencent-weixin/openclaw-weixin src/cdn/{aes-ecb,cdn-url,upload,pic-decrypt}.ts
// and src/media/media-download.ts, in dependency-free pure Node.js.

import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"

import { MessageItemType, UploadMediaType } from "./client.mjs"

export const MAX_MEDIA_BYTES = 20 * 1024 * 1024

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg", ".ico"])
const VIDEO_EXTS = new Set([".mp4", ".mov", ".avi", ".mkv", ".webm"])
const MIME_BY_EXT = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".bmp": "image/bmp", ".svg": "image/svg+xml", ".ico": "image/x-icon",
  ".mp4": "video/mp4", ".mov": "video/quicktime", ".avi": "video/x-msvideo", ".webm": "video/webm",
  ".pdf": "application/pdf", ".txt": "text/plain", ".md": "text/markdown", ".json": "application/json",
  ".csv": "text/csv", ".zip": "application/zip", ".log": "text/plain",
}

export function encryptAesEcb(plaintext, key) {
  const cipher = crypto.createCipheriv("aes-128-ecb", key, null)
  return Buffer.concat([cipher.update(plaintext), cipher.final()])
}

export function decryptAesEcb(ciphertext, key) {
  const decipher = crypto.createDecipheriv("aes-128-ecb", key, null)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()])
}

/** AES-128-ECB with PKCS7 padding to a 16-byte boundary. */
export function aesEcbPaddedSize(plaintextSize) {
  return Math.ceil((plaintextSize + 1) / 16) * 16
}

export function buildCdnDownloadUrl(encryptedQueryParam, cdnBaseUrl) {
  return `${cdnBaseUrl}/download?encrypted_query_param=${encodeURIComponent(encryptedQueryParam)}`
}

export function buildCdnUploadUrl(encryptedQueryParam, filekey, cdnBaseUrl) {
  return `${cdnBaseUrl}/upload?encrypted_query_param=${encodeURIComponent(encryptedQueryParam)}&filekey=${encodeURIComponent(filekey)}`
}

/** CDNMedia.aes_key can be base64(raw 16 bytes) or base64(32-char hex string). */
export function parseAesKey(encoded) {
  if (Buffer.isBuffer(encoded) && encoded.length === 16) return encoded
  if (typeof encoded !== "string" || !encoded.trim()) throw new Error("missing aes key")
  const trimmed = encoded.trim()
  // A plain 32-char hex string (image_item.aeskey) is also seen in the wild.
  if (/^[0-9a-fA-F]{32}$/.test(trimmed)) return Buffer.from(trimmed, "hex")
  const decoded = Buffer.from(trimmed, "base64")
  if (decoded.length === 16) return decoded
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString("ascii"))) {
    return Buffer.from(decoded.toString("ascii"), "hex")
  }
  throw new Error(`unsupported aes_key encoding (${decoded.length} bytes)`)
}

export async function downloadAndDecrypt({ encryptedQueryParam, aesKey, cdnBaseUrl, fullUrl, label = "media" }) {
  const key = parseAesKey(aesKey)
  const url = fullUrl?.trim() || buildCdnDownloadUrl(encryptedQueryParam, cdnBaseUrl)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${label}: CDN download ${res.status} ${res.statusText}`)
  const encrypted = Buffer.from(await res.arrayBuffer())
  return decryptAesEcb(encrypted, key)
}

/** Upload a local file to the WeChat CDN; returns the CDN reference used in outbound messages. */
export async function uploadLocalFile({ client, filePath, toUserId, mediaType, cdnBaseUrl, fileName }) {
  const plaintext = fs.readFileSync(filePath)
  if (plaintext.length > MAX_MEDIA_BYTES) throw new Error(`文件过大（${plaintext.length} 字节，上限 ${MAX_MEDIA_BYTES}）`)
  const rawsize = plaintext.length
  const rawfilemd5 = crypto.createHash("md5").update(plaintext).digest("hex")
  const filesize = aesEcbPaddedSize(rawsize)
  const filekey = crypto.randomBytes(16).toString("hex")
  const aeskey = crypto.randomBytes(16)

  const resp = await client.getUploadUrl({
    filekey,
    mediaType,
    toUserId,
    rawsize,
    rawfilemd5,
    filesize,
    aeskey: aeskey.toString("hex"),
  })
  const uploadUrl = resp.upload_full_url?.trim() || (resp.upload_param ? buildCdnUploadUrl(resp.upload_param, filekey, cdnBaseUrl) : null)
  if (!uploadUrl) throw new Error("getuploadurl 未返回 upload_full_url 或 upload_param")

  let downloadParam
  let lastError
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(uploadUrl, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: new Uint8Array(encryptAesEcb(plaintext, aeskey)),
      })
      if (res.status >= 400 && res.status < 500) throw new Error(`CDN 上传客户端错误 ${res.status}`)
      if (res.status !== 200) throw new Error(`CDN 上传服务端错误 ${res.status}`)
      downloadParam = res.headers.get("x-encrypted-param")
      if (!downloadParam) throw new Error("CDN 响应缺少 x-encrypted-param")
      break
    } catch (err) {
      lastError = err
      if (attempt < 3) await new Promise((r) => setTimeout(r, 1000 * attempt))
    }
  }
  if (!downloadParam) throw lastError ?? new Error("CDN 上传失败")

  return {
    filekey,
    downloadEncryptedQueryParam: downloadParam,
    // openclaw-weixin send.ts emits base64(hex string of the 16-byte key);
    // parseAesKey() accepts both that and base64(raw 16 bytes).
    aeskeyBase64: Buffer.from(aeskey.toString("hex"), "utf8").toString("base64"),
    fileSize: rawsize,
    fileSizeCiphertext: filesize,
    fileName: fileName ?? path.basename(filePath),
  }
}

export function detectMimeFromBuffer(buf, fileName = "") {
  const ext = path.extname(fileName).toLowerCase()
  if (MIME_BY_EXT[ext]) return MIME_BY_EXT[ext]
  if (buf[0] === 0x89 && buf[1] === 0x50) return "image/png"
  if (buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg"
  if (buf[0] === 0x47 && buf[1] === 0x49) return "image/gif"
  if (buf[0] === 0x52 && buf[1] === 0x49) return "image/webp"
  if (buf[0] === 0x42 && buf[1] === 0x4d) return "image/bmp"
  return "application/octet-stream"
}

export function mediaTypeFromFile(filePath) {
  const ext = path.extname(filePath).toLowerCase()
  if (IMAGE_EXTS.has(ext)) return UploadMediaType.IMAGE
  if (VIDEO_EXTS.has(ext)) return UploadMediaType.VIDEO
  return UploadMediaType.FILE
}

export function dataUrlForBuffer(buf, mime) {
  return `data:${mime || "application/octet-stream"};base64,${buf.toString("base64")}`
}

const EXT_BY_MIME = {
  "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp",
  "image/bmp": ".bmp", "image/svg+xml": ".svg", "image/x-icon": ".ico", "video/mp4": ".mp4",
  "video/quicktime": ".mov", "video/x-msvideo": ".avi", "video/webm": ".webm",
  "application/pdf": ".pdf", "text/plain": ".txt", "text/markdown": ".md", "application/json": ".json",
  "text/csv": ".csv", "application/zip": ".zip",
}

function withExtension(name, mime) {
  if (path.extname(name)) return name
  return `${name}${EXT_BY_MIME[mime] ?? ""}`
}

/** Extract CDN references from inbound message items. */
export function extractMediaItems(items = []) {
  const out = []
  for (const item of items) {
    const add = (kind, media, name, extra = {}) => {
      const encryptedQueryParam = media?.encrypt_query_param
      const aesKey = kind === "image" && item.image_item?.aeskey
        ? Buffer.from(item.image_item.aeskey, "hex").toString("base64")
        : media?.aes_key
      if (!encryptedQueryParam && !media?.full_url) return
      out.push({ kind, name: name || `${kind}-${Date.now()}`, encryptedQueryParam, aesKey, fullUrl: media?.full_url, ...extra })
    }
    if (item.type === MessageItemType.IMAGE) add("image", item.image_item?.media, item.image_item?.file_name || "image")
    else if (item.type === MessageItemType.FILE) add("file", item.file_item?.media, item.file_item?.file_name || "file")
    else if (item.type === MessageItemType.VIDEO) add("video", item.video_item?.media, item.video_item?.file_name || "video")
    else if (item.type === MessageItemType.VOICE) add("voice", item.voice_item?.media, "voice", { text: item.voice_item?.text })
  }
  return out
}

/** Download + decrypt inbound media into stateDir/media/<timestamp>/, return local file descriptors. */
export async function downloadInboundMedia({ items, stateDir, cdnBaseUrl, log = () => {} }) {
  const refs = extractMediaItems(items)
  const saved = []
  for (const ref of refs) {
    try {
      const buf = await downloadAndDecrypt({
        encryptedQueryParam: ref.encryptedQueryParam,
        aesKey: ref.aesKey,
        cdnBaseUrl,
        fullUrl: ref.fullUrl,
        label: `inbound ${ref.kind}`,
      })
      if (buf.length > MAX_MEDIA_BYTES) {
        log(`[media] skip oversized inbound ${ref.kind} (${buf.length} bytes)`)
        continue
      }
      const dir = path.join(stateDir, "media", String(Date.now()))
      fs.mkdirSync(dir, { recursive: true })
      const mime = detectMimeFromBuffer(buf, ref.name || ref.kind)
      const safeName = withExtension(
        path.basename(ref.name || ref.kind).replace(/[^\w.\-\u4e00-\u9fa5]+/g, "_"),
        mime,
      )
      const filePath = path.join(dir, safeName)
      fs.writeFileSync(filePath, buf)
      saved.push({ kind: ref.kind, path: filePath, name: safeName, mime, size: buf.length, text: ref.text })
      log(`[media] downloaded ${ref.kind}: ${filePath} (${buf.length} bytes)`)
    } catch (err) {
      log(`[media] failed to download ${ref.kind}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return saved
}

/** Find existing local image/file paths mentioned in assistant text (for sending files back). */
export function findMediaPathsInText(text, { limit = 3 } = {}) {
  if (!text) return []
  const re = /(?:\/[\w.@\-+\u4e00-\u9fa5]+)+\.(?:png|jpe?g|gif|webp|bmp|svg|mp4|mov|webm|pdf|txt|md|json|csv|zip|log)/gi
  const matches = [...new Set(text.match(re) ?? [])]
  return matches.filter((p) => {
    try {
      const st = fs.statSync(p)
      return st.isFile() && st.size > 0 && st.size <= MAX_MEDIA_BYTES
    } catch {
      return false
    }
  }).slice(0, limit)
}
