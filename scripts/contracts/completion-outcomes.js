// Generated from src/contracts/completion-outcomes.ts. Edit the source and run npm run build.
export const COMPLETION_OUTCOMES = [
    'implemented',
    'verified',
    'deployed',
    'observed',
    'resolved',
];
export class CompletionPredicateError extends Error {
    code = 'completion-predicate-invalid';
    errorCode = 'completion-predicate-invalid';
    details;
    constructor(invalidOutcomes = []) {
        super(`completion predicate contains unsupported outcomes: ${invalidOutcomes.join(', ')}`);
        this.name = 'CompletionPredicateError';
        this.details = { invalidOutcomes, supportedOutcomes: COMPLETION_OUTCOMES };
    }
}
const METHOD_OUTCOMES = Object.freeze({
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
export const outcomeForEvidenceMethod = (method) => (METHOD_OUTCOMES[String(method || '').toLowerCase()] || null);
export const normalizeCompletionOutcome = (outcome) => {
    const normalized = String(outcome || '').trim().toLowerCase();
    return COMPLETION_OUTCOMES.includes(normalized)
        ? normalized
        : null;
};
export const normalizeCompletionPredicate = (predicate = null) => {
    const raw = Array.isArray(predicate)
        ? predicate
        : Array.isArray(predicate?.requiredOutcomes)
            ? predicate.requiredOutcomes
            : [];
    const invalidOutcomes = raw
        .map((item) => String(item || '').trim())
        .filter((item) => !normalizeCompletionOutcome(item));
    if (invalidOutcomes.length > 0)
        throw new CompletionPredicateError(invalidOutcomes);
    const requiredOutcomes = [...new Set(raw.map(normalizeCompletionOutcome).filter((item) => Boolean(item)))];
    return { requiredOutcomes };
};
export const outcomeForEvidencePlan = (plan = null) => (normalizeCompletionOutcome(plan?.outcome) || outcomeForEvidenceMethod(plan?.method));
