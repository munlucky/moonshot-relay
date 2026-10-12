// Parallel execution is a derived view of the Step Ledger. There is no
// persisted approval, batch, integration lifecycle, or compatibility mode.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deriveParallelBatch, scopesOverlap, selectExecutableSteps } from '../src/kernel/run/run-step-ledger.js';
import { deriveParallelAdmission, hostSupportsParallel } from '../src/host/kernel/parallel-dispatcher.js';

type RunStep = NonNullable<Parameters<typeof selectExecutableSteps>[0]>[number];
const step = (sequence: number, allowedPaths: string[], overrides: Partial<RunStep> = {}): RunStep => ({
  stepId: `step-1-${sequence}`,
  sequence,
  state: 'ready',
  planRevision: 1,
  dependencyIds: [],
  allowedPaths,
  obligationIds: ['unit-test'],
  ...overrides,
});

const HOST = {
  supportsConcurrentSessions: true,
  supportsIsolatedWorkingDirectory: true,
  supportsPerSessionEnvironment: true,
};

test('K2: sequential selection remains the default', () => {
  const steps = [step(1, ['src/auth/**']), step(2, ['src/billing/**'])];
  const selected = selectExecutableSteps(steps, { planRevision: 1 });
  assert.deepEqual(selected.steps.map((entry) => entry.stepId), ['step-1-1']);
  assert.equal(selected.reason, 'sequential');
});

test('K2: disjoint ready Steps form a transient derived parallel selection', () => {
  const steps = [step(1, ['src/auth/**']), step(2, ['src/billing/**']), step(3, ['docs/**'])];
  const selected = deriveParallelBatch(steps, { planRevision: 1, maxWorkers: 2 });
  assert.deepEqual(selected.steps.map((entry) => entry.stepId), ['step-1-1', 'step-1-2']);
  assert.equal(selected.reason, 'parallel');
  assert.equal(Object.hasOwn(selected, 'batchId'), false);
});

test('K2: dependencies and write conflicts are derived from current Step rows', () => {
  const steps = [
    step(1, ['src/auth/**']),
    step(2, ['src/billing/**'], { dependencyIds: ['step-1-1'] }),
    step(3, ['docs/**']),
  ];
  const selected = deriveParallelBatch(steps, { planRevision: 1, maxWorkers: 3 });
  assert.deepEqual(selected.steps.map((entry) => entry.stepId), ['step-1-1', 'step-1-3']);

  const conflict = deriveParallelBatch([
    step(1, ['src/auth/**']),
    step(2, ['src/auth/tokens/**']),
  ], { planRevision: 1, maxWorkers: 2 });
  assert.deepEqual(conflict.steps.map((entry) => entry.stepId), ['step-1-1']);
  assert.equal(conflict.reason, 'parallel-scope-conflict');

  const unbounded = deriveParallelBatch([step(1, []), step(2, ['src/billing/**'])], { planRevision: 1, maxWorkers: 2 });
  assert.deepEqual(unbounded.steps.map((entry) => entry.stepId), ['step-1-1']);
  assert.equal(unbounded.reason, 'parallel-scope-conflict');
});

test('K2: scope matching keeps separator and case semantics without a lifecycle reason', () => {
  assert.equal(scopesOverlap('src/Auth/**', 'src/auth/**'), true);
  assert.equal(scopesOverlap('SRC/auth', 'src/auth/service.mjs'), true);
  assert.equal(scopesOverlap(String.raw`src\auth\**`, 'src/auth/**'), true);
  assert.equal(scopesOverlap('src/auth/**', 'src/billing/**'), false);
  assert.equal(scopesOverlap('src/auth/**', ''), true);
});

test('Host admission derives a transient integration check from current contract facts', () => {
  const run = {
    projectId: 'fixture',
    status: 'active',
    proofTier: 'T2',
    taskContract: {
      acceptance: [{ evidencePlan: { commandRefs: ['test:integration'] } }],
    },
  };
  const admitted = deriveParallelAdmission({
    run,
    steps: [step(1, ['src/auth/**']), step(2, ['src/billing/**'])],
    commands: [{ commandRef: 'test:integration' }],
    hostCapabilities: HOST,
    git: { ready: true },
  });
  assert.equal(admitted.admitted, true);
  assert.equal(admitted.workerLimit, 2);
  assert.deepEqual(admitted.integrationVerification, { commandRef: 'test:integration' });

  const blocked = deriveParallelAdmission({
    run,
    steps: [step(1, ['src/**']), step(2, ['src/billing/**'])],
    commands: [{ commandRef: 'test:integration' }],
    hostCapabilities: HOST,
    git: { ready: true },
  });
  assert.equal(blocked.admitted, false);
  assert.equal(blocked.reasons.includes('write-scope-overlap'), true);
  assert.equal(hostSupportsParallel(HOST), true);
});
