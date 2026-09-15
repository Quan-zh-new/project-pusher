# 在线 Demo 部署

Demo 模式保留项目推进器原有的页面、对话、知识库、执行日志和状态保存流程，但不会读取 OpenRouter、飞书、Libra 或本机 CLI。

## 可体验的流程

- 在右侧输入“回收实验数据”，依次模拟查询实验 ID、实验元数据与周期、指标 ID、分版本实验数据及回收检查；每一步的入参和结果都会保留在 AI 执行日志，最终结论写入知识库。
- 该链路还会保留一个脱敏的三轮 Agent Run：Context Builder、初始模型 Prompt/Tool Call、两轮携带 Tool Result 的后续 Prompt/模型回复，以及完成态 Execution Plan。Demo 的 System Prompt 直接复用生产运行时的 `agentInstructions()`；User Prompt 则直接复用 `callAgentModel()` 的 `Context：...\n\n当前命令：...` 格式，并由真实 `buildProjectContext()` 生成四段式 Context。可在“AI 执行日志”展开步骤并查看 Prompt Snapshot。
- 输入“生成评审文档”，得到一篇可打开的演示文档预览。
- 输入任意项目问题，获得基于预置项目状态的风险和下一步建议。

页面顶部会标示演示环境。点击“恢复初始演示”可以清除演示过程中的更改；因此请勿将该环境用作真实数据存储。

## 本地运行

```bash
DEMO_MODE=true HOST=0.0.0.0 npm start
```

首次访问时服务会自动创建 `data/demo-state.json`。该文件只属于 Demo，不会读取或覆盖 `data/state.json`。

## Render 部署

1. 将仓库推送到 GitHub。
2. 在 Render 选择 **New +** → **Blueprint**，连接该仓库。
3. 确认读取 `render.yaml` 并创建服务。
4. 部署完成后，把 Render 给出的 HTTPS 地址分享即可。

也可以新建 Docker Web Service，使用仓库根目录的 `Dockerfile`，并设置环境变量 `DEMO_MODE=true`、`HOST=0.0.0.0`。平台会自动提供 `PORT`。

## 边界

- 演示数据目前由同一服务实例共享；适合产品演示和短时体验。
- 真实数据、API Key、飞书或 Libra 凭据都不应配置到 Demo 服务。
- 若要让每位访客完全独立，需要下一阶段接入 Redis/PostgreSQL，并按访客 Cookie 保存工作区副本。
