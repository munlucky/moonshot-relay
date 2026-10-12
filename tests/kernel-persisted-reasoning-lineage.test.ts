import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveProviderPromptPolicy } from '../src/host/kernel/provider-prompt-policy.js';
import { buildUsageReceipt } from '../src/host/kernel/usage-receipt.js';
import { CLAUDE_CAPABILITIES } from '../src/host/kernel/adapters/claude.js';

const capable = { supportsPersistedReasoning: true };

test('reasoning persists only while the goal and priorities hold', () => {
  assert.equal(resolveProviderPromptPolicy({ provider: 'codex', role: 'implementer', capabilities: capable }).reasoningPolicy.persistedReasoning, 'all_turns');
});

test('a role change or independent review drops back to the current turn', () => {
  for (const role of ['reviewer', 'planner']) {
    assert.equal(resolveProviderPromptPolicy({ provider: 'codex', role, capabilities: capable }).reasoningPolicy.persistedReasoning, 'current_turn', role);
  }
});

test('an undetected capability never persists reasoning', () => {
  const policy = resolveProviderPromptPolicy({ provider: 'codex', role: 'implementer', capabilities: {} });
  assert.equal(policy.reasoningPolicy.supported, false);
  assert.equal(policy.reasoningPolicy.persistedReasoning, 'current_turn');
});

test('the response lineage is recorded as a digest, never as a raw id', () => {
  const receipt = buildUsageReceipt({
    decision: { decisionId: 'route-abcdef12', runId: 'run-1', modelClass: 'value_coding' },
    capabilities: CLAUDE_CAPABILITIES,
    strategy: 'subagent',
    resolution: { model: 'model-a', effort: 'high', enforcementIntent: 'enforced' },
    dispatch: { resolvedModel: 'model-a', previousResponseId: 'resp_0123456789abcdef' },
    actorSessionId: 'session-1',
    startedAt: '2026-07-29T00:00:00.000Z',
  });
  assert.equal(typeof receipt.previousResponseIdDigest, 'string');
  assert.ok(receipt.previousResponseIdDigest);
  assert.match(receipt.previousResponseIdDigest, /^sha256:[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(receipt).includes('resp_0123456789abcdef'));
});

test('a turn with no prior response records null rather than an empty digest', () => {
  const receipt = buildUsageReceipt({
    decision: { decisionId: 'route-abcdef12', runId: 'run-1', modelClass: 'value_coding' },
    capabilities: CLAUDE_CAPABILITIES,
    strategy: 'subagent',
    resolution: { model: 'model-a', effort: 'high', enforcementIntent: 'enforced' },
    dispatch: { resolvedModel: 'model-a' },
    actorSessionId: 'session-1',
    startedAt: '2026-07-29T00:00:00.000Z',
  });
  assert.equal(receipt.previousResponseIdDigest, null);
});
