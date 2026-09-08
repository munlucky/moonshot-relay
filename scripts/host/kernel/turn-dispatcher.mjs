// Host turn dispatcher (§11). Pulls the Kernel's directive, asks the Host
// adapter to run the turn under the requested model class, and files the
// receipt. It owns no provider client: `adapter.dispatch` is the only edge.

import { randomUUID } from 'node:crypto';
import { buildUsageReceipt } from './usage-receipt.mjs';
import { createModelRegistry } from './model-registry.mjs';
import { currentHostPolicies, revalidateBeforeDispatch } from './admission-revalidator.mjs';
import { buildPromptEnvelope } from './prompt-envelope.mjs';
import { buildToolManifest } from './tool-manifest.mjs';
import { resolveSessionLineage } from './session-affinity.mjs';
import { buildKernelContextSegments } from '../../kernel/context-segments.mjs';
import { resolveOptimizationModes } from './provider-prompt-policy.mjs';
import { resolveCodexModelPolicy } from './codex-model-policy.mjs';
import { resolveClaudeEffort } from './claude-effort-policy.mjs';
import { buildModelCapsuleView, buildModelVisiblePromptView } from './model-capsule-view.mjs';
import { dispatchKernelRun } from './parallel-dispatcher.mjs';
import { isMutationBearingAction, isNativeDelegationRequested, isWorkUnitBounded } from './codex-actor-router.mjs';
import { resolveEnforcementStrategy } from '../../kernel/run/model-route-contract.mjs';
import { observeWorkspaceIdentity } from '../../kernel/run/workspace-identity.mjs';
import { attestReviewTransport, resolveReviewTransports } from './review-transport-resolver.mjs';
import { normalizeHostBoundaryRequest } from './host-boundary.mjs';
import { validateIndependentSubagentReviewAttestation } from './independent-subagent-review.mjs';
import { digestOfEvidence } from '../../kernel/proof/review-receipt.mjs';
import { sanitizePersistentPayload } from '../../kernel/persistent-sanitizer.mjs';

const REVIEW_ATTEMPT_META = Symbol('reviewAttemptMeta');

// Fallback is deliberately narrower than "the adapter did not complete".
// Only an explicit, pre-spawn provider/transport classification proves that no
// reviewer result was produced and that trying another transport is safe.
const REVIEW_PRESPAWN_TRANSPORT_CODES = new Set([
  'provider-unavailable',
  'transport-unavailable',
  'launcher-unavailable',
  'cli-version-mismatch',
  'pre-spawn-incompatible',
  'isolated-cli-incompatible',
]);

const REVIEW_TRANSPORT_CATEGORIES = new Set([
  'provider/infrastructure',
  'provider/transport',
  'transport',
  'transport/infrastructure',
  'infrastructure',
]);

const normalizeSnapshotStepId = (stepId) => {
  if (stepId === null || stepId === undefined || stepId === '') return null;
  return String(stepId);
};

const finiteSnapshotRevision = (value) => {
  const revision = Number(value);
  return Number.isInteger(revision) && revision >= 0 ? revision : null;
};

// A model payload returned by Kernel `next` is reusable only while the
// authoritative run, mutation, and work-unit cursor remain the same. This is
// intentionally a read-only projection: it adds no state, table, or public
// lifecycle surface and fails closed when the Host cannot read all fields.
export const captureHostExecutionSnapshot = ({ controlPlane, runId, requestedStepId = undefined } = {}) => {
  const run = controlPlane?.stateStore?.getRun?.(runId);
  if (!run) return null;
  const currentStepId = requestedStepId !== undefined
    ? requestedStepId
    : controlPlane?.getCurrentStep?.(runId)?.stepId;
  const runRevision = finiteSnapshotRevision(run.revision);
  const mutationRevision = finiteSnapshotRevision(run.mutationRevision);
  if (runRevision === null || mutationRevision === null) return null;
  return Object.freeze({
    runRevision,
    mutationRevision,
    stepId: normalizeSnapshotStepId(currentStepId),
  });
};

export const isHostExecutionSnapshotFresh = ({ controlPlane, runId, snapshot, requestedStepId = undefined } = {}) => {
  if (!snapshot || snapshot.stepId === null) return false;
  const current = captureHostExecutionSnapshot({ controlPlane, runId, requestedStepId });
  return Boolean(
    current
    && current.stepId !== null
    && current.runRevision === snapshot.runRevision
    && current.mutationRevision === snapshot.mutationRevision
    && current.stepId === snapshot.stepId,
  );
};

const REVIEW_PROVIDER_EXECUTION_EVIDENCE_FIELDS = Object.freeze([
  'actorSessionId',
  'sessionId',
  'childSessionId',
  'providerRequestId',
  'requestId',
  'responseId',
  'turnId',
  'terminalEvents',
  'events',
  'observedSessionConfig',
  'observedConfig',
  'observed_session_config',
  'observed_config',
  'inputTokens',
  'cachedInputTokens',
  'cacheReadInputTokens',
  'cacheWriteInputTokens',
  'uncachedInputTokens',
  'outputTokens',
  'reasoningTokens',
  'costMicros',
  'wallClockMs',
  'durationMs',
  'previousResponseId',
  'startedAt',
  'finishedAt',
  'usage',
]);

const hasMeaningfulEvidenceValue = (value) => {
  if (value === null || value === undefined || value === '') return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.values(value).some(hasMeaningfulEvidenceValue);
  if (typeof value === 'boolean') return value;
  return true;
};

const hasProviderExecutionEvidence = (source) => {
  if (!source || typeof source !== 'object') return false;
  return REVIEW_PROVIDER_EXECUTION_EVIDENCE_FIELDS.some((field) => hasMeaningfulEvidenceValue(source[field]));
};

const REVIEWER_RESULT_FIELDS = Object.freeze([
  'outcome',
  'report',
  'reviewerOutcome',
  'review',
  'reviewReceipt',
  'reviewReceiptId',
  'verdict',
  'reviewVerdict',
  'findings',
  'evidenceRefs',
  'risks',
]);

const reviewerResultFields = (source) => {
  if (!source || typeof source !== 'object') return {};
  return Object.fromEntries(REVIEWER_RESULT_FIELDS
    .filter((field) => source[field] !== undefined && source[field] !== null)
    .map((field) => [field, source[field]]));
};

const hasReviewerSemanticPayload = (source, seen = new Set()) => {
  if (!source || typeof source !== 'object' || seen.has(source)) return false;
  seen.add(source);
  if (['outcome', 'report', 'reviewerOutcome', 'review', 'reviewReceipt', 'reviewReceiptId']
    .some((field) => source[field] !== null && source[field] !== undefined)) return true;
  if (['verdict', 'reviewVerdict'].some((field) => ['pass', 'fail', 'blocked'].includes(String(source[field] || '').toLowerCase()))) return true;
  if (['findings', 'evidenceRefs', 'risks'].some((field) => Array.isArray(source[field]))) return true;
  return ['details', 'cause', 'error', 'launcherFailure', 'runtimePreflight', 'result', 'response', 'payload']
    .some((field) => hasReviewerSemanticPayload(source[field], seen));
};

const TRANSPORT_MUTATION_EVIDENCE_FIELDS = Object.freeze([
  'mutationEvidence',
  'mutationReceipt',
  'hasMutations',
  'mutated',
  'changedPaths',
  'writeCount',
  'artifactWrites',
]);

const hasMutationEvidence = (source) => {
  if (!source || typeof source !== 'object') return false;
  return TRANSPORT_MUTATION_EVIDENCE_FIELDS.some((field) => hasMeaningfulEvidenceValue(source[field]));
};

const hasSemanticTransportOutcome = (source) => {
  if (!source || typeof source !== 'object') return false;
  if (['outcome', 'report', 'reviewerOutcome', 'review', 'reviewReceipt', 'reviewReceiptId']
    .some((field) => source[field] !== null && source[field] !== undefined)) return true;
  return ['verdict', 'reviewVerdict'].some((field) => ['pass', 'fail', 'blocked'].includes(String(source[field] || '').toLowerCase()))
    || hasReviewerSemanticPayload(source);
};

const transportFailureSources = ({ dispatch = {}, dispatchError = null } = {}) => [
  dispatch,
  dispatch?.runtimePreflight,
  dispatch?.launcherFailure,
  dispatchError,
  dispatchError?.details,
].filter((source) => source && typeof source === 'object');

const isReadOnlyExecution = (permissions) => permissions === 'read_only'
  || permissions === 'read-only'
  || permissions?.filesystem === 'read_only'
  || permissions?.filesystem === 'read-only';

