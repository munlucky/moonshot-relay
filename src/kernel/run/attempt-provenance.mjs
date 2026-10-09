// Canonical work-attempt provenance (WP-1/WP-2).
//
// `run_step_attempts` is the durable authority for one unit of work. The
// retired run-level `attempts` table is removed during migration. Capsule,
// route, usage, and retry lineage use the canonical Work attempt exclusively.

import { randomUUID } from 'node:crypto';

export const ATTEMPT_PROVENANCE_KINDS = Object.freeze([
  'routed',
  'owner-session',
  'kernel-owned',
  'legacy-unattributed',
]);

export const ATTEMPT_STATUSES = Object.freeze([
  'started',
  'passed',
  'failed',
  'interrupted',
  'superseded',
  'cancelled',
]);

export const ATTEMPT_ID_PATTERN = /^attempt-[a-f0-9-]{8,96}$/;

export const buildAttemptId = () => `attempt-${randomUUID()}`;

const optionalString = (value) => value === null || value === undefined || value === '' ? null : String(value);

export const normalizeAttemptProvenance = (input = {}) => {
  const provenanceKind = input.provenanceKind || 'legacy-unattributed';
  if (!ATTEMPT_PROVENANCE_KINDS.includes(provenanceKind)) {
    throw new Error(`attempt provenance_kind must be one of: ${ATTEMPT_PROVENANCE_KINDS.join(', ')}`);
  }
  const legacy = provenanceKind === 'legacy-unattributed';
  const attemptId = legacy
    ? optionalString(input.attemptId)
    : input.attemptId ? String(input.attemptId) : buildAttemptId();
  if (legacy && attemptId) throw new Error('legacy-unattributed attempts cannot claim an attemptId');
  if (attemptId && !ATTEMPT_ID_PATTERN.test(attemptId)) throw new Error('attemptId must match attempt-<hex-or-uuid>');
  return {
    attemptId,
    bindingId: optionalString(input.bindingId),
    capsuleId: optionalString(input.capsuleId),
    capsuleDigest: optionalString(input.capsuleDigest),
    admissionId: optionalString(input.admissionId),
    parentAttemptId: optionalString(input.parentAttemptId),
    provenanceKind,
    planRevision: legacy ? null : Number.isInteger(input.planRevision) && input.planRevision > 0 ? input.planRevision : 1,
    mutationRevision: legacy ? null : Number.isInteger(input.mutationRevision) && input.mutationRevision >= 0 ? input.mutationRevision : 0,
    retryReason: optionalString(input.retryReason),
    failureCategory: optionalString(input.failureCategory),
  };
};

// The check is intentionally field-oriented so callers can report a precise
// refusal before executing a provider or verification command.
export const attemptLineageMismatches = (attempt, expected = {}) => {
  const mismatches = [];
  if (!attempt) return ['attempt-missing'];
  for (const field of ['runId', 'stepId', 'attemptId', 'bindingId', 'capsuleId', 'admissionId', 'parentAttemptId', 'provenanceKind']) {
    if (expected[field] === undefined || expected[field] === null) continue;
    if (attempt[field] !== expected[field]) mismatches.push(`${field}-mismatch`);
  }
  for (const field of ['planRevision', 'mutationRevision']) {
    if (expected[field] === undefined || expected[field] === null) continue;
    if (Number(attempt[field]) !== Number(expected[field])) mismatches.push(`${field}-mismatch`);
  }
  if (expected.capsuleDigest && attempt.capsuleDigest !== expected.capsuleDigest) mismatches.push('capsule-digest-mismatch');
  if (expected.usageReceiptId && attempt.usageReceiptId !== expected.usageReceiptId) mismatches.push('usage-receipt-mismatch');
  return mismatches;
};

export const assertAttemptLineage = (attempt, expected = {}) => {
  const mismatches = attemptLineageMismatches(attempt, expected);
  if (mismatches.length > 0) {
    const error = new Error(`attempt_lineage_incomplete: ${mismatches.join(', ')}`);
    error.code = 'attempt_lineage_incomplete';
    error.mismatches = mismatches;
    throw error;
  }
  return attempt;
};
