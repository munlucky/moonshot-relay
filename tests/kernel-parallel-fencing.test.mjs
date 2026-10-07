import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { dispatchKernelStep, deliveryApplyTimeoutMs } from '../scripts/host/kernel/parallel-dispatcher.mjs';
import { runGit } from '../scripts/lib/git-safe.mjs';
import { createKernelControlPlane } from '../scripts/kernel/control-plane.mjs';
import { observeWorkspaceIdentity } from '../scripts/kernel/run/workspace-identity.mjs';

test('a stale worker report is rejected at the existing Step report fence', async () => {
  const reportCalls = [];
  const recordedResults = [];
  const step = {
    stepId: 'step-stale-worker',
    objective: 'prove stale worker rejection',
    allowedPaths: ['src/stale/**'],
    obligationIds: ['stale-proof'],
  };
  const workspace = {
    workspaceRoot: 'C:/kernel-stale-worker-workspace',
    workspaceId: 'workspace-stale-worker',
    baseWorkspaceIdentity: 'sha256:workspace-base',
  };
  const controlPlane = {
    bindStepAttempt: async () => ({ id: 1, attemptId: 'attempt-stale-worker', bindingId: 'binding-stale-worker' }),
    hostNext: async () => ({
      resolution: { model: 'fixture-model' },
      executionCapsule: { capsuleId: 'capsule-current', provenance: { capsuleDigest: 'sha256:current' } },
      hostDirective: { attempt: { attemptId: 'attempt-stale-worker', bindingId: 'binding-stale-worker' } },
      modelInput: { action: { type: 'implement' } },
    }),
    updateStepAttempt: async () => {},
    report: async (_runId, payload) => {
      reportCalls.push(payload);
      return {
        status: 'scope-rejected',
        failures: [{ errorCode: 'capsule_lineage_incomplete' }],
        step: { state: 'failed' },
      };
    },
    recordStepResult: async (_runId, stepId, result) => recordedResults.push({ stepId, result }),
  };

  const result = await dispatchKernelStep({
    controlPlane,
    runId: 'run-stale-worker',
    step,
    workspace,
    adapter: { capabilities: {} },
    prepareHost: async ({ controlPlane: cp, runId, actionContext }) => cp.hostNext(runId, { actionContext }),
    dispatchStep: async () => ({
      status: 'passed',
      resultStatus: 'passed',
      report: {
        summary: 'worker used an old mutation revision',
        mutationRevision: 1,
        changedPaths: ['src/stale/result.txt'],
      },
    }),
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.failureCode, 'scope-rejected');
  assert.equal(reportCalls.length, 1);
  assert.equal(reportCalls[0].capsuleId, 'capsule-current');
  assert.equal(reportCalls[0].mutationRevision, 1);
  assert.equal(recordedResults.length, 0, 'a fenced worker cannot create a synthetic result receipt');
  assert.doesNotMatch(JSON.stringify(result), /batchId|groupId|parallelPlanId/u);
});

test('a missing worker report fails closed without inventing durable parallel state', async () => {
  const controlPlane = {
    bindStepAttempt: async () => ({ id: 2, attemptId: 'attempt-no-report', bindingId: 'binding-no-report' }),
    hostNext: async () => ({
      executionCapsule: { capsuleId: 'capsule-no-report', provenance: { capsuleDigest: 'sha256:no-report' } },
      hostDirective: { attempt: { attemptId: 'attempt-no-report', bindingId: 'binding-no-report' } },
      modelInput: { action: { type: 'implement' } },
    }),
    updateStepAttempt: async () => {},
  };
  const result = await dispatchKernelStep({
    controlPlane,
    runId: 'run-no-report',
    step: { stepId: 'step-no-report', allowedPaths: ['src/**'], obligationIds: ['proof'] },
    workspace: { workspaceRoot: 'C:/kernel-no-report-workspace', workspaceId: 'workspace-no-report', baseWorkspaceIdentity: 'sha256:base' },
    adapter: { capabilities: {} },
    prepareHost: async ({ controlPlane: cp, runId, actionContext }) => cp.hostNext(runId, { actionContext }),
    dispatchStep: async () => ({ status: 'passed', resultStatus: 'passed' }),
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.failureCode, 'worker-report-missing');
  assert.doesNotMatch(JSON.stringify(result), /batchId|groupId|parallelPlanId/u);
});

test('Delivery patch apply is bounded strictly before the owner fence expiry', () => {
  const now = Date.parse('2026-08-31T00:00:00.000Z');
  assert.equal(deliveryApplyTimeoutMs({ now, expiresAt: '2026-08-31T00:00:05.000Z', maxMs: 60000 }), 4000);
  assert.equal(deliveryApplyTimeoutMs({ now, expiresAt: '2026-08-31T00:02:00.000Z', maxMs: 60000 }), 60000);
  assert.equal(deliveryApplyTimeoutMs({ now, expiresAt: '2026-08-30T23:59:59.000Z', maxMs: 60000 }), 0);
  assert.equal(deliveryApplyTimeoutMs({ now, maxMs: 60000 }), 60000);
});

test('owner Delivery materialization holds the fence and advances mutation revision exactly once', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-owner-delivery-cas-'));
  const runtimeHome = path.join(tmpDir, 'runtime');
  const projectRoot = path.join(tmpDir, 'project');
  fs.mkdirSync(projectRoot, { recursive: true });
  runGit(projectRoot, ['init', '-b', 'main']);
  runGit(projectRoot, ['config', 'user.name', 'Kernel Delivery Test']);
  runGit(projectRoot, ['config', 'user.email', 'kernel-delivery@example.invalid']);
  fs.writeFileSync(path.join(projectRoot, 'package.json'), JSON.stringify({ name: 'kernel-delivery-fixture', scripts: { 'test:ok': 'node --version' } }));
  fs.writeFileSync(path.join(projectRoot, 'base.txt'), 'base\n');
  runGit(projectRoot, ['add', '--all']);
  runGit(projectRoot, ['commit', '-m', 'fixture']);

  const cp = await createKernelControlPlane({ runtimeHome, projectRoot });
  const runId = 'run-owner-delivery-cas';
  try {
    await cp.startRun({ runId, objective: 'owner delivery CAS' });
    const initial = await cp.getRun(runId);
    const snapshot = {
      expectedMutationRevision: initial.mutationRevision,
      expectedWorkspaceIdentity: initial.currentWorkspaceIdentity,
      expectedHeadCommitSha: String(runGit(projectRoot, ['rev-parse', 'HEAD']).stdout).trim(),
      expectedProjectId: initial.projectId,
      expectedWorktreeId: initial.worktreeId,
      expectedWorkspaceId: initial.workspaceId,
    };
    const fence = cp.acquireOwnerWorkspaceMutationFence(runId, snapshot);
    fs.writeFileSync(path.join(projectRoot, 'delivery.txt'), 'materialized\n');
    const deliveryIdentity = observeWorkspaceIdentity({ projectRoot }).identity;
    const mutation = cp.recordOwnerWorkspaceMutation(runId, {
      ...snapshot,
      fencingToken: fence.lock.fencingToken,
      sessionToken: fence.lock.sessionToken,
      integrationWorkspaceIdentity: deliveryIdentity,
      changedPaths: ['delivery.txt'],
      patchDigest: `sha256:${'a'.repeat(64)}`,
    });
    assert.equal(mutation.status, 'applied');
    assert.equal(mutation.mutationRevision, Number(snapshot.expectedMutationRevision) + 1);
    assert.equal((await cp.getRun(runId)).currentWorkspaceIdentity, deliveryIdentity);
    assert.equal((await cp.getRun(runId)).mutationRevision, Number(snapshot.expectedMutationRevision) + 1);
    assert.equal(cp.stateStore.getMutationProvenance(runId).mutationRevision, Number(snapshot.expectedMutationRevision) + 1);
    assert.throws(
      () => cp.recordOwnerWorkspaceMutation(runId, {
        ...snapshot,
        fencingToken: fence.lock.fencingToken,
        sessionToken: fence.lock.sessionToken,
        integrationWorkspaceIdentity: deliveryIdentity,
        changedPaths: ['delivery.txt'],
        patchDigest: `sha256:${'a'.repeat(64)}`,
      }),
      (error) => error.code === 'delivery_mutation_revision_stale',
    );
    cp.releaseOwnerWorkspaceMutationFence(runId, {
      workspaceId: fence.lock.workspaceId,
      fencingToken: fence.lock.fencingToken,
      sessionToken: fence.lock.sessionToken,
    });
  } finally {
    await cp.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('owner Delivery receipt fails closed when the workspace fence is lost', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-owner-delivery-fence-'));
  const runtimeHome = path.join(tmpDir, 'runtime');
  const projectRoot = path.join(tmpDir, 'project');
  fs.mkdirSync(projectRoot, { recursive: true });
  runGit(projectRoot, ['init', '-b', 'main']);
  runGit(projectRoot, ['config', 'user.name', 'Kernel Delivery Fence Test']);
  runGit(projectRoot, ['config', 'user.email', 'kernel-delivery-fence@example.invalid']);
  fs.writeFileSync(path.join(projectRoot, 'package.json'), JSON.stringify({ name: 'kernel-delivery-fence-fixture', scripts: { 'test:ok': 'node --version' } }));
  fs.writeFileSync(path.join(projectRoot, 'base.txt'), 'base\n');
  runGit(projectRoot, ['add', '--all']);
  runGit(projectRoot, ['commit', '-m', 'fixture']);

  const cp = await createKernelControlPlane({ runtimeHome, projectRoot });
  const runId = 'run-owner-delivery-fence';
  try {
    await cp.startRun({ runId, objective: 'owner delivery fence loss' });
    const initial = await cp.getRun(runId);
    const snapshot = {
      expectedMutationRevision: initial.mutationRevision,
      expectedWorkspaceIdentity: initial.currentWorkspaceIdentity,
      expectedHeadCommitSha: String(runGit(projectRoot, ['rev-parse', 'HEAD']).stdout).trim(),
      expectedProjectId: initial.projectId,
      expectedWorktreeId: initial.worktreeId,
      expectedWorkspaceId: initial.workspaceId,
    };
    const fence = cp.acquireOwnerWorkspaceMutationFence(runId, snapshot);
    cp.releaseOwnerWorkspaceMutationFence(runId, {
      workspaceId: fence.lock.workspaceId,
      fencingToken: fence.lock.fencingToken,
      sessionToken: fence.lock.sessionToken,
    });
    const replacement = cp.stateStore.acquireWorkspaceMutationLockV2({
      workspaceId: snapshot.expectedWorkspaceId,
      projectId: snapshot.expectedProjectId,
      runId,
      sessionToken: 'replacement-owner',
    });
    assert.equal(replacement.acquired, true);
    assert.throws(
      () => cp.recordOwnerWorkspaceMutation(runId, {
        ...snapshot,
        fencingToken: fence.lock.fencingToken,
        sessionToken: fence.lock.sessionToken,
        integrationWorkspaceIdentity: snapshot.expectedWorkspaceIdentity,
        changedPaths: ['delivery.txt'],
      }),
      (error) => error.code === 'delivery_mutation_fence_lost',
    );
    cp.stateStore.releaseWorkspaceMutationLockV2({
      workspaceId: replacement.lock.workspaceId,
      runId,
      sessionToken: replacement.lock.sessionToken,
      fencingToken: replacement.lock.fencingToken,
    });
  } finally {
    await cp.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('owner Delivery fence renewal fails closed after lease expiry', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-owner-delivery-renewal-'));
  const runtimeHome = path.join(tmpDir, 'runtime');
  const projectRoot = path.join(tmpDir, 'project');
  fs.mkdirSync(projectRoot, { recursive: true });
  runGit(projectRoot, ['init', '-b', 'main']);
  runGit(projectRoot, ['config', 'user.name', 'Kernel Delivery Renewal Test']);
  runGit(projectRoot, ['config', 'user.email', 'kernel-delivery-renewal@example.invalid']);
  fs.writeFileSync(path.join(projectRoot, 'package.json'), JSON.stringify({ name: 'kernel-delivery-renewal-fixture', scripts: { 'test:ok': 'node --version' } }));
  fs.writeFileSync(path.join(projectRoot, 'base.txt'), 'base\n');
  runGit(projectRoot, ['add', '--all']);
  runGit(projectRoot, ['commit', '-m', 'fixture']);

  const cp = await createKernelControlPlane({ runtimeHome, projectRoot });
  const runId = 'run-owner-delivery-renewal';
  try {
    await cp.startRun({ runId, objective: 'owner delivery fence renewal' });
    const initial = await cp.getRun(runId);
    const snapshot = {
      expectedMutationRevision: initial.mutationRevision,
      expectedWorkspaceIdentity: initial.currentWorkspaceIdentity,
      expectedHeadCommitSha: String(runGit(projectRoot, ['rev-parse', 'HEAD']).stdout).trim(),
      expectedProjectId: initial.projectId,
      expectedWorktreeId: initial.worktreeId,
      expectedWorkspaceId: initial.workspaceId,
    };
    const fence = cp.acquireOwnerWorkspaceMutationFence(runId, { ...snapshot, ttlMs: 100 });
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.throws(
      () => cp.renewOwnerWorkspaceMutationFence(runId, {
        ...snapshot,
        workspaceId: fence.lock.workspaceId,
        fencingToken: fence.lock.fencingToken,
        sessionToken: fence.lock.sessionToken,
      }),
      (error) => error.code === 'delivery_mutation_fence_lost',
    );
  } finally {
    await cp.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('owner Delivery acquisition rejects clean HEAD, dirty-tree, and revision drift snapshots', async () => {
  const runCase = async ({ runId, expectedCode, mutate }) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `kernel-owner-delivery-drift-${runId}-`));
    const runtimeHome = path.join(tmpDir, 'runtime');
    const projectRoot = path.join(tmpDir, 'project');
    fs.mkdirSync(projectRoot, { recursive: true });
    runGit(projectRoot, ['init', '-b', 'main']);
    runGit(projectRoot, ['config', 'user.name', 'Kernel Delivery Drift Test']);
    runGit(projectRoot, ['config', 'user.email', 'kernel-delivery-drift@example.invalid']);
    fs.writeFileSync(path.join(projectRoot, 'package.json'), JSON.stringify({ name: 'kernel-delivery-drift-fixture', scripts: { 'test:ok': 'node --version' } }));
    fs.writeFileSync(path.join(projectRoot, 'base.txt'), 'base\n');
    runGit(projectRoot, ['add', '--all']);
    runGit(projectRoot, ['commit', '-m', 'fixture']);
    const cp = await createKernelControlPlane({ runtimeHome, projectRoot });
    try {
      await cp.startRun({ runId, objective: runId });
      const run = await cp.getRun(runId);
      const snapshot = {
        expectedMutationRevision: run.mutationRevision,
        expectedWorkspaceIdentity: run.currentWorkspaceIdentity,
        expectedHeadCommitSha: String(runGit(projectRoot, ['rev-parse', 'HEAD']).stdout).trim(),
        expectedProjectId: run.projectId,
        expectedWorktreeId: run.worktreeId,
        expectedWorkspaceId: run.workspaceId,
      };
      await mutate({ cp, projectRoot, snapshot });
      assert.throws(
        () => cp.acquireOwnerWorkspaceMutationFence(runId, snapshot),
        (error) => error.code === expectedCode,
      );
    } finally {
      await cp.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  };

  await runCase({
    runId: 'run-owner-delivery-head-drift',
    expectedCode: 'delivery_head_changed',
    mutate: async ({ projectRoot }) => {
      fs.writeFileSync(path.join(projectRoot, 'head-drift.txt'), 'head drift\n');
      runGit(projectRoot, ['add', '--', 'head-drift.txt']);
      runGit(projectRoot, ['commit', '-m', 'unrelated head drift']);
    },
  });
  await runCase({
    runId: 'run-owner-delivery-dirty-drift',
    expectedCode: 'delivery_workspace_drift',
    mutate: async ({ projectRoot }) => {
      fs.writeFileSync(path.join(projectRoot, 'dirty-drift.txt'), 'dirty drift\n');
    },
  });
  await runCase({
    runId: 'run-owner-delivery-revision-drift',
    expectedCode: 'delivery_mutation_revision_stale',
    mutate: async ({ cp, projectRoot }) => {
      fs.writeFileSync(path.join(projectRoot, 'revision-drift.txt'), 'revision drift\n');
      cp.stateStore.observeWorkspaceIdentity('run-owner-delivery-revision-drift', observeWorkspaceIdentity({ projectRoot }).identity);
    },
  });
});

test('owner Delivery rejects negative integration identity parity before revision advance', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-owner-delivery-parity-'));
  const runtimeHome = path.join(tmpDir, 'runtime');
  const projectRoot = path.join(tmpDir, 'project');
  fs.mkdirSync(projectRoot, { recursive: true });
  runGit(projectRoot, ['init', '-b', 'main']);
  runGit(projectRoot, ['config', 'user.name', 'Kernel Delivery Parity Test']);
  runGit(projectRoot, ['config', 'user.email', 'kernel-delivery-parity@example.invalid']);
  fs.writeFileSync(path.join(projectRoot, 'package.json'), JSON.stringify({ name: 'kernel-delivery-parity-fixture', scripts: { 'test:ok': 'node --version' } }));
  fs.writeFileSync(path.join(projectRoot, 'base.txt'), 'base\n');
  runGit(projectRoot, ['add', '--all']);
  runGit(projectRoot, ['commit', '-m', 'fixture']);

  const cp = await createKernelControlPlane({ runtimeHome, projectRoot });
  const runId = 'run-owner-delivery-parity';
  try {
    await cp.startRun({ runId, objective: 'owner delivery identity parity' });
    const initial = await cp.getRun(runId);
    const snapshot = {
      expectedMutationRevision: initial.mutationRevision,
      expectedWorkspaceIdentity: initial.currentWorkspaceIdentity,
      expectedHeadCommitSha: String(runGit(projectRoot, ['rev-parse', 'HEAD']).stdout).trim(),
      expectedProjectId: initial.projectId,
      expectedWorktreeId: initial.worktreeId,
      expectedWorkspaceId: initial.workspaceId,
    };
    const fence = cp.acquireOwnerWorkspaceMutationFence(runId, snapshot);
    fs.writeFileSync(path.join(projectRoot, 'delivery.txt'), 'materialized\n');
    assert.throws(
      () => cp.recordOwnerWorkspaceMutation(runId, {
        ...snapshot,
        fencingToken: fence.lock.fencingToken,
        sessionToken: fence.lock.sessionToken,
        integrationWorkspaceIdentity: `sha256:${'b'.repeat(64)}`,
        changedPaths: ['delivery.txt'],
      }),
      (error) => error.code === 'delivery_materialization_identity_mismatch',
    );
    assert.equal((await cp.getRun(runId)).mutationRevision, snapshot.expectedMutationRevision);
    cp.releaseOwnerWorkspaceMutationFence(runId, {
      workspaceId: fence.lock.workspaceId,
      fencingToken: fence.lock.fencingToken,
      sessionToken: fence.lock.sessionToken,
    });
  } finally {
    await cp.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
