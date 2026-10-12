import { prepareTestHostTurn } from './helpers/kernel-host-test-api.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createKernelControlPlane } from '../src/host/kernel/control-plane-runtime.js';
import { openSqliteDb } from '../src/kernel/sqlite-adapter.js';

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

const cleanup = async ({ runtimeHome, projectRoot }: { runtimeHome: string; projectRoot: string }) => {
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

const broadContract = (allowedPaths?: string[]) => ({
  strictBoundedScope: true,
  acceptance: structuredAcceptance(),
  ...(allowedPaths === undefined ? {} : { allowedPaths }),
});

const assertNoDispatchState = async (cp: KernelControlPlane, runId: string, run: Awaited<ReturnType<KernelControlPlane['getRun']>> = null) => {
  if (run?.workspaceId) assert.equal(cp.stateStore.getWorkspaceMutationLockV2(run.workspaceId), null);
  assert.equal(cp.stateStore.getRun(runId), null);
  assert.deepEqual(cp.stateStore.listModelRouteDecisions(runId), []);
  assert.deepEqual(cp.listRouteAdmissions(runId), []);
  assert.deepEqual(cp.stateStore.listExecutionCapsules(runId), []);
  assert.deepEqual(cp.stateStore.getStepAttempts(runId), []);
  const raw = await openSqliteDb(cp.stateStore.dbPath);
  try {
    const observedValue1 = raw.prepare('SELECT COUNT(*) AS count FROM worktree_mutation_leases WHERE holder_run_id=?').get(runId);
    assert.ok(observedValue1 && typeof observedValue1 === 'object');
    assert.ok(observedValue1 && typeof observedValue1 === 'object' && 'count' in observedValue1);
    assert.equal(observedValue1.count, 0);
    const observedValue2 = raw.prepare('SELECT COUNT(*) AS count FROM workspace_mutation_locks_v2 WHERE holder_run_id=?').get(runId);
    assert.ok(observedValue2 && typeof observedValue2 === 'object');
    assert.ok(observedValue2 && typeof observedValue2 === 'object' && 'count' in observedValue2);
    assert.equal(observedValue2.count, 0);
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
        (error) => { assert.ok(error && typeof error === 'object'); assert.ok(error && typeof error === 'object' && 'errorCode' in error);
        return error.errorCode === entry.errorCode; },
      );
      await assertNoDispatchState(cp, entry.runId);
    }

    await assert.rejects(
      cp.ensureRun({
        runId: 'r-ensure',
        objective: 'bounded implementation',
        taskContract: broadContract(['**']),
      }),
      (error) => { assert.ok(error && typeof error === 'object'); assert.ok(error && typeof error === 'object' && 'errorCode' in error);
      return error.errorCode === 'work-unit-scope-unbounded'; },
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
      (error) => { assert.ok(error && typeof error === 'object');
      assert.ok(error && typeof error === 'object' && 'errorCode' in error);
      assert.ok(error && typeof error === 'object' && 'details' in error);
      assert.ok(error.details && typeof error.details === 'object' && 'field' in error.details);
      return error.errorCode === 'contract-step-binding-invalid'
        && error.details?.field === 'expectedOutputs'; },
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

    assert.ok(host && typeof host === 'object' && 'modelInput' in host);
    assert.ok(host.modelInput && typeof host.modelInput === 'object' && 'action' in host.modelInput);
    assert.ok(host.modelInput.action && typeof host.modelInput.action === 'object');
    assert.ok(host.modelInput.action && typeof host.modelInput.action === 'object' && 'type' in host.modelInput.action);
    assert.equal(host.modelInput.action.type, 'implement');
    assert.ok(host && typeof host === 'object' && 'executionCapsule' in host);
    assert.ok(host.executionCapsule && typeof host.executionCapsule === 'object' && 'workUnit' in host.executionCapsule);
    assert.ok(host.executionCapsule.workUnit && typeof host.executionCapsule.workUnit === 'object');
    assert.ok(host.executionCapsule.workUnit && typeof host.executionCapsule.workUnit === 'object' && 'allowedPaths' in host.executionCapsule.workUnit);
    assert.deepEqual(host.executionCapsule.workUnit.allowedPaths, ['src/**']);
    assert.ok(host && typeof host === 'object' && 'hostDirective' in host);
    assert.ok(host.hostDirective && typeof host.hostDirective === 'object' && 'mutationLock' in host.hostDirective);
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

    assert.equal(Reflect.get(review, 'status'), undefined);
    assert.ok(review && typeof review === 'object' && 'hostDirective' in review);
    assert.ok(review.hostDirective && typeof review.hostDirective === 'object' && 'modelRouteDecision' in review.hostDirective);
    assert.ok(review.hostDirective.modelRouteDecision && typeof review.hostDirective.modelRouteDecision === 'object');
    assert.ok(review.hostDirective.modelRouteDecision && typeof review.hostDirective.modelRouteDecision === 'object' && 'role' in review.hostDirective.modelRouteDecision);
    assert.equal(review.hostDirective.modelRouteDecision.role, 'reviewer');
    assert.ok(review && typeof review === 'object' && 'hostDirective' in review);
    assert.ok(review.hostDirective && typeof review.hostDirective === 'object' && 'modelRouteDecision' in review.hostDirective);
    assert.ok(review.hostDirective.modelRouteDecision && typeof review.hostDirective.modelRouteDecision === 'object');
    assert.ok(review.hostDirective.modelRouteDecision && typeof review.hostDirective.modelRouteDecision === 'object' && 'permissions' in review.hostDirective.modelRouteDecision);
    assert.equal(review.hostDirective.modelRouteDecision.permissions, 'read_only');
    assert.ok(review && typeof review === 'object' && 'executionCapsule' in review);
    assert.ok(review.executionCapsule && typeof review.executionCapsule === 'object' && 'role' in review.executionCapsule);
    assert.equal(review.executionCapsule.role, 'reviewer');
    assert.ok(review && typeof review === 'object' && 'executionCapsule' in review);
    assert.ok(review.executionCapsule && typeof review.executionCapsule === 'object' && 'permissions' in review.executionCapsule);
    assert.ok(review.executionCapsule.permissions && typeof review.executionCapsule.permissions === 'object');
    assert.ok(review.executionCapsule.permissions && typeof review.executionCapsule.permissions === 'object' && 'filesystem' in review.executionCapsule.permissions);
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
      (err) => { assert.ok(err && typeof err === 'object'); assert.ok(err && typeof err === 'object' && 'errorCode' in err);
      assert.ok(err && typeof err === 'object' && 'message' in err);
      assert.ok(typeof err.message === 'string');
      return err.errorCode === 'work-unit-scope-missing' || err.message?.includes('work-unit-scope-missing'); },
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
    assert.ok(blockedRun && typeof blockedRun === 'object' && 'status' in blockedRun);
    assert.equal(blockedRun.status, 'blocked');
    assert.ok(blockedRun && typeof blockedRun === 'object' && 'blockedReason' in blockedRun);
    assert.equal(blockedRun.blockedReason, 'preflight_failed');
    assert.ok(blockedRun && typeof blockedRun === 'object' && 'blockingClass' in blockedRun);
    assert.equal(blockedRun.blockingClass, 'safety');

    assert.ok(blockedRun && typeof blockedRun === 'object' && 'planRevision' in blockedRun);
    cp.stateStore.replaceRunPlanAtomic(runId, {
      currentPlanRevision: blockedRun.planRevision,
      nextPlanRevision: blockedRun.planRevision + 1,
      steps: [{ stepId: 'step-new-1', sequence: 1, objective: 'fixed step', planRevision: blockedRun.planRevision + 1, state: 'ready' }],
      resumeBlockedReason: 'preflight_failed',
    });

    const unblockedRun = cp.stateStore.getRun(runId);
    assert.ok(unblockedRun && typeof unblockedRun === 'object' && 'status' in unblockedRun);
    assert.equal(unblockedRun.status, 'active');
    assert.ok(unblockedRun && typeof unblockedRun === 'object' && 'blockedReason' in unblockedRun);
    assert.equal(unblockedRun.blockedReason, null);
    assert.ok(unblockedRun && typeof unblockedRun === 'object' && 'blockingClass' in unblockedRun);
    assert.equal(unblockedRun.blockingClass, null);
  } finally {
    await cp.close();
    await cleanup(fixture);
  }
});

type KernelControlPlane = Awaited<ReturnType<typeof createKernelControlPlane>>;