// Transport policy belongs to this Host boundary. Adapters return facts from
// exactly one requested transport; this classifier decides whether a second,
// equivalent transport is safe before any receipt or step failure is closed.
export const classifyTransportFailure = ({
  dispatch = {},
  dispatchError = null,
  decision = {},
  executionContract = {},
  adapter = null,
  requestedTransport = null,
  retryAttempted = false,
} = {}) => {
  const sources = transportFailureSources({ dispatch, dispatchError });
  const preSpawn = sources.some((source) => String(source.failureStage || '').trim().toLowerCase() === 'pre-spawn');
  const providerExecutionObserved = sources.some(hasProviderExecutionEvidence);
  const semanticOutcomeObserved = sources.some(hasSemanticTransportOutcome);
  const mutationEvidenceObserved = sources.some(hasMutationEvidence);
  const failed = ['failed', 'unsupported'].includes(String(dispatch.status || '').toLowerCase())
    && dispatch.resultStatus !== 'completed';
  const independentReviewRequired = decision.role === 'reviewer'
    || decision.independentContextRequired === true
    || executionContract.independentReviewRequired === true
    || executionContract.independentReview === true
    || executionContract.reviewMode === 'independent';
  const contractPreserved = adapter?.supportsOwnerDirectRetry === true
    && !independentReviewRequired
    && !isReadOnlyExecution(executionContract.permissions || decision.permissions);
  const safeToRetryTransport = requestedTransport === 'native-subagent'
    && retryAttempted !== true
    && failed
    && preSpawn
    && !providerExecutionObserved
    && !semanticOutcomeObserved
    && !mutationEvidenceObserved
    && contractPreserved;
  return {
    preSpawn,
    providerExecutionObserved,
    semanticOutcomeObserved,
    mutationEvidenceObserved,
    failed,
    contractPreserved,
    safeToRetryTransport,
    reason: safeToRetryTransport
      ? 'pre-spawn-native-transport-failure'
      : !preSpawn
        ? 'transport-started-or-stage-unknown'
        : providerExecutionObserved
          ? 'provider-execution-observed'
          : semanticOutcomeObserved
            ? 'semantic-outcome-observed'
            : mutationEvidenceObserved
              ? 'mutation-evidence-observed'
              : !contractPreserved
                ? 'equivalent-owner-transport-unavailable'
                : !failed
                  ? 'dispatch-not-failed'
                  : retryAttempted
                    ? 'transport-retry-already-attempted'
                    : 'transport-not-requested-as-native',
  };
};

const withoutReviewAttemptMeta = (response) => {
  if (!response || typeof response !== 'object') return response;
  const publicResponse = { ...response };
  delete publicResponse[REVIEW_ATTEMPT_META];
  return publicResponse;
};

const withReviewAttemptMeta = (response, meta) => ({ ...response, [REVIEW_ATTEMPT_META]: meta });

const isReviewTransportFailure = ({ dispatch = {}, dispatchError = null } = {}) => {
  // An outcome is semantic evidence, even when the surrounding provider
  // status is imperfect.  It must never trigger reviewer shopping.
  if (dispatch?.outcome !== null && dispatch?.outcome !== undefined) return false;
  // A pre-spawn marker is not enough once the Host also reports evidence that
  // a provider process or session existed.  Such a contradictory result is a
  // terminal integrity/telemetry failure, not a safe transport retry.
  if ([dispatch, dispatch?.runtimePreflight, dispatch?.launcherFailure, dispatchError, dispatchError?.details]
    .some(hasProviderExecutionEvidence)) return false;
  // A thrown transport error may carry a reviewer outcome/report in an Error,
  // its nested details, or its launcher failure payload. That is semantic
  // evidence even when the adapter could not return a normal dispatch object;
  // preserve the result and fail closed instead of shopping for another
  // reviewer.
  if ([dispatch, dispatch?.runtimePreflight, dispatch?.launcherFailure, dispatchError, dispatchError?.details]
    .some((source) => hasReviewerSemanticPayload(source))) return false;
  if (dispatch?.launcherFailure) return false;
  const dispatchStage = String(dispatch?.failureStage || '').trim().toLowerCase();
  if (dispatchStage && dispatchStage !== 'pre-spawn') return false;
  if (!['failed', 'unsupported'].includes(String(dispatch?.status || '').toLowerCase())) return false;
  if (dispatch.resultStatus && dispatch.resultStatus !== 'failed') return false;

  const sources = [
    dispatch?.runtimePreflight,
    dispatchError?.details,
    dispatch,
  ].filter((source) => source && typeof source === 'object');
  return sources.some((source) => {
    const code = String(source.errorCode || dispatchError?.code || '').trim();
    const failureStage = String(source.failureStage || '').trim().toLowerCase();
    const failureCategory = String(source.failureCategory || '').trim().toLowerCase();
    return source.status === 'failed'
      && failureStage === 'pre-spawn'
      && REVIEW_PRESPAWN_TRANSPORT_CODES.has(code)
      && REVIEW_TRANSPORT_CATEGORIES.has(failureCategory);
  });
};

const isReviewActionContext = (actionContext = {}) => Boolean(
  String(actionContext.actionKind || '').startsWith('review')
  || actionContext.independentReviewRequired === true,
);

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);

const normalizeReviewCandidate = (candidate, defaults) => {
  const source = candidate && candidate.adapter ? candidate : { adapter: candidate };
  const adapter = source.adapter;
  const surface = adapter?.capabilities?.surface || adapter?.surface || null;
  const primarySurface = defaults.adapter?.capabilities?.surface || defaults.adapter?.surface || null;
  const primaryRegistry = defaults.registry || (primarySurface
    ? createModelRegistry({
      surface: primarySurface,
      runtimeHome: defaults.runtimeHome,
      env: defaults.env,
      overrides: defaults.overrides,
    })
    : null);
  // A same-surface fallback is only another transport for the already
  // selected provider route; it cannot bring a second model/effort registry
  // that silently changes that route. A different surface needs its existing
  // provider registry to map the same Kernel model class to that provider's
  // concrete model. Caller overrides are still inherited below, never taken
  // from the fallback entry.
  const registry = surface && surface === primarySurface
    ? primaryRegistry
    : hasOwn(source, 'registry') && source.registry
      ? source.registry
      : createModelRegistry({
        surface,
        runtimeHome: defaults.runtimeHome,
        env: defaults.env,
        overrides: defaults.overrides,
      });
  return {
    controlPlane: defaults.controlPlane,
    adapter,
    // A fallback may choose its own provider registry, but every other
    // authority input is inherited from the original Kernel turn below.
    registry,
    runtimeHome: defaults.runtimeHome,
    env: defaults.env,
    overrides: defaults.overrides,
    actionContext: defaults.actionContext,
    parentSessionId: defaults.parentSessionId,
    parentSessionConfig: defaults.parentSessionConfig,
    toolPolicy: defaults.toolPolicy,
    permissionPolicy: defaults.permissionPolicy,
    economics: defaults.economics,
  };
};

const reviewCandidateUnavailableReason = (candidate) => {
  const adapter = candidate?.adapter;
  if (!adapter || typeof adapter.dispatch !== 'function') return 'adapter-unavailable';
  if (adapter.nativeDelegationAvailable !== true) return 'reviewer-launcher-unavailable';
  if (adapter.capabilities?.supportsIndependentContext !== true) return 'independent-context-unavailable';
  if (adapter.capabilities?.supportsReadOnlyReview !== true) return 'read-only-review-unavailable';
  const surface = adapter.capabilities?.surface || adapter.surface || null;
  if (!surface || candidate.registry?.surface !== surface || typeof candidate.registry?.resolve !== 'function') return 'reviewer-registry-unavailable';
  return null;
};

// A repeated Host call can replay the same stale `review` action after the
// Kernel has already ingested its receipt. Reusing the current pass is safe
// only when the reviewed obligation, workspace, mutation revision, and hard
// evidence set are all identical. A different obligation remains a distinct
// review point and is allowed to run independently.
const currentReviewReceiptFor = ({ controlPlane, runId, obligationId } = {}) => {
  const stateStore = controlPlane?.stateStore;
  if (!stateStore || !runId || !obligationId
    || typeof stateStore.getRun !== 'function'
    || typeof stateStore.listReviewReceipts !== 'function'
    || typeof stateStore.getVerifications !== 'function') return null;
  const run = stateStore.getRun(runId);
  if (!run?.currentWorkspaceIdentity) return null;
  const evidenceDigest = digestOfEvidence(stateStore.getVerifications(runId), {
    excludeObligationId: obligationId,
  });
  return stateStore.listReviewReceipts(runId, { obligationId })
    .slice()
    .reverse()
    .find((receipt) => receipt?.verdict === 'pass'
      && receipt.subject?.workspaceIdentity === run.currentWorkspaceIdentity
      && Number(receipt.subject?.mutationRevision) === Number(run.mutationRevision)
      && receipt.subject?.evidenceDigest === evidenceDigest) || null;
};

const buildDeduplicatedReviewResponse = ({ runId, turn = null, receipt } = {}) => ({
  schemaVersion: 1,
  runId,
  dispatched: false,
  deduplicated: true,
  reason: 'review-already-recorded',
  modelInput: turn?.modelInput || null,
  hostDirective: turn?.hostDirective || null,
  executionCapsule: turn?.executionCapsule || turn?.hostDirective?.executionCapsule || null,
  dispatch: {
    dispatchMechanism: 'deduplicated-review-receipt',
    actorRole: 'reviewer',
    actorSessionId: receipt?.reviewer?.actorSessionId || null,
  },
  review: {
    required: true,
    independent: true,
    status: 'receipt-recorded',
    review: {
      verdict: receipt?.verdict || 'pass',
      findings: receipt?.findings || [],
      risks: [],
      evidenceRefs: [],
    },
    reviewReceipt: receipt,
  },
  reviewReceipt: receipt,
  reviewReceiptId: receipt?.receiptId || null,
  receipt: null,
  report: null,
});

