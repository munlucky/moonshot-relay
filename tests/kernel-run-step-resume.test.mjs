// K2-4: the cursor is state. A process that dies mid-plan is replaced by one
// that resumes at the next unfinished step, with the attempt history intact.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createKernelControlPlane } from '../scripts/kernel/control-plane.mjs';
import { openKernelStateStore } from '../scripts/kernel/state-store.mjs';

const CONTRACT = {
  complex: true,
  riskTier: 'T2',
  acceptance: [
    { acceptance: 'auth rejects expired tokens', evidencePlan: { class: 'hard', method: 'unit-test', commandRefs: ['test:ok'], obligationId: 'auth-work' } },
    { acceptance: 'the suite stays clean', evidencePlan: { class: 'hard', method: 'static-analysis', commandRefs: ['lint'], obligationId: 'tests-work' } },
  ],
  steps: [
    { objective: 'Implement token expiry', allowedPaths: ['src/auth/**'], acceptanceIds: ['AC-1'], obligationIds: ['auth-work'] },
    { objective: 'Cover it with a regression test', allowedPaths: ['tests/**'], acceptanceIds: ['AC-2'], obligationIds: ['tests-work'] },
  ],
};

const setup = async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'krn-resume-home-'));
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'krn-resume-proj-'));
  spawnSync('git', ['init'], { cwd: projectRoot, encoding: 'utf8' });
  await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({
    name: 'resume-fixture', version: '0.0.1', scripts: { 'test:ok': 'node -e "process.exit(0)"', lint: 'node -e "process.exit(0)"' },
  }, null, 2));
  await mkdir(path.join(projectRoot, 'src', 'auth'), { recursive: true });
  await mkdir(path.join(projectRoot, 'tests'), { recursive: true });
  await writeFile(path.join(projectRoot, 'src', 'auth', 'service.mjs'), 'export const v = 0;\n');
  await writeFile(path.join(projectRoot, 'tests', 'auth.test.mjs'), 'export const t = 0;\n');
  spawnSync('git', ['add', '--all'], { cwd: projectRoot, encoding: 'utf8' });
  spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-m', 'fixture', '--quiet'], { cwd: projectRoot, encoding: 'utf8' });
  return { runtimeHome, projectRoot };
};

const cleanup = async ({ runtimeHome, projectRoot }) => {
  await rm(runtimeHome, { recursive: true, force: true });
  await rm(projectRoot, { recursive: true, force: true });
};

test('K2-4: a fresh process resumes at the step after the last passed one', async () => {
  const fixture = await setup();
  let stepIds;
  const first = await createKernelControlPlane(fixture);
  try {
    await first.startRun({ runId: 'r-resume', objective: 'Harden auth', taskContract: CONTRACT });
    stepIds = first.getRunSteps('r-resume').map((step) => step.stepId);
    await writeFile(path.join(fixture.projectRoot, 'src', 'auth', 'service.mjs'), 'export const v = 1;\n');
    const reported = await first.report('r-resume', {
      summary: 'token expiry',
      stepId: stepIds[0],
      changedPaths: ['src/auth/service.mjs'],
      verifications: [{ obligationId: 'auth-work', commandRef: 'test:ok', acceptanceCoverage: ['AC-1'] }],
    });
    assert.equal(reported.step.state, 'passed');
  } finally {
    await first.close();
  }

  // The process is gone; nothing is carried over but SQLite.
  const second = await createKernelControlPlane(fixture);
  try {
    const current = second.getCurrentStep('r-resume');
    assert.equal(current.stepId, stepIds[1], 'resume lands on the next unfinished unit');
    assert.equal(current.state, 'ready');

    const next = await second.next('r-resume');
    assert.equal(next.action.step.stepId, stepIds[1]);
    assert.deepEqual(next.action.step.allowedPaths, ['tests/**']);

    const resumed = await second.resume('r-resume');
    assert.equal(resumed.status, 'resumed');
    assert.equal(resumed.next.action.step.stepId, stepIds[1]);

    // The first step's attempt history survived the process boundary.
    const store = await openKernelStateStore({ runtimeHome: fixture.runtimeHome });
    try {
      const attempts = store.getStepAttempts('r-resume', { stepId: stepIds[0] });
      assert.equal(attempts.length, 1);
      assert.equal(attempts[0].status, 'passed');
      assert.equal(attempts[0].attemptNumber, 1);
      assert.deepEqual(attempts[0].changedPaths, ['src/auth/service.mjs']);
      assert.match(attempts[0].resultDigest, /^sha256:[a-f0-9]{64}$/);
      assert.ok(attempts[0].workspaceIdentityEnd);
    } finally {
      store.close();
    }
  } finally {
    await second.close();
    await cleanup(fixture);
  }
});

test('K2: per-step attempt numbers keep counting across processes', async () => {
  const fixture = await setup();
  const first = await createKernelControlPlane(fixture);
  let stepId;
  try {
    await first.startRun({ runId: 'r-attempts', objective: 'Harden auth', taskContract: CONTRACT });
    stepId = first.getRunSteps('r-attempts')[0].stepId;
    await writeFile(path.join(fixture.projectRoot, 'src', 'auth', 'service.mjs'), 'export const v = 1;\n');
    // A failing attempt on the first unit.
    const failed = await first.report('r-attempts', {
      summary: 'missing coverage',
      stepId,
      changedPaths: ['src/auth/service.mjs'],
      verifications: [{ obligationId: 'auth-work', commandRef: 'test:ok' }],
    });
    assert.equal(failed.step.state, 'failed', 'the unit did not cover its acceptance');
    assert.deepEqual(failed.step.reasons, ['acceptance-uncovered:AC-1']);
  } finally {
    await first.close();
  }

  const second = await createKernelControlPlane(fixture);
  try {
    assert.equal(second.getCurrentStep('r-attempts').stepId, stepId, 'a failed step stays the current unit');
    await writeFile(path.join(fixture.projectRoot, 'src', 'auth', 'service.mjs'), 'export const v = 2;\n');
    const retried = await second.report('r-attempts', {
      summary: 'now with coverage',
      stepId,
      changedPaths: ['src/auth/service.mjs'],
      verifications: [{ obligationId: 'auth-work', commandRef: 'test:ok', acceptanceCoverage: ['AC-1'] }],
    });
    assert.equal(retried.step.state, 'passed');

    const store = await openKernelStateStore({ runtimeHome: fixture.runtimeHome });
    try {
      const attempts = store.getStepAttempts('r-attempts', { stepId });
      assert.deepEqual(attempts.map((attempt) => attempt.attemptNumber), [1, 2]);
      assert.deepEqual(attempts.map((attempt) => attempt.status), ['failed', 'passed']);
      assert.deepEqual(attempts[0].failureReasons, ['acceptance-uncovered:AC-1']);
    } finally {
      store.close();
    }
  } finally {
    await second.close();
    await cleanup(fixture);
  }
});
