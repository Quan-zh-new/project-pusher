# Artifact 与媒体交付设计说明

## 1. 定位

Artifact 是可定位、可验证、可复用的交付物或关键执行产物注册表，存储在 `state.artifacts[]`；媒体文件由 `state.mediaAssets[]` 管理。Artifact 与 Run、Plan、Memory 相互关联但彼此独立：Artifact 可以没有 Plan，Plan 也不能仅凭存在 Artifact 就视为完成。

## 2. Artifact 最小元数据

每条记录至少应能说明：`id`、`type`、`title`、简短 `summary`、项目/事项范围、来源 Run/Plan、创建时间、来源工具、`locator`、完整性和时效状态、替代关系。`locator` 可以是受控外部 URL、文档标识或受管媒体引用；不可把密钥、完整原始输出、任意本机路径或未授权内容暴露给模型。

媒体记录须包含受管文件路径、项目范围、MIME、文件名、来源和 Run。模型只能拿到压缩 Artifact 引用（ID、类型、标题、可公开 URL），不能得到底层文件路径。

## 3. 创建与验证

- 每次外部写入、截图、报告、知识归档等可交付结果都应创建或关联 Artifact。
- Artifact 创建不代表交付成功；必须确认文件/URL/远端文档实际存在且内容与 Tool Result 一致。
- `freshnessStatus`、`integrityStatus` 和数据日期用于避免把 T-2、部分结果或过期内容描述为最新完整数据。
- 一份 Artifact 被新版本替代时使用 `supersededBy` 保留谱系，不静默覆盖历史记录。

## 4. 历史复用与授权

当前 Run 产生的 Artifact 可直接用于同一任务。历史 Artifact、历史 Run（含关联 Plan）证据、历史工具入参/出参与历史对话统一按以下路径查询：

```text
query_agent_history(query, sources, initiativeId, limit)
  -> 返回少量相关执行记录，以及其中可用的 Artifact ID
  -> 返回的 verified Artifact 自动注入本轮可用引用
  -> 后续工具使用这些 Artifact ID
```

不得从未查询的最近对话、旧 Plan 或猜测的本机路径取历史附件。用户后续粘贴或此前产生的图片可跨 Run 复用，但也必须先成为受管媒体/Artifact，位于当前项目/事项范围内，并由本轮 `query_agent_history` 返回。

## 5. 交付声明

最终用户回复只显示真正的交付物、必要链接/网页卡片、时效或阻塞披露及下一步；中间 Tool Result 保留在审计。对外文档/图片交付只有在远端读取回验、相关 Artifact、Run、Plan 和 Tool Result 一致时，才能声明端到端完成。
