'use strict';

/**
 * Generic agent harness.
 * The model decides the task plan and tool calls; this module only runs the
 * loop, records standardized results, and persists plan state through hooks.
 */

function standardizeToolResult(result, call, index) {
  return {
    toolCallId: result.toolCallId || `${call.name}:${index}`,
    tool: call.name,
    status: result.status || 'completed',
    summary: result.summary || result.note || result.error || '',
    retryable: Boolean(result.retryable),
    missing: Array.isArray(result.missing) ? result.missing : [],
    artifacts: Array.isArray(result.artifacts) ? result.artifacts : [],
    data: result.data || null,
    error: result.error || null,
    ...result,
  };
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  return value;
}

function toolCallSignature(call) {
  return `${String(call?.name || '')}:${JSON.stringify(stableValue(call?.args || {}))}`;
}

function blockedToolResult(call, attempts, limit) {
  const error = `同一工具调用已失败 ${attempts} 次，超过最多 ${limit} 次重试；已跳过，继续执行其他未受影响的事项。`;
  return standardizeToolResult({
    status: 'blocked',
    retryable: false,
    skipped: true,
    skipReason: 'retry_limit_reached',
    attempts,
    retryLimit: limit,
    error,
    note: error,
    summary: error,
  }, call, 0);
}

function skippedTimedOutToolResult(call, attempts, limit, result) {
  const error = `同一工具调用已超时 ${attempts} 次，已完成 ${limit} 次重试；跳过该工具并继续执行其他未受影响的事项。`;
  return standardizeToolResult({
    status:'partial',
    retryable:false,
    skipped:true,
    skipReason:'retry_limit_reached',
    attempts,
    retryLimit:limit,
    timedOut:true,
    error,
    note:error,
    summary:error,
    data:result.data || null,
  }, call, 0);
}

function normalizePlanUpdate(plan, update) {
  if (!plan || !update) return plan;
  const updates = new Map((update.completionChecklist || []).map((item) => [String(item.id), item]));
  plan.completionChecklist = (plan.completionChecklist || []).map((item) => {
    const change = updates.get(item.id);
    return change ? {
      ...item,
      status: change.status || item.status,
      note: String(change.note || ''),
      artifactIds: Array.isArray(change.artifactIds) ? change.artifactIds.map(String) : item.artifactIds,
    } : item;
  });
  const unfinished = (plan.completionChecklist || []).filter((item) => item.status !== 'completed');
  const requestedCompletion = Boolean(update.goalCompleted);
  plan.goalCompleted = requestedCompletion && unfinished.length === 0;
  plan.status = plan.goalCompleted ? 'completed' : 'needs_action';
  plan.missingActions = plan.goalCompleted
    ? []
    : [...new Set([...(Array.isArray(update.missingActions) ? update.missingActions.map(String) : []), ...unfinished.map((item) => item.description)])];
  plan.nextAction = String(update.nextAction || (plan.goalCompleted ? '' : '完成未完成的 checklist 项。'));
  plan.summary = String(update.summary || '');
  plan.completionRejected = requestedCompletion && !plan.goalCompleted;
  return plan;
}

