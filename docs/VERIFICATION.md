# 验证记录

本文件记录 **真实执行** 的验证过程与原始输出，不是预期结果。所有数字都来自实际运行。

- 执行时间：2026-10-24 ~ 2026-10-25（UTC+8 深夜）
- 部署环境：Cloudflare Workers 免费版，region 自动分配
- 主域名：`https://pageradar.852367856.dpdns.org`
- 演示域名：`https://demo-pageradar.852367856.dpdns.org`

---

## 1. 构建与类型检查

```
$ node node_modules/typescript/bin/tsc -b
TSC_EXIT=0

$ node node_modules/vite/bin/vite.js build
dist/index.html                   1.14 kB │ gzip:   0.71 kB
dist/assets/index-CAd1e6a4.css   16.40 kB │ gzip:   4.25 kB
dist/assets/index-CNhFVNb8.js   258.59 kB │ gzip:  80.98 kB
✓ built in 1.30s
```

Worker 打包（wrangler 内部 esbuild）：

```
Total Upload: 4.69 KiB / gzip: 1.23 KiB
Worker Startup Time: 6 ms
```

---

## 2. 单元测试（73 个，全部通过）

```
$ pnpm test

 ✓ tests/unit/diff.test.ts      (14 tests) 14ms
 ✓ tests/unit/html.test.ts      (19 tests) 18ms
 ✓ tests/unit/robots.test.ts    (6 tests)  9ms
 ✓ tests/unit/runner.test.ts    (17 tests) 40ms
 ✓ tests/unit/url-guard.test.ts (17 tests) 14ms

 Test Files  5 passed (5)
      Tests  73 passed (73)
   Duration  591ms
```

---

## 3. 线上端到端验证（42 项，全部通过）

```
$ node scripts/verify-live.mjs

✔ 健康检查返回 ok 且数据库已连接 — {"ok":true,"now":"2026-10-24T22:29:47.021Z","version":"1.0.0","db":"connected"}
✔ 前端页面可访问且含应用挂载点 — HTTP 200, 982 bytes
✔ 未携带令牌访问被拒绝 (401) — HTTP 401
✔ 伪造令牌被拒绝 (401) — HTTP 401
✔ 可以创建工作区并获得令牌 — token=pr_bEmwrlKmS…
✔ 有效令牌可以列出（空）监控列表
✔ 配额信息一并返回 — {"checksLimit":200,"monitorsLimit":5,"snapshotsLimit":500,"retentionMaxDays":30}
✔ 10 种 SSRF 攻击向量全部被拒绝 — all 4xx
✔ 非法检查间隔被拒绝 (422) — HTTP 422 invalid-interval
✔ 缺少名称被拒绝 (422)
✔ 可以添加公开页面监控 — monitor=680107c1…
✔ 同一工作区重复添加同一 URL 被拒绝 (409) — HTTP 409 duplicate-url
✔ 首次手动检查建立基线快照 — {"status":"first","httpStatus":200}
✔ 内容未变时返回 nochange — {"status":"nochange","httpStatus":200,"durationMs":458}
✔ 历史快照可读取 — 1 个快照
✔ 详情包含配额、运行记录与时间线数据
✔ 快照内容包含页面正文 — 固定内容 这一页的正文永远不会变化…
✔ 无变化时重复检查不新增快照（幂等） — 1 → 1
✔ 页面内容真实变化时生成快照与差异 — first=first second=changed diff=+29/-48
✔ 差异操作序列包含 add 与 del — ops=3
✔ 历史里有 2 份快照 — 2 个
✔ 404 页面返回可理解的错误 — 服务器返回 HTTP 404（页面不存在）
✔ 403 页面返回可理解的错误 — 服务器返回 HTTP 403（拒绝访问…）
✔ 慢响应触发超时保护并给出可理解错误 — 11008ms · 请求超时（超过 10000 毫秒没有响应）
✔ 正常的 2 跳重定向能被正确跟随 — {"status":"first","httpStatus":200}
✔ 重定向到云元数据地址被拦截（逐跳校验）— 不允许直接使用 IP 地址作为监控目标
✔ 非 HTML 内容被拒绝并说明原因 — 返回的内容不是网页文本（Content-Type: application/json）
✔ 空正文给出可理解提示 — 页面提取到的正文为空（可能是纯 JS 渲染…）
✔ 监控状态包含最近检查与下次检查时间 — last=2026-10-24T22:30:50.247Z next=2026-10-24T22:35:50.247Z
✔ 可以暂停监控
✔ 可以恢复监控
✔ 可以编辑名称与间隔
✔ Webhook 配置被接受且检查本身正常完成 — {"status":"first"}
✔ Webhook 地址在响应中已脱敏 — https://httpstat.us/500…
✔ 其他工作区无法读取本工作区的监控 (404) — HTTP 404
✔ 其他工作区无法删除本工作区的监控 (404) — HTTP 404
✔ 其他工作区的列表不包含本工作区数据
✔ 超长名称被拒绝 (422)
✔ 非法 JSON 被拒绝 (422) — HTTP 422
✔ 非法选择器不会导致 500（错误被结构化）— HTTP 200
✔ 可以删除监控
✔ 删除后无法再读取

42/42 passed
```

