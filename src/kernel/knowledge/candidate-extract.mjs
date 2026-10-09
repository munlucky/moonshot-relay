import crypto from 'node:crypto';
import { analyzeChangeDiff } from './change-diff.mjs';

export function extractKnowledgeCandidates({
  runId,
  projectId,
  objective,
  changedFiles = [],
  evidencePack = null,
  observedStatements = [],
}) {
  const diffInfo = analyzeChangeDiff({ changedFiles });
  const candidates = [];

  for (const statement of observedStatements) {
    // Secret or transcript body rejection
    if (/sk-[a-zA-Z0-9]{20,}/.test(statement) || statement.toLowerCase().includes('raw_transcript_body')) {
      continue;
    }

    const candidateId = `cand-${crypto.createHash('sha256').update(`${runId}:${statement}`).digest('hex').slice(0, 12)}`;
    candidates.push({
      candidateId,
      runId,
      projectId,
      proposedType: 'semantic_fact',
      statement,
      scope: changedFiles,
      relatedFiles: changedFiles,
      sourceRefs: changedFiles.slice(0, 5),
      evidenceRefs: evidencePack ? [evidencePack.digest] : [],
      confidence: evidencePack?.status === 'pass' ? 0.9 : 0.4,
      status: 'observed',
      supersedes: [],
      rejectionReasons: [],
    });
  }

  return candidates;
}
