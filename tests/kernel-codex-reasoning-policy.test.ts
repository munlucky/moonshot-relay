import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveCodexModelPolicy, CODEX_MODELS, CODEX_REASONING_EFFORTS } from '../src/host/kernel/codex-model-policy.js';

test('medium is the starting point for ordinary work', () => {
  assert.equal(resolveCodexModelPolicy({ actionKind: 'implement' }).reasoning, 'medium');
});

test('all review execution classes use Sol xhigh, including protected reviews', () => {
  const engineeringReview = resolveCodexModelPolicy({ actionKind: 'review_engineering' });
  assert.equal(engineeringReview.reasoning, 'xhigh');
  assert.equal(engineeringReview.model, CODEX_MODELS.sol);
  for (const shape of ['security', 'migration', 'authentication', 'authorization', 'payment', 'data-loss', 'irreversible']) {
    const input = { actionKind: 'review_contract', shapes: [shape] };
    const policy = resolveCodexModelPolicy(input);
    assert.equal(policy.reasoning, 'xhigh', shape);
    assert.equal(policy.model, CODEX_MODELS.sol);
  }
  const input = { actionKind: 'review_engineering', riskTier: 'T3' };
  const t3Review = resolveCodexModelPolicy(input);
  assert.equal(t3Review.reasoning, 'xhigh');
  assert.equal(t3Review.model, CODEX_MODELS.sol);
});

test('repeated failure does not change the standard execution class policy', () => {
  const input = { actionKind: 'implement', repeatedFailure: true };
  const policy = resolveCodexModelPolicy(input);
  assert.equal(policy.model, CODEX_MODELS.luna);
  assert.equal(policy.reasoning, 'medium');
  assert.ok(!policy.reasons.includes('repeated-failure-escalation'));
});

test('an unrecognized requested reasoning is ignored rather than passed through', () => {
  const policy = resolveCodexModelPolicy({ actionKind: 'implement', userRequested: { reasoning: 'ultra' } });
  assert.equal(policy.reasoning, 'medium');
  assert.ok(!policy.reasons.includes('user-requested-reasoning'));
});

test('the reasoning vocabulary is closed and ordered cheapest-first', () => {
  assert.deepEqual([...CODEX_REASONING_EFFORTS], ['low', 'medium', 'high', 'xhigh', 'max']);
});
