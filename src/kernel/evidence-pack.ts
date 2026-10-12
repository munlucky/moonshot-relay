import type { ProofTier, EvidenceTier } from './proof-route.js';
import { evidenceTierForProof } from './proof-route.js';

interface EvidenceCheckLike {
  evidenceRef?: unknown;
  [key: string]: unknown;
}

export interface EvidencePackOptions {
  objective?: unknown;
  proofTier?: ProofTier;
  sliceCount?: number;
  longRunning?: boolean;
  checks?: EvidenceCheckLike[];
  acceptanceCoverage?: unknown[];
  acceptance?: unknown[];
  scope?: unknown[];
  completionDecision?: unknown;
  riskTier?: unknown;
  nonGoals?: unknown[];
}

export const selectEvidenceTier = ({
  proofTier,
  sliceCount = 1,
  longRunning = false,
}: {
  proofTier: ProofTier;
  sliceCount?: number;
  longRunning?: boolean;
}): EvidenceTier => (
  longRunning || sliceCount > 1 || proofTier === 'T3' ? 'E2' : evidenceTierForProof(proofTier)
);

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
}: EvidencePackOptions = {}) => {
  const tier = selectEvidenceTier({ proofTier, sliceCount, longRunning });
  const taskContractPayload = { objective, riskTier, acceptance, scope, nonGoals };

  if (tier === 'E0') {
    return {
      schemaVersion: 1,
      tier,
      objective,
      taskContract: taskContractPayload,
      status: completionDecision,
      evidenceRefs: checks.map((check) => check.evidenceRef).filter(Boolean),
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
      tier: 'E2' as const,
      acceptanceCoverage: acceptance,
      completionDecision,
    },
  };
};

export const buildStageEvidencePack = (options: EvidencePackOptions) => buildEvidencePack(options);
export const buildReleaseEvidencePack = (options: EvidencePackOptions) => (
  buildEvidencePack({ ...options, proofTier: 'T3', sliceCount: 2 })
);
