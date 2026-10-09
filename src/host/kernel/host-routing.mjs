// Host-routing bridge (Wave B9).
//
// The Control Plane coordinates Work, Trust, and Knowledge.  It must not also
// own the policy used to turn an action into an execution route.  This bridge
// keeps the compatibility methods that existing Host callers use, while
// making the policy boundary explicit and provider-neutral:
//
//   Kernel coordinator -> logical execution class
//   Host              -> provider/model/session/process details
//
// No provider model id or provider credential belongs in this module.

import { detectOptionalStagnation, optionalCapabilityActive } from '../../kernel/run/optional-capabilities.mjs';
import { recommendModelRouting, resolveModelRoute } from '../../kernel/run/model-routing.mjs';

export const ACTION_FOR_MODEL_ACTION = Object.freeze({
  implement: 'implement',
  fix: 'debug',
  review: 'review_engineering',
  report: 'prove',
  finalize: 'close',
  done: 'close',
  blocked: 'understand',
});

export const actionKindForModelAction = (actionType) =>
  ACTION_FOR_MODEL_ACTION[actionType] || 'implement';

const retrySignalsForRun = (store, runId, { obligationId = null } = {}) => {
  const stepAttempts = store.getStepAttempts(runId);
  const failedWorkAttempts = stepAttempts.filter((attempt) => attempt.status === 'failed');
  const verificationHistory = typeof store.getVerificationHistory === 'function'
    ? store.getVerificationHistory(runId)
    : store.getVerifications(runId);
  const failedEvidence = verificationHistory.filter((verification) => (
    verification.status === 'failed'
    && (!obligationId || String(verification.obligationId || '') === String(obligationId))
  ));
  const retryCount = Math.max(failedWorkAttempts.length, failedEvidence.length);
  const failedAttemptSignals = Array.from({ length: retryCount }, (_, index) => (
    failedWorkAttempts[index] || { status: 'failed' }
  ));
  return { stepAttempts, verificationHistory, retryCount, failedAttemptSignals };
};

const buildStagnationSignal = ({ store, detectStepStagnation }) => (runId) => {
  const run = store.getRun(runId);
  if (!run) throw new Error(`Run ${runId} not found`);
  const retrySignals = retrySignalsForRun(store, runId);
  const enabled = optionalCapabilityActive('stagnation-escalation', { run, attempts: retrySignals.failedAttemptSignals });
  const runLevel = enabled
    ? detectOptionalStagnation({
      run,
      attempts: retrySignals.failedAttemptSignals,
      verifications: retrySignals.verificationHistory,
    })
    : {
      stagnant: false,
      reason: 'optional-capability-disabled',
      failedAttempts: retrySignals.retryCount,
    };
  const stepLevel = enabled
    ? detectStepStagnation(runId)
    : { stagnant: false, reason: 'optional-capability-disabled', signals: {} };
  const stepEscalates = stepLevel.signals?.consecutiveFailures === true;
  return {
    stagnant: runLevel.stagnant || stepEscalates,
    enabled,
    runLevel,
    stepLevel,
    source: runLevel.stagnant ? 'run' : (stepEscalates ? 'step' : null),
  };
};

export const createHostRoutingBridge = ({ store, detectStepStagnation = () => ({ stagnant: false, signals: {} }) } = {}) => {
  if (!store || typeof store.getRun !== 'function') throw new TypeError('host routing bridge requires a state store');
  const stagnationSignal = buildStagnationSignal({ store, detectStepStagnation });

  const bridge = {
    detectStagnation(runId, { threshold } = {}) {
      const run = store.getRun(runId);
      if (!run) throw new Error(`Run ${runId} not found`);
      const retrySignals = retrySignalsForRun(store, runId);
      return detectOptionalStagnation({
        run,
        attempts: retrySignals.failedAttemptSignals,
        verifications: retrySignals.verificationHistory,
        threshold,
      });
    },

    stagnationSignal,

    recommendRouting(runId, { independentReviewRequired = false } = {}) {
      const run = store.getRun(runId);
      if (!run) throw new Error(`Run ${runId} not found`);
      const stagnation = stagnationSignal(runId);
      const retrySignals = retrySignalsForRun(store, runId);
      return recommendModelRouting({
        riskTier: run.proofTier,
        stagnant: stagnation.stagnant,
        retryCount: retrySignals.retryCount,
        independentReviewRequired,
      });
    },

    decideModelRoute(runId, {
      actionKind,
      obligationId = null,
      independentReviewRequired = false,
      planInvalid = false,
      architectureDeviation = false,
      protectedObligationFailed = false,
      workProfile = null,
      complexity = null,
    } = {}) {
      const run = store.getRun(runId);
      if (!run) throw new Error(`Run ${runId} not found`);
      const retrySignals = retrySignalsForRun(store, runId, { obligationId });
      const priorDecisions = store.listModelRouteDecisions(runId);
      const decision = resolveModelRoute({
        runId,
        actionKind,
        riskTier: run.proofTier,
        attemptNumber: retrySignals.retryCount + 1,
        replanCount: run.replanCount || 0,
        retryCount: retrySignals.retryCount,
        stagnant: stagnationSignal(runId).stagnant,
        protectedObligationFailed,
        planInvalid,
        architectureDeviation,
        independentReviewRequired,
        workProfile,
        complexity,
        currentPlanRevision: Number(run.planRevision || 1),
        obligationId,
        escalatedObligations: priorDecisions
          .filter((entry) => entry.modelClass === 'frontier_reasoning' && entry.role === 'implementer' && entry.obligationId)
          .map((entry) => ({ planRevision: entry.planRevision, obligationId: entry.obligationId })),
        sequence: priorDecisions.length,
      });
      return store.recordModelRouteDecision(runId, decision);
    },
  };

  return Object.freeze(bridge);
};