// A decision carries no risk-shape data (security/migration/...) to the Host
// today, only actionKind/riskTier/reasonCodes, so the recommendation below is
// computed from those alone; `shapes` stays at each policy function's
// default. `repeatedFailure` mirrors the predicate summarizeModelRouting()
// already uses to count an escalated turn, plus 'ESCALATION_LOCKED' — the
// reason resolveModelRoute() emits to KEEP an already-escalated obligation on
// frontier_reasoning for its subsequent attempts. Without it, applying the
// model-policy recommendation on a locked turn would fall through to the
// default Codex Luna/Max (or Claude's default effort) and silently undo
// the very escalation the lock exists to hold.
const isRepeatedFailure = (decision) =>
  decision.workProfile?.repeatedFailure === true
  || (decision.reasonCodes || []).some((code) => code.endsWith('_ESCALATION') || code.endsWith('_REPLAN') || code === 'PROTECTED_OBLIGATION_FAILURE' || code === 'ESCALATION_LOCKED');

// Maps each policy module's internal reason vocabulary onto the receipt's
// closed MODEL_ESCALATION_REASONS enum; a reason with no honest mapping
// (the default-path reasons) reports no escalation rather than 'unknown'.
const ESCALATION_REASON_MAP = Object.freeze({
  'protected-review': 'risk-tier',
  'engineering-review': 'review-policy',
  'planning-action': 'complexity',
  'complex-implementation': 'complexity',
  'routine-batch': 'complexity',
  'repeated-failure-escalation': 'repeated-failure',
  'repeated-failure': 'repeated-failure',
  'user-requested-model': 'user-request',
  'user-requested-reasoning': 'user-request',
  'user-requested': 'user-request',
});

const firstMappedEscalationReason = (reasons = []) => {
  for (const reason of reasons) {
    const mapped = ESCALATION_REASON_MAP[reason];
    if (mapped) return mapped;
  }
  return null;
};

// Resolves the provider model-policy recommendation for this turn.
// Returned unconditionally (not gated on modelPolicyMode) so shadow mode can
// still measure what *would* have been chosen; only the caller decides
// whether to apply it to the resolution actually used for admission and
// dispatch.
export const resolveTurnModelPolicy = ({ decision, hostCapabilities } = {}) => {
  const repeatedFailure = isRepeatedFailure(decision);
  if (hostCapabilities.surface === 'codex') {
    const policy = resolveCodexModelPolicy({
      executionClass: decision.executionClass ?? decision.workProfile?.executionClass ?? null,
      actionKind: decision.actionKind,
      complexity: decision.workProfile?.complexity || 'standard',
    });
    return {
      executionClass: policy.executionClass,
      model: policy.model,
      effort: policy.effort,
      reasons: policy.reasons,
      policyRevision: policy.policyRevision,
    };
  }
  if (hostCapabilities.surface === 'claude') {
    const policy = resolveClaudeEffort({ actionKind: decision.actionKind, riskTier: decision.riskTier, triggers: repeatedFailure ? ['repeated-failure'] : [] });
    return { model: null, effort: policy.effort, reasons: policy.reasons };
  }
  return null;
};

// Only the execution contract crosses to the worker (§4.4) — never the
// planner's reasoning, the conversation, or unrelated repository context.
export const verificationProjectionToEvidence = (projection) => {
  if (Array.isArray(projection)) return projection;
  if (!projection || typeof projection !== 'object') return [];
  return [
    ...(Array.isArray(projection.passed) ? projection.passed.map((obligationId) => ({ obligationId: String(obligationId), status: 'passed' })) : []),
    ...(Array.isArray(projection.pending) ? projection.pending.map((obligationId) => ({ obligationId: String(obligationId), status: 'pending' })) : []),
    ...(Array.isArray(projection.failed) ? projection.failed.map((failure) => ({
      ...failure,
      obligationId: String(failure?.obligationId || failure?.commandRef || ''),
      status: 'failed',
    })) : []),
  ].filter((entry) => entry.obligationId);
};

export const buildExecutionContract = (modelInput = {}, decision = {}) => {
  const action = modelInput.action || {};
  const verificationEvidence = verificationProjectionToEvidence(modelInput.verification || modelInput.evidence);
  const base = {
    objective: modelInput.objective || '',
    acceptance: modelInput.acceptance || [],
    constraints: modelInput.constraints || [],
    nonGoals: modelInput.nonGoals || [],
    role: decision.role,
    permissions: decision.permissions,
    workProfile: decision.workProfile || null,
    action: { type: action.type, guidance: action.guidance || '' },
  };
  if (decision.role === 'reviewer') {
    const acceptanceMatch = String(decision.obligationId || '').match(/^judgment-ac-(\d+)$/i);
    const scopedAcceptance = acceptanceMatch
      ? base.acceptance.filter((entry) => String(entry?.id || '').toUpperCase() === `AC-${acceptanceMatch[1]}`)
      : (decision.obligationId === 'security-review' ? [] : base.acceptance);
    return {
      objective: base.objective,
      acceptance: scopedAcceptance,
      role: base.role,
      permissions: base.permissions,
      changedPaths: modelInput.changedPaths || [],
      // Prior protected judgments are not evidence for a sibling judgment.
      // Passing them here would bypass the review-capsule isolation and can
      // create circular failures between otherwise independent obligations.
      verificationEvidence: verificationEvidence
        .filter((entry) => entry.evidenceClass !== 'judgment'),
      riskTier: decision.riskTier,
    };
  }
  return {
    ...base,
    outstandingObligations: action.outstandingObligations || [],
    requiredEvidence: action.obligations || [],
    currentEvidence: verificationEvidence,
  };
};

const buildReviewerOutcomeForIngestion = ({ outcome, executionCapsule }) => {
  if (!outcome || typeof outcome !== 'object') return null;
  const reviewedMutationRevision = executionCapsule?.subject?.mutationRevision;
  if (!Number.isInteger(reviewedMutationRevision)) return null;
  // The mutation revision is Host/Kernel provenance, not model output. The
  // reviewer must never be able to claim that it inspected a different state
  // by echoing a caller-supplied revision.
  return { ...outcome, reviewedMutationRevision };
};

// Compiles the Host prompt envelope for one turn from the Kernel's `next`
// payload. Project-stable knowledge is left empty here: `next`
// exposes it today only as `knowledge`, a single pre-rendered text block
// that mixes project- and task-scoped facts, so it cannot yet be split into
// the project-stable / volatile layers the envelope expects. Splitting that
// requires a Kernel-side change to `buildStageContext`'s return shape and is
// tracked separately; this wiring does not fabricate a split it cannot prove.
// Likewise no tool schema reaches this generic dispatcher yet, so the tool
// manifest is empty rather than guessed.
export const buildTurnPromptEnvelope = ({ modelInput = {}, decision, resolution, hostCapabilities, env = process.env } = {}) => {
  const action = modelInput.action || {};
  // The current work unit lives at action.step (run-loop.mjs's buildNextPayload
  // only sets it there for implement/fix actions), not at a top-level `step` —
  // reading the wrong path silently produced an empty step, no allowed/
  // forbidden paths, and a null control stepId on every real turn.
  const step = action.step || {};
  const contextSegments = buildKernelContextSegments({
    runStable: {
      objective: modelInput.objective,
      acceptance: modelInput.acceptance || [],
      constraints: modelInput.constraints || [],
      nonGoals: modelInput.nonGoals || [],
    },
    volatile: {
      action: { type: action.type, guidance: action.guidance },
      step: { stepId: step.stepId, objective: step.objective },
      allowedPaths: step.allowedPaths || [],
      forbiddenPaths: step.forbiddenPaths || [],
      evidence: verificationProjectionToEvidence(modelInput.verification || modelInput.evidence),
      // action.obligations is the *outstanding* subset recomputed every turn
      // (run-loop.mjs's buildNextPayload derives it from what has not yet
      // passed) — it shrinks as obligations pass and is absent entirely on a
      // fix action. Classifying it as run-stable would move runStableDigest,
      // and reset cache/session affinity, on every obligation that clears
      // even though the task contract itself never changed. No stable,
      // contract-level obligation set reaches the Host at this layer today
      // (a known gap, not silently worked around), so this stays volatile.
      outstandingObligations: action.obligations || [],
    },
  }).segments;
  return buildPromptEnvelope({
    provider: hostCapabilities.surface,
    surface: hostCapabilities.surface,
    role: decision.role,
    action: decision.actionKind,
    riskTier: decision.riskTier,
    toolManifest: buildToolManifest([]),
    contextSegments,
    modelPolicy: {
      executionClass: decision.executionClass ?? null,
      modelClass: decision.modelClass,
      resolvedModel: resolution.model,
      resolvedEffort: resolution.effort,
    },
    capabilities: hostCapabilities,
    control: { runId: decision.runId, stepId: step.stepId, capsuleId: action.capsuleId },
    env,
  });
};

