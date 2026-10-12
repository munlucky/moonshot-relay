// Claude effort policy (Wave 5.3). Effort is a Host dispatch parameter, not
// prompt text: putting the resolved effort into the prompt would change the
// cacheable prefix on every escalation while changing nothing about behavior.
//
// The effort *is* part of the cache identity, though — a turn at `high` and a
// turn at `xhigh` are different lineages and must not share a warm prefix.

import { REVIEW_ACTIONS as REVIEW_ACTION_LIST } from '../../contracts/review.js';
import { resolveVerificationPolicy } from './common-model-policy.js';
import { normalizeProviderCacheCapabilities } from './provider-prompt-policy.js';

export const CLAUDE_EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh'] as const);
export type ClaudeEffort = (typeof CLAUDE_EFFORTS)[number];

// Start conservative: the initial table is deliberately high for everything
// that writes and medium for routine review. Widening low/medium happens after
// the replay corpus shows it costs no quality, not before.
export const CLAUDE_ACTION_EFFORT: Readonly<Record<string, ClaudeEffort>> = Object.freeze({
  understand: 'high',
  design: 'high',
  plan: 'high',
  implement: 'high',
  debug: 'high',
  review_contract: 'medium',
  review_engineering: 'medium',
  replan: 'high',
});

export const REVIEW_ESCALATION_SHAPES = Object.freeze([
  'security', 'authentication', 'authorization', 'payment', 'migration',
  'data-loss', 'irreversible', 'protected-obligation',
] as const);

export const XHIGH_TRIGGERS = Object.freeze([
  'large-multi-file-implementation', 'broad-refactor', 'repeated-failure',
  'architecture-replan', 'complex-t3-change', 'user-requested',
] as const);

const REVIEW_ACTIONS = new Set<string>(REVIEW_ACTION_LIST);

export const resolveClaudeEffort = ({
  actionKind = 'implement',
  riskTier = 'T1',
  shapes = [],
  triggers = [],
  userRequestedEffort = null,
}: {
  actionKind?: string;
  riskTier?: (string) | undefined;
  shapes?: readonly string[];
  triggers?: readonly string[];
  userRequestedEffort?: ClaudeEffort | null;
} = {}) => {
  const reasons: string[] = [];
  let effort: ClaudeEffort = CLAUDE_ACTION_EFFORT[actionKind] || 'high';

  if (REVIEW_ACTIONS.has(actionKind)) {
    const escalating = riskTier === 'T3'
      || shapes.some((shape) => REVIEW_ESCALATION_SHAPES.includes(
        shape as (typeof REVIEW_ESCALATION_SHAPES)[number],
      ));
    if (escalating) {
      effort = 'high';
      reasons.push('protected-review');
    }
  }

  const xhighTrigger = triggers.find((trigger) => XHIGH_TRIGGERS.includes(
    trigger as (typeof XHIGH_TRIGGERS)[number],
  ));
  if (xhighTrigger) {
    effort = 'xhigh';
    reasons.push(xhighTrigger);
  }

  if (userRequestedEffort && CLAUDE_EFFORTS.includes(userRequestedEffort)) {
    effort = userRequestedEffort;
    reasons.push('user-requested');
  }

  if (!reasons.length) reasons.push('action-default');
  return Object.freeze({
    effort,
    reasons: Object.freeze(reasons),
    policyRevision: 'kernel-claude-effort.v1',
  });
};

// Claude's own reviewer comes from a separate Host session, so the model itself
// never needs a nested agent.
export const CLAUDE_DELEGATION_DEFAULTS: Readonly<Record<string, Readonly<{ maxNestedAgents: number }>>> = Object.freeze({
  planner: Object.freeze({ maxNestedAgents: 0 }),
  implementer: Object.freeze({ maxNestedAgents: 0 }),
  reviewer: Object.freeze({ maxNestedAgents: 0 }),
});

export const resolveClaudeDelegation = (role: string) => (
  CLAUDE_DELEGATION_DEFAULTS[role] || Object.freeze({ maxNestedAgents: 0 })
);

export const resolveClaudeCapabilityDelta = ({
  actionKind = 'implement',
  riskTier = 'T1',
  role = 'implementer',
  capabilities = {},
  obligations = [],
  doneWhen = [],
}: {
  actionKind?: string;
  riskTier?: string;
  role?: string;
  capabilities?: Record<string, unknown>;
  obligations?: readonly { allowedCommandRefs?: readonly unknown[] }[];
  doneWhen?: readonly unknown[];
} = {}) => {
  const caps = normalizeProviderCacheCapabilities(capabilities);
  const effort = resolveClaudeEffort({ actionKind, riskTier });
  const verification = resolveVerificationPolicy({ obligations, doneWhen });
  return Object.freeze({
    reasoning: Object.freeze({
      thinkingMode: caps.supportsAdaptiveThinking ? 'adaptive' as const : 'host-default' as const,
      supported: caps.supportsAdaptiveThinking,
      effort,
    }),
    delegation: Object.freeze({
      ...resolveClaudeDelegation(role),
      owner: 'host' as const,
      alwaysOn: false as const,
    }),
    verification: Object.freeze({
      source: 'common-verification-policy' as const,
      duplicateKernelProof: verification.duplicateKernelProof,
      kernelEvidence: verification.kernelEvidence,
    }),
    promptCandidates: Object.freeze([
      'remove-always-subagent',
      'remove-always-self-verification',
    ] as const),
  });
};

// Breakpoints go at the end of each cacheable prefix, longest-lived first. The
// launcher turns these into `cache_control` markers; the Kernel core never sees
// them.
export const CLAUDE_CACHE_BREAKPOINT_SEGMENTS = Object.freeze([
  'tool-stable',
  'common-host-stable',
  'provider-stable',
  'run-stable',
] as const);

interface CacheSegment {
  cacheable?: boolean;
  kind: string;
  digest: string;
}

export const resolveClaudeCacheBreakpoints = (
  segments: readonly CacheSegment[] = [],
  { maxBreakpoints = 4 }: { maxBreakpoints?: number } = {},
) => {
  const eligible = segments.filter((segment) => (
    segment.cacheable
    && CLAUDE_CACHE_BREAKPOINT_SEGMENTS.includes(
      segment.kind as (typeof CLAUDE_CACHE_BREAKPOINT_SEGMENTS)[number],
    )
  ));
  // Claude allows a bounded number of breakpoints; keep the last ones, which
  // cover the longest prefix.
  return eligible
    .slice(-maxBreakpoints)
    .map((segment) => ({ kind: segment.kind, digest: segment.digest }));
};
