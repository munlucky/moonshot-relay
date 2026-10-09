import { candidateKey } from './deduplicate.mjs';

export function detectCandidateConflicts(candidates = [], existingRecords = []) {
  const conflicts = [];
  for (const candidate of candidates) {
    const type = String(candidate.proposedType || candidate.type || 'semantic_fact');
    const scope = JSON.stringify([...(candidate.scope || [])].map(String).sort());
    const matches = existingRecords.filter((record) => String(record.type || record.recordType) === type && JSON.stringify([...(record.scope || [])].map(String).sort()) === scope);
    for (const record of matches) {
      if (candidateKey(candidate) !== candidateKey({ ...record, proposedType: type })) conflicts.push({ candidateId: candidate.candidateId, recordId: record.id, reason: 'same_type_scope_different_statement' });
    }
  }
  return conflicts;
}
