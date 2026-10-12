import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeCacheEconomics } from '../src/kernel/run/model-route-contract.js';
import { normalizeModelUsageReceipt } from '../src/contracts/model-execution.js';

const receipt = (overrides: Partial<Parameters<typeof normalizeModelUsageReceipt>[0]>) => normalizeModelUsageReceipt({
  decisionId: 'route-abcdef12',
  runId: 'run-1',
  hostSurface: 'claude',
  actorSessionId: `sha256:${'a'.repeat(64)}`,
  enforcementStatus: 'advisory',
  resultStatus: 'completed',
  ...overrides,
});

test('the eligible hit ratio compares reads against the cacheable prefix', () => {
  const summary = summarizeCacheEconomics([receipt({ eligiblePrefixTokens: 1000, cacheReadInputTokens: 900 })]);
  assert.equal(summary.eligibleHitRatio, 0.9);
});

test('the write/read ratio exposes an unprofitable prefix', () => {
  const summary = summarizeCacheEconomics([receipt({ cacheReadInputTokens: 400, cacheWriteInputTokens: 100 })]);
  assert.equal(summary.writeReadRatio, 0.25);
});

test('a ratio with a zero or unmeasured denominator is null, not zero', () => {
  assert.equal(summarizeCacheEconomics([receipt({ cacheReadInputTokens: 100 })]).eligibleHitRatio, null);
  assert.equal(summarizeCacheEconomics([receipt({ cacheReadInputTokens: 0, cacheWriteInputTokens: 0 })]).writeReadRatio, null);
  assert.equal(summarizeCacheEconomics([]).totalInputCacheRatio, null);
});

test('unmeasured totals stay null instead of summing to zero', () => {
  const summary = summarizeCacheEconomics([receipt({}), receipt({})]);
  assert.equal(summary.totals.cacheReadInputTokens, null);
  assert.equal(summary.totals.eligiblePrefixTokens, null);
  assert.equal(summary.receipts, 2);
});

test('the reasoning ratio is computed from reported tokens only', () => {
  const summary = summarizeCacheEconomics([receipt({ reasoningTokens: 50, outputTokens: 200 })]);
  assert.equal(summary.reasoningRatio, 0.25);
});

test('a receipt reporting only the denominator does not drag the ratio down', () => {
  // Regression: one turn reports 50/100 (a real 50% hit), a second turn
  // reports an eligiblePrefixTokens of 100 but never reports a read. Summing
  // each field independently would divide 50 by 200 and publish 25% for a
  // combined rate that is actually unknown on the second turn. Only the
  // fully-reported turn may contribute to either side.
  const summary = summarizeCacheEconomics([
    receipt({ eligiblePrefixTokens: 100, cacheReadInputTokens: 50 }),
    receipt({ eligiblePrefixTokens: 100, cacheReadInputTokens: null }),
  ]);
  assert.equal(summary.eligibleHitRatio, 0.5);
});

test('a receipt reporting only the numerator is excluded the same way', () => {
  const summary = summarizeCacheEconomics([
    receipt({ inputTokens: 100, cacheReadInputTokens: 40 }),
    receipt({ inputTokens: null, cacheReadInputTokens: 10 }),
  ]);
  assert.equal(summary.totalInputCacheRatio, 0.4);
});

test('no receipt reporting both sides of a ratio yields null, not a partial sum', () => {
  const summary = summarizeCacheEconomics([
    receipt({ eligiblePrefixTokens: 100, cacheReadInputTokens: null }),
    receipt({ eligiblePrefixTokens: null, cacheReadInputTokens: 50 }),
  ]);
  assert.equal(summary.eligibleHitRatio, null);
});

test('miss reasons are counted so a regression points at its cause', () => {
  const summary = summarizeCacheEconomics([
    receipt({ cacheMissReason: 'cold-prefix' }),
    receipt({ cacheMissReason: 'cold-prefix' }),
    receipt({ cacheMissReason: 'tool-schema-changed' }),
  ]);
  assert.deepEqual(summary.missReasons, { 'cold-prefix': 2, 'tool-schema-changed': 1 });
});
