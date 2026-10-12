import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveSessionLineage, LINEAGE_RESET_REASONS, SESSION_KEY_FIELDS } from '../src/host/kernel/session-affinity.js';

const identity = (overrides = {}) => ({
  ...Object.fromEntries(SESSION_KEY_FIELDS.map((field) => [field, `${field}-value`])),
  role: 'implementer',
  ...overrides,
});

test('the reset vocabulary is closed', () => {
  assert.equal(new Set(LINEAGE_RESET_REASONS).size, LINEAGE_RESET_REASONS.length);
  for (const reason of ['role-changed', 'model-changed', 'effort-changed', 'speed-mode-changed', 'reviewer-turn', 'explicit-reset']) {
    assert.ok(LINEAGE_RESET_REASONS.includes(reason), reason);
  }
});

test('a continued lineage keeps the previous id, not a fresh one', () => {
  const lineage = resolveSessionLineage({ previous: { ...identity(), sessionLineageId: 'lineage-original' }, current: identity() });
  assert.equal(lineage.sessionLineageId, 'lineage-original');
  assert.equal(lineage.continued, true);
});

test('a reset produces a new lineage id derived from the new identity', () => {
  const current = identity({ resolvedEffort: 'xhigh' });
  const lineage = resolveSessionLineage({ previous: { ...identity(), sessionLineageId: 'lineage-original' }, current });
  assert.notEqual(lineage.sessionLineageId, 'lineage-original');
  assert.equal(lineage.sessionLineageId, lineage.sessionAffinityKey);
});

test('every session-key field has its own reset reason, not just the original eight', () => {
  // Regression: provider, surface, and commonHostStableDigest changed the
  // affinity key without ever appearing in resetReasons, so a provider switch
  // or a common-prompt revision looked like a continued session.
  const previous = { ...identity(), sessionLineageId: 'lineage-1' };
  const cases = [
    [identity({ provider: 'codex' }), 'provider-changed'],
    [identity({ surface: 'codex-cloud' }), 'surface-changed'],
    [identity({ commonHostStableDigest: 'sha256:common-2' }), 'common-host-stable-changed'],
  ] as const;
  for (const [current, reason] of cases) {
    const lineage = resolveSessionLineage({ previous, current });
    assert.equal(lineage.continued, false, reason);
    assert.ok(lineage.resetReasons.includes(reason), `expected ${reason}, got ${lineage.resetReasons}`);
  }
});

test('every reported reason comes from the closed vocabulary', () => {
  const lineage = resolveSessionLineage({
    previous: { ...identity(), sessionLineageId: 'lineage-1' },
    current: identity({ role: 'reviewer', resolvedModel: 'other' }),
    role: 'reviewer',
    independentContextRequired: true,
    explicitReset: true,
  });
  for (const reason of lineage.resetReasons) assert.ok(LINEAGE_RESET_REASONS.includes(reason), reason);
  assert.ok(lineage.resetReasons.includes('independent-context-required'));
});

test('reset reasons are sorted and deduplicated for stable receipts', () => {
  const lineage = resolveSessionLineage({
    previous: { ...identity(), sessionLineageId: 'lineage-1' },
    current: identity({ role: 'reviewer' }),
    role: 'reviewer',
  });
  assert.deepEqual([...lineage.resetReasons], [...lineage.resetReasons].sort());
  assert.equal(new Set(lineage.resetReasons).size, lineage.resetReasons.length);
});
