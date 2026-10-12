import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSessionAffinityKey, resolveSessionLineage } from '../src/host/kernel/session-affinity.js';

const identity = (overrides = {}) => ({
  provider: 'claude',
  surface: 'claude',
  resolvedModel: 'model-a',
  resolvedEffort: 'high',
  speedMode: 'standard',
  role: 'implementer',
  toolSchemaDigest: 'sha256:tools',
  commonHostStableDigest: 'sha256:common',
  providerStableDigest: 'sha256:provider',
  projectStableDigest: 'sha256:project',
  runStableDigest: 'sha256:run',
  ...overrides,
});

test('analysis, implementation, test, and fix on one work unit share a session', () => {
  const previous = { ...identity(), sessionLineageId: 'lineage-1' };
  for (let turn = 0; turn < 4; turn += 1) {
    const lineage = resolveSessionLineage({ previous, current: identity() });
    assert.equal(lineage.continued, true);
    assert.equal(lineage.sessionLineageId, 'lineage-1');
    assert.deepEqual([...lineage.resetReasons], []);
  }
});

test('the first turn of a run has no previous session to continue', () => {
  const lineage = resolveSessionLineage({ previous: null, current: identity() });
  assert.equal(lineage.continued, false);
  assert.equal(lineage.sessionLineageId, buildSessionAffinityKey(identity()));
});

test('the key ignores nothing that matters and includes nothing that does not', () => {
  const input = { ...identity(), runId: 'run-9', stepId: 'step-9' };
  assert.equal(buildSessionAffinityKey(identity()), buildSessionAffinityKey(input));
  assert.notEqual(buildSessionAffinityKey(identity()), buildSessionAffinityKey(identity({ resolvedEffort: 'xhigh' })));
});

test('a reviewer turn never continues the implementer session', () => {
  const previous = { ...identity(), sessionLineageId: 'lineage-1' };
  const lineage = resolveSessionLineage({ previous, current: identity({ role: 'reviewer' }), role: 'reviewer' });
  assert.equal(lineage.continued, false);
  assert.ok(lineage.resetReasons.includes('reviewer-turn'));
  assert.ok(lineage.resetReasons.includes('role-changed'));
});

test('an explicit reset ends the lineage even when nothing else changed', () => {
  const previous = { ...identity(), sessionLineageId: 'lineage-1' };
  const lineage = resolveSessionLineage({ previous, current: identity(), explicitReset: true });
  assert.equal(lineage.continued, false);
  assert.deepEqual([...lineage.resetReasons], ['explicit-reset']);
  // Regression: a forced reset with an unchanged affinity key must not reuse
  // the previous lineage id, or a consumer keyed by lineage id would treat
  // two genuinely distinct sessions as one continuing session.
  assert.notEqual(lineage.sessionLineageId, 'lineage-1');
});

test('two consecutive forced resets with an identical identity each get a distinct lineage id', () => {
  // Two reviewer turns back to back never continue each other, but nothing
  // in their SESSION_KEY_FIELDS differs between them (role is 'reviewer'
  // both times) — the case the mint-on-forced-reset path exists for.
  const reviewerIdentity = identity({ role: 'reviewer' });
  const first = resolveSessionLineage({ previous: null, current: reviewerIdentity, role: 'reviewer' });
  const second = resolveSessionLineage({
    previous: { ...reviewerIdentity, sessionLineageId: first.sessionLineageId },
    current: reviewerIdentity,
    role: 'reviewer',
  });
  assert.equal(second.continued, false);
  assert.notEqual(second.sessionLineageId, first.sessionLineageId);
  assert.equal(second.sessionAffinityKey, first.sessionAffinityKey, 'the identity fingerprint is unchanged even though the instance is not');
});
