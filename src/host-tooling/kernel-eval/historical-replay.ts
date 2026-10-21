import { createHash } from 'node:crypto';
import {
  classifyGenerationRelevance,
  type HistoricalKnowledgeAnalysis,
  type HistoricalKnowledgeFinding,
  type HistoricalWorkCase,
} from './historical-improvement.js';
import {
  compareModelPromptReplay,
  type ModelPromptReplayAllowedDifference,
  type ModelPromptReplayAttempt,
  type ModelPromptReplayProtocol,
} from './model-prompt-replay.js';

export type HistoricalReplaySeam =
  | 'context-selection'
  | 'knowledge-dedupe'
  | 'model'
  | 'effort'
  | 'verification-guidance'
  | 'prompt-guidance';

export type HistoricalReplayDecision = 'PROMOTE' | 'KEEP_BASELINE' | 'INSUFFICIENT_EVIDENCE';

export interface HistoricalReplayCandidate {
  schemaVersion: 'kernel-historical-replay-candidate.v1';
  candidateId: string;
  findingId: HistoricalKnowledgeFinding['id'];
  seam: HistoricalReplaySeam;
  caseIds: string[];
  allowedDifferences: ModelPromptReplayAllowedDifference[];
  currentComparableEvidenceCount: number;
  singleVariable: true;
  decisionOrder: readonly ['quality', 'rework', 'efficiency'];
  productionMutationAllowed: false;
  promotionAuthority: false;
}

export interface HistoricalReplayBlockedFinding {
  findingId: HistoricalKnowledgeFinding['id'];
  status: HistoricalKnowledgeFinding['status'];
  reason: 'finding-not-candidate' | 'unsupported-replay-seam' | 'current-case-identity-missing';
}

export interface HistoricalReplayQueue {
  schemaVersion: 'kernel-historical-replay-queue.v1';
  candidates: HistoricalReplayCandidate[];
  blocked: HistoricalReplayBlockedFinding[];
  productionMutationAllowed: false;
  promotionAuthority: false;
}

const findingSeam = new Map<HistoricalKnowledgeFinding['id'], HistoricalReplaySeam>([
  ['knowledge-duplicate-context', 'knowledge-dedupe'],
]);

const seamAllowedDifferences: Record<HistoricalReplaySeam, readonly ModelPromptReplayAllowedDifference[]> = {
  'context-selection': ['providerMessageDigest'],
  'knowledge-dedupe': ['providerMessageDigest'],
  model: ['model'],
  effort: ['effort'],
  'verification-guidance': ['providerMessageDigest'],
  'prompt-guidance': ['providerMessageDigest'],
};

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

const evidenceCasesForFinding = (
  finding: HistoricalKnowledgeFinding,
  cases: readonly HistoricalWorkCase[],
): HistoricalWorkCase[] => {
  const evidenceRunIds = new Set(finding.evidenceRunIds);
  return cases.filter((item) => item.lineageRunIds.some((runId) => evidenceRunIds.has(runId)));
};

const currentCaseIds = ({
  finding,
  cases,
  currentGitRevision,
  gitRoot,
}: {
  finding: HistoricalKnowledgeFinding;
  cases: readonly HistoricalWorkCase[];
  currentGitRevision: string | null;
  gitRoot: string | null;
}): string[] => evidenceCasesForFinding(finding, cases)
  .filter((item) => classifyGenerationRelevance({
    gitRevision: item.gitRevision,
    currentGitRevision,
    fixingSeamRevision: finding.fixingSeamRevision,
    gitRoot,
  }) === 'current')
  .map((item) => item.caseId)
  .sort();

export const buildHistoricalReplayQueue = ({
  analysis,
  cases,
  currentGitRevision = null,
  gitRoot = null,
}: {
  analysis: HistoricalKnowledgeAnalysis;
  cases: readonly HistoricalWorkCase[];
  currentGitRevision?: string | null;
  gitRoot?: string | null;
}): HistoricalReplayQueue => {
  const candidates: HistoricalReplayCandidate[] = [];
  const blocked: HistoricalReplayBlockedFinding[] = [];

  for (const finding of analysis.findings) {
    if (finding.status !== 'CANDIDATE') {
      blocked.push({ findingId: finding.id, status: finding.status, reason: 'finding-not-candidate' });
      continue;
    }
    const seam = findingSeam.get(finding.id) || null;
    if (!seam) {
      blocked.push({ findingId: finding.id, status: finding.status, reason: 'unsupported-replay-seam' });
      continue;
    }
    const caseIds = currentCaseIds({ finding, cases, currentGitRevision, gitRoot });
    if (caseIds.length === 0 || finding.currentComparableEvidenceCount === 0) {
      blocked.push({ findingId: finding.id, status: finding.status, reason: 'current-case-identity-missing' });
      continue;
    }
    const allowedDifferences = [...seamAllowedDifferences[seam]];
    if (allowedDifferences.length !== 1) {
      throw new Error(`historical replay seam must declare exactly one allowed difference: ${seam}`);
    }
    candidates.push(Object.freeze({
      schemaVersion: 'kernel-historical-replay-candidate.v1',
      candidateId: `historical-replay-${sha256(`${finding.id}|${seam}|${caseIds.join('|')}`).slice(0, 24)}`,
      findingId: finding.id,
      seam,
      caseIds,
      allowedDifferences,
      currentComparableEvidenceCount: finding.currentComparableEvidenceCount,
      singleVariable: true,
      decisionOrder: ['quality', 'rework', 'efficiency'] as const,
      productionMutationAllowed: false,
      promotionAuthority: false,
    }));
  }

  return Object.freeze({
    schemaVersion: 'kernel-historical-replay-queue.v1',
    candidates: candidates.sort((left, right) => left.candidateId.localeCompare(right.candidateId)),
    blocked: blocked.sort((left, right) => left.findingId.localeCompare(right.findingId)),
    productionMutationAllowed: false,
    promotionAuthority: false,
  });
};

export const compareHistoricalReplayCandidate = ({
  candidate,
  protocol,
  attempts,
}: {
  candidate: HistoricalReplayCandidate;
  protocol: ModelPromptReplayProtocol;
  attempts: ModelPromptReplayAttempt[];
}) => {
  if (!candidate.singleVariable || candidate.allowedDifferences.length !== 1) {
    throw new Error('historical replay candidate must remain single-variable');
  }
  const candidateCaseIds = [...candidate.caseIds].sort();
  const protocolCaseIds = protocol.cases.map((item) => item.id).sort();
  if (JSON.stringify(candidateCaseIds) !== JSON.stringify(protocolCaseIds)) {
    throw new Error('historical replay protocol cases must exactly match the candidate cases');
  }
  const replay = compareModelPromptReplay({
    protocol,
    attempts,
    experiment: { allowedDifferences: candidate.allowedDifferences },
  });
  const decision: HistoricalReplayDecision = replay.status === 'eligible'
    ? 'PROMOTE'
    : replay.status === 'not-ready'
      ? 'INSUFFICIENT_EVIDENCE'
      : 'KEEP_BASELINE';
  return Object.freeze({
    schemaVersion: 'kernel-historical-replay-decision.v1' as const,
    candidateId: candidate.candidateId,
    decision,
    replay,
    productionMutationAllowed: false as const,
    promotionAuthority: false as const,
  });
};
