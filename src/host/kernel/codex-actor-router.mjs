// Codex-only actor routing. The Kernel supplies role and provider-neutral work
// shape; this module chooses the concrete Codex dispatch route and session
// policy without changing Kernel completion authority.

import { buildCodexMainSessionPolicy } from './codex-session-observer.mjs';

export const CODEX_ACTOR_ROLES = Object.freeze(['planner', 'implementer', 'debugger', 'reviewer']);

export const MUTATION_BEARING_ACTIONS = Object.freeze(['implement', 'fix', 'debug']);
export const READ_ONLY_ACTIONS = Object.freeze(['inspect', 'explain', 'read', 'question']);

export const isMutationBearingAction = (actionKind = null, actionType = null) => {
  const kind = String(actionKind || '').trim().toLowerCase();
  const type = String(actionType || '').trim().toLowerCase();
  return MUTATION_BEARING_ACTIONS.includes(kind) || MUTATION_BEARING_ACTIONS.includes(type);
};

export const isReadOnlyAction = (actionKind = null, actionType = null) => {
  const kind = String(actionKind || '').trim().toLowerCase();
  const type = String(actionType || '').trim().toLowerCase();
  return READ_ONLY_ACTIONS.includes(kind) || READ_ONLY_ACTIONS.includes(type);
};

export const isWorkUnitBounded = ({ stepId = null, allowedPaths = null, capsule = null, workUnit = null, modelInput = null } = {}) => {
  const effectiveStepId = stepId
    || capsule?.stepId
    || capsule?.workUnit?.stepId
    || workUnit?.stepId
    || modelInput?.action?.step?.stepId
    || modelInput?.step?.stepId
    || null;
  if (!effectiveStepId) return false;
  const paths = allowedPaths
    || capsule?.workUnit?.allowedPaths
    || workUnit?.allowedPaths
    || modelInput?.action?.step?.allowedPaths
    || null;
  if (!Array.isArray(paths) || paths.length === 0) return false;
  const validPaths = paths
    .map((p) => String(p || '').trim())
    .filter((s) => s.length > 0);
  if (validPaths.length === 0) return false;
  if (validPaths.some((s) => s === '*' || s === '**')) return false;
  return true;
};

// Native subagents are opt-in or automatically selected for mutation-bearing
// bounded work when a native launcher is available on a capable Host.
export const isNativeDelegationRequested = ({
  executionMode = null,
  delegationRequested = false,
  actionContext = null,
  executionContract = null,
  executionCapsule = null,
  decision = null,
  modelInput = null,
  capabilities = null,
  hasNativeLauncher = false,
} = {}) => {
  const context = actionContext && typeof actionContext === 'object' ? actionContext : {};
  const contract = executionContract && typeof executionContract === 'object' ? executionContract : {};

  // b) Explicit trivially bounded local mutation
  if (executionMode === 'owner-direct' || context.executionMode === 'owner-direct' || context.ownerDirect === true) {
    return false;
  }

  // Already explicitly requested
  if (
    executionMode === 'native-subagent'
    || delegationRequested === true
    || context.executionMode === 'native-subagent'
    || context.delegationRequested === true
    || contract.execution?.mode === 'native-subagent'
    || contract.delegationRequested === true
  ) {
    return true;
  }

  // Automatic selection:
  // When a Work Unit is mutation-bearing ('implement', 'fix', 'debug'),
  // an ExecutionCapsule exists, the Work Unit is bounded (stepId present, allowedPaths non-empty/bounded),
  // and native worker launcher is available on a capable Host.
  const actionKind = decision?.actionKind || context.actionKind || contract.actionKind || null;
  const actionType = modelInput?.action?.type || context.action?.type || null;
  if (!isMutationBearingAction(actionKind, actionType)) {
    return false;
  }

  const capsule = executionCapsule || context.executionCapsule || null;
  if (!capsule || typeof capsule !== 'object') {
    return false;
  }

  if (!isWorkUnitBounded({ capsule, modelInput, workUnit: capsule.workUnit })) {
    return false;
  }

  const capableHost = Boolean(
    capabilities?.supportsSubagentModel === true
    || capabilities?.nativeSubagent === true
    || capabilities?.supportsIndependentContext === true,
  );
  if (!hasNativeLauncher || !capableHost) {
    return false;
  }

  return true;
};

const repeatedFailure = (decision = {}) => decision.workProfile?.repeatedFailure === true
  || (decision.reasonCodes || []).some((code) => code === 'RETRY_ESCALATION' || code === 'PROTECTED_OBLIGATION_FAILURE' || code === 'ESCALATION_LOCKED');

export const resolveCodexActorRoute = ({
  decision = {},
  invocation = {},
  capabilities = {},
  hasNativeLauncher = false,
  delegationRequested = false,
  parentSessionId = null,
  parentSessionConfig = null,
  executionCapsule = null,
  executionContract = null,
  actionContext = null,
  modelInput = null,
} = {}) => {
  const role = decision.role === 'reviewer' ? 'reviewer'
    : decision.actionKind === 'debug' ? 'debugger'
      : decision.role === 'planner' ? 'planner'
        : 'implementer';
  const freshSessionRequired = decision.independentContextRequired === true
    || decision.workProfile?.independentContextRequired === true
    || role === 'reviewer'
    || repeatedFailure(decision)
    || invocation.freshSessionRequired === true;
  const independentReviewRequired = role === 'reviewer' && decision.independentContextRequired === true;
  const nativeAvailable = Boolean(hasNativeLauncher && (capabilities.supportsSubagentModel === true || capabilities.nativeSubagent === true));
  const isolatedSessionAvailable = capabilities.supportsIndependentContext === true;
  const effectiveDelegationRequested = delegationRequested || isNativeDelegationRequested({
    delegationRequested,
    actionContext,
    executionContract,
    executionCapsule,
    decision,
    modelInput,
    capabilities,
    hasNativeLauncher,
  });
  const dispatchMechanism = effectiveDelegationRequested && nativeAvailable
    ? 'native-subagent'
    : independentReviewRequired
      ? (isolatedSessionAvailable ? 'independent-review' : 'review-pending')
      : 'owner-direct';
  const executionMode = dispatchMechanism;
  const parentSessionPolicy = buildCodexMainSessionPolicy({
    parentSessionId,
    observed: parentSessionConfig,
  });
  const isExplicitOwnerDirect = actionContext?.executionMode === 'owner-direct' || actionContext?.ownerDirect === true;
  const isReadOnly = isReadOnlyAction(decision.actionKind, modelInput?.action?.type);
  const ownerDirectAllowed = !independentReviewRequired && (isReadOnly || isExplicitOwnerDirect || !nativeAvailable);

  return Object.freeze({
    role,
    requestedModel: invocation.model || null,
    requestedEffort: invocation.effort || null,
    dispatchMechanism,
    sessionPolicy: freshSessionRequired ? 'fresh' : 'reusable',
    freshSessionRequired,
    fallbackAllowed: false,
    ownerDirectAllowed,
    executionMode,
    delegation: Object.freeze({
      mode: independentReviewRequired ? 'required' : 'optional',
      available: nativeAvailable,
      requested: effectiveDelegationRequested,
    }),
    execution: Object.freeze({
      role,
      mode: executionMode,
      delegation: independentReviewRequired ? 'required' : 'optional',
    }),
    parentSessionPolicy,
  });
};
