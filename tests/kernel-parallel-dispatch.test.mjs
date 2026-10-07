import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runGit } from '../scripts/lib/git-safe.mjs';
import { observeWorkspaceIdentity } from '../scripts/kernel/run/workspace-identity.mjs';
import { cleanupExecutionWorkspaces, executionRoot } from '../scripts/host/kernel/workspace/physical-worktree.mjs';
import { dispatchKernelParallel, dispatchKernelStep } from '../scripts/host/kernel/parallel-dispatcher.mjs';
import { createClaudeAdapter } from '../scripts/host/kernel/adapters/claude.mjs';
import { createKernelControlPlane } from '../scripts/kernel/control-plane.mjs';

const capabilities = {
  surface: 'codex',
  supportsConcurrentSessions: true,
  supportsIsolatedWorkingDirectory: true,
  supportsPerSessionEnvironment: true,
};

const createFixture = async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'kernel-parallel-dispatch-repo-'));
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-parallel-dispatch-home-'));
  runGit(projectRoot, ['init', '-b', 'main']);
  runGit(projectRoot, ['config', 'user.name', 'Kernel Parallel Test']);
  runGit(projectRoot, ['config', 'user.email', 'kernel-parallel@example.invalid']);
  await mkdir(path.join(projectRoot, 'src'), { recursive: true });
  await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({ name: 'kernel-parallel-dispatch-fixture', scripts: { 'test:ok': 'node --version' } }));
  await writeFile(path.join(projectRoot, 'src', 'base.txt'), 'base\n');
  runGit(projectRoot, ['add', '--all']);
  runGit(projectRoot, ['commit', '-m', 'fixture']);
  return { projectRoot, runtimeHome, baseCommitSha: String(runGit(projectRoot, ['rev-parse', 'HEAD']).stdout).trim() };
};

const makeSteps = () => [
  { stepId: 'step-alpha', sequence: 1, allowedPaths: ['src/alpha/**'], obligationIds: ['alpha-proof'], expectedOutputs: ['alpha result'] },
  { stepId: 'step-beta', sequence: 2, allowedPaths: ['src/beta/**'], obligationIds: ['beta-proof'], expectedOutputs: ['beta result'] },
];

