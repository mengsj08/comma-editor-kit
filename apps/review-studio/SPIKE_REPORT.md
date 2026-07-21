# SKL-20 Spike Report — md 协同改稿编辑器（从 kanban 详情页抽取）

> 结论先行：**可行，值得继续集成。** 把 kanban 详情页的 md 编辑/预览/评论/AI 前端抽成独立文档编辑器，成本集中在 `render-detail.js`（卡片逻辑重写），而两个真正难的部件——markdown 渲染器（`markdown.js`）和评论锚点算法（`ai.js` 内 135 行）——几乎零改动复用。四个未知数全部实测有答案。

所有断言带 `file:line` 或命令输出。测量脚本 `test_headless.py`（真实 chromium，无头），原始结果 `test_results.json`，截图 `data/screenshot_editor.png`。

启动命令与 URL 见文末第 7 节。

---

## 1. 四模块的真实依赖与最小端点清单

原模块通过 `main.js:135-148` 装配的共享 `ctx` 通信（模块间不互相 import，全靠 `ctx.*` 和挂 `window` 的少数入口）。

| 模块 | 原行数 | 真实依赖（doc 模式需要的） | 调的 `/api/*`（doc 模式需要的） | doc 模式最小端点 |
| --- | --- | --- | --- | --- |
| `markdown.js` | 1237 | `ctx.ui.{esc,toast}`、`ctx.el.{lightbox*,detailEditor,detailMdContent,detailEditMode,newProject,fm*}`、`ctx.dataState.tasks`、`ctx.uiState.{detail,fileMention,ai,pendingUploadTasks}`、`ctx.api.openInEditor`、`ctx.renderDetail.*`、`ctx.ai.{resolveBodyQuoteTarget,jumpToBodyQuote}`；CDN: marked/highlight/mermaid | 仅在可选子系统里：`/api/file`（图片代理）、`/api/search-files` + `/api/file-exists`（@文件提及）、`/api/prepare-upload`（图片上传） | **0 个必需**（渲染纯 DOM）。图片/公式/表格/代码/mermaid 全部本地渲染 |
| `api.js` | 580 | 只有 `apiJson` 包裹模式可复用；其余 30+ 方法（automations/governance/handoff/bridges/promote）全是看板专用 | `/api/update-body`(存文档)、`/api/task`(读)、`/api/task-comments`+`/api/comments*`(评论) 是唯一与 doc 相关的形状 | `GET/PUT /api/doc`、`GET/POST/PUT/DELETE /api/comments` |
| `render-detail.js` | 2474 | 深度绑卡片：完成标准置顶、晋升/交接、landing、ledger、状态机；只有「评论侧栏渲染 + saveBody」概念可迁移 | `/api/update-body`(saveBody, `render-detail.js:2275`)、`/api/task-comments`(`:203`)、`/api/comments/edit`(`:148`) | 同上，逻辑需**重写**（不是抽取） |
| `ai.js` | 2572 | 绝大部分是卡片 AI 对话/队列/线程树；**锚点算法块（`:124-262`，135 行）是唯一可复用的核心资产** | 卡片 AI：`/api/ai-run`、`/api/ai-result(s)`、`/api/ai-comment`、`/api/ai-kill`、`/api/queue*` | doc 模式只留可选 `POST /api/ai-run` |

薄后端 `server.py`（335 行，纯标准库，绑 `127.0.0.1`）实现的最小端点集：`GET /api/doc`、`PUT /api/doc`（原子写 + 乐观并发 base_rev）、`GET/POST/PUT/DELETE /api/comments`（sidecar `<doc>.comments.json`）、`POST /api/ai-run`（可选）。写接口带同源守护（`server.py:_guard`，镜像 kanban 的 `_state_change_guard`）。

### 被砍端点 → 前端降级方式（诚实清单）

| 前端本要的端点 | doc 模式处理 | 降级后果 |
| --- | --- | --- |
| `/api/search-files`、`/api/file-exists` | 未实现 | `@文件提及`下拉失效——`markdown.js` 的 fileMention 子系统（644 行，`:538-1181`）在 doc 模式是死代码；`[[路径]]` 链接不渲染。改稿场景不需要 |
| `/api/prepare-upload` + 存储 POST | 未实现 | 粘贴图片上传失效（80 行上传逻辑 `:752-838` 死掉）。论文改稿以文字为主，可后补 |
| `/api/file`（本地图片代理） | 未实现 | markdown 里的**本地相对路径图片**不显示；外链/data: 图片正常。真 run 的图基本是外链或需另接 |
| `/api/ai-run`（卡片版，带队列/线程/apply） | 简化成单发 `claude --print` | 无并发队列、无线程树、无 @文件、无 ai-apply 自动改稿。够 spike 验证「能接通」 |

