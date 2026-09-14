'use strict';

const crypto = require('node:crypto');

const AUTOMATION_CAPABILITIES = Object.freeze({});

function localDateKey(date = new Date()) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

function minutesOfDay(date = new Date()) { return date.getHours() * 60 + date.getMinutes(); }
function parseTime(value) {
  const match = String(value || '').match(/^(\d{2}):(\d{2})$/);
  if (!match) return null;
  const hours = Number(match[1]); const minutes = Number(match[2]);
  return hours < 24 && minutes < 60 ? hours * 60 + minutes : null;
}
function normalizeStringArray(value, limit = 20) { return Array.isArray(value) ? value.map(String).map((item) => item.trim()).filter(Boolean).slice(0, limit) : []; }
function normalizeObject(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }

function normalizeAutomationPlan(raw = {}) {
  const triggerRaw = normalizeObject(raw.trigger);
  const type = ['event','daily','weekly','due_today'].includes(triggerRaw.type) ? triggerRaw.type : '';
  const trigger = {
    type,
    time: String(triggerRaw.time || '').trim(),
    weekdays: (Array.isArray(triggerRaw.weekdays) ? triggerRaw.weekdays : []).map(Number).filter((day) => Number.isInteger(day) && day >= 0 && day <= 6),
    events: normalizeStringArray(triggerRaw.events, 10),
  };
  const matchRaw = normalizeObject(raw.match || raw.conditions);
  const match = {
    targetKinds: normalizeStringArray(matchRaw.targetKinds || ['project','initiative'], 2).filter((kind) => ['project','initiative'].includes(kind)),
    actionIncludesAny: normalizeStringArray(matchRaw.actionIncludesAny, 20),
    progressIncludesAny: normalizeStringArray(matchRaw.progressIncludesAny, 20),
    requireLinkedUrl: Boolean(matchRaw.requireLinkedUrl),
    dueToday: Boolean(matchRaw.dueToday || type === 'due_today'),
    includeArchived: Boolean(matchRaw.includeArchived),
    includeCompleted: Boolean(matchRaw.includeCompleted),
  };
  const task = String(raw.task || raw.taskInstruction || raw.summary || '').trim().slice(0, 3000);

  return {
    title:String(raw.title || '未命名自动化规则').trim().slice(0, 120),
    trigger, match, task,
    summary:String(raw.summary || task).trim().slice(0, 2000),
  };
}

function validateAutomationPlan(plan) {
  const errors = [];
  if (!plan.title) errors.push('规则标题不能为空。');
  if (!plan.trigger.type) errors.push('无法识别可支持的触发时机。');
  if (['daily','weekly','due_today'].includes(plan.trigger.type) && parseTime(plan.trigger.time) === null) errors.push('定时或到期触发必须包含 HH:MM 格式的具体时间。');
  if (plan.trigger.type === 'weekly' && !plan.trigger.weekdays.length) errors.push('每周触发必须指定星期。');
  if (!plan.match.targetKinds.length) errors.push('命中条件必须包含项目或事项目标。');
  if (!plan.task) errors.push('请明确命中后需要执行的具体任务。');
  return { feasible:errors.length === 0, errors };
}

function actionTargets(state) {
  return (state.projects || []).flatMap((project) => {
    const projectTarget = project.nextAction && project.nextActionDdl ? [{ kind:'project', projectId:project.id, targetId:project.id, project, item:project }] : [];
    const initiatives = (project.initiatives || []).filter((item) => item.nextAction && item.nextActionDdl).map((item) => ({ kind:'initiative', projectId:project.id, targetId:item.id, project, item }));
    return [...projectTarget, ...initiatives];
  });
}

function targetLinkedUrls(target) { return (target.item.knowledgeLinks || []).map((link) => String(link?.url || '')).filter(Boolean); }
function targetMatches(plan, target, today = localDateKey()) {
  const match = plan.match;
  if (!match.targetKinds.includes(target.kind)) return false;
  if (target.kind === 'initiative' && target.item.archived && !match.includeArchived) return false;
  if (target.kind === 'initiative' && target.item.actionDone && !match.includeCompleted) return false;
  if (match.dueToday && String(target.item.nextActionDdl || '').slice(0, 10) !== today) return false;
  const action = String(target.item.nextAction || '').toLowerCase();
  if (match.actionIncludesAny.length && !match.actionIncludesAny.some((term) => action.includes(term.toLowerCase()))) return false;
  const progress = String(target.item.progress || '').toLowerCase();
  if (match.progressIncludesAny.length && !match.progressIncludesAny.some((term) => progress.includes(term.toLowerCase()))) return false;
  if (match.requireLinkedUrl && !targetLinkedUrls(target).length) return false;
  return true;
}

function triggerCycle(plan, now = new Date(), reason = 'event') {
  const date = localDateKey(now);
  if (reason === 'confirm') return `confirm:${date}`;
  if (plan.trigger.type === 'weekly') return `weekly:${date}`;
  if (plan.trigger.type === 'daily') return `daily:${date}`;
  if (plan.trigger.type === 'due_today') return `due:${date}`;
  return `event:${date}`;
}

function triggerReady(plan, now = new Date(), reason = 'event') {
  if (reason === 'confirm') return true;
  if (plan.trigger.type === 'event') return !plan.trigger.events.length || plan.trigger.events.includes(reason) || plan.trigger.events.includes('state_changed');
  const configured = parseTime(plan.trigger.time);
  if (configured === null || minutesOfDay(now) < configured) return false;
  if (plan.trigger.type === 'weekly' && !plan.trigger.weekdays.includes(now.getDay())) return false;
  return true;
}

function automationTaskKey(rule, target, cycle) {
  return crypto.createHash('sha256').update([rule.id, rule.version, target.kind, target.targetId, String(target.item.nextActionDdl || '').slice(0,10), cycle].join('|')).digest('hex');
}

function buildAutomationUserInput({ rule, plan, task, target }) {
  return [
    `[自动化任务 ${task.id}]`,
    `规则：${rule.title}`,
    `触发原因：${task.triggerReason}`,
    `目标：${target.kind === 'project' ? '项目' : '事项'}「${target.item.name}」（projectId=${target.projectId}${target.kind === 'initiative' ? `, initiativeId=${target.targetId}` : ''}）`,
    `当前进度：${target.item.progress || '未知'}`,
    `下一步动作：${target.item.nextAction || ''}`,
    `下一步动作截止日期：${String(target.item.nextActionDdl || '').slice(0,10)}`,
    `预计完成日期：${String(target.item.plannedEnd || '').slice(0,10)}`,
    `关联链接：${targetLinkedUrls(target).join('、') || '无'}`,
    '',
    `具体任务：${plan.task || plan.summary || ''}`,
    '请把以上具体任务作为普通用户任务执行。你可根据当前目标事实和 Provider tools 中的详细工具 Schema，自主选择正确工具与参数；需要确认 CLI 参数时先调用 inspect_cli_help。执行多步骤工作时创建本次 Execution Plan，并在结束时如实交付结果。',
  ].join('\n');
}

function defaultFlashModel(models = []) {
  return models.find((model) => /flash/i.test(model.id) || /flash/i.test(model.label)) || models[0] || null;
}

module.exports = { AUTOMATION_CAPABILITIES, localDateKey, normalizeAutomationPlan, validateAutomationPlan, actionTargets, targetMatches, triggerReady, triggerCycle, automationTaskKey, buildAutomationUserInput, defaultFlashModel };