const makeControlPlane = ({ fixture, failedStepId = null, failMaterialization = false, failRenewal = false, settlementFailureStepId = null, failReceiptPersistenceStepId = null }) => {
  const steps = makeSteps();
  const failures = [];
  const reports = [];
  const recorded = [];
  const ownerMutations = [];
  const baseWorkspaceIdentity = observeWorkspaceIdentity({ projectRoot: fixture.projectRoot }).identity;
  const run = {
    runId: 'run-parallel-dispatch',
    projectId: 'project-parallel-dispatch',
    status: 'active',
    proofTier: 'T0',
    baseCommitSha: fixture.baseCommitSha,
    mutationRevision: 0,
    currentWorkspaceIdentity: baseWorkspaceIdentity,
    workspaceId: 'workspace-parallel-dispatch',
    worktreeId: 'worktree-parallel-dispatch',
    taskContract: {
      acceptance: [{ evidencePlan: { commandRefs: ['test:ok'] } }],
    },
  };
  return {
    projectRoot: fixture.projectRoot,
    getExecutableSteps: async () => ({ mode: 'parallel', steps }),
    getRun: () => run,
    discoverProjectCommands: () => [{ commandRef: 'test:ok' }],
    registerExecutionWorkspace: (_runId, workspaceRoot) => ({
      workspaceId: `workspace-${path.basename(workspaceRoot)}`,
      identity: observeWorkspaceIdentity({ projectRoot: workspaceRoot }).identity,
    }),
    bindStepAttempt: async (_runId, step) => ({ id: step, attemptId: `attempt-${step}`, bindingId: `binding-${step}` }),
    hostNext: async (_runId, { actionContext }) => {
      const stepId = actionContext.stepId;
      return {
      resolution: { model: 'fixture-model' },
      executionCapsule: {
        capsuleId: `capsule-${stepId}`,
        provenance: { capsuleDigest: `sha256:${stepId}`, routeDecisionId: `route-${stepId}` },
      },
      hostDirective: {
        attempt: { attemptId: `attempt-${stepId}`, bindingId: `binding-${stepId}` },
        modelRouteDecision: { decisionId: `decision-${stepId}` },
        enforcementStrategy: 'isolated',
      },
      modelInput: { action: { type: 'implement' } },
      };
    },
    updateStepAttempt: async () => {},
    recordStepResult: async (_runId, stepId) => {
      if (stepId === failReceiptPersistenceStepId) {
        throw Object.assign(new Error('simulated durable worker receipt failure'), { code: 'worker_receipt_persistence_failed' });
      }
    },
    acquireOwnerWorkspaceMutationFence: async (_runId, snapshot) => ({
      lock: { workspaceId: snapshot.expectedWorkspaceId, fencingToken: 1, sessionToken: 'fixture-owner' },
      snapshot,
    }),
    renewOwnerWorkspaceMutationFence: async (_runId, snapshot) => {
      if (failRenewal) throw Object.assign(new Error('simulated owner fence loss before Delivery apply'), { code: 'delivery_mutation_fence_lost' });
      return {
        lock: { workspaceId: snapshot.workspaceId || snapshot.expectedWorkspaceId, fencingToken: snapshot.fencingToken || 1, sessionToken: snapshot.sessionToken || 'fixture-owner' },
        snapshot,
      };
    },
    assertOwnerWorkspaceMutationReady: async (_runId, mutation) => ({ snapshot: mutation }),
    recordOwnerWorkspaceMutation: async (_runId, mutation) => {
      const deliveryWorkspaceIdentity = observeWorkspaceIdentity({ projectRoot: fixture.projectRoot }).identity;
      if (failMaterialization) throw Object.assign(new Error('simulated observation crash after Delivery apply'), { code: 'delivery_observation_failed' });
      ownerMutations.push({ ...mutation, deliveryWorkspaceIdentity });
      run.currentWorkspaceIdentity = deliveryWorkspaceIdentity;
      run.mutationRevision += 1;
      return {
        status: 'applied',
        changed: true,
        deliveryWorkspaceIdentity,
        integrationWorkspaceIdentity: mutation.integrationWorkspaceIdentity,
        mutationRevision: run.mutationRevision,
      };
    },
    releaseOwnerWorkspaceMutationFence: async () => ({ released: true }),
    blockDeliveryMaterialization: async () => {
      run.status = 'blocked';
      return run;
    },
    settleParallelResult: async (_runId, payload, options) => {
      reports.push(payload);
      recorded.push({ stepId: payload.stepId, result: options.result });
      if (payload.stepId === settlementFailureStepId) {
        return {
          status: 'evidence-rejected',
          failures: [{ errorCode: 'delivery_worker_receipt_mismatch' }],
          step: { state: 'running' },
        };
      }
      return { status: 'in-progress', step: { state: 'passed', resultDigest: `digest-${payload.stepId}` } };
    },
    failStepAttempt: async (_runId, stepId, details) => failures.push({ stepId, details }),
    recordModelUsage: async () => {},
    execute: async () => {},
    failures,
    reports,
    recorded,
    ownerMutations,
    run,
    steps,
    adapter: {
      capabilities,
      dispatch: async () => ({ status: 'passed' }),
    },
    dispatchStep: async ({ step, workspace }) => {
      if (step.stepId === failedStepId) {
        return {
          status: 'failed',
          resultStatus: 'failed',
          report: { summary: 'simulated worker failure', changedPaths: [] },
        };
      }
      const relativePath = `src/${step.stepId === 'step-alpha' ? 'alpha' : 'beta'}/result.txt`;
      const target = path.join(workspace.workspaceRoot, relativePath);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, `${step.stepId}\n`);
      return {
        status: 'passed',
        resultStatus: 'passed',
        report: { summary: `${step.stepId} complete`, changedPaths: [relativePath] },
      };
    },
  };
};

