import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadModelPolicy, parseModelPolicyText, requiresProviderModel } from '../src/kernel/run/model-route-contract.js';
import { ACTION_KINDS, EXECUTION_CLASSES } from '../src/contracts/model-route.js';
import { resolveModelRoute } from '../src/host/kernel/model-routing.js';

test('canonical model policy declares exactly four provider-neutral execution classes', () => {
  const policy = loadModelPolicy();
  assert.equal(policy.schemaVersion, 1);
  assert.equal(policy.policyRevision, 'kernel-model-routing.v1');
  assert.deepEqual([...EXECUTION_CLASSES], ['planning', 'complex_implementation', 'review', 'standard']);
  assert.deepEqual(Object.keys(policy.executionClasses).sort(), [...EXECUTION_CLASSES].sort());
  assert.equal(requiresProviderModel('planning'), true);
  assert.equal(requiresProviderModel('complex_implementation'), true);
  assert.equal(requiresProviderModel('review'), true);
  assert.equal(requiresProviderModel('standard'), true);
  assert.equal(requiresProviderModel('kernel'), false);
  assert.deepEqual(Object.keys(policy.modelClasses).sort(), ['frontier_reasoning', 'kernel', 'value_coding']);
  for (const action of ACTION_KINDS) assert.ok(policy.actionDefaults[action], action);
});

test('policy is provider-neutral: no provider model id appears in the canonical file', () => {
  const policy = loadModelPolicy();
  const text = JSON.stringify(policy);
  assert.doesNotMatch(text, /gpt-|claude-|gemini|o[34]-mini|anthropic|openai/i);
});

test('a malformed or incomplete policy fails closed', () => {
  assert.throws(() => parseModelPolicyText('schemaVersion: 2\npolicyRevision: x\n'), /schemaVersion must be 1/);
  assert.throws(
    () => parseModelPolicyText('schemaVersion: 1\npolicyRevision: x\nthresholds:\n  retryEscalationThreshold: 2\n  stagnationThreshold: 3\nmodelClasses:\n  kernel:\n    providerModelRequired: false\nactionDefaults:\n  plan:\n    modelClass: frontier_reasoning\n    role: planner\n    permissions: plan_write\n'),
    /has no default for action/,
  );
  assert.throws(() => parseModelPolicyText('schemaVersion: 1\nunknownField: 1\n'), /Unknown field/);
});

test('action defaults route work to execution classes and proof to the Kernel', () => {
  const frontier = ['understand', 'design', 'plan', 'replan', 'review_contract', 'review_engineering'];
  for (const action of frontier) {
    const decision = resolveModelRoute({ runId: 'r', actionKind: action });
    assert.equal(decision.executionClass, action.startsWith('review') ? 'review' : 'planning', action);
    assert.equal(decision.modelClass, 'frontier_reasoning', action);
  }
  for (const action of ['implement', 'debug']) {
    const decision = resolveModelRoute({ runId: 'r', actionKind: action });
    assert.equal(decision.executionClass, 'standard', action);
    assert.equal(decision.modelClass, 'value_coding', action);
  }
  for (const action of ['prove', 'close']) {
    const decision = resolveModelRoute({ runId: 'r', actionKind: action });
    assert.equal(decision.executionClass, null);
    assert.equal(decision.modelClass, 'kernel');
    assert.equal(requiresProviderModel(decision.modelClass), false);
    assert.deepEqual([...decision.reasonCodes], ['KERNEL_ONLY_ACTION']);
  }
});

test('complex implementation is an explicit workload class, not a score or provider name', () => {
  const decision = resolveModelRoute({ runId: 'r-complex', actionKind: 'implement', executionClass: 'complex_implementation' });
  assert.equal(decision.executionClass, 'complex_implementation');
  assert.equal(decision.modelClass, 'frontier_reasoning');
  assert.throws(() => Reflect.apply(resolveModelRoute, undefined, [{ runId: 'r-invalid', actionKind: 'implement', executionClass: 'ultrabrain' }]), /executionClass must be one of/);
});

test('reviews demand read-only permissions and implementation demands workspace write', () => {
  assert.equal(resolveModelRoute({ runId: 'r', actionKind: 'review_engineering' }).permissions, 'read_only');
  assert.equal(resolveModelRoute({ runId: 'r', actionKind: 'implement' }).permissions, 'workspace_write');
  assert.equal(resolveModelRoute({ runId: 'r', actionKind: 'plan' }).permissions, 'plan_write');
  assert.equal(resolveModelRoute({ runId: 'r', actionKind: 'prove' }).permissions, 'kernel_runtime');
});
