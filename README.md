# 项目推进器

## 设计文档集

项目架构与后续迭代约束见 [`docs/README.md`](docs/README.md)。修改 Agent、Prompt、Tool、Memory、Plan、Artifact 或 Skill 前，先阅读对应 `docs/*_instruction.md`；若改变既定边界或 Schema，必须同步更新文档与 `instruction.md`。

## 启动

```bash
npm start
```

默认打开：`http://127.0.0.1:4173`

如端口被占用：

```bash
PORT=4178 npm start
```

## 当前后端

- `server.js`：无依赖 Node.js HTTP 服务，提供静态页面和 REST API。
- `data/state.json`：本地持久化数据文件；首次通过网页启动后自动写入。
- `data/state.example.json`：可提交的脱敏示例状态，不含真实项目文本、链接、图片或执行日志内容。
- `GET /api/state`：读取整个工作区状态。
- `PUT /api/state`：保存整个工作区状态。
- `GET /api/health`：健康检查。
- `POST /api/ai/chat`：基于当前项目 Context 生成结构化 Agent 回答；仅返回建议与草案，不直接改项目数据。
- `POST /api/proposals`：将 AI 草案提交为待确认提案。
- `POST /api/proposals/:id/confirm`：由用户确认后，才将提案写入项目字段。

## AI 执行日志

左侧导航的“AI 执行日志”会记录每次项目 AI 对话的执行情况，便于排查：

- 关联项目 / 事项、用户问题摘要、开始时间与总耗时；
- Context Builder 与模型调用两个步骤的状态；
- 模型标识、请求 ID（若供应商返回）；
- 可公开展示的错误信息。

展开单条日志还可查看实际的 Context Builder 输出、System Prompt、User Prompt 与 Assistant Prompt（模型原始回复）。这些内容仅保存到本机 `data/state.json`，单段最多保留 30,000 个字符；仍不会记录 API Key、鉴权请求头或代理配置。

日志不会记录 API Key，也不会保存完整项目 Context 或模型供应商请求头。最近最多保留 100 条记录，随本地工作区状态一起保存。

## Project Memory

左侧“Project Memory”用于保存项目级或事项级的 Learning 与决策记录。AI 回复可给出候选结论，但只有用户点击“沉淀到 Memory”后才会写入。已写入的结论支持：

- 确认结论：来源升级为 `user_confirmed`；
- 纠正结论：创建 `user_corrected` 新版本，旧版本自动标记为 `superseded`；
- 标记过期：该结论标记为 `expired`，不再进入默认 AI Context。

默认 Context 只会读取当前项目（以及当前事项相关）的 `active` Memory，不会读取被覆盖或过期的结论。

当前前端仍会在浏览器本地保留一份缓存；后端可用时会自动从后端加载并将后续修改同步到 `data/state.json`。这样离线打开 HTML 时不会丢失现有演示能力，正常使用请通过 `npm start` 打开。

> 该版本是单用户本地持久化后端。后续接 PostgreSQL / Supabase 时，可替换 `server.js` 的状态仓储层，而不改变前端工作流。

## 启用真实项目 AI（OpenRouter）

项目 AI 通过本地后端调用 OpenRouter 的 OpenAI 兼容 Chat Completions API；密钥不会发送到浏览器。

```bash
cd "/path/to/project-pusher"
cp .env.example .env
# 编辑 .env：填入 OPENROUTER_API_KEY
npm start
```

可选：在 `.env` 中指定模型（必须是你的 OpenRouter 账号可用的模型 ID）。

```bash
OPENROUTER_MODEL="deepseek/deepseek-v4-pro-0813"
```

启动后，在 `http://127.0.0.1:4173` 打开应用。右侧 AI 会将当前项目或事项、少量相关知识、最近项目对话作为轻量 Context，调用后端的 `POST /api/ai/chat`。

第一期 Agent 会按“已知事实 / 判断与假设 / 建议动作 / 需要确认”输出，并可给出项目字段更新草案。草案必须先提交为待确认提案，再由用户点击“确认写入”；AI 不会直接修改 DDL、卡点、下一步动作或 Learning。

如果没有设置 `OPENROUTER_API_KEY`，右侧 AI 会提示后端未配置密钥，不会暴露或保存密钥到前端。

## 链接抓取与内容同步

在项目或事项的“知识库”列中更新链接后，系统会自动抓取并同步内容到对应项目知识库；AI 的后续对话会读取这份已同步文本，无需额外点击按钮。

- 仅支持公开、无需登录的 HTTP / HTTPS 文本网页或 JSON / XML 数据；
- 飞书 `docx` / `doc` / `wiki` 链接会使用本机已授权的 `lark-cli` 用户身份读取；
- Libra `data.example-company.net/libra/flight/<实验ID>` 链接会通过本项目的 Libra CLI 读取实验基础信息、版本、负责人、流量和建议分析区间；首次使用前需完成 Libra CLI 登录；
- 同步会限制单次保存的文本长度，并拒绝本机和内网地址；
- 需要更新内容时，再次点击 `↻` 即可覆盖此前同步的正文。

### 网络或代理

如果 AI 提示“无法解析 OpenRouter 域名”或 `fetch failed`，说明本机 Node 服务无法连接 OpenRouter，并非项目数据或 API Key 格式错误。若你使用本地代理，在 `.env` 增加代理客户端显示的 **HTTP 代理端口**，然后重启服务：

```dotenv
HTTPS_PROXY=http://127.0.0.1:7890
HTTP_PROXY=http://127.0.0.1:7890
NO_PROXY=localhost,127.0.0.1
```

项目已使用 Node 的 `--use-env-proxy` 启动选项；设置上述变量后，后端 `fetch` 会经代理访问 OpenRouter。不要填写 SOCKS 端口，必须使用代理客户端提供的 HTTP / Mixed 端口。

同步链接后，后端会调用已配置的模型从正文生成一条一句话摘要；若未配置模型或摘要调用失败，则使用本地抽取式摘要作为降级。默认 AI Context 只使用知识标题、类型、摘要和来源链接，不再注入知识正文；需要正文证据时应通过后续的按需检索流程补充。

旧版“已同步链接内容：...”这类占位摘要会在下次读取本地工作区时按已保存正文迁移为一句话摘要，并在下一次状态保存时持久化。


## 脱敏共享包说明

此压缩包可用于共享源码，不包含真实项目状态、图片资产、本地凭据、CLI 缓存、测试文件或私有交接文档。

- `data/state.example.json` 仅保留脱敏后的结构示例；不要将真实 `data/state.json` 放回共享副本。
- AI、飞书或实验数据能力需要使用者配置自己的账号、API Key 与本机 CLI。
- 具体排除和替换规则见 `SANITIZATION_REPORT.json`。