// Parallel workers still use the normal Host routing boundary. The dispatcher
// obtains the Kernel directive for each Step, then calls this
// helper before it reaches an adapter so model resolution, route admission,
// dispatch-time revalidation, and the prompt envelope cannot be skipped by the
// parallel path.
export const prepareParallelWorkerDispatch = async ({
  controlPlane,
  runId,
  adapter,
  hosted,
  step,
  registry = null,
  runtimeHome,
  env = process.env,
  overrides = {},
  toolPolicy = {},
  permissionPolicy = {},
  economics = {},
} = {}) => {
  const hostCapabilities = adapter?.capabilities || {};
  const modelInput = hosted?.modelInput || {};
  const hostDirective = hosted?.hostDirective || {};
  const decision = hostDirective.modelRouteDecision;
  if (!decision) return { status: 'failed', failureCode: 'worker-route-missing' };
  const hostBoundary = normalizeHostBoundaryRequest({ modelInput, hostDirective });
  if (decision.executionClass === null || decision.modelClass === 'kernel') return { status: 'failed', failureCode: 'kernel-owned-worker-action' };

  const modelRegistry = registry || createModelRegistry({ surface: hostCapabilities.surface, runtimeHome, env, overrides });
  let resolution = typeof modelRegistry.resolveExecutionClass === 'function'
    ? modelRegistry.resolveExecutionClass(decision.executionClass, overrides)
    : modelRegistry.resolve(decision.modelClass, overrides);
  const modes = resolveOptimizationModes(env);
  const modelPolicyMode = hostCapabilities.surface === 'codex' ? modes.codexModelPolicyMode : modes.modelPolicyMode;
  const modelPolicyRecommendation = resolveTurnModelPolicy({ decision, hostCapabilities });
  if (modelPolicyMode === 'on' && modelPolicyRecommendation && resolution.source !== 'invocation-override') {
    const appliedModel = modelPolicyRecommendation.model || resolution.model;
    resolution = {
      ...resolution,
      model: appliedModel,
      effort: modelPolicyRecommendation.effort || resolution.effort,
      ...(appliedModel ? { source: 'model-policy', enforcementIntent: 'enforced' } : {}),
    };
  }

  const executionCapsule = hosted.executionCapsule || hostDirective.executionCapsule || null;
  const attemptId = hostDirective.attemptId || null;
  const policies = currentHostPolicies({ registry: modelRegistry, capabilities: hostCapabilities, toolPolicy, permissionPolicy });
  const admission = await controlPlane.admitRoute(runId, {
    decision,
    resolution,
    capabilities: hostCapabilities,
    capsule: executionCapsule,
    attemptId,
    step,
    policies,
    economics,
  });
  if (admission.decision === 'blocked' || admission.decision === 'redecision_required') {
    return { status: 'failed', failureCode: admission.rejectionCode || admission.decision, modelInput, hostDirective, decision, resolution, executionCapsule, admission };
  }

  const revalidated = revalidateBeforeDispatch({
    admission,
    registry: modelRegistry,
    capabilities: hostCapabilities,
    toolPolicy,
    permissionPolicy,
  });
  if (!revalidated.valid) {
    const drifted = await controlPlane.admitRoute(runId, {
      decision,
      resolution,
      capabilities: hostCapabilities,
      capsule: executionCapsule,
      attemptId,
      step,
      policies: currentHostPolicies({ registry: modelRegistry, capabilities: hostCapabilities, toolPolicy, permissionPolicy }),
      economics,
    });
    return { status: 'failed', failureCode: revalidated.rejectionCode || 'route-admission-drift', modelInput, hostDirective, decision, resolution, executionCapsule, admission: drifted, drift: revalidated.drift };
  }

  return {
    status: 'ready',
    runId,
    modelInput,
    hostDirective,
    decision,
    resolution,
    executionCapsule,
    modelVisibleCapsule: executionCapsule ? buildModelCapsuleView(executionCapsule, { role: decision.role }) : null,
    modelVisiblePrompt: buildModelVisiblePromptView({ modelInput, capsule: executionCapsule }),
    executionContract: buildExecutionContract(modelInput, decision),
    hostExecutionContract: hostBoundary.contract,
    admission,
    strategy: hostDirective.enforcementStrategy,
    envelope: buildTurnPromptEnvelope({ modelInput, decision, resolution, hostCapabilities, env }),
  };
};

