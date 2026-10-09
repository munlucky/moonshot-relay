// Host review readiness (Wave R4).
//
// This is a derived preflight view. It does not create a Run, acquire a
// mutation lock, open an attempt, or persist a receipt. The caller uses it to
// decide whether the existing Host dispatcher can take the current Run all the
// way through an independent review and Kernel-owned receipt.

import { resolveClaudeEffort } from './claude-effort-policy.mjs';
import { resolveCodexModelPolicy } from './codex-model-policy.mjs';
import { resolveOptimizationModes } from './provider-prompt-policy.mjs';

export const REVIEW_READINESS_SCHEMA_VERSION = 1;
export const REVIEW_READINESS_STATUSES = Object.freeze(['READY', 'DEGRADED', 'BLOCKED']);

const isObject = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const present = (value) => value !== null && value !== undefined && String(value).trim() !== '';
const list = (value) => (Array.isArray(value) ? value : []);

const obligationNeedsIndependentReview = (obligation = {}) => Boolean(
  obligation.evidenceClass === 'judgment'
  || obligation.protected === true
  || obligation.obligationId === 'security-review'
  || obligation.independentReviewRequired === true,
);

export const reviewRequiredForRun = ({ run = null, modelInput = null, obligations = [], verifications = [] } = {}) => {
  const action = modelInput?.action || {};
  if (action.type === 'review') return true;
  const passedObligations = new Set(list(verifications)
    .filter((verification) => String(verification?.status || '').toLowerCase() === 'passed')
    .map((verification) => String(verification.obligationId)));
  const reviewObligations = list(obligations).filter(obligationNeedsIndependentReview);
  const pendingReviewObligation = reviewObligations.some((obligation) => (
    obligationNeedsIndependentReview(obligation)
    && String(obligation?.status || '').toLowerCase() !== 'passed'
    && !passedObligations.has(String(obligation?.obligationId))
  ));
  const explicitlyRequested = Boolean(
    action.independentReviewRequired === true
    || run?.independentReviewRequired === true
    || run?.taskContract?.flags?.independentReviewRequired === true
    || run?.taskContract?.flags?.reviewRequired === true
    || run?.taskContract?.independentReview === true
  );
  // An explicit review requirement with incomplete obligation metadata must
  // remain fail-closed. Only a known, passed review obligation can clear it;
  // a nonempty list containing only hard obligations is not proof of review.
  if (explicitlyRequested) return reviewObligations.length === 0 || pendingReviewObligation;
  // Protected obligations require independent review even when a caller's
  // tier metadata is incomplete; T3 is an additional trigger, not a bypass.
  return pendingReviewObligation;
};

const resolveReviewModelAndEffort = ({ adapter, registry, riskTier = 'T3', actionKind = 'review_engineering', env = process.env } = {}) => {
  const surface = String(adapter?.capabilities?.surface || adapter?.surface || registry?.surface || '').toLowerCase();
  let registryResolution = null;
  try {
    registryResolution = typeof registry?.resolveExecutionClass === 'function'
      ? registry.resolveExecutionClass('review')
      : typeof registry?.resolve === 'function'
        ? registry.resolve('frontier_reasoning')
        : null;
  } catch {
    registryResolution = null;
  }

  // The Codex provider policy is already the source of truth used by the real
  // dispatcher. Use it for readiness too, otherwise a default Codex Host would
  // be reported as unavailable even though the dispatcher will select
  // gpt-6-astra/high before admission.
  const modes = resolveOptimizationModes(env);
  const codexPolicy = surface === 'codex' && modes.codexModelPolicyMode === 'on'
    ? resolveCodexModelPolicy({ executionClass: 'review', actionKind })
    : null;
  const claudePolicy = surface === 'claude'
    ? resolveClaudeEffort({ actionKind, riskTier })
    : null;
  const policyEnabled = surface === 'codex'
    ? modes.codexModelPolicyMode === 'on'
    : surface === 'claude'
      ? modes.modelPolicyMode === 'on'
      : false;
  const invocationOverride = registryResolution?.source === 'invocation-override';
  // Keep the preflight resolution identical to the dispatcher: provider policy
  // applies over environment/profile values, while an explicit invocation
  // override remains authoritative. A readiness payload that names a different
  // model from the one admission will use is an unsafe green light.
  const appliedPolicyModel = !invocationOverride && policyEnabled ? codexPolicy?.model || null : null;
  const appliedPolicyEffort = !invocationOverride && policyEnabled
    ? codexPolicy?.effort || claudePolicy?.effort || null
    : null;
  const model = appliedPolicyModel || registryResolution?.model || null;
  const effort = appliedPolicyEffort || registryResolution?.effort || null;

  return {
    surface: surface || null,
    model,
    effort,
    source: registryResolution?.model
      && !appliedPolicyModel
      ? registryResolution.source || 'registry'
      : appliedPolicyModel
        ? 'codex-model-policy'
        : null,
    registryResolution,
    policy: codexPolicy || claudePolicy || null,
    policyEnabled,
  };
};

