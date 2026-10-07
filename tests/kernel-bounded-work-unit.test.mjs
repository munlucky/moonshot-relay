import { prepareTestHostTurn } from './helpers/kernel-host-test-api.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createKernelControlPlane } from '../scripts/kernel/control-plane.mjs';
import { openSqliteDb } from '../scripts/kernel/sqlite-adapter.mjs';

const HOST = {
  surface: 'claude',
  supportsSubagentModel: true,
  supportsIndependentContext: true,
  supportsUsageTokens: true,
  supportsResolvedModelIdentity: true,
};

const setup = async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'krn-bounded-home-'));
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'krn-bounded-proj-'));
  spawnSync('git', ['init'], { cwd: projectRoot, encoding: 'utf8' });
  await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({
    name: 'bounded-work-unit-fixture',
    version: '0.0.1',
    scripts: { 'test:ok': 'node -e "process.exit(0)"' },
  }));
  await writeFile(path.join(projectRoot, 'app.mjs'), 'export const value = 0;\n');
  return { runtimeHome, projectRoot };
};

const cleanup = async ({ runtimeHome, projectRoot }) => {
  await rm(runtimeHome, { recursive: true, force: true });
  await rm(projectRoot, { recursive: true, force: true });
};

const structuredAcceptance = () => Array.from({ length: 10 }, (_, index) => ({
  acceptance: `criterion-${index + 1}`,
  evidencePlan: {
    class: 'hard',
    method: 'unit-test',
    commandRefs: ['test:ok'],
    obligationId: `criterion-${index + 1}`,
  },
}));

const broadContract = (allowedPaths) => ({
  strictBoundedScope: true,
  acceptance: structuredAcceptance(),
  ...(allowedPaths === undefined ? {} : { allowedPaths }),
});

const assertNoDispatchState = async (cp, runId, run = null) => {
  if (run?.workspaceId) assert.equal(cp.stateStore.getWorkspaceMutationLockV2(run.workspaceId), null);
  assert.equal(cp.stateStore.getRun(runId), null);
  assert.deepEqual(cp.stateStore.listModelRouteDecisions(runId), []);
  assert.deepEqual(cp.listRouteAdmissions(runId), []);
  assert.deepEqual(cp.stateStore.listExecutionCapsules(runId), []);
  assert.deepEqual(cp.stateStore.getStepAttempts(runId), []);
  const raw = await openSqliteDb(cp.stateStore.dbPath);
  try {
    assert.equal(raw.prepare('SELECT COUNT(*) AS count FROM worktree_mutation_leases WHERE holder_run_id=?').get(runId).count, 0);
    assert.equal(raw.prepare('SELECT COUNT(*) AS count FROM workspace_mutation_locks_v2 WHERE holder_run_id=?').get(runId).count, 0);
  } finally {
    raw.close();
  }
};

test('control-plane rejects an unbounded implementation before any dispatch state is created', async () => {
  const fixture = await setup();
  const cp = await createKernelControlPlane(fixture);
  try {
    const cases = [
      { runId: 'r-missing', taskContract: broadContract(), errorCode: 'work-unit-scope-missing' },
      { runId: 'r-empty', taskContract: broadContract([]), errorCode: 'work-unit-scope-missing' },
      { runId: 'r-globstar', taskContract: broadContract(['**']), errorCode: 'work-unit-scope-unbounded' },
      { runId: 'r-star', taskContract: broadContract(['*']), errorCode: 'work-unit-scope-unbounded' },
    ];

    for (const entry of cases) {
      await assert.rejects(
        cp.startRun({ runId: entry.runId, objective: 'bounded implementation', taskContract: entry.taskContract }),
        (error) => error.errorCode === entry.errorCode,
      );
      await assertNoDispatchState(cp, entry.runId);
    }

    await assert.rejects(
      cp.ensureRun({
        runId: 'r-ensure',
        objective: 'bounded implementation',
        taskContract: broadContract(['**']),
      }),
      (error) => error.errorCode === 'work-unit-scope-unbounded',
    );
    await assertNoDispatchState(cp, 'r-ensure');
  } finally {
    await cp.close();
    await cleanup(fixture);
  }
});

