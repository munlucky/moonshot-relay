// Generated from schemas/kernel.review-receipt.schema.json. Edit the schema and run build:contracts.

export interface KernelReviewReceipt {
  schemaVersion: 1;
  receiptId: string;
  runId: string;
  obligationId: string;
  stepId: null | string;
  reviewerBindingId: null | string;
  implementerAttemptId: null | string;
  reviewStage: 'contract' | 'engineering' | 'complexity';
  verdict: 'pass' | 'fail' | 'changes-requested';
  findingClass: 'none' | 'minor' | 'important' | 'critical';
  planRevision: number;
  reviewer: {
    actorSessionId: string;
    usageReceiptId: null | string;
    routeDecisionId: null | string;
    modelClass: string;
    resolvedModel: null | string;
    enforcementStatus:
      'enforced' | 'fallback' | 'advisory' | 'unsupported' | 'failed' | 'unrouted' | 'operator_approved';
    approvalRefDigest: null | string;
  };
  implementer: {
    actorSessionId: null | string;
    usageReceiptId: null | string;
  };
  subject: {
    workspaceIdentity: string;
    mutationRevision: number;
    changedPathsDigest: string;
    evidenceDigest: string;
  };
  acceptanceCoverage: string[];
  findings: unknown[];
  rationale: string;
  createdByVersion: string;
  migrationOrigin: null | string;
  createdAt: string;
  digest: string;
}
