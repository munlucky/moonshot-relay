// Codex-only actor routing. The Kernel supplies role and provider-neutral work
// shape; this module chooses the concrete Codex dispatch route and session
// policy without changing Kernel completion authority.

import { buildCodexMainSessionPolicy } from './codex-session-observer.js';

type UnknownRecord = Record<string, unknown>;

const asRecord = (value: unknown): UnknownRecord => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : {}
);

const nestedRecord = (record: UnknownRecord, key: string): UnknownRecord => asRecord(record[key]);

export const CODEX_ACTOR_ROLES = Object.freeze(['planner', 'implementer', 'debugger', 'reviewer']);

export const MUTATION_BEARING_ACTIONS = Object.freeze(['implement', 'fix', 'debug']);
export const READ_ONLY_ACTIONS = Object.freeze(['inspect', 'explain', 'read', 'question']);

export const isMutationBearingAction = (
  actionKind: unknown = null,
  actionType: unknown = null,
): boolean => {
  const kind = String(actionKind || '').trim().toLowerCase();
  const type = String(actionType || '').trim().toLowerCase();
  return MUTATION_BEARING_ACTIONS.includes(kind) || MUTATION_BEARING_ACTIONS.includes(type);
};

export const isReadOnlyAction = (
  actionKind: unknown = null,
  actionType: unknown = null,
): boolean => {
  const kind = String(actionKind || '').trim().toLowerCase();
  const type = String(actionType || '').trim().toLowerCase();
  return READ_ONLY_ACTIONS.includes(kind) || READ_ONLY_ACTIONS.includes(type);
};

export const isWorkUnitBounded = ({
  stepId = null,
  allowedPaths = null,
  capsule = null,
  workUnit = null,
  modelInput = null,
}: {
  stepId?: unknown;
  allowedPaths?: unknown;
  capsule?: unknown;
  workUnit?: unknown;
  modelInput?: unknown;
} = {}): boolean => {
  const capsuleRecord = asRecord(capsule);
  const capsuleWorkUnit = nestedRecord(capsuleRecord, 'workUnit');
  const workUnitRecord = asRecord(workUnit);
  const modelInputRecord = asRecord(modelInput);
  const actionStep = nestedRecord(nestedRecord(modelInputRecord, 'action'), 'step');
  const modelStep = nestedRecord(modelInputRecord, 'step');

  const effectiveStepId = stepId
    || capsuleRecord.stepId
    || capsuleWorkUnit.stepId
    || workUnitRecord.stepId
    || actionStep.stepId
    || modelStep.stepId
    || null;
  if (!effectiveStepId) return false;

  const paths = allowedPaths
    || capsuleWorkUnit.allowedPaths
    || workUnitRecord.allowedPaths
    || actionStep.allowedPaths
    || null;
  if (!Array.isArray(paths) || paths.length === 0) return false;
  const validPaths = paths
    .map((candidate: unknown) => String(candidate || '').trim())
    .filter((candidate: string) => candidate.length > 0);
  if (validPaths.length === 0) return false;
  if (validPaths.some((candidate: string) => candidate === '*' || candidate === '**')) return false;
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
}: {
  executionMode?: unknown;
  delegationRequested?: (boolean) | undefined;
  actionContext?: unknown;
  executionContract?: unknown;
  executionCapsule?: unknown;
  decision?: unknown;
  modelInput?: unknown;
  capabilities?: unknown;
  hasNativeLauncher?: boolean;
} = {}): boolean => {
  const context = asRecord(actionContext);
  const contract = asRecord(executionContract);
  const contractExecution = nestedRecord(contract, 'execution');

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
    || contractExecution.mode === 'native-subagent'
    || contract.delegationRequested === true
  ) {
    return true;
  }

  // Automatic selection:
  // When a Work Unit is mutation-bearing ('implement', 'fix', 'debug'),
  // an ExecutionCapsule exists, the Work Unit is bounded (stepId present, allowedPaths non-empty/bounded),
  // and native worker launcher is available on a capable Host.
  const decisionRecord = asRecord(decision);
  const modelRecord = asRecord(modelInput);
  const contextAction = nestedRecord(context, 'action');
  const modelAction = nestedRecord(modelRecord, 'action');
  const actionKind = decisionRecord.actionKind || context.actionKind || contract.actionKind || null;
  const actionType = modelAction.type || contextAction.type || null;
  if (!isMutationBearingAction(actionKind, actionType)) {
    return false;
  }

  const capsule = asRecord(executionCapsule || context.executionCapsule || null);
  if (Object.keys(capsule).length === 0) {
    return false;
  }

  if (!isWorkUnitBounded({
    capsule,
    modelInput,
    workUnit: capsule.workUnit,
  })) {
    return false;
  }

  const capabilityRecord = asRecord(capabilities);
  const capableHost = Boolean(
    capabilityRecord.supportsSubagentModel === true
    || capabilityRecord.nativeSubagent === true
    || capabilityRecord.supportsIndependentContext === true,
  );
  if (!hasNativeLauncher || !capableHost) {
    return false;
  }

  return true;
};

