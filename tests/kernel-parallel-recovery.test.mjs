import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runGit } from '../scripts/lib/git-safe.mjs';
import { observeWorkspaceIdentity } from '../scripts/kernel/run/workspace-identity.mjs';
import { createKernelControlPlane } from '../scripts/kernel/control-plane.mjs';
import { dispatchKernelParallel } from '../scripts/host/kernel/parallel-dispatcher.mjs';
import {
  cleanupExecutionWorkspaces,
  executionRoot,
  inspectGitWorkspace,
  prepareExecutionWorkspaces,
} from '../scripts/host/kernel/workspace/physical-worktree.mjs';

const makeRepository = async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'kernel-parallel-recovery-repo-'));
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-parallel-recovery-home-'));
  runGit(repoRoot, ['init', '-b', 'main']);
  runGit(repoRoot, ['config', 'user.name', 'Kernel Recovery Test']);
  runGit(repoRoot, ['config', 'user.email', 'kernel-recovery@example.invalid']);
  await mkdir(path.join(repoRoot, 'src'), { recursive: true });
  await writeFile(path.join(repoRoot, 'package.json'), JSON.stringify({
    name: 'kernel-parallel-recovery-fixture',
    scripts: { 'test:ok': 'node --version' },
  }));
  await writeFile(path.join(repoRoot, 'src', 'base.txt'), 'base\n');
  runGit(repoRoot, ['add', '--all']);
  runGit(repoRoot, ['commit', '-m', 'fixture']);
  return {
    repoRoot,
    runtimeHome,
    baseCommit: String(runGit(repoRoot, ['rev-parse', 'HEAD']).stdout).trim(),
  };
};

const steps = [
  { stepId: 'step-alpha', allowedPaths: ['src/alpha/**'], obligationIds: ['alpha-proof'] },
  { stepId: 'step-beta', allowedPaths: ['src/beta/**'], obligationIds: ['beta-proof'] },
];

const worktreeCount = (repoRoot) => String(runGit(repoRoot, ['worktree', 'list', '--porcelain']).stdout)
  .split(/\r?\n/u)
  .filter((line) => line.startsWith('worktree ')).length;

test('restart reuses clean run-keyed execution workspaces without adding lifecycle state', async () => {
  const fixture = await makeRepository();
  const input = { ...fixture, runId: 'run-restart-reuse', projectId: 'project-restart-reuse', steps };
  try {
    const first = await prepareExecutionWorkspaces(input);
    assert.equal(first.integration.reused, false);
    assert.ok(first.steps.every((workspace) => workspace.reused === false));
    const firstRoots = [first.integration.workspaceRoot, ...first.steps.map((workspace) => workspace.workspaceRoot)];
    assert.equal(worktreeCount(fixture.repoRoot), 4);

    const second = await prepareExecutionWorkspaces(input);
    assert.equal(second.integration.reused, true);
    assert.ok(second.steps.every((workspace) => workspace.reused === true));
    assert.deepEqual(
      [second.integration.workspaceRoot, ...second.steps.map((workspace) => workspace.workspaceRoot)],
      firstRoots,
    );
    assert.equal(worktreeCount(fixture.repoRoot), 4, 'restart must not create duplicate worktrees');
    assert.ok(inspectGitWorkspace(second.integration.workspaceRoot).ready);
    assert.ok(inspectGitWorkspace(second.steps[0].workspaceRoot).ready);
    assert.equal(existsSync(path.join(executionRoot(input), 'integration')), true);
  } finally {
    await cleanupExecutionWorkspaces({ ...input, repoRoot: fixture.repoRoot, retain: false });
    await rm(fixture.runtimeHome, { recursive: true, force: true });
    await rm(fixture.repoRoot, { recursive: true, force: true });
  }
});