const runDispatch = async ({ failedStepId = null, failMaterialization = false, failRenewal = false, verificationAddsExtraPath = false, settlementFailureStepId = null, failReceiptPersistenceStepId = null, integrationVerification = null } = {}) => {
  const fixture = await createFixture();
  const controlPlane = makeControlPlane({ fixture, failedStepId, failMaterialization, failRenewal, settlementFailureStepId, failReceiptPersistenceStepId });
  try {
    const result = await dispatchKernelParallel({
      controlPlane,
      runId: 'run-parallel-dispatch',
      adapter: controlPlane.adapter,
      projectRoot: fixture.projectRoot,
      runtimeHome: fixture.runtimeHome,
      dispatchStep: controlPlane.dispatchStep,
      prepareHost: async ({ controlPlane: cp, runId, actionContext }) => cp.hostNext(runId, { actionContext }),
      executeIntegrationVerification: async ({ workspaceRoot }) => {
        if (verificationAddsExtraPath) {
          const extraPath = path.join(workspaceRoot, 'src', 'alpha', 'verification-extra.txt');
          await writeFile(extraPath, 'verification must not change the integrated patch\n');
          const staged = runGit(workspaceRoot, ['add', '--', 'src/alpha/verification-extra.txt']);
          assert.equal(staged.status, 0, staged.stderr);
        }
        return integrationVerification || { status: 'passed', passed: true, evidenceRef: 'evidence://fixture' };
      },
    });
    return { fixture, controlPlane, result };
  } catch (error) {
    await cleanupExecutionWorkspaces({ runtimeHome: fixture.runtimeHome, projectId: 'project-parallel-dispatch', runId: 'run-parallel-dispatch', repoRoot: fixture.projectRoot, retain: false }).catch(() => {});
    await rm(fixture.runtimeHome, { recursive: true, force: true });
    await rm(fixture.projectRoot, { recursive: true, force: true });
    throw error;
  }
};

const finishFixture = async ({ fixture, result }) => {
  await cleanupExecutionWorkspaces({ runtimeHome: fixture.runtimeHome, projectId: 'project-parallel-dispatch', runId: 'run-parallel-dispatch', repoRoot: fixture.projectRoot, retain: false });
  await rm(fixture.runtimeHome, { recursive: true, force: true });
  await rm(fixture.projectRoot, { recursive: true, force: true });
  assert.ok(result);
};

