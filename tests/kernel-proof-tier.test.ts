import assert from 'node:assert/strict';
import { test } from 'node:test';
import { selectProofTier, evidenceTierForProof } from '../src/kernel/proof-route.js';
import { classifyRisk } from '../src/kernel/route.js';

test('documentation-only change is T0 while security is hard-floor T3', () => {
  assert.equal(selectProofTier({ behaviorChanging: false }), 'T0');
  assert.equal(selectProofTier({ requestedTier: 'T0', surfaces: ['security_boundary'] }), 'T3');
  assert.equal(evidenceTierForProof('T3'), 'E2');
});

test('route and proof-route share risk surface vocabulary with per-surface floors', () => {
  const t3Surfaces = ['security_boundary', 'data_migration', 'runtime_authority', 'destructive_schema_change', 'installer'];
  for (const surf of t3Surfaces) {
    assert.equal(classifyRisk({ surfaces: [surf] }), 'T3', `classifyRisk should return T3 for ${surf}`);
    assert.equal(selectProofTier({ surfaces: [surf] }), 'T3', `selectProofTier should return T3 for ${surf}`);
  }

  const t2Surfaces = ['public_contract', 'schema_change'];
  for (const surf of t2Surfaces) {
    assert.equal(classifyRisk({ surfaces: [surf] }), 'T2', `classifyRisk should return T2 for ${surf}`);
    assert.equal(selectProofTier({ surfaces: [surf] }), 'T2', `selectProofTier should return T2 for ${surf}`);
  }
});

test('tier floors only raise, never lower, a requested tier', () => {
  assert.equal(selectProofTier({ requestedTier: 'T3', surfaces: ['public_contract'] }), 'T3');
  assert.equal(selectProofTier({ requestedTier: 'T1', surfaces: ['public_contract'] }), 'T2');
});

test('file count and task duration do not escalate semantic proof tier', () => {
  assert.equal(classifyRisk({ taskClass: 'long-running', filesChanged: 100 }), 'T0');
  const durationMetadata = { requestedTier: 'T0', taskClass: 'long-running', filesChanged: 100 };
  const countMetadata = { requestedTier: 'T0', filesChanged: 100 };
  assert.equal(selectProofTier(durationMetadata), 'T0');
  assert.equal(selectProofTier(countMetadata), 'T0');
});
