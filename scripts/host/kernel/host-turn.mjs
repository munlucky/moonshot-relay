import {
  buildExecutionAssignmentId,
  normalizeHostCapabilities,
  resolveEnforcementStrategy,
} from '../../kernel/run/model-route-contract.mjs';
import { buildHostExecutionContract } from '../../kernel/run/host-execution-contract.mjs';
import {
  assertImplementationWorkUnitScope,
  workUnitScopeFailure,
} from '../../kernel/run/work-unit-scope.mjs';
import { actionKindForModelAction, createHostRoutingBridge } from './host-routing.mjs';

const buildScopeRejection = ({ runId, modelInput, capabilities, error }) => {
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
      guidance: (failure.errorSummary + ' ' + (modelInput.action.guidance || '')).trim(),
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

const routingFor = (controlPlane) => createHostRoutingBridge({
  store: controlPlane.stateStore,
  detectStepStagnation: (runId, options) => controlPlane.detectStepStagnation(runId, options),
});

export const prepareHostTurn = async ({
  controlPlane,
  runId,
  hostCapabilities = {},
  actionContext = {},
  modelInput: preloadedModelInput = null,
} = {}) => {
  if (!controlPlane?.stateStore) throw new TypeError('prepareHostTurn requires a Kernel control plane');
  const store = controlPlane.stateStore;
  const run = await controlPlane.getRun(runId);
  if (!run) return { schemaVersion: 1, runId, status: 'not_found' };
  const capabilities = normalizeHostCapabilities(hostCapabilities);
  let modelInput = preloadedModelInput || await controlPlane.next(runId, { stepId: actionContext.stepId || null });

  if (modelInput.action?.type === 'baseline-required') {
    await controlPlane.captureBaseline(runId, {
      commandRefs: modelInput.action.commandRefs,
      timeoutMs: actionContext.baselineTimeoutMs || 120000,
    });
    modelInput = await controlPlane.next(runId, { stepId: actionContext.stepId || null });
  }
  if (modelInput.status === 'contract-rejected') return modelInput;

  const reviewerTurn = String(actionContext.actionKind || '').startsWith('review');
  if (['implement', 'fix'].includes(modelInput.action?.type) && !reviewerTurn) {
    const capsuleStep = actionContext.stepId
      ? controlPlane.ensureRunStepsMigrated(runId).find((entry) => entry.stepId === actionContext.stepId)
      : controlPlane.getCurrentStep(runId);
    try {
      assertImplementationWorkUnitScope({
        step: capsuleStep,
        contract: run.taskContract,
        actionType: modelInput.action.type,
      });
    } catch (error) {
      return buildScopeRejection({ runId, modelInput, capabilities, error });
    }
  }

  let mutationLock = null;
  if (['implement', 'fix'].includes(modelInput.action?.type)) {
    const lockResult = controlPlane.acquireWorkUnitMutationLock(runId, {
      workspaceId: actionContext.workspaceId || run.workspaceId || null,
      ttlMs: actionContext.mutationLockTtlMs || 60000,
    });
    if (!lockResult?.acquired) {
      modelInput.status = 'blocked';
      modelInput.errorCode = 'workspace_mutation_conflict';
      modelInput.nextAction = 'create-worktree';
      modelInput.action = {
        type: 'blocked',
        reason: 'workspace_mutation_conflict',
        guidance: 'Workspace is held by ' + (lockResult?.lock?.holderRunId || 'another run') + '.',
      };
    } else {
      mutationLock = lockResult.lock;
    }
  }

  const routing = routingFor(controlPlane);
  const decision = routing.decideModelRoute(runId, {
    actionKind: actionContext.actionKind || actionKindForModelAction(modelInput.action?.type),
    obligationId: actionContext.obligationId ?? modelInput.action?.outstandingObligations?.[0] ?? null,
    independentReviewRequired: actionContext.independentReviewRequired === true,
    planInvalid: actionContext.planInvalid === true,
    architectureDeviation: actionContext.architectureDeviation === true,
    protectedObligationFailed: actionContext.protectedObligationFailed === true,
    workProfile: actionContext.workProfile || null,
    complexity: actionContext.complexity || null,
  });

  let executionCapsule = null;
  if (decision.modelClass !== 'kernel') {
    const latestImplementationAttempt = decision.role === 'reviewer'
      ? store.getLatestImplementationAttempt?.(runId)
      : null;
    const capsuleStep = actionContext.stepId
      ? controlPlane.ensureRunStepsMigrated(runId).find((entry) => entry.stepId === actionContext.stepId)
      : controlPlane.getCurrentStep(runId)
        || (latestImplementationAttempt?.stepId ? store.getRunStep(runId, latestImplementationAttempt.stepId) : null);
    executionCapsule = decision.role === 'reviewer'
      ? await controlPlane.buildReviewerCapsule(runId, {
        decision,
        stage: decision.actionKind === 'review_contract' ? 'contract' : 'engineering',
        obligationId: decision.obligationId,
        changedPaths: actionContext.changedPaths || [],
        step: capsuleStep,
      })
      : await controlPlane.buildCapsule(runId, {
        role: 'implementer',
        decision,
        step: capsuleStep,
        changedPaths: actionContext.changedPaths || [],
        workspaceIdentity: actionContext.workspaceIdentity || null,
      });
    if (modelInput.action) modelInput.action.capsuleId = executionCapsule.capsuleId;
  }

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
      controlPlane.assertAttemptLineage(attempt, {
        runId,
        stepId: executionCapsule.stepId,
        planRevision: run.planRevision,
        mutationRevision: run.mutationRevision,
      });
      attempt = controlPlane.attachAttemptLineage(attempt.attemptId, {
        bindingId: attempt.bindingId || store.getRunOwnerBinding?.(runId)?.bindingId || null,
        capsuleId: executionCapsule.capsuleId,
        capsuleDigest: executionCapsule.provenance?.capsuleDigest || null,
        routeDecisionId: decision.decisionId,
        provenanceKind: attempt.provenanceKind === 'legacy-unattributed' ? 'routed' : attempt.provenanceKind,
        planRevision: run.planRevision,
        mutationRevision: run.mutationRevision,
      });
    } else {
      attempt = controlPlane.beginAttempt(runId, {
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
};
