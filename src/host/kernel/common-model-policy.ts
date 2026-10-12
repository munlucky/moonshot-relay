export const PLAN_MODES = Object.freeze([
  'none',
  'internal',
  'explicit',
  'explicit-with-review',
] as const);

const HIGH_RISK_SHAPES = Object.freeze([
  'security',
  'authentication',
  'authorization',
  'payment',
  'migration',
  'data-loss',
  'irreversible',
] as const);

export interface PlanPolicyInput {
  riskTier?: string;
  actionKind?: string;
  complexity?: string;
  shapes?: readonly unknown[];
}

export const isHighRiskShape = (shapes: readonly unknown[] = []): boolean => (
  shapes.some((shape) => HIGH_RISK_SHAPES.includes(String(shape) as typeof HIGH_RISK_SHAPES[number]))
);

export const resolvePlanPolicy = ({
  riskTier = 'T1',
  actionKind = 'implement',
  complexity = 'simple',
  shapes = [],
}: PlanPolicyInput = {}) => {
  if (isHighRiskShape(shapes) || riskTier === 'T3') {
    return { mode: 'explicit-with-review', independentReviewRequired: true };
  }
  if (actionKind === 'plan' || actionKind === 'design' || actionKind === 'replan') {
    return { mode: 'explicit', independentReviewRequired: false };
  }
  if (complexity === 'complex' || complexity === 'ambiguous' || complexity === 'multi-step') {
    return { mode: 'explicit', independentReviewRequired: false };
  }
  if (complexity === 'moderate') {
    return { mode: 'internal', independentReviewRequired: false };
  }
  return { mode: 'none', independentReviewRequired: false };
};

export const MODEL_LOCAL_CHECKS = Object.freeze([
  'unit-test',
  'type-check',
  'lint',
  'diff-inspection',
] as const);

export const KERNEL_AUTHORITATIVE_EVIDENCE = Object.freeze([
  'required-obligation-proof',
  'protected-review',
  'completion-decision',
] as const);

export interface VerificationObligation {
  allowedCommandRefs?: readonly unknown[];
}

export interface VerificationPolicyInput {
  obligations?: readonly VerificationObligation[];
  doneWhen?: readonly unknown[];
}

export const resolveVerificationPolicy = ({
  obligations = [],
  doneWhen = [],
}: VerificationPolicyInput = {}) => ({
  order: Object.freeze([
    'smallest-relevant-test',
    'done-when-regression',
    'final-diff-review',
    'report-commands-and-risks',
  ]),
  modelLocalChecks: MODEL_LOCAL_CHECKS,
  kernelEvidence: KERNEL_AUTHORITATIVE_EVIDENCE,
  requestedCommandRefs: Object.freeze([
    ...new Set(obligations.flatMap((obligation) => obligation.allowedCommandRefs || [])),
  ].sort()),
  doneWhen: Object.freeze([...doneWhen]),
  duplicateKernelProof: false,
});

export const DEFAULT_MAX_NESTED_AGENTS = 0;

export interface DelegationPolicyInput {
  capsuleAllowsDelegation?: boolean;
  independentWork?: boolean;
  disjointPaths?: boolean;
  parallelBenefit?: boolean;
  contextNoiseReduction?: boolean;
  role?: string;
}

export const resolveDelegationPolicy = ({
  capsuleAllowsDelegation = false,
  independentWork = false,
  disjointPaths = false,
  parallelBenefit = false,
  contextNoiseReduction = false,
  role = 'implementer',
}: DelegationPolicyInput = {}) => {
  const gates = {
    capsuleAllowsDelegation,
    independentWork,
    disjointPaths,
    parallelBenefit: parallelBenefit || contextNoiseReduction,
  };
  const allowed = Object.values(gates).every(Boolean);
  return Object.freeze({
    schemaVersion: 1,
    allowNestedDelegation: allowed,
    maxNestedAgents: allowed ? 1 : DEFAULT_MAX_NESTED_AGENTS,
    gates: Object.freeze(gates),
    reviewerSpawnedByModel: false,
    reviewerOwnedByHost: role !== 'reviewer',
  });
};

export const STRUCTURED_OUTPUT_FIELDS = Object.freeze({
  planner: Object.freeze(['plan', 'assumptions', 'risks', 'requiredEvidence']),
  implementer: Object.freeze(['changedFiles', 'behaviorChanges', 'checks', 'blockers']),
  reviewer: Object.freeze(['verdict', 'findings', 'evidenceRefs', 'reviewedRevision']),
});

export interface CommonModelPolicyInput
  extends PlanPolicyInput, VerificationPolicyInput, DelegationPolicyInput {}

export const resolveCommonModelPolicy = (
  input: CommonModelPolicyInput = {},
) => Object.freeze({
  schemaVersion: 1,
  plan: resolvePlanPolicy(input),
  verification: resolveVerificationPolicy(input),
  delegation: resolveDelegationPolicy(input),
  structuredOutput: input.role
    ? STRUCTURED_OUTPUT_FIELDS[input.role as keyof typeof STRUCTURED_OUTPUT_FIELDS] || null
    : null,
});
