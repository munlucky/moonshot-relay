// Codex Host execution policy. The Kernel supplies one of four provider-neutral
// execution classes; this module is the only place that maps those classes to
// Codex model/effort settings. No retry score, risk score, or provider matrix
// participates in the default mapping.
//
// This module lives on the Host side. The Kernel decides a logical model class;
// only here does that become a provider model id.

export const CODEX_MODELS = Object.freeze({
  astra: 'gpt-6-astra',
  sol: 'gpt-6.1-sol',
  luna: 'gpt-6-luna',
});
export const CODEX_REASONING_EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max'] as const);

export const CODEX_EXECUTION_CLASSES = Object.freeze([
  'planning',
  'complex_implementation',
  'review',
  'standard',
] as const);

export type CodexReasoningEffort = typeof CODEX_REASONING_EFFORTS[number];
export type CodexExecutionClass = typeof CODEX_EXECUTION_CLASSES[number];

const CODEX_MODEL_POLICY_REVISION = 'kernel-codex-execution-class.v3';

export const CODEX_EXECUTION_POLICY = Object.freeze({
  planning: Object.freeze({ model: CODEX_MODELS.sol, effort: 'high' }),
  complex_implementation: Object.freeze({ model: CODEX_MODELS.sol, effort: 'high' }),
  review: Object.freeze({ model: CODEX_MODELS.sol, effort: 'xhigh' }),
  standard: Object.freeze({ model: CODEX_MODELS.luna, effort: 'medium' }),
});

// Family aliases resolve to the current validated tier. Explicit model ids pass through unchanged.
// The Host records the resolved id in the receipt so a replay remains reproducible if an alias moves.
export const CODEX_MODEL_ALIASES = Object.freeze({
  'gpt-6': CODEX_MODELS.astra,
  'gpt-6.1': CODEX_MODELS.sol,
  'gpt-6-astra': CODEX_MODELS.astra,
});

export const resolveCodexModelAlias = (model: unknown): string => (
  (CODEX_MODEL_ALIASES as Readonly<Record<string, string>>)[String(model)] || String(model)
);

const PLANNING_ACTIONS = new Set(['understand', 'design', 'plan', 'replan']);
import { REVIEW_ACTIONS as REVIEW_ACTION_LIST } from '../../contracts/review.js';
const REVIEW_ACTIONS = new Set<string>(REVIEW_ACTION_LIST);
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

const ACTION_EXECUTION_CLASSES: Readonly<Record<string, CodexExecutionClass>> = Object.freeze({
  understand: 'planning',
  design: 'planning',
  plan: 'planning',
  replan: 'planning',
  review_contract: 'review',
  review_engineering: 'review',
  implement: 'standard',
  debug: 'standard',
});

export const resolveCodexExecutionClass = ({
  executionClass = null,
  actionKind = 'implement',
  complexity = 'standard',
}: {
  executionClass?: unknown;
  actionKind?: string;
  complexity?: unknown;
} = {}): CodexExecutionClass | null => {
  const candidate = executionClass || (['complex', 'large-refactor'].includes(String(complexity)) && ['implement', 'debug'].includes(actionKind)
    ? 'complex_implementation'
    : ACTION_EXECUTION_CLASSES[actionKind]);
  if (candidate === null || candidate === undefined || candidate === '') return null;
  if (!CODEX_EXECUTION_CLASSES.includes(String(candidate) as CodexExecutionClass)) {
    throw new TypeError(`Codex executionClass must be one of: ${CODEX_EXECUTION_CLASSES.join(', ')}`);
  }
  return String(candidate) as CodexExecutionClass;
};

interface CodexUserRequest {
  model?: unknown;
  reasoning?: unknown;
  effort?: unknown;
}

export const resolveCodexModelPolicy = ({
  executionClass = null,
  actionKind = 'implement',
  complexity = 'standard',
  userRequested = null,
}: {
  executionClass?: unknown;
  actionKind?: string;
  complexity?: unknown;
  userRequested?: CodexUserRequest | null;
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
      policyRevision: CODEX_MODEL_POLICY_REVISION,
    });
  }
  const base = CODEX_EXECUTION_POLICY[resolvedExecutionClass];
  let model: string = base.model;
  let reasoning: CodexReasoningEffort = base.effort;
  const reasons = [`execution-class:${resolvedExecutionClass}`];

  // An explicit invocation override is an intentional exception to the
  // default class mapping. It is never inferred from failure or risk signals.
  if (userRequested?.model) { model = resolveCodexModelAlias(userRequested.model); reasons.push('user-requested-model'); }
  const requestedReasoning = userRequested?.reasoning ?? userRequested?.effort;
  if (
    typeof requestedReasoning === 'string'
    && CODEX_REASONING_EFFORTS.includes(requestedReasoning as CodexReasoningEffort)
  ) {
    reasoning = requestedReasoning as CodexReasoningEffort;
    reasons.push('user-requested-reasoning');
  }

  return Object.freeze({
    schemaVersion: 2,
    executionClass: resolvedExecutionClass,
    model,
    effort: reasoning,
    reasoning,
    reasons: Object.freeze(reasons),
    offDefaultPath: Boolean(userRequested?.model || requestedReasoning),
    policyRevision: CODEX_MODEL_POLICY_REVISION,
  });
};