const baselineCheck = ({ run, workspaceBaseline = null } = {}) => {
  if (workspaceBaseline && typeof workspaceBaseline.status === 'string') {
    const status = String(workspaceBaseline.status).toLowerCase();
    return {
      status: ['captured', 'ready', 'not-applicable'].includes(status) ? 'ready' : status === 'blocked' ? 'blocked' : 'unknown',
      reason: workspaceBaseline.reason || workspaceBaseline.status,
    };
  }
  if (run?.projectMode === 'greenfield') return { status: 'ready', reason: 'greenfield-not-applicable' };
  if (present(run?.runStartWorkspaceIdentity) && present(run?.currentWorkspaceIdentity)) {
    return { status: 'ready', reason: 'run-start-and-current-identities-present' };
  }
  return { status: 'unknown', reason: 'workspace-baseline-not-observed-by-readiness' };
};

const verificationCheck = ({ obligations = [], verificationCommands = null } = {}) => {
  if (verificationCommands === null || verificationCommands === undefined) {
    return { status: 'unknown', reason: 'verification-command-catalog-not-supplied' };
  }
  const commands = list(verificationCommands);
  const hardObligations = list(obligations).filter((obligation) => obligation?.evidenceClass === 'hard');
  const commandRefs = new Set(commands.map((command) => String(command?.commandRef || command || '')));
  const missing = hardObligations
    .filter((obligation) => list(obligation.allowedCommandRefs).length > 0)
    .filter((obligation) => !list(obligation.allowedCommandRefs).some((commandRef) => commandRefs.has(String(commandRef))))
    .map((obligation) => obligation.obligationId);
  return missing.length > 0
    ? { status: 'blocked', reason: 'required-verification-command-missing', missing }
    : { status: 'ready', reason: 'required-verification-commands-visible' };
};

