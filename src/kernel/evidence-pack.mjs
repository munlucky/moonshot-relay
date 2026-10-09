import { evidenceTierForProof } from './proof-route.mjs';

export const selectEvidenceTier = ({ proofTier, sliceCount = 1, longRunning = false }) =>
  longRunning || sliceCount > 1 || proofTier === 'T3' ? 'E2' : evidenceTierForProof(proofTier);

export const buildEvidencePack = ({
  objective,
  proofTier = 'T0',
  sliceCount = 1,
  longRunning = false,
  checks = [],
  acceptanceCoverage = [],
  acceptance = acceptanceCoverage,
  scope = [],
  completionDecision = 'blocked',
  riskTier = 'T0',
  nonGoals = [],
}) => {
  const tier = selectEvidenceTier({ proofTier, sliceCount, longRunning });

  const taskContractPayload = {
    objective,
    riskTier,
    acceptance,
    scope,
    nonGoals,
  };

  if (tier === 'E0') {
    return {
      schemaVersion: 1,
      tier,
      objective,
      taskContract: taskContractPayload,
      status: completionDecision,
      evidenceRefs: checks.map((c) => c.evidenceRef).filter(Boolean),
    };
  }

  const qa = { schemaVersion: 1, tier, proofTier, checks };

  if (tier === 'E1') {
    return {
      schemaVersion: 1,
      tier,
      taskContract: taskContractPayload,
      qaReport: qa,
      runSummary: { objective, status: completionDecision },
    };
  }

  return {
    schemaVersion: 1,
    tier,
    taskContract: taskContractPayload,
    sliceGraph: { sliceCount },
    qaReport: qa,
      releaseEvidence: {
      schemaVersion: 1,
      tier: 'E2',
      acceptanceCoverage: acceptance,
      completionDecision,
    },
  };
};

export const buildStageEvidencePack = (options) => buildEvidencePack(options);
export const buildReleaseEvidencePack = (options) => buildEvidencePack({ ...options, proofTier: 'T3', sliceCount: 2 });
