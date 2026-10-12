// Generated from schemas/kernel.knowledge-import.schema.json. Edit the schema and run build:contracts.

export interface KernelKnowledgeImport {
  importId: string;
  projectId: string;
  sourceType:
    | 'kernel_run'
    | 'codex_session'
    | 'claude_session'
    | 'provider_session'
    | 'codebase_index'
    | 'git_commit'
    | 'pull_request'
    | 'manual_statement';
  sourceIdentity: string;
  sourceDigest: string;
  sourceSnapshotRef?: string | null;
  status:
    | 'discovered'
    | 'analyzed'
    | 'awaiting_review'
    | 'approved'
    | 'committed'
    | 'partial'
    | 'rejected'
    | 'failed'
    | 'no_op';
  candidateCount: number;
  acceptedCount: number;
  rejectedCount: number;
  approvalRef?: string | null;
  revisionBefore?: number | null;
  revisionAfter?: number | null;
  createdAt: string;
  completedAt?: string | null;
  [k: string]: unknown | undefined;
}
