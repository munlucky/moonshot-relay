import { sha256Hex } from './candidate-identity.js';

export const CHANGE_INVALIDATION_MATRIX = Object.freeze({
  spec: ['plan', 'run', 'review', 'verify', 'score', 'submission'],
  done: ['plan', 'run', 'review', 'verify', 'score', 'submission'],
  design: ['plan', 'run', 'review', 'verify', 'score', 'submission'],
  plan: ['run', 'review', 'verify', 'score', 'submission'],
  source: ['review', 'verify', 'score', 'submission'],
  lockfile: ['environment', 'verify', 'score', 'submission'],
  environment: ['verify', 'score', 'submission'],
  policy: ['score', 'submission'],
});

export const invalidatesForChange = (changeType) => [...(CHANGE_INVALIDATION_MATRIX[changeType] || [])];

export const contractDigest = (contract) => sha256Hex(contract);

export const createSpecRevision = ({
  previousRevision = null,
  nextContract,
  changeType = 'spec',
  actor = 'moonshot-relay',
  reason = '',
  createdAt = new Date().toISOString(),
} = {}) => {
  if (!nextContract || typeof nextContract !== 'object') {
    throw new Error('nextContract is required');
  }

  const previousDigest = previousRevision?.contractDigest || '';
  const nextDigest = contractDigest(nextContract);
  const unchanged = previousDigest && previousDigest === nextDigest;
  if (previousRevision?.frozen === true && !unchanged && !reason) {
    throw new Error('frozen contract changes require an explicit revision reason');
  }

  return {
    schemaVersion: 1,
    revision: unchanged ? previousRevision.revision : (previousRevision?.revision || 0) + 1,
    frozen: Boolean(nextContract.frozen),
    changeType,
    contractDigest: nextDigest,
    previousDigest,
    invalidates: invalidatesForChange(changeType),
    actor,
    reason,
    createdAt,
  };
};

export const classifyAmbiguity = (contract = {}) => {
  const unresolvedConstraints = (contract.constraints || []).filter((item) => item.status === 'unresolved');
  const acceptance = contract.acceptanceCriteria || [];
  const uncoveredAcceptance = acceptance.filter((item) => item.covered === false || !item.verification);
  const blockers = [
    ...unresolvedConstraints.map((item) => ({ type: 'unresolved_constraint', id: item.id || item.summary })),
    ...uncoveredAcceptance.map((item) => ({ type: 'uncovered_acceptance', id: item.id || item.summary })),
  ];
  return {
    status: blockers.length > 0 ? 'ambiguous' : 'clear',
    blockers,
  };
};

export const assertEvidenceCurrent = ({ evidenceRevision, activeRevision, waiver = null } = {}) => {
  if (!activeRevision) throw new Error('activeRevision is required');
  if (evidenceRevision === activeRevision) return true;
  if (waiver?.approved === true && waiver?.activeRevision === activeRevision) return true;
  throw new Error(`stale evidence revision: expected ${activeRevision}, got ${evidenceRevision || '(missing)'}`);
};
