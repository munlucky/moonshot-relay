export function gateOntologyConstraints({ candidate, ontologyConstraints = [], approvals = [], obligations = [] } = {}) {
  const blockers = [];
  let candidateStatus = 'verified';

  for (const constraint of ontologyConstraints) {
    if (constraint.status === 'superseded' || constraint.status === 'rejected') continue;
    const rule = constraint.constraintJson?.rule || constraint.severity || 'ask_first';
    const constraintId = constraint.id || constraint.constraintId || 'ont-1';

    if (rule === 'never') {
      candidateStatus = 'rejected';
      blockers.push({ candidateId: candidate.candidateId, type: 'never_violation', constraintId });
    } else if (rule === 'ask_first') {
      const isApproved = approvals.some((a) => a.candidateId === candidate.candidateId && a.approvalReceipt);
      if (!isApproved) {
        candidateStatus = 'needs_approval';
        blockers.push({ candidateId: candidate.candidateId, type: 'needs_approval', constraintId });
      }
    } else if (rule === 'invariant' || rule === 'always') {
      const obligationId = `ob-inv-${constraintId}`;
      const matchedOb = obligations.find((o) => o.obligationId === obligationId);
      if (!matchedOb || matchedOb.status !== 'passed') {
        candidateStatus = 'pending_verification';
        blockers.push({ candidateId: candidate.candidateId, type: 'invariant_unfulfilled', obligationId });
      }
    }
  }

  return { status: candidateStatus, blockers };
}
