# 项目设计文档集

这些文档是后续迭代的**设计约束与验收依据**，用于避免某次局部需求破坏既定架构。它们描述的是当前实现（截至 <REDACTED_DATE>）与可持续演进的边界；运行证据仍以代码、测试、`data/state.json` 中的 Prompt Snapshot 和真实工具执行记录为准。

## 文档索引

| 文档 | 回答的问题 |
| --- | --- |
| [design_instruction.md](design_instruction.md) | 系统由哪些层组成、数据如何流转、修改应落在哪一层？ |
| [systemprompt_instruction.md](systemprompt_instruction.md) | 系统提示词应负责什么，不能替代什么？ |
| [tool_instruction.md](tool_instruction.md) | 工具 Schema、执行边界和模型可见结果如何设计？ |
| [memory_instruction.md](memory_instruction.md) | 长期记忆、会话记忆、执行审计如何分层？ |
| [plan_instruction.md](plan_instruction.md) | 执行 Plan 如何创建、推进、完成或恢复？ |
| [artifact_instruction.md](artifact_instruction.md) | 交付物、媒体和历史复用如何登记与授权？ |
| [skills_instruction.md](skills_instruction.md) | 可复用 Skill 如何定义并进入 Agent 工作流？ |

## 使用方式

1. **先定位变更层**：提出需求时可说“请按 `docs/<name>` 的原则修改”，先确认它影响 UI、API、Context、Prompt、Tool、Memory、Plan、Artifact 或运行时中的哪些层。
2. **先读相关文档再改代码**：局部需求不得绕开对应边界。例如要增加数据能力，先读 Tool、Plan、Artifact；要改变模型行为，先读 System Prompt、Memory、Plan。
3. **优先改善 Context 与 Schema**：不要用关键词、工具名映射或条件分支去补某个模型案例；先检查模型是否拿到了足够、正确且最小的事实和下一步信息。
4. **保持记录职责独立**：Memory 不是 Plan，Plan 不是 Artifact，Conversation 不是历史执行依据；不要为了方便把它们混写或互相当作唯一真相。
5. **验证后再宣布完成**：至少运行相关单元测试和全量 `npm test`；影响服务或 UI 时，还要在新启动的本地服务和新浏览器会话中验证目标流程。涉及外部工具时，只有真实 Tool Result、Run/Plan/Artifact 和交付物一致，才能称为端到端完成。
6. **更新文档**：若修改了任何已确认的边界、Schema、Context 内容、保留策略或验收标准，必须同步更新对应 `docs/*_instruction.md`，并在根目录 `instruction.md` 追加简短交接记录。

## 冲突处理优先级

`当前用户命令` > `真实运行/状态证据` > `本设计文档集` > `历史 Plan、历史对话或旧交接`。

设计文档约束实现方式；它不能覆盖用户当前明确目标，也不能将历史记录误当作当前事实。
