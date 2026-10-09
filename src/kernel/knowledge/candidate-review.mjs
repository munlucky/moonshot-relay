import { evaluateOntologyConstraints } from './ontology-evaluate.mjs';

export async function reviewKnowledgeCandidates({
  candidates = [],
  projectId,
  runId = null,
  stateStore = null,
  evidencePack = null,
  allowLegacyEvidencePackFallback = stateStore === null,
  env = process.env,
} = {}) {
  if (!candidates || candidates.length === 0) {
    return {
      status: 'no_candidates',
      verifiedCandidates: [],
      rejectedCandidates: [],
      needsApprovalCandidates: [],
      pendingVerificationCandidates: [],
      candidateReviews: [],
      supersessionProposals: [],
      ontologyViolations: [],
      approvalRequired: [],
      verificationsRequired: [],
      evidenceCoverage: [],
    };
  }

  const verifiedCandidates = [];
  const rejectedCandidates = [];
  const needsApprovalCandidates = [];
  const pendingVerificationCandidates = [];
  const ontologyViolations = [];
  const approvalRequired = [];
  const verificationsRequired = [];
  const candidateReviews = [];

  for (const candidate of candidates) {
    // 1. Project ID boundary check
    if (candidate.projectId && candidate.projectId !== projectId) {
      const rec = { ...candidate, status: 'rejected', rejectionReasons: ['PROJECT_ID_MISMATCH'] };
      rejectedCandidates.push(rec);
      candidateReviews.push({ candidateId: candidate.candidateId, decision: 'rejected', reason: 'PROJECT_ID_MISMATCH' });
      continue;
    }

    // 2. Safety check: secret leak
    if (/sk-[a-zA-Z0-9]{20,}/.test(candidate.statement) || (candidate.statement && candidate.statement.includes('raw_transcript_body'))) {
      const rec = { ...candidate, status: 'rejected', rejectionReasons: ['FORBIDDEN_SAFETY_LEAK'] };
      rejectedCandidates.push(rec);
      candidateReviews.push({ candidateId: candidate.candidateId, decision: 'rejected', reason: 'FORBIDDEN_SAFETY_LEAK' });
      continue;
    }

    // 3. Per-candidate ontology constraint evaluation
    const ontologyEval = await evaluateOntologyConstraints({
      projectId,
      paths: candidate.scope || [],
      statements: [candidate.statement],
      env,
    });

    if (ontologyEval.violations.length > 0) {
      ontologyViolations.push(...ontologyEval.violations);
      const rec = { ...candidate, status: 'rejected', rejectionReasons: ['ONTOLOGY_NEVER_VIOLATION'] };
      rejectedCandidates.push(rec);
      candidateReviews.push({ candidateId: candidate.candidateId, decision: 'rejected', reason: 'ONTOLOGY_NEVER_VIOLATION' });
      continue;
    }

    if (ontologyEval.approvalRequired.length > 0) {
      approvalRequired.push(...ontologyEval.approvalRequired);
      let hasApproval = false;
      if (stateStore && runId) {
        const dbApp = stateStore.getKnowledgeApproval(runId, candidate.candidateId);
        hasApproval = Boolean(dbApp && dbApp.approvalReceipt && dbApp.approvedBy);
      }
      if (!hasApproval) {
        const rec = { ...candidate, status: 'needs_approval', rejectionReasons: ['ASK_FIRST_REQUIRED'] };
        needsApprovalCandidates.push(rec);
        candidateReviews.push({ candidateId: candidate.candidateId, decision: 'needs_approval', reason: 'ASK_FIRST_REQUIRED' });
        continue;
      }
    }

    if (ontologyEval.verificationsRequired.length > 0) {
      verificationsRequired.push(...ontologyEval.verificationsRequired);
      let invariantSatisfied = false;
      if (stateStore && runId) {
        let allPassed = true;
        for (const req of ontologyEval.verificationsRequired) {
          const obId = req.obligationId || req.id || 'verify-invariant';
          stateStore.ensureRunObligation(runId, { obligationId: obId, sourceType: 'ontology_constraint', sourceRef: req.id });
          const dbObs = stateStore.getRunObligations(runId);
          const currentOb = dbObs.find((o) => o.obligationId === obId);
          if (!currentOb || (currentOb.status !== 'passed' && currentOb.status !== 'waived')) {
            allPassed = false;
          }
        }
        invariantSatisfied = allPassed;
      }

      if (!invariantSatisfied) {
        const rec = { ...candidate, status: 'pending_verification', rejectionReasons: ['INVARIANT_VERIFICATION_REQUIRED'] };
        pendingVerificationCandidates.push(rec);
        candidateReviews.push({ candidateId: candidate.candidateId, decision: 'pending_verification', reason: 'INVARIANT_VERIFICATION_REQUIRED' });
        continue;
      }
    }

    // 4. Evidence binding check (Fail-closed - Section 6)
    let candidateEvidenceDigest = null;
    const verifications = stateStore && runId ? stateStore.getVerifications(runId) : [];
    const candidateRefs = Array.isArray(candidate.evidenceRefs) ? candidate.evidenceRefs : [];
    const acceptanceIds = new Set([...(candidate.acceptanceIds || []), ...(candidate.evidenceBinding?.acceptanceIds || [])].map(String));
    const obligationIds = new Set([...(candidate.obligationIds || []), ...(candidate.evidenceBinding?.obligationIds || [])].map(String));
    const matchingVerification = verifications.filter((v) => {
      if (v.status !== 'passed' || Number(v.exitCode) !== 0 || !v.evidenceDigest) return false;
      if (candidateRefs.length > 0 && !candidateRefs.some((ref) => ref === v.evidenceDigest || ref === v.evidenceRef)) return false;
      if (acceptanceIds.size > 0 && !(v.acceptanceCoverage || []).some((id) => acceptanceIds.has(String(id)))) return false;
      if (obligationIds.size > 0 && !obligationIds.has(String(v.obligationId))) return false;
      return true;
    });
    // A single verification is a safe compatibility bridge for legacy
    // explicit observations. It is deliberately not the "last verification"
    // fallback: when several receipts exist, the observation must name its
    // acceptance, obligation, or evidence ref.
    const selectedVerification = matchingVerification.length > 0
      ? matchingVerification[0]
      : (stateStore && candidateRefs.length === 0 && acceptanceIds.size === 0 && obligationIds.size === 0 && verifications.length === 1
        ? verifications[0]
        : null);
    const structuredReceipt = candidate.sourceKind === 'auto'
      ? candidateRefs.find((ref) => /^(?:failure|blocker|review|source|receipt):\/\//i.test(String(ref)))
      : null;
    if (selectedVerification) {
      candidateEvidenceDigest = selectedVerification.evidenceDigest;
      if (stateStore && runId) {
        stateStore.recordCandidateEvidenceBinding({
          candidateId: candidate.candidateId,
          runId,
          evidenceDigest: selectedVerification.evidenceDigest,
          obligationId: selectedVerification.obligationId || 'default',
          sourceIdentity: selectedVerification.sourceIdentity,
          mutationRevision: selectedVerification.verifiedMutationRevision,
          bindingType: candidate.sourceKind === 'auto' ? 'structured-signal' : 'verification',
        });
      }
    } else if (structuredReceipt) {
      candidateEvidenceDigest = structuredReceipt;
      if (stateStore && runId) {
        const currentRun = stateStore.getRun(runId);
        stateStore.recordCandidateEvidenceBinding({
          candidateId: candidate.candidateId,
          runId,
          evidenceDigest: structuredReceipt,
          obligationId: candidate.obligationIds?.[0] || 'structured-signal',
          sourceIdentity: currentRun?.sourceIdentity || 'structured-signal',
          mutationRevision: currentRun?.mutationRevision || 0,
          bindingType: 'structured-signal',
        });
      }
    } else if (candidateRefs.length > 0 && !stateStore) {
      candidateEvidenceDigest = candidateRefs[0];
    } else if (allowLegacyEvidencePackFallback && evidencePack && (evidencePack.status === 'pass' || evidencePack.status === 'passed') && evidencePack.digest) {
      candidateEvidenceDigest = evidencePack.digest;
    } else if (candidate.sourceDigest && /^sha256:[a-f0-9]{64}$/i.test(candidate.sourceDigest)) {
      candidateEvidenceDigest = candidate.sourceDigest;
    }

    if (!candidateEvidenceDigest) {
      const rec = { ...candidate, status: 'rejected', rejectionReasons: ['MISSING_VERIFICATION_EVIDENCE'] };
      rejectedCandidates.push(rec);
      candidateReviews.push({ candidateId: candidate.candidateId, decision: 'rejected', reason: 'MISSING_VERIFICATION_EVIDENCE' });
      continue;
    }

    verifiedCandidates.push({
      ...candidate,
      status: 'verified',
      evidenceRefs: [candidateEvidenceDigest],
      evidenceBinding: {
        ...(candidate.evidenceBinding || {}),
        evidenceRefs: [candidateEvidenceDigest],
        obligationId: selectedVerification?.obligationId || candidate.obligationId || null,
        verificationId: selectedVerification?.id || null,
      },
    });
    candidateReviews.push({ candidateId: candidate.candidateId, decision: 'verified', evidenceRef: candidateEvidenceDigest });
  }

  let status = 'passed';
  if (ontologyViolations.length > 0 || (rejectedCandidates.length === candidates.length && candidates.length > 0)) {
    status = 'failed';
  } else if (needsApprovalCandidates.length > 0) {
    status = 'needs_approval';
  } else if (pendingVerificationCandidates.length > 0) {
    status = 'pending_verification';
  }

  return {
    status,
    verifiedCandidates,
    rejectedCandidates,
    needsApprovalCandidates,
    pendingVerificationCandidates,
    candidateReviews,
    supersessionProposals: [],
    ontologyViolations,
    approvalRequired,
    verificationsRequired,
    evidenceCoverage: evidencePack ? [evidencePack.digest || 'evidence-pack'] : [],
  };
}
