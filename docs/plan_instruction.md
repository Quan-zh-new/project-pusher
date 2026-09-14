# Execution Plan 设计说明

## 1. 定位

Execution Plan 是单次多步骤执行的可审计状态机，持久化在 `state.agentPlans[]`。它将目标拆成可验证的完成项，记录工具证据、开放义务、缺失动作和下一步。它不是用户长期记忆，也不是最终交付物。

简单问答不必为了形式强行创建 Plan；一旦创建，当前 Plan 才是该次执行的唯一状态机。

## 2. 必备结构

Plan 至少包含：目标与项目范围、`completionChecklist`、`obligations`、状态/版本、工具审计、关联 Artifact、`missingActions`、`nextAction`、`goalCompleted`。每个 checklist 项必须可验证，状态为 `completed`、`partial`、`missing` 或 `blocked`，并可附证据/Artifact ID。

不要把“回复用户”单列为 checklist；用户交付是终结消息的职责，而非能让 Plan 自我完成的任务项。

## 3. 运行规则

1. 多步骤任务先由模型创建 Plan，明确可验证 checklist 和必要披露义务。
2. 每轮工具结果可能改变事实；若 `planDelta.reconcile=true`，模型先对账当前 checklist，再决定下一步。
3. partial 不等于停止：完成项可标 completed，但时效/缺失/限制必须写在 note 与 obligation 中并在交付披露。
4. 只有所有 checklist 完成且 obligations 均 `fulfilled` 或 `waived`，才可 `goalCompleted=true`。
5. 终结 `update_execution_plan` 必须带完整的 `userFacingReply`，服务端直接使用它；不得额外发起模型调用，也不得发过程占位文本。
6. 达到循环上限时，Harness 禁止再执行工具，输出基于真实证据的完成、阻塞与下一步；不能把未完成项说成完成。
7. 多 block 飞书写入中途失败时，Plan 不得因部分 block 已有远端副作用而直接 completed，也不得将整批视为完全未执行。先回读目标文档，依据真实已写入/未写入内容将 checklist 标为 partial、missing 或 blocked，并只计划尚未完成的 block。

## 4. 恢复与历史

当前命令授权当前工作。旧 Plan 不能自动恢复，也不能因“继续/重试”等关键词被强行套用。若用户明确要基于旧工作推进，可将旧 Plan 作为候选并创建派生 Plan，使用 `parentPlanId` 与 `resumeMode`（如 adopt/adapt）保留出处，而不修改历史 Plan。历史 Artifact 另行检索和显式选择。

## 5. 完成判定

`agentRun.status=completed` 仅表示运行结束，不等于交付完成。至少对账：Run 的 `goalStatus` 和 loop 上限、Plan checklist/obligations、实际 Tool Result、Artifact 存在性，以及涉及外部系统时的远端结果。缺少任何关键证据时，应真实标记 needs_action/blocked/partial。

## 6. Context 归纳不属于 Plan 状态迁移（<REDACTED_DATE>）

执行上下文归纳是 Harness 的辅助模型调用，不是 Execution Plan checklist，也不改变 Plan revision、completionChecklist、obligation 或 goalCompleted。归纳只重建模型工作集；后续主模型仍依据当前 Plan 和真实工具证据决定更新 Plan。

## 7. Automation Plan（<REDACTED_DATE>）

Automation Plan 是规则级可复用执行模板，与每次运行时创建的普通 Execution Plan 分离。它必须保存触发定义、确定性命中条件、步骤、允许工具、固定入参、变量绑定、风险和外部写入读回。触发后 Automation Plan 作为合成用户输入进入普通 Agent Run；运行时 Agent 仍为本次执行创建 Execution Plan 并依据真实 Tool Result 完成对账。固定入参不得由触发时模型改写。
