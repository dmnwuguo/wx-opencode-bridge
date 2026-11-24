// Unit checks for rendering OpenCode forms into WeChat text and parsing replies.
import assert from "node:assert/strict"

import { formatFormMessage, parseFormAnswer, WECHAT_SESSION_RULE } from "../src/form-relay.mjs"

const form = {
  id: "frm_test",
  sessionID: "ses_test",
  title: "澄清需求",
  fields: [
    {
      key: "q1",
      type: "string",
      title: "你指的是哪方面？",
      options: [
        { value: "risk", label: "后续风险与关注点", description: "接下来看什么信号" },
        { value: "final", label: "给个最终结论" },
      ],
    },
    { key: "q2", type: "boolean", title: "需要止损建议？" },
  ],
}

assert.match(formatFormMessage(form), /❓ 需要你确认/)
assert.match(formatFormMessage(form), /澄清需求/)
assert.match(formatFormMessage(form), /1\. 你指的是哪方面？/)
assert.match(formatFormMessage(form), /A\. 后续风险与关注点/)
assert.match(formatFormMessage(form), /2\. 需要止损建议？/)

assert.deepEqual(parseFormAnswer(form, "A\n否"), { q1: "risk", q2: false })
assert.deepEqual(parseFormAnswer(form, "1\n是"), { q1: "risk", q2: true })
assert.deepEqual(parseFormAnswer(form, "A. 后续风险与关注点\nno"), { q1: "risk", q2: false })
assert.deepEqual(parseFormAnswer(form, "给个最终结论"), { q1: "final", q2: false })

const multi = {
  id: "frm_multi",
  sessionID: "ses_test",
  title: "多选",
  fields: [
    {
      key: "tags",
      type: "multiselect",
      title: "选哪些？",
      options: [
        { value: "a", label: "甲" },
        { value: "b", label: "乙" },
        { value: "c", label: "丙" },
      ],
    },
  ],
}
assert.deepEqual(parseFormAnswer(multi, "A, C"), { tags: ["a", "c"] })
assert.match(formatFormMessage(multi), /可多选/)

const numbers = {
  id: "frm_num",
  sessionID: "ses_test",
  title: "数字",
  fields: [
    { key: "n", type: "number", title: "数量" },
    { key: "i", type: "integer", title: "整数" },
  ],
}
assert.deepEqual(parseFormAnswer(numbers, "42\n7"), { n: 42, i: 7 })

const withDefaults = {
  id: "frm_default",
  sessionID: "ses_test",
  title: "默认",
  fields: [
    { key: "pick", type: "string", title: "选择", options: [{ value: "x", label: "X" }] },
    { key: "note", type: "string", title: "备注", default: "无" },
  ],
}
assert.deepEqual(parseFormAnswer(withDefaults, ""), { pick: "x", note: "无" })

const unknown = {
  id: "frm_unknown",
  sessionID: "ses_test",
  title: "自由文本",
  fields: [{ key: "why", type: "string", title: "原因" }],
}
assert.deepEqual(parseFormAnswer(unknown, "因为这样更好"), { why: "因为这样更好" })

assert.match(WECHAT_SESSION_RULE, /question/)
assert.match(WECHAT_SESSION_RULE, /弹窗/)
assert.match(WECHAT_SESSION_RULE, /下一条微信消息/)

// --- WeChat reply layout rules are injected into every prompt ---

assert.match(WECHAT_SESSION_RULE, /纯文本/)
assert.match(WECHAT_SESSION_RULE, /◆/)
assert.match(WECHAT_SESSION_RULE, /━━━/)
assert.match(WECHAT_SESSION_RULE, /🔴/)
assert.match(WECHAT_SESSION_RULE, /🟡/)
assert.match(WECHAT_SESSION_RULE, /🟢/)
assert.match(WECHAT_SESSION_RULE, /单独成行/)
assert.match(WECHAT_SESSION_RULE, /简短回复/)
assert.match(WECHAT_SESSION_RULE, /最重要|核心结论/)
assert.match(WECHAT_SESSION_RULE, /有利|可行/)
assert.doesNotMatch(WECHAT_SESSION_RULE, /支撑/)