const dispatchKernelTurnAttempt = async ({
  controlPlane,
  runId,
  adapter,
  registry,
  runtimeHome,
  env = process.env,
  overrides = {},
  actionContext = {},
  parentSessionId = null,
  parentSessionConfig = null,
  toolPolicy = {},
  permissionPolicy = {},
  economics = {},
  now = () => new Date().toISOString(),
  turn: preloadedTurn = null,
  attemptOverride = null,
  suppressOwnerDirect = false,
  suppressParallel = false,
  useHostDirectiveStrategy = true,
} = {}) => {
  if (!adapter) throw new Error('dispatchKernelTurn requires a Host adapter');
  const hostCapabilities = adapter.capabilities || {};
  const hasSubagentCapability = adapter.nativeDelegationAvailable === true
    || hostCapabilities.nativeSubagent === true
    || hostCapabilities.supportsSubagentModel === true;
  const nativeAvailable = Boolean(adapter.nativeDelegationAvailable && hasSubagentCapability);

  const isExplicitOwnerDirect = actionContext.executionMode === 'owner-direct' || actionContext.ownerDirect === true;

  const nativeDelegationRequested = isNativeDelegationRequested({
    executionMode: actionContext.executionMode,
    delegationRequested: actionContext.delegationRequested,
    actionContext,
    capabilities: hostCapabilities,
    hasNativeLauncher: adapter.nativeDelegationAvailable === true,
  });

  // Codex Desktop is already the native owner session. When it has no
  // optional native worker launcher, return the Kernel work unit to that
  // owner instead of entering the child-worker dispatcher and manufacturing a
  // missing-worker failure. `next()` is deliberately used here rather than
  // `hostNext()`: the latter acquires a worker mutation lock and opens a
  // delegated attempt that an owner-direct turn cannot close.
  const ownerDirectRequested = ['codex', 'claude'].includes(hostCapabilities.surface)
    && adapter.ownerDirectDefault === true
    && suppressOwnerDirect !== true
    && !['prove', 'close'].includes(actionContext.actionKind)
    && (isExplicitOwnerDirect || !nativeAvailable || !nativeDelegationRequested);
  let evaluatedModelInput = null;
  let evaluatedModelInputSnapshot = null;
  if (ownerDirectRequested) {
    const snapshotBeforeNext = captureHostExecutionSnapshot({
      controlPlane,
      runId,
      requestedStepId: actionContext.stepId,
    });
    const modelInput = await controlPlane.next(runId, { stepId: actionContext.stepId || null });
    evaluatedModelInput = modelInput;
    if (snapshotBeforeNext) {
      evaluatedModelInputSnapshot = {
        ...snapshotBeforeNext,
        stepId: normalizeSnapshotStepId(modelInput?.action?.step?.stepId) || snapshotBeforeNext.stepId,
      };
    }
    if (modelInput.status === 'not_found') return modelInput;
    const independentReviewRequired = modelInput.action?.type === 'review'
      && modelInput.action?.independentReviewRequired === true;
    if (independentReviewRequired) {
      if (!hasSubagentCapability) {
        return {
          schemaVersion: 1,
          runId,
          dispatched: false,
          executionMode: 'independent-review',
          reason: 'independent-review-required',
          review: {
            required: true,
            status: 'pending',
            independent: true,
            crossSurface: Boolean(adapter?.capabilities?.supportsCrossSurfaceReview),
          },
          blocker: null,
          modelInput,
          hostDirective: null,
          receipt: null,
          report: null,
        };
      }
      actionContext = {
        ...actionContext,
        executionMode: 'native-subagent',
        delegationRequested: true,
      };
    } else {
      const isMutation = isMutationBearingAction(actionContext.actionKind, modelInput.action?.type);
      const isBounded = isWorkUnitBounded({ modelInput, stepId: modelInput.action?.step?.stepId, allowedPaths: modelInput.action?.step?.allowedPaths });
      if (!isExplicitOwnerDirect && isMutation && isBounded && nativeAvailable) {
        actionContext = {
          ...actionContext,
          executionMode: 'native-subagent',
          delegationRequested: true,
        };
      } else {
        return {
          schemaVersion: 1,
          runId,
          dispatched: false,
          executionMode: 'owner-direct',
          reason: 'owner-session-execution-required',
          ownerExecution: {
            mode: 'owner-direct',
            delegation: { mode: 'optional', available: false },
            report: 'kernel report',
          },
          modelInput,
          hostDirective: null,
          receipt: null,
          report: null,
        };
      }
    }
  }
  const parallelMode = String(env.MOON_RELAY_KERNEL_PARALLEL_MODE || 'shadow').toLowerCase();
  if (parallelMode === 'on' && suppressParallel !== true && actionContext.skipParallel !== true && controlPlane?.getExecutableSteps) {
    return dispatchKernelRun({
      controlPlane,
      runId,
      adapter,
      projectRoot: controlPlane.projectRoot,
      runtimeHome,
      stateStore: controlPlane.stateStore,
      parentSessionId,
      parentSessionConfig,
      env,
      actionContext,
      prepareDispatch: ({ hosted, step }) => prepareParallelWorkerDispatch({
        controlPlane,
        runId,
        adapter,
        hosted,
        step,
        registry,
        runtimeHome,
        env,
        overrides,
        toolPolicy,
        permissionPolicy,
        economics,
      }),
      sequentialDispatcher: () => dispatchKernelTurn({
        controlPlane,
        runId,
        adapter,
        registry,
        runtimeHome,
        env,
        overrides,
        actionContext: { ...actionContext, skipParallel: true },
        parentSessionId,
        parentSessionConfig,
        toolPolicy,
        permissionPolicy,
        economics,
        now,
      }),
    });
  }
  const reusableModelInput = evaluatedModelInput
    && isHostExecutionSnapshotFresh({
      controlPlane,
      runId,
      snapshot: evaluatedModelInputSnapshot,
      requestedStepId: actionContext.stepId || undefined,
    })
    ? evaluatedModelInput
    : null;
  const turn = preloadedTurn || await controlPlane.hostNext(runId, {
    hostCapabilities,
    actionContext,
    modelInput: reusableModelInput,
  });
  if (turn.status === 'not_found') return turn;

  const { modelInput, hostDirective } = turn;
  if (!hostDirective?.modelRouteDecision) return turn;
  const decision = hostDirective.modelRouteDecision;
  const hostBoundary = normalizeHostBoundaryRequest({ modelInput, hostDirective });
  const boundAttempt = attemptOverride || hostDirective.attempt || null;
  const attemptId = boundAttempt?.attemptId || hostDirective.attemptId || null;
  const enforcementStrategy = useHostDirectiveStrategy
    ? hostDirective.enforcementStrategy
    : resolveEnforcementStrategy(hostCapabilities, decision);
  const candidateHostDirective = {
    ...hostDirective,
    hostCapabilities,
    enforcementStrategy,
    attemptId,
    attempt: boundAttempt,
  };
  // prove/close belong to the trusted proof runtime; dispatching a model for
  // them would hand completion authority to a provider.
  if (decision.executionClass === null || decision.modelClass === 'kernel') {
    return { schemaVersion: 1, runId, dispatched: false, reason: 'kernel-owned-action', modelInput, hostDirective, receipt: null };
  }

  const modelRegistry = registry || createModelRegistry({ surface: hostCapabilities.surface, runtimeHome, env, overrides });
  let resolution = typeof modelRegistry.resolveExecutionClass === 'function'
    ? modelRegistry.resolveExecutionClass(decision.executionClass, overrides)
    : modelRegistry.resolve(decision.modelClass, overrides);
  // Wave 5/6: the model-policy recommendation is computed unconditionally so
  // its reasons can be recorded on the receipt even in shadow mode, but it is
  // only applied to the resolution admission and dispatch actually use when
  // Codex uses its provider-specific switch; Claude continues to use the
  // generic switch. Shadow must never change what actually runs.
  const modes = resolveOptimizationModes(env);
  const modelPolicyMode = hostCapabilities.surface === 'codex' ? modes.codexModelPolicyMode : modes.modelPolicyMode;
  const modelPolicyRecommendation = resolveTurnModelPolicy({ decision, hostCapabilities });
  // 'invocation-override' is the registry's own highest-precedence source
  // (§10.2: an explicit per-call override outranks environment, profile, and
  // host-default). Applying the model-policy recommendation on top of it would
  // silently run a different model than the one a caller explicitly asked
  // for — e.g. an experiment pinning a specific model for one call.
  if (modelPolicyMode === 'on' && modelPolicyRecommendation && resolution.source !== 'invocation-override') {
    const appliedModel = modelPolicyRecommendation.model || resolution.model;
    resolution = {
      ...resolution,
      model: appliedModel,
      effort: modelPolicyRecommendation.effort || resolution.effort,
      // Claiming 'model-policy'/'enforced' asserts a concrete, Host-decided
      // model exists. Claude's recommendation supplies only an effort, so a
      // registry with no configured model would otherwise still flip to
      // 'enforced' with no model behind it — letting a T3 review's
      // checkRoleRules() pass on an unproven resolution. Only claim it when
      // the merge actually produced a model.
      ...(appliedModel ? { source: 'model-policy', enforcementIntent: 'enforced' } : {}),
    };
  }
  // K1: the capsule is the authority for what the worker may see and touch.
  // The flat contract is still passed for adapters that have not moved yet.
  const executionCapsule = turn.executionCapsule || hostDirective.executionCapsule || null;
  const attempt = boundAttempt;

  // K3: admission sits between the decision and the dispatch. A blocked or
  // drifted admission stops the turn here — no worker runs, and the refusal is
  // persisted rather than looking like a turn that never happened.
  const policies = currentHostPolicies({ registry: modelRegistry, capabilities: hostCapabilities, toolPolicy, permissionPolicy });
  const admission = await controlPlane.admitRoute(runId, {
    decision,
    resolution,
    capabilities: hostCapabilities,
    capsule: executionCapsule,
    attemptId,
    policies,
    economics,
  });
  if (admission.decision === 'blocked' || admission.decision === 'redecision_required') {
    return { schemaVersion: 1, runId, dispatched: false, reason: admission.rejectionCode || admission.decision, admission, modelInput, hostDirective: candidateHostDirective, executionCapsule, receipt: null };
  }
  const revalidated = revalidateBeforeDispatch({
    admission,
    registry: modelRegistry,
    capabilities: adapter.capabilities,
    toolPolicy,
    permissionPolicy,
  });
  if (!revalidated.valid) {
    const drifted = await controlPlane.admitRoute(runId, {
      decision,
      resolution,
      capabilities: adapter.capabilities,
      capsule: executionCapsule,
      attemptId,
      policies: currentHostPolicies({ registry: modelRegistry, capabilities: adapter.capabilities, toolPolicy, permissionPolicy }),
      economics,
    });
    return { schemaVersion: 1, runId, dispatched: false, reason: revalidated.rejectionCode, admission: drifted, drift: revalidated.drift, modelInput, hostDirective: candidateHostDirective, executionCapsule, receipt: null };
  }

  // Wave 3/7: the envelope is computed on every real turn — not only in the
  // replay corpus — so its digests and cache policy are what the launcher and
  // the usage receipt actually see. Computing it here does not itself change
  // `executionContract`, so a Host still on the legacy path behaves exactly
  // as before; a Host whose `launch()` reads `envelope.segments` gets the
  // cache-stable prompt and breakpoints described in Waves 3-5.
  const envelope = buildTurnPromptEnvelope({ modelInput, decision, resolution, hostCapabilities, env });
  // No persisted cross-turn lineage store exists yet (§Wave 7 follow-up), so
  // `previous` stays null and continuity is never claimed (`continued` is
  // always false here). `instanceSeed` still keys the id off this turn's own
  // decisionId, so two independent turns that happen to share the same
  // identity fingerprint do not mint the same sessionLineageId — without it,
  // an aggregate that groups receipts by lineage id would misread them as one
  // continued session.
  const sessionLineage = resolveSessionLineage({ previous: null, current: envelope.cacheIdentity, role: decision.role, instanceSeed: decision.decisionId });

  // The adapter is the provider boundary. It receives the current Host
  // capsule for lineage/transport work and reprojects the six-field prompt
  // there; no broad capsule view is sent to a launcher.
  const modelVisiblePrompt = buildModelVisiblePromptView({ modelInput, capsule: executionCapsule });
  const executionContract = buildExecutionContract(modelInput, decision);
  const requestedTransport = actionContext.requestedTransport
    || actionContext.transport
    || (actionContext.executionMode === 'native-subagent' ? 'native-subagent' : null);

  const startedAt = now();
  let dispatch;
  let dispatchError = null;
  try {
    dispatch = await adapter.dispatch({
      decision,
      resolution,
      strategy: enforcementStrategy,
      executionCapsule,
      modelInput,
      modelVisiblePrompt,
      executionContract,
      hostExecutionContract: hostBoundary.contract,
      envelope,
      workingDirectory: controlPlane.projectRoot || null,
      environment: env,
      parentSessionId,
      parentSessionConfig,
      reviewSubject: decision.role === 'reviewer'
        ? {
          runId: executionCapsule?.runId || decision.runId || null,
          capsuleDigest: executionCapsule?.provenance?.capsuleDigest || null,
          workspaceIdentity: executionCapsule?.subject?.workspaceIdentity || executionCapsule?.provenance?.workspaceIdentity || null,
          mutationRevision: executionCapsule?.subject?.mutationRevision ?? executionCapsule?.mutationRevision ?? null,
        }
        : null,
      concurrencyGroup: actionContext.concurrencyGroup || runId,
      actionContext,
      requestedTransport,
      executionMode: actionContext.executionMode || ((!isExplicitOwnerDirect && isMutationBearingAction(decision.actionKind, modelInput.action?.type) && executionCapsule && isWorkUnitBounded({ capsule: executionCapsule, modelInput }) && nativeAvailable) ? 'native-subagent' : null),
      delegationRequested: nativeDelegationRequested || decision.role === 'reviewer' || (!isExplicitOwnerDirect && isMutationBearingAction(decision.actionKind, modelInput.action?.type) && executionCapsule && isWorkUnitBounded({ capsule: executionCapsule, modelInput }) && nativeAvailable),
      childSession: {
        canDelegate: false,
        canCommit: false,
        maxNestedAgents: 0,
        freshSessionRequired: decision.workProfile?.independentContextRequired === true || decision.independentContextRequired === true || decision.role === 'reviewer',
      },
    }) || {};
  } catch (error) {
    dispatchError = error;
    const failureStage = error?.failureStage || error?.details?.failureStage || null;
    const failureCategory = error?.failureCategory || error?.details?.failureCategory || null;
    const semanticErrorPayload = {
      ...reviewerResultFields(error?.details?.result),
      ...reviewerResultFields(error?.details),
      ...reviewerResultFields(error),
    };
    const launcherFailure = error?.launcherFailure || error?.details?.launcherFailure || null;
    dispatch = {
      status: 'failed',
      resultStatus: 'failed',
      errorCode: error?.code || error?.errorCode || null,
      errorSummary: error?.message || String(error),
      failureCategory,
      failureStage,
      ...semanticErrorPayload,
      ...(launcherFailure ? { launcherFailure } : {}),
      ...(failureStage === 'pre-spawn' ? {
        runtimePreflight: {
          status: 'failed',
          errorCode: error?.code || error?.errorCode || null,
          failureCategory,
          failureStage,
          ...reviewerResultFields(error?.details?.runtimePreflight),
        },
      } : {}),
    };
  }

  const transportClassification = classifyTransportFailure({
    dispatch,
    dispatchError,
    decision,
    executionContract,
    adapter,
    requestedTransport,
    retryAttempted: actionContext.transportRetry === true,
  });
  if (transportClassification.safeToRetryTransport) {
    const retry = await dispatchKernelTurnAttempt({
      controlPlane,
      runId,
      adapter,
      registry,
      runtimeHome,
      env,
      overrides,
      actionContext: {
        ...actionContext,
        executionMode: 'owner-direct',
        requestedTransport: 'owner-direct',
        delegationRequested: false,
        transportRetry: true,
        transportFallbackReason: transportClassification.reason,
      },
      parentSessionId,
      parentSessionConfig,
      toolPolicy,
      permissionPolicy,
      economics,
      now,
      turn,
      attemptOverride: attempt,
      suppressOwnerDirect: true,
      suppressParallel: true,
      useHostDirectiveStrategy,
    });
    return {
      ...retry,
      transportFallback: {
        ...transportClassification,
        from: requestedTransport,
        to: 'owner-direct',
      },
    };
  }

  // The independent-subagent transport is a Host fallback, but its result is
  // not trusted merely because it contains a reviewer verdict. Require the
  // transport's explicit execution attestation before creating even the
  // usage receipt that can feed the Kernel review chain. Existing native
  // adapters retain their established provider-specific checks.
  if (decision.role === 'reviewer' && dispatch.dispatchMechanism === 'independent-subagent') {
    const reviewSubject = {
      runId: executionCapsule?.runId || decision.runId || null,
      capsuleDigest: executionCapsule?.provenance?.capsuleDigest || null,
      workspaceIdentity: executionCapsule?.subject?.workspaceIdentity || executionCapsule?.provenance?.workspaceIdentity || null,
      mutationRevision: executionCapsule?.subject?.mutationRevision ?? executionCapsule?.mutationRevision ?? null,
    };
    const attestation = validateIndependentSubagentReviewAttestation({
      dispatch,
      invocation: dispatch.invocation || {
        model: resolution.model,
        effort: resolution.effort,
      },
      reviewSubject,
      parentSessionId,
    });
    if (!attestation.valid) {
      dispatch = {
        ...dispatch,
        status: 'failed',
        resultStatus: 'failed',
        errorCode: 'review-transport-attestation-invalid',
        errorSummary: `Independent reviewer attestation failed: ${attestation.reasons.join(', ')}`,
        failureCategory: 'transport/infrastructure',
        failureStage: 'post-spawn',
        outcome: null,
        report: null,
      };
    }
  }

  // Provider output is untrusted text. Sanitize once at the Host boundary so
  // the same safe value is used for receipts, Kernel reports, and the public
  // dispatch response; no provider-specific adapter may bypass persistence
  // redaction.
  dispatch = sanitizePersistentPayload(dispatch);

  const receipt = buildUsageReceipt({
    decision,
    capabilities: hostCapabilities,
    strategy: enforcementStrategy,
    resolution,
    dispatch,
    capsule: executionCapsule,
    admission,
    attemptId,
    bindingId: attempt?.bindingId || null,
    // A pre-spawn refusal has no provider session. Include the canonical
    // attempt in its synthetic Host identity so retry receipts cannot collide
    // when a caller supplies a fixed clock or retries the same route.
    actorSessionId: dispatch.actorSessionId || `${hostCapabilities.surface}:${decision.decisionId}:${attemptId || startedAt || 'unbound'}`,
    parentSessionId,
    startedAt,
    finishedAt: now(),
    envelope,
    sessionLineage,
    cacheContext: {
      // Recorded regardless of modelPolicyMode: the whole point of computing
      // the recommendation unconditionally is that shadow mode can measure
      // which turns *would* have escalated (for risk, complexity, review
      // policy, or repeated failure) before the mode is ever turned on.
      // Gating this on 'on' discarded the only receipt-level evidence of
      // that measurement.
      modelEscalationReason: firstMappedEscalationReason(modelPolicyRecommendation?.reasons),
      // The denominator eligibleHitRatio needs: the token estimate of every
      // segment this turn declared cacheable. Without it every live receipt
      // reports a null eligiblePrefixTokens, so summarizeCacheEconomics() can
      // never publish a real hit ratio outside the replay corpus.
      eligiblePrefixTokens: envelope.segments.filter((segment) => segment.cacheable).reduce((total, segment) => total + segment.tokenEstimate, 0),
    },
  });
  await controlPlane.recordModelUsage(runId, receipt);
  const response = {
    schemaVersion: 1,
    runId,
    dispatched: true,
    modelInput,
    hostDirective: candidateHostDirective,
    resolution,
    dispatch,
    executionCapsule,
    admission,
    receipt,
    envelope,
    attemptId,
    report: dispatch.report
      ? {
        ...dispatch.report,
        attemptId,
        bindingId: attempt?.bindingId || dispatch.report.bindingId,
        assignmentId: dispatch.report.assignmentId || candidateHostDirective.executionAssignment?.assignmentId || null,
        actorSessionId: dispatch.report.actorSessionId || dispatch.actorSessionId || null,
      }
      : null,
  };
  if (decision.role !== 'reviewer') {
    if (dispatch.status === 'failed' || dispatch.resultStatus === 'failed') {
      const stepId = executionCapsule?.stepId || boundAttempt?.stepId;
      if (stepId && typeof controlPlane?.failStepAttempt === 'function') {
        try {
          await controlPlane.failStepAttempt(runId, stepId, {
            code: dispatch.errorCode || 'worker-dispatch-failed',
            failureCategory: dispatch.failureCategory || 'provider/infrastructure',
            errorSummary: dispatch.errorSummary || null,
          });
        } catch {
          // fail safe if attempt is already closed
        }
      }
    }
    return response;
  }

  if (dispatch.status !== 'completed' || !dispatch.outcome) {
    finishUnusableReviewAttempt({
      controlPlane,
      attempt,
      reason: dispatch.errorCode || (dispatch.outcome ? 'reviewer-dispatch-failed' : 'reviewer-outcome-missing'),
    });
    return withReviewAttemptMeta({
      ...response,
      review: {
        required: true,
        independent: true,
        status: dispatch.status === 'failed' || dispatch.status === 'unsupported' || !dispatch.outcome ? 'blocked' : 'pending',
        blockedReason: dispatch.status === 'failed' || dispatch.status === 'unsupported'
          ? dispatch.errorCode || 'reviewer-dispatch-failed'
          : 'reviewer-outcome-missing',
        errorSummary: dispatch.errorSummary || null,
      },
      reviewReceipt: null,
      reviewReceiptId: null,
    }, {
      fallbackEligible: isReviewTransportFailure({ dispatch, dispatchError }),
    });
  }

  const reviewerOutcome = buildReviewerOutcomeForIngestion({
    outcome: dispatch.outcome,
    executionCapsule,
  });
  if (!reviewerOutcome) {
    finishUnusableReviewAttempt({
      controlPlane,
      attempt,
      reason: 'reviewer-provenance-missing',
    });
    return withReviewAttemptMeta({
      ...response,
      review: { required: true, independent: true, status: 'blocked', blockedReason: 'reviewer-provenance-missing' },
      reviewReceipt: null,
      reviewReceiptId: null,
      blocker: { reason: 'reviewer-provenance-missing', detail: 'The Host could not bind the reviewer outcome to the current capsule mutation revision.' },
    }, { fallbackEligible: false });
  }

  try {
    const review = await controlPlane.ingestReviewerOutcome({
      runId,
      stepId: executionCapsule.stepId || null,
      capsuleId: executionCapsule.capsuleId,
      routeDecisionId: decision.decisionId,
      usageReceiptId: receipt.receiptId,
      reviewerSessionId: dispatch.actorSessionId,
      outcome: reviewerOutcome,
    });
    return withReviewAttemptMeta({
      ...response,
      review,
      reviewReceipt: review.reviewReceipt || null,
      reviewReceiptId: review.reviewReceipt?.receiptId || null,
    }, { fallbackEligible: false });
  } catch (error) {
    // A usage receipt may exist even when the review chain is incomplete. It
    // remains observable, but it can never be promoted to a review receipt by
    // the Host or by the model.
    finishUnusableReviewAttempt({
      controlPlane,
      attempt,
      reason: 'incomplete_review_chain',
    });
    return withReviewAttemptMeta({
      ...response,
      review: {
        required: true,
        independent: true,
        status: 'blocked',
        blockedReason: 'incomplete_review_chain',
        errorSummary: error?.message || String(error),
      },
      reviewReceipt: null,
      reviewReceiptId: null,
      blocker: { reason: 'incomplete_review_chain', detail: error?.message || String(error) },
    }, { fallbackEligible: false });
  }
};

