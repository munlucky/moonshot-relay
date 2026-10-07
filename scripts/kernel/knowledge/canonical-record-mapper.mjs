import crypto from 'node:crypto';
import { VALID_TYPES, resolveRecordType } from './records.mjs';
import { attachFreshness } from './freshness.mjs';

export function mapCandidateToCanonicalRecord(candidate, { runId, projectId, revision, projectRoot = process.cwd() }) {
  const type = resolveRecordType(candidate.proposedType || candidate.type || 'semantic_fact');
  if (!VALID_TYPES.includes(type)) {
    throw new Error(`INVALID_CANONICAL_TYPE: ${type} is not an allowed knowledge record type`);
  }

  const recordId = `kn-${projectId}-${type.slice(0, 4)}-${crypto.randomUUID().slice(0, 8)}`;
  const sourceRefs = Array.isArray(candidate.sourceRefs) ? candidate.sourceRefs : (Array.isArray(candidate.scope) ? candidate.scope : []);
  const baseRecord = {
    id: recordId,
    type,
    statement: candidate.statement || '',
    scope: Array.isArray(candidate.scope) ? candidate.scope : [],
    status: 'committed',
    trustTier: 'verified',
    projectId,
    sourceRunId: runId,
    revision,
  };
  // Every committed record carries freshness metadata (§21.3) so later runs
  // can cheaply decide whether it still holds.
  const record = attachFreshness(baseRecord, {
    projectRoot,
    sourceRefs,
    confidence: typeof candidate.confidence === 'number' ? candidate.confidence : 0.9,
  });

  if (type === 'required_verification') {
    const verification = candidate.verification && typeof candidate.verification === 'object' ? candidate.verification : {};
    record.verification = {
      commandRefs: [...new Set([...(Array.isArray(verification.commandRefs) ? verification.commandRefs : []), ...(verification.commandRef ? [verification.commandRef] : [])].map(String).filter(Boolean))],
      method: verification.method ? String(verification.method) : null,
      evidenceLevel: ['work', 'integration', 'goal'].includes(verification.evidenceLevel) ? verification.evidenceLevel : null,
      receiptContractRef: verification.receiptContractRef ? String(verification.receiptContractRef) : null,
      freshnessInputs: [...new Set((Array.isArray(verification.freshnessInputs) ? verification.freshnessInputs : []).map(String).filter(Boolean))],
    };
    record.receiptContractRef = record.verification.receiptContractRef;
    record.freshnessInputs = record.verification.freshnessInputs;
  }

  if (type === 'semantic_fact') {
    record.factJson = candidate.candidateJson || candidate;
  } else if (type === 'tacit_practice') {
    record.practiceJson = candidate.candidateJson || candidate;
  } else if (type === 'ontology_constraint') {
    record.constraintJson = candidate.candidateJson || candidate;
  } else if (type === 'failure_pattern') {
    record.failureJson = candidate.candidateJson || candidate;
  }

  return record;
}
