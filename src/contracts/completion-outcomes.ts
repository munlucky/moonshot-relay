export const COMPLETION_OUTCOMES = [
  'implemented',
  'verified',
  'deployed',
  'observed',
  'resolved',
] as const;

export type CompletionOutcome = typeof COMPLETION_OUTCOMES[number];

export class CompletionPredicateError extends Error {
  readonly code = 'completion-predicate-invalid';
  readonly errorCode = 'completion-predicate-invalid';
  readonly details: {
    invalidOutcomes: string[];
    supportedOutcomes: readonly CompletionOutcome[];
  };

  constructor(invalidOutcomes: string[] = []) {
    super(`completion predicate contains unsupported outcomes: ${invalidOutcomes.join(', ')}`);
    this.name = 'CompletionPredicateError';
    this.details = { invalidOutcomes, supportedOutcomes: COMPLETION_OUTCOMES };
  }
}

const METHOD_OUTCOMES: Readonly<Record<string, CompletionOutcome>> = Object.freeze({
  'static-analysis': 'verified',
  build: 'verified',
  'unit-test': 'verified',
  'integration-test': 'verified',
  e2e: 'verified',
  'runtime-reproduction': 'verified',
  deployment: 'deployed',
  'runtime-observation': 'observed',
  'post-deployment-observation': 'observed',
  judgment: 'resolved',
});

export const outcomeForEvidenceMethod = (method: unknown): CompletionOutcome | null => (
  METHOD_OUTCOMES[String(method || '').toLowerCase()] || null
);

export const normalizeCompletionOutcome = (outcome: unknown): CompletionOutcome | null => {
  const normalized = String(outcome || '').trim().toLowerCase();
  return (COMPLETION_OUTCOMES as readonly string[]).includes(normalized)
    ? normalized as CompletionOutcome
    : null;
};

interface CompletionPredicateLike {
  requiredOutcomes?: unknown[];
}

export const normalizeCompletionPredicate = (
  predicate: CompletionPredicateLike | unknown[] | null = null,
) => {
  const raw = Array.isArray(predicate)
    ? predicate
    : Array.isArray(predicate?.requiredOutcomes)
      ? predicate.requiredOutcomes
      : [];
  const invalidOutcomes = raw
    .map((item) => String(item || '').trim())
    .filter((item) => !normalizeCompletionOutcome(item));
  if (invalidOutcomes.length > 0) throw new CompletionPredicateError(invalidOutcomes);
  const requiredOutcomes = [...new Set(
    raw.map(normalizeCompletionOutcome).filter((item): item is CompletionOutcome => Boolean(item)),
  )];
  return { requiredOutcomes };
};

interface EvidencePlanLike {
  outcome?: unknown;
  method?: unknown;
}

export const outcomeForEvidencePlan = (plan: EvidencePlanLike | null = null) => (
  normalizeCompletionOutcome(plan?.outcome) || outcomeForEvidenceMethod(plan?.method)
);
