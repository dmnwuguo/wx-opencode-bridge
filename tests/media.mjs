// Fast unit checks for CDN media crypto/key handling.
import assert from "node:assert/strict"
import crypto from "node:crypto"

import {
  encryptAesEcb,
  decryptAesEcb,
  aesEcbPaddedSize,
  parseAesKey,
  buildCdnDownloadUrl,
  buildCdnUploadUrl,
  extractMediaItems,
} from "../src/ilink/media.mjs"
import { MessageItemType, UploadMediaType } from "../src/ilink/client.mjs"

const key = crypto.randomBytes(16)
const plaintext = Buffer.from("wechat-opencode-bridge media test")
const ciphertext = encryptAesEcb(plaintext, key)
assert.equal(ciphertext.length, aesEcbPaddedSize(plaintext.length))
assert.deepEqual(decryptAesEcb(ciphertext, key), plaintext)

// base64(raw 16 bytes)
assert.deepEqual(parseAesKey(key.toString("base64")), key)
// base64(32-char hex string) — the encoding used by openclaw-weixin send.ts
assert.deepEqual(parseAesKey(Buffer.from(key.toString("hex"), "utf8").toString("base64")), key)
// bare hex
assert.deepEqual(parseAesKey(key.toString("hex")), key)
assert.throws(() => parseAesKey("not-a-key"))

assert.equal(
  buildCdnDownloadUrl("abc def", "https://cdn.example/c2c"),
  "https://cdn.example/c2c/download?encrypted_query_param=abc%20def",
)
assert.equal(
  buildCdnUploadUrl("p&q", "f/key", "https://cdn.example/c2c"),
  "https://cdn.example/c2c/upload?encrypted_query_param=p%26q&filekey=f%2Fkey",
)

const items = extractMediaItems([
  {
    type: MessageItemType.IMAGE,
    image_item: { media: { encrypt_query_param: "img1", aes_key: key.toString("base64") }, file_name: "photo.jpg" },
  },
  {
    type: MessageItemType.FILE,
    file_item: { media: { encrypt_query_param: "file1", aes_key: Buffer.from(key.toString("hex")).toString("base64") }, file_name: "doc.pdf" },
  },
])
assert.equal(items.length, 2)
assert.equal(items[0].kind, "image")
assert.equal(items[0].name, "photo.jpg")
assert.equal(items[1].kind, "file")
assert.equal(UploadMediaType.FILE, 3)

console.log("PASS: media crypto/key/url helpers")
