import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSessionAffinityKey, SESSION_KEY_FIELDS } from '../src/host/kernel/session-affinity.js';

const identity = (overrides = {}) => ({
  ...Object.fromEntries(SESSION_KEY_FIELDS.map((field) => [field, `${field}-value`])),
  ...overrides,
});

test('the key is composed of exactly the declared fields', () => {
  assert.deepEqual([...SESSION_KEY_FIELDS], [
    'provider', 'surface', 'resolvedModel', 'resolvedEffort', 'speedMode', 'role',
    'toolSchemaDigest', 'commonHostStableDigest', 'providerStableDigest',
    'projectStableDigest', 'runStableDigest',
  ]);
});

test('every declared field changes the key', () => {
  const base = buildSessionAffinityKey(identity());
  for (const field of SESSION_KEY_FIELDS) {
    assert.notEqual(base, buildSessionAffinityKey(identity({ [field]: 'changed' })), `${field} does not participate in the key`);
  }
});

test('undeclared fields do not change the key', () => {
  const base = buildSessionAffinityKey(identity());
  assert.equal(base, buildSessionAffinityKey(identity({ runId: 'run-9', stepId: 'step-9', capsuleId: 'c-9', timestamp: 'now' })));
});

test('the key is stable and shaped for a receipt column', () => {
  assert.equal(buildSessionAffinityKey(identity()), buildSessionAffinityKey(identity()));
  assert.match(buildSessionAffinityKey(identity()), /^session-[a-f0-9]{32}$/);
});

test('a missing field is treated as null rather than throwing', () => {
  assert.match(buildSessionAffinityKey({}), /^session-[a-f0-9]{32}$/);
  assert.equal(buildSessionAffinityKey({}), buildSessionAffinityKey({ provider: null, role: null }));
});