// Subagents and Ultra multiply token cost; they pass the same delegation gate
// as every other provider, plus the requirement that the work genuinely splits.
export const SUBAGENT_SUITABLE = Object.freeze(['large-codebase-exploration', 'independent-log-analysis', 'independent-test-analysis', 'non-conflicting-review', 'partitioned-document-analysis']);
export const SUBAGENT_UNSUITABLE = Object.freeze(['parallel-edits-same-file', 'simple-bug-fix', 'sequential-dependency', 'final-authority-judgment']);

export const resolveCodexSubagentPolicy = ({ workShape = null, capsuleAllowsDelegation = false }: { workShape?: string | null; capsuleAllowsDelegation?: boolean } = {}) => {
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
export const resolveCodexFastModePolicy = ({ workContext = 'batch', authMode = null }: { workContext?: string; authMode?: string | null } = {}) => {
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
export const resolveCodexPlanPolicy = ({ actionKind = 'implement', complexity = 'simple', shapes = [] }: { actionKind?: string; complexity?: string; shapes?: readonly string[] } = {}) => {
  const risky = shapes.some((shape) => HIGH_RISK_SHAPES.includes(String(shape)));
  const needsPlan = actionKind === 'plan' || ['complex', 'ambiguous', 'multi-step', 'approach-comparison'].includes(String(complexity)) || risky;
  return Object.freeze({ usePlanProfile: needsPlan, profile: needsPlan ? 'plan' : 'default' });
};

// Programmatic tool calling suits bounded read-heavy aggregation. It is unfit
// where each result changes the next decision, or where the call mutates.
export const PROGRAMMATIC_TOOL_SUITABLE = Object.freeze(['test-log-filtering', 'static-metadata-aggregation', 'evidence-schema-validation', 'bounded-readonly-aggregation']);
export const PROGRAMMATIC_TOOL_UNSUITABLE = Object.freeze(['iterative-debugging', 'code-mutation', 'destructive-command', 'approval-required', 'final-review-judgment']);

export const resolveProgrammaticToolPolicy = ({ workShape = null, capabilityDetected = false, evaluated = false }: { workShape?: string | null; capabilityDetected?: boolean; evaluated?: boolean } = {}) => {
  const suitable = PROGRAMMATIC_TOOL_SUITABLE.includes(String(workShape));
  return Object.freeze({
    // Default off until a representative eval shows no quality regression.
    enabled: Boolean(capabilityDetected && suitable && evaluated),
    reason: !capabilityDetected ? 'provider-unsupported' : (!suitable ? 'work-shape-unsuitable' : (!evaluated ? 'awaiting-evaluation' : 'enabled')),
  });
};

// Derived Host view only. It does not select a model, effort, tool schema, or
// completion state; those remain owned by the existing policies and contracts.
export const resolveCodexCapabilityDelta = ({
  capabilities = {},
  workShape = null,
  programmaticToolEvaluated = false,
}: {
  capabilities?: {
    supportsSessionContinuation?: unknown;
    supportsProgrammaticToolCalling?: unknown;
  };
  workShape?: string | null;
  programmaticToolEvaluated?: boolean;
} = {}) => {
  const programmatic = resolveProgrammaticToolPolicy({
    workShape,
    capabilityDetected: capabilities.supportsProgrammaticToolCalling === true,
    evaluated: programmaticToolEvaluated,
  });
  return Object.freeze({
    autonomy: Object.freeze({
      mode: 'bounded' as const,
      delegation: 'contract-gated' as const,
    }),
    persistence: Object.freeze({
      mode: capabilities.supportsSessionContinuation === true
        ? 'session-continuation' as const
        : 'turn-local' as const,
      source: 'host-capability' as const,
    }),
    repositoryInvestigation: Object.freeze({
      mode: 'bounded' as const,
      boundary: 'work-unit-scope' as const,
    }),
    toolUse: Object.freeze({
      source: 'tool-manifest' as const,
      programmatic,
    }),
    effort: Object.freeze({
      source: 'execution-class-policy' as const,
    }),
    progress: Object.freeze({
      owner: 'execution-host' as const,
      promptDirective: false as const,
    }),
  });
};

// `reasoning.mode = "pro"` is a Responses API mode, not a model slug, and stays
// off the default path.
export const resolveCodexProModePolicy = ({ capabilityDetected = false, qualityOverLatency = false, evalConfirmedGain = false, explicitlyRequested = false } = {}) => Object.freeze({
  enabled: Boolean(capabilityDetected && qualityOverLatency && evalConfirmedGain && explicitlyRequested),
  reason: capabilityDetected ? 'gated' : 'provider-unsupported',
});
