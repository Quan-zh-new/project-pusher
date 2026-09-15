# 总体代码架构设计说明

## 1. 架构目标

项目推进器是单用户、本地运行的 Node.js Web 应用：用原生 HTTP 服务提供静态前端和 API，以 JSON 文件持久化工作区，通过一个受控的单 Agent Orchestrator 调用模型与原子工具。目标是让项目管理、数据回收和交付过程可运行、可审计、可恢复，而不是把模型回复当作事实或状态。

## 2. 当前分层

```text
Browser (index.html / app.js / styles.css)
  -> HTTP API and SSE
server.js
  -> Context Builder / Prompt Builder / Tool Router / State Repository
agent-runtime.js
  -> generic Agent loop: model -> tool calls -> normalized result -> next model
Local state and managed files
  -> data/state.json, data/assets/
External optional dependencies
  -> OpenRouter, user-registered CLI, public-link fetch
```

- **前端层**：负责展示、用户输入、确认操作和读取服务端状态；不得保存密钥，也不能成为 Agent、Plan 或 Artifact 的最终权威。
- **HTTP/API 层（`server.js`）**：负责请求校验、状态读取/写入、上下文构建、模型调用、工具派发、外部命令/网络适配、SSE 进度和公开错误转换。
- **Agent Harness（`agent-runtime.js`）**：只负责编排循环、标准化结果、有限重试、记录步骤和强制到达轮次上限后的无工具终结。工具并发由 `server.js` 中声明式 `TOOL_EXECUTION_POLICIES` 决定：同一模型回复内的独立调用可受控并发，结果仍按模型调用顺序归并；它不应按业务关键词决定任务路径。
- **领域状态层（`data/state.json`）**：持久化项目、知识、Memory、Plan、Run、Artifact、媒体和报告。服务端负责规范化、原子写入和服务端管理字段保护。
- **外部适配层**：OpenRouter、用户显式注册的 CLI 与公开网页均从后端调用。外部结果必须转换为本地统一的 Tool Result/Artifact 记录；密钥、认证头和本机 CLI 缓存不得进入浏览器或状态文件。公开包不预置任何 CLI 或 Skill；开始使用页只检测用户显式接入的通用 CLI。非演示、回环地址本机服务可通过开始使用页一次性接收 OpenRouter Key，后端仅写入本机 `.env`、立即更新进程内凭据且绝不回传 Key；公网/演示服务必须拒绝该入口。
- **Demo 适配层**：当 `DEMO_MODE=true` 时，HTTP/API 层用预置状态和确定性 Demo Agent 替代真实模型与外部系统。其结果仍通过 Conversation、Run、Notification、Knowledge、数据报告和文档预览等既有领域状态交付；不得向 Demo 服务注入真实凭据或把模拟结果描述为真实外部写入。
- **模型请求 Mock 页面（`model-request-mock.html`）**：是独立的 OpenAI-compatible 请求检查器，不进入项目 Context、Memory、Plan 或 Agent Run。它默认发送真实请求并展示模型正文；用户可切换为只校验并回显请求的 Mock 模式。页面展示 `server.js` 的完整工具清单；未受限的 `AGENT_TOOLS` 默认勾选，受限兼容 Handler 默认不勾选，用户可按本次请求选择任意服务端工具范围。服务端只接受名称并从自身工具清单投影 Schema；真实请求成功后页面原样展示上游 JSON 返回（其中包含 Tool Call）；最多三个 Tool Call 会预填至独立可编辑卡片，默认不执行，用户手动触发后才由服务端以当前选择范围执行并返回完整 Tool Result；可选模型优先由既有 OpenRouter 的 `/models` 目录加载，失败时回退到受控目录。

## 3. 主执行链路

