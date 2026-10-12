import { requiredIndex } from '../../shared/required-index.js';
// Step planning (K2 §7.3). The ledger is not forced on every task: an ordinary
// change is one synthetic step, so the loop the model sees does not change. Only
// long or complex work is decomposed, and even then the decomposition comes from
// the contract and the route — never from a free-form plan the model narrated.

import { normalizeWorkUnitAllowedPaths } from '../../contracts/work-unit-scope.js';
import {
  deriveVerificationSettlementScope,
  type VerificationObligationLike,
} from '../../contracts/verification-settlement.js';

export interface PlannedRunLike {
  runId: string;
  objective?: unknown;
}

export interface DeclaredWorkStep {
  stepId?: unknown;
  objective?: unknown;
  dependsOn?: unknown;
  allowedPaths?: unknown;
  forbiddenPaths?: unknown;
  acceptanceIds?: unknown;
  obligationIds?: unknown;
  role?: unknown;
  expectedOutputs?: unknown;
}

export interface WorkPlanContract {
  objective?: unknown;
  steps?: unknown;
  allowedPaths?: unknown;
  forbiddenPaths?: unknown;
  acceptance?: unknown;
  [key: string]: unknown;
}

export interface PlanningObligation extends VerificationObligationLike {
  obligationId?: unknown;
  acceptanceIds?: unknown;
  [key: string]: unknown;
}

export interface PlannedWorkStep {
  [key: string]: unknown;
  stepId: string;
  sequence: number;
  objective: string;
  state: 'planned' | 'ready';
  planRevision: number;
  dependencyIds: string[];
  allowedPaths: string[];
  forbiddenPaths: string[];
  acceptanceIds: string[];
  obligationIds: string[];
  assignedRole: string;
  expectedOutputs: string[];
  synthetic?: true;
}

export interface StepLedgerDecision {
  applies: boolean;
  signals: {
    declaredDecomposition: boolean;
  };
}

export interface PlanRunStepsInput {
  run: PlannedRunLike;
  contract?: WorkPlanContract;
  obligations?: PlanningObligation[];
  route?: Record<string, unknown>;
  planRevision?: number;
}

export interface PlanRunStepsResult extends StepLedgerDecision {
  steps: PlannedWorkStep[];
}

export interface PlanReplacementStepsInput {
  run: PlannedRunLike;
  contract?: WorkPlanContract;
  obligations?: PlanningObligation[];
  planRevision: number;
  deltaSteps?: DeclaredWorkStep[];
  reservedStepIds?: string[];
}

const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const strings = (value: unknown): string[] => list(value).map(String);
const acceptanceEntries = (contract: WorkPlanContract): Array<{ id?: unknown }> => (
  list(contract.acceptance).filter((entry): entry is { id?: unknown } => Boolean(entry) && typeof entry === 'object')
);
const declaredSteps = (contract: WorkPlanContract): DeclaredWorkStep[] => (
  list(contract.steps).filter((entry): entry is DeclaredWorkStep => Boolean(entry) && typeof entry === 'object')
);

export const stepLedgerApplies = ({
  contract = {},
}: { contract?: WorkPlanContract } = {}): StepLedgerDecision => {
  const signals = {
    declaredDecomposition: declaredSteps(contract).length > 0,
  };
  return { applies: signals.declaredDecomposition, signals };
};

const stepId = (_runId: string, sequence: number, planRevision: number): string => (
  `step-${planRevision}-${sequence}`
);