---

## 4. Cron 定时任务真实验证

### 方法

1. 创建一个监控，目标为 `https://demo-pageradar.852367856.dpdns.org/alternating`（每 30 秒翻转内容）
2. 间隔设为 5 分钟
3. **只手动触发一次**建立基线，之后完全不管它
4. 每 5 分钟通过 API 读一次 `lastCheckAt` / `lastStatus` / `runs`

### 观测结果

| 时间（UTC） | 触发来源 | lastStatus | 快照数 |
| :--- | :--- | :--- | :--- |
| 22:31:35 | 创建时排入队列 | — | 0 |
| 22:35:50 | **Cron（`*/5 * * * *`）** | `first` | 1 |
| 22:40:50 | **Cron** | `changed` | 2 |

第二次长时间观测（另一个工作区、另一个监控，目标 `/alternating` 每 30 秒翻转）：

| 时间（UTC） | 触发来源 | lastStatus | 快照数 |
| :--- | :--- | :--- | :--- |
| 23:06:31 | 手动（建立基线） | `first` | 1 |
| 23:15:50 | **Cron** | `changed` | 2 |

两次观测的 `lastCheckAt` 都精确落在 `*/5 * * * *` 的整点上，且状态从 `first` 自然演进为 `changed`
（`/alternating` 每 30 秒翻转内容，所以任何两次间隔 5 分钟的抓取几乎必然不同）。

原始查询输出：

```
$ node tmp-probe/cron-check.mjs

lastCheckAt 2026-10-24T23:15:50.247Z
lastStatus changed
nextCheckAt 2026-10-24T23:20:50.247Z
snapshots 2
 run 2026-10-24T23:15:50.247Z changed 200
 run 2026-10-24T23:06:31.859Z first 200
```

**结论**：

- `lastCheckAt` 精确落在 5 分钟整点（:35:50 / :40:50 / :15:50），与 `*/5 * * * *` 触发时间 + 处理耗时一致
- `lastStatus` 从 `first` → `changed`，说明 Cron 执行时内容确实变了并写入了新快照
- 整个过程除建立基线外没有任何手动请求，浏览器全程关闭
- `nextCheckAt` 自动递进到下一个 5 分钟整点，说明排期链路闭合

> 补充：第一次观测 23:06 建立基线后，23:11 那个槽位没有记录 —— 因为 `next_check_at` 是 `23:11:31`，
> 而 Cron 在 `23:10:00` 和 `23:15:00` 唤醒时它还没到期，`23:15:00` 那次唤醒时它已到期，于是在 `23:15:50` 执行。
> 这是「槽位对齐 + 只处理已到期任务」的正常表现，不是丢任务。

### 幂等验证

对静态页 `/static` 连续手动检查 3 次：

```
基线   snapshots = 1
第 2 次 snapshots = 1  (nochange)
第 3 次 snapshots = 1  (nochange)
```

---

## 5. SSRF 防护逐项验证

线上直接对生产接口发起，10 个向量全部返回 4xx：

| 输入 | 结果 |
| :--- | :--- |
| `http://127.0.0.1/` | 422 `ipv4-loopback` |
| `http://169.254.169.254/latest/meta-data/` | 422 `ipv4-link-local` |
| `http://10.0.0.1/` | 422 `ipv4-private` |
| `http://192.168.1.1/` | 422 `ipv4-private` |
| `http://172.16.0.1/` | 422 `ipv4-private` |
| `http://localhost:8080/` | 422 `blocked-hostname` |
| `http://2130706433/` | 422 `ipv4-loopback`（十进制归一化后命中） |
| `http://[::1]/` | 422 `ipv6-private` |
| `file:///etc/passwd` | 422 `bad-scheme` |
| `http://metadata.google.internal/` | 422 `blocked-hostname` |

