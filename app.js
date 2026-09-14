const STORAGE_KEY = 'project-pusher-initial-v1';
const API_ENDPOINT = location.protocol === 'http:' || location.protocol === 'https:' ? '/api/state' : null;
let backendHydrated = !API_ENDPOINT;
let backendAvailable = Boolean(API_ENDPOINT);
let backendSaveTimer = null;
let backendSaveInFlight = false;
let lastServerManagedUpdatedAt = '';
let hasClientEditsSinceHydration = false;
let aiBusy = false;
const activeAgentRequests = new Map();
let pendingChatImages = [];
let chatModelCatalog = [];
let assistantTargetMenuOpen = false;
let assistantHistoryMenuOpen = false;
let quickPromptMenuOpen = false;
let customQuickPromptOpen = false;
let skillLibrary = { parents:[], errors:[] };
let selectedSkillParentPath = '';
let selectedAutomationPlanId = '';
let automationPlanning = false;
let automationDraft = null;
let editingAutomationRuleId = '';
let notificationMenuOpen = false;
let notificationPollTimer = null;
let knownNotificationIds = new Set();
let notificationsInitialized = false;
function localDateKey(date = new Date()) {
  const localTime = new Date(date.getTime() - date.getTimezoneOffset() * 60 * 1000);
  return localTime.toISOString().slice(0, 10);
}
const TODAY = localDateKey();
const TEAM_OPTIONS = ['DS', '设计', '服务端', '算法', '前端', '客户端', '工程', '测试'];
const DEFAULT_PROGRESS_OPTIONS = ['未开始', '待排期', '推进中', '实验中', '风险', '已完成'];
const TEAM_COLORS = ['#dbeee8','#f8e5d5','#e9e2fb','#e0ecf8','#faebbf','#e5eee2','#f1e2e2','#e2edf0'];
const teamRules = [
  {name:'DS',symbol:'DS',lead:'3 个工作日',order:'1 · 问题 / 数据验证',rule:'先确认数据表、指标口径和样本量；实验开始前完成埋点验收。'},
  {name:'设计',symbol:'设',lead:'5 个工作日',order:'2 · 方案 / 交互输出',rule:'评审前冻结范围；优先支持关键路径。'},
  {name:'服务端',symbol:'BE',lead:'2 + 7 个工作日',order:'3 · 评估 / 定容 / 开发',rule:'定容前必须具备 PRD、接口清单和验收标准。'},
  {name:'算法',symbol:'ML',lead:'5 + 10 个工作日',order:'3 · 策略评估 / 开发',rule:'先确认离线指标、线上实验设计和流量条件。'},
  {name:'前端',symbol:'FE',lead:'2 + 5 个工作日',order:'4 · 联调 / 页面实现',rule:'接口契约确认后开始排期。'},
  {name:'客户端',symbol:'APP',lead:'3 + 7 个工作日',order:'4 · 版本实现',rule:'需要匹配客户端发版窗口。'},
  {name:'工程',symbol:'ENG',lead:'3 个工作日',order:'5 · 发布 / 稳定性',rule:'上线前明确灰度、监控、回滚与容量方案。'},
  {name:'测试',symbol:'QA',lead:'3 - 5 个工作日',order:'6 · 验收 / 发布',rule:'开发完成前提供验收用例和异常路径。'}
];

const defaultState = {
  selectedProjectId: 'project-alpha',
  knowledgeFilter: { projectId: 'ALL', query: '', type: 'ALL' },
  progressOptions: [...DEFAULT_PROGRESS_OPTIONS],
  projects: [
    {
      id:'project-alpha', priority:'P0', name:'示例项目 Alpha', plannedEnd:'', progress:'推进中',
      currentState:'这是用于演示的项目概览，可按实际情况填写。',
      blocker:'暂无', nextAction:'补充项目目标与下一步动作', nextActionDdl:'',
      learning:'示例记录：将可复用的结论沉淀到项目知识库。', teams:['设计','服务端','前端'],
      initiatives:[
        {id:'initiative-alpha-1', priority:'P0', name:'示例事项 A1', currentState:'等待补充事项现状。', blocker:'暂无', nextAction:'确认负责人和交付标准', nextActionDdl:'', learning:'示例记录：先明确范围和验收条件。', teams:['服务端','前端'], progress:'推进中', plannedEnd:'', actionDone:false, archived:false, knowledgeLinks:[]},
        {id:'initiative-alpha-2', priority:'P1', name:'示例事项 A2', currentState:'等待补充事项现状。', blocker:'暂无', nextAction:'梳理依赖与风险', nextActionDdl:'', learning:'示例记录：定期同步风险变化。', teams:['设计','前端'], progress:'待排期', plannedEnd:'', actionDone:false, archived:false, knowledgeLinks:[]}
      ],
      memory:[{role:'assistant', text:'这是示例项目 Alpha 的演示记忆。'}]
    },
    {
      id:'project-beta', priority:'P1', name:'示例项目 Beta', plannedEnd:'', progress:'待排期',
      currentState:'等待补充项目现状。', blocker:'暂无', nextAction:'确认项目计划', nextActionDdl:'', learning:'示例记录：关键决策应记录来源和结论。', teams:['设计','服务端','测试'],
      initiatives:[
        {id:'initiative-beta-1', priority:'P1', name:'示例事项 B1', currentState:'等待补充事项现状。', blocker:'暂无', nextAction:'拆分执行步骤', nextActionDdl:'', learning:'示例记录：按交付结果跟踪进度。', teams:['服务端','测试'], progress:'未开始', plannedEnd:'', actionDone:false, archived:false, knowledgeLinks:[]}
      ],
      memory:[{role:'assistant', text:'这是示例项目 Beta 的演示记忆。'}]
    },
    {
      id:'project-gamma', priority:'P2', name:'示例项目 Gamma', plannedEnd:'', progress:'未开始',
      currentState:'等待补充项目现状。', blocker:'暂无', nextAction:'收集项目背景', nextActionDdl:'', learning:'示例记录：先验证目标与范围。', teams:['设计','前端'],
      initiatives:[
        {id:'initiative-gamma-1', priority:'P2', name:'示例事项 C1', currentState:'等待补充事项现状。', blocker:'暂无', nextAction:'确定首个可交付成果', nextActionDdl:'', learning:'示例记录：优先聚焦最小可验证范围。', teams:['设计','前端'], progress:'未开始', plannedEnd:'', actionDone:false, archived:false, knowledgeLinks:[]}
      ],
      memory:[{role:'assistant', text:'这是示例项目 Gamma 的演示记忆。'}]
    }
  ],
  knowledgeItems: []
};

let state = loadState();
normalizeState();
saveState();

function normalizeState() {
  if (typeof state.selectedChatModel !== 'string') state.selectedChatModel = 'deepseek/deepseek-v4-pro-0813';
  if (typeof state.aiCollapsed !== 'boolean') state.aiCollapsed = true;
  if (typeof state.sidebarCollapsed !== 'boolean') state.sidebarCollapsed = false;
  if (typeof state.selectedInitiativeId !== 'string') state.selectedInitiativeId = '';
  if (!Array.isArray(state.conversations)) state.conversations = [];
  for (const project of state.projects || []) {
    const legacy=[{id:`legacy-project-${project.id}`,scope:'project',projectId:project.id,memory:project.memory,conversationSummary:project.conversationSummary},...(project.initiatives||[]).map(initiative=>({id:`legacy-initiative-${initiative.id}`,scope:'initiative',projectId:project.id,initiativeId:initiative.id,memory:initiative.memory,conversationSummary:initiative.conversationSummary}))];
    for(const item of legacy) if(!state.conversations.some(conversation=>conversation.id===item.id)&&((item.memory||[]).length||item.conversationSummary?.summary)) state.conversations.push({...item,title:item.scope==='initiative'?`事项 · ${getInitiative(item.initiativeId)?.initiative.name||''}`:`项目 · ${project.name}`,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()});
  }
  state.conversations=state.conversations.map(conversation=>({id:String(conversation.id||uid('conversation')),scope:['global','project','initiative'].includes(conversation.scope)?conversation.scope:(conversation.initiativeId?'initiative':conversation.projectId?'project':'global'),projectId:String(conversation.projectId||''),initiativeId:String(conversation.initiativeId||''),title:String(conversation.title||'无主题对话'),memory:Array.isArray(conversation.memory)?conversation.memory:[],conversationSummary:conversation.conversationSummary||null,createdAt:conversation.createdAt||new Date().toISOString(),updatedAt:conversation.updatedAt||conversation.createdAt||new Date().toISOString()})).filter(conversation=>conversation.scope==='global'||getProject(conversation.projectId));
  if (typeof state.selectedConversationId !== 'string') state.selectedConversationId = '';
  if (state.selectedConversationId && !state.conversations.some(conversation=>conversation.id===state.selectedConversationId)) state.selectedConversationId='';
  if (!Array.isArray(state.expandedArchivedProjectIds)) state.expandedArchivedProjectIds = [];
  if (!Array.isArray(state.proposals)) state.proposals = [];
  if (!Array.isArray(state.agentRuns)) state.agentRuns = [];
  if (!Array.isArray(state.agentPlans)) state.agentPlans = [];
  if (!Array.isArray(state.mediaAssets)) state.mediaAssets = [];
  if (!Array.isArray(state.skills)) state.skills = [];
  if (!Array.isArray(state.automationRules)) state.automationRules = [];
  if (!Array.isArray(state.automationPlans)) state.automationPlans = [];
  if (!Array.isArray(state.automationTasks)) state.automationTasks = [];
  if (!Array.isArray(state.notifications)) state.notifications = [];
  if (!state.agentRunFilter || typeof state.agentRunFilter !== 'object') state.agentRunFilter = { projectId: 'ALL', status: 'ALL' };
  if (!Array.isArray(state.longTermMemories)) { state.longTermMemories = [...(state.globalMemories||[]).map(item=>({...item,scope:'global',data:item.data||{content:item.content||''}})), ...(state.projectMemories||[]).map(item=>({...item,scope:item.initiativeId?'initiative':'project',data:item.data||{content:item.content||''}})), ...(state.dataRecoveryProfiles||[]).map(profile=>({id:`memory-profile-${profile.id}`,memoryKey:`data_recovery_profile:${profile.projectId}`,scope:'project',projectId:profile.projectId,initiativeId:'',type:'data_recovery_profile',statement:dataRecoveryProfileStatement(profile),data:profile,status:profile.status||'active',source:profile.source||'user_confirmed',confidence:'high',version:profile.version||1,createdAt:profile.createdAt,updatedAt:profile.updatedAt,evidence:'用户确认的数据回收配置'}))]; }
  delete state.projectMemories; delete state.globalMemories; delete state.dataRecoveryProfiles;
  if (!state.memoryFilter || typeof state.memoryFilter !== 'object') state.memoryFilter = { projectId: 'ALL', initiativeId:'ALL', status: 'active' };
  if (!Object.hasOwn(state.memoryFilter, 'initiativeId')) state.memoryFilter.initiativeId = 'ALL';
  if (!Array.isArray(state.dataRecoveryReports)) state.dataRecoveryReports = [];
  if (!state.recoveryFilter || typeof state.recoveryFilter !== 'object') state.recoveryFilter = { projectId: state.selectedProjectId || 'ALL' };
  if (!Array.isArray(state.projects)) state.projects = [];
  if (!Array.isArray(state.progressOptions)) state.progressOptions = [...DEFAULT_PROGRESS_OPTIONS];
  state.progressOptions = [...new Set([...DEFAULT_PROGRESS_OPTIONS, ...state.progressOptions.map(item=>String(item||'').trim()).filter(Boolean)])];
  if (!Array.isArray(state.expandedProjectIds)) state.expandedProjectIds = state.projects.map(project => project.id);
  if (!Array.isArray(state.knowledgeItems)) state.knowledgeItems = [];
  for (const project of state.projects) {
    if (typeof project.background !== 'string') project.background = '';
    if (typeof project.history !== 'string') project.history = '';
    if (typeof project.currentFocus !== 'string') project.currentFocus = '';
    project.progress = normalizeProgressValues(project.progress);
    for (const value of project.progress) if (!state.progressOptions.includes(value)) state.progressOptions.push(value);
    project.nextActionDdl = project.nextActionDdl ? project.nextActionDdl.slice(0, 10) : '';
    const legacyItems = [
      { initiativeId:'', statement:project.learning, type:'learning' },
      ...(project.initiatives || []).map(initiative => ({ initiativeId:initiative.id, statement:initiative.learning, type:'learning' })),
    ].filter(item => item.statement && item.statement !== '暂无' && !state.longTermMemories.some(memory => memory.projectId === project.id && memory.initiativeId === item.initiativeId && memory.statement === item.statement));
    for (const item of legacyItems) state.longTermMemories.push({ id:uid('legacy-memory'), scope:item.initiativeId?'initiative':'project', data:{content:''}, projectId:project.id, initiativeId:item.initiativeId, type:item.type, statement:item.statement, confidence:'medium', evidence:'从原项目 / 事项 learning 字段迁移', source:'legacy_import', status:'active', version:1, supersedes:'', supersededBy:'', createdAt:new Date().toISOString(), updatedAt:new Date().toISOString() });
    if (!Array.isArray(project.knowledgeLinks)) {
      project.knowledgeLinks = project.knowledgeUrl ? [{id:uid('link'), url:project.knowledgeUrl}] : [];
    }
    delete project.knowledgeUrl;
    if (!Array.isArray(project.currentStateImages)) project.currentStateImages = [];
    if (!Array.isArray(project.learningImages)) project.learningImages = [];
    if (!Array.isArray(project.initiatives)) project.initiatives = [];
    for (const initiative of project.initiatives) {
      if (typeof initiative.archived !== 'boolean') initiative.archived = false;
      initiative.progress = normalizeProgressValues(initiative.progress);
      for (const value of initiative.progress) if (!state.progressOptions.includes(value)) state.progressOptions.push(value);
      initiative.nextActionDdl = initiative.nextActionDdl ? initiative.nextActionDdl.slice(0, 10) : '';
      if (!Array.isArray(initiative.knowledgeLinks)) {
        const legacyUrl = initiative.knowledgeUrl || '';
        initiative.knowledgeLinks = legacyUrl ? [{id:uid('link'), url:legacyUrl}] : [];
      }
      delete initiative.knowledgeUrl;
      if (!Array.isArray(initiative.currentStateImages)) initiative.currentStateImages = [];
      if (!Array.isArray(initiative.learningImages)) initiative.learningImages = [];
    }
    syncProjectOverviewMemories(project);
  }
  for (const item of state.knowledgeItems) { if (item.autoLinked && item.sourceUrl) item.type = inferKnowledgeType(item.sourceUrl); }
  const selectedInitiative = state.selectedInitiativeId ? getInitiative(state.selectedInitiativeId) : null;
  if (selectedInitiative && selectedInitiative.project.id !== state.selectedProjectId) state.selectedInitiativeId = '';
}

