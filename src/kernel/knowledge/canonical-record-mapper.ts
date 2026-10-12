import crypto from 'node:crypto';
import {
  VALID_TYPES,
  resolveRecordType,
  type KnowledgeRecordType,
} from './records.js';
import {
  attachFreshness,
  type KnowledgeFreshnessRecord,
} from './freshness.js';

type UnknownRecord = Record<string, unknown>;

export interface CandidateVerification {
  commandRefs?: unknown[];
  commandRef?: unknown;
  method?: unknown;
  evidenceLevel?: unknown;
  receiptContractRef?: unknown;
  freshnessInputs?: unknown[];
}

export interface KnowledgeCandidate extends UnknownRecord {
  proposedType?: unknown;
  type?: unknown;
  statement?: unknown;
  scope?: unknown[];
  sourceRefs?: unknown[];
  confidence?: unknown;
  verification?: CandidateVerification | null;
  candidateJson?: unknown;
}

export interface CanonicalRecordInput {
  runId: string;
  projectId: string;
  revision: number | string;
  projectRoot?: string;
}

export interface CanonicalKnowledgeRecord extends KnowledgeFreshnessRecord {
  id: string;
  type: string;
  statement: string;
  scope: string[];
  status: 'committed';
  trustTier: 'verified';
  projectId: string;
  sourceRunId: string;
  revision: number | string;
  verification?: {
    commandRefs: string[];
    method: string | null;
    evidenceLevel: 'work' | 'integration' | 'goal' | null;
    receiptContractRef: string | null;
    freshnessInputs: string[];
  };
  receiptContractRef?: string | null;
  freshnessInputs?: string[];
  factJson?: unknown;
  practiceJson?: unknown;
  constraintJson?: unknown;
  failureJson?: unknown;
}

const strings = (value: unknown): string[] => (
  Array.isArray(value)
    ? value.map(String).filter(Boolean)
    : []
);

export function mapCandidateToCanonicalRecord(
  candidate: KnowledgeCandidate,
  {
    runId,
    projectId,
    revision,
    projectRoot = process.cwd(),
  }: CanonicalRecordInput,
): CanonicalKnowledgeRecord {
  const proposedType = String(
    candidate.proposedType || candidate.type || 'semantic_fact',
  );
  const type = String(resolveRecordType(proposedType));
  if (!VALID_TYPES.includes(type as KnowledgeRecordType)) {
    throw new Error(
      `INVALID_CANONICAL_TYPE: ${type} is not an allowed knowledge record type`,
    );
  }

  const recordId = `kn-${projectId}-${type.slice(0, 4)}-${crypto.randomUUID().slice(0, 8)}`;
  const scope = strings(candidate.scope);
  const sourceRefs = strings(candidate.sourceRefs);
  const baseRecord: CanonicalKnowledgeRecord = {
    id: recordId,
    type,
    statement: candidate.statement ? String(candidate.statement) : '',
    scope,
    status: 'committed',
    trustTier: 'verified',
    projectId,
    sourceRunId: runId,
    revision,
  };

  const record = attachFreshness(baseRecord, {
    projectRoot,
    sourceRefs: sourceRefs.length > 0 ? sourceRefs : scope,
    confidence: typeof candidate.confidence === 'number'
      ? candidate.confidence
      : 0.9,
  }) as CanonicalKnowledgeRecord;

  if (type === 'required_verification') {
    const verification = candidate.verification ?? {};
    const evidenceLevel = ['work', 'integration', 'goal'].includes(
      String(verification.evidenceLevel || ''),
    )
      ? String(verification.evidenceLevel) as 'work' | 'integration' | 'goal'
      : null;
    const commandRefs = [
      ...strings(verification.commandRefs),
      ...(verification.commandRef ? [String(verification.commandRef)] : []),
    ];
    record.verification = {
      commandRefs: [...new Set(commandRefs)],
      method: verification.method ? String(verification.method) : null,
      evidenceLevel,
      receiptContractRef: verification.receiptContractRef
        ? String(verification.receiptContractRef)
        : null,
      freshnessInputs: [...new Set(strings(verification.freshnessInputs))],
    };
    record.receiptContractRef = record.verification.receiptContractRef;
    record.freshnessInputs = record.verification.freshnessInputs;
  }

  if (type === 'semantic_fact') {
    record.factJson = candidate.candidateJson || candidate;
  } else if (type === 'tacit_practice' || type === 'episodic_observation') {
    record.practiceJson = candidate.candidateJson || candidate;
  } else if (type === 'ontology_constraint') {
    record.constraintJson = candidate.candidateJson || candidate;
  } else if (
    type === 'failure_pattern'
    || type === 'known_failure_pattern'
  ) {
    record.failureJson = candidate.candidateJson || candidate;
  }

  return record;
}
