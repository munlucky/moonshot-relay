// Step planning (K2 §7.3). The ledger is not forced on every task: an ordinary
// change is one synthetic step, so the loop the model sees does not change. Only
// long or complex work is decomposed, and even then the decomposition comes from
// the contract and the route — never from a free-form plan the model narrated.

import { normalizeWorkUnitAllowedPaths } from './work-unit-scope.mjs';
import { deriveVerificationSettlementScope } from './obligation-compiler.mjs';

const FILES_CHANGED_THRESHOLD = 8;

export const stepLedgerApplies = ({ contract = {}, route = {}, filesChanged = 0 } = {}) => {
  const signals = {
    longRunning: contract.taskClass === 'long-running',
    complex: contract.flags?.complex === true,
    manyFiles: Number(filesChanged || contract.filesChanged || 0) > FILES_CHANGED_THRESHOLD,
    declaredDecomposition: Array.isArray(contract.steps) && contract.steps.length > 0,
    safeParallelSplit: contract.flags?.safeParallelSplit === true || contract.safeParallelSplit === true,
    independentDeliverables: contract.flags?.independentDeliverables === true || contract.independentDeliverables === true,
  };
  return { applies: Object.values(signals).some(Boolean), signals };
};

const stepId = (runId, sequence, planRevision) => `step-${planRevision}-${sequence}`;

// `previousStepId` is the id of the step actually before this one, which is not
// always the generated one: a declared step may carry its own `stepId`, and
// defaulting to the generated id would point the chain at a step that does not
// exist, leaving the plan with nothing runnable after the first unit passes.
const normalizeDeclaredStep = ({ declared, index, runId, planRevision, contract, previousStepId = null }) => ({
  stepId: declared.stepId ? String(declared.stepId) : stepId(runId, index + 1, planRevision),
  sequence: index + 1,
  objective: String(declared.objective || contract.objective || ''),
  state: 'planned',
  planRevision,
  dependencyIds: Array.isArray(declared.dependsOn) ? declared.dependsOn.map(String) : (previousStepId ? [previousStepId] : []),
  allowedPaths: Array.isArray(declared.allowedPaths) ? normalizeWorkUnitAllowedPaths(declared.allowedPaths) : normalizeWorkUnitAllowedPaths(contract.allowedPaths),
  forbiddenPaths: Array.isArray(declared.forbiddenPaths) ? declared.forbiddenPaths.map(String) : (contract.forbiddenPaths || []),
  acceptanceIds: Array.isArray(declared.acceptanceIds) ? declared.acceptanceIds.map(String) : [],
  obligationIds: Array.isArray(declared.obligationIds) ? declared.obligationIds.map(String) : [],
  assignedRole: String(declared.role || 'implementer'),
  expectedOutputs: Array.isArray(declared.expectedOutputs) ? declared.expectedOutputs.map(String) : [],
});

// Ids are assigned first so each step can depend on the one actually before it.
// A declared id that a previous revision already used is qualified with the plan
// revision: step ids are unique per run, so reusing one would make the
// replacement step collide with the step it replaces.
const settleGoalBindingsOnFinalStep = ({ steps = [], obligations = [], contract = {} } = {}) => {
  if (steps.length <= 1) return steps;
  const goalObligationIds = new Set(obligations
    .filter((obligation) => deriveVerificationSettlementScope(obligation) === 'goal')
    .map((obligation) => String(obligation.obligationId)));
  const acceptanceBindings = new Map((contract.acceptance || []).map((acceptance) => [
    String(acceptance.id),
    obligations.filter((obligation) => (obligation.acceptanceIds || []).some((id) => String(id) === String(acceptance.id))),
  ]));
  const final = steps[steps.length - 1];

  for (const step of steps.slice(0, -1)) {
    const deferredAcceptance = (step.acceptanceIds || []).filter((acceptanceId) => {
      const bound = acceptanceBindings.get(String(acceptanceId)) || [];
      return bound.length > 0 && bound.every((obligation) => deriveVerificationSettlementScope(obligation) === 'goal');
    });
    if (deferredAcceptance.length > 0) {
      const deferred = new Set(deferredAcceptance.map(String));
      step.acceptanceIds = (step.acceptanceIds || []).filter((id) => !deferred.has(String(id)));
      final.acceptanceIds = [...new Set([...(final.acceptanceIds || []), ...deferredAcceptance])];
    }

    const deferredObligations = (step.obligationIds || []).filter((obligationId) => goalObligationIds.has(String(obligationId)));
    if (deferredObligations.length > 0) {
      const deferred = new Set(deferredObligations.map(String));
      step.obligationIds = (step.obligationIds || []).filter((id) => !deferred.has(String(id)));
      final.obligationIds = [...new Set([...(final.obligationIds || []), ...deferredObligations])];
    }
  }

  return steps;
};

