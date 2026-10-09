// Routing evaluation (§Chunk 7). Replays a fixed corpus of turn sequences
// through the REAL routing policy under two arms and reports the cost proxy,
// the frontier ratio, and the honesty invariants.
//
// What this harness does NOT measure: answer quality, completion rate, or real
// provider cost. Those need live models, so they are reported as `unavailable`
// rather than estimated — an estimated quality number would be the exact kind
// of unearned confidence the completion gate exists to prevent.

import { resolveModelRoute } from '../run/model-routing.mjs';
import { resolveEnforcementStrategy } from '../run/model-route-contract.mjs';

const ENFORCING_HOST = Object.freeze({ surface: 'eval-enforcing', supportsSubagentModel: true, supportsIndependentContext: true, supportsUsageTokens: true, supportsResolvedModelIdentity: true });
const UNSUPPORTED_HOST = Object.freeze({ surface: 'eval-unsupported' });

const sessionFor = (caseId, index) => `${caseId}-session-${index}`;

// This is an evaluation-only observation, not the Host usage receipt. Keeping
// the fixture local prevents the Kernel evaluation harness from importing the
// provider/session/cache receipt implementation it is evaluating.
const buildEvaluationReceipt = ({ strategy, resolution, dispatch }) => ({
  enforcementStatus: strategy === 'unsupported'
    ? 'unsupported'
    : (dispatch.status === 'completed' && resolution.model ? 'enforced' : 'advisory'),
  resolvedModel: resolution.model || null,
});

// Baseline A pins every provider turn to frontier; candidate B applies policy.
const routeTurn = ({ arm, testCase, turn, index, escalatedObligations }) => {
  const signals = turn.signals || {};
  const decision = resolveModelRoute({
    runId: testCase.id,
    actionKind: turn.actionKind,
    riskTier: testCase.riskTier || 'T0',
    sequence: index,
    attemptNumber: index + 1,
    obligationId: turn.obligationId || 'default',
    currentPlanRevision: turn.planRevision || 1,
    escalatedObligations,
    independentReviewRequired: testCase.requiresIndependentReview === true,
    ...signals,
  });
  if (arm === 'baseline' && decision.modelClass === 'value_coding') {
    return { ...decision, modelClass: 'frontier_reasoning', reasonCodes: [...decision.reasonCodes, 'BASELINE_ALL_FRONTIER'] };
  }
  return decision;
};

const runArm = ({ arm, corpus, hostCapabilities }) => {
  const weights = corpus.costWeights || {};
  const perCase = [];
  let providerTurns = 0;
  let frontierTurns = 0;
  let weightedTokens = 0;
  let receipts = 0;
  let dishonestReceipts = 0;
  let independentReviewTurns = 0;
  let missingIndependentReview = 0;

  for (const testCase of corpus.cases) {
    const escalatedObligations = [];
    const decisions = [];
    for (const [index, turn] of testCase.turns.entries()) {
      const decision = routeTurn({ arm, testCase, turn, index, escalatedObligations });
      decisions.push({ decision, turn });
      if (decision.modelClass === 'frontier_reasoning' && decision.role === 'implementer' && decision.obligationId) {
        escalatedObligations.push({ planRevision: decision.planRevision, obligationId: decision.obligationId });
      }
      if (decision.modelClass === 'kernel') continue;

      providerTurns += 1;
      if (decision.modelClass === 'frontier_reasoning') frontierTurns += 1;
      if (decision.independentContextRequired) independentReviewTurns += 1;
      weightedTokens += (turn.estimatedTokens || 0) * (weights[decision.modelClass] ?? 1);

      const strategy = resolveEnforcementStrategy(hostCapabilities, decision);
      const resolution = { model: `eval-${decision.modelClass}`, effort: null, enforcementIntent: 'enforced' };
      const receipt = buildEvaluationReceipt({
        strategy,
        resolution,
        dispatch: strategy === 'unsupported'
          ? { status: 'unsupported', resultStatus: 'completed' }
          : {
            status: 'completed',
            resultStatus: 'completed',
            resolvedModel: resolution.model,
            observedModel: resolution.model,
            inputTokens: turn.estimatedTokens || 0,
            outputTokens: Math.round((turn.estimatedTokens || 0) / 5),
          },
      });
      receipts += 1;
      // The single invariant that makes every other number trustworthy.
      if (receipt.enforcementStatus === 'enforced' && (strategy === 'unsupported' || !receipt.resolvedModel)) dishonestReceipts += 1;
    }

    // A T3 case must produce at least one frontier review in an independent context.
    if (testCase.riskTier === 'T3') {
      const independent = decisions.some(({ decision }) => decision.role === 'reviewer' && decision.modelClass === 'frontier_reasoning' && decision.independentContextRequired);
      if (!independent) missingIndependentReview += 1;
    }
    perCase.push({
      id: testCase.id,
      providerTurns: decisions.filter(({ decision }) => decision.modelClass !== 'kernel').length,
      frontierTurns: decisions.filter(({ decision }) => decision.modelClass === 'frontier_reasoning').length,
      escalated: decisions.some(({ decision }) => decision.reasonCodes.some((code) => code.endsWith('_ESCALATION') || code.endsWith('_REPLAN') || code === 'PROTECTED_OBLIGATION_FAILURE')),
    });
  }

  return {
    arm,
    providerTurns,
    frontierTurns,
    frontierTurnRatio: providerTurns > 0 ? frontierTurns / providerTurns : 0,
    weightedTokenCostProxy: weightedTokens,
    receiptCoverage: providerTurns > 0 ? receipts / providerTurns : 0,
    dishonestReceipts,
    independentReviewTurns,
    missingIndependentReview,
    perCase,
  };
};

export const runModelRoutingEvaluation = ({ corpus, seed = 0 } = {}) => {
  const baseline = runArm({ arm: 'baseline', corpus, hostCapabilities: ENFORCING_HOST });
  const candidate = runArm({ arm: 'candidate', corpus, hostCapabilities: ENFORCING_HOST });
  const unsupportedHost = runArm({ arm: 'candidate', corpus, hostCapabilities: UNSUPPORTED_HOST });

  return {
    taskSetRevision: corpus.taskSetRevision,
    policyRevision: 'kernel-model-routing.v1',
    seed,
    caseCount: corpus.cases.length,
    baseline,
    candidate,
    unsupportedHost,
    costProxyRatio: baseline.weightedTokenCostProxy > 0 ? candidate.weightedTokenCostProxy / baseline.weightedTokenCostProxy : 1,
    // Quality clauses of the promotion gate need live models; this harness
    // measures policy behaviour only and refuses to guess the rest.
    qualityDelta: { status: 'unavailable', reason: 'live-model-execution-not-run' },
    completionRateDelta: { status: 'unavailable', reason: 'live-model-execution-not-run' },
  };
};
