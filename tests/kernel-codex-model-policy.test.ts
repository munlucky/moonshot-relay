import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CODEX_EXECUTION_CLASSES,
  CODEX_EXECUTION_POLICY,
  CODEX_MODELS,
  resolveCodexCapabilityDelta,
  resolveCodexExecutionClass,
  resolveCodexModelAlias,
  resolveCodexModelPolicy,
} from '../src/host/kernel/codex-model-policy.js';

test('the Codex Host policy maps exactly four execution classes to two settings', () => {
  assert.deepEqual([...CODEX_EXECUTION_CLASSES], ['planning', 'complex_implementation', 'review', 'standard']);
  const expected = {
    planning: [CODEX_MODELS.astra, 'high'],
    complex_implementation: [CODEX_MODELS.astra, 'high'],
    review: [CODEX_MODELS.astra, 'high'],
    standard: [CODEX_MODELS.luna, 'high'],
  };
  for (const executionClass of CODEX_EXECUTION_CLASSES) {
    const policy = resolveCodexModelPolicy({ executionClass });
    assert.deepEqual([policy.model, policy.effort], expected[executionClass], executionClass);
    assert.deepEqual(CODEX_EXECUTION_POLICY[executionClass], { model: policy.model, effort: policy.effort });
    assert.equal(policy.executionClass, executionClass);
  }
});

test('B12 rejects cross-class model pairings and max as a default effort', () => {
  const expected = {
    planning: [CODEX_MODELS.astra, 'high'],
    complex_implementation: [CODEX_MODELS.astra, 'high'],
    review: [CODEX_MODELS.astra, 'high'],
    standard: [CODEX_MODELS.luna, 'high'],
  };
  for (const [executionClass, [model, effort]] of Object.entries(expected)) {
    const policy = resolveCodexModelPolicy({ executionClass });
    for (const otherModel of [CODEX_MODELS.astra, CODEX_MODELS.luna]) {
      if (otherModel !== model) assert.notEqual(policy.model, otherModel, `${executionClass} must not route to ${otherModel}`);
    }
    for (const otherEffort of ['high', 'max']) {
      if (otherEffort !== effort) assert.notEqual(policy.effort, otherEffort, `${executionClass} must not use ${otherEffort}`);
    }
  }
});

test('the default class policy ignores risk and retry signals rather than escalating silently', () => {
  const reviewInput = { executionClass: 'review', riskTier: 'T3', shapes: ['security'], repeatedFailure: true };
  const review = resolveCodexModelPolicy(reviewInput);
  assert.equal(review.model, CODEX_MODELS.astra);
  assert.equal(review.effort, 'high');
  const standardInput = { executionClass: 'standard', repeatedFailure: true };
  const standard = resolveCodexModelPolicy(standardInput);
  assert.equal(standard.model, CODEX_MODELS.luna);
  assert.equal(standard.effort, 'high');
  assert.throws(() => resolveCodexModelPolicy({ executionClass: 'ultrabrain' }), /executionClass must be one of/);
});

test('legacy action inputs normalize into the canonical class vocabulary', () => {
  assert.equal(resolveCodexExecutionClass({ actionKind: 'plan' }), 'planning');
  assert.equal(resolveCodexExecutionClass({ actionKind: 'review_engineering' }), 'review');
  assert.equal(resolveCodexExecutionClass({ actionKind: 'implement', complexity: 'complex' }), 'complex_implementation');
  assert.equal(resolveCodexExecutionClass({ actionKind: 'implement' }), 'standard');
});

test('ordinary implementation and debugging default to Luna at high', () => {
  for (const actionKind of ['implement', 'debug']) {
    const policy = resolveCodexModelPolicy({ actionKind });
    assert.equal(policy.model, CODEX_MODELS.luna);
    assert.equal(policy.reasoning, 'high');
    assert.ok(policy.reasons.includes('execution-class:standard'));
  }
});