1. 前端调用 `POST /api/ai/chat`，指定项目、可选事项和当前命令。
2. 服务端创建 `agentRuns` 记录，`buildProjectContext()` 只组装本轮必要事实。
3. 对话最新 Run 未收到可交付的模型回复时，前端显示“重试1次”；请求仅携带原 Run ID，服务端从持久化 Run 的原始消息或 Context Builder 审计恢复原始消息和图片资产，并校验同一对话、最新性和未重跑过。重跑不重复写入用户消息，旧 Run 记录 `manualRerunRunId` 保持审计关联。
3. `callAgentModel()` 将系统提示词、Context、工具定义发送给模型；模型返回正文和可选 Tool Calls。
4. `runAgentLoop()` 创建/续用 Plan，派发原子工具，保存完整审计，向下一轮只传最近一轮的最简结果；需要跨 Run 证据时由 `query_agent_history` 按需读取持久化对话与执行记录。
5. 工具产生的事实、Plan 回执和 Artifact 由服务端持久化；SSE 向前端发布运行进度。
6. 终结时返回用户可读正文，同时由 `finishAgentRun()` 固化 Run 状态。交付是否完成必须对账 Run、Plan、Tool Result、Artifact 和真实外部结果。

## 4. 模块职责与不变量

| 模块 | 应负责 | 不应负责 |
| --- | --- | --- |
| `server.js` | 领域逻辑、模型适配、Tool Router、状态一致性 | 将业务判断散落到前端或 Harness |
| `agent-runtime.js` | 通用循环、重试上限、结果标准化、运行记录 | 依据任务词硬编码数据回收或交付流程 |
| `app.js` | 交互与真实状态的可视化 | 直接调用有权限的 CLI 或伪造运行完成 |
| `data/state.json` | 持久化权威和审计快照 | 保存 API Key、原始大输出、任意本机路径 |
| `instruction.md` | 历史交接和验证记录 | 替代当前代码/状态或作为模型运行时 Prompt |
| `docs/*_instruction.md` | 稳定设计边界和变更规范 | 记录每次临时执行细节 |

核心不变量：

- `currentCommand` 始终高于历史上下文。
- Context 是输入视图，不是持久化源；Prompt Snapshot 才是“模型实际看到什么”的审计证据。
- Run、Plan、Artifact、Memory 四类对象独立存在，不能互相替代。
- 完成声明需要真实证据，不以模型正文、语法检查或 `run.status=completed` 单独成立。
- 行为修复优先调整 Context、Prompt、工具契约或领域状态；不得为某个句式增加专用恢复规则。

## 5. 变更落点指南

- **改变页面展示或交互**：优先改 `app.js`/`styles.css`，同时确认 API 和状态字段没有被前端覆盖。
- **改变项目业务数据**：先定义 `state` 的规范化与迁移，再改 API、前端和测试。
- **改变模型可做的事**：先审查 System Prompt、Context、Tool Schema、Tool Result，再改 Harness。
- **改变任务推进/完成语义**：改 Plan 契约和 `agent-runtime.js` 的通用机制，补全对账测试。
- **增加外部服务**：建立后端原子工具、错误/权限/时效披露、Artifact 归档和真实 E2E 验证；不让模型或前端直接掌握凭据。

## 6. 最小验收

每次架构相关变更至少验证：相关单测、`npm test`、`git diff --check`。影响服务时启动独立实例并检查 `GET /api/health`；影响 UI 时在新浏览器会话走目标流程。外部交付还需检查状态中对应 Run、Plan、Artifact、Prompt Snapshot/Tool Result 与远端结果一致。

## 8. Context 工作集层（<REDACTED_DATE>）

Context 是运行时投影，不是状态导出。服务端在审计层保留完整 Run/Plan/Tool Result，在模型输入层构建四段式工作集，并通过 `executionHandoff` 周期性压缩更早工具窗口。归纳必须是通用 Harness 能力，按 Loop/输入预算触发，不按业务关键词或工具名称打补丁。

## 9. 默认 Context 与按需参考检索（<REDACTED_DATE>）

默认 Context 只保留当前请求、当前项目/事项的范围标识、当前 Run/Plan/Tool Result 工作集和最近 6 条原始对话；不再投影 `projectFacts`、Knowledge、Long-term Memory 或 Conversation Summary。Knowledge 与 Memory 统一是“内容”，由同一个服务端内容范围解析器约束，而不是由模型关键词或工具各自猜测：无主题会话可读取所有 global、项目和事项内容；项目会话可读取 global、当前项目级及其全部事项级内容；事项会话可读取 global、当前项目级和当前事项级内容。`search_project_knowledge` 只返回项目级内容，`search_item_knowledge` 只返回事项级内容，`search_memory` 返回范围内的长期 Memory 与 Conversation Summary。`write_local_knowledge` 只写入用户明确提供或本次真实 Tool Result 验证的项目材料：项目/事项会话写入当前项目，无主题会话必须给出明确 `projectId`，事项会话只能写入当前事项；所有写入保留 Run 审计。无主题会话可通过 `projectId`/`initiativeId` 缩小范围，项目/事项会话传入其他项目或事项 ID 必须被拒绝。