**恶意重定向**（最容易被漏掉的一类）：

监控 `https://demo-pageradar.852367856.dpdns.org/to-metadata`：

```
POST /api/monitors/:id/check
→ { "ok": false, "status": "error",
    "error": "不允许直接使用 IP 地址作为监控目标。" }
```

第一跳（demo 域名）合法并通过校验；服务器返回 `302 Location: http://169.254.169.254/latest/meta-data/`；
Worker 用 `redirect: 'manual'` 收到 302 后，**对 Location 重新做完整校验**，命中 IP 字面量规则被拒绝。
如果用了 `redirect: 'follow'`，这一跳就会打到元数据服务并可能泄露 IAM 凭据。

---

## 6. 开发过程中发现并修复的真实 Bug

诚实记录，因为这类问题恰恰说明「真跑一遍」的价值。

### Bug 1：`<meta>` 空元素吞掉整个页面（严重）

**现象**：所有真实网页都返回「正文为空」。

**原因**：HTML 解析器里 `SKIP_TAGS` 包含 `meta` / `link`，跳过逻辑假设这些标签有闭合标签，
用 `indexOf('</meta>')` 找结尾 —— `<meta charset="utf-8">` 没有 `</meta>`，
于是 `indexOf` 返回 -1，代码把 `i = len`，直接吃掉了文档剩余全部内容。

**修复**：跳过前先判断 `selfClosing || VOID_TAGS.has(tag)`，是空元素就只跳过标签本身。

**回归测试**：`tests/unit/html.test.ts` → 「空元素（meta/link/br/hr）不会吞掉后续内容」、
「没有 `</head>` 的畸形页面也能解析出正文」。

这个 bug 单元测试没抓到，因为测试夹具都是手写的最小 HTML，没有 `<meta>` 和 `<link>`。
是上线后对真实页面跑验证才暴露的。

### Bug 2：`<title>` 提取失效

**现象**：`parseHtml().title` 恒为空。

**原因**：`title` 在 `SKIP_TAGS` 里，被整段跳过，但取标题的代码又依赖它成为节点。

**修复**：把 `title` 从 `SKIP_TAGS` 移除，解析完成后再从树里取文本并规范化。

### Bug 3：主 Worker 抓自己 → 522

**现象**：监控自托管的 `/demo/ticker` 恒返回 522。

**原因**：Worker A 通过公开域名请求自己，形成 Worker 子请求递归，Cloudflare 直接拒绝。

**修复**：把演示页拆成独立 Worker + 独立域名（`demo-worker/`）。这也是最终架构的一部分。

### Bug 4：Webhook 脱敏不彻底

**现象**：`https://httpstat.us/500` 脱敏后仍是完整明文。

**原因**：只在路径长度 > 6 时才追加省略号，短路径原样返回。

**修复**：无条件追加 `…`，路径只保留前 6 字符。

### Bug 5：CI 里 pnpm 版本冲突

**现象**：GitHub Actions 在 `pnpm/action-setup` 步骤直接失败。

**原因**：`package.json` 的 `packageManager` 与 workflow 里 `version: 10` 冲突，
报 `ERR_PNPM_BAD_PM_VERSION`。

**修复**：workflow 去掉 `version`，改为 `run_install: false`，让 action 读 `packageManager` 字段。

---

## 6.5 令牌重新进入 + 演示数据（新增功能验证）

用户反馈了两个可用性问题：① 退出工作区后找不到输入令牌的地方；② 不知道该填什么规则，
需要演示数据。为此新增了两个能力，并做了 API + 界面两层验证。

### API 层：`node scripts/verify-session-demo.mjs` → 21/21

```
✔ 创建工作区返回令牌 — pr_5dIdP4m…
✔ 用已有令牌可以重新进入同一工作区 — {"id":"84a50545-…","tokenPrefix":"pr_5dIdP4m2i","onboarded":false}
✔ 多次重新进入得到同一个工作区 id — 84a50545…
✔ 不存在的令牌被拒绝 (401) — 这个令牌不存在或已被删除。请检查是否复制完整（包括开头的 pr_）。
✔ 格式非法的令牌被拒绝 (422) — bad-token-format
✔ 缺少令牌字段被拒绝 (422)
✔ 令牌前后的空白被自动清理 — HTTP 200
✔ 可以预览演示数据内容 — 3 个
✔ 演示条目带有可照抄的规则配置 — #content · 演示 · 库存价格看板（会自然变化）
✔ 演示条目指向真实可访问地址 — https://demo-pageradar.852367856.dpdns.org/
✔ 可以一键加载演示数据 — created=3
✔ 演示监控带 isDemo 标记（可一键清除） — 3 个
✔ 演示监控名称可辨识
✔ 演示监控自带提取规则
✔ 重复加载演示数据被拒绝 (409) — demo-exists
✔ 演示监控可以对演示页发起真实检查 — first · http=200
✔ 可以一键清除演示数据 — removed=3
✔ 清除后演示监控不再存在
✔ 清除演示数据不会误删用户自己的监控 — 保留 我自己的监控
✔ 演示机制未绕过 SSRF 校验 — HTTP 422
✔ 被拒绝的请求没有创建任何监控 — 0 → 0
```

