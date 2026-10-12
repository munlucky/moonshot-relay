// Generated from schemas/kernel.attempt-provenance.schema.json. Edit the schema and run build:contracts.

/**
 * The durable lineage for one run step attempt. Legacy-unattributed rows are retained without guessed provenance.
 */
export type KernelAttemptProvenance = {
  schemaVersion: 1;
  attemptId?: string | null;
  runId: string;
  stepId: string;
  bindingId?: string | null;
  capsuleId?: string | null;
  capsuleDigest?: string | null;
  admissionId?: string | null;
  parentAttemptId?: string | null;
  provenanceKind: 'routed' | 'owner-session' | 'kernel-owned' | 'legacy-unattributed';
  planRevision?: number | null;
  mutationRevision?: number | null;
  retryReason?: string | null;
  failureCategory?: string | null;
  status: 'started' | 'passed' | 'failed' | 'interrupted' | 'superseded' | 'cancelled';
};