const normalizeDeclaredStep = ({
  declared,
  index,
  runId,
  planRevision,
  contract,
  previousStepId = null,
}: {
  declared: DeclaredWorkStep;
  index: number;
  runId: string;
  planRevision: number;
  contract: WorkPlanContract;
  previousStepId?: string | null;
}): PlannedWorkStep => ({
  stepId: declared.stepId ? String(declared.stepId) : stepId(runId, index + 1, planRevision),
  sequence: index + 1,
  objective: String(declared.objective || contract.objective || ''),
  state: 'planned',
  planRevision,
  dependencyIds: Array.isArray(declared.dependsOn)
    ? declared.dependsOn.map(String)
    : previousStepId ? [previousStepId] : [],
  allowedPaths: Array.isArray(declared.allowedPaths)
    ? normalizeWorkUnitAllowedPaths(declared.allowedPaths)
    : normalizeWorkUnitAllowedPaths(contract.allowedPaths),
  forbiddenPaths: Array.isArray(declared.forbiddenPaths)
    ? declared.forbiddenPaths.map(String)
    : strings(contract.forbiddenPaths),
  acceptanceIds: strings(declared.acceptanceIds),
  obligationIds: strings(declared.obligationIds),
  assignedRole: String(declared.role || 'implementer'),
  expectedOutputs: strings(declared.expectedOutputs),
});

const settleGoalBindingsOnFinalStep = ({
  steps = [],
  obligations = [],
  contract = {},
}: {
  steps?: PlannedWorkStep[];
  obligations?: PlanningObligation[];
  contract?: WorkPlanContract;
} = {}): PlannedWorkStep[] => {
  if (steps.length <= 1) return steps;

  const finalPhaseObligationIds = new Set(obligations
    .filter((obligation) => ['integration', 'goal'].includes(deriveVerificationSettlementScope(obligation)))
    .map((obligation) => String(obligation.obligationId)));

  const acceptanceBindings = new Map(acceptanceEntries(contract).map((acceptance) => [
    String(acceptance.id),
    obligations.filter((obligation) => (
      Array.isArray(obligation.acceptanceIds)
      && obligation.acceptanceIds.some((id) => String(id) === String(acceptance.id))
    )),
  ]));

  const final = requiredIndex(steps, steps.length - 1);
  for (const step of steps.slice(0, -1)) {
    const deferredAcceptance = step.acceptanceIds.filter((acceptanceId) => {
      const bound = acceptanceBindings.get(String(acceptanceId)) || [];
      return bound.length > 0
        && bound.every((obligation) => ['integration', 'goal'].includes(deriveVerificationSettlementScope(obligation)));
    });

    if (deferredAcceptance.length > 0) {
      const deferred = new Set(deferredAcceptance.map(String));
      step.acceptanceIds = step.acceptanceIds.filter((id) => !deferred.has(String(id)));
      final.acceptanceIds = [...new Set([...final.acceptanceIds, ...deferredAcceptance])];
    }

    const deferredObligations = step.obligationIds
      .filter((obligationId) => finalPhaseObligationIds.has(String(obligationId)));
    if (deferredObligations.length > 0) {
      const deferred = new Set(deferredObligations.map(String));
      step.obligationIds = step.obligationIds.filter((id) => !deferred.has(String(id)));
      final.obligationIds = [...new Set([...final.obligationIds, ...deferredObligations])];
    }
  }

  return steps;
};

const normalizeDeclaredSteps = ({
  declared = [],
  runId,
  planRevision,
  contract,
  reservedStepIds = [],
}: {
  declared?: DeclaredWorkStep[];
  runId: string;
  planRevision: number;
  contract: WorkPlanContract;
  reservedStepIds?: string[];
}): PlannedWorkStep[] => {
  const taken = new Set(reservedStepIds);
  const idMap = new Map<string, string>();
  const steps: PlannedWorkStep[] = [];

  for (const [index, entry] of declared.entries()) {
    const originalId = entry.stepId ? String(entry.stepId) : stepId(runId, index + 1, planRevision);
    const step = normalizeDeclaredStep({
      declared: entry,
      index,
      runId,
      planRevision,
      contract,
      previousStepId: steps.length > 0 ? requiredIndex(steps, steps.length - 1).stepId : null,
    });

    if (taken.has(step.stepId)) {
      let candidate = `${step.stepId}@r${planRevision}`;
      let attempt = 1;
      while (taken.has(candidate)) {
        candidate = `${step.stepId}@r${planRevision}-${attempt}`;
        attempt += 1;
      }
      step.stepId = candidate;
    }

    taken.add(step.stepId);
    idMap.set(originalId, step.stepId);
    steps.push(step);
  }

  return steps.map((step, index) => {
    if (Array.isArray(declared[index]?.dependsOn)) {
      return {
        ...step,
        dependencyIds: declared[index].dependsOn!.map((id) => idMap.get(String(id)) || String(id)),
      };
    }
    if (index === 0) return step;
    return { ...step, dependencyIds: [requiredIndex(steps, index - 1).stepId] };
  });
};

