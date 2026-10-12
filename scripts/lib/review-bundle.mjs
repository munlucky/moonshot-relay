import { sha256Hex } from './candidate-identity.js';
import { BROWSER_REPAIR_MAX_ATTEMPTS } from './browser-scenario-contract.mjs';
import {
  buildBrowserFailurePackage,
  repairPromptInputFromFailurePackage,
  repairReceiptInputFromFailurePackage,
} from './browser-failure-package.mjs';

const FORBIDDEN_KEYS = new Set([
  'implementationTranscript',
  'hiddenReasoning',
  'selfEvaluation',
  'chatHistory',
  'conversation',
  'rawPrompt',
  'transcript',
  'prompt',
]);

const scanForbidden = (value, path = []) => {
  if (!value || typeof value !== 'object') return [];
  const violations = [];
  if (Array.isArray(value)) {
    value.forEach((item, index) => violations.push(...scanForbidden(item, [...path, String(index)])));
    return violations;
  }
  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key)) violations.push([...path, key].join('.'));
    violations.push(...scanForbidden(nested, [...path, key]));
  }
  return violations;
};

export const buildReviewBundle = ({
  candidate_id,
  sourceDigest,
  contractRevision,
  freshSessionId,
  spec,
  plan,
  done,
  diff,
  testResults,
} = {}) => {
  const required = { candidate_id, sourceDigest, contractRevision, freshSessionId };
  for (const [key, value] of Object.entries(required)) {
    if (!value) throw new Error(`missing review bundle field: ${key}`);
  }
  const input = { spec, plan, done, diff, testResults };
  const violations = scanForbidden(input);
  if (violations.length > 0) {
    throw new Error(`review bundle contains forbidden context: ${violations.join(', ')}`);
  }
  const bundle = {
    schemaVersion: 1,
    artifactId: 'REVIEW_BUNDLE',
    candidate_id,
    sourceDigest,
    contractRevision,
    freshSessionId,
    input,
  };
  return {
    ...bundle,
    bundleDigest: sha256Hex(bundle),
  };
};

export const classifyFinding = (finding = {}) => {
  const disposition = finding.disposition || 'informational';
  if (!['autofix_safe', 'replan_required', 'human_decision', 'informational'].includes(disposition)) {
    throw new Error(`unknown review finding disposition: ${disposition}`);
  }
  const severity = finding.severity || 'info';
  const blocksFullScore = severity === 'critical' || disposition === 'replan_required' || disposition === 'human_decision';
  return {
    schemaVersion: 1,
    findingId: finding.findingId || finding.id || `finding-${sha256Hex(finding).slice(0, 12)}`,
    severity,
    disposition,
    blocksFullScore,
    summary: finding.summary || '',
  };
};

export const REVIEW_RESOLUTION_STATUSES = [
  'accepted',
  'rejected_with_evidence',
  'deferred_with_blocker',
  'blocking_tracked',
];

const unique = (values = []) => [...new Set(values.filter(Boolean))];

export const buildReviewCritiqueLoopReceipt = ({
  candidate_id,
  sourceDigest,
  bundleDigest,
  iterations = [],
  parentResolutions = [],
  generatedAt = new Date().toISOString(),
} = {}) => {
  const normalizedIterations = iterations.map((iteration, index) => ({
    iteration: Number(iteration.iteration || index + 1),
    reviewers: (iteration.reviewers || []).map((reviewer) => ({
      reviewerId: String(reviewer.reviewerId || reviewer.id || ''),
      focus: String(reviewer.focus || reviewer.perspective || ''),
    })),
  }));
  const reviewerIds = unique(normalizedIterations.flatMap((iteration) => iteration.reviewers.map((reviewer) => reviewer.reviewerId)));
  const normalizedResolutions = parentResolutions.map((resolution) => ({
    findingId: String(resolution.findingId || ''),
    status: String(resolution.status || ''),
    evidence: String(resolution.evidence || ''),
    blockerId: String(resolution.blockerId || ''),
  }));
  const unresolvedBlockingCount = normalizedResolutions
    .filter((resolution) => ['deferred_with_blocker', 'blocking_tracked'].includes(resolution.status))
    .length;
  const closeoutEligible = normalizedIterations.length === 2
    && reviewerIds.length >= 2
    && unresolvedBlockingCount === 0
    && normalizedResolutions.every((resolution) => REVIEW_RESOLUTION_STATUSES.includes(resolution.status));
  const receipt = {
    schemaVersion: 1,
    artifactId: 'REVIEW_CRITIQUE_LOOP_RECEIPT',
    candidate_id,
    sourceDigest,
    bundleDigest,
    effectiveReviewerCount: reviewerIds.length,
    reviewerIds,
    iterations: normalizedIterations,
    parentResolutions: normalizedResolutions,
    unresolvedBlockingCount,
    closeoutEligible,
    generatedAt,
  };
  return {
    ...receipt,
    receiptDigest: digestForReviewCritiqueLoopReceipt(receipt),
  };
};