const finishUnusableReviewAttempt = ({ controlPlane, attempt, reason }) => {
  const stateStore = controlPlane?.stateStore;
  if (!stateStore || !attempt?.id || typeof stateStore.finishStepAttempt !== 'function') return;
  const current = typeof stateStore.getStepAttempt === 'function' ? stateStore.getStepAttempt(attempt.id) : attempt;
  if (!current || !['started', 'reported', 'verifying'].includes(current.status)) return;
  stateStore.finishStepAttempt(attempt.id, {
    status: 'interrupted',
    failureReasons: [reason],
    failureCategory: reason,
  });
};

const beginReviewFallbackAttempt = ({ controlPlane, runId, turn, decision, previousAttempt }) => {
  const executionCapsule = turn?.executionCapsule || turn?.hostDirective?.executionCapsule || null;
  if (!previousAttempt?.attemptId || !executionCapsule?.stepId || typeof controlPlane?.beginAttempt !== 'function') return null;
  try {
    return controlPlane.beginAttempt(runId, {
      stepId: executionCapsule.stepId,
      bindingId: previousAttempt.bindingId || null,
      capsuleId: executionCapsule.capsuleId,
      capsuleDigest: executionCapsule.provenance?.capsuleDigest || previousAttempt.capsuleDigest || null,
      routeDecisionId: decision?.decisionId || previousAttempt.routeDecisionId || null,
      parentAttemptId: previousAttempt.attemptId,
      provenanceKind: 'routed',
      planRevision: Number(previousAttempt.planRevision || decision?.planRevision || 1),
      mutationRevision: Number(executionCapsule.subject?.mutationRevision ?? previousAttempt.mutationRevision ?? 0),
      workspaceIdentityStart: executionCapsule.provenance?.workspaceIdentity || previousAttempt.workspaceIdentityStart || null,
      workspaceId: previousAttempt.workspaceId || null,
      workspaceRootHash: previousAttempt.workspaceRootHash || null,
      baseWorkspaceIdentity: previousAttempt.baseWorkspaceIdentity || null,
      retryReason: 'review-transport-fallback',
    });
  } catch {
    // A fallback without a fresh canonical attempt would reuse a failed
    // provider receipt, so the caller must stop rather than weaken lineage.
    return null;
  }
};

