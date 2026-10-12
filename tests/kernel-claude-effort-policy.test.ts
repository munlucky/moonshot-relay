import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveClaudeEffort, CLAUDE_ACTION_EFFORT, CLAUDE_EFFORTS } from '../src/host/kernel/claude-effort-policy.js';
import { CLAUDE_PROVIDER_PROMPT } from '../src/host/kernel/prompts/claude-opus-5.js';

test('the initial action table matches the declared policy', () => {
  assert.deepEqual({ ...CLAUDE_ACTION_EFFORT }, {
    understand: 'high',
    design: 'high',
    plan: 'high',
    implement: 'high',
    debug: 'high',
    review_contract: 'medium',
    review_engineering: 'medium',
    replan: 'high',
  });
});

test('routine review stays at medium', () => {
  assert.equal(resolveClaudeEffort({ actionKind: 'review_engineering', riskTier: 'T1' }).effort, 'medium');
});

test('a protected or T3 review escalates to high', () => {
  for (const shape of ['security', 'authentication', 'authorization', 'payment', 'migration', 'data-loss', 'irreversible', 'protected-obligation']) {
    assert.equal(resolveClaudeEffort({ actionKind: 'review_contract', shapes: [shape] }).effort, 'high', shape);
  }
  assert.equal(resolveClaudeEffort({ actionKind: 'review_engineering', riskTier: 'T3' }).effort, 'high');
});

test('declared triggers reach xhigh and record why', () => {
  for (const trigger of ['large-multi-file-implementation', 'broad-refactor', 'repeated-failure', 'architecture-replan', 'complex-t3-change', 'user-requested']) {
    const resolved = resolveClaudeEffort({ actionKind: 'implement', triggers: [trigger] });
    assert.equal(resolved.effort, 'xhigh', trigger);
    assert.ok(resolved.reasons.includes(trigger));
  }
});

test('an undeclared trigger does not escalate', () => {
  assert.equal(resolveClaudeEffort({ actionKind: 'implement', triggers: ['feels-hard'] }).effort, 'high');
});

test('an explicit user effort wins and is attributed', () => {
  const resolved = resolveClaudeEffort({ actionKind: 'implement', userRequestedEffort: 'low' });
  assert.equal(resolved.effort, 'low');
  assert.ok(resolved.reasons.includes('user-requested'));
  assert.equal(Reflect.apply(resolveClaudeEffort, undefined, [{ actionKind: 'implement', userRequestedEffort: 'turbo' }]).effort, 'high');
});

test('the resolved effort never leaks into the prompt text', () => {
  for (const effort of CLAUDE_EFFORTS) {
    assert.ok(!CLAUDE_PROVIDER_PROMPT.includes(`effort: ${effort}`));
  }
  assert.doesNotMatch(CLAUDE_PROVIDER_PROMPT, /reasoning_effort/);
});
