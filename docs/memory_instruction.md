# Memory 设计说明

## 1. 四类记录必须分离

| 记录 | 用途 | 是否默认进入模型 Context |
| --- | --- | --- |
| Long-term Memory | 已确认、可跨轮复用的事实/偏好/决策 | 是，按 scope 和状态过滤 |
| Conversation Memory | 当前项目对话的近期原文与摘要 | 摘要 + 最近 6 条 |
| Execution Plan | 某次任务的 checklist、义务、下一步、审计 | 仅当前 Plan 的精简视图 |
| Run / Prompt Snapshot / Tool Result | 可追溯的执行证据 | 默认不注入，只提供当前轮最简 Result |

Artifact 是交付物注册表，不是 Memory；历史 Artifact 必须通过 `query_agent_history` 查询后才可在本轮复用。

## 2. Long-term Memory

存储在 `state.longTermMemories[]`。只有用户明确确认、纠正或设定且可跨轮复用的信息才可写入，例如项目事实、稳定决策、协作偏好、数据口径、Learning、已确认的数据回收 Profile。

- `scope=project`：与当前项目、事项、实验、依赖、指标或决策强相关。
- `scope=global`：脱离当前项目仍成立的协作规则、交付格式、通用偏好或数据口径。
- `data_recovery_profile` 是 `projectMemory` 中的一个 `type`，不是 Long-term Memory 的平行对象。其 `statement` 固定用“项目常用回收指标和指标组：指标组名称：指标名称、指标名称；...”表达可读摘要；`data.metricGroups` 保留给工具调用的结构化默认值。
- 不记录模型猜测、临时 Plan、未验证工具结果、一次性措辞。
- 同一轮识别到应保存的信息时，模型必须调用 `update_long_term_memory`，不能只回复“已记住”。
- 已纠正内容创建新版本，旧内容为 `superseded`；`expired` 与非 active 记录不进入默认 Context。

## 3. Conversation Memory

项目对象的 `memory` 保存近期对话；`conversationSummary` 归纳更早对话。Context 只带最近 6 条原始消息，每条截断到合理长度；Conversation Summary 通过 `search_memory(type=conversation_summary)` 按需读取。摘要仅服务于前情、纠正和未完成事项理解，不能作为历史任务已执行、Artifact 存在或外部交付成功的证据。

超过保留窗口时，只有已有有效摘要覆盖旧消息才可安全裁剪原文。不要把完整聊天史、历史 Plan 数量或最近 Run 列表注入 Context。

状态读写中的归一化只修复仍保留了 Summary 已覆盖前缀的遗留 store；不能按 `coveredMessageCount >= overflow` 直接裁剪正常滚动 store 的新消息。正常流程必须先合并“旧 Summary + 超出 recent-6 的新消息”生成新 Summary，成功后再保留最近 6 条原文。用户明确要求刷新时，可调用 conversation-summary API 的 `force=true` 将当前 recent-6 也合并进一轮新摘要，原文仍保留。

## 4. Context 与审计

`buildProjectContext()` 不默认输出项目事实、Knowledge、Long-term Memory 或 Conversation Summary；它仅保留当前项目/事项 scope、当前 Run 工作集和最近 6 条 `recentConversation`。每条最近消息按原文完整进入 Context，不做单条字符截断；这是模型输入预算，不是全量状态导出。

- `agentRuns[].promptSnapshots[].debug.context` 是验证“模型当时看到了什么”的权威。
- Prompt Snapshot 必须是不可变副本/引用；不能共享后续循环会变动的数组。
- 当前轮只传 `lastLoopToolResults` 的压缩结果；完整历史留在服务端 Run/Plan 审计。
- 历史执行证据由 `query_agent_history` 只读派生于 Conversation、Run（含关联 Plan）、Tool Step 与 Artifact；不是单独的真相库，也不能自动恢复工作。

## 5. 检索原则

默认不注入历史。需要时模型调用通用检索：知识检索无匹配必须返回空集，不可用“最近记录”凑结果；历史对话、执行事实、工具入参/出参和历史 Artifact 都由 `query_agent_history` 查询。查询返回的已验证 Artifact 自动成为本轮可用引用；当前命令永远优先，旧 Plan 只能作为候选事实。

Conversation Summary 对未完成请求必须保留可执行交接字段：具体内容范围、目标对象（已知 URL/文件/Block/项目标识）、操作方式、真实完成证据、缺失项和下一步。摘要器同时读取当前范围的未完成 Execution Plan 作为线索，避免遗漏已知交付目标；但只能保留对话或执行证据支持的细节，未知必须明确标注。

当前 Run 的模型 Context 现在携带全部 Loop 的压缩 `currentRun.toolResults`，避免后续 Plan/Skill/读取步骤覆盖已获得的 Block ID、文档定位或 CLI 错误事实。`lastLoopToolResults` 仍是审计与实时步骤字段，不再是模型唯一可见结果。

## 6. 四段式运行 Context 与执行交接（<REDACTED_DATE>）

