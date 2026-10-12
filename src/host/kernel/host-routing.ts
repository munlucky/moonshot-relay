// Host-routing bridge.
//
// Kernel persistence stays behind the Control Plane. The Host receives only a
// bounded routing snapshot and writes back a closed route decision.

import { detectOptionalStagnation, optionalCapabilityActive } from '../../contracts/optional-capabilities.js';
import { RISK_TIERS } from '../../contracts/model-route.js';
import type {
  ActionKind,
  NormalizedModelRouteDecision,
  RiskTier,
} from '../../contracts/model-route.js';
import { recommendModelRouting, resolveModelRoute } from './model-routing.js';

type UnknownRecord = Record<string, unknown>;

interface HostRoutingSnapshot {
  run: UnknownRecord;
  stepAttempts?: UnknownRecord[];
  verificationHistory?: UnknownRecord[];
  routeDecisions?: UnknownRecord[];
}

interface HostRoutingControlPlane {
  getHostRoutingSnapshot(runId: string): HostRoutingSnapshot;
  recordHostModelRouteDecision(
    runId: string,
    decision: Readonly<NormalizedModelRouteDecision>,
  ): Readonly<NormalizedModelRouteDecision>;
}

interface StepStagnationResult extends UnknownRecord {
  stagnant: boolean;
  signals?: UnknownRecord;
}

type StepStagnationDetector = (runId: string) => StepStagnationResult;

const asRiskTier = (value: unknown): RiskTier => (
  RISK_TIERS.includes(value as RiskTier)
    ? value as RiskTier
    : 'T0'
);

export const ACTION_FOR_MODEL_ACTION: Readonly<Record<string, ActionKind>> = Object.freeze({
  implement: 'implement',
  fix: 'debug',
  review: 'review_engineering',
  report: 'prove',
  finalize: 'close',
  done: 'close',
  blocked: 'understand',
});

export const actionKindForModelAction = (actionType: unknown): ActionKind =>
  ACTION_FOR_MODEL_ACTION[String(actionType || '')] || 'implement';

const retrySignalsForSnapshot = (
  snapshot: HostRoutingSnapshot,
  { obligationId = null }: { obligationId?: unknown } = {},
) => {
  const stepAttempts = Array.isArray(snapshot.stepAttempts) ? snapshot.stepAttempts : [];
  const failedWorkAttempts = stepAttempts.filter((attempt) => attempt.status === 'failed');
  const verificationHistory = Array.isArray(snapshot.verificationHistory)
    ? snapshot.verificationHistory
    : [];
  const failedEvidence = verificationHistory.filter((verification) => (
    verification.status === 'failed'
    && (!obligationId || String(verification.obligationId || '') === String(obligationId))
  ));
  const retryCount = Math.max(failedWorkAttempts.length, failedEvidence.length);
  const failedAttemptSignals: UnknownRecord[] = Array.from(
    { length: retryCount },
    (_, index) => failedWorkAttempts[index] || { status: 'failed' },
  );
  return {
    stepAttempts,
    verificationHistory,
    retryCount,
    failedAttemptSignals,
  };
};

const buildStagnationSignal = ({
  controlPlane,
  detectStepStagnation,
}: {
  controlPlane: HostRoutingControlPlane;
  detectStepStagnation: StepStagnationDetector;
}) => (runId: string) => {
  const snapshot = controlPlane.getHostRoutingSnapshot(runId);
  const { run } = snapshot;
  const retrySignals = retrySignalsForSnapshot(snapshot);
  const enabled = optionalCapabilityActive('stagnation-escalation', {
    run,
    attempts: retrySignals.failedAttemptSignals,
  });
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

export const createHostRoutingBridge = ({
  controlPlane,
  detectStepStagnation = () => ({ stagnant: false, signals: {} }),
}: {
  controlPlane?: HostRoutingControlPlane | null;
  detectStepStagnation?: StepStagnationDetector;
} = {}) => {
  if (!controlPlane
    || typeof controlPlane.getHostRoutingSnapshot !== 'function'
    || typeof controlPlane.recordHostModelRouteDecision !== 'function') {
    throw new TypeError('host routing bridge requires Kernel routing ports');
  }
  const stagnationSignal = buildStagnationSignal({ controlPlane, detectStepStagnation });

  return Object.freeze({
    detectStagnation(
      runId: string,
      { threshold }: { threshold?: number } = {},
    ) {
      const snapshot = controlPlane.getHostRoutingSnapshot(runId);
      const retrySignals = retrySignalsForSnapshot(snapshot);
      return detectOptionalStagnation({
        run: snapshot.run,
        attempts: retrySignals.failedAttemptSignals,
        verifications: retrySignals.verificationHistory,
        threshold,
      });
    },

    stagnationSignal,

    recommendRouting(
      runId: string,
      { independentReviewRequired = false }: {
        independentReviewRequired?: boolean;
      } = {},
    ) {
      const snapshot = controlPlane.getHostRoutingSnapshot(runId);
      const stagnation = stagnationSignal(runId);
      const retrySignals = retrySignalsForSnapshot(snapshot);
      return recommendModelRouting({
        riskTier: asRiskTier(snapshot.run.proofTier),
        stagnant: stagnation.stagnant,
        retryCount: retrySignals.retryCount,
        independentReviewRequired,
      });
    },

    decideModelRoute(
      runId: string,
      {
        actionKind,
        obligationId = null,
        independentReviewRequired = false,
        planInvalid = false,
        architectureDeviation = false,
        protectedObligationFailed = false,
        workProfile = null,
        complexity = null,
      }: {
        actionKind?: unknown;
        obligationId?: unknown;
        independentReviewRequired?: boolean;
        planInvalid?: boolean;
        architectureDeviation?: boolean;
        protectedObligationFailed?: boolean;
        workProfile?: unknown;
        complexity?: unknown;
      } = {},
    ) {
      const snapshot = controlPlane.getHostRoutingSnapshot(runId);
      const { run } = snapshot;
      const retrySignals = retrySignalsForSnapshot(snapshot, { obligationId });
      const priorDecisions = snapshot.routeDecisions || [];
      const decision = resolveModelRoute({
        runId,
        actionKind,
        riskTier: asRiskTier(run.proofTier),
        attemptNumber: retrySignals.retryCount + 1,
        replanCount: Number(run.replanCount || 0),
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
          .filter((entry: UnknownRecord) => (
            entry.modelClass === 'frontier_reasoning'
            && entry.role === 'implementer'
            && Boolean(entry.obligationId)
          ))
          .map((entry: UnknownRecord) => ({
            planRevision: entry.planRevision,
            obligationId: entry.obligationId,
          })),
        sequence: priorDecisions.length,
      });
      return controlPlane.recordHostModelRouteDecision(runId, decision);
    },
  });
};
