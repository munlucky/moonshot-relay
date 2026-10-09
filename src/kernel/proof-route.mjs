import { floorForSurface } from './risk-surfaces.mjs';
import { KERNEL_POLICY } from './policy.mjs';

const rank = { T0: 0, T1: 1, T2: 2, T3: 3 };

export const selectProofTier = (task = {}) => {
  let tier = task.requestedTier || task.proofTier || (task.behaviorChanging ? 'T1' : 'T0');
  if (task.crossLayer) tier = rank[tier] < rank.T2 ? 'T2' : tier;
  for (const surface of task.surfaces || []) {
    const floor = floorForSurface(surface);
    if (floor && rank[tier] < rank[floor]) tier = floor;
  }
  return tier;
};

export const evidenceTierForProof = (proofTier) => KERNEL_POLICY.proofToEvidence[proofTier] || 'E1';

export const requiredChecksForProof = (proofTier) => {
  return KERNEL_POLICY.requiredChecks[proofTier] || ['default'];
};

export const resolveProofRoute = (task = {}) => {
  const proofTier = selectProofTier(task);
  const evidenceTier = evidenceTierForProof(proofTier);
  const requiredChecks = requiredChecksForProof(proofTier);
  return {
    proofTier,
    evidenceTier,
    requiredChecks,
  };
};
