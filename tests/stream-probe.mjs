// Temporary probe: verify V2 SSE streaming events over the real opencode service.
import { createOpenCodeClient } from "../src/opencode/client.mjs"

const c = createOpenCodeClient()
const { id: sid } = await c.session.create({ title: "stream-probe-tmp" })
const ctrl = new AbortController()
const seen = []
const sub = (async () => {
  try {
    for await (const ev of c.event.subscribe({
      types: ["session.text.delta", "session.text.ended", "session.execution.succeeded", "session.idle"],
      signal: ctrl.signal,
    })) {
      if (ev.data?.sessionID && ev.data.sessionID !== sid) continue
      seen.push({ type: ev.type, delta: ev.data?.delta, text: ev.data?.text, at: Date.now() })
      if (ev.type === "session.execution.succeeded" || ev.type === "session.idle") break
    }
  } catch (e) {
    seen.push({ type: "ERROR", error: e.message })
  }
})()
await new Promise((r) => setTimeout(r, 500))
await c.session.prompt({ sessionID: sid, text: "Count from 1 to 3, one number per line, nothing else." })
await Promise.race([sub, new Promise((r) => setTimeout(r, 45_000))])
ctrl.abort()
console.log("events:", JSON.stringify(seen.slice(0, 40), null, 2))
console.log("delta count:", seen.filter((e) => e.type === "session.text.delta").length)
await c.session.remove({ sessionID: sid })
process.exit(0)
