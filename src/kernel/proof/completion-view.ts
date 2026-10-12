type EvidenceClass = 'hard' | 'judgment';
type StageStatus = 'not-required' | 'pending' | 'passed' | 'failed';

interface CompletionRunLike {
  mutationRevision?: number | null;
  status?: string | null;
  finalizationStatus?: string | null;
  taskContract?: {
    completionPredicate?: {
      requiredOutcomes?: string[];
    } | null;
    [key: string]: unknown;
  } | null;
}

interface CompletionStepLike {
  state?: string | null;
}

interface ObligationLike {
  obligationId: string;
  status?: string | null;
  evidenceClass?: EvidenceClass | string | null;
  metadata?: {
    outcomes?: unknown[];
    outcome?: unknown;
    [key: string]: unknown;
  } | null;
}

interface VerificationLike {
  id?: number;
  obligationId: string;
  status?: string | null;
}

interface ReviewLike {
  id?: number;
  obligationId?: string | null;
  reviewStage?: string | null;
  stage?: string | null;
  verdict?: string | null;
  subject?: {
    mutationRevision?: number;
    [key: string]: unknown;
  } | null;
}

interface CompletionDecisionLike {
  decision?: string | null;
}

export interface ComputeCompletionViewInput {
  run?: CompletionRunLike | null;
  step?: CompletionStepLike | null;
  verifications?: VerificationLike[];
  obligations?: ObligationLike[];
  reviews?: ReviewLike[];
  completionDecision?: CompletionDecisionLike | null;
}

export const computeCompletionView = ({
  run = null,
  step = null,
  verifications = [],
  obligations = [],
  reviews = [],
  completionDecision = null,
}: ComputeCompletionViewInput = {}) => {
  const required = obligations.filter((item) => item.status === 'required');
  const hard = required.filter((item) => item.evidenceClass === 'hard');
  const judgment = required.filter((item) => item.evidenceClass === 'judgment');

  const latestVerifications = new Map<string, VerificationLike>();
  for (const item of verifications) latestVerifications.set(item.obligationId, item);

  const currentMutationRevision = run?.mutationRevision ?? null;
  const latestReviews = new Map<string, ReviewLike>();
  for (const item of reviews) {
    if (
      item.subject?.mutationRevision !== undefined
      && currentMutationRevision !== null
      && item.subject.mutationRevision < currentMutationRevision
    ) {
      continue;
    }
    const key = item.obligationId || `review-${item.reviewStage || item.stage}`;
    latestReviews.set(key, item);
  }

  const anyHardFailed = hard.some((item) => latestVerifications.get(item.obligationId)?.status === 'failed');
  const anyJudgmentFailed = judgment.some((item) => {
    const receipt = latestReviews.get(item.obligationId);
    return receipt ? receipt.verdict !== 'pass' : false;
  }) || [...latestReviews.values()].some((item) => item.verdict === 'fail');

  const requiredOutcomes = new Set(run?.taskContract?.completionPredicate?.requiredOutcomes || []);
  const outcomesFor = (item: ObligationLike): Set<string> => new Set([
    ...(Array.isArray(item.metadata?.outcomes) ? item.metadata.outcomes.map(String) : []),
    ...(item.metadata?.outcome ? [String(item.metadata.outcome)] : []),
  ]);
  const stageStatus = (outcome: string): StageStatus => {
    const stageObligations = required.filter((item) => outcomesFor(item).has(outcome));
    if (!requiredOutcomes.has(outcome) && stageObligations.length === 0) return 'not-required';

    const statusFor = (item: ObligationLike) => item.evidenceClass === 'judgment'
      ? latestReviews.get(item.obligationId)?.verdict
      : latestVerifications.get(item.obligationId)?.status;

    if (stageObligations.some((item) => {
      const status = statusFor(item);
      return status === 'failed' || status === 'fail';
    })) return 'failed';
    if (stageObligations.length === 0) return 'pending';
    return stageObligations.every((item) => {
      const status = statusFor(item);
      return status === 'passed' || status === 'pass';
    }) ? 'passed' : 'pending';
  };

  const implementation = step
    ? step.state === 'passed'
      ? 'complete'
      : ['active', 'ready'].includes(String(step.state))
        ? 'active'
        : 'pending'
    : Number(run?.mutationRevision || 0) > 0
      ? 'complete'
      : 'pending';

  const verification: StageStatus = hard.length === 0
    ? 'not-required'
    : anyHardFailed
      ? 'failed'
      : hard.every((item) => latestVerifications.get(item.obligationId)?.status === 'passed')
        ? 'passed'
        : 'pending';

  const review: StageStatus = judgment.length === 0
    ? 'not-required'
    : anyJudgmentFailed
      ? 'failed'
      : judgment.every((item) => latestReviews.get(item.obligationId)?.verdict === 'pass')
        ? 'passed'
        : 'pending';

  const kernelAcceptance = completionDecision?.decision === 'accepted'
    ? 'accepted'
    : completionDecision?.decision === 'rejected'
      ? 'rejected'
      : 'pending';
  const finalization = run?.finalizationStatus === 'completed' ? 'complete' : 'pending';
  const blocked = run?.status === 'blocked'
    || verification === 'failed'
    || review === 'failed'
    || kernelAcceptance === 'rejected';
  const done = kernelAcceptance === 'accepted' && finalization === 'complete';

  const verifiedOutcome = stageStatus('verified');
  return {
    implementation,
    verification,
    deployment: stageStatus('deployed'),
    observation: stageStatus('observed'),
    resolution: stageStatus('resolved'),
    outcomes: {
      implemented: implementation,
      verified: verifiedOutcome === 'not-required' ? verification : verifiedOutcome,
      deployed: stageStatus('deployed'),
      observed: stageStatus('observed'),
      resolved: stageStatus('resolved'),
    },
    review,
    kernelAcceptance,
    finalization,
    overall: done ? 'done' : blocked ? 'blocked' : 'active',
  };
};
