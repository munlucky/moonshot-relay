import { parseKernelContract } from '../../contracts/schema-codec.js';
import type { KernelKnowledgeCommitReceipt } from '../../contracts/generated/kernel.knowledge-commit-receipt.js';
import crypto from 'node:crypto';

export interface KnowledgeCommitReceiptInput {
  runId: string;
  projectId: string;
  sourceIdentity?: string;
  mutationRevision?: number;
  completionDecisionRef?: string | null;
  revisionBefore: string | number;
  revisionAfter: string | number;
  acceptedCandidates?: unknown[];
  rejectedCandidates?: unknown[];
  supersededRecords?: unknown[];
  evidenceRefs?: unknown[];
  filesWritten?: unknown[];
  projectionStatus?: string;
  status?: string;
}

export type KnowledgeCommitReceipt = KernelKnowledgeCommitReceipt;

export function buildKnowledgeCommitReceipt({
  runId,
  projectId,
  sourceIdentity = 'kernel-source-identity',
  mutationRevision = 1,
  completionDecisionRef = null,
  revisionBefore,
  revisionAfter,
  acceptedCandidates = [],
  rejectedCandidates = [],
  supersededRecords = [],
  evidenceRefs = [],
  filesWritten = [],
  projectionStatus = 'completed',
  status = 'committed',
}: KnowledgeCommitReceiptInput): KnowledgeCommitReceipt {
  const payload = {
    schemaVersion: 1 as const,
    runId,
    projectId,
    sourceIdentity,
    mutationRevision,
    completionDecisionRef: completionDecisionRef || `accepted-${runId}`,
    revisionBefore,
    revisionAfter,
    acceptedCandidates,
    rejectedCandidates,
    supersededRecords,
    evidenceRefs,
    filesWritten,
    projectionStatus,
    status,
  };

  const digest = crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  return parseKernelContract('kernel.knowledge-commit-receipt', { ...payload, digest });
}
