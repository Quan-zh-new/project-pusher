# 工具 Schema 与 Tool Result 设计说明

## 1. 工具模型

工具是后端执行的**原子能力**：模型决定是否、何时以及使用何组明确参数调用；工具只执行参数描述的动作并返回事实，不读取 Memory 替模型决定流程，也不根据自然语言猜测任务。

当前 Schema 集中在 `server.js` 的 `AGENT_TOOLS`。主要类别：

- Libra：`read_experiment_metadata`、`resolve_metric_specs`、`query_metric_data`、`check_experiment_recycle`、`capture_metric_snapshot`
- 链接读取：`read_feishu_document`（飞书 Docx/Wiki）与 `read_web_page`（公开 HTTP/HTTPS 网页）
- 飞书交付：`create_feishu_document`、`append_feishu_document`、`replace_feishu_document_text`、`replace_feishu_document_blocks`、`replace_feishu_document_images`、`insert_document_images`；通用 `execute_cli` 仍用于已注册 CLI 的其他能力
- 知识与历史：`search_project_knowledge`、`search_item_knowledge`、`search_memory`；`query_agent_history` 仍暂不对模型开放
- 持久化：`write_local_knowledge`（本地知识库）、`update_long_term_memory`
- 执行状态：`create_execution_plan`、`update_execution_plan`

## 2. Schema 原则

- 一个工具只处理一个可验证能力；需要编排时由模型经多个原子调用完成。
- 参数只保留执行所需信息，使用明确类型、枚举、必填字段和 `additionalProperties:false`。
- 工具描述应说明：用途、前置条件、参数含义、不可做事项、结果状态和下一步约束。
- 对于受管本地路径参数，工具描述必须提供可执行的相对目录和示例。模型应直接据此构造 argv，不能把“位于受管目录内”当作需要靠失败后猜测的隐式约束。
- 同一条模型回复中的多个 `execute_cli` 调用，如彼此独立，可由通用 Harness 按受控并发批量执行；结果按模型调用顺序回传并分别保留审计。任何依赖另一命令 stdout、文件产物或远端写入结果的命令，必须等下一轮拿到真实 Result 后再发起，不能假设同批结果的完成顺序。
- 权限、目标、版本、时间范围、项目/事项范围必须显式入参或由服务端已验证上下文确定，不能从聊天猜测。图片 Artifact 的归属遵循当前会话 Scope：项目会话可插入本项目的项目级图片 Artifact，事项会话仅可插入当前事项的图片 Artifact；两者不能跨 Scope 复用。
- 写操作应区分草稿/确认/实际写入，并保留可定位的执行审计和错误披露。通用 CLI Harness 在退出码为 0 后继续检查结构化 JSON：显式 `ok=false`、`result/status=failed` 或已声明的更新数为 0 都标记失败，`partial_success` 标记 partial；原始 stdout/stderr/json 保持在既有 Tool Result 字段中。飞书 `docs +update` 以外部 JSON 的 `data.result="success"` 作为写入成功判据；`updated_blocks_count` 仅保留为回执信息，允许缺失。写后仍需重新读取目标范围，不能将接口成功当作交付成功。
- 数据工具返回真实数据日期、版本边界和完整性；partial 是可继续的事实状态，不是成功伪装。

## 3. 两层结果：持久化全量，模型可见最简

服务端审计保存完整 Tool Result、原始必要证据和 Artifact 引用。传入下一轮模型的结果必须由 `compactToolResultForModel()` 压缩为：

```json
{
  "tool": "工具名",
  "status": "completed | partial | blocked | needs_input | conflict | failed",
  "facts": { "本轮决策需要的真实事实": true },
  "planDelta": { "reconcile": true },
  "next": "唯一、可执行的下一步",
  "artifacts": [{ "id": "artifact-id", "type": "...", "title": "...", "url": "可选" }],
  "error": "仅失败/阻塞时的最小解释",
  "missing": ["仅缺输入时"],
  "retryable": false
}
```

原则：不重复 `note`/`summary`/正文，不传完整 stdout、Base64（包括 `image_base64`）、受管本地路径或与下一步无关的历史；但不得删掉会改变判断的 metricResults、时效、版本、检索 `items` 或 Artifact ID。

## 4. 状态与重试

- `completed`：动作完成，事实可用。
- `partial`：已取得部分有效结果；可继续不相关工作，必须保留限制披露。
- `needs_input` / `conflict`：缺少用户选择或存在冲突，阻断相关分支。
- `blocked`：权限、不可重试失败或重试上限等阻断。
- `failed`：失败；仅 `retryable=true` 可以由通用 Harness 有限重试。

重试规则由 `agent-runtime.js` 通过稳定的调用签名和次数上限统一处理，不在单个业务工具中用专属分支实现。

## 5. 历史与媒体安全边界