export const assessReviewReadiness = ({
  run = null,
  contract = run?.taskContract || null,
  modelInput = null,
  obligations = [],
  adapter = null,
  registry = null,
  controlPlane = null,
  verifications = [],
  receiptAttestationAvailable = null,
  reviewExecutionAvailable = null,
  reviewModelAvailable = null,
  reviewReadOnlyAvailable = null,
  reviewIndependentContextAvailable = null,
  workspaceBaseline = null,
  verificationCommands = null,
  permission = null,
  implementationOnly = false,
  env = process.env,
} = {}) => {
  const action = modelInput?.action || {};
  const reviewRequired = reviewRequiredForRun({ run, modelInput, obligations, verifications });
  const contractReady = isObject(contract)
    && (present(contract.objective) || list(contract.acceptance).length > 0 || list(contract.steps).length > 0);
  const baseline = baselineCheck({ run, workspaceBaseline });
  const verification = verificationCheck({ obligations, verificationCommands });
  const modelRoute = resolveReviewModelAndEffort({
    adapter,
    registry,
    riskTier: run?.proofTier || 'T3',
    env,
  });
  const executionAvailable = reviewExecutionAvailable === null || reviewExecutionAvailable === undefined
    ? Boolean(adapter?.nativeDelegationAvailable === true && typeof adapter?.dispatch === 'function')
    : reviewExecutionAvailable === true;
  const modelAvailable = reviewModelAvailable === null || reviewModelAvailable === undefined
    ? Boolean(present(modelRoute.model) && present(modelRoute.effort))
    : reviewModelAvailable === true;
  const readOnlyAvailable = reviewReadOnlyAvailable === null || reviewReadOnlyAvailable === undefined
    ? adapter?.capabilities?.supportsReadOnlyReview === true
    : reviewReadOnlyAvailable === true;
  const independentContextAvailable = reviewIndependentContextAvailable === null || reviewIndependentContextAvailable === undefined
    ? adapter?.capabilities?.supportsIndependentContext === true
    : reviewIndependentContextAvailable === true;
  const receiptAvailable = receiptAttestationAvailable === null || receiptAttestationAvailable === undefined
    ? Boolean(typeof controlPlane?.ingestReviewerOutcome === 'function')
    : receiptAttestationAvailable === true;
  const permissionReady = permission === null || permission === undefined
    ? true
    : permission === true
      || (isObject(permission) && permission.filesystem === 'read_only');

  const blockers = [];
  const degraded = [];
  if (!contractReady) blockers.push('contract-unavailable');
  if (baseline.status === 'blocked') blockers.push(`workspace-baseline:${baseline.reason}`);
  if (verification.status === 'blocked') blockers.push(`verification:${verification.reason}`);
  if (!permissionReady) blockers.push('review-permission-not-read-only');

  const review = {
    required: reviewRequired,
    reviewExecutionAvailable: reviewRequired ? executionAvailable : null,
    reviewReceiptAttestationAvailable: reviewRequired ? receiptAvailable : null,
    reviewModelAvailable: reviewRequired ? modelAvailable : null,
    reviewReadOnlyAvailable: reviewRequired ? readOnlyAvailable : null,
    reviewIndependentContextAvailable: reviewRequired ? independentContextAvailable : null,
    model: reviewRequired ? modelRoute.model : null,
    effort: reviewRequired ? modelRoute.effort : null,
    modelSource: reviewRequired ? modelRoute.source : null,
  };

  const completionBlockers = [];
  if (reviewRequired) {
    if (!executionAvailable) completionBlockers.push('review-execution-unavailable');
    if (!modelAvailable) completionBlockers.push('review-model-or-effort-unavailable');
    if (!readOnlyAvailable) completionBlockers.push('review-read-only-unavailable');
    if (!independentContextAvailable) completionBlockers.push('review-independent-context-unavailable');
    if (!receiptAvailable) degraded.push('review-receipt-attestation-unavailable');
  }

  const currentWorkIsReview = action.type === 'review';
  const status = blockers.length > 0 || (currentWorkIsReview && completionBlockers.length > 0)
    ? 'BLOCKED'
    : degraded.length > 0 || completionBlockers.length > 0
      ? 'DEGRADED'
      : 'READY';
  const canComplete = status === 'READY';
  const canExecuteCurrentWork = status !== 'BLOCKED' && (!currentWorkIsReview || completionBlockers.length === 0);
  const canStartMutation = canExecuteCurrentWork && (canComplete || implementationOnly === true);
  return Object.freeze({
    schemaVersion: REVIEW_READINESS_SCHEMA_VERSION,
    status,
    canStartMutation,
    canExecuteCurrentWork,
    canComplete,
    canCompleteGoal: canComplete,
    review,
    checks: {
      contract: { status: contractReady ? 'ready' : 'blocked', reason: contractReady ? 'contract-present' : 'contract-unavailable' },
      workspaceBaseline: baseline,
      verificationCommands: verification,
      permission: { status: permissionReady ? 'ready' : 'blocked', reason: permissionReady ? 'read-only-review-permission' : 'review-permission-not-read-only' },
    },
    blockers: Object.freeze([...new Set([...blockers, ...completionBlockers])]),
    executionBlockers: Object.freeze([...new Set(blockers)]),
    completionBlockers: Object.freeze([...new Set(completionBlockers)]),
    degraded: Object.freeze([...new Set(degraded)]),
    implementationOnly: implementationOnly === true,
    nextAction: status === 'READY'
      ? 'continue'
      : (status === 'DEGRADED' && implementationOnly === true && canExecuteCurrentWork)
        ? 'continue-with-degraded-review'
        : 'stop-before-mutation',
  });
};