test('a dirty interrupted workspace is preserved and rejected instead of being overwritten', async () => {
  const fixture = await makeRepository();
  const input = { ...fixture, runId: 'run-dirty-recovery', projectId: 'project-dirty-recovery', steps };
  try {
    const first = await prepareExecutionWorkspaces(input);
    const dirtyPath = path.join(first.steps[0].workspaceRoot, 'src', 'alpha', 'uncommitted.txt');
    await mkdir(path.dirname(dirtyPath), { recursive: true });
    await writeFile(dirtyPath, 'worker-progress\n');

    await assert.rejects(
      () => prepareExecutionWorkspaces(input),
      (error) => error.code === 'WORKTREE_REUSE_FAILED' && /dirty-working-tree/u.test(error.message),
    );
    assert.equal(existsSync(dirtyPath), true, 'recovery must not delete interrupted worker progress');
    assert.equal(existsSync(first.integration.workspaceRoot), true);
    assert.equal(existsSync(executionRoot(input)), true);
  } finally {
    await cleanupExecutionWorkspaces({ ...input, repoRoot: fixture.repoRoot, retain: false });
    await rm(fixture.runtimeHome, { recursive: true, force: true });
    await rm(fixture.repoRoot, { recursive: true, force: true });
  }
});

test('a retained execution root is explicitly recoverable after a partial worker failure', async () => {
  const fixture = await makeRepository();
  const input = { ...fixture, runId: 'run-partial-retain', projectId: 'project-partial-retain', steps };
  try {
    const prepared = await prepareExecutionWorkspaces(input);
    const retained = await cleanupExecutionWorkspaces({ ...input, repoRoot: fixture.repoRoot, retain: true });
    assert.equal(retained.retained, true);
    assert.equal(existsSync(prepared.integration.workspaceRoot), true);
    assert.equal(existsSync(prepared.steps[1].workspaceRoot), true);
  } finally {
    await cleanupExecutionWorkspaces({ ...input, repoRoot: fixture.repoRoot, retain: false });
    await rm(fixture.runtimeHome, { recursive: true, force: true });
    await rm(fixture.repoRoot, { recursive: true, force: true });
  }
});