## 10. 自动化规则与事件执行（<REDACTED_DATE>）

自动化规则是服务端管理的独立状态，不属于 Memory，也不以浏览器状态为权威。用户自然语言先进入 `automation_planning` 只读 Agent Run，输出规则级 Automation Plan；服务端再依据能力注册表校验触发、条件、工具、固定参数、变量来源及外部写入读回，只有可实现的 Plan 才能确认启用。

规则匹配由确定性代码完成，不调用模型。触发包括项目/事项状态变更、首次读取状态、规则确认、每日/每周指定时间和 DDL 当日指定时间；错过时间后在服务恢复时幂等补偿。命中后将已解析目标与已确认 Plan 组成普通用户输入，复用现有 Agent 链路，Run 类型标记为 `automation_execution`。`automationRules`、`automationPlans`、`automationTasks` 均为服务端管理字段。

## 11. 浏览器保存响应的状态边界（<REDACTED_DATE>）

项目表格编辑和展开状态属于浏览器当前交互状态。后台 `PUT /api/state` 返回时只能合并 Agent、Plan、Artifact、Skill 和自动化等服务端管理字段，不得用异步返回的整份 state 替换当前浏览器 state；否则较早请求的响应会回滚新建事项或展开/收起状态。首次 hydration 和无待保存、无保存中请求的窗口重新聚焦仍可采用完整服务端状态。

页面导航也必须自行渲染所属视图的当前状态，不能依赖该页内的二次筛选或按钮点击触发首屏绘制。项目知识库进入时同步渲染筛选控件和列表/详情，保证刷新后第一次点击“项目知识库”就展示已经 hydration 的知识记录。

## 12. 表格自动保存反馈（<REDACTED_DATE>）

项目全景中的内联字段采用静默自动保存。单个字段 change 不弹出“已保存”Toast，避免用户连续填写新项目或事项时每次失焦都被提示打断；新增、删除、归档等明确离散操作仍可显示一次结果反馈。

## 13. 后台保存不重绘编辑表格（<REDACTED_DATE>）

即使后台保存响应包含新的服务端管理字段，`persistBackendState()` 也只能合并状态并更新轻量计数，不能调用 `renderAll()`。表格重绘只能来自用户明确操作、视图切换或安全 hydration；该边界保护所有内联 input/textarea 的焦点、选区和未完成输入。

## 14. 内联字段更新不重绘表格（<REDACTED_DATE>）

`updateInlineField()` 不能调用 `renderAll()`：change 事件可能由用户从一个表格字段切换到下一字段时触发，若立即重绘会替换正在点击/输入的下一个 DOM 节点。内联更新只保存数据并刷新计数、今日动作和 textarea 高度；链接同步完成后的异步结果同样不得重绘项目表格。

## 15. 进度多选与候选项（<REDACTED_DATE>）

项目和事项的 `progress` 统一为字符串数组，旧字符串自动迁移为单个选择项。工作区保存可编辑的 `progressOptions` 候选项；表格进度单元格支持同时勾选多个状态、删除当前选择、新增候选项以及删除候选项。模型 Context 和自动化匹配将数组格式化为以“ · ”连接的稳定文本，避免改变既有事实语义。

## 16. 自动化规划 Prompt 审计（<REDACTED_DATE>）

`automation_planning` Run 与普通 Agent Run 一样必须在模型请求前创建 Prompt Snapshot，并把 Snapshot ID 写入规划模型步骤。Snapshot 保存实际 system prompt、用户自然语言规则、能力注册表、目标投影、模型原始回复、请求 ID 和 token usage；即使模型调用随后失败，也保留已发送的 Prompt 证据。

## 17. 自动化规划与执行工具投影（<REDACTED_DATE>）

