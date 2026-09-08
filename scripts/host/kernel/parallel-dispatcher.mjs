import path from 'node:path';
import { createHash } from 'node:crypto';
import { runGit } from '../../lib/git-safe.mjs';
import { observeWorkspaceIdentity } from '../../kernel/run/workspace-identity.mjs';
import {
  prepareExecutionWorkspaces,
  createStepResultCommit,
  canUseExecutionWorkspace,
  cleanupExecutionWorkspaces,
} from '../../kernel/workspace/step-worktree-manager.mjs';
import { executeTrustedProof } from '../../kernel/proof/proof-executor.mjs';
import { buildUsageReceipt } from './usage-receipt.mjs';
import { buildModelVisiblePromptView } from './model-capsule-view.mjs';
import { sanitizePersistentPayload } from '../../kernel/persistent-sanitizer.mjs';

const baseCommit = (repoRoot) => {
  const result = runGit(repoRoot, ['rev-parse', '--verify', 'HEAD']);
  if (result.error || result.status !== 0) return null;
  return String(result.stdout || '').trim();
};

const digest = (value) => `sha256:${createHash('sha256').update(String(value || '')).digest('hex')}`;

// The owner fence is a lease. A synchronous, unbounded `git apply` could
// outlive that lease while still changing the Delivery workspace, so the
// mutating subprocess always receives a deadline strictly before the fence
// expires. The existing post-apply CAS remains the authoritative witness.
const DELIVERY_APPLY_MAX_MS = 60_000;
const DELIVERY_APPLY_SAFETY_MS = 1_000;
export const deliveryApplyTimeoutMs = ({ expiresAt = null, now = Date.now(), maxMs = DELIVERY_APPLY_MAX_MS } = {}) => {
  const expiry = expiresAt ? Date.parse(expiresAt) : Number.NaN;
  const remaining = Number.isFinite(expiry) ? expiry - Number(now) : Number(maxMs) + DELIVERY_APPLY_SAFETY_MS;
  return Math.max(0, Math.min(Number(maxMs), Math.floor(remaining - DELIVERY_APPLY_SAFETY_MS)));
};

const normalizeHostCapabilities = (capabilities = {}) => ({
  supportsConcurrentSessions: capabilities.supportsConcurrentSessions === true,
  supportsIsolatedWorkingDirectory: capabilities.supportsIsolatedWorkingDirectory === true,
  supportsPerSessionEnvironment: capabilities.supportsPerSessionEnvironment === true,
});

export const hostSupportsParallel = (capabilities = {}) => Object.values(normalizeHostCapabilities(capabilities)).every(Boolean);