function clone(data) { return JSON.parse(JSON.stringify(data)); }
function loadState() { try { const saved = localStorage.getItem(STORAGE_KEY); return saved ? JSON.parse(saved) : clone(defaultState); } catch { return clone(defaultState); } }
function clientStateSnapshot() {
  const snapshot = clone(state);
  // Agent execution logs, reports and generated assets are server-owned. Sending
  // them back on every UI save can exceed the request limit and overwrite newer
  // server evidence with an older browser copy.
  delete snapshot.agentRuns;
  delete snapshot.agentPlans;
  delete snapshot.dataRecoveryReports;
  delete snapshot.artifacts;
  delete snapshot.mediaAssets;
  delete snapshot.cliHelpCache;
  delete snapshot.skills;
  delete snapshot.automationRules;
  delete snapshot.automationPlans;
  delete snapshot.automationTasks;
  delete snapshot.notifications;
  delete snapshot.longTermMemories;
  return snapshot;
}
function mergeAgentWrittenKnowledge(serverItems, localItems) {
  const merged=new Map((Array.isArray(localItems)?localItems:[]).filter(item=>item?.id).map(item=>[item.id,item]));
  for(const item of Array.isArray(serverItems)?serverItems:[]) if(item?.id&&item.sourceType==='agent_written') merged.set(item.id,item);
  return [...merged.values()];
}
function mergeServerManagedState(serverState, updatedAt='') {
  if (!serverState || typeof serverState !== 'object') return false;
  if (updatedAt && lastServerManagedUpdatedAt && updatedAt < lastServerManagedUpdatedAt) return false;
  for (const key of ['agentRuns','agentPlans','dataRecoveryReports','artifacts','mediaAssets','cliHelpCache','skills','automationRules','automationPlans','automationTasks','longTermMemories']) {
    if (Object.prototype.hasOwnProperty.call(serverState,key)) state[key]=serverState[key];
  }
  if (Object.prototype.hasOwnProperty.call(serverState,'knowledgeItems')) state.knowledgeItems=mergeAgentWrittenKnowledge(serverState.knowledgeItems,state.knowledgeItems);
  if (updatedAt) lastServerManagedUpdatedAt=updatedAt;
  return true;
}
async function persistBackendState() {
  if (!API_ENDPOINT || !backendHydrated || !backendAvailable) return;
  const response = await fetch(API_ENDPOINT, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ state:clientStateSnapshot(), clientManagedOnly:true }),
  });
  if (!response.ok) throw new Error(`Backend save failed: ${response.status}`);
  const payload = await response.json().catch(() => ({}));
  // A PUT response can arrive after the user has moved on to another inline
  // field. It must never rebuild the editable table: replacing its DOM loses
  // focus and drops keystrokes. Explicit UI actions and hydration own redraws.
  if (mergeServerManagedState(payload.state,payload.updatedAt)) { normalizeState(); renderCounts(); }
}
function saveState() {
  if (backendHydrated) hasClientEditsSinceHydration = true;
  for (const project of state.projects || []) syncProjectOverviewMemories(project);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (error) {
    // Large agent logs / reports can exceed browser quota. The backend remains the source of truth.
    try { localStorage.removeItem(STORAGE_KEY); } catch {}
    console.warn('Browser cache quota exceeded; continuing with backend persistence only.', error);
  }
  queueBackendSave();
}
function queueBackendSave() {
  if (!API_ENDPOINT || !backendHydrated || !backendAvailable) return;
  clearTimeout(backendSaveTimer);
  backendSaveTimer = setTimeout(async () => {
    backendSaveTimer = null;
    backendSaveInFlight = true;
    try {
      await persistBackendState();
    } catch (error) {
      backendAvailable = false;
      console.warn('Backend persistence is unavailable; changes remain in local browser cache.', error);
    } finally {
      backendSaveInFlight = false;
    }
  }, 300);
}
async function hydrateFromBackend() {
  if (!API_ENDPOINT) return;
  const canReplaceClientState = !backendHydrated || (!hasClientEditsSinceHydration && !backendSaveTimer && !backendSaveInFlight && !aiBusy);
  try {
    const response = await fetch(API_ENDPOINT, { cache: 'no-store' });
    if (!response.ok) throw new Error(`Backend load failed: ${response.status}`);
    const payload = await response.json();
    if (payload.state && typeof payload.state === 'object' && canReplaceClientState) {
      state = payload.state;
      normalizeState();
      lastServerManagedUpdatedAt=payload.updatedAt || lastServerManagedUpdatedAt;
    } else if (payload.state && typeof payload.state === 'object') {
      mergeServerManagedState(payload.state,payload.updatedAt);
    }
    await hydrateChatModelCatalog();
    backendHydrated = true;
    renderAll();
    void refreshSkillLibrary();
    startNotificationPolling();
  } catch (error) {
    backendAvailable = false;
    backendHydrated = true;
    console.warn('Backend load is unavailable; using local browser cache.', error);
  }
}
async function hydrateChatModelCatalog() {
  if (!API_ENDPOINT) return;
  const response=await fetch('/api/ai/models',{cache:'no-store'});
  if (!response.ok) throw new Error(`模型列表加载失败：${response.status}`);
  const payload=await response.json();
  chatModelCatalog=Array.isArray(payload.models) ? payload.models : [];
  if (!chatModelCatalog.some((item)=>item.id===state.selectedChatModel)) state.selectedChatModel=payload.defaultModel || chatModelCatalog[0]?.id || '';
}
function uid(prefix) { return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`; }
function upsertLocalProjectMemory(entry) { const index=state.longTermMemories.findIndex(item=>item.projectId===entry.projectId&&item.memoryKey===entry.memoryKey); const previous=index>=0?state.longTermMemories[index]:null; if(previous&&previous.statement===entry.statement&&previous.content===entry.content) return previous; const now=new Date().toISOString(); const record={id:previous?.id||uid('memory'),scope:'project',initiativeId:'',data:{content:entry.content||''},status:'active',version:(previous?.version||0)+1,createdAt:previous?.createdAt||now,updatedAt:now,source:'project_overview',confidence:'high',evidence:'用户在项目全景中输入',...entry}; if(index>=0)state.longTermMemories[index]=record;else state.longTermMemories.unshift(record);return record; }
function syncProjectOverviewMemories(project) { const entries=[['project_background','project_background',project.background],['project_history','project_history',project.history||project.learning],['project_status','project_status',`进度：${progressText(project.progress)}；现状：${project.currentState||'待补充'}；卡点：${project.blocker||'暂无'}`],['current_focus','current_focus',project.currentFocus||`当前重点：${project.nextAction||'待补充'}${project.nextActionDdl?`；DDL：${project.nextActionDdl}`:''}`]]; for(const [memoryKey,type,statement] of entries){if(statement&&statement!=='暂无')upsertLocalProjectMemory({projectId:project.id,memoryKey,type,statement:String(statement),content:String(statement)});} }
function dataRecoveryProfileStatement(profile) { const details=(Array.isArray(profile?.metricGroups)?profile.metricGroups:[]).map(group=>{ const name=String(group?.name||'').trim(); const metrics=Array.isArray(group?.metrics)?group.metrics.map(metric=>String(metric||'').trim()).filter(Boolean):[]; return name&&metrics.length?`${name}：${metrics.join('、')}`:''; }).filter(Boolean); return `项目常用回收指标和指标组：${details.join('；')||'待用户确认'}`; }
function syncDataRecoveryProfileMemoryLocal(profile) { if(!profile?.projectId||profile.status!=='active'||!hasUsableRecoveryProfile(profile))return; const statement=dataRecoveryProfileStatement(profile); upsertLocalProjectMemory({projectId:profile.projectId,memoryKey:'data_recovery_profile',type:'data_recovery_profile',statement,content:'',data:profile,source:'user_confirmed',confidence:'high',evidence:'用户确认的数据回收配置'}); }
function getProject(id) { return state.projects.find(project => project.id === id); }
function getInitiative(id) { for (const project of state.projects) { const initiative = project.initiatives.find(item => item.id === id); if (initiative) return { project, initiative }; } return null; }
function formatDate(value) { if (!value) return '待定'; const [y,m,d] = value.slice(0, 10).split('-'); return `${Number(m)}.${Number(d)}`; }
function inferLinkTheme(url='') { try { const parsed = new URL(url); const host = parsed.hostname.replace(/^www\./,''); const flightId = parsed.pathname.match(/\/flight\/(\d+)/)?.[1]; if (host.includes('data.example-company.net') && flightId) return `Libra 实验报告 #${flightId}`; const segments = parsed.pathname.split('/').filter(Boolean); const last = segments.at(-1); const readable = last && !/^(main|index|report)$/i.test(last) ? decodeURIComponent(last).replace(/[-_]+/g,' ') : ''; return readable ? `${host} · ${readable}` : host; } catch { return '未识别主题的关联链接'; } }
function inferKnowledgeType(url='') { try { const parsed = new URL(url); return parsed.hostname.endsWith('data.example-company.net') && /^\/libra\//.test(parsed.pathname) ? '实验与数据' : '方案与需求'; } catch { return '方案与需求'; } }
function priorityRank(priority='P2') { return ({P0:0,P1:1,P2:2})[priority] ?? 9; }
function isToday(value) { return value && value.slice(0,10) === TODAY; }
function isOverdue(value) { return value && value.slice(0,10) < TODAY; }
function escapeHtml(value='') { return value.replace(/[&<>'"]/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[char])); }
function normalizeProgressValues(value) { const source=Array.isArray(value)?value:[value]; return [...new Set(source.map(item=>String(item||'').trim()).filter(Boolean))]; }
function progressText(value) { const values=normalizeProgressValues(value); return values.join(' · ') || '未设置'; }
function selectedProgressValues(form) { return [...form.querySelectorAll('select[name="progress"] option:checked')].map(option=>option.value); }
function progressOptionsHtml(selected=[]) { const values=normalizeProgressValues(selected); return state.progressOptions.map(option=>`<option value="${escapeHtml(option)}" ${values.includes(option)?'selected':''}>${escapeHtml(option)}</option>`).join(''); }
function progressMultiSelect(kind,id,selected=[]) { const values=normalizeProgressValues(selected); const chips=values.map(value=>`<span class="progress-chip">${escapeHtml(value)}<button type="button" data-progress-remove-kind="${kind}" data-progress-remove-id="${id}" data-progress-value="${escapeHtml(value)}" aria-label="移除 ${escapeHtml(value)}">×</button></span>`).join(''); const options=state.progressOptions.map(option=>`<label><input type="checkbox" data-progress-option-kind="${kind}" data-progress-option-id="${id}" value="${escapeHtml(option)}" ${values.includes(option)?'checked':''} />${escapeHtml(option)}<button type="button" data-progress-delete-option="${escapeHtml(option)}" title="删除候选项">×</button></label>`).join(''); return `<div class="progress-multi" data-progress-kind="${kind}" data-progress-id="${id}"><div class="progress-chip-list">${chips||'<span class="no-progress">未设置</span>'}</div><details><summary>选择进度</summary><div class="progress-options">${options}</div><div class="progress-option-add"><input data-progress-new-kind="${kind}" data-progress-new-id="${id}" placeholder="新增候选项" /><button type="button" data-progress-add-kind="${kind}" data-progress-add-id="${id}">添加</button></div></details></div>`; }
function progressFormControl(selected=[]) { return `<div class="progress-form-control"><select name="progress" multiple size="5">${progressOptionsHtml(selected)}</select><small>可多选；按 Command/Ctrl 选择多个候选项。候选项可在项目全景的进度菜单中新增或删除。</small></div>`; }
function priorityClass(priority) { return priority === 'P0' ? 'p0' : ''; }
function riskClass(text='') { return /风险|负向|未确认|未锁定|阻塞|逾期/.test(text) ? 'risk' : ''; }
function teamChips(teams=[]) { return teams.map((team, index) => `<span class="team-chip" style="--chip:${TEAM_COLORS[index % TEAM_COLORS.length]}">${escapeHtml(team)}</span>`).join(''); }
function nextActionHtml(action, ddl, done=false) { return `<div class="next-action ${done ? 'action-done' : ''}"><span>${escapeHtml(action || '待补充')}</span><b>${done ? '已完成' : formatDate(ddl)}</b></div>`; }
function getOpenActions() { return state.projects.flatMap(project => project.initiatives.filter(initiative => !initiative.archived && !initiative.actionDone && initiative.nextAction && initiative.nextActionDdl).map(initiative => ({project, initiative}))); }
function getTodayDeadlineActions() { return state.projects.flatMap(project => { const projectAction = project.nextAction && project.nextActionDdl ? [{ kind:'project', project, item:project, name:project.name, action:project.nextAction, ddl:project.nextActionDdl, priority:project.priority }] : []; const initiativeActions = project.initiatives.filter(initiative => !initiative.archived && !initiative.actionDone && initiative.nextAction && initiative.nextActionDdl).map(initiative => ({ kind:'initiative', project, item:initiative, name:initiative.name, action:initiative.nextAction, ddl:initiative.nextActionDdl, priority:initiative.priority })); return [...projectAction, ...initiativeActions]; }); }

function autoSizeInlineTextareas() { requestAnimationFrame(() => { document.querySelectorAll('.portfolio-table .inline-textarea').forEach(textarea => { textarea.style.height = 'auto'; textarea.style.height = `${textarea.scrollHeight}px`; }); }); }
function renderAll() { renderShell(); renderNotifications(); renderCounts(); renderDeadlines(); renderProjectTable(); const activeView=document.querySelector('.view.active-view')?.id || 'projects'; if(activeView==='knowledge'){renderKnowledgeFilters();renderKnowledge();} if(activeView==='automation')renderAutomation(); if(activeView==='cli-skills')renderCliSkills(); if(activeView==='project-memory')renderProjectMemory(); if(activeView==='agent-runs')renderAgentRuns(); renderAssistant(); autoSizeInlineTextareas(); }
function renderShell() { const shell = document.querySelector('.app-shell'); shell.classList.toggle('ai-collapsed', Boolean(state.aiCollapsed)); shell.classList.toggle('sidebar-collapsed', Boolean(state.sidebarCollapsed)); const aiButton = document.getElementById('toggleCopilot'); if (aiButton) { aiButton.textContent = state.aiCollapsed ? '‹' : '›'; aiButton.title = state.aiCollapsed ? '展开 AI 助手' : '收起 AI 助手'; aiButton.setAttribute('aria-label', aiButton.title); } const launcher=document.getElementById('assistantLauncher'); if(launcher)launcher.hidden=!state.aiCollapsed; const sideButton = document.getElementById('toggleSidebar'); if (sideButton) { sideButton.textContent = state.sidebarCollapsed ? '›' : '‹'; sideButton.title = state.sidebarCollapsed ? '展开导航栏' : '收起导航栏'; sideButton.setAttribute('aria-label', sideButton.title); } }
function notificationTime(value) { return value ? new Date(value).toLocaleTimeString('zh-CN',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit'}) : ''; }
function renderNotifications() { const button=document.getElementById('notificationButton'); const dot=document.getElementById('notificationDot'); const menu=document.getElementById('notificationMenu'); if(!button||!dot||!menu)return; const notifications=(state.notifications||[]).slice(0,20); const unread=notifications.filter(item=>!item.readAt).length; dot.hidden=!unread; button.setAttribute('aria-label',unread?`AI 消息通知，${unread} 条未读`:'AI 消息通知'); menu.hidden=!notificationMenuOpen; menu.innerHTML=notifications.length?`<header><b>AI 消息</b><span>${unread?`${unread} 条未读`:'全部已读'}</span></header>${notifications.map(item=>`<button type="button" class="notification-item ${item.readAt?'':'unread'}" data-open-notification="${escapeHtml(item.id)}"><b>${escapeHtml(item.title)}</b><p>${escapeHtml(item.body||'').replace(/\s+/g,' ').slice(0,100)}</p><small>${escapeHtml(notificationTime(item.createdAt))}</small></button>`).join('')}`:'<p class="notification-empty">暂无 AI 消息。</p>'; }
async function refreshNotifications(announce=false) { if(!API_ENDPOINT)return; try { const response=await fetch('/api/notifications',{cache:'no-store'}); const payload=await response.json(); if(!response.ok)throw new Error(payload.error||'通知读取失败'); const incoming=Array.isArray(payload.notifications)?payload.notifications:[]; const fresh=incoming.filter(item=>!knownNotificationIds.has(item.id)); state.notifications=incoming; for(const item of incoming)knownNotificationIds.add(item.id); if(Array.isArray(payload.conversations)){const known=new Map((state.conversations||[]).map(item=>[item.id,item]));for(const conversation of payload.conversations)known.set(conversation.id,conversation);state.conversations=[...known.values()];} renderNotifications(); renderCounts(); if(announce&&notificationsInitialized&&fresh.some(item=>!item.readAt))toast(`收到 ${fresh.filter(item=>!item.readAt).length} 条 AI 消息`); notificationsInitialized=true; } catch(error) { console.warn('Notification refresh skipped:',error.message); } }
function startNotificationPolling() { if(!API_ENDPOINT||notificationPollTimer)return; void refreshNotifications(false); notificationPollTimer=setInterval(()=>void refreshNotifications(true),5000); }
async function openNotification(notificationId) { const response=await fetch(`/api/notifications/${encodeURIComponent(notificationId)}/read`,{method:'POST'}); const payload=await response.json(); if(!response.ok)return toast(payload.error||'通知打开失败'); state.notifications=payload.notifications||state.notifications; if(payload.conversation){const index=state.conversations.findIndex(item=>item.id===payload.conversation.id);if(index>=0)state.conversations[index]=payload.conversation;else state.conversations.unshift(payload.conversation);state.selectedConversationId=payload.conversation.id;state.selectedProjectId=payload.conversation.projectId||state.selectedProjectId;state.selectedInitiativeId=payload.conversation.initiativeId||'';state.aiCollapsed=false;} notificationMenuOpen=false; renderAll(); }
function renderCounts() { const count = state.projects.length; const risks = state.projects.filter(project => riskClass(`${project.currentState} ${project.blocker} ${project.progress}`)).length; document.getElementById('projectCount').textContent = count; document.getElementById('memoryCount').textContent = state.longTermMemories.filter(memory=>memory.status === 'active').length; const automationCount=document.getElementById('automationCount'); if(automationCount) automationCount.textContent=state.automationRules.filter(rule=>rule.enabled).length; const cliSkillCount=document.getElementById('cliSkillCount'); if(cliSkillCount) cliSkillCount.textContent=(skillLibrary.parents || []).length; const runCount=document.getElementById('agentRunCount'); if(runCount) runCount.textContent = state.agentRuns.filter(run=>run.status === 'failed').length || state.agentRuns.length; document.getElementById('portfolioHealth').innerHTML = `<span>项目总概 ${count} 个</span><b><i></i> ${risks} 个项目存在风险</b>`; }
function renderDeadlines() { const items = getTodayDeadlineActions().filter(item => isToday(item.ddl)).sort((a,b) => priorityRank(a.priority) - priorityRank(b.priority) || a.ddl.localeCompare(b.ddl)).slice(0,3); const root = document.getElementById('deadlineStrip'); root.innerHTML = items.length ? items.map(item => { const isProject = item.kind === 'project'; return `<article class="deadline-card ${item.priority === 'P0' ? 'deadline-card-p0' : ''}" ${isProject ? `data-edit-project="${item.project.id}"` : `data-edit-initiative="${item.item.id}"`}><div class="deadline-top"><div class="deadline-tags"><span class="deadline-priority priority-${item.priority.toLowerCase()}">${escapeHtml(item.priority)}</span><span class="project-tag">${escapeHtml(item.project.name)}</span></div><span class="deadline-ddl">DDL ${formatDate(item.ddl)}</span></div><h3>${escapeHtml(isProject ? `${item.name} · 项目动作` : item.name)}</h3><p>${escapeHtml(item.action)}</p><div class="deadline-actions">${isProject ? `<button data-project-ai="${item.project.id}">项目 AI</button><button data-knowledge-search="${item.project.id}">查知识</button>` : `<button data-archive-initiative="${item.item.id}">归档事项</button><button data-knowledge-search="${item.project.id}" data-initiative-focus="${item.item.id}">查知识</button>`}</div></article>`; }).join('') : '<div class="empty-deadline">今天没有待完成的项目或事项 DDL。可以用这段时间补充项目现状、卡点或知识库。</div>'; }
function inlineText(kind, id, field, value, options={}) { const type = options.type || 'text'; const cls = options.cls || ''; const rows = options.rows || 2; if (options.select) return `<select class="inline-control ${cls}" data-inline-kind="${kind}" data-inline-id="${id}" data-inline-field="${field}">${options.select.map(option=>`<option value="${option}" ${option===value?'selected':''}>${option}</option>`).join('')}</select>`; if (type === 'textarea') return `<textarea class="inline-control inline-textarea ${cls}" data-inline-kind="${kind}" data-inline-id="${id}" data-inline-field="${field}" rows="${rows}">${escapeHtml(value || '')}</textarea>`; return `<input class="inline-control ${cls}" data-inline-kind="${kind}" data-inline-id="${id}" data-inline-field="${field}" type="${type}" value="${escapeHtml(type==='date' ? toInputDate(value || '') : (value || ''))}" />`; }
function inlineRichText(kind, id, field, value, images=[], rows=3) { const imageField = `${field}Images`; const previews=(images||[]).map((src,index)=>`<span class="inline-image-wrap"><img src="${src}" alt="已粘贴图片" /><button data-remove-inline-image-kind="${kind}" data-remove-inline-image-id="${id}" data-image-field="${imageField}" data-image-index="${index}" title="删除图片">×</button></span>`).join(''); return `<div class="inline-rich">${inlineText(kind,id,field,value,{type:'textarea',rows})}<div class="inline-image-list">${previews}</div><span class="paste-image-tip">可在此粘贴图片</span></div>`; }
function knowledgeCell(kind, id, links, projectId, initiativeId='') { const normalized = Array.isArray(links) ? links : []; const list = normalized.map(link => `<div class="inline-knowledge-link"><input class="inline-control inline-link" data-inline-kind="${kind}" data-inline-id="${id}" data-inline-field="knowledgeLinkUrl" data-link-id="${link.id}" type="url" value="${escapeHtml(link.url || '')}" placeholder="粘贴相关链接" title="链接会自动同步到项目知识库" />${link.url ? `<a class="inline-link-open" href="${escapeHtml(link.url)}" target="_blank" rel="noreferrer" title="打开链接">↗</a>` : ''}<button class="link-remove" data-remove-link-kind="${kind}" data-remove-link-id="${id}" data-link-id="${link.id}" title="删除链接">×</button>${link.url ? `<span class="link-theme" title="自动解析的主题">${escapeHtml(inferLinkTheme(link.url))}</span>` : ''}</div>`).join(''); return `<div class="inline-knowledge"><div class="inline-knowledge-links">${list || '<span class="no-link">暂无链接</span>'}</div><div class="inline-knowledge-actions"><button class="link-add" data-add-link-kind="${kind}" data-add-link-id="${id}">＋ 链接</button><button class="row-knowledge" data-knowledge-search="${projectId}" ${initiativeId ? `data-initiative-focus="${initiativeId}"` : ''}>查看</button></div></div>`; }
function latestAutomationTask(kind,id) { return state.automationTasks.filter(task=>task.targetKind===kind&&task.targetId===id).sort((a,b)=>String(b.createdAt||'').localeCompare(String(a.createdAt||'')))[0] || null; }
function automationTaskButton(kind,id) { const task=latestAutomationTask(kind,id); if(!task)return ''; const done=['completed','partial','failed','blocked'].includes(task.status); const label=task.status==='pending'?'待执行自动化任务':task.status==='running'?'执行自动化任务中，不支持点击':'查看自动化任务结果'; const unread=done&&!(task.readDates||[]).includes(TODAY); return `<button class="row-automation ${done?'is-finished':''}" ${done?`data-view-automation-task="${escapeHtml(task.id)}"`:'disabled'}>${unread?'<i class="automation-unread-dot"></i>':''}${label}</button>`; }
function initiativeTableRow(project, initiative, archived=false) { return `<tr class="initiative-row ${archived?'archived-row':''} ${riskClass(`${initiative.currentState} ${initiative.blocker}`)}" data-row-kind="initiative" data-row-id="${initiative.id}"><td>${inlineText('initiative',initiative.id,'priority',initiative.priority,{select:['P0','P1','P2'],cls:'inline-priority'})}</td><td><div class="overview-name initiative-overview-name"><span>└</span>${inlineText('initiative',initiative.id,'name',initiative.name,{type:'textarea',rows:2,cls:'inline-name'})}</div>${inlineRichText('initiative',initiative.id,'currentState',initiative.currentState,initiative.currentStateImages,4)}</td><td><div class="inline-next-action">${inlineText('initiative',initiative.id,'nextAction',initiative.nextAction,{type:'textarea',rows:2,cls:'inline-action'})}${inlineText('initiative',initiative.id,'nextActionDdl',initiative.nextActionDdl,{type:'date',cls:'inline-ddl'})}</div></td><td>${inlineRichText('initiative',initiative.id,'learning',initiative.learning,initiative.learningImages,3)}</td><td>${progressMultiSelect('initiative',initiative.id,initiative.progress)}</td><td>${inlineText('initiative',initiative.id,'plannedEnd',initiative.plannedEnd,{type:'date',cls:'inline-date'})}</td><td>${knowledgeCell('initiative',initiative.id,initiative.knowledgeLinks,project.id,initiative.id)}</td><td><div class="row-actions">${automationTaskButton('initiative',initiative.id)}<button class="row-ai" data-initiative-ai="${initiative.id}" title="以此事项为讨论对象">✦</button>${archived ? `<button class="row-add" data-unarchive-initiative="${initiative.id}">恢复</button>` : `<button class="row-archive" data-archive-initiative="${initiative.id}">归档</button>`}<button class="row-delete" data-delete-initiative="${initiative.id}">删除</button></div></td></tr>`; }
function renderProjectTable() { const body = document.getElementById('projectTable'); const rows = [...state.projects].sort((a,b) => priorityRank(a.priority) - priorityRank(b.priority) || a.name.localeCompare(b.name, 'zh-CN')).map(project => {
  const expanded = state.expandedProjectIds.includes(project.id);
  const projectRow = `<tr class="project-summary-row ${riskClass(`${project.currentState} ${project.blocker} ${project.progress}`)}" data-row-kind="project" data-row-id="${project.id}"><td>${inlineText('project',project.id,'priority',project.priority,{select:['P0','P1','P2'],cls:'inline-priority'})}</td><td><div class="overview-name"><button type="button" class="tree-toggle" data-toggle-project="${project.id}" aria-expanded="${expanded}" title="${expanded ? '收起事项' : '展开事项'}">${expanded ? '⌄' : '›'}</button>${inlineText('project',project.id,'name',project.name,{type:'textarea',rows:2,cls:'inline-name'})}</div>${inlineRichText('project',project.id,'currentState',project.currentState,project.currentStateImages,3)}</td><td><div class="inline-next-action">${inlineText('project',project.id,'nextAction',project.nextAction,{type:'textarea',rows:2,cls:'inline-action'})}${inlineText('project',project.id,'nextActionDdl',project.nextActionDdl,{type:'date',cls:'inline-ddl'})}</div></td><td>${inlineRichText('project',project.id,'learning',project.learning,project.learningImages,3)}</td><td>${progressMultiSelect('project',project.id,project.progress)}</td><td>${inlineText('project',project.id,'plannedEnd',project.plannedEnd,{type:'date',cls:'inline-date'})}</td><td>${knowledgeCell('project',project.id,project.knowledgeLinks,project.id)}</td><td><div class="row-actions">${automationTaskButton('project',project.id)}<button class="row-ai" data-project-ai="${project.id}" title="以整个项目为讨论对象">✦</button><button class="row-add" data-add-initiative="${project.id}">＋事项</button><button class="row-delete" data-delete-project="${project.id}">删除</button></div></td></tr>`;
  const active = expanded ? project.initiatives.filter(initiative=>!initiative.archived).sort((a,b) => priorityRank(a.priority) - priorityRank(b.priority) || a.name.localeCompare(b.name, 'zh-CN')).map(initiative=>initiativeTableRow(project,initiative)).join('') : '';
  const archived = project.initiatives.filter(initiative=>initiative.archived); const archivedExpanded=state.expandedArchivedProjectIds.includes(project.id);
  const archiveRows = expanded && archived.length ? `<tr class="archived-toggle-row"><td class="table-sticky-priority-cell"></td><td colspan="7" class="table-action-row-fill"><div class="initiative-name archive-disclosure"><span>└</span><div><button data-toggle-archived="${project.id}">${archivedExpanded ? '收起已归档事项' : `查看已归档事项（${archived.length}）`}</button><small>${archivedExpanded ? '已展开该项目全部已归档事项。' : '归档事项默认不参与今日 DDL 和项目时间线。'}</small></div></div></td></tr>${archivedExpanded ? [...archived].sort((a,b) => priorityRank(a.priority) - priorityRank(b.priority) || a.name.localeCompare(b.name, 'zh-CN')).map(initiative=>initiativeTableRow(project,initiative,true)).join('') : ''}` : '';
  return projectRow + active + archiveRows;
 }).join('');
 body.innerHTML = rows + `<tr class="table-add-row"><td colspan="8" class="table-add-row-fill"><button class="table-add-project" data-add-project>＋ 添加项目</button><span>项目创建后，可在现状列中直接增加事项。</span></td></tr>`; }
function renderTimeline() { const events = getOpenActions().map(({project,initiative}) => ({date:initiative.nextActionDdl, project, initiative, title:initiative.nextAction, state:isOverdue(initiative.nextActionDdl) ? 'risk' : isToday(initiative.nextActionDdl) ? 'today' : 'plan'})).sort((a,b)=>a.date.localeCompare(b.date)); const root = document.getElementById('largeTimeline'); root.innerHTML = events.length ? `<div class="event-list">${events.map(event => `<article class="event-row ${event.state}" data-edit-initiative="${event.initiative.id}"><div class="event-date"><b>${formatDate(event.date)}</b><span>${isToday(event.date) ? '今天' : '待推进'}</span></div><div class="event-marker"><i></i></div><div class="event-content"><div><span class="event-project">${escapeHtml(event.project.name)}</span><h4>${escapeHtml(event.title)}</h4></div><p>${escapeHtml(event.initiative.name)}：${escapeHtml(event.initiative.currentState || '待补充现状')}</p></div><div class="event-ddl"><span>DDL</span><b>${formatDate(event.date)}</b></div></article>`).join('')}</div>` : '<div class="empty-state">尚无带 DDL 的下一步动作。请在项目或事项编辑中填写下一步动作和 DDL。</div>'; }
function renderKnowledgeFilters() { const select = document.getElementById('knowledgeProjectFilter'); select.innerHTML = `<option value="ALL">全部项目</option>${state.projects.map(project => `<option value="${project.id}">${escapeHtml(project.name)}</option>`).join('')}`; select.value = state.knowledgeFilter.projectId; document.getElementById('knowledgeSearchInput').value = state.knowledgeFilter.query; document.getElementById('allKnowledgeCount').textContent = state.knowledgeItems.length; document.querySelectorAll('[data-knowledge-type]').forEach(button => button.classList.toggle('active', button.dataset.knowledgeType === state.knowledgeFilter.type)); }
function filteredKnowledge() { const {projectId, query, type} = state.knowledgeFilter; const normalized = query.trim().toLowerCase(); return state.knowledgeItems.filter(item => {
  const projectMatch = projectId === 'ALL' || item.projectId === projectId;
  const typeMatch = type === 'ALL' || item.type === type;
  const corpus = `${item.title} ${item.summary} ${item.content} ${projectName(item.projectId)} ${initiativeName(item.initiativeId)}`.toLowerCase();
  return projectMatch && typeMatch && (!normalized || corpus.includes(normalized));
 }); }
function projectName(projectId) { return getProject(projectId)?.name || '未关联项目'; }
function renderProjectMemory() { const projectSelect=document.getElementById('memoryProjectFilter'); const initiativeSelect=document.getElementById('memoryInitiativeFilter'); const list=document.getElementById('projectMemoryList'); if(!projectSelect || !initiativeSelect || !list) return; projectSelect.innerHTML=state.projects.map(project=>`<option value="${project.id}">${escapeHtml(project.name)}</option>`).join(''); if(!getProject(state.memoryFilter.projectId)) { state.memoryFilter.projectId=state.selectedProjectId || state.projects[0]?.id || ''; state.memoryFilter.initiativeId='ALL'; } projectSelect.value=state.memoryFilter.projectId; const project=getProject(state.memoryFilter.projectId); if(!project) { list.innerHTML='<div class="empty-state compact">暂无项目存储数据。</div>'; return; } const initiatives=project.initiatives||[]; if(state.memoryFilter.initiativeId!=='ALL'&&!initiatives.some(item=>item.id===state.memoryFilter.initiativeId)) state.memoryFilter.initiativeId='ALL'; initiativeSelect.innerHTML=`<option value="ALL">全部事项</option>${initiatives.map(initiative=>`<option value="${initiative.id}">${escapeHtml(initiative.name || initiative.id)}</option>`).join('')}`; initiativeSelect.value=state.memoryFilter.initiativeId; const globalMemory=state.longTermMemories.filter(item=>item.scope==='global'); const projectConversationMemory=Array.isArray(project.memory)?project.memory.slice(-6):[]; const projectLongTermMemory=state.longTermMemories.filter(item=>item.projectId===project.id && !item.initiativeId); const raw=value=>escapeHtml(JSON.stringify(value,null,2)); const section=(key,label,value,meta='')=>`<section class="memory-inspector-section"><header><div><span>${key}</span><b>${label}${meta?` · ${meta}`:''}</b></div></header><pre>${raw(value)}</pre></section>`; const conversationSections=(owner,keyPrefix)=>section(`${keyPrefix}.conversationSummary`,'Conversation Summary',owner.conversationSummary||null,owner.conversationSummary?`已覆盖 ${owner.conversationSummary.coveredMessageCount||0} 条消息`:'尚未生成')+section(`${keyPrefix}.memory`,'Conversation Memory',Array.isArray(owner.memory)?owner.memory.slice(-6):[],`仅保留最近 ${(owner.memory||[]).slice(-6).length} / 6 条原始消息`); const visibleInitiatives=state.memoryFilter.initiativeId==='ALL'?initiatives:initiatives.filter(item=>item.id===state.memoryFilter.initiativeId); const initiativeSections=visibleInitiatives.map(initiative=>{ const longTermMemory=state.longTermMemories.filter(item=>item.projectId===project.id && item.initiativeId===initiative.id); return `<section class="memory-scope-group"><h3>事项记忆 · ${escapeHtml(initiative.name || initiative.id)}</h3>${conversationSections(initiative,`initiative:${initiative.id}`)}${section(`state.longTermMemories (initiative:${initiative.id})`,'事项 Long-term Memory',longTermMemory,`${longTermMemory.length} 条`)}</section>`; }).join('') || '<div class="empty-state compact">该筛选下暂无事项。</div>'; const initiativeLabel=state.memoryFilter.initiativeId==='ALL'?'事项记忆 · 全部':'事项记忆 · 已筛选'; list.innerHTML=section('state.longTermMemories (global)','Global Memory',globalMemory,`${globalMemory.length} 条`)+`<section class="memory-scope-group"><h3>项目记忆 · ${escapeHtml(project.name)}</h3>${conversationSections(project,'project')}${section('state.longTermMemories (project)','项目 Long-term Memory',projectLongTermMemory,`${projectLongTermMemory.length} 条`)}</section>`+`<section class="memory-scope-group memory-initiative-groups"><h3>${initiativeLabel}</h3>${initiativeSections}</section>`; }
function initiativeName(initiativeId) { return initiativeId ? getInitiative(initiativeId)?.initiative.name || '' : ''; }
function hasUsableRecoveryProfile(profile) { return Boolean(profile && Array.isArray((profile.data||profile).metricGroups) && (profile.data||profile).metricGroups.some(group=>group && typeof group==='object' && Array.isArray(group.metrics) && group.metrics.length)); }
function editRecoveryProfile(id) { const profile=state.longTermMemories.find(item=>item.id===id); if(!profile) return; state.selectedProjectId=profile.projectId; state.selectedInitiativeId=''; state.aiCollapsed=false; saveState(); renderAll(); document.getElementById('chatInput').focus(); toast('请直接在 AI 中说明要修改哪些指标组或指标；AI 会再次展示变更并要求确认。'); }
function renderKnowledge() { const items = filteredKnowledge(); const list = document.getElementById('knowledgeList'); if (!items.length) { list.innerHTML = '<div class="empty-state compact">没有匹配的知识。可以点击“新增知识”将当前项目的方案、实验或学习沉淀下来。</div>'; document.getElementById('knowledgeDetail').innerHTML = '<div class="empty-state compact">选择一条知识查看详情。</div>'; return; } list.innerHTML = items.map((item,index)=>`<div class="knowledge-list-row"><button class="knowledge-item ${index===0?'active':''}" data-show-knowledge="${item.id}"><span>${escapeHtml(item.type)}</span><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(projectName(item.projectId))} · ${escapeHtml(item.summary || '无摘要')}</p></button><button class="knowledge-list-delete" data-delete-knowledge="${item.id}" title="删除知识" aria-label="删除知识">×</button></div>`).join(''); showKnowledge(items[0].id); }
async function refreshSkillLibrary() { if(!API_ENDPOINT) return; try { const response=await fetch('/api/skills',{cache:'no-store'}); const payload=await response.json(); if(!response.ok) throw new Error(payload.error || `Skills 加载失败（${response.status}）`); skillLibrary=payload; renderCounts(); renderCliSkills(); } catch(error) { console.warn('Skill library unavailable:',error.message); } }
function renderCliSkills() { const root=document.getElementById('cliSkillList'); if(!root) return; const parents=skillLibrary.parents || []; if(!parents.length){root.innerHTML='<div class="empty-state compact">暂无 Skill 文件。请在项目根目录 skills/ 下创建父目录和一个顶层 Markdown 父 Skill。</div>';return;} root.innerHTML=`<div class="skill-selection-note">模型检索到的父/子 Skill 全文会自动带入当前 Run 的后续 Context。</div>${parents.map(parent=>`<section class="cli-skill-group"><header><div><span class="eyebrow">PARENT SKILL</span><h3>${escapeHtml(parent.title)}</h3><p>${escapeHtml(parent.summary || '无摘要')}</p></div><div class="skill-entry-actions"><button class="secondary-button" data-open-parent-skill="${escapeHtml(parent.skillPath)}">${parent.childCount?`子 Skill ${parent.childCount}`:'无子 Skill'}</button><button class="skill-delete-button" data-delete-skill="${escapeHtml(parent.skillPath)}" title="删除父 Skill">×</button></div></header><div class="cli-skill-meta"><code>${escapeHtml(parent.skillPath)}</code></div>${selectedSkillParentPath===parent.skillPath&&parent.children.length?`<div class="cli-skill-entries">${parent.children.map(child=>`<div class="skill-child-row"><span><b>${escapeHtml(child.title)}</b><small>${escapeHtml(child.summary || '')}</small><code>${escapeHtml(child.skillPath)}</code></span><button type="button" class="skill-delete-button" data-delete-skill="${escapeHtml(child.skillPath)}" title="删除子 Skill">×</button></div>`).join('')}</div>`:''}</section>`).join('')}${skillLibrary.errors?.length?`<div class="run-step-error">${skillLibrary.errors.map(item=>escapeHtml(`${item.parentDir}：${item.error}`)).join('<br>')}</div>`:''}`; }
function formatRunTime(value) { return value ? new Date(value).toLocaleDateString('zh-CN', { timeZone:'Asia/Shanghai' }) : '执行中'; }
function formatRunDuration(value) { return Number.isFinite(value) ? `${(value / 1000).toFixed(value < 1000 ? 2 : 1)} 秒` : '—'; }
function formatTokenUsage(usage) { if (!usage || typeof usage !== 'object') return ''; const parts=[]; if(Number.isFinite(usage.inputTokens)) parts.push(`Input ${usage.inputTokens.toLocaleString('en-US')}`); if(Number.isFinite(usage.outputTokens)) parts.push(`Output ${usage.outputTokens.toLocaleString('en-US')}`); return parts.join(' · '); }
function renderJsonValue(value, depth=0) { if(value===null)return '<span class="json-null">null</span>'; if(typeof value==='string')return `<span class="json-string">${escapeHtml(JSON.stringify(value))}</span>`; if(typeof value==='number')return `<span class="json-number">${value}</span>`; if(typeof value==='boolean')return `<span class="json-boolean">${value}</span>`; const isArray=Array.isArray(value); const entries=isArray?value.map((item,index)=>[index,item]):Object.entries(value||{}); const open=depth<1?' open':''; const label=isArray?`Array(${entries.length})`:`Object(${entries.length})`; if(!entries.length)return `<span class="json-empty">${isArray?'[]':'{}'}</span>`; return `<details class="json-node"${open}><summary>${isArray?'[':'{'} <span>${label}</span> ${isArray?']':'}'}</summary><div class="json-children">${entries.map(([key,item])=>`<div class="json-row"><span class="json-key">${isArray?key:escapeHtml(JSON.stringify(key))}</span><span class="json-colon">: </span>${renderJsonValue(item,depth+1)}</div>`).join('')}</div></details>`; }
function promptSnapshotForDisplay(snapshot) { if (!snapshot || typeof snapshot !== 'object') return snapshot; const { context, charCounts, ...visible } = snapshot; const { context:contextChars, ...visibleCharCounts } = charCounts || {}; return { ...visible, charCounts:visibleCharCounts, contextIncludedInUserPrompt:true }; }
function filteredAgentRuns() {
  return state.agentRuns.filter(run=>(state.agentRunFilter.projectId==='ALL'||run.projectId===state.agentRunFilter.projectId)&&(state.agentRunFilter.status==='ALL'||run.status===state.agentRunFilter.status));
}

function renderAgentRunDetails(run) {
  const steps=(run.steps||[]).map((step,index)=>{
    const snapshotId=step.output?.snapshotId || step.input?.snapshotId || '';
    const usage=step.output?.usage;
    const usageLabel=step.type==='llm' ? formatTokenUsage(usage) : '';
    return `<details class="run-step ${escapeHtml(step.status || '')}"><summary><span>Step ${index+1}</span><b>${escapeHtml(step.label || step.name || step.type || '执行步骤')}</b>${usageLabel?`<span class="run-token-usage">${escapeHtml(usageLabel)}</span>`:''}<em>${escapeHtml(step.status || 'unknown')}</em></summary><div class="run-step-body">${usageLabel?`<div class="run-token-usage-detail">本次模型调用：${escapeHtml(usageLabel)}</div>`:''}<h4>Input</h4><div class="step-json">${renderJsonValue(step.input || {})}</div><h4>Output</h4><div class="step-json">${renderJsonValue(step.output || {})}</div>${snapshotId?`<button class="secondary-button" data-show-agent-snapshot="${escapeHtml(snapshotId)}" data-agent-run-id="${escapeHtml(run.id)}">查看 Prompt Snapshot</button><div class="agent-log-lazy-output"></div>`:''}${step.error?`<div class="run-step-error">${escapeHtml(step.error)}</div>`:''}</div></details>`;
  }).join('');
  return `<section class="run-timeline">${steps || '<div class="empty-state compact">暂无步骤。</div>'}</section><div class="run-detail-actions"><button class="secondary-button" data-show-agent-raw="${escapeHtml(run.id)}">查看原始 JSON</button><div class="agent-log-lazy-output"></div></div>`;
}

function renderAgentRuns() {
  const projectSelect=document.getElementById('agentRunProjectFilter');const statusSelect=document.getElementById('agentRunStatusFilter');const list=document.getElementById('agentRunList');if(!projectSelect||!statusSelect||!list)return;
  projectSelect.innerHTML=`<option value="ALL">全部项目</option>${state.projects.map(project=>`<option value="${project.id}">${escapeHtml(project.name)}</option>`).join('')}`;projectSelect.value=state.agentRunFilter.projectId;statusSelect.value=state.agentRunFilter.status;
  const items=filteredAgentRuns();const limit=state.agentRunLimit || 10;const visible=items.slice(0,limit);
  const card=run=>{ const usageLabel=formatTokenUsage(run.modelUsage); return `<article class="timeline-run ${escapeHtml(run.status || '')}"><header><div><span class="run-status">${escapeHtml(run.status || 'unknown')}</span><b>${escapeHtml(projectName(run.projectId))}</b></div><time>${escapeHtml(formatRunTime(run.startedAt))}</time></header><h3>${escapeHtml(run.messagePreview || run.type || 'Agent Run')}</h3><div class="run-summary"><span>耗时 ${escapeHtml(formatRunDuration(run.durationMs))}</span><span>Loop ${escapeHtml(String(run.loop?.usedSteps || 1))}/${escapeHtml(String(run.loop?.maxSteps || 1))}${run.loop?.limitReached?' · 已达上限':''}</span><span>${(run.steps||[]).length} 个步骤</span>${usageLabel?`<span class="run-token-usage">模型累计 ${escapeHtml(usageLabel)}</span>`:''}${run.planRef?`<span>Plan ${escapeHtml(run.planRef.planId)} · v${escapeHtml(String(run.planRef.revision))}</span>`:''}</div>${run.error?`<div class="run-step-error">${escapeHtml(run.error)}</div>`:''}<button class="secondary-button" data-expand-agent-run="${escapeHtml(run.id)}">展开步骤与快照</button><div class="agent-run-details" data-agent-run-details="${escapeHtml(run.id)}"></div></article>`; };
  list.innerHTML=visible.length?visible.map(card).join(''):'<div class="empty-state compact">暂无执行日志。</div>';
  if(items.length>visible.length)list.insertAdjacentHTML('beforeend',`<button class="secondary-button agent-run-load-more" data-load-more-agent-runs>加载更多（已显示 ${visible.length}/${items.length}）</button>`);
}

function automationTriggerText(trigger={}) { if(trigger.type==='daily')return `每天 ${trigger.time}`; if(trigger.type==='weekly')return `每周 ${(trigger.weekdays||[]).map(day=>['日','一','二','三','四','五','六'][day]).join('、')} ${trigger.time}`; if(trigger.type==='due_today')return `今天到期 · ${trigger.time}`; return `事件触发：${(trigger.events||[]).join('、') || '状态变更'}`; }
function automationPlanPreview(record) { if(!record)return '<div class="empty-state compact">暂无自动化规则。请先输入自然语言规则。</div>'; const plan=record.plan||{}; const errors=record.errors||[]; return `<div class="automation-preview-head"><div><span class="eyebrow">${record.feasible?'IMPLEMENTABLE':'NOT IMPLEMENTABLE'}</span><h2>${escapeHtml(record.title||plan.title||'自动化规则')}</h2><p>${escapeHtml(plan.summary||record.naturalLanguage||'')}</p></div><span class="automation-feasible ${record.feasible?'yes':'no'}">${record.feasible?'可实现':'不可实现'}</span></div>${errors.length?`<div class="automation-errors">${errors.map(error=>`<p>${escapeHtml(error)}</p>`).join('')}</div>`:''}<section class="automation-preview-section"><h3>触发条件</h3><p>${escapeHtml(automationTriggerText(plan.trigger))}</p><pre>${escapeHtml(JSON.stringify(plan.match||{},null,2))}</pre></section><section class="automation-preview-section"><h3>具体任务</h3><p>${escapeHtml(plan.task||plan.summary||'未识别到具体任务。')}</p><small>触发后会将此任务和命中目标作为普通用户输入，交由 Agent 根据 Provider tools 的详细 Schema 自主选择工具和参数。</small></section><section class="automation-preview-section"><h3>调用模型</h3><select id="automationPreviewModel">${chatModelCatalog.map(model=>`<option value="${escapeHtml(model.id)}" ${model.id===record.modelId?'selected':''}>${escapeHtml(model.label)}</option>`).join('')}</select></section>${record.feasible&&!record.confirmedAt?`<button class="primary-button" data-confirm-automation-plan="${escapeHtml(record.id)}">确认并开启自动化执行</button>`:''}${(() => { const rule=(state.automationRules||[]).find(item=>item.automationPlanId===record.id); return rule?`<div class="automation-rule-edit-actions"><button class="secondary-button" data-edit-automation-rule="${escapeHtml(rule.id)}">编辑规则</button><button class="secondary-button automation-delete-rule" data-delete-automation-rule="${escapeHtml(rule.id)}">删除规则</button></div>`:''; })()}`; }

function renderAutomation() { const modelSelect=document.getElementById('automationModelSelect'); if(modelSelect){modelSelect.innerHTML=chatModelCatalog.map(model=>`<option value="${escapeHtml(model.id)}">${escapeHtml(model.label)}</option>`).join('')||'<option value="">正在加载模型…</option>'; const fallback=chatModelCatalog.find(model=>/flash/i.test(model.id))?.id||state.selectedChatModel||chatModelCatalog[0]?.id||''; if(!modelSelect.value)modelSelect.value=fallback;} const status=document.getElementById('automationPlanningStatus'); if(status)status.textContent=automationPlanning?'AI 正在识别命中条件、触发时间和具体任务…':''; const button=document.getElementById('automationPlanButton'); if(button)button.disabled=automationPlanning; const list=document.getElementById('automationRuleList'); const preview=document.getElementById('automationRulePreview'); if(!list||!preview)return; const rules=state.automationRules||[]; list.innerHTML=rules.length?rules.map(rule=>`<button class="automation-rule-item ${rule.automationPlanId===selectedAutomationPlanId?'active':''}" data-select-automation-plan="${escapeHtml(rule.automationPlanId)}"><span><b>${escapeHtml(rule.title)}</b><small>${rule.enabled?'已开启':'已关闭'}</small></span><i class="automation-toggle ${rule.enabled?'on':''}" data-toggle-automation-rule="${escapeHtml(rule.id)}" data-enabled="${String(!rule.enabled)}">${rule.enabled?'自动化执行中':'开启自动化执行'}</i></button>`).join(''):'<div class="empty-state compact">暂无已保存规则。</div>'; const selected=automationDraft||(state.automationPlans||[]).find(plan=>plan.id===selectedAutomationPlanId)||(rules[0]?(state.automationPlans||[]).find(plan=>plan.id===rules[0].automationPlanId):null); if(selected&&!selectedAutomationPlanId)selectedAutomationPlanId=selected.id; preview.innerHTML=automationPlanPreview(selected); }
async function createAutomationPlan() { const input=document.getElementById('automationRuleInput'); const model=document.getElementById('automationModelSelect'); const description=input?.value.trim(); if(!description)return toast('请输入自动化规则。'); automationPlanning=true; automationDraft=null; renderAutomation(); try{ const response=await fetch('/api/automation/plans',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({description,model:model?.value||'',replaceRuleId:editingAutomationRuleId||undefined})}); const payload=await response.json(); if(payload.state&&typeof payload.state==='object'){state=payload.state;normalizeState();} automationDraft=payload.plan||null; selectedAutomationPlanId=payload.plan?.id||''; renderAll(); if(!response.ok)toast(payload.error||payload.errors?.join('；')||'规则不可实现'); else toast('自动化规则已识别，请确认后开启。'); }catch(error){toast(error.message||'规则识别失败');}finally{automationPlanning=false;renderAutomation();} }
async function confirmAutomationPlan(planId) { const response=await fetch('/api/automation/rules/confirm',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({automationPlanId:planId,modelId:document.getElementById('automationPreviewModel')?.value||''})}); const payload=await response.json(); if(!response.ok)return toast(payload.error||'规则确认失败'); if(payload.state){state=payload.state;normalizeState();} automationDraft=null; editingAutomationRuleId=''; selectedAutomationPlanId=planId; renderAll(); toast('自动化执行已开启，并开始检查当前命中动作。'); }
async function toggleAutomationRule(ruleId,enabled) { const response=await fetch(`/api/automation/rules/${encodeURIComponent(ruleId)}/toggle`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled})}); const payload=await response.json(); if(!response.ok)return toast(payload.error||'自动化规则更新失败'); if(payload.state){state=payload.state;normalizeState();} renderAll(); toast(enabled?'自动化执行已开启':'自动化执行已关闭'); }
function editAutomationRule(ruleId) { const rule=state.automationRules.find(item=>item.id===ruleId); if(!rule)return; editingAutomationRuleId=rule.id; automationDraft=null; selectedAutomationPlanId=rule.automationPlanId; const input=document.getElementById('automationRuleInput'); const model=document.getElementById('automationModelSelect'); if(input)input.value=rule.naturalLanguage||''; if(model)model.value=rule.modelId||state.selectedChatModel; renderAutomation(); input?.focus(); toast('已载入规则。修改自然语言后重新识别并确认即可生效。'); }
async function deleteAutomationRule(ruleId) { const rule=state.automationRules.find(item=>item.id===ruleId); if(!rule)return; if(!confirm(`确认删除自动化规则「${rule.title}」吗？已生成的执行记录会保留。`))return; const response=await fetch(`/api/automation/rules/${encodeURIComponent(ruleId)}`,{method:'DELETE'}); const payload=await response.json(); if(!response.ok)return toast(payload.error||'自动化规则删除失败'); if(payload.state){state=payload.state;normalizeState();} if(editingAutomationRuleId===ruleId)editingAutomationRuleId=''; if(selectedAutomationPlanId===rule.automationPlanId)selectedAutomationPlanId=''; automationDraft=null; renderAll(); toast('自动化规则已删除。'); }
async function viewAutomationTask(taskId) { const response=await fetch(`/api/automation/tasks/${encodeURIComponent(taskId)}`); const payload=await response.json(); if(!response.ok)return toast(payload.error||'自动化任务读取失败'); if(payload.state){state=payload.state;normalizeState();} const task=payload.task; if(task.targetKind==='initiative')selectAssistantTarget(`initiative:${task.targetId}`); else selectAssistantTarget(`project:${task.projectId}`); state.aiCollapsed=false; renderShell(); renderAssistant(); await fetch(`/api/automation/tasks/${encodeURIComponent(taskId)}/read`,{method:'POST'}); const local=state.automationTasks.find(item=>item.id===taskId); if(local&&!local.readDates.includes(TODAY))local.readDates.push(TODAY); renderProjectTable(); toast('已在右侧 AI 助手中打开自动化任务结果'); }

function showKnowledge(id) { const item = state.knowledgeItems.find(entry=>entry.id===id); if (!item) return; document.querySelectorAll('.knowledge-item').forEach(el=>el.classList.toggle('active',el.dataset.showKnowledge===id)); const initiative = item.initiativeId ? initiativeName(item.initiativeId) : ''; document.getElementById('knowledgeDetail').innerHTML = `<span class="detail-type">${escapeHtml(item.type)}</span><h2>${escapeHtml(item.title)}</h2><div class="detail-meta">关联项目：${escapeHtml(projectName(item.projectId))}${initiative ? ` · 事项：${escapeHtml(initiative)}` : ''} · 记录于 ${formatDate(item.createdAt)}</div><section class="detail-section"><h4>摘要</h4><p>${escapeHtml(item.summary || '暂无摘要')}</p></section><section class="detail-section"><h4>内容</h4><p>${escapeHtml(item.content || '暂无内容').replaceAll('\n','<br>')}</p></section>${item.sourceUrl ? `<a class="source-pill" href="${escapeHtml(item.sourceUrl)}" target="_blank" rel="noreferrer">↗ 打开来源链接</a>` : ''}<div class="detail-actions"><button class="secondary-button" data-edit-knowledge="${item.id}">编辑知识</button><button class="secondary-button knowledge-delete" data-delete-knowledge="${item.id}">删除知识</button></div>`; }
function renderTeams() { document.getElementById('teamTable').innerHTML = `<div class="team-row team-header"><span>协作团队</span><span>默认预留</span><span>推进顺序</span><span>协作规则</span><span></span></div>${teamRules.map(rule=>`<div class="team-row"><div class="team-name"><i class="team-symbol">${rule.symbol}</i>${rule.name}</div><b>${rule.lead}</b><span>${rule.order}</span><span>${rule.rule}</span><button>参考</button></div>`).join('')}`; }
function activeConversation() { return state.conversations.find(conversation=>conversation.id===state.selectedConversationId)||null; }
function conversationTargetRecord(conversation) { return { project:conversation?.projectId?getProject(conversation.projectId):null, initiative:conversation?.initiativeId?getInitiative(conversation.initiativeId)?.initiative:null }; }
function assistantTargetOptions() { return `<button type="button" class="assistant-target-option" data-assistant-target="global">无主题对话 <small>可查询所有项目/事项</small></button>${state.projects.map(project=>`<section class="assistant-target-group"><b>${escapeHtml(project.name)}</b><button type="button" class="assistant-target-option" data-assistant-target="project:${escapeHtml(project.id)}">项目 · ${escapeHtml(project.name)}</button>${project.initiatives.map(initiative=>`<button type="button" class="assistant-target-option is-initiative" data-assistant-target="initiative:${escapeHtml(initiative.id)}">事项 · ${escapeHtml(initiative.name)}</button>`).join('')}</section>`).join('')}`; }
function createConversation(scope='global',projectId='',initiativeId='') { const record={id:uid('conversation'),scope,projectId,initiativeId,title:scope==='global'?'无主题对话':'',memory:[],conversationSummary:null,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()}; const target=conversationTargetRecord(record); record.title=scope==='initiative'?`事项 · ${target.initiative?.name||''}`:scope==='project'?`项目 · ${target.project?.name||''}`:'无主题对话'; state.conversations.unshift(record); state.selectedConversationId=record.id; return record; }
function openConversationScope(scope='global',projectId='',initiativeId='',fresh=false) { const record=fresh?null:state.conversations.filter(item=>item.scope===scope&&item.projectId===projectId&&item.initiativeId===initiativeId).sort((a,b)=>String(b.updatedAt).localeCompare(String(a.updatedAt)))[0]; state.selectedProjectId=projectId||state.selectedProjectId;state.selectedInitiativeId=initiativeId||'';state.selectedConversationId=(record||createConversation(scope,projectId,initiativeId)).id;assistantTargetMenuOpen=false;assistantHistoryMenuOpen=false;state.aiCollapsed=false;saveState();renderShell();renderAssistant();document.getElementById('chatInput')?.focus(); }
function selectAssistantTarget(value) { const [kind,id]=String(value||'').split(':'); const fromGlobal=activeConversation()?.scope==='global'; if(kind==='global')return openConversationScope('global'); if(kind==='project'&&getProject(id))return openConversationScope('project',id,'',fromGlobal); if(kind==='initiative'){const record=getInitiative(id);if(record)return openConversationScope('initiative',record.project.id,record.initiative.id,fromGlobal);} }
function renderQuickPrompts() { const root=document.getElementById('quickPrompts'); if(!root)return; root.innerHTML=`<button type="button" class="quick-prompt-trigger" data-toggle-quick-prompts aria-expanded="${quickPromptMenuOpen}">快捷提示 <i>⌄</i></button>${quickPromptMenuOpen?`<div class="quick-prompt-menu"><button type="button" data-ai-prompt="回收实验数据">回收实验数据</button>${customQuickPromptOpen?`<label><input id="customQuickPrompt" type="text" placeholder="输入快捷提示" /><button type="button" data-submit-ai-prompt>发送</button></label>`:`<button type="button" class="quick-prompt-add" data-add-ai-prompt>＋ 自定义</button>`}</div>`:''}`; }
function closeAssistantOverlaysOutside(target) { const outsideTargetMenu=assistantTargetMenuOpen&&!target.closest('#assistantTargetTrigger,#assistantTargetMenu');const outsideHistory=assistantHistoryMenuOpen&&!target.closest('#assistantHistoryButton,#assistantHistoryMenu');const outsideQuickPrompts=quickPromptMenuOpen&&!target.closest('#quickPrompts');const outsideNotifications=notificationMenuOpen&&!target.closest('#notificationButton,#notificationMenu');if(!outsideTargetMenu&&!outsideHistory&&!outsideQuickPrompts&&!outsideNotifications)return;assistantTargetMenuOpen=false;assistantHistoryMenuOpen=false;quickPromptMenuOpen=false;customQuickPromptOpen=false;notificationMenuOpen=false;renderAssistant();renderNotifications(); }
function runHasModelReply(run) { if(run?.hasModelReply===true||run?.status==='completed')return true;if(run?.hasModelReply===false)return false;const texts=[run?.historySummary,...(run?.steps||[]).filter(step=>step?.type==='llm').map(step=>step?.output?.assistantText)];return !run?.error&&texts.some(text=>{const value=String(text||'').trim();return value&&!['正在准备执行请求…','正在继续执行任务…','[模型仅返回工具调用]'].includes(value);}); }
function activeRequestForConversation(conversationId='') { return [...activeAgentRequests.values()].find((request)=>request.conversationId===conversationId) || null; }
function refreshAgentBusyUi() { aiBusy=activeAgentRequests.size>0; setChatBusy(Boolean(activeRequestForConversation(activeConversation()?.id || ''))); }
function latestManualRerunCandidate(conversation) { if(aiBusy)return null; const run=(state.agentRuns || []).find((item)=>item.conversationId===conversation?.id); return run && !runHasModelReply(run) && !run.manualRerunPending && !run.manualRerunRunId ? run : null; }
function renderAssistant() { let conversation=activeConversation();if(!conversation)conversation=createConversation('global');const {project,initiative}=conversationTargetRecord(conversation);const scope=conversation.scope;const pending=project?state.proposals.filter(proposal=>proposal.projectId===project.id&&proposal.status==='pending'&&proposal.initiativeId===(initiative?.id||'')):[];const rerunCandidate=latestManualRerunCandidate(conversation);const manualRerun=rerunCandidate?`<div class="assistant-manual-rerun"><span>上一条消息未收到模型回复。</span><button type="button" data-rerun-agent-run="${escapeHtml(rerunCandidate.id)}">重试1次</button></div>`:'';const activeRequest=activeRequestForConversation(conversation.id);const liveProgress=activeRequest?`<div class="assistant-message ai-loading" role="status" aria-live="polite">${escapeHtml(activeRequest.progress?.message||'AI 正在执行…')}</div>`:'';document.getElementById('assistantName').textContent=scope==='global'?'AI 助手':`${initiative?.name||project?.name||'讨论对象'} · AI`;document.getElementById('assistantContext').textContent=scope==='global'?'无主题对话 · 可按需查询所有项目/事项':scope==='initiative'?`讨论对象：事项「${initiative?.name}」· 仅显示该事项的历史对话`:`讨论对象：项目「${project?.name}」· 仅显示该项目的历史对话`;const targetMenu=document.getElementById('assistantTargetMenu');const targetTrigger=document.getElementById('assistantTargetTrigger');if(targetMenu){targetMenu.hidden=!assistantTargetMenuOpen;targetMenu.innerHTML=assistantTargetOptions();}if(targetTrigger)targetTrigger.setAttribute('aria-expanded',String(assistantTargetMenuOpen));const historyMenu=document.getElementById('assistantHistoryMenu');if(historyMenu){const rows=state.conversations.filter(item=>item.scope===scope&&item.projectId===conversation.projectId&&item.initiativeId===conversation.initiativeId).sort((a,b)=>String(b.updatedAt).localeCompare(String(a.updatedAt)));historyMenu.hidden=!assistantHistoryMenuOpen;historyMenu.innerHTML=rows.map(item=>`<div class="assistant-history-row ${item.id===conversation.id?'active':''}"><button type="button" class="assistant-history-item" data-open-conversation="${escapeHtml(item.id)}"><b>${escapeHtml(item.title||'新对话')}</b><small>${escapeHtml((item.memory||[]).at(-1)?.text||item.conversationSummary?.summary||'新对话').slice(0,70)}</small></button><button type="button" class="assistant-conversation-delete" data-delete-conversation="${escapeHtml(item.id)}" aria-label="删除对话" title="删除对话">×</button></div>`).join('')||'<p>暂无历史对话</p>';}document.getElementById('chatInput').placeholder=scope==='global'?'和 AI 助手讨论任意项目、事项或方案...':scope==='initiative'?`围绕事项「${initiative?.name}」讨论...`:`和「${project?.name}」的 AI 讨论方案...`;const modelSelect=document.getElementById('chatModelSelect');if(modelSelect){modelSelect.innerHTML=chatModelCatalog.map(model=>`<option value="${escapeHtml(model.id)}">${escapeHtml(model.label)}${model.supportsVision?' · 图片':''}</option>`).join('')||'<option>正在加载模型…</option>';modelSelect.value=state.selectedChatModel;modelSelect.disabled=!chatModelCatalog.length||Boolean(activeRequest);}document.getElementById('chatHistory').innerHTML=`${pending.length?`<section class="pending-proposals"><span>待确认提案 ${pending.length}</span>${pending.map(proposal=>`<div class="proposal-row"><b>${escapeHtml(proposal.title)}</b><p>${escapeHtml(proposal.rationale||`${proposal.field} 将更新为：${proposal.value}`)}</p><button data-confirm-proposal="${proposal.id}">确认写入</button></div>`).join('')}</section>`:''}${(conversation.memory||[]).map(message=>`<div class="${message.role==='user'?'user-message':'assistant-message'}">${renderChatMessage(message)}</div>`).join('')}${manualRerun}${liveProgress}`;renderQuickPrompts();setChatBusy(Boolean(activeRequest));requestAnimationFrame(()=>{const history=document.getElementById('chatHistory');if(history)history.scrollTop=history.scrollHeight;}); }

function openModal(kind, options={}) { const content = document.getElementById('modalContent'); const project = options.projectId ? getProject(options.projectId) : null; const initiativeRecord = options.initiativeId ? getInitiative(options.initiativeId) : null; const initiative = initiativeRecord?.initiative; const knowledge = options.knowledgeId ? state.knowledgeItems.find(item=>item.id===options.knowledgeId) : null; const selectedTeams = (project?.teams || initiative?.teams || []).join(',');
  if (kind === 'project') { const current = project || {}; content.innerHTML = `<span class="eyebrow">${project?'EDIT PROJECT':'NEW PROJECT'}</span><h2>${project?'编辑项目总概':'创建项目'}</h2><p>填写项目整体状态、当前最重要动作和项目级 DDL。事项可在创建后继续添加。</p><form id="projectForm" data-id="${current.id||''}">${projectFields(current)}<button class="primary-button full">${project?'保存项目':'创建项目'} →</button></form>`; }
  if (kind === 'initiative') { const current = initiative || {}; const targetProjectId = project?.id || initiativeRecord?.project.id || state.selectedProjectId; content.innerHTML = `<span class="eyebrow">${initiative?'EDIT INITIATIVE':'NEW INITIATIVE'}</span><h2>${initiative?'编辑事项':'添加事项'}</h2><p>每个事项必须可单独维护现状、卡点、下一步动作和 DDL。</p><form id="initiativeForm" data-id="${current.id||''}"><label>所属项目<select name="projectId" required>${projectOptions(targetProjectId)}</select></label>${initiativeFields(current, selectedTeams)}<label class="checkbox-label"><input name="actionDone" type="checkbox" ${current.actionDone?'checked':''} /> 当前下一步动作已完成</label><button class="primary-button full">${initiative?'保存事项':'添加事项'} →</button></form>`; }
  if (kind === 'knowledge') { const current = knowledge || {}; content.innerHTML = `<span class="eyebrow">${knowledge?'EDIT KNOWLEDGE':'NEW KNOWLEDGE'}</span><h2>${knowledge?'编辑知识':'新增项目知识'}</h2><p>记录会自动关联项目；可选关联某个事项。用于后续项目 AI 和一键检索。</p><form id="knowledgeForm" data-id="${current.id||''}"><label>关联项目<select name="projectId" id="knowledgeProjectInput" required>${projectOptions(current.projectId || state.knowledgeFilter.projectId)}</select></label><label>关联事项（可选）<select name="initiativeId" id="knowledgeInitiativeInput">${initiativeOptions(current.projectId || state.knowledgeFilter.projectId, current.initiativeId || '')}</select></label><label>知识类型<select name="type">${['会议与决策','实验与数据','方案与需求','经验与踩坑'].map(type=>`<option ${current.type===type?'selected':''}>${type}</option>`).join('')}</select></label><label>标题<input name="title" required value="${escapeHtml(current.title||'')}" placeholder="例如：AI 推实验分层指标口径" /></label><label>摘要<input name="summary" value="${escapeHtml(current.summary||'')}" placeholder="一句话总结核心结论" /></label><label>来源链接（可选）<input name="sourceUrl" type="url" value="${escapeHtml(current.sourceUrl||'')}" placeholder="https://..." /></label><label>内容<textarea name="content" required rows="8" placeholder="记录背景、事实、结论、数据表、统计周期或经验...">${escapeHtml(current.content||'')}</textarea></label><button class="primary-button full">${knowledge?'保存知识':'保存到知识库'} →</button></form>`; }
  document.getElementById('modalBackdrop').classList.add('show');
}
function projectFields(current={}) { return `<label>项目名称<input name="name" required value="${escapeHtml(current.name||'')}" /></label><div class="form-row"><label>优先级<select name="priority">${priorityOptions(current.priority||'P1')}</select></label><label>预计完成<input name="plannedEnd" type="date" value="${current.plannedEnd||''}" required /></label></div><label>项目背景<textarea name="background" rows="2">${escapeHtml(current.background||'')}</textarea></label><label>项目历史<textarea name="history" rows="2">${escapeHtml(current.history||'')}</textarea></label><label>项目现状<textarea name="currentState" required rows="3">${escapeHtml(current.currentState||'')}</textarea></label><label>当前重点<textarea name="currentFocus" rows="2">${escapeHtml(current.currentFocus||'')}</textarea></label><label>项目卡点<textarea name="blocker" rows="2">${escapeHtml(current.blocker||'暂无')}</textarea></label><div class="form-row"><label>下一步动作<input name="nextAction" value="${escapeHtml(current.nextAction||'')}" placeholder="例如：回收实验数据" /></label><label>动作 DDL<input name="nextActionDdl" type="date" value="${toInputDate(current.nextActionDdl||'')}" /></label></div><label>历史 learning<textarea name="learning" rows="2">${escapeHtml(current.learning||'暂无')}</textarea></label><label>涉及团队（多选）${teamCheckboxes(current.teams||[])}</label><label>进度${progressFormControl(current.progress||['未开始'])}</label>`; }
function initiativeFields(current={}, teamString='') { return `<label>事项名称<input name="name" required value="${escapeHtml(current.name||'')}" /></label><div class="form-row"><label>优先级<select name="priority">${priorityOptions(current.priority||'P1')}</select></label><label>预计完成<input name="plannedEnd" type="date" value="${current.plannedEnd||''}" required /></label></div><label>现状<textarea name="currentState" required rows="4">${escapeHtml(current.currentState||'')}</textarea></label><label>卡点<textarea name="blocker" rows="2">${escapeHtml(current.blocker||'暂无')}</textarea></label><div class="form-row"><label>下一步动作<input name="nextAction" value="${escapeHtml(current.nextAction||'')}" placeholder="例如：数据回收" /></label><label>动作 DDL<input name="nextActionDdl" type="date" value="${toInputDate(current.nextActionDdl||'')}" /></label></div><label>历史 learning<textarea name="learning" rows="2">${escapeHtml(current.learning||'暂无')}</textarea></label><label>涉及团队（多选）${teamCheckboxes(current.teams || teamString.split(',').filter(Boolean))}</label><label>进度${progressFormControl(current.progress||['推进中'])}</label>`; }
function priorityOptions(selected) { return ['P0','P1','P2'].map(priority=>`<option ${selected===priority?'selected':''}>${priority}</option>`).join(''); }
function teamCheckboxes(selected=[]) { return `<div class="team-checkboxes">${TEAM_OPTIONS.map(team=>`<label><input type="checkbox" name="teams" value="${team}" ${selected.includes(team)?'checked':''} />${team}</label>`).join('')}</div>`; }
function projectOptions(selectedId) { return state.projects.map(project=>`<option value="${project.id}" ${project.id===selectedId?'selected':''}>${escapeHtml(project.name)}</option>`).join(''); }
function initiativeOptions(projectId, selectedId='') { const project = getProject(projectId); return `<option value="">不关联具体事项</option>${(project?.initiatives || []).map(initiative=>`<option value="${initiative.id}" ${initiative.id===selectedId?'selected':''}>${escapeHtml(initiative.name)}</option>`).join('')}`; }
function toInputDate(value) { return value ? value.slice(0,10) : ''; }
function closeModal() { document.getElementById('modalBackdrop').classList.remove('show'); }
function formDataObject(form) { const data = new FormData(form); return Object.fromEntries(data.entries()); }
function checkedTeams(form) { return [...form.querySelectorAll('input[name="teams"]:checked')].map(input=>input.value); }
function toast(message) { const el = document.getElementById('toast'); el.textContent = message; el.classList.add('show'); setTimeout(()=>el.classList.remove('show'), 2300); }
function clearKnowledgeFilters() { state.knowledgeFilter = { projectId:'ALL', query:'', type:'ALL' }; saveState(); renderKnowledgeFilters(); renderKnowledge(); const projectFilter = document.getElementById('knowledgeProjectFilter'); const searchInput = document.getElementById('knowledgeSearchInput'); if (projectFilter) projectFilter.value = 'ALL'; if (searchInput) searchInput.value = ''; toast('已清除知识库筛选'); }
async function deleteStoredSkill(skillPath) { if(!confirm(`确认删除 Skill「${skillPath}」吗？`)) return; try { const response=await fetch(`/api/skills/${encodeURIComponent(skillPath)}`,{method:'DELETE'}); const payload=await response.json(); if(!response.ok) throw new Error(payload.error || `删除失败（${response.status}）`); skillLibrary=payload.library || skillLibrary; if(selectedSkillParentPath===skillPath) selectedSkillParentPath=''; renderCliSkills(); toast('已删除 Skill'); } catch(error) { toast(error.message || 'Skill 删除失败'); } }
async function uploadManualSkill(file) { if(!file) return; if(!/\.md$/i.test(file.name || '')) return toast('仅支持上传 Markdown Skill。'); if(file.size > 200 * 1024) return toast('Skill 文件不能超过 200KB。'); if(!selectedSkillParentPath) return toast('请先在 Skills 页面选择一个父 Skill。'); try { const content=await file.text(); const response=await fetch('/api/skills/upload',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({parentSkillPath:selectedSkillParentPath,content,filename:file.name})}); const payload=await response.json(); if(!response.ok) throw new Error(payload.error || `上传失败（${response.status}）`); skillLibrary=payload.library || skillLibrary; renderCliSkills(); toast(`已上传 Skill「${payload.skill?.title || file.name}」`); } catch(error) { toast(error.message || 'Skill 上传失败'); } }
function switchView(view) { document.querySelectorAll('.view').forEach(el=>el.classList.remove('active-view')); document.getElementById(view).classList.add('active-view'); document.querySelectorAll('.nav-item').forEach(button=>button.classList.toggle('active',button.dataset.view===view)); const meta = {projects:['PROJECT PORTFOLIO','项目全景'],knowledge:['PROJECT KNOWLEDGE','项目知识库'],automation:['AUTOMATION RULES','自动化任务'],'cli-skills':['CROSS-RUN SKILL LIBRARY','Skills'],'project-memory':['PROJECT MEMORY','项目结论记忆'],'agent-runs':['AGENT OBSERVABILITY','AI 执行日志']}[view]; document.getElementById('viewKicker').textContent=meta[0]; document.getElementById('viewTitle').textContent=meta[1]; if (view === 'projects') requestAnimationFrame(() => { renderProjectTable(); autoSizeInlineTextareas(); }); if (view === 'knowledge') { renderKnowledgeFilters(); renderKnowledge(); } if (view === 'automation') renderAutomation(); if (view === 'cli-skills') { renderCliSkills(); void refreshSkillLibrary(); } if (view === 'project-memory') renderProjectMemory(); if (view === 'agent-runs') renderAgentRuns(); }
function saveAndRender(message) { saveState(); renderAll(); if (message) toast(message); }
function openKnowledgeSearch(projectId, initiativeId='') { state.knowledgeFilter.projectId = projectId; state.knowledgeFilter.query = initiativeId ? initiativeName(initiativeId) : ''; state.knowledgeFilter.type = 'ALL'; state.selectedProjectId = projectId; saveState(); switchView('knowledge'); renderAll(); toast('已筛选关联项目知识库'); }
function archiveInitiative(id) { const record = getInitiative(id); if (!record) return; record.initiative.archived = true; saveAndRender('事项已归档，已从今日 DDL 和时间线中移除'); }
function unarchiveInitiative(id) { const record = getInitiative(id); if (!record) return; record.initiative.archived = false; saveAndRender('事项已恢复到项目全景'); }
function toggleProject(projectId) { const list=state.expandedProjectIds; state.expandedProjectIds = list.includes(projectId) ? list.filter(id=>id!==projectId) : [...list,projectId]; saveAndRender(); }
function toggleArchived(projectId) { const list=state.expandedArchivedProjectIds; state.expandedArchivedProjectIds = list.includes(projectId) ? list.filter(id=>id!==projectId) : [...list,projectId]; saveAndRender(); }
function parseTeams(value='') { return [...new Set(value.split(/[、,，\s]+/).map(item=>item.trim()).filter(Boolean))]; }
function syncKnowledgeLink(kind, id, linkId, url) { const target = kind === 'project' ? getProject(id) : getInitiative(id); const project = kind === 'project' ? target : target?.project; const initiative = kind === 'project' ? null : target?.initiative; if (!project) return; const linkKey = `${kind}:${id}:${linkId}`; const existing = state.knowledgeItems.find(item => item.linkKey === linkKey); if (!url) { if (existing?.autoLinked) state.knowledgeItems = state.knowledgeItems.filter(item=>item.id!==existing.id); return; } const theme = inferLinkTheme(url); const title = `${project.name}${initiative ? ` · ${initiative.name}` : ''} · ${theme}`; const payload = { projectId:project.id, initiativeId:initiative?.id || '', type:inferKnowledgeType(url), title, summary:'等待同步正文后自动生成一句话摘要。', sourceUrl:url, content:`关联链接：${url}\n自动解析主题：${theme}`, createdAt:TODAY, autoLinked:true, linkKey, parsedTheme:theme, syncStatus:'未同步', syncedAt:'' }; if (existing) Object.assign(existing,payload,{syncStatus:existing.syncStatus || '未同步', syncedAt:existing.syncedAt || ''}); else state.knowledgeItems.unshift({id:uid('k'),...payload}); }
async function syncLinkContent(kind, id, linkId) { const target = kind === 'project' ? getProject(id) : getInitiative(id)?.initiative; const project = kind === 'project' ? target : getInitiative(id)?.project; const initiative = kind === 'project' ? null : target; const link = target?.knowledgeLinks?.find(item => item.id === linkId); if (!project || !link?.url) return toast('请先填写有效链接'); if (!API_ENDPOINT) return toast('请通过 npm start 启动后再同步链接内容'); const linkKey = `${kind}:${id}:${linkId}`; const knowledge = state.knowledgeItems.find(item => item.linkKey === linkKey); try { toast('正在抓取链接内容…'); const response = await fetch('/api/knowledge/sync-link', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({url:link.url}) }); const payload = await response.json(); if (!response.ok) throw new Error(payload.error || `同步失败（${response.status}）`); const theme = payload.title || inferLinkTheme(payload.url); const content = `关联链接：${payload.url}\n同步日期：${new Date(payload.fetchedAt).toLocaleDateString('zh-CN', { timeZone:'Asia/Shanghai' })}\n\n${payload.text}${payload.truncated ? '\n\n[内容已截断]' : ''}`; const record = knowledge || {id:uid('k'), projectId:project.id, initiativeId:initiative?.id || '', type:inferKnowledgeType(link.url), linkKey, autoLinked:true, createdAt:TODAY}; Object.assign(record, {projectId:project.id, initiativeId:initiative?.id || '', type:inferKnowledgeType(payload.url), title:`${project.name}${initiative ? ` · ${initiative.name}` : ''} · ${theme}`, summary:payload.summary || '正文已同步，摘要待生成。', sourceUrl:payload.url, content, parsedTheme:theme, syncStatus:'已同步', syncedAt:payload.fetchedAt, autoLinked:true, linkKey}); if (!knowledge) state.knowledgeItems.unshift(record); saveState(); renderCounts(); if (document.querySelector('.view.active-view')?.id === 'knowledge') { renderKnowledgeFilters(); renderKnowledge(); } toast('链接内容已同步，并已生成摘要供 AI 默认使用'); } catch (error) { if (knowledge) { knowledge.syncStatus = `同步失败：${error.message}`; saveState(); renderCounts(); if (document.querySelector('.view.active-view')?.id === 'knowledge') { renderKnowledgeFilters(); renderKnowledge(); } } toast(error.message); } }
function refreshOverviewAfterInlineSave() { renderCounts(); renderDeadlines(); autoSizeInlineTextareas(); }
async function updateInlineField(element) { const kind = element.dataset.inlineKind; const id = element.dataset.inlineId; const field = element.dataset.inlineField; const value = field === 'teams' ? parseTeams(element.value) : element.value.trim(); const target = kind === 'project' ? getProject(id) : getInitiative(id)?.initiative; if (!target) return; if (field === 'knowledgeLinkUrl') { const link = target.knowledgeLinks?.find(item=>item.id===element.dataset.linkId); if (!link) return; link.url = element.value.trim(); syncKnowledgeLink(kind,id,link.id,link.url); saveState(); refreshOverviewAfterInlineSave(); if (link.url) await syncLinkContent(kind,id,link.id); else toast('链接已从项目知识库移除'); return; } target[field] = value; if (field === 'nextActionDdl' || field === 'plannedEnd') target[field] = element.value; saveState(); refreshOverviewAfterInlineSave(); }
function progressTarget(kind,id) { return kind==='project'?getProject(id):getInitiative(id)?.initiative; }
function refreshProgressControl(kind,id) { const current=document.querySelector(`.progress-multi[data-progress-kind="${kind}"][data-progress-id="${id}"]`); const target=progressTarget(kind,id); const wasOpen=Boolean(current?.querySelector('details')?.open); if (current && target) { current.outerHTML=progressMultiSelect(kind,id,target.progress); const replacement=document.querySelector(`.progress-multi[data-progress-kind="${kind}"][data-progress-id="${id}"] details`); if (replacement) replacement.open=wasOpen; } }
function setProgressOption(kind,id,value,checked) { const target=progressTarget(kind,id); if (!target) return; const next=normalizeProgressValues(target.progress); target.progress=checked?[...new Set([...next,value])]:next.filter(item=>item!==value); saveState(); refreshProgressControl(kind,id); renderCounts(); }
function addProgressOption(kind,id,input) { const value=String(input?.value||'').trim(); if (!value) return toast('请输入候选项名称。'); if (!state.progressOptions.includes(value)) state.progressOptions.push(value); const target=progressTarget(kind,id); if (target) target.progress=[...new Set([...normalizeProgressValues(target.progress),value])]; saveState(); refreshProgressControl(kind,id); renderCounts(); }
function deleteProgressOption(value) { const option=String(value||'').trim(); if (!option) return; state.progressOptions=state.progressOptions.filter(item=>item!==option); for (const project of state.projects) { project.progress=normalizeProgressValues(project.progress).filter(item=>item!==option); for (const initiative of project.initiatives||[]) initiative.progress=normalizeProgressValues(initiative.progress).filter(item=>item!==option); } saveAndRender('已删除进度候选项。'); }
function addKnowledgeLink(kind, id) { const target = kind === 'project' ? getProject(id) : getInitiative(id)?.initiative; if (!target) return; target.knowledgeLinks ||= []; const link={id:uid('link'),url:''}; target.knowledgeLinks.push(link); saveAndRender('已新增链接输入框'); requestAnimationFrame(()=>{const input=document.querySelector(`[data-inline-kind="${kind}"][data-inline-id="${id}"][data-link-id="${link.id}"]`); input?.focus();}); }
function removeKnowledgeLink(kind, id, linkId) { const target = kind === 'project' ? getProject(id) : getInitiative(id)?.initiative; if (!target) return; const link=target.knowledgeLinks?.find(item=>item.id===linkId); if (!link) return; syncKnowledgeLink(kind,id,linkId,''); target.knowledgeLinks=target.knowledgeLinks.filter(item=>item.id!==linkId); saveAndRender('链接已删除，并已从自动同步知识中移除'); }
function addInlineImage(kind, id, imageField, imageUrl) { const target = kind === 'project' ? getProject(id) : getInitiative(id)?.initiative; if (!target) return; target[imageField] ||= []; target[imageField].push(imageUrl); saveAndRender('图片已保存'); }
async function savePastedImage(kind, id, imageField, dataUrl) {
  const record = kind === 'project' ? { project:getProject(id), initiative:null } : getInitiative(id);
  const project = record?.project || record;
  const initiative = record?.initiative || null;
  if (!project) return;
  if (!API_ENDPOINT) return addInlineImage(kind, id, imageField, dataUrl);
  try {
    toast('正在保存图片资产…');
    const response = await fetch('/api/media-assets/paste', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ projectId:project.id, initiativeId:initiative?.id || '', dataUrl, title:`${initiative?.name || project.name} · 用户粘贴图片` }) });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || `图片保存失败（${response.status}）`);
    state.mediaAssets ||= [];
    if (!state.mediaAssets.some((asset) => asset.id === payload.asset.id)) state.mediaAssets.unshift(payload.asset);
    addInlineImage(kind, id, imageField, payload.asset.assetUrl);
  } catch (error) { toast(error.message || '图片保存失败'); }
}
function removeInlineImage(kind, id, imageField, index) { const target = kind === 'project' ? getProject(id) : getInitiative(id)?.initiative; if (!target?.[imageField]) return; target[imageField].splice(Number(index),1); saveAndRender('图片已删除'); }
function focusInline(kind, id, field='name') { requestAnimationFrame(() => { const input = document.querySelector(`[data-inline-kind="${kind}"][data-inline-id="${id}"][data-inline-field="${field}"]`); if (input) { input.focus(); input.select?.(); } }); }
function addProjectInline() { const project = { id:uid('p'), priority:'P1', name:'未命名项目', plannedEnd:'', progress:['未开始'], currentState:'待补充项目现状。', blocker:'暂无', nextAction:'待补充下一步动作', nextActionDdl:'', learning:'暂无', teams:[], knowledgeLinks:[], currentStateImages:[], learningImages:[], initiatives:[], memory:[{role:'assistant',text:'我是这个项目的专属 AI。请补充项目目标、事项、卡点和相关知识。'}] }; state.projects.unshift(project); state.expandedProjectIds = [...new Set([...state.expandedProjectIds, project.id])]; state.selectedProjectId = project.id; saveAndRender('已添加项目行，请直接在表格中填写'); focusInline('project', project.id); }
function addInitiativeInline(projectId) { const project = getProject(projectId); if (!project) return; const initiative = { id:uid('i'), priority:'P1', name:'未命名事项', currentState:'待补充事项现状。', blocker:'暂无', nextAction:'待补充下一步动作', nextActionDdl:'', learning:'暂无', teams:[...project.teams], progress:['未开始'], plannedEnd:project.plannedEnd || '', actionDone:false, archived:false, knowledgeLinks:[], currentStateImages:[], learningImages:[] }; project.initiatives.push(initiative); state.selectedProjectId=project.id; saveAndRender('已添加事项行，请直接在表格中填写'); focusInline('initiative', initiative.id); }
function deleteProject(id) { const project=getProject(id); if (!project) return; if (!confirm(`确认删除项目「${project.name}」及其 ${project.initiatives.length} 个事项吗？`)) return; state.projects=state.projects.filter(item=>item.id!==id); state.knowledgeItems=state.knowledgeItems.filter(item=>item.projectId!==id); state.selectedProjectId=state.projects[0]?.id || ''; saveAndRender('项目已删除'); }
function deleteInitiative(id) { const record=getInitiative(id); if (!record) return; if (!confirm(`确认删除事项「${record.initiative.name}」吗？`)) return; record.project.initiatives=record.project.initiatives.filter(item=>item.id!==id); state.knowledgeItems=state.knowledgeItems.map(item=>item.initiativeId===id?{...item,initiativeId:''}:item); saveAndRender('事项已删除'); }
function deleteKnowledge(id) { const item=state.knowledgeItems.find(entry=>entry.id===id); if(!item) return; if(!confirm(`确认删除知识「${item.title}」吗？此操作不会删除原始飞书或 Libra 链接。`)) return; state.knowledgeItems=state.knowledgeItems.filter(entry=>entry.id!==id); saveAndRender('知识已删除'); }
function safeMarkdownUrl(value='') { try { const url=new URL(String(value).replace(/&amp;/g,'&')); return ['http:','https:'].includes(url.protocol) ? url.toString() : ''; } catch { return ''; } }
function formatMarkdownInline(value='') { let html=escapeHtml(value); const tokens=[]; const token=(markup)=>{const key=`@@OAI_LINK_${tokens.length}@@`;tokens.push([key,markup]);return key;}; html=html.replace(/!\[([^\]]*)\]\((https?:\/\/[^\s)）]+)\)/g,(_,alt,url)=>{const href=safeMarkdownUrl(url);return href?token(`<img class="markdown-image" src="${escapeHtml(href)}" alt="${alt}" loading="lazy" />`):alt;}); html=html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)）]+)\)/g,(_,label,url)=>{const href=safeMarkdownUrl(url);return href?token(`<a class="markdown-link" href="${escapeHtml(href)}" target="_blank" rel="noreferrer">${label}</a>`):label;}); html=html.replace(/(https?:\/\/[^\s<)\]）】》〉，。；！？、（【《〈]+)/g,(url)=>{const href=safeMarkdownUrl(url);return href?token(`<a class="markdown-link" href="${escapeHtml(href)}" target="_blank" rel="noreferrer">${url}</a>`):url;}); html=html.replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>'); for(const [key,markup] of tokens) html=html.replace(key,markup); return html; }
function extractStandaloneWebLinks(text='') { const links=[]; const seen=new Set(); for (const line of String(text||'').replace(/\r\n/g,'\n').split('\n')) { const raw=line.trim(); if (!/^https?:\/\/[^\s<)\]）】》〉，。；！？、（【《〈]+$/.test(raw)) continue; const href=safeMarkdownUrl(raw); if (!href || seen.has(href)) continue; seen.add(href); let host='网页链接'; try { host=new URL(href).hostname.replace(/^www\./,'') || host; } catch {} links.push({ href, host }); } return links; }
function replaceStandaloneWebLinksWithCardRefs(text='') { return String(text||'').replace(/(^|\n)\s*(https?:\/\/[^\s<)\]）】》〉，。；！？、（【《〈]+)\s*(?=\n|$)/g, (match, prefix, rawUrl) => safeMarkdownUrl(rawUrl) ? `${prefix}网页链接（见下方链接卡片）` : match); }
function renderWebLinkCards(text='') { const links=extractStandaloneWebLinks(text); if(!links.length)return ''; return `<section class="web-link-cards" aria-label="网页链接">${links.map(link=>`<a class="web-link-card" href="${escapeHtml(link.href)}" target="_blank" rel="noreferrer"><span class="web-link-card-kicker">网页链接</span><b>${escapeHtml(link.href)}</b><small>${escapeHtml(link.host)}</small><i>打开 ↗</i></a>`).join('')}</section>`; }
function formatFinalReply(text='') { return `${formatModelText(replaceStandaloneWebLinksWithCardRefs(text))}${renderWebLinkCards(text)}`; }
function markdownTableCells(line='') { return line.trim().replace(/^\||\|$/g,'').split('|').map(cell=>cell.trim()); }
function isMarkdownTableSeparator(line='') { return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line); }
function formatModelText(text='') { const lines=String(text).replace(/\r\n/g,'\n').split('\n'); const html=[]; let list=[]; let inCode=false; let code=[]; const flushList=()=>{if(list.length){html.push(`<ul>${list.map(item=>`<li>${formatMarkdownInline(item)}</li>`).join('')}</ul>`);list=[];}}; const flushCode=()=>{if(inCode){html.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);inCode=false;code=[];}}; for(let index=0;index<lines.length;index+=1){const line=lines[index];if(/^```/.test(line)){if(inCode)flushCode();else{flushList();inCode=true;}continue;}if(inCode){code.push(line);continue;}if(line.includes('|')&&isMarkdownTableSeparator(lines[index+1]||'')){flushList();const headers=markdownTableCells(line);const rows=[];index+=2;while(index<lines.length&&lines[index].includes('|')&&lines[index].trim()){rows.push(markdownTableCells(lines[index]));index+=1;}index-=1;html.push(`<div class="markdown-table-wrap"><table class="markdown-table"><thead><tr>${headers.map(cell=>`<th>${formatMarkdownInline(cell)}</th>`).join('')}</tr></thead><tbody>${rows.map(row=>`<tr>${headers.map((_,cellIndex)=>`<td>${formatMarkdownInline(row[cellIndex]||'')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);continue;}const heading=line.match(/^(#{1,3})\s+(.+)$/);const bullet=line.match(/^[-*]\s+(.+)$/);if(heading){flushList();const level=heading[1].length+1;html.push(`<h${level}>${formatMarkdownInline(heading[2])}</h${level}>`);}else if(bullet){list.push(bullet[1]);}else if(!line.trim()){flushList();}else{flushList();html.push(`<p>${formatMarkdownInline(line)}</p>`);}}flushList();flushCode();return html.join('')||'<p></p>'; }
function renderChatAttachments(attachments=[]) { const images=Array.isArray(attachments) ? attachments.filter((item)=>item?.assetUrl) : []; return images.length ? `<div class="chat-message-images">${images.map((item)=>`<img src="${escapeHtml(item.assetUrl)}" alt="${escapeHtml(item.title || '已上传图片')}" loading="lazy" />`).join('')}</div>` : ''; }
function renderChatMessage(message) { return message.role==='assistant' ? formatFinalReply(message.text) : `${message.html || escapeHtml(message.text || '')}${renderChatAttachments(message.attachments)}`; }
function formatAgentAnswer(answer) {
  answer ||= {};
  const section = (title, values) => values?.length ? `<section class="agent-section"><strong>${title}</strong><ul>${values.map(value=>`<li>${escapeHtml(value)}</li>`).join('')}</ul></section>` : '';
  const actions = answer.actions?.length ? `<section class="agent-section"><strong>建议动作</strong>${answer.actions.map(item=>`<div class="agent-action"><b>${escapeHtml(item.action)}</b>${item.ddl ? `<span>建议 DDL：${escapeHtml(item.ddl)}</span>` : ''}${item.impact ? `<small>${escapeHtml(item.impact)}</small>` : ''}</div>`).join('')}</section>` : '';
  const proposals = answer.proposals?.length ? `<section class="agent-section"><strong>待确认提案</strong>${answer.proposals.map(proposal=>`<div class="agent-proposal"><b>${escapeHtml(proposal.title)}</b><p>${escapeHtml(proposal.rationale || `${proposal.field} 将更新为：${proposal.value}`)}</p><button data-create-proposal="${proposal.id}">提交待确认</button></div>`).join('')}</section>` : '';
  const memoryCandidates = answer.memoryCandidates?.length ? `<section class="agent-section"><strong>候选 Project Memory</strong>${answer.memoryCandidates.map(item=>`<div class="agent-proposal"><b>${item.type==='decision'?'决策':'Learning'} · ${escapeHtml(item.statement)}</b>${item.evidence?`<p>${escapeHtml(item.evidence)}</p>`:''}<button data-create-memory="${item.id}">沉淀到 Memory</button></div>`).join('')}</section>` : '';
  const toolResults = answer.toolResults?.length ? `<section class="agent-section"><strong>工具执行结果</strong>${answer.toolResults.map(result=>{ const label={failed:'执行失败',needs_input:'需要指定实验',needs_confirmation:'等待确认',confirmed:'Profile 已确认',recovered:'数据已覆盖 T-1',stale:'数据未最新'}[result.status] || (result.isLatest?'数据已覆盖 T-1':'执行完成'); const metrics=result.metrics?.length?`<ul class="agent-metric-results">${result.metrics.map(metric=>`<li><b>${escapeHtml(metric.group)} · ${escapeHtml(metric.metric)}</b><span>${escapeHtml(metric.result)}${metric.dataDate?` · 数据日期：${escapeHtml(metric.dataDate)}`:''}</span></li>`).join('')}</ul>`:''; const image=result.imageUrl?`<img class="tool-result-image" src="${escapeHtml(result.imageUrl)}" alt="${escapeHtml(result.title || '工具截图')}" />`:''; const confirmButton=result.status==='needs_confirmation'&&result.confirmationId?`<button data-confirm-recovery="${escapeHtml(result.confirmationId)}">确认并执行</button>`:''; return `<div class="agent-action"><b>${escapeHtml(result.title || result.name)}</b><span>${label}</span><small>${formatMarkdownInline(result.error || result.note || '')}</small>${image}${metrics}${confirmButton}${result.knowledgeTitle?`<small>已保存到项目知识库：${escapeHtml(result.knowledgeTitle)}</small>`:''}</div>`; }).join('')}</section>` : '';
  const structured = section('已知事实', answer.facts) + section('判断 / 假设', answer.assessments) + actions + section('需要确认', answer.confirmations) + proposals + memoryCandidates + toolResults;
  const narrative = answer.fallbackText && answer.fallbackText !== '正在准备执行请求…' && answer.fallbackText !== '正在继续执行任务…' ? `<section class="agent-narrative">${formatModelText(answer.fallbackText)}</section>` : '';
  return narrative + structured || formatModelText(answer.fallbackText || '模型未返回可解析的结构化结果。');
}
function allProjectConversations(project) { return [project, ...(project.initiatives || [])]; }
function findDraftProposal(id) { for (const project of state.projects) { for (const conversation of allProjectConversations(project)) { for (const message of conversation.memory || []) { const proposal = message.structured?.proposals?.find(item=>item.id===id); if (proposal) return proposal; } } } return null; }
function findMemoryCandidate(id) { for (const project of state.projects) { for (const conversation of allProjectConversations(project)) { for (const message of conversation.memory || []) { const entry = message.structured?.memoryCandidates?.find(item=>item.id===id); if (entry) return entry; } } } return null; }
function upsertAgentRun(run) { if (!run?.id) return; state.agentRuns ||= []; const index = state.agentRuns.findIndex(item=>item.id === run.id); if (index >= 0) state.agentRuns[index] = run; else state.agentRuns.unshift(run); state.agentRuns = state.agentRuns.slice(0, 100); }
async function maybeSummarizeConversation(projectId, initiativeId='') { if(!API_ENDPOINT) return; try { const response=await fetch(`/api/projects/${encodeURIComponent(projectId)}/conversation-summary/refresh`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({initiativeId})}); const payload=await response.json(); if(!response.ok) throw new Error(payload.error || `总结失败（${response.status}）`); if(payload.summarized) { const target=initiativeId?getInitiative(initiativeId)?.initiative:getProject(projectId); if(target) { target.conversationSummary=payload.summary; target.memory=Array.isArray(payload.memory)?payload.memory:target.memory; } saveState(); renderAll(); } } catch(error) { console.warn('Conversation summary skipped:',error.message); } }
async function submitMemoryCandidate(id) { const entry=findMemoryCandidate(id); if(!entry) return toast('未找到候选 Memory'); try { const response=await fetch('/api/project-memory',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({entry,state})}); const payload=await response.json(); if(!response.ok) throw new Error(payload.error || `保存失败（${response.status}）`); state=payload.state; normalizeState(); saveAndRender('已沉淀到 Project Memory，可继续确认或纠正'); } catch(error) { toast(error.message); } }
async function confirmMemory(id) { try { const response=await fetch(`/api/project-memory/${encodeURIComponent(id)}/confirm`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({state})}); const payload=await response.json(); if(!response.ok) throw new Error(payload.error || `确认失败（${response.status}）`); state=payload.state; normalizeState(); saveAndRender('该结论已标记为人工确认'); } catch(error) { toast(error.message); } }
async function correctMemory(id) { const current=state.longTermMemories.find(item=>item.id===id); const statement=prompt('请输入纠正后的结论。旧结论会保留为历史版本：', current?.statement || ''); if(!statement?.trim()) return; try { const response=await fetch(`/api/project-memory/${encodeURIComponent(id)}/correct`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({state,statement:statement.trim()})}); const payload=await response.json(); if(!response.ok) throw new Error(payload.error || `纠正失败（${response.status}）`); state=payload.state; normalizeState(); saveAndRender('已创建人工纠正版本，旧结论不再进入默认 Context'); } catch(error) { toast(error.message); } }
async function expireMemory(id) { try { const response=await fetch(`/api/project-memory/${encodeURIComponent(id)}/expire`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({state})}); const payload=await response.json(); if(!response.ok) throw new Error(payload.error || `更新失败（${response.status}）`); state=payload.state; normalizeState(); saveAndRender('已标记为过期，不再进入默认 Context'); } catch(error) { toast(error.message); } }
async function submitProposal(id) { const proposal = findDraftProposal(id); if (!proposal) return toast('未找到待提交提案'); try { const response = await fetch('/api/proposals', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({proposal,state}) }); const payload = await response.json(); if (!response.ok) throw new Error(payload.error || `提交失败（${response.status}）`); state = payload.state; normalizeState(); saveAndRender('提案已提交，等待你确认写入'); } catch (error) { toast(error.message); } }
async function confirmProposal(id) { try { const response = await fetch(`/api/proposals/${encodeURIComponent(id)}/confirm`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({state}) }); const payload = await response.json(); if (!response.ok) throw new Error(payload.error || `确认失败（${response.status}）`); state = payload.state; normalizeState(); saveAndRender('提案已确认并写入项目状态'); } catch (error) { toast(error.message); } }
function renderLiveAgentProgress(event) {
  const payload = event?.run ? event : null;
  if (!payload) return;
  const current = state.agentRuns?.find((item) => item.id === payload.run.id);
  upsertAgentRun({ ...(current || {}), ...payload.run });
  const active = activeAgentRequests.get(payload.run.id);
  if (active) active.progress = { runId:payload.run.id, message:payload.message || `AI 执行中：${payload.type}`, type:payload.type };
  renderAssistant();
  const logView = document.getElementById('agent-runs');
  if (logView?.classList.contains('active-view')) renderAgentRuns();
}

