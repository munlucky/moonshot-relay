// Measurement-based model routing (§25 P3) — a POLICY hook only. It never
// calls a provider; it decides a logical model class from observed signals and
// leaves the actual model selection and invocation to the Host (§5.1).

import {
  ACTION_KINDS,
  BUILD_ACTIONS,
  REVIEW_ACTIONS,
  RISK_TIERS,
  buildDecisionId,
  normalizeModelRouteDecision,
} from '../../contracts/model-route.js';
import type { ActionKind, RiskTier } from '../../contracts/model-route.js';
import type { ExecutionClass } from '../../contracts/execution-class.js';
import type { WorkProfile } from '../../contracts/model-execution.js';
import { loadModelPolicy } from './model-route-policy.js';
import type { ModelPolicy } from './model-route-policy.js';
import {
  ModelRouteContractError,
  normalizeWorkProfile,
} from '../../contracts/model-execution.js';
import {
  executionClassForAction,
  legacyModelClassForExecutionClass,
} from '../../contracts/execution-class.js';

// Fixed priority (§5.3). Stagnation outranks retry escalation, because more
// attempts with a stronger model do not fix a plan that cannot work.
interface EscalationSignal {
  action: ActionKind;
  reasonCode: string;
}

const resolveEscalation = ({
  actionKind,
  retryCount,
  stagnant,
  planInvalid,
  architectureDeviation,
  protectedObligationFailed,
  escalationLocked,
  threshold,
}: {
  actionKind: ActionKind;
  retryCount: number;
  stagnant: boolean;
  planInvalid: boolean;
  architectureDeviation: boolean;
  protectedObligationFailed: boolean;
  escalationLocked: boolean;
  threshold: number;
}): EscalationSignal | null => {
  if (!(BUILD_ACTIONS as readonly ActionKind[]).includes(actionKind)) return null;
  if (stagnant) return { action: 'replan', reasonCode: 'STAGNATION_REPLAN' };
  if (planInvalid) return { action: 'replan', reasonCode: 'PLAN_INVALID_REPLAN' };
  if (architectureDeviation) return { action: 'replan', reasonCode: 'ARCHITECTURE_DEVIATION_REPLAN' };
  if (retryCount >= threshold) return { action: 'implement', reasonCode: 'RETRY_ESCALATION' };
  if (protectedObligationFailed) return { action: 'debug', reasonCode: 'PROTECTED_OBLIGATION_FAILURE' };
  // §5.4: within one plan revision and obligation an escalation never demotes.
  if (escalationLocked) return { action: actionKind, reasonCode: 'ESCALATION_LOCKED' };
  return null;
};

// Work shape is derived in the Kernel from task signals. The Host receives the
// resulting profile and may choose an actor, but it cannot feed a provider
// model or effort setting back into this function.
export const resolveWorkProfile = ({
  actionKind,
  riskTier,
  retryCount = 0,
  independentContextRequired = false,
  workProfile = null,
  complexity = null,
  executionClass = null,
  policy = loadModelPolicy(),
}: {
  actionKind: ActionKind;
  riskTier?: RiskTier;
  retryCount?: number;
  independentContextRequired?: boolean;
  workProfile?: unknown;
  complexity?: unknown;
  executionClass?: ExecutionClass | null;
  policy?: Readonly<ModelPolicy>;
}): Readonly<WorkProfile> | null => {
  const supplied = workProfile === null || workProfile === undefined
    ? null
    : normalizeWorkProfile(workProfile, { actionKind });
  const selectedExecutionClass = supplied?.executionClass
    ?? executionClass
    ?? executionClassForAction(actionKind, { complexity: supplied?.complexity ?? complexity });
  return normalizeWorkProfile({
    executionClass: selectedExecutionClass,
    complexity: supplied?.complexity ?? complexity ?? 'standard',
    repeatedFailure: supplied?.repeatedFailure ?? (Number(retryCount) >= Number(policy?.thresholds?.retryEscalationThreshold || 2)),
    independentContextRequired: supplied?.independentContextRequired ?? independentContextRequired,
    parallelizable: supplied?.parallelizable ?? false,
  }, { actionKind });
};

