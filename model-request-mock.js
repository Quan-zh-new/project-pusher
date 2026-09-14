'use strict';

const form = document.getElementById('requestForm');
const modelInput = document.getElementById('model');
const modelOptions = document.getElementById('modelOptions');
const modelPicker = document.getElementById('modelPicker');
const status = document.getElementById('status');
const submitButton = document.getElementById('submitButton');
const requestOutput = document.getElementById('requestOutput');
const responseOutput = document.getElementById('responseOutput');
const toolCallPanel = document.getElementById('toolCallPanel');
const toolCallList = document.getElementById('toolCallList');

const toolSelectionList = document.getElementById('toolSelectionList');
const toolSelectionSummary = document.getElementById('toolSelectionSummary');
const selectDefaultToolsButton = document.getElementById('selectDefaultTools');
const clearToolsButton = document.getElementById('clearTools');
let serverTools = [];


function numberOrUndefined(value) {
  return value === '' ? undefined : Number(value);
}

function selectedToolNames() {
  return [...toolSelectionList.querySelectorAll('input:checked')].map((input) => input.value);
}

function parseToolArguments(value) {
  const source = value.trim();
  if (!source) return {};
  const parsed = JSON.parse(source);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('工具参数必须是 JSON 对象。');
  return parsed;
}

function modelToolCalls(response) {
  const calls = response?.choices?.[0]?.message?.tool_calls;
  return Array.isArray(calls) ? calls.slice(0, 3) : [];
}

async function executeManualToolCall(card, call) {
  const button = card.querySelector('button');
  const argsInput = card.querySelector('textarea');
  const resultOutput = card.querySelector('pre');
  button.disabled = true;
  resultOutput.textContent = '正在执行工具调用...';
  try {
    const args = parseToolArguments(argsInput.value);
    const response = await fetch('/api/model-request-mock/tools/execute', {
      method:'POST', headers:{ 'Content-Type':'application/json' },
      body:JSON.stringify({ name:call.function?.name || '', args, selectedToolNames:selectedToolNames() }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || `工具调用失败 (${response.status})`);
    resultOutput.textContent = JSON.stringify(payload.result, null, 2);
  } catch (error) {
    resultOutput.textContent = JSON.stringify({ error:error.message || '工具调用失败。' }, null, 2);
  } finally {
    button.disabled = false;
  }
}

function renderModelToolCalls(response) {
  const calls = modelToolCalls(response);
  toolCallPanel.hidden = !calls.length;
  toolCallList.replaceChildren();
  for (const [index, call] of calls.entries()) {
    const card = document.createElement('article');
    card.className = 'tool-call-card';
    const heading = document.createElement('h3');
    heading.textContent = `#${index + 1} ${call.function?.name || 'unknown_tool'}`;
    const note = document.createElement('p');
    note.textContent = '参数已从模型返回自动填入。执行会产生真实工具结果。';
    const args = document.createElement('textarea');
    args.rows = 8;
    let parsedArgs = call.function?.arguments || '{}';
    try { parsedArgs = JSON.stringify(JSON.parse(parsedArgs), null, 2); } catch {}
    args.value = parsedArgs;
    const button = document.createElement('button');
    button.type = 'button'; button.textContent = '手动执行此工具';
    const output = document.createElement('pre');
    output.textContent = '尚未执行。';
    button.addEventListener('click', () => executeManualToolCall(card, call));
    card.append(heading, note, args, button, output);
    toolCallList.append(card);
  }
}

function formPayload() {
  return {
    model: modelInput.value.trim(),
    systemPrompt: document.getElementById('systemPrompt').value,
    userPrompt: document.getElementById('userPrompt').value,
    sendRealRequest: document.getElementById('sendRealRequest').checked,
    temperature: numberOrUndefined(document.getElementById('temperature').value),
    topP: numberOrUndefined(document.getElementById('topP').value),
    maxTokens: numberOrUndefined(document.getElementById('maxTokens').value),
    seed: numberOrUndefined(document.getElementById('seed').value),
    selectedToolNames:selectedToolNames(),
  };
}

function updateToolSelectionSummary() {
  const selected = toolSelectionList.querySelectorAll('input:checked').length;
  toolSelectionSummary.textContent = `已选择 ${selected}/${serverTools.length} 个工具`;
}

function renderToolSelection() {
  toolSelectionList.replaceChildren();
  for (const tool of serverTools) {
    const label = document.createElement('label');
    label.className = `tool-option ${tool.availability === 'restricted' ? 'tool-option-restricted' : ''}`;
    const input = document.createElement('input');
    input.type = 'checkbox'; input.value = tool.name; input.checked = Boolean(tool.defaultSelected);
    input.addEventListener('change', updateToolSelectionSummary);
    const content = document.createElement('span');
    const title = document.createElement('b'); title.textContent = tool.name;
    const description = document.createElement('small'); description.textContent = tool.description;
    const badge = document.createElement('em'); badge.textContent = tool.availability === 'restricted' ? '受限' : '未受限';
    content.append(title, description);
    label.append(input, content, badge);
    toolSelectionList.append(label);
  }
  updateToolSelectionSummary();
}

async function hydrateToolSelection() {
  const response = await fetch('/api/model-request-mock/tools', { cache:'no-store' });
  if (!response.ok) throw new Error('服务端工具列表加载失败');
  const payload = await response.json();
  serverTools = Array.isArray(payload.tools) ? payload.tools : [];
  renderToolSelection();
}

async function hydrateModels() {
  const response = await fetch('/api/model-request-mock/models', { cache: 'no-store' });
  if (!response.ok) throw new Error('模型目录加载失败');
  const payload = await response.json();
  const models = Array.isArray(payload.models) ? payload.models : [];
  modelOptions.replaceChildren();
  modelPicker.replaceChildren(new Option(`选择模型（${models.length} 个）`, ''));
  for (const entry of models) {
    const option = new Option(`${entry.label} (${entry.id})`, entry.id);
    modelPicker.add(option);
    modelOptions.append(new Option(entry.label, entry.id));
  }
  const preferred = models.find((entry) => entry.id === 'deepseek/deepseek-v4-flash')?.id || models[0]?.id || '';
  modelInput.value = preferred;
  modelPicker.value = preferred;
}

modelPicker.addEventListener('change', () => {
  if (modelPicker.value) modelInput.value = modelPicker.value;
});


form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const payload = formPayload();
  submitButton.disabled = true;
  status.textContent = payload.sendRealRequest ? '正在发送真实请求...' : '正在生成 Mock 请求...';
  try {
    const response = await fetch('/api/model-request-mock', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || `请求失败 (${response.status})`);
    requestOutput.textContent = JSON.stringify(body.request, null, 2);
    responseOutput.textContent = JSON.stringify(body.response, null, 2);
    renderModelToolCalls(body.response);
    status.textContent = body.mocked ? 'Mock 已生成；未调用外部模型。' : '真实请求已完成，已展示上游原始返回。';
  } catch (error) {
    status.textContent = error.message || '请求失败。';
  } finally {
    submitButton.disabled = false;
  }
});

selectDefaultToolsButton.addEventListener('click', () => { toolSelectionList.querySelectorAll('input').forEach((input, index) => { input.checked = Boolean(serverTools[index]?.defaultSelected); }); updateToolSelectionSummary(); });
clearToolsButton.addEventListener('click', () => { toolSelectionList.querySelectorAll('input').forEach((input) => { input.checked = false; }); updateToolSelectionSummary(); });

Promise.all([hydrateModels(), hydrateToolSelection()]).catch((error) => { status.textContent = error.message || '初始化失败，请刷新重试。'; });
