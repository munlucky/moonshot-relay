import { floorForSurface } from './risk-surfaces.js';
import { KERNEL_POLICY } from './policy.js';

export type ProofTier = 'T0' | 'T1' | 'T2' | 'T3';
export type EvidenceTier = 'E0' | 'E1' | 'E2';

interface ProofPolicyLike {
  proofToEvidence: Record<string, EvidenceTier>;
  requiredChecks: Record<string, string[]>;
}

interface ProofRouteTask {
  requestedTier?: unknown;
  proofTier?: unknown;
  behaviorChanging?: boolean;
  crossLayer?: boolean;
  surfaces?: unknown[];
}

const policy = KERNEL_POLICY as ProofPolicyLike;
const rank: Readonly<Record<ProofTier, number>> = Object.freeze({ T0: 0, T1: 1, T2: 2, T3: 3 });

export const isProofTier = (value: unknown): value is ProofTier => (
  typeof value === 'string' && Object.prototype.hasOwnProperty.call(rank, value)
);

export const selectProofTier = (task: ProofRouteTask = {}): ProofTier => {
  const requested = task.requestedTier || task.proofTier;
  let tier: ProofTier = isProofTier(requested) ? requested : (task.behaviorChanging ? 'T1' : 'T0');
  if (task.crossLayer) tier = rank[tier] < rank.T2 ? 'T2' : tier;
  for (const surface of task.surfaces || []) {
    const floor = floorForSurface(surface);
    if (floor && rank[tier] < rank[floor]) tier = floor;
  }
  return tier;
};

export const evidenceTierForProof = (proofTier: ProofTier): EvidenceTier => (
  policy.proofToEvidence[proofTier] || 'E1'
);

export const requiredChecksForProof = (proofTier: ProofTier): string[] => (
  policy.requiredChecks[proofTier] || ['default']
);

export const resolveProofRoute = (task: ProofRouteTask = {}) => {
  const proofTier = selectProofTier(task);
  return {
    proofTier,
    evidenceTier: evidenceTierForProof(proofTier),
    requiredChecks: requiredChecksForProof(proofTier),
  };
};
