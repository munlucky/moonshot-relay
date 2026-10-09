const values = (value) => (Array.isArray(value) ? value : []).map(String);
const keyOf = (candidate) => `${candidate.proposedType || candidate.type || 'semantic_fact'}|${String(candidate.statement || '').trim().toLowerCase()}|${JSON.stringify(values(candidate.scope).sort())}`;

export function deduplicateCandidates(candidates = []) {
  const merged = new Map();
  for (const candidate of candidates) {
    if (!candidate?.statement) continue;
    const key = keyOf(candidate);
    const prior = merged.get(key);
    if (!prior) { merged.set(key, { ...candidate, evidenceRefs: [...new Set(values(candidate.evidenceRefs))] }); continue; }
    merged.set(key, {
      ...prior,
      confidence: Math.max(Number(prior.confidence || 0), Number(candidate.confidence || 0)),
      evidenceRefs: [...new Set([...values(prior.evidenceRefs), ...values(candidate.evidenceRefs)])],
      sourceRefs: [...new Set([...values(prior.sourceRefs), ...values(candidate.sourceRefs)])],
      conflictRefs: [...new Set([...values(prior.conflictRefs), ...values(candidate.conflictRefs)])],
    });
  }
  return [...merged.values()];
}

export const candidateKey = keyOf;
