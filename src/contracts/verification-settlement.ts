// Provider-neutral verification settlement contract.
//
// This module owns no evidence execution and no persistence. Work, Trust, and
// the coordinator share the same derived classification so they do not import
// one another's implementation modules or duplicate settlement policy.

export type VerificationSettlementScope = 'focused' | 'integration' | 'goal';
export type EvidenceLevel = 'work' | 'integration' | 'goal';

export interface VerificationScopeCandidate {
  sourceType?: unknown;
  sourceRef?: unknown;
  scope?: unknown;
  freshnessInputs?: unknown;
}

export interface VerificationCommandCandidate {
  sourceType?: unknown;
}

export interface VerificationObligationLike {
  sourceType?: unknown;
  sourceRef?: unknown;
  acceptanceIds?: unknown;
  metadata?: {
    rootProofRequired?: unknown;
    evidenceLevel?: unknown;
    scope?: unknown;
    freshnessInputs?: unknown;
    scopeCandidates?: unknown;
    commandCandidates?: unknown;
  } | null;
}

const SCOPE_SOURCE_PRIORITY: Readonly<Record<string, number>> = Object.freeze({
  knowledge: 0,
  caller: 1,
  'evidence-plan': 2,
  'proof-policy': 3,
});

const scopeSourcePriority = (sourceType: unknown): number => (
  SCOPE_SOURCE_PRIORITY[String(sourceType)] ?? 99
);

const normalizeScope = (scope: unknown): string[] => (
  Array.isArray(scope)
    ? [...new Set(scope.map(String).map((entry) => entry.trim()).filter(Boolean))].sort()
    : []
);

const scopeCandidates = (value: unknown): VerificationScopeCandidate[] => (
  Array.isArray(value)
    ? value.filter((candidate): candidate is VerificationScopeCandidate => (
        Boolean(candidate) && typeof candidate === 'object'
      ))
    : []
);

export interface AuthoritativeVerificationScope {
  scope: string[];
  freshnessInputs: string[];
  sourceType: unknown;
  sourceRef: string | null;
}

// Only an authoritative declared scope can narrow freshness. Step paths and
// model-reported changed paths are deliberately not accepted.
export const authoritativeVerificationScope = (
  obligation: VerificationObligationLike | null | undefined,
): AuthoritativeVerificationScope | null => {
  if (!obligation) return null;
  const candidate = scopeCandidates(obligation.metadata?.scopeCandidates)
    .sort((left, right) => (
      scopeSourcePriority(left.sourceType) - scopeSourcePriority(right.sourceType)
        || String(left.sourceRef || '').localeCompare(String(right.sourceRef || ''))
    ))
    .find((entry) => normalizeScope(entry.scope).length > 0);

  if (candidate) {
    return {
      scope: normalizeScope(candidate.scope),
      freshnessInputs: Array.isArray(candidate.freshnessInputs)
        ? [...new Set(candidate.freshnessInputs.map(String))]
        : [],
      sourceType: candidate.sourceType,
      sourceRef: candidate.sourceRef ? String(candidate.sourceRef) : null,
    };
  }

  const scope = normalizeScope(obligation.metadata?.scope);
  return scope.length > 0
    ? {
      scope,
      freshnessInputs: Array.isArray(obligation.metadata?.freshnessInputs)
        ? [...new Set(obligation.metadata.freshnessInputs.map(String))]
        : [],
      sourceType: obligation.sourceType || null,
      sourceRef: obligation.sourceRef ? String(obligation.sourceRef) : null,
    }
    : null;
};

const requiresRootProof = (obligation: VerificationObligationLike): boolean => (
  obligation.metadata?.rootProofRequired === true
  || obligation.sourceType === 'proof-policy'
  || (Array.isArray(obligation.metadata?.commandCandidates)
    && (obligation.metadata.commandCandidates as VerificationCommandCandidate[])
      .some((candidate) => candidate?.sourceType === 'proof-policy'))
);

// Settlement scope is derived state, never a writable lifecycle authority.
export const deriveVerificationSettlementScope = (
  obligation: VerificationObligationLike | null | undefined,
): VerificationSettlementScope => {
  if (!obligation || requiresRootProof(obligation)) return 'goal';
  const declared = obligation.metadata?.evidenceLevel;
  if (declared === 'goal') return 'goal';
  if (declared === 'integration') return 'integration';
  if (declared === 'work') return 'focused';
  if (authoritativeVerificationScope(obligation)) return 'focused';
  if (
    obligation.sourceType === 'evidence-plan'
    && Array.isArray(obligation.acceptanceIds)
    && obligation.acceptanceIds.length > 0
  ) return 'focused';
  return 'goal';
};

export const verificationSettlementRank = (scope: unknown): number => ({
  focused: 0,
  integration: 1,
  goal: 2,
}[String(scope)] ?? 2);

export const deriveEvidenceLevel = (
  obligation: VerificationObligationLike | null | undefined,
): EvidenceLevel => {
  if (!obligation || requiresRootProof(obligation)) return 'goal';
  const declared = obligation.metadata?.evidenceLevel;
  if (declared === 'work' || declared === 'integration' || declared === 'goal') return declared;
  const settlement = deriveVerificationSettlementScope(obligation);
  if (settlement === 'focused') return 'work';
  if (settlement === 'integration') return 'integration';
  return 'goal';
};
