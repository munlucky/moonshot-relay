import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveCodexModelPolicy, CODEX_MODELS, CODEX_REASONING_EFFORTS } from '../src/host/kernel/codex-model-policy.js';

test('max is the starting point for ordinary work', () => {
  assert.equal(resolveCodexModelPolicy({ actionKind: 'implement' }).reasoning, 'max');
});

test('all review execution classes use Astra high, including protected reviews', () => {
  const engineeringReview = resolveCodexModelPolicy({ actionKind: 'review_engineering' });
  assert.equal(engineeringReview.reasoning, 'high');
  assert.equal(engineeringReview.model, CODEX_MODELS.astra);
  for (const shape of ['security', 'migration', 'authentication', 'authorization', 'payment', 'data-loss', 'irreversible']) {
    const input = { actionKind: 'review_contract', shapes: [shape] };
    const policy = resolveCodexModelPolicy(input);
    assert.equal(policy.reasoning, 'high', shape);
    assert.equal(policy.model, CODEX_MODELS.astra);
  }
  const input = { actionKind: 'review_engineering', riskTier: 'T3' };
  const t3Review = resolveCodexModelPolicy(input);
  assert.equal(t3Review.reasoning, 'high');
  assert.equal(t3Review.model, CODEX_MODELS.astra);
});

test('repeated failure does not change the standard execution class policy', () => {
  const input = { actionKind: 'implement', repeatedFailure: true };
  const policy = resolveCodexModelPolicy(input);
  assert.equal(policy.model, CODEX_MODELS.luna);
  assert.equal(policy.reasoning, 'max');
  assert.ok(!policy.reasons.includes('repeated-failure-escalation'));
});

test('an unrecognized requested reasoning is ignored rather than passed through', () => {
  const policy = resolveCodexModelPolicy({ actionKind: 'implement', userRequested: { reasoning: 'ultra' } });
  assert.equal(policy.reasoning, 'max');
  assert.ok(!policy.reasons.includes('user-requested-reasoning'));
});

test('the reasoning vocabulary is closed and ordered cheapest-first', () => {
  assert.deepEqual([...CODEX_REASONING_EFFORTS], ['low', 'medium', 'high', 'xhigh', 'max']);
});
