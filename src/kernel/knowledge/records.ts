import type { KernelKnowledgeRecord } from '../../contracts/generated/kernel.knowledge-record.js';
import { KERNEL_CONTRACT_ENUMS } from '../../contracts/schema-definitions.generated.js';
type ErrorDetails = Record<string, unknown>;

export const VALID_TYPES = KERNEL_CONTRACT_ENUMS['kernel.knowledge-record'].type;

export type KnowledgeRecordType = (typeof VALID_TYPES)[number];

export const CANDIDATE_TO_RECORD_TYPE = {
  semantic_fact: 'semantic_fact',
  architecture_decision: 'architecture_decision',
  domain_term: 'domain_term',
  component_boundary: 'component_boundary',
  api_contract: 'api_contract',
  kg_relation: 'kg_relation',
  ontology_constraint: 'ontology_constraint',
  tacit_observation: 'episodic_observation',
  tacit_practice: 'episodic_observation',
  known_failure_pattern: 'known_failure_pattern',
  required_verification: 'required_verification',
} as const satisfies Record<string, KnowledgeRecordType>;

export function resolveRecordType(proposedType: unknown): string {
  const normalized = proposedType ? String(proposedType) : '';
  return CANDIDATE_TO_RECORD_TYPE[
    normalized as keyof typeof CANDIDATE_TO_RECORD_TYPE
  ] || normalized || 'semantic_fact';
}

export const VALID_STATUSES = KERNEL_CONTRACT_ENUMS['kernel.knowledge-record'].status;

export type KnowledgeRecordStatus = (typeof VALID_STATUSES)[number];

export const TRUST_TIERS = KERNEL_CONTRACT_ENUMS['kernel.knowledge-record'].trustTier;

export type KnowledgeTrustTier = (typeof TRUST_TIERS)[number];

export const TRUST_TIER_HIERARCHY: Readonly<Record<KnowledgeTrustTier, number>> = {
  authoritative: 5,
  verified: 4,
  derived: 3,
  quarantined: 2,
  degraded: 1,
};

// Internal identity/status projection. The full wire DTO is generated from its schema.
export type KnowledgeRecord = Pick<KernelKnowledgeRecord, 'id' | 'projectId' | 'type' | 'status' | 'trustTier'>
  & Partial<Pick<KernelKnowledgeRecord, 'evidence' | 'supersedes' | 'updatedAt'>> & Record<string, unknown>;

export interface SupersessionRecord {
  id: string;
  projectId?: string | null;
  trustTier?: string | null;
  supersedes?: string[];
  [key: string]: unknown;
}

export class KernelKnowledgeRecordError extends Error {
  readonly code: string;
  readonly details: ErrorDetails;

  constructor(
    code: string,
    message: string,
    details: ErrorDetails = {},
  ) {
    super(message);
    this.name = 'KernelKnowledgeRecordError';
    this.code = code;
    this.details = details;
  }
}

export class KernelKnowledgeTransitionError extends Error {
  readonly code: string;
  readonly details: ErrorDetails;

  constructor(
    code: string,
    message: string,
    details: ErrorDetails = {},
  ) {
    super(message);
    this.name = 'KernelKnowledgeTransitionError';
    this.code = code;
    this.details = details;
  }
}

export class KernelKnowledgeIsolationError extends Error {
  readonly code: string;
  readonly details: ErrorDetails;

  constructor(
    code: string,
    message: string,
    details: ErrorDetails = {},
  ) {
    super(message);
    this.name = 'KernelKnowledgeIsolationError';
    this.code = code;
    this.details = details;
  }
}

const isRecordType = (value: unknown): value is KnowledgeRecordType => (
  VALID_TYPES.includes(value as KnowledgeRecordType)
);

const isRecordStatus = (value: unknown): value is KnowledgeRecordStatus => (
  VALID_STATUSES.includes(value as KnowledgeRecordStatus)
);

const isTrustTier = (value: unknown): value is KnowledgeTrustTier => (
  TRUST_TIERS.includes(value as KnowledgeTrustTier)
);

const hasEvidence = (value: unknown): boolean => {
  if (!value) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
};

export function validateKnowledgeRecord(
  record: unknown,
): record is KnowledgeRecord {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new KernelKnowledgeRecordError(
      'INVALID_RECORD',
      'Record must be a non-null object',
    );
  }

  const candidate = record as Record<string, unknown>;
  if (!candidate.id || typeof candidate.id !== 'string') {
    throw new KernelKnowledgeRecordError(
      'MISSING_FIELD',
      'Record missing id',
    );
  }
  if (!candidate.projectId || typeof candidate.projectId !== 'string') {
    throw new KernelKnowledgeRecordError(
      'MISSING_FIELD',
      'Record missing projectId',
    );
  }
  if (!isRecordType(candidate.type)) {
    throw new KernelKnowledgeRecordError(
      'INVALID_TYPE',
      `Invalid record type: ${String(candidate.type)}`,
    );
  }
  if (!isRecordStatus(candidate.status)) {
    throw new KernelKnowledgeRecordError(
      'INVALID_STATUS',
      `Invalid record status: ${String(candidate.status)}`,
    );
  }
  if (!isTrustTier(candidate.trustTier)) {
    throw new KernelKnowledgeRecordError(
      'INVALID_TRUST_TIER',
      `Invalid trust tier: ${String(candidate.trustTier)}`,
    );
  }

  if (
    candidate.type === 'semantic_fact'
    && (candidate.status === 'verified' || candidate.status === 'committed')
    && !hasEvidence(candidate.evidence)
  ) {
    throw new KernelKnowledgeRecordError(
      'MISSING_EVIDENCE',
      'Verified or committed semantic fact requires fresh verification evidence',
    );
  }

  if (
    candidate.trustTier === 'quarantined'
    && (candidate.status === 'committed' || candidate.status === 'verified')
  ) {
    throw new KernelKnowledgeRecordError(
      'QUARANTINE_PROMOTION_FORBIDDEN',
      'Raw quarantined records cannot be automatically promoted to verified or committed status',
    );
  }
  return true;
}

