import { matchCapture } from '../../shared/match-capture.js';
import { normalizeCandidate } from './normalize.js';
import { deduplicateCandidates } from './deduplicate.js';
import type {
  NormalizedKnowledgeCandidate,
  UnknownRecord,
} from './normalize.js';

const decisionPattern = /^(?:decided|decision|architecture|we will|사용자 결정|결정|아키텍처)\s*[:\-]?\s*(.+)$/i;

export interface SessionCandidateSource extends UnknownRecord {
  provider?: string;
  nativeSessionId?: string;
  sourceDigest?: unknown;
  decisions?: string[];
  failures?: string[];
  nextSteps?: string[];
  objective?: string | null;
  statements?: unknown[];
  changedFiles?: string[];
}

export interface CandidateExtractionContext {
  projectId?: unknown;
  sourceType?: unknown;
  sourceIdentity?: unknown;
  sourceDigest?: unknown;
}

interface CodebaseFileLike extends UnknownRecord {
  path?: string;
  symbols?: string[];
  apiSurface?: string[];
}

interface CodebaseIndexLike extends UnknownRecord {
  sourceTreeDigest?: unknown;
  files?: CodebaseFileLike[];
}

export function extractSessionCandidates(
  session: SessionCandidateSource = {},
  {
    projectId,
    sourceType = `${session.provider || 'provider'}_session`,
    sourceIdentity = session.provider && session.nativeSessionId
      ? `${session.provider}:${session.nativeSessionId}`
      : session.nativeSessionId,
    sourceDigest = session.sourceDigest,
  }: CandidateExtractionContext = {},
): NormalizedKnowledgeCandidate[] {
  const raw: Array<Record<string, unknown>> = [];
  for (const decision of session.decisions || []) {
    raw.push({
      proposedType: 'architecture_decision',
      statement: decision,
      scope: session.changedFiles,
      relatedFiles: session.changedFiles,
      status: 'staged',
      trustTier: 'derived',
    });
  }
  for (const failure of session.failures || []) {
    raw.push({
      proposedType: 'episodic_observation',
      statement: failure,
      scope: session.changedFiles,
      relatedFiles: session.changedFiles,
      status: 'observed',
      trustTier: 'derived',
    });
  }
  for (const next of session.nextSteps || []) {
    raw.push({
      proposedType: 'required_verification',
      statement: next,
      scope: session.changedFiles,
      relatedFiles: session.changedFiles,
      status: 'staged',
      trustTier: 'derived',
    });
  }
  if (session.objective) {
    raw.push({
      proposedType: 'episodic_observation',
      statement: `Session objective: ${session.objective}`,
      scope: session.changedFiles,
      relatedFiles: session.changedFiles,
      status: 'observed',
      trustTier: 'derived',
    });
  }
  for (const text of session.statements || []) {
    const match = String(text).match(decisionPattern);
    if (match?.[1]) {
      raw.push({
        proposedType: 'architecture_decision',
        statement: matchCapture(match, 1),
        scope: session.changedFiles,
        relatedFiles: session.changedFiles,
        status: 'staged',
        trustTier: 'derived',
      });
    }
  }

  return deduplicateCandidates(
    raw.map((candidate) => normalizeCandidate(candidate, {
      projectId,
      sourceType,
      sourceIdentity,
      sourceDigest,
      defaultStatus: candidate.status || 'observed',
    })),
  );
}

export function extractCodebaseCandidates(
  index: CodebaseIndexLike = {},
  {
    projectId,
    sourceDigest = index.sourceTreeDigest,
  }: Pick<CandidateExtractionContext, 'projectId' | 'sourceDigest'> = {},
): NormalizedKnowledgeCandidate[] {
  const candidates: NormalizedKnowledgeCandidate[] = [];
  for (const file of index.files || []) {
    if (!file.path || file.path.startsWith('tests/')) continue;
    const scope = [file.path];
    const sourceRefs = [file.path];
    const symbol = file.symbols?.[0];
    candidates.push(normalizeCandidate({
      proposedType: 'component_boundary',
      statement: `Module ${file.path} owns ${symbol ? `the ${symbol} symbols` : 'its implementation responsibility'}.`,
      scope,
      sourceRefs,
      relatedFiles: scope,
      status: 'verified',
      trustTier: 'verified',
      evidenceRefs: [sourceDigest],
    }, {
      projectId,
      sourceType: 'codebase_index',
      sourceIdentity: `codebase:${sourceDigest}`,
      sourceDigest,
      defaultStatus: 'verified',
    }));

    for (const api of file.apiSurface || []) {
      candidates.push(normalizeCandidate({
        proposedType: 'api_contract',
        statement: `${file.path} exposes ${api}.`,
        scope,
        sourceRefs,
        relatedFiles: scope,
        status: 'verified',
        trustTier: 'verified',
        evidenceRefs: [sourceDigest],
      }, {
        projectId,
        sourceType: 'codebase_index',
        sourceIdentity: `codebase:${sourceDigest}`,
        sourceDigest,
        defaultStatus: 'verified',
      }));
    }
  }
  return deduplicateCandidates(candidates);
}