---

## 2. 每模块保留/删除行数（抽取成本）

命令核验：`diff -q vendor-ref/markdown.orig.js static/markdown.js` → **BYTE-IDENTICAL**。

| 模块 | 原行数 | 本原型做法 | 复用/新增行数 |
| --- | --- | --- | --- |
| `markdown.js` | 1237 | **原样复制，0 改动**（`static/markdown.js` 与原仓字节相同），靠 ~40 行 `ctx` shim 驱动 | 复用 1237 / 0 删除源码；其中 fileMention 644 行 + 上传 80 行在 doc 模式为死代码（保留不碍事，可选删） |
| `ai.js` 锚点块 | 2572 | 外科抽取 `:124-262`（`normalizedQuoteText`/`bodyQuoteBlocks`/`chooseSourceQuoteIndex`/`resolveBodyQuoteTarget`/`jumpToBodyQuote`/`sourceQuoteFromSelection`），逻辑**逐字保留**，只换 ctx 装配 → `static/anchor.js` 137 行 | 复用 ~135 / 删除 ~2437（卡片 AI 全弃） |
| `render-detail.js` | 2474 | 不抽取；doc 模式的评论侧栏 + 编辑/保存在 `app.js` 内**重写** | 复用 0 / 概念参考（saveBody 契约、评论卡结构） |
| `api.js` | 580 | 不抽取；`app.js` 里 15 行 `apiJson` 重实现 | 复用 0 / 借鉴 apiJson 模式 |

新增/改写代码：`app.js` 381、`anchor.js` 137、`editor.html` 83、`editor.css` 90、`server.py` 335（`wc -l` 实测）。

**抽取成本判词**：markdown.js = 便宜（字节级复用 + shim）；ai.js 锚点 = 中（135 行外科抽取）；render-detail.js / api.js = 贵（卡片语义太重，重写比抽取快）。总的独立编辑器 = 约 1026 行新代码（含后端）即可跑起来，其中真正的技术难点由复用覆盖。

---

## 3. 性能实测（`test_results.json` → `render`）

素材：`data/paper.md`，**3413 行 / 189KB**，含 61 处行内公式源、30 段 `$$` 公式、15 张表、15 个代码块、120 个三级标题（`gen_paper.py` 生成，确定性可复现）。

| 指标 | 实测值 |
| --- | --- |
| 首屏全量加载（含 CDN 下载 + 解析 + 渲染，navigation→`.katex` 可见） | **1281 ms** |
| 隔离重渲染（marked 解析 + KaTeX + DOM 构建，排除 CDN 下载），5 次中位 | **27 ms**（样本 25–28 ms） |
| 渲染出的块元素（p/li/h/td/pre） | 1906 |
| KaTeX 公式渲染数 / 报错数 | 106 / **0** |
| 表格 / 代码块 | 15 / 15 |
| 控制台错误 | **0** |

结论：3400 行长稿首屏 1.3 秒内可交互，纯渲染 27ms，无需虚拟滚动/分块。marked+KaTeX 在这个体量下不是瓶颈。

---

## 4. 编辑保存往返 & 锚点稳定性（`test_results.json`）

### 4a. 保存往返是否丢格式 —— 不丢
`edit_roundtrip`：`save_ok=true`、`byte_fidelity_after_reread=true`（存盘后重读与写入字节相同）、`new_rev_differs=true`。body 即整份 markdown 源，`PUT /api/doc` 原子写（tmp+`os.replace`，`server.py:_atomic_write`）+ base_rev 乐观并发。**LaTeX/表格/代码块无损**。

### 4b. 锚点稳定性 —— 唯一文本 5/5 稳；重复短语是失效模式
测法（`test_headless.py`）：真实 chromium 里对 5 个**唯一**正文片段建 DOM Range，走 `sourceQuoteFromSelection(text, range)`（与真实划词流程一致，填 `block_index`），`POST /api/comments`，再解析。

