import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeModelUsageReceipt } from '../src/contracts/model-execution.js';

const base = {
  decisionId: 'route-abcdef12',
  runId: 'run-1',
  hostSurface: 'claude',
  actorSessionId: `sha256:${'a'.repeat(64)}`,
  enforcementStatus: 'advisory',
  resultStatus: 'completed',
};

test('a legacy Host reporting only cachedInputTokens is read as a cache read', () => {
  const receipt = normalizeModelUsageReceipt({ ...base, cachedInputTokens: 512 });
  assert.equal(receipt.cachedInputTokens, 512);
  assert.equal(receipt.cacheReadInputTokens, 512);
});

test('a new Host reporting cacheReadInputTokens keeps the legacy field populated', () => {
  const receipt = normalizeModelUsageReceipt({ ...base, cacheReadInputTokens: 512 });
  assert.equal(receipt.cacheReadInputTokens, 512);
  assert.equal(receipt.cachedInputTokens, 512, 'existing readers must not go blind');
});

test('a Host reporting neither leaves both null', () => {
  const receipt = normalizeModelUsageReceipt(base);
  assert.equal(receipt.cachedInputTokens, null);
  assert.equal(receipt.cacheReadInputTokens, null);
});

test('an explicit zero is not confused with an absent measurement', () => {
  const measured = normalizeModelUsageReceipt({ ...base, cachedInputTokens: 0 });
  assert.equal(measured.cachedInputTokens, 0);
  assert.equal(measured.cacheReadInputTokens, 0);
  assert.notEqual(measured.cacheReadInputTokens, null);
});

test('every pre-existing receipt field keeps its meaning', () => {
  const receipt = normalizeModelUsageReceipt({
    ...base,
    resolvedModel: 'model-a',
    resolvedEffort: 'high',
    inputTokens: 1000,
    outputTokens: 200,
    costMicros: 4200,
    wallClockMs: 900,
    capsuleId: 'capsule-1',
    stepId: 'step-1',
    admissionId: 'adm-1',
  });
  assert.equal(receipt.schemaVersion, 1);
  assert.equal(receipt.inputTokens, 1000);
  assert.equal(receipt.outputTokens, 200);
  assert.equal(receipt.costMicros, 4200);
  assert.equal(receipt.capsuleId, 'capsule-1');
  assert.equal(receipt.stepId, 'step-1');
  assert.equal(receipt.admissionId, 'adm-1');
});
