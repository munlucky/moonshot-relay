export const computeCompletionView = ({
  run,
  step = null,
  verifications = [],
  obligations = [],
  reviews = [],
  completionDecision = null,
} = {}) => {
  const required = obligations.filter((item) => item.status === 'required');
  const hard = required.filter((item) => item.evidenceClass === 'hard');
  const judgment = required.filter((item) => item.evidenceClass === 'judgment');

  // Reduce verifications to latest row per obligationId
  const latestVerifications = new Map();
  for (const item of verifications) {
    latestVerifications.set(item.obligationId, item);
  }

  // Reduce reviews to latest receipt per obligationId for current mutation revision
  const currentMutationRevision = run?.mutationRevision ?? null;
  const latestReviews = new Map();
  for (const item of reviews) {
    if (item.subject?.mutationRevision !== undefined && currentMutationRevision !== null && item.subject.mutationRevision < currentMutationRevision) {
      continue;
    }
    const key = item.obligationId || `review-${item.reviewStage || item.stage}`;
    latestReviews.set(key, item);
  }

  const anyHardFailed = hard.some((item) => latestVerifications.get(item.obligationId)?.status === 'failed');
  const anyJudgmentFailed = judgment.some((item) => {
    const key = item.obligationId;
    const rev = latestReviews.get(key);
    return rev ? rev.verdict !== 'pass' : false;
  }) || [...latestReviews.values()].some((item) => item.verdict === 'fail');

  const requiredOutcomes = new Set(run?.taskContract?.completionPredicate?.requiredOutcomes || []);
  const outcomesFor = (item) => new Set([
    ...(Array.isArray(item?.metadata?.outcomes) ? item.metadata.outcomes : []),
    ...(item?.metadata?.outcome ? [item.metadata.outcome] : []),
  ]);
  const stageStatus = (outcome) => {
    const stageObligations = required.filter((item) => outcomesFor(item).has(outcome));
    if (!requiredOutcomes.has(outcome) && stageObligations.length === 0) return 'not-required';
    const statusFor = (item) => item.evidenceClass === 'judgment'
      ? latestReviews.get(item.obligationId)?.verdict
      : latestVerifications.get(item.obligationId)?.status;
    if (stageObligations.some((item) => statusFor(item) === 'failed' || statusFor(item) === 'fail')) return 'failed';
    if (stageObligations.length === 0) return 'pending';
    return stageObligations.every((item) => statusFor(item) === 'passed' || statusFor(item) === 'pass')
      ? 'passed'
      : 'pending';
  };

  const implementation = step
    ? (step.state === 'passed' ? 'complete' : ['active', 'ready'].includes(step.state) ? 'active' : 'pending')
    : (run?.mutationRevision > 0 ? 'complete' : 'pending');
  const verification = hard.length === 0
    ? 'not-required'
    : anyHardFailed ? 'failed' : hard.every((item) => latestVerifications.get(item.obligationId)?.status === 'passed') ? 'passed' : 'pending';
  const review = judgment.length === 0
    ? 'not-required'
    : anyJudgmentFailed ? 'failed' : judgment.every((item) => latestReviews.get(item.obligationId)?.verdict === 'pass') ? 'passed' : 'pending';
  const kernelAcceptance = completionDecision?.decision === 'accepted' ? 'accepted'
    : completionDecision?.decision === 'rejected' ? 'rejected' : 'pending';
  const finalization = run?.finalizationStatus === 'completed' ? 'complete' : 'pending';
  const blocked = run?.status === 'blocked' || verification === 'failed' || review === 'failed' || kernelAcceptance === 'rejected';
  const done = kernelAcceptance === 'accepted' && finalization === 'complete';
  return {
    implementation,
    verification,
    deployment: stageStatus('deployed'),
    observation: stageStatus('observed'),
    resolution: stageStatus('resolved'),
    outcomes: {
      implemented: implementation,
      verified: stageStatus('verified') === 'not-required' ? verification : stageStatus('verified'),
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