### 界面层：`node scripts/verify-ui-session-demo.mjs` → 18/18

真实浏览器操作（桌面 1366×940 + iPhone 13 视口）：

```
✔ 落地页默认展示「已有令牌，进入工作区」
✔ 落地页有令牌输入框
✔ 创建工作区后展示令牌 — pr_78btjSv…
✔ 令牌面板提供复制按钮
✔ 令牌面板提供下载 txt 按钮
✔ 令牌可以下载为 txt 备份 — pageradar-token-pr_78btjSvxW.txt
✔ 进入工作区后可见演示数据引导横幅
✔ 加载演示数据后列表出现 3 个监控 — 3 个
✔ 列表里演示监控有「演示」标记
✔ 演示监控可以手动检查并立即出结果
✔ 退出后回到进入页并默认停在「已有令牌」
✔ 粘令牌可以回到同一个工作区（数据都在）— 3 个监控
✔ 错误令牌显示可理解的错误提示
✔ 清除演示数据后列表为空 — 0 个监控
✔ [移动] 进入页无横向溢出 — 390 <= 390
✔ [移动] 令牌输入框可见
✔ [移动] 输入框宽度适配小屏 — 310px
✔ [移动] 加载演示数据后仍无横向溢出 — 390 <= 390
```

### 这一轮修复的 bug

`DELETE /api/demo/sample` 原本直接返回 D1 的 `meta.changes`。D1 会把**外键级联删除的子行**
（快照、check_runs）也计入 `changes`，于是「删了 3 个演示监控」返回 `removed=5`，
界面提示「已清除 5 个演示监控」——数字是错的。改为先 `countDemoMonitors()` 再删，返回真实数量。
验证里第 17 项 (`removed=3`) 就是这条的回归测试。

---

## 7. 手机端 / 桌面端

| 项目 | 方法 | 结果 |
| :--- | :--- | :--- |
| 桌面 1366×940 | Playwright 截图 | 四区域布局正常，无横向滚动 |
| iPhone 13（390×844） | Playwright `devices['iPhone 13']` | 单列堆叠，顶部 𝕏 入口收成图标，33×33 |
| 深色模式 | `emulateMedia({ colorScheme: 'dark' })` | 背景 `#0b0d11`，文字对比度正常 |
| 键盘 | Tab / Esc | 弹窗可 Esc 关闭，按钮可 Tab 聚焦 |

截图见 `docs/screenshots/`。

---

## 8. 资源占用（Cloudflare 免费额度内）

| 指标 | 观测值 | 免费额度 |
| :--- | :--- | :--- |
| Worker startup time | 6 ms | — |
| Worker bundle | 4.69 KiB（gzip 1.23 KiB） | 3 MiB |
| 单次抓取耗时 | 400 ms ~ 1.2 s（不含超时用例） | CPU 10 ms/请求（Wall clock 无限制） |
| D1 数据库体积 | < 1 MB（测试数据） | 5 GB |
| Cron 触发 | 每 5 分钟 = 288 次/天 | 免费 |

> 注意：Worker 免费版的 CPU 时间限制是 **10 ms/请求**。本项目的抓取是 **I/O 等待**（不计入 CPU），
> 但 HTML 解析与差异计算是 CPU 工作。对超大页面（接近 2 MB）的解析可能接近限制。
> 付费版（$5/月）给 30 秒 CPU，可以完全消除这个风险。这是当前架构下最现实的成本约束。

---

## 9. 复现全部验证

```bash
# 单元测试
pnpm test

# 线上验证（需要先部署）
node scripts/verify-live.mjs https://your-domain.example.com https://demo.your-domain.example.com

# 重新生成截图（需要部署 + Playwright）
node scripts/shoot.mjs https://your-domain.example.com
```
