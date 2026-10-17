import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CLAUDE_AGENT_FOR_ROLE, buildClaudeInvocation, createClaudeAdapter } from '../src/host/kernel/adapters/claude.js';
import { resolveModelRoute } from '../src/kernel/run/model-routing.js';
import { buildUsageReceipt } from '../src/host/kernel/usage-receipt.js';

const decisionFor = (actionKind: string, riskTier = 'T1') => resolveModelRoute({ runId: 'r-claude', actionKind, riskTier, obligationId: 'default' });
const resolution = (model: string | null) => ({ model, effort: 'high', enforcementIntent: model ? 'enforced' : 'advisory' });

test('each Kernel role maps onto its own Claude subagent', () => {
  assert.deepEqual(CLAUDE_AGENT_FOR_ROLE, { planner: 'kernel-planner', implementer: 'kernel-implementer', reviewer: 'kernel-reviewer' });
  assert.equal(buildClaudeInvocation({ decision: decisionFor('plan'), resolution: resolution('f') }).subagent, 'kernel-planner');
  assert.equal(buildClaudeInvocation({ decision: decisionFor('implement'), resolution: resolution('v') }).subagent, 'kernel-implementer');
  assert.equal(buildClaudeInvocation({ decision: decisionFor('review_engineering'), resolution: resolution('f') }).subagent, 'kernel-reviewer');
  assert.throws(() => buildClaudeInvocation({ decision: decisionFor('prove'), resolution: resolution(null) }), /No Claude subagent/);
});

test('the reviewer is read-only and runs in a fresh context; T3 demands a separate session', () => {
  const review = buildClaudeInvocation({ decision: decisionFor('review_engineering', 'T3'), resolution: resolution('f') });
  assert.equal(review.readOnly, true);
  assert.equal(review.freshContext, true);
  assert.equal(review.independentSessionRequired, true);

  const implement = buildClaudeInvocation({ decision: decisionFor('implement', 'T3'), resolution: resolution('v') });
  assert.equal(implement.readOnly, false);
  assert.equal(implement.permissions, 'workspace_write');
  assert.equal(implement.independentSessionRequired, false);

  const t1Review = buildClaudeInvocation({ decision: decisionFor('review_contract', 'T1'), resolution: resolution('f') });
  assert.equal(t1Review.independentSessionRequired, false);
  assert.equal(t1Review.readOnly, true);
});

test('the adapter injects the registry model rather than pinning one of its own', async () => {
  const adapter = createClaudeAdapter({ launch: async ({ invocation }) => {
    assert.ok(invocation && typeof invocation === 'object' && 'model' in invocation);
    return { resolvedModel: invocation.model, sessionId: 's1' };
  } });
  const planned = await adapter.dispatch({
    decision: decisionFor('plan'),
    resolution: resolution('registry-frontier'),
    strategy: 'subagent',
    executionContract: {},
    executionMode: 'native-subagent',
    delegationRequested: true,
  });
  assert.equal(planned.resolvedModel, 'registry-frontier');
  assert.equal(planned.resolvedEffort, 'high');
  assert.equal(planned.observedModel, null);
  assert.equal(planned.observedEffort, null);
  // No provider model id may appear anywhere in the adapter source contract.
  assert.doesNotMatch(JSON.stringify(CLAUDE_AGENT_FOR_ROLE), /gpt-|claude-|gemini/i);
});

test('resolved Claude configuration is not promoted to observed execution identity', async () => {
  const adapter = createClaudeAdapter({ launch: async ({ invocation }) => ({
    resolvedModel: invocation && typeof invocation === 'object' && 'model' in invocation ? invocation.model : null,
    resolvedEffort: invocation && typeof invocation === 'object' && 'effort' in invocation ? invocation.effort : null,
    sessionId: 's-observation-missing',
  }) });
  const decision = decisionFor('implement');
  const requested = resolution('registry-value');
  const dispatch = await adapter.dispatch({
    decision,
    resolution: requested,
    strategy: 'subagent',
    executionContract: {},
    executionMode: 'native-subagent',
    delegationRequested: true,
  });
  assert.equal(dispatch.resolvedModel, 'registry-value');
  assert.equal(dispatch.resolvedEffort, 'high');
  assert.equal(dispatch.observedModel, null);
  assert.equal(dispatch.observedEffort, null);
  const receipt = buildUsageReceipt({
    decision,
    capabilities: adapter.capabilities,
    strategy: 'subagent',
    resolution: requested,
    dispatch,
    actorSessionId: 's-observation-missing',
  });
  assert.equal(receipt.enforcementStatus, 'advisory');
  assert.equal(receipt.observedModel, null);
  assert.equal(receipt.observedEffort, null);
});

test('a Host with no launcher keeps ordinary work owner-direct instead of inventing a worker blocker', async () => {
  const adapter = createClaudeAdapter();
  assert.equal(adapter.capabilities.supportsSubagentModel, false);
  assert.equal(adapter.capabilities.supportsResolvedModelIdentity, false);
  assert.equal(adapter.capabilities.supportsUsageTokens, false);
  assert.equal(adapter.capabilities.supportsPromptCache, false);
  assert.equal(adapter.capabilities.supportsCacheReadTokens, false);
  assert.equal(adapter.capabilities.supportsCacheWriteTokens, false);
  assert.equal(adapter.capabilities.supportsSessionContinuation, true);
  const decision = decisionFor('implement');
  const dispatch = await adapter.dispatch({ decision, resolution: resolution('registry-value'), strategy: 'subagent', executionContract: {} });
  assert.equal(dispatch.status, 'owner-direct');
  assert.equal(dispatch.resultStatus, 'interrupted');
  const receipt = buildUsageReceipt({
    decision,
    capabilities: adapter.capabilities,
    strategy: 'subagent',
    resolution: resolution('registry-value'),
    dispatch,
    actorSessionId: 'no-launcher',
  });
  assert.equal(receipt.enforcementStatus, 'unsupported');
  assert.equal(receipt.resolvedModel, null);
});

test('a Host that cannot resolve model identity is downgraded even when it can pick a subagent', async () => {
  const adapter = createClaudeAdapter({
    capabilities: { supportsResolvedModelIdentity: false },
    launch: async () => ({ sessionId: 's1' }),
  });
  assert.equal(adapter.capabilities.supportsResolvedModelIdentity, false);
  const decision = decisionFor('implement');
  const dispatch = await adapter.dispatch({
    decision,
    resolution: resolution('registry-value'),
    strategy: 'advisory',
    executionContract: {},
    executionMode: 'native-subagent',
    delegationRequested: true,
  });
  const receipt = buildUsageReceipt({ decision, capabilities: adapter.capabilities, strategy: 'advisory', resolution: resolution('registry-value'), dispatch, actorSessionId: 's1' });
  assert.equal(receipt.enforcementStatus, 'unsupported');
});
