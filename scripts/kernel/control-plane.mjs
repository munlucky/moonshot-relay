import { createHash } from 'node:crypto';
import path from 'node:path';
import { openKernelStateStore } from './state-store.mjs';
import { canonicalJson } from './canonical-digest.mjs';
import { buildContextReceipt } from './context-build.mjs';
import { resolveProofRoute } from './proof-route.mjs';
import { buildExecutionAssignmentId, normalizeHostCapabilities, resolveEnforcementStrategy, summarizeModelRouting } from './run/model-route-contract.mjs';
import { buildReleaseEvidencePack } from './evidence-pack.mjs';
import { projectRunState, buildResumeView } from './state-projector.mjs';
import { resolveKernelRuntimeHome } from './runtime-home.mjs';
import { KERNEL_POLICY, KernelPrinciplesError, loadKernelPrinciples } from './policy.mjs';
import { resolveKernelCapabilities } from './capability-resolver.mjs';
import { buildCandidateIdentity, gitTreeDigest, sha256Hex } from '../lib/candidate-identity.mjs';
import { resolveKernelProjectIdentity } from './project-identity.mjs';
import { ensureKnowledgeStoreDirectories } from './knowledge/store.mjs';
import { buildProjectKnowledgeContext } from './knowledge/context-load.mjs';
import { retryGitCloseout as retryGitCloseoutHelper } from './git/closeout.mjs';
import { finalizeRun, recordKnowledgeObservations } from './run/finalization.mjs';
import { normalizeChangedContract } from './change-contract.mjs';
import { observeWorkspaceIdentity, observeScopedWorkspaceIdentity, deriveRunChangedPaths } from './run/workspace-identity.mjs';
import { executeTrustedProof, executeApprovedProof, executeWithFlakyRerun, UntrustedCommandError, CommandApprovalRequiredError } from './proof/proof-executor.mjs';
import { NetworkPolicyUnenforceableError } from './proof/network-policy.mjs';
import { buildNextPayload, normalizeReport, planStatePath, planRouteSteps } from './run/run-loop.mjs';
import { detectProjectMode } from './task/project-mode.mjs';
import {
  normalizeTaskContract,
  applyEvidencePlans,
  assertEvidencePlanSubmission,
  normalizeAcceptanceCoverage,
  mergeContractRevisionWithBindings,
  replaceContractRevisionWithBindings,
  contractBriefing,
  riskSummaryFromContract,
} from './task/task-contract.mjs';
import {
  compileRunObligations,
  assertCommandBinding,
  assertVerificationSupport,
  selectBoundCommandRef,
  authoritativeVerificationScope,
  deriveVerificationSettlementScope,
  rebindProofPolicyCommands,
  ObligationBindingError,
} from './run/obligation-compiler.mjs';
import { discoverProjectCommands } from './proof/command-catalog.mjs';
import { resolveHostSessionHolder, REPORT_LEASE_TTL_MS, SESSION_LEASE_TTL_MS } from './run/session-holder.mjs';
import { digestOfEvidence, digestOfPaths, evaluateReviewReceipt, reviewEvidenceRef } from './proof/review-receipt.mjs';
import { isProtectedObligation } from './proof/protected-obligations.mjs';
import { hashSessionId } from './run/model-route-contract.mjs';
import { scanRepositoryEvidence } from './task/evidence-scan.mjs';
import { allStepsPassed, currentStep as selectCurrentStep } from './run/run-step-ledger.mjs';
import { planRunSteps } from './run/step-planner.mjs';
import { createWorkCursorApi } from './run/work-cursor.mjs';
import { admitRoute, admissionAllowsDispatch } from './routing/route-admission.mjs';
import { captureBaselineProof } from './proof/baseline-proof.mjs';
import { classifyFailures } from './proof/failure-classify.mjs';
import { computeCompletionView } from './run/completion-view.mjs';
import { assertMutationAllowed } from './run/mutation-guard.mjs';
import { assertRequiredHostCapabilities } from './run/required-host-capabilities.mjs';
import { assertBoundRunAccess, bindingErrorPayload } from './run/binding-preflight.mjs';
import { normalizeSessionBinding } from './run/session-binding.mjs';
import { canonicalizeHostSessionId } from './run/host-session.mjs';
import { resolveBoundInvocation as resolveInvocation } from './run/invocation-resolver.mjs';
import { buildSuccessorKey } from './run/successor-key.mjs';
import { registerKernelWorktreeBinding, assertRunWorktreeMutationAuthority } from './run/worktree-binding.mjs';
import { resolveRunArtifactPaths } from './artifact-paths.mjs';
import { writeRunLocator } from './run/run-locator.mjs';
import { buildStructuredRunSignals, failureFingerprint } from './knowledge/capture.mjs';
import { buildKnowledgeAuthorityView } from './knowledge/knowledge-authority.mjs';
import { buildEvidenceIdentity, buildEvidenceReuseReceipt, VERIFICATION_SCOPE_FIELD, EVIDENCE_IDENTITY_FIELDS } from './proof/evidence-reuse.mjs';
import { assertImplementationWorkUnitScope, workUnitScopeFailure } from './run/work-unit-scope.mjs';
import { preflightTaskContract } from './run/contract-preflight.mjs';
import { buildReviewCapsule, capsuleStaleness } from './run/execution-capsule.mjs';
import { buildHostExecutionContract } from './run/host-execution-contract.mjs';
import { buildWorkAuthorityView } from './run/work-authority.mjs';
import { buildTrustAuthorityView } from './proof/trust-authority.mjs';
import { digestOfChangedFiles, findScopeViolations } from './run/capsule-selection.mjs';
import { assertOwnerWorkspaceMutationCAS } from './run/mutation-guard.mjs';
import { actionKindForModelAction, createHostRoutingBridge } from './bridge/host-routing.mjs';
import { buildCoordinatorSurface } from './bridge/coordinator-surface.mjs';

const canonicalChangedPaths = (paths) => [...new Set((Array.isArray(paths) ? paths : [])
  .map((entry) => String(entry).replaceAll('\\', '/').replace(/^\.\//u, ''))
  .filter(Boolean))].sort();

const canonicalReceiptValue = (value) => {
  if (Array.isArray(value)) return value.map((entry) => canonicalReceiptValue(entry));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalReceiptValue(value[key])]));
};

const receiptValuesEqual = (left, right, { paths = false } = {}) => JSON.stringify(
  canonicalReceiptValue(paths ? canonicalChangedPaths(left) : left),
) === JSON.stringify(canonicalReceiptValue(paths ? canonicalChangedPaths(right) : right));

// Report idempotency is keyed by the complete normalized report, not only by
// its verification fields. Two attempts can target the same workspace and
// command while carrying different summaries, judgments, closeout requests,
// or knowledge observations; collapsing those attempts would erase retry and
// stagnation evidence. Canonical serialization keeps equivalent object-key
// orderings on the same key while ignoring unknown caller fields through the
// report normalizer.
const reportIdempotencyKey = ({ runId, payload, workspaceIdentity } = {}) => {
  const normalized = normalizeReport(payload || {});
  return createHash('sha256').update(canonicalJson({
    runId,
    workspaceIdentity: workspaceIdentity || null,
    report: normalized,
  })).digest('hex');
};

// Only executions produced by this module may enter the report-local cache.
// The WeakMap is deliberately private: a public caller cannot manufacture the
// cache entry or replay one from another report/run through executeProof().
const proofExecutionCacheContexts = new WeakMap();
const proofExecutionCacheRequest = Symbol('kernel-proof-execution-cache-request');

const rememberProofExecutionCacheEntry = (execution, context) => {
  if (execution && typeof execution === 'object' && context) {
    proofExecutionCacheContexts.set(execution, context);
  }
  return execution;
};

// A single report may need the same trusted command for several hard
// obligations. Keep that execution in-memory only, and key it by every
// freshness and execution property that can change the meaning of the result.
// The individual obligation receipts are still recorded separately below.
const proofExecutionCacheKey = ({ run, obligation, request, scopeObservation = null } = {}) => JSON.stringify(canonicalReceiptValue({
  commandRef: request?.commandRef || null,
  // Approved/discovered executions intentionally have no trusted commandRef.
  // Keep their concrete argv and approval identity in the in-memory key so
  // two different discovered commands can never share one execution.
  command: request?.command || request?.discovered?.command || null,
  args: request?.args || request?.discovered?.args || [],
  approval: request?.approval || request?.discovered?.approval || null,
  timeoutMs: Number.isFinite(request?.timeoutMs) ? Number(request.timeoutMs) : null,
  networkPolicy: request?.networkPolicy || 'inherited',
  flakyRerun: request?.flakyRerun === true,
  allowEvidenceReuse: request?.allowEvidenceReuse !== false,
  sourceIdentity: run?.sourceIdentity || null,
  currentWorkspaceIdentity: run?.currentWorkspaceIdentity || null,
  mutationRevision: run?.mutationRevision ?? null,
  contractRevision: run?.contractRevision ?? null,
  scopeAuthority: authoritativeVerificationScope(obligation) || null,
  // The authoritative scope's current content identity is part of the
  // lookup key as well as the later executeProof guard. This prevents two
  // same-command obligations with different scope snapshots from sharing a
  // cache entry and then falling through to a duplicate execution only after
  // the guard rejects the mismatch.
  scopeIdentity: scopeObservation
    ? {
      status: scopeObservation.status || null,
      identity: scopeObservation.identity || null,
      reason: scopeObservation.reason || null,
    }
    : null,
}));

export const computeKernelSourceIdentity = ({ projectRoot = process.cwd(), objective = '', taskContract = {} } = {}) => {
  const sourceDigest = gitTreeDigest(projectRoot) || sha256Hex({ projectRoot, objective });
  return buildCandidateIdentity({
    profile: 'kernel',
    source: sourceDigest,
    task: objective,
    spec: taskContract.spec || taskContract.acceptance || taskContract.acceptanceCriteria || [],
    environment: `${process.platform}:${process.arch}:${process.version}`,
    policy: 'moon-relay-kernel.v1',
  }).candidateId;
};

const observed = (value) => ({ status: 'observed', value });
const unavailable = (reason) => ({ status: 'unavailable', reason });

const EFFICIENCY_TIMESTAMP_FIELDS = Object.freeze([
  'runStartedAt', 'goalResolvedAt', 'readinessCompletedAt', 'firstRepositoryReadAt',
  'firstMutationAt', 'lastMutationAt', 'focusedVerificationStartedAt',
  'focusedVerificationFinishedAt', 'goalRegressionStartedAt', 'goalRegressionFinishedAt',
  'reviewRequestedAt', 'reviewSpawnedAt', 'reviewFinishedAt', 'blockedAt',
]);
const EFFICIENCY_COUNTER_FIELDS = Object.freeze([
  'reportCount', 'reportRejectedCount', 'contractRepairCount', 'scopeRejectedCount',
  'verificationTimeoutCount', 'waitTimeoutCount', 'contextCompactionCount',
  'repositorySearchCount', 'sameFileReadCount',
]);
const EFFICIENCY_KPI_FIELDS = Object.freeze([
  'timeToGoalResolutionMs', 'timeToReadinessMs', 'timeToFirstMutationMs',
  'implementationWallMs', 'verificationWallMs', 'reviewQueueMs', 'reviewWallMs',
  'reportRepairTimeMs', 'blockedDiscoveryLatencyMs',
]);

const finiteTimestamp = (value) => {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : null;
};

const durationBetween = (start, finish) => {
  const startMs = finiteTimestamp(start);
  const finishMs = finiteTimestamp(finish);
  return startMs !== null && finishMs !== null && finishMs >= startMs ? finishMs - startMs : null;
};

const efficiencyTelemetryMeasurement = ({ run, workflowEfficiency = null } = {}) => {
  const raw = run?.runSignals && typeof run.runSignals === 'object' && !Array.isArray(run.runSignals)
    ? run.runSignals.efficiency
    : null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return unavailable('efficiency-telemetry-not-recorded');
  }
  const value = {};
  for (const field of EFFICIENCY_TIMESTAMP_FIELDS) value[field] = raw[field] || null;
  for (const field of EFFICIENCY_COUNTER_FIELDS) value[field] = Number.isFinite(Number(raw[field])) ? Number(raw[field]) : 0;
  value.timeToGoalResolutionMs = durationBetween(raw.runStartedAt, raw.goalResolvedAt);
  value.timeToReadinessMs = durationBetween(raw.runStartedAt, raw.readinessCompletedAt);
  value.timeToFirstMutationMs = durationBetween(raw.runStartedAt, raw.firstMutationAt);
  value.implementationWallMs = workflowEfficiency?.value?.executeMs ?? null;
  value.verificationWallMs = durationBetween(raw.focusedVerificationStartedAt, raw.focusedVerificationFinishedAt);
  value.reviewQueueMs = durationBetween(raw.reviewRequestedAt, raw.reviewSpawnedAt);
  value.reviewWallMs = durationBetween(raw.reviewSpawnedAt, raw.reviewFinishedAt);
  value.reportRepairTimeMs = null;
  value.blockedDiscoveryLatencyMs = durationBetween(raw.runStartedAt, raw.blockedAt);
  return observed(value);
};

// Provider usage becomes observable only when the Host files receipts. Without
// them the fields stay `unavailable` — an unmeasured run must never look free.
const providerUsageMeasurement = (receipts = []) => {
  const withTokens = receipts.filter((receipt) => receipt.inputTokens !== null || receipt.outputTokens !== null);
  const models = [...new Set(receipts.map((receipt) => receipt.resolvedModel).filter(Boolean))];
  const durations = receipts.map((receipt) => receipt.wallClockMs).filter((value) => Number.isInteger(value));
  const sum = (key) => withTokens.reduce((total, receipt) => total + (receipt[key] ?? 0), 0);
  return {
    providerModelIdentity: models.length > 0
      ? observed({ models, enforcedTurns: receipts.filter((receipt) => receipt.enforcementStatus === 'enforced').length, turns: receipts.length })
      : unavailable('provider-usage-not-recorded'),
    actualInputTokens: withTokens.length > 0 ? observed({ total: sum('inputTokens'), cached: sum('cachedInputTokens'), reportedTurns: withTokens.length }) : unavailable('provider-usage-not-recorded'),
    actualOutputTokens: withTokens.length > 0 ? observed({ total: sum('outputTokens'), reportedTurns: withTokens.length }) : unavailable('provider-usage-not-recorded'),
    wallClockMs: durations.length > 0 ? observed({ modelTurnsTotalMs: durations.reduce((total, value) => total + value, 0), reportedTurns: durations.length }) : unavailable('run-duration-not-recorded'),
  };
};

const workflowEfficiencyMeasurement = ({ run, verifications = [], verificationHistory = [], attempts = [], usageReceipts = [], reviewReceipts = [] }) => {
  const stages = Array.isArray(run.route?.stages) ? run.route.stages : [];
  const currentStageIndex = stages.indexOf(run.state);
  const durationByStage = Object.fromEntries(['FRAME', 'EXECUTE', 'PROVE', 'CLOSE'].map((stage) => [stage, 0]));
  for (const attempt of attempts) {
    const started = Date.parse(attempt.startedAt || '');
    const finished = Date.parse(attempt.finishedAt || '');
    if (!Number.isFinite(started) || !Number.isFinite(finished) || finished < started) continue;
    if (Object.prototype.hasOwnProperty.call(durationByStage, attempt.state)) {
      durationByStage[attempt.state] += finished - started;
    }
  }
  const history = verificationHistory.length > 0 ? verificationHistory : verifications;
  return observed({
    // The route is persisted, so this count remains available without adding
    // a transition-history table. It counts the reached route positions,
    // including the initial FRAME position (CLOSE on a completed standard
    // route therefore reports four).
    transitions: currentStageIndex >= 0 ? currentStageIndex + 1 : stages.length,
    modelTurns: usageReceipts.length,
    proofExecutions: history.filter((verification) => verification.executor === 'kernel-runtime' && !verification.reuseOfVerificationId).length,
    proofReuses: history.filter((verification) => Boolean(verification.reuseOfVerificationId)).length,
    reviewExecutions: reviewReceipts.length,
    frameMs: durationByStage.FRAME,
    executeMs: durationByStage.EXECUTE,
    proveMs: durationByStage.PROVE,
    closeMs: durationByStage.CLOSE,
    // These values have no persisted start/lock/payload receipt in the
    // current schema; zero is the explicit observed baseline, not an
    // invented duration or byte count.
    proofWallMs: 0,
    reviewWallMs: 0,
    lockWaitMs: 0,
    nextPayloadBytes: 0,
  });
};

export const buildKernelMeasurement = ({ run, completion, principles = loadKernelPrinciples(), verifications = [], verificationHistory = [], attempts = [], routeDecisions = [], usageReceipts = [], reviewReceipts = [] }) => {
  const workflowEfficiency = workflowEfficiencyMeasurement({ run, verifications, verificationHistory, attempts, usageReceipts, reviewReceipts });
  return {
    schemaVersion: 2,
    harnessIdentity: 'moon-relay-kernel',
    sourceIdentity: run.sourceIdentity,
    currentWorkspaceIdentity: run.currentWorkspaceIdentity ? observed(run.currentWorkspaceIdentity) : unavailable('workspace-identity-not-observed'),
    hardEvidenceCoverage: observed({
      kernelRuntimePassed: verifications.filter((verification) => verification.executor === 'kernel-runtime' && verification.status === 'passed').length,
      callerAttestedPassed: verifications.filter((verification) => verification.executor !== 'kernel-runtime' && verification.status === 'passed').length,
      total: verifications.length,
      requiredForCompletion: run.mutationRevision > 0,
    }),
    promptTokenBudget: observed({
      stableTokenBudget: KERNEL_POLICY.context.stableTokenBudget,
      stageTokenBudget: KERNEL_POLICY.context.stageTokenBudget,
    }),
    taskIdentity: `task-${createHash('sha256').update(run.objective).digest('hex').slice(0, 16)}`,
    ...providerUsageMeasurement(usageReceipts),
    modelRouting: routeDecisions.length > 0 ? observed(summarizeModelRouting(routeDecisions, usageReceipts)) : unavailable('model-routing-not-recorded'),
    estimatedStaticTokens: Math.ceil(JSON.stringify(principles.principles).length / 4),
    successDecision: observed(completion.decision === 'accepted'),
    falseCompletionDecision: unavailable('false-completion-evaluation-not-run'),
    retryCount: observed(Math.max(0, attempts.length - 1)),
    replanCount: observed(run.replanCount || 0),
    userInterventionCount: observed(run.interventionCount || 0),
    evidenceCoverage: observed({ passed: verifications.filter((verification) => verification.status === 'passed').length, total: verifications.length, required: run.requiredObligations.length }),
    workflowEfficiency,
    efficiencyTelemetry: efficiencyTelemetryMeasurement({ run, workflowEfficiency }),
    contaminationSignals: observed({ relayStateMutation: false, profileMutation: false, source: 'kernel-runtime-boundary' }),
  };
};

// The route a run follows is fixed at start (P1-1). Structural planning is an
// internal judgment of the work unit, not a persisted workflow state.
const refreshedTier = (store, runId) => store.getRun(runId)?.proofTier;

const FINDING_CLASS_RANK = Object.freeze({ critical: 3, important: 2, minor: 1 });

const findingClassOf = (findings = []) => {
  let highest = 'none';
  for (const finding of findings) {
    const severity = typeof finding === 'object' && finding ? finding.severity : 'minor';
    if ((FINDING_CLASS_RANK[severity] || 1) > (FINDING_CLASS_RANK[highest] || 0)) highest = severity in FINDING_CLASS_RANK ? severity : 'minor';
  }
  return highest;
};

// K0: which judgments may not rest on caller-supplied reviewer strings.
const reviewReceiptRequired = ({ obligationId, declared, proofTier, independentReviewRequired = false }) =>
  Boolean(declared?.protected)
  || isProtectedObligation(obligationId)
  || obligationId === 'security-review'
  || independentReviewRequired === true
  || (proofTier === 'T3' && (declared?.evidenceClass || 'hard') === 'judgment');

const buildRunRoute = (contract, riskSummary) => {
  if (contract.taskClass === 'analysis') return ['FRAME', 'CLOSE'];
  return ['FRAME', 'EXECUTE', 'PROVE', 'CLOSE'];
};

export const resolveDeclaredStepForReplan = (contract, step) => {
  if (!step || !Array.isArray(contract?.steps)) return null;
  const byId = contract.steps.find((entry) => entry.stepId && String(entry.stepId) === step.stepId);
  if (byId) return byId;
  const byObjective = contract.steps.find((entry) => String(entry.objective || '') === String(step.objective || ''));
  if (byObjective) return byObjective;
  return contract.steps[Number(step.sequence) - 1] || null;
};

const stepScopeChanged = (step, declared) => {
  if (!step || !declared) return false;
  const normalized = (value) => [...new Set((Array.isArray(value) ? value : []).map(String))].sort();
  return JSON.stringify(normalized(step.allowedPaths)) !== JSON.stringify(normalized(declared.allowedPaths))
    || JSON.stringify(normalized(step.forbiddenPaths)) !== JSON.stringify(normalized(declared.forbiddenPaths))
    || JSON.stringify(normalized(step.acceptanceIds)) !== JSON.stringify(normalized(declared.acceptanceIds))
    || JSON.stringify(normalized(step.obligationIds)) !== JSON.stringify(normalized(declared.obligationIds));
};

const planDiffersFromContract = (steps = [], declared = []) => {
  if (steps.length !== declared.length) return true;
  return steps.some((step, index) => (
    String(step.objective || '') !== String(declared[index]?.objective || '')
    || stepScopeChanged(step, declared[index])
  ));
};

