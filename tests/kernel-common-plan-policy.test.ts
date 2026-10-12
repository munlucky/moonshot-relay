import test from 'node:test';
import assert from 'node:assert/strict';
import { resolvePlanPolicy, isHighRiskShape } from '../src/host/kernel/common-model-policy.js';

test('a simple T1 edit produces no plan artifact at all', () => {
  assert.deepEqual(resolvePlanPolicy({ riskTier: 'T1', actionKind: 'implement', complexity: 'simple' }), {
    mode: 'none',
    independentReviewRequired: false,
  });
});

test('moderate work plans internally instead of emitting an artifact', () => {
  assert.equal(resolvePlanPolicy({ complexity: 'moderate' }).mode, 'internal');
});

test('complex, ambiguous, or multi-step work earns an explicit plan', () => {
  for (const complexity of ['complex', 'ambiguous', 'multi-step']) {
    assert.equal(resolvePlanPolicy({ complexity }).mode, 'explicit');
  }
});

test('a plan action always plans explicitly', () => {
  for (const actionKind of ['plan', 'design', 'replan']) {
    assert.equal(resolvePlanPolicy({ actionKind }).mode, 'explicit');
  }
});

test('security, migration, and data-loss shapes force a plan plus independent review', () => {
  for (const shape of ['security', 'migration', 'data-loss', 'payment', 'authentication']) {
    const policy = resolvePlanPolicy({ shapes: [shape] });
    assert.equal(policy.mode, 'explicit-with-review');
    assert.equal(policy.independentReviewRequired, true);
  }
  assert.equal(resolvePlanPolicy({ riskTier: 'T3' }).independentReviewRequired, true);
});

test('a harmless shape does not trip the high-risk gate', () => {
  assert.equal(isHighRiskShape(['formatting', 'docs']), false);
  assert.equal(isHighRiskShape(['docs', 'migration']), true);
});
