# wx-opencode-bridge — 微信 ↔ OpenCode 桥接

把个人微信（通过 iLink / ClawBot）与 [OpenCode](https://opencode.ai) 桥接：给微信好友发消息，
自动转发给本机运行的 OpenCode 并回复。支持 SSE 流式回复、图片/文件收发、微信端斜杠命令与后台 daemon。

参考实现：

- `@tencent-weixin/openclaw-weixin`（OpenClaw 微信 channel，iLink 长轮询 + CDN 媒体管线）
- `Wechat-ggGitHub/wechat-claude-code`（微信 ↔ Claude Code 案例仓库）

## 架构

```
微信(手机) <--> iLink/ClawBot(https://ilinkai.weixin.qq.com) <--> Node 桥接 daemon <--> OpenCode server
```

`src/` 目录结构：

| 文件 | 职责 |
|------|------|
| `src/ilink/client.mjs` | iLink HTTP 客户端：`getUpdates` 长轮询、`sendMessage`、`getConfig`/`sendTyping`、`getuploadurl`、QR 登录（验证码 / IDC 重定向）、uint64 无损解析 |
| `src/ilink/media.mjs` | 微信 CDN 媒体：AES-128-ECB 加解密、`getuploadurl` → CDN 上传、入站下载解密、MIME/扩展名推断 |
| `src/ilink/sender.mjs` | 发送方：限流（2.5s/用户）、ret:-2 退避、熔断器、陈旧会话检测、typing、文本/图片/文件/视频消息 |
| `src/ilink/accounts.mjs` | 账号存储（`~/.wechat-opencode-bridge/accounts/`）、sync-buf、context-tokens |
| `src/commands.mjs` | 微信端斜杠命令路由 |
| `src/bridge.mjs` | `WeChatOpenCodeBridge`：monitor 循环、每用户队列、SSE 流式回复、媒体处理、OpenCode 会话管理 |
| `src/opencode/client.mjs` | 用 `@opencode/client` 创建 OpenCode 客户端（HTTP Basic 认证） |
| `src/main.mjs` | CLI：`setup/start/daemon/doctor/status/install-service` |

## 快速开始

1. 确保 OpenCode 服务已运行（`opencode serve`，默认 `http://127.0.0.1:49374`；密码可用
   `opencode service get password` 读取，或设置 `WCOB_OPENCODE_PASSWORD`）。
2. 扫码绑定：`npm run setup`（或 `node src/main.mjs setup`）。
3. 自检：`npm run doctor`。
4. 前台运行：`npm start`；后台运行：`npm run daemon -- start`。
5. 开机自启：`npm run install-service`，然后按提示 `systemctl --user enable --now ...`。

环境变量：

| 变量 | 默认 | 说明 |
|------|------|------|
| `WCOB_STATE_DIR` | `~/.wechat-opencode-bridge` | 状态目录 |
| `WCOB_OPENCODE_URL` | `http://127.0.0.1:49374` | OpenCode 服务地址 |
| `WCOB_OPENCODE_PASSWORD` | 自动读取 | Basic auth 密码 |
| `WCOB_STREAMING` | 关闭 | 设为 `1` 才开启 SSE 流式回复；默认关闭以保证一条完整回复只发一条微信消息 |
| `WCOB_STREAM_FLUSH_MS` | `3000` | 流式分片间隔（毫秒） |
| `WCOB_CDN_BASE_URL` | 微信官方 CDN | CDN base URL |

## 微信端命令

`/help`、`/new [标题]`、`/status`、`/model [模型名]`、`/clear`、`/history [n]`、
`/compact`、`/undo`、`/send <本机文件路径>`、`/ping`、`/version`、`/cwd`。

其他文字直接交给 OpenCode；收到的图片/文件/视频/语音会解密后作为附件进入同一会话。
OpenCode 回复中如果存在可访问的本地图片/文件路径，会自动上传 CDN 后发回微信。

终端与微信共用同一个 OpenCode 会话时，终端发的消息及其最终回复会同步到微信，分别带
`【终端】` 和 `【终端回复】` 标记；微信自己发的消息和回复不会回显。同步需要有效的 context
token（由微信入站消息刷新并持久化）；若长时间没有微信消息导致 token 过期，在微信发一条消息即可恢复。

## 验证

```bash
cd <项目目录>
npm test
# 或分别运行：
timeout 420 node tests/e2e.mjs
timeout 480 node tests/e2e-features.mjs
```

- `tests/e2e.mjs`：mock iLink → 桥接 → 真实 OpenCode，验证基础往返。
- `tests/e2e-features.mjs`：覆盖 `/ping` 命令、SSE 流式分片、入站图片解密下载、出站图片 CDN 上传与解密校验。

## 关键设计

- **每个微信用户 = 一个 OpenCode 会话**（title `wechat-<fromUserId>`，映射持久化到
  `stateDir/opencode-sessions.json`）。
- **流式**：默认关闭（`WCOB_STREAMING=1` 开启）；`event.subscribe({ types: [...] })` 监听 `session.text.delta`，按间隔合并成分片发送；
  `message.list?type=assistant` 作为完成态权威来源，SSE 结束信号只用于提前收尾。断流时自动回退轮询。
- **媒体**：入站 CDN 密文用 AES-128-ECB 解密；key 兼容 base64(raw16) / base64(hex32) / 裸 hex；
  出站先 `getuploadurl`，AES 加密后 POST 到 CDN，取响应头 `x-encrypted-param` 作为下载参数。
- **容错**：`message_id` 去重、sync-buf 持久化、token 失效暂停、发送重试与熔断、typing 保活。
- **OpenCode V2 API 形状**：`session.create({ title })`、`session.prompt({ sessionID, text, files })`、
  `message.list({ sessionID, type })`、`event.subscribe()` 均为扁平输入（V1 文档的 `{ path, body }` 已过时）。

## 开源与合规提示

iLink / ClawBot 是微信的非公开接口，本项目未获得腾讯官方授权。使用前请自行确认账号与服务条款风险，
包括但不限于账号限制或封禁；作者不对使用该接口产生的后果负责。

仓库内不含任何账号、token 或密码。登录凭据与会话状态只保存在本机 `WCOB_STATE_DIR`
（默认 `~/.wechat-opencode-bridge`，沿用历史目录名以避免破坏已有数据）。

MIT 许可证仅覆盖本仓库代码，不包含微信或 OpenCode 的任何商标、协议或服务端资产。
