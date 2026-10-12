import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFuturesBoundedRestoreWorkUnit,
  planReplacementSteps,
} from '../src/kernel/run/step-planner.js';
import {
  canReuseEvidence,
  normalizeEvidenceIdentity,
} from '../src/kernel/proof/evidence-reuse.js';

const identity = (sourceInputDigest: string) => normalizeEvidenceIdentity({
  commandDigest: 'sha256:command',
  verifierVersion: 'kernel-proof-v1',
  sourceInputDigest,
  artifactDigest: 'sha256:artifact',
  fixtureDigest: 'sha256:fixture',
  environmentFingerprint: 'sha256:environment',
  verificationScopeDigest: 'sha256:scope',
});

test('C15: reviewed Yellow candidate becomes one bounded replacement Work Unit with fresh regression requirements', () => {
  const restore = buildFuturesBoundedRestoreWorkUnit({
    candidate: {
      kind: 'bounded-restore',
      allowedPaths: ['src/auth/service.ts', 'tests/auth.test.ts'],
    },
    sourceMutationRevision: 12,
    behaviorInvariants: ['expired tokens stay rejected'],
    regressionObligationIds: ['verify-auth-regression'],
    acceptanceIds: ['AC-auth'],
  });

  assert.equal(restore.kind, 'bounded-restore-work-unit');
  assert.deepEqual(restore.replacementStep.allowedPaths, [
    'src/auth/service.ts',
    'tests/auth.test.ts',
  ]);
  assert.deepEqual(restore.behaviorInvariants, ['expired tokens stay rejected']);
  assert.deepEqual(restore.stopConditions, [
    'scope-violation',
    'behavior-invariant-changed',
    'fresh-regression-proof-failed',
  ]);
  assert.deepEqual(restore.proofPolicy, {
    requiresFreshRegression: true,
    minimumMutationRevisionExclusive: 12,
    priorRevisionEvidenceAllowed: false,
  });

  const [step] = planReplacementSteps({
    run: { runId: 'run-restore', objective: 'Preserve auth behavior' },
    planRevision: 2,
    deltaSteps: [restore.replacementStep],
  });
  assert.equal(step.planRevision, 2);
  assert.equal(step.state, 'ready');
  assert.deepEqual(step.allowedPaths, restore.replacementStep.allowedPaths);
  assert.deepEqual(step.obligationIds, ['verify-auth-regression']);
});

test('C15: unbounded or escaping restore scopes fail closed instead of becoming rollback authority', () => {
  for (const allowedPaths of [['**'], ['../outside']]) {
    assert.throws(() => buildFuturesBoundedRestoreWorkUnit({
      candidate: { kind: 'bounded-restore', allowedPaths },
      sourceMutationRevision: 1,
      behaviorInvariants: ['behavior preserved'],
      regressionObligationIds: ['verify-regression'],
    }), (error: unknown) => {
      assert.ok(error instanceof Error);
      const code = error && typeof error === 'object' && 'code' in error
        ? String(error.code)
        : '';
      assert.ok([
        'work-unit-scope-unbounded',
        'contract-path-invalid',
      ].includes(code));
      return true;
    });
  }
});

test('C15: proof identity from before the restore cannot be reused after source input changes', () => {
  const before = identity('sha256:before');
  const after = identity('sha256:after');
  assert.equal(canReuseEvidence({
    previous: {
      status: 'passed',
      evidenceDigest: 'sha256:proof',
      evidenceIdentity: before,
    },
    current: after,
  }), false);
  assert.equal(canReuseEvidence({
    previous: {
      status: 'passed',
      evidenceDigest: 'sha256:proof',
      evidenceIdentity: after,
    },
    current: after,
  }), true);
});
