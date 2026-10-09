import crypto from 'node:crypto';

export function buildKnowledgeCommitReceipt({
  runId,
  projectId,
  sourceIdentity = 'kernel-source-identity',
  mutationRevision = 1,
  completionDecisionRef = null,
  revisionBefore,
  revisionAfter,
  acceptedCandidates = [],
  rejectedCandidates = [],
  supersededRecords = [],
  evidenceRefs = [],
  filesWritten = [],
  projectionStatus = 'completed',
  status = 'committed',
}) {
  const payload = {
    schemaVersion: 1,
    runId,
    projectId,
    sourceIdentity,
    mutationRevision,
    completionDecisionRef: completionDecisionRef || `accepted-${runId}`,
    revisionBefore,
    revisionAfter,
    acceptedCandidates,
    rejectedCandidates,
    supersededRecords,
    evidenceRefs,
    filesWritten,
    projectionStatus,
    status,
  };

  const digest = crypto
    .createHash('sha256')
    .update(JSON.stringify(payload))
    .digest('hex');

  payload.digest = digest;
  return payload;
}
