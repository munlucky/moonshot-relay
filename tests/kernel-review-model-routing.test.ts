import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyReviewFindings, normalizeReviewFinding } from '../src/kernel/proof/review-pipeline.js';
import { resolveModelRoute } from '../src/host/kernel/model-routing.js';

test('both review stages run on the frontier class regardless of risk tier', () => {
  for (const tier of ['T0', 'T1', 'T2', 'T3']) {
    for (const stage of ['review_contract', 'review_engineering']) {
      const decision = resolveModelRoute({ runId: 'r', actionKind: stage, riskTier: tier });
      assert.equal(decision.modelClass, 'frontier_reasoning', `${stage}@${tier}`);
      assert.equal(decision.role, 'reviewer');
      assert.equal(decision.permissions, 'read_only');
    }
  }
});

test('an implementation finding stays with the value class', () => {
  const followUp = classifyReviewFindings([{ severity: 'important', category: 'implementation', summary: 'off-by-one' }]);
  assert.equal(followUp.requiredAction, 'fix');
  assert.equal(followUp.modelClass, 'value_coding');
  assert.equal(followUp.actionKind, 'debug');
  assert.equal(followUp.blocking, false);
});

test('a contract or architecture finding forces a frontier replan, not a local patch', () => {
  for (const category of ['contract', 'architecture']) {
    const followUp = classifyReviewFindings([{ severity: 'important', category, summary: 'wrong seam' }]);
    assert.equal(followUp.requiredAction, 'replan', category);
    assert.equal(followUp.modelClass, 'frontier_reasoning');
    assert.equal(followUp.actionKind, 'replan');
  }
  // The most severe finding wins when a review returns a mix.
  const mixed = classifyReviewFindings([
    { category: 'implementation', summary: 'nit' },
    { category: 'architecture', summary: 'seam' },
  ]);
  assert.equal(mixed.requiredAction, 'replan');
});

test('a critical security finding blocks instead of routing more implementation', () => {
  const followUp = classifyReviewFindings([{ severity: 'critical', category: 'security', summary: 'auth bypass' }]);
  assert.equal(followUp.requiredAction, 'block');
  assert.equal(followUp.blocking, true);
  assert.equal(followUp.modelClass, 'frontier_reasoning');
});

test('legacy string findings still classify, and unknown categories default conservatively', () => {
  assert.deepEqual(normalizeReviewFinding('something is off'), {
    severity: 'minor', category: 'implementation', path: null, summary: 'something is off', requiredAction: 'fix',
  });
  assert.equal(normalizeReviewFinding({ category: 'nonsense', summary: 'x' }).category, 'implementation');
  assert.equal(classifyReviewFindings([]).requiredAction, 'none');
  assert.equal(classifyReviewFindings([]).modelClass, null);
});

test('a review-driven replan lands on the frontier class through the router', () => {
  const decision = resolveModelRoute({ runId: 'r', actionKind: 'implement', architectureDeviation: true, obligationId: 'default' });
  assert.equal(decision.actionKind, 'replan');
  assert.equal(decision.modelClass, 'frontier_reasoning');
  assert.ok(decision.reasonCodes.includes('ARCHITECTURE_DEVIATION_REPLAN'));
});