| 阶段 | resolved | correct（解析到的块确含该引文） |
| --- | --- | --- |
| 建锚基线（5 条，全唯一） | 5/5 | 5/5 |
| **上游插入一大段 + 删除一段后** | **5/5** | **5/5** |
| 失效模式：改写其中 1 条被引原文 | 4/5 resolved，被改那条**正确失效** | — |

锚点机制（`ai.js:166 resolveBodyQuoteTarget`）= 引文文本匹配 + `block_index` + `occurrence_index` + prefix/suffix 上下文打分（`ai.js:136 chooseSourceQuoteIndex`，各 160 字符窗口），**不是行号/字节偏移**，所以上游增删段落不影响下游锚点。改稿工具最关键的属性成立。

**诚实缺陷（第一轮实测抓到）**：解析器对**歧义（重复文本）会拒绝猜测、返回 null**。当被引片段在文中出现多次且 `block_index` 因上游结构编辑而过期时，会失效。表现为：
- 唯一片段（整句/整段）→ 稳。
- 短重复短语（如反复出现的模板句）→ 上游编辑后可能失效标「锚点失效」。
这对论文改稿多为整句/整段批注，实际影响小；但产品化需补**软失效 UI**（保留快照 + 提示「原位置已变化」，原仓已有此降级路径 `markdown.js:700`）。

事件台账 `data/edits.events.jsonl`（append-only，记 actor+时间+摘要）在测试中被真实写入 15 条（save-doc / add-comment / edit-comment / ai-run）。

---

## 5. KaTeX 结论 —— 可行，走 marked 扩展而非 auto-render

`katex`：106 条公式渲染、**0 报错**；样例 `C=∑ipi⋅ui`（源 `C = \sum_{i} p_i \cdot u_i`）渲染正确（截图可见摘要块行内公式）。

实现要点（`app.js:installMathExtension`）：**不能**用 `renderMathInElement` auto-render——marked 会先把 `f_\theta` 的下划线解析成 `<em>`、`$...$` 里的内容被 markdown 破坏。改用 **marked 行内/块级扩展**（`$...$` / `$$...$$` 各一个 tokenizer→`katex.renderToString`），在 marked 解析阶段就接管数学片段，绕开强调符冲突。这是把 KaTeX 加进 kanban markdown.js 的正确接法（kanban 现无公式渲染，属**新增能力**，非移植）。

---

## 6. 嵌入 academic-paper-review-workbench 的缺口清单 + 工作量

宿主契约现状（`~/skills/skills/academic-paper-review-workbench/`）：评审跑完产出 `runs/<id>/result.md`（`references/runtime-contract.md:41`），嵌套 Codex 跑 `--sandbox read-only --ephemeral`（`SKILL.md:38`）。

### 必须 June 显式入账的两条契约变更
1. **撤销「禁 manuscript rewriting」**：`SKILL.md:45` 明列 *"Do not replace this flow with ... manuscript rewriting ..."*。协同改稿工作台本质就是 manuscript rewriting，需 June 显式撤销/加例外，否则违反宿主 v1 边界。
2. **改稿阶段给 run 目录写权限**：评审阶段 read-only（`SKILL.md:38`）是安全不变量；协同改稿要能存 `result.md` 修订 + `<doc>.comments.json` sidecar + 事件台账，需在**改稿阶段**（评审后）解除 run 目录 read-only。建议分相：评审=read-only，改稿=对该 run 目录可写、其余仍限。

### 工程缺口与工作量估计
| 缺口 | 说明 | 估计 |
| --- | --- | --- |
| 后端合流 | 把 `server.py` 的 doc/comments/events 端点并进 workbench 的 `scripts/workbench.py`（同为 stdlib localhost）；或作为它拉起的独立模块 | 0.5–1 天 |
| 打开真 result.md | doc 路径从 `runs/<id>/result.md` 载入；沿用现有 run 目录布局 | 0.5 天 |
| 评论/事件落 run 目录 | sidecar + `edits.events.jsonl` 写进 `runs/<id>/`，与 `run.json` 台账并存 | 0.5 天 |
| 嵌套 AI 改稿 | 复用 workbench 的 Codex 启动器做「按批注改稿」，但需写权限（见契约变更 2）+ ai-apply 回写 | 1–2 天 |
| 软失效 UI + 重复锚点 | 补锚点失效提示（原仓 `markdown.js:700` 已有降级可借） | 0.5 天 |
| 图片/上传（如需） | 接 `/api/file` + `/api/prepare-upload` | 1 天（可延后） |