规划阶段将完整工具 Schema 通过 Provider `tools` 传给模型，并以多轮 Tool Call 获取只读 help/Skill 事实；规划 Run 审计每轮 Prompt、Provider Tool Call 和 Tool Result。执行阶段不再向模型暴露全量工具，而是根据已确认 Automation Plan 投影其步骤工具，加上 Execution Plan 的创建/更新工具。服务端仍校验实际调用及固定参数，Provider 可见工具集合和服务端授权集合必须一致。

## 18. Prompt Snapshot 的 Context 展示（<REDACTED_DATE>）

Prompt Snapshot 审计仍保留 `context` 以兼容审计和历史恢复，但 UI 不单独展示该字段；普通 Agent 的 `userPrompt` 已包含 `Context：...`，因此 Snapshot 查看器只显示 system prompt、user prompt、工具调用、回复、用量和元数据，并标注 Context 已包含在 User Prompt 中。

## 19. Threaded AI assistant and unscoped workspace conversations (<REDACTED_DATE>)

The assistant uses `state.conversations[]` as the UI conversation authority. A thread has `id`, `scope` (`global`, `project`, or `initiative`), optional project/initiative IDs, title, recent raw messages, rolling summary, and timestamps. Existing project and initiative `memory`/`conversationSummary` are copied into stable legacy threads during normalization so prior chat remains visible.

The collapsed assistant is opened from the lower-right launcher. Direct project/initiative entry resolves the latest thread for that scope; a title switch from a global thread opens a separate target-scoped thread and never reassigns the global history. History and new-thread actions are restricted to the current scope.

`POST /api/ai/chat` accepts `conversationId` and derives the authoritative scope server-side. Global threads receive only a lightweight workspace Context plus their own recent messages, but receive the same registered `AGENT_TOOLS` set as project/initiative threads, including read and write capabilities. Scope is therefore a Context boundary rather than a provider-tool whitelist: the model must first discover or obtain every concrete project, initiative, document, Artifact, CLI argument, or other target required by the selected tool's own contract. A global conversation must not assume unqueried workspace facts, silently infer a project target, or bypass a tool's normal validation and audit trail.

### 19.1 Assistant thread controls (<REDACTED_DATE>)

The history list remains hidden by default, including the active thread. Opening it is an explicit action. Each saved thread has a delete control; deleting the active thread opens the most recently updated remaining thread in the same scope, or creates a fresh empty thread when none remains. Clicking the assistant title opens the complete scope-candidate menu directly; do not add an intermediate native select interaction.

## 19. 简化自动化规则识别（<REDACTED_DATE>）

自动化规则识别只输出标题、触发定义、确定性命中条件和面向命中目标的 `task` 自然语言任务；它不查询工具、不生成工具步骤、不固定参数。触发后，服务端把任务和目标事实作为普通用户输入交给现有 Agent，Agent 在该次执行中通过 Provider `tools` 自主选择工具、查询 help 并构造参数。规则识别和任务执行职责分离，避免把易变 CLI 调用细节固化进规则。

## 20. AI 长回复展示（<REDACTED_DATE>）

AI 助手保持固定视口高度，但对话记录必须占据独立的可收缩 flex 对话记录区，并只由该区域垂直滚动。长回复、长 URL 或连续文本不得被面板或横向溢出裁剪；消息文本使用安全换行。行内链接保留在正文中正常显示；仅独占一行的裸 URL 转为链接卡片，且不会带入相邻消息文字。URL 识别必须以中英文括号和中文标点作为边界，不能把后续正文合并进链接。此规则只影响展示，不截断 `conversation.memory`、Prompt Snapshot 或模型原始输出。

## 21. 链接读取与模型可见业务工具（<REDACTED_DATE>）

飞书文档工具和 `read_web_page(url)` 进入 `AGENT_TOOLS`，由已有参数校验、Run 审计、Plan 和外部读回约束执行。公开包的 Tool 列表不包含任何 Libra 实验、指标、回收或截图工具；内部部署如需该能力必须在私有扩展中单独提供。`read_web_page(url)` 仅读取公开 HTTP/HTTPS 文本页面，逐跳拒绝本机、内网和保留地址，限制重定向、响应类型与正文长度；飞书 Docx/Wiki 必须走 `read_feishu_document`。`query_agent_history` 仍保持不对模型开放。

