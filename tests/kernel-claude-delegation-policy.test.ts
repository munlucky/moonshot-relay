import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveClaudeCapabilityDelta, resolveClaudeDelegation, CLAUDE_DELEGATION_DEFAULTS } from '../src/host/kernel/claude-effort-policy.js';
import { buildClaudeInvocation, CLAUDE_AGENT_FOR_ROLE } from '../src/host/kernel/adapters/claude.js';

test('every Claude role defaults to zero nested agents', () => {
  for (const role of ['planner', 'implementer', 'reviewer']) {
    assert.equal(CLAUDE_DELEGATION_DEFAULTS[role].maxNestedAgents, 0);
    assert.equal(resolveClaudeDelegation(role).maxNestedAgents, 0);
  }
});

test('an unknown role still resolves to zero rather than undefined', () => {
  assert.equal(resolveClaudeDelegation('mystery').maxNestedAgents, 0);
});

test('the reviewer runs in a fresh Host-created context, not inside the implementer', () => {
  const invocation = buildClaudeInvocation({
    decision: { role: 'reviewer', permissions: 'read_only', independentContextRequired: true },
    resolution: { model: 'model-a', effort: 'medium' },
  });
  assert.equal(invocation.subagent, CLAUDE_AGENT_FOR_ROLE.reviewer);
  assert.equal(invocation.freshContext, true);
  assert.equal(invocation.independentSessionRequired, true);
  assert.equal(invocation.readOnly, true);
});

test('a routine implementer turn keeps its context so the prefix stays warm', () => {
  const invocation = buildClaudeInvocation({
    decision: { role: 'implementer', permissions: 'workspace_write', independentContextRequired: false },
    resolution: { model: 'model-a', effort: 'high' },
  });
  assert.equal(invocation.freshContext, false);
  assert.equal(invocation.independentSessionRequired, false);
});


test('Claude capability delta never enables an always-on nested agent', () => {
  for (const role of ['planner', 'implementer', 'reviewer', 'mystery']) {
    const delegation = resolveClaudeCapabilityDelta({ role }).delegation;
    assert.equal(delegation.maxNestedAgents, 0);
    assert.equal(delegation.alwaysOn, false);
    assert.equal(delegation.owner, 'host');
  }
});
