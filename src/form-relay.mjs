// Renders OpenCode form requests into readable WeChat text, and parses a
// WeChat reply back into the answer shape expected by session.form.reply().

export const WECHAT_RULE_PREFIX = "【微信会话规则】"

export const WECHAT_SESSION_RULE = [
  `${WECHAT_RULE_PREFIX}本条回复将通过微信发送，而不是本地终端。`,
  "禁止使用 question 工具或任何需要弹窗 / UI 交互的工具——它们会在 TUI 弹出对话框并挂起会话，导致微信端一直等不到回复。",
  "需要向用户澄清时，直接用普通文字在回复里提问，并等待用户下一条微信消息。",
  "微信气泡只显示纯文本，不渲染 Markdown，也没有真正的字体加粗或颜色，请用排版让重点突出：",
  "分区用 ◆ 作小标题，分区之间用 ━━━ 分隔线；重要结论或数字单独成行、在行首挂一个彩色标签：🔴 表示最重要或核心结论，🟡 表示需要注意的细节，🟢 表示有利或可行的信息。标签含义不限于某个领域，适用于任何主题。",
  "不要用 **、`、# 等 Markdown 符号，也不要用中文粗体字符；简短回复保持自然，不必强行套用分区和分隔线。",
].join("\n")

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"

export function formatFormMessage(form) {
  const lines = ["❓ 需要你确认", ""]
  if (form.title) lines.push(form.title, "")

  for (const [index, field] of (form.fields ?? []).entries()) {
    lines.push(`${index + 1}. ${field.title || field.key}`)
    if (field.description) lines.push(`   ${field.description}`)

    const options = field.options ?? []
    if (options.length) {
      options.forEach((option, optionIndex) => {
        const letter = LETTERS[optionIndex] ?? String(optionIndex + 1)
        const description = option.description ? ` — ${option.description}` : ""
        lines.push(`   ${letter}. ${option.label ?? option.value}${description}`)
      })
      lines.push(field.type === "multiselect" ? "   （可多选，用逗号分隔，如 A, C）" : "   （回复选项字母或文字）")
    } else if (field.type === "boolean") {
      lines.push("   （回复 是/否 或 true/false）")
    } else if (field.type === "number" || field.type === "integer") {
      lines.push("   （回复数字）")
    } else {
      lines.push("   （直接回复文字）")
    }
    lines.push("")
  }

  lines.push("直接回复即可；多个问题请按序号逐行回答。")
  return lines.join("\n").trim()
}

function matchOption(options, token) {
  const raw = String(token ?? "").trim()
  if (!raw) return undefined
  // Accept "A", "A.", "A. 标签", "（A）标签", "1." etc.
  const prefix = raw.match(/^[（(]?([A-Za-z0-9]+)[.、)）]\s*/)
  const cleaned = prefix ? prefix[1] : raw
  for (const candidate of [raw, cleaned]) {
    const found = options.find((option) =>
      String(option.value).toLowerCase() === candidate.toLowerCase()
      || String(option.label ?? "").toLowerCase() === candidate.toLowerCase(),
    )
    if (found) return found.value
  }
  if (/^[A-Za-z]$/.test(cleaned)) {
    const index = cleaned.toUpperCase().charCodeAt(0) - 65
    if (index >= 0 && index < options.length) return options[index].value
  }
  if (/^\d+$/.test(cleaned)) {
    const index = Number(cleaned) - 1
    if (index >= 0 && index < options.length) return options[index].value
  }
  return undefined
}

function parseField(field, line) {
  const options = field.options ?? []

  if (field.type === "multiselect") {
    const tokens = line.split(/[,，、\s]+/).filter(Boolean)
    const values = tokens.map((token) => matchOption(options, token)).filter((value) => value !== undefined)
    if (values.length) return [...new Set(values)]
    return field.default ?? []
  }

  if (options.length && line) {
    const matched = matchOption(options, line)
    if (matched !== undefined) return matched
  }

  if (field.type === "boolean") {
    if (/^(是|yes|true|1|y)$/i.test(line)) return true
    if (/^(否|no|false|0|n)$/i.test(line)) return false
    return typeof field.default === "boolean" ? field.default : false
  }

  if (field.type === "number" || field.type === "integer") {
    const value = Number(line)
    if (line !== "" && Number.isFinite(value)) return field.type === "integer" ? Math.trunc(value) : value
    return field.default ?? 0
  }

  if (line) return line
  if (field.default !== undefined) return field.default
  return options.length ? options[0].value : ""
}

export function parseFormAnswer(form, text) {
  const fields = form.fields ?? []
  const lines = String(text ?? "").split(/\r?\n/)
  const answer = {}
  fields.forEach((field, index) => {
    const line = fields.length === 1 ? String(text ?? "").trim() : (lines[index] ?? "").trim()
    answer[field.key] = parseField(field, line)
  })
  return answer
}
