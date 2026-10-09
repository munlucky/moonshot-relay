// Codex Host execution policy. The Kernel supplies one of four provider-neutral
// execution classes; this module is the only place that maps those classes to
// Codex model/effort settings. No retry score, risk score, or provider matrix
// participates in the default mapping.
//
// This module lives on the Host side. The Kernel decides a logical model class;
// only here does that become a provider model id.

export const CODEX_MODELS = Object.freeze({
  astra: 'gpt-6-astra',
  sol: 'gpt-5.6-sol',
  terra: 'gpt-5.6-terra',
  luna: 'gpt-5.6-luna',
});
export const CODEX_REASONING_EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);

export const CODEX_EXECUTION_CLASSES = Object.freeze([
  'planning',
  'complex_implementation',
  'review',
  'standard',
]);

export const CODEX_EXECUTION_POLICY = Object.freeze({
  planning: Object.freeze({ model: CODEX_MODELS.astra, effort: 'high' }),
  complex_implementation: Object.freeze({ model: CODEX_MODELS.astra, effort: 'high' }),
  review: Object.freeze({ model: CODEX_MODELS.astra, effort: 'high' }),
  standard: Object.freeze({ model: CODEX_MODELS.luna, effort: 'max' }),
});

// `gpt-5.6` is an alias that resolves to the Sol tier. `gpt-6` resolves to Astra.
// The Host records the explicit id in the receipt so a replay is reproducible even if the alias moves.
export const CODEX_MODEL_ALIASES = Object.freeze({
  'gpt-5.6': CODEX_MODELS.sol,
  'gpt-6': CODEX_MODELS.astra,
  'gpt-6-astra': CODEX_MODELS.astra,
});

export const resolveCodexModelAlias = (model) => CODEX_MODEL_ALIASES[String(model)] || String(model);

const PLANNING_ACTIONS = new Set(['understand', 'design', 'plan', 'replan']);
const REVIEW_ACTIONS = new Set(['review_contract', 'review_engineering']);
const HIGH_RISK_SHAPES = Object.freeze(['security', 'migration', 'authentication', 'authorization', 'payment', 'data-loss', 'irreversible']);

// The Codex "launch-profile" dispatch mechanism selects one of the standard
// profiles (default/plan/review/batch), not a model class name. The profile is
// an execution mechanism; the model/effort mapping remains the class policy.
export const selectCodexProfileName = ({ actionKind = 'implement', complexity = 'standard' } = {}) => {
  if (REVIEW_ACTIONS.has(actionKind)) return 'review';
  if (PLANNING_ACTIONS.has(actionKind)) return 'plan';
  if (['routine', 'routine-batch'].includes(String(complexity))) return 'batch';
  return 'default';
};

const ACTION_EXECUTION_CLASSES = Object.freeze({
  understand: 'planning',
  design: 'planning',
  plan: 'planning',
  replan: 'planning',
  review_contract: 'review',
  review_engineering: 'review',
  implement: 'standard',
  debug: 'standard',
});

export const resolveCodexExecutionClass = ({ executionClass = null, actionKind = 'implement', complexity = 'standard' } = {}) => {
  const candidate = executionClass || (['complex', 'large-refactor'].includes(String(complexity)) && ['implement', 'debug'].includes(actionKind)
    ? 'complex_implementation'
    : ACTION_EXECUTION_CLASSES[actionKind]);
  if (candidate === null || candidate === undefined || candidate === '') return null;
  if (!CODEX_EXECUTION_CLASSES.includes(String(candidate))) {
    throw new TypeError(`Codex executionClass must be one of: ${CODEX_EXECUTION_CLASSES.join(', ')}`);
  }
  return String(candidate);
};

export const resolveCodexModelPolicy = ({
  executionClass = null,
  actionKind = 'implement',
  complexity = 'standard',
  userRequested = null,
} = {}) => {
  const resolvedExecutionClass = resolveCodexExecutionClass({ executionClass, actionKind, complexity });
  if (resolvedExecutionClass === null) {
    return Object.freeze({
      schemaVersion: 2,
      executionClass: null,
      model: null,
      effort: null,
      reasoning: null,
      reasons: Object.freeze(['kernel-owned-action']),
      offDefaultPath: false,
      policyRevision: 'kernel-codex-execution-class.v1',
    });
  }
  const base = CODEX_EXECUTION_POLICY[resolvedExecutionClass];
  let model = base.model;
  let reasoning = base.effort;
  const reasons = [`execution-class:${resolvedExecutionClass}`];

  // An explicit invocation override is an intentional exception to the
  // default class mapping. It is never inferred from failure or risk signals.
  if (userRequested?.model) { model = resolveCodexModelAlias(userRequested.model); reasons.push('user-requested-model'); }
  const requestedReasoning = userRequested?.reasoning ?? userRequested?.effort;
  if (requestedReasoning && CODEX_REASONING_EFFORTS.includes(requestedReasoning)) {
    reasoning = requestedReasoning; reasons.push('user-requested-reasoning');
  }

  return Object.freeze({
    schemaVersion: 2,
    executionClass: resolvedExecutionClass,
    model,
    effort: reasoning,
    reasoning,
    reasons: Object.freeze(reasons),
    offDefaultPath: Boolean(userRequested?.model || requestedReasoning),
    policyRevision: 'kernel-codex-execution-class.v1',
  });
};

