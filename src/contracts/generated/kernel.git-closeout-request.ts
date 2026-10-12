// Generated from schemas/kernel.git-closeout-request.schema.json. Edit the schema and run build:contracts.

export interface KernelGitCloseoutRequest {
  requested: boolean;
  mode: 'commit' | 'commit_and_push';
  approvedBy: string;
  approvalReceipt: string;
  /**
   * Optional commit subject and body. The Kernel appends task context to the requested message.
   */
  message?: string;
  [k: string]: unknown | undefined;
}