function connectAgentEventStream(runId) {
  const active = activeAgentRequests.get(runId);
  if (!API_ENDPOINT || !window.EventSource || !active) return;
  clearTimeout(active.eventRetryTimer);
  active.eventSource?.close();
  const source = new EventSource(`/api/ai/runs/${encodeURIComponent(runId)}/events`);
  active.eventSource = source;
  source.addEventListener('progress', (event) => {
    try { renderLiveAgentProgress(JSON.parse(event.data)); } catch (error) { console.warn('Invalid AI progress event:', error); }
  });
  source.onerror = () => {
    source.close();
    const current = activeAgentRequests.get(runId);
    if (current) current.eventRetryTimer = setTimeout(() => connectAgentEventStream(runId), 250);
  };
}

async function stopActiveAgent(runId = activeRequestForConversation(activeConversation()?.id || '')?.runId) {
  const active = activeAgentRequests.get(runId);
  if (!active || !API_ENDPOINT) return;
  try {
    const response = await fetch(`/api/ai/runs/${encodeURIComponent(runId)}/stop`, { method:'POST' });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || '停止 AI 任务失败。');
    upsertAgentRun(payload.run);
    active.abortController.abort();
    active.eventSource?.close();
    clearTimeout(active.eventRetryTimer);
    toast('已请求停止当前 AI 任务。其他会话和自动化任务会继续运行。');
  } catch (error) {
    toast(error.message || '停止 AI 任务失败。');
  }
}