const normalizeDeclaredSteps = ({ declared = [], runId, planRevision, contract, reservedStepIds = [] }) => {
  const taken = new Set(reservedStepIds);
  const idMap = new Map();
  const steps = [];
  for (const [index, entry] of declared.entries()) {
    const originalId = entry.stepId ? String(entry.stepId) : stepId(runId, index + 1, planRevision);
    const step = normalizeDeclaredStep({
      declared: entry,
      index,
      runId,
      planRevision,
      contract,
      previousStepId: steps.length > 0 ? steps[steps.length - 1].stepId : null,
    });
    if (taken.has(step.stepId)) {
      let candidate = `${step.stepId}@r${planRevision}`;
      let attempt = 1;
      while (taken.has(candidate)) {
        candidate = `${step.stepId}@r${planRevision}-${attempt}`;
        attempt++;
      }
      step.stepId = candidate;
    }
    taken.add(step.stepId);
    idMap.set(originalId, step.stepId);
    steps.push(step);
  }
  // Dependencies default to the preceding step, so they are resolved after the
  // ids are final rather than against a name that was just qualified away.
  return steps.map((step, index) => {
    if (Array.isArray(declared[index]?.dependsOn)) {
      return {
        ...step,
        dependencyIds: declared[index].dependsOn.map((id) => idMap.get(String(id)) || String(id)),
      };
    }
    if (index === 0) {
      return step;
    }
    return { ...step, dependencyIds: [steps[index - 1].stepId] };
  });
};

// The synthetic single step. It carries the whole run: the same acceptance, the
// same obligations, the same scope. This is what keeps `next`/`report` identical
// for simple work while still giving every run a durable cursor.
export const buildSyntheticStep = ({ run, contract = {}, obligations = [], planRevision = 1 }) => ({
  stepId: stepId(run.runId, 1, planRevision),
  sequence: 1,
  objective: run.objective,
  state: 'ready',
  planRevision,
  dependencyIds: [],
  allowedPaths: normalizeWorkUnitAllowedPaths(contract.allowedPaths),
  forbiddenPaths: contract.forbiddenPaths || [],
  acceptanceIds: (contract.acceptance || []).map((item) => item.id),
  obligationIds: obligations.map((obligation) => obligation.obligationId),
  assignedRole: 'implementer',
  expectedOutputs: [],
  synthetic: true,
});

// A declared decomposition binds each unit to the acceptance and obligations it
// is responsible for; anything it leaves unclaimed stays on the last step, so no
// obligation can fall between two units and never be proven.
export const planRunSteps = ({
  run,
  contract = {},
  obligations = [],
  route = {},
  planRevision = 1,
} = {}) => {
  const decision = stepLedgerApplies({ contract, route, filesChanged: contract.filesChanged });
  const declared = Array.isArray(contract.steps) ? contract.steps : [];

  if (!decision.applies || declared.length === 0) {
    return { applies: decision.applies, signals: decision.signals, steps: [buildSyntheticStep({ run, contract, obligations, planRevision })] };
  }

  const steps = settleGoalBindingsOnFinalStep({
    steps: normalizeDeclaredSteps({ declared, runId: run.runId, planRevision, contract }),
    obligations,
    contract,
  });

  const claimedObligations = new Set(steps.flatMap((step) => step.obligationIds));
  const claimedAcceptance = new Set(steps.flatMap((step) => step.acceptanceIds));
  const last = steps[steps.length - 1];
  last.obligationIds = [...new Set([...last.obligationIds, ...obligations.map((o) => o.obligationId).filter((id) => !claimedObligations.has(id))])];
  last.acceptanceIds = [...new Set([...last.acceptanceIds, ...(contract.acceptance || []).map((item) => item.id).filter((id) => !claimedAcceptance.has(id))])];

  // Only the first step (or every dependency-free step) starts ready.
  for (const step of steps) {
    if (step.dependencyIds.length === 0) step.state = 'ready';
  }
  return { applies: true, signals: decision.signals, steps };
};

// A replan does not edit history: the live steps of the old revision are
// superseded and the new plan is written at a new revision, so what was
// attempted stays readable.
export const planReplacementSteps = ({ run, contract = {}, obligations = [], planRevision, deltaSteps = [], reservedStepIds = [] } = {}) => {
  if (!Array.isArray(deltaSteps) || deltaSteps.length === 0) {
    return [buildSyntheticStep({ run, contract, obligations, planRevision })];
  }
  return settleGoalBindingsOnFinalStep({
    steps: normalizeDeclaredSteps({ declared: deltaSteps, runId: run.runId, planRevision, contract, reservedStepIds }),
    obligations,
    contract,
  }).map((step) => (step.dependencyIds.length === 0 ? { ...step, state: 'ready' } : step));
};
