import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createKernelControlPlane } from '../src/host/kernel/control-plane-runtime.js';
import { CODEX_EXECUTION_POLICY, resolveCodexModelPolicy } from '../src/host/kernel/codex-model-policy.js';
import { cleanupWindowsTimeoutProcessTree } from '../src/host/kernel/proof/process-tree.js';
import { openSqliteDb } from '../src/kernel/sqlite-adapter.js';

const safeCleanup = async (...dirs: string[]) => {
  for (const dir of dirs) {
    if (!dir) continue;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await rm(dir, { recursive: true, force: true });
        break;
      } catch (err) {
        assert.ok(err && typeof err === 'object' && 'code' in err);
        if (err.code === 'EBUSY' && attempt < 4) {
          await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
          continue;
        }
        assert.ok(err && typeof err === 'object' && 'code' in err);
        if (err.code !== 'EBUSY') throw err;
      }
    }
  }
};

const setupProject = async (name = 'golden-e2e') => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), `krn-${name}-proj-`));
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), `krn-${name}-state-`));
  spawnSync('git', ['init'], { cwd: projectRoot, encoding: 'utf8' });
  spawnSync('git', ['config', 'user.email', 'kernel@example.invalid'], { cwd: projectRoot, encoding: 'utf8' });
  spawnSync('git', ['config', 'user.name', 'Kernel Golden Test'], { cwd: projectRoot, encoding: 'utf8' });

  await mkdir(path.join(projectRoot, '.moon-relay'), { recursive: true });
  await writeFile(path.join(projectRoot, '.moon-relay', 'track.yaml'), 'schemaVersion: 1\ntrack: kernel\nproduct: moon-relay-kernel\n');
  await writeFile(path.join(projectRoot, '.moon-relay', 'project.identity.yaml'), `projectId: ${name}\n`);
  await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({
    name,
    version: '0.0.1',
    scripts: {
      'test:step1': 'node -e "process.exit(0)"',
      'test:step2': 'node -e "process.exit(0)"',
      'test:hang': 'node -e "setTimeout(() => {}, 60000)"',
    },
  }, null, 2));
  spawnSync('git', ['add', '.'], { cwd: projectRoot, encoding: 'utf8' });
  spawnSync('git', ['commit', '-m', 'initial commit'], { cwd: projectRoot, encoding: 'utf8' });

  return { projectRoot, runtimeHome, projectId: name };
};

test('Golden E2E: distinct goal does not adopt stale blocked run in worktree', async () => {
  const fixture = await setupProject('golden-stale-isolation');
  const sessionId = 'codex:session-1';
  let cp = null;
  try {
    cp = await createKernelControlPlane({
      runtimeHome: fixture.runtimeHome,
      projectRoot: fixture.projectRoot,
      env: {
        MOON_RELAY_KERNEL_SESSION_ID: sessionId,
        MOON_RELAY_KERNEL_PROVIDER: 'codex',
      },
    });

    // 1. Create a previous run that gets blocked
    const run1 = await cp.ensureRun({
      runId: 'run-prior-blocked',
      objective: 'Old completely different task that got blocked',
      taskContract: {
        objective: 'Old completely different task that got blocked',
        acceptance: ['Old requirement A'],
      },
    });
    assert.ok(['created', 'resumed'].includes(run1.status));

    // Report a blocker so run becomes blocked
    await cp.reportUnderLease('run-prior-blocked', {
      blocker: { reason: 'external-dependency', detail: 'Waiting for external fix' },
    }, { fencingToken: 1 });

    const store = cp.stateStore;
    const priorRun = store.getRun('run-prior-blocked');
    assert.ok(priorRun && typeof priorRun === 'object' && 'status' in priorRun);
    assert.equal(priorRun.status, 'blocked');

    // Simulate stale unleased historical run
    const raw = await openSqliteDb(store.dbPath);
    assert.ok(priorRun && typeof priorRun === 'object' && 'worktreeId' in priorRun);
    raw.prepare('DELETE FROM worktree_mutation_leases WHERE worktree_id=?').run(priorRun.worktreeId);
    raw.close();

    // 2. Incoming new task with distinct goal identity should NOT adopt the stale blocked run
    const resolved = cp.resolveBoundInvocation({
      taskContract: {
        objective: 'New independent feature goal',
        acceptance: ['New feature requirement X'],
      },
      sessionId: 'codex:session-2',
    });

    // Fresh run is created, not revising or colliding with old run
    assert.equal(resolved.mode, 'create');
    assert.notEqual(resolved.runId, 'run-prior-blocked');
  } finally {
    if (cp) await cp.close().catch(() => {});
    await safeCleanup(fixture.projectRoot, fixture.runtimeHome);
  }
});

