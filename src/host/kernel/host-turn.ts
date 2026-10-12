import {
  buildExecutionAssignmentId,
  normalizeHostCapabilities,
  resolveEnforcementStrategy,
  type HostCapabilities,
  type WorkProfile,
} from '../../contracts/model-execution.js';
import {
  buildHostExecutionContract,
  type HostWorkUnitInput,
} from '../../contracts/host-execution-contract.js';
import type { NormalizedModelRouteDecision } from '../../contracts/model-route.js';
import {
  assertImplementationWorkUnitScope,
  workUnitScopeFailure,
  type WorkScopeContract,
  type WorkScopeStep,
} from '../../contracts/work-unit-scope.js';
import {
  actionKindForModelAction,
  createHostRoutingBridge,
} from './host-routing.js';

type UnknownRecord = Record<string, unknown>;

interface ModelActionLike extends UnknownRecord {
  type?: (string) | undefined;
  commandRefs?: string[];
  guidance?: string | null;
  outstandingObligations?: unknown[];
  mode?: string;
  execution?: {
    executionMode?: unknown;
    [key: string]: unknown;
  } | null;
  capsuleId?: string | null;
  step?: HostWorkUnitInput | null;
}

interface ModelInputLike extends UnknownRecord {
  status?: string;
  errorCode?: string | null;
  failureCode?: string;
  errorSummary?: string | null;
  nextAction?: string | null;
  workUnitScope?: unknown;
  action?: ModelActionLike | null;
}

interface RunLike extends UnknownRecord {
  taskContract?: (WorkScopeContract & UnknownRecord) | null;
  workspaceId?: string | null;
  planRevision?: unknown;
  mutationRevision?: unknown;
  currentWorkspaceIdentity?: unknown;
  proofTier?: unknown;
  replanCount?: unknown;
}

interface StepLike extends WorkScopeStep, UnknownRecord {
  stepId: string;
}

interface CapsuleProvenanceLike extends UnknownRecord {
  capsuleDigest?: unknown;
  workspaceIdentity?: string | null;
}

type CapsuleLike = Awaited<ReturnType<KernelControlPlanePort['buildCapsule']>>;

interface AttemptLike extends UnknownRecord {
  attemptId: string;
  stepId?: unknown;
  bindingId?: unknown;
  provenanceKind?: unknown;
}

type MutationLockLike = NonNullable<NonNullable<ReturnType<KernelControlPlanePort['acquireWorkUnitMutationLock']>>['lock']>;

interface MutationLockResult {
  acquired?: boolean;
  lock?: MutationLockLike | null;
}

interface RoutingSnapshot {
  run: UnknownRecord;
  stepAttempts?: UnknownRecord[];
  verificationHistory?: UnknownRecord[];
  routeDecisions?: UnknownRecord[];
}

interface StagnationResult extends UnknownRecord {
  stagnant: boolean;
  signals?: UnknownRecord;
}

type KernelControlPlanePort = Awaited<ReturnType<typeof import('./control-plane-runtime.js').createKernelControlPlane>>;

interface HostTurnCapabilitiesInput extends UnknownRecord {
  nativeSubagent?: unknown;
  supportsSubagentModel?: unknown;
}

interface HostTurnActionContext extends UnknownRecord {
  stepId?: string | null;
  baselineTimeoutMs?: number;
  actionKind?: unknown;
  workspaceId?: string | null;
  mutationLockTtlMs?: number;
  obligationId?: unknown;
  independentReviewRequired?: boolean;
  planInvalid?: boolean;
  architectureDeviation?: boolean;
  protectedObligationFailed?: boolean;
  workProfile?: WorkProfile | null;
  complexity?: unknown;
  changedPaths?: string[];
  workspaceIdentity?: (string | null) | undefined;
  attemptId?: string | null;
  executionMode?: unknown;
  delegationRequested?: boolean;
}

interface PrepareHostTurnInput {
  controlPlane?: KernelControlPlanePort | null;
  runId?: string;
  hostCapabilities?: HostTurnCapabilitiesInput;
  actionContext?: HostTurnActionContext;
  modelInput?: ModelInputLike | null;
}

const readModelInput = (value: unknown): ModelInputLike => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('kernel_model_input_required');
  const record = value as UnknownRecord;
  for (const key of ['status', 'errorCode', 'failureCode', 'errorSummary', 'nextAction']) {
    if (record[key] != null && typeof record[key] !== 'string') throw new TypeError('kernel_model_input_invalid: '+key);
  }
  if (record.action != null) {
    if (typeof record.action !== 'object' || Array.isArray(record.action)) throw new TypeError('kernel_model_action_invalid');
    const action = record.action as UnknownRecord;
    if (action.type != null && typeof action.type !== 'string') throw new TypeError('kernel_model_action_type_invalid');
    if (action.commandRefs != null && (!Array.isArray(action.commandRefs) || !action.commandRefs.every(v => typeof v === 'string'))) throw new TypeError('kernel_model_command_refs_invalid');
  }
  return record as ModelInputLike;
};