export const normalizeReviewCritiqueLoopReceipt = (receipt = {}) => ({
  schemaVersion: receipt.schemaVersion,
  artifactId: receipt.artifactId,
  candidate_id: receipt.candidate_id,
  sourceDigest: receipt.sourceDigest,
  bundleDigest: receipt.bundleDigest,
  effectiveReviewerCount: receipt.effectiveReviewerCount,
  reviewerIds: Array.isArray(receipt.reviewerIds) ? receipt.reviewerIds.map(String) : [],
  iterations: Array.isArray(receipt.iterations)
    ? receipt.iterations.map((iteration) => ({
      iteration: Number(iteration.iteration),
      reviewers: Array.isArray(iteration.reviewers)
        ? iteration.reviewers.map((reviewer) => ({
          reviewerId: String(reviewer.reviewerId || ''),
          focus: String(reviewer.focus || ''),
        }))
        : [],
    }))
    : [],
  parentResolutions: Array.isArray(receipt.parentResolutions)
    ? receipt.parentResolutions.map((resolution) => ({
      findingId: String(resolution.findingId || ''),
      status: String(resolution.status || ''),
      evidence: String(resolution.evidence || ''),
      blockerId: String(resolution.blockerId || ''),
    }))
    : [],
  unresolvedBlockingCount: Number(receipt.unresolvedBlockingCount || 0),
  closeoutEligible: receipt.closeoutEligible === true,
  generatedAt: String(receipt.generatedAt || ''),
  receiptDigest: String(receipt.receiptDigest || ''),
});

const digestForReviewCritiqueLoopReceipt = (receipt = {}) => {
  const normalized = normalizeReviewCritiqueLoopReceipt(receipt);
  const { receiptDigest: _receiptDigest, ...digestInput } = normalized;
  return sha256Hex(digestInput);
};