async function runAgentLoop({
  initial,
  maxSteps,
  getCalls,
  dispatch,
  nextModel,
  ensurePlan,
  applyPlanUpdate,
  shouldStopAfterDispatch,
  beforeNextModel,
  onStep,
  signal,
  maxRetryableFailuresPerCall = 1,
  forceFinalResponseAtLimit = false,
}) {
  let answer = initial;
  let plan = null;
  let step = 1;
  const toolResults = [];
  const artifacts = [];
  const failureCounts = new Map();
  const blockedCalls = new Map();
  let finalResponseForced = false;
  const assertActive = () => {
    if (!signal?.aborted) return;
    const error = new Error('AI agent run was stopped.');
    error.code = 'AGENT_STOPPED';
    error.statusCode = 499;
    throw error;
  };

  const appendResults = (results) => {
    toolResults.push(...results);
    artifacts.push(...results.flatMap((result) => result.artifacts || []));
    if (plan) {
      plan.currentStep = step;
      plan.toolResults.push(...results);
      plan.artifacts.push(...results.flatMap((result) => result.artifacts || []));
    }
  };

  while (step <= maxSteps) {
    assertActive();
    const calls = getCalls(answer);
    plan = await ensurePlan({ answer, calls, plan, step, toolResults, artifacts });

    if (!calls.length) break;

    const executable = [];
    const skipped = [];
    for (const call of calls) {
      const signature = toolCallSignature(call);
      if (blockedCalls.has(signature)) {
        skipped.push(blockedToolResult(call, blockedCalls.get(signature).attempts, maxRetryableFailuresPerCall));
      } else {
        executable.push({ call, signature });
      }
    }

    let normalized = [];
    if (executable.length) {
      const dispatched = await dispatch({ calls: executable.map((item) => item.call), plan, step });
      assertActive();
      plan = dispatched.plan || plan;
      normalized = (dispatched.results || dispatched).map((result, index) => {
        const call = executable[index].call;
        const signature = executable[index].signature;
        const current = standardizeToolResult(result, call, index);
        current.callSignature = signature;
        if (current.status === 'failed' && current.retryable) {
          const attempts = (failureCounts.get(signature) || 0) + 1;
          failureCounts.set(signature, attempts);
          current.attempts = attempts;
          current.retryLimit = maxRetryableFailuresPerCall;
          if (attempts > maxRetryableFailuresPerCall) {
            const blocked = current.timedOut || ['TOOL_TIMEOUT','ETIMEDOUT'].includes(String(current.errorCode || current.data?.code || ''))
              ? skippedTimedOutToolResult(call, attempts, maxRetryableFailuresPerCall, current)
              : blockedToolResult(call, attempts, maxRetryableFailuresPerCall);
            blocked.toolCallId = current.toolCallId;
            blocked.data = current.data;
            blocked.artifacts = current.artifacts;
            blocked.originalError = current.error;
            blocked.callSignature = signature;
            return blocked;
          }
        } else if (current.status === 'failed' && !current.retryable) {
          current.status = 'blocked';
          current.skipReason = 'non_retryable_failure';
          current.attempts = 1;
          current.retryLimit = 0;
          current.summary = current.summary || current.error || '工具失败且不应重试。';
        }
        return current;
      });
    }

    const currentResults = [...normalized, ...skipped];
    appendResults(currentResults);
    for (const result of currentResults.filter((item) => item.status === 'blocked' || item.skipReason === 'retry_limit_reached')) {
      const signature = result.callSignature;
      if (!signature) continue;
      blockedCalls.set(signature, { attempts:Number(result.attempts || maxRetryableFailuresPerCall + 1), error:result.originalError || result.error || '' });
    }
    onStep?.({ step, calls, toolResults:currentResults, plan, blockedCalls:[...blockedCalls.entries()].map(([signature, value]) => ({ signature, ...value })) });

    // The model must include its user-facing delivery in the same response as
    // terminal plan updates. This path intentionally keeps that response and
    // avoids spending another model turn only to restate verified results.
    if (shouldStopAfterDispatch?.({ answer, plan, step, calls, toolResults:currentResults, artifacts })) break;

    // Reserve the final model call for a mandatory user-facing wrap-up. Tool
    // execution is allowed only through the preceding loop so a runaway task
    // cannot consume the final turn with yet another tool call.
    if (forceFinalResponseAtLimit && maxSteps > 1 && step >= maxSteps - 1) {
      finalResponseForced = true;
      step += 1;
      assertActive();
      await beforeNextModel?.({
        step,
        plan,
        toolResults,
        lastLoopToolResults: currentResults,
        artifacts,
        forceFinalResponse: true,
        retryPolicy: {
          maxRetryableFailuresPerCall,
          blockedCalls:[...blockedCalls.entries()].map(([signature, value]) => ({ signature, ...value })),
        },
      });
      answer = await nextModel({
        step,
        plan,
        toolResults,
        lastLoopToolResults: currentResults,
        artifacts,
        forceFinalResponse: true,
        retryPolicy: {
          maxRetryableFailuresPerCall,
          blockedCalls:[...blockedCalls.entries()].map(([signature, value]) => ({ signature, ...value })),
        },
      });
      break;
    }

    if (step >= maxSteps) break;

    step += 1;
    assertActive();
    await beforeNextModel?.({
      step,
      plan,
      toolResults,
      lastLoopToolResults: currentResults,
      artifacts,
      forceFinalResponse: false,
      retryPolicy: {
        maxRetryableFailuresPerCall,
        blockedCalls:[...blockedCalls.entries()].map(([signature, value]) => ({ signature, ...value })),
      },
    });
    answer = await nextModel({
      step,
      plan,
      toolResults,
      lastLoopToolResults: currentResults,
      artifacts,
      forceFinalResponse: false,
      retryPolicy: {
        maxRetryableFailuresPerCall,
        blockedCalls:[...blockedCalls.entries()].map(([signature, value]) => ({ signature, ...value })),
      },
    });
  }

  return {
    answer,
    plan,
    toolResults,
    artifacts,
    steps: step,
    limitReached: finalResponseForced || (step >= maxSteps && Boolean(getCalls(answer).length)),
    finalResponseForced,
    blockedCalls:[...blockedCalls.entries()].map(([signature, value]) => ({ signature, ...value })),
  };
}

module.exports = { runAgentLoop, normalizePlanUpdate, standardizeToolResult, toolCallSignature };
