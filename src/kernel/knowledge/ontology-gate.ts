export interface KnowledgeCandidateLike {
  candidateId: string;
}

export interface OntologyConstraintLike {
  status?: string | null;
  constraintJson?: { rule?: string | null; [key: string]: unknown } | null;
  severity?: string | null;
  id?: string | null;
  constraintId?: string | null;
}

export interface ApprovalLike {
  candidateId?: string | null;
  approvalReceipt?: unknown;
}

export interface ObligationLike {
  obligationId?: string | null;
  status?: string | null;
}

export interface OntologyGateInput {
  candidate: KnowledgeCandidateLike;
  ontologyConstraints?: OntologyConstraintLike[];
  approvals?: ApprovalLike[];
  obligations?: ObligationLike[];
}

export function gateOntologyConstraints({
  candidate,
  ontologyConstraints = [],
  approvals = [],
  obligations = [],
}: OntologyGateInput) {
  const blockers: Array<Record<string, string>> = [];
  let candidateStatus = 'verified';

  for (const constraint of ontologyConstraints) {
    if (constraint.status === 'superseded' || constraint.status === 'rejected') continue;
    const rule = constraint.constraintJson?.rule || constraint.severity || 'ask_first';
    const constraintId = constraint.id || constraint.constraintId || 'ont-1';

    if (rule === 'never') {
      candidateStatus = 'rejected';
      blockers.push({ candidateId: candidate.candidateId, type: 'never_violation', constraintId });
    } else if (rule === 'ask_first') {
      const isApproved = approvals.some((approval) => (
        approval.candidateId === candidate.candidateId && Boolean(approval.approvalReceipt)
      ));
      if (!isApproved) {
        candidateStatus = 'needs_approval';
        blockers.push({ candidateId: candidate.candidateId, type: 'needs_approval', constraintId });
      }
    } else if (rule === 'invariant' || rule === 'always') {
      const obligationId = `ob-inv-${constraintId}`;
      const matchedObligation = obligations.find((obligation) => obligation.obligationId === obligationId);
      if (!matchedObligation || matchedObligation.status !== 'passed') {
        candidateStatus = 'pending_verification';
        blockers.push({
          candidateId: candidate.candidateId,
          type: 'invariant_unfulfilled',
          obligationId,
        });
      }
    }
  }

  return { status: candidateStatus, blockers };
}