export const reviewCritiqueLoopBlockers = ({
  receipt = null,
  required = true,
  candidate_id = '',
  sourceDigest = '',
  bundleDigest = '',
} = {}) => {
  if (!required) return [];
  if (!receipt || typeof receipt !== 'object') {
    return [{ code: 'review_critique_loop_missing', reason: 'missing review-critique-loop receipt' }];
  }
  const forbidden = scanForbidden(receipt);
  if (forbidden.length > 0) {
    return [{ code: 'review_critique_loop_forbidden_context', reason: `review-critique-loop contains forbidden context: ${forbidden.join(', ')}` }];
  }
  const allowedKeys = new Set([
    'schemaVersion',
    'artifactId',
    'candidate_id',
    'sourceDigest',
    'bundleDigest',
    'effectiveReviewerCount',
    'reviewerIds',
    'iterations',
    'parentResolutions',
    'unresolvedBlockingCount',
    'closeoutEligible',
    'generatedAt',
    'receiptDigest',
  ]);
  const blockers = [];
  for (const key of Object.keys(receipt)) {
    if (!allowedKeys.has(key)) {
      blockers.push({ code: 'review_critique_loop_unknown_field', reason: `review-critique-loop contains unknown field: ${key}` });
    }
  }
  if (receipt.artifactId !== 'REVIEW_CRITIQUE_LOOP_RECEIPT') {
    blockers.push({ code: 'review_critique_loop_invalid', reason: 'invalid review-critique-loop artifact' });
  }
  if (receipt.receiptDigest !== digestForReviewCritiqueLoopReceipt(receipt)) {
    blockers.push({ code: 'review_critique_loop_digest_mismatch', reason: 'review-critique-loop digest mismatch' });
  }
  if (candidate_id && receipt.candidate_id !== candidate_id) {
    blockers.push({ code: 'review_critique_loop_candidate_mismatch', reason: 'review-critique-loop candidate mismatch' });
  }
  if (sourceDigest && receipt.sourceDigest !== sourceDigest) {
    blockers.push({ code: 'review_critique_loop_source_mismatch', reason: 'review-critique-loop source digest mismatch' });
  }
  if (bundleDigest && receipt.bundleDigest !== bundleDigest) {
    blockers.push({ code: 'review_critique_loop_bundle_mismatch', reason: 'review-critique-loop bundle digest mismatch' });
  }
  if (!Array.isArray(receipt.iterations) || receipt.iterations.length !== 2) {
    blockers.push({ code: 'review_critique_loop_iteration_count', reason: 'review-critique-loop requires exactly two iterations' });
  }
  const reviewerIds = Array.isArray(receipt.reviewerIds) ? unique(receipt.reviewerIds.map(String)) : [];
  const derivedReviewerIds = unique((Array.isArray(receipt.iterations) ? receipt.iterations : [])
    .flatMap((iteration) => (iteration.reviewers || []).map((reviewer) => String(reviewer.reviewerId || ''))));
  const sortedClaimed = [...reviewerIds].sort();
  const sortedDerived = [...derivedReviewerIds].sort();
  if (JSON.stringify(sortedClaimed) !== JSON.stringify(sortedDerived)) {
    blockers.push({ code: 'review_critique_loop_reviewer_set_mismatch', reason: 'reviewerIds must match reviewers derived from iterations' });
  }
  if (Number(receipt.effectiveReviewerCount || 0) !== derivedReviewerIds.length) {
    blockers.push({ code: 'review_critique_loop_reviewer_count_mismatch', reason: 'effectiveReviewerCount must equal unique reviewers derived from iterations' });
  }
  if (derivedReviewerIds.length < 2) {
    blockers.push({ code: 'review_critique_loop_reviewer_count', reason: 'review-critique-loop requires at least two independent reviewers' });
  }
  for (const iteration of Array.isArray(receipt.iterations) ? receipt.iterations : []) {
    if (!Array.isArray(iteration.reviewers) || iteration.reviewers.length === 0) {
      blockers.push({ code: 'review_critique_loop_iteration_reviewers', reason: `review iteration ${iteration.iteration || '?'} has no reviewers` });
    }
    for (const reviewer of iteration.reviewers || []) {
      if (!reviewer.reviewerId || !reviewer.focus) {
        blockers.push({ code: 'review_critique_loop_reviewer_metadata', reason: 'reviewer id and focus are required' });
      }
    }
  }
  for (const resolution of Array.isArray(receipt.parentResolutions) ? receipt.parentResolutions : []) {
    if (!REVIEW_RESOLUTION_STATUSES.includes(resolution.status)) {
      blockers.push({ code: 'review_critique_loop_resolution_status', reason: 'review resolution status is outside contract enum' });
    }
    if (resolution.status === 'rejected_with_evidence' && !resolution.evidence) {
      blockers.push({ code: 'review_critique_loop_resolution_evidence', reason: 'rejected review finding requires evidence' });
    }
    if (['deferred_with_blocker', 'blocking_tracked'].includes(resolution.status) && !resolution.blockerId) {
      blockers.push({ code: 'review_critique_loop_blocker_missing', reason: 'blocking review resolution requires blockerId' });
    }
  }
  const derivedUnresolvedBlockingCount = (Array.isArray(receipt.parentResolutions) ? receipt.parentResolutions : [])
    .filter((resolution) => ['deferred_with_blocker', 'blocking_tracked'].includes(resolution.status))
    .length;
  if (Number(receipt.unresolvedBlockingCount || 0) !== derivedUnresolvedBlockingCount) {
    blockers.push({ code: 'review_critique_loop_blocking_count_mismatch', reason: 'unresolvedBlockingCount must match parent resolutions' });
  }
  const derivedCloseoutEligible = Array.isArray(receipt.iterations)
    && receipt.iterations.length === 2
    && derivedReviewerIds.length >= 2
    && derivedUnresolvedBlockingCount === 0
    && (Array.isArray(receipt.parentResolutions) ? receipt.parentResolutions : [])
      .every((resolution) => REVIEW_RESOLUTION_STATUSES.includes(resolution.status));
  if (receipt.closeoutEligible !== derivedCloseoutEligible) {
    blockers.push({ code: 'review_critique_loop_closeout_eligibility_mismatch', reason: 'closeoutEligible must be derived from receipt contents' });
  }
  if (derivedUnresolvedBlockingCount > 0) {
    blockers.push({ code: 'review_critique_loop_unresolved_blocking', reason: 'review-critique-loop has unresolved blocking findings' });
  }
  if (receipt.closeoutEligible !== true) {
    blockers.push({ code: 'review_critique_loop_not_eligible', reason: 'review-critique-loop is not closeout eligible' });
  }
  return blockers;
};