`query_agent_history(query, sources, initiativeId, limit)` 是唯一的历史 Agent 证据入口。`sources` 可省略；不确定类别时应省略，让工具统一检索四类记录：`conversation` 是历史用户/助手消息，`tool_call` 是单次调用的真实入参与出参，`agent_run` 是一次任务的整体状态并包含关联 Plan 的 checklist/义务，`artifact` 是可交付产物元数据。已裁剪的对话只能返回 Conversation Summary。返回的已验证 Artifact 引用自动成为当前 Run 可用 Artifact；当前 Run 产物也可直接引用。历史查询不会自动继续、重试、写入或把旧外部结果伪装成当前查询结果。图片仍通过受管 `mediaAssets`/Artifact ID 复用，绝不向模型开放任意文件系统路径。


## 6. 新增工具的验收

新增或改 Schema 时：补参数校验和失败路径测试；验证最简 Result 不丢失必要事实；验证 Context 无冗余大字段；若写入外部系统，做授权的真实 E2E，并对账 Tool Result、Run、Plan、Artifact 与远端结果。

## 7. CLI Help 缓存

`inspect_cli_help` 只查询真实 CLI `--help`，并使用服务端缓存避免重复启动相同命令；不会创建、更新或检索 Skill。Help 结果不代表当前外部业务状态。

## 8. 文件树 Skill 工具契约

`search_skills(query?, parentSkillPath?, limit?)` 的层级由 `parentSkillPath` 控制，而不是拆分 Tool：无父路径只返回父 Markdown 元数据；有父路径只返回该父目录 `references/` 的子 Markdown 元数据。非空 `query` 按空白拆词，只要标题、摘要、正文、相对路径或不带 `.md` 的文件名命中任一个词即可返回；没有任何词命中的 Skill 必须过滤。完整路径/文件名命中有最高排序权重，文件名或路径词命中次之，最后才是完整 query 或正文词命中；因此直接请求某个 Skill 时，本体优先于仅引用它的工作流。命中父/子 Skill 的全文自动记录为当前 Run 的不可变 discovered Skill 快照，供后续模型调用使用；工具不执行 Skill 内容。

失败/阻断的 `execute_cli` 结果是例外：模型可见的压缩 facts 仍保留实际 `cli`、`argv`、`exitCode` 和最多 6000 字符的已脱敏 `stderr`，使下一轮能够基于真实 CLI 错误修正参数。其他失败工具继续使用最小错误摘要。

`execute_cli` 的路径契约不是 CLI `--help` 的一部分，直接由 Tool Description 提供；例如 `libra-cli` 的 `--output` 必须传 `data/assets/<filename>`，而 `lark-cli` 的 `--file` 也必须传该受管相对路径。当前模型需要把已导出的图片写入飞书时，直接通过 `execute_cli` 调用已确认的 lark-cli 插图命令，并把同一 `data/assets/<filename>` 作为 `--file`。

`search_skills` 对每个命中的父/子 Skill 返回完整 Markdown 正文，帮助模型在选择前判断是否适用；搜索结果会自动成为当前 Run 后续 Context 的稳定引用。

`search_skills` 命中的完整父/子 Skill 会自动成为当前 Run 的 discovered Skill 快照，并在后续 Context 持续提供；这避免模型因遗漏 `select_skills_for_run` 而遗忘已检索知识。不再需要单独的绑定工具。

模型 Context 保留当前 Run 全部压缩 Tool Result；完整原始审计输出仍不重复注入。实现应在后续模型调用中传入 `allToolResults`，并保留 `lastLoopToolResults` 仅用于审计和刚发生变化的步骤记录。

`search_skills` 的模型结果不包含 Skill `summary` 字段：模型获得完整 `content` 后，摘要既重复又可能遗漏命令参数。`summary` 仅保留给前端文件树浏览和内部检索排序。

## 9. 窗口化模型输入与完整最近结果（<REDACTED_DATE>）

Tool Result 的完整审计仍写入 Run Step。模型 Context 中最近 1 个工具 Loop 与更早 pending 都使用去重后的语义 Evidence：保留一次请求、一次结果、错误、Artifact、参数和结构化数据，删除同值的 note/summary、input/data 参数、JSON stdout/json 双份编码和完全相同的重复 Evidence。已归纳窗口仅以 `executionHandoff.usableFacts` 提供。不得因为去重或归纳而删除审计或使历史查询失去原始证据。

## 10. `query_agent_history` 暂停开放给模型（<REDACTED_DATE>）

在历史投影和执行交接修复完成前，`query_agent_history` 的后端处理与审计读取能力保留，但不出现在 `AGENT_TOOLS` 中，也不发送给模型。模型不得猜测或自动复用未进入当前 Context 的旧 Run、旧 Plan、旧 Tool Result 或历史 Artifact。

