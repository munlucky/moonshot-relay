import test from 'node:test';
import assert from 'node:assert/strict';
import { buildUsageReceipt } from '../src/host/kernel/usage-receipt.js';
import { buildPromptEnvelope } from '../src/host/kernel/prompt-envelope.js';
import { buildToolManifest } from '../src/host/kernel/tool-manifest.js';
import { resolveSessionLineage } from '../src/host/kernel/session-affinity.js';
import { CLAUDE_CAPABILITIES } from '../src/host/kernel/adapters/claude.js';

const envelope = buildPromptEnvelope({
  provider: 'claude',
  role: 'implementer',
  toolManifest: buildToolManifest([{ name: 'read_file', description: 'Read a file' }]),
  contextSegments: {},
  modelPolicy: {
    modelClass: 'value_coding',
    resolvedModel: 'model-a',
    resolvedEffort: 'high',
    speedMode: 'standard',
    policyRevision: 'kernel-claude-effort.v1',
  },
  capabilities: CLAUDE_CAPABILITIES,
  env: { MOON_RELAY_KERNEL_CLAUDE_OPTIMIZATION: 'on' },
});

const lineage = resolveSessionLineage({ previous: null, current: envelope.cacheIdentity });

const receipt = buildUsageReceipt({
  decision: {
    decisionId: 'route-abcdef12',
    runId: 'run-1',
    modelClass: 'value_coding',
    policyRevision: 'kernel-model-routing.v1',
  },
  capabilities: CLAUDE_CAPABILITIES,
  strategy: 'subagent',
  resolution: { model: 'model-a', effort: 'high', enforcementIntent: 'enforced' },
  dispatch: {
    resolvedModel: 'model-a',
    resolvedEffort: 'high',
    observedModel: 'model-a',
    observedEffort: 'high',
    speedMode: 'standard',
    inputTokens: 1000,
    cacheReadInputTokens: 800,
    cacheWriteInputTokens: 50,
    outputTokens: 120,
    reasoningTokens: 40,
  },
  actorSessionId: 'session-1',
  startedAt: '2026-07-29T00:00:00.000Z',
  finishedAt: '2026-07-29T00:00:03.000Z',
  envelope,
  sessionLineage: lineage,
  cacheContext: { eligiblePrefixTokens: 900, modelEscalationReason: 'complexity' },
});

test('the receipt records which prompt shape produced the cache result', () => {
  assert.equal(receipt.promptPrefixDigest, envelope.cacheIdentity.prefixDigest);
  assert.equal(receipt.cacheMode, 'on');
  assert.equal(receipt.cacheTtl, 'default');
  assert.equal(receipt.eligiblePrefixTokens, 900);
});

test('the receipt pins the derived Host execution profile revision', () => {
  assert.ok(receipt.executionProfileRevision);
  assert.match(
    receipt.executionProfileRevision,
    /^host-execution-profile\.v1:sha256:[a-f0-9]{64}$/,
  );
  const downgraded = buildUsageReceipt({
    decision: {
      decisionId: 'route-abcdef13',
      runId: 'run-1',
      modelClass: 'value_coding',
      policyRevision: 'kernel-model-routing.v1',
    },
    capabilities: { ...CLAUDE_CAPABILITIES, supportsUsageTokens: false },
    strategy: 'subagent',
    resolution: { model: 'model-a', effort: 'high', enforcementIntent: 'enforced' },
    dispatch: {
      resolvedModel: 'model-a',
      resolvedEffort: 'high',
      observedModel: 'model-a',
      observedEffort: 'high',
    },
    actorSessionId: 'session-2',
    envelope,
  });
  assert.notEqual(
    downgraded.executionProfileRevision,
    receipt.executionProfileRevision,
  );
});

test('model, effort, speed, reasoning context, and delegation mode are all recorded', () => {
  assert.equal(receipt.resolvedModel, 'model-a');
  assert.equal(receipt.resolvedEffort, 'high');
  assert.equal(receipt.speedMode, 'standard');
  assert.equal(receipt.reasoningContext, envelope.modelPolicy.reasoningContext);
  assert.equal(receipt.delegationMode, 'none');
});

test('the session lineage is carried so continuation can be measured', () => {
  assert.equal(receipt.sessionLineageId, lineage.sessionLineageId);
});

test('an escalation reason is attributable', () => {
  assert.equal(receipt.modelEscalationReason, 'complexity');
});

test('cache read and write are recorded separately from total input', () => {
  assert.equal(receipt.inputTokens, 1000);
  assert.equal(receipt.cacheReadInputTokens, 800);
  assert.equal(receipt.cacheWriteInputTokens, 50);
  assert.equal(receipt.reasoningTokens, 40);
  assert.equal(receipt.cacheMissReason, null);
});

test('no provider prompt or reasoning text crosses into the receipt', () => {
  const serialized = JSON.stringify(receipt);
  assert.ok(!serialized.includes('kernel_execution'));
  assert.ok(!serialized.includes('claude_runtime'));
});