const observeReviewSubjectFreshness = ({ controlPlane, runId, executionCapsule } = {}) => {
  const stateStore = controlPlane?.stateStore;
  const projectRoot = controlPlane?.projectRoot;
  const unavailable = (reasons) => ({ stale: true, reasons, liveWorkspaceIdentity: null, run: null });
  if (!stateStore || typeof stateStore.getRun !== 'function' || typeof stateStore.observeWorkspaceIdentity !== 'function' || !projectRoot) {
    return unavailable(['review-workspace-observation-unavailable']);
  }

  let liveObservation;
  try {
    liveObservation = observeWorkspaceIdentity({ projectRoot });
  } catch {
    return unavailable(['review-workspace-observation-failed']);
  }
  if (!liveObservation?.identity) return unavailable(['review-workspace-identity-unavailable']);

  let run = stateStore.getRun(runId);
  if (!run) return unavailable(['run-not-found']);

  const subject = executionCapsule?.subject || {};
  const capsuleWorkspaceIdentity = subject.workspaceIdentity
    || executionCapsule?.provenance?.workspaceIdentity
    || null;
  const capsuleMutationRevision = subject.mutationRevision
    ?? executionCapsule?.mutationRevision
    ?? null;
  const reasons = [];

  // Advance the existing authoritative Run observation before comparing the
  // capsule. This makes a concurrent mutation visible to the next PROVE turn
  // while keeping the stale capsule fail-closed for this fallback chain.
  if (run.currentWorkspaceIdentity !== liveObservation.identity) {
    reasons.push('review-workspace-identity-changed');
    try {
      run = stateStore.observeWorkspaceIdentity(runId, liveObservation.identity).run || stateStore.getRun(runId);
    } catch {
      return unavailable(['review-workspace-observation-persist-failed']);
    }
  }
  if (capsuleWorkspaceIdentity !== liveObservation.identity) reasons.push('capsule-workspace-identity-stale');
  if (!Number.isInteger(Number(capsuleMutationRevision))) {
    reasons.push('capsule-mutation-revision-unavailable');
  } else if (Number(capsuleMutationRevision) !== Number(run?.mutationRevision)) {
    reasons.push('capsule-mutation-revision-stale');
  }
  return {
    stale: reasons.length > 0,
    reasons,
    liveWorkspaceIdentity: liveObservation.identity,
    run,
  };
};

const buildReviewSubjectStaleResponse = ({ turn, runId, lastTransportFailure, freshness } = {}) => {
  const base = withoutReviewAttemptMeta(lastTransportFailure) || {
    schemaVersion: 1,
    runId,
    dispatched: false,
    modelInput: turn?.modelInput,
    hostDirective: turn?.hostDirective,
    executionCapsule: turn?.executionCapsule || turn?.hostDirective?.executionCapsule || null,
    receipt: null,
    report: null,
  };
  const detail = freshness?.reasons?.join(', ') || 'review capsule subject changed';
  return {
    ...base,
    reason: 'review-subject-stale',
    executionMode: 'independent-review',
    review: {
      required: true,
      independent: true,
      status: 'blocked',
      blockedReason: 'review-subject-stale',
      errorSummary: detail,
    },
    reviewReceipt: null,
    reviewReceiptId: null,
    blocker: {
      reason: 'review-subject-stale',
      detail: `Reviewer fallback stopped because the capsule subject changed (${detail}). Request a fresh PROVE review action.`,
    },
  };
};

const buildReviewClaimFailureResponse = ({ turn, runId, claim, claimKey } = {}) => {
  const reason = claim?.reason || 'review-claim-not-established';
  const base = {
    schemaVersion: 1,
    runId,
    dispatched: false,
    modelInput: turn?.modelInput || null,
    hostDirective: turn?.hostDirective || null,
    executionCapsule: turn?.executionCapsule || turn?.hostDirective?.executionCapsule || null,
    receipt: null,
    report: null,
  };
  return {
    ...base,
    reason,
    executionMode: 'independent-review',
    claim: claim || { claimed: false, reason },
    claimKey: claimKey || null,
    review: {
      required: true,
      independent: true,
      status: 'blocked',
      blockedReason: reason,
      errorSummary: 'Reviewer dispatch stopped because durable claim ownership was not established.',
    },
    reviewReceipt: null,
    reviewReceiptId: null,
    blocker: {
      reason,
      detail: 'No reviewer provider was invoked without an owned durable review claim.',
    },
  };
};

