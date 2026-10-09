const contractHasHardProof = (contract = {}) => {
  const acceptance = Array.isArray(contract?.acceptance) ? contract.acceptance : [];
  if (acceptance.some((item) => item?.evidencePlan?.class !== 'judgment')) return true;

  const requiredVerifications = Array.isArray(contract?.requiredVerifications)
    ? contract.requiredVerifications
    : [];
  if (requiredVerifications.some((item) => {
    const evidenceClass = typeof item === 'object' && item !== null
      ? (item.evidenceClass || item.class)
      : null;
    return evidenceClass !== 'judgment';
  })) return true;

  // A bare requiredObligations entry has no class information. Treat it as
  // hard in this contract-only fallback; callers with compiled obligations
  // below provide the authoritative class and can safely identify judgment
  // obligations such as security-review.
  return (Array.isArray(contract?.requiredObligations) ? contract.requiredObligations : []).length > 0;
};

export const requiredHostCapabilities = (contract = {}, { stage = 'FRAME', action = null, obligations = null } = {}) => {
  const isProve = String(stage || '').toUpperCase() === 'PROVE';
  const compiledObligations = Array.isArray(obligations) ? obligations : null;
  const hasHardProof = compiledObligations
    ? compiledObligations.some((obligation) => obligation?.evidenceClass === 'hard')
    : contractHasHardProof(contract);
  return {
    proofExecution: isProve && hasHardProof,
    // Reviewer transport is selected at the actual reviewer dispatch edge.
    // Keeping these fields preserves the capability summary shape for callers
    // without making the owner adapter a prerequisite for a later reviewer.
    independentReviewer: false,
    readOnlyReview: false,
  };
};

export const assertRequiredHostCapabilities = (contract, hostCapabilities = {}, { stage = 'FRAME', action = null, obligations = null } = {}) => {
  const required = requiredHostCapabilities(contract, { stage, action, obligations });
  const missing = [];
  if (required.proofExecution && hostCapabilities.supportsProofExecution !== true) missing.push('proof-command-execution');
  if (missing.length) {
    const error = new Error(`required_host_capability_missing: ${missing.join(', ')}`);
    error.code = 'REQUIRED_HOST_CAPABILITY_MISSING';
    error.errorCode = 'REQUIRED_HOST_CAPABILITY_MISSING';
    error.stage = stage;
    error.missing = missing;
    throw error;
  }
  return { admitted: true, required, stage };
};