test('planning actions route to Astra at high', () => {
  for (const actionKind of ['understand', 'design', 'plan', 'replan']) {
    const policy = resolveCodexModelPolicy({ actionKind });
    assert.equal(policy.model, CODEX_MODELS.astra);
    assert.equal(policy.reasoning, 'high');
  }
});

test('complex implementation and large refactors escalate to Astra high', () => {
  for (const complexity of ['complex', 'large-refactor']) {
    const policy = resolveCodexModelPolicy({ actionKind: 'implement', complexity });
    assert.equal(policy.model, CODEX_MODELS.astra);
    assert.equal(policy.reasoning, 'high');
  }
});

test('routine batch uses the same Luna high actor as ordinary work', () => {
  const luna = resolveCodexModelPolicy({ actionKind: 'implement', complexity: 'routine-batch' });
  assert.equal(luna.model, CODEX_MODELS.luna);
  assert.equal(luna.reasoning, 'high');
  assert.equal(resolveCodexModelPolicy({ actionKind: 'implement', complexity: 'standard' }).model, CODEX_MODELS.luna);
});

test('high is the default implementation effort and explicit max requests remain attributable', () => {
  const selections = [
    { actionKind: 'implement' }, { actionKind: 'debug' }, { actionKind: 'plan' },
    { actionKind: 'design' }, { actionKind: 'review_engineering' },
    { actionKind: 'review_contract', riskTier: 'T3', shapes: ['security'] },
    { actionKind: 'implement', repeatedFailure: true },
    { actionKind: 'implement', complexity: 'routine-batch' },
  ].map((input) => resolveCodexModelPolicy(input).reasoning);
  assert.ok(selections.includes('high'));
  const policy = resolveCodexModelPolicy({ actionKind: 'implement', userRequested: { reasoning: 'max' } });
  assert.equal(policy.reasoning, 'max');
  assert.ok(policy.reasons.includes('user-requested-reasoning'));
});

test('the gpt-5.6 alias resolves to an explicit Sol id and gpt-6 to Astra for reproducibility', () => {
  assert.equal(resolveCodexModelAlias('gpt-5.6'), CODEX_MODELS.sol);
  assert.equal(resolveCodexModelAlias('gpt-5.6-terra'), CODEX_MODELS.terra);
  assert.equal(resolveCodexModelAlias('gpt-6'), CODEX_MODELS.astra);
  assert.equal(resolveCodexModelAlias('gpt-6-astra'), CODEX_MODELS.astra);
  const solPolicy = resolveCodexModelPolicy({ userRequested: { model: 'gpt-5.6' } });
  assert.equal(solPolicy.model, CODEX_MODELS.sol);
  const astraPolicy = resolveCodexModelPolicy({ userRequested: { model: 'gpt-6' } });
  assert.equal(astraPolicy.model, CODEX_MODELS.astra);
});


test('Codex capability delta is Host-owned and does not duplicate model or completion policy', () => {
  const delta = resolveCodexCapabilityDelta({
    capabilities: { supportsSessionContinuation: true },
  });
  assert.deepEqual(delta.autonomy, { mode: 'bounded', delegation: 'contract-gated' });
  assert.deepEqual(delta.persistence, { mode: 'session-continuation', source: 'host-capability' });
  assert.deepEqual(delta.repositoryInvestigation, { mode: 'bounded', boundary: 'work-unit-scope' });
  assert.equal(delta.toolUse.source, 'tool-manifest');
  assert.deepEqual(delta.effort, { source: 'execution-class-policy' });
  assert.deepEqual(delta.progress, { owner: 'execution-host', promptDirective: false });
  assert.equal('model' in delta, false);
  assert.equal('completionCondition' in delta, false);
});

test('Codex capability delta defaults to turn-local persistence without declared Host support', () => {
  const delta = resolveCodexCapabilityDelta({
    capabilities: { supportsSessionContinuation: 'yes' },
  });
  assert.equal(delta.persistence.mode, 'turn-local');
});
