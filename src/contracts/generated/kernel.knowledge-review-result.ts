// Generated from schemas/kernel.knowledge-review-result.schema.json. Edit the schema and run build:contracts.

export interface KernelKnowledgeReviewResult {
  status: 'failed' | 'no_candidates' | 'passed' | 'needs_approval' | 'pending_verification';
  verifiedCandidates: {
    candidateId?: string;
    projectId?: string;
    statement?: string;
    scope?: string[];
    status?: string;
    rejectionReasons?: string[];
    evidenceRefs?: string[];
    acceptanceIds?: string[];
    obligationIds?: string[];
    evidenceBinding?: {
      acceptanceIds?: string[];
      obligationIds?: string[];
      evidenceRefs?: string[];
      [k: string]: unknown | undefined;
    };
    sourceKind?: string;
    sourceDigest?: string;
    obligationId?: string;
    [k: string]: unknown | undefined;
  }[];
  rejectedCandidates: {
    candidateId?: string;
    projectId?: string;
    statement?: string;
    scope?: string[];
    status?: string;
    rejectionReasons?: string[];
    evidenceRefs?: string[];
    acceptanceIds?: string[];
    obligationIds?: string[];
    evidenceBinding?: {
      acceptanceIds?: string[];
      obligationIds?: string[];
      evidenceRefs?: string[];
      [k: string]: unknown | undefined;
    };
    sourceKind?: string;
    sourceDigest?: string;
    obligationId?: string;
    [k: string]: unknown | undefined;
  }[];
  needsApprovalCandidates: {
    candidateId?: string;
    projectId?: string;
    statement?: string;
    scope?: string[];
    status?: string;
    rejectionReasons?: string[];
    evidenceRefs?: string[];
    acceptanceIds?: string[];
    obligationIds?: string[];
    evidenceBinding?: {
      acceptanceIds?: string[];
      obligationIds?: string[];
      evidenceRefs?: string[];
      [k: string]: unknown | undefined;
    };
    sourceKind?: string;
    sourceDigest?: string;
    obligationId?: string;
    [k: string]: unknown | undefined;
  }[];
  pendingVerificationCandidates: {
    candidateId?: string;
    projectId?: string;
    statement?: string;
    scope?: string[];
    status?: string;
    rejectionReasons?: string[];
    evidenceRefs?: string[];
    acceptanceIds?: string[];
    obligationIds?: string[];
    evidenceBinding?: {
      acceptanceIds?: string[];
      obligationIds?: string[];
      evidenceRefs?: string[];
      [k: string]: unknown | undefined;
    };
    sourceKind?: string;
    sourceDigest?: string;
    obligationId?: string;
    [k: string]: unknown | undefined;
  }[];
  candidateReviews: {
    candidateId?: string;
    decision: string;
    reason?: string;
    evidenceRef?: string;
    [k: string]: unknown | undefined;
  }[];
  supersessionProposals: {
    [k: string]: unknown | undefined;
  }[];
  ontologyViolations: {
    id?: string;
    type?: string;
    recordType?: string;
    status?: string;
    scope?: string[];
    pattern?: null | string;
    severity?: null | string;
    statement?: null | string;
    [k: string]: unknown | undefined;
  }[];
  approvalRequired: {
    id?: string;
    type?: string;
    recordType?: string;
    status?: string;
    scope?: string[];
    pattern?: null | string;
    severity?: null | string;
    statement?: null | string;
    [k: string]: unknown | undefined;
  }[];
  verificationsRequired: {
    id?: string;
    type?: string;
    recordType?: string;
    status?: string;
    scope?: string[];
    pattern?: null | string;
    severity?: null | string;
    statement?: null | string;
    [k: string]: unknown | undefined;
  }[];
  evidenceCoverage: string[];
}