test('restart blocks an owner mutation whose Step settlement was interrupted', async () => {
  const fixture = await makeRepository();
  const runId = 'run-delivery-crash-recovery';
  const capabilities = {
    surface: 'codex',
    supportsConcurrentSessions: true,
    supportsIsolatedWorkingDirectory: true,
    supportsPerSessionEnvironment: true,
  };
  const contract = {
    riskTier: 'T1',
    acceptance: [
      { id: 'AC-ALPHA', acceptance: 'alpha result exists', evidencePlan: { class: 'hard', method: 'unit-test', commandRefs: ['test:ok'], obligationId: 'alpha-proof' } },
      { id: 'AC-BETA', acceptance: 'beta result exists', evidencePlan: { class: 'hard', method: 'unit-test', commandRefs: ['test:ok'], obligationId: 'beta-proof' } },
    ],
    requiredObligations: ['alpha-proof', 'beta-proof'],
    requiredVerifications: [
      { obligationId: 'alpha-proof', commandRefs: ['test:ok'] },
      { obligationId: 'beta-proof', commandRefs: ['test:ok'] },
    ],
    steps: [
      { objective: 'materialize alpha', allowedPaths: ['src/alpha/**'], acceptanceIds: ['AC-ALPHA'], obligationIds: ['alpha-proof'], dependsOn: [] },
      { objective: 'materialize beta', allowedPaths: ['src/beta/**'], acceptanceIds: ['AC-BETA'], obligationIds: ['beta-proof'], dependsOn: [] },
    ],
  };
  let controlPlane;
  let projectId;
  try {
    controlPlane = await createKernelControlPlane({ runtimeHome: fixture.runtimeHome, projectRoot: fixture.repoRoot });
    const started = await controlPlane.startRun({ runId, objective: 'recover committed Delivery', taskContract: contract });
    projectId = started.projectId;
    const originalSettle = controlPlane.settleParallelResult.bind(controlPlane);
    let crash = true;
    controlPlane.settleParallelResult = async (...args) => {
      if (crash) {
        crash = false;
        throw Object.assign(new Error('simulated dispatcher crash after Delivery CAS'), { code: 'simulated_dispatcher_crash' });
      }
      return originalSettle(...args);
    };
    await assert.rejects(
      () => dispatchKernelParallel({
        controlPlane,
        runId,
        adapter: { capabilities },
        projectRoot: fixture.repoRoot,
        runtimeHome: fixture.runtimeHome,
        parentSessionId: 'recovery-parent',
        actionContext: { integrationVerification: { commandRef: 'test:ok' } },
        dispatchStep: async ({ step, workspace }) => {
          const name = step.objective.endsWith('alpha') ? 'alpha' : 'beta';
          const relativePath = `src/${name}/result.txt`;
          await mkdir(path.dirname(path.join(workspace.workspaceRoot, relativePath)), { recursive: true });
          await writeFile(path.join(workspace.workspaceRoot, relativePath), `${name}\n`);
          return {
            status: 'passed',
            resultStatus: 'passed',
            report: {
              summary: `${name} worker complete`,
              changedPaths: [relativePath],
              verifications: [{
                obligationId: `${name}-proof`,
                commandRef: 'test:ok',
                acceptanceCoverage: [`AC-${name.toUpperCase()}`],
              }, ...(name === 'beta' ? [{ obligationId: 'unit-test', commandRef: 'test:ok', acceptanceCoverage: [] }] : [])],
            },
          };
        },
        executeIntegrationVerification: async () => ({ status: 'passed', passed: true, evidenceRef: 'evidence://recovery' }),
      }),
      (error) => error.code === 'simulated_dispatcher_crash',
    );

    const pending = controlPlane.stateStore.getMutationProvenance(runId);
    assert.equal(Object.hasOwn(pending, 'deliveryReceipt'), false, 'Delivery recovery must not persist a separate lifecycle marker');
    assert.equal(controlPlane.stateStore.getRun(runId).mutationRevision, 1);
    const pendingAttempts = controlPlane.stateStore.getStepAttempts(runId);
    assert.equal(pendingAttempts.length, 2);
    assert.ok(pendingAttempts.every((attempt) => attempt.status === 'started'));
    assert.ok(pendingAttempts.every((attempt) => attempt.workerReport?.verifications?.length >= 1));

    const pendingAttempt = pendingAttempts[0];
    const deliveryMutation = {
      changed: true,
      mutationRevision: pending.mutationRevision,
      expectedMutationRevision: pendingAttempts[0].mutationRevision,
      deliveryWorkspaceIdentity: pending.workspaceIdentity,
      integrationWorkspaceIdentity: pending.workspaceIdentity,
      changedPaths: pending.changedPaths,
      patchDigest: pending.mutationDigest,
      snapshot: {
        runId,
        expectedMutationRevision: pendingAttempts[0].mutationRevision,
        expectedWorkspaceIdentity: pendingAttempts[0].baseWorkspaceIdentity,
        expectedHeadCommitSha: fixture.baseCommit,
        expectedProjectId: controlPlane.stateStore.getRun(runId).projectId,
        expectedWorktreeId: controlPlane.stateStore.getRun(runId).worktreeId,
        expectedWorkspaceId: controlPlane.stateStore.getRun(runId).workspaceId,
      },
    };
    const workerReport = pendingAttempt.workerReport;
    const settlementPayload = {
      ...workerReport,
      stepId: pendingAttempt.stepId,
      attemptId: pendingAttempt.attemptId,
      capsuleId: pendingAttempt.capsuleId,
      workspaceId: pendingAttempt.workspaceId,
      bindingId: pendingAttempt.bindingId,
      changedPaths: pendingAttempt.changedPaths,
    };
    const settlementResult = {
      attemptId: pendingAttempt.attemptId,
      executionWorkspaceId: pendingAttempt.workspaceId,
      workerWorkspaceIdentity: pendingAttempt.baseWorkspaceIdentity,
      resultWorkspaceIdentity: pendingAttempt.resultWorkspaceIdentity,
      resultCommitSha: pendingAttempt.resultCommitSha,
      changedPaths: pendingAttempt.changedPaths,
      patchDigest: pendingAttempt.patchDigest,
      workerReport,
    };
    const originalGetMutationProvenance = controlPlane.stateStore.getMutationProvenance;
    controlPlane.stateStore.getMutationProvenance = (...args) => null;
    const missingPersistedReceipt = await controlPlane.settleParallelResult(runId, settlementPayload, {
      deliveryMutation,
      result: settlementResult,
    });
    controlPlane.stateStore.getMutationProvenance = originalGetMutationProvenance;
    assert.equal(missingPersistedReceipt.status, 'evidence-rejected');
    assert.equal(missingPersistedReceipt.failures[0].errorCode, 'delivery_owner_mutation_stale');

    controlPlane.settleParallelResult = originalSettle;
    const recovered = await controlPlane.recoverPendingDeliveryMaterialization(runId);
    assert.equal(recovered.status, 'blocked', JSON.stringify(recovered, null, 2));
    assert.equal(recovered.reason, 'delivery_materialization_recovery_required');
    assert.ok(controlPlane.stateStore.getStepAttempts(runId).every((attempt) => attempt.status === 'started'));
    assert.equal(Object.hasOwn(controlPlane.stateStore.getMutationProvenance(runId), 'deliveryReceipt'), false);

    const completedAttempt = controlPlane.stateStore.getStepAttempts(runId)[0];
    for (const [field, value] of Object.entries({
      mutationRevision: Number(completedAttempt.mutationRevision) + 1,
      changedPaths: ['src/forged/result.txt'],
      workspaceIdentityEnd: `sha256:${'f'.repeat(64)}`,
      resultWorkspaceIdentity: `sha256:${'e'.repeat(64)}`,
      resultCommitSha: `sha256:${'d'.repeat(64)}`,
      patchDigest: `sha256:${'c'.repeat(64)}`,
      workerReport: { forged: true },
    })) {
      assert.throws(
        () => controlPlane.stateStore.updateStepAttempt(completedAttempt.id, { [field]: value }),
        (error) => error.code === 'STEP_RESULT_IMMUTABLE_CONFLICT' && error.field === field,
        `generic attempt updates must not overwrite ${field}`,
      );
    }
    assert.throws(
      () => controlPlane.stateStore.attachAttemptLineage(completedAttempt.attemptId, { mutationRevision: Number(completedAttempt.mutationRevision) + 1 }),
      (error) => error.code === 'STEP_RESULT_IMMUTABLE_CONFLICT' && error.field === 'mutationRevision',
    );
  } finally {
    if (controlPlane) await controlPlane.close();
    await cleanupExecutionWorkspaces({ runtimeHome: fixture.runtimeHome, projectId, runId, repoRoot: fixture.repoRoot, retain: false }).catch(() => {});
    await rm(fixture.runtimeHome, { recursive: true, force: true });
    await rm(fixture.repoRoot, { recursive: true, force: true });
  }
});

