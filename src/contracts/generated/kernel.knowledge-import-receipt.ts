// Generated from schemas/kernel.knowledge-import-receipt.schema.json. Edit the schema and run build:contracts.

export interface KernelKnowledgeImportReceipt {
  schemaVersion: 1;
  importId: string;
  projectId: string;
  authorityType: 'user_approved_import';
  sourceType?: string;
  sourceIdentityDigest?: string;
  sourceDigest: string;
  candidateCount: number;
  acceptedCount: number;
  rejectedCount: number;
  supersededCount?: number;
  knowledgeRevisionBefore: number;
  knowledgeRevisionAfter: number;
  approvalRef: string;
  status: 'committed' | 'partial' | 'no_op';
  [k: string]: unknown | undefined;
}