const normalizePaths = (paths = []) => [...new Set(paths.map((entry) => String(entry).replaceAll('\\', '/').replace(/^\.\//u, '')).filter(Boolean))].sort();
const pathWithin = (value, scope) => {
  const normalizedValue = String(value).replaceAll('\\', '/').toLowerCase();
  const normalizedScope = String(scope).replaceAll('\\', '/').toLowerCase().replace(/\/\*+$/u, '').replace(/\*+$/u, '').replace(/\/$/u, '');
  return normalizedValue === normalizedScope || normalizedValue.startsWith(`${normalizedScope}/`);
};
const scopeOverlaps = (left, right) => {
  const a = normalizePaths(left);
  const b = normalizePaths(right);
  return a.some((candidate) => b.some((other) => pathWithin(candidate, other) || pathWithin(other, candidate)));
};

const commandCandidates = (run, explicit = null) => [
  explicit?.commandRef,
  ...(Array.isArray(run?.taskContract?.requiredVerifications)
    ? run.taskContract.requiredVerifications.flatMap((item) => item && typeof item === 'object'
      ? (item.commandRefs || (item.commandRef ? [item.commandRef] : []))
      : [])
    : []),
  ...(Array.isArray(run?.taskContract?.acceptance)
    ? run.taskContract.acceptance.flatMap((item) => item?.evidencePlan?.commandRefs || [])
    : []),
].filter(Boolean).map(String);

// Admission is a pure check over the current Step Ledger and host facts. It
// deliberately returns no identity that would need to be persisted.
export const deriveParallelAdmission = ({
  run,
  steps = [],
  commands = [],
  hostCapabilities = {},
  git = {},
  maxWorkers = 2,
  integrationVerification = null,
} = {}) => {
  const reasons = [];
  if (run?.status !== 'active') reasons.push('run-not-active');
  if (steps.length < 2) reasons.push('fewer-than-two-executable-steps');
  if (steps.some((step) => !Array.isArray(step.allowedPaths) || step.allowedPaths.length === 0)) reasons.push('step-write-scope-missing');
  if (steps.some((step) => (step.allowedPaths || []).some((scope) => ['*', '**'].includes(String(scope).trim())))) reasons.push('unbounded-write-scope');
  if (steps.some((step) => !((step.obligationIds || []).length || (step.expectedOutputs || []).length))) reasons.push('step-verification-missing');
  if (steps.some((step, index) => steps.slice(index + 1).some((other) => scopeOverlaps(step.allowedPaths, other.allowedPaths)))) reasons.push('write-scope-overlap');
  for (const [name, supported] of Object.entries(normalizeHostCapabilities(hostCapabilities))) if (!supported) reasons.push(`host-${name}-unsupported`);
  if (git.ready === false) reasons.push(git.reason || 'git-workspace-unavailable');

  const commandRef = commandCandidates(run, integrationVerification)
    .find((candidate) => commands.some((command) => command.commandRef === candidate)) || null;
  if (!commandRef) reasons.push('integration-command-missing');
  const t3Review = run?.proofTier === 'T3'
    && (run?.independentReviewRequired === true || run?.taskContract?.flags?.independentReviewRequired === true || run?.taskContract?.independentReview === true);
  const boundedLimit = t3Review ? 3 : 2;
  return {
    admitted: reasons.length === 0,
    reasons,
    workerLimit: Math.max(1, Math.min(Number(maxWorkers) || 2, boundedLimit, steps.length)),
    integrationVerification: commandRef ? { commandRef } : null,
  };
};

const fallback = async ({ sequentialDispatcher, reason, context }) => {
  if (typeof sequentialDispatcher === 'function') return sequentialDispatcher(context);
  return { schemaVersion: 1, dispatched: false, fallback: true, reason };
};

const dispatchDefaultStep = async ({ adapter, hosted, dispatchContext = null, workspace, parentSessionId, parentSessionConfig = null, runId, step, env = process.env }) => {
  if (!adapter?.dispatch) throw new Error('parallel worker adapter requires dispatch');
  const context = dispatchContext || hosted;
  if (!context.resolution) throw Object.assign(new Error('parallel worker dispatch requires an admitted model resolution'), { code: 'WORKER_ROUTE_UNRESOLVED' });
  const capsule = context.executionCapsule
    ? { ...context.executionCapsule, permissions: { ...context.executionCapsule.permissions, canCommit: false, canDelegate: false } }
    : null;
  const executionMode = context.hostDirective?.executionAssignment?.executionMode
    || hosted.hostDirective?.executionAssignment?.executionMode
    || null;
  const delegationRequested = context.hostDirective?.executionAssignment?.delegation?.requested === true
    || hosted.hostDirective?.executionAssignment?.delegation?.requested === true;
  const decision = context.decision || context.hostDirective?.modelRouteDecision || hosted.hostDirective?.modelRouteDecision || {};
  // Ignore any caller-provided projection. The adapter will reproject this
  // current capsule again at the provider boundary.
  const modelInput = context.modelInput || hosted.modelInput || { action: { type: 'implement' } };
  const modelVisiblePrompt = buildModelVisiblePromptView({ modelInput, capsule });
  return adapter.dispatch({
    decision,
    resolution: context.resolution,
    strategy: context.strategy || context.hostDirective?.enforcementStrategy || hosted.hostDirective?.enforcementStrategy || 'isolated',
    executionCapsule: capsule,
    modelInput,
    modelVisiblePrompt,
    executionContract: context.executionContract || hosted.executionContract || {
      objective: step.objective,
      role: 'worker',
      permissions: { filesystem: 'workspace_write', canCommit: false, canDelegate: false },
      action: { type: 'implement', guidance: step.objective },
    },
    envelope: context.envelope || hosted.envelope || null,
    workingDirectory: workspace.workspaceRoot,
    environment: {
      ...env,
      MOON_RELAY_KERNEL_RUN_ID: context.runId || hosted.runId || runId,
      MOON_RELAY_KERNEL_STEP_ID: step.stepId,
      MOON_RELAY_KERNEL_WORKSPACE_ID: workspace.workspaceId,
      MOON_RELAY_KERNEL_SESSION_ID: context.actorSessionId || hosted.actorSessionId || `worker:${step.stepId}`,
    },
    parentSessionId,
    parentSessionConfig,
    concurrencyGroup: runId,
    childSession: { parentSessionId, maxNestedAgents: 0, canDelegate: false, canCommit: false },
    executionMode,
    delegationRequested,
    actionContext: { executionMode, delegationRequested },
  });
};

export const dispatchKernelStep = async ({
  controlPlane,
  runId,
  step,
  workspace,
  adapter,
  hostCapabilities,
  parentSessionId = null,
  parentSessionConfig = null,
  actionContext = {},
  dispatchStep = null,
  prepareDispatch = null,
  env = process.env,
  deferReport = false,
} = {}) => {
  let boundAttempt = null;
  if (controlPlane?.bindStepAttempt) {
    boundAttempt = await controlPlane.bindStepAttempt(runId, step.stepId, {
      actorSessionId: `${parentSessionId || 'parent'}:worker:${step.stepId}`,
      workspaceId: workspace.workspaceId,
      workspaceIdentity: workspace.baseWorkspaceIdentity,
      baseWorkspaceIdentity: workspace.baseWorkspaceIdentity,
    });
  }
  const hosted = controlPlane?.hostNext
    ? await controlPlane.hostNext(runId, {
      hostCapabilities,
      actionContext: {
        ...actionContext,
        stepId: step.stepId,
        attemptId: boundAttempt?.attemptId || null,
        workingDirectory: workspace.workspaceRoot,
        workspaceId: workspace.workspaceId,
        workspaceIdentity: workspace.baseWorkspaceIdentity,
        parentSessionId,
        workProfile: step.workProfile || actionContext.workProfile || null,
        complexity: step.complexity || actionContext.complexity || null,
      },
    })
    : { runId, executionCapsule: null, hostDirective: {}, modelInput: { action: { type: 'implement' } } };
  if (hosted.status === 'not_found') return { status: 'failed', failureCode: 'run-not-found', hosted };
  if (boundAttempt && hosted.executionCapsule && controlPlane?.updateStepAttempt) {
    const updatedAttempt = await controlPlane.updateStepAttempt(boundAttempt.id, {
      capsuleId: hosted.executionCapsule.capsuleId,
      capsuleDigest: hosted.executionCapsule.provenance?.capsuleDigest || null,
    });
    if (updatedAttempt && typeof updatedAttempt === 'object' && updatedAttempt.attemptId) boundAttempt = updatedAttempt;
  }
  const dispatchContext = typeof prepareDispatch === 'function'
    ? await prepareDispatch({ hosted, step, workspace, parentSessionId })
    : null;
  if (dispatchContext?.status === 'failed') return { status: 'failed', failureCode: dispatchContext.failureCode || 'worker-route-rejected', hosted, dispatchContext, attempt: boundAttempt };
  if (!dispatchContext && typeof dispatchStep !== 'function') return { status: 'failed', failureCode: 'worker-route-unresolved', hosted, attempt: boundAttempt };

  let result;
  try {
    result = await (typeof dispatchStep === 'function'
      ? dispatchStep({ hosted, dispatchContext, adapter, step, workspace, parentSessionId, parentSessionConfig })
      : dispatchDefaultStep({ adapter, hosted, dispatchContext, workspace, parentSessionId, parentSessionConfig, runId, step, env }));
  } catch (error) {
    result = { status: 'failed', resultStatus: 'failed', errorSummary: error?.message || String(error), failureCategory: 'provider/infrastructure' };
  }
  result = sanitizePersistentPayload(result);
  const usageContext = dispatchContext || hosted;
  const usageDecision = usageContext.decision || usageContext.hostDirective?.modelRouteDecision || hosted.hostDirective?.modelRouteDecision;
  const usageAttempt = boundAttempt || usageContext.hostDirective?.attempt || null;
  if (usageDecision && usageContext.resolution && usageContext.admission && controlPlane?.recordModelUsage) {
    const usageReceipt = buildUsageReceipt({
      decision: usageDecision,
      capabilities: hostCapabilities,
      strategy: usageContext.strategy || usageContext.hostDirective?.enforcementStrategy || 'unsupported',
      resolution: usageContext.resolution,
      dispatch: result || {},
      capsule: usageContext.executionCapsule || hosted.executionCapsule || null,
      admission: usageContext.admission,
      attemptId: usageAttempt?.attemptId || usageContext.hostDirective?.attemptId || null,
      bindingId: usageAttempt?.bindingId || null,
      actorSessionId: result?.actorSessionId || `${hostCapabilities.surface}:${usageDecision.decisionId}`,
      parentSessionId,
      startedAt: result?.startedAt || null,
      finishedAt: result?.finishedAt || new Date().toISOString(),
      envelope: usageContext.envelope || hosted.envelope || null,
    });
    await controlPlane.recordModelUsage(runId, usageReceipt);
    if (boundAttempt?.attemptId) boundAttempt = controlPlane.stateStore?.getStepAttemptByAttemptId?.(boundAttempt.attemptId, { runId }) || boundAttempt;
  }
  const workerReport = result?.report || result?.kernelReport || null;
  let reportResult = null;
  if (workerReport && !deferReport && controlPlane?.report) {
    reportResult = await controlPlane.report(runId, {
      ...workerReport,
      stepId: step.stepId,
      attemptId: boundAttempt?.attemptId || workerReport.attemptId,
      capsuleId: hosted.executionCapsule?.capsuleId || workerReport.capsuleId,
      workspaceId: workspace.workspaceId,
      bindingId: boundAttempt?.bindingId || workerReport.bindingId,
      assignmentId: workerReport.assignmentId || hosted.hostDirective?.executionAssignment?.assignmentId || null,
      actorSessionId: result?.actorSessionId || boundAttempt?.actorSessionId || workerReport.actorSessionId,
    });
  }
  const workerCompleted = ['passed', 'completed', 'success'].includes(result?.status || result?.resultStatus);
  const reportAccepted = deferReport ? Boolean(workerReport) : reportResult?.step?.state === 'passed';
  return {
    status: workerCompleted && reportAccepted ? 'passed' : 'failed',
    failureCode: !workerReport ? 'worker-report-missing' : !reportAccepted ? reportResult?.status || 'worker-report-not-passed' : null,
    result,
    workerReport,
    reportResult,
    hosted,
    dispatchContext,
    attempt: boundAttempt,
  };
};

const git = (root, args, options = {}) => {
  const result = runGit(root, args, { maxBuffer: 64 * 1024 * 1024, ...options });
  if (result.error || result.status !== 0) throw Object.assign(new Error(String(result.stderr || '').trim() || `git ${args[0]} failed`), { code: 'PARALLEL_INTEGRATION_FAILED', result });
  return String(result.stdout || '');
};

const stagedPaths = (root) => normalizePaths(git(root, ['diff', '--name-only', '--cached', '--']).split(/\r?\n/u).filter(Boolean));

const integrateParallelResults = async ({ run, steps, results, integrationWorkspace, deliveryWorkspace, integrationVerification, executeIntegrationVerification, materializeDelivery, runtimeHome, projectRoot, runId }) => {
  const ordered = [...results].sort((left, right) => (steps.find((step) => step.stepId === left.stepId)?.sequence || 0) - (steps.find((step) => step.stepId === right.stepId)?.sequence || 0));
  const base = run.baseCommitSha || git(integrationWorkspace.workspaceRoot, ['rev-parse', 'HEAD']).trim();
  const preIntegrationIdentity = observeWorkspaceIdentity({ projectRoot: integrationWorkspace.workspaceRoot }).identity;
  try {
    if (git(integrationWorkspace.workspaceRoot, ['rev-parse', 'HEAD']).trim() !== base) throw new Error('parallel integration base changed');
    for (const result of ordered) {
      const step = steps.find((candidate) => candidate.stepId === result.stepId);
      if (!step || !result.resultCommitSha) throw new Error(`missing execution result for ${result.stepId || '<unknown>'}`);
      for (const changedPath of result.changedPaths || []) {
        if (!(step.allowedPaths || []).some((scope) => pathWithin(changedPath, scope)) || (step.forbiddenPaths || []).some((scope) => pathWithin(changedPath, scope))) {
          throw new Error(`execution result path is outside Step scope: ${changedPath}`);
        }
      }
      git(integrationWorkspace.workspaceRoot, ['cherry-pick', '--no-commit', result.resultCommitSha]);
    }
    const integratedPaths = stagedPaths(integrationWorkspace.workspaceRoot);
    const declaredPaths = normalizePaths(ordered.flatMap((result) => result.changedPaths || []));
    if (JSON.stringify(integratedPaths) !== JSON.stringify(declaredPaths)) {
      throw Object.assign(new Error('integrated diff does not match execution receipts'), { code: 'integration_receipt_paths_mismatch' });
    }
    const preVerificationPatch = git(integrationWorkspace.workspaceRoot, ['diff', '--cached', '--binary', base]);
    const verification = await executeIntegrationVerification({
      commandRef: integrationVerification.commandRef,
      workspaceRoot: integrationWorkspace.workspaceRoot,
      run,
      steps,
    });
    if (!verification || verification.status !== 'passed' || verification.passed !== true) {
      throw Object.assign(new Error('parallel integration verification failed'), { code: 'integration_verification_failed' });
    }
    // Verification is trusted proof, not a second mutation authority. Re-read
    // both the staged path set and the exact patch after it runs so a helper
    // that stages an extra file (or changes an integrated file) cannot smuggle
    // content into Delivery outside the execution receipts.
    const postVerificationPaths = stagedPaths(integrationWorkspace.workspaceRoot);
    const postVerificationPatch = git(integrationWorkspace.workspaceRoot, ['diff', '--cached', '--binary', base]);
    if (JSON.stringify(postVerificationPaths) !== JSON.stringify(integratedPaths)
      || JSON.stringify(postVerificationPaths) !== JSON.stringify(declaredPaths)
      || postVerificationPatch !== preVerificationPatch) {
      throw Object.assign(new Error('integration verification changed the staged Delivery patch'), { code: 'integration_verification_changed_paths' });
    }
    const integrationIdentity = observeWorkspaceIdentity({ projectRoot: integrationWorkspace.workspaceRoot }).identity;
    const patch = postVerificationPatch;
    if (!patch) throw Object.assign(new Error('delivery_patch_empty'), { code: 'delivery_patch_empty' });
    if (typeof materializeDelivery !== 'function') {
      throw Object.assign(new Error('delivery_authority_unavailable'), { code: 'delivery_authority_unavailable' });
    }
    const deliveryMutation = await materializeDelivery({
      patch,
      baseCommit: base,
      integrationWorkspaceIdentity: integrationIdentity,
      changedPaths: integratedPaths,
      deliveryRoot: deliveryWorkspace.workspaceRoot || projectRoot,
    });
    return {
      status: 'integrated',
      deliveryWorkspaceIdentity: deliveryMutation.deliveryWorkspaceIdentity,
      integrationWorkspaceIdentity: integrationIdentity,
      preIntegrationIdentity,
      changedPaths: integratedPaths,
      verification,
      patch,
      deliveryMutation,
    };
  } catch (error) {
    try { runGit(integrationWorkspace.workspaceRoot, ['cherry-pick', '--abort']); } catch {}
    return { status: 'failed', failureCode: error.code || 'parallel-integration-failed', error, changedPaths: [] };
  }
};

export const dispatchKernelParallel = async ({
  controlPlane,
  runId,
  adapter,
  projectRoot,
  runtimeHome,
  parentSessionId = null,
  parentSessionConfig = null,
  env = process.env,
  actionContext = {},
  sequentialDispatcher = null,
  dispatchStep = null,
  prepareDispatch = null,
  executeIntegrationVerification = null,
} = {}) => {
  const executable = await controlPlane.getExecutableSteps(runId);
  if ((executable.steps || []).length < 2 || executable.mode !== 'parallel') {
    return fallback({ sequentialDispatcher, reason: executable.reason || 'sequential-fast-path', context: { runId, executable } });
  }
  const run = controlPlane.getRun ? await controlPlane.getRun(runId) : controlPlane.stateStore?.getRun(runId);
  const repoRoot = projectRoot || controlPlane.projectRoot;
  const commands = controlPlane.discoverProjectCommands ? controlPlane.discoverProjectCommands() : [];
  const gitCheck = repoRoot ? canUseExecutionWorkspace(repoRoot) : { ready: false, reason: 'project-root-missing' };
  const admission = deriveParallelAdmission({ run, steps: executable.steps, commands, hostCapabilities: adapter?.capabilities || {}, git: gitCheck, maxWorkers: executable.steps.length, integrationVerification: actionContext.integrationVerification || null });
  if (!admission.admitted || !hostSupportsParallel(adapter?.capabilities || {})) {
    return fallback({ sequentialDispatcher, reason: admission.reasons[0] || 'parallel-unavailable', context: { runId, executable, admission } });
  }
  const base = baseCommit(repoRoot);
  if (!base) return fallback({ sequentialDispatcher, reason: 'head-unavailable', context: { runId, executable } });
  const deliveryIdentity = observeWorkspaceIdentity({ projectRoot: repoRoot }).identity;
  const deliverySnapshot = {
    expectedMutationRevision: Number(run?.mutationRevision || 0),
    expectedWorkspaceIdentity: run?.currentWorkspaceIdentity || deliveryIdentity,
    expectedHeadCommitSha: base,
    expectedProjectId: run?.projectId || null,
    expectedWorktreeId: run?.worktreeId || null,
    expectedWorkspaceId: run?.workspaceId || null,
  };
  if (run?.currentWorkspaceIdentity && run.currentWorkspaceIdentity !== deliveryIdentity) {
    return { schemaVersion: 1, runId, dispatched: false, status: 'failed', failureCode: 'delivery_workspace_drift', deliverySnapshot };
  }
  if (!controlPlane?.acquireOwnerWorkspaceMutationFence
    || !controlPlane?.renewOwnerWorkspaceMutationFence
    || !controlPlane?.assertOwnerWorkspaceMutationReady
    || !controlPlane?.recordOwnerWorkspaceMutation
    || !controlPlane?.releaseOwnerWorkspaceMutationFence
    || !controlPlane?.settleParallelResult
    || !controlPlane?.blockDeliveryMaterialization
    || !controlPlane?.recordStepResult) {
    return fallback({ sequentialDispatcher, reason: 'delivery-authority-unavailable', context: { runId, executable, deliverySnapshot } });
  }
  let workspaces;
  try {
    workspaces = await prepareExecutionWorkspaces({ repoRoot, baseCommit: base, runId, projectId: run.projectId, runtimeHome, controlPlane: controlPlane.stateStore, stateStore: controlPlane.stateStore, steps: executable.steps });
  } catch (error) {
    return fallback({ sequentialDispatcher, reason: 'execution-workspace-preparation-failed', context: { runId, executable, error } });
  }
  const workspaceByStep = new Map(workspaces.steps.map((workspace) => [workspace.stepId, workspace]));
  const dispatched = await Promise.allSettled((executable.steps || []).map((step) => dispatchKernelStep({
    controlPlane,
    runId,
    step,
    workspace: workspaceByStep.get(step.stepId),
    adapter,
    hostCapabilities: adapter.capabilities || {},
    parentSessionId,
    parentSessionConfig,
    actionContext,
    dispatchStep,
    prepareDispatch,
    env,
    deferReport: true,
  })));
  const successful = [];
  const dispatchFailures = [];
  const resultProcessingFailures = [];
  for (let index = 0; index < dispatched.length; index += 1) {
    const entry = dispatched[index];
    const step = executable.steps[index];
    if (entry.status !== 'fulfilled' || entry.value.status !== 'passed') {
      const failureCode = entry.status === 'rejected' ? entry.reason?.code || 'worker-dispatch-failed' : entry.value.failureCode || 'worker-failed';
      dispatchFailures.push({ stepId: step.stepId, failureCode });
      if (controlPlane.failStepAttempt) await controlPlane.failStepAttempt(runId, step.stepId, { code: failureCode });
      continue;
    }
    try {
      const commit = createStepResultCommit({ workspaceRoot: workspaceByStep.get(step.stepId).workspaceRoot, runId, stepId: step.stepId, attemptNumber: step.attemptCount + 1 });
      if (!commit.commitSha) throw new Error(`worker ${step.stepId} produced no result commit`);
      const workspace = workspaceByStep.get(step.stepId);
      const resultWorkspaceIdentity = observeWorkspaceIdentity({ projectRoot: workspace.workspaceRoot }).identity;
      const executionReceipt = {
        stepId: step.stepId,
        step,
        workspace,
        outcome: entry.value,
        resultCommitSha: commit.commitSha,
        changedPaths: commit.changedPaths,
        patchDigest: commit.patch ? digest(commit.patch) : null,
        resultWorkspaceIdentity,
      };
      // Persist the worker's complete execution receipt before the owner
      // mutation. Delivery settlement is allowed to consume only this
      // canonical State Store row, never a dispatcher-memory projection.
      const attemptId = entry.value.attempt?.attemptId || entry.value.workerReport?.attemptId || null;
      if (!attemptId) throw Object.assign(new Error(`worker ${step.stepId} produced no canonical attempt id`), { code: 'worker_receipt_persistence_failed' });
      await controlPlane.recordStepResult(runId, step.stepId, {
        attemptId,
        executionWorkspaceId: workspace.workspaceId,
        mutationRevision: entry.value.attempt?.mutationRevision ?? run?.mutationRevision ?? 0,
        resultWorkspaceIdentity,
        resultCommitSha: commit.commitSha,
        changedPaths: commit.changedPaths,
        patchDigest: executionReceipt.patchDigest,
        workerReport: entry.value.workerReport,
        recordMutationProvenance: false,
      });
      const persistedAttempt = controlPlane.stateStore?.getStepAttemptByAttemptId?.(attemptId, { runId }) || null;
      if (controlPlane.stateStore && (!persistedAttempt
        || persistedAttempt.attemptId !== attemptId
        || persistedAttempt.workspaceId !== workspace.workspaceId
        || persistedAttempt.resultWorkspaceIdentity !== resultWorkspaceIdentity
        || persistedAttempt.resultCommitSha !== commit.commitSha
        || JSON.stringify(persistedAttempt.changedPaths || []) !== JSON.stringify(commit.changedPaths || [])
        || persistedAttempt.patchDigest !== executionReceipt.patchDigest
        || JSON.stringify(persistedAttempt.workerReport || null) !== JSON.stringify(entry.value.workerReport || null))) {
        throw Object.assign(new Error(`worker ${step.stepId} execution receipt was not durably persisted`), { code: 'worker_receipt_persistence_failed' });
      }
      successful.push(executionReceipt);
    } catch (error) {
      resultProcessingFailures.push({
        stepId: step.stepId,
        failureCode: error.code || 'worker-result-commit-failed',
        errorSummary: error.message || String(error),
      });
      if (controlPlane.failStepAttempt) await controlPlane.failStepAttempt(runId, step.stepId, { code: error.code || 'worker-result-commit-failed' });
    }
  }
  const integrationRunner = executeIntegrationVerification || (async ({ commandRef, workspaceRoot }) => {
    const execution = executeTrustedProof({ projectRoot: workspaceRoot, commandRef, evidenceDir: path.join(runtimeHome, 'evidence', run.projectId, runId, 'parallel-integration') });
    return { status: execution.status, passed: execution.status === 'passed', evidenceRef: execution.evidenceRef, verificationRef: execution.evidenceRef, execution };
  });
  const integration = successful.length > 0
    ? await integrateParallelResults({
      run: { ...run, baseCommitSha: base },
      steps: executable.steps,
      results: successful,
      integrationWorkspace: workspaces.integration,
      deliveryWorkspace: { workspaceRoot: repoRoot },
      integrationVerification: admission.integrationVerification,
      executeIntegrationVerification: integrationRunner,
      materializeDelivery: async ({ patch, integrationWorkspaceIdentity, changedPaths }) => {
        if (path.resolve(repoRoot) !== path.resolve(controlPlane.projectRoot || repoRoot)) {
          throw Object.assign(new Error('delivery_workspace_mismatch'), { code: 'delivery_workspace_mismatch' });
        }
        let ownerFence = null;
        let applyAttempted = false;
        let primaryError = null;
        try {
          ownerFence = await controlPlane.acquireOwnerWorkspaceMutationFence(runId, deliverySnapshot);
          const check = runGit(repoRoot, ['apply', '--check', '--binary', '-'], { input: patch, maxBuffer: 64 * 1024 * 1024 });
          if (check.error || check.status !== 0) throw Object.assign(new Error(String(check.stderr || '').trim() || 'delivery patch check failed'), { code: 'delivery_patch_check_failed' });
          // The check itself can take long enough for the owner lease to
          // expire. Renew and re-run the full owner CAS immediately before the
          // mutating git apply; a lost/reissued fence therefore fails closed
          // before any Delivery bytes are changed.
          ownerFence = await controlPlane.renewOwnerWorkspaceMutationFence(runId, {
            ...deliverySnapshot,
            workspaceId: ownerFence.lock.workspaceId,
            fencingToken: ownerFence.lock.fencingToken,
            sessionToken: ownerFence.lock.sessionToken,
          });
          await controlPlane.assertOwnerWorkspaceMutationReady(runId, {
            ...deliverySnapshot,
            workspaceId: ownerFence.lock.workspaceId,
            fencingToken: ownerFence.lock.fencingToken,
            sessionToken: ownerFence.lock.sessionToken,
            integrationWorkspaceIdentity,
            changedPaths,
            patchDigest: digest(patch),
          });
          applyAttempted = true;
          const applyTimeoutMs = deliveryApplyTimeoutMs({ expiresAt: ownerFence.lock.expiresAt });
          if (applyTimeoutMs <= 0) {
            throw Object.assign(new Error('delivery mutation fence has insufficient remaining lease for patch apply'), { code: 'delivery_mutation_fence_lost' });
          }
          const apply = runGit(repoRoot, ['apply', '--binary', '-'], {
            input: patch,
            maxBuffer: 64 * 1024 * 1024,
            timeout: applyTimeoutMs,
            killSignal: 'SIGTERM',
          });
          if (apply.error || apply.status !== 0) {
            const timedOut = apply.error?.code === 'ETIMEDOUT';
            throw Object.assign(new Error(String(apply.stderr || '').trim() || (timedOut ? 'delivery patch apply exceeded the owner fence deadline' : 'delivery patch failed')), {
              code: timedOut ? 'delivery_patch_apply_timeout' : 'delivery_patch_apply_failed',
            });
          }
          const mutation = await controlPlane.recordOwnerWorkspaceMutation(runId, {
            ...deliverySnapshot,
            fencingToken: ownerFence.lock.fencingToken,
            sessionToken: ownerFence.lock.sessionToken,
            integrationWorkspaceIdentity,
            changedPaths,
            patchDigest: digest(patch),
          });
          return { ...mutation, snapshot: deliverySnapshot };
        } catch (error) {
          primaryError = error;
          if (applyAttempted) {
            try {
              await controlPlane.blockDeliveryMaterialization(runId, {
                reason: 'delivery_materialization_recovery_required',
                detail: error.message,
              });
            } catch (recoveryError) {
              error.recoveryError = recoveryError;
            }
          }
          throw error;
        } finally {
          if (ownerFence) {
            try {
              await controlPlane.releaseOwnerWorkspaceMutationFence(runId, {
                workspaceId: ownerFence.lock.workspaceId,
                fencingToken: ownerFence.lock.fencingToken,
                sessionToken: ownerFence.lock.sessionToken,
              });
            } catch (releaseError) {
              if (primaryError) primaryError.releaseError = releaseError;
              else {
                try {
                  await controlPlane.blockDeliveryMaterialization(runId, {
                    reason: 'delivery_materialization_recovery_required',
                    detail: releaseError.message,
                  });
                } catch (recoveryError) {
                  releaseError.recoveryError = recoveryError;
                }
                throw releaseError;
              }
            }
          }
        }
      },
      runtimeHome,
      projectRoot: repoRoot,
      runId,
    })
    : { status: 'failed', failureCode: 'no-successful-worker-result' };

  const reported = [];
  const settlementFailures = [];
  if (integration.status === 'integrated') {
    for (const item of successful) {
      const workerReport = item.outcome.workerReport;
      const reportResult = workerReport && controlPlane.settleParallelResult
        ? await controlPlane.settleParallelResult(runId, {
           ...workerReport,
           stepId: item.step.stepId,
           attemptId: item.outcome.attempt?.attemptId || workerReport.attemptId,
           capsuleId: item.outcome.attempt?.capsuleId || workerReport.capsuleId,
           workspaceId: item.workspace.workspaceId,
           bindingId: item.outcome.attempt?.bindingId || workerReport.bindingId,
           actorSessionId: item.outcome.result?.actorSessionId || item.outcome.attempt?.actorSessionId || workerReport.actorSessionId,
         }, {
           deliveryMutation: integration.deliveryMutation,
           result: {
             attemptId: item.outcome.attempt?.attemptId || workerReport.attemptId || null,
             executionWorkspaceId: item.workspace.workspaceId,
             workerWorkspaceIdentity: item.workspace.baseWorkspaceIdentity,
             resultWorkspaceIdentity: item.resultWorkspaceIdentity,
             resultCommitSha: item.resultCommitSha,
             changedPaths: item.changedPaths,
             patchDigest: item.patchDigest,
             workerReport,
           },
         })
        : null;
      if (reportResult?.step?.state === 'passed') {
        const result = { ...item, attempt: item.outcome.attempt, receiptDigest: reportResult.step.resultDigest };
        reported.push({ ...item, reportResult });
      } else if (controlPlane.failStepAttempt) {
        settlementFailures.push({ stepId: item.step.stepId, reportResult });
        await controlPlane.failStepAttempt(runId, item.step.stepId, { code: reportResult?.status || 'worker-report-not-passed' });
      }
    }
  }
  const failed = dispatchFailures.length + resultProcessingFailures.length + settlementFailures.length;
  const cleanup = integration.status === 'integrated' && failed === 0
    ? await cleanupExecutionWorkspaces({ runtimeHome, projectId: run.projectId, runId, repoRoot, retain: false })
    : await cleanupExecutionWorkspaces({ runtimeHome, projectId: run.projectId, runId, repoRoot, retain: true });
  return {
    schemaVersion: 1,
    runId,
    dispatched: true,
    status: integration.status === 'integrated' && settlementFailures.length === 0 && failed === 0
      ? 'passed'
      : integration.status === 'integrated' ? 'partial-failure' : 'failed',
    workerResults: dispatched,
    dispatchFailures,
    resultProcessingFailures,
    executionResults: reported,
    settlementFailures,
    integration,
    deliveryMutation: integration.deliveryMutation || null,
    cleanup,
    baseWorkspaceIdentity: deliveryIdentity,
  };
};

export const dispatchKernelRun = (options = {}) => dispatchKernelParallel(options);