test('restart blocks an owner workspace changed after worker receipt but before mutation provenance', async () => {
  const fixture = await makeRepository();
  const runId = 'run-provenance-gap-recovery';
  let controlPlane;
  let projectId;
  try {
    controlPlane = await createKernelControlPlane({ runtimeHome: fixture.runtimeHome, projectRoot: fixture.repoRoot });
    const started = await controlPlane.startRun({
      runId,
      objective: 'recover an apply before provenance observation',
      taskContract: {
        steps: [{ objective: 'materialize alpha', allowedPaths: ['src/alpha/**'], acceptanceIds: ['AC-ALPHA'], obligationIds: ['alpha-proof'], dependsOn: [] }],
        acceptance: [{ id: 'AC-ALPHA', acceptance: 'alpha result exists', evidencePlan: { class: 'hard', method: 'unit-test', commandRefs: ['test:ok'], obligationId: 'alpha-proof' } }],
        requiredObligations: ['alpha-proof'],
        requiredVerifications: [{ obligationId: 'alpha-proof', commandRefs: ['test:ok'] }],
      },
    });
    projectId = started.projectId;
    const run = controlPlane.stateStore.getRun(runId);
    const step = controlPlane.stateStore.getRunSteps(runId)[0];
    const baseWorkspaceIdentity = observeWorkspaceIdentity({ projectRoot: fixture.repoRoot }).identity;
    const attempt = controlPlane.bindStepAttempt(runId, step.stepId, {
      actorSessionId: 'worker-session',
      workspaceId: 'worker-workspace',
      baseWorkspaceIdentity,
      workspaceIdentity: baseWorkspaceIdentity,
      capsuleId: 'capsule-provenance-gap',
      bindingId: 'binding-provenance-gap',
    });
    controlPlane.stateStore.recordStepResult(runId, step.stepId, {
      attemptId: attempt.attemptId,
      executionWorkspaceId: attempt.workspaceId,
      mutationRevision: run.mutationRevision,
      resultWorkspaceIdentity: `sha256:${'b'.repeat(64)}`,
      resultCommitSha: `sha256:${'c'.repeat(64)}`,
      changedPaths: ['src/alpha/result.txt'],
      patchDigest: `sha256:${'d'.repeat(64)}`,
      workerReport: { summary: 'worker receipt persisted before owner observation', verifications: [] },
      recordMutationProvenance: false,
    });
    controlPlane.failStepAttempt(runId, step.stepId, { code: 'delivery_settlement_rejected' });
    assert.equal(controlPlane.stateStore.getStepAttempts(runId)[0].status, 'failed');
    assert.equal(controlPlane.stateStore.getMutationProvenance(runId), null);
    await mkdir(path.join(fixture.repoRoot, 'src', 'alpha'), { recursive: true });
    await writeFile(path.join(fixture.repoRoot, 'src', 'alpha', 'result.txt'), 'applied before provenance\n');

    const recovered = await controlPlane.recoverPendingDeliveryMaterialization(runId);
    assert.equal(recovered.status, 'blocked', JSON.stringify(recovered, null, 2));
    assert.match(recovered.detail, /before owner mutation provenance was persisted/u);
    assert.equal(controlPlane.stateStore.getRun(runId).status, 'blocked');
    assert.equal(controlPlane.stateStore.getMutationProvenance(runId), null);
  } finally {
    if (controlPlane) await controlPlane.close();
    await cleanupExecutionWorkspaces({ runtimeHome: fixture.runtimeHome, projectId, runId, repoRoot: fixture.repoRoot, retain: false }).catch(() => {});
    await rm(fixture.runtimeHome, { recursive: true, force: true });
    await rm(fixture.repoRoot, { recursive: true, force: true });
  }
});