test('contract preflight admits missing verification commands at start but rejects incomplete detailed step bindings before Run creation', async () => {
  const fixture = await setup();
  const cp = await createKernelControlPlane(fixture);
  try {
    const started = await cp.startRun({
      runId: 'r-missing-command',
      objective: 'bounded implementation',
      taskContract: {
        acceptance: [{
          acceptance: 'the change is tested',
          evidencePlan: { class: 'hard', method: 'unit-test', commandRefs: ['test:missing'], obligationId: 'unit-test' },
        }],
        allowedPaths: ['app.mjs'],
      },
    });
    assert.equal(started.runId, 'r-missing-command');
    await cp.abandonRun('r-missing-command');

    await assert.rejects(
      cp.startRun({
        runId: 'r-missing-output',
        objective: 'detailed bounded implementation',
        taskContract: {
          behaviorChanging: true,
          acceptance: structuredAcceptance().slice(0, 2),
          steps: [
            { objective: 'change', allowedPaths: ['app.mjs'], acceptanceIds: ['AC-1'], obligationIds: ['criterion-1'], expectedOutputs: [] },
            { objective: 'verify', allowedPaths: ['tests/**'], acceptanceIds: ['AC-2'], obligationIds: ['criterion-2'], expectedOutputs: [] },
          ],
        },
      }),
      (error) => error.errorCode === 'contract-step-binding-invalid'
        && error.details?.field === 'expectedOutputs',
    );
    await assertNoDispatchState(cp, 'r-missing-output');
  } finally {
    await cp.close();
    await cleanup(fixture);
  }
});

test('a scoped implementation is still admitted by the control plane', async () => {
  const fixture = await setup();
  const cp = await createKernelControlPlane(fixture);
  try {
    await cp.startRun({
      runId: 'r-scoped',
      objective: 'bounded implementation',
      taskContract: broadContract(['src/**']),
    });
    const host = await prepareTestHostTurn(cp, 'r-scoped', { hostCapabilities: HOST });

    assert.equal(host.modelInput.action.type, 'implement');
    assert.deepEqual(host.executionCapsule.workUnit.allowedPaths, ['src/**']);
    assert.ok(host.hostDirective.mutationLock);
    assert.equal(cp.stateStore.listModelRouteDecisions('r-scoped').length, 1);
    assert.equal(cp.stateStore.listExecutionCapsules('r-scoped').length, 1);
    assert.equal(cp.stateStore.getStepAttempts('r-scoped').length, 1);
  } finally {
    await cp.close();
    await cleanup(fixture);
  }
});

test('reviewer/read-only turns remain allowed without an implementation scope', async () => {
  const fixture = await setup();
  const cp = await createKernelControlPlane(fixture);
  try {
    await cp.startRun({
      runId: 'r-review',
      objective: 'review the workspace',
      taskContract: { allowedPaths: [] },
    });
    const review = await prepareTestHostTurn(cp, 'r-review', {
      hostCapabilities: HOST,
      actionContext: { actionKind: 'review_engineering' },
    });

    assert.equal(review.status, undefined);
    assert.equal(review.hostDirective.modelRouteDecision.role, 'reviewer');
    assert.equal(review.hostDirective.modelRouteDecision.permissions, 'read_only');
    assert.equal(review.executionCapsule.role, 'reviewer');
    assert.equal(review.executionCapsule.permissions.filesystem, 'read_only');
  } finally {
    await cp.close();
    await cleanup(fixture);
  }
});

test('strictBoundedScope rejects empty allowedPaths on declared steps', async () => {
  const fixture = await setup();
  const cp = await createKernelControlPlane(fixture);
  try {
    await assert.rejects(
      () => cp.startRun({
        runId: 'r-step-strict',
        objective: 'strict step test',
        taskContract: {
          strictBoundedScope: true,
          allowedPaths: ['src/app.mjs'],
          steps: [
            { stepId: 's1', sequence: 1, allowedPaths: [] },
          ],
        },
      }),
      (err) => err.errorCode === 'work-unit-scope-missing' || err.message?.includes('work-unit-scope-missing'),
    );
  } finally {
    await cp.close();
    await cleanup(fixture);
  }
});

test('replaceRunPlan clears both blocked_reason and blocking_class upon unblocking', async () => {
  const fixture = await setup();
  const cp = await createKernelControlPlane(fixture);
  try {
    const runId = 'r-unblock-replan';
    await cp.startRun({
      runId,
      objective: 'unblock replan test',
      taskContract: { allowedPaths: ['src/app.mjs'] },
    });
    cp.stateStore.markRunBlocked(runId, 'preflight_failed', 'safety');
    const blockedRun = cp.stateStore.getRun(runId);
    assert.equal(blockedRun.status, 'blocked');
    assert.equal(blockedRun.blockedReason, 'preflight_failed');
    assert.equal(blockedRun.blockingClass, 'safety');

    cp.stateStore.replaceRunPlanAtomic(runId, {
      currentPlanRevision: blockedRun.planRevision,
      nextPlanRevision: blockedRun.planRevision + 1,
      steps: [{ stepId: 'step-new-1', sequence: 1, objective: 'fixed step' }],
      resumeBlockedReason: 'preflight_failed',
    });

    const unblockedRun = cp.stateStore.getRun(runId);
    assert.equal(unblockedRun.status, 'active');
    assert.equal(unblockedRun.blockedReason, null);
    assert.equal(unblockedRun.blockingClass, null);
  } finally {
    await cp.close();
    await cleanup(fixture);
  }
});