export const buildSyntheticStep = ({
  run,
  contract = {},
  obligations = [],
  planRevision = 1,
}: {
  run: PlannedRunLike;
  contract?: WorkPlanContract;
  obligations?: PlanningObligation[];
  planRevision?: number;
}): PlannedWorkStep => ({
  stepId: stepId(run.runId, 1, planRevision),
  sequence: 1,
  objective: String(run.objective || ''),
  state: 'ready',
  planRevision,
  dependencyIds: [],
  allowedPaths: normalizeWorkUnitAllowedPaths(contract.allowedPaths),
  forbiddenPaths: strings(contract.forbiddenPaths),
  acceptanceIds: acceptanceEntries(contract).map((item) => String(item.id)),
  obligationIds: obligations.map((obligation) => String(obligation.obligationId)),
  assignedRole: 'implementer',
  expectedOutputs: [],
  synthetic: true,
});

export const planRunSteps = ({
  run,
  contract = {},
  obligations = [],
  route: _route = {},
  planRevision = 1,
}: PlanRunStepsInput): PlanRunStepsResult => {
  const decision = stepLedgerApplies({ contract });
  const declared = declaredSteps(contract);

  if (!decision.applies || declared.length === 0) {
    return {
      applies: decision.applies,
      signals: decision.signals,
      steps: [buildSyntheticStep({ run, contract, obligations, planRevision })],
    };
  }

  const steps = settleGoalBindingsOnFinalStep({
    steps: normalizeDeclaredSteps({ declared, runId: run.runId, planRevision, contract }),
    obligations,
    contract,
  });

  const claimedObligations = new Set(steps.flatMap((step) => step.obligationIds));
  const claimedAcceptance = new Set(steps.flatMap((step) => step.acceptanceIds));
  const last = requiredIndex(steps, steps.length - 1);

  last.obligationIds = [...new Set([
    ...last.obligationIds,
    ...obligations
      .map((obligation) => String(obligation.obligationId))
      .filter((id) => !claimedObligations.has(id)),
  ])];

  last.acceptanceIds = [...new Set([
    ...last.acceptanceIds,
    ...acceptanceEntries(contract)
      .map((item) => String(item.id))
      .filter((id) => !claimedAcceptance.has(id)),
  ])];

  for (const step of steps) {
    if (step.dependencyIds.length === 0) step.state = 'ready';
  }

  return { applies: true, signals: decision.signals, steps };
};

export const planReplacementSteps = ({
  run,
  contract = {},
  obligations = [],
  planRevision,
  deltaSteps = [],
  reservedStepIds = [],
}: PlanReplacementStepsInput): PlannedWorkStep[] => {
  if (!Array.isArray(deltaSteps) || deltaSteps.length === 0) {
    return [buildSyntheticStep({ run, contract, obligations, planRevision })];
  }

  return settleGoalBindingsOnFinalStep({
    steps: normalizeDeclaredSteps({
      declared: deltaSteps,
      runId: run.runId,
      planRevision,
      contract,
      reservedStepIds,
    }),
    obligations,
    contract,
  }).map((step) => (
    step.dependencyIds.length === 0 ? { ...step, state: 'ready' as const } : step
  ));
};