test('Golden E2E: multi-step plan preserved, step 1 continues to step 2, and goal reaches completion', async () => {
  const fixture = await setupProject('golden-multi-step');
  const sessionId = 'codex:session-golden';
  const runId = 'run-golden-lifecycle';
  let cp = null;
  try {
    cp = await createKernelControlPlane({
      runtimeHome: fixture.runtimeHome,
      projectRoot: fixture.projectRoot,
      env: {
        MOON_RELAY_KERNEL_SESSION_ID: sessionId,
        MOON_RELAY_KERNEL_PROVIDER: 'codex',
        MOON_RELAY_KERNEL_RUN_ID: runId,
      },
    });

    // Step-planned task contract with 2 steps
    const contract = {
      objective: 'Implement end-to-end two-step feature',
      taskClass: 'feature',
      allowedPaths: ['src'],
      acceptance: [
        { id: 'AC-1', statement: 'Step 1 service implemented', evidencePlan: { class: 'hard', commandRefs: ['test:step1'] } },
        { id: 'AC-2', statement: 'Step 2 router implemented', evidencePlan: { class: 'hard', commandRefs: ['test:step2'] } },
      ],
      steps: [
        {
          stepId: 'step-1-service',
          objective: 'Implement service layer',
          allowedPaths: ['src/service.mjs'],
          acceptanceIds: ['AC-1'],
        },
        {
          stepId: 'step-2-router',
          objective: 'Implement router layer',
          allowedPaths: ['src/router.mjs'],
          acceptanceIds: ['AC-2'],
        },
      ],
    };

    // 1. Ensure run with contract before mutating files
    const ensured = await cp.ensureRun({ runId, objective: contract.objective, taskContract: contract });
    assert.ok(ensured.run);
    assert.ok(ensured && typeof ensured === 'object' && 'run' in ensured);
    assert.ok(ensured.run);
    assert.ok(ensured && typeof ensured === 'object' && 'run' in ensured);
    assert.ok(ensured.run);
    assert.ok(ensured && typeof ensured === 'object' && 'run' in ensured);
    assert.ok(ensured.run);
    assert.ok(ensured && typeof ensured === 'object' && 'run' in ensured);
    assert.ok(ensured.run.taskContract !== null && ensured.run.taskContract !== undefined);
    assert.ok(ensured.run.taskContract.steps !== null && ensured.run.taskContract.steps !== undefined);
    assert.equal(ensured.run.taskContract.steps.length, 2);

    // Initial action should be implement step 1
    const next1 = await cp.next(runId);
    assert.ok(next1 && typeof next1 === 'object' && 'action' in next1);
    assert.ok(next1.action !== null && next1.action !== undefined);
    assert.equal(next1.action.type, 'implement');
    assert.ok(next1 && typeof next1 === 'object' && 'workAuthority' in next1);
    assert.ok(next1.workAuthority !== null && next1.workAuthority !== undefined);
    assert.equal(next1.workAuthority.goalStatus, 'active');
    assert.ok(next1 && typeof next1 === 'object' && 'workAuthority' in next1);
    assert.ok(next1.workAuthority !== null && next1.workAuthority !== undefined);
    assert.ok(next1.workAuthority.currentWorkUnit !== null && next1.workAuthority.currentWorkUnit !== undefined);
    assert.equal(next1.workAuthority.currentWorkUnit.stepId, 'step-1-service');

    // Now implement Step 1
    await mkdir(path.join(fixture.projectRoot, 'src'), { recursive: true });
    await writeFile(path.join(fixture.projectRoot, 'src', 'service.mjs'), 'export const service = 1;\n');

    // 2. Report Step 1 completion
    const report1 = await cp.report(runId, {
      stepId: 'step-1-service',
      summary: 'Implemented service.mjs',
      changedPaths: ['src/service.mjs'],
      verifications: [{ commandRef: 'test:step1' }],
    });

    assert.ok(report1 && typeof report1 === 'object' && 'workUnitStatus' in report1);
    assert.equal(report1.workUnitStatus, 'complete');
    assert.ok(report1 && typeof report1 === 'object' && 'goalStatus' in report1);
    assert.equal(report1.goalStatus, 'active');
    assert.ok(report1 && typeof report1 === 'object' && 'continuation' in report1);
    assert.ok(report1.continuation && typeof report1.continuation === 'object' && 'action' in report1.continuation);
    assert.equal(report1.continuation.action, 'implement');
    assert.ok(report1 && typeof report1 === 'object' && 'continuation' in report1);
    assert.ok(report1.continuation && typeof report1.continuation === 'object' && 'stepId' in report1.continuation);
    assert.equal(report1.continuation.stepId, 'step-2-router');

    // After Step 1, next() must NOT be done! It must implement step 2
    const next2 = await cp.next(runId);
    assert.ok(next2 && typeof next2 === 'object' && 'action' in next2);
    assert.ok(next2.action !== null && next2.action !== undefined);
    assert.notEqual(next2.action.type, 'done');
    assert.ok(next2 && typeof next2 === 'object' && 'action' in next2);
    assert.ok(next2.action !== null && next2.action !== undefined);
    assert.equal(next2.action.type, 'implement');
    assert.ok(next2 && typeof next2 === 'object' && 'workAuthority' in next2);
    assert.ok(next2.workAuthority !== null && next2.workAuthority !== undefined);
    assert.equal(next2.workAuthority.goalStatus, 'active');
    assert.ok(next2 && typeof next2 === 'object' && 'workAuthority' in next2);
    assert.ok(next2.workAuthority !== null && next2.workAuthority !== undefined);
    assert.ok(next2.workAuthority.currentWorkUnit !== null && next2.workAuthority.currentWorkUnit !== undefined);
    assert.equal(next2.workAuthority.currentWorkUnit.stepId, 'step-2-router');

    // Drop the entire owner context. A new process/session has only the
    // durable Run handle, and must recover the same cursor without transcript.
    const durableBeforeRestart = cp.stateStore.getKernelDurableState(runId);
    const journalBeforeRestart = cp.stateStore.getRunJournal(runId);
    await cp.close();
    cp = await createKernelControlPlane({
      runtimeHome: fixture.runtimeHome, projectRoot: fixture.projectRoot,
      env: { MOON_RELAY_KERNEL_PROVIDER: 'codex', MOON_RELAY_KERNEL_SESSION_ID: 'codex:new-context', MOON_RELAY_KERNEL_RUN_ID: runId },
    });
    const recovered = await cp.next(runId);
    assert.ok(recovered && typeof recovered === 'object' && 'action' in recovered);
    assert.ok(recovered.action && typeof recovered.action === 'object' && 'step' in recovered.action);
    assert.ok(recovered.action.step && typeof recovered.action.step === 'object');
    assert.ok(recovered.action.step && typeof recovered.action.step === 'object' && 'stepId' in recovered.action.step);
    assert.equal(recovered.action.step.stepId, 'step-2-router');
    assert.ok(recovered && typeof recovered === 'object' && 'workAuthority' in recovered);
    assert.ok(recovered.workAuthority !== null && recovered.workAuthority !== undefined);
    assert.ok(recovered.workAuthority.progress !== null && recovered.workAuthority.progress !== undefined);
    assert.deepEqual(recovered.workAuthority.progress.completedWorkUnitIds, ['step-1-service']);
    assert.ok(durableBeforeRestart && typeof durableBeforeRestart === 'object' && 'work' in durableBeforeRestart);
    const observedValue6 = cp.stateStore.getKernelDurableState(runId);
    assert.ok(observedValue6);
    assert.equal(observedValue6.work.planRevision, durableBeforeRestart.work.planRevision);
    assert.deepEqual(cp.stateStore.getRunJournal(runId), journalBeforeRestart);

    // 3. Implement and report Step 2
    await writeFile(path.join(fixture.projectRoot, 'src', 'router.mjs'), 'export const router = 2;\n');
    const report2 = await cp.report(runId, {
      stepId: 'step-2-router',
      summary: 'Implemented router.mjs',
      changedPaths: ['src/router.mjs'],
      verifications: [{ commandRef: 'test:step2' }],
    });

    // 4. Final step report completes or asks for finalization
    assert.ok(report2 && typeof report2 === 'object' && 'workUnitStatus' in report2);
    assert.equal(report2.workUnitStatus, 'complete');
    assert.ok(report2 && typeof report2 === 'object' && 'status' in report2);
    if (report2.status === 'in-progress') {
      const finalReport = await cp.report(runId, {
        summary: 'Finalization report',
      });
      assert.ok(finalReport && typeof finalReport === 'object' && 'status' in finalReport);
      assert.equal(finalReport.status, 'completed');
    }

    const nextFinal = await cp.next(runId);
    assert.ok(nextFinal && typeof nextFinal === 'object' && 'action' in nextFinal);
    assert.ok(nextFinal.action !== null && nextFinal.action !== undefined);
    assert.equal(nextFinal.action.type, 'done');
    assert.ok(nextFinal && typeof nextFinal === 'object' && 'workAuthority' in nextFinal);
    assert.ok(nextFinal.workAuthority !== null && nextFinal.workAuthority !== undefined);
    assert.equal(nextFinal.workAuthority.goalStatus, 'complete');
  } finally {
    if (cp) await cp.close().catch(() => {});
    await safeCleanup(fixture.projectRoot, fixture.runtimeHome);
  }
});

test('Golden E2E: reviewer policy resolution enforces the canonical review policy', () => {
  const policy = resolveCodexModelPolicy({ executionClass: 'review' });
  assert.equal(policy.model, CODEX_EXECUTION_POLICY.review.model);
  assert.equal(policy.effort, CODEX_EXECUTION_POLICY.review.effort);
});

test('Golden E2E: process tree timeout cleanup terminates safely without indefinite hang', () => {
  const result = cleanupWindowsTimeoutProcessTree({
    launcherPid: 9999999,
    expectedCommand: 'node',
    expectedArgs: ['-e'],
    startedAt: new Date(),
    processTable: { status: 'ready', processes: [] },
  });
  assert.ok(['completed', 'blocked', 'not-applicable'].includes(result.status));
});

type KernelControlPlane = Awaited<ReturnType<typeof createKernelControlPlane>>;