## 22. 最近对话原文完整输入（<REDACTED_DATE>）

`recentConversation` 仍只保留最近 6 条原始消息，但取消每条消息的字符截断；每条文本按持久化原文完整进入模型 Context。更早对话继续通过滚动 Conversation Summary 按需检索，不能以单条截断替代事实交接。

## 23. Global Context Handoff 一致性（<REDACTED_DATE>）

`executionHandoff` 是已归纳 Tool Result 的替代工作集，不是与完整历史 Tool Result 并列重复注入的第二份上下文。项目、事项和无主题（global）会话必须使用同一条通用投影规则：下一轮模型 Context 只包含 `executionHandoff`、最近一轮 Tool Result，以及尚未被 `executionHandoffCoveredToolCallIds` 覆盖的 Tool Result。归纳成功后不得把已覆盖的完整历史重新放入 `pendingToolResults`；否则会在 Context 超出预算后重复触发归纳、使输入持续膨胀。完整历史仍只保留在 Run Steps 和 Prompt Snapshot 审计层。

上下文归纳是辅助工作集优化，不得成为业务 Agent 的无限等待点。归纳开始时必须先持久化 `running` Step；其独立模型调用默认最长 90 秒，且不超过主模型请求超时。模型网络/超时按固定退避自动重试 2 次；超时覆盖从建立 HTTP 连接到完整读取和解析响应 body 的整个生命周期。重试后仍超时、网络失败或返回无效 JSON 时，服务端以通用的受限 Tool Result handoff 覆盖当前 pending window、记录 `partial` 与错误边界，并继续下一轮业务 Agent；完整原始 Tool Result 保留在审计层，模型需要正文或精确 Block 时按目标重新读取。不得对特定工具、文档或任务关键词设置绕过规则。

## 20. 自动化规则编辑与删除（<REDACTED_DATE>）

自动化规则可以同时存在并独立启停。确认一个未关联 `replaceRuleId` 的新 Plan 时必须新增一条规则，绝不能关闭或覆盖其他已启用规则；同一个 Plan 的重复确认只恢复其已有规则，不得重复创建。编辑已启用规则时，前端载入其自然语言和模型，重新识别出新的规则草案；只有用户再次确认后才以同一 rule ID 和递增版本替换生效规则，旧规则在编辑过程中继续保持原行为。删除规则只移除未来触发资格，已有 Automation Task、Agent Run、Plan 和 Prompt Snapshot 保留为审计记录；已在运行的任务不被静默中断。

## 22. 并发 Run 与状态隔离（<REDACTED_DATE>）

同一服务进程内，手动对话和 Automation Task 都可并行运行：每个 Run 拥有独立 `runId`、AbortController、SSE 事件流、执行上下文、Conversation、Prompt Snapshot 和 Tool Result。浏览器以 `runId -> active request` 管理运行态；某个会话发送后仅禁用该会话输入，切换到其他项目或事项仍可发起独立对话，停止操作也只能停止当前会话的 Run。

`data/state.json` 仍是单进程持久化载体，但服务端必须持有一个共享的 canonical state object；所有并发 Run 在该对象上变更，磁盘写入只负责按队列落盘快照，不能让不同 Run 在各自旧 state 副本上读改写。模型/工具执行保持并发，状态提交不丢失 Run、Conversation、Knowledge、Long-term Memory、Automation Task、Notification 或审计步骤。并发 E2E 必须同时验证两个事项的模型调用真实重叠、知识和 Memory 均落盘、外部 CLI 审计分别保留、最终回复均返回，以及任一 Run 的 Prompt/Conversation 不出现另一 Run 的私有 Tool Result。

## 21. AI 对话与站内通知（<REDACTED_DATE>）

每次有用户可读的 AI 最终回复时，服务端创建一条站内通知，通知保存关联 conversation、Run、项目/事项和自动化任务 ID。自动化任务执行前必须在对应项目/事项范围新建独立的“自动化 · 规则标题”对话，结果写入该对话而不是复用最近对话。客户端轮询通知；未读消息以通知红点和即时 Toast 呈现，点击通知先标已读再跳转至对应 AI 对话。通知删除/已读不删除 Run、Conversation 或自动化审计。
