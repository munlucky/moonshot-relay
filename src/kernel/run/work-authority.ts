import type { KernelWorkAuthority } from '../../contracts/generated/kernel.work-authority.js';
import { parseKernelContract } from '../../contracts/schema-codec.js';
import type { ExecutionClass } from '../../contracts/execution-class.js';
import { executionClassForAction, normalizeExecutionClass } from '../../contracts/execution-class.js';
import type { RunStep } from './run-step-ledger.js';
import { currentStep as selectCurrentStep } from './run-step-ledger.js';

export const WORK_AUTHORITY_SCHEMA_VERSION = 1;

const FORBIDDEN_WORK_FIELDS = new Set([
  'provider', 'providerModel', 'model', 'modelClass', 'resolvedModel',
  'requestedModel', 'effort', 'resolvedEffort', 'requestedEffort',
  'sessionId', 'nativeSessionId', 'worktreeRoot', 'gitState', 'cacheKey',
  'promptCache', 'providerState', 'optimizationState', 'progressState',
]);

export interface WorkRun {
  runId: string;
  projectId?: string | null;
  objective?: string | null;
  status?: string | null;
  state?: string | null;
  currentState?: string | null;
  finalizationStatus?: string | null;
  planRevision?: number | null;
  mutationRevision?: number | null;
  contractRevision?: number | null;
  acceptanceCriteria?: unknown[];
  taskContract?: {
    taskClass?: unknown;
    acceptance?: unknown[];
    [key: string]: unknown;
  } | null;
  [key: string]: unknown;
}

interface RouteDecisionLike {
  executionClass?: unknown;
}

export interface BuildWorkAuthorityInput {
  run?: WorkRun | null;
  steps?: RunStep[];
  step?: RunStep | null;
  routeDecision?: RouteDecisionLike | null;
  actionKind?: unknown;
}

export type WorkAuthorityView = KernelWorkAuthority;

const list = (value: unknown): string[] => (Array.isArray(value) ? value : []).map(String);

const workUnitView = (step: RunStep | null | undefined) => (step
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

const executionClassFor = ({
  routeDecision = null,
  actionKind = null,
}: { routeDecision?: RouteDecisionLike | null; actionKind?: unknown } = {}): ExecutionClass | null => {
  const supplied = routeDecision?.executionClass;
  if (supplied !== null && supplied !== undefined) {
    try { return normalizeExecutionClass(supplied); } catch { return null; }
  }
  if (!actionKind) return null;
  try { return executionClassForAction(actionKind); } catch { return null; }
};

const assertProviderFree = (value: unknown, currentPath = '$'): void => {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertProviderFree(entry, `${currentPath}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_WORK_FIELDS.has(key)) {
      throw new Error(`work_authority_forbidden_field: ${currentPath}.${key}`);
    }
    assertProviderFree(child, `${currentPath}.${key}`);
  }
};

export const validateWorkAuthority = (view: unknown): WorkAuthorityView => {
  if (!view || typeof view !== 'object' || Array.isArray(view)) {
    throw new TypeError('work authority view must be an object');
  }
  const candidate = view as Partial<WorkAuthorityView>;
  if (candidate.schemaVersion !== WORK_AUTHORITY_SCHEMA_VERSION) throw new Error('work_authority_schema_invalid');
  if (!candidate.task?.runId || !candidate.run?.runId) throw new Error('work_authority_identity_missing');
  if (candidate.task.runId !== candidate.run.runId) throw new Error('work_authority_identity_mismatch');
  assertProviderFree(candidate);
  return parseKernelContract('kernel.work-authority', candidate);
};

export const buildWorkAuthorityView = ({
  run = null,
  steps = [],
  step = null,
  routeDecision = null,
  actionKind = null,
}: BuildWorkAuthorityInput = {}): WorkAuthorityView | null => {
  if (!run) return null;
  const planRevision = Number(run.planRevision || 1);
  const currentPlanSteps = steps.filter((candidate) => Number(candidate.planRevision || 1) === planRevision);
  const current = step || selectCurrentStep(steps, { planRevision });
  const currentView = workUnitView(current);

  const completedHistory = steps
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

  const totalAcceptanceCount = Array.isArray(run.acceptanceCriteria)
    ? run.acceptanceCriteria.length
    : (run.taskContract?.acceptance?.length || 0);
  const completedAcceptanceIds = new Set(
    steps
      .filter((candidate) => candidate.state === 'passed')
      .flatMap((candidate) => Array.isArray(candidate.acceptanceIds) ? candidate.acceptanceIds : []),
  );
  const isGoalComplete = run.status === 'completed' && (run.finalizationStatus || 'completed') === 'completed';
  const goalStatus: WorkAuthorityView['goalStatus'] = isGoalComplete
    ? 'complete'
    : run.status === 'blocked'
      ? 'blocked'
      : 'active';
  const workUnitStatus: WorkAuthorityView['workUnitStatus'] = currentView?.state === 'passed'
    ? 'complete'
    : currentView?.state === 'failed' || currentView?.state === 'blocked'
      ? 'blocked'
      : 'active';

  const view: WorkAuthorityView = {
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