export const buildRepairPrompt = ({
  failurePackage = null,
  scenario = null,
  browserResult = {},
  scenarioId,
  originalScenarioId = scenarioId,
  rerunScenarioId = scenarioId,
  failedStep,
  failureClass,
  failedAssertionIds = [],
  consoleSummary = {},
  networkSummary = {},
  artifacts = [],
  prohibitedRepairActions = [],
  rerunCommand,
  maxRepairAttempts = BROWSER_REPAIR_MAX_ATTEMPTS,
  attemptIndex = 1,
  setupGap = false,
  redactionManifest = {},
  blockerMapping = [],
} = {}) => {
  const canonicalPackage = failurePackage || buildBrowserFailurePackage({
    scenario,
    browserResult,
    scenarioId,
    originalScenarioId,
    rerunScenarioId,
    failedStep,
    failedStage: browserResult.failedStage || failedStep,
    failureClass,
    failedAssertionIds: failedAssertionIds.length > 0 ? failedAssertionIds : browserResult.failedAssertionIds || [],
    consoleSummary: Object.keys(consoleSummary || {}).length > 0 ? consoleSummary : browserResult.consoleSummary || {},
    networkSummary: Object.keys(networkSummary || {}).length > 0 ? networkSummary : browserResult.networkSummary || {},
    artifacts: artifacts.length > 0 ? artifacts : browserResult.artifacts || [],
    prohibitedRepairActions,
    rerunCommand,
    maxRepairAttempts,
    attemptIndex,
    setupGap,
    redactionManifest,
    blockerMapping,
    requireScenarioArtifacts: false,
  });
  const repairInput = repairPromptInputFromFailurePackage(canonicalPackage);
  const requiredProhibitions = [
    'do not delete or weaken failing assertions',
    'do not change expected behavior without a tracked blocker',
    'do not update screenshot or visual baselines automatically',
    'do not skip required browser or integration tests',
  ];
  const finalProhibitions = unique([...requiredProhibitions, ...(repairInput.prohibitedRepairActions || []).map(String)]);
  const boundedMaxRepairAttempts = Math.max(1, Math.min(BROWSER_REPAIR_MAX_ATTEMPTS, Number(repairInput.maxRepairAttempts) || BROWSER_REPAIR_MAX_ATTEMPTS));
  const lines = [
    '# Repair Prompt',
    '',
    `- scenarioId: ${repairInput.scenarioId || 'unknown'}`,
    `- originalScenarioId: ${repairInput.originalScenarioId || repairInput.scenarioId || 'unknown'}`,
    `- rerunScenarioId: ${repairInput.rerunScenarioId || 'unknown'}`,
    `- failedStep: ${repairInput.failedStep || 'unknown'}`,
    `- failedStage: ${repairInput.failedStage || repairInput.failedStep || 'unknown'}`,
    `- failureClass: ${repairInput.failureClass || 'unknown'}`,
    `- failedAssertionIds: ${(repairInput.failedAssertionIds || []).join(', ') || 'none'}`,
    `- attemptIndex: ${Number(repairInput.attemptIndex) || 1}`,
    `- maxRepairAttempts: ${boundedMaxRepairAttempts}`,
    `- rerunCommand: ${repairInput.rerunCommand || 'rerun the same scenarioId with the original assertions'}`,
    '',
    '## Console Summary',
    JSON.stringify(repairInput.consoleSummary || {}, null, 2),
    '',
    '## Network Summary',
    JSON.stringify(repairInput.networkSummary || {}, null, 2),
    '',
    '## Artifact Paths',
    ...(repairInput.artifacts || []).map((artifact) => `- ${artifact.path || artifact}`),
    '',
    '## Blocker Mapping',
    JSON.stringify(repairInput.blockerMapping || [], null, 2),
    '',
    '## Prohibited Repair Actions',
    ...finalProhibitions.map((action) => `- ${action}`),
  ];
  return {
    schemaVersion: 1,
    artifactId: 'REPAIR_PROMPT',
    scenarioId: repairInput.scenarioId || '',
    originalScenarioId: repairInput.originalScenarioId || repairInput.scenarioId || '',
    rerunScenarioId: repairInput.rerunScenarioId || '',
    failedStep: repairInput.failedStep || '',
    failedStage: repairInput.failedStage || repairInput.failedStep || '',
    failureClass: repairInput.failureClass || '',
    failedAssertionIds: repairInput.failedAssertionIds || [],
    attemptIndex: Number(repairInput.attemptIndex) || 1,
    maxRepairAttempts: boundedMaxRepairAttempts,
    rerunCommand: repairInput.rerunCommand || '',
    artifacts: repairInput.artifacts || [],
    redactionManifest: repairInput.redactionManifest || {},
    blockerMapping: repairInput.blockerMapping || [],
    failurePackage: canonicalPackage,
    prohibitedRepairActions: finalProhibitions,
    prompt: `${lines.join('\n')}\n`,
  };
};