## 11. Skill 原文到 `usableFacts` 的交接（<REDACTED_DATE>）

`search_skills` 命中的全文只在当前 Tool Result 与 Context 归纳输入中出现，不作为普通后续 Loop 的常驻 Context。归纳器应从当前 Plan 和待执行意图选择所需命令，并在 `executionHandoff.usableFacts` 中以 key=用途、value=完整命令模板和参数/约束/输出用法保存；CLI 实际执行仍必须由模型在本轮 `execute_cli` 中显式提供 argv。

## 12. 命令作为 `usableFacts` 保存（<REDACTED_DATE>）

Context 归纳不再输出 commandGuidance。每一条后续必需 CLI 命令都是一条 `usableFacts`：key 为明确用途，value 必须保留 `libra-cli metrics search ...`、`libra-cli metrics report-data ...`、`libra-cli metrics snapshot ...` 等完整命令前缀与参数模板，不能只留下参数片段。变量替换、数据来源、路径限制和输出续用方式都写在同一 value。

## 13. 项目、事项知识与长期记忆按需检索（<REDACTED_DATE>）

`projectFacts`、Knowledge 与 Long-term Memory 都不再默认注入模型 Context。`core.scope` 仅保留当前项目/事项的已验证标识，模型按当前任务自行检索：

- `search_project_knowledge(query, projectId?, types?, includeContent?)`：只读项目事实和 `initiativeId` 为空的项目级知识。无主题会话不传 `projectId` 时跨全部项目查询，传入时仅查该项目；项目/事项会话只能查询当前项目，传入其他 ID 返回 `needs_input`。不返回事项知识。
- `search_item_knowledge(query, projectId?, initiativeId?, types?, includeContent?)`：只读事项事实和事项级知识。无主题会话可不传目标查询全部事项，或传目标缩小范围；项目会话可查询当前项目下全部事项或其中一个事项；事项会话只允许当前事项。越界目标返回 `needs_input`，不会回退或扩大为其他范围。
- `search_memory(query, projectId?, initiativeId?, types?, includeContent?)`：读取同一内容范围内的长期 Memory 与 `conversation_summary`。无主题会话拥有 global/project/item 全部内容读取权限；项目会话可读取 global、当前项目及其全部事项；事项会话可读取 global、当前项目和当前事项，但均不能读取其他项目/事项。摘要只返回已压缩的更早对话交接，不返回 recent 原始消息，也不是执行完成证据。`data_recovery_profile` 保留 `data.metricGroups` 等显式参数，后续数据工具必须原样复制实际返回值。

三个检索工具都使用通用全文匹配、范围过滤和有限结果返回；无匹配返回空集，不能用最近记录补位。检索本身只读，不改变 Plan、项目状态或外部交付。

`write_local_knowledge(projectId?, initiativeId?, type, title, summary, content, sourceUrl?, imageUrl?)` 是本地 Knowledge 的显式写入工具。它只接受用户明确提供或本次真实 Tool Result 已验证的材料：项目/事项会话默认写入当前项目，无主题会话必须传明确 `projectId`；事项会话只能写入当前事项。服务端验证项目和事项归属，写入后返回 `knowledgeId`，并保留完整 Run Tool Result 审计。不得把模型推测、临时计划或未读取的外部内容写成知识事实。

## 10. 自动化能力注册（<REDACTED_DATE>）

自动化规则只能引用服务端 `AUTOMATION_CAPABILITIES` 中登记的工具能力。规划模型不得生成任意 shell 或未登记动作；服务端必须再次校验每一步具有固定入参或明确变量来源。标记为外部写入的能力必须声明同一目标的读回验证，否则整条规则判定不可实现且不得启用。

## 11. 自动化规划的 Provider tools（<REDACTED_DATE>）

自动化规则规划请求也必须通过 Provider `tools` 参数发送真实 `AGENT_TOOLS` Schema，而不是把能力名称当作普通 Prompt 文本让模型猜参数。规划 Agent 只允许实际执行 `inspect_cli_help` 和 `search_skills` 等只读发现工具；完整执行工具 Schema 同时可见，供模型据此输出 Plan。每个 `execute_cli` Plan 步骤必须使用真实 `cli` 和 `argv` 参数结构，禁止虚构 `action` 参数；没有真实 help、Skill 或事实可支撑的参数必须导致 Plan 不可实现。

## 12. 简化自动化规则与工具选择（<REDACTED_DATE>）

自动化规则识别不调用工具，也不保存工具调用模板。只有自动化任务真正触发后，普通 Agent 才收到完整 `AGENT_TOOLS` Provider Schema，并按现有工具合同自主选择工具和参数；需要 CLI 精确参数时由执行 Agent 调用 `inspect_cli_help`。规则层只负责确定何时、命中谁、要完成什么任务。
