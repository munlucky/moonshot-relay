// Two-stage review (§31 Superpowers split, §20 role-as-I/O-contract).
//
// Contract review checks public-contract compatibility and acceptance
// semantics; engineering review checks implementation standards and
// complexity. Reviewers are defined by a fixed input/output contract, never a
// long persona. High-risk work (T3) additionally requires an INDEPENDENT
// reviewer whose context differs from the implementer's.

import { REVIEW_ACTIONS } from '../run/model-route-contract.mjs';

const RANK = { T0: 0, T1: 1, T2: 2, T3: 3 };

export const REVIEW_STAGES = ['contract', 'engineering'];

// Fixed reviewer output contract. No prose personas — just a verdict, findings
// and risks.
export const normalizeReviewVerdict = (verdict = {}) => {
  if (!verdict || typeof verdict !== 'object') throw new Error('review verdict must be an object');
  if (!['pass', 'fail', 'changes-requested'].includes(verdict.verdict)) {
    throw new Error('review verdict must be pass | fail | changes-requested');
  }
  if (!REVIEW_STAGES.includes(verdict.stage)) {
    throw new Error(`review stage must be one of: ${REVIEW_STAGES.join(', ')}`);
  }
  return {
    stage: verdict.stage,
    verdict: verdict.verdict,
    reviewerId: verdict.reviewerId || null,
    findings: Array.isArray(verdict.findings) ? verdict.findings : [],
    risks: Array.isArray(verdict.risks) ? verdict.risks : [],
  };
};

// Which review stages apply, and whether an independent reviewer is required.
export const resolveReviewPlan = ({ riskTier = 'T0', publicContract = false, acceptanceAmbiguity = false, behaviorChanging = false } = {}) => {
  const stages = [];
  if (publicContract || acceptanceAmbiguity || RANK[riskTier] >= RANK.T2) {
    stages.push({ stage: 'contract', permissions: 'read_only', objective: 'Assess public-contract compatibility and acceptance semantics.' });
  }
  if (behaviorChanging || RANK[riskTier] >= RANK.T1) {
    stages.push({ stage: 'engineering', permissions: 'read_only', objective: 'Assess implementation standards and complexity.' });
  }
  return {
    stages,
    independentReviewerRequired: RANK[riskTier] >= RANK.T3,
  };
};

// A T3 review verdict is only valid from a reviewer whose context differs from
// the implementer's.
export const assertIndependentReview = ({ verdict, implementerId }) => {
  if (!verdict.reviewerId) {
    throw new Error('INDEPENDENT_REVIEW_REQUIRED: reviewerId is required for an independent review');
  }
  if (implementerId && verdict.reviewerId === implementerId) {
    throw new Error('INDEPENDENT_REVIEW_REQUIRED: reviewer must be independent of the implementer');
  }
  return true;
};

export const REVIEW_SEVERITIES = Object.freeze(['critical', 'important', 'minor']);
export const REVIEW_CATEGORIES = Object.freeze(['contract', 'architecture', 'implementation', 'security', 'verification']);
export const REVIEW_REQUIRED_ACTIONS = Object.freeze(['fix', 'replan', 'block']);

// §9.3: where a finding sends the run. A contract or architecture defect is
// not something the implementer can patch locally — it invalidates the plan.
const ACTION_FOR_CATEGORY = Object.freeze({
  contract: 'replan',
  architecture: 'replan',
  implementation: 'fix',
  verification: 'fix',
  security: 'block',
});

export const normalizeReviewFinding = (finding) => {
  if (typeof finding === 'string') {
    return { severity: 'minor', category: 'implementation', path: null, summary: finding, requiredAction: 'fix' };
  }
  if (!finding || typeof finding !== 'object') throw new Error('a review finding must be a string or an object');
  const category = REVIEW_CATEGORIES.includes(finding.category) ? finding.category : 'implementation';
  const severity = REVIEW_SEVERITIES.includes(finding.severity) ? finding.severity : 'minor';
  const inferred = severity === 'critical' && category === 'security' ? 'block' : ACTION_FOR_CATEGORY[category];
  return {
    severity,
    category,
    path: finding.path ? String(finding.path) : null,
    summary: String(finding.summary || ''),
    requiredAction: REVIEW_REQUIRED_ACTIONS.includes(finding.requiredAction) ? finding.requiredAction : inferred,
  };
};

// Decides which model class must handle the follow-up, so an architecture
// defect is never handed back to the implementer for a local patch.
export const classifyReviewFindings = (findings = []) => {
  const normalized = findings.map(normalizeReviewFinding);
  const requiredAction = normalized.some((finding) => finding.requiredAction === 'block') ? 'block'
    : normalized.some((finding) => finding.requiredAction === 'replan') ? 'replan'
      : normalized.some((finding) => finding.requiredAction === 'fix') ? 'fix' : 'none';
  return {
    findings: normalized,
    requiredAction,
    blocking: requiredAction === 'block',
    actionKind: requiredAction === 'fix' ? 'debug' : requiredAction === 'none' ? null : 'replan',
    modelClass: requiredAction === 'fix' ? 'value_coding' : requiredAction === 'none' ? null : 'frontier_reasoning',
  };
};

// §9.2: at T3 independence is proven by the Host session that actually ran the
// review, not by a caller-supplied reviewer string that anyone can invent.
export const assertIndependentReviewSession = ({ reviewDecision, reviewReceipt, implementationSession } = {}) => {
  if (!reviewReceipt) throw new Error('INDEPENDENT_REVIEW_REQUIRED: a routed T3 review requires the Host usage receipt for the reviewing session');
  if (!reviewDecision || reviewDecision.modelClass !== 'frontier_reasoning') {
    throw new Error('INDEPENDENT_REVIEW_REQUIRED: a T3 review must run on the frontier reasoning class');
  }
  // The class and the session are not enough: a planner or implementer turn on
  // the frontier class in its own session satisfies both. Only a turn the
  // Kernel actually routed AS a review can mint a review receipt.
  if (reviewDecision.role !== 'reviewer' || !REVIEW_ACTIONS.includes(reviewDecision.actionKind)) {
    throw new Error(`INDEPENDENT_REVIEW_REQUIRED: a T3 review must come from a routed reviewer turn, not a ${reviewDecision.role || 'unknown'} ${reviewDecision.actionKind || 'turn'}`);
  }
  if (!['enforced', 'fallback'].includes(reviewReceipt.enforcementStatus)) {
    throw new Error(`INDEPENDENT_REVIEW_REQUIRED: a T3 review cannot rest on ${reviewReceipt.enforcementStatus} model routing`);
  }
  if (implementationSession && reviewReceipt.actorSessionId === implementationSession.actorSessionId) {
    throw new Error('INDEPENDENT_REVIEW_REQUIRED: the reviewing session is the implementing session');
  }
  return true;
};

export const buildReviewContract = ({ stage, objective, acceptance = [], changedPaths = [] } = {}) => ({
  role: 'reviewer',
  stage,
  permissions: 'read_only',
  objective: objective || '',
  input: { acceptance, changedPaths },
  output: { verdict: '', findings: [], risks: [] },
});