合计约 **3–5 人天**到可用 MVP（不含图片上传）。技术风险低——难点部件已在本 spike 验证。

---

## 7. 启动命令与 URL

Historical June-local spike path:

```bash
cd /Users/a1234/Documents/TaskSpace/_projects/md-collab-editor-spike
SPIKE_PORT=8891 python3 server.py           # 纯标准库，绑 127.0.0.1
# 浏览器打开：
#   http://127.0.0.1:8891/?doc=paper.md
```

无头复验（历史记录使用 June 本机 kanban .venv，内含 playwright+chromium）：
```bash
VENV=/Users/a1234/Documents/AI-Agent-Hub/kanban-personal/shared/toolkit/kanban/.venv
SPIKE_PORT=8891 $VENV/bin/python test_headless.py     # 打印 test_results.json 同款指标
```
生成/再生素材：`python3 gen_paper.py > data/paper.md`（确定性 3413 行）。
AI 端点：本机有 `claude` 时走真 `claude --print`（实测返回 `PONG`，非桩）；无则返回 stub 并如实标注。

---

## 附：kanban 仓零改动核验
本 spike 全程只读复制 kanban 源码到 `vendor-ref/` 与 `static/markdown.js`，原仓一字节未动。历史 June-local 收尾核验命令 `git -C /Users/a1234/Documents/AI-Agent-Hub/kanban-personal status --short` 输出为空（见执行报告）。

---

# 第二轮迭代（2026-07-10 · June 试用反馈）

按 June 两条反馈迭代：① AI 运行接 Codex CLI；② 编辑模式从「跳回 Markdown 源码」改成 Typora 式块级就地编辑。两条都真跑验证，证据在 `test_headless.py`（原测，仍绿）+ 新增 `test_blocks.py`。

## 8. AI 运行接入 Codex CLI（`server.py:_ai_run`）

`/api/ai-run` 加 `tool` 参数（`claude|codex`，缺省 `claude`）。前端 AI 面板加单选切换（`editor.html` `.ai-tool-row`）。两个 CLI **各真跑一次**（经端点，非桩），命令行/退出码/耗时如实记录：

| tool | 实际命令 | 退出码 | 耗时 | 输出（截断） |
| --- | --- | --- | --- | --- |
| claude | `claude --print <prompt>` | 0 | 10435 ms | "Section 1 introduces the paper's aim of building provenance-aware orchestration…" |
| codex | `codex exec --sandbox read-only --skip-git-repo-check --color never -C <data 目录> --output-last-message <tmp> <prompt>` | 0 | 34902 ms | "Section 1 introduces reproducible multi-agent pipelines." |

事件台账实录（`data/edits.events.jsonl`）：`[claude rc=0 10435ms]` / `[codex rc=0 34902ms]` 各一条。codex 用 `--output-last-message` 取「仅最终消息」，绕开 v0.144 的 preamble（session id / tokens used 等），输出干净。`stdin=subprocess.DEVNULL` 防 codex 阻塞读 stdin。

### 安全默认（分发场景定调，与 June 个人看板不同 —— 重要）
- **本 spike（面向分发/嵌入宿主）**：codex 一律 `--sandbox read-only`，cwd 用 `-C` 限定在文档工作目录；`server.py:_assert_no_dangerous_flags` 硬拒 `--yolo` / `--dangerously-*` / `danger-full-access` / `bypass-approvals` 任一子串（单元测试三条拒绝 + 一条安全 argv 放行，全绿）。
- **June 个人看板（`.kanban.config.json`，可信本机）**：`codex exec --yolo --json` + `claude --print --dangerously-skip-permissions`（全权限、无沙箱）。
- 差异原因：个人本机 June 已授信；协同改稿工作台会被分发/多人用，默认必须收紧。**集成时若允许「按批注改稿」写回，需从 read-only 升到 `workspace-write` 并限定 run 目录（见第 6 节契约变更 2），仍禁 bypass 类旗子。**

## 9. 块级就地编辑（Typora 式，`static/app.js`）