function setChatBusy(busy) {
  const input=document.getElementById('chatInput');
  const submit=document.querySelector('.send-button');
  const attach=document.getElementById('chatAttachButton');
  const modelSelect=document.getElementById('chatModelSelect');
  const stop=document.getElementById('stopAgentButton');
  if (input) input.disabled=busy;
  if (submit) submit.disabled=busy;
  if (attach) attach.disabled=busy;
  if (modelSelect) modelSelect.disabled=busy || !chatModelCatalog.length;
  if (stop) stop.hidden=!busy;
}

function renderPendingChatImages() {
  const root=document.getElementById('chatAttachmentPreview');
  if (!root) return;
  root.hidden=!pendingChatImages.length;
  root.innerHTML=pendingChatImages.map((file,index)=>`<span><img src="${escapeHtml(file.previewUrl)}" alt="${escapeHtml(file.name)}" /><button type="button" data-remove-chat-image="${index}" title="移除图片">×</button></span>`).join('');
}
function addPendingChatImages(files) {
  const candidates=[...(files || [])].filter((file)=>file?.type && /^image\/(png|jpeg|webp|gif)$/i.test(file.type));
  if (!candidates.length) return toast('仅支持 PNG、JPEG、WebP 或 GIF 图片');
  const oversized=candidates.find((file)=>file.size > 10 * 1024 * 1024);
  if (oversized) return toast('单张图片不能超过 10MB');
  if (pendingChatImages.length + candidates.length > 4) return toast('一次最多上传 4 张图片');
  pendingChatImages.push(...candidates.map((file)=>({ file, name:file.name || '图片', previewUrl:URL.createObjectURL(file) })));
  renderPendingChatImages();
}
function clearPendingChatImages() { pendingChatImages.forEach((item)=>URL.revokeObjectURL(item.previewUrl)); pendingChatImages=[]; renderPendingChatImages(); }
function readFileAsDataUrl(file) { return new Promise((resolve,reject)=>{ const reader=new FileReader(); reader.onerror=()=>reject(new Error('图片读取失败，请重试')); reader.onload=()=>resolve(reader.result); reader.readAsDataURL(file); }); }
async function uploadChatImages(project, initiativeId, images, conversationId) {
  const uploaded=[];
  for (const image of images) {
    const dataUrl=await readFileAsDataUrl(image.file);
    const response=await fetch('/api/media-assets/paste',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({projectId:project?.id||'',initiativeId,conversationId,dataUrl,title:`${project?.name||'无主题对话'} · AI 对话图片 · ${image.name}`})});
    const payload=await response.json();
    if(!response.ok) throw new Error(payload.error || `图片上传失败（${response.status}）`);
    uploaded.push(payload.asset);
  }
  return uploaded;
}
function chatSubmissionError(pendingImages, selectedModel) {
  if (pendingImages.length && selectedModel && !selectedModel.supportsVision) return `「${selectedModel.label}」不支持图片输入，请先切换模型`;
  return '';
}