// The full Kernel→Host decision for the action the model is about to perform.
export const resolveModelRoute = ({
  runId = 'unbound',
  actionKind,
  riskTier = 'T0',
  attemptNumber = 1,
  replanCount = 0,
  retryCount = 0,
  stagnant = false,
  protectedObligationFailed = false,
  planInvalid = false,
  architectureDeviation = false,
  independentReviewRequired = false,
  currentPlanRevision = 1,
  obligationId = null,
  escalatedObligations = [],
  sequence = 0,
  workProfile = null,
  complexity = null,
  executionClass = null,
  createdAt,
  policy = loadModelPolicy(),
}: {
  runId?: string;
  actionKind?: unknown;
  riskTier?: unknown;
  attemptNumber?: number;
  replanCount?: number;
  retryCount?: number;
  stagnant?: boolean;
  protectedObligationFailed?: boolean;
  planInvalid?: boolean;
  architectureDeviation?: boolean;
  independentReviewRequired?: boolean;
  currentPlanRevision?: number;
  obligationId?: unknown;
  escalatedObligations?: readonly unknown[];
  sequence?: number;
  workProfile?: unknown;
  complexity?: unknown;
  executionClass?: ExecutionClass | null;
  createdAt?: unknown;
  policy?: Readonly<ModelPolicy>;
} = {}) => {
  if (!ACTION_KINDS.includes(actionKind as ActionKind)) {
    throw new ModelRouteContractError('kernel_model_action_invalid', `actionKind must be one of: ${ACTION_KINDS.join(', ')}`);
  }
  const normalizedActionKind = actionKind as ActionKind;
  const tier: RiskTier = RISK_TIERS.includes(riskTier as RiskTier)
    ? riskTier as RiskTier
    : 'T0';
  const base = policy.actionDefaults[normalizedActionKind];
  if (!base) throw new ModelRouteContractError('kernel_model_policy_action_missing', 'No default for action: ' + normalizedActionKind);
  const reasonCodes: string[] = [];
  const baseWorkProfile = resolveWorkProfile({
    actionKind: normalizedActionKind,
    riskTier: tier,
    retryCount,
    independentContextRequired: false,
    workProfile,
    complexity,
    executionClass,
    policy,
  });
  const baseExecutionClass: ExecutionClass | null = base.executionClass
    ?? (
      base.modelClass === 'kernel'
        ? null
        : executionClassForAction(normalizedActionKind, { complexity })
    );

  // prove/close belong to the Kernel runtime; no signal may hand them a model.
  if (baseExecutionClass === null) {
    return normalizeModelRouteDecision({
      decisionId: buildDecisionId({
        runId,
        attemptNumber,
        sequence,
        actionKind: normalizedActionKind,
      }),
      runId,
      attemptNumber,
      replanCount,
      planRevision: currentPlanRevision,
      obligationId,
      actionKind: normalizedActionKind,
      role: base.role,
      executionClass: null,
      modelClass: base.modelClass,
      riskTier: tier,
      independentContextRequired: false,
      workProfile: baseWorkProfile,
      permissions: base.permissions,
      reasonCodes: ['KERNEL_ONLY_ACTION'],
      policyRevision: policy.policyRevision,
      createdAt,
    });
  }

  const escalationLocked = Boolean(obligationId) && escalatedObligations.some((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const record = entry as Record<string, unknown>;
    return record.obligationId === obligationId
      && Number(record.planRevision) === Number(currentPlanRevision);
  });
  const escalation = resolveEscalation({
    actionKind: normalizedActionKind,
    retryCount,
    stagnant,
    planInvalid,
    architectureDeviation,
    protectedObligationFailed,
    escalationLocked,
    threshold: Number(policy.thresholds.retryEscalationThreshold || 2),
  });

  const effectiveAction: ActionKind = escalation
    ? escalation.action
    : normalizedActionKind;
  const spec = policy.actionDefaults[effectiveAction];
  if (!spec) throw new ModelRouteContractError('kernel_model_policy_action_missing', 'No default for action: ' + effectiveAction);
  if (escalation) reasonCodes.push(escalation.reasonCode);
  else reasonCodes.push(`ACTION_${effectiveAction.toUpperCase()}_DEFAULT`);

  // The Kernel records the requested workload class. The legacy modelClass is
  // retained only as a compatibility projection for pre-B1 consumers; old
  // retry/replan behavior may still make that projection frontier-shaped.
  const selectedExecutionClass: ExecutionClass | null = escalation
    ? (
      effectiveAction === 'replan'
        ? 'planning'
        : effectiveAction === 'review_engineering' || effectiveAction === 'review_contract'
          ? 'review'
          : 'complex_implementation'
    )
    : executionClass ?? spec.executionClass;
  const modelClass = escalation
    ? 'frontier_reasoning'
    : legacyModelClassForExecutionClass(selectedExecutionClass);

  const isReview = (REVIEW_ACTIONS as readonly ActionKind[]).includes(effectiveAction);
  const independentContextRequired = isReview && (tier === 'T3' || independentReviewRequired === true);
  if (independentContextRequired) reasonCodes.push('INDEPENDENT_REVIEW_REQUIRED');

  const effectiveWorkProfile = resolveWorkProfile({
    actionKind: effectiveAction,
    riskTier: tier,
    retryCount,
    independentContextRequired,
    workProfile,
    complexity,
    executionClass: selectedExecutionClass,
    policy,
  });

  return normalizeModelRouteDecision({
    decisionId: buildDecisionId({ runId, attemptNumber, sequence, actionKind: effectiveAction }),
    runId,
    attemptNumber,
    replanCount,
    planRevision: currentPlanRevision,
    obligationId,
    actionKind: effectiveAction,
    role: spec.role,
    executionClass: selectedExecutionClass,
    modelClass,
    riskTier: tier,
    independentContextRequired,
    workProfile: effectiveWorkProfile,
    permissions: spec.permissions,
    reasonCodes,
    policyRevision: policy.policyRevision,
    createdAt,
  });
};

// Compatibility surface (§8.4): the original recommendation vocabulary, now
// derived from the same resolver so the two cannot drift apart.
export const recommendModelRouting = ({
  riskTier = 'T0',
  stagnant = false,
  retryCount = 0,
  independentReviewRequired = false,
}: {
  riskTier?: RiskTier;
  stagnant?: boolean;
  retryCount?: number;
  independentReviewRequired?: boolean;
} = {}) => {
  const route = resolveModelRoute({ actionKind: 'implement', riskTier, stagnant, retryCount, independentReviewRequired });
  if (route.reasonCodes.includes('STAGNATION_REPLAN')) {
    return { action: 'replan', rationale: 'stagnation detected: repeated failure without progress', modelRoute: route };
  }
  if (route.reasonCodes.includes('RETRY_ESCALATION')) {
    return { action: 'escalate-model', rationale: 'multiple retries: recommend a stronger model for the next attempt', modelRoute: route };
  }
  if (independentReviewRequired || riskTier === 'T3') {
    const reviewRoute = resolveModelRoute({ actionKind: 'review_engineering', riskTier, independentReviewRequired });
    return { action: 'independent-review', rationale: 'high-risk run: route to an independent reviewer context', modelRoute: reviewRoute };
  }
  return { action: 'stay', rationale: 'no routing change warranted', modelRoute: route };
};
