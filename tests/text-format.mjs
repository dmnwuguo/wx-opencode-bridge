import assert from "node:assert/strict"

import { formatForWeChat } from "../src/text-format.mjs"

assert.equal(formatForWeChat("**加粗** 和 `代码`"), "加粗 和 代码")
assert.equal(formatForWeChat("## 标题\n正文"), "标题\n正文")
assert.equal(formatForWeChat("```js\nconst a = 1\n```"), "const a = 1")
assert.equal(formatForWeChat("[文档](https://x.com)"), "文档 (https://x.com)")
assert.equal(formatForWeChat("---\n分割"), "分割")
assert.equal(formatForWeChat("普通中文，带标点。\n- 列表一\n- 列表二"), "普通中文，带标点。\n- 列表一\n- 列表二")
assert.equal(
  formatForWeChat("```python\n# 注释\nkwargs = {\"**\": \"x\"}\nurl = \"a__b\"\n---\n```"),
  "# 注释\nkwargs = {\"**\": \"x\"}\nurl = \"a__b\"\n---",
)
