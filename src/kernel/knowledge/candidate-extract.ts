import crypto from 'node:crypto';
import { analyzeChangeDiff } from './change-diff.js';

interface EvidencePackLike {
  digest: string;
  status?: string;
}

export interface ExtractKnowledgeCandidatesInput {
  runId: string;
  projectId: string;
  objective?: string;
  changedFiles?: string[];
  evidencePack?: EvidencePackLike | null;
  observedStatements?: string[];
}

export function extractKnowledgeCandidates({
  runId,
  projectId,
  objective: _objective,
  changedFiles = [],
  evidencePack = null,
  observedStatements = [],
}: ExtractKnowledgeCandidatesInput) {
  const diffInfo = analyzeChangeDiff({ changedFiles });
  void diffInfo;

  const candidates = [];
  for (const statement of observedStatements) {
    if (
      /sk-[a-zA-Z0-9]{20,}/.test(statement)
      || statement.toLowerCase().includes('raw_transcript_body')
    ) {
      continue;
    }

    const candidateId = 'cand-' + crypto
      .createHash('sha256')
      .update(`${runId}:${statement}`)
      .digest('hex')
      .slice(0, 12);

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