const repeatedFailure = (decision: unknown = {}): boolean => {
  const record = asRecord(decision);
  const workProfile = nestedRecord(record, 'workProfile');
  const reasonCodes = Array.isArray(record.reasonCodes) ? record.reasonCodes : [];
  return workProfile.repeatedFailure === true
    || reasonCodes.some((code: unknown) => (
      code === 'RETRY_ESCALATION'
      || code === 'PROTECTED_OBLIGATION_FAILURE'
      || code === 'ESCALATION_LOCKED'
    ));
};

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
}: {
  decision?: unknown;
  invocation?: unknown;
  capabilities?: unknown;
  hasNativeLauncher?: boolean;
  delegationRequested?: boolean;
  parentSessionId?: unknown;
  parentSessionConfig?: unknown;
  executionCapsule?: unknown;
  executionContract?: unknown;
  actionContext?: unknown;
  modelInput?: unknown;
} = {}) => {
  const decisionRecord = asRecord(decision);
  const invocationRecord = asRecord(invocation);
  const capabilityRecord = asRecord(capabilities);
  const workProfile = nestedRecord(decisionRecord, 'workProfile');
  const contextRecord = asRecord(actionContext);
  const modelRecord = asRecord(modelInput);
  const modelAction = nestedRecord(modelRecord, 'action');

  const role = decisionRecord.role === 'reviewer' ? 'reviewer'
    : decisionRecord.actionKind === 'debug' ? 'debugger'
      : decisionRecord.role === 'planner' ? 'planner'
        : 'implementer';
  const freshSessionRequired = decisionRecord.independentContextRequired === true
    || workProfile.independentContextRequired === true
    || role === 'reviewer'
    || repeatedFailure(decisionRecord)
    || invocationRecord.freshSessionRequired === true;
  const independentReviewRequired = role === 'reviewer'
    && decisionRecord.independentContextRequired === true;
  const nativeAvailable = Boolean(
    hasNativeLauncher
    && (
      capabilityRecord.supportsSubagentModel === true
      || capabilityRecord.nativeSubagent === true
    ),
  );
  const isolatedSessionAvailable = capabilityRecord.supportsIndependentContext === true;
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
    observed: parentSessionConfig ? asRecord(parentSessionConfig) : null,
  });
  const isExplicitOwnerDirect = contextRecord.executionMode === 'owner-direct'
    || contextRecord.ownerDirect === true;
  const isReadOnly = isReadOnlyAction(decisionRecord.actionKind, modelAction.type);
  const ownerDirectAllowed = !independentReviewRequired
    && (isReadOnly || isExplicitOwnerDirect || !nativeAvailable);

  return Object.freeze({
    role,
    requestedModel: invocationRecord.model || null,
    requestedEffort: invocationRecord.effort || null,
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
