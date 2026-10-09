import crypto from 'node:crypto';

export const VALID_TYPES = [
  'policy_anchor',
  'semantic_fact',
  'architecture_decision',
  'domain_term',
  'component_boundary',
  'api_contract',
  'kg_relation',
  'ontology_constraint',
  'episodic_observation',
  'known_failure_pattern',
  'required_verification',
  'provenance_event',
  'knowledge_candidate',
];

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
};

export function resolveRecordType(proposedType) {
  return CANDIDATE_TO_RECORD_TYPE[proposedType] || proposedType || 'semantic_fact';
}

export const VALID_STATUSES = [
  'observed',
  'staged',
  'verified',
  'rejected',
  'committed',
  'superseded',
  'archived',
  'quarantined',
];

export const TRUST_TIERS = [
  'authoritative',
  'verified',
  'derived',
  'quarantined',
  'degraded',
];

export const TRUST_TIER_HIERARCHY = {
  authoritative: 5,
  verified: 4,
  derived: 3,
  quarantined: 2,
  degraded: 1,
};

export class KernelKnowledgeRecordError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'KernelKnowledgeRecordError';
    this.code = code;
    this.details = details;
  }
}

export class KernelKnowledgeTransitionError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'KernelKnowledgeTransitionError';
    this.code = code;
    this.details = details;
  }
}

export class KernelKnowledgeIsolationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'KernelKnowledgeIsolationError';
    this.code = code;
    this.details = details;
  }
}

export function validateKnowledgeRecord(record) {
  if (!record || typeof record !== 'object') {
    throw new KernelKnowledgeRecordError('INVALID_RECORD', 'Record must be a non-null object');
  }
  if (!record.id || typeof record.id !== 'string') {
    throw new KernelKnowledgeRecordError('MISSING_FIELD', 'Record missing id');
  }
  if (!record.projectId || typeof record.projectId !== 'string') {
    throw new KernelKnowledgeRecordError('MISSING_FIELD', 'Record missing projectId');
  }
  if (!VALID_TYPES.includes(record.type)) {
    throw new KernelKnowledgeRecordError('INVALID_TYPE', `Invalid record type: ${record.type}`);
  }
  if (!VALID_STATUSES.includes(record.status)) {
    throw new KernelKnowledgeRecordError('INVALID_STATUS', `Invalid record status: ${record.status}`);
  }
  if (!TRUST_TIERS.includes(record.trustTier)) {
    throw new KernelKnowledgeRecordError('INVALID_TRUST_TIER', `Invalid trust tier: ${record.trustTier}`);
  }
  if (record.type === 'semantic_fact' && (record.status === 'verified' || record.status === 'committed')) {
    if (!record.evidence || (Array.isArray(record.evidence) && record.evidence.length === 0) || (typeof record.evidence === 'object' && Object.keys(record.evidence).length === 0)) {
      throw new KernelKnowledgeRecordError('MISSING_EVIDENCE', 'Verified or committed semantic fact requires fresh verification evidence');
    }
  }
  if (record.trustTier === 'quarantined' && (record.status === 'committed' || record.status === 'verified')) {
    throw new KernelKnowledgeRecordError('QUARANTINE_PROMOTION_FORBIDDEN', 'Raw quarantined records cannot be automatically promoted to verified or committed status');
  }
  return true;
}

export function transitionStatus(record, targetStatus, { evidence = null, currentProjectId = null } = {}) {
  validateKnowledgeRecord(record);

  if (currentProjectId && record.projectId !== currentProjectId) {
    throw new KernelKnowledgeIsolationError('CROSS_PROJECT_MUTATION', `Cannot mutate record from foreign project: ${record.projectId} != ${currentProjectId}`);
  }

  if (!VALID_STATUSES.includes(targetStatus)) {
    throw new KernelKnowledgeTransitionError('INVALID_TARGET_STATUS', `Target status ${targetStatus} is not valid`);
  }

  const allowedTransitions = {
    observed: ['staged', 'rejected', 'quarantined'],
    staged: ['verified', 'rejected', 'archived'],
    verified: ['committed', 'superseded', 'rejected', 'archived'],
    committed: ['superseded', 'archived'],
    rejected: ['archived'],
    superseded: ['archived'],
    archived: [],
  };

  const allowed = allowedTransitions[record.status] || [];
  if (!allowed.includes(targetStatus)) {
    throw new KernelKnowledgeTransitionError(
      'FORBIDDEN_TRANSITION',
      `Cannot transition record from ${record.status} to ${targetStatus}`
    );
  }

  if (targetStatus === 'verified' || targetStatus === 'committed') {
    if (record.type === 'semantic_fact' && !evidence) {
      throw new KernelKnowledgeTransitionError('EVIDENCE_REQUIRED', `Transition to ${targetStatus} for semantic_fact requires verification evidence`);
    }
  }

  const now = new Date().toISOString();
  return {
    ...record,
    status: targetStatus,
    updatedAt: now,
    evidence: evidence || record.evidence,
  };
}

export function validateSupersession(records, targetId, supersedingId, { currentProjectId } = {}) {
  const target = records.find((r) => r.id === targetId);
  const superseding = records.find((r) => r.id === supersedingId);

  if (!target || !superseding) {
    throw new KernelKnowledgeRecordError('RECORD_NOT_FOUND', 'Target or superseding record not found');
  }

  if (currentProjectId && (target.projectId !== currentProjectId || superseding.projectId !== currentProjectId)) {
    throw new KernelKnowledgeIsolationError('CROSS_PROJECT_SUPERSEDING', 'Supersession across different projects is forbidden');
  }

  if (target.projectId !== superseding.projectId) {
    throw new KernelKnowledgeIsolationError('CROSS_PROJECT_SUPERSEDING', 'Supersession across different projects is forbidden');
  }

  const targetTierValue = TRUST_TIER_HIERARCHY[target.trustTier] || 0;
  const supersedingTierValue = TRUST_TIER_HIERARCHY[superseding.trustTier] || 0;

  if (supersedingTierValue < targetTierValue) {
    throw new KernelKnowledgeTransitionError('LOWER_TRUST_SUPERSEDING', 'Lower trust tier record cannot supersede higher trust tier record');
  }

  // Check cycle
  let curr = superseding;
  const visited = new Set([targetId]);
  while (curr && curr.supersedes) {
    for (const supId of curr.supersedes) {
      if (visited.has(supId)) {
        throw new KernelKnowledgeTransitionError('SUPERSEDED_CYCLE', `Supersession cycle detected: ${supId}`);
      }
      visited.add(supId);
      curr = records.find((r) => r.id === supId);
    }
  }

  return true;
}
