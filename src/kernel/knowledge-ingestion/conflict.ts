import { candidateKey } from './deduplicate.js';
import type { KnowledgeCandidateInput } from './normalize.js';

type KnowledgeRecordLike = KnowledgeCandidateInput & {
  id?: unknown;
  recordType?: unknown;
};

export interface CandidateConflict {
  candidateId: unknown;
  recordId: unknown;
  reason: 'same_type_scope_different_statement';
}

const sortedScope = (value: unknown): string => JSON.stringify(
  (Array.isArray(value) ? value : []).map(String).sort(),
);

export function detectCandidateConflicts(
  candidates: KnowledgeCandidateInput[] = [],
  existingRecords: KnowledgeRecordLike[] = [],
): CandidateConflict[] {
  const conflicts: CandidateConflict[] = [];
  for (const candidate of candidates) {
    const type = String(
      candidate.proposedType || candidate.type || 'semantic_fact',
    );
    const scope = sortedScope(candidate.scope);
    const matches = existingRecords.filter((record) => (
      String(record.type || record.recordType) === type
      && sortedScope(record.scope) === scope
    ));
    for (const record of matches) {
      if (
        candidateKey(candidate)
        !== candidateKey({ ...record, proposedType: type })
      ) {
        conflicts.push({
          candidateId: candidate.candidateId,
          recordId: record.id,
          reason: 'same_type_scope_different_statement',
        });
      }
    }
  }
  return conflicts;
}