export const buildRepairLoopReceipt = ({
  failurePackage = null,
  scenarioId,
  originalScenarioId = scenarioId,
  rerunScenarioId = scenarioId,
  failedAssertionIds = [],
  preservedAssertionIds = failedAssertionIds,
  attemptIndex = 1,
  maxRepairAttempts = BROWSER_REPAIR_MAX_ATTEMPTS,
  status = 'ready_for_rerun',
  artifactLinks = [],
  blockerMapping = [],
} = {}) => {
  const receiptInput = failurePackage ? repairReceiptInputFromFailurePackage(failurePackage) : {
    scenarioId,
    originalScenarioId,
    rerunScenarioId,
    failedAssertionIds,
    preservedAssertionIds,
    attemptIndex,
    maxRepairAttempts,
    artifactLinks,
    blockerMapping,
  };
  const boundedMaxRepairAttempts = Math.max(1, Math.min(BROWSER_REPAIR_MAX_ATTEMPTS, Number(receiptInput.maxRepairAttempts) || BROWSER_REPAIR_MAX_ATTEMPTS));
  const normalized = {
    schemaVersion: 1,
    artifactId: 'REPAIR_LOOP_RECEIPT',
    scenarioId: receiptInput.scenarioId || '',
    originalScenarioId: receiptInput.originalScenarioId || receiptInput.scenarioId || '',
    rerunScenarioId: receiptInput.rerunScenarioId || '',
    failedAssertionIds: (receiptInput.failedAssertionIds || []).map(String),
    preservedAssertionIds: (receiptInput.preservedAssertionIds || receiptInput.failedAssertionIds || []).map(String),
    attemptIndex: Number(receiptInput.attemptIndex) || 1,
    maxRepairAttempts: boundedMaxRepairAttempts,
    status,
    artifactLinks: receiptInput.artifactLinks || [],
    blockerMapping: receiptInput.blockerMapping || [],
  };
  return {
    ...normalized,
    receiptDigest: sha256Hex(normalized),
  };
};

export const repairLoopBlockers = ({ receipt = null, required = false } = {}) => {
  if (!required) return [];
  if (!receipt || typeof receipt !== 'object') {
    return [{ code: 'repair_loop_missing', reason: 'missing repair loop receipt' }];
  }
  const blockers = [];
  if (receipt.artifactId !== 'REPAIR_LOOP_RECEIPT') {
    blockers.push({ code: 'repair_loop_invalid', reason: 'invalid repair loop receipt' });
  }
  if (Number(receipt.maxRepairAttempts || 0) > 2) {
    blockers.push({ code: 'repair_loop_attempt_budget_invalid', reason: 'maxRepairAttempts cannot exceed 2' });
  }
  if (receipt.status === 'repair_exhausted' || Number(receipt.attemptIndex || 0) > Number(receipt.maxRepairAttempts || 0)) {
    blockers.push({ code: 'repair_exhausted', reason: 'repair loop exhausted' });
  }
  if (receipt.originalScenarioId !== receipt.rerunScenarioId) {
    blockers.push({ code: 'repair_scenario_mismatch', reason: 'repair rerun must use the same scenarioId' });
  }
  const preserved = new Set((receipt.preservedAssertionIds || []).map(String));
  const missingAssertions = (receipt.failedAssertionIds || []).filter((id) => !preserved.has(String(id)));
  if (missingAssertions.length > 0) {
    blockers.push({ code: 'repair_assertion_ids_changed', reason: 'repair rerun must preserve failing assertion ids' });
  }
  return blockers;
};

export const reviewOutcomeEvidence = ({
  runId,
  goalId,
  candidate_id,
  bundleDigest,
  findings = [],
} = {}) => ({
  runtimeEvent: {
    event_type: 'review.completed',
    severity: findings.some((finding) => classifyFinding(finding).blocksFullScore) ? 'warning' : 'info',
    payload: {
      candidate_id,
      bundleDigest,
      findingCount: findings.length,
    },
  },
  evalEvidence: {
    runId,
    goalId,
    plane: 'review',
    status: findings.some((finding) => classifyFinding(finding).blocksFullScore) ? 'failed' : 'passed',
    candidate_id,
    bundleDigest,
  },
});

export const assertAutofixCreatesNewCandidate = ({ beforeCandidateId, afterCandidateId, finding } = {}) => {
  const classified = classifyFinding(finding);
  if (classified.disposition !== 'autofix_safe') return true;
  if (!beforeCandidateId || !afterCandidateId || beforeCandidateId === afterCandidateId) {
    throw new Error('autofix must create a new candidate_id and invalidate stale review evidence');
  }
  return true;
};
