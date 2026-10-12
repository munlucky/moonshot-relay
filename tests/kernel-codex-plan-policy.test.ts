import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveCodexPlanPolicy } from '../src/host/kernel/codex-model-policy.js';

test('a simple edit executes without a plan profile', () => {
  const policy = resolveCodexPlanPolicy({ actionKind: 'implement', complexity: 'simple' });
  assert.equal(policy.usePlanProfile, false);
  assert.equal(policy.profile, 'default');
});

test('the plan profile is selected only when the Kernel action is plan', () => {
  assert.equal(resolveCodexPlanPolicy({ actionKind: 'plan' }).profile, 'plan');
  assert.equal(resolveCodexPlanPolicy({ actionKind: 'implement' }).profile, 'default');
  assert.equal(resolveCodexPlanPolicy({ actionKind: 'debug' }).profile, 'default');
});

test('complex, ambiguous, multi-step, and approach-comparison work plans first', () => {
  for (const complexity of ['complex', 'ambiguous', 'multi-step', 'approach-comparison']) {
    assert.equal(resolveCodexPlanPolicy({ actionKind: 'implement', complexity }).usePlanProfile, true, complexity);
  }
});

test('a risky change plans even when it looks simple', () => {
  for (const shape of ['security', 'migration', 'data-loss']) {
    assert.equal(resolveCodexPlanPolicy({ actionKind: 'implement', complexity: 'simple', shapes: [shape] }).usePlanProfile, true, shape);
  }
});