去掉「点编辑→整篇跳源码」的模式切换，默认路径改成：**点任一渲染块 → 该块原地变 textarea（内容=该块 md 源码）→ blur 或 Cmd/Ctrl+Enter 提交 → PUT `/api/doc`（base_rev 乐观锁）→ 整篇重渲染**。原「编辑」按钮改名「源码」，保留为整篇源码模式的后备入口。

### 实现要点
- **源码区间**：`window.marked.lexer(body)` 拿顶级 token，`token.raw` 累计偏移即每块在源串中的字节区间。实测 `token.raw` 拼接**逐字节等于源串**（189434 == 189434，`test_blocks.py::lexer_reconstruction`），故偏移math精确、splice 可靠。2792 token → 1489 个可编辑块。
- **渲染**：每个顶级块渲进独立 `<div class="doc-block" data-block-index=i>`，复用 `markdown.js` 的 `renderMarkdownEnhanced`（KaTeX/表格/代码块/mermaid 均在块内本地渲染）。数学块 `$$…$$`、代码块、表格编辑时看到的都是该块源码，离开即重渲染。
- **提交/放弃**：blur 或 `Cmd/Ctrl+Enter` = 提交（把新源码 splice 回源串该区间）；`Esc` = 放弃本块；`Cmd/Ctrl+Enter` 额外在其后生成新空段落编辑器（「接着写」）；空块 `Backspace` = 删除该块。整篇重渲染 41ms（块模式 1489 wrapper；扁平模式 28ms 见第 3 节），首屏 1227ms。
- **点击 vs 划词消歧**：光标折叠（纯点击）→ 就地编辑；有选区 → 走「加批注/问 AI」popover。互不打架。

### 字节保真证据（provenance 要求 —— diff 证明）
`test_blocks.py::byte_fidelity`：对第 749 块（paragraph）就地追加 " EDITED-BY-TEST"（15 字符）后 GET 文档：

| 断言 | 值 |
| --- | --- |
| `only_this_block_changed`（改后源串 == 原串仅该区间替换） | **true** |
| `prefix_bytes_identical`（该块之前所有字节不变） | **true** |
| `suffix_bytes_identical`（该块之后所有字节不变） | **true** |
| `delta_chars`（全文字节变化量） | **+15**（恰为插入串长度，无其它漂移） |

即：改一段，其余部分与改前**逐字节相同**。乐观锁 base_rev 冲突返回 409 且不覆盖（resync 到磁盘副本）。

### 评论锚点在被编辑块上的行为（如实测试）
`test_blocks.py::comment_on_edited_block`：在某块建批注（锚定其正文）→ 把该块整段改写 → 重解析锚点：批注**从 resolved 变 stale**（`resolved: true → false`），侧栏显示「锚点失效」，`console_errors: []`。符合契约：**允许失锚、不允许 JS 报错**。（这与第一轮抓到的 API 直发 source_locator 为空缺口是两回事；此处 UI 路径 locator 完整。）

### 遗留缺口（诚实清单）
1. **新段落 ZWSP 占位**：`insertParagraphAfter` 用零宽字符占位空段落；若新建后直接放弃（blur 空内容），可能残留 `​\n\n` 一处零宽字节。低频、可后补「空则丢弃」清理。
2. **Enter 语义**：裸 `Enter` = textarea 换行（多行块/列表/代码块编辑需要），「新增段落」走 `Cmd/Ctrl+Enter`——不是纯 Typora 的裸回车分块。有意取舍，已记此差异。
3. **每块独立渲染的跨块依赖**：引用式链接定义 `[x]: url` 若与引用处不在同一顶级块，块内单独渲染会断链（本 paper 用内联引用，未命中）。集成真实稿件需回退到「整篇渲染 + 事后打 data-block-index」或预扫描 link definitions。
4. **块编辑 + 乐观锁粒度**：块提交 PUT 整篇 + base_rev；若编辑中途磁盘变了，409 resync 保证不覆盖，但进行中的块编辑会丢。单人够用；AI 协同改稿（多 actor 同时写）需要更细的合并（块级 rev / CRDT），是集成阶段的真问题。
5. **部分重渲染未做**：当前提交后整篇重渲染（41ms，可接受）；未实现「只重渲染受影响块」。块数不变时可优化，块数变化时整篇更稳。
