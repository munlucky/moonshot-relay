// Generated from schemas/kernel.review-capsule.schema.json. Edit the schema and run build:contracts.

export interface KernelReviewCapsule {
  capsuleId: string;
  provenance: {
    capsuleDigest: string;
    workspaceIdentity: string;
    sourceIdentity: null | string;
    routeDecisionId: null | string;
    createdByVersion: string;
    migrationOrigin: null | string;
  };
  createdAt: string;
  schemaVersion: 1;
  runId: string;
  stepId: null | string;
  role: 'reviewer';
  riskTier: string;
  planRevision: number;
  objective: string;
  acceptance: {
    id: string;
    statement: string;
    obligationIds: string[];
  }[];
  subject: {
    changedPaths: string[];
    diffDigest: null | string;
    workspaceIdentity: string;
    mutationRevision: number;
  };
  verificationEvidence: {
    obligationId: string;
    status: string;
    evidenceDigest: null | string;
    command: null | string;
    exitCode: null | number;
  }[];
  implementationReceipt: {
    actorSessionId: null | string;
    attemptId: null | string;
    capsuleDigest: null | string;
    modelClass: null | string;
    resolvedModel: null | string;
  };
  reviewScope: {
    stage: 'contract' | 'engineering' | 'complexity';
    requiredChecks: string[];
    obligationId: null | string;
  };
  permissions: {
    filesystem: 'read_only';
    network: string;
    canDelegate: boolean;
    canCommit: boolean;
  };
}
