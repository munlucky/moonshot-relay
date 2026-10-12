import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeModelRouting } from '../src/kernel/run/model-route-contract.js';
import { normalizeModelRouteDecision } from '../src/contracts/model-route.js';
import { normalizeModelUsageReceipt } from '../src/contracts/model-execution.js';

const decision = (overrides: Partial<Parameters<typeof normalizeModelRouteDecision>[0]>) => normalizeModelRouteDecision({
  decisionId: 'route-abcdef12',
  runId: 'run-1',
  actionKind: 'implement',
  modelClass: 'value_coding',
  role: 'implementer',
  permissions: 'workspace_write',
  riskTier: 'T1',
  reasonCodes: ['ACTION_DEFAULT'],
  policyRevision: 'kernel-model-routing.v1',
  ...overrides,
});

const receipt = (overrides: Partial<Parameters<typeof normalizeModelUsageReceipt>[0]>) => normalizeModelUsageReceipt({
  decisionId: 'route-abcdef12',
  runId: 'run-1',
  hostSurface: 'codex',
  actorSessionId: `sha256:${'a'.repeat(64)}`,
  enforcementStatus: 'advisory',
  resultStatus: 'completed',
  ...overrides,
});

test('the existing routing summary still reports class distribution', () => {
  const summary = summarizeModelRouting(
    [decision({}), decision({ decisionId: 'route-abcdef13', modelClass: 'frontier_reasoning', role: 'planner', actionKind: 'plan', permissions: 'plan_write' })],
    [],
  );
  assert.equal(summary.totalTurns, 2);
  assert.equal(summary.valueTurns, 1);
  assert.equal(summary.frontierTurns, 1);
});

test('escalated turns are counted from their reason codes', () => {
  const summary = summarizeModelRouting([decision({ reasonCodes: ['RETRY_ESCALATION'] })], []);
  assert.equal(summary.escalatedTurns, 1);
});

test('a turn whose Host reported no tokens contributes to turns but not to totals', () => {
  const summary = summarizeModelRouting([decision({})], [receipt({})]);
  assert.equal(summary.advisoryTurns, 1);
  assert.equal(summary.tokens.input, null);
  assert.equal(summary.tokens.reportedTurns, 0);
});

test('reported tokens accumulate and the cached total is carried', () => {
  const summary = summarizeModelRouting([decision({})], [receipt({ inputTokens: 1000, cachedInputTokens: 600, outputTokens: 100 })]);
  assert.equal(summary.tokens.input, 1000);
  assert.equal(summary.tokens.cachedInput, 600);
  assert.equal(summary.tokens.reportedTurns, 1);
});

test('resolved models are attributed to the class that requested them', () => {
  const summary = summarizeModelRouting([decision({})], [receipt({ resolvedModel: 'gpt-5.6-terra' })]);
  assert.deepEqual(summary.resolvedModels, ['value_coding:gpt-5.6-terra']);
});
