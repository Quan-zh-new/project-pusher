'use strict';

const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { URL } = require('node:url');
const dns = require('node:dns').promises;
const net = require('node:net');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const { runAgentLoop } = require('./agent-runtime');
const skillLibrary = require('./skill-library');
const {
  AUTOMATION_CAPABILITIES,
  localDateKey: automationLocalDateKey,
  normalizeAutomationPlan,
  validateAutomationPlan,
  actionTargets,
  targetMatches,
  triggerReady,
  triggerCycle,
  automationTaskKey,
  buildAutomationUserInput,
  defaultFlashModel,
} = require('./automation-engine');

const ROOT = __dirname;
const DATA_DIR = path.resolve(process.env.PROJECT_PUSHER_DATA_DIR || path.join(ROOT, 'data'));
const WORKSPACE_ROOT = path.dirname(DATA_DIR);
const DEMO_MODE = /^(1|true|yes)$/i.test(String(process.env.DEMO_MODE || ''));
const STATE_FILE = path.join(DATA_DIR, DEMO_MODE ? 'demo-state.json' : 'state.json');
const ASSET_DIR = path.join(DATA_DIR, 'assets');
const SKILLS_DIR = process.env.SKILLS_DIR_PATH || path.join(DATA_DIR, 'skills');
const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || (DEMO_MODE ? '0.0.0.0' : '127.0.0.1');
const MAX_BODY_BYTES = 25 * 1024 * 1024;
const MAX_MEDIA_UPLOAD_BYTES = 10 * 1024 * 1024;
const MAX_LINK_CONTENT_CHARS = 24000;
const LINK_FETCH_TIMEOUT_MS = 15000;
const LIBRA_CLI = process.env.LIBRA_CLI_PATH || path.join(ROOT, '.venv-libra-cli', 'bin', 'libra-cli');
const execFileAsync = promisify(execFile);
let OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'deepseek/deepseek-v4-pro-0813';
const OPENROUTER_BASE_URL = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';
const CHAT_MODEL_CATALOG = Object.freeze([
  { id:'deepseek/deepseek-v4.1-flash', label:'DeepSeek V4.1 Flash', supportsVision:true },
  { id:'deepseek/deepseek-v4-flash', label:'DeepSeek V4 Flash', supportsVision:false },
  { id:'deepseek/deepseek-v4-pro-0813', label:'DeepSeek V4 Pro', supportsVision:false },
  { id:'xiaomi/mimo-v2.5', label:'MiMo-V2.5', supportsVision:true },
  { id:'google/gemini-3.7-flash', label:'Gemini 3.7 Flash', supportsVision:true },
  { id:'openai/gpt-5.6-luna', label:'GPT-5.6 Luna', supportsVision:true },
]);
const DEMO_AGENT_MODEL = Object.freeze({ id:'demo-agent', label:'Demo Agent（完整模拟链路）', supportsVision:true, source:'demo' });
const MAX_AGENT_LOOP_STEPS = 30;
const MAX_RETRYABLE_FAILURES_PER_TOOL_CALL = 2;
const CONTEXT_NORMAL_CHAR_BUDGET = 32 * 1024;
const CONTEXT_COMPACTION_LOOP_INTERVAL = 6;
const MAX_EXECUTION_HANDOFF_CHARS = 48 * 1024;
const MAX_RECENT_CONVERSATION_MESSAGES = 6;
const MODEL_REQUEST_TIMEOUT_MS = Math.max(5_000, Number(process.env.MODEL_REQUEST_TIMEOUT_MS || 90_000));
const AGENT_MODEL_REQUEST_TIMEOUT_MS = Math.max(5_000, Number(process.env.AGENT_MODEL_REQUEST_TIMEOUT_MS || 300_000));
const CONTEXT_COMPACTION_TIMEOUT_MS = Math.max(2_000, Math.min(MODEL_REQUEST_TIMEOUT_MS, Number(process.env.CONTEXT_COMPACTION_TIMEOUT_MS || 90_000)));
const TOOL_EXECUTION_TIMEOUT_MS = Math.max(5_000, Number(process.env.TOOL_EXECUTION_TIMEOUT_MS || 300_000));
const RETRYABLE_OPERATION_RETRIES = 2;
const RETRYABLE_OPERATION_RETRY_DELAY_MS = 500;
const MODEL_CATALOG_CACHE_TTL_MS = 5 * 60 * 1000;
let modelCatalogCache = { expiresAt:0, models:[] };
const TOOL_EXECUTION_POLICIES = Object.freeze({
  // Independent CLI calls issued in one model response are dispatched as a
  // bounded batch. Results still retain the model-call order for the next
  // loop and for audit; a later call cannot consume an earlier call's result
  // until the model receives that result in the next loop.
  execute_cli: { maxConcurrency:10 },
});
const CLI_OUTPUT_LIMIT_CHARS = 30_000;
const CLI_HELP_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_CLI_HELP_CACHE_ENTRIES = 6;
const MAX_CLI_HELP_CONTEXT_CHARS = 8_000;
const MAX_PERSISTED_CLI_HELP_CACHE_ENTRIES = 24;
const MAX_MANUAL_SKILL_CHARS = 200_000;
const CLI_HELP_CACHE = new Map();
// A public installation starts with no external command registration. Users
// explicitly add the CLI tools they want through project-pusher cli install/add.
const DEFAULT_CLI_REGISTRY = Object.freeze({});

function configuredCliRegistry() {
  let configured = [];
  try { configured = JSON.parse(process.env.PROJECT_PUSHER_CLI_REGISTRY || '[]'); } catch { configured = []; }
  const custom = {};
  for (const item of Array.isArray(configured) ? configured : []) {
    const name = String(item?.name || '').trim();
    const executable = String(item?.executable || '').trim();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$/.test(name) || !executable || /[\0\r\n]/.test(executable) || DEFAULT_CLI_REGISTRY[name]) continue;
    custom[name] = Object.freeze({
      executable, cwd:WORKSPACE_ROOT, timeout:Math.max(5_000, Math.min(300_000, Number(item.timeout || 60_000))), riskLevel:'external_write',
      capabilities:String(item.capabilities || `${name} 外部 CLI。执行前先查询 --help 确认参数和写入语义。`).slice(0, 2000),
      pathArgs:[], artifactRules:[],
    });
  }
  return Object.freeze({ ...DEFAULT_CLI_REGISTRY, ...custom });
}
const CLI_REGISTRY = configuredCliRegistry();

const ACTIVE_AGENT_RUNS = new Map();
const AGENT_EVENT_HISTORY_LIMIT = 60;
const RECENT_AGENT_EVENT_STREAMS = new Map();
const AGENT_EVENT_REPLAY_TTL_MS = 5 * 60 * 1000;
let stateWriteQueue = Promise.resolve();
// A single Node process is the authority for the JSON workspace. Every route
// and Run must mutate this shared object, then queue only the disk snapshot.
// This prevents concurrent Runs from later writing independent stale copies.
let runtimeStateDocument = null;
let runtimeStateLoad = null;
const ALL_AGENT_TOOLS = [
  { type:'function', function:{ name:'search_workspace', description:'在无主题对话中按自然语言跨项目、事项、知识、对话、Agent Run 和 Artifact 检索已保存的工作区证据。默认只返回匹配摘要和所属项目/事项；includeContent=true 时返回知识正文节选。它是只读发现工具，不会默认把全部工作区内容放入 Context，也不会执行写入。', parameters:{type:'object',properties:{query:{type:'string'},sources:{type:'array',items:{type:'string',enum:['project','initiative','knowledge','conversation','agent_run','artifact']}},includeContent:{type:'boolean'},limit:{type:'integer',minimum:1,maximum:12}},required:['query'],additionalProperties:false} } },
  { type:'function', function:{ name:'inspect_cli_help', description:'查询已注册外部 CLI 或其子命令的真实 --help。cli 只能是 Context 中列出的名称；argvPrefix 是不含 --help 的子命令前缀。遇到未知命令、参数、输出格式或写入语义时必须先调用本工具，再依据返回的实际参数说明调用 execute_cli。', parameters:{type:'object',properties:{cli:{type:'string',enum:Object.keys(CLI_REGISTRY)},argvPrefix:{type:'array',items:{type:'string'},maxItems:20}},required:['cli'],additionalProperties:false} } },
  { type:'function', function:{ name:'search_skills', description:'统一检索项目 skills/ 文件树，并返回每个命中 Skill 的完整 Markdown 正文。未传 parentSkillPath 时仅检索父 Skill；传入此前返回的 parentSkillPath 后，仅检索该父目录 references/ 下的子 Skill。命中全文会自动保留在当前 Run 后续 Context。', parameters:{type:'object',properties:{query:{type:'string'},parentSkillPath:{type:'string'},limit:{type:'integer',minimum:1,maximum:8}},additionalProperties:false} } },
  { type:'function', function:{ name:'execute_cli', description:'执行用户已注册外部 CLI 的明确 argv。不得传可执行路径或 shell 字符串；需要确认命令或参数时，调用 inspect_cli_help 查询真实说明。已上传的 Markdown Skill 可按需通过 search_skills 查询。argv 会原样作为参数数组传入，不使用 shell。外部写操作会直接执行并留存审计。一次需要执行多个彼此独立的 CLI 命令时，应在同一条 assistant message 中分别调用本工具，服务端会按受控并发批量执行；后一条命令若依赖前一条的输出、文件或远端写入结果，必须等下一轮取得真实 Result 后再调用。需要受管文件路径时，按已注册 CLI 的帮助和 Skill 约束使用项目内相对路径。', parameters:{type:'object',properties:{cli:{type:'string',enum:Object.keys(CLI_REGISTRY)},argv:{type:'array',minItems:1,maxItems:80,items:{type:'string'}}},required:['cli','argv'],additionalProperties:false} } },
  { type:'function', function:{ name:'read_experiment_metadata', description:'读取一个明确指定的 Libra 实验元数据、完整自然日查询窗口和版本信息。首次数据回收、缺少实验元数据或需要确认查询范围时调用；不查询指标。', parameters:{ type:'object', properties:{ experimentId:{type:'string'} }, required:['experimentId'], additionalProperties:false } } },
  { type:'function', function:{ name:'resolve_metric_specs', description:'将本次任务明确给出的指标组和指标名解析为 Libra 可查询的指标规格。它不读取 Profile、不查询数据。', parameters:{ type:'object', properties:{ experimentId:{type:'string'}, metricGroups:{type:'array',items:{type:'object',properties:{name:{type:'string'},metrics:{type:'array',items:{type:'string'}}},required:['name','metrics'],additionalProperties:false}} }, required:['experimentId','metricGroups'], additionalProperties:false } } },
  { type:'function', function:{ name:'query_metric_data', description:'按本次调用显式提供的 experimentId、metricGroups、experimentVersionIds 和 freshnessPolicy 查询 Libra 指标数据。experimentVersionIds 必须来自本次或当前 Run 的 read_experiment_metadata；需要默认回收全部实验组时，必须把该工具返回的全部 experimentVersionIds 原样写入，而不是传 dimensions。结果会按每个实验版本分别与基准组对比。只能在用户已确认具体指标，或先通过 search_memory 找到 type=data_recovery_profile 的用户确认记录并将其中 data.metricGroups 原样复制进本次参数时调用。不会读取 Memory、不会发布飞书、不会保存知识。', parameters:{ type:'object', properties:{ experimentId:{type:'string'}, metricGroups:{type:'array',items:{type:'object',properties:{name:{type:'string'},metrics:{type:'array',items:{type:'string'}}},required:['name','metrics'],additionalProperties:false}}, experimentVersionIds:{type:'array',minItems:1,items:{type:'string'}}, freshnessPolicy:{type:'object'} }, required:['experimentId','metricGroups','experimentVersionIds','freshnessPolicy'], additionalProperties:false } } },
  { type:'function', function:{ name:'check_experiment_recycle', description:'读取一个明确指定的 Libra 实验的回收和合规信息；不查询指标、不生成报告。', parameters:{type:'object',properties:{experimentId:{type:'string'}},required:['experimentId'],additionalProperties:false} } },
  { type:'function', function:{ name:'capture_metric_snapshot', description:'导出一个明确指定实验和指标组的 Libra 原生表格或趋势图截图。仅生成本地图片 Artifact，不自动保存知识或写飞书。', parameters:{type:'object',properties:{experimentId:{type:'string'},metricGroup:{type:'string'},metricNames:{type:'array',items:{type:'string'}},screenshotType:{type:'string',enum:['table','chart']},metricName:{type:'string'}},required:['experimentId','metricGroup','screenshotType'],additionalProperties:false} } },
  { type:'function', function:{ name:'read_feishu_document', description:'只读查询一个明确指定、当前账号可访问的飞书文档 URL。默认返回正文节选；需要局部改写、替换段落或调整已有图片位置时传 includeBlockIds=true，并在 blockQuery 中描述目标段落/图片，以获得目标附近带 blockId 的结构化片段。不会要求该文档已在知识库中，也不会同步或写入项目知识库。', parameters:{type:'object',properties:{documentUrl:{type:'string'},includeBlockIds:{type:'boolean'},blockQuery:{type:'string'}},required:['documentUrl'],additionalProperties:false} } },
  { type:'function', function:{ name:'read_web_page', description:'只读抓取一个明确指定的公开 HTTP / HTTPS 网页或文本数据 URL，提取标题和正文节选。仅适用于无需登录的外部网页；会拒绝本机、内网、保留地址和非文本响应，并在重定向后再次校验目标。飞书 Docx/Wiki 请使用 read_feishu_document。不会保存知识、不会写入外部系统。', parameters:{type:'object',properties:{url:{type:'string'}},required:['url'],additionalProperties:false} } },
  { type:'function', function:{ name:'query_agent_history', description:'按自然语言查询当前项目的历史 Agent 证据。sources 可省略；不确定该查什么时省略它，工具会在四类记录中统一匹配。四类记录的区别：conversation 只回答历史用户或助手说过什么（旧消息若已裁剪，只返回真实 Conversation Summary）；tool_call 只回答某一次原子工具调用实际传了什么 input、返回什么 output；agent_run 回答一整次任务执行到了哪里，包含关联 Plan 的 checklist、遗留义务、状态和关联 Artifact；artifact 只回答已交付或已生成的受管产物是什么、何时生成、来自哪个 Run/Plan、是否可复用。需要知道历史消息、工具入参/出参、任务进度或可复用交付物时调用。查询结果中的已验证 Artifact 会自动成为本次 Run 可用引用；它不会自动继续、重试、修改旧 Plan 或执行外部操作。', parameters:{type:'object',properties:{query:{type:'string'},initiativeId:{type:'string'},sources:{type:'array',items:{type:'string',enum:['conversation','tool_call','agent_run','artifact']}},limit:{type:'integer',minimum:1,maximum:8}},required:['query'],additionalProperties:false} } },
  { type:'function', function:{ name:'search_project_knowledge', description:'按自然语言检索项目事实和项目级知识库；不检索事项级知识。内容范围由当前会话统一决定：无主题会话可省略 projectId 查询全部项目；项目/事项会话只能查询当前项目，即使传入其他 projectId 也会被拒绝。无主题会话传 projectId 时仅查询该项目。项目事实以 source=project_facts 返回，项目级知识以 source=knowledge 返回。', parameters:{type:'object',properties:{projectId:{type:'string'},query:{type:'string'},types:{type:'array',items:{type:'string',enum:['会议与决策','实验与数据','方案与需求','经验与踩坑']}},includeContent:{type:'boolean'}},required:['query'],additionalProperties:false} } },
  { type:'function', function:{ name:'search_item_knowledge', description:'按自然语言检索事项事实和事项级知识库；不检索项目级知识。内容范围由当前会话统一决定：无主题会话可省略 target 查询全部事项，或传 projectId/initiativeId 缩小范围；项目会话可读取当前项目下全部事项，传 initiativeId 时仅限该项目的该事项；事项会话只能读取当前事项，不能扩展到同项目其他事项或其他项目。', parameters:{type:'object',properties:{projectId:{type:'string'},initiativeId:{type:'string'},query:{type:'string'},types:{type:'array',items:{type:'string',enum:['会议与决策','实验与数据','方案与需求','经验与踩坑']}},includeContent:{type:'boolean'}},required:['query'],additionalProperties:false} } },
  { type:'function', function:{ name:'search_memory', description:'按自然语言检索内容范围内的长期 Memory 和 conversation_summary。内容范围由当前会话统一决定：无主题会话可查询全部 global/project/item Memory 与各级摘要，也可传 projectId/initiativeId 缩小范围；项目会话可读取 global、当前项目及其全部事项的 Memory/摘要；事项会话可读取 global、当前项目级和当前事项级的 Memory/摘要。项目/事项会话不得读取其他项目/事项内容。type=data_recovery_profile 的结果包含可显式复制的 data.metricGroups 等参数。', parameters:{type:'object',properties:{projectId:{type:'string'},initiativeId:{type:'string'},query:{type:'string'},types:{type:'array',items:{type:'string',enum:['work_preference','delivery_format','metric_caliber','data_asset','collaboration_rule','project_background','project_history','project_status','current_focus','learning','decision','data_recovery_profile','conversation_summary']}},includeContent:{type:'boolean'}},required:['query'],additionalProperties:false} } },
  { type:'function', function:{ name:'create_feishu_document', description:'创建一篇新的飞书文档。必须显式提供 title 和 content；不复用旧文档。', parameters:{type:'object',properties:{title:{type:'string'},content:{type:'string'}},required:['title','content'],additionalProperties:false} } },
  { type:'function', function:{ name:'append_feishu_document', description:'向明确给出的飞书 documentUrl 追加 content。', parameters:{type:'object',properties:{documentUrl:{type:'string'},content:{type:'string'}},required:['documentUrl','content'],additionalProperties:false} } },
  { type:'function', function:{ name:'replace_feishu_document_text', description:'局部修改已有飞书文档中已经读取到的明确原文片段，而不是在文末追加。先调用 read_feishu_document 获取 documentUrl 和原文；再显式传入 documentUrl、originalText（文档中唯一的待替换原文）与 replacement（替换后的内容，可为空以删除）。仅替换该原文片段，不覆盖其他内容；若要整篇重写或按 block 重排，应先说明需要更精确的文档结构信息，不能把 append 当作修改。', parameters:{type:'object',properties:{documentUrl:{type:'string'},originalText:{type:'string',minLength:1},replacement:{type:'string'}},required:['documentUrl','originalText','replacement'],additionalProperties:false} } },
  { type:'function', function:{ name:'replace_feishu_document_blocks', description:'按已读取的飞书 blockId 精确替换一个或多个已有段落/标题/图片等 block。先用 read_feishu_document(includeBlockIds=true) 定位 blockId；每项传完整 XML block content。适用于跨段落修改、替换对应位置内容或更新 demo 图，不能降级为 append，也不能猜测 blockId。', parameters:{type:'object',properties:{documentUrl:{type:'string'},blocks:{type:'array',minItems:1,items:{type:'object',properties:{blockId:{type:'string',minLength:1},content:{type:'string'}},required:['blockId','content'],additionalProperties:false}}},required:['documentUrl','blocks'],additionalProperties:false} } },
  { type:'function', function:{ name:'replace_feishu_document_images', description:'将已有飞书文档中的明确图片 block 替换为受管图片 Artifact，并保留在原位置附近。先用 read_feishu_document(includeBlockIds=true, blockQuery) 获取旧 imageBlockId 和相邻的唯一 anchorText；每项传 imageBlockId、artifactId、anchorText，默认在 anchorText 前插入新图后删除旧图。不得传本地路径、猜测 imageBlockId 或改为文末插图。', parameters:{type:'object',properties:{documentUrl:{type:'string'},replacements:{type:'array',minItems:1,items:{type:'object',properties:{imageBlockId:{type:'string',minLength:1},artifactId:{type:'string',minLength:1},anchorText:{type:'string',minLength:1},caption:{type:'string'}},required:['imageBlockId','artifactId','anchorText'],additionalProperties:false}}},required:['documentUrl','replacements'],additionalProperties:false} } },
  { type:'function', function:{ name:'insert_document_images', description:'将明确指定的图片 Artifact 插入明确给出的飞书 documentUrl。传 artifactIds，不传本地路径或 mediaAssetId。每个 Artifact 必须属于当前项目、为已验证图片，且必须是本次 Run 新生成的 Artifact，或本轮 query_agent_history 返回的历史 Artifact；不会寻找最近报告或自动创建文档。', parameters:{type:'object',properties:{documentUrl:{type:'string'},artifactIds:{type:'array',items:{type:'string'},minItems:1}},required:['documentUrl','artifactIds'],additionalProperties:false} } },
  { type:'function', function:{ name:'write_local_knowledge', description:'将已由用户明确提供或本次真实 Tool Result 验证的信息写入本地知识库（state.knowledgeItems）。项目/事项会话默认写入当前项目；无主题会话必须传已知 projectId。传 initiativeId 可写入该项目的明确事项；事项会话只能写入当前事项。必须提供可检索的标题、摘要和正文；不得把模型推测、临时计划或未经读取/验证的外部内容当作事实保存。结果返回 knowledgeId，后续可用 search_project_knowledge 或 search_item_knowledge 检索。', parameters:{type:'object',properties:{projectId:{type:'string'},initiativeId:{type:'string'},type:{type:'string',enum:['会议与决策','实验与数据','方案与需求','经验与踩坑']},title:{type:'string',minLength:1},summary:{type:'string',minLength:1},content:{type:'string',minLength:1},sourceUrl:{type:'string'},imageUrl:{type:'string'}},required:['type','title','summary','content'],additionalProperties:false} } },
  { type:'function', function:{ name:'update_long_term_memory', description:'在本轮用户原话明确确认、纠正或设定了可复用的长期偏好、项目事实或 data_recovery_profile 时，必须调用此工具自动沉淀；不要只在回复中说“已记住”，也不要生成需要用户再次点击保存的候选项。scope 由你根据语义判断：与当前项目、具体事项、实验、事件、依赖、项目指标或项目决策强相关时写 project；脱离当前项目仍成立的工作方式、交付格式、通用协作规则或数据口径写 global。不得要求用户额外声明“所有项目适用”。不得记录模型推测、临时执行过程或未验证结论。data_recovery_profile 必须在 data 中显式包含 metricGroups。', parameters:{type:'object',properties:{scope:{type:'string',enum:['global','project']},type:{type:'string',enum:['work_preference','delivery_format','metric_caliber','data_asset','collaboration_rule','project_background','project_history','project_status','current_focus','learning','decision','data_recovery_profile']},statement:{type:'string'},content:{type:'string'},evidence:{type:'string'},data:{type:'object'}},required:['scope','type','statement'],additionalProperties:false} } },
  { type:'function', function:{ name:'create_execution_plan', description:'为多步骤任务创建本次 Run 的 Execution Plan，并为每个可执行、可验证的工作给出 completionChecklist。不要把“回复用户/交付聊天结果”单列为 checklist：终结 userFacingReply 负责该交付。若本轮已通过 query_agent_history 找到需要引用的旧 Plan，可传其 planId 作为 resumeCandidatePlanId 和 resumeMode=adopt 或 adapt，创建新的派生 Plan；旧 Plan只提供已完成事实和未完成项线索，绝不自动覆盖当前命令。', parameters:{type:'object',properties:{goal:{type:'string'},taskType:{type:'string'},resumeCandidatePlanId:{type:'string'},resumeMode:{type:'string',enum:['adopt','adapt']},completionChecklist:{type:'array',items:{type:'object',properties:{id:{type:'string'},description:{type:'string'}},required:['id','description'],additionalProperties:false}}},required:['goal','completionChecklist'],additionalProperties:false} } },
  { type:'function', function:{ name:'update_execution_plan', description:'更新明确指定的 Execution Plan 版本。必须传当前 planId 与 revision，并逐项更新 completionChecklist 和需要结清的 obligations。只有每一项 completionChecklist 都 completed 且不存在 open obligation 时才可以 goalCompleted=true；否则必须列出 missingActions 和 nextAction。userFacingReply 每次必传：未终结时传空字符串；goalCompleted=true 时必须传可直接发送给用户的完整交付，包含真实结果、链接（如有）、必要披露和下一步。', parameters:{type:'object',properties:{planId:{type:'string'},revision:{type:'integer'},goalCompleted:{type:'boolean'},completionChecklist:{type:'array',items:{type:'object',properties:{id:{type:'string'},status:{type:'string',enum:['completed','partial','missing','blocked']},note:{type:'string'}},required:['id','status'],additionalProperties:false}},obligations:{type:'array',items:{type:'object',properties:{id:{type:'string'},status:{type:'string',enum:['fulfilled','waived']},evidence:{type:'string'}},required:['id','status'],additionalProperties:false}},missingActions:{type:'array',items:{type:'string'}},nextAction:{type:'string'},summary:{type:'string'},userFacingReply:{type:'string'}},required:['planId','revision','goalCompleted','completionChecklist','userFacingReply'],additionalProperties:false} } },
];
// Legacy handlers stay available for already-persisted Run records, but new
// provider requests only receive the generic CLI contract for external systems.
const LEGACY_AGENT_TOOL_NAMES = new Set([
  // Kept only to read historical Run records created before write_local_knowledge.
  'save_knowledge_artifact',
  // Temporarily withheld from model requests while the history projection is
  // being rebuilt. The handler remains for audit and direct regression tests.
  'query_agent_history',
  'search_project_history', 'search_artifacts', 'select_artifacts_for_task',
]);
// Internal Libra handlers remain only to read historical Run records. They are
// deliberately absent from all public/provider and request-inspector lists.
const INTERNAL_ONLY_AGENT_TOOL_NAMES = new Set([
  'read_experiment_metadata', 'resolve_metric_specs', 'query_metric_data',
  'check_experiment_recycle', 'capture_metric_snapshot',
]);
const AGENT_TOOLS = Object.freeze(ALL_AGENT_TOOLS.filter((tool) => !LEGACY_AGENT_TOOL_NAMES.has(tool.function.name) && !INTERNAL_ONLY_AGENT_TOOL_NAMES.has(tool.function.name)));

function publicAgentRun(run) {
  return { id:run.id, type:run.type, status:run.status, projectId:run.projectId, initiativeId:run.initiativeId, messagePreview:run.messagePreview, startedAt:run.startedAt, completedAt:run.completedAt, durationMs:run.durationMs, model:run.model, requestId:run.requestId, error:run.error, planId:run.planId || '', planRef:run.planRef || null, goalStatus:run.goalStatus || '', selectedArtifactRefs:run.selectedArtifactRefs || [], selectedSkillRefs:run.selectedSkillRefs || [], discoveredSkillRefs:run.discoveredSkillRefs || [], executionHandoff:handoffForModel(run.executionHandoff), executionHandoffAudit:{ coveredToolCallIds:run.executionHandoffCoveredToolCallIds || run.executionHandoff?.coveredToolCallIds || [], failure:run.executionHandoffFailure || null }, loop:run.loop || null, stopRequestedAt:run.stopRequestedAt || '', steps:run.steps || [] };
}

function publishAgentEvent(runId, type, extra = {}) {
  const active = ACTIVE_AGENT_RUNS.get(runId);
  if (!active) return;
  const payload = { type, at:new Date().toISOString(), run:publicAgentRun(active.run), ...extra };
  active.events.push(payload);
  active.events = active.events.slice(-AGENT_EVENT_HISTORY_LIMIT);
  const wire = `event: progress\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const response of active.subscribers) response.write(wire);
}

function closeAgentEventStream(runId, type) {
  const active = ACTIVE_AGENT_RUNS.get(runId);
  if (!active) return;
  publishAgentEvent(runId, type);
  RECENT_AGENT_EVENT_STREAMS.set(runId, { events:[...active.events], expiresAt:Date.now() + AGENT_EVENT_REPLAY_TTL_MS });
  for (const response of active.subscribers) response.end();
  active.subscribers.clear();
}

function getAgentEventReplay(runId) {
  for (const [id, entry] of RECENT_AGENT_EVENT_STREAMS) if (entry.expiresAt <= Date.now()) RECENT_AGENT_EVENT_STREAMS.delete(id);
  return RECENT_AGENT_EVENT_STREAMS.get(runId) || null;
}

const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
};

async function ensureDataDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

// Keep onboarding diagnostics deliberately non-sensitive: this endpoint reports
// readiness only and never returns keys, proxy URLs, or command output.
async function integrationSetupStatus() {
  const commandAvailable = async (executable) => {
    try {
      await execFileAsync(executable, ['--help'], { timeout:5_000, maxBuffer:128 * 1024 });
      return true;
    } catch (error) {
      return error?.code !== 'ENOENT';
    }
  };
  // lark-cli and libra-cli are invoked only when a user explicitly uses the
  // corresponding capability. Do not probe them during general onboarding:
  // most installations do not use either integration.
  const configuredCliEntries = Object.entries(CLI_REGISTRY)
    .filter(([name]) => !Object.hasOwn(DEFAULT_CLI_REGISTRY, name));
  const installedCli = (await Promise.all(configuredCliEntries.map(async ([name, definition]) => ({
    name,
    installed:await commandAvailable(definition.executable),
    command:definition.executable,
    capabilities:definition.capabilities,
  })))).filter((cli) => cli.installed);
  return {
    server:{ running:true, host:HOST, port:PORT, demo:DEMO_MODE },
    ai:{ configured:Boolean(OPENROUTER_API_KEY), model:OPENROUTER_MODEL, provider:'OpenRouter' },
    cli:{ installed:installedCli },
  };
}

function allowsLocalApiKeySetup() {
  return !DEMO_MODE && ['127.0.0.1', 'localhost', '::1'].includes(HOST);
}

async function saveOpenRouterApiKey(value) {
  const apiKey=String(value || '').trim();
  if (apiKey.length < 12 || apiKey.length > 1000 || /[\r\n\0]/.test(apiKey)) throw Object.assign(new Error('API Key 格式无效。'), { statusCode:422 });
  const envFile=path.join(ROOT, '.env');
  const existing=await fs.readFile(envFile, 'utf8').catch((error) => error?.code === 'ENOENT' ? '' : Promise.reject(error));
  const entry=`OPENROUTER_API_KEY=${apiKey}`;
  const updated=/^\s*OPENROUTER_API_KEY\s*=.*$/m.test(existing)
    ? existing.replace(/^\s*OPENROUTER_API_KEY\s*=.*$/m, entry)
    : `${existing}${existing && !existing.endsWith('\n') ? '\n' : ''}${entry}\n`;
  await fs.writeFile(envFile, updated, { mode:0o600 });
  await fs.chmod(envFile, 0o600);
  OPENROUTER_API_KEY=apiKey;
  modelCatalogCache={ expiresAt:0, models:[] };
}

function createDemoState() {
  const now = new Date().toISOString();
  return {
    selectedProjectId:'demo-growth', selectedInitiativeId:'demo-exp', selectedConversationId:'demo-conversation',
    knowledgeFilter:{ projectId:'ALL', query:'', type:'ALL' }, progressOptions:['未开始','待排期','推进中','实验中','风险','已完成'],
    projects:[{
      id:'demo-growth', priority:'P0', name:'新用户首周留存增长', plannedEnd:'2026-10-18', progress:['实验中'],
      currentState:'已完成新手引导 A/B 实验第一阶段；核心漏斗保持稳定，正在验证首周留存提升。',
      blocker:'实验组样本量尚不足以对次日留存做最终结论。', nextAction:'回收实验数据并输出评审结论', nextActionDdl:'2026-09-18',
      learning:'先确认指标口径和最小样本量，再决定是否扩大流量。', teams:['产品','设计','服务端','前端','DS'], knowledgeLinks:[], currentStateImages:[], learningImages:[],
      initiatives:[{ id:'demo-exp', priority:'P0', name:'新手引导分层实验', plannedEnd:'2026-09-20', progress:['实验中'], actionDone:false, archived:false,
        currentState:'实验 EXP-DEMO-2026-01 已运行 8 天，对照组与实验组各覆盖约 12 万用户。', blocker:'次日留存尚未达到预设显著性阈值。', nextAction:'回收核心指标并形成是否扩量建议', nextActionDdl:'2026-09-18', learning:'避免只看点击率；以激活完成率与次日留存共同决策。', teams:['产品','DS','前端'], knowledgeLinks:[], currentStateImages:[], learningImages:[] }]
    }],
    knowledgeItems:[
      { id:'demo-knowledge-prd', projectId:'demo-growth', initiativeId:'demo-exp', type:'方案与需求', title:'新手引导分层实验方案', summary:'实验组按用户意图展示分层引导；核心目标是提升激活完成率与次日留存。', content:'实验 ID：EXP-DEMO-2026-01\n对照组：标准三步引导\n实验组：按意图分层的两步引导\n主指标：激活完成率、次日留存。', sourceType:'demo_seed', createdAt:'2026-09-06' },
      { id:'demo-knowledge-metric', projectId:'demo-growth', initiativeId:'demo-exp', type:'实验与数据', title:'实验指标口径', summary:'激活完成率以首次完成关键动作计；次日留存以自然日回访计。', content:'激活完成率 = 完成关键动作用户 / 进入引导用户。\n次日留存 = 次日有活跃行为用户 / 首日进入实验用户。', sourceType:'demo_seed', createdAt:'2026-09-06' }
    ],
    conversations:[{ id:'demo-conversation', scope:'initiative', projectId:'demo-growth', initiativeId:'demo-exp', title:'事项 · 新手引导分层实验', createdAt:now, updatedAt:now, memory:[{ role:'assistant', text:'这里是可安全体验的演示环境。可以试试“回收实验数据”或“生成评审文档”。', createdAt:now }], conversationSummary:null }],
    longTermMemories:[{ id:'demo-memory', memoryKey:'demo-metric', scope:'project', projectId:'demo-growth', initiativeId:'', type:'metric_caliber', statement:'决策以激活完成率和次日留存共同判断，不能只看点击率。', data:{ content:'已确认的演示指标口径。' }, source:'user_confirmed', confidence:'high', status:'active', version:1, createdAt:now, updatedAt:now }],
    agentRuns:[], agentPlans:[], artifacts:[], mediaAssets:[], dataRecoveryReports:[], proposals:[], notifications:[], automationRules:[], automationPlans:[], automationTasks:[], demoDocuments:[]
  };
}

async function readStoredState() {
  if (runtimeStateDocument) return runtimeStateDocument;
  if (runtimeStateLoad) return runtimeStateLoad;
  runtimeStateLoad = (async () => {
  try {
    const text = await fs.readFile(STATE_FILE, 'utf8');
    const document = JSON.parse(text);
    if (document?.state && typeof document.state === 'object') {
      runtimeStateDocument = document;
      const before = JSON.stringify(document.state);
      normalizeProjectDateFields(document.state);
      normalizeAutomationState(document.state);
      normalizeNotifications(document.state);
      repairMissingAgentWrittenKnowledge(document.state);
      normalizeInterruptedAgentRuns(document.state);
      refreshLegacyKnowledgeSummaries(document.state);
      normalizeDataRecoveryProfiles(document.state);
      normalizeLongTermMemoryStore(document.state);
      normalizeConversationMemoryStore(document.state);
      normalizeExecutionPlans(document.state);
      normalizeAgentLoopAuditInputs(document.state);
      normalizeMediaAssets(document.state);
      normalizeArtifactRegistry(document.state);
      normalizeCliHelpCache(document.state);
      normalizeSkills(document.state);
      await skillLibrary.migrateLegacySkills(SKILLS_DIR, document.state);
      if (JSON.stringify(document.state) !== before) await writeStoredState(document.state);
    }
    return document && typeof document === 'object' ? document : null;
  } catch (error) {
    if (error.code === 'ENOENT' && DEMO_MODE) {
      const state = createDemoState();
      await writeStoredState(state);
      return runtimeStateDocument;
    }
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  })();
  try {
    return await runtimeStateLoad;
  } finally {
    runtimeStateLoad = null;
  }
}

async function writeJsonAtomically(filePath, value) {
  const temporaryFile = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  await fs.writeFile(temporaryFile, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.rename(temporaryFile, filePath);
}

function writeStoredState(state) {
  if (runtimeStateDocument?.state && runtimeStateDocument.state !== state) {
    for (const key of Object.keys(runtimeStateDocument.state)) delete runtimeStateDocument.state[key];
    Object.assign(runtimeStateDocument.state, state);
    state = runtimeStateDocument.state;
  }
  const save = async () => {
    normalizeProjectDateFields(state);
    normalizeLongTermMemoryStore(state);
    normalizeConversationMemoryStore(state);
    normalizeExecutionPlans(state);
    normalizeAgentLoopAuditInputs(state);
    normalizeMediaAssets(state);
    normalizeArtifactRegistry(state);
    normalizeCliHelpCache(state);
    normalizeSkills(state);
    prunePromptSnapshots(state);
    await ensureDataDir();
    const document = {
      version: 1,
      updatedAt: new Date().toISOString(),
      state,
    };
    runtimeStateDocument = document;
    await writeJsonAtomically(STATE_FILE, document);
    return document;
  };
  const pending = stateWriteQueue.then(save, save);
  stateWriteQueue = pending.catch(() => {});
  return pending;
}

function normalizeProjectDateFields(state) {
  if (!state || !Array.isArray(state.projects)) return;
  const dateOnly = (value) => typeof value === 'string' ? value.slice(0, 10) : '';
  for (const project of state.projects) {
    project.plannedEnd = dateOnly(project.plannedEnd);
    project.nextActionDdl = dateOnly(project.nextActionDdl);
    for (const initiative of project.initiatives || []) {
      initiative.plannedEnd = dateOnly(initiative.plannedEnd);
      initiative.nextActionDdl = dateOnly(initiative.nextActionDdl);
    }
  }
}

function progressLabel(value) {
  if (Array.isArray(value)) return value.map((item) => String(item || '').trim()).filter(Boolean).join(' · ');
  return String(value || '');
}

function normalizeAutomationState(state) {
  if (!state || typeof state !== 'object') return;
  if (!Array.isArray(state.automationRules)) state.automationRules = [];
  if (!Array.isArray(state.automationPlans)) state.automationPlans = [];
  if (!Array.isArray(state.automationTasks)) state.automationTasks = [];
  state.automationPlans = state.automationPlans.slice(0, 50).map((plan) => {
    const validation = validateAutomationPlan(plan?.plan || {});
    return { ...plan, feasible:validation.feasible, errors:validation.errors };
  });
  state.automationRules = state.automationRules.slice(0, 20).map((rule) => ({
    ...rule,
    enabled:Boolean(rule?.enabled) && Boolean(state.automationPlans.find((plan) => plan.id === rule?.automationPlanId)?.feasible),
    version:Math.max(1, Number(rule?.version || 1)),
    title:String(rule?.title || '未命名自动化规则'),
    modelId:String(rule?.modelId || ''),
  }));
  state.automationTasks = state.automationTasks.slice(0, 200).map((task) => ({
    ...task,
    status:['pending','running','completed','partial','failed','blocked'].includes(task?.status) ? task.status : 'pending',
    readDates:Array.isArray(task?.readDates) ? task.readDates.map(String) : [],
  }));
}

function normalizeNotifications(state) {
  if (!state || typeof state !== 'object') return;
  if (!Array.isArray(state.notifications)) state.notifications=[];
  state.notifications = state.notifications.slice(0,200).map((item) => ({
    id:String(item?.id || `notification-${Date.now()}-${Math.random().toString(16).slice(2)}`),
    type:String(item?.type || 'ai_message'), title:String(item?.title || 'AI 消息').slice(0,240), body:String(item?.body || '').slice(0,2000),
    conversationId:String(item?.conversationId || ''), projectId:String(item?.projectId || ''), initiativeId:String(item?.initiativeId || ''),
    runId:String(item?.runId || ''), automationTaskId:String(item?.automationTaskId || ''), createdAt:item?.createdAt || new Date().toISOString(), readAt:item?.readAt || '',
  })).sort((a,b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

function createInAppNotification(state, { title, body, conversation, run, automationTaskId = '' }) {
  normalizeNotifications(state);
  const notification = { id:`notification-${Date.now()}-${Math.random().toString(16).slice(2)}`, type:run?.type === 'automation_execution' ? 'automation_result' : 'ai_message', title:String(title || 'AI 消息'), body:String(body || '').slice(0,2000), conversationId:String(conversation?.id || ''), projectId:String(conversation?.projectId || run?.projectId || ''), initiativeId:String(conversation?.initiativeId || run?.initiativeId || ''), runId:String(run?.id || ''), automationTaskId:String(automationTaskId || run?.automationTaskId || ''), createdAt:new Date().toISOString(), readAt:'' };
  state.notifications.unshift(notification); state.notifications=state.notifications.slice(0,200);
  return notification;
}

const SERVER_MANAGED_STATE_KEYS = Object.freeze(['agentRuns','agentPlans','dataRecoveryReports','artifacts','mediaAssets','cliHelpCache','skills','automationRules','automationPlans','automationTasks','notifications','longTermMemories','demoDocuments']);

function knowledgeUpdatedAt(item) {
  const value = Date.parse(String(item?.updatedAt || item?.syncedAt || item?.createdAt || ''));
  return Number.isFinite(value) ? value : 0;
}

function agentWrittenKnowledge(item) {
  return item?.sourceType === 'agent_written';
}

function repairMissingAgentWrittenKnowledge(state) {
  if (!state || !Array.isArray(state.agentRuns)) return 0;
  state.knowledgeItems ||= [];
  const existingIds = new Set(state.knowledgeItems.map((item) => String(item?.id || '')).filter(Boolean));
  let restored = 0;
  for (const run of state.agentRuns) {
    for (const step of run?.steps || []) {
      const output = step?.output;
      if (step?.type !== 'tool' || output?.name !== 'write_local_knowledge' || output?.status !== 'completed') continue;
      const knowledgeId = String(output?.data?.knowledgeId || '').trim();
      const input = output?.input && typeof output.input === 'object' ? output.input : step.input;
      const projectId = String(output?.data?.projectId || run?.projectId || '').trim();
      const initiativeId = String(output?.data?.initiativeId || run?.initiativeId || '').trim();
      if (!knowledgeId || existingIds.has(knowledgeId) || !projectId || !input || !String(input.title || '').trim() || !String(input.summary || '').trim() || !String(input.content || '').trim()) continue;
      const updatedAt = String(run?.completedAt || run?.startedAt || new Date().toISOString());
      state.knowledgeItems.unshift({
        id:knowledgeId,
        projectId,
        initiativeId,
        type:String(input.type || '实验与数据'),
        title:String(input.title).trim(),
        summary:String(input.summary).trim(),
        content:String(input.content).trim(),
        sourceUrl:String(input.sourceUrl || output?.data?.sourceUrl || '').trim(),
        createdAt:updatedAt.slice(0, 10),
        updatedAt,
        sourceType:'agent_written',
        recoveredFromRunId:String(run?.id || ''),
        recoveredFromToolCallId:String(output?.toolCallId || ''),
      });
      existingIds.add(knowledgeId);
      restored += 1;
    }
  }
  return restored;
}

function mergeKnowledgeItems(storedItems, clientItems) {
  const stored = Array.isArray(storedItems) ? storedItems : [];
  const client = Array.isArray(clientItems) ? clientItems : [];
  const clientById = new Map(client.filter((item) => item?.id).map((item) => [String(item.id), item]));
  const merged = [];
  for (const item of stored) {
    const clientItem = clientById.get(String(item.id));
    clientById.delete(String(item.id));
    if (!agentWrittenKnowledge(item)) {
      if (clientItem) merged.push(clientItem);
      continue;
    }
    // An Agent write is authoritative until the user explicitly edits that
    // exact record with a newer timestamp. A stale browser snapshot cannot
    // remove a successful model-side knowledge write.
    merged.push(clientItem && knowledgeUpdatedAt(clientItem) > knowledgeUpdatedAt(item) ? clientItem : item);
  }
  for (const item of clientById.values()) merged.push(item);
  return merged;
}

function mergeClientStateSnapshot(storedState, clientState) {
  const merged = { ...(storedState && typeof storedState === 'object' ? storedState : {}), ...(clientState && typeof clientState === 'object' ? clientState : {}) };
  for (const key of SERVER_MANAGED_STATE_KEYS) {
    if (storedState && Object.prototype.hasOwnProperty.call(storedState, key)) merged[key] = storedState[key];
  }
  if (Array.isArray(storedState?.knowledgeItems) || Array.isArray(clientState?.knowledgeItems)) {
    merged.knowledgeItems = mergeKnowledgeItems(storedState?.knowledgeItems, clientState?.knowledgeItems);
  }
  if (Array.isArray(storedState?.conversations)) {
    const clientConversations = Array.isArray(clientState?.conversations) ? clientState.conversations : [];
    const storedById = new Map(storedState.conversations.map((item) => [String(item.id), item]));
    for (const item of clientConversations) if (item?.id && !storedById.has(String(item.id))) storedById.set(String(item.id), item);
    merged.conversations = [...storedById.values()];
  }
  return merged;
}

function conversationStore(project, initiativeId = '') {
  const initiative = initiativeId ? (project?.initiatives || []).find((item) => item.id === initiativeId) : null;
  return initiative || project || null;
}

function conversationScope(projectId = '', initiativeId = '') { return initiativeId ? 'initiative' : projectId ? 'project' : 'global'; }
function conversationTitle(scope, project, initiative) { return scope === 'initiative' ? `事项 · ${initiative?.name || '未命名事项'}` : scope === 'project' ? `项目 · ${project?.name || '未命名项目'}` : '无主题对话'; }
function normalizeConversationThread(thread, state) {
  const projectId=String(thread?.projectId || ''); const initiativeId=String(thread?.initiativeId || '');
  const project=projectId ? findProject(state, projectId) : null;
  const initiative=initiativeId ? project?.initiatives?.find((item) => item.id === initiativeId) : null;
  const scope=['global','project','initiative'].includes(thread?.scope) ? thread.scope : conversationScope(projectId, initiativeId);
  return { id:String(thread?.id || `conversation-${Date.now()}-${Math.random().toString(16).slice(2)}`), scope, projectId:scope === 'global' ? '' : projectId, initiativeId:scope === 'initiative' ? initiativeId : '', title:String(thread?.title || conversationTitle(scope, project, initiative)).slice(0,240), memory:Array.isArray(thread?.memory) ? thread.memory : [], conversationSummary:thread?.conversationSummary && typeof thread.conversationSummary === 'object' ? thread.conversationSummary : null, createdAt:thread?.createdAt || new Date().toISOString(), updatedAt:thread?.updatedAt || thread?.createdAt || new Date().toISOString() };
}
function normalizeConversationThreads(state) {
  if (!state || !Array.isArray(state.projects)) return;
  if (!Array.isArray(state.conversations)) state.conversations=[];
  const known=new Set(state.conversations.map((item) => String(item?.id || '')));
  for (const project of state.projects) {
    const legacy=[{ id:`legacy-project-${project.id}`, scope:'project', projectId:project.id, memory:project.memory, conversationSummary:project.conversationSummary }, ...(project.initiatives || []).map((initiative) => ({ id:`legacy-initiative-${initiative.id}`, scope:'initiative', projectId:project.id, initiativeId:initiative.id, memory:initiative.memory, conversationSummary:initiative.conversationSummary }))];
    for (const thread of legacy) if (!known.has(thread.id) && ((thread.memory || []).length || thread.conversationSummary?.summary)) { state.conversations.push(normalizeConversationThread(thread, state)); known.add(thread.id); }
  }
  state.conversations=state.conversations.map((thread) => normalizeConversationThread(thread, state)).filter((thread) => thread.scope === 'global' || (findProject(state, thread.projectId) && (!thread.initiativeId || findProject(state, thread.projectId)?.initiatives?.some((item) => item.id === thread.initiativeId)))).sort((a,b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0,200);
  for (const thread of state.conversations) normalizeConversationStore(thread);
  if (state.selectedConversationId && !state.conversations.some((thread) => thread.id === state.selectedConversationId)) state.selectedConversationId='';
}
function findConversation(state, conversationId) { normalizeConversationThreads(state); return state.conversations.find((thread) => thread.id === String(conversationId || '')) || null; }

function normalizeConversationStore(store) {
  if (!store) return;
  if (!Array.isArray(store.memory)) store.memory = [];
  const summary = store.conversationSummary;
  const coveredMessageCount = Number(summary?.coveredMessageCount || 0);
  const overflow = store.memory.length - MAX_RECENT_CONVERSATION_MESSAGES;

  // Earlier versions wrote every raw chat message permanently while using
  // `slice(-6)` only for model Context. When a valid summary already covers
  // the older prefix, it is safe to repair that state without another model
  // call or losing any conversation facts.
  // Only repair a legacy store that still contains the summary-covered prefix.
  // A rolling store normally keeps only the uncompressed tail, so its
  // coveredMessageCount can be much larger than memory.length. Trimming that
  // tail here would discard newly arrived messages before summarization.
  if (summary?.summary && Number.isFinite(coveredMessageCount) && overflow > 0 && store.memory.length > coveredMessageCount && coveredMessageCount >= overflow) {
    store.memory = store.memory.slice(-MAX_RECENT_CONVERSATION_MESSAGES);
  }
}

function normalizeConversationMemoryStore(state) {
  if (!state || !Array.isArray(state.projects)) return;
  for (const project of state.projects) {
    normalizeConversationStore(project);
    for (const initiative of project.initiatives || []) normalizeConversationStore(initiative);
  }
  normalizeConversationThreads(state);
}

function normalizeInterruptedAgentRuns(state) {
  if (!state || !Array.isArray(state.agentRuns)) return;
  const now = new Date().toISOString();
  for (const run of state.agentRuns) {
    if (!['running','stopping'].includes(run?.status) || ACTIVE_AGENT_RUNS.has(run.id)) continue;
    run.status = 'interrupted';
    run.completedAt = run.completedAt || now;
    run.durationMs = Number.isFinite(run.durationMs) ? run.durationMs : Math.max(0, new Date(run.completedAt).getTime() - new Date(run.startedAt || run.completedAt).getTime());
    run.error = '服务重启或进程中断，模型请求未完成。请重新发起该任务。';
    for (const step of run.steps || []) {
      if (step?.status !== 'running') continue;
      step.status = 'interrupted';
      step.error = '服务重启或进程中断。';
    }
  }
}

function normalizeAgentLoopAuditInputs(state) {
  if (!state || !Array.isArray(state.agentRuns)) return 0;
  let repaired = 0;
  for (const run of state.agentRuns) {
    const snapshots = new Map((run?.promptSnapshots || []).map((snapshot) => [snapshot.id, snapshot]));
    for (const [index, step] of (run?.steps || []).entries()) {
      if (!/^agent_loop_\d+$/.test(String(step?.name || ''))) continue;
      const legacyInput = step.input || {};
      if (Array.isArray(legacyInput.lastLoopToolResults) && !Object.hasOwn(legacyInput, 'toolResults')) continue;
      const snapshot = snapshots.get(legacyInput.snapshotId);
      if (!snapshot?.context) continue;
      let context;
      try { context = JSON.parse(snapshot.context); } catch { continue; }
      const priorToolResults = (run.steps || []).slice(0, index).filter((item) => item?.type === 'tool').map((item) => item.output || {}).filter(Boolean);
      const priorArtifacts = priorToolResults.flatMap((result) => result.persistedArtifacts || result.artifacts || []);
      step.input = buildAgentLoopAuditInput({
        snapshotId:snapshot.id,
        lastLoopToolResults:context.currentRun?.toolResults || [],
        allToolResults:priorToolResults,
        artifacts:priorArtifacts,
        planRef:context.currentRun?.planRef || legacyInput.planRef || null,
        retryPolicy:context.currentRun?.retryPolicy || legacyInput.retryPolicy || null,
        forceFinalResponse:Boolean(legacyInput.forceFinalResponse),
      });
      repaired += 1;
    }
  }
  return repaired;
}

function normalizeExecutionPlans(state) {
  if (!state || !Array.isArray(state.agentPlans)) return;
  for (const plan of state.agentPlans) {
    if (!Array.isArray(plan.obligations)) plan.obligations = [];
    plan.obligations = plan.obligations.filter((item) => item && item.id && item.instruction).map((item) => ({
      id:String(item.id), kind:String(item.kind || 'requirement'), status:['open','fulfilled','waived'].includes(item.status) ? item.status : 'open',
      instruction:String(item.instruction).slice(0, 2000), evidence:String(item.evidence || '').slice(0, 2000), sourceRef:item.sourceRef && typeof item.sourceRef === 'object' ? item.sourceRef : {},
    }));
    if (!['in_progress','needs_action'].includes(plan?.status)) continue;
    if (Array.isArray(plan.completionChecklist) && plan.completionChecklist.length) continue;
    plan.goalCompleted = false;
    plan.status = 'invalid';
    plan.missingActions = [...new Set([...(Array.isArray(plan.missingActions) ? plan.missingActions : []), 'Execution Plan 缺少 completionChecklist，不能恢复执行。'])].slice(0, 12);
    plan.nextAction = '创建一份包含可验证 completionChecklist 的新 Execution Plan。';
    plan.updatedAt = new Date().toISOString();
  }
}

function normalizeMediaAssets(state) {
  if (!state || typeof state !== 'object') return;
  if (!Array.isArray(state.mediaAssets)) state.mediaAssets = [];
  state.mediaAssets = state.mediaAssets
    .filter((asset) => asset && typeof asset === 'object' && asset.id && asset.filePath && (asset.projectId || asset.conversationId))
    .map((asset) => ({
      id:String(asset.id), projectId:String(asset.projectId || ''), initiativeId:String(asset.initiativeId || ''), conversationId:String(asset.conversationId || ''),
      filePath:String(asset.filePath), assetUrl:String(asset.assetUrl || ''), mimeType:String(asset.mimeType || ''),
      filename:String(asset.filename || path.basename(String(asset.filePath))), title:String(asset.title || path.basename(String(asset.filePath))),
      source:String(asset.source || 'imported'), createdAt:asset.createdAt || new Date().toISOString(),
      createdBy:String(asset.createdBy || 'system'), runId:String(asset.runId || ''),
    }));
}

function normalizeArtifactRegistry(state) {
  if (!state || typeof state !== 'object') return;
  normalizeMediaAssets(state);
  const existing = Array.isArray(state.artifacts) ? state.artifacts : [];
  const records = new Map();
  const add = (artifact, provenance = {}) => {
    if (!artifact || typeof artifact !== 'object' || !artifact.id) return;
    const projectId = String(artifact.projectId || provenance.projectId || '');
    if (!projectId) return;
    const previous = records.get(String(artifact.id));
    records.set(String(artifact.id), {
      id:String(artifact.id), type:String(artifact.type || 'unknown'), title:String(artifact.title || artifact.type || 'Artifact').slice(0, 300),
      summary:String(artifact.summary || previous?.summary || '').slice(0, 2000),
      projectId, initiativeId:String(artifact.initiativeId || provenance.initiativeId || ''), runId:String(artifact.runId || provenance.runId || ''), planId:String(artifact.planId || provenance.planId || ''),
      createdAt:artifact.createdAt || provenance.createdAt || new Date().toISOString(), source:artifact.source && typeof artifact.source === 'object' ? artifact.source : (previous?.source || {}),
      locator:artifact.locator && typeof artifact.locator === 'object' ? artifact.locator : (previous?.locator || { mediaAssetId:artifact.mediaAssetId || '', filePath:artifact.filePath || '', url:artifact.feishuUrl || artifact.imageUrl || '', reportId:artifact.reportId || '', knowledgeId:artifact.knowledgeId || '' }),
      integrityStatus:['verified','discovered_unverified','unavailable'].includes(artifact.integrityStatus) ? artifact.integrityStatus : (previous?.integrityStatus || 'verified'),
      freshnessStatus:['current','stale','unknown','not_applicable'].includes(artifact.freshnessStatus) ? artifact.freshnessStatus : (previous?.freshnessStatus || 'unknown'),
      supersededBy:String(artifact.supersededBy || previous?.supersededBy || ''),
    });
  };
  for (const artifact of existing) {
    if (String(artifact.id || '').startsWith('artifact-media-media-migrated-')) continue;
    add(artifact);
  }
  for (const media of state.mediaAssets || []) {
    if (media.source === 'artifact_migration') continue;
    add({
    id:`artifact-media-${media.id}`, type:'image', title:media.title, projectId:media.projectId, initiativeId:media.initiativeId, runId:media.runId,
    createdAt:media.createdAt, source:{ tool:'media_asset_registry', source:media.source }, locator:{ mediaAssetId:media.id, filePath:media.filePath, url:media.assetUrl }, integrityStatus:'verified', freshnessStatus:'not_applicable',
    });
  }
  for (const plan of state.agentPlans || []) for (const artifact of plan.artifacts || []) add(artifact, { projectId:plan.projectId, initiativeId:plan.initiativeId, planId:plan.id, createdAt:plan.updatedAt || plan.createdAt });
  for (const run of state.agentRuns || []) for (const step of run.steps || []) for (const artifact of step?.output?.artifacts || []) add(artifact, { projectId:run.projectId, initiativeId:run.initiativeId, runId:run.id, planId:run.planId, createdAt:run.completedAt || run.startedAt });
  for (const artifact of records.values()) {
    const relativePath = String(artifact.locator?.filePath || '');
    if (artifact.type !== 'image' || !relativePath || artifact.locator?.mediaAssetId) continue;
    const matchingMedia = state.mediaAssets.find((asset) => asset.projectId === artifact.projectId && asset.initiativeId === artifact.initiativeId && asset.filePath === relativePath);
    const mediaAsset = matchingMedia || {
      id:`media-migrated-${artifact.id}`, projectId:artifact.projectId, initiativeId:artifact.initiativeId, filePath:relativePath,
      assetUrl:String(artifact.locator?.url || `/${relativePath.split(path.sep).join('/')}`), mimeType:'image/png', filename:path.basename(relativePath), title:artifact.title,
      source:'artifact_migration', createdAt:artifact.createdAt, createdBy:'system', runId:artifact.runId,
    };
    if (!matchingMedia) state.mediaAssets.push(mediaAsset);
    artifact.locator.mediaAssetId = mediaAsset.id;
  }
  state.mediaAssets = state.mediaAssets.slice(0, 500);
  state.artifacts = [...records.values()].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 1000);
}

function normalizeLongTermMemoryStore(state) {
  if (!state || typeof state !== 'object') return;
  const migrated = Array.isArray(state.longTermMemories) ? state.longTermMemories : [];
  if (!Array.isArray(state.longTermMemories)) {
    for (const item of state.globalMemories || []) migrated.push({ ...item, scope:'global', data:item.data || { content:item.content || '' } });
    for (const item of state.projectMemories || []) migrated.push({ ...item, scope:item.initiativeId ? 'initiative' : 'project', data:item.data || { content:item.content || '' } });
    for (const profile of state.dataRecoveryProfiles || []) migrated.push({ id:`memory-profile-${profile.id}`, memoryKey:`data_recovery_profile:${profile.projectId}`, scope:'project', projectId:profile.projectId, initiativeId:'', type:'data_recovery_profile', statement:dataRecoveryProfileStatement(profile), data:profile, source:profile.source || 'user_confirmed', confidence:'high', status:profile.status || 'active', version:profile.version || 1, createdAt:profile.createdAt || new Date().toISOString(), updatedAt:profile.updatedAt || new Date().toISOString() });
    state.longTermMemories = migrated;
  }
  // Collapse legacy Profile mirrors into one canonical project memory record.
  const activeByProject = new Map();
  for (const item of state.longTermMemories) {
    if (item.type !== 'data_recovery_profile') continue;
    if (typeof item.data?.content === 'string') {
      try {
        const parsed = JSON.parse(item.data.content);
        if (parsed && typeof parsed === 'object') item.data = parsed;
      } catch {}
    }
    if (hasConfirmedMetricProfile(item.data)) item.statement = dataRecoveryProfileStatement(item.data);
    if (item.status !== 'active') continue;
    const valid = Array.isArray(item.data?.metricGroups) && item.data.metricGroups.some((group) => Array.isArray(group?.metrics) && group.metrics.length);
    const current = activeByProject.get(item.projectId);
    if (!current || (valid && !current.valid) || (valid === current.valid && String(item.updatedAt || '') > String(current.item.updatedAt || ''))) {
      activeByProject.set(item.projectId, { item, valid });
    }
  }
  for (const item of state.longTermMemories) {
    if (item.type === 'data_recovery_profile' && item.status === 'active' && activeByProject.get(item.projectId)?.item !== item) {
      item.status = 'superseded';
      item.supersededBy = activeByProject.get(item.projectId)?.item?.id || '';
      item.updatedAt = new Date().toISOString();
    }
  }
  // Legacy collections are migration inputs only; never persist duplicate sources.
  delete state.globalMemories;
  delete state.projectMemories;
  delete state.dataRecoveryProfiles;
}

function dataRecoveryProfileStatement(profile) {
  const details = (Array.isArray(profile?.metricGroups) ? profile.metricGroups : []).map((group) => {
    const name = String(group?.name || '').trim();
    const metrics = Array.isArray(group?.metrics) ? group.metrics.map((metric) => String(metric || '').trim()).filter(Boolean) : [];
    return name && metrics.length ? `${name}：${metrics.join('、')}` : '';
  }).filter(Boolean);
  return `项目常用回收指标和指标组：${details.join('；') || '待用户确认'}`;
}

function memories(state) { normalizeLongTermMemoryStore(state); return state.longTermMemories; }
function getActiveRecoveryProfile(state, projectId) { return memories(state).find((item) => item.scope === 'project' && item.projectId === projectId && item.type === 'data_recovery_profile' && item.status === 'active')?.data || null; }
function memoryByScope(state, scope, projectId = '') { return memories(state).filter((item) => item.scope === scope && (!projectId || item.projectId === projectId) && item.status === 'active'); }

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(payload));
}

function sendText(response, statusCode, text) {
  response.writeHead(statusCode, { 'Content-Type': 'text/plain; charset=utf-8' });
  response.end(text);
}

function runArtifactCommand(command, args, { timeout, cwd }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio:['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error ? reject(error) : resolve();
    };
    const timer = setTimeout(() => {
      const error = Object.assign(new Error(`Command timed out after ${timeout}ms.`), { code:'ETIMEDOUT', stderr, retryable:true });
      child.kill('SIGTERM');
      finish(error);
    }, timeout);
    child.stderr?.on('data', (chunk) => {
      if (stderr.length < 65536) stderr += chunk.toString();
    });
    child.once('error', (error) => { error.stderr = stderr; finish(error); });
    child.once('close', (code, signal) => {
      if (settled) return;
      if (code === 0) return finish();
      const error = Object.assign(new Error(`Command failed with exit code ${code ?? 'unknown'}${signal ? ` (${signal})` : ''}.`), { code, signal, stderr });
      finish(error);
    });
  });
}

function registeredCli(cli) {
  const definition = CLI_REGISTRY[String(cli || '')];
  if (!definition) throw Object.assign(new Error(`未注册的 CLI：${cli || 'unknown'}。`), { statusCode:422 });
  return definition;
}

function cliHelpCacheKey(cli, argvPrefix) {
  return `${String(cli)}:${JSON.stringify(normalizeCliArgv(argvPrefix, 'argvPrefix'))}`;
}

function cachedCliHelpData(data = {}) {
  return {
    cli:String(data.cli || ''), argv:Array.isArray(data.argv) ? data.argv.map(String).slice(0, 80) : [], exitCode:Number(data.exitCode || 0), signal:String(data.signal || ''), timedOut:Boolean(data.timedOut), durationMs:Number(data.durationMs || 0),
    stdout:String(data.stdout || '').slice(0, CLI_OUTPUT_LIMIT_CHARS), stderr:String(data.stderr || '').slice(0, CLI_OUTPUT_LIMIT_CHARS), json:null,
  };
}

function normalizeCliHelpCache(state) {
  if (!state || typeof state !== 'object') return;
  const now = Date.now();
  const records = Array.isArray(state.cliHelpCache) ? state.cliHelpCache : [];
  state.cliHelpCache = records.filter((item) => item && typeof item === 'object' && typeof item.key === 'string' && Number(item.expiresAt) > now).map((item) => ({ key:item.key, data:cachedCliHelpData(item.data), cachedAt:String(item.cachedAt || new Date(now).toISOString()), expiresAt:Number(item.expiresAt) })).sort((a, b) => b.expiresAt - a.expiresAt).slice(0, MAX_PERSISTED_CLI_HELP_CACHE_ENTRIES);
}

function persistCliHelpCacheEntry(state, entry) {
  normalizeCliHelpCache(state);
  state.cliHelpCache = [entry, ...(state.cliHelpCache || []).filter((item) => item.key !== entry.key)].slice(0, MAX_PERSISTED_CLI_HELP_CACHE_ENTRIES);
}

function normalizeSkills(state) {
  if (!state || typeof state !== 'object') return;
  const records = new Map();
  for (const item of Array.isArray(state.skills) ? state.skills : []) {
    if (!item || typeof item !== 'object' || !item.id || !item.title || !item.content) continue;
    const kind = 'manual';
    records.set(String(item.id), { id:String(item.id), kind, title:String(item.title).slice(0, 240), summary:String(item.summary || '').slice(0, 1200), content:String(item.content).slice(0, MAX_MANUAL_SKILL_CHARS), source:item.source && typeof item.source === 'object' ? item.source : {}, createdAt:String(item.createdAt || new Date().toISOString()), updatedAt:String(item.updatedAt || item.createdAt || new Date().toISOString()) });
  }
  state.skills = [...records.values()].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0, 300);
}

function createManualSkill(state, { title, content, filename = '' }) {
  normalizeSkills(state);
  const normalizedTitle = String(title || filename || '').trim().slice(0, 240);
  const normalizedContent = String(content || '').replace(/\r\n/g, '\n').trim().slice(0, MAX_MANUAL_SKILL_CHARS);
  if (!normalizedTitle || !normalizedContent) throw Object.assign(new Error('Skill 标题和内容不能为空。'), { statusCode:422 });
  const now = new Date().toISOString();
  const skill = { id:`skill-manual-${Date.now()}-${Math.random().toString(16).slice(2)}`, kind:'manual', title:normalizedTitle, summary:normalizedContent.replace(/\s+/g, ' ').slice(0, 280), content:normalizedContent, source:{ filename:String(filename || '').slice(0, 240), uploadedBy:'user' }, createdAt:now, updatedAt:now };
  state.skills.unshift(skill);
  state.skills = state.skills.slice(0, 300);
  return skill;
}

function deleteSkill(state, skillId) {
  normalizeSkills(state);
  const id = String(skillId || '');
  const skill = state.skills.find((item) => item.id === id);
  if (!skill) throw Object.assign(new Error('Skill 不存在或已删除。'), { statusCode:404 });
  state.skills = state.skills.filter((item) => item.id !== id);
  return skill;
}

function searchSkills(state, { query, types, limit = 5 }) {
  normalizeSkills(state);
  const normalizedQuery = String(query || '').trim();
  const allowed = Array.isArray(types) && types.length ? new Set(types) : null;
  return (state.skills || []).filter((skill) => !allowed || allowed.has(skill.kind)).map((skill) => ({ skill, score:fullTextScore(normalizedQuery, `${skill.title}\n${skill.summary}\n${skill.content}`) })).filter(({ score }) => score > 0).sort((a, b) => b.score - a.score || String(b.skill.updatedAt).localeCompare(String(a.skill.updatedAt))).slice(0, Math.max(1, Math.min(Number(limit) || 5, 5))).map(({ skill }) => ({ id:skill.id, type:skill.kind, title:skill.title, summary:skill.summary, contentExcerpt:skill.content.slice(0, MAX_CLI_SKILL_RESULT_CHARS), updatedAt:skill.updatedAt, source:skill.source }));
}

function readCliHelpCache(state, key) {
  const cached = CLI_HELP_CACHE.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    if (state && !(state.cliHelpCache || []).some((item) => item.key === key)) persistCliHelpCacheEntry(state, cached);
    return cached;
  }
  if (cached) {
    CLI_HELP_CACHE.delete(key);
  }
  normalizeCliHelpCache(state);
  const persisted = state?.cliHelpCache?.find((item) => item.key === key);
  if (!persisted) return null;
  CLI_HELP_CACHE.set(key, persisted);
  return persisted;
}

function writeCliHelpCache(state, key, data) {
  const now = Date.now();
  const entry = { key, data:cachedCliHelpData(data), cachedAt:new Date(now).toISOString(), expiresAt:now + CLI_HELP_CACHE_TTL_MS };
  CLI_HELP_CACHE.set(key, entry);
  for (const [existingKey, existing] of CLI_HELP_CACHE) if (existing.expiresAt <= now) CLI_HELP_CACHE.delete(existingKey);
  normalizeCliHelpCache(state);
  persistCliHelpCacheEntry(state, entry);
  return entry;
}

function rememberRunCliHelp(run, { cli, argvPrefix, data, cachedAt, expiresAt }) {
  if (!run) return;
  const entry = {
    cli:String(cli), argvPrefix:normalizeCliArgv(argvPrefix, 'argvPrefix'),
    stdout:String(data?.stdout || '').slice(0, MAX_CLI_HELP_CONTEXT_CHARS), stderr:String(data?.stderr || '').slice(0, 2_000),
    cachedAt:String(cachedAt || new Date().toISOString()), expiresAt:new Date(expiresAt).toISOString(),
  };
  const key = cliHelpCacheKey(entry.cli, entry.argvPrefix);
  const entries = Array.isArray(run.cliHelpCache) ? run.cliHelpCache.filter((item) => item && new Date(item.expiresAt).getTime() > Date.now() && cliHelpCacheKey(item.cli, item.argvPrefix || []) !== key) : [];
  entries.unshift(entry);
  run.cliHelpCache = entries.slice(0, MAX_CLI_HELP_CACHE_ENTRIES);
}

function normalizeCliArgv(argv, field = 'argv') {
  if (!Array.isArray(argv) || (!argv.length && field !== 'argvPrefix')) throw Object.assign(new Error(`${field} 必须是${field === 'argvPrefix' ? '' : '非空'}字符串数组。`), { statusCode:422 });
  if (argv.length > 80) throw Object.assign(new Error(`${field} 最多允许 80 个参数。`), { statusCode:422 });
  const normalized = argv.map((value) => String(value));
  if (normalized.some((value) => !value || value.length > 8_000 || /[\u0000]/.test(value))) throw Object.assign(new Error(`${field} 含有空值、过长值或无效字符。`), { statusCode:422 });
  return normalized;
}

function argumentValue(argv, flag) {
  const inline = argv.find((item) => item.startsWith(`${flag}=`));
  if (inline) return inline.slice(flag.length + 1);
  const index = argv.lastIndexOf(flag);
  return index >= 0 ? argv[index + 1] || '' : '';
}

function requireRegisteredCliPaths(definition, argv) {
  for (const rule of definition.pathArgs || []) {
    const value = argumentValue(argv, rule.flag);
    if (!value) continue;
    if (path.isAbsolute(value)) throw Object.assign(new Error(`${rule.flag} 必须使用项目内相对路径。`), { statusCode:422 });
    const absolute = path.resolve(definition.cwd, value);
    if (absolute !== rule.root && !absolute.startsWith(`${rule.root}${path.sep}`)) throw Object.assign(new Error(`${rule.flag} 必须位于受管目录内。`), { statusCode:422 });
  }
}

function safeCliText(value, maximum = CLI_OUTPUT_LIMIT_CHARS) {
  const clipped = clipLogText(value, maximum)
    .replace(new RegExp(ROOT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '<project-root>')
    .replace(/data:[a-z]+\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+/ig, '[base64 omitted]');
  return clipped;
}

function runRegisteredCliProcess(command, argv, { cwd, timeout }) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn(command, argv, { cwd, stdio:['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let settled = false;
    const append = (current, chunk) => current.length >= CLI_OUTPUT_LIMIT_CHARS ? current : `${current}${chunk.toString().slice(0, CLI_OUTPUT_LIMIT_CHARS - current.length)}`;
    const finish = (value, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) return reject(error);
      resolve({ ...value, durationMs:Date.now() - startedAt, stdout:stdoutTruncated ? `${stdout}\n[日志内容已截断]` : stdout, stderr:stderrTruncated ? `${stderr}\n[日志内容已截断]` : stderr });
    };
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish({ exitCode:null, signal:'SIGTERM', timedOut:true });
    }, timeout);
    child.stdout?.on('data', (chunk) => { if (stdout.length >= CLI_OUTPUT_LIMIT_CHARS || chunk.length > CLI_OUTPUT_LIMIT_CHARS - stdout.length) stdoutTruncated = true; stdout = append(stdout, chunk); });
    child.stderr?.on('data', (chunk) => { if (stderr.length >= CLI_OUTPUT_LIMIT_CHARS || chunk.length > CLI_OUTPUT_LIMIT_CHARS - stderr.length) stderrTruncated = true; stderr = append(stderr, chunk); });
    child.once('error', (error) => { error.stdout = stdout; error.stderr = stderr; error.durationMs = Date.now() - startedAt; finish(null, error); });
    child.once('close', (exitCode, signal) => finish({ exitCode, signal:signal || '', timedOut:false }));
  });
}

function parseCliJson(stdout) {
  try { return JSON.parse(stdout); } catch { return null; }
}

function cliBusinessStatus(data) {
  const payload = data?.json;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return 'completed';
  const result = String(payload?.data?.result || payload?.result || '').trim().toLowerCase();
  const reportedStatus = String(payload?.status || payload?.data?.status || '').trim().toLowerCase();
  const changed = payload?.data?.updated_blocks_count;
  if (payload.ok === false || ['failed','failure','error'].includes(result) || ['failed','failure','error'].includes(reportedStatus)) return 'failed';
  if (['partial','partial_success'].includes(result) || ['partial','partial_success'].includes(reportedStatus)) return 'partial';
  if (changed !== undefined && (!Number.isFinite(Number(changed)) || Number(changed) <= 0)) return 'failed';
  return 'completed';
}

function cliBusinessFailureMessage(data) {
  const payload = data?.json || {};
  return String(payload?.error?.message || payload?.data?.message || payload?.message || payload?.data?.tips || data?.stderr || '').trim();
}

async function runRegisteredCli(cli, argv, { help = false } = {}) {
  const definition = registeredCli(cli);
  const normalized = normalizeCliArgv(argv, help ? 'argvPrefix' : 'argv');
  if (help && normalized.some((item) => item === '--help' || item === '-h')) throw Object.assign(new Error('argvPrefix 不要包含 --help 或 -h；系统会自动追加。'), { statusCode:422 });
  requireRegisteredCliPaths(definition, normalized);
  const actualArgv = help ? [...normalized, '--help'] : normalized;
  const raw = await runRegisteredCliProcess(definition.executable, actualArgv, definition);
  const data = {
    cli:String(cli), argv:actualArgv.map((item) => safeCliText(item, 2_000)), exitCode:raw.exitCode, signal:raw.signal, timedOut:raw.timedOut, durationMs:raw.durationMs,
    stdout:safeCliText(raw.stdout), stderr:safeCliText(raw.stderr), json:parseCliJson(raw.stdout),
  };
  if (raw.timedOut || raw.exitCode !== 0) {
    const detail = String(data.stderr || data.stdout || '').trim();
    const message = raw.timedOut ? `CLI 命令超时（${Math.round(definition.timeout / 1000)} 秒）。` : `CLI 命令以退出码 ${raw.exitCode} 结束。`;
    const error = Object.assign(new Error(detail ? `${message}\n${detail}` : message), { statusCode:502, retryable:true, timedOut:Boolean(raw.timedOut), cliData:data });
    throw error;
  }
  const status = cliBusinessStatus(data);
  if (status === 'failed') {
    const detail = cliBusinessFailureMessage(data);
    throw Object.assign(new Error(detail ? `CLI 外部响应表示执行失败：${detail}` : 'CLI 外部响应表示执行失败。'), { statusCode:502, retryable:false, cliData:data });
  }
  return { definition, data, rawArgv:actualArgv, status };
}

async function collectRegisteredCliArtifacts({ state, projectId, initiativeId, runId, definition, argv, outputSpec }) {
  const requestedRuleId = String(outputSpec?.artifactRuleId || '');
  const rules = (definition.artifactRules || []).filter((rule) => !requestedRuleId || rule.id === requestedRuleId);
  if (requestedRuleId && !rules.length) throw Object.assign(new Error(`outputSpec.artifactRuleId 未在 CLI 注册表中声明：${requestedRuleId}。`), { statusCode:422 });
  const artifacts = [];
  for (const rule of rules) {
    const outputPath = argumentValue(argv, rule.outputFlag);
    if (!outputPath) continue;
    const absolute = path.resolve(definition.cwd, outputPath);
    if (path.isAbsolute(outputPath) || (absolute !== rule.managedRoot && !absolute.startsWith(`${rule.managedRoot}${path.sep}`))) throw Object.assign(new Error(`${rule.outputFlag} 产物必须位于受管目录内。`), { statusCode:422 });
    const stat = await fs.stat(absolute).catch(() => null);
    if (!stat?.isFile()) throw Object.assign(new Error(`CLI 未生成声明的产物文件：${outputPath}。`), { statusCode:502, retryable:false });
    const relativePath = path.relative(ROOT, absolute);
    const title = String(outputSpec?.title || rule.title || path.basename(relativePath)).slice(0, 240);
    const mediaAsset = rule.registerMedia ? registerMediaAsset(state, { projectId, initiativeId, filePath:relativePath, assetUrl:`/${relativePath.split(path.sep).join('/')}`, mimeType:rule.mimeType || '', title, source:'agent_generated', createdBy:'agent', runId }) : null;
    artifacts.push(toolArtifact(rule.type, title, { filePath:relativePath, imageUrl:mediaAsset?.assetUrl || '', mediaAssetId:mediaAsset?.id || '' }));
  }
  return artifacts;
}

function publicErrorMessage(error) {
  if (error?.cause?.code === 'ENOTFOUND') {
    return '无法解析 OpenRouter 域名 openrouter.ai。请检查网络或在 .env 配置 HTTPS_PROXY / HTTP_PROXY 后重启 npm start。';
  }
  if (error?.cause?.code === 'ECONNREFUSED') {
    return '无法连接配置的网络代理或 OpenRouter 服务。请检查 .env 中的代理地址和端口。';
  }
  if (error?.cause?.code === 'ETIMEDOUT' || error?.name === 'TimeoutError') {
    return '连接 OpenRouter 超时。请检查网络或代理后重试。';
  }
  return error?.message || 'Internal server error';
}

function cliOutputText(value) {
  return String(value || '').trim();
}

function feishuWriteError(error, operation) {
  const stderr = cliOutputText(error?.stderr);
  const stdout = cliOutputText(error?.stdout);
  const message = stderr || stdout || publicErrorMessage(error);
  return Object.assign(new Error(`飞书${operation}失败：${message}`), {
    statusCode:error?.statusCode || 502,
    retryable:false,
    cliData:{
      stdout,
      stderr,
      exitCode:Number.isInteger(error?.code) ? error.code : null,
    },
  });
}

function feishuUpdateResult(stdout, operation) {
  const payload = parseCliJson(stdout);
  const data = payload?.data || {};
  const result = String(data.result || '').trim().toLowerCase();
  const reportedCount = data.updated_blocks_count;
  const parsedUpdatedBlocksCount = Number(reportedCount);
  const updatedBlocksCount = reportedCount === undefined || reportedCount === null || reportedCount === '' || !Number.isFinite(parsedUpdatedBlocksCount)
    ? null
    : parsedUpdatedBlocksCount;
  if (!payload || result !== 'success') {
    const externalMessage = String(payload?.error?.message || data.message || data.tips || '').trim();
    const detail = externalMessage || `data.result=${result || 'missing'}`;
    throw Object.assign(new Error(`飞书${operation}未成功：${detail}`), {
      statusCode:502,
      retryable:false,
      cliData:{ stdout:cliOutputText(stdout), stderr:'', exitCode:0, json:payload || null },
    });
  }
  return {
    result,
    updatedBlocksCount,
    revisionId:data.document?.revision_id ?? null,
    warnings:Array.isArray(data.warnings) ? data.warnings : [],
    tips:String(data.tips || ''),
  };
}

async function runFeishuUpdate(args, operation) {
  try {
    const { stdout } = await execFileAsync('lark-cli', args, { timeout:30000, maxBuffer:2*1024*1024 });
    return feishuUpdateResult(stdout, operation);
  } catch (error) {
    if (error?.cliData) throw error;
    throw feishuWriteError(error, operation);
  }
}

function decodeHtml(text = '') {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)));
}

function isPrivateAddress(address) {
  if (net.isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a >= 224;
  }
  const normalized = address.toLowerCase();
  return normalized === '::1' || normalized === '::' || normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe80:');
}

async function assertSafeExternalUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    const error = new Error('链接地址无效。');
    error.statusCode = 422;
    throw error;
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password) {
    const error = new Error('仅支持不含账号信息的公开 HTTP / HTTPS 链接。');
    error.statusCode = 422;
    throw error;
  }
  const hostname = parsed.hostname.toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    const error = new Error('不允许同步本机或内网地址。');
    error.statusCode = 403;
    throw error;
  }
  const addresses = net.isIP(hostname) ? [{ address: hostname }] : await dns.lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) {
    const error = new Error('不允许同步本机、内网或保留地址。');
    error.statusCode = 403;
    throw error;
  }
  return parsed;
}

function extractPageText(raw, contentType) {
  const source = raw.slice(0, MAX_LINK_CONTENT_CHARS * 5);
  if (!/html|xml/i.test(contentType || '')) return { title: '', text: source.trim().slice(0, MAX_LINK_CONTENT_CHARS) };
  const title = decodeHtml((source.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
  const text = decodeHtml(source
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()).slice(0, MAX_LINK_CONTENT_CHARS);
  return { title, text };
}

async function fetchPublicLinkContent(url) {
  let current = await assertSafeExternalUrl(url);
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    const response = await fetch(current, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(LINK_FETCH_TIMEOUT_MS),
      headers: { 'User-Agent': 'Project-Pusher-Link-Sync/1.0', Accept: 'text/html,text/plain,application/xhtml+xml;q=0.9,*/*;q=0.1' },
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location || redirects === 3) throw new Error('链接重定向次数过多，无法同步。');
      current = await assertSafeExternalUrl(new URL(location, current).toString());
      continue;
    }
    if (!response.ok) {
      const error = new Error(`链接返回 HTTP ${response.status}，可能需要登录或没有访问权限。`);
      error.statusCode = 502;
      throw error;
    }
    const contentType = response.headers.get('content-type') || '';
    if (!/text\/|application\/(json|xml|javascript)/i.test(contentType)) {
      const error = new Error('该链接不是可同步的文本网页或文本数据。');
      error.statusCode = 415;
      throw error;
    }
    const raw = await response.text();
    const extracted = extractPageText(raw, contentType);
    if (!extracted.text) {
      const error = new Error('已访问链接，但没有提取到可保存的文本内容。');
      error.statusCode = 422;
      throw error;
    }
    return { url: current.toString(), title: extracted.title, text: extracted.text, fetchedAt: new Date().toISOString(), truncated: raw.length > MAX_LINK_CONTENT_CHARS * 5 || extracted.text.length >= MAX_LINK_CONTENT_CHARS };
  }
  throw new Error('无法同步链接内容。');
}

function isFeishuDocumentUrl(value) {
  try {
    const parsed = new URL(value);
    const isFeishuHost = /(^|\.)(feishu\.cn|larksuite\.com|larkoffice\.com|doubao\.com)$/i.test(parsed.hostname);
    return isFeishuHost && /^\/(docx|doc|wiki)\//i.test(parsed.pathname);
  } catch {
    return false;
  }
}

function isLibraUrl(value) {
  try {
    const parsed = new URL(value);
    return /(^|\.)data\.example-company\.net$/i.test(parsed.hostname) && /^\/libra\//i.test(parsed.pathname);
  } catch {
    return false;
  }
}

function stripDocumentMarkup(content = '') {
  return decodeHtml(content
    .replace(/<img\b[^>]*>/gi, ' [图片] ')
    .replace(/<source\b[^>]*>/gi, ' [附件] ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()).slice(0, MAX_LINK_CONTENT_CHARS);
}

function extractFeishuDocumentBlocks(content = '') {
  const blocks = [];
  const pattern = /<(p|h[1-9]|li|blockquote|checkbox|img|source|whiteboard|sheet)\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/\1\s*>|<(img|source|whiteboard|sheet)\b[^>]*\bid="([^"]+)"[^>]*\/>/gi;
  let match;
  while ((match = pattern.exec(String(content || ''))) && blocks.length < 160) {
    const tag = String(match[1] || match[4] || '').toLowerCase();
    const blockId = String(match[2] || match[5] || '');
    const xml = match[0];
    const text = stripDocumentMarkup(xml);
    blocks.push({ blockId, type:tag, text, xml:xml.slice(0,2400) });
  }
  return blocks;
}

function selectFeishuDocumentBlocks(blocks, query = '') {
  const words = String(query || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  if (!words.length) return blocks.slice(0,80);
  const matched = new Set();
  blocks.forEach((block, index) => {
    const haystack = `${block.text || ''} ${block.xml || ''}`.toLowerCase();
    if (words.some((word) => haystack.includes(word))) for (let cursor=Math.max(0,index-4); cursor<=Math.min(blocks.length-1,index+5); cursor++) matched.add(cursor);
  });
  return [...matched].sort((a,b)=>a-b).slice(0,80).map((index) => blocks[index]);
}

async function fetchFeishuDocumentContent(url, { includeBlockIds = false, blockQuery = '' } = {}) {
  try {
    const { stdout } = await execFileAsync('lark-cli', [
      'docs', '+fetch', '--api-version', 'v2', '--as', 'user', '--doc', url, '--doc-format', 'xml', '--detail', includeBlockIds ? 'with-ids' : 'simple', '--format', 'json',
    ], { timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
    const payload = JSON.parse(stdout);
    if (!payload?.ok) throw new Error(payload?.error?.message || '飞书文档读取失败。');
    const raw = payload?.data?.document?.content || '';
    const title = decodeHtml((raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').replace(/<[^>]+>/g, ' ').trim());
    const text = stripDocumentMarkup(raw);
    if (!text) throw new Error('飞书文档已读取，但未提取到可保存的正文。');
    const allBlocks = includeBlockIds ? extractFeishuDocumentBlocks(raw) : [];
    return { url, title, text, blocks:includeBlockIds ? selectFeishuDocumentBlocks(allBlocks, blockQuery) : [], fetchedAt: new Date().toISOString(), truncated: raw.length > MAX_LINK_CONTENT_CHARS, sourceType: 'feishu' };
  } catch (error) {
    const detail = error?.stderr ? String(error.stderr).trim() : error?.message;
    const failure = new Error(`无法读取飞书文档：${detail || '请确认你拥有文档访问权限并完成飞书授权。'}`);
    failure.statusCode = 502;
    throw failure;
  }
}

function cleanSummaryText(value = '') {
  return String(value)
    .replace(/\[(?:图片|附件)\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function oneSentence(value, maximum = 160) {
  const text = cleanSummaryText(value);
  if (!text) return '';
  const boundary = text.search(/[。！？!?]/);
  const sentence = boundary >= 0 ? text.slice(0, boundary + 1) : text;
  const clipped = sentence.length > maximum ? `${sentence.slice(0, maximum - 1)}…` : sentence;
  return /[。！？!?…]$/.test(clipped) ? clipped : `${clipped}。`;
}

function labelValue(text, label) {
  return text.match(new RegExp(`^${label}：([^\\n]+)`, 'm'))?.[1]?.trim() || '';
}

function summarizeSyncedKnowledge({ title, text, sourceType }) {
  if (sourceType === 'libra') {
    const name = labelValue(text, '实验名称') || title || '该实验';
    const status = labelValue(text, '状态');
    const period = labelValue(text, '实验周期');
    const traffic = labelValue(text, '流量');
    return oneSentence(`${name}${status ? `当前状态为${status}` : ''}${period ? `，实验周期为${period}` : ''}${traffic ? `，流量为${traffic}` : ''}`);
  }
  const paragraphs = String(text || '')
    .split(/\n\s*\n|\r?\n/)
    .map(cleanSummaryText)
    .filter((paragraph) => paragraph && !/^(关联链接|同步时间|来源)[:：]/.test(paragraph));
  const candidate = paragraphs.find((paragraph) => paragraph.length >= 12) || paragraphs[0] || title;
  return oneSentence(candidate || title);
}

function refreshLegacyKnowledgeSummaries(state) {
  for (const item of state?.knowledgeItems || []) {
    if (!item?.autoLinked || !/^(已同步|自动解析主题|等待同步正文|正文已同步)/.test(String(item.summary || ''))) continue;
    const content = String(item.content || '');
    const sourceType = content.match(/(?:^|\n)来源：([^\n]+)/)?.[1]?.trim() || 'public';
    const body = content.split(/\n\s*\n/).slice(1).join('\n\n') || content;
    const summary = summarizeSyncedKnowledge({ title: item.parsedTheme || item.title, text: body, sourceType });
    if (summary) {
      item.summary = summary;
      item.summaryVersion = 1;
    }
  }
}

async function generateKnowledgeSummary(result) {
  const fallback = summarizeSyncedKnowledge(result);
  if (!OPENROUTER_API_KEY) return { summary: fallback, summaryMethod: 'extractive' };
  try {
    const response = await fetch(`${OPENROUTER_BASE_URL.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: OPENROUTER_MODEL,
        temperature: 0,
        messages: [
          { role: 'system', content: '你是项目知识库摘要器。仅根据给定正文，用中文输出一句不超过 80 个汉字的事实性摘要。不要添加标题、前缀、Markdown、推测或无关信息。' },
          { role: 'user', content: `标题：${result.title || '未命名资料'}\n来源类型：${result.sourceType || 'public'}\n正文：\n${String(result.text || '').slice(0, 8000)}` },
        ],
      }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload?.error?.message || '摘要模型请求失败。');
    const summary = oneSentence(extractOutputText(payload), 100);
    return { summary: summary || fallback, summaryMethod: summary ? 'model' : 'extractive' };
  } catch (error) {
    console.warn(`Knowledge summary fallback: ${publicErrorMessage(error)}`);
    return { summary: fallback, summaryMethod: 'extractive' };
  }
}

async function syncLinkContent(url) {
  let result;
  if (isLibraUrl(url)) result = await fetchLibraExperimentContent(url);
  else if (isFeishuDocumentUrl(url)) result = await fetchFeishuDocumentContent(url);
  else result = { ...(await fetchPublicLinkContent(url)), sourceType: 'public' };
  return { ...result, ...(await generateKnowledgeSummary(result)) };
}

function formatUnixTime(seconds) {
  return Number.isFinite(Number(seconds)) ? new Date(Number(seconds) * 1000).toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '未知';
}

function textList(values, formatter = (value) => value) {
  return Array.isArray(values) && values.length ? values.map(formatter).filter(Boolean).join('、') : '暂无';
}

async function fetchLibraExperimentContent(url) {
  const parsed = new URL(url);
  const experimentId = parsed.pathname.match(/\/flight\/(\d+)/)?.[1];
  if (!experimentId) {
    const error = new Error('无法从 Libra 链接中识别实验 ID。');
    error.statusCode = 422;
    throw error;
  }
  try {
    await fs.access(LIBRA_CLI);
  } catch {
    const error = new Error('Libra CLI 尚未安装或路径不可用。请先完成本项目的 Libra CLI 安装。');
    error.statusCode = 503;
    throw error;
  }
  try {
    const { stdout } = await execFileAsync(LIBRA_CLI, [
      'experiment', 'get', '--experiment-id', experimentId, '--with', 'versions,analysis', '--json', '--site', 'prod', '--network', 'prod',
    ], { timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
    const payload = JSON.parse(stdout);
    const data = payload?.data?.data;
    const experiment = data?.experiment;
    if (payload?.status !== 'success' || !experiment) throw new Error(payload?.data?.message || payload?.message || 'Libra 实验查询失败。');
    const analysis = data?.analysis || {};
    const content = [
      `实验名称：${experiment.name || `Libra 实验 #${experimentId}`}`,
      `实验 ID：${experiment.id || experimentId}`,
      `所属应用：${experiment.app?.name || '未知'}（ID：${experiment.app?.id ?? '未知'}）`,
      `状态：${experiment.status?.label || '未知'}`,
      `实验类型：${experiment.feature_type?.label || experiment.manage_type?.label || '未知'}`,
      `负责人：${textList(experiment.owners, (owner) => owner?.name)}`,
      `实验周期：${formatUnixTime(experiment.timing?.start_time)} 至 ${formatUnixTime(experiment.timing?.end_time)}`,
      `流量：${experiment.traffic?.version_resource != null ? `${Math.round(Number(experiment.traffic.version_resource) * 100)}%` : '未知'}`,
      `版本：${textList(data?.versions, (version) => `${version?.name || '未知'}（${version?.type?.label || '未知'}）`)}`,
      `建议查询区间：${analysis.start_date || analysis.suggestion?.start_date || '未知'} 至 ${analysis.end_date || analysis.suggestion?.end_date || '未知'}`,
      `数据区域：${analysis.suggestion?.data_region || '未知'}`,
      analysis.filter_function ? `实验分流条件：\n${analysis.filter_function}` : '',
    ].filter(Boolean).join('\n\n');
    return {
      url: parsed.toString(),
      title: experiment.name || `Libra 实验 #${experimentId}`,
      text: content.slice(0, MAX_LINK_CONTENT_CHARS),
      fetchedAt: new Date().toISOString(),
      truncated: content.length > MAX_LINK_CONTENT_CHARS,
      sourceType: 'libra',
      experimentId,
    };
  } catch (error) {
    const detail = error?.stderr ? String(error.stderr).trim() : error?.message;
    const failure = new Error(`无法读取 Libra 实验 ${experimentId}：${detail || '请检查 Libra CLI 登录状态和实验访问权限。'}`);
    failure.statusCode = 502;
    throw failure;
  }
}

function shanghaiDateKey(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

function localIsoDate(value) {
  return /^\d{4}-\d{2}-\d{2}/.test(String(value || '')) ? String(value).slice(0, 10) : '';
}

function objectValue(object, keys) {
  for (const key of keys) if (object && object[key] != null && object[key] !== '') return object[key];
  return '';
}

function findFirstByKey(value, matcher) {
  if (!value || typeof value !== 'object') return '';
  for (const [key, item] of Object.entries(value)) {
    if (matcher(key) && (typeof item === 'string' || typeof item === 'number')) return String(item);
    if (item && typeof item === 'object') { const nested = findFirstByKey(item, matcher); if (nested) return nested; }
  }
  return '';
}

function hasConfirmedMetricProfile(profile) {
  return Boolean(profile && Array.isArray(profile.metricGroups) && profile.metricGroups.some((group) => group && typeof group === 'object' && Array.isArray(group.metrics) && group.metrics.length));
}

function normalizeDataRecoveryProfiles(state) {
  for (const profile of state?.dataRecoveryProfiles || []) {
    if (profile.status === 'active' && !hasConfirmedMetricProfile(profile)) {
      profile.status = 'superseded';
      profile.invalidReason = '旧版默认 Profile 未记录用户确认的具体指标，不能用于实际指标回收。';
      profile.updatedAt = new Date().toISOString();
    }
  }
}

function collectMetricRecords(value, results = []) {
  if (!value || typeof value !== 'object') return results;
  if (!Array.isArray(value)) {
    const label = objectValue(value, ['metric_name', 'metricName', 'name', 'metric_title', 'metricTitle']);
    if (label) results.push({ label:String(label), raw:value });
  }
  for (const item of Array.isArray(value) ? value : Object.values(value)) collectMetricRecords(item, results);
  return results;
}

function summarizeMetricRecord(record) {
  const raw = record.raw || {};
  const fields = ['value', 'control_value', 'experiment_value', 'relative_diff', 'relativeDifference', 'p_value', 'pValue', 'is_significant', 'isSignificant', 'confidence_interval'];
  const summary = fields.filter((key) => raw[key] != null).map((key) => `${key}=${typeof raw[key] === 'object' ? JSON.stringify(raw[key]) : raw[key]}`).join('；');
  return summary || JSON.stringify(raw).slice(0, 800);
}

function shanghaiDateFromUnix(seconds) {
  if (!Number.isFinite(Number(seconds))) return '';
  return new Intl.DateTimeFormat('en-CA', { timeZone:'Asia/Shanghai', year:'numeric', month:'2-digit', day:'2-digit' }).format(new Date(Number(seconds) * 1000));
}

function earliestDateKey(...values) {
  return values.filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))).sort()[0] || '';
}

function dateDaysAfter(dateKey, days) {
  return dateDaysBefore(dateKey, -days);
}

function isShanghaiMidnight(seconds) {
  if (!Number.isFinite(Number(seconds))) return false;
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone:'Asia/Shanghai', hour:'2-digit', minute:'2-digit', second:'2-digit', hourCycle:'h23' }).formatToParts(new Date(Number(seconds) * 1000));
  const value = (type) => parts.find((part) => part.type === type)?.value || '';
  return value('hour') === '00' && value('minute') === '00' && value('second') === '00';
}

function fullDayQueryWindow(experiment, todayMinusOne) {
  const rawStart = shanghaiDateFromUnix(experiment.timing?.start_time);
  const rawEnd = shanghaiDateFromUnix(experiment.timing?.end_time);
  const startDate = rawStart && !isShanghaiMidnight(experiment.timing?.start_time) ? dateDaysAfter(rawStart, 1) : rawStart;
  const experimentEnd = rawEnd && !isShanghaiMidnight(experiment.timing?.end_time) ? dateDaysBefore(rawEnd, 1) : rawEnd;
  return { startDate, endDate:earliestDateKey(todayMinusOne, experimentEnd) };
}

async function fetchLibraRecoveryPreflight(experimentUrl) {
  const parsed = new URL(experimentUrl);
  const experimentId = parsed.pathname.match(/\/flight\/(\d+)/)?.[1];
  if (!experimentId) throw Object.assign(new Error('无法从关联 Libra 链接识别实验 ID。'), { statusCode: 422 });
  const { stdout } = await execFileAsync(LIBRA_CLI, ['experiment', 'get', '--experiment-id', experimentId, '--with', 'versions,analysis', '--json', '--site', 'prod', '--network', 'prod'], { timeout:30000, maxBuffer:2*1024*1024 });
  const payload = JSON.parse(stdout);
  const experiment = payload?.data?.data?.experiment || {};
  const window = fullDayQueryWindow(experiment, shanghaiDateKey(new Date(Date.now() - 24 * 60 * 60 * 1000)));
  const startDate = window.startDate || '未知';
  const endDate = window.endDate;
  return { experimentId, experimentUrl:parsed.toString(), title:experiment.name || `Libra 实验 #${experimentId}`, startDate, endDate };
}

function parseMetricSearchCsv(csvText = '') {
  const lines = String(csvText).trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = lines[0].split(',');
  return lines.slice(1).map((line) => Object.fromEntries(line.split(',').map((value, index) => [headers[index], value])));
}

function dateDaysBefore(dateKey, days) {
  const date = new Date(`${dateKey}T00:00:00+08:00`);
  date.setUTCDate(date.getUTCDate() - days);
  return shanghaiDateKey(date);
}

function metricValueFromReport(reportData, metricId, baseVersionId, experimentVersionId) {
  const versions = reportData?.merge_data?.[String(metricId)] || {};
  const base = versions[String(baseVersionId)] || {};
  const experiment = versions[String(experimentVersionId)] || {};
  const value = experiment.value;
  return {
    found: value !== null && value !== undefined && base.value !== null && base.value !== undefined,
    value,
    baseValue: base.value,
    relativeDiff: experiment.relative_diff?.[String(baseVersionId)] ?? null,
    absoluteDiff: experiment.absolute_diff?.[String(baseVersionId)] ?? null,
    pValue: experiment.p_val?.[String(baseVersionId)] ?? null,
    confidence: experiment.confidence?.[String(baseVersionId)] ?? null,
  };
}

function normalizeExperimentVersionIds(versionIds) {
  return [...new Set((Array.isArray(versionIds) ? versionIds : []).map((id) => String(id || '').trim()).filter(Boolean))];
}

function buildExperimentVersionCatalog(versions, baseVersionId) {
  return (Array.isArray(versions) ? versions : [])
    .map((version) => {
      const id = String(objectValue(version, ['id','version_id','versionId']) || '');
      const name = String(objectValue(version, ['name','label','title']) || version?.type?.label || `版本 ${id}`);
      return { id, name, isBaseline:id === String(baseVersionId) };
    })
    .filter((version) => version.id);
}

function buildVersionedMetricResults(groups, experimentVersions, baseVersionId, dataDate) {
  return groups.flatMap((item) => item.resolved.flatMap((metric) => experimentVersions.map((version) => ({
    group:item.group.name,
    metric:metric.metric,
    metricId:metric.metricId,
    experimentVersionId:version.id,
    experimentVersionName:version.name,
    baselineVersionId:String(baseVersionId),
    dataDate,
    ...metricValueFromReport(item.reportData, metric.metricId, baseVersionId, version.id),
  }))));
}

async function queryLibraMetricGroup({ experimentId, appId, group, startDate, endDate, baseVersionId, dataRegion }) {
  const searchResult = await execFileAsync(LIBRA_CLI, ['metrics', 'search', '--experiment-id', experimentId, '--metric-group-key', group.name, '--metric-keys', group.metrics.join(','), '--top', '20', '--json', '--site', 'prod', '--network', 'prod'], { timeout:30000, maxBuffer:2*1024*1024 });
  const searchPayload = JSON.parse(searchResult.stdout);
  const hits = parseMetricSearchCsv(searchPayload?.data || '');
  const groupId = hits.find((item) => item.result_type === 'metric_group' && item.metric_group_name === group.name)?.metric_group_id || hits.find((item) => item.metric_group_id)?.metric_group_id;
  const resolved = group.metrics.map((metric) => {
    const hit = hits.find((item) => item.result_type === 'metric' && item.metric_name === metric && item.resolution_status === 'exact');
    return { metric, metricId: hit?.metric_id || '', resolved: Boolean(hit?.metric_id) };
  });
  if (!groupId) return { group, groupId:'', resolved, reportData:null };
  const ids = resolved.filter((item) => item.resolved).map((item) => item.metricId);
  if (!ids.length) return { group, groupId, resolved, reportData:null };
  const reportResult = await execFileAsync(LIBRA_CLI, ['metrics', 'report-data', '--experiment-id', experimentId, '--metric-group', groupId, '--selected-metric-ids', ids.join(','), '--start-date', startDate, '--end-date', endDate, '--period-type', 'd', '--app-id', appId, '--data-region', dataRegion, '--base-vid', baseVersionId, '--view-type', 'merge', '--merge-type', 'total', '--json', '--site', 'prod', '--network', 'prod'], { timeout:30000, maxBuffer:4*1024*1024 });
  const reportPayload = JSON.parse(reportResult.stdout);
  return { group, groupId, resolved, reportData:reportPayload?.data?.data || reportPayload?.data || reportPayload };
}

async function resolveLibraMetricGroup({ experimentId, groupName, metricNames }) {
  const result = await execFileAsync(LIBRA_CLI, ['metrics', 'search', '--experiment-id', experimentId, '--metric-group-key', groupName, '--metric-keys', (metricNames || []).join(','), '--top', '30', '--json', '--site', 'prod', '--network', 'prod'], { timeout:30000, maxBuffer:2*1024*1024 });
  const payload = JSON.parse(result.stdout);
  const hits = parseMetricSearchCsv(payload?.data || '');
  const groupId = hits.find((item) => item.result_type === 'metric_group' && item.metric_group_name === groupName)?.metric_group_id || hits.find((item) => item.metric_group_id)?.metric_group_id;
  const metrics = (metricNames || []).map((name) => { const hit=hits.find((item) => item.result_type === 'metric' && item.metric_name === name); return { name, id:hit?.metric_id || '' }; }).filter((item) => item.id);
  if (!groupId) throw Object.assign(new Error(`未在该实验中找到指标组「${groupName}」。`), { statusCode:422 });
  return { groupId, metrics };
}

async function captureLibraMetricSnapshot(state, projectId, call) {
  const experimentResult = await execFileAsync(LIBRA_CLI, ['experiment', 'get', '--experiment-id', call.experimentId, '--with', 'versions,analysis', '--json', '--site', 'prod', '--network', 'prod'], { timeout:30000, maxBuffer:2*1024*1024 });
  const data = JSON.parse(experimentResult.stdout)?.data?.data || {};
  const experiment = data.experiment || {};
  const versions = Array.isArray(data.versions) ? data.versions : [];
  const baseVersion = versions.find((version) => /对照|基准|control|base/i.test(JSON.stringify(version?.type || {}))) || versions[0];
  const baseVersionId = String(objectValue(baseVersion, ['id','version_id','versionId']));
  const versionIds = versions.map((version) => String(objectValue(version, ['id','version_id','versionId']))).filter(Boolean);
  const window = fullDayQueryWindow(experiment, shanghaiDateKey(new Date(Date.now() - 24 * 60 * 60 * 1000)));
  const resolved = await resolveLibraMetricGroup({ experimentId:call.experimentId, groupName:call.metricGroup, metricNames:call.metricNames });
  if (call.screenshotType === 'chart' && !resolved.metrics.length) throw Object.assign(new Error('趋势图截图需要指定该指标组中的一个指标。'), { statusCode:422 });
  await fs.mkdir(ASSET_DIR, { recursive:true });
  const snapshotId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const filename = `libra-${call.experimentId}-${snapshotId}.png`;
  const relativeOutput = path.join('data','assets',filename);
  const args = ['metrics','snapshot','--screenshot-type',call.screenshotType,'--flight-id',call.experimentId,'--group-id',resolved.groupId,'--start-date',window.startDate,'--end-date',window.endDate,'--base-version-id',baseVersionId,'--versions',versionIds.join(','),'--output',relativeOutput,'--json','--site','prod','--network','prod'];
  if (resolved.metrics.length) args.splice(args.indexOf('--output'), 0, '--selected-metric-ids', resolved.metrics.map((item)=>item.id).join(','));
  if (call.screenshotType === 'chart') args.push('--metric-id', resolved.metrics.find((item)=>item.name===call.metricName)?.id || resolved.metrics[0].id);
  try {
    // Libra also returns the PNG as base64 in its JSON envelope. The image has
    // already been written by --output, so discard stdout instead of buffering
    // megabytes of duplicate image data in Node memory.
    await runArtifactCommand(LIBRA_CLI, args, { timeout:150000, cwd:WORKSPACE_ROOT });
    const file = await fs.stat(managedAssetAbsolutePath(relativeOutput));
    if (!file.isFile() || file.size <= 0) throw Object.assign(new Error('Libra 截图命令结束，但未生成有效 PNG 文件。'), { retryable:true });
  } catch (error) {
    const cliOutput = [error?.stderr, error?.stdout].filter(Boolean).join('\n').trim();
    if (/Not authenticated|AUTH_REQUIRED/i.test(cliOutput)) {
      throw Object.assign(new Error('Libra CLI 未认证（AUTH_REQUIRED）。请先完成 `libra-cli auth login --site prod`，再重试截图。'), { statusCode:401, retryable:false, cliOutput });
    }
    const message = cliOutput ? `Libra 截图导出失败：${cliOutput.slice(0, 4000)}` : `Libra 截图导出失败：${error.message}`;
    throw Object.assign(new Error(message), { statusCode:error?.statusCode, retryable:true, cliOutput });
  }
  const assetUrl = `/data/assets/${filename}`;
  const title = `${experiment.name || call.experimentId} · Libra 截图 · ${call.metricGroup}`;
  return { assetUrl, filePath:relativeOutput, title, note:`已导出 ${call.metricGroup} 的 Libra 原生${call.screenshotType === 'chart' ? '趋势图' : '表格'}截图。` };
}

async function readExperimentMetadata(experimentId) {
  if (!/^\d+$/.test(String(experimentId || ''))) throw Object.assign(new Error('experimentId 必须是 Libra 实验 ID。'), { statusCode:422 });
  const { stdout } = await execFileAsync(LIBRA_CLI, ['experiment', 'get', '--experiment-id', String(experimentId), '--with', 'versions,analysis', '--json', '--site', 'prod', '--network', 'prod'], { timeout:30000, maxBuffer:2*1024*1024 });
  const data = JSON.parse(stdout)?.data?.data || {};
  const experiment = data.experiment || {};
  const analysis = data.analysis || {};
  const versions = Array.isArray(data.versions) ? data.versions : [];
  const baseVersion = versions.find((version) => /对照|基准|control|base/i.test(JSON.stringify(version?.type || {}))) || versions[0];
  const baseVersionId = String(objectValue(baseVersion, ['id','version_id','versionId']) || '');
  const versionCatalog = buildExperimentVersionCatalog(versions, baseVersionId);
  const experimentVersions = versionCatalog.filter((version) => !version.isBaseline);
  const experimentVersionIds = experimentVersions.map((version) => version.id);
  const window = fullDayQueryWindow(experiment, shanghaiDateKey(new Date(Date.now() - 24 * 60 * 60 * 1000)));
  return { experimentId:String(experimentId), experimentUrl:`https://data.example.invalid/libra/flight/${experimentId}/report/main`, title:experiment.name || `Libra 实验 #${experimentId}`, experiment, analysis, appId:String(experiment.app?.id || ''), baseVersionId, baselineVersion:versionCatalog.find((version) => version.isBaseline) || null, experimentVersions, experimentVersionIds, dataRegion:analysis.suggestion?.data_region || 'other', startDate:window.startDate || localIsoDate(analysis.start_date || analysis.suggestion?.start_date), endDate:window.endDate };
}

async function queryLibraMetricData({ experimentId, metricGroups, experimentVersionIds, freshnessPolicy }) {
  const profile = { metricGroups, freshnessPolicy };
  if (!hasConfirmedMetricProfile(profile)) throw Object.assign(new Error('query_metric_data 必须显式传入已确认的 metricGroups。'), { statusCode:422 });
  try { await fs.access(LIBRA_CLI); } catch { throw Object.assign(new Error('Libra CLI 尚未安装或路径不可用。'), { statusCode:503 }); }
  const metadata = await readExperimentMetadata(experimentId);
  const { appId, baseVersionId, experimentVersions, dataRegion, startDate, endDate:primaryEndDate, experiment, title, experimentUrl } = metadata;
  const requestedVersionIds = normalizeExperimentVersionIds(experimentVersionIds);
  if (!requestedVersionIds.length) throw Object.assign(new Error('query_metric_data 必须显式传入 experimentVersionIds；请先读取实验元数据，再选择需回收的实验版本。'), { statusCode:422 });
  const availableVersions = new Map(experimentVersions.map((version) => [version.id, version]));
  const unknownVersionIds = requestedVersionIds.filter((id) => !availableVersions.has(id));
  if (unknownVersionIds.length) throw Object.assign(new Error(`experimentVersionIds 包含不属于该实验的版本：${unknownVersionIds.join('、')}。`), { statusCode:422 });
  const selectedExperimentVersions = requestedVersionIds.map((id) => availableVersions.get(id));
  const fallbackEndDate = dateDaysBefore(primaryEndDate, 1);
  if (!appId || !baseVersionId || !selectedExperimentVersions.length || !startDate || !primaryEndDate) throw Object.assign(new Error('无法从 Libra 实验读取 APP、基准组、实验组或完整自然日查询窗口。'), { statusCode:422 });
  const primaryGroups = [];
  for (const group of metricGroups) primaryGroups.push(await queryLibraMetricGroup({ experimentId, appId, group, startDate, endDate:primaryEndDate, baseVersionId, dataRegion }));
  const primaryResults = buildVersionedMetricResults(primaryGroups, selectedExperimentVersions, baseVersionId, primaryEndDate);
  const missingGroupNames = [...new Set(primaryResults.filter((item) => !item.found).map((item) => item.group))];
  const fallbackByGroup = new Map();
  for (const group of metricGroups.filter((item) => missingGroupNames.includes(item.name))) fallbackByGroup.set(group.name, await queryLibraMetricGroup({ experimentId, appId, group, startDate, endDate:fallbackEndDate, baseVersionId, dataRegion }));
  const metricResults = primaryResults.map((item) => {
    if (item.found) return item;
    const fallback = fallbackByGroup.get(item.group);
    if (!fallback?.resolved.some((entry) => entry.metricId === item.metricId)) return item;
    return { ...item, dataDate:fallbackEndDate, ...metricValueFromReport(fallback.reportData, item.metricId, baseVersionId, item.experimentVersionId) };
  });
  const foundMetricCount = metricResults.filter((item) => item.found).length;
  const fallbackMetricCount = metricResults.filter((item) => item.found && item.dataDate === fallbackEndDate).length;
  const primaryMetricCount = metricResults.filter((item) => item.found && item.dataDate === primaryEndDate).length;
  const metricSummary = metricResults.map((item) => ({ group:item.group, metric:item.metric, experimentVersionId:item.experimentVersionId, experimentVersionName:item.experimentVersionName, baselineVersionId:item.baselineVersionId, found:item.found, dataDate:item.found ? item.dataDate : '', result:item.found ? `实验组（${item.experimentVersionName} / ${item.experimentVersionId}）=${item.value}；对照组=${item.baseValue}；相对变化=${item.relativeDiff ?? '未知'}；P值=${item.pValue ?? '未知'}` : 'T-1 与 T-2 均未返回指标值。' }));
  const status = foundMetricCount ? (fallbackMetricCount ? 'partial' : 'completed') : 'blocked';
  const deliveryDisclosure = buildDataRecoveryDisclosure({ status, primaryEndDate, fallbackEndDate, primaryMetricCount, fallbackMetricCount, metricResults:metricSummary });
  return { id:`recovery-${Date.now()}-${Math.random().toString(16).slice(2)}`, experimentId:String(experimentId), experimentUrl, title, status, dataLatestDate:foundMetricCount ? (fallbackMetricCount ? fallbackEndDate : primaryEndDate) : '未返回', isLatest:Boolean(foundMetricCount && !fallbackMetricCount), continuation:status === 'partial' ? 'continue_with_disclosure' : status === 'completed' ? 'continue' : 'blocked', deliveryDisclosure, fetchedAt:new Date().toISOString(), experiment:{ status:experiment.status?.label || '未知', app:experiment.app?.name || '未知', traffic:experiment.traffic?.version_resource != null ? `${Math.round(Number(experiment.traffic.version_resource)*100)}%`:'未知', analysisRange:`${startDate} 至 ${primaryEndDate}`, baselineVersionId:baseVersionId, experimentVersions:selectedExperimentVersions }, metricResults:metricSummary, reportDataExcerpt:JSON.stringify([...primaryGroups, ...fallbackByGroup.values()].map((item)=>item.reportData)).slice(0,MAX_LINK_CONTENT_CHARS), note:foundMetricCount ? `已匹配 ${foundMetricCount} 个版本指标值（${selectedExperimentVersions.length} 个实验版本）：T-1（${primaryEndDate}）${primaryMetricCount} 个，T-2（${fallbackEndDate}）${fallbackMetricCount} 个。` : `Libra 在 T-1（${primaryEndDate}）及 T-2（${fallbackEndDate}）均未返回已确认版本的指标值，不能生成最终决策。` };
}

function buildDataRecoveryDisclosure({ status, primaryEndDate = '', fallbackEndDate = '', primaryMetricCount = 0, fallbackMetricCount = 0, metricResults = [] }) {
  if (status !== 'partial') return null;
  const datedMetrics = metricResults.filter((item) => item?.found && item.dataDate).map((item) => `- ${item.group} / ${item.metric}：${item.dataDate}`);
  return {
    kind:'data_freshness',
    completionNote:`指标已查询：T-1（${primaryEndDate}）${primaryMetricCount} 个，T-2（${fallbackEndDate}）${fallbackMetricCount} 个；已按数据时效限制继续生成交付物。`,
    requiredText:[
      '## 数据时效说明',
      `本次已查询指标共 ${primaryMetricCount + fallbackMetricCount} 个：T-1（${primaryEndDate}）${primaryMetricCount} 个，T-2（${fallbackEndDate}）${fallbackMetricCount} 个。`,
      '存在 T-2 回退数据，本报告不是最新完整数据；相关结果仅供过程跟踪，不应作为无条件的最终业务决策。',
      '各指标实际数据日期：',
      ...datedMetrics,
    ].join('\n'),
  };
}

async function checkExperimentRecycle(experimentId) {
  if (!/^\d+$/.test(String(experimentId || ''))) throw Object.assign(new Error('experimentId 必须是 Libra 实验 ID。'), { statusCode:422 });
  const { stdout } = await execFileAsync(LIBRA_CLI, ['conclusion', 'recycle', '--experiment-id', String(experimentId), '--json', '--site', 'prod', '--network', 'prod'], { timeout:30000, maxBuffer:2*1024*1024 });
  const raw = JSON.parse(stdout);
  const data = raw?.data?.data || raw?.data || raw;
  const text = JSON.stringify(data);
  const summary = Array.isArray(data?.summary?.msg) ? data.summary.msg.map((item) => item?.text).filter(Boolean).join('；') : '';
  return { experimentId:String(experimentId), status:'completed', summary:summary || '已读取实验回收与合规信息。', excerpt:text.slice(0,MAX_LINK_CONTENT_CHARS), truncated:text.length > MAX_LINK_CONTENT_CHARS };
}

// Compatibility-only path for the legacy direct endpoint. The model-visible contract
// uses query_metric_data and check_experiment_recycle separately.
async function runLibraDataRecovery(experimentUrl, profile) {
  const experimentId = new URL(experimentUrl).pathname.match(/\/flight\/(\d+)/)?.[1];
  if (!experimentId) throw Object.assign(new Error('无法从关联 Libra 链接识别实验 ID。'), { statusCode:422 });
  const metadata = await readExperimentMetadata(experimentId);
  const report = await queryLibraMetricData({ experimentId, metricGroups:profile?.metricGroups, experimentVersionIds:profile?.experimentVersionIds || metadata.experimentVersionIds, freshnessPolicy:profile?.freshnessPolicy || { mode:'per_metric_latest_available', candidates:['T-1','T-2'], discloseFallback:true } });
  const recycle = await checkExperimentRecycle(experimentId);
  report.status = report.status === 'completed' ? 'recovered' : 'stale';
  report.recycleExcerpt = recycle.excerpt;
  report.recycleTruncated = recycle.truncated;
  return report;
}

async function readJsonBody(request) {
  let body = '';
  let size = 0;

  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error('Request body is too large');
      error.statusCode = 413;
      throw error;
    }
    body += chunk;
  }

  if (!body) return {};
  try {
    return JSON.parse(body);
  } catch {
    const error = new Error('Invalid JSON body');
    error.statusCode = 400;
    throw error;
  }
}

function resolveStaticPath(pathname) {
  if (pathname.startsWith('/data/assets/')) {
    try { return managedAssetAbsolutePath(pathname.slice(1)); } catch { return null; }
  }
  const requestedPath = pathname === '/' ? '/index.html' : pathname;
  const relativePath = path.normalize(decodeURIComponent(requestedPath)).replace(/^([/\\])+/, '');
  if (relativePath === 'data' || relativePath.startsWith(`data${path.sep}`)) return null;
  const fullPath = path.resolve(ROOT, relativePath);
  if (!fullPath.startsWith(`${ROOT}${path.sep}`) && fullPath !== ROOT) return null;
  return fullPath;
}

async function serveStatic(request, response, pathname) {
  const filePath = resolveStaticPath(pathname);
  if (!filePath) return sendText(response, 403, 'Forbidden');

  try {
    const stats = await fs.stat(filePath);
    if (!stats.isFile()) return sendText(response, 404, 'Not found');
    const extension = path.extname(filePath).toLowerCase();
    const content = await fs.readFile(filePath);
    response.writeHead(200, {
      'Content-Type': MIME_TYPES[extension] || 'application/octet-stream',
      'Cache-Control': extension === '.html' ? 'no-store' : 'no-cache',
    });
    response.end(content);
  } catch (error) {
    if (error.code === 'ENOENT') return sendText(response, 404, 'Not found');
    throw error;
  }
}


function findProject(state, projectId) {
  return Array.isArray(state?.projects) ? state.projects.find((project) => project.id === projectId) : null;
}

function inferKnowledgeTypeFromUrl(value) {
  return isLibraUrl(value) ? '实验与数据' : '方案与需求';
}

function inferLinkThemeFromUrl(value) {
  try {
    const parsed = new URL(value);
    const flightId = parsed.pathname.match(/\/flight\/(\d+)/)?.[1];
    if (isLibraUrl(value) && flightId) return `Libra 实验报告 #${flightId}`;
    const last = parsed.pathname.split('/').filter(Boolean).at(-1);
    return last && !/^(main|index|report)$/i.test(last) ? `${parsed.hostname} · ${decodeURIComponent(last).replace(/[-_]+/g, ' ')}` : parsed.hostname;
  } catch {
    return '关联链接';
  }
}

function applySyncedKnowledge(state, { kind, ownerId, linkId, project, initiative, link, synced }) {
  const linkKey = `${kind}:${ownerId}:${linkId}`;
  let item = Array.isArray(state.knowledgeItems) ? state.knowledgeItems.find((entry) => entry.linkKey === linkKey) : null;
  const theme = synced.title || inferLinkThemeFromUrl(synced.url);
  const content = `关联链接：${synced.url}\n同步日期：${new Date(synced.fetchedAt).toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' })}\n来源：${synced.sourceType || 'public'}\n\n${synced.text}${synced.truncated ? '\n\n[内容已截断]' : ''}`;
  const payload = {
    projectId: project.id,
    initiativeId: initiative?.id || '',
    type: inferKnowledgeTypeFromUrl(synced.url),
    title: `${project.name}${initiative ? ` · ${initiative.name}` : ''} · ${theme}`,
    summary: synced.summary || summarizeSyncedKnowledge(synced),
    summaryVersion: 1,
    summaryMethod: synced.summaryMethod || 'extractive',
    sourceUrl: synced.url,
    content,
    parsedTheme: theme,
    syncStatus: '已同步',
    syncedAt: synced.fetchedAt,
    autoLinked: true,
    linkKey,
  };
  if (item) Object.assign(item, payload);
  else {
    item = { id: `k-sync-${Date.now()}-${Math.random().toString(16).slice(2)}`, createdAt: new Date().toISOString().slice(0, 10), ...payload };
    state.knowledgeItems ||= [];
    state.knowledgeItems.unshift(item);
  }
  return item;
}

async function syncPendingKnowledge(state) {
  const results = [];
  for (const project of state.projects || []) {
    const sources = [
      { kind: 'project', ownerId: project.id, owner: project, initiative: null },
      ...(project.initiatives || []).map((initiative) => ({ kind: 'initiative', ownerId: initiative.id, owner: initiative, initiative })),
    ];
    for (const source of sources) {
      for (const link of source.owner.knowledgeLinks || []) {
        const url = typeof link?.url === 'string' ? link.url.trim() : '';
        if (!url) continue;
        const linkKey = `${source.kind}:${source.ownerId}:${link.id}`;
        const existing = state.knowledgeItems?.find((item) => item.linkKey === linkKey);
        if (existing?.syncStatus === '已同步') continue;
        try {
          const synced = await syncLinkContent(url);
          applySyncedKnowledge(state, { kind: source.kind, ownerId: source.ownerId, linkId: link.id, project, initiative: source.initiative, link, synced });
          results.push({ url, title: synced.title, sourceType: synced.sourceType, status: 'synced' });
        } catch (error) {
          const failure = existing || {
            id: `k-sync-${Date.now()}-${Math.random().toString(16).slice(2)}`,
            projectId: project.id,
            initiativeId: source.initiative?.id || '',
            type: inferKnowledgeTypeFromUrl(url),
            title: `${project.name}${source.initiative ? ` · ${source.initiative.name}` : ''} · ${inferLinkThemeFromUrl(url)}`,
            summary: `自动解析主题：${inferLinkThemeFromUrl(url)}`,
            sourceUrl: url,
            content: `关联链接：${url}`,
            createdAt: new Date().toISOString().slice(0, 10),
            autoLinked: true,
            linkKey,
          };
          failure.syncStatus = `同步失败：${publicErrorMessage(error)}`;
          failure.syncedAt = '';
          if (!existing) state.knowledgeItems.unshift(failure);
          results.push({ url, status: 'failed', error: publicErrorMessage(error) });
        }
      }
    }
  }
  return results;
}

function queryTerms(value = '') {
  const raw = String(value).toLowerCase().match(/[\u4e00-\u9fff]+|[a-z0-9_]{2,}/g) || [];
  const terms = [];
  for (const token of raw) {
    terms.push(token);
    if (/^[\u4e00-\u9fff]+$/.test(token)) for (let index = 0; index < token.length - 1; index += 1) terms.push(token.slice(index, index + 2));
  }
  return [...new Set(terms)].slice(0, 40);
}

function sanitizeToolResultForModel(value, seen = new WeakSet()) {
  if (typeof value === 'string') {
    if (/^data:[a-z]+\/[a-z0-9.+-]+;base64,/i.test(value)) return '[已省略 Base64 数据]';
    if (/^(?:\/|[A-Za-z]:[\\/])/.test(value)) return '[已省略本地绝对路径]';
    return value;
  }
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return '[循环引用已省略]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeToolResultForModel(item, seen));
  return Object.fromEntries(Object.entries(value).flatMap(([key, item]) => {
    if (/^(authorization|apiKey|token|secret|password|dataUrl|image_base64)$/i.test(key)) return [];
    if (/^(absolutePath|localPath)$/i.test(key)) return [];
    return [[key, sanitizeToolResultForModel(item, seen)]];
  }));
}

function stableModelValue(value) {
  if (Array.isArray(value)) return value.map(stableModelValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableModelValue(value[key])]));
  return value;
}

function sameModelValue(left, right) {
  return JSON.stringify(stableModelValue(left)) === JSON.stringify(stableModelValue(right));
}

function jsonTextValue(value) {
  if (typeof value !== 'string') return undefined;
  try { return JSON.parse(value); } catch { return undefined; }
}

function canonicalModelData(data, request) {
  const normalized = sanitizeToolResultForModel(data ?? null);
  if (!normalized || typeof normalized !== 'object' || Array.isArray(normalized)) return normalized;
  const output = { ...normalized };
  for (const [key, value] of Object.entries(request || {})) if (Object.hasOwn(output, key) && sameModelValue(output[key], value)) delete output[key];
  const parsedStdout = jsonTextValue(output.stdout);
  if (parsedStdout !== undefined && output.json !== undefined && sameModelValue(parsedStdout, output.json)) delete output.stdout;
  return output;
}

function modelEvidenceForToolResult(result) {
  const request = sanitizeToolResultForModel(result?.input || result?.arguments || {});
  const note = String(result?.note || '');
  const summary = String(result?.summary || '');
  const message = note || summary || String(result?.error || '');
  const evidence = {
    tool:String(result?.name || result?.tool || ''), status:String(result?.status || 'unknown'), title:String(result?.title || ''),
    message, result:canonicalModelData(result?.data, request), artifacts:(result?.persistedArtifacts || result?.artifacts || []).map(compactArtifactReference),
    obligations:sanitizeToolResultForModel(result?.obligations || []), missing:sanitizeToolResultForModel(result?.missing || []), error:String(result?.error || ''), retryable:Boolean(result?.retryable),
  };
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify(stableModelValue(evidence))).digest('hex').slice(0, 16);
  return {
    evidenceId:`evidence-${fingerprint}`,
    ...evidence,
    occurrences:[{ toolCallId:String(result?.toolCallId || ''), request }],
  };
}

function dedupeModelEvidence(results = []) {
  const byFingerprint = new Map();
  for (const result of results) {
    const evidence = modelEvidenceForToolResult(result);
    const existing = byFingerprint.get(evidence.evidenceId);
    if (existing) existing.occurrences.push(...evidence.occurrences);
    else byFingerprint.set(evidence.evidenceId, evidence);
  }
  return [...byFingerprint.values()];
}

function compactContextPlan(plan) {
  if (!plan || typeof plan !== 'object') return null;
  return {
    id:plan.id || '', revision:Number(plan.revision || 0), status:plan.status || '', goal:plan.goal || '',
    completionChecklist:(plan.completionChecklist || []).map((item) => ({ id:item.id, description:item.description, status:item.status, note:item.note || '', artifactIds:item.artifactIds || [] })),
    obligations:(plan.obligations || []).filter((item) => item.status === 'open').map((item) => ({ id:item.id, kind:item.kind, instruction:item.instruction, sourceRef:item.sourceRef || {} })),
    missingActions:plan.missingActions || [], nextAction:plan.nextAction || '', goalCompleted:Boolean(plan.goalCompleted),
  };
}

function currentTaskIntent({ plan, handoff, lastLoopToolResults, currentCommand = '' } = {}) {
  if (String(plan?.nextAction || '').trim()) return String(plan.nextAction).trim();
  const guided = (lastLoopToolResults || []).map((result) => result?.modelGuidance?.nextStep).find((item) => String(item || '').trim());
  return String(guided || currentCommand || '').trim();
}

function handoffForModel(handoff) {
  if (!handoff || typeof handoff !== 'object') return null;
  return {
    usableFacts:(handoff.usableFacts || []).map((item) => ({ key:String(item?.key || ''), value:sanitizeToolResultForModel(item?.value) })).filter((item) => item.key),
  };
}

function projectFactsCard(project) {
  return {
    source:'project_facts', id:`project-facts-${project.id}`, title:String(project.name || '当前项目'),
    facts:{ name:project.name || '', priority:project.priority || '', plannedEnd:project.plannedEnd || '', progress:progressLabel(project.progress), currentState:project.currentState || '', blocker:project.blocker || '', nextAction:project.nextAction || '', nextActionDdl:project.nextActionDdl || '', learning:project.learning || '' },
  };
}

function itemFactsCard(initiative) {
  return {
    source:'item_facts', id:`item-facts-${initiative.id}`, title:String(initiative.name || '当前事项'),
    facts:{ name:initiative.name || '', priority:initiative.priority || '', progress:progressLabel(initiative.progress), currentState:initiative.currentState || '', blocker:initiative.blocker || '', nextAction:initiative.nextAction || '', nextActionDdl:initiative.nextActionDdl || '', learning:initiative.learning || '' },
  };
}

function knowledgeSearchText(item) {
  return [item.title, item.summary, item.content, item.sourceUrl, item.type].filter(Boolean).join('\n');
}

function resolveContentReadScope(state, { conversationProjectId = '', conversationInitiativeId = '', requestedProjectId = '', requestedInitiativeId = '' } = {}) {
  const currentProjectId=String(conversationProjectId || '');
  const currentInitiativeId=String(conversationInitiativeId || '');
  const requestedProject=String(requestedProjectId || '').trim();
  const requestedInitiative=String(requestedInitiativeId || '').trim();
  const sessionScope=currentInitiativeId ? 'initiative' : currentProjectId ? 'project' : 'global';
  const projects=Array.isArray(state?.projects) ? state.projects : [];
  const currentProject=currentProjectId ? findProject(state, currentProjectId) : null;
  if (currentProjectId && !currentProject) throw Object.assign(new Error('当前会话项目不存在。'), { statusCode:422 });
  if (sessionScope === 'initiative' && !(currentProject?.initiatives || []).some((item) => item.id === currentInitiativeId)) throw Object.assign(new Error('当前会话事项不存在。'), { statusCode:422 });
  if (sessionScope !== 'global' && requestedProject && requestedProject !== currentProjectId) throw Object.assign(new Error('当前会话不能读取其他项目内容。'), { statusCode:422 });
  let project=currentProject || (requestedProject ? findProject(state, requestedProject) : null);
  if (requestedProject && !project) throw Object.assign(new Error(`projectId ${requestedProject} 不存在。`), { statusCode:422 });
  let initiativeId=requestedInitiative;
  if (sessionScope === 'initiative') {
    if (initiativeId && initiativeId !== currentInitiativeId) throw Object.assign(new Error('当前事项会话不能读取其他事项内容。'), { statusCode:422 });
    initiativeId=currentInitiativeId;
  } else if (initiativeId) {
    const candidates=project ? [project] : projects;
    const owners=candidates.filter((candidate) => (candidate.initiatives || []).some((item) => item.id === initiativeId));
    if (owners.length !== 1) throw Object.assign(new Error(`initiativeId ${initiativeId} 不存在或归属不明确。`), { statusCode:422 });
    project=owners[0];
    if (sessionScope === 'project' && project.id !== currentProjectId) throw Object.assign(new Error('当前项目会话不能读取其他项目内容。'), { statusCode:422 });
  }
  const projectId=project?.id || '';
  const initiativeIds=initiativeId ? [initiativeId] : project ? (project.initiatives || []).map((item) => String(item.id || '')).filter(Boolean) : null;
  return { sessionScope, projectId, initiativeIds, initiativeId, includeGlobalMemory:true, label:sessionScope === 'global' ? (projectId ? initiativeId ? 'global_selected_item' : 'global_selected_project' : 'global_all') : sessionScope };
}

function searchKnowledge(state, { projectId = '', initiativeId = '', initiativeIds = undefined, query = '', types = [], includeContent = false, factsCard = null, factsCards = [] }) {
  const normalizedQuery = String(query || '').trim();
  const allowedTypes = new Set(Array.isArray(types) ? types.map(String) : []);
  const allowedInitiativeIds=initiativeIds === undefined ? new Set([String(initiativeId || '')]) : initiativeIds === null ? null : new Set(initiativeIds.map(String));
  const entries = [
    ...[...(factsCard ? [factsCard] : []), ...(Array.isArray(factsCards) ? factsCards : [])].map((item) => ({ item, score:fullTextScore(normalizedQuery, JSON.stringify(item)) })),
    ...(state.knowledgeItems || []).filter((item) => (!projectId || item?.projectId === projectId) && (allowedInitiativeIds === null || allowedInitiativeIds.has(String(item.initiativeId || ''))) && (!allowedTypes.size || allowedTypes.has(item.type))).map((item) => ({ item, score:fullTextScore(normalizedQuery, knowledgeSearchText(item)) })),
  ].filter(({ score }) => !normalizedQuery || score > 0)
    .sort((a, b) => b.score - a.score || String(b.item.updatedAt || b.item.syncedAt || b.item.createdAt || '').localeCompare(String(a.item.updatedAt || a.item.syncedAt || a.item.createdAt || '')))
    .slice(0, 8);
  return entries.map(({ item }) => item.source ? item : {
    source:'knowledge', id:item.id, projectId:String(item.projectId || ''), initiativeId:String(item.initiativeId || ''), type:item.type, title:item.title, summary:item.summary, sourceUrl:item.sourceUrl,
    contentExcerpt:includeContent ? String(item.content || '').slice(0, 2200) : '',
  });
}

function memorySearchCard(item, includeContent) {
  const scope = item.scope === 'global' ? 'global' : item.initiativeId ? 'item' : 'project';
  return {
    id:item.id, scope, type:item.type, statement:item.statement, confidence:item.confidence, source:item.source, evidence:item.evidence || '',
    ...(includeContent ? { contentExcerpt:String(item.data?.content || item.content || '').slice(0, 2200) } : {}),
    ...(item.type === 'data_recovery_profile' ? { data:{ metricGroups:item.data?.metricGroups || [], defaultSegments:item.data?.defaultSegments || '', reportFormatOverride:item.data?.reportFormatOverride || {}, freshnessPolicy:item.data?.freshnessPolicy || {}, feishuDocUrl:item.data?.feishuDocUrl || '' } } : {}),
  };
}

function conversationSummarySearchCard(project, initiativeId = '') {
  const store = conversationStore(project, initiativeId);
  const summary = String(store?.conversationSummary?.summary || '').trim();
  if (!summary) return null;
  return {
    source:'conversation_summary', id:`conversation-summary:${project.id}:${initiativeId || 'project'}`, scope:initiativeId ? 'item' : 'project', type:'conversation_summary',
    summary, coveredMessageCount:Math.max(0, Number(store.conversationSummary?.coveredMessageCount || 0) || 0), updatedAt:store.conversationSummary?.updatedAt || '',
  };
}

function searchMemory(state, { projectId = '', initiativeId = '', initiativeIds = undefined, includeGlobalMemory = true, query = '', types = [], includeContent = false }) {
  const normalizedQuery = String(query || '').trim();
  const allowedTypes = new Set(Array.isArray(types) ? types.map(String) : []);
  const selectedProject=projectId ? findProject(state, projectId) : null;
  const allowedInitiativeIds=initiativeIds === undefined ? (initiativeId ? new Set([String(initiativeId)]) : null) : initiativeIds === null ? null : new Set(initiativeIds.map(String));
  const longTermEntries = memories(state).filter((item) => {
    if (item.status !== 'active' || (allowedTypes.size && !allowedTypes.has(item.type))) return false;
    if (item.scope === 'global') return includeGlobalMemory;
    if (projectId && item.projectId !== projectId) return false;
    if (!projectId && allowedInitiativeIds === null) return true;
    return !item.initiativeId || allowedInitiativeIds === null || allowedInitiativeIds.has(String(item.initiativeId));
  }).map((item) => {
    const card = memorySearchCard(item, includeContent);
    return { card, score:fullTextScore(normalizedQuery, JSON.stringify(card)), updatedAt:item.updatedAt || item.createdAt || '' };
  });
  const summaryProjects=selectedProject ? [selectedProject] : (projectId ? [] : state.projects || []);
  const conversationSummaries=(!allowedTypes.size || allowedTypes.has('conversation_summary')) ? summaryProjects.flatMap((project) => {
    const ids=allowedInitiativeIds === null ? ['', ...(project.initiatives || []).map((item) => item.id)] : ['', ...[...allowedInitiativeIds]];
    return ids.map((id) => conversationSummarySearchCard(project, id)).filter(Boolean);
  }).map((card) => ({ card, score:fullTextScore(normalizedQuery, card.summary), updatedAt:card.updatedAt })) : [];
  const entries = [...longTermEntries, ...conversationSummaries];
  return entries.filter(({ score }) => !normalizedQuery || score > 0)
    .sort((a, b) => b.score - a.score || String(b.updatedAt).localeCompare(String(a.updatedAt)))
    .slice(0, 8).map(({ card }) => card);
}

function buildProjectContext(state, project, selectedInitiativeId = '', currentCommand = '', taskState = {}) {
  const initiatives = Array.isArray(project.initiatives) ? project.initiatives : [];
  const selectedInitiative = selectedInitiativeId ? initiatives.find((initiative) => initiative.id === selectedInitiativeId) : null;
  const discussionConversation = taskState.conversation || conversationStore(project, selectedInitiativeId);
  const recentConversation = (Array.isArray(discussionConversation?.memory) ? discussionConversation.memory.slice(-6) : []).map((item) => ({ role:item.role, text:String(item.text || ''), createdAt:item.createdAt || '' }));
  const contextPlan = compactContextPlan(taskState.plan);
  const lastLoopToolResults = taskState.lastLoopToolResults || [];
  const pendingToolResults = pendingToolResultsForContext(taskState);
  const pendingEvidence = dedupeModelEvidence(pendingToolResults);
  const modelArtifacts = (taskState.artifacts || []).map(compactArtifactReference);
  const compactRunSkill = (item) => ({ skillPath:String(item.skillPath || ''), parentSkillPath:String(item.parentSkillPath || ''), title:String(item.title || ''), kind:String(item.kind || '') });
  const discoveredSkills = (taskState.discoveredSkills || []).map(compactRunSkill);
  return JSON.stringify({
    core:{ userRequest:String(currentCommand || ''), taskGoal:contextPlan?.goal || String(currentCommand || ''), scope:{ projectId:project.id, initiativeId:selectedInitiative?.id || '', projectName:project.name, initiativeName:selectedInitiative?.name || '' } },
    currentTask:{ intent:currentTaskIntent({ plan:contextPlan, handoff:taskState.executionHandoff, lastLoopToolResults, currentCommand }), latestLoopToolResults:dedupeModelEvidence(lastLoopToolResults) },
    executionState:{ runId:taskState.runId || '', loop:taskState.loop || null, planRef:taskState.planRef || null, plan:contextPlan, executionHandoff:handoffForModel(taskState.executionHandoff), pendingToolResults:pendingEvidence, runtimeReferences:{ artifacts:modelArtifacts, selectedArtifacts:(taskState.selectedArtifacts || []).map(compactArtifactReference), discoveredSkills } },
    reference:{ recentConversation },
  }, null, 2);
}

function pendingToolResultsForContext(taskState = {}) {
  const latestToolCallIds = new Set((taskState.lastLoopToolResults || []).map((item) => item?.toolCallId).filter(Boolean));
  const coveredToolCallIds = new Set(taskState.executionHandoffCoveredToolCallIds || taskState.executionHandoff?.coveredToolCallIds || []);
  return (taskState.toolResults || []).filter((result) => !latestToolCallIds.has(result?.toolCallId) && !coveredToolCallIds.has(result?.toolCallId));
}

function buildWorkspaceContext(state, currentCommand = '', taskState = {}) {
  const conversation=taskState.conversation || null;
  const recentConversation=(conversation?.memory || []).slice(-6).map((item) => ({ role:item.role, text:String(item.text || ''), createdAt:item.createdAt || '' }));
  const lastLoopToolResults=taskState.lastLoopToolResults || [];
  const pendingToolResults=pendingToolResultsForContext(taskState);
  return JSON.stringify({ core:{ userRequest:String(currentCommand || ''), taskGoal:String(currentCommand || ''), scope:{ scope:'global', label:'无主题工作区对话', retrieval:'按需调用 search_workspace 跨项目检索；不得假设未检索的项目事实。' } }, currentTask:{ intent:currentTaskIntent({ plan:null, handoff:taskState.executionHandoff, lastLoopToolResults, currentCommand }), latestLoopToolResults:dedupeModelEvidence(lastLoopToolResults) }, executionState:{ runId:taskState.runId || '', loop:taskState.loop || null, planRef:null, plan:null, executionHandoff:handoffForModel(taskState.executionHandoff), pendingToolResults:dedupeModelEvidence(pendingToolResults), runtimeReferences:{ artifacts:[], selectedArtifacts:[], discoveredSkills:(taskState.discoveredSkills || []).map((item) => ({ skillPath:String(item.skillPath || ''), parentSkillPath:String(item.parentSkillPath || ''), title:String(item.title || ''), kind:String(item.kind || '') })) } }, reference:{ recentConversation } }, null, 2);
}

function searchWorkspace(state, { query='', sources=[], includeContent=false, limit=8 } = {}) {
  const allowed=new Set(Array.isArray(sources) ? sources.map(String) : []); const records=[];
  for (const project of state.projects || []) { records.push({ source:'project', projectId:project.id, initiativeId:'', title:project.name, summary:[project.currentState, project.blocker, project.nextAction].filter(Boolean).join('；') }); for (const initiative of project.initiatives || []) records.push({ source:'initiative', projectId:project.id, initiativeId:initiative.id, title:initiative.name, summary:[initiative.currentState, initiative.blocker, initiative.nextAction].filter(Boolean).join('；') }); }
  for (const item of state.knowledgeItems || []) records.push({ source:'knowledge', projectId:item.projectId || '', initiativeId:item.initiativeId || '', title:item.title || '知识', summary:item.summary || '', ...(includeContent ? { content:String(item.content || '').slice(0,4000) } : {}) });
  for (const thread of state.conversations || []) records.push({ source:'conversation', projectId:thread.projectId || '', initiativeId:thread.initiativeId || '', title:thread.title, summary:String(thread.conversationSummary?.summary || (thread.memory || []).map(cleanConversationMessage).join('\n')).slice(0,2000), conversationId:thread.id, scope:thread.scope });
  for (const run of state.agentRuns || []) records.push({ source:'agent_run', projectId:run.projectId || '', initiativeId:run.initiativeId || '', title:run.messagePreview || run.type || 'Agent Run', summary:run.historySummary || run.error || '', runId:run.id, status:run.status });
  for (const artifact of state.artifacts || []) records.push({ source:'artifact', projectId:artifact.projectId || '', initiativeId:artifact.initiativeId || '', title:artifact.title || artifact.type || 'Artifact', summary:artifact.summary || '', artifactId:artifact.id, status:artifact.integrityStatus });
  return records.filter((item) => !allowed.size || allowed.has(item.source)).map((item) => ({ item, score:fullTextScore(String(query || ''), JSON.stringify(item)) })).filter(({score}) => !String(query || '').trim() || score > 0).sort((a,b) => b.score-a.score).slice(0,Math.max(1,Math.min(Number(limit)||8,12))).map(({item}) => item);
}

function parseModelJson(text) {
  const candidate = String(text || '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(candidate.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

function asStringList(value, maximum = 5) {
  return Array.isArray(value)
    ? value.map((item) => String(item || '').trim()).filter(Boolean).slice(0, maximum)
    : [];
}

function normalizeProposal(raw, project, initiativeId) {
  const target = raw?.target === 'project' ? 'project' : 'initiative';
  const targetInitiativeId = target === 'initiative' ? initiativeId : '';
  const allowedFields = target === 'project'
    ? new Set(['nextAction', 'nextActionDdl', 'blocker', 'learning'])
    : new Set(['nextAction', 'nextActionDdl', 'blocker', 'learning']);
  const field = String(raw?.field || '');
  const value = String(raw?.value || '').trim();
  if (!allowedFields.has(field) || !value || (target === 'initiative' && !targetInitiativeId)) return null;
  return {
    id: `proposal-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    status: 'draft',
    projectId: project.id,
    initiativeId: targetInitiativeId,
    target,
    field,
    value,
    title: String(raw?.title || `建议更新${field}`).trim().slice(0, 120),
    rationale: String(raw?.rationale || '').trim().slice(0, 1000),
    createdAt: new Date().toISOString(),
  };
}

function normalizeRecoveryProfile(raw, project) {
  const metricGroups = Array.isArray(raw?.metricGroups) ? raw.metricGroups.map((group) => ({
    name: String(group?.name || '').trim().slice(0, 80),
    metrics: Array.isArray(group?.metrics) ? group.metrics.map((metric) => String(metric || '').trim()).filter(Boolean).slice(0, 12) : [],
  })).filter((group) => group.name && group.metrics.length).slice(0, 8) : [];
  if (!metricGroups.length) return null;
  return { projectId: project.id, metricGroups, defaultSegments: String(raw?.defaultSegments || '').trim().slice(0, 300), source: 'user_confirmed' };
}

function normalizeMemoryUpdate(raw, project, initiativeId) {
  const allowed = new Set(['work_preference','delivery_format','metric_caliber','data_asset','collaboration_rule','project_background','project_history','project_status','current_focus','learning','decision','data_recovery_profile']);
  if (!allowed.has(raw?.type) || !String(raw?.statement || '').trim()) return null;
  const scope = raw.scope === 'global' ? 'global' : 'project';
  if (scope === 'global' && !['work_preference','delivery_format','metric_caliber','data_asset','collaboration_rule'].includes(raw.type)) return null;
  if (raw.type === 'data_recovery_profile' && (!raw.data || !hasConfirmedMetricProfile(raw.data))) return null;
  return { scope, projectId:scope==='project'?project.id:'', initiativeId:scope==='project'?initiativeId:'', type:raw.type, statement:String(raw.statement).trim().slice(0,1500), content:String(raw.content || raw.statement).trim().slice(0,4000), data:raw.data && typeof raw.data === 'object' ? raw.data : undefined, evidence:String(raw.evidence || '用户在对话中明确提供').trim().slice(0,1000) };
}

function normalizeAtomicToolCall(raw, project, initiativeId) {
  const name = String(raw?.name || '');
  const allowed = new Set(AGENT_TOOLS.map((item) => item.function.name));
  if (!allowed.has(name)) return null;
  const args = raw?.arguments && typeof raw.arguments === 'object' ? raw.arguments : raw;
  if (name === 'create_execution_plan' || name === 'update_execution_plan') return { name, args };
  if (name === 'update_long_term_memory') return { name, args:normalizeMemoryUpdate(args, project, initiativeId) || args };
  return { name, args };
}

function applyModelMemoryUpdate(state, update) {
  if (update.type === 'data_recovery_profile') {
    if (update.scope !== 'project' || !hasConfirmedMetricProfile(update.data)) throw Object.assign(new Error('data_recovery_profile 必须为项目级且包含已确认指标。'), { statusCode:422 });
    return activateRecoveryProfile(state, update.projectId, { ...update.data, source:'user_confirmed' });
  }
  const now = new Date().toISOString();
  if (update.scope === 'global') {
    const store = memories(state);
    const memoryKey = `global:${update.type}`;
    const index = store.findIndex((item) => item.memoryKey === memoryKey);
    const record = { id:index>=0?store[index].id:`global-memory-${Date.now()}-${Math.random().toString(16).slice(2)}`, memoryKey, scope:'global', status:'active', version:index>=0?Number(store[index].version||1)+1:1, createdAt:index>=0?store[index].createdAt:now, updatedAt:now, source:'user_confirmed', confidence:'high', data:{ content:update.content || '' }, ...update };
    if(index>=0)store[index]=record;else store.unshift(record);
    return record;
  }
  return upsertProjectMemory(state, { ...update, memoryKey:`agent:${update.type}:${update.initiativeId || 'project'}`, source:'user_confirmed', confidence:'high', evidence:update.evidence });
}

function createExecutionPlan(state, projectId, initiativeId, raw) {
  state.agentPlans ||= [];
  const now = new Date().toISOString();
  const checklist = Array.isArray(raw.completionChecklist) ? raw.completionChecklist.map((item) => ({ id:String(item.id || '').slice(0,120), description:String(item.description || '').slice(0,1000), status:'missing', note:'', artifactIds:[] })).filter((item) => item.id && item.description).slice(0,20) : [];
  if (!checklist.length) throw Object.assign(new Error('Execution Plan 必须包含至少一条可验证的 completionChecklist。'), { statusCode:422 });
  const parentPlan = raw.resumeCandidatePlanId ? state.agentPlans.find((item) => item.id === String(raw.resumeCandidatePlanId)) : null;
  if (raw.resumeCandidatePlanId && (!parentPlan || !['in_progress','needs_action'].includes(parentPlan.status) || parentPlan.projectId !== projectId || (initiativeId && parentPlan.initiativeId && parentPlan.initiativeId !== initiativeId))) throw Object.assign(new Error('resumeCandidatePlanId 不是当前项目/事项可用的续跑候选。'), { statusCode:422 });
  const inheritedChecklist = parentPlan ? (parentPlan.completionChecklist || []).map((item) => ({ id:item.id, description:item.description, status:item.status, note:item.note || '', artifactIds:Array.isArray(item.artifactIds) ? item.artifactIds : [] })) : [];
  const inheritedObligations = parentPlan ? (parentPlan.obligations || []).filter((item) => item.status === 'open').map((item) => ({ ...item, sourceRef:{ ...(item.sourceRef || {}), inheritedFromPlanId:parentPlan.id } })) : [];
  const plan = { id:`plan-${Date.now()}-${Math.random().toString(16).slice(2)}`, projectId, initiativeId:initiativeId || '', goal:String(raw.goal || '').slice(0,1000), taskType:String(raw.taskType || 'general').slice(0,120), completionChecklist:checklist, doneCriteria:checklist.map((item) => item.description), status:'in_progress', revision:1, currentStep:0, maxSteps:MAX_AGENT_LOOP_STEPS, toolResults:[], artifacts:[], obligations:inheritedObligations, missingActions:[], nextAction:'', summary:'', createdAt:now, updatedAt:now, completedAt:'', parentPlanId:parentPlan?.id || '', resumeMode:parentPlan ? String(raw.resumeMode || 'adapt') : '', inheritedChecklist, inheritedArtifactIds:parentPlan ? (parentPlan.artifacts || []).map((artifact) => artifact.id).filter(Boolean) : [], inheritedObligations };
  state.agentPlans.unshift(plan);
  state.agentPlans = state.agentPlans.slice(0,50);
  return plan;
}

function artifactCard(artifact) {
  return {
    id:artifact.id, type:artifact.type, title:artifact.title, initiativeId:artifact.initiativeId, createdAt:artifact.createdAt,
    source:artifact.source || {}, integrityStatus:artifact.integrityStatus, freshnessStatus:artifact.freshnessStatus, supersededBy:artifact.supersededBy || '',
  };
}

function selectedArtifactReference(artifact, purpose) {
  return { ...artifactCard(artifact), purpose, usableMediaAssetId:artifact.type === 'image' ? String(artifact.locator?.mediaAssetId || '') : '' };
}

function persistResultArtifacts(state, { projectId, initiativeId, runId, planId, result }) {
  normalizeArtifactRegistry(state);
  const persisted = [];
  for (const artifact of result?.artifacts || []) {
    if (!artifact?.id) continue;
    const source = artifact.source && typeof artifact.source === 'object' ? artifact.source : {};
    const record = {
      ...artifact,
      summary:String(artifact.summary || result.note || '').slice(0, 2000),
      projectId, initiativeId, runId, planId:planId || '',
      source:{ tool:result.name, status:result.status, ...source, experimentId:artifact.experimentId || source.experimentId || '', dataDate:artifact.dataDate || source.dataDate || result.data?.dataLatestDate || '' },
      locator:{ mediaAssetId:artifact.mediaAssetId || '', filePath:artifact.filePath || '', url:artifact.feishuUrl || artifact.imageUrl || '', reportId:artifact.reportId || '', knowledgeId:artifact.knowledgeId || '' },
      freshnessStatus:artifact.freshnessStatus || (result.data?.isLatest === false ? 'stale' : result.data?.dataLatestDate ? 'current' : 'not_applicable'),
      integrityStatus:'verified',
    };
    const index = state.artifacts.findIndex((item) => item.id === record.id);
    if (index >= 0) state.artifacts[index] = { ...state.artifacts[index], ...record };
    else state.artifacts.unshift(record);
    persisted.push(artifactCard(record));
  }
  state.artifacts = state.artifacts.slice(0, 1000);
  return persisted;
}

function fullTextScore(query, corpus) {
  const normalizedQuery = String(query || '').trim().toLowerCase();
  const normalizedCorpus = String(corpus || '').toLowerCase();
  const terms = queryTerms(normalizedQuery);
  const phraseScore = normalizedQuery && normalizedCorpus.includes(normalizedQuery) ? 12 : 0;
  const termScore = terms.reduce((total, term) => total + (normalizedCorpus.includes(term) ? 3 : 0), 0);
  return phraseScore + termScore;
}

function artifactSearchText(state, artifact) {
  const plan = (state.agentPlans || []).find((item) => item.id === artifact.planId);
  const run = (state.agentRuns || []).find((item) => item.id === artifact.runId);
  return [
    artifact.title, artifact.summary, artifact.type, artifact.source?.tool, artifact.source?.experimentId, artifact.source?.dataDate,
    plan?.goal, plan?.summary, run?.messagePreview, run?.historySummary,
  ].filter(Boolean).join('\n');
}

function artifactSearchCard(artifact) {
  return {
    artifactId:artifact.id, type:artifact.type, title:artifact.title, summary:artifact.summary || '', createdAt:artifact.createdAt,
    provenance:{ runId:artifact.runId || '', planId:artifact.planId || '', tool:artifact.source?.tool || '', experimentId:artifact.source?.experimentId || '' },
    integrityStatus:artifact.integrityStatus, freshnessStatus:artifact.freshnessStatus, externalUrl:artifact.locator?.url || '',
  };
}

function searchArtifacts(state, { projectId, initiativeId = '', query = '', types = [], limit = 6 }) {
  normalizeArtifactRegistry(state);
  const allowedTypes = new Set(Array.isArray(types) ? types.map(String) : []);
  return state.artifacts.filter((artifact) => artifact.projectId === projectId && (!initiativeId || artifact.initiativeId === initiativeId) && (!allowedTypes.size || allowedTypes.has(artifact.type)) && artifact.integrityStatus !== 'unavailable').map((artifact) => {
    const score = fullTextScore(query, artifactSearchText(state, artifact));
    return { artifact, score };
  }).filter((entry) => !String(query || '').trim() || entry.score > 0).sort((a, b) => b.score - a.score || String(b.artifact.createdAt).localeCompare(String(a.artifact.createdAt))).slice(0, Math.max(1, Math.min(Number(limit) || 6, 8))).map(({ artifact }) => artifactSearchCard(artifact));
}

function historyScopeMatches(record, projectId, initiativeId) {
  return record?.projectId === projectId && (!initiativeId || !record.initiativeId || record.initiativeId === initiativeId);
}

function planHistoryCard(plan, state) {
  const artifactIds = new Set([...(plan.artifacts || []).map((item) => item.id), ...(plan.completionChecklist || []).flatMap((item) => item.artifactIds || [])]);
  const artifactRefs = state.artifacts.filter((item) => artifactIds.has(item.id)).slice(0, 8).map((item) => ({ artifactId:item.id, type:item.type, title:item.title }));
  return {
    historyId:`history-plan-${plan.id}`, kind:'execution_plan', recordRef:{ planId:plan.id }, title:plan.goal, summary:plan.summary || plan.nextAction || '', status:plan.status,
    initiativeId:plan.initiativeId || '', updatedAt:plan.updatedAt || plan.createdAt || '',
    checklist:{
      completed:(plan.completionChecklist || []).filter((item) => item.status === 'completed').map((item) => ({ id:item.id, description:item.description, artifactIds:item.artifactIds || [] })),
      unfinished:(plan.completionChecklist || []).filter((item) => item.status !== 'completed').map((item) => ({ id:item.id, description:item.description, status:item.status, note:item.note || '' })),
    },
    openObligations:(plan.obligations || []).filter((item) => item.status === 'open').map((item) => ({ id:item.id, kind:item.kind, instruction:item.instruction })), artifactRefs,
  };
}

function runHistoryCard(run, state) {
  const artifactRefs = [...new Map((run.historyRefs?.artifactIds || []).map((id) => {
    const artifact = (state.artifacts || []).find((item) => item.id === id);
    return [id, artifact ? { artifactId:id, type:artifact.type, title:artifact.title } : { artifactId:id }];
  })).values()];
  const plan = run.planId ? (state.agentPlans || []).find((item) => item.id === run.planId) : null;
  return {
    historyId:`history-run-${run.id}`, kind:'agent_run', recordRef:{ runId:run.id, planId:run.planId || '' }, title:run.messagePreview || 'Agent Run',
    summary:run.historySummary || run.error || '', status:run.status, initiativeId:run.initiativeId || '', completedAt:run.completedAt || run.startedAt || '', artifactRefs,
    executionPlan:plan ? planHistoryCard(plan, state) : null,
  };
}

function memoryHistoryCard(memory) {
  return {
    historyId:`history-memory-${memory.id}`, kind:'confirmed_memory', recordRef:{ memoryId:memory.id }, title:memory.statement,
    summary:String(memory.data?.content || memory.content || memory.statement || ''), status:memory.status, initiativeId:memory.initiativeId || '', updatedAt:memory.updatedAt || memory.createdAt || '', artifactRefs:[],
  };
}

function historySearchText(item) {
  return [item.title, item.summary, item.status, ...(item.checklist?.completed || []).flatMap((entry) => [entry.description, ...(entry.artifactIds || [])]), ...(item.checklist?.unfinished || []).flatMap((entry) => [entry.description, entry.note]), ...(item.openObligations || []).map((item) => item.instruction), ...(item.artifactRefs || []).flatMap((item) => [item.title, item.artifactId])].filter(Boolean).join('\n');
}

function searchProjectHistory(state, { projectId, initiativeId = '', query = '', kinds = [], limit = 6 }) {
  normalizeExecutionPlans(state);
  normalizeArtifactRegistry(state);
  const allowedKinds = new Set(Array.isArray(kinds) ? kinds.map(String) : []);
  const items = [
    ...(state.agentPlans || []).filter((item) => historyScopeMatches(item, projectId, initiativeId)).map((item) => planHistoryCard(item, state)),
    ...(state.agentRuns || []).filter((item) => historyScopeMatches(item, projectId, initiativeId)).map((item) => runHistoryCard(item, state)),
    ...(state.artifacts || []).filter((item) => historyScopeMatches(item, projectId, initiativeId)).map((item) => ({ historyId:`history-artifact-${item.id}`, kind:'artifact_activity', recordRef:{ artifactId:item.id, runId:item.runId || '', planId:item.planId || '' }, title:item.title, summary:item.summary || '', status:item.integrityStatus, initiativeId:item.initiativeId || '', updatedAt:item.createdAt || '', artifactRefs:[{ artifactId:item.id, type:item.type, title:item.title }] })),
    memoryByScope(state, 'project', projectId).filter((item) => item.type !== 'data_recovery_profile' && (!initiativeId || !item.initiativeId || item.initiativeId === initiativeId)).map(memoryHistoryCard),
  ];
  return items.filter((item) => !allowedKinds.size || allowedKinds.has(item.kind)).map((item) => ({ item, score:fullTextScore(query, historySearchText(item)) })).filter((entry) => !String(query || '').trim() || entry.score > 0).sort((a, b) => b.score - a.score || String(b.item.updatedAt || b.item.completedAt || '').localeCompare(String(a.item.updatedAt || a.item.completedAt || ''))).slice(0, Math.max(1, Math.min(Number(limit) || 6, 8))).map(({ item }) => item);
}

function historySafeValue(value, maximum = 12_000) {
  const seen = new WeakSet();
  const sanitize = (item) => {
    if (typeof item === 'string') {
      if (/^data:[a-z]+\/[a-z0-9.+-]+;base64,/i.test(item)) return '[已省略 Base64 数据]';
      return item.length > maximum ? `${item.slice(0, maximum)}\n[内容已截断]` : item;
    }
    if (!item || typeof item !== 'object') return item;
    if (seen.has(item)) return '[循环引用已省略]';
    seen.add(item);
    if (Array.isArray(item)) return item.slice(0, 80).map(sanitize);
    return Object.fromEntries(Object.entries(item).flatMap(([key, child]) => {
      if (/^(filePath|absolutePath|dataUrl|authorization|apiKey|token|secret)$/i.test(key)) return [];
      return [[key, sanitize(child)]];
    }));
  };
  return sanitize(value);
}

function historyArtifactRefs(state, record) {
  const refs = [];
  const add = (id) => {
    const artifact = (state.artifacts || []).find((item) => item.id === id);
    if (artifact && artifact.integrityStatus !== 'unavailable') refs.push(artifactSearchCard(artifact));
  };
  for (const id of record?.artifactRefs || []) add(typeof id === 'string' ? id : id?.artifactId);
  for (const artifact of record?.persistedArtifacts || record?.artifacts || []) add(artifact?.id);
  return [...new Map(refs.map((item) => [item.artifactId, item])).values()];
}

function conversationHistoryRecords(project, initiativeId) {
  const store = conversationStore(project, initiativeId);
  if (!store) return [];
  const scope = initiativeId ? 'initiative' : 'project';
  const messages = (store.memory || []).map((message, index) => ({
    historyId:`history-conversation-${scope}-${index}-${message.createdAt || ''}`,
    source:'conversation', recordRef:{ conversationScope:scope, messageIndex:index }, role:message.role === 'user' ? 'user' : 'assistant',
    content:cleanConversationMessage(message), createdAt:message.createdAt || '', initiativeId:initiativeId || '',
  }));
  const summary = String(store.conversationSummary?.summary || '').trim();
  if (summary) messages.unshift({
    historyId:`history-conversation-summary-${scope}`, source:'conversation', recordRef:{ conversationScope:scope, summary:true }, role:'summary',
    content:summary, createdAt:store.conversationSummary.updatedAt || '', initiativeId:initiativeId || '', truncated:true,
  });
  return messages;
}

function toolCallHistoryRecords(state, projectId, initiativeId) {
  const records = [];
  for (const run of state.agentRuns || []) {
    if (!historyScopeMatches(run, projectId, initiativeId)) continue;
    for (const step of run.steps || []) {
      if (step?.type !== 'tool') continue;
      const output = step.output && typeof step.output === 'object' ? step.output : {};
      records.push({
        historyId:`history-tool-${run.id}-${output.toolCallId || step.name || records.length}`,
        source:'tool_call', recordRef:{ runId:run.id, planId:run.planId || '', toolCallId:output.toolCallId || '', tool:output.name || output.tool || step.name || '' },
        title:output.title || output.name || output.tool || step.label || step.name || '工具调用', status:output.status || step.status || '',
        input:historySafeValue(step.input || {}), output:historySafeValue(output), createdAt:step.completedAt || step.updatedAt || run.completedAt || run.startedAt || '',
        initiativeId:run.initiativeId || '', artifactRefs:historyArtifactRefs(state, output),
      });
    }
  }
  return records;
}

function queryAgentHistory(state, { projectId, initiativeId = '', query = '', sources = [], limit = 6 }) {
  normalizeExecutionPlans(state);
  normalizeArtifactRegistry(state);
  normalizeConversationMemoryStore(state);
  const project = findProject(state, projectId);
  const selectedInitiativeIds = initiativeId ? [initiativeId] : ['', ...(project?.initiatives || []).map((item) => item.id)];
  const allowedSources = new Set(Array.isArray(sources) ? sources.map(String) : []);
  const runRecords = (state.agentRuns || []).filter((item) => historyScopeMatches(item, projectId, initiativeId)).map((item) => ({ ...runHistoryCard(item, state), source:'agent_run' }));
  const artifactRecords = (state.artifacts || []).filter((item) => historyScopeMatches(item, projectId, initiativeId)).map((item) => ({ historyId:`history-artifact-${item.id}`, source:'artifact', recordRef:{ artifactId:item.id, runId:item.runId || '', planId:item.planId || '' }, ...artifactSearchCard(item), initiativeId:item.initiativeId || '' }));
  const conversationRecords = selectedInitiativeIds.flatMap((id) => conversationHistoryRecords(project, id));
  const toolRecords = toolCallHistoryRecords(state, projectId, initiativeId);
  const records = [...conversationRecords, ...toolRecords, ...runRecords, ...artifactRecords];
  return records.filter((record) => !allowedSources.size || allowedSources.has(record.source)).map((record) => ({ record, score:fullTextScore(query, JSON.stringify(record)) })).filter(({ score }) => !String(query || '').trim() || score > 0).sort((a, b) => b.score - a.score || String(b.record.createdAt || b.record.updatedAt || b.record.completedAt || '').localeCompare(String(a.record.createdAt || a.record.updatedAt || a.record.completedAt || ''))).slice(0, Math.max(1, Math.min(Number(limit) || 6, 8))).map(({ record }) => record);
}

function updateExecutionPlan(plan, raw) {
  plan.updatedAt = new Date().toISOString();
  const updates = new Map((raw.completionChecklist || []).map((item) => [String(item.id), item]));
  plan.completionChecklist = (plan.completionChecklist || []).map((item) => {
    const update = updates.get(item.id);
    return update ? { ...item, status:update.status || item.status, note:String(update.note || ''), artifactIds:Array.isArray(update.artifactIds)?update.artifactIds.map(String):item.artifactIds } : item;
  });
  const obligationUpdates = new Map((raw.obligations || []).map((item) => [String(item.id), item]));
  plan.obligations = (plan.obligations || []).map((item) => {
    const update = obligationUpdates.get(item.id);
    return update && ['fulfilled','waived'].includes(update.status) ? { ...item, status:update.status, evidence:String(update.evidence || '').slice(0, 2000) } : item;
  });
  const unfinished = (plan.completionChecklist || []).filter((item) => item.status !== 'completed');
  const openObligations = (plan.obligations || []).filter((item) => item.status === 'open');
  const requestedCompletion = Boolean(raw.goalCompleted);
  plan.goalCompleted = requestedCompletion && unfinished.length === 0 && openObligations.length === 0;
  const suppliedMissing = Array.isArray(raw.missingActions) ? raw.missingActions.map(String).filter(Boolean).slice(0,12) : [];
  plan.missingActions = plan.goalCompleted ? [] : [...new Set([...suppliedMissing, ...unfinished.map((item) => item.description), ...openObligations.map((item) => item.instruction)])].slice(0,12);
  plan.nextAction = String(raw.nextAction || (plan.goalCompleted ? '' : '完成未完成的 checklist 项。')).slice(0,1000);
  plan.summary = String(raw.summary || '').slice(0,2000);
  plan.status = plan.goalCompleted ? 'completed' : 'needs_action';
  plan.completionRejected = requestedCompletion && !plan.goalCompleted;
  plan.revision = Number(plan.revision || 1) + 1;
  if (plan.goalCompleted) plan.completedAt = plan.updatedAt;
  return plan;
}

function normalizeAgentAnswer(raw, fallbackText, state, project, initiativeId, providerToolCalls = []) {
  const parsed = raw && typeof raw === 'object' ? raw : {};
  const actions = Array.isArray(parsed.actions) ? parsed.actions.slice(0,3).map((item) => ({ action:String(item?.action || '').trim(), ddl:String(item?.ddl || '').trim(), impact:String(item?.impact || '').trim() })).filter((item) => item.action) : [];
  const proposals = Array.isArray(parsed.proposals) ? parsed.proposals.map((item) => normalizeProposal(item, project, initiativeId)).filter(Boolean).slice(0,3) : [];
  const memoryCandidates = Array.isArray(parsed.memoryCandidates) ? parsed.memoryCandidates.map((item) => normalizeMemoryCandidate(item, project, initiativeId)).filter(Boolean).slice(0,2) : [];
  const atomicCalls = providerToolCalls.map((item) => normalizeAtomicToolCall(item, project, initiativeId)).filter(Boolean).slice(0,12);
  return { facts:asStringList(parsed.facts), assessments:asStringList(parsed.assessments), actions, confirmations:asStringList(parsed.confirmations), proposals, memoryCandidates, atomicCalls, toolResults:[], fallbackText:raw ? '' : fallbackText };
}

function terminalUserFacingReply(answer) {
  const call = collectAgentCalls(answer).find((item) => item.name === 'update_execution_plan' && item.args?.goalCompleted === true);
  return String(call?.args?.userFacingReply || '').trim();
}
function applyTerminalUserFacingReply(answer, plan) {
  const reply = plan?.goalCompleted ? terminalUserFacingReply(answer) : '';
  return reply ? { ...answer, text:reply, structured:{ ...(answer?.structured || {}), fallbackText:reply } } : answer;
}

function applyProposal(state, proposal) {
  const project = findProject(state, proposal.projectId);
  if (!project) throw Object.assign(new Error('Proposal project not found.'), { statusCode: 404 });
  const target = proposal.target === 'project'
    ? project
    : (project.initiatives || []).find((initiative) => initiative.id === proposal.initiativeId);
  if (!target) throw Object.assign(new Error('Proposal initiative not found.'), { statusCode: 404 });
  target[proposal.field] = proposal.value;
}

function normalizeMemoryCandidate(raw, project, initiativeId) {
  const type = raw?.type === 'decision' ? 'decision' : 'learning';
  const statement = String(raw?.statement || '').trim();
  if (!statement) return null;
  return {
    id: `memory-draft-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    projectId: project.id,
    initiativeId: raw?.scope === 'project' ? '' : (initiativeId || ''),
    type,
    statement: statement.slice(0, 1000),
    confidence: ['high', 'medium', 'low'].includes(raw?.confidence) ? raw.confidence : 'medium',
    evidence: String(raw?.evidence || '').trim().slice(0, 1000),
    source: 'agent_generated',
  };
}


function createProjectMemory(state, entry) {
  const project = findProject(state, entry.projectId);
  if (!project || !['learning', 'decision', 'project_background', 'project_history', 'project_status', 'current_focus', 'data_recovery_profile'].includes(entry.type) || !String(entry.statement || '').trim()) {
    throw Object.assign(new Error('Invalid project memory entry.'), { statusCode: 422 });
  }
  const record = {
    id: `memory-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    projectId: entry.projectId,
    initiativeId: entry.initiativeId || '',
    type: entry.type,
    statement: String(entry.statement).trim().slice(0, 1000),
    confidence: ['high', 'medium', 'low'].includes(entry.confidence) ? entry.confidence : 'medium',
    evidence: String(entry.evidence || '').trim().slice(0, 1000),
    source: 'agent_generated',
    status: 'active',
    version: 1,
    supersedes: '',
    supersededBy: '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  memories(state).unshift({ ...record, scope:record.initiativeId ? 'initiative' : 'project', data:{ content:record.content || '' } });
  return record;
}

function upsertProjectMemory(state, entry) {
  const store = memories(state);
  const index = store.findIndex((item) => item.memoryKey && item.memoryKey === entry.memoryKey && item.projectId === entry.projectId);
  const now = new Date().toISOString();
  const record = { id:index >= 0 ? store[index].id : `memory-${Date.now()}-${Math.random().toString(16).slice(2)}`, scope:entry.initiativeId ? 'initiative' : 'project', status:'active', version:index >= 0 ? Number(store[index].version || 1) + 1 : 1, createdAt:index >= 0 ? store[index].createdAt : now, updatedAt:now, source:'project_overview', confidence:'high', evidence:'用户在项目全景中输入', initiativeId:'', data:{ content:entry.content || '' }, ...entry };
  if (index >= 0) store[index] = record;
  else store.unshift(record);
  return record;
}

function syncDataRecoveryProfileMemory(state, profile) {
  if (!profile?.projectId) return null;
  return upsertProjectMemory(state, { projectId:profile.projectId, type:'data_recovery_profile', memoryKey:'data_recovery_profile', statement:dataRecoveryProfileStatement(profile), data:profile, source:'user_confirmed', confidence:'high', evidence:'用户确认的数据回收配置' });
}

function activeConversationPlan(state, projectId, initiativeId = '') {
  return (state?.agentPlans || []).find((plan) => plan.projectId === projectId && String(plan.initiativeId || '') === String(initiativeId || '') && ['in_progress','needs_action'].includes(plan.status)) || null;
}

function rememberRunDiscoveredSkills(run, found) {
  if (!run || !found) return;
  const candidates = [
    ...(found.level === 'parent' ? found.items || [] : [found.parent, ...(found.items || [])]),
  ].filter((item) => item?.skillPath && typeof item.content === 'string').map((item) => ({
    skillPath:item.skillPath,
    parentSkillPath:item.parentSkillPath || (found.level === 'parent' ? item.skillPath : found.parent?.skillPath || ''),
    title:item.title || '',
    kind:item.parentSkillPath ? 'child' : 'parent',
    content:item.content,
    discoveredAt:new Date().toISOString(),
  }));
  const byPath = new Map((run.discoveredSkillRefs || []).map((item) => [item.skillPath, item]));
  for (const item of candidates) byPath.set(item.skillPath, item);
  run.discoveredSkillRefs = [...byPath.values()];
}

function conversationSummaryInstructions() {
  return [
    '压缩项目对话，保留已确认事实、用户偏好、未完成事项和工具操作；不编造，1200 字以内。',
    '把 Conversation Summary 当作可继续执行的任务交接单，而不是泛泛回顾。每个未完成用户请求必须单独保留：具体要改/产出的内容、目标对象（文档 URL、文件、项目、事项、Block 等已知标识）、要求的操作方式（例如原位替换/创建/验证）、当前已完成证据、仍缺什么、下一步。',
    '不得把已知细节压缩成“更新方案”“修改文档”“继续处理”等泛称；例如用户要求把某两版搭配交互方案中的具体入口、跳转、换一换逻辑更新到某飞书文档时，摘要必须同时保留方案内容范围与目标文档标识。未知信息要明确标为未知，不能补写。',
    '若提供当前 Execution Plan，将其未完成 checklist 和 nextAction 作为交接线索，但只保留有真实对话或执行证据支持的内容。',
  ].join('\n');
}

function createAgentRun({ projectId = '', initiativeId = '', conversationId = '', message, imageAssetIds = [], runId = '', manualRerunOf = '' }) {
  const startedAt = new Date().toISOString();
  const command=String(message || '');
  return { id:runId || `run-${Date.now()}-${Math.random().toString(16).slice(2)}`, type:'project_chat', status:'running', projectId, initiativeId:initiativeId || '', conversationId, message:command, messagePreview:command.slice(0,160) || (imageAssetIds.length ? `已上传 ${imageAssetIds.length} 张图片` : ''), imageAssetIds, manualRerunOf, startedAt, completedAt:'', durationMs:null, model:'', requestId:'', modelUsage:null, outputFormat:'', error:'', planRef:null, selectedArtifactRefs:[], discoveredSkillRefs:[], cliHelpCache:[], executionHandoff:{ usableFacts:[] }, executionHandoffCoveredToolCallIds:[], executionHandoffLastLoop:0, executionHandoffFailure:null, promptSnapshots:[], steps:[ { name:'context_builder', type:'context', label:projectId ? '构建项目 Context' : '构建工作区 Context', status:'running', input:{ currentCommand:command, imageAssetIds, conversationId }, output:{} }, { name:'model_call', type:'llm', label:'调用 AI 模型（Loop 1）', status:'running', input:{}, output:{} } ] };
}

function recoverManualRerunInput(run) {
  const contextInput=(run?.steps || []).find((step) => step?.name === 'context_builder')?.input || {};
  const message=[run?.message, contextInput.currentCommand].map((value) => String(value || '').trim()).find(Boolean) || '';
  const imageAssetIds=Array.isArray(run?.imageAssetIds) && run.imageAssetIds.length
    ? run.imageAssetIds.map(String).filter(Boolean)
    : (Array.isArray(contextInput.imageAssetIds) ? contextInput.imageAssetIds.map(String).filter(Boolean) : []);
  return { message, imageAssetIds };
}

function validateManualRerun(state, { runId, conversationId }) {
  const source=(state?.agentRuns || []).find((item) => item.id === runId);
  if (!source || source.conversationId !== conversationId) throw Object.assign(new Error('未找到当前对话可重跑的 AI Run。'), { statusCode:404 });
  if (runHasUserFacingModelReply(source)) throw Object.assign(new Error('该 AI Run 已收到模型回复，不需要重试。'), { statusCode:409 });
  const latest=(state?.agentRuns || []).find((item) => item.conversationId === conversationId);
  if (latest?.id !== source.id) throw Object.assign(new Error('只能重跑当前对话最新一条失败或已停止的消息。'), { statusCode:409 });
  if (source.manualRerunRunId) throw Object.assign(new Error('这条消息已手动重跑过一次。'), { statusCode:409 });
  const input=recoverManualRerunInput(source);
  if (!input.message && !input.imageAssetIds.length) throw Object.assign(new Error('原始消息内容不可用，无法重跑。'), { statusCode:409 });
  return { source, ...input };
}

function resolveChatModel(modelId = '') {
  const requested = String(modelId || OPENROUTER_MODEL).trim();
  if (DEMO_MODE && requested === DEMO_AGENT_MODEL.id) return DEMO_AGENT_MODEL;
  const model = CHAT_MODEL_CATALOG.find((item) => item.id === requested);
  if (model) return model;
  // The browser only receives ids from OpenRouter's catalog. Keep this small
  // syntax guard so a freshly fetched provider model does not need a manual
  // server-side registration before it can be used in a chat request.
  if (/^[a-z0-9][a-z0-9._/-]{1,200}$/i.test(requested)) return { id:requested, label:requested, supportsVision:true, source:'provider' };
  throw Object.assign(new Error('所选模型 ID 无效。'), { statusCode:422 });
}

function clipLogText(value, maximum = 30000) { const text=String(value || ''); return text.length > maximum ? `${text.slice(0, maximum)}\n\n[日志内容已截断]` : text; }
function snapshotAuditValue(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}
function compactResultReference(result) {
  return { toolCallId:result?.toolCallId || '', name:result?.name || result?.tool || '', status:result?.status || '', title:result?.title || '', summary:String(result?.summary || result?.note || '').slice(0, 300) };
}
function compactArtifactReference(artifact) {
  const reference = { id:artifact?.id || '', type:artifact?.type || '', title:artifact?.title || '' };
  const url = String(artifact?.externalUrl || artifact?.url || artifact?.feishuUrl || artifact?.locator?.url || '');
  if (/^https:\/\//.test(url)) reference.url = url;
  return reference;
}
function normalizeModelUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const readTokenCount = (...values) => {
    for (const value of values) {
      const number = Number(value);
      if (Number.isFinite(number) && number >= 0) return Math.trunc(number);
    }
    return null;
  };
  const inputTokens = readTokenCount(usage.input_tokens, usage.prompt_tokens, usage.inputTokens, usage.promptTokens);
  const outputTokens = readTokenCount(usage.output_tokens, usage.completion_tokens, usage.outputTokens, usage.completionTokens);
  const totalTokens = readTokenCount(usage.total_tokens, usage.totalTokens) ?? (inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null);
  if (inputTokens === null && outputTokens === null && totalTokens === null) return null;
  return { inputTokens, outputTokens, totalTokens };
}
function summarizeRunModelUsage(promptSnapshots = []) {
  const totals = { inputTokens:null, outputTokens:null, totalTokens:null };
  let hasUsage = false;
  for (const snapshot of promptSnapshots) {
    const usage = snapshot?.usage;
    if (!usage) continue;
    hasUsage = true;
    for (const field of Object.keys(totals)) {
      if (!Number.isFinite(usage[field])) continue;
      totals[field] = (totals[field] || 0) + usage[field];
    }
  }
  return hasUsage ? totals : null;
}
function modelFactsForToolResult(result) {
  const data = result?.data || {};
  const shared = { summary:String(result?.summary || result?.note || result?.error || '').slice(0, 800) };
  if (result?.status === 'failed' || result?.status === 'blocked' || result?.status === 'needs_input' || result?.status === 'conflict') {
    if ((result?.name || result?.tool) === 'execute_cli' && data && typeof data === 'object') {
      return { ...shared, cli:String(data.cli || ''), argv:Array.isArray(data.argv) ? data.argv.map(String).slice(0, 80) : [], exitCode:data.exitCode ?? null, stderr:String(data.stderr || '').slice(0, 6_000) };
    }
    return shared;
  }
  switch (result?.name || result?.tool) {
    case 'inspect_cli_help': return { cli:data.cli, argv:data.argv || [], capabilities:data.capabilities || '', exitCode:data.exitCode, stdout:data.stdout || '', stderr:data.stderr || '' };
    case 'search_skills': return { level:data.level || '', parent:data.parent || null, items:data.items || [] };
    case 'execute_cli': return { cli:data.cli, argv:data.argv || [], exitCode:data.exitCode, durationMs:data.durationMs, stdout:data.stdout || '', stderr:data.stderr || '', json:data.json || null };
    case 'read_experiment_metadata': return { experimentId:data.experimentId, title:data.title, startDate:data.startDate, endDate:data.endDate, experimentVersionIds:data.experimentVersionIds || [] };
    case 'resolve_metric_specs': return { experimentId:data.experimentId, metricGroups:data.metricGroups || [] };
    case 'query_metric_data': return { experimentId:data.experimentId, metricResults:data.metricResults || [], dataLatestDate:data.dataLatestDate, isLatest:data.isLatest, continuation:data.continuation, deliveryDisclosure:data.deliveryDisclosure || null };
    case 'read_feishu_document': return { documentUrl:data.documentUrl, title:data.title, contentExcerpt:data.contentExcerpt, blocks:data.blocks || [], truncated:Boolean(data.truncated) };
    case 'read_web_page': return { url:data.url, title:data.title, contentExcerpt:data.contentExcerpt, fetchedAt:data.fetchedAt, truncated:Boolean(data.truncated) };
    case 'query_agent_history':
    case 'search_project_knowledge':
    case 'search_item_knowledge':
    case 'search_memory': return { items:data.items || [] };
    case 'create_feishu_document':
    case 'append_feishu_document':
    case 'replace_feishu_document_text': return { documentUrl:data.documentUrl || data.url || '' };
    case 'replace_feishu_document_blocks': return { documentUrl:data.documentUrl || data.url || '', updatedBlockIds:data.updatedBlockIds || [] };
    case 'replace_feishu_document_images': return { documentUrl:data.documentUrl, replacedImageBlockIds:data.replacedImageBlockIds || [], insertedArtifactIds:data.insertedArtifactIds || [], failures:data.failures || [] };
    case 'insert_document_images': return { documentUrl:data.documentUrl, count:data.count, insertedArtifactIds:data.insertedArtifactIds || [], failures:data.failures || [] };
    case 'update_execution_plan': return { planRef:data.planRef || null, goalCompleted:Boolean(data.goalCompleted), completionRejected:Boolean(data.completionRejected), missingActions:data.missingActions || [], nextAction:data.nextAction || '' };
    default: return shared;
  }
}
function compactToolResultForModel(result) {
  const guidance = result?.modelGuidance || buildToolResultGuidance(result || {});
  const tool = result?.name || result?.tool || '';
  const payload = { tool, status:result?.status || 'unknown', facts:modelFactsForToolResult(result), next:String(guidance?.nextStep || '').slice(0, 1000), artifacts:(result?.persistedArtifacts || result?.artifacts || []).map(compactArtifactReference) };
  if (['failed','blocked','needs_input','conflict'].includes(payload.status)) {
    payload.error = String(result?.error || result?.summary || result?.note || '').slice(0, 1000);
    payload.missing = Array.isArray(result?.missing) ? result.missing.map(String).slice(0, 12) : [];
    payload.retryable = Boolean(result?.retryable);
  }
  if (tool === 'update_execution_plan') {
    const data = result?.data || {};
    payload.planDelta = { reconcile:false, planRef:data.planRef || null, checklist:(data.completionChecklist || []).map((item) => ({ id:item.id, status:item.status, note:String(item.note || '').slice(0, 500), artifactIds:item.artifactIds || [] })), obligations:(data.obligations || []).map((item) => ({ id:item.id, status:item.status, instruction:String(item.instruction || '').slice(0, 500), evidence:String(item.evidence || '').slice(0, 500) })) };
    payload.next = String(data.nextAction || guidance?.nextStep || '').slice(0, 1000);
  } else if (tool !== 'create_execution_plan') {
    // This is a generic state-transition marker, not a checklist mapping: the
    // model remains responsible for matching facts to the current Plan.
    payload.planDelta = { reconcile:true };
  }
  return payload;
}
function buildAgentLoopAuditInput({ lastLoopToolResults = [], allToolResults = [], artifacts = [], planRef = null, retryPolicy = null, forceFinalResponse = false, snapshotId = '' }) {
  return {
    ...(snapshotId ? { snapshotId } : {}),
    lastLoopToolResults:snapshotAuditValue(lastLoopToolResults),
    cumulativeToolResultRefs:(allToolResults || []).map(compactResultReference),
    availableArtifactRefs:(artifacts || []).map(compactArtifactReference),
    planRef:snapshotAuditValue(planRef),
    retryPolicy:snapshotAuditValue(retryPolicy),
    forceFinalResponse:Boolean(forceFinalResponse),
  };
}
function escapeDocXml(value = '') { return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
function findDocumentUrl(value) { if (!value || typeof value !== 'object') return ''; for (const [key,item] of Object.entries(value)) { if (typeof item === 'string' && /(url|link)$/i.test(key) && /^https:\/\//.test(item)) return item; if (item && typeof item === 'object') { const nested=findDocumentUrl(item); if (nested) return nested; } } return ''; }

function recordPromptSnapshot(run, { loop, phase, debug, answer, toolCalls = [] }) {
  const snapshot = { id:`snapshot-${run.id}-${loop}-${Date.now()}`, loop, phase, createdAt:new Date().toISOString(), model:answer?.model || '', requestId:answer?.requestId || null, usage:normalizeModelUsage(answer?.usage), context:debug?.context || '', systemPrompt:debug?.systemPrompt || '', userPrompt:debug?.userPrompt || '', assistantText:debug?.assistantPrompt || answer?.text || '', toolCalls, charCounts:{ context:(debug?.context || '').length, systemPrompt:(debug?.systemPrompt || '').length, userPrompt:(debug?.userPrompt || '').length, assistantText:(debug?.assistantPrompt || answer?.text || '').length } };
  run.promptSnapshots ||= [];
  run.promptSnapshots.push(snapshot);
  return snapshot;
}

function prunePromptSnapshots(state, keepRuns = 10) {
  if (!Array.isArray(state?.agentRuns)) return;
  for (const [index,run] of state.agentRuns.entries()) {
    if (index < keepRuns) continue;
    if (Array.isArray(run.promptSnapshots) && run.promptSnapshots.length) run.promptSnapshotPrunedAt = new Date().toISOString();
    delete run.promptSnapshots;
    delete run.prompts;
  }
}

function modelReplyText(value) { return String(value || '').trim(); }
function hasUserFacingModelReply(value) {
  const text=modelReplyText(typeof value === 'object' && value ? (value.text || value.structured?.fallbackText) : value);
  return Boolean(text) && !['正在准备执行请求…','正在继续执行任务…','[模型仅返回工具调用]'].includes(text);
}
function runHasUserFacingModelReply(run) {
  if (run?.hasModelReply === true || run?.status === 'completed') return true;
  if (run?.hasModelReply === false) return false;
  const modelTexts=(run?.steps || []).filter((step) => step?.type === 'llm').map((step) => step?.output?.assistantText);
  if (modelTexts.some(hasUserFacingModelReply)) return true;
  return !run?.error && hasUserFacingModelReply(run?.historySummary);
}
function finishAgentRun(run, { answer, error }) {
  const completedAt=new Date().toISOString(); run.completedAt=completedAt; run.durationMs=Math.max(0,new Date(completedAt).getTime()-new Date(run.startedAt).getTime()); run.hasModelReply=!error && hasUserFacingModelReply(answer); run.status=error?.code === 'AGENT_STOPPED' ? 'stopped' : error ? 'failed' : run.hasModelReply ? 'completed' : 'needs_action'; run.model=answer?.model || ''; run.requestId=answer?.requestId || ''; run.modelUsage=summarizeRunModelUsage(run.promptSnapshots); run.outputFormat=answer?.structured?.fallbackText?'text_fallback':'structured'; run.error=error?publicErrorMessage(error):'';
  run.historySummary = String(error ? publicErrorMessage(error) : answer?.text || '').slice(0, 2000);
  const artifactIds = [
    ...(run.selectedArtifactRefs || []).map((item) => item.id),
    ...(run.steps || []).flatMap((step) => step?.output?.persistedArtifacts || []).map((item) => item.id),
  ].filter(Boolean);
  run.historyRefs = { planId:run.planId || '', artifactIds:[...new Set(artifactIds)] };
  const modelStep=run.steps.find((step)=>step.name==='model_call'); if (modelStep) modelStep.status=error?'failed':'completed';
}

function demoAgentAnswer({ state, run, conversation, command, origin }) {
  const now = new Date().toISOString();
  const project = findProject(state, run.projectId);
  const initiative = project?.initiatives?.find((item) => item.id === run.initiativeId);
  const normalized = String(command || '').toLowerCase();
  let text;
  let outcome = '项目分析';
  const demoToolResults=[];
  const addDemoTool=(name, title, input, data, note) => {
    const toolCallId=`${run.id}:${name}:${demoToolResults.length + 1}`;
    const result={ name, toolCallId, status:'completed', title, input, data, note, summary:note, modelGuidance:{ nextStep:'继续执行演示数据回收链路。' } };
    run.steps.push({ name:`tool:${toolCallId}`, type:'tool', label:`工具：${name}`, status:'completed', input, output:result });
    demoToolResults.push(result);
    return result;
  };
  const recordDemoSnapshot=(loop, phase, context, assistantText, toolCalls=[]) => {
    const contextText=typeof context === 'string' ? context : JSON.stringify(context, null, 2);
    const systemPrompt=agentInstructions();
    const userPrompt=`Context：\n${contextText}\n\n当前命令：\n${command}`;
    const snapshot={ id:`snapshot-${run.id}-${loop}-demo`, loop, phase, createdAt:now, model:'demo-agent', requestId:`demo-${run.id}-loop-${loop}`, usage:{ prompt_tokens:Math.ceil((systemPrompt.length+userPrompt.length)/4), completion_tokens:Math.ceil(assistantText.length/4), total_tokens:Math.ceil((systemPrompt.length+userPrompt.length+assistantText.length)/4) }, context:contextText, systemPrompt, userPrompt, assistantText, toolCalls, charCounts:{ context:contextText.length, systemPrompt:systemPrompt.length, userPrompt:userPrompt.length, assistantText:assistantText.length } };
    run.promptSnapshots.push(snapshot);
    return snapshot;
  };
  if (/(回收|实验|指标|数据|libra)/i.test(normalized)) {
    outcome = '实验数据回收';
    const experimentId='EXP-DEMO-2026-01';
    const plan={ id:`plan-${run.id}`, revision:1, goal:`回收 ${experimentId} 的核心实验指标并给出阶段性建议`, projectId:run.projectId, initiativeId:run.initiativeId, status:'completed', goalCompleted:true, createdAt:now, updatedAt:now, completionChecklist:[{ id:'resolve-experiment', description:'确认实验 ID、周期、版本和查询窗口', status:'completed', note:'已读取模拟实验元数据。' },{ id:'resolve-metrics', description:'解析已确认指标的可查询 ID', status:'completed', note:'已解析 3 个模拟指标 ID。' },{ id:'query-data', description:'按版本查询实验数据并检查回收条件', status:'completed', note:'已完成模拟查询和回收检查。' }], obligations:[{ id:'demo-disclosure', kind:'disclosure', status:'fulfilled', instruction:'明确披露模拟数据和次日留存尚未显著。', evidence:'最终回复已披露。' }], missingActions:[], nextAction:'等待用户确认是否按建议继续观察 3 天。' };
    state.agentPlans ||= []; state.agentPlans.unshift(plan); state.agentPlans=state.agentPlans.slice(0,100);
    run.planId=plan.id; run.planRef={ planId:plan.id, revision:1 }; run.goalStatus='completed';
    const initialContext=buildProjectContext(state, project, run.initiativeId, command, { runId:run.id, planRef:null, plan:null, conversation, toolResults:[], lastLoopToolResults:[], executionHandoff:null, executionHandoffCoveredToolCallIds:[], discoveredSkills:[], artifacts:[], selectedArtifacts:[], loop:1 });
    const initialAssistant='我将先读取实验元数据以确认周期、版本和查询窗口；随后解析已确认指标的 ID，再按版本查询数据并进行回收检查。';
    const snapshot1=recordDemoSnapshot(1, 'initial', initialContext, initialAssistant, [{ name:'read_experiment_metadata', arguments:{ experimentId } }]);
    run.steps[0].status='completed'; run.steps[0].output={ snapshotId:snapshot1.id, mode:'demo_sanitized_trace', context:initialContext, currentCommand:command };
    run.steps[1].status='completed'; run.steps[1].input={ snapshotId:snapshot1.id, systemPromptChars:snapshot1.charCounts.systemPrompt, userPromptChars:snapshot1.charCounts.userPrompt }; run.steps[1].output={ snapshotId:snapshot1.id, assistantText:initialAssistant, model:'demo-agent', requestId:snapshot1.requestId, usage:snapshot1.usage, toolCalls:snapshot1.toolCalls };
    const metadata={ experimentId, name:'新手引导分层实验', status:'running', owner:'王晓', startedAt:'2026-09-06', plannedEndAt:'2026-09-20', queryWindow:{ startDate:'2026-09-06', endDate:'2026-09-13', timezone:'Asia/Shanghai' }, baseVersion:{ id:'v-control-001', name:'对照组 · 标准三步引导', traffic:'50%' }, experimentVersions:[{ id:'v-treatment-002', name:'实验组 · 分层两步引导', traffic:'50%' }], sampleSize:{ control:120486, treatment:120193 } };
    addDemoTool('read_experiment_metadata', `实验元数据：${experimentId}`, { experimentId }, metadata, '已确认实验周期、版本边界、流量分配和可查询的自然日窗口。');
    const metricGroups=[{ name:'activation_funnel', label:'激活漏斗', metrics:[{ id:'metric-activation-completion', name:'激活完成率', definition:'完成关键动作用户 / 进入引导用户' },{ id:'metric-guide-exit', name:'引导中途退出率', definition:'未完成关键动作即离开引导用户 / 进入引导用户' }] },{ name:'retention', label:'留存', metrics:[{ id:'metric-d1-retention', name:'次日留存', definition:'次日有活跃行为用户 / 首日进入实验用户' }] }];
    addDemoTool('resolve_metric_specs', `指标规格：${experimentId}`, { experimentId, metricGroups:[{ name:'activation_funnel', metrics:['激活完成率','引导中途退出率'] },{ name:'retention', metrics:['次日留存'] }] }, { experimentId, metricGroups }, '已根据演示指标口径解析到 3 个可查询指标 ID。');
    const loop2Context=buildProjectContext(state, project, run.initiativeId, command, { runId:run.id, planRef:run.planRef, plan, conversation, toolResults:demoToolResults, lastLoopToolResults:demoToolResults, executionHandoff:null, executionHandoffCoveredToolCallIds:[], discoveredSkills:[], artifacts:[], selectedArtifacts:[], loop:2 });
    const loop2Assistant='实验周期和两组版本已确认，三个目标指标均已解析到可查询 ID。下一步按确认的版本边界和自然日窗口查询指标数据。';
    const snapshot2=recordDemoSnapshot(2, 'after_tool', loop2Context, loop2Assistant, [{ name:'query_metric_data', arguments:{ experimentId, experimentVersionIds:['v-control-001','v-treatment-002'], metricGroups:[{ name:'activation_funnel', metrics:['metric-activation-completion','metric-guide-exit'] },{ name:'retention', metrics:['metric-d1-retention'] }], freshnessPolicy:{ requireLatestAvailableDay:true, timezone:'Asia/Shanghai' } } },{ name:'check_experiment_recycle', arguments:{ experimentId } }]);
    run.steps.push({ name:'agent_loop_2', type:'llm', label:'调用 AI 模型（Loop 2：根据元数据继续）', status:'completed', input:buildAgentLoopAuditInput({ snapshotId:snapshot2.id, lastLoopToolResults:demoToolResults, allToolResults:demoToolResults, planRef:run.planRef }), output:{ snapshotId:snapshot2.id, assistantText:loop2Assistant, model:'demo-agent', requestId:snapshot2.requestId, usage:snapshot2.usage, toolCalls:snapshot2.toolCalls } });
    const metricResults=[{ metricId:'metric-activation-completion', name:'激活完成率', control:{ value:0.3842, display:'38.42%', users:46290 }, treatment:{ value:0.4116, display:'41.16%', users:49478 }, delta:{ absolute:0.0274, display:'+2.74pp' }, statistics:{ pValue:0.018, confidenceLevel:0.95, significant:true } },{ metricId:'metric-guide-exit', name:'引导中途退出率', control:{ value:0.2175, display:'21.75%' }, treatment:{ value:0.1938, display:'19.38%' }, delta:{ absolute:-0.0237, display:'-2.37pp' }, statistics:{ pValue:0.031, confidenceLevel:0.95, significant:true } },{ metricId:'metric-d1-retention', name:'次日留存', control:{ value:0.2608, display:'26.08%' }, treatment:{ value:0.2661, display:'26.61%' }, delta:{ absolute:0.0053, display:'+0.53pp' }, statistics:{ pValue:0.164, confidenceLevel:0.95, significant:false } }];
    addDemoTool('query_metric_data', `实验数据：${experimentId}`, { experimentId, experimentVersionIds:['v-control-001','v-treatment-002'], metricGroups:[{ name:'activation_funnel', metrics:['metric-activation-completion','metric-guide-exit'] },{ name:'retention', metrics:['metric-d1-retention'] }], freshnessPolicy:{ requireLatestAvailableDay:true, timezone:'Asia/Shanghai' } }, { experimentId, dataLatestDate:'2026-09-13', isLatest:true, sampleSize:metadata.sampleSize, metricResults }, '已返回 2026-09-06 至 2026-09-13 的按实验版本对比数据。');
    addDemoTool('check_experiment_recycle', `实验回收检查：${experimentId}`, { experimentId }, { experimentId, eligible:true, checks:[{ name:'实验运行时长', status:'passed', detail:'已运行 8 个自然日，达到最小观察期。' },{ name:'样本量', status:'passed', detail:'两组样本均超过 12 万。' },{ name:'长期指标', status:'watch', detail:'次日留存方向为正，但尚未显著。' }] }, '回收前置检查已完成：可产出阶段性结论，但应披露次日留存尚未显著。');
    const report = { id:`demo-report-${Date.now()}`, projectId:run.projectId, initiativeId:run.initiativeId, experimentId:'EXP-DEMO-2026-01', title:'EXP-DEMO-2026-01 · 核心指标回收', status:'completed', createdAt:now, dataLatestDate:'2026-09-13', isLatest:true,
      metricResults:[{ name:'激活完成率', control:'38.42%', treatment:'41.16%', delta:'+2.74pp', significance:'显著（p=0.018）' },{ name:'次日留存', control:'26.08%', treatment:'26.61%', delta:'+0.53pp', significance:'暂不显著（p=0.164）' }],
      note:'演示数据：激活完成率显著提升，次日留存方向为正但尚未显著。建议继续观察 3 天后再决定全量扩展。' };
    state.dataRecoveryReports ||= []; state.dataRecoveryReports.unshift(report);
    state.knowledgeItems ||= []; state.knowledgeItems.unshift({ id:`demo-knowledge-report-${Date.now()}`, projectId:run.projectId, initiativeId:run.initiativeId, type:'实验与数据', title:report.title, summary:report.note, content:report.metricResults.map((item) => `${item.name}：对照 ${item.control}，实验 ${item.treatment}，变化 ${item.delta}，${item.significance}`).join('\n'), sourceType:'agent_written', createdAt:now.slice(0,10), updatedAt:now });
    text = `已完成 EXP-DEMO-2026-01 的完整演示回收链路（数据截止 ${report.dataLatestDate}）。\n\n1. 已查询实验 ID 并读取元数据：实验周期为 2026-09-06 至 2026-09-20，本次查询窗口为 09-06 至 09-13；对照/实验组各 50%。\n2. 已解析 3 个指标 ID：激活完成率、引导中途退出率、次日留存。\n3. 已按版本回收实验数据，并完成可回收性检查。\n\n**结果**\n- 激活完成率：38.42% → 41.16%，提升 2.74pp，统计显著（p=0.018）。\n- 引导中途退出率：21.75% → 19.38%，下降 2.37pp，统计显著。\n- 次日留存：26.08% → 26.61%，提升 0.53pp，方向为正但暂不显著（p=0.164）。\n\n**建议**：保持当前流量继续观察 3 天；若次日留存仍为正且置信区间收敛，再扩大至 50% 流量。完整 Tool Result 已写入“AI 执行日志”，汇总结论已写入项目知识库。\n\n_以上均为模拟工具调用和模拟数据，未访问 Libra 或任何真实实验。_`;
    const loop3Context=buildProjectContext(state, project, run.initiativeId, command, { runId:run.id, planRef:run.planRef, plan, conversation, toolResults:demoToolResults, lastLoopToolResults:demoToolResults.slice(-2), executionHandoff:null, executionHandoffCoveredToolCallIds:[], discoveredSkills:[], artifacts:[], selectedArtifacts:[], loop:3 });
    const snapshot3=recordDemoSnapshot(3, 'after_tool', loop3Context, text, []);
    run.steps.push({ name:'agent_loop_3', type:'llm', label:'调用 AI 模型（Loop 3：对账并输出结论）', status:'completed', input:buildAgentLoopAuditInput({ snapshotId:snapshot3.id, lastLoopToolResults:demoToolResults.slice(-2), allToolResults:demoToolResults, planRef:run.planRef, forceFinalResponse:false }), output:{ snapshotId:snapshot3.id, assistantText:text, model:'demo-agent', requestId:snapshot3.requestId, usage:snapshot3.usage, toolCalls:[] } });
    run.loop={ maxSteps:30, usedSteps:3, limitReached:false, finalResponseForced:false, retryLimit:2, blockedCalls:[] };
  } else if (/(文档|方案|评审|写一篇|整理)/i.test(normalized)) {
    outcome = '评审文档创建';
    const id = `demo-doc-${Date.now()}`;
    const doc = { id, title:`新手引导分层实验评审稿 · ${now.slice(0,10)}`, createdAt:now, content:`# 新手引导分层实验评审稿\n\n## 背景\n当前实验验证分层引导能提升用户激活。\n\n## 结论\n激活完成率提升 2.74pp；次日留存仍需继续观察。\n\n## 建议\n维持当前流量 3 天，达到样本量门槛后再决定扩量。\n\n## 风险\n避免仅按点击率做扩量决策。` };
    state.demoDocuments ||= []; state.demoDocuments.unshift(doc);
    const url = `${origin}/demo/docs/${encodeURIComponent(id)}`;
    text = `已根据项目方案、指标口径和当前实验状态生成评审文档。\n\n[打开《${doc.title}》](${url})\n\n文档包含背景、当前结论、扩量建议与风险项；这是可预览的模拟文档，未写入真实飞书。`;
  } else {
    const action = initiative?.nextAction || project?.nextAction || '补充下一步动作';
    text = `我已基于当前项目的演示上下文完成梳理。\n\n**已知事实**：实验运行 8 天，激活完成率是主验证指标；次日留存尚在观察。\n\n**当前风险**：若样本量不足时提前扩量，可能把短期点击改善误判为长期留存改善。\n\n**建议动作**：${action}。建议在结果出来前安排一次 30 分钟评审，确认扩量门槛和回滚条件。\n\n_这是 Demo Agent 的模拟回复，不会调用真实模型或外部系统。_`;
  }
  if (!run.steps[0].output?.snapshotId) { run.steps[0].status='completed'; run.steps[0].output={ mode:'demo', currentCommand:command }; }
  if (!run.steps[1].output?.snapshotId) { run.steps[1].status='completed'; run.steps[1].output={ mode:'demo', assistantText:text, outcome }; }
  return { text, model:'demo-agent', requestId:`demo-${run.id}`, demoToolResults, structured:{ facts:[], assessments:[], actions:[], confirmations:[], proposals:[], fallbackText:text } };
}

function extractOutputText(payload) {
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) return content.map((part) => typeof part?.text === 'string' ? part.text : '').filter(Boolean).join('\n').trim();
  return '';
}

function extractProviderToolCalls(payload) {
  const calls = payload?.choices?.[0]?.message?.tool_calls;
  if (!Array.isArray(calls)) return [];
  return calls.map((call) => {
    let args = {};
    try { args = JSON.parse(call?.function?.arguments || '{}'); } catch {}
    return { name:call?.function?.name || '', arguments:args };
  }).filter((call) => call.name);
}

function agentStoppedError() { const error=new Error('AI 助手已停止。'); error.code='AGENT_STOPPED'; error.statusCode=499; return error; }
function assertAgentActive(signal) { if (signal?.aborted) throw agentStoppedError(); }

function normalizeModelRequestMockModels(payload) {
  const providerModels = Array.isArray(payload?.data) ? payload.data : [];
  const known = new Map();
  for (const item of providerModels) {
    const id = String(item?.id || '').trim();
    if (!id) continue;
    const inputModalities = Array.isArray(item?.architecture?.input_modalities) ? item.architecture.input_modalities : [];
    known.set(id, {
      id,
      label:String(item?.name || id).trim() || id,
      supportsVision:inputModalities.includes('image'),
      contextLength:Number(item?.context_length || 0) || null,
      source:'provider',
    });
  }
  // Retain a small offline fallback only for a temporary catalog outage. It is
  // not a user-maintained allowlist: normal operation uses the full provider
  // directory above.
  if (!known.size) for (const model of CHAT_MODEL_CATALOG) known.set(model.id, { ...model, source:'fallback' });
  return [...known.values()].sort((a, b) => a.label.localeCompare(b.label));
}

async function fetchModelRequestMockModels({ fetchImpl = fetch, now = Date.now() } = {}) {
  if (modelCatalogCache.expiresAt > now && modelCatalogCache.models.length) return { models:modelCatalogCache.models, source:'cache' };
  const fallback = normalizeModelRequestMockModels(null);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(MODEL_REQUEST_TIMEOUT_MS, 15_000));
  try {
    const response = await fetchImpl(`${OPENROUTER_BASE_URL.replace(/\/$/,'')}/models?output_modalities=text&sort=most-popular`, {
      headers:{ ...(OPENROUTER_API_KEY ? { Authorization:`Bearer ${OPENROUTER_API_KEY}` } : {}), 'Content-Type':'application/json' }, signal:controller.signal,
    });
    const payload = await response.json().catch(() => ({}));
    const models = response.ok ? normalizeModelRequestMockModels(payload) : fallback;
    modelCatalogCache = { expiresAt:now + MODEL_CATALOG_CACHE_TTL_MS, models };
    return { models, source:response.ok ? 'provider' : 'fallback' };
  } catch {
    return { models:fallback, source:'fallback' };
  } finally {
    clearTimeout(timer);
  }
}

function normalizeModelRequestTools(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 64) throw Object.assign(new Error('tools must be an array with at most 64 entries.'), { statusCode:422 });
  const encoded = JSON.stringify(value);
  if (encoded.length > 64_000) throw Object.assign(new Error('tools JSON must not exceed 64000 characters.'), { statusCode:422 });
  return value.map((tool) => {
    const name = String(tool?.function?.name || '').trim();
    if (tool?.type !== 'function' || !/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(name)) throw Object.assign(new Error('each tool must be an OpenAI-compatible function tool with a valid name.'), { statusCode:422 });
    const parameters = tool?.function?.parameters;
    if (parameters !== undefined && (!parameters || typeof parameters !== 'object' || Array.isArray(parameters))) throw Object.assign(new Error(`tool ${name} parameters must be a JSON Schema object.`), { statusCode:422 });
    return { type:'function', function:{ name, ...(typeof tool.function.description === 'string' ? { description:tool.function.description.slice(0, 4000) } : {}), ...(parameters === undefined ? {} : { parameters }) } };
  });
}

function extractModelRequestToolCalls(payload) {
  const calls = payload?.choices?.[0]?.message?.tool_calls;
  if (!Array.isArray(calls)) return [];
  return calls.map((call) => {
    const rawArguments = String(call?.function?.arguments || '{}');
    let argumentsValue = rawArguments;
    try { argumentsValue = JSON.parse(rawArguments); } catch {}
    return { id:String(call?.id || ''), name:String(call?.function?.name || ''), arguments:argumentsValue };
  }).filter((call) => call.name);
}

function modelRequestToolCatalog() {
  return AGENT_TOOLS.map((tool) => ({
    name:tool.function.name,
    description:String(tool.function.description || ''),
    defaultSelected:true,
    availability:'unrestricted',
  }));
}

function selectModelRequestTools(selectedToolNames) {
  if (selectedToolNames === undefined) return AGENT_TOOLS;
  if (!Array.isArray(selectedToolNames)) throw Object.assign(new Error('selectedToolNames must be an array.'), { statusCode:422 });
  const requested = new Set(selectedToolNames.map(String));
  const available = new Set(AGENT_TOOLS.map((tool) => tool.function.name));
  if (requested.size !== selectedToolNames.length || [...requested].some((name) => !available.has(name))) throw Object.assign(new Error('selectedToolNames contains an unknown or duplicate server tool.'), { statusCode:422 });
  return AGENT_TOOLS.filter((tool) => requested.has(tool.function.name));
}

function buildModelRequestMock(payload = {}) {
  const model = String(payload.model || '').trim();
  const systemPrompt = String(payload.systemPrompt || '').trim();
  const userPrompt = String(payload.userPrompt || '').trim();
  const temperature = payload.temperature === undefined || payload.temperature === null ? 0.2 : Number(payload.temperature);
  const topP = payload.topP === undefined || payload.topP === null ? 1 : Number(payload.topP);
  const maxTokens = payload.maxTokens === undefined || payload.maxTokens === null ? 1024 : Number(payload.maxTokens);
  const seed = payload.seed === undefined || payload.seed === null || payload.seed === '' ? undefined : Number(payload.seed);
  const tools = normalizeModelRequestTools(payload.tools === undefined ? AGENT_TOOLS : payload.tools);
  if (!model) throw Object.assign(new Error('model is required.'), { statusCode:422 });
  if (!userPrompt) throw Object.assign(new Error('userPrompt is required.'), { statusCode:422 });
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) throw Object.assign(new Error('temperature must be between 0 and 2.'), { statusCode:422 });
  if (!Number.isFinite(topP) || topP < 0 || topP > 1) throw Object.assign(new Error('topP must be between 0 and 1.'), { statusCode:422 });
  if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 16_384) throw Object.assign(new Error('maxTokens must be an integer between 1 and 16384.'), { statusCode:422 });
  if (seed !== undefined && (!Number.isInteger(seed) || seed < 0 || seed > 2_147_483_647)) throw Object.assign(new Error('seed must be an integer between 0 and 0.'), { statusCode:422 });
  return {
    model,
    messages:[...(systemPrompt ? [{ role:'system', content:systemPrompt }] : []), { role:'user', content:userPrompt }],
    temperature,
    top_p:topP,
    max_tokens:maxTokens,
    ...(seed === undefined ? {} : { seed }),
    ...(tools.length ? { tools, tool_choice:'auto' } : {}),
    stream:false,
  };
}

function automationPlanningInstructions() {
  return [
    '你是自动化规则识别助手。只识别规则，不查询工具、不调用工具、不执行任务。',
    '把用户自然语言转换为严格 JSON，不输出 Markdown。',
    'JSON 字段只有：title, summary, trigger, match, task。',
    'trigger.type 只能是 event、daily、weekly、due_today；daily/weekly/due_today 必须提供 HH:MM 的 time；weekly 还要提供 weekdays（0=周日，1=周一）。event 可提供 events。',
    'match 字段可包含 targetKinds、actionIncludesAny、progressIncludesAny、requireLinkedUrl、dueToday、includeArchived、includeCompleted。',
    'task 必须是一段具体、面向命中目标的自然语言任务。不要写工具名、CLI 命令、参数、步骤或固定入参；真正执行时由普通 Agent 根据 Provider tools 的详细 Schema 自主选择工具和参数。',
  ].join('\n');
}

async function planAutomationRule({ state, description, model, fetchImpl = fetch }) {
  const run = createAgentRun({ projectId:'', initiativeId:'', message:description });
  run.type = 'automation_planning';
  run.requestedModel = model.id;
  run.steps = [{ name:'automation_rule_context', type:'context', label:'构建自动化规则识别 Context', status:'completed', input:{ description }, output:{ fields:['trigger','match','task'] } }, { name:'automation_rule_model', type:'llm', label:'调用 AI 识别自动化规则', status:'running', input:{ model:model.id }, output:{} }];
  state.agentRuns ||= [];
  state.agentRuns.unshift(run);
  state.agentRuns = state.agentRuns.slice(0, 100);
  if (!OPENROUTER_API_KEY) throw Object.assign(new Error('OPENROUTER_API_KEY is not configured on the backend.'), { statusCode:503, automationRun:run });
  const projectFacts = actionTargets(state).map((target) => ({ kind:target.kind, projectId:target.projectId, targetId:target.targetId, name:target.item.name, progress:progressLabel(target.item.progress), nextAction:target.item.nextAction || '', nextActionDdl:target.item.nextActionDdl || '', plannedEnd:target.item.plannedEnd || '', linkedUrls:(target.item.knowledgeLinks || []).map((link) => link?.url).filter(Boolean) })).slice(0, 100);
  const systemPrompt = automationPlanningInstructions();
  const userPrompt = JSON.stringify({ currentDate:automationLocalDateKey(), naturalLanguageRule:description, currentTargets:projectFacts }, null, 2);
  const snapshot = recordPromptSnapshot(run, { loop:1, phase:'automation_planning', debug:{ context:userPrompt, systemPrompt, userPrompt, assistantPrompt:'' }, answer:{ model:model.id, requestId:'', usage:null, text:'' } });
  const modelStep = run.steps.find((step) => step.name === 'automation_rule_model');
  if (modelStep) modelStep.input = { model:model.id, snapshotId:snapshot.id, toolChoice:'none' };
  let response;
  try {
    response = await fetchOpenRouterChat({ model:model.id, messages:[{ role:'system', content:systemPrompt }, { role:'user', content:userPrompt }], tool_choice:'none', temperature:0.1, max_tokens:1800, stream:false }, { fetchImpl });
  } catch (error) {
    if (modelStep) { modelStep.status='failed'; modelStep.error=publicErrorMessage(error); modelStep.output={ snapshotId:snapshot.id }; }
    throw Object.assign(error, { automationRun:run });
  }
  const { response: upstream, payload } = response;
  if (!upstream.ok) {
    const error = Object.assign(new Error(payload?.error?.message || '自动化规则识别模型调用失败。'), { statusCode:upstream.status, automationRun:run });
    if (modelStep) { modelStep.status='failed'; modelStep.error=publicErrorMessage(error); modelStep.output={ snapshotId:snapshot.id }; }
    throw error;
  }
  const text = extractOutputText(payload);
  const parsed = parseModelJson(text);
  run.model = payload?.model || model.id;
  run.requestId = upstream.headers.get('x-request-id') || payload?.id || '';
  run.modelUsage = normalizeModelUsage(payload?.usage);
  snapshot.model=run.model; snapshot.requestId=run.requestId; snapshot.usage=run.modelUsage; snapshot.assistantText=text; snapshot.charCounts.assistantText=text.length;
  if (modelStep) { modelStep.status=parsed?'completed':'failed'; modelStep.output={ snapshotId:snapshot.id, assistantText:text, model:run.model, requestId:run.requestId, usage:run.modelUsage }; if (!parsed) modelStep.error='模型未返回可解析的自动化规则 JSON。'; }
  if (!parsed) throw Object.assign(new Error('AI 未返回可解析的自动化规则 JSON。'), { statusCode:422, automationRun:run });
  const plan = normalizeAutomationPlan(parsed);
  const validation = validateAutomationPlan(plan);
  finishAgentRun(run, validation.feasible ? { answer:{ text:`已识别自动化规则：${plan.title}`, model:run.model, requestId:run.requestId, usage:run.modelUsage } } : { error:Object.assign(new Error(validation.errors.join('；')), { statusCode:422 }) });
  run.goalStatus = validation.feasible ? 'completed' : 'invalid';
  return { run, plan, ...validation };
}

const AUTOMATION_EXECUTIONS = new Set();
let automationEvaluationQueue = Promise.resolve();

function findAutomationTarget(state, task) {
  return actionTargets(state).find((target) => target.kind === task.targetKind && target.targetId === task.targetId) || null;
}

function assertAutomationCallsAuthorized(state, run, calls) {
  if (run?.type !== 'automation_execution') return;
  const task = state?.automationTasks?.find((item) => item.id === run.automationTaskId);
  const planRecord = state?.automationPlans?.find((item) => item.id === task?.automationPlanId);
  if (!task || !planRecord?.feasible) throw Object.assign(new Error('自动化执行缺少已确认的自动化规则。'), { statusCode:422, code:'AUTOMATION_PLAN_MISSING' });
  // The simplified rule intentionally authorizes a normal Agent task. Tool
  // selection and parameter construction happen from real Provider tools at
  // execution time, not in the rule-recognition pass.
}

async function launchAutomationTask(taskId) {
  if (AUTOMATION_EXECUTIONS.has(taskId)) return;
  AUTOMATION_EXECUTIONS.add(taskId);
  try {
    let document = await readStoredState();
    let state = document?.state;
    normalizeAutomationState(state);
    let task = state?.automationTasks?.find((item) => item.id === taskId);
    const rule = state?.automationRules?.find((item) => item.id === task?.ruleId);
    const planRecord = state?.automationPlans?.find((item) => item.id === task?.automationPlanId);
    const target = task ? findAutomationTarget(state, task) : null;
    if (!task || !rule || !planRecord || !target) return;
    normalizeConversationThreads(state);
    const scope = conversationScope(target.projectId, target.kind === 'initiative' ? target.targetId : '');
    const automationConversation = normalizeConversationThread({
      id:`conversation-automation-${task.id}`,
      scope,
      projectId:target.projectId,
      initiativeId:target.kind === 'initiative' ? target.targetId : '',
      title:`自动化 · ${rule.title}`,
      memory:[],
      createdAt:new Date().toISOString(),
      updatedAt:new Date().toISOString(),
    }, state);
    if (!state.conversations.some((item) => item.id === automationConversation.id)) state.conversations.unshift(automationConversation);
    task.conversationId = automationConversation.id;
    task.status = 'running'; task.startedAt = new Date().toISOString();
    const prompt = buildAutomationUserInput({ rule, plan:planRecord.plan, task, target });
    task.syntheticUserInput = prompt;
    await writeStoredState(state);
    const address = server.address();
    if (!address) throw new Error('自动化执行服务尚未启动。');
    const host = typeof address === 'object' && address.address && !['::','0.0.0.0'].includes(address.address) ? address.address : HOST;
    const port = typeof address === 'object' ? address.port : PORT;
    const runId = `run-client-auto-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    task.runId = runId;
    await writeStoredState(state);
    const response = await fetch(`http://${host}:${port}/api/ai/chat`, { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ runId, conversationId:automationConversation.id, message:prompt, model:rule.modelId, runType:'automation_execution', automationTaskId:task.id }) });
    const payload = await response.json().catch(() => ({}));
    document = await readStoredState(); state = document?.state; normalizeAutomationState(state);
    task = state?.automationTasks?.find((item) => item.id === taskId);
    if (!task) return;
    task.completedAt = new Date().toISOString();
    task.runId = payload?.run?.id || runId;
    task.resultText = String(payload?.text || payload?.error || '自动化任务未返回结果。');
    task.status = response.ok ? (payload?.run?.goalStatus === 'needs_action' ? 'partial' : 'completed') : 'failed';
    task.error = response.ok ? '' : String(payload?.error || `自动化 Agent 请求失败（${response.status}）`);
    await writeStoredState(state);
  } catch (error) {
    const document = await readStoredState(); const state = document?.state; normalizeAutomationState(state);
    const task = state?.automationTasks?.find((item) => item.id === taskId);
    if (task) { task.status='failed'; task.error=publicErrorMessage(error); task.resultText=task.error; task.completedAt=new Date().toISOString(); await writeStoredState(state); }
  } finally {
    AUTOMATION_EXECUTIONS.delete(taskId);
  }
}

async function evaluateAutomationRules(reason = 'state_changed', now = new Date()) {
  automationEvaluationQueue = automationEvaluationQueue.then(async () => {
    const document = await readStoredState();
    const state = document?.state;
    if (!state) return [];
    normalizeAutomationState(state);
    const created = [];
    for (const rule of state.automationRules.filter((item) => item.enabled)) {
      const planRecord = state.automationPlans.find((item) => item.id === rule.automationPlanId && item.feasible);
      if (!planRecord || !triggerReady(planRecord.plan, now, reason)) continue;
      const cycle = triggerCycle(planRecord.plan, now, reason);
      for (const target of actionTargets(state).filter((item) => targetMatches(planRecord.plan, item, automationLocalDateKey(now)))) {
        const idempotencyKey = automationTaskKey(rule, target, cycle);
        if (state.automationTasks.some((task) => task.idempotencyKey === idempotencyKey)) continue;
        const task = { id:`automation-task-${Date.now()}-${Math.random().toString(16).slice(2)}`, idempotencyKey, ruleId:rule.id, ruleVersion:rule.version, automationPlanId:planRecord.id, projectId:target.projectId, targetKind:target.kind, targetId:target.targetId, dueDate:String(target.item.nextActionDdl || '').slice(0,10), triggerReason:reason, triggerCycle:cycle, status:'pending', runId:'', resultText:'', error:'', readDates:[], createdAt:new Date().toISOString(), startedAt:'', completedAt:'' };
        state.automationTasks.unshift(task); created.push(task.id);
      }
    }
    state.automationTasks = state.automationTasks.slice(0, 200);
    if (created.length) await writeStoredState(state);
    for (const taskId of created) setImmediate(() => void launchAutomationTask(taskId));
    return created;
  }).catch((error) => { console.error('Automation evaluation failed:', error); return []; });
  return automationEvaluationQueue;
}

function readJsonWithSignal(response, signal) {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason || new Error('模型响应读取已取消。'));
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once:true });
    Promise.resolve(response.json()).then(
      (payload) => { signal.removeEventListener('abort', onAbort); resolve(payload); },
      (error) => { signal.removeEventListener('abort', onAbort); reject(error); },
    );
  });
}

async function fetchOpenRouterChatOnce(body, { signal, debug, fetchImpl = fetch, timeoutMs = MODEL_REQUEST_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  let timedOut = false;
  const onParentAbort = () => controller.abort(signal?.reason || agentStoppedError());
  if (signal?.aborted) onParentAbort();
  else signal?.addEventListener('abort', onParentAbort, { once:true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const response = await fetchImpl(`${OPENROUTER_BASE_URL.replace(/\/$/,'')}/chat/completions`, {
      method:'POST',
      headers:{ Authorization:`Bearer ${OPENROUTER_API_KEY}`, 'Content-Type':'application/json' },
      body:JSON.stringify(body),
      signal:controller.signal,
    });
    let payload = {};
    try {
      payload = await readJsonWithSignal(response, controller.signal);
    } catch (error) {
      if (controller.signal.aborted) throw error;
    }
    return { response, payload };
  } catch (error) {
    if (signal?.aborted) throw agentStoppedError();
    if (timedOut) throw Object.assign(new Error(`模型请求超时（${Math.round(timeoutMs / 1000)} 秒）。请稍后重试。`), { code:'MODEL_REQUEST_TIMEOUT', statusCode:504, retryable:true, debug });
    throw Object.assign(new Error(`模型请求连接失败：${error?.message || '未知网络错误'}`), { code:'MODEL_REQUEST_NETWORK_ERROR', statusCode:502, retryable:true, debug });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onParentAbort);
  }
}

async function fetchOpenRouterChat(body, options = {}) {
  let lastError;
  for (let attempt = 1; attempt <= RETRYABLE_OPERATION_RETRIES + 1; attempt += 1) {
    try {
      return await fetchOpenRouterChatOnce(body, options);
    } catch (error) {
      lastError = error;
      if (options.signal?.aborted || !error?.retryable || attempt > RETRYABLE_OPERATION_RETRIES) {
        error.attempts = attempt;
        error.retryLimit = RETRYABLE_OPERATION_RETRIES;
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, RETRYABLE_OPERATION_RETRY_DELAY_MS * attempt));
    }
  }
  throw lastError;
}

function agentInstructions() {
  return [
    '你是项目推进助手。只使用 Context 中的事实，currentCommand 优先级最高。',
    'Context 分为 core、currentTask、executionState、reference 四部分。core 的 userRequest 和 taskGoal 说明本轮目标，并给出当前项目/事项的 ID 和名称；currentTask 的 intent 是当前可执行子任务，latestLoopToolResults 是刚完成的一轮完整安全证据；executionState 中的 plan 是唯一执行状态机，executionHandoff 是已归纳的历史事实，pendingToolResults 是尚未归纳但仍有效的历史工具证据。reference 仅有 recentConversation，代表对话现场的最近原始消息。Conversation Summary、longTermMemory 与 knowledge 默认不注入；需要更早对话交接、规则、口径、固定格式或历史资料时，按需调用对应工具查询。检索结果与当前对话冲突时，以更靠近当前对话时间的事实为准。',
    '优先使用 executionHandoff、pendingToolResults 与 latestLoopToolResults 中的真实参数、ID、日期和失败边界，不重复执行已满足前置条件的读取。工具参数和前置条件以对应 Result 为准。多步骤任务先创建 Plan；Plan 存在后，根据新工具事实更新 checklist、obligation 和 nextAction。若已有事实足以继续执行，创建或更新 Plan 必须与不依赖该回执的后续工具调用放在同一条 assistant message 中；不要单独用一轮只创建或更新 Plan，再用下一轮重新读取已经具备的事实。',
    'tool返回结果中status=partial 可继续推进但必须向用户解释原因；对 retryable 的临时工具失败可使用同一套参数重试，最多重试 2 次；达到重试上限且被标记 skipped 时，不得再调用同一工具和参数，应跳过该项并继续其他未受影响的事项。blocked、needs_input、conflict、retry_limit_reached 才阻断对应事项。当前版本暂不提供历史 Agent 查询工具；不得从未进入 Context 的旧对话、旧 Run 或旧 Plan 猜测事实或复用对象。',
    '终结时，所有执行 checklist 都已 completed，且所有 obligation 已 fulfilled 或 waived 后，调用 update_execution_plan(goalCompleted=true)。工具结果为 partial 但工作本身已完成时，应把 checklist 记为 completed、在 note 中保留限制，并结清必要 disclosure。该调用的 userFacingReply 必须非空、可直接交付，包含真实结果、链接（如有）、必要披露与下一步。没有 Plan 时仍直接用正文回复用户。',
    '知识库与 Memory 统一遵循会话内容范围：无主题会话可读取全部 global、项目级和事项级内容；项目会话可读取 global、当前项目级及其全部事项级内容；事项会话可读取 global、当前项目级和当前事项级内容。search_project_knowledge 只读项目级知识，search_item_knowledge 只读事项级知识，search_memory 读取同一内容范围内的长期 Memory 和 conversation_summary。需要沉淀用户明确提供或本次真实 Tool Result 验证的项目材料时，调用 write_local_knowledge：项目/事项会话写当前项目，无主题会话必须传明确 projectId，事项会话不得写到其他事项；不得保存模型推测、临时计划或未经验证的外部内容。无主题会话可传 projectId/initiativeId 缩小检索；项目或事项会话不能用参数扩展到其他项目或事项。conversation_summary 不是历史执行或交付完成证据。type=data_recovery_profile 的 data 保留显式指标组等默认值，后续工具必须复制返回值。每轮最终回复前，若 currentCommand 包含用户明确确认、纠正或设定的可跨轮复用长期信息，必须在本轮调用 update_long_term_memory；不得只说“已记住”。scope 必须由你根据语义自主判断；不得记录模型推测、临时计划或未验证结果。',
    '项目设计文档撰写、数据回收等任务可调用Skill，采用文件树两阶段检索：先调用（不传 parentSkillPath）查父 Skill；选定父 Skill 后，携带其 parentSkillPath 再调用同一工具查子 Skill。命中原文仅在当前工具结果和归纳阶段可见；归纳后必须使用 executionHandoff.usableFacts 中保存的完整必要命令、参数来源、约束和输出用法，不能依赖 Skill 原文仍会回输。需要确认 CLI 用法时调用 inspect_cli_help 查询帮助；该查询不会创建或更新 Skill。execute_cli 只执行本次显式 cli 与 argv，不会从 Memory、Profile 或旧 Tool Result 补齐参数；外部写操作会直接执行。',
    '用户提供明确 URL 且要求总结、核实、提意见或补全内容时，先按来源读取真实内容：飞书 Docx/Wiki 用 read_feishu_document，公开 HTTP/HTTPS 网页用 read_web_page；读取失败必须披露，不能假装已读。',
    '自然、直接、简洁地回答用户；不要输出 JSON 或复述全部 Context。',
  ].join('\n');
}

function finalLoopInstruction(maxSteps = MAX_AGENT_LOOP_STEPS) {
  return [
    `系统执行边界：本次已达到最多 ${maxSteps} 轮模型调用。现在必须停止调用任何工具，并直接回复用户。`,
    '终结回复必须基于 currentRun.plan、最近一轮 toolResults 和真实 Tool Result，严格按以下格式输出：',
    '## 本轮已完成\n- 仅列举真实已完成的动作、数据或交付物；若无，写“无”。',
    '## 遗留/阻塞\n- 列出未完成 checklist、失败项、待确认项；若无，则不写。',
    '## 下一步\n- 给出最直接的建议动作。',
    '最后必须单独询问：是否要我继续处理这些遗留项？',
    '不得发起 atomicCalls，不得把未完成 Plan 表述为已完成。',
  ].join('\n');
}

function executionCompactionInstructions() {
  return [
    '你是执行上下文归纳器，不是项目执行者。',
    '把已有 executionHandoff 与待归纳的真实工具执行证据合并为新的结构化 executionHandoff，供后续 Agent Loop 继续执行。输出只能保留 usableFacts。',
    '只使用输入中可验证的事实；不得猜测、补全、修改 Plan、调用工具或回复用户。',
    '必须保留后续执行依赖的精确 CLI/argv 与失败边界、实验和版本 ID、指标组和查询窗口、数据日期与 partial 披露、文档 URL/Block ID/图片锚点、Artifact ID、开放 checklist/obligation/缺失输入。',
    'activeSkills 是归纳时可见、但后续普通 Loop 不会回输的原始使用文档。凡当前 Plan 后续需要的 CLI 命令，必须各自作为 usableFacts 的一项完整保存：key 写清用途，例如“按指标组名称搜索指标组 ID”；value 必须从 cli 命令名开始，写完整命令模板、占位变量如何替换、参数值来源、路径或顺序约束、输出如何继续使用和注意事项。不能只保留 Skill 路径、标题、参数片段或“参考文档”。',
    '新旧证据冲突时以更晚的真实工具结果为准。删除长 stdout、长文档正文、长历史原文、重复 receipt 和已无后续依赖的过程信息。不得把 partial、blocked、needs_input 或 conflict 写成完成。',
    '输出严格 JSON，不能有 Markdown、解释文字或 tool call。',
    'JSON Schema：{"usableFacts":[{"key":"string","value":"any"}]}',
  ].join('\n');
}

function normalizeExecutionHandoff(raw) {
  const parsed = raw && typeof raw === 'object' ? raw : null;
  if (!parsed) return null;
  const usableFacts = Array.isArray(parsed.usableFacts) ? parsed.usableFacts.map((item) => ({ key:String(item?.key || '').trim(), value:sanitizeToolResultForModel(item?.value) })).filter((item) => item.key) : null;
  if (!usableFacts) return null;
  const handoff = { usableFacts };
  return JSON.stringify(handoff).length <= MAX_EXECUTION_HANDOFF_CHARS ? handoff : null;
}

function buildExecutionCompactionInput({ currentCommand, plan, executionHandoff, pendingToolResults, activeSkills = [] }) {
  return {
    currentCommand:String(currentCommand || ''),
    plan:compactContextPlan(plan),
    existingExecutionHandoff:handoffForModel(executionHandoff),
    pendingToolResults:dedupeModelEvidence(pendingToolResults || []),
    activeSkills:(activeSkills || []).map((item) => ({ skillPath:String(item.skillPath || ''), parentSkillPath:String(item.parentSkillPath || ''), title:String(item.title || ''), kind:String(item.kind || ''), content:String(item.content || '') })).filter((item) => item.skillPath && item.content),
  };
}

function recordExecutionCompactionSnapshot(run, { input, systemPrompt, responseText, status, error = '', trigger, loop = 0, step = null }) {
  const snapshot = {
    id:`snapshot-${run.id}-compaction-${Date.now()}`, loop:Number(loop || run?.loop?.usedSteps || 0), phase:'context_compaction', createdAt:new Date().toISOString(),
    model:run.requestedModel || '', requestId:null, context:JSON.stringify(input, null, 2), systemPrompt, userPrompt:JSON.stringify(input, null, 2), assistantText:responseText || '',
    toolCalls:[], charCounts:{ context:JSON.stringify(input).length, systemPrompt:systemPrompt.length, userPrompt:JSON.stringify(input).length, assistantText:String(responseText || '').length },
  };
  run.promptSnapshots ||= [];
  run.promptSnapshots.push(snapshot);
  const record=step || { name:`context_compaction:${snapshot.id}`, type:'context_compaction', label:'归纳执行上下文', status:'running', input:{}, output:{} };
  record.name=`context_compaction:${snapshot.id}`;
  record.status=status;
  record.input={ snapshotId:snapshot.id, trigger, pendingToolCallIds:(input.pendingToolResults || []).flatMap((item) => item.occurrences || []).map((item) => item.toolCallId).filter(Boolean) };
  const startedAt=record.startedAt || snapshot.createdAt;
  record.completedAt=snapshot.createdAt;
  record.durationMs=Math.max(0, Date.parse(record.completedAt) - Date.parse(startedAt));
  record.output=status === 'completed' ? { snapshotId:snapshot.id } : { snapshotId:snapshot.id, error };
  if (!step) run.steps.push(record);
  return snapshot;
}

function fallbackExecutionHandoff(existingHandoff, pendingToolResults) {
  const usableFacts=[...(existingHandoff?.usableFacts || [])];
  for (const result of pendingToolResults || []) {
    const compact=compactToolResultForModel(result);
    const serialized=JSON.stringify(compact);
    usableFacts.push({
      key:`${compact.tool || 'tool_result'} ${String(result?.toolCallId || '').trim()}`.trim(),
      value:serialized.length <= 2_400 ? compact : {
        summary:compact.facts?.summary || compact.next || 'Tool Result 过大，完整内容仅保留在 Run 审计层。',
        tool:compact.tool,
        status:compact.status,
        truncated:true,
        next:'如需正文、完整 stdout 或 Block 细节，请根据当前目标重新调用对应读取工具。',
      },
    });
  }
  return normalizeExecutionHandoff({ usableFacts }) || { usableFacts:[{ key:'execution_handoff_fallback', value:'归纳模型未在时限内返回；完整 Tool Result 保留在 Run 审计层，需要时重新读取明确目标。' }] };
}

async function compactExecutionContext({ run, model, currentCommand, plan, pendingToolResults, activeSkills = [], signal, trigger, loop = 0, fetchImpl = fetch, timeoutMs = CONTEXT_COMPACTION_TIMEOUT_MS, onStarted = null }) {
  const pending = (pendingToolResults || []).filter(Boolean);
  if (!pending.length) return { compacted:false, reason:'no_pending_results' };
  const input = buildExecutionCompactionInput({ currentCommand, plan, executionHandoff:run.executionHandoff, pendingToolResults:pending, activeSkills });
  const systemPrompt = executionCompactionInstructions();
  const step={ name:`context_compaction:pending-${Date.now()}`, type:'context_compaction', label:'归纳执行上下文', status:'running', startedAt:new Date().toISOString(), input:{ trigger, pendingToolCallIds:pending.map((item) => String(item.toolCallId || '')).filter(Boolean), inputChars:JSON.stringify(input).length, timeoutMs }, output:{} };
  run.steps.push(step);
  await onStarted?.(step, input);
  try {
    const { response, payload } = await fetchOpenRouterChat({ model:model.id, temperature:0, messages:[{ role:'system', content:systemPrompt }, { role:'user', content:JSON.stringify(input) }], tool_choice:'none' }, { signal, fetchImpl, timeoutMs });
    if (!response.ok) throw Object.assign(new Error(payload?.error?.message || 'Execution context compaction request failed.'), { statusCode:response.status });
    const responseText = extractOutputText(payload);
    const handoff = normalizeExecutionHandoff(parseModelJson(responseText));
    if (!handoff) throw Object.assign(new Error('执行上下文归纳返回的 usableFacts 结构无效。'), { code:'INVALID_EXECUTION_HANDOFF', statusCode:502 });
    const priorCovered = run.executionHandoffCoveredToolCallIds || run.executionHandoff?.coveredToolCallIds || [];
    run.executionHandoff = handoff;
    run.executionHandoffCoveredToolCallIds = [...new Set([...priorCovered, ...pending.map((item) => String(item.toolCallId || '')).filter(Boolean)])];
    run.executionHandoffFailure = null;
    const snapshot = recordExecutionCompactionSnapshot(run, { input, systemPrompt, responseText, status:'completed', trigger, loop, step });
    return { compacted:true, handoff:run.executionHandoff, snapshotId:snapshot.id };
  } catch (error) {
    const message=publicErrorMessage(error);
    const priorCovered = run.executionHandoffCoveredToolCallIds || run.executionHandoff?.coveredToolCallIds || [];
    run.executionHandoff=fallbackExecutionHandoff(run.executionHandoff, pending);
    run.executionHandoffCoveredToolCallIds=[...new Set([...priorCovered, ...pending.map((item) => String(item.toolCallId || '')).filter(Boolean)])];
    run.executionHandoffFailure = { at:new Date().toISOString(), trigger, error:message, fallback:true };
    const snapshot = recordExecutionCompactionSnapshot(run, { input, systemPrompt, responseText:'', status:'partial', error:message, trigger, loop, step });
    return { compacted:true, fallback:true, error:message, handoff:run.executionHandoff, snapshotId:snapshot.id };
  }
}

function contextCharacterBreakdown(context) {
  const parsed = typeof context === 'string' ? parseModelJson(context) : context || {};
  return {
    core:JSON.stringify(parsed.core || {}).length,
    currentTask:JSON.stringify(parsed.currentTask || {}).length,
    executionState:JSON.stringify(parsed.executionState || {}).length,
    reference:JSON.stringify(parsed.reference || {}).length,
    total:JSON.stringify(parsed).length,
  };
}

function executionCompactionTrigger({ completedToolLoops, lastCompactionLoop = 0, predictedContextChars, pendingToolResultCount }) {
  if (!Number(pendingToolResultCount || 0)) return '';
  if (Number(predictedContextChars || 0) > CONTEXT_NORMAL_CHAR_BUDGET) return 'context_budget';
  if (Number(completedToolLoops || 0) - Number(lastCompactionLoop || 0) >= CONTEXT_COMPACTION_LOOP_INTERVAL) return 'loop_interval';
  return '';
}

async function callAgentModel({ state, projectId, initiativeId, currentCommand, imageAttachments = [], model, taskState, systemPrompt, signal }) {
  assertAgentActive(signal);
  const project=projectId ? findProject(state, projectId) : null; if(projectId && !project) throw Object.assign(new Error('Project not found.'), {statusCode:404});
  const context=project ? buildProjectContext(state, project, initiativeId, currentCommand, taskState) : buildWorkspaceContext(state, currentCommand, taskState);
  const instructions=[systemPrompt || agentInstructions(), taskState?.forceFinalResponse ? finalLoopInstruction() : ''].filter(Boolean).join('\n\n');
  const userPrompt=`Context：\n${context}\n\n当前命令：\n${currentCommand}`;
  const visualInput = imageAttachments.map((attachment) => ({ type:'image_url', image_url:{ url:attachment.dataUrl } }));
  if (visualInput.length && !model.supportsVision) throw Object.assign(new Error(`「${model.label}」不支持图片输入，请切换到支持图片的模型。`), { statusCode:422 });
  const userContent = visualInput.length ? [{ type:'text', text:userPrompt }, ...visualInput] : userPrompt;
  const debug={context,contextBreakdown:contextCharacterBreakdown(context),systemPrompt:instructions,userPrompt:visualInput.length ? `${userPrompt}\n\n[随本次命令上传图片：${imageAttachments.map((item) => item.title).join('、')}]` : userPrompt,assistantPrompt:''};
  if(!OPENROUTER_API_KEY) throw Object.assign(new Error('OPENROUTER_API_KEY is not configured on the backend.'), {statusCode:503,debug});
  const availableTools = taskState?.availableTools || AGENT_TOOLS;
  const { response, payload }=await fetchOpenRouterChat({model:model.id,temperature:0.2,messages:[{role:'system',content:instructions},{role:'user',content:userContent}],tools:availableTools,tool_choice:taskState?.forceFinalResponse ? 'none' : 'auto'}, { signal, debug, timeoutMs:AGENT_MODEL_REQUEST_TIMEOUT_MS });
  if(!response.ok) throw Object.assign(new Error(payload?.error?.message || 'OpenRouter request failed.'), {statusCode:response.status,debug});
  const rawProviderToolCalls=extractProviderToolCalls(payload);
  const providerToolCalls=taskState?.forceFinalResponse ? [] : rawProviderToolCalls;
  const text=extractOutputText(payload); if(!text && !providerToolCalls.length) throw Object.assign(new Error('The model returned no text output.'), {statusCode:502,debug});
  const structured=project ? normalizeAgentAnswer(null,text || '正在准备执行请求…',state,project,initiativeId,providerToolCalls) : { facts:[], assessments:[], actions:[], confirmations:[], proposals:[], memoryCandidates:[], atomicCalls:providerToolCalls.map((item) => ({ name:item.name, args:item.arguments || item.args || {} })), toolResults:[], fallbackText:'' };
  return {text:text || '正在准备执行请求…',structured,requestId:response.headers.get('x-request-id') || null,model:payload?.model || model.id,usage:normalizeModelUsage(payload?.usage),debug:{...debug,assistantPrompt:text || '[模型仅返回工具调用]'},providerToolCalls};
}

function automationExecutionTools() { return AGENT_TOOLS; }
// Conversation scope controls what enters Context, not which registered Agent
// capabilities the provider can consider. A global conversation starts without
// a project target, so the model must discover or obtain the concrete target
// required by a tool's own contract before acting.
function globalConversationTools() { return AGENT_TOOLS; }

async function askOpenRouter({ state, projectId, initiativeId, message, imageAttachments=[], model, run, signal, conversation=null }) { return callAgentModel({state,projectId,initiativeId,currentCommand:message,imageAttachments,model,taskState:{runId:run.id,planRef:run.planRef,plan:null,conversation,toolResults:[],lastLoopToolResults:[],executionHandoff:run.executionHandoff || null,executionHandoffCoveredToolCallIds:run.executionHandoffCoveredToolCallIds || [],discoveredSkills:run.discoveredSkillRefs || [],artifacts:[],selectedArtifacts:run.selectedArtifactRefs || [],loop:1,availableTools:projectId ? automationExecutionTools(state,run) : globalConversationTools()},signal}); }
async function askOpenRouterAfterTool({ state, projectId, initiativeId, originalMessage, imageAttachments=[], model, toolResults, allToolResults, artifacts=[], plan=null, loopStep, run, signal, retryPolicy=null, forceFinalResponse=false, conversation=null }) { return callAgentModel({state,projectId,initiativeId,currentCommand:originalMessage,imageAttachments,model,taskState:{runId:run.id,planRef:run.planRef,plan,conversation,toolResults:allToolResults,lastLoopToolResults:toolResults,executionHandoff:run.executionHandoff || null,executionHandoffCoveredToolCallIds:run.executionHandoffCoveredToolCallIds || [],discoveredSkills:run.discoveredSkillRefs || [],artifacts,selectedArtifacts:run.selectedArtifactRefs || [],loop:loopStep,retryPolicy,forceFinalResponse,availableTools:projectId ? automationExecutionTools(state,run) : globalConversationTools()},signal}); }

function cleanConversationMessage(message) {
  return String(message?.text || '').replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
}

async function summarizeProjectConversation(state, project, initiativeId = '', { force = false } = {}) {
  const store = conversationStore(project, initiativeId);
  if (!store) return null;
  normalizeConversationStore(store);
  const memory = Array.isArray(store.memory) ? store.memory : [];
  const messagesToCompact = force ? memory : memory.slice(0, -MAX_RECENT_CONVERSATION_MESSAGES);
  if (!messagesToCompact.length || !OPENROUTER_API_KEY) return null;
  const existingSummary = String(store.conversationSummary?.summary || '').trim();
  const previouslyCovered = Math.max(0, Number(store.conversationSummary?.coveredMessageCount || 0) || 0);
  const transcript = messagesToCompact.map((item) => `${item.role === 'user' ? '用户' : '助手'}：${cleanConversationMessage(item)}`).join('\n');
  const plan = activeConversationPlan(state, project.id, initiativeId);
  const planHandoff = plan ? JSON.stringify({ goal:plan.goal, completionChecklist:(plan.completionChecklist || []).filter((item) => item.status !== 'completed').map((item) => ({ description:item.description, status:item.status, note:item.note || '' })), missingActions:plan.missingActions || [], nextAction:plan.nextAction || '' }, null, 2) : '';
  const summaryInput = [
    existingSummary ? `已有摘要：\n${existingSummary}` : '',
    transcript ? `本次需要合并的更早对话：\n${transcript}` : '',
    planHandoff ? `当前待续执行计划（只作为交接线索）：\n${planHandoff}` : '',
  ].filter(Boolean).join('\n\n');
  const { response, payload } = await fetchOpenRouterChat({ model:OPENROUTER_MODEL, temperature:0.1, messages:[{ role:'system', content:conversationSummaryInstructions() },{ role:'user', content:summaryInput }] });
  if (!response.ok) throw Object.assign(new Error(payload?.error?.message || 'Conversation summary request failed.'), { statusCode:response.status });
  const summary = extractOutputText(payload);
  if (!summary) return null;
  store.conversationSummary = { summary:summary.slice(0,3000), coveredMessageCount:previouslyCovered + messagesToCompact.length, updatedAt:new Date().toISOString(), source:'model' };
  store.memory = memory.slice(-MAX_RECENT_CONVERSATION_MESSAGES);
  return store.conversationSummary;
}


function activateRecoveryProfile(state, projectId, profileDraft) {
  if (!hasConfirmedMetricProfile(profileDraft)) throw Object.assign(new Error('Data Recovery Profile 缺少用户确认的具体指标。'), { statusCode: 422 });
  const store = memories(state);
  const previous = getActiveRecoveryProfile(state, projectId);
  const now = new Date().toISOString();
  for (const item of store) if (item.scope === 'project' && item.projectId === projectId && item.type === 'data_recovery_profile' && item.status === 'active') item.status = 'superseded';
  const profile = { id:`recovery-profile-${Date.now()}-${Math.random().toString(16).slice(2)}`, ...profileDraft, projectId, status:'active', version:Number(previous?.version || 0)+1, createdAt:now, updatedAt:now };
  const memory = { id:`memory-profile-${profile.id}`, memoryKey:`data_recovery_profile:${projectId}`, scope:'project', projectId, initiativeId:'', type:'data_recovery_profile', statement:dataRecoveryProfileStatement(profile), data:profile, source:profile.source || 'user_confirmed', confidence:'high', status:'active', version:profile.version, evidence:'用户确认的数据回收配置', createdAt:now, updatedAt:now };
  store.unshift(memory);
  return memory;
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);

    if (url.pathname === '/api/demo/config' && request.method === 'GET') {
      return sendJson(response, 200, { enabled:DEMO_MODE });
    }

    if (url.pathname === '/api/demo/reset' && request.method === 'POST') {
      if (!DEMO_MODE) return sendJson(response, 404, { error:'Demo mode is disabled.' });
      const document = await writeStoredState(createDemoState());
      return sendJson(response, 200, { ok:true, state:document.state, updatedAt:document.updatedAt });
    }

    const demoDocumentMatch = url.pathname.match(/^\/demo\/docs\/([^/]+)$/);
    if (demoDocumentMatch && request.method === 'GET') {
      if (!DEMO_MODE) return sendText(response, 404, 'Not found');
      const document = await readStoredState();
      const item=(document?.state?.demoDocuments || []).find((entry) => entry.id === decodeURIComponent(demoDocumentMatch[1]));
      if (!item) return sendText(response, 404, '演示文档不存在或已被重置。');
      const body=String(item.content || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/^# (.*)$/gm,'<h1>$1</h1>').replace(/^## (.*)$/gm,'<h2>$1</h2>').replace(/\n\n/g,'</p><p>').replace(/\n/g,'<br>');
      response.writeHead(200, { 'Content-Type':'text/html; charset=utf-8', 'Cache-Control':'no-store' });
      return response.end(`<!doctype html><meta charset="utf-8"><title>${item.title}</title><style>body{margin:0;background:#f7f7f5;font:16px/1.7 system-ui,sans-serif;color:#202522}main{max-width:760px;margin:56px auto;padding:48px;background:#fff;border:1px solid #e8e8e3;border-radius:16px}small{color:#68716b}h1{font-size:30px}h2{margin-top:32px}</style><main><small>推进器 · 演示文档（模拟数据）</small><p>${body}</p></main>`);
    }

    if (url.pathname === '/api/health' && request.method === 'GET') {
      return sendJson(response, 200, { ok: true, storage: 'json-file', demo:DEMO_MODE });
    }

    if (url.pathname === '/api/setup/status' && request.method === 'GET') {
      return sendJson(response, 200, await integrationSetupStatus());
    }

    if (url.pathname === '/api/setup/openrouter-key' && request.method === 'POST') {
      if (!allowsLocalApiKeySetup()) return sendJson(response, 403, { error:'仅在非演示模式的本机服务中允许通过页面保存 API Key。' });
      const payload=await readJsonBody(request);
      await saveOpenRouterApiKey(payload.apiKey);
      return sendJson(response, 200, { ok:true, configured:true });
    }

    if (url.pathname === '/api/ai/models' && request.method === 'GET') {
      const catalog = await fetchModelRequestMockModels();
      const models = DEMO_MODE ? [DEMO_AGENT_MODEL, ...catalog.models] : catalog.models;
      const configuredDefault = resolveChatModel().id;
      const defaultModel = DEMO_MODE ? DEMO_AGENT_MODEL.id : (models.some((model) => model.id === configuredDefault) ? configuredDefault : models[0]?.id || configuredDefault);
      return sendJson(response, 200, { models, defaultModel, source:catalog.source, demo:DEMO_MODE });
    }

    if (url.pathname === '/api/model-request-mock/models' && request.method === 'GET') {
      const catalog = await fetchModelRequestMockModels();
      return sendJson(response, 200, catalog);
    }

    if (url.pathname === '/api/model-request-mock/tools' && request.method === 'GET') {
      const tools = modelRequestToolCatalog();
      return sendJson(response, 200, { tools, defaultSelectedToolNames:tools.filter((tool) => tool.defaultSelected).map((tool) => tool.name) });
    }

    if (url.pathname === '/api/model-request-mock/tools/execute' && request.method === 'POST') {
      const payload = await readJsonBody(request);
      const name = String(payload.name || '');
      const args = payload.args && typeof payload.args === 'object' && !Array.isArray(payload.args) ? payload.args : null;
      const selectedTools = selectModelRequestTools(payload.selectedToolNames);
      if (!args) return sendJson(response, 422, { error:'args must be an object.' });
      if (!selectedTools.some((tool) => tool.function.name === name)) return sendJson(response, 422, { error:'The requested tool is not selected for this Playground request.' });
      const document = await readStoredState();
      const state = document?.state || { projects:[], knowledgeItems:[], longTermMemories:[], agentPlans:[], agentRuns:[], artifacts:[], mediaAssets:[] };
      const run = createAgentRun({ message:`Playground manual tool call: ${name}` });
      run.type = 'model_request_playground';
      const executed = await executeAgentCall({ state, projectId:'', initiativeId:'', run, plan:null, call:{ name, args }, resultIndex:0 });
      await writeStoredState(state);
      return sendJson(response, 200, { executed:true, result:executed.result });
    }

    if (url.pathname === '/api/model-request-mock' && request.method === 'POST') {
      const payload = await readJsonBody(request);
      const modelRequest = buildModelRequestMock({ ...payload, tools:selectModelRequestTools(payload.selectedToolNames) });
      if (payload.sendRealRequest !== true) {
        return sendJson(response, 200, {
          mocked:true,
          request:modelRequest,
          response:{ mode:'mock', message:'Request validated. No external model was called.', model:modelRequest.model },
        });
      }
      if (!OPENROUTER_API_KEY) return sendJson(response, 503, { error:'OPENROUTER_API_KEY is not configured on the backend.' });
      const { response: upstream, payload:upstreamPayload } = await fetchOpenRouterChat(modelRequest);
      if (!upstream.ok) throw Object.assign(new Error(upstreamPayload?.error?.message || 'OpenRouter request failed.'), { statusCode:upstream.status });
      return sendJson(response, 200, {
        mocked:false,
        request:modelRequest,
        response:upstreamPayload,
      });
    }

    if (url.pathname === '/api/knowledge/sync-link' && request.method === 'POST') {
      const payload = await readJsonBody(request);
      const link = typeof payload.url === 'string' ? payload.url.trim() : '';
      if (!link) return sendJson(response, 422, { error: 'url is required.' });
      const synced = await syncLinkContent(link);
      return sendJson(response, 200, synced);
    }

    if (url.pathname === '/api/knowledge/sync-pending' && request.method === 'POST') {
      const document = await readStoredState();
      if (!document?.state || typeof document.state !== 'object') return sendJson(response, 409, { error: 'No workspace state is available yet.' });
      const results = await syncPendingKnowledge(document.state);
      const saved = await writeStoredState(document.state);
      return sendJson(response, 200, {
        ok: true,
        synced: results.filter((result) => result.status === 'synced').length,
        failed: results.filter((result) => result.status === 'failed').length,
        results,
        updatedAt: saved.updatedAt,
      });
    }

    if (url.pathname === '/api/skills' && request.method === 'GET') return sendJson(response, 200, await skillLibrary.scanSkillTree(SKILLS_DIR));

    if (url.pathname === '/api/skills/upload' && request.method === 'POST') {
      const payload = await readJsonBody(request);
      const skill = await skillLibrary.uploadSkill(SKILLS_DIR, { parentSkillPath:payload.parentSkillPath, filename:payload.filename, content:payload.content });
      return sendJson(response, 201, { skill, library:await skillLibrary.scanSkillTree(SKILLS_DIR) });
    }

    const skillDeleteMatch = url.pathname.match(/^\/api\/skills\/([^/]+)$/);
    if (skillDeleteMatch && request.method === 'DELETE') {
      const skill = await skillLibrary.deleteSkill(SKILLS_DIR, decodeURIComponent(skillDeleteMatch[1]));
      return sendJson(response, 200, { skill, library:await skillLibrary.scanSkillTree(SKILLS_DIR) });
    }

    if (url.pathname === '/api/media-assets/paste' && request.method === 'POST') {
      const payload = await readJsonBody(request);
      const projectId = typeof payload.projectId === 'string' ? payload.projectId : '';
      const initiativeId = typeof payload.initiativeId === 'string' ? payload.initiativeId : '';
      const suppliedConversationId = typeof payload.conversationId === 'string' ? payload.conversationId : '';
      const document = await readStoredState();
      const state = document?.state;
      const conversation=findConversation(state, suppliedConversationId);
      const project = projectId ? findProject(state, projectId) : null;
      const validScope=conversation && conversation.projectId === projectId && conversation.initiativeId === initiativeId;
      if (!state || !conversation || !validScope || (projectId && (!project || (initiativeId && !project.initiatives?.some((item) => item.id === initiativeId))))) return sendJson(response, 422, { error:'conversationId or its discussion scope is invalid.' });
      const image = decodeImageDataUrl(payload.dataUrl);
      await fs.mkdir(ASSET_DIR, { recursive:true });
      const filename = `paste-${Date.now()}-${Math.random().toString(16).slice(2)}.${image.extension}`;
      const filePath = path.join('data', 'assets', filename);
      await fs.writeFile(managedAssetAbsolutePath(filePath), image.buffer);
      const asset = registerMediaAsset(state, {
        projectId, initiativeId, conversationId:conversation.id, filePath, mimeType:image.mimeType, filename,
        title:String(payload.title || '用户粘贴图片').slice(0, 240), source:'user_pasted', createdBy:'user',
      });
      await writeStoredState(state);
      return sendJson(response, 201, { asset });
    }

    const agentEventsMatch = url.pathname.match(/^\/api\/ai\/runs\/([^/]+)\/events$/);
    if (agentEventsMatch && request.method === 'GET') {
      const runId = decodeURIComponent(agentEventsMatch[1]);
      const active = ACTIVE_AGENT_RUNS.get(runId);
      const replay = active ? null : getAgentEventReplay(runId);
      if (!active && !replay) return sendJson(response, 404, { error:'未找到 AI Run 事件流。' });
      response.writeHead(200, { 'Content-Type':'text/event-stream; charset=utf-8', 'Cache-Control':'no-cache, no-transform', Connection:'keep-alive' });
      for (const event of active ? active.events : replay.events) response.write(`event: progress\ndata: ${JSON.stringify(event)}\n\n`);
      if (!active) return response.end();
      active.subscribers.add(response);
      request.on('close', () => active.subscribers.delete(response));
      return;
    }

    const stopAgentMatch = url.pathname.match(/^\/api\/ai\/runs\/([^/]+)\/stop$/);
    if (stopAgentMatch && request.method === 'POST') {
      const runId = decodeURIComponent(stopAgentMatch[1]);
      const active = ACTIVE_AGENT_RUNS.get(runId);
      if (!active) return sendJson(response, 404, { error:'未找到正在执行的 AI Run。' });
      active.run.stopRequestedAt = new Date().toISOString();
      active.run.status = 'stopping';
      active.controller.abort();
      publishAgentEvent(runId, 'stop_requested', { message:'已收到停止请求。' });
      await writeStoredState(active.state);
      return sendJson(response, 202, { ok:true, run:active.run, state:active.state });
    }

    if (url.pathname === '/api/automation/plans' && request.method === 'POST') {
      const payload = await readJsonBody(request);
      const description = String(payload?.description || '').trim();
      if (!description) return sendJson(response, 422, { error:'请输入自然语言自动化规则。' });
      const document = await readStoredState(); const state = document?.state;
      if (!state) return sendJson(response, 409, { error:'No workspace state is available yet.' });
      normalizeAutomationState(state);
      const fallbackModel = defaultFlashModel(CHAT_MODEL_CATALOG);
      const model = resolveChatModel(String(payload?.model || fallbackModel?.id || ''));
      let planned;
      try {
        planned = await planAutomationRule({ state, description, model });
      } catch (error) {
        const run = error.automationRun;
        if (run && run.status === 'running') finishAgentRun(run, { error });
        await writeStoredState(state);
        return sendJson(response, error.statusCode || 500, { error:publicErrorMessage(error), run, state });
      }
      const replaceRuleId = String(payload?.replaceRuleId || '');
      if (replaceRuleId && !state.automationRules.some((item) => item.id === replaceRuleId)) return sendJson(response, 422, { error:'待编辑的自动化规则不存在。' });
      const record = { id:`automation-plan-${Date.now()}-${Math.random().toString(16).slice(2)}`, version:1, naturalLanguage:description, planningRunId:planned.run.id, title:planned.plan.title, modelId:model.id, feasible:planned.feasible, errors:planned.errors, plan:planned.plan, replaceRuleId, createdAt:new Date().toISOString(), confirmedAt:'' };
      state.automationPlans.unshift(record); state.automationPlans = state.automationPlans.slice(0, 50);
      await writeStoredState(state);
      return sendJson(response, planned.feasible ? 201 : 422, { plan:record, run:planned.run, feasible:planned.feasible, errors:planned.errors, state });
    }

    if (url.pathname === '/api/automation/rules/confirm' && request.method === 'POST') {
      const payload = await readJsonBody(request);
      const document = await readStoredState(); const state = document?.state;
      if (!state) return sendJson(response, 409, { error:'No workspace state is available yet.' });
      normalizeAutomationState(state);
      const plan = state.automationPlans.find((item) => item.id === String(payload?.automationPlanId || ''));
      if (!plan || !plan.feasible) return sendJson(response, 422, { error:'只能确认已通过可实现性校验的 Automation Plan。' });
      if (payload?.modelId) plan.modelId = resolveChatModel(String(payload.modelId)).id;
      const confirmedRule = state.automationRules.find((item) => item.automationPlanId === plan.id);
      const previous = confirmedRule || (plan.replaceRuleId ? state.automationRules.find((item) => item.id === plan.replaceRuleId) : null);
      const rule = { id:previous?.id || `automation-rule-${Date.now()}-${Math.random().toString(16).slice(2)}`, title:plan.title, naturalLanguage:plan.naturalLanguage, automationPlanId:plan.id, planningRunId:plan.planningRunId, modelId:plan.modelId, enabled:true, version:confirmedRule ? Number(confirmedRule.version || 1) : Number(previous?.version || 0) + 1, createdAt:previous?.createdAt || new Date().toISOString(), updatedAt:new Date().toISOString() };
      state.automationRules = [rule, ...state.automationRules.filter((item) => item.id !== rule.id)].slice(0, 20);
      plan.confirmedAt = new Date().toISOString();
      await writeStoredState(state);
      await evaluateAutomationRules('confirm');
      const refreshed = await readStoredState();
      return sendJson(response, 201, { rule, state:refreshed?.state });
    }

    const automationDeleteMatch = url.pathname.match(/^\/api\/automation\/rules\/([^/]+)$/);
    if (automationDeleteMatch && request.method === 'DELETE') {
      const document = await readStoredState(); const state = document?.state; normalizeAutomationState(state);
      const ruleId = decodeURIComponent(automationDeleteMatch[1]);
      const rule = state?.automationRules?.find((item) => item.id === ruleId);
      if (!rule) return sendJson(response, 404, { error:'未找到自动化规则。' });
      state.automationRules = state.automationRules.filter((item) => item.id !== ruleId);
      await writeStoredState(state);
      return sendJson(response, 200, { ok:true, deletedRuleId:ruleId, state });
    }

    const automationToggleMatch = url.pathname.match(/^\/api\/automation\/rules\/([^/]+)\/toggle$/);
    if (automationToggleMatch && request.method === 'POST') {
      const payload = await readJsonBody(request);
      const document = await readStoredState(); const state = document?.state; normalizeAutomationState(state);
      const rule = state?.automationRules?.find((item) => item.id === decodeURIComponent(automationToggleMatch[1]));
      if (!rule) return sendJson(response, 404, { error:'未找到自动化规则。' });
      rule.enabled = Boolean(payload?.enabled); rule.updatedAt = new Date().toISOString();
      await writeStoredState(state);
      if (rule.enabled) await evaluateAutomationRules('confirm');
      const refreshed = await readStoredState();
      return sendJson(response, 200, { rule, state:refreshed?.state });
    }

    const automationTaskMatch = url.pathname.match(/^\/api\/automation\/tasks\/([^/]+)$/);
    if (automationTaskMatch && request.method === 'GET') {
      const document = await readStoredState(); const state = document?.state; normalizeAutomationState(state);
      const task = state?.automationTasks?.find((item) => item.id === decodeURIComponent(automationTaskMatch[1]));
      if (!task) return sendJson(response, 404, { error:'未找到自动化任务。' });
      const run = state.agentRuns?.find((item) => item.id === task.runId) || null;
      return sendJson(response, 200, { task, run, state });
    }

    const automationReadMatch = url.pathname.match(/^\/api\/automation\/tasks\/([^/]+)\/read$/);
    if (automationReadMatch && request.method === 'POST') {
      const document = await readStoredState(); const state = document?.state; normalizeAutomationState(state);
      const task = state?.automationTasks?.find((item) => item.id === decodeURIComponent(automationReadMatch[1]));
      if (!task) return sendJson(response, 404, { error:'未找到自动化任务。' });
      const today = automationLocalDateKey();
      if (!task.readDates.includes(today)) task.readDates.push(today);
      await writeStoredState(state);
      return sendJson(response, 200, { task, state });
    }

    if (url.pathname === '/api/notifications' && request.method === 'GET') {
      const document = await readStoredState(); const state = document?.state;
      normalizeNotifications(state); normalizeConversationThreads(state);
      return sendJson(response, 200, { notifications:state?.notifications || [], unreadCount:(state?.notifications || []).filter((item) => !item.readAt).length, conversations:state?.conversations || [] });
    }

    const notificationReadMatch = url.pathname.match(/^\/api\/notifications\/([^/]+)\/read$/);
    if (notificationReadMatch && request.method === 'POST') {
      const document = await readStoredState(); const state = document?.state;
      normalizeNotifications(state); normalizeConversationThreads(state);
      const notification = state?.notifications?.find((item) => item.id === decodeURIComponent(notificationReadMatch[1]));
      if (!notification) return sendJson(response, 404, { error:'未找到站内通知。' });
      notification.readAt ||= new Date().toISOString();
      await writeStoredState(state);
      const conversation = notification.conversationId ? findConversation(state, notification.conversationId) : null;
      return sendJson(response, 200, { notification, conversation, notifications:state.notifications, unreadCount:state.notifications.filter((item) => !item.readAt).length });
    }

    if (url.pathname === '/api/ai/chat' && request.method === 'POST') {
      const payload = await readJsonBody(request);
      const suppliedConversationId = typeof payload.conversationId === 'string' ? payload.conversationId : '';
      const suppliedProjectId = typeof payload.projectId === 'string' ? payload.projectId : '';
      const suppliedInitiativeId = typeof payload.initiativeId === 'string' ? payload.initiativeId : '';
      let message = typeof payload.message === 'string' ? payload.message.trim() : '';
      let imageAssetIds = Array.isArray(payload.imageAssetIds) ? payload.imageAssetIds.map(String).filter(Boolean) : [];
      const manualRerunOf = typeof payload.manualRerunOf === 'string' ? payload.manualRerunOf : '';
      const model = resolveChatModel(payload.model);
      const requestedRunId = typeof payload.runId === 'string' && /^run-client-[a-z0-9-]+$/i.test(payload.runId) ? payload.runId : '';
      if ((!suppliedConversationId && !suppliedProjectId) || (!manualRerunOf && !message && !imageAssetIds.length)) return sendJson(response, 422, { error: 'conversationId or projectId and message or imageAssetIds are required.' });
      const document = await readStoredState();
      const state = document?.state;
      if (!state || typeof state !== 'object') return sendJson(response, 409, { error: 'No workspace state is available yet.' });
      normalizeDataRecoveryProfiles(state);
      let requestConversation=findConversation(state, suppliedConversationId);
      if (!requestConversation && suppliedProjectId) {
        const project=findProject(state, suppliedProjectId);
        const initiative=suppliedInitiativeId ? project?.initiatives?.find((item) => item.id === suppliedInitiativeId) : null;
        if (!project || (suppliedInitiativeId && !initiative)) return sendJson(response, 422, { error:'projectId or initiativeId is invalid.' });
        const scope=conversationScope(suppliedProjectId, suppliedInitiativeId);
        requestConversation=(state.conversations || []).filter((thread) => thread.scope===scope && thread.projectId===suppliedProjectId && thread.initiativeId===suppliedInitiativeId).sort((a,b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0] || normalizeConversationThread({ id:`compat-${scope}-${suppliedInitiativeId || suppliedProjectId}`, scope, projectId:suppliedProjectId, initiativeId:suppliedInitiativeId, memory:conversationStore(project, suppliedInitiativeId)?.memory || [], conversationSummary:conversationStore(project, suppliedInitiativeId)?.conversationSummary || null }, state);
        if (!(state.conversations || []).some((thread) => thread.id===requestConversation.id)) state.conversations.unshift(requestConversation);
      }
      if (!requestConversation) return sendJson(response, 422, { error:'conversationId is invalid.' });
      const projectId=requestConversation.projectId || ''; const initiativeId=requestConversation.initiativeId || '';
      const requestProject = projectId ? findProject(state, projectId) : null;
      if ((projectId && (!requestProject || (initiativeId && !requestProject.initiatives?.some((item) => item.id === initiativeId)))) || (!projectId && initiativeId)) return sendJson(response, 422, { error:'conversation scope is invalid.' });
      const rerun = manualRerunOf ? validateManualRerun(state, { runId:manualRerunOf, conversationId:requestConversation.id }) : null;
      const rerunSource=rerun?.source || null;
      if (rerun) {
        message = rerun.message;
        imageAssetIds = rerun.imageAssetIds;
      }
      const imageAttachments = await resolveChatImageAttachments(state, { projectId, initiativeId, conversationId:requestConversation.id, imageAssetIds });
      if (imageAttachments.length && !model.supportsVision) return sendJson(response, 422, { error:`「${model.label}」不支持图片输入，请切换到支持图片的模型。` });
      const command = message || '请分析我上传的图片。';
      requestConversation.memory ||= [];
      const lastMessage = requestConversation.memory.at(-1);
      if (!rerunSource && !(lastMessage?.role === 'user' && cleanConversationMessage(lastMessage) === message && JSON.stringify(lastMessage.imageAssetIds || []) === JSON.stringify(imageAssetIds))) {
        requestConversation.memory.push({ role:'user', text:message, imageAssetIds, attachments:imageAttachments.map(({ id, title, mimeType, assetUrl }) => ({ id, title, mimeType, assetUrl })), createdAt:new Date().toISOString(), serverPersisted:true });
      }
      state.agentRuns ||= [];
      const run = createAgentRun({ projectId, initiativeId, conversationId:requestConversation.id, message:command, imageAssetIds, runId:requestedRunId, manualRerunOf });
      if (rerunSource) { rerunSource.manualRerunRunId=run.id; rerunSource.manualRerunAt=new Date().toISOString(); }
      if (payload.runType === 'automation_execution') {
        run.type = 'automation_execution';
        run.automationTaskId = String(payload.automationTaskId || '');
      }
      run.requestedModel = model.id;
      state.agentRuns.unshift(run);
      state.agentRuns = state.agentRuns.slice(0, 100);
      await writeStoredState(state);
      const controller = new AbortController();
      ACTIVE_AGENT_RUNS.set(run.id, { controller, run, state, events:[], subscribers:new Set() });
      publishAgentEvent(run.id, 'run_started', { message:'AI Run 已创建，正在构建 Context。' });
      if (model.id === DEMO_AGENT_MODEL.id) {
        const answer=demoAgentAnswer({ state, run, conversation:requestConversation, command, origin:url.origin });
        for (const result of answer.demoToolResults || []) publishAgentEvent(run.id, 'tool_result', { message:`工具 ${result.name}：${result.status}`, result });
        requestConversation.memory.push({ role:'assistant', text:answer.text, structured:answer.structured, model:answer.model, requestId:answer.requestId, createdAt:new Date().toISOString(), serverPersisted:true });
        requestConversation.updatedAt=new Date().toISOString();
        finishAgentRun(run, { answer });
        createInAppNotification(state, { title:`Demo AI · ${requestConversation.title}`, body:answer.text, conversation:requestConversation, run });
        await writeStoredState(state);
        publishAgentEvent(run.id, 'model_response', { message:'Demo Agent 已生成模拟结果。' });
        closeAgentEventStream(run.id, 'run_finished');
        ACTIVE_AGENT_RUNS.delete(run.id);
        return sendJson(response, 200, { ...answer, run, state, updatedAt:runtimeStateDocument?.updatedAt || '' });
      }
      try {
        const initialAnswer = await askOpenRouter({ state, projectId, initiativeId, message:command, imageAttachments, model, run, conversation:requestConversation, signal:controller.signal });
        const initialSnapshot = recordPromptSnapshot(run, { loop:1, phase:'initial', debug:initialAnswer.debug, answer:initialAnswer, toolCalls:initialAnswer.providerToolCalls });
        const contextStep = run.steps.find((step) => step.name === 'context_builder');
        if (contextStep) {
          contextStep.status = 'completed';
          contextStep.output = { snapshotId:initialSnapshot.id, contextChars:initialSnapshot.charCounts.context, contextBreakdown:initialAnswer.debug.contextBreakdown, currentCommand:command, imageCount:imageAttachments.length };
        }
        const initialModelStep = run.steps.find((step) => step.name === 'model_call');
        if (initialModelStep) {
          initialModelStep.status = 'completed';
          initialModelStep.input = { snapshotId:initialSnapshot.id, systemPromptChars:initialSnapshot.charCounts.systemPrompt, userPromptChars:initialSnapshot.charCounts.userPrompt };
          initialModelStep.output = { snapshotId:initialSnapshot.id, assistantText:initialSnapshot.assistantText, model:initialSnapshot.model, requestId:initialSnapshot.requestId, usage:initialSnapshot.usage, toolCalls:initialSnapshot.toolCalls };
        }
        publishAgentEvent(run.id, 'model_response', { message:'Loop 1 模型已返回，开始执行工具。' });
        const loop = await runAgentLoop({
          initial: initialAnswer,
          maxSteps: MAX_AGENT_LOOP_STEPS,
          forceFinalResponseAtLimit: true,
          maxRetryableFailuresPerCall: MAX_RETRYABLE_FAILURES_PER_TOOL_CALL,
          getCalls: collectAgentCalls,
          ensurePlan: async ({ plan }) => plan,
          dispatch: async ({ calls, plan, step }) => {
            assertAgentActive(controller.signal);
            assertAutomationCallsAuthorized(state, run, calls);
            const dispatched = await dispatchAgentCalls({ state, projectId, initiativeId, run, plan, calls, onResult:(result) => publishAgentEvent(run.id, 'tool_result', { message:`工具 ${result.name}：${result.status}`, result }) });
            assertAgentActive(controller.signal);
            if (dispatched.plan) run.planId = dispatched.plan.id;
            return dispatched;
          },
          beforeNextModel: async ({ step, plan, toolResults, lastLoopToolResults, artifacts, forceFinalResponse }) => {
            if (forceFinalResponse) return;
            const covered = new Set(run.executionHandoffCoveredToolCallIds || run.executionHandoff?.coveredToolCallIds || []);
            const latest = new Set((lastLoopToolResults || []).map((item) => item.toolCallId).filter(Boolean));
            const pending = (toolResults || []).filter((item) => !covered.has(item.toolCallId) && !latest.has(item.toolCallId));
            const predicted = projectId ? buildProjectContext(state, findProject(state, projectId), initiativeId, command, {
              runId:run.id, planRef:run.planRef, plan, toolResults, lastLoopToolResults, executionHandoff:run.executionHandoff || null, executionHandoffCoveredToolCallIds:run.executionHandoffCoveredToolCallIds || [],
              discoveredSkills:run.discoveredSkillRefs || [], artifacts, selectedArtifacts:run.selectedArtifactRefs || [], loop:step, conversation:requestConversation,
            }) : buildWorkspaceContext(state, command, { runId:run.id, toolResults, lastLoopToolResults, executionHandoff:run.executionHandoff || null, discoveredSkills:run.discoveredSkillRefs || [], loop:step, conversation:requestConversation });
            const predictedChars = predicted.length;
            const completedToolLoops = Math.max(0, step - 1);
            const trigger = executionCompactionTrigger({ completedToolLoops, lastCompactionLoop:run.executionHandoffLastLoop, predictedContextChars:predictedChars, pendingToolResultCount:pending.length });
            if (!trigger) return;
            publishAgentEvent(run.id, 'context_compaction_started', { message:'正在归纳执行上下文。', trigger, predictedChars, contextBudget:CONTEXT_NORMAL_CHAR_BUDGET });
            const compacted = await compactExecutionContext({ run, model, currentCommand:command, plan, pendingToolResults:pending, activeSkills:run.discoveredSkillRefs || [], signal:controller.signal, trigger, loop:completedToolLoops, onStarted:async () => {
              await writeStoredState(state);
              publishAgentEvent(run.id, 'context_compaction_persisted', { message:`正在归纳执行上下文（最长 ${Math.round(CONTEXT_COMPACTION_TIMEOUT_MS / 1000)} 秒）。`, trigger, predictedChars, contextBudget:CONTEXT_NORMAL_CHAR_BUDGET });
            } });
            if (compacted.compacted) {
              run.executionHandoffLastLoop = completedToolLoops;
              publishAgentEvent(run.id, compacted.fallback ? 'context_compaction_fallback' : 'context_compaction_completed', { message:compacted.fallback ? `执行上下文归纳超时/失败，已使用受限降级交接继续：${compacted.error}` : '执行上下文已归纳。', trigger, snapshotId:compacted.snapshotId });
            }
          },
          nextModel: async ({ step, plan, toolResults, lastLoopToolResults, artifacts, retryPolicy, forceFinalResponse=false }) => {
          const record = { name:`agent_loop_${step}`, type:'llm', label:forceFinalResponse ? `调用 AI 模型（Loop ${step}：强制终结回复）` : `调用 AI 模型（Loop ${step}：检查完成条件）`, status:'running', input:buildAgentLoopAuditInput({ lastLoopToolResults, allToolResults:toolResults, artifacts, planRef:run.planRef || null, retryPolicy, forceFinalResponse }), output:{} };
            run.steps.push(record);
            publishAgentEvent(run.id, 'model_started', { message:`Loop ${step} 模型调用中。` });
            try {
              const next = await askOpenRouterAfterTool({ state, projectId, initiativeId, originalMessage:command, imageAttachments, model, toolResults:lastLoopToolResults, allToolResults:toolResults, artifacts, plan, loopStep:step, run, conversation:requestConversation, signal:controller.signal, retryPolicy, forceFinalResponse });
              const snapshot = recordPromptSnapshot(run, { loop:step, phase:'after_tool', debug:next.debug, answer:next, toolCalls:next.providerToolCalls });
              record.status = 'completed';
              record.input = buildAgentLoopAuditInput({ snapshotId:snapshot.id, lastLoopToolResults, allToolResults:toolResults, artifacts, planRef:run.planRef || null, retryPolicy, forceFinalResponse });
              record.output = { snapshotId:snapshot.id, contextChars:snapshot.charCounts.context, contextBreakdown:next.debug.contextBreakdown, assistantOutput:snapshot.assistantText, model:next.model || '', requestId:next.requestId || '', usage:snapshot.usage, toolCalls:snapshot.toolCalls };
              publishAgentEvent(run.id, 'model_response', { message:`Loop ${step} 模型已返回。` });
              return next;
            } catch (error) {
              record.status = 'failed';
              record.error = publicErrorMessage(error);
              throw error;
            }
          },
          applyPlanUpdate: updateExecutionPlan,
          shouldStopAfterDispatch: ({ answer, plan, toolResults }) => {
            const hasCompletedPlanUpdate = toolResults.some((result) => result.name === 'update_execution_plan' && result.status === 'completed');
            return Boolean(plan?.goalCompleted && hasCompletedPlanUpdate && terminalUserFacingReply(answer));
          },
          signal: controller.signal,
          onStep: ({ plan }) => { if (plan) { run.planId = plan.id; run.planRef = { planId:plan.id, revision:Number(plan.revision || 1) }; run.goalStatus = plan.status; } },
        });
        let answer = loop.answer;
        run.loop = { maxSteps:MAX_AGENT_LOOP_STEPS, usedSteps:loop.steps, limitReached:loop.limitReached, finalResponseForced:loop.finalResponseForced, retryLimit:MAX_RETRYABLE_FAILURES_PER_TOOL_CALL, blockedCalls:loop.blockedCalls };
        if (loop.plan) {
          run.planId = loop.plan.id;
          run.goalStatus = loop.plan.status;
        }
        answer = applyTerminalUserFacingReply(answer, loop.plan);
        answer.structured = { ...(answer.structured || {}), toolResults:[] };
        const responseConversation = findConversation(state, requestConversation.id) || requestConversation;
        responseConversation.memory ||= [];
        const lastStoredMessage = responseConversation.memory.at(-1);
        if (!(lastStoredMessage?.role === 'assistant' && lastStoredMessage.requestId === answer.requestId && lastStoredMessage.text === answer.text)) {
          responseConversation.memory.push({ role:'assistant', text:answer.text, structured:answer.structured, model:answer.model, requestId:answer.requestId, createdAt:new Date().toISOString(), serverPersisted:true });
        }
        responseConversation.updatedAt=new Date().toISOString();
        finishAgentRun(run, { answer });
        createInAppNotification(state, {
          title:run.type === 'automation_execution' ? `自动化任务结果 · ${responseConversation.title}` : `AI 消息 · ${responseConversation.title}`,
          body:answer.text,
          conversation:responseConversation,
          run,
        });
        await writeStoredState(state);
        closeAgentEventStream(run.id, 'run_finished');
        ACTIVE_AGENT_RUNS.delete(run.id);
        return sendJson(response, 200, { ...answer, run, state });
      } catch (error) {
        finishAgentRun(run, { error });
        await writeStoredState(state);
        closeAgentEventStream(run.id, error?.code === 'AGENT_STOPPED' ? 'run_stopped' : 'run_failed');
        ACTIVE_AGENT_RUNS.delete(run.id);
        return sendJson(response, error.statusCode || 500, { error: publicErrorMessage(error), run, state });
      }
    }

    const summaryRefreshMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/conversation-summary\/refresh$/);
    if (summaryRefreshMatch && request.method === 'POST') {
      const payload = await readJsonBody(request);
      const document = await readStoredState();
      const state = document?.state;
      const project = findProject(state, decodeURIComponent(summaryRefreshMatch[1]));
      const initiativeId = typeof payload?.initiativeId === 'string' ? payload.initiativeId : '';
      const hasInitiative = !initiativeId || Boolean(project?.initiatives?.some((item) => item.id === initiativeId));
      const store = conversationStore(project, initiativeId);
      if (!state || !project || !hasInitiative || !store) return sendJson(response, 422, { error:'A stored project and valid optional initiative are required.' });
      try {
        const summary = await summarizeProjectConversation(state, project, initiativeId, { force:payload?.force === true });
        if (summary) await writeStoredState(state);
        return sendJson(response, 200, { summarized:Boolean(summary), summary:summary || store.conversationSummary || null, memory:Array.isArray(store.memory) ? store.memory : [] });
      } catch (error) {
        return sendJson(response, error.statusCode || 502, { error:publicErrorMessage(error) });
      }
    }

    const summaryMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/conversation-summary$/);
    if (summaryMatch && request.method === 'POST') {
      const payload = await readJsonBody(request);
      const state = (await readStoredState())?.state;
      const project = findProject(state, decodeURIComponent(summaryMatch[1]));
      const initiativeId = typeof payload?.initiativeId === 'string' ? payload.initiativeId : '';
      const hasInitiative = !initiativeId || Boolean(project?.initiatives?.some((item) => item.id === initiativeId));
      const store = conversationStore(project, initiativeId);
      if (!state || !project || !hasInitiative) return sendJson(response, 422, { error:'A stored project and valid optional initiative are required.' });
      try {
      const summary = await summarizeProjectConversation(state, project, initiativeId, { force:payload?.force === true });
        if (summary) await writeStoredState(state);
        return sendJson(response, 200, { summarized:Boolean(summary), summary:summary || store.conversationSummary || null, state });
      } catch (error) {
        return sendJson(response, error.statusCode || 502, { error:publicErrorMessage(error) });
      }
    }

    if (url.pathname === '/api/proposals' && request.method === 'POST') {
      const payload = await readJsonBody(request);
      const proposal = payload?.proposal;
      const state = (await readStoredState())?.state;
      if (!proposal || typeof proposal !== 'object' || !state || typeof state !== 'object') {
        return sendJson(response, 422, { error: 'proposal and stored state are required.' });
      }
      if (!['draft', 'pending'].includes(proposal.status) || !findProject(state, proposal.projectId)) {
        return sendJson(response, 422, { error: 'Invalid proposal.' });
      }
      state.proposals ||= [];
      const savedProposal = { ...proposal, status: 'pending', submittedAt: new Date().toISOString() };
      state.proposals.unshift(savedProposal);
      await writeStoredState(state);
      return sendJson(response, 201, { proposal: savedProposal, state });
    }

    const confirmProposalMatch = url.pathname.match(/^\/api\/proposals\/([^/]+)\/confirm$/);
    if (confirmProposalMatch && request.method === 'POST') {
      await readJsonBody(request);
      const state = (await readStoredState())?.state;
      if (!state || typeof state !== 'object' || !Array.isArray(state.proposals)) {
        return sendJson(response, 422, { error: 'Stored state.proposals is required.' });
      }
      const proposal = state.proposals.find((item) => item.id === decodeURIComponent(confirmProposalMatch[1]));
      if (!proposal || proposal.status !== 'pending') return sendJson(response, 404, { error: 'Pending proposal not found.' });
      applyProposal(state, proposal);
      proposal.status = 'accepted';
      proposal.confirmedAt = new Date().toISOString();
      await writeStoredState(state);
      return sendJson(response, 200, { proposal, state });
    }

    if (url.pathname === '/api/project-memory' && request.method === 'POST') {
      const payload = await readJsonBody(request);
      const state = (await readStoredState())?.state;
      if (!state || typeof state !== 'object' || !payload?.entry || typeof payload.entry !== 'object') {
        return sendJson(response, 422, { error: 'Stored state and entry are required.' });
      }
      const entry = createProjectMemory(state, payload.entry);
      await writeStoredState(state);
      return sendJson(response, 201, { entry, state });
    }

    const confirmMemoryMatch = url.pathname.match(/^\/api\/project-memory\/([^/]+)\/confirm$/);
    if (confirmMemoryMatch && request.method === 'POST') {
      await readJsonBody(request);
      const state = (await readStoredState())?.state;
      const entry = memories(state).find((item) => item.id === decodeURIComponent(confirmMemoryMatch[1]));
      if (!entry) return sendJson(response, 404, { error: 'Project memory entry not found.' });
      entry.source = 'user_confirmed';
      entry.updatedAt = new Date().toISOString();
      await writeStoredState(state);
      return sendJson(response, 200, { entry, state });
    }

    const correctMemoryMatch = url.pathname.match(/^\/api\/project-memory\/([^/]+)\/correct$/);
    if (correctMemoryMatch && request.method === 'POST') {
      const payload = await readJsonBody(request);
      const state = (await readStoredState())?.state;
      const oldEntry = memories(state).find((item) => item.id === decodeURIComponent(correctMemoryMatch[1]));
      const statement = String(payload?.statement || '').trim();
      if (!oldEntry || !statement) return sendJson(response, 422, { error: 'Existing memory entry and corrected statement are required.' });
      const entry = {
        ...oldEntry,
        id: `memory-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        statement: statement.slice(0, 1000),
        source: 'user_corrected',
        status: 'active',
        version: Number(oldEntry.version || 1) + 1,
        supersedes: oldEntry.id,
        supersededBy: '',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      oldEntry.status = 'superseded';
      oldEntry.supersededBy = entry.id;
      oldEntry.updatedAt = entry.updatedAt;
      memories(state).unshift({ ...entry, scope:entry.initiativeId ? 'initiative' : 'project', data:{ content:entry.content || '' } });
      await writeStoredState(state);
      return sendJson(response, 201, { entry, state });
    }

    const expireMemoryMatch = url.pathname.match(/^\/api\/project-memory\/([^/]+)\/expire$/);
    if (expireMemoryMatch && request.method === 'POST') {
      await readJsonBody(request);
      const state = (await readStoredState())?.state;
      const entry = memories(state).find((item) => item.id === decodeURIComponent(expireMemoryMatch[1]));
      if (!entry) return sendJson(response, 404, { error: 'Project memory entry not found.' });
      entry.status = 'expired';
      entry.updatedAt = new Date().toISOString();
      await writeStoredState(state);
      return sendJson(response, 200, { entry, state });
    }


    if (url.pathname === '/api/state' && request.method === 'GET') {
      await evaluateAutomationRules('workspace_open');
      const document = await readStoredState();
      return sendJson(response, 200, { state: document ? document.state : null, updatedAt: document ? document.updatedAt : null });
    }

    if (url.pathname === '/api/state' && request.method === 'PUT') {
      const payload = await readJsonBody(request);
      if (!payload || typeof payload.state !== 'object' || payload.state === null || Array.isArray(payload.state)) {
        return sendJson(response, 422, { error: 'Expected an object in payload.state' });
      }
      const existing = await readStoredState();
      const nextState = payload.clientManagedOnly === true ? mergeClientStateSnapshot(existing?.state, payload.state) : payload.state;
      const document = await writeStoredState(nextState);
      await evaluateAutomationRules('state_changed');
      const refreshed = await readStoredState();
      return sendJson(response, 200, { ok: true, updatedAt:refreshed?.updatedAt || document.updatedAt, state:refreshed?.state });
    }

    if (url.pathname === '/api/state' && request.method === 'DELETE') {
      await fs.rm(STATE_FILE, { force: true });
      runtimeStateDocument = null;
      runtimeStateLoad = null;
      return sendJson(response, 200, { ok: true });
    }

    if (url.pathname.startsWith('/api/')) return sendJson(response, 404, { error: 'API route not found' });
    return serveStatic(request, response, url.pathname);
  } catch (error) {
    console.error(error);
    return sendJson(response, error.statusCode || 500, { error: publicErrorMessage(error) });
  }
});

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`Project Pusher backend is running at http://${HOST}:${PORT}`);
    void evaluateAutomationRules('workspace_open');
    const automationTimer = setInterval(() => void evaluateAutomationRules('schedule'), 30_000);
    automationTimer.unref();
  });
}

function collectAgentCalls(answer) {
  return Array.isArray(answer?.structured?.atomicCalls)
    ? answer.structured.atomicCalls.map((call) => ({ name:call.name, args:call.args || {} }))
    : [];
}

function toolArtifact(type, title, data = {}) {
  return { id:`artifact-${Date.now()}-${Math.random().toString(16).slice(2)}`, type, title, createdAt:new Date().toISOString(), ...data };
}

function normalizeToolObligations(result) {
  return (Array.isArray(result?.obligations) ? result.obligations : []).map((item, index) => {
    const instruction = String(item?.instruction || '').trim();
    if (!instruction) return null;
    return {
      id:String(item.id || `obligation-${result.toolCallId}-${index + 1}`), kind:String(item.kind || 'requirement').slice(0, 120), status:'open', instruction:instruction.slice(0, 2000), evidence:String(item.evidence || '').slice(0, 2000),
      sourceRef:{ tool:result.name, toolCallId:result.toolCallId, artifactIds:(result.persistedArtifacts || []).map((artifact) => artifact.id) },
    };
  }).filter(Boolean);
}

function mergePlanObligations(plan, obligations) {
  if (!plan || !obligations?.length) return;
  plan.obligations ||= [];
  for (const obligation of obligations) {
    const index = plan.obligations.findIndex((item) => item.id === obligation.id);
    if (index >= 0) plan.obligations[index] = { ...plan.obligations[index], ...obligation };
    else plan.obligations.push(obligation);
  }
  plan.updatedAt = new Date().toISOString();
}

function buildToolResultGuidance(result) {
  const failed = ['failed','needs_input','blocked','conflict'].includes(result?.status);
  const unavailable = {
    meaning:`该工具本次状态为 ${result?.status || 'unknown'}；error、missing 和 summary 是当前唯一可确认的执行事实。`,
    nextStep:'先根据 error 或 missing 补齐必要输入、处理冲突或向用户说明真实阻塞；不要把该工具声称的目标当作已完成。',
    mustNotAssume:['不得把失败、阻塞、冲突或缺少输入的工具调用描述为已执行成功。', '不得因为此前存在类似历史记录而跳过当前错误处理。'],
  };
  if (failed) return unavailable;
  const guidanceByTool = {
    inspect_cli_help: {
      meaning:'capabilities、argv、stdout 和 stderr 是本次从已注册 CLI 返回或复用的有效帮助信息；它只说明命令用法，不表示任何外部操作已经执行。',
      nextStep:'依据帮助中实际存在的子命令、参数和输出格式，使用同一 cli 调用 execute_cli；同一 Run 内已有等价帮助或 executionHandoff 中已有命令模板时不要重复查询。',
      mustNotAssume:['不得把 --help 查询当作外部查询、写入或交付已完成。', '不得把未出现在帮助结果中的命令或参数当作可用。'],
    },
    search_skills: {
      meaning:'items 是 skills/ 文件树中的同层检索结果。level=parent时items是父目录下的skills；level=child 时 items 是该父目录 references/ 下的子 Skill。',
      nextStep:'根据当前任务确认是否进一步查询子skills；查询子skills时携带 parentSkillPath 和 query。检索命中的全文会自动持续出现在本 Run 后续 Context。',
      mustNotAssume:['不得将人工上传 Skill 当作已验证的外部系统返回。', '不得把 Skill 检索命中当作 Plan 或交付已完成。'],
    },
    execute_cli: {
      meaning:'argv是本次调用工具的入参，stdout是调用成功时工具返回结果，stderr是调用错误信息，外部写入是否成功依据status判断。',
      nextStep:'根据返回的内容继续处理；需要将 data/assets 下已导出的图片写入飞书文档时，查询 lark-cli 对应命令后直接通过 execute_cli 传 --file。',
      mustNotAssume:['不得因为命令已发起就认为外部写入、文件产物或远端内容已成功。', '不得根据历史命令或猜测的参数替代本次 argv 的真实结果。'],
    },
    read_experiment_metadata: {
      meaning:'experimentId、实验标题、版本和完整自然日查询窗口是本次读取到的实验元数据事实；它不表示任何指标已经查询或报告已经生成。',
      nextStep:'需要查询指标时，使用本 Result 返回的 experimentVersionIds 作为后续 query_metric_data 的明确版本边界。',
      mustNotAssume:['不得把读取元数据当作数据回收完成。', '不得猜测未返回的指标、数据日期或实验版本。'],
    },
    resolve_metric_specs: {
      meaning:'metricGroups 中的 groupId、指标名称和指标 ID 是已解析的可查询规格，不是指标结果。',
      nextStep:'将返回的指标组用于后续 query_metric_data；仍需明确 experimentVersionIds 和 freshnessPolicy。',
      mustNotAssume:['不得把规格解析当作指标查询完成。', '不得将不同实验版本的结果预先合并。'],
    },
    query_metric_data: {
      meaning:'metricResults 是本次真实查询结果；isLatest、dataLatestDate、deliveryDisclosure 和 obligations 描述时效、可继续性与尚未履行的交付限制。',
      nextStep:'可继续生成依赖这些真实结果的截图、报告或文档；将 open obligation 保留到 Plan，并在最终交付中履行。',
      mustNotAssume:['partial 不等于未执行。', '存在 T-2 回退时不得表述为最新完整数据或无条件最终决策。', '不得在 open obligation 未结清时将 Plan 标记 completed。'],
    },
    check_experiment_recycle: {
      meaning:'Result 仅描述该实验当前回收或合规状态，不包含指标查询、截图或文档交付事实。',
      nextStep:'根据返回的回收状态决定是否继续读取元数据或查询指标。',
      mustNotAssume:['不得把回收检查当作数据报告已生成。'],
    },
    capture_metric_snapshot: {
      meaning:'artifacts 中的 image 是本次已成功导出的受管截图；其 Artifact ID 可在当前 Run 后续工具中直接使用。',
      nextStep:'需要插入文档时使用当前 Run 的图片 Artifact ID；历史图片必须先经 query_agent_history 返回。',
      mustNotAssume:['截图生成不等于已插入文档或已向用户交付。', '不得使用文件路径或 mediaAssetId 代替 Artifact ID。'],
    },
    read_web_page: {
      meaning:'url、title、contentExcerpt、fetchedAt 和 truncated 是本次从公开网页提取的只读事实；truncated=true 表示只返回正文节选。',
      nextStep:'仅依据返回正文回答、比较或继续分析；需要飞书正文时调用 read_feishu_document，网页需要登录或无正文时如实说明限制。',
      mustNotAssume:['不得把公开网页读取当作飞书、Libra 或需要登录系统已读取。', '不得把正文节选表述为已读完整页面。'],
    },
    read_feishu_document: {
      meaning:'documentUrl、标题和 contentExcerpt 是本次只读获取的文档事实；truncated=true 表示正文只返回节选。',
      nextStep:'若需要引用文档内容，仅依据返回节选；内容不足时说明限制或读取更明确的来源。',
      mustNotAssume:['不得把只读文档当作已同步知识库或已修改文档。'],
    },
    query_agent_history: {
      meaning:'items 是当前项目持久化的四类历史 Agent 证据：conversation 是用户/助手历史消息；tool_call 是单次工具调用的真实 input 和 output；agent_run 是一次任务的整体状态，并带有关联 Plan 的 checklist、义务和 Artifact；artifact 是受管交付物元数据。返回的 verified Artifact 引用已加入本次 Run，可直接作为后续 Artifact ID 使用。',
      nextStep:'根据记录中的真实 content、input、output、runId、planId、toolCallId 或 artifactId 继续；若需要复用返回的历史图片或文档，直接传对应 artifactId，不要再调用额外选择工具。',
      mustNotAssume:['Conversation Summary 不是逐条历史消息原文；已被裁剪的消息不能凭摘要还原。', '历史工具 output 不是当前外部系统的最新查询结果；需要当前状态时仍须调用对应读取工具。', '查询或引用 Artifact 不等于已插入文档、已发布或已向用户交付。'],
    },
    search_project_knowledge: {
      meaning:'这是项目级知识检索：projectId 非空时，items 是该项目的项目事实（source=project_facts）和项目级知识；projectId 为空时，items 是跨项目的项目级知识，不生成项目事实。它们不是当前执行状态、Plan 完成状态、Artifact 交付状态或历史对话。',
      nextStep:'需要方案、事实来源或正文证据时使用这些条目；必要时根据 sourceUrl 读取明确文档。',
      mustNotAssume:['不得以知识库记录推翻同轮历史 Plan、Run 或 Artifact 的真实执行事实。', '检索到知识不等于已执行其中描述的动作。'],
    },
    search_item_knowledge: {
      meaning:'items 是当前事项范围内的检索证据。source=item_facts 是当前事项事实，source=knowledge 是该事项知识；不会包含项目级或其他事项知识。',
      nextStep:'仅用这些条目处理当前事项；需要项目整体信息时调用 search_project_knowledge。',
      mustNotAssume:['事项知识不能代表项目整体状态。', '检索到知识不等于已执行其中描述的动作。'],
    },
    search_memory: {
      meaning:'items 是当前适用的记忆。source=conversation_summary 是当前项目或事项已压缩的更早对话交接；其他项是长期记忆，scope 说明其来自 global、project 或 item。data_recovery_profile 的 data 是可显式复制到后续工具的已确认参数。',
      nextStep:'仅依据返回的 summary、statement、data 和 scope 继续；需要更多材料时调用对应知识检索。',
      mustNotAssume:['未返回的记忆或对话摘要不能视为存在或适用。', 'Conversation Summary 和长期记忆都不等于当前 Plan 或外部交付已经完成。'],
    },
    create_feishu_document: {
      meaning:'documentUrl 是本次已经创建成功的飞书文档地址，且 Result artifacts 中有对应 feishu_document Artifact。',
      nextStep:'若需继续写入或插图，使用该 documentUrl；若本轮最终目标是向用户交付链接，最终回复应实际引用该 URL。',
      mustNotAssume:['创建文档不等于已写完、已插图或已向用户交付。'],
    },
    append_feishu_document: {
      meaning:'documentUrl 指向本次已成功追加的飞书文档，Result artifacts 记录该更新事实。',
      nextStep:'如需验证正文或图片结果，读取同一 documentUrl；需要交付时在最终回复实际引用该 URL。',
      mustNotAssume:['追加文档不等于用户已经收到链接。'],
    },
    replace_feishu_document_text: {
      meaning:'documentUrl 指向本次已按 originalText 精确替换的飞书文档；Result artifacts 记录该局部修改事实。',
      nextStep:'如需确认替换结果，读取同一 documentUrl；若原文不唯一或需要按章节、块级重排，应先取得更精确的文档结构信息，不要改为追加。',
      mustNotAssume:['局部替换不等于整篇文档已重写。', '不得把 append 当作对既有正文的修改。'],
    },
    replace_feishu_document_blocks: {
      meaning:'documentUrl 指向本次已按 blockId 精确替换的飞书文档，updatedBlockIds 是实际操作的块。',
      nextStep:'读取同一文档的 block 结构核验实际内容；如需插入新 demo 图片，使用受管图片 Artifact 再调用插图工具。',
      mustNotAssume:['block_replace 成功不等于未核验的其他段落或图片也已更新。', '不得用 append 代替指定 block 的修改。'],
    },
    replace_feishu_document_images: {
      meaning:'replacedImageBlockIds 是已删除并由受管 Artifact 新图替代的旧图片 block；failures 表示未完成或可能产生重复图片的替换项。',
      nextStep:'读取同一文档的目标区域，核验新图在正确位置、旧图已消失；failures 非空时先处理实际残留，不要整批盲重试。',
      mustNotAssume:['插入新图不等于旧图已经删除。', '不得用文末插图代替已有图片的替换。'],
    },
    insert_document_images: {
      meaning:'count、insertedArtifactIds 和 failures 描述本次图片插入结果；partial 表示部分图片已插入，不能当作完全失败。',
      nextStep:'若 failures 非空，披露失败并决定补救；需要确认视觉交付时读取同一文档。',
      mustNotAssume:['图片插入不等于最终文档已向用户交付。', 'partial 不等于所有图片均成功插入。'],
    },
    write_local_knowledge: {
      meaning:'knowledgeId、projectId 和 initiativeId 标识已持久化的本地知识库记录；sourceUrl 仅在调用时提供来源时存在。',
      nextStep:'后续需要使用该材料时，通过对应的项目或事项知识检索工具按标题或关键词检索。',
      mustNotAssume:['写入知识库不等于源文档已被完整读取、外部交付已完成或记录中的计划已经执行。'],
    },
    save_knowledge_artifact: {
      meaning:'knowledgeId 和 sourceUrl 是历史兼容路径保存的知识记录。',
      nextStep:'后续需要使用该材料时通过知识库检索或明确 sourceUrl 读取。',
      mustNotAssume:['保存知识摘要不等于源文档已被完整读取或外部交付已完成。'],
    },
    update_long_term_memory: {
      meaning:'memoryId 表示用户明确确认的信息已写入长期记忆；其 scope 和 type 决定后续 Context 的适用范围。',
      nextStep:'继续处理当前任务；不要重复写入同一条稳定信息。',
      mustNotAssume:['长期记忆写入不等于项目状态、Plan 或外部交付物已修改。'],
    },
    create_execution_plan: {
      meaning:'planRef 是当前 Run 唯一可更新的 Plan 版本；completionChecklist 和 obligations 是该 Plan 的真实完成状态来源。',
      nextStep:'后续更新必须携带该 planId 与 revision；引用历史 Plan 时仅可使用本轮 query_agent_history 返回的 planId。',
      mustNotAssume:['创建 Plan 不等于底层工作已执行。', '历史 Plan 的 inheritedChecklist 仅是审计快照，不自动替代当前 Plan 的 checklist。', 'open obligation 存在时不得宣布目标完成。'],
    },
    update_execution_plan: {
      meaning:'planRef、completionChecklist、obligations、missingActions 和 nextAction 是当前 Plan 更新后的真实状态。',
      nextStep:'若 goalCompleted=false，继续处理 missingActions 或 nextAction；若 goalCompleted=true，基于真实 Artifact 和最终回复完成交付。',
      mustNotAssume:['模型提出 goalCompleted 不等于系统已接受完成。', 'completionRejected=true 时不得宣称目标完成。'],
    },
  };
  return guidanceByTool[result?.name] || {
    meaning:'该 Tool Result 包含本次工具实际返回的结构化事实。',
    nextStep:'仅根据 status、data、artifacts、missing 和 error 决定后续动作。',
    mustNotAssume:['不得把未在 Result 中出现的外部执行、资源或状态当作已完成。'],
  };
}

function normalizeMetricGroups(metricGroups) {
  return Array.isArray(metricGroups) ? metricGroups.map((group) => ({
    name:String(group?.name || '').trim(),
    metrics:Array.isArray(group?.metrics) ? group.metrics.map((metric) => String(metric || '').trim()).filter(Boolean) : [],
  })).filter((group) => group.name && group.metrics.length) : [];
}

function saveKnowledgeArtifact(state, projectId, args, fallbackInitiativeId = '') {
  const project = findProject(state, projectId);
  if (!project) throw Object.assign(new Error('项目不存在，无法写入本地知识库。'), { statusCode:422 });
  const initiativeId=String(args.initiativeId || fallbackInitiativeId || '');
  if (initiativeId && !(project.initiatives || []).some((initiative) => initiative.id === initiativeId)) throw Object.assign(new Error('initiativeId 不属于目标项目，无法写入本地知识库。'), { statusCode:422 });
  const now=new Date().toISOString();
  const item = {
    id:`k-local-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    projectId,
    initiativeId,
    type:args.type,
    title:String(args.title).slice(0,240),
    summary:String(args.summary).slice(0,2000),
    content:String(args.content).slice(0,MAX_LINK_CONTENT_CHARS),
    sourceUrl:String(args.sourceUrl || ''),
    imageUrl:String(args.imageUrl || ''),
    createdAt:now,
    updatedAt:now,
    sourceType:'agent_written',
  };
  state.knowledgeItems ||= [];
  state.knowledgeItems.unshift(item);
  return item;
}

function managedAssetAbsolutePath(filePath) {
  const input = String(filePath || '');
  const absolute = path.isAbsolute(input) ? path.resolve(input) : input.replace(/\\/g, '/').startsWith('data/assets/') ? path.resolve(ASSET_DIR, input.replace(/\\/g, '/').slice('data/assets/'.length)) : path.resolve(ROOT, input);
  if (!absolute.startsWith(`${ASSET_DIR}${path.sep}`)) throw Object.assign(new Error('图片必须位于受管 data/assets 目录。'), { statusCode:422 });
  return absolute;
}

function relativeManagedAssetPath(filePath) {
  const absolute = managedAssetAbsolutePath(filePath);
  return path.join('data', 'assets', path.relative(ASSET_DIR, absolute));
}

function registerMediaAsset(state, { projectId = '', initiativeId = '', conversationId = '', filePath, assetUrl = '', mimeType = '', filename = '', title = '', source = 'imported', createdBy = 'system', runId = '' }) {
  normalizeMediaAssets(state);
  const relativePath = relativeManagedAssetPath(filePath);
  const existing = state.mediaAssets.find((asset) => asset.projectId === projectId && asset.initiativeId === initiativeId && String(asset.conversationId || '') === String(conversationId || '') && asset.filePath === relativePath);
  if (existing) return existing;
  const asset = {
    id:`media-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    projectId, initiativeId, conversationId, filePath:relativePath,
    assetUrl:assetUrl || `/${relativePath.split(path.sep).join('/')}`,
    mimeType, filename:filename || path.basename(relativePath), title:title || path.basename(relativePath),
    source, createdAt:new Date().toISOString(), createdBy, runId,
  };
  state.mediaAssets.unshift(asset);
  state.mediaAssets = state.mediaAssets.slice(0, 500);
  return asset;
}

async function resolveInitiativeMediaAssets(state, { projectId, initiativeId, imageAssetIds }) {
  normalizeMediaAssets(state);
  const requested = Array.isArray(imageAssetIds) ? imageAssetIds.map(String) : [];
  if (!requested.length) throw Object.assign(new Error('imageAssetIds 至少需要一张图片。'), { statusCode:422 });
  const scopeLabel = initiativeId ? '当前事项' : '当前项目';
  const assets = [];
  for (const id of requested) {
    const asset = state.mediaAssets.find((item) => item.id === id && item.projectId === projectId && item.initiativeId === initiativeId);
    if (!asset) throw Object.assign(new Error(`图片资产 ${id} 不属于${scopeLabel}或不存在。`), { statusCode:422 });
    const relativePath = relativeManagedAssetPath(asset.filePath);
    const file = await fs.stat(managedAssetAbsolutePath(relativePath)).catch(() => null);
    if (!file?.isFile() || file.size <= 0) throw Object.assign(new Error(`图片资产 ${id} 的本地文件不存在或无效。`), { statusCode:422 });
    assets.push({ ...asset, filePath:relativePath });
  }
  return assets;
}

async function resolveChatImageAttachments(state, { projectId = '', initiativeId = '', conversationId = '', imageAssetIds }) {
  normalizeMediaAssets(state);
  const requested = [...new Set(Array.isArray(imageAssetIds) ? imageAssetIds.map(String).filter(Boolean) : [])];
  if (requested.length > 4) throw Object.assign(new Error('一次最多上传 4 张图片。'), { statusCode:422 });
  const attachments = [];
  for (const id of requested) {
    const asset = state.mediaAssets.find((item) => item.id === id && item.projectId === projectId && item.initiativeId === initiativeId && String(item.conversationId || '') === String(conversationId || ''));
    if (!asset) throw Object.assign(new Error(`图片资产 ${id} 不属于当前讨论范围或不存在。`), { statusCode:422 });
    const relativePath = relativeManagedAssetPath(asset.filePath);
    const buffer = await fs.readFile(managedAssetAbsolutePath(relativePath)).catch(() => null);
    if (!buffer?.length || buffer.length > MAX_MEDIA_UPLOAD_BYTES) throw Object.assign(new Error(`图片资产 ${id} 的本地文件无效或超过 10MB 限制。`), { statusCode:422 });
    if (!/^image\/(png|jpeg|webp|gif)$/i.test(asset.mimeType || '')) throw Object.assign(new Error(`图片资产 ${id} 的格式不受支持。`), { statusCode:422 });
    attachments.push({ id:asset.id, title:String(asset.title || asset.filename || '图片').slice(0,240), mimeType:asset.mimeType, assetUrl:asset.assetUrl, dataUrl:`data:${asset.mimeType};base64,${buffer.toString('base64')}` });
  }
  return attachments;
}

async function resolveImageArtifactsForTask(state, { projectId, initiativeId, run, artifactIds }) {
  normalizeArtifactRegistry(state);
  const requested = Array.isArray(artifactIds) ? artifactIds.map(String) : [];
  if (!requested.length) throw Object.assign(new Error('artifactIds 至少需要一张图片 Artifact。'), { statusCode:422 });
  const scopeLabel = initiativeId ? '当前事项' : '当前项目';
  const selectedIds = new Set((run?.selectedArtifactRefs || []).map((item) => String(item.id)));
  const mediaAssetIds = [];
  for (const id of requested) {
    const artifact = state.artifacts.find((item) => item.id === id && item.projectId === projectId);
    if (!artifact) throw Object.assign(new Error(`Artifact ${id} 不属于当前项目或不存在。`), { statusCode:422 });
    if (artifact.type !== 'image') throw Object.assign(new Error(`Artifact ${id} 不是图片，不能插入文档。`), { statusCode:422 });
    if (artifact.initiativeId !== initiativeId) throw Object.assign(new Error(`Artifact ${id} 不属于${scopeLabel}。`), { statusCode:422 });
    if (artifact.integrityStatus !== 'verified') throw Object.assign(new Error(`Artifact ${id} 未通过完整性校验，不能插入文档。`), { statusCode:422 });
    if (artifact.runId !== run?.id && !selectedIds.has(id)) throw Object.assign(new Error(`Artifact ${id} 是历史产物，需先通过本轮 query_agent_history 返回。`), { statusCode:422 });
    const mediaAssetId = String(artifact.locator?.mediaAssetId || '');
    if (!mediaAssetId) throw Object.assign(new Error(`Artifact ${id} 缺少可用的受管媒体资产。`), { statusCode:422 });
    mediaAssetIds.push(mediaAssetId);
  }
  return resolveInitiativeMediaAssets(state, { projectId, initiativeId, imageAssetIds:mediaAssetIds });
}

function decodeImageDataUrl(value) {
  const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([a-z0-9+/=\s]+)$/i.exec(String(value || ''));
  if (!match) throw Object.assign(new Error('仅支持 PNG、JPEG、WebP 或 GIF 图片数据。'), { statusCode:422 });
  const buffer = Buffer.from(match[2].replace(/\s+/g, ''), 'base64');
  if (!buffer.length || buffer.length > MAX_MEDIA_UPLOAD_BYTES) throw Object.assign(new Error('图片为空或超过 10MB 限制。'), { statusCode:422 });
  const extension = { 'image/png':'png', 'image/jpeg':'jpg', 'image/webp':'webp', 'image/gif':'gif' }[match[1].toLowerCase()];
  return { buffer, mimeType:match[1].toLowerCase(), extension };
}

function buildReadWebPageToolResult(content) { const title=String(content?.title || '网页'); return { title, data:{ url:String(content?.url || ''), title, contentExcerpt:String(content?.text || ''), fetchedAt:String(content?.fetchedAt || ''), truncated:Boolean(content?.truncated) } }; }

function buildReadFeishuDocumentToolResult(documentUrl, content) {
  const title = String(content?.title || '飞书文档');
  const truncated = Boolean(content?.truncated);
  return {
    title,
    data:{ documentUrl, title, contentExcerpt:String(content?.text || ''), blocks:Array.isArray(content?.blocks) ? content.blocks : [], truncated },
  };
}

async function createFeishuDocument({ title, content }) {
  const { stdout } = await execFileAsync('lark-cli', ['docs','+create','--api-version','v2','--as','user','--content', `<title>${escapeDocXml(title)}</title>${content}`, '--format','json'], { timeout:30000, maxBuffer:2*1024*1024 });
  const url = findDocumentUrl(JSON.parse(stdout));
  if (!url) throw new Error('飞书文档已创建，但 CLI 返回中未找到文档地址。');
  return { url, status:'created' };
}

async function appendFeishuDocument({ documentUrl, content }) {
  const externalResult = await runFeishuUpdate(['docs','+update','--api-version','v2','--as','user','--doc',documentUrl,'--command','append','--content',content,'--format','json'], '文档追加');
  return { url:documentUrl, status:'updated', externalResult };
}

async function replaceFeishuDocumentText({ documentUrl, originalText, replacement }) {
  if (!isFeishuDocumentUrl(documentUrl)) throw Object.assign(new Error('documentUrl 必须是有效的飞书文档 URL。'), { statusCode:422 });
  if (!String(originalText || '').trim()) throw Object.assign(new Error('originalText 必须是文档中明确、非空的待替换原文。'), { statusCode:422 });
  if (/\r|\n/.test(String(originalText))) throw Object.assign(new Error('replace_feishu_document_text 仅支持单个 block 内的行内替换；跨段落内容请先读取 blockId 并使用 replace_feishu_document_blocks。'), { statusCode:422 });
  const externalResult = await runFeishuUpdate(['docs','+update','--api-version','v2','--as','user','--doc',documentUrl,'--command','str_replace','--pattern',originalText,'--content',replacement,'--format','json'], '文档局部替换');
  return { url:documentUrl, status:'updated', externalResult };
}

async function replaceFeishuDocumentBlocks({ documentUrl, blocks }) {
  if (!isFeishuDocumentUrl(documentUrl)) throw Object.assign(new Error('documentUrl 必须是有效的飞书文档 URL。'), { statusCode:422 });
  if (!Array.isArray(blocks) || !blocks.length) throw Object.assign(new Error('blocks 至少需要一个带 blockId 和 content 的替换项。'), { statusCode:422 });
  const updated = [];
  for (const item of blocks) {
    const blockId = String(item?.blockId || '').trim();
    if (!blockId) throw Object.assign(new Error('每个替换项都必须提供从 read_feishu_document(includeBlockIds=true) 获取的 blockId。'), { statusCode:422 });
    await runFeishuUpdate(['docs','+update','--api-version','v2','--as','user','--doc',documentUrl,'--command','block_replace','--block-id',blockId,'--content',String(item?.content ?? ''),'--format','json'], `block ${blockId} 替换`);
    updated.push(blockId);
  }
  return { url:documentUrl, status:'updated', updatedBlockIds:updated };
}

async function replaceFeishuDocumentImages({ documentUrl, replacements, assets }) {
  if (!isFeishuDocumentUrl(documentUrl)) throw Object.assign(new Error('documentUrl 必须是有效的飞书文档 URL。'), { statusCode:422 });
  const assetById = new Map((assets || []).flatMap((asset) => [[asset.id, asset], [asset.artifactId, asset]].filter(([id]) => id)));
  const replaced = [];
  const failures = [];
  for (const item of replacements || []) {
    const imageBlockId = String(item?.imageBlockId || '').trim();
    const artifactId = String(item?.artifactId || '').trim();
    const anchorText = String(item?.anchorText || '').trim();
    const asset = assetById.get(artifactId);
    if (!imageBlockId || !anchorText || !asset) {
      failures.push({ imageBlockId, artifactId, error:'每项必须包含已读取的 imageBlockId、唯一 anchorText 和当前任务可用的图片 Artifact。' });
      continue;
    }
    try {
      const { stdout } = await execFileAsync('lark-cli', ['docs','+media-insert','--as','user','--doc',documentUrl,'--file',asset.filePath,'--selection-with-ellipsis',anchorText,'--before','--align','center','--caption',String(item.caption || asset.filename || ''),'--format','json'], { timeout:60000, maxBuffer:2*1024*1024, cwd:WORKSPACE_ROOT });
      const inserted = JSON.parse(stdout);
      await runFeishuUpdate(['docs','+update','--api-version','v2','--as','user','--doc',documentUrl,'--command','block_delete','--block-id',imageBlockId,'--format','json'], `图片 block ${imageBlockId} 删除`);
      replaced.push({ imageBlockId, artifactId, insertedBlockId:inserted?.data?.block_id || inserted?.data?.blockId || '' });
    } catch (error) {
      failures.push({ imageBlockId, artifactId, error:publicErrorMessage(error) });
    }
  }
  if (!replaced.length && failures.length) throw Object.assign(new Error(failures.map((item) => `${item.imageBlockId || item.artifactId}: ${item.error}`).join('\n')), { statusCode:502, retryable:false });
  return { url:documentUrl, replaced, failures };
}

async function insertDocumentImages({ documentUrl, assets }) {
  const inserted = [];
  const failures = [];
  for (const asset of assets) {
    try {
      const { stdout } = await execFileAsync('lark-cli', ['docs','+media-insert','--as','user','--doc',documentUrl,'--file',asset.filePath,'--align','center','--caption',asset.filename,'--format','json'], { timeout:60000, maxBuffer:2*1024*1024, cwd:WORKSPACE_ROOT });
      inserted.push({ assetId:asset.id, response:JSON.parse(stdout) });
    } catch (error) {
      failures.push({ assetId:asset.id, error:publicErrorMessage(error) });
    }
  }
  if (!inserted.length && failures.length) throw Object.assign(new Error(failures.map((item) => `${item.assetId}: ${item.error}`).join('\n')), { statusCode:502, retryable:false });
  return { url:documentUrl, inserted, failures };
}

async function executeAgentCallOnce({ state, projectId, initiativeId, run, plan, call, resultIndex, onResult, executionDeadline = null }) {
    const args = call.args || {};
    const result = { name:call.name, status:'completed', title:args.title || call.name, note:'', data:null, artifacts:[], missing:[] };
    try {
      if (call.name === 'search_workspace') {
        const items=searchWorkspace(state, { query:String(args.query || ''), sources:args.sources, includeContent:Boolean(args.includeContent), limit:args.limit });
        result.title=`工作区检索：${args.query}`; result.note=items.length ? `找到 ${items.length} 条跨项目/事项的只读证据。` : '未找到匹配的工作区证据。'; result.data={ items };
      } else if (call.name === 'inspect_cli_help') {
        const cli = String(args.cli || '');
        const argvPrefix = Array.isArray(args.argvPrefix) ? args.argvPrefix : [];
        const cacheKey = cliHelpCacheKey(cli, argvPrefix);
        const cached = readCliHelpCache(state, cacheKey);
        const inspected = cached
          ? { definition:registeredCli(cli), data:{ ...cached.data, cached:true, cacheExpiresAt:new Date(cached.expiresAt).toISOString() } }
          : await runRegisteredCli(cli, argvPrefix, { help:true });
        const cacheEntry = cached || writeCliHelpCache(state, cacheKey, inspected.data);
        rememberRunCliHelp(run, { cli, argvPrefix, data:inspected.data, cachedAt:cacheEntry.cachedAt, expiresAt:cacheEntry.expiresAt });
        result.title = `${args.cli} 帮助`;
        result.note = inspected.data.cached ? `已复用 ${args.cli} 的缓存 --help。` : `已读取 ${args.cli} 的真实 --help。`;
        result.data = { ...inspected.data, capabilities:inspected.definition.capabilities, riskLevel:inspected.definition.riskLevel };
      } else if (call.name === 'search_skills') {
        const found = await skillLibrary.searchSkills(SKILLS_DIR, { query:String(args.query || ''), parentSkillPath:String(args.parentSkillPath || ''), limit:args.limit });
        rememberRunDiscoveredSkills(run, found);
        result.title = found.level === 'parent' ? `父 Skill 检索：${args.query || '全部'}` : `子 Skill 检索：${found.parent?.title || ''}`;
        result.note = found.items.length ? `找到 ${found.items.length} 条 ${found.level === 'parent' ? '父' : '子'} Skill。` : '未找到匹配的 Skill。';
        result.data = found;
      } else if (call.name === 'execute_cli') {
        const executed = await runRegisteredCli(String(args.cli || ''), args.argv);
        result.title = `${args.cli} 命令执行`;
        result.status = executed.status;
        result.note = executed.status === 'partial' ? `${args.cli} 已以部分成功状态完成。` : `${args.cli} 已以退出码 0 完成，且外部响应未报告失败。`;
        result.data = executed.data;
        result.artifacts.push(...await collectRegisteredCliArtifacts({ state, projectId, initiativeId, runId:run.id, definition:executed.definition, argv:executed.rawArgv, outputSpec:args.outputSpec }));
      } else if (call.name === 'create_execution_plan') {
        if (run.planRef?.planId) {
          const current = state.agentPlans?.find((item) => item.id === run.planRef.planId) || plan;
          result.status = 'conflict';
          result.title = current?.goal || 'Execution Plan 已绑定';
          result.note = '当前 Run 已绑定 Execution Plan；请使用 update_execution_plan 并携带当前 planId 与 revision。';
          result.data = { planRef:run.planRef, plan:current ? { id:current.id, revision:current.revision, status:current.status, completionChecklist:current.completionChecklist } : null, allowedOperations:['update_execution_plan'] };
        } else {
          plan = createExecutionPlan(state, projectId, initiativeId, args);
          mergePlanObligations(plan, run.pendingObligations || []);
          run.pendingObligations = [];
          run.planId = plan.id;
          run.planRef = { planId:plan.id, revision:Number(plan.revision || 1) };
          result.title = plan.goal;
          result.note = `已创建执行计划，完成清单 ${plan.doneCriteria.length} 项。`;
          result.data = { planRef:run.planRef, completionChecklist:plan.completionChecklist, obligations:plan.obligations || [] };
        }
      } else if (call.name === 'update_execution_plan') {
        const current = run.planRef?.planId ? state.agentPlans?.find((item) => item.id === run.planRef.planId) : null;
        if (!current) {
          result.status = 'conflict';
          result.note = '当前 Run 未绑定 Execution Plan，不能更新。';
          result.data = { planRef:run.planRef || null, allowedOperations:['create_execution_plan'] };
        } else if (String(args.planId || '') !== current.id || Number(args.revision) !== Number(current.revision || 1)) {
          result.status = 'conflict';
          result.title = current.goal;
          result.note = 'Execution Plan 引用或版本已过期；请读取当前 planRef 后重新提交更新。';
          result.data = { planRef:{ planId:current.id, revision:current.revision }, completionChecklist:current.completionChecklist };
        } else {
          plan = current;
          updateExecutionPlan(plan, args);
          run.planId = plan.id;
          run.planRef = { planId:plan.id, revision:Number(plan.revision || 1) };
          run.goalStatus = plan.status;
          result.title = plan.goal;
          result.status = plan.goalCompleted ? 'completed' : 'partial';
          result.note = plan.goalCompleted ? '完成清单已全部完成。' : `目标尚未完成：${plan.missingActions.join('；') || plan.nextAction}`;
          result.data = { planRef:run.planRef, goalCompleted:plan.goalCompleted, completionRejected:plan.completionRejected, completionChecklist:plan.completionChecklist, obligations:plan.obligations || [], missingActions:plan.missingActions, nextAction:plan.nextAction, userFacingReply:String(args.userFacingReply || '').trim() };
        }
      } else if (call.name === 'update_long_term_memory') {
        const update = normalizeMemoryUpdate(args, findProject(state, projectId), initiativeId);
        if (!update) throw Object.assign(new Error('Long-term Memory 参数不完整或不符合确认边界。'), { statusCode:422 });
        const record = applyModelMemoryUpdate(state, update);
        result.title = `Long-term Memory：${record.type}`;
        result.note = record.statement || '已更新用户确认的长期记忆。';
        result.data = { memoryId:record.id, type:record.type };
      } else if (call.name === 'read_experiment_metadata') {
        const metadata = await readExperimentMetadata(args.experimentId);
        result.title = metadata.title;
        result.note = `实验完整自然日查询窗口：${metadata.startDate} 至 ${metadata.endDate}。`;
        result.data = { experimentId:metadata.experimentId, title:metadata.title, startDate:metadata.startDate, endDate:metadata.endDate, appId:metadata.appId, baseVersionId:metadata.baseVersionId, baselineVersion:metadata.baselineVersion, experimentVersions:metadata.experimentVersions, experimentVersionIds:metadata.experimentVersionIds };
      } else if (call.name === 'resolve_metric_specs') {
        const groups = normalizeMetricGroups(args.metricGroups);
        if (!groups.length) throw Object.assign(new Error('resolve_metric_specs 必须提供 metricGroups。'), { statusCode:422 });
        const specs = [];
        for (const group of groups) specs.push({ name:group.name, ...(await resolveLibraMetricGroup({ experimentId:String(args.experimentId || ''), groupName:group.name, metricNames:group.metrics })) });
        result.title = `指标规格：${args.experimentId}`;
        result.note = `已解析 ${specs.reduce((total, group) => total + group.metrics.length, 0)} 个指标。`;
        result.data = { experimentId:String(args.experimentId || ''), metricGroups:specs };
      } else if (call.name === 'query_metric_data') {
        const groups = normalizeMetricGroups(args.metricGroups);
        const versionIds = normalizeExperimentVersionIds(args.experimentVersionIds);
        if (!groups.length || !versionIds.length || !args.freshnessPolicy || typeof args.freshnessPolicy !== 'object') throw Object.assign(new Error('query_metric_data 必须显式传入 metricGroups、experimentVersionIds 和 freshnessPolicy。'), { statusCode:422 });
        const report = await queryLibraMetricData({ experimentId:String(args.experimentId || ''), metricGroups:groups, experimentVersionIds:versionIds, freshnessPolicy:args.freshnessPolicy });
        report.projectId = projectId; report.initiativeId = initiativeId;
        state.dataRecoveryReports ||= []; state.dataRecoveryReports.unshift(report); state.dataRecoveryReports = state.dataRecoveryReports.slice(0,50);
        result.title = report.title;
        result.status = report.status === 'completed' ? 'completed' : report.status === 'partial' ? 'partial' : 'blocked';
        result.note = report.note;
        result.data = { reportId:report.id, experimentId:report.experimentId, experimentVersions:report.experiment.experimentVersions, dataLatestDate:report.dataLatestDate, isLatest:report.isLatest, continuation:report.continuation, deliveryDisclosure:report.deliveryDisclosure, metricResults:report.metricResults };
        if (report.deliveryDisclosure?.requiredText) result.obligations = [{ kind:'disclosure', instruction:report.deliveryDisclosure.requiredText, evidence:report.deliveryDisclosure.completionNote || '' }];
        result.artifacts.push(toolArtifact('metric_query', report.title, { reportId:report.id, experimentId:report.experimentId }));
      } else if (call.name === 'check_experiment_recycle') {
        const recycle = await checkExperimentRecycle(args.experimentId);
        result.title = `实验回收检查：${args.experimentId}`;
        result.note = recycle.summary;
        result.data = recycle;
      } else if (call.name === 'capture_metric_snapshot') {
        const snapshot = await captureLibraMetricSnapshot(state, projectId, { ...args, experimentId:String(args.experimentId || '') });
        const mediaAsset = registerMediaAsset(state, { projectId, initiativeId, filePath:snapshot.filePath, assetUrl:snapshot.assetUrl, mimeType:'image/png', title:snapshot.title, source:'agent_generated', createdBy:'agent', runId:run.id });
        result.title = snapshot.title;
        result.note = snapshot.note;
        result.data = { imageUrl:snapshot.assetUrl, filePath:snapshot.filePath, mediaAssetId:mediaAsset.id };
        result.artifacts.push(toolArtifact('image', snapshot.title, { imageUrl:snapshot.assetUrl, filePath:snapshot.filePath, mediaAssetId:mediaAsset.id }));
      } else if (call.name === 'read_web_page') {
        const url = String(args.url || '');
        if (isFeishuDocumentUrl(url)) throw Object.assign(new Error('飞书 Docx/Wiki 请使用 read_feishu_document。'), { statusCode:422 });
        const content = await fetchPublicLinkContent(url);
        Object.assign(result, buildReadWebPageToolResult(content));
        delete result.note;
        delete result.summary;
      } else if (call.name === 'read_feishu_document') {
        const documentUrl = String(args.documentUrl || '');
        if (!isFeishuDocumentUrl(documentUrl)) throw Object.assign(new Error('documentUrl 必须是有效的飞书文档 URL。'), { statusCode:422 });
        const content = await fetchFeishuDocumentContent(documentUrl, { includeBlockIds:Boolean(args.includeBlockIds), blockQuery:String(args.blockQuery || '') });
        Object.assign(result, buildReadFeishuDocumentToolResult(documentUrl, content));
        delete result.note;
        delete result.summary;
      } else if (call.name === 'query_agent_history') {
        const requestedInitiativeId = String(args.initiativeId || initiativeId || '');
        if (requestedInitiativeId && initiativeId && requestedInitiativeId !== initiativeId) throw Object.assign(new Error('历史查询只能限定当前事项，或在项目级对话中不传 initiativeId。'), { statusCode:422 });
        const items = queryAgentHistory(state, { projectId, initiativeId:requestedInitiativeId, query:String(args.query || ''), sources:args.sources, limit:args.limit });
        const artifactIds = new Set(items.flatMap((item) => [
          item.recordRef?.artifactId,
          ...(item.artifactRefs || []).map((artifact) => artifact.artifactId),
        ]).filter(Boolean));
        run.selectedArtifactRefs ||= [];
        for (const artifactId of artifactIds) {
          const artifact = state.artifacts.find((entry) => entry.id === artifactId && entry.projectId === projectId);
          if (!artifact || artifact.integrityStatus !== 'verified') continue;
          const reference = selectedArtifactReference(artifact, `query_agent_history: ${String(args.query || '').slice(0, 300)}`);
          const index = run.selectedArtifactRefs.findIndex((entry) => entry.id === artifact.id);
          if (index >= 0) run.selectedArtifactRefs[index] = reference;
          else run.selectedArtifactRefs.push(reference);
        }
        result.title = `Agent 历史查询：${args.query}`;
        result.note = items.length ? `找到 ${items.length} 条历史执行记录。` : '未找到匹配的历史执行记录。';
        result.data = { items };
      } else if (call.name === 'search_artifacts') {
        const requestedInitiativeId = String(args.initiativeId || initiativeId || '');
        if (requestedInitiativeId && requestedInitiativeId !== initiativeId) throw Object.assign(new Error('历史 Artifact 检索只能使用当前事项，或在项目级对话中不传 initiativeId。'), { statusCode:422 });
        const items = searchArtifacts(state, { projectId, initiativeId:requestedInitiativeId, query:String(args.query || ''), types:args.types, limit:args.limit });
        result.title = `Artifact 检索：${args.query}`;
        result.note = items.length ? `找到 ${items.length} 个可选 Artifact。` : '未找到匹配的可用 Artifact。';
        result.data = { items };
      } else if (call.name === 'select_artifacts_for_task') {
        normalizeArtifactRegistry(state);
        const requested = Array.isArray(args.artifactIds) ? args.artifactIds.map(String) : [];
        if (!requested.length) throw Object.assign(new Error('artifactIds 至少需要一个 Artifact。'), { statusCode:422 });
        const selected = [];
        for (const id of requested) {
          const artifact = state.artifacts.find((item) => item.id === id && item.projectId === projectId);
          if (!artifact) throw Object.assign(new Error(`Artifact ${id} 不属于当前项目或不存在。`), { statusCode:422 });
          if (initiativeId && artifact.initiativeId && artifact.initiativeId !== initiativeId) throw Object.assign(new Error(`Artifact ${id} 不属于当前事项。`), { statusCode:422 });
          if (artifact.integrityStatus !== 'verified') throw Object.assign(new Error(`Artifact ${id} 未通过完整性校验，不能直接用于正式交付。`), { statusCode:422 });
          selected.push(artifact);
        }
        run.selectedArtifactRefs ||= [];
        const purpose = String(args.purpose || '').trim().slice(0,500);
        for (const artifact of selected) {
          const reference = selectedArtifactReference(artifact, purpose);
          const index = run.selectedArtifactRefs.findIndex((item) => item.id === artifact.id);
          if (index >= 0) run.selectedArtifactRefs[index] = reference;
          else run.selectedArtifactRefs.push(reference);
        }
        result.title = '已绑定历史 Artifact';
        result.note = `已为本次任务绑定 ${selected.length} 个 Artifact。`;
        result.data = { items:run.selectedArtifactRefs };
      } else if (call.name === 'search_project_history') {
        const requestedInitiativeId = String(args.initiativeId || initiativeId || '');
        if (requestedInitiativeId && initiativeId && requestedInitiativeId !== initiativeId) throw Object.assign(new Error('历史检索只能限定当前事项，或在项目级对话中不传 initiativeId。'), { statusCode:422 });
        const items = searchProjectHistory(state, { projectId, initiativeId:requestedInitiativeId, query:String(args.query || ''), kinds:args.kinds, limit:args.limit });
        result.title = `历史检索：${args.query}`;
        result.note = items.length ? `找到 ${items.length} 条相关历史记录。` : '未找到匹配的项目历史。';
        result.data = { items };
      } else if (call.name === 'search_project_knowledge') {
        const contentScope=resolveContentReadScope(state, { conversationProjectId:projectId, conversationInitiativeId:initiativeId, requestedProjectId:args.projectId });
        const project=contentScope.projectId ? findProject(state, contentScope.projectId) : null;
        const selected = searchKnowledge(state, { projectId:contentScope.projectId, initiativeIds:[''], query:args.query, types:args.types, includeContent:Boolean(args.includeContent), factsCard:project ? projectFactsCard(project) : null });
        result.title = contentScope.projectId ? `项目知识库检索：${args.query}` : `全项目知识库检索：${args.query}`;
        result.note = selected.length ? `找到 ${selected.length} 条${contentScope.projectId ? '项目事实或项目级知识' : '项目级知识'}。` : '未找到匹配的项目级知识。';
        result.data = { projectId:contentScope.projectId, contentScope:contentScope.label, items:selected };
      } else if (call.name === 'search_item_knowledge') {
        const contentScope=resolveContentReadScope(state, { conversationProjectId:projectId, conversationInitiativeId:initiativeId, requestedProjectId:args.projectId, requestedInitiativeId:args.initiativeId });
        const scopeProject=contentScope.projectId ? findProject(state, contentScope.projectId) : null;
        const factProjects=scopeProject ? [scopeProject] : state.projects || [];
        const itemInitiativeIds=contentScope.initiativeIds === null ? factProjects.flatMap((candidate) => (candidate.initiatives || []).map((item) => String(item.id || '')).filter(Boolean)) : contentScope.initiativeIds;
        const factsCards=factProjects.flatMap((candidate) => (candidate.initiatives || []).filter((item) => itemInitiativeIds.includes(item.id)).map(itemFactsCard));
        const selected = searchKnowledge(state, { projectId:contentScope.projectId, initiativeIds:itemInitiativeIds, query:args.query, types:args.types, includeContent:Boolean(args.includeContent), factsCards });
        result.title = `事项知识检索：${args.query}`;
        result.note = selected.length ? `找到 ${selected.length} 条事项事实或事项级知识。` : '未找到匹配的事项事实或事项级知识。';
        result.data = { projectId:contentScope.projectId, initiativeIds:itemInitiativeIds, contentScope:contentScope.label, items:selected };
      } else if (call.name === 'search_memory') {
        const contentScope=resolveContentReadScope(state, { conversationProjectId:projectId, conversationInitiativeId:initiativeId, requestedProjectId:args.projectId, requestedInitiativeId:args.initiativeId });
        const selected = searchMemory(state, { projectId:contentScope.projectId, initiativeIds:contentScope.initiativeIds, includeGlobalMemory:contentScope.includeGlobalMemory, query:args.query, types:args.types, includeContent:Boolean(args.includeContent) });
        result.title = `长期记忆检索：${args.query}`;
        result.note = selected.length ? `找到 ${selected.length} 条适用长期记忆。` : '未找到匹配的适用长期记忆。';
        result.data = { projectId:contentScope.projectId, initiativeIds:contentScope.initiativeIds || [], contentScope:contentScope.label, items:selected };
      } else if (call.name === 'create_feishu_document') {
        const created = await createFeishuDocument({ title:String(args.title || ''), content:String(args.content || '') });
        result.title = String(args.title || '飞书文档'); result.note = `已创建飞书文档：${created.url}`; result.data = created;
        result.artifacts.push(toolArtifact('feishu_document', result.title, { feishuUrl:created.url }));
      } else if (call.name === 'append_feishu_document') {
        const updated = await appendFeishuDocument({ documentUrl:String(args.documentUrl || ''), content:String(args.content || '') });
        result.title = '飞书文档追加'; result.note = `已追加飞书文档：${updated.url}`; result.data = updated;
        result.artifacts.push(toolArtifact('feishu_document', result.title, { feishuUrl:updated.url }));
      } else if (call.name === 'replace_feishu_document_text') {
        const updated = await replaceFeishuDocumentText({ documentUrl:String(args.documentUrl || ''), originalText:String(args.originalText || ''), replacement:String(args.replacement ?? '') });
        result.title = '飞书文档局部修改'; result.note = `已修改飞书文档：${updated.url}`; result.data = updated;
        result.artifacts.push(toolArtifact('feishu_document', result.title, { feishuUrl:updated.url }));
      } else if (call.name === 'replace_feishu_document_blocks') {
        const updated = await replaceFeishuDocumentBlocks({ documentUrl:String(args.documentUrl || ''), blocks:args.blocks });
        result.title = '飞书文档块级修改'; result.note = `已修改飞书文档 ${updated.updatedBlockIds.length} 个 block：${updated.url}`; result.data = updated;
        result.artifacts.push(toolArtifact('feishu_document', result.title, { feishuUrl:updated.url, blockIds:updated.updatedBlockIds }));
      } else if (call.name === 'replace_feishu_document_images') {
        const replacements = Array.isArray(args.replacements) ? args.replacements : [];
        const artifactIds = replacements.map((item) => String(item?.artifactId || ''));
        const assets = (await resolveImageArtifactsForTask(state, { projectId, initiativeId, run, artifactIds })).map((asset, index) => ({ ...asset, artifactId:artifactIds[index] }));
        const updated = await replaceFeishuDocumentImages({ documentUrl:String(args.documentUrl || ''), replacements, assets });
        result.status = updated.failures.length ? 'partial' : 'completed';
        result.title = '飞书图片替换'; result.note = updated.failures.length ? `已替换 ${updated.replaced.length} 张图片，${updated.failures.length} 张未完成。` : `已替换 ${updated.replaced.length} 张图片。`;
        result.data = { documentUrl:updated.url, replacedImageBlockIds:updated.replaced.map((item) => item.imageBlockId), insertedArtifactIds:updated.replaced.map((item) => item.artifactId), failures:updated.failures };
        result.artifacts.push(toolArtifact('document_images', result.title, { feishuUrl:updated.url, replacedImageBlockIds:updated.replaced.map((item) => item.imageBlockId), artifactIds:updated.replaced.map((item) => item.artifactId) }));
      } else if (call.name === 'insert_document_images') {
        const documentUrl = String(args.documentUrl || '');
        if (!isFeishuDocumentUrl(documentUrl)) throw Object.assign(new Error('documentUrl 必须是有效的飞书文档 URL。'), { statusCode:422 });
        const assets = await resolveImageArtifactsForTask(state, { projectId, initiativeId, run, artifactIds:args.artifactIds });
        const inserted = await insertDocumentImages({ documentUrl, assets });
        result.status = inserted.failures.length ? 'partial' : 'completed';
        result.title = '飞书图片插入'; result.note = inserted.failures.length ? `已插入 ${inserted.inserted.length} 张图片，${inserted.failures.length} 张失败。` : `已插入 ${inserted.inserted.length} 张图片。`;
        result.data = { documentUrl:inserted.url, count:inserted.inserted.length, insertedArtifactIds:args.artifactIds, failures:inserted.failures };
        result.artifacts.push(toolArtifact('document_images', result.title, { feishuUrl:inserted.url, count:inserted.inserted.length, artifactIds:args.artifactIds }));
      } else if (call.name === 'write_local_knowledge' || call.name === 'save_knowledge_artifact') {
        const requestedProjectId=String(args.projectId || '').trim();
        const targetProjectId=projectId || requestedProjectId;
        if (!targetProjectId) throw Object.assign(new Error('无主题会话写入知识库时必须传 projectId。'), { statusCode:422 });
        if (projectId && requestedProjectId && requestedProjectId !== projectId) throw Object.assign(new Error('当前会话不能写入其他项目知识库。'), { statusCode:422 });
        const targetInitiativeId=String(args.initiativeId || initiativeId || '').trim();
        if (initiativeId && targetInitiativeId !== initiativeId) throw Object.assign(new Error('当前事项会话只能写入当前事项知识库。'), { statusCode:422 });
        const item = saveKnowledgeArtifact(state, targetProjectId, { ...args, initiativeId:targetInitiativeId }, targetInitiativeId);
        result.title = item.title; result.note = '已写入本地知识库。'; result.data = { knowledgeId:item.id, projectId:item.projectId, initiativeId:item.initiativeId, sourceUrl:item.sourceUrl };
        result.artifacts.push(toolArtifact('knowledge_item', item.title, { knowledgeId:item.id }));
      } else {
        throw Object.assign(new Error(`不支持的原子工具：${call.name}`), { statusCode:422 });
      }
    } catch (error) {
      result.status = error.statusCode === 409 || error.statusCode === 422 ? 'needs_input' : 'failed';
      result.error = publicErrorMessage(error);
      result.note = result.error;
      if (error?.cliData) result.data = error.cliData;
      result.errorCode = String(error?.code || '');
      result.timedOut = Boolean(error?.timedOut || error?.code === 'ETIMEDOUT' || error?.code === 'TOOL_TIMEOUT');
      result.retryable = error?.retryable !== false && result.status === 'failed';
      result.missing = result.status === 'needs_input' ? [result.error] : [];
    }
  if (executionDeadline?.timedOut) return { plan, result:null };
  const persistedArtifacts = persistResultArtifacts(state, { projectId, initiativeId, runId:run.id, planId:plan?.id || run.planId || '', result });
  if (persistedArtifacts.length) result.persistedArtifacts = persistedArtifacts;
  const toolCallSequence = (run.steps || []).filter((step) => step?.type === 'tool').length + 1;
  result.toolCallId = `${run.id}:${call.name}:${toolCallSequence}`;
  const obligations = normalizeToolObligations(result);
  if (obligations.length) {
    result.obligations = obligations;
    if (plan) mergePlanObligations(plan, obligations);
    else {
      run.pendingObligations ||= [];
      run.pendingObligations.push(...obligations);
    }
  }
  result.modelGuidance = buildToolResultGuidance(result);
  if (!Object.hasOwn(result, 'summary') && (result.note || result.error)) result.summary = result.note || result.error;
  result.input = snapshotAuditValue(args);
  run.steps.push({ name:`tool:${result.toolCallId}`, type:'tool', label:`工具：${call.name}`, status:result.status, input:args, output:result });
  onResult?.(result);
  return { plan, result };
}

function recordTimedOutToolCall({ state, projectId, initiativeId, run, plan, call, onResult, timeoutMs }) {
  const args = call.args || {};
  const result = {
    name:call.name,
    status:'failed',
    title:args.title || call.name,
    note:`工具执行超时（${Math.round(timeoutMs / 1000)} 秒）。`,
    error:`工具执行超时（${Math.round(timeoutMs / 1000)} 秒）。`,
    errorCode:'TOOL_TIMEOUT',
    timedOut:true,
    retryable:true,
    data:{ code:'TOOL_TIMEOUT', timeoutMs },
    artifacts:[],
    missing:[],
    input:snapshotAuditValue(args),
  };
  const toolCallSequence = (run.steps || []).filter((step) => step?.type === 'tool').length + 1;
  result.toolCallId = `${run.id}:${call.name}:${toolCallSequence}`;
  result.modelGuidance = buildToolResultGuidance(result);
  result.summary = result.note;
  run.steps.push({ name:`tool:${result.toolCallId}`, type:'tool', label:`工具：${call.name}`, status:result.status, input:args, output:result });
  onResult?.(result);
  return { plan, result };
}

async function executeAgentCall(params) {
  const timeoutMs = Number(params.toolTimeoutMs || TOOL_EXECUTION_TIMEOUT_MS);
  const executionDeadline = { timedOut:false };
  const pending = executeAgentCallOnce({ ...params, executionDeadline });
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => {
    executionDeadline.timedOut = true;
    reject(Object.assign(new Error(`工具执行超时（${Math.round(timeoutMs / 1000)} 秒）。`), { code:'TOOL_TIMEOUT' }));
  }, timeoutMs); });
  try {
    return await Promise.race([pending, timeout]);
  } catch (error) {
    if (error?.code !== 'TOOL_TIMEOUT') throw error;
    return recordTimedOutToolCall({ ...params, timeoutMs });
  } finally {
    clearTimeout(timer);
  }
}

function parallelPolicy(call) {
  return TOOL_EXECUTION_POLICIES[call?.name] || null;
}

async function dispatchAgentCalls({ state, projectId, initiativeId, run, plan, calls, onResult }) {
  const results = [];
  let currentPlan = plan;
  for (let index = 0; index < calls.length;) {
    const policy = parallelPolicy(calls[index]);
    if (!policy?.maxConcurrency) {
      const executed = await executeAgentCall({ state, projectId, initiativeId, run, plan:currentPlan, call:calls[index], resultIndex:index, onResult });
      currentPlan = executed.plan || currentPlan;
      results.push(executed.result);
      index += 1;
      continue;
    }

    const batch = [];
    while (index < calls.length && parallelPolicy(calls[index])?.maxConcurrency === policy.maxConcurrency && batch.length < policy.maxConcurrency) {
      batch.push({ call:calls[index], resultIndex:index });
      index += 1;
    }
    const executed = await Promise.all(batch.map(({ call, resultIndex }) => executeAgentCall({ state, projectId, initiativeId, run, plan:currentPlan, call, resultIndex, onResult })));
    results.push(...executed.map((item) => item.result));
  }
  return { plan:currentPlan, results };
}

module.exports = {
  server,
  integrationSetupStatus,
  AGENT_TOOLS,
  ALL_AGENT_TOOLS,
  CLI_REGISTRY,
  CLI_HELP_CACHE_TTL_MS,
  CHAT_MODEL_CATALOG,
  resolveChatModel,
  isFeishuDocumentUrl,
  normalizeMediaAssets,
  normalizeProjectDateFields,
  progressLabel,
  normalizeArtifactRegistry,
  normalizeSkills,
  relativeManagedAssetPath,
  registerMediaAsset,
  resolveInitiativeMediaAssets,
  resolveChatImageAttachments,
  resolveImageArtifactsForTask,
  createExecutionPlan,
  validateManualRerun,
  hasUserFacingModelReply,
  runHasUserFacingModelReply,
  finishAgentRun,
  updateExecutionPlan,
  searchArtifacts,
  searchProjectHistory,
  queryAgentHistory,
  searchKnowledge,
  searchMemory,
  buildDataRecoveryDisclosure,
  buildExperimentVersionCatalog,
  buildVersionedMetricResults,
  metricValueFromReport,
  mergeClientStateSnapshot,
  repairMissingAgentWrittenKnowledge,
  writeJsonAtomically,
  normalizeInterruptedAgentRuns,
  normalizeAgentLoopAuditInputs,
  normalizeModelRequestMockModels,
  fetchModelRequestMockModels,
  normalizeModelRequestTools,
  extractModelRequestToolCalls,
  modelRequestToolCatalog,
  selectModelRequestTools,
  buildModelRequestMock,
  fetchOpenRouterChat,
  buildProjectContext,
  modelEvidenceForToolResult,
  dedupeModelEvidence,
  sanitizeToolResultForModel,
  normalizeExecutionHandoff,
  buildExecutionCompactionInput,
  compactExecutionContext,
  executionCompactionInstructions,
  contextCharacterBreakdown,
  executionCompactionTrigger,
  CONTEXT_NORMAL_CHAR_BUDGET,
  CONTEXT_COMPACTION_LOOP_INTERVAL,
  agentInstructions,
  finalLoopInstruction,
  normalizeMemoryUpdate,
  applyModelMemoryUpdate,
  normalizeConversationMemoryStore,
  normalizeConversationThreads,
  findConversation,
  buildWorkspaceContext,
  pendingToolResultsForContext,
  searchWorkspace,
  conversationStore,
  activeConversationPlan,
  conversationSummaryInstructions,
  decodeImageDataUrl,
  buildReadFeishuDocumentToolResult,
  buildReadWebPageToolResult,
  fetchPublicLinkContent,
  fetchFeishuDocumentContent,
  selectFeishuDocumentBlocks,
  replaceFeishuDocumentText,
  replaceFeishuDocumentBlocks,
  replaceFeishuDocumentImages,
  insertDocumentImages,
  runRegisteredCli,
  cliHelpCacheKey,
  readCliHelpCache,
  rememberRunCliHelp,
  createManualSkill,
  deleteSkill,
  searchSkills,
  collectRegisteredCliArtifacts,
  dispatchAgentCalls,
  buildToolResultGuidance,
  compactToolResultForModel,
  terminalUserFacingReply,
  applyTerminalUserFacingReply,
  buildAgentLoopAuditInput,
  normalizeModelUsage,
  summarizeRunModelUsage,
  normalizeAutomationState,
  normalizeNotifications,
  createInAppNotification,
  planAutomationRule,
  evaluateAutomationRules,
  assertAutomationCallsAuthorized,
  automationExecutionTools,
  globalConversationTools,
};
