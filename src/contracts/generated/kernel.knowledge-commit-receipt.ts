// Generated from schemas/kernel.knowledge-commit-receipt.schema.json. Edit the schema and run build:contracts.

export interface KernelKnowledgeCommitReceipt {
  schemaVersion: 1;
  sourceIdentity: string;
  mutationRevision: number;
  completionDecisionRef: string;
  acceptedCandidates: unknown[];
  rejectedCandidates: unknown[];
  supersededRecords: unknown[];
  evidenceRefs: unknown[];
  filesWritten: unknown[];
  projectionStatus: string;
  status: string;
  digest: string;
  runId: string;
  projectId: string;
  revisionBefore: string | number;
  revisionAfter: string | number;
}
