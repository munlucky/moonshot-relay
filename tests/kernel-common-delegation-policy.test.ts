import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveDelegationPolicy, DEFAULT_MAX_NESTED_AGENTS, STRUCTURED_OUTPUT_FIELDS, resolveCommonModelPolicy,
} from '../src/host/kernel/common-model-policy.js';

test('delegation is denied by default', () => {
  assert.equal(DEFAULT_MAX_NESTED_AGENTS, 0);
  const policy = resolveDelegationPolicy({});
  assert.equal(policy.allowNestedDelegation, false);
  assert.equal(policy.maxNestedAgents, 0);
});

test('every gate must pass before a single nested agent is allowed', () => {
  const gates = { capsuleAllowsDelegation: true, independentWork: true, disjointPaths: true, parallelBenefit: true };
  assert.equal(resolveDelegationPolicy(gates).maxNestedAgents, 1);
  for (const gate of Object.keys(gates)) {
    const denied = resolveDelegationPolicy({ ...gates, [gate]: false });
    assert.equal(denied.allowNestedDelegation, false, `a failed gate must deny delegation: ${gate}`);
  }
});

test('the capsule alone does not authorize delegation for conflicting work', () => {
  const policy = resolveDelegationPolicy({ capsuleAllowsDelegation: true, independentWork: true, disjointPaths: false, parallelBenefit: true });
  assert.equal(policy.allowNestedDelegation, false);
});

test('the model never spawns its own reviewer', () => {
  const policy = resolveDelegationPolicy({ capsuleAllowsDelegation: true, independentWork: true, disjointPaths: true, parallelBenefit: true });
  assert.equal(policy.reviewerSpawnedByModel, false);
  assert.equal(policy.reviewerOwnedByHost, true);
});

test('each role has a structured output contract', () => {
  assert.deepEqual([...STRUCTURED_OUTPUT_FIELDS.planner], ['plan', 'assumptions', 'risks', 'requiredEvidence']);
  assert.deepEqual([...STRUCTURED_OUTPUT_FIELDS.implementer], ['changedFiles', 'behaviorChanges', 'checks', 'blockers']);
  assert.deepEqual([...STRUCTURED_OUTPUT_FIELDS.reviewer], ['verdict', 'findings', 'evidenceRefs', 'reviewedRevision']);
});

test('the combined policy resolves plan, verification, and delegation together', () => {
  const policy = resolveCommonModelPolicy({ role: 'implementer', riskTier: 'T1', complexity: 'simple' });
  assert.equal(policy.plan.mode, 'none');
  assert.equal(policy.delegation.maxNestedAgents, 0);
  assert.ok(policy.structuredOutput);
  assert.deepEqual([...policy.structuredOutput], [...STRUCTURED_OUTPUT_FIELDS.implementer]);
});
