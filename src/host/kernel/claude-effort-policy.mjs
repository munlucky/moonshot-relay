// Claude effort policy (Wave 5.3). Effort is a Host dispatch parameter, not
// prompt text: putting the resolved effort into the prompt would change the
// cacheable prefix on every escalation while changing nothing about behavior.
//
// The effort *is* part of the cache identity, though — a turn at `high` and a
// turn at `xhigh` are different lineages and must not share a warm prefix.

export const CLAUDE_EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh']);

// Start conservative: the initial table is deliberately high for everything
// that writes and medium for routine review. Widening low/medium happens after
// the replay corpus shows it costs no quality, not before.
export const CLAUDE_ACTION_EFFORT = Object.freeze({
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
]);

export const XHIGH_TRIGGERS = Object.freeze([
  'large-multi-file-implementation', 'broad-refactor', 'repeated-failure',
  'architecture-replan', 'complex-t3-change', 'user-requested',
]);

const REVIEW_ACTIONS = new Set(['review_contract', 'review_engineering']);

export const resolveClaudeEffort = ({
  actionKind = 'implement',
  riskTier = 'T1',
  shapes = [],
  triggers = [],
  userRequestedEffort = null,
} = {}) => {
  const reasons = [];
  let effort = CLAUDE_ACTION_EFFORT[actionKind] || 'high';

  if (REVIEW_ACTIONS.has(actionKind)) {
    const escalating = riskTier === 'T3' || shapes.some((shape) => REVIEW_ESCALATION_SHAPES.includes(String(shape)));
    if (escalating) { effort = 'high'; reasons.push('protected-review'); }
  }

  const xhighTrigger = triggers.find((trigger) => XHIGH_TRIGGERS.includes(String(trigger)));
  if (xhighTrigger) { effort = 'xhigh'; reasons.push(xhighTrigger); }

  if (userRequestedEffort && CLAUDE_EFFORTS.includes(userRequestedEffort)) {
    effort = userRequestedEffort;
    reasons.push('user-requested');
  }

  if (!reasons.length) reasons.push('action-default');
  return Object.freeze({ effort, reasons: Object.freeze(reasons), policyRevision: 'kernel-claude-effort.v1' });
};

// Claude's own reviewer comes from a separate Host session, so the model itself
// never needs a nested agent.
export const CLAUDE_DELEGATION_DEFAULTS = Object.freeze({
  planner: Object.freeze({ maxNestedAgents: 0 }),
  implementer: Object.freeze({ maxNestedAgents: 0 }),
  reviewer: Object.freeze({ maxNestedAgents: 0 }),
});

export const resolveClaudeDelegation = (role) => CLAUDE_DELEGATION_DEFAULTS[role] || Object.freeze({ maxNestedAgents: 0 });

// Breakpoints go at the end of each cacheable prefix, longest-lived first. The
// launcher turns these into `cache_control` markers; the Kernel core never sees
// them.
export const CLAUDE_CACHE_BREAKPOINT_SEGMENTS = Object.freeze(['tool-stable', 'common-host-stable', 'provider-stable', 'run-stable']);

export const resolveClaudeCacheBreakpoints = (segments = [], { maxBreakpoints = 4 } = {}) => {
  const eligible = segments.filter((segment) => segment.cacheable && CLAUDE_CACHE_BREAKPOINT_SEGMENTS.includes(segment.kind));
  // Claude allows a bounded number of breakpoints; keep the last ones, which
  // cover the longest prefix.
  return eligible.slice(-maxBreakpoints).map((segment) => ({ kind: segment.kind, digest: segment.digest }));
};