const buildScopeRejection = ({
  runId,
  modelInput,
  capabilities,
  error,
}: {
  runId: string;
  modelInput: ModelInputLike;
  capabilities: Readonly<HostCapabilities>;
  error: unknown;
}) => {
  const failure = workUnitScopeFailure(error);
  const workUnitScope = {
    valid: false,
    reason: failure.scopeReason,
    errorCode: failure.errorCode,
    allowedPaths: failure.allowedPaths,
    ...(failure.workspaceWide.length > 0
      ? { workspaceWide: failure.workspaceWide }
      : {}),
  };
  const action = modelInput.action
    ? {
        ...modelInput.action,
        workUnitScope,
        guidance: (
          failure.errorSummary
          + ' '
          + (modelInput.action.guidance || '')
        ).trim(),
      }
    : null;
  const decision = {
    runId,
    actionKind: 'work-unit-scope-guard',
    role: 'implementer',
    executionClass: null,
    permissions: 'workspace_write',
    decisionId: 'route-' + '0'.repeat(24),
    reasonCodes: [failure.errorCode],
  };
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
      modelRouteDecision: {
        schemaVersion: 1,
        ...decision,
        modelClass: 'kernel',
      },
      executionContract: buildHostExecutionContract({ decision }),
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

const routingFor = (controlPlane: KernelControlPlanePort) =>
  createHostRoutingBridge({
    controlPlane,
    detectStepStagnation: (runId: string) =>
      controlPlane.detectStepStagnation(runId),
  });

export const prepareHostTurn = async ({
  controlPlane,
  runId = '',
  hostCapabilities = {},
  actionContext = {},
  modelInput: preloadedModelInput = null,
}: PrepareHostTurnInput = {}) => {
  if (!controlPlane?.getRun) {
    throw new TypeError(
      'prepareHostTurn requires a Kernel control plane',
    );
  }
  const run = await controlPlane.getRun(runId);
  if (!run) {
    return { schemaVersion: 1, runId, status: 'not_found' };
  }
  const capabilities = normalizeHostCapabilities(hostCapabilities);
  let modelInput = preloadedModelInput || readModelInput(await controlPlane.next(
    runId,
    { stepId: actionContext.stepId || null },
  ));

  if (modelInput.action?.type === 'baseline-required') {
    await controlPlane.captureBaseline(runId, {
      commandRefs: modelInput.action.commandRefs,
      timeoutMs: actionContext.baselineTimeoutMs || 120000,
    });
    modelInput = readModelInput(await controlPlane.next(
      runId,
      { stepId: actionContext.stepId || null },
    ));
  }
  if (modelInput.status === 'contract-rejected') return modelInput;

  const reviewerTurn = String(
    actionContext.actionKind || '',
  ).startsWith('review');
  if (
    ['implement', 'fix'].includes(modelInput.action?.type || '')
    && !reviewerTurn
  ) {
    const capsuleStep = actionContext.stepId
      ? controlPlane.ensureRunStepsMigrated(runId).find(
          (entry) => entry.stepId === actionContext.stepId,
        ) || null
      : controlPlane.getCurrentStep(runId);
    try {
      assertImplementationWorkUnitScope({
        step: capsuleStep,
        contract: run.taskContract,
        actionType: modelInput.action?.type,
      });
    } catch (error: unknown) {
      return buildScopeRejection({
        runId,
        modelInput,
        capabilities,
        error,
      });
    }
  }

  let mutationLock: MutationLockLike | null = null;
  if (['implement', 'fix'].includes(modelInput.action?.type || '')) {
    const lockResult = controlPlane.acquireWorkUnitMutationLock(
      runId,
      {
        workspaceId: actionContext.workspaceId
          || run.workspaceId
          || null,
        ttlMs: actionContext.mutationLockTtlMs || 60000,
      },
    );
    if (!lockResult?.acquired) {
      modelInput.status = 'blocked';
      modelInput.errorCode = 'workspace_mutation_conflict';
      modelInput.nextAction = 'create-worktree';
      modelInput.action = {
        type: 'blocked',
        reason: 'workspace_mutation_conflict',
        guidance:
          'Workspace is held by '
          + (lockResult?.lock?.holderRunId || 'another run')
          + '.',
      };
    } else {
      mutationLock = lockResult.lock || null;
    }
  }

  const routing = routingFor(controlPlane);
  const decision = routing.decideModelRoute(runId, {
    actionKind:
      actionContext.actionKind
      || actionKindForModelAction(modelInput.action?.type),
    obligationId:
      actionContext.obligationId
      ?? modelInput.action?.outstandingObligations?.[0]
      ?? null,
    independentReviewRequired:
      actionContext.independentReviewRequired === true,
    planInvalid: actionContext.planInvalid === true,
    architectureDeviation:
      actionContext.architectureDeviation === true,
    protectedObligationFailed:
      actionContext.protectedObligationFailed === true,
    workProfile: actionContext.workProfile || null,
    complexity: actionContext.complexity || null,
  });

  let executionCapsule: CapsuleLike | null = null;
  if (decision.modelClass !== 'kernel') {
    const latestImplementationAttempt =
      decision.role === 'reviewer'
        ? controlPlane.getLatestImplementationAttempt(runId)
        : null;
    const capsuleStep = actionContext.stepId
      ? controlPlane.ensureRunStepsMigrated(runId).find(
          (entry) => entry.stepId === actionContext.stepId,
        ) || null
      : controlPlane.getCurrentStep(runId)
        || (
          latestImplementationAttempt?.stepId
            ? controlPlane.getRunSteps(runId).find(
                (entry) =>
                  entry.stepId
                  === String(latestImplementationAttempt.stepId),
              ) || null
            : null
        );
    executionCapsule = decision.role === 'reviewer'
      ? await controlPlane.buildReviewerCapsule(runId, {
          decision,
          stage:
            decision.actionKind === 'review_contract'
              ? 'contract'
              : 'engineering',
          obligationId: decision.obligationId,
          changedPaths: actionContext.changedPaths || [],
          step: capsuleStep,
        })
      : await controlPlane.buildCapsule(runId, {
          role: 'implementer',
          decision,
          step: capsuleStep,
          changedPaths: actionContext.changedPaths || [],
          workspaceIdentity:
            actionContext.workspaceIdentity || null,
        });
    if (modelInput.action) {
      modelInput.action.capsuleId = executionCapsule.capsuleId;
    }
  }

  let attempt = actionContext.attemptId
    ? controlPlane.getAttemptById(
        runId,
        actionContext.attemptId,
      )
    : null;
  if (
    !attempt
    && decision.modelClass !== 'kernel'
    && executionCapsule?.stepId
  ) {
    attempt = controlPlane.getActiveAttempt(runId, {
      stepId: executionCapsule.stepId,
      capsuleId: executionCapsule.capsuleId,
    });
  }
  if (
    decision.modelClass !== 'kernel'
    && executionCapsule?.stepId
  ) {
    if (attempt) {
      controlPlane.assertAttemptLineage(attempt, {
        runId,
        stepId: executionCapsule.stepId,
        planRevision: run.planRevision,
        mutationRevision: run.mutationRevision,
      });
      if (!attempt.attemptId) throw new Error('ATTEMPT_ID_REQUIRED');
      attempt = controlPlane.attachAttemptLineage(
        attempt.attemptId,
        {
          bindingId:
            attempt.bindingId
            || controlPlane.getRunOwnerBindingId(runId),
          capsuleId: executionCapsule.capsuleId,
          capsuleDigest:
            executionCapsule.provenance?.capsuleDigest || null,
          routeDecisionId: decision.decisionId,
          provenanceKind:
            attempt.provenanceKind === 'legacy-unattributed'
              ? 'routed'
              : attempt.provenanceKind,
          planRevision: run.planRevision,
          mutationRevision: run.mutationRevision,
        },
      );
    } else {
      attempt = controlPlane.beginAttempt(runId, {
        stepId: executionCapsule.stepId,
        bindingId: controlPlane.getRunOwnerBindingId(runId),
        capsuleId: executionCapsule.capsuleId,
        capsuleDigest:
          executionCapsule.provenance?.capsuleDigest || null,
        routeDecisionId: decision.decisionId,
        provenanceKind: 'routed',
        planRevision: run.planRevision,
        mutationRevision: run.mutationRevision,
        workspaceIdentityStart:
          executionCapsule.provenance?.workspaceIdentity
          || run.currentWorkspaceIdentity,
        workspaceId:
          actionContext.workspaceId
          || run.workspaceId
          || null,
        baseWorkspaceIdentity:
          actionContext.workspaceIdentity || null,
      });
    }
  }

  const independentReviewRequired =
    decision.role === 'reviewer'
    && decision.independentContextRequired === true;
  const ownerDirectAllowed = !independentReviewRequired;
  const hasSubagentCapability =
    hostCapabilities.nativeSubagent === true
    || hostCapabilities.supportsSubagentModel === true;
  const nativeDelegationRequested =
    actionContext.executionMode === 'native-subagent'
    || actionContext.delegationRequested === true
    || modelInput.action?.mode === 'subagent'
    || modelInput.action?.execution?.executionMode
      === 'native-subagent'
    || (
      independentReviewRequired
      && hasSubagentCapability
    );
  const executionAssignment =
    decision.modelClass === 'kernel'
      ? null
      : {
          ...(nativeDelegationRequested
            ? {
                assignmentId: buildExecutionAssignmentId(
                  decision.decisionId,
                ),
              }
            : {}),
          role: decision.role,
          workProfile: decision.workProfile,
          executionMode: nativeDelegationRequested
            ? 'native-subagent'
            : ownerDirectAllowed
              ? 'owner-direct'
              : 'independent-review',
          delegation: {
            mode: ownerDirectAllowed
              ? 'optional'
              : 'required',
            requested: nativeDelegationRequested,
          },
          freshSessionRequired:
            decision.independentContextRequired === true
            || decision.workProfile
              ?.independentContextRequired === true
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
      enforcementStrategy: resolveEnforcementStrategy(
        capabilities,
        { ...decision },
      ),
      executionCapsule,
      attemptId: attempt?.attemptId || null,
      attempt,
      mutationLock,
    },
  };
};