test('parallel default worker dispatch keeps its Host envelope out of the provider launch', async () => {
  const fixture = await createFixture();
  const controlPlane = makeControlPlane({ fixture });
  const step = makeSteps()[0];
  const workspace = {
    workspaceId: 'workspace-worker-alpha',
    workspaceRoot: fixture.projectRoot,
    baseWorkspaceIdentity: observeWorkspaceIdentity({ projectRoot: fixture.projectRoot }).identity,
  };
  let seen = null;
  const adapter = createClaudeAdapter({
    capabilities,
    launch: async (providerInput) => {
      seen = providerInput;
      return {
        status: 'completed',
        resolvedModel: 'fixture-model',
        sessionId: 'parallel-worker-session',
        report: { summary: 'parallel worker complete', changedPaths: [] },
      };
    },
  });
  try {
    const result = await dispatchKernelStep({
      controlPlane,
      runId: 'run-parallel-dispatch',
      step,
      workspace,
      adapter,
      hostCapabilities: capabilities,
      prepareHost: async ({ controlPlane: cp, runId, actionContext }) => cp.hostNext(runId, { actionContext }),
      prepareDispatch: async ({ hosted }) => ({
        ...hosted,
        resolution: { model: 'fixture-model', effort: 'high' },
        decision: { role: 'implementer', modelClass: 'value_coding' },
        executionCapsule: {
          ...hosted.executionCapsule,
          role: 'implementer',
          objective: 'parallel objective',
          workUnit: { objective: step.objective, allowedPaths: step.allowedPaths, expectedOutputs: step.expectedOutputs },
          permissions: { filesystem: 'workspace_write' },
          mutationRevision: 8,
          provenance: { capsuleDigest: 'host-only-capsule', routeDecisionId: 'host-only-route' },
        },
        modelInput: {
          objective: 'parallel objective',
          action: { type: 'implement', step },
          requiredEvidence: [{ obligationId: 'alpha-proof', control: { runId: 'nested-leak' } }],
        },
        hostDirective: {
          ...hosted.hostDirective,
          executionAssignment: { executionMode: 'native-subagent', delegation: { requested: true } },
        },
        envelope: { control: { runId: 'host-only-run' }, modelPolicy: { resolvedModel: 'host-only-model' } },
      }),
      deferReport: true,
    });
    assert.equal(result.status, 'passed', JSON.stringify(result));
    assert.ok(seen);
    assert.equal(seen.envelope, undefined);
    assert.equal(seen.control, undefined);
    assert.equal(seen.modelPolicy, undefined);
    assert.deepEqual(seen.modelVisiblePrompt.requiredEvidence, [{ obligationId: 'alpha-proof' }]);
    assert.doesNotMatch(seen.message, /host-only-run|host-only-model|nested-leak|mutationRevision|routeDecision/u);
  } finally {
    await cleanupExecutionWorkspaces({ runtimeHome: fixture.runtimeHome, projectId: 'project-parallel-dispatch', runId: 'run-parallel-dispatch', repoRoot: fixture.projectRoot, retain: false }).catch(() => {});
    await rm(fixture.runtimeHome, { recursive: true, force: true });
    await rm(fixture.projectRoot, { recursive: true, force: true });
  }
});

test('parallel success uses existing Step receipts and integrates deterministic worker results', async () => {
  const run = await runDispatch();
  try {
    assert.equal(run.result.status, 'passed', `${JSON.stringify(run.result, null, 2)}\nintegration=${run.result.integration.error?.stack || run.result.integration.error?.message || ''}\nreasons=${run.result.workerResults.map((entry) => entry.reason?.stack || entry.reason || '').join('\n')}`);
    assert.equal(run.result.dispatched, true);
    assert.equal(run.result.executionResults.length, 2);
    assert.equal(run.controlPlane.failures.length, 0);
    assert.equal(run.controlPlane.recorded.length, 2);
    assert.ok(run.controlPlane.reports.every((report) => report.attemptId.startsWith('attempt-step-')));
    assert.doesNotMatch(JSON.stringify(run.result), /batchId|groupId|parallelPlanId/u);
    assert.equal((await readFile(path.join(run.fixture.projectRoot, 'src', 'alpha', 'result.txt'), 'utf8')).trim(), 'step-alpha');
    assert.equal((await readFile(path.join(run.fixture.projectRoot, 'src', 'beta', 'result.txt'), 'utf8')).trim(), 'step-beta');
  } finally {
    await finishFixture(run);
  }
});

