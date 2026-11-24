// WeChat-side slash commands. Mirrors the command UX of wechat-claude-code
// (src/commands/router.ts) but backed by OpenCode session APIs.

const HELP = `可用命令：
/help                 显示本帮助
/new [标题]           新建 OpenCode 会话
/status               查看连接与会话状态
/model [模型名]        列出可选模型 / 切换当前会话模型（/models 同义）
/clear                清空（新建）当前会话
/history [n]          查看最近 n 条对话
/compact              压缩当前会话上下文
/undo                 撤销上一步
/send <文件路径>       把本机文件发送到微信
/ping                 连通性自检
/version              版本信息
其他文字消息直接发给 OpenCode 处理。`

export async function routeCommand({ text, ctx, log = () => {} }) {
  const raw = (text ?? "").trim()
  if (!raw.startsWith("/")) return { handled: false }

  const space = raw.indexOf(" ")
  const cmd = (space === -1 ? raw.slice(1) : raw.slice(1, space)).toLowerCase()
  const args = space === -1 ? "" : raw.slice(space + 1).trim()
  log(`[cmd] /${cmd} ${args}`.trimEnd())

  try {
    switch (cmd) {
      case "help":
      case "h":
        return { handled: true, reply: HELP }

      case "new":
        return { handled: true, reply: await ctx.newSession(args || undefined) }

      case "status":
        return { handled: true, reply: await ctx.statusText() }

      case "model":
      case "models": {
        if (!args) return { handled: true, reply: await ctx.listModels() }
        return { handled: true, reply: await ctx.switchModel(args) }
      }

      case "clear":
      case "reset":
        return { handled: true, reply: await ctx.newSession() }

      case "history": {
        const n = Number.parseInt(args, 10)
        return { handled: true, reply: await ctx.history(Number.isFinite(n) ? Math.min(Math.max(n, 1), 20) : 5) }
      }

      case "compact":
        return { handled: true, reply: await ctx.compact() }

      case "undo":
        return { handled: true, reply: await ctx.revert() }

      case "send":
        if (!args) return { handled: true, reply: "用法：/send <文件路径>" }
        return { handled: true, sendFilePath: args }

      case "ping":
        return { handled: true, reply: "pong ✅ 微信 ↔ 桥接 ↔ OpenCode 链路正常" }

      case "version":
        return { handled: true, reply: "wx-opencode-bridge v0.2.0 (OpenCode V2 / iLink ClawBot)" }

      case "cwd":
        return { handled: true, reply: await ctx.cwd() }

      default:
        return { handled: true, reply: `未知命令 /${cmd}。发送 /help 查看可用命令。` }
    }
  } catch (err) {
    return { handled: true, reply: `命令执行失败: ${err instanceof Error ? err.message : String(err)}` }
  }
}
