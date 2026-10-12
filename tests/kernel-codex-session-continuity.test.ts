import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveSessionLineage } from '../src/host/kernel/session-affinity.js';
import { buildCodexInvocation, CODEX_CAPABILITIES } from '../src/host/kernel/adapters/codex.js';

const identity = (overrides = {}) => ({
  provider: 'codex',
  surface: 'codex',
  resolvedModel: 'gpt-5.6-terra',
  resolvedEffort: 'medium',
  speedMode: 'standard',
  role: 'implementer',
  toolSchemaDigest: 'sha256:tools',
  commonHostStableDigest: 'sha256:common',
  providerStableDigest: 'sha256:provider',
  projectStableDigest: 'sha256:project',
  runStableDigest: 'sha256:run',
  ...overrides,
});

test('Codex declares session continuation as its cache mechanism', () => {
  assert.equal(CODEX_CAPABILITIES.supportsSessionContinuation, true);
  assert.equal(CODEX_CAPABILITIES.supportsExplicitCacheBreakpoints, false);
});

test('the same work unit at the same model, effort, and digests continues', () => {
  const lineage = resolveSessionLineage({ previous: { ...identity(), sessionLineageId: 'lineage-1' }, current: identity() });
  assert.equal(lineage.continued, true);
});

test('every declared change starts a new lineage with a named reason', () => {
  const previous = { ...identity(), sessionLineageId: 'lineage-1' };
  const cases = [
    [identity({ role: 'planner' }), 'role-changed'],
    [identity({ resolvedModel: 'gpt-5.6-sol' }), 'model-changed'],
    [identity({ resolvedEffort: 'high' }), 'effort-changed'],
    [identity({ speedMode: 'fast' }), 'speed-mode-changed'],
    [identity({ providerStableDigest: 'sha256:provider-2' }), 'provider-stable-changed'],
    [identity({ projectStableDigest: 'sha256:project-2' }), 'project-stable-changed'],
    [identity({ runStableDigest: 'sha256:run-2' }), 'run-stable-changed'],
    [identity({ toolSchemaDigest: 'sha256:tools-2' }), 'tool-schema-changed'],
  ] as const;
  for (const [current, reason] of cases) {
    const lineage = resolveSessionLineage({ previous, current });
    assert.equal(lineage.continued, false, reason);
    assert.ok(lineage.resetReasons.includes(reason), `expected ${reason}, got ${lineage.resetReasons}`);
  }
});

test('several simultaneous changes are all reported, not just the first', () => {
  const lineage = resolveSessionLineage({
    previous: { ...identity(), sessionLineageId: 'lineage-1' },
    current: identity({ resolvedModel: 'gpt-5.6-sol', resolvedEffort: 'high', runStableDigest: 'sha256:run-2' }),
  });
  assert.deepEqual([...lineage.resetReasons], ['effort-changed', 'model-changed', 'run-stable-changed']);
});

test('a reviewer invocation always demands a fresh Codex session', () => {
  const invocation = buildCodexInvocation({
    decision: { role: 'reviewer', permissions: 'read_only', modelClass: 'frontier_reasoning' },
    resolution: { model: 'gpt-5.6-sol', effort: 'xhigh' },
    capabilities: CODEX_CAPABILITIES,
  });
  assert.equal(invocation.freshSessionRequired, true);
  assert.equal(invocation.sandbox, 'read-only');
});