test('partial worker failure retains recovery workspaces and records only the failed Step', async () => {
  const run = await runDispatch({ failedStepId: 'step-beta' });
  try {
    assert.equal(run.result.status, 'partial-failure', `${JSON.stringify(run.result, null, 2)}\nintegration=${run.result.integration.error?.stack || run.result.integration.error?.message || ''}\nreasons=${run.result.workerResults.map((entry) => entry.reason?.stack || entry.reason || '').join('\n')}`);
    assert.equal(run.result.executionResults.length, 1);
    assert.deepEqual(run.controlPlane.failures.map((entry) => entry.stepId), ['step-beta']);
    assert.equal(run.controlPlane.recorded.length, 1);
    assert.equal(run.result.cleanup.retained, true);
    assert.equal((await readFile(path.join(run.fixture.projectRoot, 'src', 'alpha', 'result.txt'), 'utf8')).trim(), 'step-alpha');
    assert.equal(existsSync(executionRoot({ runtimeHome: run.fixture.runtimeHome, projectId: 'project-parallel-dispatch', runId: 'run-parallel-dispatch' })), true);
    assert.doesNotMatch(JSON.stringify(run.result), /batchId|groupId|parallelPlanId/u);
  } finally {
    await finishFixture(run);
  }
});

test('a Delivery observation failure after apply blocks recovery and never settles a worker', async () => {
  const run = await runDispatch({ failMaterialization: true });
  try {
    assert.equal(run.result.status, 'failed');
    assert.equal(run.result.integration.status, 'failed');
    assert.equal(run.result.integration.failureCode, 'delivery_observation_failed');
    assert.equal(run.result.executionResults.length, 0);
    assert.equal(run.controlPlane.run.status, 'blocked');
    assert.equal(run.result.cleanup.retained, true);
    assert.equal((await readFile(path.join(run.fixture.projectRoot, 'src', 'alpha', 'result.txt'), 'utf8')).trim(), 'step-alpha');
  } finally {
    await finishFixture(run);
  }
});

test('integration verification cannot add staged paths after receipt validation', async () => {
  const run = await runDispatch({ verificationAddsExtraPath: true });
  try {
    assert.equal(run.result.status, 'failed');
    assert.equal(run.result.integration.status, 'failed');
    assert.equal(run.result.integration.failureCode, 'integration_verification_changed_paths');
    assert.equal(run.controlPlane.ownerMutations.length, 0);
    assert.equal(existsSync(path.join(run.fixture.projectRoot, 'src', 'alpha', 'result.txt')), false);
    assert.equal(run.result.cleanup.retained, true);
  } finally {
    await finishFixture(run);
  }
});

test('rejected Delivery settlements make the dispatch partial-failure instead of passed', async () => {
  const run = await runDispatch({ settlementFailureStepId: 'step-alpha' });
  try {
    assert.equal(run.result.status, 'partial-failure', JSON.stringify(run.result, null, 2));
    assert.equal(run.result.integration.status, 'integrated');
    assert.equal(run.result.executionResults.length, 1);
    assert.equal(run.result.settlementFailures.length, 1);
    assert.equal(run.result.settlementFailures[0].stepId, 'step-alpha');
    assert.equal(run.result.settlementFailures[0].reportResult.status, 'evidence-rejected');
    assert.deepEqual(run.controlPlane.failures.map((entry) => entry.stepId), ['step-alpha']);
    assert.equal(run.controlPlane.ownerMutations.length, 1);
    assert.equal(run.result.cleanup.retained, true);
  } finally {
    await finishFixture(run);
  }
});

test('post-dispatch worker receipt failure makes mixed success partial-failure', async () => {
  const run = await runDispatch({ failReceiptPersistenceStepId: 'step-alpha' });
  try {
    assert.equal(run.result.status, 'partial-failure', JSON.stringify(run.result, null, 2));
    assert.equal(run.result.integration.status, 'integrated');
    assert.equal(run.result.executionResults.length, 1);
    assert.equal(run.result.resultProcessingFailures.length, 1);
    assert.equal(run.result.resultProcessingFailures[0].stepId, 'step-alpha');
    assert.equal(run.result.resultProcessingFailures[0].failureCode, 'worker_receipt_persistence_failed');
    assert.deepEqual(run.controlPlane.failures.map((entry) => entry.stepId), ['step-alpha']);
    assert.equal(run.result.cleanup.retained, true);
  } finally {
    await finishFixture(run);
  }
});

