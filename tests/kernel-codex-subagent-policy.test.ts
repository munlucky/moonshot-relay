import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveCodexSubagentPolicy, SUBAGENT_SUITABLE, SUBAGENT_UNSUITABLE } from '../src/host/kernel/codex-model-policy.js';

test('subagents are denied by default', () => {
  const policy = resolveCodexSubagentPolicy({});
  assert.equal(policy.allowSubagents, false);
  assert.equal(policy.maxSubagents, 0);
});

test('a suitable shape still needs contract approval', () => {
  const policy = resolveCodexSubagentPolicy({ workShape: 'large-codebase-exploration', capsuleAllowsDelegation: false });
  assert.equal(policy.allowSubagents, false);
  assert.equal(policy.reason, 'contract-not-approved');
});

test('approval plus a genuinely splittable shape allows exactly one subagent', () => {
  for (const workShape of SUBAGENT_SUITABLE) {
    const policy = resolveCodexSubagentPolicy({ workShape, capsuleAllowsDelegation: true });
    assert.equal(policy.allowSubagents, true, workShape);
    assert.equal(policy.maxSubagents, 1);
  }
});

test('conflicting or sequential work is refused even with approval', () => {
  for (const workShape of SUBAGENT_UNSUITABLE) {
    const policy = resolveCodexSubagentPolicy({ workShape, capsuleAllowsDelegation: true });
    assert.equal(policy.allowSubagents, false, workShape);
    assert.equal(policy.reason, 'work-shape-unsuitable');
  }
});

test('Ultra stays off and is never a completion condition', () => {
  const policy = resolveCodexSubagentPolicy({ workShape: 'large-codebase-exploration', capsuleAllowsDelegation: true });
  assert.equal(policy.allowUltra, false);
  assert.equal(policy.ultraRequiresContractApproval, true);
});
