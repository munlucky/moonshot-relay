import { executionClassForAction, normalizeExecutionClass } from './execution-class.mjs';
import { currentStep as selectCurrentStep } from './run-step-ledger.mjs';

export const WORK_AUTHORITY_SCHEMA_VERSION = 1;

// Work Authority is a provider-free read model. These fields are deliberately
// rejected so a progress/cursor projection cannot become a second Host or
// optimization state store by accident.
const FORBIDDEN_WORK_FIELDS = new Set([
  'provider', 'providerModel', 'model', 'modelClass', 'resolvedModel',
  'requestedModel', 'effort', 'resolvedEffort', 'requestedEffort',
  'sessionId', 'nativeSessionId', 'worktreeRoot', 'gitState', 'cacheKey',
  'promptCache', 'providerState', 'optimizationState', 'progressState',
]);

const list = (value) => (Array.isArray(value) ? value : []).map(String);

const workUnitView = (step) => (step
  ? {
    stepId: String(step.stepId),
    sequence: Number(step.sequence || 0),
    planRevision: Number(step.planRevision || 1),
    objective: String(step.objective || ''),
    state: String(step.state || 'planned'),
    synthetic: step.synthetic === true,
    acceptanceIds: list(step.acceptanceIds),
    obligationIds: list(step.obligationIds),
    allowedPaths: list(step.allowedPaths),
    forbiddenPaths: list(step.forbiddenPaths),
  }
  : null);

const executionClassFor = ({ routeDecision = null, actionKind = null } = {}) => {
  const supplied = routeDecision?.executionClass;
  if (supplied !== null && supplied !== undefined) {
    try { return normalizeExecutionClass(supplied); } catch { return null; }
  }
  if (!actionKind) return null;
  try { return executionClassForAction(actionKind); } catch { return null; }
};

const assertProviderFree = (value, path = '$') => {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertProviderFree(entry, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_WORK_FIELDS.has(key)) throw new Error(`work_authority_forbidden_field: ${path}.${key}`);
    assertProviderFree(child, `${path}.${key}`);
  }
};

export const validateWorkAuthority = (view) => {
  if (!view || typeof view !== 'object' || Array.isArray(view)) throw new TypeError('work authority view must be an object');
  if (view.schemaVersion !== WORK_AUTHORITY_SCHEMA_VERSION) throw new Error('work_authority_schema_invalid');
  if (!view.task?.runId || !view.run?.runId) throw new Error('work_authority_identity_missing');
  if (view.task.runId !== view.run.runId) throw new Error('work_authority_identity_mismatch');
  assertProviderFree(view);
  return view;
};

export const buildWorkAuthorityView = ({
  run = null,
  steps = [],
  step = null,
  routeDecision = null,
  actionKind = null,
} = {}) => {
  if (!run) return null;
  const planRevision = Number(run.planRevision || 1);
  const currentPlanSteps = (Array.isArray(steps) ? steps : [])
    .filter((candidate) => Number(candidate.planRevision || 1) === planRevision);
  const current = step || selectCurrentStep(steps, { planRevision });
  const currentView = workUnitView(current);
  // Work completion is monotonic across replans. A later plan may require new
  // evidence or replacement work, but it must not erase the fact that a
  // previous Work Unit completed. Trust Authority independently decides
  // whether that work's evidence is still fresh for Goal completion.
  const completedHistory = (Array.isArray(steps) ? steps : [])
    .filter((candidate) => candidate.state === 'passed')
    .map((candidate) => String(candidate.stepId));
  const completedCurrentPlan = currentPlanSteps
    .filter((candidate) => candidate.state === 'passed')
    .map((candidate) => String(candidate.stepId));
  const completed = [...new Set(completedHistory)];
  const remaining = currentPlanSteps
    .filter((candidate) => candidate.state !== 'passed')
    .map((candidate) => String(candidate.stepId));
  const cursor = {
    planRevision,
    currentStepId: currentView?.stepId || null,
    currentSequence: currentView?.sequence || null,
    stepCount: currentPlanSteps.length,
  };
  const totalAcceptanceCount = Array.isArray(run.acceptanceCriteria) ? run.acceptanceCriteria.length : (run.taskContract?.acceptance?.length || 0);
  const completedAcceptanceIds = new Set(
    (Array.isArray(steps) ? steps : [])
      .filter((s) => s.state === 'passed')
      .flatMap((s) => (Array.isArray(s.acceptanceIds) ? s.acceptanceIds : [])),
  );
  const isGoalComplete = run.status === 'completed' && (run.finalizationStatus || 'completed') === 'completed';
  const goalStatus = isGoalComplete ? 'complete' : run.status === 'blocked' ? 'blocked' : 'active';
  const workUnitStatus = currentView?.state === 'passed' ? 'complete'
    : (currentView?.state === 'failed' || currentView?.state === 'blocked') ? 'blocked'
    : 'active';

  const view = {
    schemaVersion: WORK_AUTHORITY_SCHEMA_VERSION,
    task: {
      runId: String(run.runId),
      objective: String(run.objective || ''),
      taskClass: String(run.taskContract?.taskClass || 'feature'),
      contractRevision: Number(run.contractRevision || 1),
      acceptanceCriteria: list(run.acceptanceCriteria),
    },
    run: {
      runId: String(run.runId),
      projectId: run.projectId ? String(run.projectId) : null,
      status: String(run.status || 'active'),
      state: String(run.state || run.currentState || ''),
      planRevision,
      mutationRevision: Number(run.mutationRevision || 0),
    },
    workUnitStatus,
    goalStatus,
    goal: {
      status: goalStatus,
      objective: String(run.objective || ''),
      coverage: {
        completedAcceptanceCount: completedAcceptanceIds.size,
        totalAcceptanceCount,
        summary: `${completedAcceptanceIds.size} / ${totalAcceptanceCount} acceptance complete`,
      },
    },
    currentWorkUnit: currentView,
    progress: {
      completedWorkUnitIds: completed,
      completedCurrentPlanWorkUnitIds: completedCurrentPlan,
      remainingWorkUnitIds: remaining,
      completedCount: completed.length,
      completedCurrentPlanCount: completedCurrentPlan.length,
      remainingCount: remaining.length,
    },
    cursor,
    executionClass: executionClassFor({ routeDecision, actionKind }),
    resume: {
      status: String(run.status || 'active'),
      action: run.status === 'completed'
        ? 'none'
        : currentView?.state === 'running' || currentView?.state === 'reported' || currentView?.state === 'verifying'
          ? 'continue-current-work-unit'
          : currentView
            ? 'continue-work'
            : 'rebuild-work-cursor',
      stepId: currentView?.stepId || null,
    },
  };
  return validateWorkAuthority(view);
};
