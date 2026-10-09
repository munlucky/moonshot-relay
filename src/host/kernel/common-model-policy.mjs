// Common model execution policy (Wave 4.3, 4.4, 4.7). Planning, verification,
// and delegation rules that hold for every provider, resolved as data instead of
// repeated as prose in each provider's prompt.
//
// The theme is conditional, not mandatory: a plan artifact, an extra reviewer,
// and a subagent each cost a turn, so each is produced only when the shape of
// the work actually calls for it.

export const PLAN_MODES = Object.freeze(['none', 'internal', 'explicit', 'explicit-with-review']);

const HIGH_RISK_SHAPES = Object.freeze(['security', 'authentication', 'authorization', 'payment', 'migration', 'data-loss', 'irreversible']);

export const isHighRiskShape = (shapes = []) => shapes.some((shape) => HIGH_RISK_SHAPES.includes(String(shape)));

// T1 single-file work goes straight to implementation; the plan artifact only
// earns its cost once the work is multi-step, ambiguous, or dangerous.
export const resolvePlanPolicy = ({ riskTier = 'T1', actionKind = 'implement', complexity = 'simple', shapes = [] } = {}) => {
  if (isHighRiskShape(shapes) || riskTier === 'T3') return { mode: 'explicit-with-review', independentReviewRequired: true };
  if (actionKind === 'plan' || actionKind === 'design' || actionKind === 'replan') return { mode: 'explicit', independentReviewRequired: false };
  if (complexity === 'complex' || complexity === 'ambiguous' || complexity === 'multi-step') return { mode: 'explicit', independentReviewRequired: false };
  if (complexity === 'moderate') return { mode: 'internal', independentReviewRequired: false };
  return { mode: 'none', independentReviewRequired: false };
};

// A model-local check informs the model's next edit. Kernel evidence decides
// completion. Asking the model to re-run the Kernel's proof commands buys no
// authority and costs a turn, so the two lists stay disjoint.
export const MODEL_LOCAL_CHECKS = Object.freeze(['unit-test', 'type-check', 'lint', 'diff-inspection']);
export const KERNEL_AUTHORITATIVE_EVIDENCE = Object.freeze(['required-obligation-proof', 'protected-review', 'completion-decision']);

export const resolveVerificationPolicy = ({ obligations = [], doneWhen = [] } = {}) => ({
  order: Object.freeze(['smallest-relevant-test', 'done-when-regression', 'final-diff-review', 'report-commands-and-risks']),
  modelLocalChecks: MODEL_LOCAL_CHECKS,
  kernelEvidence: KERNEL_AUTHORITATIVE_EVIDENCE,
  // The model names these; the Kernel runs them and owns the result.
  requestedCommandRefs: Object.freeze([...new Set(obligations.flatMap((o) => o.allowedCommandRefs || []))].sort()),
  doneWhen: Object.freeze([...doneWhen]),
  duplicateKernelProof: false,
});

export const DEFAULT_MAX_NESTED_AGENTS = 0;

// Delegation is default-deny. The gate is about whether the work genuinely
// splits, not about how big it feels.
export const resolveDelegationPolicy = ({
  capsuleAllowsDelegation = false,
  independentWork = false,
  disjointPaths = false,
  parallelBenefit = false,
  contextNoiseReduction = false,
  role = 'implementer',
} = {}) => {
  const gates = { capsuleAllowsDelegation, independentWork, disjointPaths, parallelBenefit: parallelBenefit || contextNoiseReduction };
  const allowed = Object.values(gates).every(Boolean);
  return Object.freeze({
    schemaVersion: 1,
    allowNestedDelegation: allowed,
    maxNestedAgents: allowed ? 1 : DEFAULT_MAX_NESTED_AGENTS,
    gates: Object.freeze(gates),
    // An implementer that spawns its own reviewer is reviewing itself. The
    // independent reviewer is a separate Host session, always.
    reviewerSpawnedByModel: false,
    reviewerOwnedByHost: role !== 'reviewer',
  });
};

export const STRUCTURED_OUTPUT_FIELDS = Object.freeze({
  planner: Object.freeze(['plan', 'assumptions', 'risks', 'requiredEvidence']),
  implementer: Object.freeze(['changedFiles', 'behaviorChanges', 'checks', 'blockers']),
  reviewer: Object.freeze(['verdict', 'findings', 'evidenceRefs', 'reviewedRevision']),
});

export const resolveCommonModelPolicy = (input = {}) => Object.freeze({
  schemaVersion: 1,
  plan: resolvePlanPolicy(input),
  verification: resolveVerificationPolicy(input),
  delegation: resolveDelegationPolicy(input),
  structuredOutput: STRUCTURED_OUTPUT_FIELDS[input.role] || null,
});
