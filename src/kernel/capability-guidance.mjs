// Compacts the internally resolved capability set into the smallest set of
// model-visible guidance entries. Internal activation stays granular so Kernel
// policy keeps its signals; only the instructions handed to the model are
// merged, so overlapping methodology guidance never stacks.

// Review capabilities are listed in activation priority order; the first active
// entry carries the merged guidance.
const REVIEW_CAPABILITIES = ['kernel-review-spec', 'kernel-review-standards', 'kernel-review-complexity'];

// Trust-boundary capabilities are completion/authority contracts rather than
// development methodology, so they are outside the instruction budget.
export const TRUST_BOUNDARY_CAPABILITIES = new Set([
  'kernel-verification-before-completion',
  'kernel-security-review-policy',
  'kernel-browser-proof-adapter',
  'kernel-commit-closeout',
]);

export const GUIDANCE_BUDGET = { simple: 2, behaviorChange: 3, complex: 5 };

const joinPhrases = (parts) => {
  if (parts.length <= 1) return parts.join('');
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}`;
};

export const reviewGuidanceText = (aspects = {}) => {
  const parts = [];
  if (aspects.contract) parts.push('contract');
  if (aspects.implementation) parts.push('implementation risks');
  if (aspects.complexity) parts.push('unnecessary complexity');
  if (parts.length === 0) return null;
  return `Review the changed ${joinPhrases(parts)} relevant to this work.`;
};

export const modelVisibleGuidanceCount = (selected = []) => selected
  .filter((entry) => !TRUST_BOUNDARY_CAPABILITIES.has(entry.id)).length;

export const compactCapabilityGuidance = (selected = [], state = {}) => {
  const active = new Map(selected.map((entry) => [entry.id, entry]));
  const compacted = [];
  const drop = (id, reason) => {
    const entry = active.get(id);
    if (!entry) return;
    compacted.push({ id, reason, activationCondition: entry.activationCondition });
    active.delete(id);
  };

  // Test guidance: one conditional regression-test hint, never a TDD sequence.
  drop('kernel-test-driven-development', 'superseded_by_focused_test_guidance');

  // Debug guidance: escalate to root-cause analysis instead of stacking both.
  if (active.has('kernel-systematic-debugging')) drop('kernel-diagnosing-bugs', 'superseded_by_systematic_debugging');

  // Review guidance: one entry that names the aspects that actually apply.
  const reviewActive = REVIEW_CAPABILITIES.filter((id) => active.has(id));
  const reviewCarrier = reviewActive[0] || null;
  const reviewAspects = reviewCarrier
    ? {
      contract: active.has('kernel-review-spec'),
      implementation: active.has('kernel-review-standards'),
      complexity: active.has('kernel-review-complexity'),
      security: Boolean(state.domainPolicies?.security?.required),
    }
    : null;
  for (const id of reviewActive.slice(1)) drop(id, 'merged_into_compact_review_guidance');

  const visible = [];
  const seenGuidance = new Set();
  for (const entry of active.values()) {
    const guidance = entry.id === reviewCarrier ? reviewGuidanceText(reviewAspects) : entry.guidance;
    if (seenGuidance.has(guidance)) {
      compacted.push({ id: entry.id, reason: 'duplicate_guidance', activationCondition: entry.activationCondition });
      continue;
    }
    seenGuidance.add(guidance);
    visible.push(entry.id === reviewCarrier
      ? { ...entry, guidance, aspects: reviewAspects }
      : { ...entry, guidance });
  }
  visible.sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  compacted.sort((a, b) => a.id.localeCompare(b.id));
  return { selected: visible, compacted };
};
