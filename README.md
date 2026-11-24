# wx-opencode-bridge

[![Node.js](https://img.shields.io/badge/Node.js-22%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![OpenCode](https://img.shields.io/badge/OpenCode-V2-7B61FF)](https://opencode.ai/)
[![WeChat](https://img.shields.io/badge/WeChat-iLink-07C160?logo=wechat&logoColor=white)](https://www.npmjs.com/package/@tencent-weixin/openclaw-weixin)
[![License](https://img.shields.io/badge/License-MIT-blue)](./LICENSE)

把个人微信与 [OpenCode](https://opencode.ai) 桥接：微信发来的消息交给本机 OpenCode 处理，回复再送回微信。同时把终端里的提问和回答同步到微信，让两边共享同一个会话。

## ✨ 特性

- 扫码即用 — 终端显示二维码，微信扫码确认授权，凭证自动持久化，重启无需重扫
- 微信 ↔ OpenCode — 每个微信用户对应一个独立 OpenCode 会话，多轮上下文自动维护
- 一条完整回复 — 默认关闭流式分片，一次回答只发一条微信消息，不再碎片化
- 富媒体收发 — 图片、文件、视频、语音入站解密后作为附件；回复中的本地图片/文件自动上传 CDN 发回
- 微信端指令 — 新建/切换会话、切模型、看历史、压缩、撤销、发文件等斜杠命令
- 终端同步 — 终端发的消息与最终回复同步到微信，带 `【终端】` / `【终端回复】` 标记
- 后台运行 — 支持前台、daemon 与 user systemd 开机自启
- 可测试 — mock iLink + 真实 OpenCode 的端到端测试，覆盖命令、媒体与回复质量

## 📋 前提条件

- Node.js >= 22
- 一个正在运行的 OpenCode 服务：`opencode serve`（默认 `http://127.0.0.1:49374`）
- 可扫码授权的个人微信账号

## 🚀 快速开始

### 1. 克隆并安装

```bash
git clone https://github.com/dmnwuguo/wx-opencode-bridge.git
cd wx-opencode-bridge
npm install
```

### 2. 准备 OpenCode

```bash
opencode serve
```

Basic auth 密码可用 `opencode service get password` 读取，或设置 `WCOB_OPENCODE_PASSWORD`。

### 3. 扫码绑定

```bash
npm run setup
```

终端显示二维码，微信扫码并在手机上确认。登录凭证保存在本机状态目录。

### 4. 自检与启动

```bash
npm run doctor     # 检查配置与连接
npm start          # 前台运行
```

### 5. 后台运行（可选）

```bash
npm run daemon -- start    # 后台 daemon
npm run install-service    # 生成 user systemd 单元，按提示 enable
```

日常管理：`npm run daemon -- status|restart|stop`，`npm run status` 查看运行状态。

## ⚙️ 环境变量

不读取 `.env` 文件，直接通过进程环境变量配置。

| 变量 | 默认 | 说明 |
|------|------|------|
| `WCOB_STATE_DIR` | `~/.wechat-opencode-bridge` | 状态目录（历史名称，保持不变以免破坏已有数据） |
| `WCOB_OPENCODE_URL` | `http://127.0.0.1:49374` | OpenCode 服务地址 |
| `WCOB_OPENCODE_PASSWORD` | 自动读取 | OpenCode Basic auth 密码 |
| `WCOB_STREAMING` | 关闭 | 设为 `1` 才开启 SSE 流式分片；默认关闭，保证一条回复只发一条消息 |
| `WCOB_STREAM_FLUSH_MS` | `3000` | 流式分片间隔（毫秒，仅开启流式时有效） |
| `WCOB_CDN_BASE_URL` | 微信官方 CDN | 媒体 CDN base URL |

## 💬 微信端指令

| 指令 | 说明 |
|------|------|
| `/help` | 显示帮助（`/h` 同义） |
| `/new [标题]` | 新建 OpenCode 会话 |
| `/status` | 查看连接与会话状态 |
| `/model [模型名]` | 列出可选模型或切换当前会话模型（`/models` 同义） |
| `/clear` | 清空并新建当前会话（`/reset` 同义） |
| `/history [n]` | 查看最近 n 条对话，范围 1-20，默认 5 |
| `/compact` | 压缩当前会话上下文 |
| `/undo` | 撤销上一步 |
| `/send <本机文件路径>` | 把本机文件发送到微信 |
| `/ping` | 连通性自检 |
| `/version` | 版本信息 |
| `/cwd` | 查看当前工作目录 |

其他文字消息直接交给 OpenCode。收到的图片/文件/视频/语音会解密后作为附件进入同一会话；OpenCode 回复中若有可访问的本地图片/文件路径，会自动上传 CDN 后发回微信。

终端与微信共用同一会话时，终端提问及其最终回复会同步到微信。同步依赖有效 context token（由微信入站消息刷新并持久化）；长时间没有微信消息导致 token 过期时，在微信发一条消息即可恢复。

## 📁 项目结构

```
src/
├── main.mjs                 # CLI：setup / start / daemon / doctor / status / install-service
├── bridge.mjs               # 核心桥接：monitor 循环、每用户队列、回复发送、会话管理
├── commands.mjs             # 微信斜杠命令路由
├── form-relay.mjs           # 微信会话规则注入与 OpenCode 表单问答转发
├── text-format.mjs          # Markdown → 微信纯文本
├── terminal-sync.mjs        # 终端消息/回复 → 微信（2 秒轮询、按 ID 去重）
├── opencode/
│   └── client.mjs           # @opencode/client 封装（HTTP Basic）
└── ilink/
    ├── client.mjs           # iLink HTTP：长轮询、发送、上传 URL、扫码登录
    ├── media.mjs            # CDN 媒体 AES-128-ECB 加解密与上传下载
    ├── sender.mjs           # 发送：限流、重试、熔断、陈旧会话检测、typing 保活
    └── accounts.mjs         # 账号、sync-buf、context-token 持久化
```

## 🔧 工作原理

```
微信用户发消息
    ↓ getUpdates（长轮询）
iLink 网关
    ↓ 解密媒体 / 组装 prompt
wx-opencode-bridge
    ↓ session.prompt
OpenCode server
    ↓ 完整回复（默认非流式）
wx-opencode-bridge
    ↓ sendMessage（媒体先上传 CDN）
iLink 网关
    ↓
微信用户收到回复

终端消息 ──┐
           ├──→ 同一个 OpenCode 会话 ──→ 轮询 message.list ──→ terminal-sync
微信消息 ──┘                                               ↓
                                          微信收到【终端】/【终端回复】
```

关键设计：

- 每个微信用户 = 一个 OpenCode 会话，映射持久化到 `stateDir/opencode-sessions.json`
- 流式默认关闭；开启时监听 `session.text.delta` 并按间隔合并，`message.list?type=assistant` 作为完成态权威来源
- 入站 CDN 密文用 AES-128-ECB 解密，key 兼容 base64(raw16) / base64(hex32) / 裸 hex；出站先取 `getuploadurl`，加密后 POST 到 CDN
- `message_id` 去重、sync-buf 持久化、token 失效暂停、发送重试与熔断
- OpenCode V2 API 均为扁平输入（`session.create` / `session.prompt` / `message.list` / `event.subscribe`），V1 的 `{ path, body }` 已过时

## ✅ 验证

```bash
cd wx-opencode-bridge
npm test
```

`npm test` 覆盖单元测试与 mock iLink → 桥接 → 真实 OpenCode 的端到端测试。也可单独运行：

```bash
timeout 420 node tests/e2e.mjs
timeout 480 node tests/e2e-features.mjs
```

## 📜 协议与合规说明

本项目直接对接微信 iLink 的 `ilink/bot/*` HTTP 接口，协议实现参考了公开的 `@tencent-weixin/openclaw-weixin` 包，但不依赖该包，也未获得腾讯官方授权或书面许可。使用前请自行确认账号与服务条款风险，包括但不限于账号限制或封禁；作者不对使用该接口产生的后果负责。

仓库内不含任何账号、token 或密码。登录凭据与会话状态只保存在本机 `WCOB_STATE_DIR`，不会进入版本控制。

## License

[MIT](./LICENSE) © 2026 guowunan。许可证仅覆盖本仓库代码，不包含微信或 OpenCode 的商标、协议与服务端资产。