const ALLOWED_TRANSITIONS: Readonly<
  Record<KnowledgeRecordStatus, readonly KnowledgeRecordStatus[]>
> = {
  observed: ['staged', 'rejected', 'quarantined'],
  staged: ['verified', 'rejected', 'archived'],
  verified: ['committed', 'superseded', 'rejected', 'archived'],
  committed: ['superseded', 'archived'],
  rejected: ['archived'],
  superseded: ['archived'],
  archived: [],
  quarantined: [],
};

export function transitionStatus(
  record: unknown,
  targetStatus: unknown,
  {
    evidence = null,
    currentProjectId = null,
  }: {
    evidence?: unknown;
    currentProjectId?: string | null;
  } = {},
): KnowledgeRecord {
  if (!validateKnowledgeRecord(record)) {
    throw new KernelKnowledgeRecordError(
      'INVALID_RECORD',
      'Record must be a non-null object',
    );
  }

  if (currentProjectId && record.projectId !== currentProjectId) {
    throw new KernelKnowledgeIsolationError(
      'CROSS_PROJECT_MUTATION',
      `Cannot mutate record from foreign project: ${record.projectId} != ${currentProjectId}`,
    );
  }

  if (!isRecordStatus(targetStatus)) {
    throw new KernelKnowledgeTransitionError(
      'INVALID_TARGET_STATUS',
      `Target status ${String(targetStatus)} is not valid`,
    );
  }

  const allowed = ALLOWED_TRANSITIONS[record.status];
  if (!allowed.includes(targetStatus)) {
    throw new KernelKnowledgeTransitionError(
      'FORBIDDEN_TRANSITION',
      `Cannot transition record from ${record.status} to ${targetStatus}`,
    );
  }

  if (
    (targetStatus === 'verified' || targetStatus === 'committed')
    && record.type === 'semantic_fact'
    && !evidence
  ) {
    throw new KernelKnowledgeTransitionError(
      'EVIDENCE_REQUIRED',
      `Transition to ${targetStatus} for semantic_fact requires verification evidence`,
    );
  }

  return {
    ...record,
    status: targetStatus,
    updatedAt: new Date().toISOString(),
    evidence: evidence || record.evidence,
  };
}

export function validateSupersession<T extends SupersessionRecord>(
  records: readonly T[],
  targetId: string,
  supersedingId: string,
  {
    currentProjectId = null,
  }: {
    currentProjectId?: string | null;
  } = {},
): true {
  const target = records.find((record) => record.id === targetId);
  const superseding = records.find((record) => record.id === supersedingId);

  if (!target || !superseding) {
    throw new KernelKnowledgeRecordError(
      'RECORD_NOT_FOUND',
      'Target or superseding record not found',
    );
  }

  if (
    currentProjectId
    && (
      target.projectId !== currentProjectId
      || superseding.projectId !== currentProjectId
    )
  ) {
    throw new KernelKnowledgeIsolationError(
      'CROSS_PROJECT_SUPERSEDING',
      'Supersession across different projects is forbidden',
    );
  }

  if (target.projectId !== superseding.projectId) {
    throw new KernelKnowledgeIsolationError(
      'CROSS_PROJECT_SUPERSEDING',
      'Supersession across different projects is forbidden',
    );
  }

  const targetTierValue = TRUST_TIER_HIERARCHY[
    target.trustTier as KnowledgeTrustTier
  ] || 0;
  const supersedingTierValue = TRUST_TIER_HIERARCHY[
    superseding.trustTier as KnowledgeTrustTier
  ] || 0;

  if (supersedingTierValue < targetTierValue) {
    throw new KernelKnowledgeTransitionError(
      'LOWER_TRUST_SUPERSEDING',
      'Lower trust tier record cannot supersede higher trust tier record',
    );
  }

  let current: T | undefined = superseding;
  const visited = new Set<string>([targetId]);
  while (current?.supersedes) {
    for (const supersededId of current.supersedes) {
      if (visited.has(supersededId)) {
        throw new KernelKnowledgeTransitionError(
          'SUPERSEDED_CYCLE',
          `Supersession cycle detected: ${supersededId}`,
        );
      }
      visited.add(supersededId);
      current = records.find((record) => record.id === supersededId);
    }
  }

  return true;
}