test('non-passed integration verification fails closed before owner Delivery mutation', async () => {
  const run = await runDispatch({ integrationVerification: { status: 'blocked' } });
  try {
    assert.equal(run.result.status, 'failed');
    assert.equal(run.result.integration.status, 'failed');
    assert.equal(run.result.integration.failureCode, 'integration_verification_failed');
    assert.equal(run.result.executionResults.length, 0);
    assert.equal(run.controlPlane.ownerMutations.length, 0);
    assert.equal(run.result.cleanup.retained, true);
  } finally {
    await finishFixture(run);
  }
});

test('owner fence renewal loss fails closed before Delivery apply', async () => {
  const run = await runDispatch({ failRenewal: true });
  try {
    assert.equal(run.result.status, 'failed');
    assert.equal(run.result.integration.status, 'failed');
    assert.equal(run.result.integration.failureCode, 'delivery_mutation_fence_lost');
    assert.equal(run.controlPlane.ownerMutations.length, 0);
    assert.equal(existsSync(path.join(run.fixture.projectRoot, 'src', 'alpha', 'result.txt')), false);
    assert.equal(run.controlPlane.run.status, 'active', 'no recovery block is needed when apply was never attempted');
  } finally {
    await finishFixture(run);
  }
});

test('real Control Plane settles worker receipts only after owner Delivery CAS', async () => {
  const fixture = await createFixture();
  const controlPlane = await createKernelControlPlane({ runtimeHome: fixture.runtimeHome, projectRoot: fixture.projectRoot });
  const runId = 'run-real-parallel-delivery';
  const contract = {
    complex: true,
    riskTier: 'T1',
    acceptance: [
      { id: 'AC-ALPHA', acceptance: 'alpha is materialized', evidencePlan: { class: 'hard', method: 'unit-test', commandRefs: ['test:ok'], obligationId: 'alpha-proof' } },
      { id: 'AC-BETA', acceptance: 'beta is materialized', evidencePlan: { class: 'hard', method: 'unit-test', commandRefs: ['test:ok'], obligationId: 'beta-proof' } },
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
  let projectId = null;
  try {
    const started = await controlPlane.startRun({ runId, objective: 'real parallel delivery', taskContract: contract });
    projectId = started.projectId;
    assert.equal(started.mutationRevision, 0);
    const executable = controlPlane.getExecutableSteps(runId);
    assert.equal(executable.mode, 'parallel', JSON.stringify(executable));
    const settleParallelResult = controlPlane.settleParallelResult.bind(controlPlane);
    let mismatchedSettlement = null;
    let forgedSettlement = null;
    let forgedWorkerReceiptSettlement = null;
    let omittedWorkerPathSettlement = null;
    let driftedSettlement = null;
    controlPlane.settleParallelResult = async (settleRunId, payload, options) => {
      if (!mismatchedSettlement) {
        mismatchedSettlement = await settleParallelResult(settleRunId, {
          ...payload,
          changedPaths: ['src/declared.txt'],
        }, options);
        forgedSettlement = await settleParallelResult(settleRunId, payload, {
          ...options,
          deliveryMutation: {
            ...options.deliveryMutation,
            deliveryWorkspaceIdentity: `sha256:${'c'.repeat(64)}`,
          },
        });
        forgedWorkerReceiptSettlement = await settleParallelResult(settleRunId, payload, {
          ...options,
          result: {
            ...options.result,
            resultCommitSha: `sha256:${'f'.repeat(64)}`,
          },
        });
        const originalGetMutationProvenance = controlPlane.stateStore.getMutationProvenance;
        controlPlane.stateStore.getMutationProvenance = (...args) => {
          const persisted = originalGetMutationProvenance(...args);
          return persisted ? { ...persisted, changedPaths: ['src/beta/result.txt'] } : persisted;
        };
        omittedWorkerPathSettlement = await settleParallelResult(settleRunId, payload, {
          ...options,
          deliveryMutation: {
            ...options.deliveryMutation,
            changedPaths: ['src/beta/result.txt'],
          },
        });
        controlPlane.stateStore.getMutationProvenance = originalGetMutationProvenance;
        assert.equal(controlPlane.stateStore.getRunStep(settleRunId, payload.stepId).state, 'running');
        const driftPath = path.join(fixture.projectRoot, 'between-settlement.txt');
        await writeFile(driftPath, 'Delivery changed after the owner fence was released\n');
        driftedSettlement = await settleParallelResult(settleRunId, payload, options);
        await rm(driftPath, { force: true });
      }
      return settleParallelResult(settleRunId, payload, options);
    };
    const result = await dispatchKernelParallel({
      controlPlane,
      runId,
      adapter: { capabilities },
      projectRoot: fixture.projectRoot,
      runtimeHome: fixture.runtimeHome,
      parentSessionId: 'fixture-parent',
      actionContext: { integrationVerification: { commandRef: 'test:ok' } },
      dispatchStep: async ({ step, workspace }) => {
        const name = step.stepId.endsWith('1') ? 'alpha' : 'beta';
        const relativePath = `src/${name}/result.txt`;
        const target = path.join(workspace.workspaceRoot, relativePath);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, `${name}\n`);
        const obligationId = name === 'alpha' ? 'alpha-proof' : 'beta-proof';
        const acceptanceId = name === 'alpha' ? 'AC-ALPHA' : 'AC-BETA';
        const verifications = [{ obligationId, commandRef: 'test:ok', acceptanceCoverage: [acceptanceId] }];
        if (name === 'beta') verifications.push({ obligationId: 'unit-test', commandRef: 'test:ok', acceptanceCoverage: [] });
        return {
          status: 'passed',
          resultStatus: 'passed',
          report: {
            summary: `${name} worker complete`,
            changedPaths: [relativePath],
            verifications,
          },
        };
      },
      executeIntegrationVerification: async () => ({ status: 'passed', passed: true, evidenceRef: 'evidence://real-parallel' }),
    });
    assert.equal(result.status, 'passed', JSON.stringify({
      worker: result.workerResults.map((entry) => entry.value ? { status: entry.value.status, failureCode: entry.value.failureCode } : { status: entry.status, reason: entry.reason?.message }),
      integration: { status: result.integration?.status, failureCode: result.integration?.failureCode, error: result.integration?.error?.message },
      execution: result.executionResults.map((entry) => ({ stepId: entry.stepId, status: entry.reportResult?.status, failures: entry.reportResult?.failures })),
      settlementFailures: result.settlementFailures?.map((entry) => ({ stepId: entry.stepId, status: entry.reportResult?.status, failures: entry.reportResult?.failures, next: entry.reportResult?.next })),
      steps: controlPlane.stateStore.getRunSteps(runId).map((step) => ({ stepId: step.stepId, state: step.state, blockedReason: step.blockedReason })),
      verifications: controlPlane.stateStore.getVerifications(runId).map((verification) => ({ obligationId: verification.obligationId, status: verification.status, errorSummary: verification.errorSummary })),
    }, null, 2));
    assert.equal(result.integration.deliveryMutation.mutationRevision, 1);
    assert.equal(result.integration.deliveryMutation.expectedMutationRevision, 0);
    const finalRun = await controlPlane.getRun(runId);
    assert.equal(finalRun.mutationRevision, 1);
    assert.equal(finalRun.currentWorkspaceIdentity, result.integration.deliveryWorkspaceIdentity);
    assert.equal(result.executionResults.length, 2);
    assert.ok(result.executionResults.every((entry) => entry.reportResult.step.state === 'passed'));
    const attempts = controlPlane.stateStore.getRunSteps(runId).flatMap((step) => controlPlane.stateStore.getStepAttempts(runId, { stepId: step.stepId }));
    assert.equal(attempts.length, 2);
    assert.ok(attempts.every((attempt) => attempt.mutationRevision === 0), 'worker attempts retain execution-time revision');
    assert.ok(attempts.every((attempt) => attempt.resultWorkspaceIdentity?.startsWith('sha256:')));
    assert.deepEqual(
      attempts.map((attempt) => attempt.changedPaths),
      [['src/alpha/result.txt'], ['src/beta/result.txt']],
      'durable worker receipts preserve committed changed paths',
    );
    const ownerProvenance = controlPlane.stateStore.getMutationProvenance(runId);
    assert.equal(ownerProvenance.workspaceIdentity, result.integration.deliveryWorkspaceIdentity);
    assert.deepEqual(ownerProvenance.changedPaths, ['src/alpha/result.txt', 'src/beta/result.txt']);
    assert.ok(mismatchedSettlement);
    assert.equal(mismatchedSettlement.status, 'evidence-rejected');
    assert.equal(mismatchedSettlement.failures[0].errorCode, 'delivery_worker_paths_mismatch');
    assert.ok(forgedSettlement);
    assert.equal(forgedSettlement.status, 'evidence-rejected');
    assert.equal(forgedSettlement.failures[0].errorCode, 'delivery_workspace_identity_stale');
    assert.ok(forgedWorkerReceiptSettlement);
    assert.equal(forgedWorkerReceiptSettlement.status, 'evidence-rejected');
    assert.equal(forgedWorkerReceiptSettlement.failures[0].errorCode, 'delivery_worker_receipt_mismatch');
    assert.ok(omittedWorkerPathSettlement);
    assert.equal(omittedWorkerPathSettlement.status, 'evidence-rejected');
    assert.equal(omittedWorkerPathSettlement.failures[0].errorCode, 'delivery_worker_paths_omitted');
    assert.ok(driftedSettlement);
    assert.equal(driftedSettlement.status, 'evidence-rejected');
    assert.equal(driftedSettlement.failures[0].errorCode, 'delivery_workspace_identity_stale');

    const firstAttempt = attempts[0];
    const firstStep = controlPlane.stateStore.getRunStep(runId, firstAttempt.stepId);
    assert.doesNotThrow(() => controlPlane.stateStore.recordStepResult(runId, firstAttempt.stepId, {
      attemptId: firstAttempt.attemptId,
      mutationRevision: firstAttempt.mutationRevision,
      resultWorkspaceIdentity: firstAttempt.resultWorkspaceIdentity,
      resultCommitSha: firstAttempt.resultCommitSha,
      changedPaths: firstAttempt.changedPaths,
      patchDigest: firstAttempt.patchDigest,
      workerReport: firstAttempt.workerReport,
      recordMutationProvenance: false,
    }));
    assert.throws(
      () => controlPlane.stateStore.recordStepResult(runId, firstAttempt.stepId, {
        attemptId: firstAttempt.attemptId,
        mutationRevision: firstAttempt.mutationRevision,
        resultWorkspaceIdentity: firstAttempt.resultWorkspaceIdentity,
        resultCommitSha: 'sha256:forged-worker-commit',
        changedPaths: firstAttempt.changedPaths,
        patchDigest: firstAttempt.patchDigest,
        workerReport: firstAttempt.workerReport,
        recordMutationProvenance: false,
      }),
      (error) => error.code === 'STEP_RESULT_IMMUTABLE_CONFLICT' && error.field === 'resultCommitSha',
    );
    assert.equal(firstStep.resultAttemptId, firstAttempt.attemptId);
  } finally {
    await controlPlane.close();
    await cleanupExecutionWorkspaces({ runtimeHome: fixture.runtimeHome, projectId, runId, repoRoot: fixture.projectRoot, retain: false }).catch(() => {});
    await rm(fixture.runtimeHome, { recursive: true, force: true });
    await rm(fixture.projectRoot, { recursive: true, force: true });
  }
});