// Subagents and Ultra multiply token cost; they pass the same delegation gate
// as every other provider, plus the requirement that the work genuinely splits.
export const SUBAGENT_SUITABLE = Object.freeze(['large-codebase-exploration', 'independent-log-analysis', 'independent-test-analysis', 'non-conflicting-review', 'partitioned-document-analysis']);
export const SUBAGENT_UNSUITABLE = Object.freeze(['parallel-edits-same-file', 'simple-bug-fix', 'sequential-dependency', 'final-authority-judgment']);

export const resolveCodexSubagentPolicy = ({ workShape = null, capsuleAllowsDelegation = false } = {}) => {
  const suitable = SUBAGENT_SUITABLE.includes(String(workShape));
  const allowed = capsuleAllowsDelegation && suitable;
  return Object.freeze({
    allowSubagents: allowed,
    maxSubagents: allowed ? 1 : 0,
    // Ultra fan-out is never a completion condition; the Kernel decides done.
    allowUltra: false,
    ultraRequiresContractApproval: true,
    reason: allowed ? 'contract-approved-independent-work' : (suitable ? 'contract-not-approved' : 'work-shape-unsuitable'),
  });
};

// Fast mode changes throughput, not intelligence. It is an execution setting,
// never prompt text.
export const resolveCodexFastModePolicy = ({ workContext = 'batch', authMode = null } = {}) => {
  const interactive = ['interactive-urgent-fix', 'short-debug-loop', 'user-waiting-exploration'].includes(String(workContext));
  return Object.freeze({
    speedMode: interactive ? 'fast' : 'standard',
    deliveredAs: 'execution-setting',
    includedInPrompt: false,
    authMode: authMode || null,
    // Credit multipliers differ between ChatGPT-login and API-key billing; the
    // Host records what it knows and null when it does not.
    creditMultiplierKnown: null,
  });
};

// Plan mode is for work that is genuinely multi-step or contested. A simple
// edit goes straight to execution.
export const resolveCodexPlanPolicy = ({ actionKind = 'implement', complexity = 'simple', shapes = [] } = {}) => {
  const risky = shapes.some((shape) => HIGH_RISK_SHAPES.includes(String(shape)));
  const needsPlan = actionKind === 'plan' || ['complex', 'ambiguous', 'multi-step', 'approach-comparison'].includes(String(complexity)) || risky;
  return Object.freeze({ usePlanProfile: needsPlan, profile: needsPlan ? 'plan' : 'default' });
};

// Programmatic tool calling suits bounded read-heavy aggregation. It is unfit
// where each result changes the next decision, or where the call mutates.
export const PROGRAMMATIC_TOOL_SUITABLE = Object.freeze(['test-log-filtering', 'static-metadata-aggregation', 'evidence-schema-validation', 'bounded-readonly-aggregation']);
export const PROGRAMMATIC_TOOL_UNSUITABLE = Object.freeze(['iterative-debugging', 'code-mutation', 'destructive-command', 'approval-required', 'final-review-judgment']);

export const resolveProgrammaticToolPolicy = ({ workShape = null, capabilityDetected = false, evaluated = false } = {}) => {
  const suitable = PROGRAMMATIC_TOOL_SUITABLE.includes(String(workShape));
  return Object.freeze({
    // Default off until a representative eval shows no quality regression.
    enabled: Boolean(capabilityDetected && suitable && evaluated),
    reason: !capabilityDetected ? 'provider-unsupported' : (!suitable ? 'work-shape-unsuitable' : (!evaluated ? 'awaiting-evaluation' : 'enabled')),
  });
};

// `reasoning.mode = "pro"` is a Responses API mode, not a model slug, and stays
// off the default path.
export const resolveCodexProModePolicy = ({ capabilityDetected = false, qualityOverLatency = false, evalConfirmedGain = false, explicitlyRequested = false } = {}) => Object.freeze({
  enabled: Boolean(capabilityDetected && qualityOverLatency && evalConfirmedGain && explicitlyRequested),
  reason: capabilityDetected ? 'gated' : 'provider-unsupported',
});
