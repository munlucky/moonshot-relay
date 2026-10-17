import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveOptimizationModes } from '../src/host/kernel/provider-prompt-policy.js';
import { resolveCodexModelPolicy } from '../src/host/kernel/codex-model-policy.js';
import { resolveClaudeEffort } from '../src/host/kernel/claude-effort-policy.js';

// In shadow the Host still resolves a recommended model and effort so the
// replay corpus can compare them against what actually ran; it just does not
// apply them. The recommendation must therefore be computable without any
// mode-dependent branching.

test('the model policy mode is its own switch', () => {
  const modes = resolveOptimizationModes({ MOON_RELAY_KERNEL_MODEL_POLICY_MODE: 'on', MOON_RELAY_KERNEL_CACHE_MODE: 'off' });
  assert.equal(modes.modelPolicyMode, 'on');
  assert.equal(modes.cacheMode, 'off');
});

test('Codex has an isolated final-profile switch with generic fallback', () => {
  assert.equal(resolveOptimizationModes({}).codexModelPolicyMode, 'on');
  assert.equal(resolveOptimizationModes({ MOON_RELAY_KERNEL_MODEL_POLICY_MODE: 'shadow' }).codexModelPolicyMode, 'shadow');
  assert.equal(resolveOptimizationModes({ MOON_RELAY_KERNEL_MODEL_POLICY_MODE: 'on', MOON_RELAY_KERNEL_CODEX_MODEL_POLICY_MODE: 'off' }).codexModelPolicyMode, 'off');
});

test('a recommendation is produced regardless of the active mode', () => {
  for (const mode of ['off', 'shadow', 'on']) {
    resolveOptimizationModes({ MOON_RELAY_KERNEL_MODEL_POLICY_MODE: mode });
    const codex = resolveCodexModelPolicy({ actionKind: 'implement' });
    const claude = resolveClaudeEffort({ actionKind: 'implement' });
    assert.equal(codex.model, 'gpt-5.6-luna');
    assert.equal(codex.reasoning, 'high');
    assert.equal(claude.effort, 'high');
  }
});

test('the recommendation is deterministic for identical input', () => {
  const input = { actionKind: 'review_engineering', riskTier: 'T3', shapes: ['security'] };
  assert.deepEqual(resolveCodexModelPolicy(input), resolveCodexModelPolicy(input));
  assert.deepEqual(resolveClaudeEffort(input), resolveClaudeEffort(input));
});

test('every routing decision carries the reasons that produced it', () => {
  const input = { executionClass: 'standard', repeatedFailure: true };
  const standard = resolveCodexModelPolicy(input);
  assert.ok(standard.reasons.includes('execution-class:standard'));
  assert.equal(standard.policyRevision, 'kernel-codex-execution-class.v2');
  const claude = resolveClaudeEffort({ actionKind: 'implement', triggers: ['broad-refactor'] });
  assert.ok(claude.reasons.includes('broad-refactor'));
  assert.equal(claude.policyRevision, 'kernel-claude-effort.v1');
});
