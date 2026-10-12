import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeModelUsageReceipt } from '../src/contracts/model-execution.js';

const base = {
  decisionId: 'route-abcdef12',
  runId: 'run-1',
  hostSurface: 'claude',
  actorSessionId: `sha256:${'a'.repeat(64)}`,
  enforcementStatus: 'enforced',
  resultStatus: 'completed',
  resolvedModel: 'model-a',
};

test('the new economics fields default to null, not zero', () => {
  const receipt = normalizeModelUsageReceipt(base);
  for (const field of [
    'provider', 'surface', 'speedMode', 'reasoningContext', 'reasoningMode', 'delegationMode',
    'sessionLineageId', 'previousResponseIdDigest', 'promptPrefixDigest', 'promptCacheKeyDigest',
    'cacheMode', 'cacheTtl', 'cacheMissReason', 'modelEscalationReason',
    'eligiblePrefixTokens', 'uncachedInputTokens', 'cacheReadInputTokens', 'cacheWriteInputTokens', 'reasoningTokens',
  ] as const) {
    assert.equal(receipt[field], null, `${field} must default to null`);
  }
});

test('cache read and write are recorded separately', () => {
  const receipt = normalizeModelUsageReceipt({ ...base, cacheReadInputTokens: 900, cacheWriteInputTokens: 120, eligiblePrefixTokens: 1000 });
  assert.equal(receipt.cacheReadInputTokens, 900);
  assert.equal(receipt.cacheWriteInputTokens, 120);
  assert.equal(receipt.eligiblePrefixTokens, 1000);
});

test('a zero read is preserved as a measured zero', () => {
  const receipt = normalizeModelUsageReceipt({ ...base, cacheReadInputTokens: 0 });
  assert.equal(receipt.cacheReadInputTokens, 0);
});

test('a negative count is refused rather than clamped', () => {
  assert.throws(() => normalizeModelUsageReceipt({ ...base, cacheWriteInputTokens: -1 }), /must be a non-negative integer or null/);
});

test('cache mode and diagnostic reasons come from closed vocabularies', () => {
  const receipt = normalizeModelUsageReceipt({ ...base, cacheMode: 'shadow', cacheMissReason: 'tool-schema-changed', modelEscalationReason: 'repeated-failure' });
  assert.equal(receipt.cacheMode, 'shadow');
  assert.equal(receipt.cacheMissReason, 'tool-schema-changed');
  assert.equal(receipt.modelEscalationReason, 'repeated-failure');
  assert.throws(() => normalizeModelUsageReceipt({ ...base, cacheMode: 'enabled' }), /cacheMode must be one of/);
  assert.throws(() => normalizeModelUsageReceipt({ ...base, cacheMissReason: 'because' }), /cacheMissReason must be one of/);
});

test('the prefix digest and session lineage travel with the numbers', () => {
  const receipt = normalizeModelUsageReceipt({ ...base, promptPrefixDigest: 'sha256:abc', sessionLineageId: 'session-1234' });
  assert.equal(receipt.promptPrefixDigest, 'sha256:abc');
  assert.equal(receipt.sessionLineageId, 'session-1234');
});

test('the receipt validates against its published schema', async () => {
  const { readFile } = await import('node:fs/promises');
  const schema = JSON.parse(await readFile('schemas/kernel.model-usage.schema.json', 'utf8'));
  const receipt = normalizeModelUsageReceipt({ ...base, cacheReadInputTokens: 10, cacheMode: 'on', provider: 'claude' });
  // additionalProperties is false, so every new field must be declared.
  const undeclared = Object.keys(receipt).filter((key) => !Object.hasOwn(schema.properties, key));
  assert.deepEqual(undeclared, []);
});
