import test from 'node:test';
import assert from 'node:assert/strict';
import { buildUsageReceipt } from '../src/host/kernel/usage-receipt.js';
import { CODEX_CAPABILITIES } from '../src/host/kernel/adapters/codex.js';
import { CLAUDE_CAPABILITIES } from '../src/host/kernel/adapters/claude.js';

const decision = { decisionId: 'route-abcdef12', runId: 'run-1', modelClass: 'value_coding' };

const receiptFor = (capabilities: Parameters<typeof buildUsageReceipt>[0]['capabilities'], dispatch: Parameters<typeof buildUsageReceipt>[0]['dispatch'] = {}, extra: Partial<Parameters<typeof buildUsageReceipt>[0]> = {}) => buildUsageReceipt({
  decision,
  capabilities,
  strategy: 'session',
  resolution: { model: 'model-a', effort: 'high', enforcementIntent: 'enforced' },
  dispatch: { resolvedModel: 'model-a', ...dispatch },
  actorSessionId: 'session-1',
  startedAt: '2026-07-29T00:00:00.000Z',
  ...extra,
});

test('a provider without prompt cache records provider-unsupported, not a miss', () => {
  const receipt = receiptFor(CODEX_CAPABILITIES);
  assert.equal(receipt.cacheMissReason, 'provider-unsupported');
  assert.equal(receipt.cacheReadInputTokens, null);
  assert.equal(receipt.cacheWriteInputTokens, null);
});

test('cache counts a Host cannot observe stay null even when the dispatch supplies them', () => {
  // Codex declares it cannot count cache tokens; a number arriving anyway is
  // not evidence, so it is dropped rather than persisted as measurement.
  const receipt = receiptFor(CODEX_CAPABILITIES, { cacheReadInputTokens: 4321 });
  assert.equal(receipt.cacheReadInputTokens, null);
});

test('a capable provider that reported nothing is usage-unreported, not zero', () => {
  const receipt = receiptFor(CLAUDE_CAPABILITIES);
  assert.equal(receipt.cacheReadInputTokens, null);
  assert.equal(receipt.cacheMissReason, 'usage-unreported');
});

test('a genuine cold prefix is distinguished from an unreported one', () => {
  const receipt = receiptFor(CLAUDE_CAPABILITIES, { cacheReadInputTokens: 0, cacheWriteInputTokens: 900, inputTokens: 900 });
  assert.equal(receipt.cacheReadInputTokens, 0);
  assert.equal(receipt.cacheWriteInputTokens, 900);
  assert.equal(receipt.cacheMissReason, 'cold-prefix');
});

test('a warm hit records no miss reason', () => {
  const receipt = receiptFor(CLAUDE_CAPABILITIES, { cacheReadInputTokens: 800, cacheWriteInputTokens: 0, inputTokens: 900 });
  assert.equal(receipt.cacheMissReason, null);
});

test('an explicitly diagnosed miss keeps its own reason', () => {
  const receipt = receiptFor(CLAUDE_CAPABILITIES, { cacheReadInputTokens: 0 }, { cacheContext: { cacheMissReason: 'tool-schema-changed' } });
  assert.equal(receipt.cacheMissReason, 'tool-schema-changed');
});