export const dispatchKernelTurn = async ({
  controlPlane,
  runId,
  adapter,
  registry,
  runtimeHome,
  env = process.env,
  overrides = {},
  actionContext = {},
  parentSessionId = null,
  parentSessionConfig = null,
  toolPolicy = {},
  permissionPolicy = {},
  economics = {},
  now = () => new Date().toISOString(),
  reviewFallbacks = [],
  hostAdapters = [],
  reviewTransports = [],
} = {}) => {
  if (!adapter) throw new Error('dispatchKernelTurn requires a Host adapter');
  const fallbackEntries = resolveReviewTransports({
    adapter,
    reviewFallbacks: (Array.isArray(reviewFallbacks) ? reviewFallbacks : [])
      .map((entry) => attestReviewTransport(entry, 'dispatcher:explicit-fallback'))
      .filter(Boolean),
    hostAdapters: (Array.isArray(hostAdapters) ? hostAdapters : [])
      .map((entry) => attestReviewTransport(entry, 'dispatcher:host-adapter'))
      .filter(Boolean),
    reviewTransports: (Array.isArray(reviewTransports) ? reviewTransports : [])
      .map((entry) => attestReviewTransport(entry, 'dispatcher:review-transport'))
      .filter(Boolean),
    env,
    runtimeHome,
    overrides,
  });
  const reviewIntent = isReviewActionContext(actionContext);

  // Review is one obligation-level action. A retried call for the same
  // subject must not create a second reviewer session or receipt.
  if (reviewIntent && actionContext.obligationId) {
    const existing = currentReviewReceiptFor({
      controlPlane,
      runId,
      obligationId: actionContext.obligationId,
    });
    if (existing) return buildDeduplicatedReviewResponse({ runId, receipt: existing });
  }

  // Preserve the original owner-direct and parallel paths byte-for-byte for
  // ordinary work.  Review candidates need one shared hostNext result, so the
  // reviewer path below preloads that turn before trying any adapter.
  if (!reviewIntent) {
    return withoutReviewAttemptMeta(await dispatchKernelTurnAttempt({
      controlPlane,
      runId,
      adapter,
      registry,
      runtimeHome,
      env,
      overrides,
      actionContext,
      parentSessionId,
      parentSessionConfig,
      toolPolicy,
      permissionPolicy,
      economics,
      now,
    }));
  }

  const hostCapabilities = adapter.capabilities || {};
  const turn = await controlPlane.hostNext(runId, { hostCapabilities, actionContext });
  if (turn.status === 'not_found') return turn;
  if (!turn.hostDirective?.modelRouteDecision) return turn;
  const decision = turn.hostDirective.modelRouteDecision;
  const existing = currentReviewReceiptFor({
    controlPlane,
    runId,
    obligationId: decision.obligationId,
  });
  if (existing) {
    finishUnusableReviewAttempt({
      controlPlane,
      attempt: turn.hostDirective?.attempt || null,
      reason: 'review-already-recorded',
    });
    return buildDeduplicatedReviewResponse({ runId, turn, receipt: existing });
  }
  const reviewStepId = decision.stepId || turn.hostDirective?.attempt?.stepId || turn.executionCapsule?.stepId;
  const reviewPlanRevision = turn.executionCapsule?.planRevision ?? turn.hostDirective?.attempt?.planRevision ?? null;
  const reviewMutationRevision = turn.executionCapsule?.mutationRevision ?? turn.hostDirective?.attempt?.mutationRevision ?? null;
  // The claim label is part of the durable subject identity. Including the
  // plan and step prevents a new plan from inheriting a stale old-plan claim.
  const reviewClaimKey = JSON.stringify({
    runId,
    stepId: reviewStepId || null,
    planRevision: reviewPlanRevision,
    mutationRevision: reviewMutationRevision,
    obligationId: decision.obligationId || 'review',
  });
  const reviewClaimHolder = `host-review:${process.pid}:${randomUUID()}`;
  const reviewClaim = controlPlane.stateStore?.claimReviewAttempt?.({
    runId,
    stepId: reviewStepId,
    claimKey: reviewClaimKey,
    holder: reviewClaimHolder,
    expiresAt: new Date(Date.now() + 300000).toISOString(),
    role: decision.role,
    actionKind: decision.actionKind,
    obligationId: decision.obligationId,
    planRevision: reviewPlanRevision,
    mutationRevision: reviewMutationRevision,
  });
  if (reviewClaim?.reason === 'already-claimed' || (reviewClaim && !reviewClaim.claimed && reviewClaim.existing)) {
    return { ...buildDeduplicatedReviewResponse({ runId, turn, receipt: null }), status: 'review-in-progress', reason: 'review-already-claimed', claim: reviewClaim.existing || null };
  }
  const reviewClaimEstablished = reviewClaim?.claimed === true && Boolean(reviewClaim.existing?.attemptId);
  if (decision.role === 'reviewer' && !reviewClaimEstablished) {
    const claimFailureReason = reviewClaim?.reason || 'review-claim-not-established';
    finishUnusableReviewAttempt({
      controlPlane,
      attempt: turn.hostDirective?.attempt || null,
      reason: claimFailureReason,
    });
    return buildReviewClaimFailureResponse({ runId, turn, claim: reviewClaim, claimKey: reviewClaimKey });
  }
  const defaults = {
    controlPlane,
    adapter,
    registry,
    runtimeHome,
    env,
    overrides,
    actionContext,
    parentSessionId,
    parentSessionConfig,
    toolPolicy,
    permissionPolicy,
    economics,
  };

  // A caller may pass a fallback list defensively while the current action is
  // ordinary work.  The list is only meaningful for a reviewer decision.
  if (decision.role !== 'reviewer') {
    return withoutReviewAttemptMeta(await dispatchKernelTurnAttempt({
      ...defaults,
      runId,
      now,
      turn,
      suppressOwnerDirect: true,
      suppressParallel: true,
    }));
  }

  const candidates = [{ adapter }, ...fallbackEntries].map((candidate) => normalizeReviewCandidate(candidate, defaults));
  const candidateUnavailableReasons = candidates.map((candidate) => reviewCandidateUnavailableReason(candidate));
  let lastTransportFailure = null;
  let canonicalAttempt = turn.hostDirective?.attempt || null;
  for (const [candidateIndex, candidate] of candidates.entries()) {
    if (candidateUnavailableReasons[candidateIndex]) continue;

    // Every fallback candidate gets a fresh child attempt, including when an
    // unavailable candidate was skipped between two usable transports. This
    // keeps one canonical attempt per attempted transport and preserves the
    // parent chain through arbitrary fallback hops.
    let fallbackAttempt = null;
    if (candidateIndex > 0) {
      const freshness = observeReviewSubjectFreshness({
        controlPlane,
        runId,
        executionCapsule: turn.executionCapsule || turn.hostDirective?.executionCapsule || null,
      });
      if (freshness.stale) {
        finishUnusableReviewAttempt({
          controlPlane,
          attempt: canonicalAttempt || lastTransportFailure?.hostDirective?.attempt || turn.hostDirective?.attempt || null,
          reason: 'review-subject-stale',
        });
        return buildReviewSubjectStaleResponse({
          turn,
          runId,
          lastTransportFailure,
          freshness,
        });
      }
      const previousAttempt = canonicalAttempt;
      finishUnusableReviewAttempt({
        controlPlane,
        attempt: canonicalAttempt,
        reason: candidateUnavailableReasons.slice(0, candidateIndex).find(Boolean) || 'reviewer-transport-unavailable',
      });
      fallbackAttempt = beginReviewFallbackAttempt({
        controlPlane,
        runId,
        turn,
        decision,
        previousAttempt,
      });
      if (!fallbackAttempt) break;
    }

    const attempt = await dispatchKernelTurnAttempt({
      ...candidate,
      runId,
      now,
      turn,
      suppressOwnerDirect: true,
      suppressParallel: true,
      useHostDirectiveStrategy: candidateIndex === 0,
      attemptOverride: fallbackAttempt,
    });
    canonicalAttempt = attempt?.hostDirective?.attempt || fallbackAttempt || canonicalAttempt;
    const meta = attempt?.[REVIEW_ATTEMPT_META];
    if (meta?.fallbackEligible !== true) return withoutReviewAttemptMeta(attempt);
    lastTransportFailure = attempt;
  }

  if (lastTransportFailure) {
    finishUnusableReviewAttempt({
      controlPlane,
      attempt: canonicalAttempt || lastTransportFailure.hostDirective?.attempt || turn.hostDirective?.attempt || null,
      reason: lastTransportFailure.review?.blockedReason || 'reviewer-transport-failed',
    });
  } else {
    finishUnusableReviewAttempt({
      controlPlane,
      attempt: canonicalAttempt || turn.hostDirective?.attempt || null,
      reason: 'no-independent-review-capability',
    });
  }
  controlPlane.stateStore?.releaseReviewClaim?.(reviewClaimKey, reviewClaimHolder, {
    runId,
    stepId: reviewStepId,
    planRevision: reviewPlanRevision,
  });

  const base = withoutReviewAttemptMeta(lastTransportFailure) || {
    schemaVersion: 1,
    runId,
    dispatched: false,
    modelInput: turn.modelInput,
    hostDirective: turn.hostDirective,
    executionCapsule: turn.executionCapsule || turn.hostDirective.executionCapsule || null,
    receipt: null,
    report: null,
  };
  return {
    ...base,
    reason: 'no-independent-review-capability',
    executionMode: 'independent-review',
    review: {
      required: true,
      independent: true,
      status: 'blocked',
      blockedReason: 'no-independent-review-capability',
      errorSummary: null,
    },
    reviewReceipt: null,
    reviewReceiptId: null,
    blocker: {
      reason: 'no-independent-review-capability',
      detail: 'No configured reviewer transport produced an independent outcome.',
    },
  };
};
