// Convert assistant Markdown to plain text that reads well in WeChat.
// WeChat's chat bubbles don't render Markdown, so strip the markup while
// keeping the human-readable content intact.

export function formatForWeChat(text) {
  if (!text) return ""
  let insideFence = false
  return String(text)
    .split("\n")
    .map((line) => {
      // Fenced code blocks: drop the fence line, keep the code verbatim.
      if (/^\s*```/.test(line)) {
        insideFence = !insideFence
        return null
      }
      if (insideFence) return line
      // Horizontal rules become noise.
      if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) return null
      // Headings and blockquotes: keep the content, drop the marker.
      line = line.replace(/^\s*#{1,6}\s+/, "").replace(/^\s*>\s?/, "")
      // Inline emphasis / code / links.
      line = line.replace(/\*\*|__/g, "").replace(/`+/g, "")
      line = line.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
      return line
    })
    .filter((line) => line !== null)
    .join("\n")
}
