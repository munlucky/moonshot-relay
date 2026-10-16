import { assertTestArray, assertTestNumber, assertTestPresent, assertTestRecord, assertTestString, optionalTestRecord } from './helpers/assert-value.js';
import { prepareTestHostTurn } from './helpers/kernel-host-test-api.js';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runGit } from '../src/shared/git-safe.js';
import { observeWorkspaceIdentity } from '../src/host/kernel/workspace/workspace-identity.js';
import { cleanupExecutionWorkspaces, executionRoot } from '../src/host/kernel/workspace/physical-worktree.js';
import { dispatchKernelParallel, dispatchKernelStep } from '../src/host/kernel/parallel-dispatcher.js';
import { createClaudeAdapter } from '../src/host/kernel/adapters/claude.js';
import { createKernelControlPlane } from '../src/host/kernel/control-plane-runtime.js';

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

const makeControlPlane = ({ fixture, failedStepId = null, failMaterialization = false, failRenewal = false, settlementFailureStepId = null, failReceiptPersistenceStepId = null }: FixtureOptions) => {
  const steps = makeSteps();
  const failures: unknown[] = [];
  const reports: unknown[] = [];
  const recorded: unknown[] = [];
  const ownerMutations: unknown[] = [];
  const attempts = new Map<string, FixtureAttempt>();
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
    registerExecutionWorkspace: (_runId: string, workspaceRoot: string) => ({
      workspaceId: `workspace-${path.basename(workspaceRoot)}`,
      identity: observeWorkspaceIdentity({ projectRoot: workspaceRoot }).identity,
    }),
    bindStepAttempt: async (_runId: string, step: Parameters<TestControlPlane["bindStepAttempt"]>[1]) => {
      const attempt = {
        id: steps.findIndex(item => item.stepId === step) + 1,
        runId: 'run-parallel-dispatch',
        stepId: step,
        attemptId: `attempt-${step}`,
        bindingId: `binding-${step}`,
        status: 'started',
      };
      attempts.set(attempt.attemptId, attempt);
      return attempt;
    },
    hostNext: async (_runId: string, { actionContext }: { actionContext: Record<string, unknown> }) => {
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
    updateStepAttempt: async (attemptId: string, patch = {}) => {
      const attempt = attempts.get(attemptId);
      if (attempt) Object.assign(attempt, patch);
      return attempt || null;
    },
    getAttemptById: (_runId: string, attemptId: string) => attempts.get(attemptId) || null,
    recordStepResult: async (_runId: string, stepId: string, result: Record<string, unknown> = {}) => {
      if (stepId === failReceiptPersistenceStepId) {
        throw Object.assign(new Error('simulated durable worker receipt failure'), { code: 'worker_receipt_persistence_failed' });
      }
      const attempt = attempts.get(assertTestString(result.attemptId));
      if (attempt) {
        Object.assign(attempt, {
          workspaceId: result.executionWorkspaceId || attempt.workspaceId || null,
          resultWorkspaceIdentity: result.resultWorkspaceIdentity || null,
          resultCommitSha: result.resultCommitSha || null,
          changedPaths: result.changedPaths || [],
          patchDigest: result.patchDigest || null,
          workerReport: result.workerReport || null,
        });
      }
      return attempt || null;
    },
    acquireOwnerWorkspaceMutationFence: async (_runId: string, snapshot: Record<string, unknown> = {}) => ({
      lock: { workspaceId: assertTestString(snapshot.expectedWorkspaceId), fencingToken: 1, sessionToken: 'fixture-owner' },
      snapshot,
    }),
    renewOwnerWorkspaceMutationFence: async (_runId: string, snapshot: Record<string, unknown> = {}) => {
      if (failRenewal) throw Object.assign(new Error('simulated owner fence loss before Delivery apply'), { code: 'delivery_mutation_fence_lost' });
      return {
        lock: { workspaceId: assertTestString(snapshot.workspaceId || snapshot.expectedWorkspaceId), fencingToken: assertTestNumber(snapshot.fencingToken || 1), sessionToken: assertTestString(snapshot.sessionToken || 'fixture-owner') },
        snapshot,
      };
    },
    assertOwnerWorkspaceMutationReady: async (_runId: string, mutation: Record<string, unknown> = {}) => ({ snapshot: mutation }),
    recordOwnerWorkspaceMutation: async (_runId: string, mutation: Record<string, unknown> = {}) => {
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
    settleParallelResult: async (_runId: string, payload: Record<string, unknown> = {}, options: Record<string, unknown> = {}) => {
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
    failStepAttempt: async (_runId: string, stepId: string, details: Parameters<TestControlPlane['failStepAttempt']>[2]) => failures.push({ stepId, details }),
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
    dispatchStep: async ({ step, workspace }: Parameters<NonNullable<NonNullable<Parameters<typeof dispatchKernelParallel>[0]>["dispatchStep"]>>[0]) => {
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

const runDispatch = async ({ failedStepId = null, failMaterialization = false, failRenewal = false, verificationAddsExtraPath = false, settlementFailureStepId = null, failReceiptPersistenceStepId = null, integrationVerification = null }: DispatchFixtureOptions = {}) => {
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
      prepareHost: async ({ runId, actionContext }) => controlPlane.hostNext(runId, { actionContext }),
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

const finishFixture = async ({ fixture, result }: { fixture: { projectRoot: string; runtimeHome: string }; result: unknown }) => {
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
  let seen: unknown = null;
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
      prepareHost: async ({ runId, actionContext }) => controlPlane.hostNext(runId, { actionContext }),
      prepareDispatch: async ({ hosted }) => ({
        ...hosted,
        resolution: { model: 'fixture-model', effort: 'high' },
        decision: { role: 'implementer', modelClass: 'value_coding' },
        executionCapsule: {
          ...hosted.executionCapsule,
          role: 'implementer',
          objective: 'parallel objective',
          workUnit: { objective: assertTestRecord(step).objective, allowedPaths: step.allowedPaths, expectedOutputs: step.expectedOutputs },
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
    assert.equal(assertTestRecord(seen).envelope, undefined);
    assert.equal(assertTestRecord(seen).control, undefined);
    assert.equal(assertTestRecord(seen).modelPolicy, undefined);
    assert.deepEqual(assertTestRecord(assertTestRecord(seen).modelVisiblePrompt).requiredEvidence, [{ obligationId: 'alpha-proof' }]);
    assert.doesNotMatch(assertTestString(assertTestRecord(seen).message), /host-only-run|host-only-model|nested-leak|mutationRevision|routeDecision/u);
  } finally {
    await cleanupExecutionWorkspaces({ runtimeHome: fixture.runtimeHome, projectId: 'project-parallel-dispatch', runId: 'run-parallel-dispatch', repoRoot: fixture.projectRoot, retain: false }).catch(() => {});
    await rm(fixture.runtimeHome, { recursive: true, force: true });
    await rm(fixture.projectRoot, { recursive: true, force: true });
  }
});

test('parallel success uses existing Step receipts and integrates deterministic worker results', async () => {
  const run = await runDispatch();
  try {
    assert.equal(assertTestRecord(run.result).status, 'passed', `${JSON.stringify(run.result, null, 2)}\nintegration=${optionalTestRecord(assertTestRecord(assertTestRecord(run.result).integration).error)?.stack || optionalTestRecord(assertTestRecord(assertTestRecord(run.result).integration).error)?.message || ''}\nreasons=${assertTestArray(assertTestRecord(run.result).workerResults).map((entry: unknown) => optionalTestRecord(assertTestRecord(entry).reason)?.stack || assertTestRecord(entry).reason || '').join('\n')}`);
    assert.equal(assertTestRecord(run.result).dispatched, true);
    assert.equal(assertTestArray(assertTestRecord(run.result).executionResults).length, 2);
    assert.equal(run.controlPlane.failures.length, 0);
    assert.equal(run.controlPlane.recorded.length, 2);
    assert.ok(run.controlPlane.reports.every((report) => assertTestString(assertTestRecord(report).attemptId).startsWith('attempt-step-')));
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
    assert.equal(assertTestRecord(run.result).status, 'partial-failure', `${JSON.stringify(run.result, null, 2)}\nintegration=${optionalTestRecord(assertTestRecord(assertTestRecord(run.result).integration).error)?.stack || optionalTestRecord(assertTestRecord(assertTestRecord(run.result).integration).error)?.message || ''}\nreasons=${assertTestArray(assertTestRecord(run.result).workerResults).map((entry: unknown) => optionalTestRecord(assertTestRecord(entry).reason)?.stack || assertTestRecord(entry).reason || '').join('\n')}`);
    assert.equal(assertTestArray(assertTestRecord(run.result).executionResults).length, 1);
    assert.deepEqual(run.controlPlane.failures.map((entry) => assertTestRecord(entry).stepId), ['step-beta']);
    assert.equal(run.controlPlane.recorded.length, 1);
    assert.equal(assertTestRecord(assertTestRecord(run.result).cleanup).retained, true);
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
    assert.equal(assertTestRecord(run.result).status, 'failed');
    assert.equal(assertTestRecord(assertTestRecord(run.result).integration).status, 'failed');
    assert.equal(assertTestRecord(assertTestRecord(run.result).integration).failureCode, 'delivery_observation_failed');
    assert.equal(assertTestArray(assertTestRecord(run.result).executionResults).length, 0);
    assert.equal(run.controlPlane.run.status, 'blocked');
    assert.equal(assertTestRecord(assertTestRecord(run.result).cleanup).retained, true);
    assert.equal((await readFile(path.join(run.fixture.projectRoot, 'src', 'alpha', 'result.txt'), 'utf8')).trim(), 'step-alpha');
  } finally {
    await finishFixture(run);
  }
});

test('integration verification cannot add staged paths after receipt validation', async () => {
  const run = await runDispatch({ verificationAddsExtraPath: true });
  try {
    assert.equal(assertTestRecord(run.result).status, 'failed');
    assert.equal(assertTestRecord(assertTestRecord(run.result).integration).status, 'failed');
    assert.equal(assertTestRecord(assertTestRecord(run.result).integration).failureCode, 'integration_verification_changed_paths');
    assert.equal(run.controlPlane.ownerMutations.length, 0);
    assert.equal(existsSync(path.join(run.fixture.projectRoot, 'src', 'alpha', 'result.txt')), false);
    assert.equal(assertTestRecord(assertTestRecord(run.result).cleanup).retained, true);
  } finally {
    await finishFixture(run);
  }
});

test('rejected Delivery settlements make the dispatch partial-failure instead of passed', async () => {
  const run = await runDispatch({ settlementFailureStepId: 'step-alpha' });
  try {
    assert.equal(assertTestRecord(run.result).status, 'partial-failure', JSON.stringify(run.result, null, 2));
    assert.equal(assertTestRecord(assertTestRecord(run.result).integration).status, 'integrated');
    assert.equal(assertTestArray(assertTestRecord(run.result).executionResults).length, 1);
    assert.equal(assertTestArray(assertTestRecord(run.result).settlementFailures).length, 1);
    assert.equal(assertTestRecord(assertTestArray(assertTestRecord(run.result).settlementFailures)[0]).stepId, 'step-alpha');
    assert.equal(assertTestRecord(assertTestRecord(assertTestArray(assertTestRecord(run.result).settlementFailures)[0]).reportResult).status, 'evidence-rejected');
    assert.deepEqual(run.controlPlane.failures.map((entry) => assertTestRecord(entry).stepId), ['step-alpha']);
    assert.equal(run.controlPlane.ownerMutations.length, 1);
    assert.equal(assertTestRecord(assertTestRecord(run.result).cleanup).retained, true);
  } finally {
    await finishFixture(run);
  }
});

test('post-dispatch worker receipt failure makes mixed success partial-failure', async () => {
  const run = await runDispatch({ failReceiptPersistenceStepId: 'step-alpha' });
  try {
    assert.equal(assertTestRecord(run.result).status, 'partial-failure', JSON.stringify(run.result, null, 2));
    assert.equal(assertTestRecord(assertTestRecord(run.result).integration).status, 'integrated');
    assert.equal(assertTestArray(assertTestRecord(run.result).executionResults).length, 1);
    assert.equal(assertTestArray(assertTestRecord(run.result).resultProcessingFailures).length, 1);
    assert.equal(assertTestRecord(assertTestArray(assertTestRecord(run.result).resultProcessingFailures)[0]).stepId, 'step-alpha');
    assert.equal(assertTestRecord(assertTestArray(assertTestRecord(run.result).resultProcessingFailures)[0]).failureCode, 'worker_receipt_persistence_failed');
    assert.deepEqual(run.controlPlane.failures.map((entry) => assertTestRecord(entry).stepId), ['step-alpha']);
    assert.equal(assertTestRecord(assertTestRecord(run.result).cleanup).retained, true);
  } finally {
    await finishFixture(run);
  }
});

test('non-passed integration verification fails closed before owner Delivery mutation', async () => {
  const run = await runDispatch({ integrationVerification: { status: 'blocked' } });
  try {
    assert.equal(assertTestRecord(run.result).status, 'failed');
    assert.equal(assertTestRecord(assertTestRecord(run.result).integration).status, 'failed');
    assert.equal(assertTestRecord(assertTestRecord(run.result).integration).failureCode, 'integration_verification_failed');
    assert.equal(assertTestArray(assertTestRecord(run.result).executionResults).length, 0);
    assert.equal(run.controlPlane.ownerMutations.length, 0);
    assert.equal(assertTestRecord(assertTestRecord(run.result).cleanup).retained, true);
  } finally {
    await finishFixture(run);
  }
});

test('owner fence renewal loss fails closed before Delivery apply', async () => {
  const run = await runDispatch({ failRenewal: true });
  try {
    assert.equal(assertTestRecord(run.result).status, 'failed');
    assert.equal(assertTestRecord(assertTestRecord(run.result).integration).status, 'failed');
    assert.equal(assertTestRecord(assertTestRecord(run.result).integration).failureCode, 'delivery_mutation_fence_lost');
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
  let projectId: unknown = null;
  try {
    const started = await controlPlane.startRun({ runId, objective: 'real parallel delivery', taskContract: contract });
    projectId = started.projectId;
    assert.equal(started.mutationRevision, 0);
    const executable = controlPlane.getExecutableSteps(runId);
    assert.equal(executable.mode, 'parallel', JSON.stringify(executable));
    const settleParallelResult = controlPlane.settleParallelResult.bind(controlPlane);
    let mismatchedSettlement: unknown = null;
    let forgedSettlement: unknown = null;
    let forgedWorkerReceiptSettlement: unknown = null;
    let omittedWorkerPathSettlement: unknown = null;
    let driftedSettlement: unknown = null;
    controlPlane.settleParallelResult = async (settleRunId, payload, options) => {
      if (!mismatchedSettlement) {
        mismatchedSettlement = await settleParallelResult(settleRunId, {
          ...payload,
          changedPaths: ['src/declared.txt'],
        }, options);
        forgedSettlement = await settleParallelResult(settleRunId, payload, {
          ...options,
          deliveryMutation: {
            ...assertTestPresent(options).deliveryMutation,
            deliveryWorkspaceIdentity: `sha256:${'c'.repeat(64)}`,
          },
        });
        forgedWorkerReceiptSettlement = await settleParallelResult(settleRunId, payload, {
          ...options,
          result: {
            ...assertTestPresent(options).result,
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
            ...assertTestPresent(options).deliveryMutation,
            changedPaths: ['src/beta/result.txt'],
          },
        });
        controlPlane.stateStore.getMutationProvenance = originalGetMutationProvenance;
        assert.equal(assertTestPresent(controlPlane.stateStore.getRunStep(settleRunId, assertTestString(assertTestPresent(payload).stepId))).state, 'running');
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
    assert.equal(assertTestRecord(result).status, 'passed', JSON.stringify({
      worker: assertTestArray(assertTestRecord(result).workerResults).map((entry: unknown) => assertTestRecord(entry).value ? { status: assertTestRecord(assertTestRecord(entry).value).status, failureCode: assertTestRecord(assertTestRecord(entry).value).failureCode } : { status: assertTestRecord(entry).status, reason: optionalTestRecord(assertTestRecord(entry).reason)?.message }),
      integration: { status: optionalTestRecord(assertTestRecord(result).integration)?.status, failureCode: optionalTestRecord(assertTestRecord(result).integration)?.failureCode, error: optionalTestRecord(optionalTestRecord(assertTestRecord(result).integration)?.error)?.message },
      execution: assertTestArray(assertTestRecord(result).executionResults).map((entry: unknown) => ({ stepId: assertTestRecord(entry).stepId, status: optionalTestRecord(assertTestRecord(entry).reportResult)?.status, failures: optionalTestRecord(assertTestRecord(entry).reportResult)?.failures })),
      settlementFailures: assertTestArray(assertTestRecord(result).settlementFailures).map((entry: unknown) => ({ stepId: assertTestRecord(entry).stepId, status: optionalTestRecord(assertTestRecord(entry).reportResult)?.status, failures: optionalTestRecord(assertTestRecord(entry).reportResult)?.failures, next: optionalTestRecord(assertTestRecord(entry).reportResult)?.next })),
      steps: controlPlane.stateStore.getRunSteps(runId).map((step) => ({ stepId: step.stepId, state: step.state, blockedReason: step.blockedReason })),
      verifications: controlPlane.stateStore.getVerifications(runId).map((verification) => ({ obligationId: verification.obligationId, status: verification.status, errorSummary: verification.errorSummary })),
    }, null, 2));
    assertTestRecord(assertTestRecord(result).next);
    assert.ok(
      assertTestArray(assertTestRecord(result).executionResults)
        .every((entry: unknown) => assertTestRecord(assertTestRecord(entry).reportResult).next === null),
      'individual parallel settlements defer continuation preparation until the batch boundary',
    );
    assert.equal(assertTestRecord(assertTestRecord(assertTestRecord(result).integration).deliveryMutation).mutationRevision, 1);
    assert.equal(assertTestRecord(assertTestRecord(assertTestRecord(result).integration).deliveryMutation).expectedMutationRevision, 0);
    const finalRun = await controlPlane.getRun(runId);
    assert.equal(assertTestPresent(finalRun).mutationRevision, 1);
    assert.equal(assertTestPresent(finalRun).currentWorkspaceIdentity, assertTestRecord(assertTestRecord(result).integration).deliveryWorkspaceIdentity);
    assert.equal(assertTestArray(assertTestRecord(result).executionResults).length, 2);
    assert.ok(assertTestArray(assertTestRecord(result).executionResults).every((entry: unknown) => assertTestRecord(assertTestRecord(assertTestRecord(entry).reportResult).step).state === 'passed'));
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
    assert.equal(assertTestPresent(ownerProvenance).workspaceIdentity, assertTestRecord(assertTestRecord(result).integration).deliveryWorkspaceIdentity);
    assert.deepEqual(assertTestPresent(ownerProvenance).changedPaths, ['src/alpha/result.txt', 'src/beta/result.txt']);
    assert.ok(mismatchedSettlement);
    assert.equal(assertTestRecord(mismatchedSettlement).status, 'evidence-rejected');
    assert.equal(assertTestRecord(assertTestArray(assertTestRecord(mismatchedSettlement).failures)[0]).errorCode, 'delivery_worker_paths_mismatch');
    assert.ok(forgedSettlement);
    assert.equal(assertTestRecord(forgedSettlement).status, 'evidence-rejected');
    assert.equal(assertTestRecord(assertTestArray(assertTestRecord(forgedSettlement).failures)[0]).errorCode, 'delivery_workspace_identity_stale');
    assert.ok(forgedWorkerReceiptSettlement);
    assert.equal(assertTestRecord(forgedWorkerReceiptSettlement).status, 'evidence-rejected');
    assert.equal(assertTestRecord(assertTestArray(assertTestRecord(forgedWorkerReceiptSettlement).failures)[0]).errorCode, 'delivery_worker_receipt_mismatch');
    assert.ok(omittedWorkerPathSettlement);
    assert.equal(assertTestRecord(omittedWorkerPathSettlement).status, 'evidence-rejected');
    assert.equal(assertTestRecord(assertTestArray(assertTestRecord(omittedWorkerPathSettlement).failures)[0]).errorCode, 'delivery_worker_paths_omitted');
    assert.ok(driftedSettlement);
    assert.equal(assertTestRecord(driftedSettlement).status, 'evidence-rejected');
    assert.equal(assertTestRecord(assertTestArray(assertTestRecord(driftedSettlement).failures)[0]).errorCode, 'delivery_workspace_identity_stale');

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
      (error) => assertTestRecord(error).code === 'STEP_RESULT_IMMUTABLE_CONFLICT' && assertTestRecord(error).field === 'resultCommitSha',
    );
    assert.equal(assertTestPresent(firstStep).resultAttemptId, firstAttempt.attemptId);
  } finally {
    await controlPlane.close();
    await cleanupExecutionWorkspaces({ runtimeHome: fixture.runtimeHome, projectId: assertTestString(projectId), runId, repoRoot: fixture.projectRoot, retain: false }).catch(() => {});
    await rm(fixture.runtimeHome, { recursive: true, force: true });
    await rm(fixture.projectRoot, { recursive: true, force: true });
  }
});

type TestControlPlane = Awaited<ReturnType<typeof import('../src/host/kernel/control-plane-runtime.js').createKernelControlPlane>>;
type TestStateStore = Awaited<ReturnType<typeof import('../src/kernel/state-store.js').openKernelStateStore>>;


interface FixtureOptions { fixture: Awaited<ReturnType<typeof createFixture>>; failedStepId?: string | null; failMaterialization?: boolean; failRenewal?: boolean; settlementFailureStepId?: string | null; failReceiptPersistenceStepId?: string | null }
interface DispatchFixtureOptions extends Omit<FixtureOptions, "fixture"> { verificationAddsExtraPath?: boolean; integrationVerification?: Record<string, unknown> | null }
interface FixtureAttempt extends Record<string, unknown> { id: number; runId: string; stepId: string; attemptId: string; bindingId: string; status: string }
