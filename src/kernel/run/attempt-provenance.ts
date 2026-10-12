// Canonical work-attempt provenance (WP-1/WP-2).
//
// run_step_attempts is the durable authority for one unit of work. Capsule,
// route, usage, and retry lineage use this canonical Work attempt exclusively.

import { randomUUID } from 'node:crypto';

export const ATTEMPT_PROVENANCE_KINDS = Object.freeze([
  'routed',
  'owner-session',
  'kernel-owned',
  'legacy-unattributed',
] as const);

export const ATTEMPT_STATUSES = Object.freeze([
  'started',
  'passed',
  'failed',
  'interrupted',
  'superseded',
  'cancelled',
] as const);

export type AttemptProvenanceKind = typeof ATTEMPT_PROVENANCE_KINDS[number];
export type AttemptStatus = typeof ATTEMPT_STATUSES[number];

export const ATTEMPT_ID_PATTERN = /^attempt-[a-f0-9-]{8,96}$/;

export interface AttemptProvenanceInput {
  attemptId?: unknown;
  bindingId?: unknown;
  capsuleId?: unknown;
  capsuleDigest?: unknown;
  admissionId?: unknown;
  parentAttemptId?: unknown;
  provenanceKind?: unknown;
  planRevision?: unknown;
  mutationRevision?: unknown;
  retryReason?: unknown;
  failureCategory?: unknown;
}

export interface AttemptLineageRecord extends Record<string, unknown> {
  runId?: unknown;
  stepId?: unknown;
  attemptId?: unknown;
  bindingId?: unknown;
  capsuleId?: unknown;
  capsuleDigest?: unknown;
  admissionId?: unknown;
  parentAttemptId?: unknown;
  provenanceKind?: unknown;
  planRevision?: unknown;
  mutationRevision?: unknown;
  usageReceiptId?: unknown;
}

export interface NormalizedAttemptProvenance {
  attemptId: string | null;
  bindingId: string | null;
  capsuleId: string | null;
  capsuleDigest: string | null;
  admissionId: string | null;
  parentAttemptId: string | null;
  provenanceKind: AttemptProvenanceKind;
  planRevision: number | null;
  mutationRevision: number | null;
  retryReason: string | null;
  failureCategory: string | null;
}

export class AttemptLineageError extends Error {
  readonly code = 'attempt_lineage_incomplete';

  constructor(readonly mismatches: string[]) {
    super(`attempt_lineage_incomplete: ${mismatches.join(', ')}`);
    this.name = 'AttemptLineageError';
  }
}

export const buildAttemptId = (): string => `attempt-${randomUUID()}`;

const optionalString = (value: unknown): string | null => (
  value === null || value === undefined || value === '' ? null : String(value)
);

const isAttemptProvenanceKind = (value: unknown): value is AttemptProvenanceKind => (
  typeof value === 'string'
  && (ATTEMPT_PROVENANCE_KINDS as readonly string[]).includes(value)
);

export const normalizeAttemptProvenance = (
  input: AttemptProvenanceInput = {},
): NormalizedAttemptProvenance => {
  const provenanceKind = input.provenanceKind || 'legacy-unattributed';
  if (!isAttemptProvenanceKind(provenanceKind)) {
    throw new Error(`attempt provenance_kind must be one of: ${ATTEMPT_PROVENANCE_KINDS.join(', ')}`);
  }
  const legacy = provenanceKind === 'legacy-unattributed';
  const attemptId = legacy
    ? optionalString(input.attemptId)
    : input.attemptId ? String(input.attemptId) : buildAttemptId();
  if (legacy && attemptId) throw new Error('legacy-unattributed attempts cannot claim an attemptId');
  if (attemptId && !ATTEMPT_ID_PATTERN.test(attemptId)) {
    throw new Error('attemptId must match attempt-<hex-or-uuid>');
  }

  const planRevision = typeof input.planRevision === 'number' ? input.planRevision : Number.NaN;
  const mutationRevision = typeof input.mutationRevision === 'number' ? input.mutationRevision : Number.NaN;

  return {
    attemptId,
    bindingId: optionalString(input.bindingId),
    capsuleId: optionalString(input.capsuleId),
    capsuleDigest: optionalString(input.capsuleDigest),
    admissionId: optionalString(input.admissionId),
    parentAttemptId: optionalString(input.parentAttemptId),
    provenanceKind,
    planRevision: legacy ? null : Number.isInteger(planRevision) && planRevision > 0 ? planRevision : 1,
    mutationRevision: legacy ? null : Number.isInteger(mutationRevision) && mutationRevision >= 0 ? mutationRevision : 0,
    retryReason: optionalString(input.retryReason),
    failureCategory: optionalString(input.failureCategory),
  };
};

const IDENTITY_FIELDS = [
  'runId',
  'stepId',
  'attemptId',
  'bindingId',
  'capsuleId',
  'admissionId',
  'parentAttemptId',
  'provenanceKind',
] as const;

const REVISION_FIELDS = ['planRevision', 'mutationRevision'] as const;

export const attemptLineageMismatches = (
  attempt: AttemptLineageRecord | null | undefined,
  expected: AttemptLineageRecord = {},
): string[] => {
  const mismatches: string[] = [];
  if (!attempt) return ['attempt-missing'];

  for (const field of IDENTITY_FIELDS) {
    if (expected[field] === undefined || expected[field] === null) continue;
    if (attempt[field] !== expected[field]) mismatches.push(`${field}-mismatch`);
  }
  for (const field of REVISION_FIELDS) {
    if (expected[field] === undefined || expected[field] === null) continue;
    if (Number(attempt[field]) !== Number(expected[field])) mismatches.push(`${field}-mismatch`);
  }
  if (expected.capsuleDigest && attempt.capsuleDigest !== expected.capsuleDigest) {
    mismatches.push('capsule-digest-mismatch');
  }
  if (expected.usageReceiptId && attempt.usageReceiptId !== expected.usageReceiptId) {
    mismatches.push('usage-receipt-mismatch');
  }
  return mismatches;
};

export const assertAttemptLineage = <T extends AttemptLineageRecord>(
  attempt: T | null | undefined,
  expected: AttemptLineageRecord = {},
): T => {
  const mismatches = attemptLineageMismatches(attempt, expected);
  if (mismatches.length > 0) throw new AttemptLineageError(mismatches);
  return attempt as T;
};