运行 Context 固定分为 `core`、`currentTask`、`executionState`、`reference`：`core` 保存原始用户诉求、目标和项目/事项范围；`currentTask` 保存 Plan 优先的当前意图及最近 1 Loop 的完整安全 Tool Result；`executionState` 保存精简 Plan、已归纳 `executionHandoff` 与尚未归纳的历史 Tool Result；`reference` 仅保存项目事实、长期记忆、Knowledge 和对话前情，不默认注入 history。

完整 Run、Tool Step、Tool Result 和 Prompt Snapshot 始终是审计真相，不因归纳删除。`executionHandoff` 仅是模型工作集：必须带来源引用，保留后续执行所需参数、ID、日期、披露、Artifact、阻断和下一步；删除长过程文本。每 6 个工具 Loop 或预测常规 Context 超过 32 KB 字符时，额外模型调用归纳该窗口；该调用不计入 Agent Loop，不执行工具、不修改 Plan。归纳失败时保留原工作集并继续。

## 7. 简化 executionHandoff 与 Skill 命令交接（<REDACTED_DATE>）

`executionHandoff` 仅保存 `usableFacts`；完整来源、覆盖窗口和过程状态留在 Run Step / Prompt Snapshot。Skill 原文不再在发现后的普通 Loop 持续回输；归纳调用读取 `activeSkills` 原文，并把当前 Plan 后续需要的完整命令模板、变量替换、约束和输出用法写入对应 usableFact。

## 8. `usableFacts` 唯一 Handoff 结构（<REDACTED_DATE>）

`executionHandoff` 对模型只保留 `{ usableFacts: [{ key, value }] }`。不再保留 summary、status、sourceRefs、reference、risk、nextIntent 或独立 commandGuidance；Run 审计继续保存完整来源和覆盖窗口。归纳完成的 ToolCall 覆盖集合是服务端内部元数据，不进入模型 handoff。

需要继续使用的 Skill 命令同样写成 usableFact：key 描述用途，value 从完整 CLI 命令模板开始，并写明占位变量替换、参数来源、执行约束、输出如何被下一步使用和注意事项。

## 9. 语义 Evidence 去重与无 CLI Help Context（<REDACTED_DATE>）

`latestLoopToolResults` 与 `pendingToolResults` 不直接复制审计对象，而使用语义 Evidence：同值 note/summary 仅保留 message；input/data 中相同参数只保留 request；JSON stdout 与同值 parsed json 仅保留结构化结果；相同 tool/status/result 的重复 Evidence 按内容指纹合并并保留 occurrences。Run Step 仍保存每一次完整调用。`cliHelpCache` 继续作为服务端缓存，但不进入模型 Context；模型只使用当前 Evidence 或 handoff 中已有的命令事实。

## 10. 长期记忆按需检索（<REDACTED_DATE>）

Long-term Memory 和 Conversation Summary 都不默认进入 `buildProjectContext()`。模型需要稳定偏好、项目决策、事项 learning、data recovery profile 或更早对话交接时，调用 `search_memory`。Memory 与 Knowledge 共用内容范围：无主题会话可读取全部 global/project/item Memory 和所有 Conversation Summary；项目会话读取 global、当前项目及其全部事项的 Memory/Summary；事项会话读取 global、当前项目和当前事项的 Memory/Summary。项目/事项会话不得读取其他项目/事项的内容；没有命中的记录不能被猜测为存在。写入仍通过 `update_long_term_memory`，不因改为检索而改变确认、版本和 superseded 规则。

同一原则适用于 Knowledge 与项目事实：`search_project_knowledge` 只读允许范围内的项目级内容，`search_item_knowledge` 只读允许范围内的事项级内容；无主题会话可带目标 ID 缩小检索，项目/事项会话的越界 ID 必须被服务端拒绝，而不是进入默认 Context。

自动摘要请求使用服务端持久化状态：`POST /api/projects/:projectId/conversation-summary/refresh` 仅接收 `initiativeId` 和可选 `force`，由服务端读取、压缩并写回当前 state，同时只返回当前对话的 `summary` 与 recent `memory`。前端不得再上传整个工作区 state 触发摘要，以避免图片/运行审计导致请求体过大和覆盖服务端刚写入的对话。

## 11. Project Memory 排查视图（<REDACTED_DATE>）

Project Memory 页面按当前筛选项目分为 Global Memory、项目记忆和逐事项记忆。项目与每个事项分别展示其 `conversationSummary`、最近 6 条 `memory` 原文和仅属于该 scope 的 Long-term Memory；事项没有记录时也保留空区块，便于排查隔离、遗漏和串扰。该页面是只读检查视图，不展示 Execution Plan、Run 或 Prompt Snapshot。

Project Memory 页面提供“事项筛选”：选择某一事项后，页面仍保留当前项目与 Global Memory 作为该事项可继承的检查背景，但只展示被选事项的 Conversation Summary、最近对话和事项 Long-term Memory；切换项目会重置为“全部事项”。