export const createKernelControlPlane = async ({ runtimeHome = resolveKernelRuntimeHome(), relayHome, projectRoot = process.cwd(), holder: holderOption, env = process.env, requireHostBinding = false } = {}) => {
  const store = await openKernelStateStore({ runtimeHome, relayHome });
  const reportIdempotencyCache = new Map();
  let currentProject = resolveKernelProjectIdentity({
    cwd: projectRoot,
    env: { ...env, MOON_RELAY_KERNEL_HOME: runtimeHome },
  });
  // State-store identity roots are persisted in canonical, case-normalized
  // form. Keep a native spelling for mutation fencing without changing the
  // source-root spelling used by source identity and repository evidence.
  const fencingWorkspaceRoot = path.resolve(currentProject.canonicalRoot);
  const identityState = store.inspectProjectIdentity({
    projectId: currentProject.projectId,
    canonicalRoot: currentProject.canonicalRoot,
    gitCommonDir: currentProject.gitCommonDir,
    legacyCandidates: (currentProject.legacyAliases || []).filter((candidate) => candidate?.projectId),
  });
  const legacyData = identityState.legacyCandidates.filter((candidate) => candidate.hasData);
  if (!identityState.currentIdentity && legacyData.length > 0) {
    store.close();
    throw Object.assign(new Error('project_identity_preflight_required'), {
      code: 'project_identity_preflight_required',
      errorCode: 'project_identity_preflight_required',
      legacyProjectId: legacyData[0].projectId,
      source: legacyData[0].source,
      nextAction: 'kernel identity bootstrap --policy isolate or kernel identity approve --legacy-project-id <id> --approval-ref <operator-ref> --approved-by <operator> then kernel identity repair --legacy-project-id <id> --approval-ref <operator-ref>',
      projectIdentity: {
        status: 'repair_required',
        projectId: currentProject.projectId,
        canonicalRoot: currentProject.canonicalRoot,
        legacyCandidates: legacyData,
        remediation: {
          action: 'choose-isolate-or-adopt',
          isolateCommand: 'kernel identity bootstrap --policy isolate',
          approvalCommand: 'kernel identity approve --legacy-project-id <id> --approval-ref <operator-ref> --approved-by <operator>',
          adoptCommand: 'kernel identity repair --legacy-project-id <id> --approval-ref <operator-ref>',
          reason: 'legacy project data exists without an explicit operator identity-repair decision',
        },
      },
    });
  }
  const persistedIdentity = identityState.currentIdentity || store.registerProjectIdentity({
    ...currentProject,
    legacyProjectIds: [],
    legacyAliases: [],
  });
  currentProject = {
    ...currentProject,
    ...persistedIdentity,
    projectRoot,
    aliases: persistedIdentity.aliases,
  };
  const rawHostSessionId = env.MOON_RELAY_KERNEL_SESSION_ID || null;
  const hostProvider = env.MOON_RELAY_KERNEL_PROVIDER || 'unknown-host';
  const hostSessionId = rawHostSessionId
    ? canonicalizeHostSessionId({ provider: hostProvider, sessionId: rawHostSessionId })
    : null;
  const explicitLegacySessionId = env.MOON_RELAY_KERNEL_LEGACY_SESSION_ID || null;
  const codexLegacySessionId = env.CODEX_THREAD_ID && hostSessionId === `codex:${env.CODEX_THREAD_ID}`
    ? env.CODEX_THREAD_ID
    : null;
  const legacyHostSessionId = explicitLegacySessionId
    || codexLegacySessionId
    || (rawHostSessionId && rawHostSessionId !== hostSessionId && !rawHostSessionId.includes(':')
      ? rawHostSessionId
      : null);
  const holder = resolveHostSessionHolder({
    holder: holderOption,
    env: hostSessionId ? { ...env, MOON_RELAY_KERNEL_SESSION_ID: hostSessionId } : env,
    projectRoot,
  });
  const hostWorkspaceId = env.MOON_RELAY_KERNEL_WORKSPACE_ID || null;
  const currentWorktree = registerKernelWorktreeBinding({
    stateStore: store,
    cwd: projectRoot,
    env: { ...env, MOON_RELAY_KERNEL_HOME: runtimeHome },
    projectIdentity: currentProject,
  });
  const registeredWorkspace = currentWorktree.registeredWorkspace;
  if (hostWorkspaceId && hostWorkspaceId !== registeredWorkspace.workspaceId) {
    throw Object.assign(new Error('run_workspace_mismatch'), { code: 'run_workspace_mismatch' });
  }
  const effectiveWorkspaceId = registeredWorkspace.workspaceId;
  const effectiveWorktreeId = currentWorktree.worktreeId;
  // The locator is only a Kernel account-root address book. SQLite remains the
  // authority for every Run field; a locator write failure must not turn
  // derived discovery metadata into a lifecycle failure.
  const syncRunLocator = async (run) => {
    if (!run?.runId) return null;
    try {
      return await writeRunLocator({
        run,
        runtimeHome,
        projectRoot,
        projectIdentity: currentProject,
        worktree: currentWorktree,
        ownerSessionId: hostSessionId,
      });
    } catch {
      return null;
    }
  };
  const advanceWorkspaceReportBaseline = (runId, observation) => {
    if (observation?.method !== 'git' || !Array.isArray(observation.changeEntries)) return;
    try {
      store.updateRunWorkspaceBaseline(runId, {
        changedPaths: observation.changedPaths || [],
        entries: observation.changeEntries,
      });
    } catch {
      // This is a derived observation cursor. The immutable Run-start
      // baseline and SQLite lifecycle receipts remain authoritative if the
      // convenience cursor cannot be refreshed.
    }
  };
  const recordEfficiency = (runId, patch = {}) => {
    if (!runId || typeof store.recordRunEfficiency !== 'function') return;
    try { store.recordRunEfficiency(runId, patch); } catch { /* telemetry never changes lifecycle authority */ }
  };
  const recordReportOutcome = (runId, result) => {
    if (!result || result.status === 'lease-conflict' || result.idempotentReplay === true) return;
    const rejected = new Set(['scope-rejected', 'step-rejected', 'evidence-rejected', 'execution-readiness-blocked']).has(result.status);
    recordEfficiency(runId, {
      increments: {
        ...(rejected ? { reportRejectedCount: 1 } : {}),
        ...(result.status === 'scope-rejected' || result.status === 'step-rejected' ? { scopeRejectedCount: 1 } : {}),
      },
    });
  };
  const publicReportResult = (result) => {
    if (!result || result.idempotentReplay !== true) return result;
    const { idempotentReplay, ...publicResult } = result;
    void idempotentReplay;
    return publicResult;
  };
  const settleDurableReportReplay = (attempt) => {
    if (!attempt?.reportResult || !['started', 'reported', 'verifying'].includes(attempt.status)) return;
    if (typeof store.finishStepAttemptWithReportResult !== 'function') return;
    const result = attempt.reportResult;
    const step = result.step || {};
    store.finishStepAttemptWithReportResult(attempt.attemptId, {
      status: step.state === 'failed' || (Array.isArray(result.failures) && result.failures.length > 0) ? 'failed' : 'passed',
      resultDigest: step.resultDigest || null,
      changedPaths: Array.isArray(result.reportedChangedPaths) ? result.reportedChangedPaths : null,
      failureReasons: Array.isArray(result.failures) ? result.failures.map((failure) => failure.errorSummary).filter(Boolean) : [],
      failureCategory: result.failures?.[0]?.failureCategory || null,
    }, result);
  };
  let deliveryRecoveryInProgress = false;
  // Reconcile terminal bindings and stale mutation locks at the public Kernel
  // lifecycle boundary. Preserve only a completed binding owned by this host
  // so a successor contract can perform its atomic handoff; blocked bindings
  // and terminal bindings from other sessions cannot remain executable.
  store.reconcileTerminalLifecycle({
    projectId: currentProject.projectId,
    preserveSessionId: hostSessionId,
  });
  const getHostBinding = ({ runId = null } = {}) => {
    const canonical = runId
      ? store.getActiveRunBinding({ projectId: currentProject.projectId, sessionId: hostSessionId, runId })
      : store.getActiveOwnerBinding({
          projectId: currentProject.projectId,
          sessionId: hostSessionId,
          workspaceId: effectiveWorkspaceId,
        });
    if (canonical || !legacyHostSessionId || !hostSessionId) return canonical;
    const migrated = store.migrateLegacySessionBinding({
      projectId: currentProject.projectId,
      legacySessionId: legacyHostSessionId,
      canonicalSessionId: hostSessionId,
      provider: hostProvider,
    });
    if (!migrated || (runId && migrated.runId !== runId)) return null;
    return migrated;
  };
  const preflight = (runId, command) => {
    const run = store.getRun(runId);
    if (!run) throw Object.assign(new Error('run_access_denied'), { code: 'run_access_denied' });
    assertRunWorktreeMutationAuthority({ stateStore: store, run, worktree: currentWorktree });
    if (!requireHostBinding || !hostSessionId) return { run, worktree: currentWorktree };
    const binding = getHostBinding({ runId });
    if (!binding) {
      // Strict Host entrypoints may only operate through their active owner
      // binding. Unbound legacy adoption is handled once in ensureRun; a
      // second native surface must not silently gain mutation authority by
      // naming the same Run.
      return assertBoundRunAccess({
        stateStore: store,
        requestedRunId: runId,
        currentProject,
        currentWorkspace: effectiveWorkspaceId,
        sessionId: hostSessionId,
        requiredAccess: command,
        command,
      });
    }
    return assertBoundRunAccess({
      stateStore: store,
      requestedRunId: runId,
      currentProject,
      currentWorkspace: effectiveWorkspaceId,
      sessionId: binding?.sessionId || hostSessionId,
      requiredAccess: command,
      command,
    });
  };

  // Blocking a run closes its owner binding by design. Build the model-visible
  // blocked action directly from persisted state instead of calling the
  // binding-gated `next()` immediately after that transition; otherwise the
  // real blocker is replaced by the secondary `host_binding_missing` error.
  const buildUnboundNextPayload = (runId) => {
    const run = store.getRun(runId);
    if (!run) return { schemaVersion: 1, runId, status: 'not_found' };
    return buildNextForRun(run, {
      verifications: store.getVerifications(runId),
      requiredObligations: run.requiredObligations,
      obligations: store.getRunObligations(runId),
      contract: run.taskContract ? contractBriefing(run.taskContract) : null,
    });
  };
  const buildBlockedResponse = ({ runId, reason, detail = null }) => ({
    schemaVersion: 1,
    runId,
    status: 'blocked',
    blockedReason: reason,
    blockedDetail: detail,
    next: buildUnboundNextPayload(runId),
  });
  const reportHintObligationId = (request, obligations = []) => {
    if (request?.obligationId) return String(request.obligationId);
    if (obligations.some((obligation) => String(obligation?.obligationId || '') === 'default')) return 'default';
    return String(request?.commandRef || '');
  };
  const buildWorkUnitScopeRejection = ({ runId, modelInput, capabilities, error }) => {
    const failure = workUnitScopeFailure(error);
    const workUnitScope = {
      valid: false,
      reason: failure.scopeReason,
      errorCode: failure.errorCode,
      allowedPaths: failure.allowedPaths,
      ...(failure.workspaceWide.length > 0 ? { workspaceWide: failure.workspaceWide } : {}),
    };
    const action = modelInput.action
      ? {
        ...modelInput.action,
        workUnitScope,
        guidance: `${failure.errorSummary} ${modelInput.action.guidance || ''}`.trim(),
      }
      : null;
    return {
      schemaVersion: 1,
      runId,
      status: 'scope-rejected',
      errorCode: failure.errorCode,
      failureCode: failure.failureCode,
      errorSummary: failure.errorSummary,
      nextAction: failure.nextAction,
      workUnitScope,
      modelInput: {
        ...modelInput,
        status: 'scope-rejected',
        errorCode: failure.errorCode,
        failureCode: failure.failureCode,
        errorSummary: failure.errorSummary,
        nextAction: failure.nextAction,
        workUnitScope,
        ...(action ? { action } : {}),
      },
      executionCapsule: null,
      hostDirective: {
        // The dispatcher treats this as a Kernel-owned rejection and returns
        // before route admission, provider resolution, or worker dispatch.
        modelRouteDecision: {
          schemaVersion: 1,
          runId,
          actionKind: 'work-unit-scope-guard',
          role: 'implementer',
          modelClass: 'kernel',
          permissions: 'workspace_write',
          reasonCodes: [failure.errorCode],
        },
        executionContract: buildHostExecutionContract({
          decision: {
            runId,
            actionKind: 'work-unit-scope-guard',
            role: 'implementer',
            executionClass: null,
            permissions: 'workspace_write',
            decisionId: `route-${'0'.repeat(24)}`,
            reasonCodes: [failure.errorCode],
          },
        }),
        executionAssignment: null,
        hostCapabilities: capabilities,
        enforcementStrategy: 'kernel',
        executionCapsule: null,
        attemptId: null,
        attempt: null,
        mutationLock: null,
        rejection: failure,
      },
    };
  };
  const buildContractPreflightRejection = ({ runId, error, contract = {}, commands = [], obligations = [] }) => {
    const errorCode = error?.errorCode || error?.code || 'contract-preflight-invalid';
    const errorSummary = error?.message || String(error);
    const nextAction = error?.nextAction || 'revise-task-contract-before-run-creation';
    const recoverable = error?.recoverable ?? (errorCode !== 'contract-preflight-unauthorized-path-escape' && errorCode !== 'contract-preflight-worktree-escape');
    const blockingClass = error?.blockingClass || (recoverable ? 'completion' : 'safety');
    const canonicalAcceptanceIds = (contract?.acceptance || []).map((item) => String(item.id));
    const availableCommandRefs = [...new Set((commands || []).map((command) => command?.commandRef).filter(Boolean).map(String))].sort();
    const requiredVerifications = (obligations || []).map((obligation) => ({
      obligationId: String(obligation.obligationId),
      evidenceClass: obligation.evidenceClass || 'hard',
      allowedCommandRefs: obligation.allowedCommandRefs || [],
      commandRef: obligation.allowedCommandRefs?.[0] || null,
      acceptanceIds: obligation.acceptanceIds || [],
      verificationScope: obligation.metadata?.verificationScope || obligation.metadata?.scope || null,
      timeoutMs: Number.isFinite(Number(obligation.metadata?.timeoutMs)) ? Number(obligation.metadata.timeoutMs) : null,
    }));
    const repairHint = {
      action: nextAction,
      errorCode,
      canonicalAcceptanceIds,
      availableCommandRefs,
      supportedEvidenceClasses: ['hard', 'judgment'],
    };
    const action = {
      type: 'blocked',
      reason: errorCode,
      guidance: errorSummary,
      recoverable,
      blockingClass,
    };
    const modelInput = {
      schemaVersion: 1,
      runId,
      status: 'contract-rejected',
      errorCode,
      errorSummary,
      nextAction,
      repairHint,
      recoverable,
      blockingClass,
      action,
    };
    return {
      schemaVersion: 1,
      runId,
      status: 'contract-rejected',
      errorCode,
      failureCode: errorCode,
      errorSummary,
      nextAction,
      canonicalAcceptanceIds,
      availableCommandRefs,
      supportedEvidenceClasses: ['hard', 'judgment'],
      requiredVerifications,
      repairHint,
      recoverable,
      diagnostics: {
        ...(error?.details || {}),
        canonicalAcceptanceIds,
        availableCommandRefs,
        supportedEvidenceClasses: ['hard', 'judgment'],
      },
      action,
      modelInput,
      executionCapsule: null,
      hostDirective: {
        modelRouteDecision: {
          schemaVersion: 1,
          runId,
          actionKind: 'contract-preflight',
          role: 'implementer',
          modelClass: 'kernel',
          permissions: 'workspace_write',
          reasonCodes: [errorCode],
        },
        executionContract: buildHostExecutionContract({
          decision: {
            runId,
            actionKind: 'contract-preflight',
            role: 'implementer',
            executionClass: null,
            permissions: 'workspace_write',
            decisionId: `route-${'0'.repeat(24)}`,
            reasonCodes: [errorCode],
          },
        }),
        executionAssignment: null,
        executionCapsule: null,
        attemptId: null,
        attempt: null,
        mutationLock: null,
        rejection: {
          errorCode,
          errorSummary,
          nextAction,
          recoverable,
          diagnostics: {
            ...(error?.details || {}),
            canonicalAcceptanceIds,
            availableCommandRefs,
            supportedEvidenceClasses: ['hard', 'judgment'],
          },
        },
      },
    };
  };

  const persistReleaseEvidenceIfNeeded = (runId, updated) => {
    if (updated.evidenceTier !== 'E2') return;
    const pack = buildReleaseEvidencePack({
      objective: updated.objective,
      proofTier: updated.proofTier,
      acceptanceCoverage: updated.acceptanceCriteria,
      acceptance: updated.acceptanceCriteria,
      scope: [projectRoot],
      completionDecision: 'pending',
      checks: store.getVerifications(runId),
    });
    const digest = `sha256:${createHash('sha256').update(JSON.stringify({ pack, mutationRevision: updated.mutationRevision })).digest('hex')}`;
    store.recordEvidencePack(runId, { tier: 'E2', pack, digest, mutationRevision: updated.mutationRevision });
  };

  const refreshProofPolicyBindings = (runId) => {
    const before = store.getRunObligations(runId);
    const rebound = rebindProofPolicyCommands({
      obligations: before,
      projectRoot,
      commands: discoverProjectCommands({ projectRoot }),
    });
    const bindingShape = (obligation) => JSON.stringify({
      obligationId: obligation.obligationId,
      allowedCommandRefs: obligation.allowedCommandRefs || [],
      rejectedCommandRefs: obligation.rejectedCommandRefs || [],
      metadata: obligation.metadata || {},
      satisfiable: obligation.satisfiable,
    });
    const changed = rebound.some((obligation, index) => bindingShape(obligation) !== bindingShape(before[index]));
    if (changed) store.declareRunObligations(runId, rebound);
    return changed ? store.getRunObligations(runId) : before;
  };

  const verificationScopeIdentities = (runId, obligations = store.getRunObligations(runId)) => {
    const identities = {};
    for (const obligation of obligations) {
      const authority = authoritativeVerificationScope(obligation);
      if (!authority) continue;
      identities[obligation.obligationId] = observeScopedWorkspaceIdentity({
        projectRoot,
        scopes: authority.scope,
      });
    }
    return identities;
  };

  const evaluateRunCompletion = (runId, { obligations = null } = {}) => store.evaluateCompletion(runId, {
    verificationScopeIdentities: verificationScopeIdentities(runId, obligations || store.getRunObligations(runId)),
  });

  const buildTrustAuthorityForRun = (currentRun, {
    completion = null,
    obligations = null,
    verifications = null,
    reviews = null,
    completionDecision = null,
    step = null,
  } = {}) => {
    if (!currentRun) return null;
    const resolvedObligations = obligations || store.getRunObligations(currentRun.runId);
    const resolvedVerifications = verifications || store.getVerifications(currentRun.runId);
    const resolvedCompletion = completion || evaluateRunCompletion(currentRun.runId, { obligations: resolvedObligations });
    const resolvedSteps = typeof store.getRunSteps === 'function'
      ? store.getRunSteps(currentRun.runId, { planRevision: currentRun.planRevision })
      : [];
    const resolvedStep = step || selectCurrentStep(resolvedSteps, { planRevision: currentRun.planRevision });
    return buildTrustAuthorityView({
      run: currentRun,
      obligations: resolvedObligations,
      verifications: resolvedVerifications,
      reviews: reviews || store.listReviewReceipts(currentRun.runId),
      completion: resolvedCompletion,
      completionDecision: completionDecision || store.getCompletionDecision(currentRun.runId),
      verificationScopeIdentities: verificationScopeIdentities(currentRun.runId, resolvedObligations),
      routeAdmissions: typeof store.listRouteAdmissions === 'function' ? store.listRouteAdmissions(currentRun.runId) : [],
      step: resolvedStep,
    });
  };

  const buildKnowledgeAuthorityForRun = (currentRun, {
    context = null,
    stage = null,
  } = {}) => {
    if (!currentRun?.projectId) return null;
    const stages = ['FRAME', 'EXECUTE', 'PROVE', 'CLOSE'];
    const contextReceipts = stages
      .map((entry) => store.getKnowledgeContextReceipt(currentRun.runId, entry))
      .filter(Boolean);
    const resolvedContext = context
      || store.getKnowledgeContextReceipt(currentRun.runId, stage || currentRun.state)?.receiptJson
      || store.getKnowledgeContextReceipt(currentRun.runId, 'FRAME')?.receiptJson
      || null;
    return buildKnowledgeAuthorityView({
      projectId: currentRun.projectId,
      run: currentRun,
      knowledgeRevision: store.getProjectKnowledgeRevision(currentRun.projectId),
      context: resolvedContext,
      contextReceipts,
      stage: stage || currentRun.state,
      candidates: typeof store.getKnowledgeCandidates === 'function' ? store.getKnowledgeCandidates(currentRun.runId) : [],
      reviewReceipt: typeof store.getKnowledgeReviewReceipt === 'function' ? store.getKnowledgeReviewReceipt(currentRun.runId) : null,
      commitReceipt: typeof store.getKnowledgeCommitReceipt === 'function' ? store.getKnowledgeCommitReceipt(currentRun.runId) : null,
      records: typeof store.listKnowledgeRecords === 'function'
        ? store.listKnowledgeRecords({ projectId: currentRun.projectId, statuses: ['committed', 'superseded', 'verified', 'rejected'] })
        : [],
      imports: typeof store.listKnowledgeImports === 'function' ? store.listKnowledgeImports({ projectId: currentRun.projectId }) : [],
    });
  };

  const resumeViewForRun = (currentRun, {
    completion = null,
    obligations = null,
    verifications = null,
    step = null,
    context = null,
    workAuthority = null,
  } = {}) => {
    if (!currentRun) return null;
    const resolvedObligations = obligations || store.getRunObligations(currentRun.runId);
    const resolvedVerifications = verifications || store.getVerifications(currentRun.runId);
    const resolvedCompletion = completion || evaluateRunCompletion(currentRun.runId, { obligations: resolvedObligations });
    const resolvedContext = context
      || store.getKnowledgeContextReceipt(currentRun.runId, currentRun.state)?.receiptJson
      || store.getKnowledgeContextReceipt(currentRun.runId, 'FRAME')?.receiptJson
      || null;
    const steps = typeof store.getRunSteps === 'function'
      ? store.getRunSteps(currentRun.runId, { planRevision: currentRun.planRevision })
      : [];
    const resolvedStep = step || selectCurrentStep(steps, { planRevision: currentRun.planRevision });
    const routeDecisions = store.listModelRouteDecisions(currentRun.runId);
    const resolvedWorkAuthority = workAuthority || buildWorkAuthorityView({
      run: currentRun,
      steps,
      step: resolvedStep,
      routeDecision: routeDecisions.at(-1) || null,
    });
    return buildResumeView({
      run: currentRun,
      step: resolvedStep,
      verifications: resolvedVerifications,
      obligations: resolvedObligations,
      reviews: store.listReviewReceipts(currentRun.runId),
      completionDecision: store.getCompletionDecision(currentRun.runId),
      finalizationReceipt: store.getFinalizationReceipt(currentRun.runId),
      gitCloseout: store.getGitCloseoutReceipt(currentRun.runId),
      routeDecisions,
      usageReceipts: store.listModelUsageReceipts(currentRun.runId),
      completion: resolvedCompletion,
      context: resolvedContext,
      workAuthority: resolvedWorkAuthority,
    });
  };

  const buildNextForRun = (run, options = {}) => {
    const currentRun = run || store.getRun(options.runId);
    if (!currentRun) return buildNextPayload({ run: currentRun, ...options });
    const obligations = options.obligations || refreshProofPolicyBindings(currentRun.runId);
    const completion = options.completion || evaluateRunCompletion(currentRun.runId, { obligations });
    const verifications = options.verifications || store.getVerifications(currentRun.runId);
    const steps = typeof store.getRunSteps === 'function'
      ? store.getRunSteps(currentRun.runId, { planRevision: currentRun.planRevision })
      : [];
    const workAuthority = options.workAuthority || buildWorkAuthorityView({
      run: currentRun,
      steps,
      step: options.step || null,
      routeDecision: store.listModelRouteDecisions(currentRun.runId).at(-1) || null,
    });
    const trustAuthority = options.trustAuthority || buildTrustAuthorityForRun(currentRun, {
      completion,
      obligations,
      verifications,
      step: options.step || null,
    });
    const knowledgeAuthority = options.knowledgeAuthority || buildKnowledgeAuthorityForRun(currentRun, {
      context: options.context || null,
    });
    const payload = buildNextPayload({
      ...options,
      run: currentRun,
      verifications,
      requiredObligations: options.requiredObligations || currentRun.requiredObligations,
      obligations,
      satisfiedObligations: completion.obligationStatuses.filter((entry) => entry.satisfied).map((entry) => entry.obligationId),
      outstandingObligationIds: completion.unsatisfiedObligations.map((entry) => entry.obligationId),
      contract: options.contract || (currentRun.taskContract ? contractBriefing(currentRun.taskContract) : null),
      resume: options.resume || resumeViewForRun(currentRun, {
        completion,
        obligations,
        verifications,
        step: options.step || null,
        context: options.context || null,
        workAuthority,
      }),
      workAuthority,
      trustAuthority,
    });
    payload.knowledgeAuthority = knowledgeAuthority;
    return payload;
  };

  const proofRequestsForReport = ({ runId, report, completion, step = null }) => {
    const projectCommands = discoverProjectCommands({ projectRoot });
    const currentRun = store.getRun(runId);
    const obligations = store.getRunObligations(runId);
    const planSteps = store.getRunSteps(runId, { planRevision: currentRun?.planRevision });
    const finalWorkUnitCandidate = Boolean(step) && planSteps
      .filter((candidate) => candidate.stepId !== step.stepId)
      .every((candidate) => ['passed', 'superseded', 'cancelled'].includes(candidate.state));
    const byId = new Map(obligations.map((obligation) => [obligation.obligationId, obligation]));
    const outstanding = new Set((completion?.unsatisfiedObligations || []).map((entry) => entry.obligationId));
    const acceptedCoverage = new Set((completion?.acceptanceCovered || []).map(String));
    const requested = new Map((report?.verifications || []).map((request) => [reportHintObligationId(request, obligations), request]));
    const stepAcceptanceIds = new Set((step?.acceptanceIds || []).map(String));
    const stepObligationIds = step && !step.synthetic
      ? new Set([
        ...(step.obligationIds || []).map(String),
        ...obligations
          .filter((obligation) => (obligation.acceptanceIds || []).some((acceptanceId) => stepAcceptanceIds.has(String(acceptanceId))))
          .map((obligation) => String(obligation.obligationId)),
      ])
      : null;
    const freshRequests = (report?.verifications || []).filter((request) => (
      request.forceFresh === true
      || request.freshnessPolicy === 'fresh'
      || request.stalePolicy === 'rerun'
    ));
    const requests = [];
    const addRequest = (obligation, hint = {}, { forceFresh = false, automatic = false } = {}) => {
      if (!obligation || obligation.evidenceClass !== 'hard') return;
      const commandRef = selectBoundCommandRef(obligation, {
        projectCommands,
        preferredCommandRef: automatic ? null : hint.commandRef,
      });
      if (!commandRef) return;
      const existing = requests.find((request) => request.obligationId === obligation.obligationId);
      if (existing) {
        if (forceFresh) existing.allowEvidenceReuse = false;
        return;
      }
      const verificationScope = deriveVerificationSettlementScope(obligation);
      requests.push({
        obligationId: obligation.obligationId,
        commandRef,
        verificationScope,
        timeoutMs: Number.isFinite(Number(hint.timeoutMs)) && Number(hint.timeoutMs) > 0
          ? Number(hint.timeoutMs)
          : (Number.isFinite(Number(obligation.metadata?.timeoutMs)) && Number(obligation.metadata.timeoutMs) > 0 ? Number(obligation.metadata.timeoutMs) : undefined),
        // A model-supplied verification hint is not itself acceptance proof.
        // Only the no-hint, Kernel-planned path may use the obligation's
        // declared acceptance binding; explicit hints must carry their own
        // coverage or the Step Ledger will keep the unit failed.
        acceptanceCoverage: automatic
          ? (obligation.acceptanceIds || [])
          : (Array.isArray(hint.acceptanceCoverage) ? hint.acceptanceCoverage : []),
        networkPolicy: hint.networkPolicy || 'inherited',
        flakyRerun: hint.flakyRerun === true,
        // A flaky request must execute the command twice at the current
        // workspace identity. Reusing an older pass would bypass the
        // divergence check entirely.
        allowEvidenceReuse: !forceFresh && hint.flakyRerun !== true,
      });
    };

    const coverageNeedsProof = (obligation, hint) => {
      if (!obligation || !Array.isArray(hint?.acceptanceCoverage) || hint.acceptanceCoverage.length === 0) return false;
      try {
        const canonicalCoverage = normalizeAcceptanceCoverage({
          contract: currentRun?.taskContract || {},
          acceptanceCriteria: currentRun?.acceptanceCriteria || [],
          obligation,
          coverage: hint.acceptanceCoverage,
        });
        return canonicalCoverage.some((acceptanceId) => !acceptedCoverage.has(String(acceptanceId)));
      } catch {
        return false;
      }
    };

    for (const obligationId of outstanding) {
      const obligation = byId.get(obligationId);
      const hasHint = requested.has(obligationId);
      // A report bound to a declared Step settles that unit. Do not spend the
      // settlement on an unrelated later Step's automatic proof (which can
      // fail intentionally while the current Step is still being completed).
      // An explicit hint remains authoritative and is still honored below.
      const settlementScope = deriveVerificationSettlementScope(obligation);
      if (settlementScope === 'goal' && !finalWorkUnitCandidate && step) continue;
      if (settlementScope === 'focused' && !hasHint && stepObligationIds && !stepObligationIds.has(String(obligationId))) continue;
      addRequest(obligation, requested.get(obligationId) || {}, { forceFresh: false, automatic: !hasHint });
    }
    // An obligation can have a valid receipt while the report explicitly
    // supplies coverage for an acceptance criterion that is still uncovered.
    // Keep that obligation in the proof queue so a revised or partial
    // acceptance binding cannot be mistaken for complete coverage.
    for (const [obligationId, hint] of requested) {
      const obligation = byId.get(obligationId);
      if (!outstanding.has(obligationId) && coverageNeedsProof(obligation, hint)) {
        addRequest(obligation, hint);
      }
    }
    // Re-running a satisfied or unrelated obligation is opt-in. Even then the
    // command is still Kernel-selected from the authority ordering above.
    for (const request of freshRequests) {
      const obligationId = reportHintObligationId(request, obligations);
      const obligation = byId.get(obligationId);
      if (deriveVerificationSettlementScope(obligation) === 'goal' && !finalWorkUnitCandidate && step) continue;
      addRequest(obligation, request, { forceFresh: true });
    }
    return requests.sort((left, right) => (left.verificationScope === 'goal') - (right.verificationScope === 'goal'));
  };

  const assertLiveReviewWorkspace = (runId, expectedRun, phase = 'review') => {
    let observation;
    try {
      observation = observeWorkspaceIdentity({ projectRoot });
    } catch {
      throw new Error(`incomplete_review_chain: live workspace observation failed during ${phase}`);
    }
    if (!observation?.identity) {
      throw new Error(`incomplete_review_chain: live workspace identity unavailable during ${phase}`);
    }
    if (observation.identity !== expectedRun?.currentWorkspaceIdentity) {
      try {
        store.observeWorkspaceIdentity(runId, observation.identity);
      } catch {
        throw new Error(`incomplete_review_chain: live workspace observation could not be persisted during ${phase}`);
      }
      if (phase !== 'operator-approval') {
        throw new Error(`incomplete_review_chain: review workspace identity changed during ${phase}`);
      }
    }
    return { identity: observation.identity, run: store.getRun(runId) || expectedRun };
  };

  // Work cursor and Host routing are bridges around the coordinator. Their
  // compatibility methods remain available to existing Host callers, but the
  // route/stagnation policy is no longer implemented in this module.
  const workCursorApi = createWorkCursorApi({ store, projectRoot, runtimeHome, worktree: currentWorktree });
  const hostRouting = createHostRoutingBridge({
    store,
    detectStepStagnation: (runId, options) => workCursorApi.detectStepStagnation(runId, options),
  });

  return {
    // Internal Host hooks. They do not add a model-visible command or stage;
    // the Host derives any parallel selection behind next/report.
    projectRoot,
    stateStore: store,
    discoverProjectCommands: () => discoverProjectCommands({ projectRoot }),
    // K1 + K2 live behind the Work Cursor bridge. Spread as methods so `this`
    // stays the control plane for the compatibility surface.
    ...workCursorApi,

    // Structural coordinator contract. Host-only helpers remain callable for
    // compatibility, but model-facing lifecycle commands are next/report.
    coordinatorSurface() {
      return buildCoordinatorSurface({
        next: (runId, options) => this.next(runId, options),
        report: (runId, payload) => this.report(runId, payload),
      });
    },

    // Keep the reviewer capsule's public shape in the existing Work Cursor,
    // but source its evidence from the complete current-revision history. The
    // store's latest-row projection remains authoritative for completion; a
    // reviewer must also see distinct package and targeted-suite receipts.
    async buildReviewerCapsule(runId, { decision = null, step = null, stage = 'engineering', obligationId = null, requiredChecks = [], changedPaths = [] } = {}) {
      const run = store.getRun(runId);
      if (!run) throw new Error(`Run ${runId} not found`);
      const scopedIdentities = verificationScopeIdentities(runId);
      const verifications = (store.getVerificationHistory?.(runId) || store.getVerifications(runId))
        .filter((verification) => verification.evidenceClass !== 'judgment')
        .filter((verification) => {
          const scopedDigest = verification.evidenceIdentity?.values?.verificationScopeDigest || null;
          if (scopedDigest) {
            const current = scopedIdentities[verification.obligationId];
            const currentDigest = typeof current === 'string' ? current : current?.identity;
            return Boolean(currentDigest && currentDigest === scopedDigest);
          }
          return Number(verification.verifiedMutationRevision ?? verification.verifiedRuntimeRevision) === Number(run.mutationRevision);
        })
        .filter((verification) => Number(verification.contractRevision || 1) === Number(run.contractRevision || 1));
      const capsule = buildReviewCapsule({
        run,
        step,
        decision,
        contract: run.taskContract,
        stage,
        obligationId,
        requiredChecks,
        changedPaths,
        diffDigest: digestOfChangedFiles({ projectRoot, changedPaths }),
        verifications,
        implementationSession: store.getImplementationPrincipal(runId),
      });
      return store.recordExecutionCapsule(runId, capsule);
    },

    resolveBoundInvocation({
      explicitRunId = null,
      envRunId = null,
      sessionId = null,
      taskContract = null,
      invocationIntent = null,
      intent = null,
    } = {}) {
      return resolveInvocation({
        stateStore: store,
        projectId: currentProject.projectId,
        provider: hostProvider,
        sessionId: sessionId || hostSessionId,
        workspaceId: effectiveWorkspaceId,
        worktreeId: effectiveWorktreeId,
        explicitRunId,
        envRunId,
        taskContract,
        invocationIntent,
        intent,
      });
    },

    async startRun({ runId, objective, sourceIdentity, taskContract = {}, hostCapabilities = null } = {}) {
      const runStartedAt = new Date().toISOString();
      const trustedSourceIdentity = computeKernelSourceIdentity({ projectRoot, objective: objective || taskContract.objective || 'Kernel execution task', taskContract });
      if (sourceIdentity && sourceIdentity !== trustedSourceIdentity) {
        throw new Error('sourceIdentity is computed by Kernel and cannot be caller-authored');
      }

      // Evidence plans are optional refinements. The normalized contract is
      // what gets persisted, so constraints, non-goals, risks, and any
      // explicitly supplied plan survive a process restart (P0-4/P0-5).
      const contract = normalizeTaskContract(taskContract, { objective: objective || taskContract.objective });
      if (hostCapabilities) assertRequiredHostCapabilities(contract, hostCapabilities, { stage: 'FRAME' });

      const identity = currentProject;
      const projectId = identity.projectId;
      await ensureKnowledgeStoreDirectories(projectId, { env: { MOON_RELAY_KERNEL_HOME: runtimeHome } });
      const knowledgeRevisionStart = String(store.getProjectKnowledgeRevision(projectId));
      const hasKernelKnowledge = store.listKnowledgeRecords({ projectId }).length > 0;
      const projectMode = detectProjectMode({ projectRoot, hasKernelKnowledge });
      // Greenfield walking-skeleton planning is optional prework. Load it only
      // for a greenfield run; ordinary brownfield runs do not import the
      // architecture/planning helper into their default execution graph.
      let implementationContext;
      if (projectMode.mode === 'greenfield') {
        const { planWalkingSkeleton } = await import('./task/greenfield-bootstrap.mjs');
        implementationContext = {
          walkingSkeleton: planWalkingSkeleton({
            projectType: contract.flags?.projectType || 'library',
            objective: contract.objective,
            taskContract: contract,
          }),
        };
      } else {
        const repositoryScan = scanRepositoryEvidence({ projectRoot });
        implementationContext = {
          entrypoints: repositoryScan.entrypoints,
          manifests: repositoryScan.manifests,
          knownCommands: [...repositoryScan.testCommands, ...repositoryScan.buildCommands].map((entry) => entry.commandRef),
          baseline: { status: contract.flags?.baselineRequired ? 'required' : 'deferred' },
        };
      }

      const normalizedChangeSet = normalizeChangedContract(taskContract);

      // Risk carries behaviorChanging through to the tier resolver, so an
      // ordinary behavior change is not left at T0 (P1-1).
      const riskSummary = {
        ...riskSummaryFromContract(contract),
        filesChanged: contract.filesChanged || normalizedChangeSet.changedFileCount,
      };
      const proofRoute = resolveProofRoute(riskSummary);
      const route = buildRunRoute(contract, riskSummary);
      const projectCommands = discoverProjectCommands({ projectRoot });

      // Obligations are compiled once and fixed: each records its evidence
      // class and the exact commands allowed to prove it (P0-2/P0-3).
      const obligations = compileRunObligations({
        projectRoot,
        requiredChecks: proofRoute.requiredChecks || ['default'],
        contract,
        contractRevision: 1,
        commands: projectCommands,
        knowledgeRecords: store.listKnowledgeRecords({ projectId, statuses: ['committed'] }),
        changedPaths: normalizedChangeSet.changedPaths,
      });
      preflightTaskContract({
        contract,
        projectRoot,
        commands: projectCommands,
        obligations,
      });

      const workspaceObservation = observeWorkspaceIdentity({ projectRoot });
      const readinessCompletedAt = new Date().toISOString();
      const firstRepositoryReadAt = new Date().toISOString();
      let run = null;
      try {
        run = store.createRun({
          runId,
          objective: contract.objective,
          sourceIdentity: trustedSourceIdentity,
          workspaceIdentity: workspaceObservation.identity,
          proofTier: proofRoute.proofTier,
          evidenceTier: proofRoute.evidenceTier,
          requiredObligations: obligations.map((obligation) => obligation.obligationId),
          acceptanceCriteria: contract.acceptance.map((item) => item.statement).filter(Boolean),
          requireReleaseEvidence: proofRoute.evidenceTier === 'E2',
          projectId,
          knowledgeRevisionStart,
          projectMode: projectMode.mode,
          taskContract: contract,
          contractRevision: 1,
          route: { stages: route, riskTier: proofRoute.proofTier },
          implementationContext,
          workspaceId: effectiveWorkspaceId,
          worktreeId: effectiveWorktreeId,
          baselineChangedPaths: workspaceObservation.changedPaths || [],
          baselineWorkspaceEntries: workspaceObservation.changeEntries || [],
          reportBaselineChangedPaths: workspaceObservation.changedPaths || [],
          reportBaselineWorkspaceEntries: workspaceObservation.changeEntries || [],
        });
        recordEfficiency(runId, {
          timestamps: {
            runStartedAt,
            goalResolvedAt: readinessCompletedAt,
            readinessCompletedAt,
            firstRepositoryReadAt,
          },
          increments: { repositorySearchCount: projectMode.mode === 'greenfield' ? 0 : 1 },
        });
        store.declareRunObligations(runId, obligations);

        // K2: every run gets a durable work cursor. Ordinary work is one synthetic
        // step — the model-visible loop is unchanged — while long or complex work
        // is decomposed into units the ledger can resume, retry, and replan.
        const planned = planRunSteps({
          run,
          contract,
          obligations,
          route: { stages: route },
          planRevision: 1,
        });
        store.createRunSteps(runId, planned.steps);

        // Automatically load FRAME knowledge context and record receipt
        const frameKnowledgeCtx = await buildProjectKnowledgeContext({
          projectId,
          stage: 'FRAME',
          runId,
          objective: run.objective,
          changedPaths: normalizedChangeSet.changedPaths,
          projectRoot,
          stateStore: store,
          env: { MOON_RELAY_KERNEL_HOME: runtimeHome },
        });
        store.recordKnowledgeContextReceipt(runId, {
          stage: 'FRAME',
          knowledgeRevision: frameKnowledgeCtx.knowledgeRevision,
          digest: frameKnowledgeCtx.digest,
          receiptJson: frameKnowledgeCtx,
        });

        await syncRunLocator(run);
        await projectRunState(run, { runtimeHome });
        return run;
      } catch (error) {
        if (run && typeof store.rollbackRunInitialization === 'function') {
          try {
            store.rollbackRunInitialization(runId, { projectId, sourceIdentity: trustedSourceIdentity });
          } catch (rollbackError) {
            error.lifecycleRollback = {
              errorCode: rollbackError.code || rollbackError.message,
              message: rollbackError.message,
            };
          }
        }
        throw error;
      }
    },

    async startSuccessor({ invocation, objective, taskContract = {}, hostCapabilities = null } = {}) {
      const runStartedAt = new Date().toISOString();
      if (invocation?.mode !== 'successor' || !invocation.predecessorRunId) {
        throw Object.assign(new Error('successor_not_allowed'), {
          code: 'successor_not_allowed',
          errorCode: 'successor_not_allowed',
          nextAction: 'resolve-successor-from-current-binding',
        });
      }
      const runId = invocation.runId;
      const contract = normalizeTaskContract(taskContract, {
        objective: objective || taskContract.objective,
      });
      if (hostCapabilities) assertRequiredHostCapabilities(contract, hostCapabilities, { stage: 'FRAME' });
      const trustedSourceIdentity = computeKernelSourceIdentity({
        projectRoot,
        objective: contract.objective,
        taskContract: contract,
      });
      const projectId = currentProject.projectId;
      await ensureKnowledgeStoreDirectories(projectId, {
        env: { MOON_RELAY_KERNEL_HOME: runtimeHome },
      });
      const knowledgeRevisionStart = String(store.getProjectKnowledgeRevision(projectId));
      const hasKernelKnowledge = store.listKnowledgeRecords({ projectId }).length > 0;
      const projectMode = detectProjectMode({ projectRoot, hasKernelKnowledge });
      let implementationContext;
      if (projectMode.mode === 'greenfield') {
        const { planWalkingSkeleton } = await import('./task/greenfield-bootstrap.mjs');
        implementationContext = {
          walkingSkeleton: planWalkingSkeleton({
            projectType: contract.flags?.projectType || 'library',
            objective: contract.objective,
            taskContract: contract,
          }),
        };
      } else {
        const repositoryScan = scanRepositoryEvidence({ projectRoot });
        implementationContext = {
          entrypoints: repositoryScan.entrypoints,
          manifests: repositoryScan.manifests,
          knownCommands: [...repositoryScan.testCommands, ...repositoryScan.buildCommands]
            .map((entry) => entry.commandRef),
          baseline: { status: contract.flags?.baselineRequired ? 'required' : 'deferred' },
        };
      }
      const normalizedChangeSet = normalizeChangedContract(taskContract);
      const riskSummary = {
        ...riskSummaryFromContract(contract),
        filesChanged: contract.filesChanged || normalizedChangeSet.changedFileCount,
      };
      const proofRoute = resolveProofRoute(riskSummary);
      const route = buildRunRoute(contract, riskSummary);
      const projectCommands = discoverProjectCommands({ projectRoot });
      const obligations = compileRunObligations({
        projectRoot,
        requiredChecks: proofRoute.requiredChecks || ['default'],
        contract,
        contractRevision: 1,
        commands: projectCommands,
        knowledgeRecords: store.listKnowledgeRecords({ projectId, statuses: ['committed'] }),
        changedPaths: normalizedChangeSet.changedPaths,
      });
      preflightTaskContract({
        contract,
        projectRoot,
        commands: projectCommands,
        obligations,
      });
      const workspaceObservation = observeWorkspaceIdentity({ projectRoot });
      const readinessCompletedAt = new Date().toISOString();
      const firstRepositoryReadAt = new Date().toISOString();
      const successorRun = {
        runId,
        objective: contract.objective,
        sourceIdentity: trustedSourceIdentity,
        workspaceIdentity: workspaceObservation.identity,
        runStartWorkspaceIdentity: workspaceObservation.identity,
        proofTier: proofRoute.proofTier,
        evidenceTier: proofRoute.evidenceTier,
        requiredObligations: obligations.map((obligation) => obligation.obligationId),
        acceptanceCriteria: contract.acceptance.map((item) => item.statement).filter(Boolean),
        requireReleaseEvidence: proofRoute.evidenceTier === 'E2',
        projectId,
        knowledgeRevisionStart,
        projectMode: projectMode.mode,
        taskContract: contract,
        contractRevision: 1,
        route: {
          stages: route,
          riskTier: proofRoute.proofTier,
        },
        implementationContext,
        workspaceId: effectiveWorkspaceId,
        worktreeId: effectiveWorktreeId,
        baselineChangedPaths: workspaceObservation.changedPaths || [],
        baselineWorkspaceEntries: workspaceObservation.changeEntries || [],
        reportBaselineChangedPaths: workspaceObservation.changedPaths || [],
        reportBaselineWorkspaceEntries: workspaceObservation.changeEntries || [],
      };
      const planned = planRunSteps({
        run: successorRun,
        contract,
        obligations,
        route: { stages: route },
        planRevision: 1,
      });
      const successorBinding = hostSessionId ? normalizeSessionBinding({
          sessionId: hostSessionId,
          runId,
          projectId,
          workspaceId: effectiveWorkspaceId,
          workspaceRoot: path.resolve(projectRoot),
          provider: hostProvider,
          surface: env.MOON_RELAY_KERNEL_SURFACE || null,
          accessMode: 'owner',
        }) : null;
      const predecessor = store.getRun(invocation.predecessorRunId);
      const currentLock = predecessor?.workspaceId
        ? store.getWorkspaceMutationLockV2(predecessor.workspaceId)
        : null;
      const result = store.createSuccessorRunAtomic({
        projectId,
        sessionId: hostSessionId,
        predecessorRunId: invocation.predecessorRunId,
        predecessorBindingId: invocation.binding?.bindingId || null,
        successorRun,
        successorBinding,
        obligations,
        steps: planned.steps,
        successorKey: buildSuccessorKey({
          projectId,
          predecessorRunId: invocation.predecessorRunId,
          worktreeId: effectiveWorktreeId,
          taskContractDigest: contract.digest,
        }),
        predecessorLock: currentLock?.holderRunId === invocation.predecessorRunId
          ? currentLock
          : null,
      });
      if (result.created) {
        recordEfficiency(runId, {
          timestamps: {
            runStartedAt,
            goalResolvedAt: readinessCompletedAt,
            readinessCompletedAt,
            firstRepositoryReadAt,
          },
          increments: { repositorySearchCount: projectMode.mode === 'greenfield' ? 0 : 1 },
        });
        const frameKnowledgeCtx = await buildProjectKnowledgeContext({
          projectId,
          stage: 'FRAME',
          runId,
          objective: result.run.objective,
          changedPaths: normalizedChangeSet.changedPaths,
          projectRoot,
          stateStore: store,
          env: { MOON_RELAY_KERNEL_HOME: runtimeHome },
        });
        store.recordKnowledgeContextReceipt(runId, {
          stage: 'FRAME',
          knowledgeRevision: frameKnowledgeCtx.knowledgeRevision,
          digest: frameKnowledgeCtx.digest,
          receiptJson: frameKnowledgeCtx,
        });
        await projectRunState(result.run, { runtimeHome });
      }
      await syncRunLocator(result.run);
      return {
        status: result.created ? 'created' : 'resumed',
        run: result.run,
        next: await this.next(result.run.runId),
      };
    },

    async resolveRunId({ explicitRunId = null, envRunId = null } = {}) {
      if (explicitRunId && envRunId && String(explicitRunId) !== String(envRunId)) {
        throw Object.assign(new Error('run_binding_conflict'), {
          code: 'run_binding_conflict',
          errorCode: 'run_binding_conflict',
          nextAction: 'reopen-from-correct-worktree',
        });
      }
      if (requireHostBinding && !hostSessionId) {
        throw Object.assign(new Error('host_binding_missing'), { code: 'host_binding_missing' });
      }
      const binding = hostSessionId ? getHostBinding() : null;
      const worktreeLease = effectiveWorktreeId && typeof store.getWorktreeMutationLease === 'function'
        ? store.getWorktreeMutationLease(effectiveWorktreeId)
        : null;
      const mutable = store.listRuns({
        projectId: currentProject.projectId,
        worktreeId: effectiveWorktreeId,
        statuses: ['active', 'blocked'],
      }).filter((run) => run.status === 'active'
        || (worktreeLease?.projectId === currentProject.projectId
          && worktreeLease?.holderRunId === run.runId));
      if (mutable.length > 1) {
        throw Object.assign(new Error('worktree_run_conflict'), {
          code: 'worktree_run_conflict',
          errorCode: 'worktree_run_conflict',
          nextAction: 'resolve-conflicting-active-runs',
        });
      }
      const requested = explicitRunId || envRunId || mutable[0]?.runId || binding?.runId || null;
      if (!requested) {
        throw Object.assign(new Error('host_binding_missing'), {
          code: 'host_binding_missing',
          errorCode: 'host_binding_missing',
          nextAction: 'supply-a-task-contract',
          details: {
            remediation: {
              action: 'supply-a-task-contract',
              command: 'kernel next --contract-json <task-contract.json>',
            },
          },
        });
      }
      if (binding && binding.runId === requested) {
        preflight(requested, 'next');
        return requested;
      }
      const envProjectId = env.MOON_RELAY_KERNEL_PROJECT_ID || currentProject.projectId;
      if (envProjectId !== currentProject.projectId) throw Object.assign(new Error('run_project_mismatch'), { code: 'run_project_mismatch' });
      preflight(requested, 'next');
      return String(requested);
    },

    // Host bootstrap (P0-1). The model only ever calls `next` and `report`, so
    // the run must come into existence without a model-visible `start` command.
    // ensureRun is idempotent: it creates the run on first call for a run id
    // and resumes it afterwards, and it is what `kernel next --contract-json`
    // uses to bootstrap a turn.
    async ensureRun({ runId, objective, taskContract = {} } = {}) {
      if (!runId) throw new Error('ensureRun requires a runId');
      const metadata = store.getRunMetadata(runId);
      if (!metadata) {
        let createdRun = null;
        try {
          createdRun = await this.startRun({ runId, objective, taskContract });
          if (hostSessionId) {
            const binding = normalizeSessionBinding({
              sessionId: hostSessionId,
              runId,
              projectId: currentProject.projectId,
              workspaceId: effectiveWorkspaceId,
              workspaceRoot: path.resolve(projectRoot),
              provider: env.MOON_RELAY_KERNEL_PROVIDER || 'unknown',
              surface: env.MOON_RELAY_KERNEL_SURFACE || null,
              accessMode: 'owner',
            });
            store.createSessionBinding(binding);
          }
          return { status: 'created', run: createdRun, next: await this.next(runId) };
        } catch (error) {
          if (createdRun && typeof store.rollbackRunInitialization === 'function') {
            try {
              store.rollbackRunInitialization(runId, {
                projectId: currentProject.projectId,
                sourceIdentity: createdRun.sourceIdentity,
              });
            } catch (rollbackError) {
              error.lifecycleRollback = {
                errorCode: rollbackError.code || rollbackError.message,
                message: rollbackError.message,
              };
            }
          }
          throw error;
        }
      }
      if (hostSessionId && !getHostBinding({ runId })) {
        if (metadata.status === 'blocked' && metadata.ownerBindingId) {
          store.reactivateBlockedRunBinding(normalizeSessionBinding({
            bindingId: metadata.ownerBindingId,
            sessionId: hostSessionId,
            runId,
            projectId: currentProject.projectId,
            workspaceId: effectiveWorkspaceId,
            workspaceRoot: path.resolve(projectRoot),
            provider: env.MOON_RELAY_KERNEL_PROVIDER || 'unknown',
            surface: env.MOON_RELAY_KERNEL_SURFACE || null,
            accessMode: 'owner',
          }));
        }
        // Additive legacy adoption is deliberately one-shot. Only an
        // unowned run in this exact project/workspace can acquire its first
        // owner binding; once owner_binding_id is populated, another session
        // must be authorized by the Host rather than claiming the run here.
        if (
          !metadata.ownerBindingId
          && metadata.projectId === currentProject.projectId
          && (!metadata.workspaceId || metadata.workspaceId === effectiveWorkspaceId)
        ) {
          store.adoptUnownedRunBinding(normalizeSessionBinding({
            sessionId: hostSessionId,
            runId,
            projectId: currentProject.projectId,
            workspaceId: effectiveWorkspaceId,
            workspaceRoot: path.resolve(projectRoot),
            provider: env.MOON_RELAY_KERNEL_PROVIDER || 'unknown',
            surface: env.MOON_RELAY_KERNEL_SURFACE || null,
            accessMode: 'owner',
          }));
        }
      }
      preflight(runId, 'next');
      const existing = store.getRun(runId);
      // An existing Run carries the active Goal. A new contract is a
      // revision of that Run, never a reason to fragment the lifecycle.
      if (objective || (taskContract && Object.keys(taskContract).length > 0)) {
        // The replacement helper preserves only compatible step structure;
        // acceptance, scope, and obligations are authoritative in this input.
        const mergedRevision = replaceContractRevisionWithBindings(
          existing.taskContract,
          normalizeTaskContract(taskContract, { objective: objective || existing.objective }),
        );
        const merged = mergedRevision.contract;
        if (existing.taskContract) {
          const contractChanged = merged.digest !== existing.taskContract.digest;
          if (contractChanged) {
            await this.reviseContract(runId, merged, { acceptanceIdMap: mergedRevision.acceptanceIdMap });
          }
          const activeContract = contractChanged ? merged : existing.taskContract;
          const currentRun = store.getRun(runId);
          const currentStep = this.getCurrentStep(runId);
          const amendedStep = resolveDeclaredStepForReplan(activeContract, currentStep);
          const requiresSyntheticReplan = contractChanged && activeContract.steps.length === 0;
          const requiresScopeReplan = requiresSyntheticReplan || stepScopeChanged(currentStep, amendedStep);
          const currentPlan = store.getRunSteps(runId, { planRevision: currentRun.planRevision });
          const requiresCompletedPlanReplan = !currentStep
            && activeContract.steps.length > 0
            && planDiffersFromContract(currentPlan, activeContract.steps);
          if (requiresScopeReplan || requiresCompletedPlanReplan) {
            await this.replanSteps(runId, {
              steps: requiresSyntheticReplan
                ? []
                : requiresCompletedPlanReplan
                ? activeContract.steps
                : [{
                  ...amendedStep,
                  dependsOn: [],
                }],
              resumeBlockedReason: existing.status === 'blocked'
                && existing.blockedReason === 'unsupported-verification'
                ? 'unsupported-verification'
                : null,
            });
          }
        }
      }
      return { status: 'resumed', run: store.getRun(runId), next: await this.next(runId) };
    },

    // Persists a refined Task Contract and recompiles obligations against it,
    // so a plan supplied after FRAME is a binding change, not a note (P0-5).
    async reviseContract(runId, contract, { acceptanceIdMap = null } = {}) {
      const run = store.getRun(runId);
      if (!run) throw new Error(`Run ${runId} not found`);
      const nextContractRevision = Number(run.contractRevision || 1) + 1;
      const obligations = compileRunObligations({
        projectRoot,
        requiredChecks: KERNEL_POLICY.requiredChecks[run.proofTier] || ['default'],
        contract,
        contractRevision: nextContractRevision,
        commands: discoverProjectCommands({ projectRoot }),
        knowledgeRecords: run.projectId
          ? store.listKnowledgeRecords({ projectId: run.projectId, statuses: ['committed'] })
          : [],
        changedPaths: contract.changedPaths || [],
      });
      preflightTaskContract({
        contract,
        projectRoot,
        commands: discoverProjectCommands({ projectRoot }),
        obligations,
        acceptanceIdMap,
      });
      // The contract already contains canonicalized successor references. Keep
      // the mapping visible to this boundary for lineage, but never rewrite
      // predecessor proof from an old AC namespace using successor-local IDs.
      void acceptanceIdMap;
      const updated = typeof store.reviseTaskContractAtomic === 'function'
        ? store.reviseTaskContractAtomic(runId, contract, { obligations })
        : store.updateTaskContract(runId, contract);
      recordEfficiency(runId, { increments: { contractRepairCount: 1 } });
      if (typeof store.reviseTaskContractAtomic !== 'function') {
        store.declareRunObligations(runId, obligations);
        const merged = [...new Set([...updated.requiredObligations, ...obligations.map((obligation) => obligation.obligationId)])];
        const escalated = store.escalateRun(runId, { addObligations: merged });
        await projectRunState(escalated, { runtimeHome });
        return escalated;
      }
      await projectRunState(updated, { runtimeHome });
      return updated;
    },

    async getRun(runId) {
      return store.getRun(runId);
    },

    async abandon(runId, { reason = 'user_requested' } = {}) {
      if (!runId) throw new Error('abandon requires a runId');
      const result = store.abandonRun(runId, { reason });
      await syncRunLocator(result);
      return result;
    },

    async buildStageContext(runId, { stage = 'EXECUTE', taskContract = {}, principles, principleExtensions = [], stageRecords = [], references = [], evidence = [] } = {}) {
      try { preflight(runId, 'context'); } catch (error) { return bindingErrorPayload(error, { projectRoot, provider: hostProvider }); }
      const run = store.getRun(runId);
      if (!run) throw new Error(`Run ${runId} not found`);

      const normalizedChangeSet = normalizeChangedContract(taskContract);
      const projectId = run.projectId || currentProject.projectId;
      const knowledgeCtx = await buildProjectKnowledgeContext({
        projectId,
        stage,
        runId,
        objective: run.objective,
        changedPaths: normalizedChangeSet.changedPaths,
        projectRoot,
        stateStore: store,
        env: { MOON_RELAY_KERNEL_HOME: runtimeHome },
      });
      store.recordKnowledgeContextReceipt(runId, {
        stage,
        knowledgeRevision: knowledgeCtx.knowledgeRevision,
        digest: knowledgeCtx.digest,
        receiptJson: knowledgeCtx,
      });

      const canonical = loadKernelPrinciples();
      const callerValues = principles === undefined || principles === null || (typeof principles === 'object' && !Array.isArray(principles) && Object.keys(principles).length === 0)
        ? []
        : (Array.isArray(principles) ? principles : Object.entries(principles).map(([id, value]) => ({ id, guidance: value, rationale: 'Caller-supplied extension' })));
      const extensions = [...callerValues, ...(Array.isArray(principleExtensions) ? principleExtensions : [])].map((extension, index) => {
        const candidate = typeof extension === 'string'
          ? { id: `caller.${index + 1}`, guidance: extension, rationale: 'Caller-supplied extension' }
          : extension;
        if (!candidate || typeof candidate !== 'object' || !candidate.id || !candidate.guidance || !candidate.rationale) {
          throw new KernelPrinciplesError('kernel_principle_extension_invalid', 'Caller principle extensions require id, guidance, and rationale');
        }
        if (canonical.principles.some((principle) => principle.id === candidate.id)) {
          throw new KernelPrinciplesError('kernel_principle_override_forbidden', `Canonical principle override is forbidden: ${candidate.id}`);
        }
        if (!/^(?:caller|extension)[.:\/-]/.test(candidate.id)) {
          throw new KernelPrinciplesError('kernel_principle_extension_namespace_required', `Caller principle extension must use caller.* or extension.* namespace: ${candidate.id}`);
        }
        return { id: String(candidate.id), guidance: String(candidate.guidance), rationale: String(candidate.rationale) };
      });

      const persistedEvidence = store.getVerifications(runId).map((verification) => ({
        id: `verification-${verification.obligationId}`,
        type: 'evidence-digest',
        content: JSON.stringify({
          obligationId: verification.obligationId,
          status: verification.status,
          evidenceRef: verification.evidenceRef,
          command: verification.command,
          exitCode: verification.exitCode,
          evidenceDigest: verification.evidenceDigest,
          acceptanceCoverage: verification.acceptanceCoverage,
        }),
        revision: String(verification.verifiedRuntimeRevision || run.revision),
        sourceRef: verification.evidenceRef || `verification:${verification.id}`,
        trust: 'persisted-verification',
      }));
      const capabilityDecision = resolveKernelCapabilities({ ...taskContract, stage, taskClass: taskContract.taskClass || 'feature' });

      const context = await buildContextReceipt({
        taskContract: { objective: run.objective, ...taskContract },
        principles: [...canonical.principles, ...extensions],
        principleSource: canonical,
        stage,
        stageRecords: [
          { id: `stage-${runId}`, type: 'stage-context', content: JSON.stringify({ runId, state: run.state, stage }), revision: String(run.revision), sourceRef: `run:${runId}`, trust: 'persisted-run-state' },
          { id: `capability-decision-${runId}`, type: 'stage-context', content: JSON.stringify(capabilityDecision), revision: capabilityDecision.revision, sourceRef: 'catalog/kernel-skills.json', trust: 'canonical-catalog' },
          { id: `knowledge-context-${runId}`, type: 'knowledge-context', content: JSON.stringify({ digest: knowledgeCtx.digest, contextPackRef: knowledgeCtx.contextPackRef, promptBlock: knowledgeCtx.promptBlock }), revision: String(knowledgeCtx.knowledgeRevision), sourceRef: knowledgeCtx.contextPackRef, trust: 'verified-knowledge' },
          ...stageRecords,
        ],
        references,
        evidence: [...persistedEvidence, ...evidence],
      });
      const contextItems = [...stageRecords, ...references, ...evidence]
        .filter((entry) => entry && typeof entry === 'object');
      const seenSourceRefs = new Set();
      let sameFileReadCount = 0;
      for (const entry of contextItems) {
        const sourceRef = entry.sourceRef || entry.path || entry.file;
        if (!sourceRef) continue;
        const normalizedSourceRef = String(sourceRef).replaceAll('\\', '/');
        if (seenSourceRefs.has(normalizedSourceRef)) sameFileReadCount += 1;
        seenSourceRefs.add(normalizedSourceRef);
      }
      const omittedEntries = Array.isArray(context.omitted) ? context.omitted : [];
      const contextWasCompacted = omittedEntries.some((entry) => entry?.reason === 'context-budget')
        || String(context.promptBlock || '').includes('[TRUNCATED]');
      recordEfficiency(runId, {
        increments: {
          ...(sameFileReadCount > 0 ? { sameFileReadCount } : {}),
          ...(contextWasCompacted ? { contextCompactionCount: 1 } : {}),
        },
      });
      context.knowledgeContext = knowledgeCtx;
      return context;
    },

    async materializeStageKnowledge(runId, { stage, strict = true } = {}) {
      return this.refreshStageKnowledge(runId, { stage, strict });
    },

    refreshVerificationBindings(runId) {
      return refreshProofPolicyBindings(runId);
    },

    async transition(runId, nextState, options = {}) {
      if (String(nextState || '').toUpperCase() === 'PROVE') {
        const obligations = this.refreshVerificationBindings(runId);
        const currentRun = store.getRun(runId);
        if (options.hostCapabilities) {
          assertRequiredHostCapabilities(currentRun?.taskContract || {}, options.hostCapabilities, {
            stage: 'PROVE',
            obligations,
          });
        }
        try {
          assertVerificationSupport(obligations, { completionPredicate: currentRun?.taskContract?.completionPredicate }, { projectMode: currentRun?.projectMode });
        } catch (error) {
          store.markRunBlocked(runId, 'unsupported-verification');
          await projectRunState(store.getRun(runId), { runtimeHome });
          throw error;
        }
      }
      await this.materializeStageKnowledge(runId, {
        stage: nextState,
        strict: true,
      });

      const updated = store.transition(runId, nextState, options);
      await projectRunState(updated, { runtimeHome });
      return updated;
    },

    async abandonRun(runId) {
      const updated = store.abandonRun(runId);
      await syncRunLocator(updated);
      await projectRunState(updated, { runtimeHome });
      return updated;
    },

    async recordProof(runId, { obligationId = 'default', status, sourceIdentity, evidenceRef, command, commandRef = null, exitCode = 0, evidenceDigest, acceptanceCoverage = [], evidenceClass = null } = {}) {
      const run = store.getRun(runId);
      const effectiveSourceIdentity = sourceIdentity || run?.sourceIdentity;
      const updated = store.recordVerification(runId, {
        obligationId,
        status,
        evidenceRef,
        sourceIdentity: effectiveSourceIdentity,
        commandRef,
        command,
        exitCode,
        evidenceDigest,
        acceptanceCoverage,
        evidenceClass,
        executor: 'caller-attested',
      });
      persistReleaseEvidenceIfNeeded(runId, updated);

      await projectRunState(updated, { runtimeHome });
      return updated;
    },

    // Migration impact analysis (§16.4). Validates the change-seam analysis,
    // and when a migration is required, escalates the run to T3 and adds the
    // protected migration-smoke obligation. Missing rollback / verification
    // seam blocks the run instead of proceeding.
    async analyzeMigration(runId, impact = {}) {
      const run = store.getRun(runId);
      if (!run) throw new Error(`Run ${runId} not found`);
      const { buildImpactAnalysis } = await import('./task/migration-workflow.mjs');
      const result = buildImpactAnalysis(impact);

      if (result.blockingFindings.length > 0) {
        store.markRunBlocked(runId, 'external-dependency');
        await projectRunState(store.getRun(runId), { runtimeHome });
        return { ...result, status: 'blocked', blockedReason: 'external-dependency' };
      }

      let escalated = run;
      if (result.analysis.migrationRequired) {
        escalated = store.escalateRun(runId, {
          proofTier: result.requiredTier,
          evidenceTier: 'E2',
          addObligations: result.requiredObligations,
        });
        await projectRunState(escalated, { runtimeHome });
      }
      return { ...result, status: 'ready', run: escalated };
    },

    // Stagnation detection (§25 P3): repeated failing attempts with no
    // progress on the same obligation.
    detectStagnation(runId, { threshold } = {}) {
      return hostRouting.detectStagnation(runId, { threshold });
    },

    // Records a replan event (durable, measured). Used when stagnation or a new
    // risk requires a different approach.
    async signalReplan(runId) {
      const updated = store.incrementReplanCount(runId);
      await projectRunState(updated, { runtimeHome });
      return updated;
    },

    // K2 §7.9: stagnation is judged per unit of work as well as per run. A step
    // that keeps failing the same way escalates the route even when the run-wide
    // attempt counter has not reached its threshold yet.
    // Only the step's CONSECUTIVE-FAILURE signal escalates the route. Its looser
    // signals (a no-op retry, an identical result digest) fire at two attempts,
    // which would overtake the retry-escalation threshold and make it
    // unreachable — stagnation outranks retry. Those signals still drive the
    // replan recommendation. Parallel selection is derived again from the
    // resulting Step Ledger, so no execution lifecycle needs suspension.
    stagnationSignal(runId) {
      return hostRouting.stagnationSignal(runId);
    },

    // Measurement-based routing recommendation (policy only; no provider call).
    recommendRouting(runId, { independentReviewRequired = false } = {}) {
      return hostRouting.recommendRouting(runId, { independentReviewRequired });
    },

    // Decides the LOGICAL model class for the action the model is about to
    // perform and persists it before the Host dispatches (§16.5). Provider
    // identity is never decided here — only the class the Host must satisfy.
    async decideModelRoute(runId, { actionKind, obligationId = null, independentReviewRequired = false, planInvalid = false, architectureDeviation = false, protectedObligationFailed = false, workProfile = null, complexity = null } = {}) {
      return hostRouting.decideModelRoute(runId, {
        actionKind,
        obligationId,
        independentReviewRequired,
        planInvalid,
        architectureDeviation,
        protectedObligationFailed,
        workProfile,
        complexity,
      });
    },

    // Host-only turn API (§8.2). `next` stays exactly as the model sees it;
    // the routing directive travels beside it, never inside it.
    async hostNext(runId, { hostCapabilities = {}, actionContext = {}, modelInput: preloadedModelInput = null } = {}) {
      const run = store.getRun(runId);
      if (!run) return { schemaVersion: 1, runId, status: 'not_found' };
      const capabilities = normalizeHostCapabilities(hostCapabilities);
      let modelInput = preloadedModelInput || await this.next(runId, { stepId: actionContext.stepId || null });
      if (modelInput.action?.type === 'baseline-required') {
        await this.captureBaseline(runId, {
          commandRefs: modelInput.action.commandRefs,
          timeoutMs: actionContext.baselineTimeoutMs || 120000,
        });
        modelInput = await this.next(runId, { stepId: actionContext.stepId || null });
      }
      // Contract admission is a pre-dispatch boundary. A malformed persisted
      // contract must not acquire a mutation lock, route decision, capsule,
      // attempt, or provider admission while the Host is recovering it.
      if (modelInput.status === 'contract-rejected') return modelInput;
      const reviewerTurn = String(actionContext.actionKind || '').startsWith('review');
      if (['implement', 'fix'].includes(modelInput.action?.type) && !reviewerTurn) {
        const capsuleStep = actionContext.stepId
          ? this.ensureRunStepsMigrated(runId).find((entry) => entry.stepId === actionContext.stepId)
          : this.getCurrentStep(runId);
        try {
          assertImplementationWorkUnitScope({
            step: capsuleStep,
            contract: run.taskContract,
            actionType: modelInput.action.type,
          });
        } catch (error) {
          return buildWorkUnitScopeRejection({ runId, modelInput, capabilities, error });
        }
      }
      let mutationLock = null;
      const workspaceIdForTurn = actionContext.workspaceId || run.workspaceId || effectiveWorkspaceId;
      if (['implement', 'fix'].includes(modelInput.action?.type)) {
        const lockResult = store.acquireWorkspaceMutationLockV2({
          workspaceId: workspaceIdForTurn,
          projectId: run.projectId,
          runId,
          sessionToken: holder,
          ttlMs: actionContext.mutationLockTtlMs || 60000,
        });
        if (!lockResult.acquired) {
          modelInput.status = 'blocked';
          modelInput.errorCode = 'workspace_mutation_conflict';
          modelInput.nextAction = 'create-worktree';
          modelInput.action = {
            type: 'blocked',
            reason: 'workspace_mutation_conflict',
            guidance: `Workspace is held by run ${lockResult.lock.holderRunId}.`,
          };
        } else {
          mutationLock = lockResult.lock;
        }
      }
      const decision = await this.decideModelRoute(runId, {
        actionKind: actionContext.actionKind || actionKindForModelAction(modelInput.action?.type),
        obligationId: actionContext.obligationId ?? modelInput.action?.outstandingObligations?.[0] ?? null,
        independentReviewRequired: actionContext.independentReviewRequired === true,
        planInvalid: actionContext.planInvalid === true,
        architectureDeviation: actionContext.architectureDeviation === true,
        protectedObligationFailed: actionContext.protectedObligationFailed === true,
        workProfile: actionContext.workProfile || null,
        complexity: actionContext.complexity || null,
      });

      // K1: the worker's bounded context is built here, beside the routing
      // directive, so the model-visible payload keeps its shape while the Host
      // gains everything a fresh session needs. Kernel-owned actions dispatch no
      // worker, so they get no capsule.
      let executionCapsule = null;
      if (decision.modelClass !== 'kernel') {
        const latestImplementationAttempt = decision.role === 'reviewer'
          ? store.getLatestImplementationAttempt?.(runId)
          : null;
        const capsuleStep = actionContext.stepId
          ? this.ensureRunStepsMigrated(runId).find((entry) => entry.stepId === actionContext.stepId)
          : this.getCurrentStep(runId)
            || (latestImplementationAttempt?.stepId ? store.getRunStep(runId, latestImplementationAttempt.stepId) : null);
        executionCapsule = decision.role === 'reviewer'
          ? await this.buildReviewerCapsule(runId, {
            decision,
            stage: decision.actionKind === 'review_contract' ? 'contract' : 'engineering',
            obligationId: decision.obligationId,
            changedPaths: actionContext.changedPaths || [],
            step: capsuleStep,
          })
          : await this.buildCapsule(runId, {
            role: 'implementer',
            decision,
            step: capsuleStep,
            changedPaths: actionContext.changedPaths || [],
            workspaceIdentity: actionContext.workspaceIdentity || null,
          });
        if (modelInput.action) modelInput.action.capsuleId = executionCapsule.capsuleId;
      }

      // The attempt is opened after the Kernel has issued the bounded capsule
      // but before admission/dispatch. Routed workers pass their pre-bound
      // attempt so the shared path never creates a duplicate row.
      let attempt = actionContext.attemptId
        ? store.getStepAttemptByAttemptId(actionContext.attemptId, { runId })
        : null;
      if (!attempt && decision.modelClass !== 'kernel' && executionCapsule?.stepId) {
        attempt = store.getActiveStepAttempt(runId, {
          stepId: executionCapsule.stepId,
          capsuleId: executionCapsule.capsuleId,
        });
      }
      if (decision.modelClass !== 'kernel' && executionCapsule?.stepId) {
        if (attempt) {
          this.assertAttemptLineage(attempt, { runId, stepId: executionCapsule.stepId, planRevision: run.planRevision, mutationRevision: run.mutationRevision });
          attempt = this.attachAttemptLineage(attempt.attemptId, {
            bindingId: attempt.bindingId || store.getRunOwnerBinding?.(runId)?.bindingId || null,
            capsuleId: executionCapsule.capsuleId,
            capsuleDigest: executionCapsule.provenance?.capsuleDigest || null,
            routeDecisionId: decision.decisionId,
            provenanceKind: attempt.provenanceKind === 'legacy-unattributed' ? 'routed' : attempt.provenanceKind,
            planRevision: run.planRevision,
            mutationRevision: run.mutationRevision,
          });
        } else {
          attempt = this.beginAttempt(runId, {
            stepId: executionCapsule.stepId,
            bindingId: store.getRunOwnerBinding?.(runId)?.bindingId || null,
            capsuleId: executionCapsule.capsuleId,
            capsuleDigest: executionCapsule.provenance?.capsuleDigest || null,
            routeDecisionId: decision.decisionId,
            provenanceKind: 'routed',
            planRevision: run.planRevision,
            mutationRevision: run.mutationRevision,
            workspaceIdentityStart: executionCapsule.provenance?.workspaceIdentity || run.currentWorkspaceIdentity,
            workspaceId: actionContext.workspaceId || run.workspaceId || null,
            baseWorkspaceIdentity: actionContext.workspaceIdentity || null,
          });
        }
      }

      // The model-visible `next` action carries the provider-neutral execution
      // mode. Host callers also receive the concrete assignment handle that a
      // delegated worker report may echo. The owner session is allowed to
      // execute ordinary work directly; only an explicitly independent review
      // keeps the orchestrator/worker boundary mandatory.
      const independentReviewRequired = decision.role === 'reviewer' && decision.independentContextRequired === true;
      const ownerDirectAllowed = !independentReviewRequired;
      const hasSubagentCapability = hostCapabilities?.nativeSubagent === true
        || hostCapabilities?.supportsSubagentModel === true;
      const nativeDelegationRequested = actionContext.executionMode === 'native-subagent'
        || actionContext.delegationRequested === true
        || modelInput.action?.mode === 'subagent'
        || modelInput.action?.execution?.executionMode === 'native-subagent'
        || (independentReviewRequired && hasSubagentCapability);
      const executionAssignment = decision.modelClass === 'kernel'
        ? null
        : {
          ...(nativeDelegationRequested ? { assignmentId: buildExecutionAssignmentId(decision.decisionId) } : {}),
          role: decision.role,
          workProfile: decision.workProfile,
          executionMode: nativeDelegationRequested ? 'native-subagent' : (ownerDirectAllowed ? 'owner-direct' : 'independent-review'),
          delegation: { mode: ownerDirectAllowed ? 'optional' : 'required', requested: nativeDelegationRequested },
          freshSessionRequired: decision.independentContextRequired === true
            || decision.workProfile?.independentContextRequired === true
            || decision.role === 'reviewer',
        };
      const executionContract = buildHostExecutionContract({
        decision,
        assignment: executionAssignment,
        capsule: executionCapsule,
        attemptId: attempt?.attemptId || null,
        workUnit: modelInput.action?.step || null,
      });
      return {
        schemaVersion: 1,
        runId,
        modelInput,
        executionCapsule,
        hostDirective: {
          modelRouteDecision: decision,
          executionContract,
          executionAssignment,
          hostCapabilities: capabilities,
          enforcementStrategy: resolveEnforcementStrategy(capabilities, decision),
          executionCapsule,
          attemptId: attempt?.attemptId || null,
          attempt,
          mutationLock,
        },
      };
    },

    assertMutationAllowed(request = {}) {
      return assertMutationAllowed({
        stateStore: store,
        workspaceRoot: fencingWorkspaceRoot,
        ...request,
      });
    },

    // Internal owner authority for parallel Delivery materialization. This is
    // deliberately a method on the existing Control Plane rather than a new
    // public command or lifecycle: the owner Worktree lease, workspace fence,
    // and Run CAS all remain one Kernel mutation boundary.
    acquireOwnerWorkspaceMutationFence(runId, {
      expectedMutationRevision,
      expectedWorkspaceIdentity,
      expectedHeadCommitSha,
      expectedProjectId = null,
      expectedWorktreeId = null,
      expectedWorkspaceId = null,
      sessionToken = holder,
      ttlMs = 120000,
    } = {}) {
      const run = store.getRun(runId);
      const projectId = expectedProjectId || run?.projectId || currentProject.projectId;
      const worktreeId = expectedWorktreeId || run?.worktreeId || currentWorktree.worktreeId;
      const workspaceId = expectedWorkspaceId || run?.workspaceId || currentWorktree.workspaceId;
      const required = [expectedMutationRevision, expectedWorkspaceIdentity, expectedHeadCommitSha, projectId, worktreeId, workspaceId, sessionToken];
      if (!run || run.status !== 'active') {
        throw Object.assign(new Error(`delivery_run_inactive: ${runId}`), { code: 'delivery_run_inactive', errorCode: 'delivery_run_inactive' });
      }
      if (required.some((value) => value === null || value === undefined || value === '')) {
        throw Object.assign(new Error('delivery_cas_snapshot_missing'), { code: 'delivery_cas_snapshot_missing', errorCode: 'delivery_cas_snapshot_missing' });
      }
      if (projectId !== currentProject.projectId || worktreeId !== currentWorktree.worktreeId || workspaceId !== currentWorktree.workspaceId) {
        throw Object.assign(new Error('delivery_worktree_authority_lost'), { code: 'delivery_worktree_authority_lost', errorCode: 'delivery_worktree_authority_lost' });
      }

      let lockResult;
      try {
        lockResult = store.acquireWorkspaceMutationLockV2({
          workspaceId,
          projectId,
          runId,
          sessionToken,
          ttlMs,
        });
      } catch (error) {
        throw Object.assign(new Error(`delivery_worktree_authority_lost: ${error.message}`), {
          code: 'delivery_worktree_authority_lost',
          errorCode: 'delivery_worktree_authority_lost',
          cause: error,
        });
      }
      if (!lockResult?.acquired) {
        throw Object.assign(new Error(`delivery_mutation_fence_lost: workspace is held by ${lockResult?.lock?.holderRunId || 'another run'}`), {
          code: 'delivery_mutation_fence_lost',
          errorCode: 'delivery_mutation_fence_lost',
          lock: lockResult?.lock || null,
        });
      }

      try {
        const assertion = assertOwnerWorkspaceMutationCAS({
          stateStore: store,
          workspaceRoot: fencingWorkspaceRoot,
          runId,
          workspaceId,
          projectId,
          worktree: currentWorktree,
          fencingToken: lockResult.lock.fencingToken,
          sessionToken,
          expectedMutationRevision,
          expectedWorkspaceIdentity,
          expectedHeadCommitSha,
          expectedProjectId: projectId,
          expectedWorktreeId: worktreeId,
          expectedWorkspaceId: workspaceId,
          phase: 'pre',
        });
        return {
          lock: lockResult.lock,
          snapshot: {
            runId,
            expectedMutationRevision: Number(expectedMutationRevision),
            expectedWorkspaceIdentity,
            expectedHeadCommitSha,
            expectedProjectId: projectId,
            expectedWorktreeId: worktreeId,
            expectedWorkspaceId: workspaceId,
          },
          assertion,
        };
      } catch (error) {
        try {
          store.releaseWorkspaceMutationLockV2({
            workspaceId,
            runId,
            sessionToken,
            fencingToken: lockResult.lock.fencingToken,
          });
        } catch {}
        throw error;
      }
    },

    renewOwnerWorkspaceMutationFence(runId, {
      expectedMutationRevision,
      expectedWorkspaceIdentity,
      expectedHeadCommitSha,
      expectedProjectId = null,
      expectedWorktreeId = null,
      expectedWorkspaceId = null,
      workspaceId = expectedWorkspaceId,
      fencingToken,
      sessionToken = holder,
      ttlMs = 120000,
    } = {}) {
      const run = store.getRun(runId);
      const projectId = expectedProjectId || run?.projectId || currentProject.projectId;
      const worktreeId = expectedWorktreeId || run?.worktreeId || currentWorktree.worktreeId;
      const effectiveWorkspaceId = workspaceId || run?.workspaceId || currentWorktree.workspaceId;
      const required = [expectedMutationRevision, expectedWorkspaceIdentity, expectedHeadCommitSha, projectId, worktreeId, effectiveWorkspaceId, fencingToken, sessionToken];
      if (!run || run.status !== 'active') {
        throw Object.assign(new Error(`delivery_run_inactive: ${runId}`), { code: 'delivery_run_inactive', errorCode: 'delivery_run_inactive' });
      }
      if (required.some((value) => value === null || value === undefined || value === '')) {
        throw Object.assign(new Error('delivery_cas_snapshot_missing'), { code: 'delivery_cas_snapshot_missing', errorCode: 'delivery_cas_snapshot_missing' });
      }
      let renewal;
      try {
        renewal = store.renewWorkspaceMutationLockV2({
          workspaceId: effectiveWorkspaceId,
          projectId,
          runId,
          sessionToken,
          fencingToken,
          ttlMs,
        });
      } catch (error) {
        throw Object.assign(new Error(`delivery_mutation_fence_lost: ${error.message}`), {
          code: 'delivery_mutation_fence_lost',
          errorCode: 'delivery_mutation_fence_lost',
          cause: error,
        });
      }
      if (!renewal?.renewed) {
        throw Object.assign(new Error('delivery_mutation_fence_lost: owner mutation fence could not be renewed'), {
          code: 'delivery_mutation_fence_lost',
          errorCode: 'delivery_mutation_fence_lost',
          lock: renewal?.lock || null,
        });
      }
      try {
        const assertion = assertOwnerWorkspaceMutationCAS({
          stateStore: store,
          workspaceRoot: fencingWorkspaceRoot,
          runId,
          workspaceId: effectiveWorkspaceId,
          projectId,
          worktree: currentWorktree,
          fencingToken,
          sessionToken,
          expectedMutationRevision,
          expectedWorkspaceIdentity,
          expectedHeadCommitSha,
          expectedProjectId: projectId,
          expectedWorktreeId: worktreeId,
          expectedWorkspaceId: effectiveWorkspaceId,
          phase: 'pre',
        });
        return {
          lock: renewal.lock,
          snapshot: {
            runId,
            expectedMutationRevision: Number(expectedMutationRevision),
            expectedWorkspaceIdentity,
            expectedHeadCommitSha,
            expectedProjectId: projectId,
            expectedWorktreeId: worktreeId,
            expectedWorkspaceId: effectiveWorkspaceId,
          },
          assertion,
        };
      } catch (error) {
        throw error;
      }
    },

    // Validate the owner mutation immediately before applying a prepared patch.
    // The snapshot is deliberately transient: the existing Run mutation
    // provenance is the only durable owner-mutation record, so this boundary
    // cannot create a second Delivery lifecycle in the State Store.
    assertOwnerWorkspaceMutationReady(runId, {
      expectedMutationRevision,
      expectedWorkspaceIdentity,
      expectedHeadCommitSha,
      expectedProjectId = null,
      expectedWorktreeId = null,
      expectedWorkspaceId = null,
      fencingToken,
      sessionToken = holder,
      integrationWorkspaceIdentity,
      changedPaths = [],
      patchDigest = null,
    } = {}) {
      const run = store.getRun(runId);
      const projectId = expectedProjectId || run?.projectId || currentProject.projectId;
      const worktreeId = expectedWorktreeId || run?.worktreeId || currentWorktree.worktreeId;
      const workspaceId = expectedWorkspaceId || run?.workspaceId || currentWorktree.workspaceId;
      const committedPaths = canonicalChangedPaths(changedPaths);
      if (!integrationWorkspaceIdentity || !patchDigest || committedPaths.length === 0) {
        throw Object.assign(new Error('delivery_mutation_input_incomplete'), {
          code: 'delivery_mutation_input_incomplete',
          errorCode: 'delivery_mutation_input_incomplete',
        });
      }
      assertOwnerWorkspaceMutationCAS({
        stateStore: store,
        workspaceRoot: fencingWorkspaceRoot,
        runId,
        workspaceId,
        projectId,
        worktree: currentWorktree,
        fencingToken,
        sessionToken,
        expectedMutationRevision,
        expectedWorkspaceIdentity,
        expectedHeadCommitSha,
        expectedProjectId: projectId,
        expectedWorktreeId: worktreeId,
        expectedWorkspaceId: workspaceId,
        phase: 'pre',
      });
      const snapshot = {
        runId,
        expectedMutationRevision: Number(expectedMutationRevision),
        expectedWorkspaceIdentity,
        expectedHeadCommitSha,
        expectedProjectId: projectId,
        expectedWorktreeId: worktreeId,
        expectedWorkspaceId: workspaceId,
      };
      return { snapshot, integrationWorkspaceIdentity, changedPaths: canonicalChangedPaths(changedPaths), patchDigest };
    },

    recordOwnerWorkspaceMutation(runId, {
      expectedMutationRevision,
      expectedWorkspaceIdentity,
      expectedHeadCommitSha,
      expectedProjectId = null,
      expectedWorktreeId = null,
      expectedWorkspaceId = null,
      fencingToken,
      sessionToken = holder,
      integrationWorkspaceIdentity,
      changedPaths = [],
      patchDigest = null,
    } = {}) {
      const run = store.getRun(runId);
      const projectId = expectedProjectId || run?.projectId || currentProject.projectId;
      const worktreeId = expectedWorktreeId || run?.worktreeId || currentWorktree.worktreeId;
      const workspaceId = expectedWorkspaceId || run?.workspaceId || currentWorktree.workspaceId;
      const deliveryWorkspaceIdentity = observeWorkspaceIdentity({ projectRoot: fencingWorkspaceRoot }).identity;
      const committedPaths = canonicalChangedPaths(changedPaths);
      assertOwnerWorkspaceMutationCAS({
        stateStore: store,
        workspaceRoot: fencingWorkspaceRoot,
        runId,
        workspaceId,
        projectId,
        worktree: currentWorktree,
        fencingToken,
        sessionToken,
        expectedMutationRevision,
        expectedWorkspaceIdentity,
        expectedHeadCommitSha,
        expectedProjectId: projectId,
        expectedWorktreeId: worktreeId,
        expectedWorkspaceId: workspaceId,
        actualWorkspaceIdentity: deliveryWorkspaceIdentity,
        phase: 'post',
      });
      if (!integrationWorkspaceIdentity || deliveryWorkspaceIdentity !== integrationWorkspaceIdentity) {
        throw Object.assign(new Error('delivery_materialization_identity_mismatch'), {
          code: 'delivery_materialization_identity_mismatch',
          errorCode: 'delivery_materialization_identity_mismatch',
          integrationWorkspaceIdentity: integrationWorkspaceIdentity || null,
          deliveryWorkspaceIdentity,
        });
      }
      if (!patchDigest || committedPaths.length === 0) {
        throw Object.assign(new Error('delivery_mutation_input_incomplete'), {
          code: 'delivery_mutation_input_incomplete',
          errorCode: 'delivery_mutation_input_incomplete',
        });
      }
      const observed = store.observeWorkspaceIdentityCAS(runId, {
        expectedMutationRevision,
        expectedWorkspaceIdentity,
        identity: deliveryWorkspaceIdentity,
        provenance: {
          projectId,
          workspaceId,
          sourceIdentity: run?.sourceIdentity,
          baseSourceIdentity: run?.sourceIdentity,
          mutationRevision: Number(expectedMutationRevision) + 1,
          changedPaths: committedPaths,
          workspaceIdentity: deliveryWorkspaceIdentity,
          mutationDigest: patchDigest || deliveryWorkspaceIdentity,
          attemptId: null,
        },
      });
      const updated = store.getRun(runId);
      if (!observed.changed || Number(updated?.mutationRevision) !== Number(expectedMutationRevision) + 1 || updated.currentWorkspaceIdentity !== deliveryWorkspaceIdentity) {
        throw Object.assign(new Error('delivery_mutation_revision_stale'), { code: 'delivery_mutation_revision_stale', errorCode: 'delivery_mutation_revision_stale' });
      }
      const committedAssertion = assertOwnerWorkspaceMutationCAS({
        stateStore: store,
        workspaceRoot: fencingWorkspaceRoot,
        runId,
        workspaceId,
        projectId,
        worktree: currentWorktree,
        fencingToken,
        sessionToken,
        expectedMutationRevision: Number(expectedMutationRevision) + 1,
        expectedWorkspaceIdentity: deliveryWorkspaceIdentity,
        expectedHeadCommitSha,
        expectedProjectId: projectId,
        expectedWorktreeId: worktreeId,
        expectedWorkspaceId: workspaceId,
        phase: 'post-commit',
      });
      return {
        status: 'applied',
        changed: true,
        run: updated,
        mutationRevision: Number(updated.mutationRevision),
        expectedMutationRevision: Number(expectedMutationRevision),
        deliveryWorkspaceIdentity,
        integrationWorkspaceIdentity,
        committedAssertion,
        changedPaths: committedPaths,
        patchDigest,
      };
    },

    releaseOwnerWorkspaceMutationFence(runId, { workspaceId = currentWorktree.workspaceId, fencingToken, sessionToken = holder } = {}) {
      return store.releaseWorkspaceMutationLockV2({ workspaceId, runId, sessionToken, fencingToken });
    },

    async blockDeliveryMaterialization(runId, { reason = 'delivery_materialization_recovery_required', detail = null } = {}) {
      const run = store.getRun(runId);
      if (run?.status === 'active') {
        store.markRunBlocked(runId, reason);
        if (typeof store.recordRunSignals === 'function') {
          store.recordRunSignals(runId, buildStructuredRunSignals({
            runId,
            blocker: { reason, detail, blockerReceipt: `blocker://${runId}/${reason}` },
          }));
        }
        await projectRunState(store.getRun(runId), { runtimeHome });
      }
      return store.getRun(runId);
    },

    // Restart recovery is derived from the existing Run mutation authority,
    // provenance, Step Ledger, and execution attempts. No persisted Delivery
    // intent/status lifecycle is created. A workspace drift or an owner
    // mutation whose worker Steps were not fully settled is ambiguous after a
    // crash, so the safe outcome is a blocked Run.
    async recoverPendingDeliveryMaterialization(runId) {
      const run = store.getRun(runId);
      if (!run) return { status: 'not_found', run: null };
      if (deliveryRecoveryInProgress) return { status: 'in-progress', run };
      if (run.status !== 'active') return { status: 'none', run };

      // Ordinary owner-direct reports also advance the Run mutationRevision,
      // but they do not leave a parallel Delivery provenance record behind.
      // Only a persisted owner-mutation provenance row marks the boundary at
      // which restart reconciliation is meaningful; without it, a normal
      // edit between two reports must remain an ordinary next/report cycle.
      const provenance = typeof store.getMutationProvenance === 'function'
        ? store.getMutationProvenance(runId)
        : null;
      const recoveryReason = 'delivery_materialization_recovery_required';
      const block = async (detail) => {
        const blocked = await this.blockDeliveryMaterialization(runId, { reason: recoveryReason, detail });
        return { status: 'blocked', reason: recoveryReason, detail, run: blocked };
      };

      // A parallel worker receipt is the existing durable marker for the
      // otherwise-unpersisted interval between `git apply` and the owner CAS.
      // Ordinary owner-direct reports have no routed execution attempt, so a
      // changed owner workspace remains an ordinary report cycle. This closes
      // the apply-before-observation crash window without adding a Delivery
      // lifecycle row or marker.
      const activeStatuses = new Set(['started', 'reported', 'verifying', 'passed', 'failed']);
      const terminalStepStates = new Set(['passed', 'superseded', 'cancelled']);
      const steps = store.getRunSteps(runId, { planRevision: run.planRevision });
      const stepById = new Map(steps.map((step) => [step.stepId, step]));
      const workerAttempts = store.getStepAttempts(runId)
        .filter((attempt) => attempt.provenanceKind === 'routed')
        .filter((attempt) => activeStatuses.has(attempt.status))
        .filter((attempt) => {
          const step = stepById.get(attempt.stepId);
          return step && step.executionWorkspaceId === attempt.workspaceId;
        });
      const expectedRevision = provenance
        ? Number(run.mutationRevision) - 1
        : Number(run.mutationRevision);
      const relevantAttempts = workerAttempts
        .filter((attempt) => Number(attempt.mutationRevision) === expectedRevision);

      // No routed worker receipt means there is no parallel Delivery boundary
      // to reconcile. In particular, this keeps ordinary direct edits and
      // future pending Steps from being mistaken for a crashed Delivery.
      // `mutation_provenance` is also updated by ordinary owner-direct step
      // settlement, so its presence alone cannot distinguish the apply-before
      // owner-CAS window from a normal direct report. An owner-direct receipt
      // carries its canonical attempt id; only a provenance row without that
      // id is the explicit prepared-Delivery marker, while a routed worker
      // receipt is the other durable marker for the crash window. This keeps
      // the incomplete-marker guard fail-closed without repeatedly blocking on
      // a stale historical owner mutation during a normal PROVE retry.
      const preparedDeliveryMarker = Boolean(provenance && !provenance.attemptId);
      if (relevantAttempts.length === 0 && !preparedDeliveryMarker) return { status: 'none', run };

      let liveDeliveryWorkspaceIdentity;
      try {
        liveDeliveryWorkspaceIdentity = observeWorkspaceIdentity({ projectRoot: fencingWorkspaceRoot }).identity;
      } catch (error) {
        return block(`Delivery workspace identity could not be observed during recovery: ${error.message}`);
      }

      // If provenance is absent, a live identity change alongside durable
      // routed worker receipts is exactly the crash window after apply and
      // before the owner CAS persisted its provenance. It is ambiguous and
      // must block rather than silently resume.
      if (!provenance) {
        if (liveDeliveryWorkspaceIdentity === run.currentWorkspaceIdentity) return { status: 'none', run };
        return block('Owner workspace changed after parallel worker receipts but before owner mutation provenance was persisted');
      }
      if (!run.currentWorkspaceIdentity || liveDeliveryWorkspaceIdentity !== run.currentWorkspaceIdentity) {
        return block('Delivery workspace identity diverged from the Run authority; mutation reconciliation is required');
      }

      if (provenance && (provenance.workspaceIdentity !== liveDeliveryWorkspaceIdentity
        || Number(provenance.mutationRevision) !== Number(run.mutationRevision))) {
        return block('Persisted owner mutation provenance no longer matches the live Run workspace identity');
      }

      if (expectedRevision < 0 || relevantAttempts.length === 0) return { status: 'none', run };

      const incomplete = relevantAttempts.filter((attempt) => !attempt.attemptId
        || !attempt.workspaceId
        || !attempt.resultWorkspaceIdentity
        || !attempt.resultCommitSha
        || !attempt.patchDigest
        || !Array.isArray(attempt.changedPaths)
        || attempt.changedPaths.length === 0
        || !attempt.workerReport
        || typeof attempt.workerReport !== 'object');
      if (incomplete.length > 0) {
        return block(`Durable worker receipts are incomplete for ${incomplete.map((attempt) => attempt.attemptId || attempt.stepId).join(', ')}`);
      }
      const reconstructedPaths = canonicalChangedPaths(relevantAttempts.flatMap((attempt) => attempt.changedPaths || []));
      if (!provenance || JSON.stringify(reconstructedPaths) !== JSON.stringify(canonicalChangedPaths(provenance.changedPaths))) {
        return block('Durable parallel worker paths do not reconstruct the recorded owner mutation');
      }
      const relevantStepIds = new Set(relevantAttempts.map((attempt) => attempt.stepId));
      const unresolvedSteps = steps.filter((step) => relevantStepIds.has(step.stepId) && !terminalStepStates.has(step.state));
      if (unresolvedSteps.length > 0) {
        return block(`Owner workspace mutation was recorded before these Steps settled: ${unresolvedSteps.map((step) => step.stepId).join(', ')}`);
      }
      return { status: 'none', run };
    },

    // A parallel worker's attempt is intentionally bound to the pre-delivery
    // revision and its own execution workspace. This resolver accepts that
    // fixed receipt only when the owner CAS has already advanced exactly once;
    // it never refreshes the worker capsule to the post-materialization state.
    resolveParallelSettlementStep(runId, report, {
      expectedMutationRevision,
      expectedWorkspaceIdentity,
      workerWorkspaceId,
      workerWorkspaceIdentity,
    } = {}) {
      const run = store.getRun(runId);
      const step = report.stepId ? store.getRunStep(runId, report.stepId) : null;
      const reject = (obligationId, errorSummary, errorCode = null) => ({
        rejection: [{ obligationId, command: 'kernel report', errorSummary, ...(errorCode ? { errorCode } : {}) }],
      });
      if (!run || run.status !== 'active') return reject('run', 'Run is not active', 'delivery_run_inactive');
      if (!step || step.planRevision !== run.planRevision) return reject('step', `Step "${report.stepId || '<missing>'}" is not a live step for this plan`);
      if (['passed', 'superseded', 'cancelled'].includes(step.state)) return reject('step', `Step "${step.stepId}" is already ${step.state} and cannot be settled again`);
      if (Number(run.mutationRevision) !== Number(expectedMutationRevision) + 1 || run.currentWorkspaceIdentity === expectedWorkspaceIdentity) {
        return reject('attempt', 'Owner Delivery mutation is not at the expected post-materialization revision', 'delivery_mutation_revision_stale');
      }
      if (step.executionWorkspaceId !== workerWorkspaceId || report.workspaceId !== workerWorkspaceId) {
        return reject('workspace', 'Parallel report workspace does not match the Step execution workspace', 'delivery_workspace_mismatch');
      }
      const attempt = report.attemptId
        ? store.getActiveStepAttempt(runId, { stepId: step.stepId, attemptId: report.attemptId, capsuleId: report.capsuleId })
        : null;
      if (!attempt) return reject('attempt', `Attempt "${report.attemptId || '<missing>'}" is not an active parallel attempt for step "${step.stepId}"`);
      if (Number(attempt.mutationRevision) !== Number(expectedMutationRevision)) return reject('attempt', 'Worker attempt revision does not match the pre-delivery snapshot', 'attempt_lineage_incomplete');
      if (attempt.workspaceId !== workerWorkspaceId || (workerWorkspaceIdentity && attempt.baseWorkspaceIdentity !== workerWorkspaceIdentity)) {
        return reject('attempt', 'Worker attempt workspace lineage does not match the execution receipt', 'attempt_lineage_incomplete');
      }
      if (attempt.capsuleId && attempt.capsuleId !== report.capsuleId) return reject('capsule', 'Report capsule does not match the active parallel attempt');
      if (attempt.bindingId && attempt.bindingId !== report.bindingId) return reject('binding', 'Report binding does not match the active parallel attempt');
      return { step, attempt, parallel: true };
    },

    assertParallelCapsuleScope(runId, report, step, {
      expectedMutationRevision,
    } = {}) {
      const run = store.getRun(runId);
      const capsule = report.capsuleId ? store.getExecutionCapsule(report.capsuleId, { runId }) : null;
      if (report.capsuleId && !capsule) return [{ obligationId: 'capsule', command: 'kernel report', errorSummary: `Execution capsule "${report.capsuleId}" was not issued for this run` }];
      const capsuleRun = {
        ...run,
        mutationRevision: Number(expectedMutationRevision),
        currentWorkspaceIdentity: step?.baseWorkspaceIdentity || run.currentWorkspaceIdentity,
      };
      if (capsule) {
        const stale = capsuleStaleness({ capsule, run: capsuleRun });
        if (stale.stale) return [{ obligationId: 'capsule', command: 'kernel report', errorSummary: `Execution capsule "${capsule.capsuleId}" no longer describes the worker execution: ${stale.reasons.join(', ')}`, errorCode: 'capsule_lineage_incomplete' }];
      }
      const scope = capsule
        ? { source: 'capsule', label: `work unit ${capsule.capsuleId}`, obligationId: 'capsule', allowedPaths: capsule.workUnit?.allowedPaths || [], forbiddenPaths: capsule.workUnit?.forbiddenPaths || [] }
        : { source: 'step', label: `step ${step.stepId}`, obligationId: 'step', allowedPaths: step.allowedPaths || [], forbiddenPaths: step.forbiddenPaths || [] };
      const violations = findScopeViolations({ changedPaths: report.changedPaths, allowedPaths: scope.allowedPaths, forbiddenPaths: scope.forbiddenPaths });
      return violations.length === 0 ? null : violations.map((violation) => ({
        obligationId: scope.obligationId,
        command: 'kernel report',
        errorSummary: `Changed path "${violation.path}" is ${violation.reason === 'forbidden-path' ? 'inside a forbidden path' : 'outside the allowed paths'} of ${scope.label}`,
      }));
    },

    // K3: the Host asks for admission between the route decision and the actual
    // dispatch, and the answer is persisted whatever it is. A blocked admission
    // is evidence that a turn was refused, not an absence of a turn.
    async admitRoute(runId, { decision, resolution, capabilities = {}, capsule = null, step = null, attemptId = null, policies, economics = {} } = {}) {
      const run = store.getRun(runId);
      if (!run) throw new Error(`Run ${runId} not found`);
      const admission = admitRoute({
        run,
        step: step || this.getCurrentStep(runId),
        attemptId,
        decision,
        resolution,
        capabilities,
        capsule,
        policies,
        economics,
      });
      return store.recordRouteAdmission(runId, admission);
    },

    getRouteAdmission(runId, admissionId) {
      return store.getRouteAdmission(admissionId, { runId });
    },

    listRouteAdmissions(runId, options = {}) {
      return store.listRouteAdmissions(runId, options);
    },

    // The Host reports what it actually ran. This is the only evidence that a
    // routing decision was honoured; without it the turn stays unobserved.
    async recordModelUsage(runId, usageReceipt = {}, { lateObservation = false } = {}) {
      const run = store.getRun(runId);
      if (!run) throw new Error(`Run ${runId} not found`);
      if (run.status === 'completed' && !lateObservation) {
        throw new Error(`Run ${runId} is completed; a late usage receipt requires an explicit late-observation flag`);
      }
      const attempt = usageReceipt.attemptId
        ? store.getStepAttemptByAttemptId(usageReceipt.attemptId, { runId })
        : usageReceipt.capsuleId ? store.getActiveStepAttempt(runId, { capsuleId: usageReceipt.capsuleId }) : null;
      return store.recordModelUsageReceipt(runId, {
        ...usageReceipt,
        runId,
        ...(attempt && !usageReceipt.attemptId ? { attemptId: attempt.attemptId } : {}),
        ...(attempt && !usageReceipt.bindingId ? { bindingId: attempt.bindingId } : {}),
      });
    },

    modelRoutingSummary(runId) {
      return summarizeModelRouting(store.listModelRouteDecisions(runId), store.listModelUsageReceipts(runId));
    },

    listReviewReceipts(runId, options = {}) {
      return store.listReviewReceipts(runId, options);
    },

    // Two-stage review plan (§31): which reviews apply and whether an
    // independent reviewer is required, derived from the run's tier and risk.
    async reviewPlan(runId, { publicContract = false, acceptanceAmbiguity = false, behaviorChanging = false } = {}) {
      const run = store.getRun(runId);
      if (!run) throw new Error(`Run ${runId} not found`);
      const { resolveReviewPlan } = await import('./proof/review-pipeline.mjs');
      return resolveReviewPlan({ riskTier: run.proofTier, publicContract, acceptanceAmbiguity, behaviorChanging });
    },

    // Records a structured review verdict as a judgment obligation. At T3 the
    // verdict must come from a reviewer independent of the implementer.
    //
    // K0: the receipt is written FIRST and the judgment verification references
    // it, so every judgment the completion gate accepts has a lineage it can
    // re-check later. A review the Host never routed is still recorded, but as
    // `unrouted` — visible, and never sufficient for a protected or T3 judgment.
    async recordReview(runId, verdict = {}, {
      implementerId,
      reviewReceiptId = null,
      obligationId = null,
      acceptanceCoverage = [],
      changedPaths = [],
      rationale = null,
    } = {}) {
      let run = store.getRun(runId);
      if (!run) throw new Error(`Run ${runId} not found`);
      run = assertLiveReviewWorkspace(runId, run, 'review-recording').run;
      // Review is an optional evidence producer. Its transport/normalization
      // code is loaded only after a caller has requested a review turn.
      const {
        normalizeReviewVerdict,
        assertIndependentReview,
        assertIndependentReviewSession,
        classifyReviewFindings,
      } = await import('./proof/review-pipeline.mjs');
      const normalized = normalizeReviewVerdict(verdict);
      const implementationSession = store.getImplementationPrincipal(runId);
      const usageReceipt = reviewReceiptId ? store.getModelUsageReceipt(reviewReceiptId, { runId }) : null;
      const reviewDecision = usageReceipt ? store.getModelRouteDecision(usageReceipt.decisionId, { runId }) : null;

      if (run.proofTier === 'T3') {
        assertIndependentReview({ verdict: normalized, implementerId });
        // Once the Host is routing models, the reviewer string is no longer
        // enough: independence is checked against the session that implemented.
        if (implementationSession || reviewReceiptId) {
          assertIndependentReviewSession({ reviewReceipt: usageReceipt, reviewDecision, implementationSession });
        }
      }

      const targetObligation = obligationId || `review-${normalized.stage}`;
      // Keep the final filesystem observation adjacent to receipt creation.
      // The earlier check protects the route/capsule validation below; this
      // second check prevents that validation work from becoming a stale
      // review subject before the Kernel writes its receipt.
      run = assertLiveReviewWorkspace(runId, run, 'review-receipt').run;
      const reviewReceipt = store.recordReviewReceipt(runId, {
        runId,
        obligationId: targetObligation,
        reviewStage: normalized.stage,
        verdict: normalized.verdict,
        findingClass: findingClassOf(normalized.findings),
        planRevision: Number(run.planRevision || run.contractRevision || 1),
        reviewer: usageReceipt
          ? {
            actorSessionId: usageReceipt.actorSessionId,
            usageReceiptId: usageReceipt.receiptId,
            routeDecisionId: usageReceipt.decisionId,
            modelClass: reviewDecision?.modelClass || 'unrouted',
            resolvedModel: usageReceipt.resolvedModel,
            enforcementStatus: usageReceipt.enforcementStatus,
          }
          : {
            actorSessionId: hashSessionId(normalized.reviewerId || `unrouted-reviewer:${runId}:${normalized.stage}`),
            usageReceiptId: null,
            routeDecisionId: null,
            modelClass: 'unrouted',
            resolvedModel: null,
            enforcementStatus: 'unrouted',
          },
        implementer: {
          actorSessionId: implementationSession?.actorSessionId || null,
          usageReceiptId: implementationSession?.receiptId || null,
        },
        stepId: usageReceipt?.stepId
          || implementationSession?.stepId
          || store.getLatestImplementationAttempt?.(runId)?.stepId
          || null,
        reviewerBindingId: usageReceipt?.bindingId || null,
        implementerAttemptId: implementationSession?.attemptId
          || store.getLatestImplementationAttempt?.(runId)?.attemptId
          || null,
        subject: {
          workspaceIdentity: run.currentWorkspaceIdentity,
          mutationRevision: run.mutationRevision,
          changedPathsDigest: digestOfPaths(changedPaths),
          evidenceDigest: digestOfEvidence(store.getVerifications(runId), { excludeObligationId: targetObligation }),
        },
        acceptanceCoverage,
        findings: normalized.findings,
        rationale: rationale || `${normalized.stage} review verdict: ${normalized.verdict}`,
      });

      const updated = await this.recordProof(runId, {
        obligationId: targetObligation,
        status: normalized.verdict === 'pass' ? 'passed' : 'failed',
        evidenceRef: reviewEvidenceRef(runId, reviewReceipt.receiptId),
        command: 'structured-review',
        exitCode: normalized.verdict === 'pass' ? 0 : 1,
        evidenceDigest: reviewReceipt.digest,
        evidenceClass: 'judgment',
        acceptanceCoverage: reviewReceipt.acceptanceCoverage,
      });
      // The follow-up class is decided here, so an architecture defect cannot
      // be quietly handed back to the implementer as a local patch (§9.3).
      return { review: normalized, reviewReceipt, run: updated, followUp: classifyReviewFindings(normalized.findings) };
    },

    async approveObligation({
      runId,
      obligationId = 'security-review',
      approver = 'operator',
      reason = 'User approval granted',
      approvalRef = null,
      allJudgments = false,
      autoFinalize = true,
    } = {}) {
      let run = store.getRun(runId);
      if (!run) throw new Error(`Run ${runId} not found`);
      run = assertLiveReviewWorkspace(runId, run, 'operator-approval').run;

      // Operator approval is a human judgment override, never executable proof.
      // Require an opaque Host/operator reference and bind only its digest to the
      // exact run + obligation so raw approval text does not enter durable state.
      const normalizedApprovalRef = String(approvalRef || '').trim();
      if (!normalizedApprovalRef) {
        const err = new Error('OPERATOR_APPROVAL_REF_REQUIRED: operator approval requires a Host-issued approval reference');
        err.code = 'OPERATOR_APPROVAL_REF_REQUIRED';
        throw err;
      }
      if (normalizedApprovalRef.length > 512) {
        const err = new Error('OPERATOR_APPROVAL_REF_INVALID: approval reference is too long');
        err.code = 'OPERATOR_APPROVAL_REF_INVALID';
        throw err;
      }

      const obligations = store.getRunObligations(runId);
      const completionBefore = evaluateRunCompletion(runId, { obligations });
      const outstandingIds = new Set(completionBefore.unsatisfiedObligations.map((entry) => String(entry.obligationId)));
      const latestAttempt = store.getLatestImplementationAttempt?.(runId);
      const changedPaths = (latestAttempt?.changedPaths && latestAttempt.changedPaths.length > 0)
        ? latestAttempt.changedPaths
        : (Array.isArray(run.taskContract?.allowedPaths) && run.taskContract.allowedPaths.length > 0
          ? run.taskContract.allowedPaths
          : (run.taskContract?.scope || []));
      const targetObligations = [];

      if (allJudgments || obligationId === 'all-judgments' || obligationId === 'all') {
        for (const obligation of obligations) {
          if (obligation.evidenceClass === 'judgment' && outstandingIds.has(String(obligation.obligationId))) {
            targetObligations.push(obligation);
          }
        }
      } else {
        const found = obligations.find((item) => item.obligationId === obligationId);
        if (!found) {
          const err = new Error(`OPERATOR_APPROVAL_OBLIGATION_NOT_DECLARED: Obligation "${obligationId}" is not declared for run ${runId}`);
          err.code = 'OPERATOR_APPROVAL_OBLIGATION_NOT_DECLARED';
          throw err;
        }
        if (found.evidenceClass !== 'judgment') {
          const err = new Error(`HARD_EVIDENCE_NOT_OPERATOR_APPROVABLE: Obligation "${found.obligationId}" requires executable hard evidence`);
          err.code = 'HARD_EVIDENCE_NOT_OPERATOR_APPROVABLE';
          throw err;
        }
        if (!outstandingIds.has(String(found.obligationId))) {
          const err = new Error(`OPERATOR_APPROVAL_OBLIGATION_NOT_OUTSTANDING: Obligation "${found.obligationId}" is already satisfied`);
          err.code = 'OPERATOR_APPROVAL_OBLIGATION_NOT_OUTSTANDING';
          throw err;
        }
        targetObligations.push(found);
      }

      if (targetObligations.length === 0) {
        // `--all-judgments` is intentionally idempotent for commit/retry flows:
        // never mint a second approval receipt, but allow a run that is already
        // otherwise ready to complete its finalization.
        const allRequested = allJudgments || obligationId === 'all-judgments' || obligationId === 'all';
        if (allRequested) {
          let finalized = null;
          if (autoFinalize && completionBefore.readyExceptClose && run.state === 'PROVE') {
            finalized = await this.finalizeRun(runId, {
              changedPaths,
              changedFileCount: changedPaths.length,
            });
          }
          return {
            status: 'no_op',
            success: true,
            runId,
            decisionBasis: 'operator_approval',
            approvedObligations: [],
            finalizationStatus: store.getRun(runId)?.finalizationStatus || null,
            completion: completionBefore,
            finalized,
            run: store.getRun(runId),
          };
        }
        const err = new Error('NO_OUTSTANDING_JUDGMENT_OBLIGATIONS: no declared judgment obligation currently requires operator approval');
        err.code = 'NO_OUTSTANDING_JUDGMENT_OBLIGATIONS';
        throw err;
      }

      if (run.state !== 'PROVE') {
        if (run.state === 'FRAME') {
          await this.transition(runId, 'EXECUTE');
        }
        await this.transition(runId, 'PROVE');
        run = store.getRun(runId);
      }

      const results = [];

      for (const target of targetObligations) {
        const targetCoverage = Array.isArray(target.acceptanceIds) ? target.acceptanceIds : [];
        const approvalRefDigest = `sha256:${createHash('sha256')
          .update(`${normalizedApprovalRef}|${runId}|${target.obligationId}`)
          .digest('hex')}`;
        const reviewReceipt = store.recordReviewReceipt(runId, {
          runId,
          obligationId: target.obligationId,
          reviewStage: 'engineering',
          verdict: 'pass',
          findingClass: 'none',
          planRevision: Number(run.planRevision || run.contractRevision || 1),
          reviewer: {
            actorSessionId: hashSessionId(`operator:${approver}:${runId}`),
            usageReceiptId: null,
            routeDecisionId: null,
            modelClass: 'operator',
            resolvedModel: `operator:${approver}`,
            enforcementStatus: 'operator_approved',
            approvalRefDigest,
          },
          implementer: {
            actorSessionId: null,
            usageReceiptId: null,
          },
          stepId: latestAttempt?.stepId || null,
          reviewerBindingId: null,
          implementerAttemptId: latestAttempt?.attemptId || null,
          subject: {
            workspaceIdentity: run.currentWorkspaceIdentity,
            mutationRevision: run.mutationRevision,
            changedPathsDigest: digestOfPaths(changedPaths),
            evidenceDigest: digestOfEvidence(store.getVerifications(runId), { excludeObligationId: target.obligationId }),
          },
          acceptanceCoverage: targetCoverage,
          findings: [],
          rationale: reason || `Operator approval granted by ${approver}`,
        });

        await this.recordProof(runId, {
          obligationId: target.obligationId,
          status: 'passed',
          evidenceRef: reviewEvidenceRef(runId, reviewReceipt.receiptId),
          command: 'operator-approval',
          exitCode: 0,
          evidenceDigest: reviewReceipt.digest,
          evidenceClass: 'judgment',
          acceptanceCoverage: targetCoverage,
        });
        results.push({
          obligationId: target.obligationId,
          status: 'passed',
          decisionBasis: 'operator_approval',
          reviewReceiptId: reviewReceipt.receiptId,
          receipt: reviewReceipt,
        });
      }

      const completionPreview = evaluateRunCompletion(runId);
      let finalized = null;
      if (autoFinalize && completionPreview.readyExceptClose && run.state === 'PROVE') {
        finalized = await this.finalizeRun(runId, {
          changedPaths,
          changedFileCount: changedPaths.length,
        });
      }

      return {
        status: 'approved',
        success: true,
        runId,
        decisionBasis: 'operator_approval',
        approvedObligations: results,
        finalizationStatus: store.getRun(runId)?.finalizationStatus || null,
        completion: completionPreview,
        finalized,
        run: store.getRun(runId),
      };
    },

    async ingestReviewerOutcome({
      runId,
      stepId = null,
      capsuleId,
      routeDecisionId,
      usageReceiptId,
      reviewerSessionId,
      outcome,
    } = {}) {
      let run = store.getRun(runId);
      if (!run) throw new Error(`incomplete_review_chain: run ${runId} not found`);
      if (!outcome || !['pass', 'fail', 'blocked'].includes(outcome.verdict)
        || !Array.isArray(outcome.findings) || !Array.isArray(outcome.evidenceRefs)
        || !Number.isInteger(outcome.reviewedMutationRevision)) {
        throw new Error('incomplete_review_chain: invalid reviewer outcome schema');
      }
      // A reviewer outcome is accepted only for the workspace that is live at
      // ingestion time. The helper advances the authoritative observation when
      // drift is found, then fails closed without minting a ReviewReceipt.
      run = assertLiveReviewWorkspace(runId, run, 'review-outcome-ingestion').run;
      const capsule = store.getExecutionCapsule(capsuleId, { runId });
      const usage = store.getModelUsageReceipt(usageReceiptId, { runId });
      const decision = store.getModelRouteDecision(routeDecisionId, { runId });
      const admission = usage?.admissionId ? store.getRouteAdmission(usage.admissionId, { runId }) : null;
      const implementationSession = store.getImplementationPrincipal(runId);
      const reviewerSessionHash = hashSessionId(reviewerSessionId);
      const chainComplete = capsule?.role === 'reviewer'
        && (!stepId || capsule.stepId === stepId)
        && capsule.provenance.routeDecisionId === routeDecisionId
        && capsule.subject.mutationRevision === run.mutationRevision
        && capsule.subject.workspaceIdentity === run.currentWorkspaceIdentity
        && outcome.reviewedMutationRevision === run.mutationRevision
        && decision?.role === 'reviewer'
        && decision.permissions === 'read_only'
        && usage?.decisionId === routeDecisionId
        && usage.capsuleId === capsuleId
        && usage.actorSessionId === reviewerSessionHash
        && usage.enforcementStatus === 'enforced'
        && admissionAllowsDispatch(admission)
        && admission.capsuleId === capsuleId
        && admission.decisionId === routeDecisionId
        && implementationSession?.actorSessionId
        && implementationSession.actorSessionId !== usage.actorSessionId;
      if (!chainComplete) throw new Error('incomplete_review_chain: route, capsule, usage, session, read-only, or mutation lineage is missing');
      if (outcome.verdict === 'blocked') {
        return { status: 'blocked', blockedReason: 'incomplete_review_chain', findings: outcome.findings };
      }
      const obligationId = capsule.reviewScope?.obligationId || decision.obligationId || 'security-review';
      const acceptanceCoverage = (capsule.acceptance || [])
        .filter((item) => (item.obligationIds || []).includes(obligationId))
        .map((item) => item.id);
      return this.recordReview(runId, {
        stage: capsule.reviewScope?.stage || 'engineering',
        verdict: outcome.verdict,
        reviewerId: reviewerSessionHash,
        findings: outcome.findings,
      }, {
        implementerId: implementationSession.actorSessionId,
        reviewReceiptId: usageReceiptId,
        obligationId,
        acceptanceCoverage,
        changedPaths: capsule.subject.changedPaths,
        rationale: `Host-ingested reviewer outcome (${outcome.evidenceRefs.length} evidence refs)`,
      });
    },

    // Within-run route/tier promotion only (§13.5). Demotion throws.
    async escalateRoute(runId, { proofTier, evidenceTier, addObligations = [] } = {}) {
      const updated = store.escalateRun(runId, { proofTier, evidenceTier, addObligations });
      await projectRunState(updated, { runtimeHome });
      return updated;
    },

    // Hard evidence path: the Kernel runtime resolves a trusted manifest
    // command, executes it itself, and binds the result to the workspace
    // identity observed immediately before execution.
    async executeProof(runId, { obligationId = 'default', commandRef, timeoutMs, acceptanceCoverage = [], flakyRerun = false, discovered = null, networkPolicy = 'inherited', evidenceIdentity: requestedEvidenceIdentity = null, freshnessInputs = null, allowEvidenceReuse = true, sharedExecution = null, [proofExecutionCacheRequest]: proofExecutionCacheContext = null } = {}) {
      const run = store.getRun(runId);
      if (!run) throw new Error(`Run ${runId} not found`);
      recordEfficiency(runId, { timestamps: { focusedVerificationStartedAt: new Date().toISOString() } });
      const finishVerificationTelemetry = (execution = null) => recordEfficiency(runId, {
        timestamps: { focusedVerificationFinishedAt: new Date().toISOString() },
        increments: execution?.timedOut === true ? { verificationTimeoutCount: 1 } : {},
      });

      // Direct Host callers use this method without reportUnderLease's
      // preflight. Reject an unbound command before observing/executing it so
      // the direct API cannot create side effects and only fail at persistence.
      const declaredObligation = store.getRunObligation(runId, obligationId);
      if (declaredObligation && declaredObligation.sourceType !== 'ad-hoc') {
        assertCommandBinding(declaredObligation, discovered ? null : commandRef);
      }

      const observation = observeWorkspaceIdentity({ projectRoot });
      store.observeWorkspaceIdentity(runId, observation.identity);

      const scopeAuthority = authoritativeVerificationScope(declaredObligation);
      const scopedObservation = scopeAuthority
        ? observeScopedWorkspaceIdentity({ projectRoot, scopes: scopeAuthority.scope })
        : null;
      const scopedProof = scopedObservation?.status === 'observed';
      const declaredFreshnessInputs = Array.isArray(scopeAuthority?.freshnessInputs) && scopeAuthority.freshnessInputs.length > 0
        ? scopeAuthority.freshnessInputs
        : null;
      const requestedFreshnessInputs = Array.isArray(freshnessInputs) && freshnessInputs.length > 0
        ? freshnessInputs
        : declaredFreshnessInputs;
      const scopedFreshnessInputs = scopedProof
        ? [...new Set([
          ...(requestedFreshnessInputs || EVIDENCE_IDENTITY_FIELDS.filter((field) => field !== 'sourceInputDigest')),
          VERIFICATION_SCOPE_FIELD,
        ].filter((field) => field !== 'sourceInputDigest'))]
        : (requestedFreshnessInputs || undefined);
      // Caller-provided identity values cannot replace an authoritative scope
      // digest. If scoped observation is unavailable, the global workspace
      // identity is the fail-safe freshness boundary.
      const evidenceIdentity = !scopeAuthority && requestedEvidenceIdentity
        ? requestedEvidenceIdentity
        : buildEvidenceIdentity({
          commandRef,
          sourceInputDigest: observation.identity,
          networkPolicy,
          freshnessInputs: scopedFreshnessInputs,
          verificationScopeDigest: scopedProof ? scopedObservation.identity : null,
        });

      // A shared execution is an in-memory same-report optimization, not a
      // caller-supplied proof. Revalidate its complete freshness boundary and
      // command identity before recording another Kernel-runtime receipt.
      if (sharedExecution) {
        const currentRun = store.getRun(runId);
        const sharedStatus = sharedExecution.recordedStatus || sharedExecution.status;
        const sharedExitCode = Number.isInteger(sharedExecution.recordedExitCode)
          ? sharedExecution.recordedExitCode
          : (Number.isInteger(sharedExecution.exitCode) ? sharedExecution.exitCode : 1);
        const sharedIdentityDigest = sharedExecution.evidenceIdentity?.digest || null;
        const sharedCommandRef = discovered ? null : commandRef;
        const sharedExactReuse = sharedExecution.actualCommandExecution === false
          && sharedExecution.reused === true
          && sharedExecution.reuseReceipt?.priorRunId
          && Number.isInteger(Number(sharedExecution.reuseOfVerificationId || sharedExecution.reuseReceipt?.priorVerificationId));
        const cacheContextMatches = proofExecutionCacheContext
          && proofExecutionCacheContexts.get(sharedExecution) === proofExecutionCacheContext
          && proofExecutionCacheContext.runId === runId
          && proofExecutionCacheContext.sourceIdentity === currentRun?.sourceIdentity
          && proofExecutionCacheContext.contractRevision === currentRun?.contractRevision
          && proofExecutionCacheContext.mutationRevision === currentRun?.mutationRevision;
        const reusable = cacheContextMatches
          && (sharedExecution.actualCommandExecution === true || sharedExactReuse)
          && sharedExecution.workspaceMutatedByProof !== true
          && sharedExecution.mutationRevision === currentRun?.mutationRevision
          && sharedExecution.workspaceIdentity === observation.identity
          && sharedExecution.commandRef === sharedCommandRef
          && sharedExecution.networkPolicy === networkPolicy
          && sharedIdentityDigest
          && sharedIdentityDigest === evidenceIdentity.digest
          && ['passed', 'failed'].includes(sharedStatus);
        if (!reusable) {
          throw Object.assign(new Error('Shared proof execution is no longer safe to reuse at the current workspace identity'), {
            code: 'PROOF_EXECUTION_REUSE_UNSAFE',
          });
        }
        const sharedReuseReceipt = sharedExactReuse
          ? buildEvidenceReuseReceipt({
            runId,
            obligationId,
            priorRunId: sharedExecution.reuseReceipt.priorRunId,
            priorVerificationId: Number(sharedExecution.reuseOfVerificationId || sharedExecution.reuseReceipt.priorVerificationId),
            mutationRevision: currentRun.mutationRevision,
            identity: evidenceIdentity,
            evidenceDigest: sharedExecution.outputDigest,
          })
          : null;
        const updated = store.recordVerification(runId, {
          obligationId,
          status: sharedStatus,
          evidenceRef: sharedReuseReceipt
            ? `evidence://reuse/${sharedReuseReceipt.receiptId}`
            : sharedExecution.evidenceRef,
          commandRef: sharedCommandRef,
          command: [sharedExecution.command, ...(sharedExecution.args || [])].filter(Boolean).join(' ') || commandRef,
          exitCode: sharedExitCode,
          evidenceDigest: sharedExecution.outputDigest,
          acceptanceCoverage,
          verifiedSourceIdentity: observation.identity,
          executor: 'kernel-runtime',
          networkIsolation: sharedExecution.networkIsolation,
          evidenceIdentity,
          reuseOfVerificationId: sharedExactReuse
            ? Number(sharedExecution.reuseOfVerificationId || sharedExecution.reuseReceipt.priorVerificationId)
            : null,
          reuseReceipt: sharedReuseReceipt,
        });
        persistReleaseEvidenceIfNeeded(runId, updated);
        await projectRunState(updated, { runtimeHome });
        const verification = store.getVerifications(runId).find((entry) => entry.obligationId === obligationId);
        finishVerificationTelemetry(sharedExecution);
        return {
          run: updated,
          execution: {
            ...sharedExecution,
            status: sharedExecution.status || sharedStatus,
            recordedStatus: sharedStatus,
            reused: true,
            shared: true,
            actualCommandExecution: false,
            evidenceIdentity,
            ...(sharedReuseReceipt ? {
              reuseOfVerificationId: Number(sharedExecution.reuseOfVerificationId || sharedExecution.reuseReceipt.priorVerificationId),
              reuseReceipt: sharedReuseReceipt,
              evidenceRef: `evidence://reuse/${sharedReuseReceipt.receiptId}`,
            } : {}),
            verifiedSourceIdentity: observation.identity,
            workspaceIdentity: observation.identity,
            mutationRevision: updated.mutationRevision,
            verificationId: verification?.id,
            recordedExitCode: sharedExitCode,
          },
        };
      }

      const reusable = allowEvidenceReuse
        && !flakyRerun
        && !discovered
        && typeof store.findExactReusableVerification === 'function'
        ? store.findExactReusableVerification({
          projectId: run.projectId,
          obligationId,
          evidenceIdentity,
          contractRevision: run.contractRevision,
        })
        : null;
      if (reusable) {
        const reuseReceipt = buildEvidenceReuseReceipt({
          runId,
          obligationId,
          priorRunId: reusable.runId,
          priorVerificationId: reusable.id,
          mutationRevision: run.mutationRevision,
          identity: evidenceIdentity,
          evidenceDigest: reusable.evidenceDigest,
        });
        const updated = store.recordVerification(runId, {
          obligationId,
          status: 'passed',
          evidenceRef: `evidence://reuse/${reuseReceipt.receiptId}`,
          commandRef,
          command: reusable.command || commandRef,
          exitCode: 0,
          evidenceDigest: reusable.evidenceDigest,
          acceptanceCoverage,
          verifiedSourceIdentity: observation.identity,
          executor: 'kernel-runtime',
          networkIsolation: networkPolicy,
          evidenceIdentity,
          reuseOfVerificationId: reusable.id,
          reuseReceipt,
        });
        persistReleaseEvidenceIfNeeded(runId, updated);
        await projectRunState(updated, { runtimeHome });
        const cacheExecution = {
          status: 'passed',
          recordedStatus: 'passed',
          reused: true,
          reuseReceipt,
          outputDigest: reusable.evidenceDigest,
          evidenceIdentity,
          evidenceRef: `evidence://reuse/${reuseReceipt.receiptId}`,
          command: reusable.command || commandRef,
          commandRef,
          args: [],
          exitCode: 0,
          flaky: false,
          workspaceMutatedByProof: false,
          actualCommandExecution: false,
          networkPolicy,
          workspaceIdentity: observation.identity,
          verifiedSourceIdentity: observation.identity,
          mutationRevision: updated.mutationRevision,
          recordedExitCode: 0,
          reuseOfVerificationId: reusable.id,
        };
        rememberProofExecutionCacheEntry(cacheExecution, proofExecutionCacheContext);
        finishVerificationTelemetry(cacheExecution);
        return {
          run: updated,
          execution: cacheExecution,
        };
      }

      const evidenceDir = run.projectId
        ? resolveRunArtifactPaths({ runtimeHome, projectId: run.projectId, runId }).evidence
        : path.join(runtimeHome, 'evidence', runId);
      // Discovered commands require an explicit approval; trusted commands are
      // manifest scripts. Flaky reruns re-execute once at the same identity.
      const runner = discovered
        ? () => executeApprovedProof({ projectRoot, command: discovered.command, args: discovered.args || [], approval: discovered.approval, label: obligationId, timeoutMs, evidenceDir, networkPolicy })
        : () => executeTrustedProof({ projectRoot, commandRef, timeoutMs, evidenceDir, networkPolicy });
      const execution = flakyRerun ? executeWithFlakyRerun(runner) : runner();
      finishVerificationTelemetry(execution);

      // Re-observe the workspace AFTER execution. If the verification command
      // itself mutated tracked source (e.g. a formatter or codegen step), the
      // evidence was produced against a state that no longer exists — bind it
      // to the post-execution identity so the completion gate treats it as
      // stale rather than accepting evidence for a vanished workspace (F2).
      const postObservation = observeWorkspaceIdentity({ projectRoot });
      const workspaceMutatedByProof = postObservation.identity !== observation.identity;
      if (workspaceMutatedByProof) {
        store.observeWorkspaceIdentity(runId, postObservation.identity);
        const mutationAt = new Date().toISOString();
        recordEfficiency(runId, { timestamps: { firstMutationAt: mutationAt, lastMutationAt: mutationAt } });
      }

      // A flaky result (divergent pass/fail across identical runs) is blocking
      // by default (§17); it may only pass through an explicit waiver, which
      // marks the run degraded. A proof that mutated its own workspace cannot
      // stand as valid evidence for that workspace either.
      const blockedForFlaky = execution.flaky === true;
      const recordedStatus = (blockedForFlaky || workspaceMutatedByProof) ? 'failed' : execution.status;

      const updated = store.recordVerification(runId, {
        obligationId,
        status: recordedStatus,
        evidenceRef: execution.evidenceRef,
        commandRef: discovered ? null : commandRef,
        command: [execution.command, ...execution.args].join(' '),
        exitCode: recordedStatus === 'failed' && execution.exitCode === 0 ? 1 : execution.exitCode,
        evidenceDigest: execution.outputDigest,
        acceptanceCoverage,
        verifiedSourceIdentity: workspaceMutatedByProof ? postObservation.identity : observation.identity,
        executor: 'kernel-runtime',
        networkIsolation: execution.networkIsolation,
        evidenceIdentity,
      });
      persistReleaseEvidenceIfNeeded(runId, updated);

      await projectRunState(updated, { runtimeHome });
      const verification = store.getVerifications(runId).find((entry) => entry.obligationId === obligationId);
      const recordedExitCode = recordedStatus === 'failed' && execution.exitCode === 0 ? 1 : execution.exitCode;
      const cacheExecution = {
        ...execution,
        recordedStatus,
        flaky: blockedForFlaky,
        workspaceMutatedByProof,
        actualCommandExecution: true,
        commandRef: discovered ? null : commandRef,
        evidenceIdentity,
        verifiedSourceIdentity: workspaceMutatedByProof ? postObservation.identity : observation.identity,
        workspaceIdentity: workspaceMutatedByProof ? postObservation.identity : observation.identity,
        mutationRevision: updated.mutationRevision,
        verificationId: verification?.id,
        recordedExitCode,
      };
      rememberProofExecutionCacheEntry(cacheExecution, proofExecutionCacheContext);
      return {
        run: updated,
        execution: cacheExecution,
      };
    },

    // Builds (and records a receipt for) the knowledge context of the run's
    // CURRENT stage, so an EXECUTE turn is not handed FRAME knowledge (P1-2).
    async refreshStageKnowledge(runId, { stage, strict = false } = {}) {
      const run = store.getRun(runId);
      if (!run) return null;
      const effectiveStage = stage || run.state;
      const existing = store.getKnowledgeContextReceipt(runId, effectiveStage);
      const projectId = run.projectId;
      if (!projectId) return existing?.receiptJson || null;
      const knowledgeRevision = String(store.getProjectKnowledgeRevision(projectId));
      const contractRevision = Number(run.contractRevision || 1);
      const objectiveDigest = sha256Hex(run.objective || '');
      const changedPaths = run.taskContract?.changedPaths || [];
      const changedPathsDigest = sha256Hex(JSON.stringify([...changedPaths].sort()));

      const receiptMeta = existing?.receiptJson?.selectionMeta;
      const isMatch = existing
        && String(existing.knowledgeRevision) === knowledgeRevision
        && (receiptMeta?.contractRevision === undefined || receiptMeta.contractRevision === contractRevision)
        && (receiptMeta?.objectiveDigest === undefined || receiptMeta.objectiveDigest === objectiveDigest)
        && (receiptMeta?.changedPathsDigest === undefined || receiptMeta.changedPathsDigest === changedPathsDigest);

      if (isMatch) return existing.receiptJson;

      try {
        const context = await buildProjectKnowledgeContext({
          projectId,
          stage: effectiveStage,
          runId,
          objective: run.objective,
          changedPaths,
          projectRoot,
          stateStore: store,
          env: { MOON_RELAY_KERNEL_HOME: runtimeHome },
        });
        context.selectionMeta = {
          stage: effectiveStage,
          knowledgeRevision,
          contractRevision,
          objectiveDigest,
          changedPathsDigest,
        };
        store.recordKnowledgeContextReceipt(runId, {
          stage: effectiveStage,
          knowledgeRevision: context.knowledgeRevision,
          digest: context.digest,
          receiptJson: context,
        });
        return context;
      } catch (error) {
        if (strict) throw error;
        return existing?.receiptJson || null;
      }
    },

    // Model-visible command 1 of 2: what to do now.
    async next(runId, { stepId = null } = {}) {
      try {
        preflight(runId, 'next');
      } catch (error) {
        return bindingErrorPayload(error, { projectRoot, provider: hostProvider });
      }
      let run = store.getRun(runId);
      if (!run) return { schemaVersion: 1, runId, status: 'not_found' };
      const projectCommands = discoverProjectCommands({ projectRoot });
      try {
        preflightTaskContract({
          contract: run.taskContract || {},
          projectRoot,
          commands: projectCommands,
          obligations: store.getRunObligations(runId),
        });
      } catch (error) {
        return buildContractPreflightRejection({
          runId,
          error,
          contract: run.taskContract || {},
          commands: projectCommands,
          obligations: store.getRunObligations(runId),
        });
      }
      const deliveryRecovery = await this.recoverPendingDeliveryMaterialization(runId);
      if (deliveryRecovery.status === 'blocked') {
        return buildBlockedResponse({
          runId,
          reason: deliveryRecovery.reason,
          detail: deliveryRecovery.detail,
        });
      }
      let stageContext = store.getKnowledgeContextReceipt(runId, run.state)?.receiptJson;
      if (!stageContext) {
        stageContext = await this.refreshStageKnowledge(runId, { stage: run.state });
      }
      if (!stageContext) {
        stageContext = store.getKnowledgeContextReceipt(runId, 'FRAME')?.receiptJson || null;
      }

      const obligations = refreshProofPolicyBindings(runId);
      const isProve = String(run.state || '').toUpperCase() === 'PROVE';

      if (run.status === 'blocked' && run.blockedReason === 'unsupported-verification') {
        try {
          assertVerificationSupport(obligations, { completionPredicate: run.taskContract?.completionPredicate }, { projectMode: run.projectMode });
          store.resumeBlockedRun(runId);
          run = store.getRun(runId);
        } catch {
          // Still blocked
        }
      } else if (isProve) {
        try {
          assertVerificationSupport(obligations, { completionPredicate: run.taskContract?.completionPredicate }, { projectMode: run.projectMode });
        } catch (error) {
          store.markRunBlocked(runId, 'unsupported-verification');
          await projectRunState(store.getRun(runId), { runtimeHome });
          run = store.getRun(runId);
        }
      }

      await syncRunLocator(run);

      const capabilityDecision = resolveKernelCapabilities({
        ...(run.taskContract?.flags || {}),
        taskClass: run.taskContract?.taskClass || 'feature',
        riskTier: run.proofTier,
        stage: run.state,
        route: run.route?.stages || [],
        filesChanged: run.taskContract?.filesChanged || 0,
      });

      const completion = evaluateRunCompletion(runId, { obligations });
      const payload = buildNextForRun(run, {
        verifications: store.getVerifications(runId),
        requiredObligations: run.requiredObligations,
        obligations,
        contract: run.taskContract ? contractBriefing(run.taskContract) : null,
        completion,
        knowledgePromptBlock: stageContext?.promptBlock || null,
        context: stageContext,
        capabilities: capabilityDecision.selected.map((entry) => ({ id: entry.id, guidance: entry.guidance })),
      });

      if (payload.action?.type === 'implement' && run.projectMode !== 'greenfield' && run.taskContract?.flags?.baselineRequired === true && run.baselineStatus === 'pending') {
        const commandRefs = [...new Set(obligations
          .filter((obligation) => obligation.evidenceClass === 'hard')
          .flatMap((obligation) => obligation.allowedCommandRefs))].slice(0, 3);
        if (commandRefs.length > 0 && run.runStartWorkspaceIdentity === run.currentWorkspaceIdentity) {
          payload.action = {
            type: 'baseline-required',
            guidance: 'The Kernel host must capture the bound baseline commands before implementation.',
            commandRefs,
          };
          payload.nextAction = 'baseline-required';
        }
      }
      if (payload.action?.type === 'implement' && run.implementationContext) {
        payload.action.projectContext = {
          ...run.implementationContext,
          baseline: run.baselineStatus === 'captured'
            ? { status: 'captured', failures: run.baselineFailures }
            : run.implementationContext.baseline,
        };
      }
      // K2: the model is handed ONE work unit, never the whole plan. A synthetic
      // step carries the run itself, so a simple task looks exactly as before.
      const requestedStep = stepId
        ? this.ensureRunStepsMigrated(runId).find((entry) => entry.stepId === stepId && entry.planRevision === run.planRevision)
        : null;
      const step = requestedStep || this.getCurrentStep(runId);
      // Owner-direct turns use the same fail-closed scope boundary as routed
      // workers. Refuse an unbounded implementation before the owner is
      // invited to mutate the workspace.
      if (step && ['implement', 'fix'].includes(payload.action?.type)) {
        try {
          assertImplementationWorkUnitScope({ step, contract: run.taskContract, actionType: payload.action.type });
        } catch (error) {
          const failure = workUnitScopeFailure(error);
          payload.status = 'scope-rejected';
          payload.errorCode = failure.errorCode;
          payload.failureCode = failure.failureCode;
          payload.errorSummary = failure.errorSummary;
          payload.nextAction = failure.nextAction;
          payload.action = {
            ...payload.action,
            workUnitScope: {
              valid: false,
              reason: failure.scopeReason,
              errorCode: failure.errorCode,
              allowedPaths: failure.allowedPaths,
              ...(failure.workspaceWide.length > 0 ? { workspaceWide: failure.workspaceWide } : {}),
            },
            guidance: [failure.errorSummary, payload.action.guidance || ''].filter(Boolean).join(' ').trim(),
          };
          return payload;
        }
      }
      if (step && ['implement', 'fix', 'review', 'report'].includes(payload.action?.type)) {
        payload.action.step = {
          stepId: step.stepId,
          objective: step.objective,
          acceptanceIds: step.acceptanceIds,
          allowedPaths: step.allowedPaths,
          forbiddenPaths: step.forbiddenPaths,
        };
      }
      payload.completion = computeCompletionView({
        run,
        step,
        verifications: store.getVerifications(runId),
        obligations,
        reviews: store.listReviewReceipts(runId),
        completionDecision: store.getCompletionDecision(runId),
      });
      payload.trustAuthority = buildTrustAuthorityForRun(run, {
        completion,
        obligations,
        verifications: store.getVerifications(runId),
        step,
      });
      payload.knowledgeAuthority = buildKnowledgeAuthorityForRun(run, {
        context: stageContext,
        stage: run.state,
      });
      payload.resume = resumeViewForRun(run, {
        completion,
        obligations,
        verifications: store.getVerifications(runId),
        step,
        context: stageContext,
      });
      return payload;
    },

    // Greenfield/Brownfield guidance is attached to the one action that can
    // use it, instead of living in an API the host loop never calls (P1-3).
    // The mode itself stays an internal policy signal and is never named in
    // the model-visible payload; only its consequences are.
    async buildImplementationContext(runId, run) {
      if (run.projectMode === 'greenfield') {
        const { planWalkingSkeleton } = await import('./task/greenfield-bootstrap.mjs');
        return {
          walkingSkeleton: planWalkingSkeleton({
            projectType: run.taskContract?.flags?.projectType || 'library',
            objective: run.objective,
            taskContract: run.taskContract || {},
          }),
        };
      }
      const scan = scanRepositoryEvidence({ projectRoot });
      const baseline = await this.captureBaselineIfPossible(runId, run);
      return {
        entrypoints: scan.entrypoints,
        manifests: scan.manifests,
        knownCommands: [...scan.testCommands, ...scan.buildCommands].map((entry) => entry.commandRef),
        baseline,
      };
    },

    // A baseline is only meaningful before the workspace changes. When the run
    // is still at its start identity we capture it automatically; afterwards we
    // say so honestly instead of pretending failures are pre-existing.
    async captureBaselineIfPossible(runId, run) {
      if ((run.baselineFailures || []).length > 0) return { status: 'captured', failures: run.baselineFailures };
      if (String(env.MOON_RELAY_KERNEL_BASELINE || 'auto') === 'off') return { status: 'disabled' };
      if (run.projectMode === 'greenfield') return { status: 'not-applicable' };
      if (!run.runStartWorkspaceIdentity || run.currentWorkspaceIdentity !== run.runStartWorkspaceIdentity) {
        return { status: 'unavailable-workspace-already-changed' };
      }
      const commandRefs = [...new Set(store.getRunObligations(runId)
        .filter((obligation) => obligation.evidenceClass === 'hard')
        .flatMap((obligation) => obligation.allowedCommandRefs))].slice(0, 3);
      if (commandRefs.length === 0) return { status: 'no-bound-commands' };
      const baseline = await this.captureBaseline(runId, { commandRefs, timeoutMs: 120000 });
      return { status: 'captured', commandRefs, failures: baseline.baselineFailures };
    },

    // Brownfield repository scan (§16.2): objective-relevant evidence only.
    scanEvidence() {
      return scanRepositoryEvidence({ projectRoot });
    },

    // Greenfield walking-skeleton plan (§15.4): only meaningful for greenfield
    // runs; returns the minimal runnable slice and the project-type evidence.
    async greenfieldPlan(runId, { projectType = 'library', taskContract = {} } = {}) {
      const run = store.getRun(runId);
      if (!run) throw new Error(`Run ${runId} not found`);
      const { planWalkingSkeleton } = await import('./task/greenfield-bootstrap.mjs');
      return {
        projectMode: run.projectMode,
        applicable: run.projectMode === 'greenfield',
        plan: planWalkingSkeleton({ projectType, objective: run.objective, taskContract }),
      };
    },

    // Capture a pre-change baseline (§16.3): run the requested trusted commands
    // and persist which already fail, so later failures can be classified.
    async captureBaseline(runId, { commandRefs = [], timeoutMs } = {}) {
      const run = store.getRun(runId);
      if (!run) throw new Error(`Run ${runId} not found`);
      const baseline = captureBaselineProof({
        projectRoot,
        commandRefs,
        timeoutMs,
        evidenceDir: run.projectId
          ? path.join(resolveRunArtifactPaths({ runtimeHome, projectId: run.projectId, runId }).evidence, 'baseline')
          : path.join(runtimeHome, 'evidence', runId, 'baseline'),
      });
      store.observeWorkspaceIdentity(runId, baseline.workspaceIdentity);
      store.setBaselineFailures(runId, baseline.baselineFailures);
      store.setBaselineStatus(runId, 'captured');
      return baseline;
    },

    // Deterministic resume: reconstructs the next action from persisted SQLite
    // state alone (never chat history), and detects a live lease held by a
    // different runner so concurrent processes do not stomp the same run.
    async resume(runId) {
      try {
        preflight(runId, 'resume');
      } catch (error) {
        return bindingErrorPayload(error, { projectRoot, provider: hostProvider });
      }
      const run = store.getRun(runId);
      if (!run) return { schemaVersion: 1, runId, status: 'not_found' };
      const leaseResult = store.acquireLease(runId, { holder, ttlMs: SESSION_LEASE_TTL_MS });
      if (!leaseResult.acquired) {
        return { schemaVersion: 1, runId, status: 'lease-conflict', lease: leaseResult.lease, next: await this.next(runId) };
      }
      const attempts = store.getAttempts(runId);
      const verifications = store.getVerifications(runId);
      const lastValidEvidence = verifications.filter((verification) => verification.status === 'passed').at(-1) || null;
      return {
        schemaVersion: 1,
        runId,
        status: run.status === 'completed' ? 'completed' : run.status === 'blocked' ? 'blocked' : 'resumed',
        state: run.state,
        mutationRevision: run.mutationRevision,
        attemptCount: attempts.length,
        blockedReason: run.blockedReason || null,
        lastValidEvidence: lastValidEvidence ? { obligationId: lastValidEvidence.obligationId, evidenceDigest: lastValidEvidence.evidenceDigest, executor: lastValidEvidence.executor } : null,
        next: await this.next(runId),
      };
    },

    // Internal Host settlement for a parallel worker. The delivery mutation is
    // already committed before this method is entered; the worker receipt is
    // checked against its pre-delivery attempt lineage and is never replayed
    // through a refreshed capsule.
    async settleParallelResult(runId, payload = {}, { deliveryMutation = null, result = null } = {}) {
      try {
        preflight(runId, 'report');
      } catch (error) {
        return bindingErrorPayload(error, { projectRoot, provider: hostProvider });
      }
      const snapshot = deliveryMutation?.snapshot || deliveryMutation || null;
      const deliveryWorkspaceIdentity = deliveryMutation?.deliveryWorkspaceIdentity || snapshot?.deliveryWorkspaceIdentity || null;
      if (!snapshot || !Number.isInteger(Number(snapshot.expectedMutationRevision))
        || !snapshot.expectedWorkspaceIdentity || !deliveryWorkspaceIdentity) {
        return {
          schemaVersion: 1,
          runId,
          status: 'evidence-rejected',
          failures: [{ obligationId: 'delivery-materialization', command: 'parallel-settlement', errorSummary: 'Parallel settlement requires a committed owner workspace mutation' }],
        };
      }
      const currentRun = store.getRun(runId);
      const persistedProvenance = typeof store.getMutationProvenance === 'function'
        ? store.getMutationProvenance(runId)
        : null;
      let liveDeliveryWorkspaceIdentity = null;
      try {
        liveDeliveryWorkspaceIdentity = observeWorkspaceIdentity({ projectRoot: fencingWorkspaceRoot }).identity;
      } catch (error) {
        return {
          schemaVersion: 1,
          runId,
          status: 'evidence-rejected',
          failures: [{
            obligationId: 'delivery-materialization',
            command: 'parallel-settlement',
            errorSummary: `Delivery workspace identity could not be re-observed: ${error.message}`,
            errorCode: 'delivery_workspace_identity_stale',
          }],
        };
      }
      if (liveDeliveryWorkspaceIdentity !== deliveryWorkspaceIdentity) {
        return {
          schemaVersion: 1,
          runId,
          status: 'evidence-rejected',
          failures: [{
            obligationId: 'delivery-materialization',
            command: 'parallel-settlement',
            errorSummary: 'Delivery workspace changed after materialization and before worker settlement',
            errorCode: 'delivery_workspace_identity_stale',
          }],
        };
      }
      const expectedDeliveryRevision = Number(snapshot.expectedMutationRevision) + 1;
      const deliveryPaths = canonicalChangedPaths(deliveryMutation?.changedPaths);
      const persistedPaths = canonicalChangedPaths(persistedProvenance?.changedPaths);
      const committedOwnerMutationMatchesRun = deliveryMutation?.changed === true
        && Array.isArray(deliveryMutation?.changedPaths)
        && deliveryPaths.length > 0
        && Boolean(deliveryMutation?.patchDigest)
        && deliveryMutation?.integrationWorkspaceIdentity === deliveryWorkspaceIdentity
        && Number(deliveryMutation?.mutationRevision) === expectedDeliveryRevision
        && currentRun?.status === 'active'
        && currentRun.projectId === (snapshot.expectedProjectId || currentRun.projectId)
        && currentRun.worktreeId === (snapshot.expectedWorktreeId || currentRun.worktreeId)
        && currentRun.workspaceId === (snapshot.expectedWorkspaceId || currentRun.workspaceId)
        && Number(currentRun.mutationRevision) === expectedDeliveryRevision
        && currentRun.currentWorkspaceIdentity === deliveryWorkspaceIdentity
        && persistedProvenance?.mutationRevision === expectedDeliveryRevision
        && persistedProvenance?.projectId === currentRun.projectId
        && persistedProvenance?.workspaceId === currentRun.workspaceId
        && persistedProvenance.workspaceIdentity === deliveryWorkspaceIdentity
        && JSON.stringify(deliveryPaths) === JSON.stringify(persistedPaths)
        && persistedProvenance.mutationDigest === deliveryMutation.patchDigest;
      if (!committedOwnerMutationMatchesRun) {
        return {
          schemaVersion: 1,
          runId,
          status: 'evidence-rejected',
          failures: [{
            obligationId: 'delivery-materialization',
            command: 'parallel-settlement',
            errorSummary: 'The supplied owner mutation does not match the persisted Run mutation provenance',
            errorCode: 'delivery_owner_mutation_stale',
          }],
        };
      }
      const workerPaths = canonicalChangedPaths(payload.changedPaths);
      const committedPaths = canonicalChangedPaths(result?.changedPaths);
      if (!result || !Array.isArray(payload.changedPaths) || !Array.isArray(result.changedPaths)
        || JSON.stringify(workerPaths) !== JSON.stringify(committedPaths)) {
        return {
          schemaVersion: 1,
          runId,
          status: 'evidence-rejected',
          failures: [{
            obligationId: 'delivery-materialization',
            command: 'parallel-settlement',
            errorSummary: 'Worker changed paths do not match the committed integrated result',
            errorCode: 'delivery_worker_paths_mismatch',
          }],
        };
      }
      const omittedWorkerPaths = workerPaths.filter((workerPath) => !deliveryPaths.includes(workerPath));
      if (omittedWorkerPaths.length > 0) {
        return {
          schemaVersion: 1,
          runId,
          status: 'evidence-rejected',
          failures: [{
            obligationId: 'delivery-materialization',
            command: 'parallel-settlement',
            errorSummary: `Canonical worker receipt paths are omitted from the persisted Delivery mutation: ${omittedWorkerPaths.join(', ')}`,
            errorCode: 'delivery_worker_paths_omitted',
          }],
        };
      }

      const parallelResolution = this.resolveParallelSettlementStep(runId, payload, {
        expectedMutationRevision: Number(snapshot.expectedMutationRevision),
        expectedWorkspaceIdentity: snapshot.expectedWorkspaceIdentity,
        workerWorkspaceId: result?.executionWorkspaceId || payload.workspaceId || null,
        workerWorkspaceIdentity: result?.workerWorkspaceIdentity || null,
      });
      if (parallelResolution.rejection) {
        return {
          schemaVersion: 1,
          runId,
          status: 'evidence-rejected',
          failures: parallelResolution.rejection,
        };
      }

      const canonicalAttempt = parallelResolution.attempt;
      const requiredReceiptFields = [
        ['attemptId', result?.attemptId],
        ['executionWorkspaceId', result?.executionWorkspaceId],
        ['workerWorkspaceIdentity', result?.workerWorkspaceIdentity],
        ['resultWorkspaceIdentity', result?.resultWorkspaceIdentity],
        ['resultCommitSha', result?.resultCommitSha],
        ['patchDigest', result?.patchDigest],
        ['changedPaths', result?.changedPaths],
        ['workerReport', result?.workerReport],
      ];
      const missingReceiptFields = requiredReceiptFields
        .filter(([field, value]) => value === null || value === undefined || value === ''
          || (field === 'changedPaths' && (!Array.isArray(value) || value.length === 0))
          || (field === 'workerReport' && (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length === 0)))
        .map(([field]) => field);
      if (missingReceiptFields.length > 0) {
        return {
          schemaVersion: 1,
          runId,
          status: 'evidence-rejected',
          failures: [{
            obligationId: 'delivery-materialization',
            command: 'parallel-settlement',
            errorSummary: `Canonical worker execution receipt is incomplete: ${missingReceiptFields.join(', ')}`,
            errorCode: 'delivery_worker_receipt_incomplete',
          }],
        };
      }
      const receiptMismatches = [];
      const compareReceiptField = (field, incoming, canonical, options = {}) => {
        if (!receiptValuesEqual(incoming, canonical, options)) receiptMismatches.push(field);
      };
      if (result.attemptId !== canonicalAttempt.attemptId || payload.attemptId !== canonicalAttempt.attemptId) receiptMismatches.push('attemptId');
      if (result.executionWorkspaceId !== canonicalAttempt.workspaceId) receiptMismatches.push('executionWorkspaceId');
      compareReceiptField('workerWorkspaceIdentity', result.workerWorkspaceIdentity, canonicalAttempt.baseWorkspaceIdentity);
      compareReceiptField('resultWorkspaceIdentity', result.resultWorkspaceIdentity, canonicalAttempt.resultWorkspaceIdentity);
      compareReceiptField('resultCommitSha', result.resultCommitSha, canonicalAttempt.resultCommitSha);
      compareReceiptField('patchDigest', result.patchDigest, canonicalAttempt.patchDigest);
      compareReceiptField('changedPaths', result.changedPaths, canonicalAttempt.changedPaths, { paths: true });
      compareReceiptField('workerReport', result.workerReport, canonicalAttempt.workerReport);
      if (receiptMismatches.length > 0) {
        return {
          schemaVersion: 1,
          runId,
          status: 'evidence-rejected',
          failures: [{
            obligationId: 'delivery-materialization',
            command: 'parallel-settlement',
            errorSummary: `Worker execution receipt differs from its canonical attempt: ${[...new Set(receiptMismatches)].join(', ')}`,
            errorCode: 'delivery_worker_receipt_mismatch',
          }],
        };
      }
      const leaseResult = store.acquireLease(runId, { holder, ttlMs: REPORT_LEASE_TTL_MS });
      if (!leaseResult.acquired) {
        return { schemaVersion: 1, runId, status: 'lease-conflict', lease: leaseResult.lease, next: await this.next(runId) };
      }
      const fencingToken = leaseResult.lease.fencingToken;
      try {
        const reportResult = await this.reportUnderLease(runId, payload, {
          fencingToken,
          parallelSettlement: {
            expectedMutationRevision: Number(snapshot.expectedMutationRevision),
            expectedWorkspaceIdentity: snapshot.expectedWorkspaceIdentity,
            deliveryWorkspaceIdentity,
            workerWorkspaceId: result?.executionWorkspaceId || payload.workspaceId || null,
            workerWorkspaceIdentity: result?.workerWorkspaceIdentity || result?.resultWorkspaceIdentity || null,
            result,
          },
        });
        recordReportOutcome(runId, reportResult);
        return publicReportResult(reportResult);
      } finally {
        store.releaseLease(runId, { holder, fencingToken });
      }
    },

    // Model-visible command 2 of 2: submit work. The Kernel re-observes the
    // workspace, executes requested trusted verifications itself, records
    // evidence, advances state, and finalizes when everything required passed.
    async report(runId, payload = {}) {
      try {
        preflight(runId, payload?.blocker ? 'blocker' : 'report');
      } catch (error) {
        return bindingErrorPayload(error, { projectRoot, provider: hostProvider });
      }
      const run = store.getRun(runId);
      let workspaceObservation = null;
      try { workspaceObservation = observeWorkspaceIdentity({ projectRoot }); } catch {}
      const reportKey = reportIdempotencyKey({
        runId,
        payload,
        workspaceIdentity: workspaceObservation?.identity || null,
      });
      const durableReplay = typeof store.findStepAttemptByReportDigest === 'function'
        ? store.findStepAttemptByReportDigest(runId, reportKey)
        : null;
      if (durableReplay?.reportResult) {
        settleDurableReportReplay(durableReplay);
        return { ...durableReplay.reportResult, idempotentReplay: true };
      }
      if (reportIdempotencyCache.has(reportKey)) {
        const cached = reportIdempotencyCache.get(reportKey);
        return {
          ...cached,
          next: await this.next(runId),
        };
      }
      // A completed run is only *done* when finalization also completed
      // (P0-7); a partial finalization stays retryable instead of reporting a
      // success the Kernel did not actually achieve.
      if (run.status === 'completed' && run.finalizationStatus === 'completed') {
        return { schemaVersion: 1, runId, status: 'completed', workUnitStatus: 'complete', goalStatus: 'complete', next: await this.next(runId) };
      }

      // Enforce the run lease before mutating any state (F4). If another runner
      // holds a live lease, refuse the report so concurrent processes cannot
      // interleave attempts, transitions, and finalization on the same run.
      const leaseResult = store.acquireLease(runId, { holder, ttlMs: REPORT_LEASE_TTL_MS });
      if (!leaseResult.acquired) {
        return { schemaVersion: 1, runId, status: 'lease-conflict', lease: leaseResult.lease, next: await this.next(runId) };
      }
      const fencingToken = leaseResult.lease.fencingToken;
      try {
        const result = await this.reportUnderLease(runId, payload, { fencingToken });
        recordReportOutcome(runId, result);
        return publicReportResult(result);
      } finally {
        // The lease is released when the command finishes so the next CLI
        // process — a different PID, same session — is never locked out (P0-6).
        store.releaseLease(runId, { holder, fencingToken });
      }
    },

    async reportUnderLease(runId, payload, { fencingToken, parallelSettlement = null }) {
      const run = store.getRun(runId);
      let currentObservation = null;
      try { currentObservation = observeWorkspaceIdentity({ projectRoot }); } catch {}
      const reportKey = reportIdempotencyKey({
        runId,
        payload,
        workspaceIdentity: currentObservation?.identity || null,
      });
      const durableReplay = typeof store.findStepAttemptByReportDigest === 'function'
        ? store.findStepAttemptByReportDigest(runId, reportKey)
        : null;
      if (durableReplay?.reportResult) {
        settleDurableReportReplay(durableReplay);
        return { ...durableReplay.reportResult, idempotentReplay: true };
      }
      if (reportIdempotencyCache.has(reportKey)) {
        const cached = reportIdempotencyCache.get(reportKey);
        return {
          ...cached,
          idempotentReplay: true,
          next: await this.next(runId),
        };
      }
      recordEfficiency(runId, { increments: { reportCount: 1 } });
      const evidenceRejected = (failures) => {
        const currentRun = store.getRun(runId);
        return {
          schemaVersion: 1,
          runId,
          status: 'evidence-rejected',
          executed: [],
          failures,
          finalization: null,
          next: buildNextForRun(currentRun, {
            verifications: store.getVerifications(runId),
            requiredObligations: currentRun.requiredObligations,
            contract: currentRun.taskContract ? contractBriefing(currentRun.taskContract) : null,
            failures,
          }),
        };
      };
      const workspaceScopeRejected = ({
        actualChangedPaths = null,
        reportedChangedPaths = [],
        failure,
        observation = null,
      }) => {
        const currentRun = store.getRun(runId);
        return {
          schemaVersion: 1,
          runId,
          status: 'scope-rejected',
          actualChangedPaths,
          reportedChangedPaths,
          workspaceObservation: observation
            ? { method: observation.method || null, status: observation.status || 'observed', reason: observation.reason || null }
            : { method: null, status: 'unavailable', reason: 'workspace-observation-unavailable' },
          executed: [],
          failures: [failure],
          finalization: null,
          next: buildNextForRun(currentRun, {
            verifications: store.getVerifications(runId),
            requiredObligations: currentRun.requiredObligations,
            contract: currentRun.taskContract ? contractBriefing(currentRun.taskContract) : null,
            failures: [failure],
          }),
        };
      };
      // A run that already reached accepted completion but whose finalization
      // is partial re-enters finalization instead of restarting the loop.
      if (run.status === 'completed' && run.finalizationStatus !== 'completed') {
        const retried = await this.finalizeRun(runId, {
          gitCloseoutRequest: payload?.gitCloseoutRequest || null,
          changedPaths: Array.isArray(payload?.changedPaths) ? payload.changedPaths : [],
          knowledgeObservations: Array.isArray(payload?.knowledgeObservations) ? payload.knowledgeObservations : [],
        });
        const finalRun = store.getRun(runId);
        return {
          schemaVersion: 1,
          runId,
          status: retried.finalizationStatus === 'completed' ? 'completed' : 'finalization-incomplete',
          executed: [],
          failures: [],
          finalization: retried,
          next: await this.next(runId),
        };
      }

      let report = normalizeReport(payload);
      // An omitted changedPaths field carries no caller claim. The Kernel may
      // fill it from the live authoritative observation for follow-up reports
      // (for example, a review/evidence-only report while the same working
      // tree remains dirty). An explicitly supplied [] is still a claim that
      // there are no changed paths and must match the authority exactly.
      const changedPathsClaimed = Boolean(payload && typeof payload === 'object'
        && Object.prototype.hasOwnProperty.call(payload, 'changedPaths'));
      const reportedChangedPaths = changedPathsClaimed ? canonicalChangedPaths(report.changedPaths) : [];
      let liveWorkspaceObservation = null;
      let actualChangedPaths = null;
      let workspaceMismatchFailure = null;

      // `changedPaths` in a model report is a claim. For a direct owner report,
      // the live Git observation and the Run's baseline are the authority. A
      // mismatch is rejected before knowledge compilation, capsule settlement,
      // or proof execution so an omitted or stale path cannot be hidden by a
      // passing verification.
      if (parallelSettlement) {
        actualChangedPaths = canonicalChangedPaths(
          parallelSettlement.result?.changedPaths || report.changedPaths,
        );
        report = { ...report, changedPaths: actualChangedPaths };
      } else {
        try {
          liveWorkspaceObservation = observeWorkspaceIdentity({ projectRoot });
        } catch {
          return workspaceScopeRejected({
            reportedChangedPaths,
            failure: {
              obligationId: 'workspace-scope',
              command: 'kernel report',
              errorSummary: 'Kernel could not observe the workspace before accepting the report',
              errorCode: 'workspace_observation_unavailable',
            },
          });
        }
        const changeSet = deriveRunChangedPaths({
          observation: liveWorkspaceObservation,
          baselineChangedPaths: run.reportBaselineChangedPaths || run.baselineChangedPaths,
          baselineEntries: run.reportBaselineWorkspaceEntries || run.baselineWorkspaceEntries,
          baselineStatus: run.workspaceBaselineStatus,
        });
        if (changeSet.status !== 'observed' && liveWorkspaceObservation.method === 'git') {
          return workspaceScopeRejected({
            reportedChangedPaths,
            observation: liveWorkspaceObservation,
            failure: {
              obligationId: 'workspace-scope',
              command: 'kernel report',
              errorSummary: `Kernel cannot establish an authoritative Git change set: ${changeSet.reason || 'observation unavailable'}`,
              errorCode: 'workspace_observation_unavailable',
            },
          });
        }
        // A non-Git project has no Git change-set authority. Preserve the
        // existing stat-walk compatibility path while making the limitation
        // visible in the response; Git projects remain fail-closed above.
        actualChangedPaths = changeSet.status === 'observed'
          ? canonicalChangedPaths(changeSet.actualChangedPaths)
          : reportedChangedPaths;
        if (changedPathsClaimed && liveWorkspaceObservation.method === 'git'
          && !receiptValuesEqual(actualChangedPaths, reportedChangedPaths, { paths: true })) {
          const missingFromReport = actualChangedPaths.filter((entry) => !reportedChangedPaths.includes(entry));
          const staleInReport = reportedChangedPaths.filter((entry) => !actualChangedPaths.includes(entry));
          workspaceMismatchFailure = {
            obligationId: 'workspace-scope',
            command: 'kernel report',
            errorSummary: `Report changed paths do not match the authoritative workspace delta${missingFromReport.length > 0 ? `; unreported: ${missingFromReport.join(', ')}` : ''}${staleInReport.length > 0 ? `; stale: ${staleInReport.join(', ')}` : ''}`,
            errorCode: missingFromReport.length > 0 ? 'unreported_workspace_change' : 'stale_or_invalid_change_report',
            actualChangedPaths,
            reportedChangedPaths,
          };
        }
        report = { ...report, changedPaths: actualChangedPaths };
      }

      if (actualChangedPaths.length > 0) {
        const mutationAt = new Date().toISOString();
        recordEfficiency(runId, {
          timestamps: { firstMutationAt: mutationAt, lastMutationAt: mutationAt },
        });
      }

      // Project-owned required_verification records are compiled when the
      // actual changed scope becomes known. This keeps a report's binding
      // exact without requiring the project to predict paths in the initial
      // compact contract.
      if (report.changedPaths.length > 0 && typeof store.listKnowledgeRecords === 'function') {
        const currentContractRun = store.getRun(runId);
        const scopedObligations = compileRunObligations({
          projectRoot,
          requiredChecks: [],
          contract: currentContractRun.taskContract,
          contractRevision: currentContractRun.contractRevision,
          commands: discoverProjectCommands({ projectRoot }),
          knowledgeRecords: store.listKnowledgeRecords({ projectId: currentContractRun.projectId, statuses: ['committed'] }),
          changedPaths: report.changedPaths,
        }).filter((obligation) => obligation.sourceType === 'knowledge');
        if (scopedObligations.length > 0) {
          store.declareRunObligations(runId, scopedObligations);
          store.escalateRun(runId, { addObligations: scopedObligations.map((obligation) => obligation.obligationId) });
        }
      }

      // K1: a report answers a capsule. A report that names a capsule the
      // Kernel never issued, or one built against a workspace the run has
      // already moved past, is refused before any evidence is executed — and a
      // change outside the capsule's work unit is a scope violation, not a
      // stylistic problem.
      // K2: which unit of work this report answers, resolved from the ledger
      // rather than from whatever the model remembered.
      const stepResolution = parallelSettlement
        ? this.resolveParallelSettlementStep(runId, report, parallelSettlement)
        : this.resolveReportStep(runId, report);
      const activeStep = stepResolution.step || null;

      // Keep the actual Git set authoritative, but preserve the more useful
      // existing diagnostics when a stale claim also points at an invalid
      // step, capsule, or scope. Neither check accepts the caller's paths for
      // completion: the claimed set is consulted only to explain a stale or
      // out-of-scope claim, while the actual set is used for all downstream
      // acceptance decisions.
      if (workspaceMismatchFailure) {
        const claimedScopeRejection = this.assertCapsuleScope(
          runId,
          { ...report, changedPaths: reportedChangedPaths },
          activeStep,
        );
        const actualScopeRejection = this.assertCapsuleScope(
          runId,
          { ...report, changedPaths: actualChangedPaths },
          activeStep,
        );
        const failures = stepResolution.rejection || actualScopeRejection || claimedScopeRejection;
        if (failures) {
          const currentRun = store.getRun(runId);
          return {
            schemaVersion: 1,
            runId,
            status: stepResolution.rejection ? 'step-rejected' : 'scope-rejected',
            executed: [],
            failures,
            finalization: null,
            next: buildNextForRun(currentRun, {
              verifications: store.getVerifications(runId),
              requiredObligations: currentRun.requiredObligations,
              contract: currentRun.taskContract ? contractBriefing(currentRun.taskContract) : null,
              failures,
            }),
          };
        }
        return workspaceScopeRejected({
          actualChangedPaths,
          reportedChangedPaths,
          observation: liveWorkspaceObservation,
          failure: workspaceMismatchFailure,
        });
      }

      // A stale named capsule remains a capsule/scope failure even when the
      // active attempt carrying it also has stale mutation lineage. Preserve
      // that public rejection class while still refusing the report before
      // any proof can run.
      const lineageRejection = stepResolution.rejection;
      const hasAttemptLineageRejection = lineageRejection
        && lineageRejection.some((failure) => failure.errorCode === 'attempt_lineage_incomplete');
      const scopeStep = activeStep
        || (report.stepId ? store.getRunStep(runId, report.stepId) : this.getCurrentStep(runId));
      const capsuleScopeRejection = parallelSettlement
        ? this.assertParallelCapsuleScope(runId, report, scopeStep, parallelSettlement)
        : hasAttemptLineageRejection
          ? this.assertCapsuleScope(runId, report, scopeStep)
          : null;
      const staleCapsuleRejection = !parallelSettlement && hasAttemptLineageRejection
        && (report.capsuleId || capsuleScopeRejection)
        ? capsuleScopeRejection || [{
          obligationId: 'capsule',
          command: 'kernel report',
          errorSummary: `Execution capsule "${report.capsuleId}" no longer describes this run: ${lineageRejection.map((failure) => failure.errorSummary).join(', ')}`,
          errorCode: 'capsule_lineage_incomplete',
        }]
        : null;
      const capsuleRejection = parallelSettlement
        ? (lineageRejection || capsuleScopeRejection)
        : (staleCapsuleRejection || lineageRejection || this.assertCapsuleScope(runId, report, activeStep));
      if (capsuleRejection) {
        const currentRun = store.getRun(runId);
        return {
          schemaVersion: 1,
          runId,
          status: staleCapsuleRejection ? 'scope-rejected' : stepResolution.rejection ? 'step-rejected' : 'scope-rejected',
          executed: [],
          failures: capsuleRejection,
          finalization: null,
          next: buildNextForRun(currentRun, {
            verifications: store.getVerifications(runId),
            requiredObligations: currentRun.requiredObligations,
            contract: currentRun.taskContract ? contractBriefing(currentRun.taskContract) : null,
            failures: capsuleRejection,
          }),
        };
      }

      // A blocker is still a model claim about the current work unit. Accept
      // it only after the same workspace-diff, step-lineage, and capsule-scope
      // checks as a normal report; otherwise a blocker could hide an
      // unreported or forbidden actual change before fail-closed validation.
      if (report.blocker) {
        if (typeof store.recordRunSignals === 'function') {
          store.recordRunSignals(runId, buildStructuredRunSignals({
            runId,
            blocker: { ...report.blocker, blockerReceipt: `blocker://${runId}/${report.blocker.reason}` },
            changedPaths: report.changedPaths,
          }));
        }
        store.markRunBlocked(runId, report.blocker.reason, report.blocker.blockingClass || null);
        await syncRunLocator(store.getRun(runId));
        await projectRunState(store.getRun(runId), { runtimeHome });
        return buildBlockedResponse({ runId, reason: report.blocker.reason, detail: report.blocker.detail || null });
      }
      if (run.status === 'blocked') store.resumeBlockedRun(runId);

      // A refined contract (new constraints, or an optional evidence-plan
      // refinement produced in FRAME) is persisted before any execution
      // (P0-5). Plain and structured acceptance criteria both bind to the
      // compiled proof policy when no explicit plan is supplied.
      const currentRunForEvidence = store.getRun(runId);
      try {
        if (report.evidencePlans.length > 0) {
          assertEvidencePlanSubmission(currentRunForEvidence.taskContract || {}, report.evidencePlans);
          const revised = applyEvidencePlans(currentRunForEvidence.taskContract, report.evidencePlans);
          if (revised) await this.reviseContract(runId, revised);
        }
      } catch (error) {
        return evidenceRejected([{
          obligationId: 'evidence-plan',
          command: 'evidence-plan',
          errorSummary: error.message,
          errorCode: error.code || 'MISSING_EVIDENCE_PLAN',
          ...(error.detail ? { detail: error.detail } : {}),
        }]);
      }

      // Each report is a durable attempt; the number is derived from persisted
      // rows so retry counting survives restarts.
      // Compatibility projection only. Completion, retry, and lineage below
      // use the step attempt returned by the canonical work-attempt authority.
      const compatibilityAttempt = store.recordAttempt(runId, { attemptNumber: store.nextAttemptNumber(runId), state: run.state, status: 'started' });

      const boundAttempt = stepResolution.attempt || null;
      const boundWorkspaceId = report.workspaceId || boundAttempt?.workspaceId || null;
      const boundWorkspace = boundWorkspaceId && store.getProjectWorkspace
        ? store.getProjectWorkspace(boundWorkspaceId)
        : null;
      const observation = !parallelSettlement && liveWorkspaceObservation
        ? liveWorkspaceObservation
        : observeWorkspaceIdentity({
          projectRoot: boundWorkspace?.canonicalRoot || projectRoot,
        });
      // A routed Step workspace has its own identity and mutation lock. Its
      // observation is an execution receipt, not a mutation of the owner
      // workspace; only the owner workspace advances the Run revision.
      const workerWorkspace = Boolean(
        report.workspaceId
        && report.workspaceId !== run.workspaceId
        && stepResolution.step?.executionWorkspaceId === report.workspaceId,
      );
      const observed = workerWorkspace
        ? { changed: false, run: store.getRun(runId) }
        : store.observeWorkspaceIdentity(runId, observation.identity);

      // The step moves to `running` and opens its own attempt row, so retries
      // and failures are counted per unit of work rather than per run. The
      // canonical row is opened only after the pre-execution evidence binding
      // checks below; a rejected command must not leave a live attempt that a
      // legacy retry cannot identify.
      let stepAttempt = null;

      const failures = [];
      const executed = [];
      if (activeStep) {
        const boundCapsule = report.capsuleId ? store.getExecutionCapsule(report.capsuleId, { runId }) : null;
        stepAttempt = boundAttempt || store.getActiveStepAttempt(runId, {
          stepId: activeStep.stepId,
          attemptId: report.attemptId,
          capsuleId: report.capsuleId,
        });
        if (!stepAttempt) {
          stepAttempt = this.beginAttempt(runId, {
            stepId: activeStep.stepId,
            bindingId: store.getRunOwnerBinding?.(runId)?.bindingId || null,
            capsuleId: report.capsuleId,
            capsuleDigest: boundCapsule?.provenance?.capsuleDigest || null,
            routeDecisionId: boundCapsule?.provenance?.routeDecisionId || null,
            provenanceKind: boundCapsule?.provenance?.routeDecisionId ? 'routed' : 'owner-session',
            planRevision: activeStep.planRevision,
            mutationRevision: run.mutationRevision,
            workspaceIdentityStart: observation.identity,
            summary: report.summary || null,
            reportDigest: reportKey,
            changedPaths: report.changedPaths,
            workspaceId: report.workspaceId || null,
            baseWorkspaceIdentity: stepResolution.step?.baseWorkspaceIdentity || null,
          });
        }
        if (stepAttempt && typeof store.bindStepAttemptReportDigest === 'function') {
          // Report digest binding belongs to the canonical Step Attempt API.
          // The numeric `id` is only the legacy attempts-row compatibility
          // projection and must never identify durable report state.
          stepAttempt = store.bindStepAttemptReportDigest(stepAttempt.attemptId, reportKey) || stepAttempt;
        }
        // Workspace observation is what advances mutationRevision for a direct
        // report. Bind the active attempt to that observed result before proof
        // and before a later process resumes it; a manually stale attempt with
        // no new workspace observation is still rejected by resolveReportStep.
        if (stepAttempt && observed.changed && !workerWorkspace) {
          stepAttempt = typeof store.updateOwnerAttemptMutationRevision === 'function'
            ? store.updateOwnerAttemptMutationRevision(stepAttempt.attemptId, {
              expectedMutationRevision: run.mutationRevision,
              mutationRevision: observed.run.mutationRevision,
            })
            : this.attachAttemptLineage(stepAttempt.attemptId, {
              mutationRevision: observed.run.mutationRevision,
            });
        }
      }

      // A report hint is still an explicit claim about an obligation. Reject
      // an unbound command before the Kernel can fall back to an automatic
      // proof for the same obligation; otherwise a forged hint could be
      // silently replaced by a passing command and hide the caller's invalid
      // evidence claim. This check intentionally follows the workspace
      // observation above: a rejected proof must not execute, but the
      // mutation it reports must still advance the authoritative workspace
      // lineage so a capsule issued for the old revision cannot be reused.
      const bindingFailures = [];
      const declaredProjectCommandRefs = new Set(discoverProjectCommands({ projectRoot })
        .map((command) => String(command?.commandRef || ''))
        .filter(Boolean));
      const declaredObligations = store.getRunObligations(runId);
      for (const request of report.verifications) {
        // A commandRef-only report is a legacy shorthand for the default hard
        // obligation. If the command is not declared by the project, fail
        // closed before the outstanding-proof planner can substitute a
        // different passing command.
        if (!request.obligationId && !declaredProjectCommandRefs.has(String(request.commandRef))) {
          const detail = `Verification command "${request.commandRef}" is not declared by the project command catalog`;
          store.markRunBlocked(runId, 'unsafe-command');
          await projectRunState(store.getRun(runId), { runtimeHome });
          return buildBlockedResponse({ runId, reason: 'unsafe-command', detail });
        }
        const obligationId = reportHintObligationId(request, declaredObligations);
        const declared = store.getRunObligation(runId, obligationId);
        if (!declared || declared.sourceType === 'ad-hoc') continue;
        try {
          assertCommandBinding(declared, request.commandRef);
        } catch (error) {
          if (!(error instanceof ObligationBindingError)) throw error;
          bindingFailures.push({
            obligationId,
            commandRef: request.commandRef,
            errorSummary: error.message,
            allowedCommandRefs: declared.allowedCommandRefs,
            requiredEvidenceClass: declared.evidenceClass,
          });
        }
      }
      if (bindingFailures.length > 0) return evidenceRejected(bindingFailures);

      // Proof is Kernel-planned. A model report may contain verification hints,
      // but only an explicit fresh request is allowed to rerun a satisfied or
      // unrelated obligation; ordinary reports run the outstanding bound hard
      // obligations exactly once in this settlement.
      const proofObligations = refreshProofPolicyBindings(runId);
      const preProofCompletion = evaluateRunCompletion(runId, { obligations: proofObligations });
      // A structured judgment is never a valid substitute for an executable
      // obligation. Reject that hint explicitly and keep the same obligation
      // out of this settlement's automatic proof selection; otherwise the
      // report would both claim invalid evidence and silently replace it with
      // a passing command, masking the caller's forgery.
      const invalidHardJudgmentIds = new Set();
      const invalidHardJudgmentFailures = [];
      for (const judgment of report.judgments) {
        const obligationId = String(judgment.obligationId || '');
        const declared = obligationId ? store.getRunObligation(runId, obligationId) : null;
        if (!declared || declared.evidenceClass === 'judgment') continue;
        invalidHardJudgmentIds.add(obligationId);
        invalidHardJudgmentFailures.push({
          obligationId,
          command: 'structured-judgment',
          errorSummary: `Obligation "${obligationId}" is executable and cannot be satisfied by a structured judgment`,
          errorCode: 'OBLIGATION_REQUIRES_EXECUTABLE_PROOF',
          requiredEvidenceClass: declared.evidenceClass,
        });
      }
      failures.push(...invalidHardJudgmentFailures);
      const proofRequests = proofRequestsForReport({ runId, report, completion: preProofCompletion, step: activeStep })
        .filter((request) => !invalidHardJudgmentIds.has(String(request.obligationId || '')));
      const outstandingJudgmentIds = new Set(preProofCompletion.unsatisfiedObligations
        .filter((entry) => entry.requiredEvidenceClass === 'judgment')
        .map((entry) => entry.obligationId));
      const judgmentRequests = report.judgments.filter((judgment) => (
        outstandingJudgmentIds.has(String(judgment.obligationId))
        || judgment.forceFresh === true
        || judgment.freshnessPolicy === 'fresh'
        || judgment.stalePolicy === 'rerun'
      ));

      const coverageFailures = [];
      for (const request of proofRequests) {
        const obligationId = request.obligationId;
        const declared = store.getRunObligation(runId, obligationId);
        try {
          request.acceptanceCoverage = normalizeAcceptanceCoverage({
            contract: store.getRun(runId).taskContract || {},
            acceptanceCriteria: store.getRun(runId).acceptanceCriteria || [],
            obligation: declared,
            coverage: request.acceptanceCoverage || [],
          });
          assertCommandBinding(declared, request.commandRef);
        } catch (error) {
          coverageFailures.push({
            obligationId,
            commandRef: request.commandRef,
            errorSummary: error.message,
            errorCode: error.code || 'ACCEPTANCE_COVERAGE_INVALID',
            ...(error.detail ? { detail: error.detail } : {}),
          });
        }
      }
      if (coverageFailures.length > 0) return evidenceRejected(coverageFailures);

      if (proofRequests.length === 0 && judgmentRequests.length === 0 && preProofCompletion.unsatisfiedObligations.some((o) => o.requiredEvidenceClass === 'hard')) {
        const current = store.getRun(runId);
        try {
          assertVerificationSupport(proofObligations, { completionPredicate: current.taskContract?.completionPredicate }, { projectMode: current.projectMode });
        } catch (error) {
          store.markRunBlocked(runId, 'unsupported-verification');
          await projectRunState(store.getRun(runId), { runtimeHome });
          return buildBlockedResponse({ runId, reason: 'unsupported-verification', detail: error.message });
        }
      }

      if (proofRequests.length > 0 || judgmentRequests.length > 0) {
        const current = store.getRun(runId);
        // Follow the four-state route fixed at run start.
        const pathToProve = planRouteSteps(current.route?.stages, current.state, 'PROVE') ?? planStatePath(current.state, 'PROVE');
        if (pathToProve === null) throw new Error(`Cannot advance run ${runId} from ${current.state} to verification`);
        for (const stateStep of pathToProve) {
          try {
            await this.transition(runId, stateStep);
          } catch (error) {
            if (error?.code === 'unsupported-verification') {
              return buildBlockedResponse({
                runId,
                reason: 'unsupported-verification',
                detail: error.message,
              });
            }
            throw error;
          }
        }

        const proofExecutionCache = new Map();
        const proofExecutionCacheContext = (() => {
          const cacheRun = store.getRun(runId);
          return Object.freeze({
            reportNonce: Symbol('kernel-proof-report-cache'),
            runId,
            sourceIdentity: cacheRun?.sourceIdentity || null,
            contractRevision: cacheRun?.contractRevision ?? null,
            mutationRevision: cacheRun?.mutationRevision ?? null,
          });
        })();

        let goalRegressionStarted = false;
        const failureSettlementScope = (failure) => failure?.verificationScope
          || deriveVerificationSettlementScope(store.getRunObligation(runId, failure?.obligationId));
        try {
          for (const request of proofRequests) {
            if (request.verificationScope === 'goal' && failures.some((failure) => failureSettlementScope(failure) === 'focused')) break;
            if (request.verificationScope === 'goal' && !goalRegressionStarted) {
              goalRegressionStarted = true;
              recordEfficiency(runId, { timestamps: { goalRegressionStartedAt: new Date().toISOString() } });
            }
            const obligationId = request.obligationId || request.commandRef;
            try {
            const declaredObligation = store.getRunObligation(runId, obligationId);
            const scopeAuthority = authoritativeVerificationScope(declaredObligation);
            const scopeObservation = scopeAuthority
              ? observeScopedWorkspaceIdentity({ projectRoot, scopes: scopeAuthority.scope })
              : null;
            const cacheKey = proofExecutionCacheKey({
              run: store.getRun(runId),
              obligation: declaredObligation,
              request,
              scopeObservation,
            });
            let cachedExecution = proofExecutionCache.get(cacheKey) || null;
            let sharedExecutionUsed = Boolean(cachedExecution);
            let execution;
            if (cachedExecution) {
              try {
                ({ execution } = await this.executeProof(runId, {
                  obligationId,
                  commandRef: request.commandRef,
                  timeoutMs: request.timeoutMs,
                  flakyRerun: request.flakyRerun === true,
                  acceptanceCoverage: request.acceptanceCoverage || [],
                  networkPolicy: request.networkPolicy || 'inherited',
                  allowEvidenceReuse: request.allowEvidenceReuse !== false,
                  sharedExecution: cachedExecution,
                  [proofExecutionCacheRequest]: proofExecutionCacheContext,
                }));
              } catch (error) {
                if (error?.code !== 'PROOF_EXECUTION_REUSE_UNSAFE') throw error;
                proofExecutionCache.delete(cacheKey);
                cachedExecution = null;
                sharedExecutionUsed = false;
              }
            }
            if (!cachedExecution) {
              ({ execution } = await this.executeProof(runId, {
                obligationId,
                commandRef: request.commandRef,
                timeoutMs: request.timeoutMs,
                flakyRerun: request.flakyRerun === true,
                acceptanceCoverage: request.acceptanceCoverage || [],
                networkPolicy: request.networkPolicy || 'inherited',
                allowEvidenceReuse: request.allowEvidenceReuse !== false,
                [proofExecutionCacheRequest]: proofExecutionCacheContext,
              }));
            }
            if (!sharedExecutionUsed
              && proofExecutionCacheContexts.get(execution) === proofExecutionCacheContext
              && execution.workspaceMutatedByProof !== true
              && (execution.actualCommandExecution === true || execution.reused === true)) {
              proofExecutionCache.set(proofExecutionCacheKey({
                run: store.getRun(runId),
                obligation: declaredObligation,
                request,
                scopeObservation,
              }), execution);
            }
            // recordedStatus reflects flaky/self-mutation blocking policy, not
            // just the raw command exit; use it so the report is consistent
            // with what completion authority actually sees.
            const effectiveStatus = execution.recordedStatus || execution.status;
            executed.push({ obligationId, commandRef: request.commandRef, verificationScope: request.verificationScope, status: effectiveStatus, exitCode: execution.exitCode, evidenceDigest: execution.outputDigest, newRegression: request.newRegression === true, flaky: Boolean(execution.flaky), workspaceMutatedByProof: Boolean(execution.workspaceMutatedByProof), shared: Boolean(execution.shared) });
            if (effectiveStatus !== 'passed') {
              const flakyNote = execution.flaky ? ' (flaky: divergent pass/fail — requires a waiver to pass)' : '';
              const mutationNote = execution.workspaceMutatedByProof ? ' (verification command mutated tracked source; evidence invalid)' : '';
              failures.push({
                obligationId,
                commandRef: request.commandRef,
                command: [execution.command, ...execution.args].join(' '),
                errorSummary: `${execution.errorSummary || ''}${flakyNote}${mutationNote}`.trim() || null,
                timedOut: execution.timedOut === true,
                reason: execution.timedOut ? 'verification-timeout' : 'verification-failed',
                verificationScope: request.verificationScope,
              });
            }
          } catch (error) {
            if (error instanceof UntrustedCommandError) {
              store.markRunBlocked(runId, 'unsafe-command');
              await projectRunState(store.getRun(runId), { runtimeHome });
              return buildBlockedResponse({ runId, reason: 'unsafe-command', detail: error.message });
            }
            // A requested isolation that cannot be truly enforced blocks the run
            // rather than recording a false security boundary (§11.5).
            if (error instanceof NetworkPolicyUnenforceableError) {
              store.markRunBlocked(runId, 'network-policy');
              await projectRunState(store.getRun(runId), { runtimeHome });
              return buildBlockedResponse({ runId, reason: 'network-policy', detail: error.message });
            }
            throw error;
          }
          }
        } finally {
          if (goalRegressionStarted) {
            recordEfficiency(runId, { timestamps: { goalRegressionFinishedAt: new Date().toISOString() } });
          }
        }

        for (const judgment of judgmentRequests) {
          // A judgment standing in for a protected obligation (security, auth,
          // payment, migration) must name its reviewer and its reasoning, and
          // at T3 that reviewer may not be the implementer (§31).
          const declaredJudgment = store.getRunObligation(runId, judgment.obligationId);
          if (declaredJudgment?.protected) {
            if (!judgment.reviewerId || !judgment.rationale) {
              failures.push({ obligationId: judgment.obligationId, command: 'structured-judgment', errorSummary: `Protected obligation "${judgment.obligationId}" requires a judgment with reviewerId and rationale` });
              continue;
            }
            // At T3 both identities are mandatory. Making the comparison
            // conditional on `implementerId` being present would let a caller
            // skip the independence gate simply by omitting the field.
            if (refreshedTier(store, runId) === 'T3') {
              if (!report.implementerId) {
                failures.push({ obligationId: judgment.obligationId, command: 'structured-judgment', errorSummary: `T3 protected obligation "${judgment.obligationId}" requires the report to declare implementerId so reviewer independence can be checked` });
                continue;
              }
              if (judgment.reviewerId === report.implementerId) {
                failures.push({ obligationId: judgment.obligationId, command: 'structured-judgment', errorSummary: `T3 protected obligation "${judgment.obligationId}" requires a reviewer independent of the implementer` });
                continue;
              }
            }
          }
          let judgmentEvidenceRef = `judgment://${runId}/${judgment.obligationId}`;
          let judgmentDigest = `sha256:${createHash('sha256').update(JSON.stringify(judgment)).digest('hex')}`;
          let judgmentCoverage = judgment.acceptanceCoverage || (judgment.acceptanceMapping || []).map((mapping) => mapping.acceptance);

          // K0: a protected or T3 judgment may not be self-asserted in the
          // report. It must name a Review Receipt whose reviewer lineage the
          // Kernel itself recorded, and that receipt must still describe the
          // workspace and evidence state the run is in now.
          const currentTier = refreshedTier(store, runId);
          if (reviewReceiptRequired({
            obligationId: judgment.obligationId,
            declared: declaredJudgment,
            proofTier: currentTier,
            independentReviewRequired: judgment.independentReviewRequired === true,
          })) {
            if (!judgment.reviewReceiptId) {
              failures.push({ obligationId: judgment.obligationId, command: 'structured-judgment', errorSummary: `Obligation "${judgment.obligationId}" requires a reviewReceiptId: a review recorded by the Kernel from a routed reviewer session, not a reviewer identifier supplied in the report` });
              continue;
            }
            const receipt = store.getReviewReceipt(judgment.reviewReceiptId, { runId });
            if (!receipt) {
              failures.push({ obligationId: judgment.obligationId, command: 'structured-judgment', errorSummary: `Review receipt "${judgment.reviewReceiptId}" does not exist for this run` });
              continue;
            }
            if (receipt.obligationId !== judgment.obligationId) {
              failures.push({ obligationId: judgment.obligationId, command: 'structured-judgment', errorSummary: `Review receipt "${receipt.receiptId}" reviewed "${receipt.obligationId}" and cannot satisfy "${judgment.obligationId}"` });
              continue;
            }
            const lineage = evaluateReviewReceipt({
              receipt,
              run: store.getRun(runId),
              requireIndependentSession: currentTier === 'T3',
              requireFrontierClass: currentTier === 'T3',
              requireTrustedEnforcement: true,
              currentEvidenceDigest: digestOfEvidence(store.getVerifications(runId), { excludeObligationId: judgment.obligationId }),
            });
            if (!lineage.usable) {
              failures.push({ obligationId: judgment.obligationId, command: 'structured-judgment', errorSummary: `Review receipt "${receipt.receiptId}" cannot prove "${judgment.obligationId}": ${lineage.reasons.join(', ')}` });
              continue;
            }
            if (judgment.verdict === 'pass' && receipt.verdict !== 'pass') {
              failures.push({ obligationId: judgment.obligationId, command: 'structured-judgment', errorSummary: `Review receipt "${receipt.receiptId}" recorded verdict "${receipt.verdict}" and cannot back a passing judgment` });
              continue;
            }
            judgmentEvidenceRef = reviewEvidenceRef(runId, receipt.receiptId);
            judgmentDigest = receipt.digest;
            judgmentCoverage = [...new Set([...(judgmentCoverage || []), ...receipt.acceptanceCoverage])];
          }

          await this.recordProof(runId, {
            obligationId: judgment.obligationId,
            status: judgment.verdict === 'pass' ? 'passed' : 'failed',
            evidenceRef: judgmentEvidenceRef,
            command: 'structured-judgment',
            exitCode: judgment.verdict === 'pass' ? 0 : 1,
            evidenceDigest: judgmentDigest,
            evidenceClass: 'judgment',
            acceptanceCoverage: judgmentCoverage,
          });
          if (judgment.verdict !== 'pass') {
            failures.push({ obligationId: judgment.obligationId, command: 'structured-judgment', errorSummary: judgment.reason || 'structured judgment failed' });
          }
        }
      }

      const refreshed = store.getRun(runId);
      const verifications = store.getVerifications(runId);
      const structuredSignals = buildStructuredRunSignals({
        runId,
        failures: failures.map((failure) => ({ ...failure, fingerprint: failure.fingerprint || failureFingerprint(failure) })),
        judgments: report.judgments,
        executed,
        changedPaths: report.changedPaths,
        verifications,
      });
      structuredSignals.invariantObservations = report.knowledgeObservations
        .filter((observation) => ['ontology_constraint', 'invariant', 'invariant_observation'].includes(observation?.proposedType || observation?.type))
        .map((observation) => ({ ...observation, evidenceRefs: observation.evidenceRefs || observation.evidenceRef || observation.evidenceDigest, scope: observation.scope || report.changedPaths }));
      structuredSignals.supersessionEvidence = report.knowledgeObservations
        .filter((observation) => Array.isArray(observation?.supersedes) || observation?.supersedes || observation?.supersedesId)
        .map((observation) => ({ ...observation, evidenceRefs: observation.evidenceRefs || observation.evidenceRef || observation.evidenceDigest, scope: observation.scope || report.changedPaths }));
      if (typeof store.recordRunSignals === 'function') store.recordRunSignals(runId, structuredSignals);
      const completionPreview = evaluateRunCompletion(runId);
      const outstanding = completionPreview.unsatisfiedObligations.map((entry) => entry.obligationId);
      const focusedOutstanding = completionPreview.unsatisfiedObligations
        .filter((entry) => deriveVerificationSettlementScope(store.getRunObligation(runId, entry.obligationId)) === 'focused')
        .map((entry) => entry.obligationId);
      const workUnitFailures = failures.filter((failure) => (failure?.verificationScope
        || deriveVerificationSettlementScope(store.getRunObligation(runId, failure?.obligationId))) === 'focused');

      // Settle the step BEFORE completion is considered: a step that passed
      // moves the cursor, and only a plan whose every step passed can reach
      // run-level completion.
      const stepOutcome = activeStep
        ? this.settleStep(runId, {
          step: activeStep,
          attempt: stepAttempt,
          report,
          failures: workUnitFailures,
          outstanding: focusedOutstanding,
          requiredObligationIds: (activeStep.obligationIds || []).filter((obligationId) => (
            deriveVerificationSettlementScope(store.getRunObligation(runId, obligationId)) === 'focused'
          )),
          observation,
          persistAttempt: false,
        })
        : null;
      const currentSteps = store.getRunSteps(runId, { planRevision: refreshed.planRevision });
      const stepsSettled = allStepsPassed(currentSteps, refreshed.planRevision);

      let finalization = null;
      if (failures.length === 0 && outstanding.length === 0 && stepsSettled && refreshed.state === 'PROVE') {
        // Only the runner that still holds the lease it acquired may finalize.
        if (!store.isLeaseHeld(runId, { holder, fencingToken })) {
          return { schemaVersion: 1, runId, status: 'lease-conflict', lease: store.getLease(runId), next: await this.next(runId) };
        }
        let finalizationChangedPaths = report.changedPaths;
        if (!parallelSettlement) {
          let finalizationObservation = null;
          try { finalizationObservation = observeWorkspaceIdentity({ projectRoot }); } catch {}
          const finalizationChangeSet = deriveRunChangedPaths({
            observation: finalizationObservation || liveWorkspaceObservation,
            baselineChangedPaths: refreshed.baselineChangedPaths,
            baselineEntries: refreshed.baselineWorkspaceEntries,
            baselineStatus: refreshed.workspaceBaselineStatus,
          });
          if (finalizationChangeSet.status === 'observed') {
            finalizationChangedPaths = canonicalChangedPaths(finalizationChangeSet.actualChangedPaths);
          }
        }
        finalization = await this.finalizeRun(runId, {
          gitCloseoutRequest: report.gitCloseoutRequest,
          changedPaths: finalizationChangedPaths,
          knowledgeObservations: report.knowledgeObservations,
          structuredSignals,
        });
      }

      const proofMutatedWorkspace = executed.some((entry) => entry.workspaceMutatedByProof === true);
      // Advance the report-local observation boundary after all proof and
      // finalization work has run. The original Run-start baseline is kept
      // untouched for user-change protection; this cursor makes each mutable
      // step/report compare against the workspace it actually started from.
      if (!workerWorkspace && !proofMutatedWorkspace) {
        let currentWorkspaceObservation = null;
        try { currentWorkspaceObservation = observeWorkspaceIdentity({ projectRoot }); } catch {}
        advanceWorkspaceReportBaseline(runId, currentWorkspaceObservation);
      }
      const finalRun = store.getRun(runId);
      // `completed` requires BOTH an accepted completion decision and a
      // finalization that actually finished (P0-7).
      const status = finalization?.completionStatus === 'accepted'
        ? (finalization.finalizationStatus === 'completed' ? 'completed' : 'finalization-incomplete')
        : failures.length > 0 ? 'evidence-failed' : 'in-progress';

      store.finishAttempt(compatibilityAttempt.id, failures.length > 0 ? 'failed' : 'finished');

      // Classify failures against the run's baseline so the model can tell
      // which failures it caused vs. pre-existing/unrelated breakage.
      const failureClassification = failures.length > 0
        ? classifyFailures({ baselineFailures: finalRun.baselineFailures || [], currentFailures: failures, changedPaths: report.changedPaths })
        : null;

      await syncRunLocator(finalRun);
      const workAuth = buildWorkAuthorityView({
        run: finalRun,
        steps: store.getRunSteps(runId, { planRevision: finalRun.planRevision }),
        step: this.getCurrentStep(runId),
        routeDecision: store.listModelRouteDecisions(runId).at(-1) || null,
      });
      const stepState = stepOutcome?.state || stepOutcome?.step?.state || null;
      const workUnitStatus = stepOutcome
        ? (stepState === 'passed' ? 'complete' : (stepState === 'failed' || stepState === 'blocked' || failures.length > 0) ? 'blocked' : 'active')
        : (finalization?.completionStatus === 'accepted' ? 'complete' : failures.length > 0 ? 'blocked' : (workAuth?.workUnitStatus || 'active'));
      const goalStatus = workAuth?.goalStatus || (status === 'completed' ? 'complete' : finalRun.status === 'blocked' ? 'blocked' : 'active');
      const nextStep = workAuth?.currentWorkUnit || null;
      const continuation = {
        action: goalStatus === 'complete' ? 'none'
          : finalRun.status === 'blocked' ? 'blocked'
          : (nextStep ? 'implement' : 'continue'),
        stepId: nextStep?.stepId || null,
      };

      const reportResult = {
        schemaVersion: 1,
        runId,
        status,
        workUnitStatus,
        goalStatus,
        continuation,
        attemptNumber: stepAttempt?.attemptNumber ?? compatibilityAttempt.attemptNumber,
        mutationDetected: observed.changed,
        actualChangedPaths,
        reportedChangedPaths,
        executed,
        failures,
        failureClassification,
        step: stepOutcome ? { ...stepOutcome } : null,
        finalization,
        next: buildNextForRun(finalRun, {
          verifications: store.getVerifications(runId),
          requiredObligations: finalRun.requiredObligations,
          contract: finalRun.taskContract ? contractBriefing(finalRun.taskContract) : null,
          failures,
        }),
      };
      if (stepAttempt?.attemptId && stepOutcome?.attemptSettlement) {
        // Journal the exact result before the settlement transaction. If the
        // process exits after that transaction's status UPDATE, the durable
        // result still lets restart replay the original bytes and finish the
        // active attempt without rerunning proof.
        if (typeof store.setStepAttemptReportResult === 'function') {
          store.setStepAttemptReportResult(stepAttempt.attemptId, reportResult);
        }
        // The State Store owns the atomic boundary: use the same canonical
        // string attemptId that owns the report digest, including when the
        // Host pre-bound the attempt before this report crossed a process
        // boundary.
        if (typeof store.finishStepAttemptWithReportResult === 'function') {
          store.finishStepAttemptWithReportResult(
            stepAttempt.attemptId,
            stepOutcome.attemptSettlement,
            reportResult,
          );
        } else {
          // Compatibility for narrow test doubles and older embedded callers.
          // The real SQLite State Store always takes the atomic path above.
          store.finishStepAttempt(stepAttempt.id, stepOutcome.attemptSettlement);
          if (typeof store.setStepAttemptReportResult === 'function') {
            store.setStepAttemptReportResult(stepAttempt.attemptId, reportResult);
          }
        }
      }
      if (reportKey) reportIdempotencyCache.set(reportKey, reportResult);
      return reportResult;
    },

    async recordKnowledgeObservations(runId, { observations = [] } = {}) {
      return recordKnowledgeObservations({ store, runtimeHome, runId, observations });
    },

    async closeRun(runId) {
      const updated = store.transition(runId, 'CLOSE');
      await syncRunLocator(updated);
      await projectRunState(updated, { runtimeHome });
      return updated;
    },

    async finalizeRun(runId, options = {}) {
      try { preflight(runId, 'finalize'); } catch (error) { return bindingErrorPayload(error, { projectRoot, provider: hostProvider }); }
      const finalized = await finalizeRun({ store, runtimeHome, projectRoot, runId, ...options });
      await syncRunLocator(store.getRun(runId));
      return finalized;
    },

    async retryGitCloseout(runId) {
      return retryGitCloseoutHelper(runId, { stateStore: store, repoRoot: projectRoot });
    },

    async assessCompletion(runId) {
      return evaluateRunCompletion(runId);
    },

    // Work Authority is a derived, provider-free view over the durable Run and
    // Step Ledger. It is the single semantic answer for current work,
    // completed/remaining units, execution class, and resume cursor.
    workAuthority(runId, { actionKind = null } = {}) {
      const run = store.getRun(runId);
      if (!run) return null;
      const steps = typeof store.getRunSteps === 'function'
        ? store.getRunSteps(runId, { planRevision: run.planRevision })
        : [];
      return buildWorkAuthorityView({
        run,
        steps,
        routeDecision: store.listModelRouteDecisions(runId).at(-1) || null,
        actionKind,
      });
    },

    // Trust Authority is a derived, provider-free graph over requirements,
    // fresh evidence, protected review lineage, and the completion decision.
    trustAuthority(runId, { step = null } = {}) {
      const run = store.getRun(runId);
      if (!run) return null;
      return buildTrustAuthorityForRun(run, { step });
    },

    // Knowledge Authority is a derived lifecycle view. SQLite records are
    // authoritative; context packs and filesystem projections are summarized
    // as non-authoritative outputs.
    knowledgeAuthority(runId, { stage = null, context = null } = {}) {
      const run = store.getRun(runId);
      if (!run) return null;
      return buildKnowledgeAuthorityForRun(run, { stage, context });
    },

    async status(runId) {
      try { preflight(runId, 'status'); } catch (error) { return bindingErrorPayload(error, { projectRoot, provider: hostProvider }); }
      const run = store.getRun(runId);
      if (!run) return null;
      await syncRunLocator(run);
      const completion = evaluateRunCompletion(runId);
      const verifications = store.getVerifications(runId);
      const context = store.getKnowledgeContextReceipt(runId, run.state)?.receiptJson
        || store.getKnowledgeContextReceipt(runId, 'FRAME')?.receiptJson
        || null;
      return {
        run,
        workAuthority: this.workAuthority(runId),
        trustAuthority: this.trustAuthority(runId),
        knowledgeAuthority: this.knowledgeAuthority(runId, { stage: run.state, context }),
        completion,
        resume: resumeViewForRun(run, {
          completion,
          verifications,
          context,
        }),
        measurement: buildKernelMeasurement({
          run,
          completion,
          verifications,
          verificationHistory: store.getVerificationHistory?.(runId) || [],
          attempts: store.getAttempts(runId),
          routeDecisions: store.listModelRouteDecisions(runId),
          usageReceipts: store.listModelUsageReceipts(runId),
          reviewReceipts: store.listReviewReceipts(runId),
        }),
      };
    },

    async addWaiver(runId, options) {
      const waiver = store.addWaiver(runId, options);
      const run = store.getRun(runId);
      if (run.evidenceTier === 'E2') {
        const pack = buildReleaseEvidencePack({
          objective: run.objective,
          proofTier: run.proofTier,
          acceptanceCoverage: run.acceptanceCriteria,
          acceptance: run.acceptanceCriteria,
          scope: [projectRoot],
          completionDecision: 'pending',
          checks: [...store.getVerifications(runId), waiver],
        });
        const digest = `sha256:${createHash('sha256').update(JSON.stringify({ pack, mutationRevision: run.mutationRevision })).digest('hex')}`;
        store.recordEvidencePack(runId, { tier: 'E2', pack, digest, mutationRevision: run.mutationRevision });
      }
      return waiver;
    },

    async close() {
      store.close();
    },
  };
};
