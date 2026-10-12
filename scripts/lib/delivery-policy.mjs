import { assertEvidenceBinding, evidenceBinding } from './candidate-identity.js';

const DELIVERY_MODES = new Set(['local', 'pr', 'release']);

const receiptSha = (receipt = {}) => receipt.gitSha
  || receipt.sha
  || receipt.sourceSha
  || receipt.reviewedSha
  || receipt.verifiedSha
  || receipt.scoredSha
  || receipt.submittedSha
  || '';

const addBlocker = (blockers, type, detail = {}) => {
  blockers.push({ type, severity: 'blocking', ...detail });
};

export const assessDeliverySubmission = ({
  mode = 'local',
  score,
  verification,
  review = null,
  currentSha = '',
  submittedSha = currentSha,
} = {}) => {
  const blockers = [];
  if (!DELIVERY_MODES.has(mode)) addBlocker(blockers, 'invalid_delivery_mode', { mode });
  if (!score || score.artifactId !== 'SCORE_RECEIPT') addBlocker(blockers, 'missing_score_receipt');
  if (!verification || verification.artifactId !== 'VERIFICATION_RECEIPT') addBlocker(blockers, 'missing_verification_receipt');
  if (score?.status !== 'FULL') addBlocker(blockers, 'score_not_full', { scoreStatus: score?.status || '' });
  if (verification?.status && verification.status !== 'passed') {
    addBlocker(blockers, 'verification_not_passed', { verificationStatus: verification.status });
  }

  for (const [label, receipt] of [['verification', verification], ['review', review]].filter(([, value]) => value)) {
    try {
      assertEvidenceBinding(score || {}, receipt);
    } catch (error) {
      addBlocker(blockers, 'stale_candidate_evidence', {
        receipt: label,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const reviewedSha = review ? receiptSha(review) : submittedSha;
  const verifiedSha = receiptSha(verification);
  const scoredSha = receiptSha(score);
  const shaChecks = [
    ['currentSha', currentSha],
    ['submittedSha', submittedSha],
    ['reviewedSha', reviewedSha],
    ['verifiedSha', verifiedSha],
    ['scoredSha', scoredSha],
  ];
  for (const [field, value] of shaChecks) {
    if (!value) addBlocker(blockers, 'missing_sha', { field });
  }

  const referenceSha = scoredSha || submittedSha;
  for (const [field, value] of shaChecks) {
    if (value && referenceSha && value !== referenceSha) {
      addBlocker(blockers, 'sha_mismatch', { field, expected: referenceSha, actual: value });
    }
  }

  return {
    status: blockers.length === 0 ? 'allowed' : 'blocked',
    mode,
    blockers,
    sourceMutationAfterScore: Boolean(currentSha && scoredSha && currentSha !== scoredSha),
    shaAlignment: {
      currentSha,
      submittedSha,
      reviewedSha,
      verifiedSha,
      scoredSha,
    },
  };
};

export const buildSubmissionReceipt = ({
  mode = 'local',
  score,
  verification,
  review = null,
  currentSha = '',
  submittedSha = currentSha,
  createdAt = new Date().toISOString(),
} = {}) => {
  const assessment = assessDeliverySubmission({
    mode,
    score,
    verification,
    review,
    currentSha,
    submittedSha,
  });
  if (assessment.status !== 'allowed') {
    const reason = assessment.blockers.map((blocker) => blocker.type).join(', ');
    throw new Error(`delivery submission blocked: ${reason}`);
  }

  const binding = evidenceBinding(score);
  return {
    schemaVersion: 1,
    artifactId: 'SUBMISSION_RECEIPT',
    candidate_id: binding.candidate_id,
    candidateId: binding.candidate_id,
    sourceDigest: binding.sourceDigest,
    environmentDigest: binding.environmentDigest,
    policyDigest: binding.policyDigest,
    scoreStatus: score.status,
    submittedSha,
    currentSha,
    reviewedSha: assessment.shaAlignment.reviewedSha,
    verifiedSha: assessment.shaAlignment.verifiedSha,
    scoredSha: assessment.shaAlignment.scoredSha,
    sourceMutationAfterScore: false,
    deliveryAllowed: true,
    mode,
    createdAt,
  };
};
