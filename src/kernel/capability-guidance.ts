interface ReviewAspects {
  contract?: boolean;
  implementation?: boolean;
  complexity?: boolean;
  security?: boolean;
}

interface CapabilityGuidanceEntry {
  id: string;
  priority: number;
  guidance: string | null;
  activationCondition?: unknown;
  aspects?: ReviewAspects | null;
  [key: string]: unknown;
}

interface CapabilityGuidanceState {
  domainPolicies?: {
    security?: {
      required?: boolean;
    };
  };
}

interface CompactedCapability {
  id: string;
  reason: string;
  activationCondition?: unknown;
}

const REVIEW_CAPABILITIES = [
  'kernel-review-spec',
  'kernel-review-standards',
  'kernel-review-complexity',
] as const;

export const TRUST_BOUNDARY_CAPABILITIES = new Set<string>([
  'kernel-verification-before-completion',
  'kernel-security-review-policy',
  'kernel-browser-proof-adapter',
  'kernel-commit-closeout',
]);

export const GUIDANCE_BUDGET = {
  simple: 2,
  behaviorChange: 3,
  complex: 5,
} as const;

const joinPhrases = (parts: readonly string[]): string => {
  if (parts.length <= 1) return parts.join('');
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}`;
};

export const reviewGuidanceText = (
  aspects: ReviewAspects | null = {},
): string | null => {
  if (!aspects) return null;
  const parts: string[] = [];
  if (aspects.contract) parts.push('contract');
  if (aspects.implementation) parts.push('implementation risks');
  if (aspects.complexity) parts.push('unnecessary complexity');
  if (parts.length === 0) return null;
  return `Review the changed ${joinPhrases(parts)} relevant to this work.`;
};

export const modelVisibleGuidanceCount = (
  selected: readonly CapabilityGuidanceEntry[] = [],
): number => selected.filter(
  (entry) => !TRUST_BOUNDARY_CAPABILITIES.has(entry.id),
).length;

export const compactCapabilityGuidance = (
  selected: readonly CapabilityGuidanceEntry[] = [],
  state: CapabilityGuidanceState = {},
): {
  selected: CapabilityGuidanceEntry[];
  compacted: CompactedCapability[];
} => {
  const active = new Map<string, CapabilityGuidanceEntry>(
    selected.map((entry) => [entry.id, entry]),
  );
  const compacted: CompactedCapability[] = [];
  const drop = (id: string, reason: string): void => {
    const entry = active.get(id);
    if (!entry) return;
    compacted.push({
      id,
      reason,
      activationCondition: entry.activationCondition,
    });
    active.delete(id);
  };

  drop(
    'kernel-test-driven-development',
    'superseded_by_focused_test_guidance',
  );

  if (active.has('kernel-systematic-debugging')) {
    drop('kernel-diagnosing-bugs', 'superseded_by_systematic_debugging');
  }

  const reviewActive = REVIEW_CAPABILITIES.filter((id) => active.has(id));
  const reviewCarrier = reviewActive[0] || null;
  const reviewAspects: ReviewAspects | null = reviewCarrier
    ? {
        contract: active.has('kernel-review-spec'),
        implementation: active.has('kernel-review-standards'),
        complexity: active.has('kernel-review-complexity'),
        security: Boolean(state.domainPolicies?.security?.required),
      }
    : null;

  for (const id of reviewActive.slice(1)) {
    drop(id, 'merged_into_compact_review_guidance');
  }

  const visible: CapabilityGuidanceEntry[] = [];
  const seenGuidance = new Set<string | null>();
  for (const entry of active.values()) {
    const guidance = entry.id === reviewCarrier
      ? reviewGuidanceText(reviewAspects)
      : entry.guidance;
    if (seenGuidance.has(guidance)) {
      compacted.push({
        id: entry.id,
        reason: 'duplicate_guidance',
        activationCondition: entry.activationCondition,
      });
      continue;
    }
    seenGuidance.add(guidance);
    visible.push(
      entry.id === reviewCarrier
        ? { ...entry, guidance, aspects: reviewAspects }
        : { ...entry, guidance },
    );
  }

  visible.sort((left, right) => (
    left.priority - right.priority
    || left.id.localeCompare(right.id)
  ));
  compacted.sort((left, right) => left.id.localeCompare(right.id));
  return { selected: visible, compacted };
};