test('restart blocks Delivery workspace drift without a persisted lifecycle marker', async () => {
  const fixture = await makeRepository();
  const runId = 'run-prepared-delivery-recovery';
  let controlPlane;
  let projectId;
  try {
    controlPlane = await createKernelControlPlane({ runtimeHome: fixture.runtimeHome, projectRoot: fixture.repoRoot });
    const started = await controlPlane.startRun({
      runId,
      objective: 'block incomplete Delivery intent',
      taskContract: { acceptance: [{ id: 'AC-1', acceptance: 'prepared mutation is detected', evidencePlan: { class: 'hard', method: 'unit-test', commandRefs: ['test:ok'], obligationId: 'proof' } }], requiredObligations: ['proof'], requiredVerifications: [{ obligationId: 'proof', commandRefs: ['test:ok'] }] },
    });
    projectId = started.projectId;
    const run = controlPlane.stateStore.getRun(runId);
    const baseWorkspaceIdentity = observeWorkspaceIdentity({ projectRoot: fixture.repoRoot }).identity;
    controlPlane.stateStore.recordMutationProvenance(runId, {
      projectId: run.projectId,
      workspaceId: run.workspaceId,
      sourceIdentity: run.sourceIdentity,
      baseSourceIdentity: run.sourceIdentity,
      mutationRevision: run.mutationRevision,
      changedPaths: ['src/prepared.txt'],
      workspaceIdentity: baseWorkspaceIdentity,
      mutationDigest: `sha256:${'a'.repeat(64)}`,
    });
    await writeFile(path.join(fixture.repoRoot, 'src', 'prepared.txt'), 'uncommitted Delivery bytes\n');

    const recovered = await controlPlane.recoverPendingDeliveryMaterialization(runId);
    assert.equal(recovered.status, 'blocked');
    assert.equal(recovered.reason, 'delivery_materialization_recovery_required');
    assert.equal(controlPlane.stateStore.getRun(runId).status, 'blocked');
    assert.equal(controlPlane.stateStore.getRun(runId).blockedReason, 'delivery_materialization_recovery_required');
    assert.equal(Object.hasOwn(controlPlane.stateStore.getMutationProvenance(runId), 'deliveryReceipt'), false);
  } finally {
    if (controlPlane) await controlPlane.close();
    await cleanupExecutionWorkspaces({ runtimeHome: fixture.runtimeHome, projectId, runId, repoRoot: fixture.repoRoot, retain: false }).catch(() => {});
    await rm(fixture.runtimeHome, { recursive: true, force: true });
    await rm(fixture.repoRoot, { recursive: true, force: true });
  }
});
