// Generated from schemas/kernel.git-closeout-receipt.schema.json. Edit the schema and run build:contracts.

export interface KernelGitCloseoutReceipt {
  schemaVersion: 1;
  runId: string;
  projectId: string;
  requestedMode: string;
  knowledgeCommitReceiptRef?: string;
  selectedPaths?: unknown[];
  excludedPaths?: unknown[];
  commitSha?: string;
  branch?: string;
  remote?: string;
  pushStatus?: 'skipped' | 'completed' | 'failed';
  remoteHeadSha?: string;
  parity?: 'matched' | 'mismatched' | 'not_requested';
  approvalReceipt?: string;
  status: 'completed' | 'partial' | 'failed' | 'skipped';
  digest: string;
  [k: string]: unknown | undefined;
}
