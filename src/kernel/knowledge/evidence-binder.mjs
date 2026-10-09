export function bindCandidateEvidence(candidate, verifications = [], { currentRun = null } = {}) {
  const bindings = [];
  const refs = candidate.evidenceRefs || [];
  if (refs.length === 0) {
    return { status: 'rejected', reason: 'missing_evidence_refs', bindings: [] };
  }

  for (const ref of refs) {
    const matchedVer = verifications.find((v) => {
      if (!v) return false;

      // Only check runId cross-ref if BOTH candidate and verification have it populated
      if (candidate.runId && v.runId && v.runId !== candidate.runId) return false;

      if (v.status !== 'passed') return false;
      if (Number(v.exitCode) !== 0) return false;
      if (!v.command || typeof v.command !== 'string' || v.command.trim() === '') return false;

      if (currentRun) {
        if (!v.sourceIdentity || v.sourceIdentity !== currentRun.sourceIdentity) return false;
        // Allow when verifiedMutationRevision is null/0 (e.g. run has never incremented)
        const verMutRev = v.verifiedMutationRevision;
        const currentMutRev = Number(currentRun.mutationRevision);
        if (verMutRev !== null && verMutRev !== undefined && Number(verMutRev) !== currentMutRev) return false;
      }

      // Exact ref match: evidenceRef, evidenceDigest, or sha256 prefix
      const vDigest = v.evidenceDigest || '';
      const vRef = v.evidenceRef || '';
      const isExact =
        vRef === ref ||
        vDigest === ref ||
        `sha256:${vDigest}` === ref ||
        (ref.startsWith('sha256:') && vDigest === ref.slice(7));

      return isExact;
    });

    if (matchedVer) {
      bindings.push({
        candidateId: candidate.candidateId,
        verificationId: matchedVer.id || 1,
        runId: candidate.runId || (currentRun ? currentRun.runId : 'unknown'),
        evidenceDigest: matchedVer.evidenceDigest || ref,
        sourceIdentity: matchedVer.sourceIdentity || (currentRun ? currentRun.sourceIdentity : ''),
        mutationRevision: currentRun ? currentRun.mutationRevision : (matchedVer.verifiedMutationRevision || 0),
        evidenceRef: ref,
        status: 'passed',
      });
    }
  }

  if (bindings.length === 0) {
    return { status: 'rejected', reason: 'unverified_evidence_refs', bindings: [] };
  }

  return { status: 'verified', bindings };
}