async function rerunLatestAgentRun(runId) { const conversation=activeConversation(); const run=latestManualRerunCandidate(conversation); if(!run || run.id!==runId) return toast('当前没有可重跑的最新失败消息'); run.manualRerunPending=true; renderAssistant(); await aiReply('', [], { manualRerunOf:run.id }); }

async function aiReply(prompt, pendingImages=[], options={}) {
  const manualRerunOf=String(options.manualRerunOf || '');
  const conversation=activeConversation();
  if(!conversation || activeRequestForConversation(conversation.id)) return;
  const {project,initiative}=conversationTargetRecord(conversation);
  const selectedModel=chatModelCatalog.find(model=>model.id===state.selectedChatModel);
  const submissionError=chatSubmissionError(pendingImages,selectedModel);
  if(submissionError)return toast(submissionError);
  const runId=`run-client-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const active={ runId, conversationId:conversation.id, abortController:new AbortController(), eventSource:null, eventRetryTimer:null, progress:{ runId, message:'正在准备 AI 请求…', type:'request_preparing' } };
  activeAgentRequests.set(runId, active);
  refreshAgentBusyUi();
  saveAndRender();
  try {
    if(!API_ENDPOINT)throw new Error('请通过 npm start 启动本地服务后使用真实 AI。');
    await persistBackendState();
    const uploadedImages=manualRerunOf ? [] : await uploadChatImages(project,initiative?.id||'',pendingImages,conversation.id);
    const imageAssetIds=uploadedImages.map(asset=>asset.id);
    const attachments=uploadedImages.map(asset=>({id:asset.id,title:asset.title,mimeType:asset.mimeType,assetUrl:asset.assetUrl}));
    if(!manualRerunOf) {
      conversation.memory ||= [];
      conversation.memory.push({role:'user',text:prompt,imageAssetIds,attachments,createdAt:new Date().toISOString()});
      conversation.updatedAt=new Date().toISOString();
      saveAndRender();
    }
    active.progress={runId,message:'正在创建 AI Run 并构建 Context…',type:'request_started'};
    renderAssistant();
    const chatRequest=fetch('/api/ai/chat',{method:'POST',headers:{'Content-Type':'application/json'},signal:active.abortController.signal,body:JSON.stringify({runId,conversationId:conversation.id,message:prompt,imageAssetIds,manualRerunOf,model:state.selectedChatModel})});
    connectAgentEventStream(runId);
    const response=await chatRequest;
    const payload=await response.json();
    if(response.ok)selectedSkillParentPath='';
    upsertAgentRun(payload.run);
    if(!response.ok)throw new Error(payload.error||`AI 请求失败（${response.status}）`);
    if(payload.state&&typeof payload.state==='object'){mergeServerManagedState(payload.state,payload.updatedAt || '');normalizeState();}
    const responseConversation=state.conversations.find((item)=>item.id===conversation.id) || conversation;
    const responseText=payload.text||payload.structured?.fallbackText||'模型未返回内容。';
    const lastStoredMessage=responseConversation.memory.at(-1);
    const finalHtml=formatFinalReply(responseText);
    if(lastStoredMessage?.role==='assistant'&&lastStoredMessage.text===responseText)Object.assign(lastStoredMessage,{html:finalHtml,structured:payload.structured,model:payload.model,requestId:payload.requestId,finalOnly:true});
    else responseConversation.memory.push({role:'assistant',text:responseText,html:finalHtml,structured:payload.structured,model:payload.model,requestId:payload.requestId,finalOnly:true,createdAt:new Date().toISOString()});
    responseConversation.updatedAt=new Date().toISOString();
    saveAndRender();
  } catch(error) {
    if(error.name==='AbortError')toast('AI 助手已停止。');
    else {
      conversation.memory ||= [];
      conversation.memory.push({role:'assistant',text:`<strong>AI 暂不可用</strong><br>${escapeHtml(error.message)}`});
      conversation.updatedAt=new Date().toISOString();
      saveAndRender();
    }
  } finally {
    const current=activeAgentRequests.get(runId);
    if(current){
      current.eventSource?.close();
      clearTimeout(current.eventRetryTimer);
      activeAgentRequests.delete(runId);
    }
    refreshAgentBusyUi();
    renderAssistant();
    if(activeConversation()?.id===conversation.id) document.getElementById('chatInput')?.focus();
  }
}

function handleProjectForm(form) { const data = formDataObject(form); const id = form.dataset.id; const payload = {priority:data.priority,name:data.name.trim(),plannedEnd:data.plannedEnd,background:data.background.trim(),history:data.history.trim(),currentFocus:data.currentFocus.trim(),currentState:data.currentState.trim(),blocker:data.blocker.trim() || '暂无',nextAction:data.nextAction.trim(),nextActionDdl:data.nextActionDdl,learning:data.learning.trim() || '暂无',teams:checkedTeams(form),progress:selectedProgressValues(form)}; if (!payload.name || !payload.plannedEnd || !payload.currentState) return toast('请填写项目名称、项目现状和预计完成时间'); if (id) Object.assign(getProject(id),payload); else state.projects.unshift({id:uid('p'),...payload,initiatives:[],memory:[{role:'assistant',text:`我是「${escapeHtml(payload.name)}」的专属 AI。请补充项目目标、事项、卡点和相关知识，我会在该项目 Context 下协助讨论方案。`}]}); state.selectedProjectId = id || state.projects[0].id; closeModal(); saveAndRender(id?'项目已保存':'项目已创建'); }
function handleInitiativeForm(form) { const data = formDataObject(form); const id = form.dataset.id; const payload = {priority:data.priority,name:data.name.trim(),plannedEnd:data.plannedEnd,currentState:data.currentState.trim(),blocker:data.blocker.trim() || '暂无',nextAction:data.nextAction.trim(),nextActionDdl:data.nextActionDdl,learning:data.learning.trim() || '暂无',teams:checkedTeams(form),progress:selectedProgressValues(form),actionDone:form.elements.actionDone.checked}; if (!payload.name || !payload.plannedEnd || !payload.currentState) return toast('请填写事项名称、现状和预计完成时间'); if (!payload.actionDone && (!payload.nextAction || !payload.nextActionDdl)) return toast('未完成事项请填写下一步动作和具体 DDL'); if (id) { const record = getInitiative(id); const moved = record.project.id !== data.projectId; Object.assign(record.initiative,payload); if (moved) { record.project.initiatives = record.project.initiatives.filter(item=>item.id!==id); getProject(data.projectId).initiatives.push(record.initiative); } state.selectedProjectId = data.projectId; } else { const project = getProject(data.projectId); project.initiatives.push({id:uid('i'),...payload}); state.selectedProjectId = project.id; } closeModal(); saveAndRender(id?'事项已保存':'事项已添加'); }
function handleKnowledgeForm(form) { const data = formDataObject(form); const id = form.dataset.id; const payload = {projectId:data.projectId,initiativeId:data.initiativeId,type:data.type,title:data.title.trim(),summary:data.summary.trim(),sourceUrl:data.sourceUrl.trim(),content:data.content.trim(),createdAt:TODAY,updatedAt:new Date().toISOString()}; if (!payload.title || !payload.content) return toast('请填写知识标题和内容'); if (id) { const item = state.knowledgeItems.find(entry=>entry.id===id); Object.assign(item,payload,{createdAt:item.createdAt}); } else state.knowledgeItems.unshift({id:uid('k'),...payload}); state.selectedProjectId = payload.projectId; state.knowledgeFilter = {projectId:payload.projectId,query:'',type:'ALL'}; closeModal(); switchView('knowledge'); saveAndRender(id?'知识已保存':'已保存到项目知识库'); }

document.addEventListener('click', event => {
  closeAssistantOverlaysOutside(event.target);
  const removeChatImage=event.target.closest('[data-remove-chat-image]'); if(removeChatImage){ const [removed]=pendingChatImages.splice(Number(removeChatImage.dataset.removeChatImage),1); if(removed) URL.revokeObjectURL(removed.previewUrl); renderPendingChatImages(); return; }
  if (event.target.id === 'chatAttachButton') document.getElementById('chatImageInput')?.click();
  if (event.target.id === 'notificationButton') { notificationMenuOpen=!notificationMenuOpen; renderNotifications(); return; }
  const notificationItem=event.target.closest('[data-open-notification]'); if(notificationItem){openNotification(notificationItem.dataset.openNotification);return;}
  if (event.target.id === 'assistantLauncher') { openConversationScope('global'); return; }
  if (event.target.closest('#assistantTargetTrigger')) { assistantTargetMenuOpen=!assistantTargetMenuOpen; renderAssistant(); return; }
  if (event.target.closest('#assistantHistoryButton')) { assistantHistoryMenuOpen=!assistantHistoryMenuOpen; renderAssistant(); return; }
  if (event.target.closest('#assistantNewConversationButton')) { const conversation=activeConversation(); if(conversation) openConversationScope(conversation.scope,conversation.projectId,conversation.initiativeId,true); return; }
  const deleteConversation=event.target.closest('[data-delete-conversation]'); if(deleteConversation){const id=deleteConversation.dataset.deleteConversation;if(!confirm('删除这条对话？'))return;const deleted=state.conversations.find(item=>item.id===id);state.conversations=state.conversations.filter(item=>item.id!==id);if(state.selectedConversationId===id){const next=state.conversations.filter(item=>item.scope===deleted?.scope&&item.projectId===deleted?.projectId&&item.initiativeId===deleted?.initiativeId).sort((a,b)=>String(b.updatedAt).localeCompare(String(a.updatedAt)))[0];state.selectedConversationId=(next||createConversation(deleted?.scope||'global',deleted?.projectId||'',deleted?.initiativeId||'')).id;}saveState();renderAssistant();return;} const assistantTarget=event.target.closest('[data-assistant-target]'); if(assistantTarget){selectAssistantTarget(assistantTarget.dataset.assistantTarget);return;} const historyConversation=event.target.closest('[data-open-conversation]'); if(historyConversation){state.selectedConversationId=historyConversation.dataset.openConversation;assistantHistoryMenuOpen=false;saveState();renderAssistant();return;}
  const toggleQuickPrompts=event.target.closest('[data-toggle-quick-prompts]'); if(toggleQuickPrompts){quickPromptMenuOpen=!quickPromptMenuOpen;customQuickPromptOpen=false;renderQuickPrompts();return;}
  if(event.target.closest('[data-add-ai-prompt]')){customQuickPromptOpen=true;renderQuickPrompts();document.getElementById('customQuickPrompt')?.focus();return;}
  if(event.target.closest('[data-submit-ai-prompt]')){const input=document.getElementById('customQuickPrompt');const prompt=input?.value.trim();if(prompt){quickPromptMenuOpen=false;customQuickPromptOpen=false;renderQuickPrompts();aiReply(prompt);}return;}
  if (event.target.closest('#stopAgentButton')) { stopActiveAgent(); return; }
  const rerunAgentRun=event.target.closest('[data-rerun-agent-run]'); if(rerunAgentRun){rerunLatestAgentRun(rerunAgentRun.dataset.rerunAgentRun);return;}
  const expandRun = event.target.closest('[data-expand-agent-run]'); if (expandRun) { const run=state.agentRuns.find(item=>item.id===expandRun.dataset.expandAgentRun); const target=document.querySelector(`[data-agent-run-details="${expandRun.dataset.expandAgentRun}"]`); if (run && target) { target.innerHTML=renderAgentRunDetails(run); expandRun.remove(); } return; }
  const showSnapshot = event.target.closest('[data-show-agent-snapshot]'); if (showSnapshot) { const run=state.agentRuns.find(item=>item.id===showSnapshot.dataset.agentRunId); const snapshot=run?.promptSnapshots?.find(item=>item.id===showSnapshot.dataset.showAgentSnapshot); const output=showSnapshot.parentElement?.querySelector('.agent-log-lazy-output') || showSnapshot.closest('.run-step-body')?.querySelector('.agent-log-lazy-output'); if (output) output.innerHTML=snapshot?`<div class="json-viewer">${renderJsonValue(promptSnapshotForDisplay(snapshot))}</div>`:'<p class="run-prompt-pruned">完整 Prompt 快照已按保留策略清理。</p>'; return; }
  const showRaw = event.target.closest('[data-show-agent-raw]'); if (showRaw) { const run=state.agentRuns.find(item=>item.id===showRaw.dataset.showAgentRaw); const output=showRaw.parentElement?.querySelector('.agent-log-lazy-output'); if (run && output) output.innerHTML=`<div class="json-viewer">${renderJsonValue(run)}</div>`; return; }
  if (event.target.closest('[data-load-more-agent-runs]')) { state.agentRunLimit=(state.agentRunLimit || 10)+10; renderAgentRuns(); return; }
  const selectAutomation=event.target.closest('[data-select-automation-plan]'); if(selectAutomation&&!event.target.closest('[data-toggle-automation-rule]')){selectedAutomationPlanId=selectAutomation.dataset.selectAutomationPlan;automationDraft=null;renderAutomation();return;}
  const toggleAutomation=event.target.closest('[data-toggle-automation-rule]'); if(toggleAutomation){event.preventDefault();event.stopPropagation();toggleAutomationRule(toggleAutomation.dataset.toggleAutomationRule,toggleAutomation.dataset.enabled==='true');return;}
  const confirmAutomation=event.target.closest('[data-confirm-automation-plan]'); if(confirmAutomation){confirmAutomationPlan(confirmAutomation.dataset.confirmAutomationPlan);return;}
  const editAutomation=event.target.closest('[data-edit-automation-rule]'); if(editAutomation){editAutomationRule(editAutomation.dataset.editAutomationRule);return;}
  const deleteAutomation=event.target.closest('[data-delete-automation-rule]'); if(deleteAutomation){deleteAutomationRule(deleteAutomation.dataset.deleteAutomationRule);return;}
  const viewAutomation=event.target.closest('[data-view-automation-task]'); if(viewAutomation){viewAutomationTask(viewAutomation.dataset.viewAutomationTask);return;}
  const removeProgress=event.target.closest('[data-progress-remove-kind]'); if(removeProgress){setProgressOption(removeProgress.dataset.progressRemoveKind,removeProgress.dataset.progressRemoveId,removeProgress.dataset.progressValue,false);return;}
  const addProgress=event.target.closest('[data-progress-add-kind]'); if(addProgress){const input=document.querySelector(`[data-progress-new-kind="${addProgress.dataset.progressAddKind}"][data-progress-new-id="${addProgress.dataset.progressAddId}"]`);addProgressOption(addProgress.dataset.progressAddKind,addProgress.dataset.progressAddId,input);return;}
  const deleteProgress=event.target.closest('[data-progress-delete-option]'); if(deleteProgress){deleteProgressOption(deleteProgress.dataset.progressDeleteOption);return;}
  const target = event.target.closest('[data-view]'); if (target) switchView(target.dataset.view);
  if (event.target.closest('[data-upload-skill]')) document.getElementById('skillFileInput')?.click();
  const openParentSkill=event.target.closest('[data-open-parent-skill]'); if(openParentSkill){ selectedSkillParentPath=openParentSkill.dataset.openParentSkill; renderCliSkills(); return; }
  const deleteSkillButton=event.target.closest('[data-delete-skill]'); if(deleteSkillButton){ event.preventDefault(); event.stopPropagation(); deleteStoredSkill(deleteSkillButton.dataset.deleteSkill); return; }
  const open = event.target.closest('[data-open-form]'); if (open) openModal(open.dataset.openForm, {projectId:open.dataset.projectId});
  if (event.target.closest('[data-add-project]')) addProjectInline();
  const addInitiative = event.target.closest('[data-add-initiative]'); if (addInitiative) addInitiativeInline(addInitiative.dataset.addInitiative);
  const addLink = event.target.closest('[data-add-link-kind]'); if (addLink) addKnowledgeLink(addLink.dataset.addLinkKind, addLink.dataset.addLinkId);
  const removeLink = event.target.closest('[data-remove-link-kind]'); if (removeLink) removeKnowledgeLink(removeLink.dataset.removeLinkKind, removeLink.dataset.removeLinkId, removeLink.dataset.linkId);
  const removeImage = event.target.closest('[data-remove-inline-image-kind]'); if (removeImage) removeInlineImage(removeImage.dataset.removeInlineImageKind, removeImage.dataset.removeInlineImageId, removeImage.dataset.imageField, removeImage.dataset.imageIndex);
  const removeProject = event.target.closest('[data-delete-project]'); if (removeProject) deleteProject(removeProject.dataset.deleteProject);
  const removeInitiative = event.target.closest('[data-delete-initiative]'); if (removeInitiative) deleteInitiative(removeInitiative.dataset.deleteInitiative);
  const editProject = event.target.closest('[data-edit-project]'); if (editProject && !event.target.closest('button,a,input,textarea,select')) openModal('project',{projectId:editProject.dataset.editProject});
  const editInitiative = event.target.closest('[data-edit-initiative]'); if (editInitiative && !event.target.closest('button,a,input,textarea,select')) openModal('initiative',{initiativeId:editInitiative.dataset.editInitiative});
  const editKnowledge = event.target.closest('[data-edit-knowledge]'); if (editKnowledge) openModal('knowledge',{knowledgeId:editKnowledge.dataset.editKnowledge});
  const deleteKnowledgeButton = event.target.closest('[data-delete-knowledge]'); if (deleteKnowledgeButton) deleteKnowledge(deleteKnowledgeButton.dataset.deleteKnowledge);
  const search = event.target.closest('[data-knowledge-search]'); if (search) openKnowledgeSearch(search.dataset.knowledgeSearch, search.dataset.initiativeFocus || '');
  const archive = event.target.closest('[data-archive-initiative]'); if (archive) archiveInitiative(archive.dataset.archiveInitiative);
  const unarchive = event.target.closest('[data-unarchive-initiative]'); if (unarchive) unarchiveInitiative(unarchive.dataset.unarchiveInitiative);
  const projectToggle = event.target.closest('[data-toggle-project]'); if (projectToggle) toggleProject(projectToggle.dataset.toggleProject);
  const archiveToggle = event.target.closest('[data-toggle-archived]'); if (archiveToggle) toggleArchived(archiveToggle.dataset.toggleArchived);
  const ai = event.target.closest('[data-project-ai]'); if (ai) { openConversationScope('project',ai.dataset.projectAi); toast('已打开项目 AI 助手'); }
  const initiativeAi = event.target.closest('[data-initiative-ai]'); if (initiativeAi) { const record = getInitiative(initiativeAi.dataset.initiativeAi); if (record) { openConversationScope('initiative',record.project.id,record.initiative.id); toast(`已锚定事项「${record.initiative.name}」为讨论对象`); } }
  const show = event.target.closest('[data-show-knowledge]'); if (show) showKnowledge(show.dataset.showKnowledge);
  const type = event.target.closest('[data-knowledge-type]'); if (type) { state.knowledgeFilter.type = type.dataset.knowledgeType; saveState(); renderKnowledgeFilters(); renderKnowledge(); }
  const prompt = event.target.closest('[data-ai-prompt]'); if (prompt) { quickPromptMenuOpen=false;customQuickPromptOpen=false;renderQuickPrompts();aiReply(prompt.dataset.aiPrompt); }
  const createProposal = event.target.closest('[data-create-proposal]'); if (createProposal) submitProposal(createProposal.dataset.createProposal);
  const confirmProposalButton = event.target.closest('[data-confirm-proposal]'); if (confirmProposalButton) confirmProposal(confirmProposalButton.dataset.confirmProposal);
  const createMemory = event.target.closest('[data-create-memory]'); if (createMemory) submitMemoryCandidate(createMemory.dataset.createMemory);
  const confirmMemoryButton = event.target.closest('[data-confirm-memory]'); if (confirmMemoryButton) confirmMemory(confirmMemoryButton.dataset.confirmMemory);
  const correctMemoryButton = event.target.closest('[data-correct-memory]'); if (correctMemoryButton) correctMemory(correctMemoryButton.dataset.correctMemory);
  const expireMemoryButton = event.target.closest('[data-expire-memory]'); if (expireMemoryButton) expireMemory(expireMemoryButton.dataset.expireMemory);
  const editRecovery = event.target.closest('[data-edit-recovery-profile]'); if (editRecovery) editRecoveryProfile(editRecovery.dataset.editRecoveryProfile);
  if (event.target.id === 'closeModal' || event.target.id === 'modalBackdrop') closeModal();
  if (event.target.closest?.('#clearKnowledgeFilter')) clearKnowledgeFilters();
  if (event.target.id === 'toggleSidebar') { state.sidebarCollapsed = !state.sidebarCollapsed; saveState(); renderShell(); }
  if (event.target.id === 'toggleCopilot') { state.aiCollapsed = !state.aiCollapsed; saveState(); renderShell(); if(!state.aiCollapsed)renderAssistant(); }
  if (event.target.id === 'resetDemo') { if (confirm('将清除当前浏览器保存的项目、事项和知识库数据，并恢复演示数据。是否继续？')) { state=clone(defaultState); state.aiCollapsed=false; state.sidebarCollapsed=false; saveAndRender('已恢复演示数据'); } }
});
document.addEventListener('submit', event => { if (event.target.id === 'automationRuleForm') { event.preventDefault(); createAutomationPlan(); } if (event.target.id === 'projectForm') { event.preventDefault(); handleProjectForm(event.target); } if (event.target.id === 'initiativeForm') { event.preventDefault(); handleInitiativeForm(event.target); } if (event.target.id === 'knowledgeForm') { event.preventDefault(); handleKnowledgeForm(event.target); } if (event.target.id === 'chatForm') { event.preventDefault(); const input=document.getElementById('chatInput'); const value=input.value.trim(); const images=[...pendingChatImages]; const selectedModel=chatModelCatalog.find((model)=>model.id===state.selectedChatModel); const submissionError=chatSubmissionError(images, selectedModel); if (submissionError) return toast(submissionError); if(value || images.length){input.value='';clearPendingChatImages();aiReply(value,images);} } });
document.addEventListener('input', event => { if (event.target.matches('.portfolio-table .inline-textarea')) { event.target.style.height = 'auto'; event.target.style.height = `${event.target.scrollHeight}px`; } });
document.addEventListener('change', event => { if (event.target.matches('[data-progress-option-kind]')) { setProgressOption(event.target.dataset.progressOptionKind,event.target.dataset.progressOptionId,event.target.value,event.target.checked); return; } if (event.target.matches('[data-inline-kind]')) { updateInlineField(event.target); return; } if (event.target.id === 'chatModelSelect') { state.selectedChatModel=event.target.value; saveState(); toast(`已切换到 ${chatModelCatalog.find((model)=>model.id===event.target.value)?.label || '所选模型'}`); return; } if (event.target.id === 'knowledgeProjectFilter') { state.knowledgeFilter.projectId=event.target.value; state.knowledgeFilter.query=''; saveState(); renderKnowledge(); } if (event.target.id === 'memoryProjectFilter') { state.memoryFilter.projectId=event.target.value; state.memoryFilter.initiativeId='ALL'; saveState(); renderProjectMemory(); } if (event.target.id === 'memoryInitiativeFilter') { state.memoryFilter.initiativeId=event.target.value; saveState(); renderProjectMemory(); } if (event.target.id === 'agentRunProjectFilter') { state.agentRunFilter.projectId=event.target.value; saveState(); renderAgentRuns(); } if (event.target.id === 'agentRunStatusFilter') { state.agentRunFilter.status=event.target.value; saveState(); renderAgentRuns(); } if (event.target.id === 'knowledgeProjectInput') { const initiativeSelect=document.getElementById('knowledgeInitiativeInput'); initiativeSelect.innerHTML=initiativeOptions(event.target.value); } });
document.getElementById('chatImageInput').addEventListener('change', event=>{ addPendingChatImages(event.target.files); event.target.value=''; });
document.getElementById('skillFileInput').addEventListener('change', event=>{ uploadManualSkill(event.target.files?.[0]); event.target.value=''; });
document.getElementById('knowledgeSearchInput').addEventListener('input', event=>{state.knowledgeFilter.query=event.target.value; saveState(); renderKnowledge();});
function handleInlineImagePaste(event) {
  const source = event.target instanceof Element ? event.target : document.activeElement;
  const target = source?.closest?.('.portfolio-table [data-inline-kind][data-inline-field="currentState"], .portfolio-table [data-inline-kind][data-inline-field="learning"]');
  if (!target) return;
  const clipboard = event.clipboardData;
  const imageItem = [...(clipboard?.items || [])].find(item => item.kind === 'file' && item.type?.startsWith('image/'));
  const imageFile = imageItem?.getAsFile?.() || [...(clipboard?.files || [])].find(file => file.type?.startsWith('image/'));
  if (!imageFile) return;
  event.preventDefault();
  event.stopPropagation();
  const kind = target.dataset.inlineKind;
  const id = target.dataset.inlineId;
  const imageField = `${target.dataset.inlineField}Images`;
  const reader = new FileReader();
  reader.onerror = () => toast('图片读取失败，请重新复制后粘贴');
  reader.onload = () => { if (typeof reader.result === 'string') savePastedImage(kind, id, imageField, reader.result); };
  reader.readAsDataURL(imageFile);
}
document.addEventListener('paste', handleInlineImagePaste, true);
document.getElementById('chatInput').addEventListener('paste', event=>{ const image=[...(event.clipboardData?.files || [])].find((file)=>file.type?.startsWith('image/')); if(image){ event.preventDefault(); addPendingChatImages([image]); } });
document.addEventListener('dblclick', event => { const image = event.target.closest('.inline-image-wrap img'); if (!image) return; const viewer=document.getElementById('imageViewer'); document.getElementById('imageViewerTarget').src=image.src; viewer.classList.add('show'); viewer.setAttribute('aria-hidden','false'); });
document.getElementById('closeImageViewer').addEventListener('click',()=>{ const viewer=document.getElementById('imageViewer'); viewer.classList.remove('show'); viewer.setAttribute('aria-hidden','true'); document.getElementById('imageViewerTarget').src=''; });
document.getElementById('imageViewer').addEventListener('click', event=>{ if(event.target.id==='imageViewer') document.getElementById('closeImageViewer').click(); });
document.getElementById('chatInput').addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();document.getElementById('chatForm').requestSubmit();}});
document.addEventListener('keydown',event=>{if(event.target.id==='customQuickPrompt'&&event.key==='Enter'){event.preventDefault();event.target.closest('.quick-prompt-menu')?.querySelector('[data-submit-ai-prompt]')?.click();}});

if (API_ENDPOINT) hydrateFromBackend();
else renderAll();

// Recover server-persisted assistant replies when this page regains focus.
window.addEventListener('focus', () => {
  if (API_ENDPOINT && !activeAgentRequests.size && !backendSaveTimer && !backendSaveInFlight) void hydrateFromBackend();
});
