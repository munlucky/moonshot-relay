export interface EvidencePlanLike {
  class?: unknown;
}

export interface AcceptanceLike {
  id?: string;
  evidencePlan?: EvidencePlanLike | null;
}

export interface VerificationRequirementLike {
  evidenceClass?: unknown;
  class?: unknown;
}

export interface RequiredCapabilityContract {
  acceptance?: AcceptanceLike[];
  requiredVerifications?: unknown[];
  requiredObligations?: unknown[];
}

export interface ObligationLike {
  evidenceClass?: unknown;
}

export interface HostCapabilitySet {
  supportsProofExecution?: boolean;
}

export interface RequiredHostCapabilityContext {
  stage?: unknown;
  action?: unknown;
  obligations?: ObligationLike[] | null;
}

export interface RequiredHostCapabilitySummary {
  proofExecution: boolean;
  independentReviewer: false;
  readOnlyReview: false;
}

const contractHasHardProof = (contract: RequiredCapabilityContract = {}) => {
  const acceptance = Array.isArray(contract.acceptance) ? contract.acceptance : [];
  if (acceptance.some((item) => item?.evidencePlan?.class !== 'judgment')) return true;

  const requiredVerifications = Array.isArray(contract.requiredVerifications)
    ? contract.requiredVerifications
    : [];
  if (requiredVerifications.some((item) => {
    const evidenceClass = typeof item === 'object' && item !== null
      ? ((item as VerificationRequirementLike).evidenceClass || (item as VerificationRequirementLike).class)
      : null;
    return evidenceClass !== 'judgment';
  })) return true;

  // A bare requiredObligations entry has no class information. Treat it as
  // hard in this contract-only fallback; callers with compiled obligations
  // below provide the authoritative class and can safely identify judgment
  // obligations such as security-review.
  return (Array.isArray(contract.requiredObligations) ? contract.requiredObligations : []).length > 0;
};

export const requiredHostCapabilities = (
  contract: RequiredCapabilityContract = {},
  { stage = 'FRAME', action: _action = null, obligations = null }: RequiredHostCapabilityContext = {},
): RequiredHostCapabilitySummary => {
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

export class RequiredHostCapabilityError extends Error {
  readonly code = 'REQUIRED_HOST_CAPABILITY_MISSING';
  readonly errorCode = 'REQUIRED_HOST_CAPABILITY_MISSING';

  constructor(
    readonly stage: unknown,
    readonly missing: string[],
  ) {
    super(`required_host_capability_missing: ${missing.join(', ')}`);
    this.name = 'RequiredHostCapabilityError';
  }
}

export const assertRequiredHostCapabilities = (
  contract: RequiredCapabilityContract,
  hostCapabilities: HostCapabilitySet = {},
  { stage = 'FRAME', action = null, obligations = null }: RequiredHostCapabilityContext = {},
) => {
  const required = requiredHostCapabilities(contract, { stage, action, obligations });
  const missing: string[] = [];
  if (required.proofExecution && hostCapabilities.supportsProofExecution !== true) {
    missing.push('proof-command-execution');
  }
  if (missing.length) throw new RequiredHostCapabilityError(stage, missing);
  return { admitted: true as const, required, stage };
};
