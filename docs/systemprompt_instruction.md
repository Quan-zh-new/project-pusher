# 系统提示词设计说明

## 1. 定位

系统提示词是**模型行为合同**，不是业务流程引擎。当前运行时提示词由 `server.js` 的 `agentInstructions()` 和终结场景的 `finalLoopInstruction()` 生成；根目录 `instruction.md` 不会自动注入模型。

提示词应告诉模型：Context 各字段的语义和优先级、何时规划/调用工具、如何解释 Tool Result、何时交付、何时写 Memory，以及用户输出的风格。提示词不应复制长篇业务资料、工具参数细节或用特例规则限制模型。

## 2. 编写原则

1. **事实优先级明确**：当前命令最高；项目事实和已确认长期记忆可约束决策；会话摘要不能充当历史执行或 Artifact 证据。
2. **以 Context 驱动，不以关键词打补丁**：模型做错时，先检查其是否缺少当前事实、历史检索入口、Artifact 授权信息、Plan 回执或 Tool Result 语义。
3. **职责分开**：跨工具的行为规则放 System Prompt；单工具参数、前置条件和返回字段放 Tool Description/Schema；硬资源上限放运行时。
4. **同轮真实交付**：当已有最终事实（完成、部分完成、受阻、需输入或无需工具）时，本轮正文必须直接面向用户，不能以“正在处理”占位。Plan 更新是记录，不得成为回复前置条件。
5. **如实披露**：partial、时效不足、权限阻塞、缺输入和失败必须按实际 Result 表达，不能把可继续推进误称为完整完成。
6. **简洁自然**：模型不输出内部 JSON、完整 Context、工具审计或推理过程；中间 Tool Result 留在 Run 审计。

## 3. 必须覆盖的通用合同

- 多步骤任务创建并持续对账 Execution Plan；没有 Plan 的简单任务仍可直接回答。
- 用户提供明确 URL 且要求基于内容总结、核实、提意见或补全时，按来源调用只读工具：飞书 Docx/Wiki 使用 `read_feishu_document`，公开 HTTP/HTTPS 页面使用 `read_web_page`，Libra 实验使用对应 Libra 原子工具；读取失败或正文截断必须披露，不能臆称已读。
- `planDelta.reconcile=true` 表示新事实可能影响 checklist，模型应先根据事实自行对账，而不是重跑已完成动作。
- 需要历史材料时调用 `query_agent_history`；不得从未查询的对话或“最近一次”猜测复用对象。该工具返回的已验证 Artifact 才可在本轮作为历史 Artifact 使用。
- 仅当当前命令包含可跨轮复用且已明确确认/纠正/设定的信息时，调用 `update_long_term_memory`；scope 由模型按语义判断。
- 到硬循环上限时，模型被禁止继续调用工具，只能基于现有证据说明已完成、阻塞和下一步。

## 4. 不应写入提示词的内容

- “若用户说继续/重试/上次，则自动恢复某 Plan”之类的关键词分支。
- 具体实验 ID、临时链接、单次任务的当前结论和大段历史列表。
- API Key、认证信息、内部文件路径或完整原始 Tool Result。
- 以工具名映射 checklist 的刚性流程；Plan 由模型根据目标和真实 facts 维护。
- 为规避一次失败而加入的专属话术。若确有硬安全/资源边界，应在运行时实现并在提示词中说明结果语义。

## 5. 修改检查清单

修改提示词前后，确认：它没有覆盖 `currentCommand`；没有重复 Tool Schema；能让模型解释 Context/Result 的最小字段；终结回复不额外增加模型调用；对应行为有 Prompt Snapshot 和测试可验证。系统提示词变化同时更新本文件和 `instruction.md`。


## 6. CLI 帮助查询

当模型需要确认外部 CLI 的命令或参数时，调用 `inspect_cli_help` 获取真实 `--help`。项目中已有的 Markdown Skill 可按需通过 `search_skills` 查询，但 CLI Help 不会自动写入或更新 Skill。

## 7. 执行上下文归纳提示词（<REDACTED_DATE>）

归纳模型与项目推进模型职责分离。归纳提示词只允许把已有 handoff 与真实 Tool Result 合并为严格 JSON 的 `executionHandoff`，要求每项事实携带 ToolCall / Artifact / Plan 来源；不得调用工具、修改 Plan、猜测事实或向用户交付。它必须保留可执行参数、实验/版本/日期/指标披露、文档 Block、Artifact 和阻断边界，并移除长 stdout、正文、重复 receipt 与无后续依赖的过程细节。

## 8. 历史查询临时下线（<REDACTED_DATE>）

`query_agent_history` 暂不暴露给模型，直到其递归历史投影被修复。系统提示词要求模型只基于当前 Context 和本轮真实工具结果推进，不得猜测或隐式复用旧执行事实。

## 9. Skill 命令交接（<REDACTED_DATE>）

归纳提示词仅输出 `usableFacts`。它必须把归纳阶段可见、而后续普通 Loop 不再回输的 Skill 原文，转写为 key=用途、value=完整命令模板及变量替换/约束/输出用法的 usableFact；仅保留 Skill 路径或标题不视为完成交接。

## 10. `usableFacts` 唯一归纳输出（<REDACTED_DATE>）

归纳模型的 JSON 只允许 `usableFacts`。原始 Skill 不进入后续普通 Loop；需要的命令必须变成 key=用途、value=完整可执行命令模板及变量替换/约束/输出用法的 usableFact。服务端从待归纳窗口自行登记覆盖的 ToolCall，不再要求模型返回来源或覆盖 ID。

## 11. Plan 与后续工具同轮推进（<REDACTED_DATE>）

当已有 Context 或本轮 Result 足以继续执行时，模型应在同一条 assistant message 中同时创建/更新 Plan 和发起不依赖 Plan 回执的后续工具调用；不得专门消耗一轮只写 Plan 后再重新读取已有事实。

## 12. 项目知识和 Memory 按需检索（<REDACTED_DATE>）

默认 Prompt 不携带 projectFacts、Knowledge、Long-term Memory 或 Conversation Summary；仅保留最近原始对话。系统提示词只说明统一内容范围与检索职责：无主题会话可检索全部内容，项目会话可检索 global、当前项目及其事项，事项会话可检索 global、当前项目和当前事项。项目事实/项目级知识走 `search_project_knowledge`，事项事实/事项级知识走 `search_item_knowledge`，稳定记忆和已压缩的更早对话交接走 `search_memory`；用户明确提供或本次真实 Tool Result 验证的项目材料可通过 `write_local_knowledge` 写入本地 Knowledge，不能写入模型推测或临时计划。无主题会话可传 `projectId`/`initiativeId` 缩小范围；项目/事项会话不得借参数扩展到其他项目或事项。模型根据当前命令和已有 Tool Result 自主判断是否检索；不得用 Harness 关键词规则预取，也不得把项目检索结果当作事项检索结果。
