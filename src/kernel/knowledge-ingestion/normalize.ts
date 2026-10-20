import { sha256Hex } from '../../shared/candidate-identity.js';
import { redactObject, redactText } from './redact.js';

export type UnknownRecord = Record<string, unknown>;

const asRecord = (value: unknown): UnknownRecord => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : {}
);

const list = (value: unknown): string[] => (
  Array.isArray(value) ? value : value ? [value] : []
).map((item) => redactText(item)).filter(Boolean);

export interface SourceReceiptInput {
  sourceType?: unknown;
  provider?: unknown;
  sourceIdentity?: unknown;
  sourceDigest?: unknown;
  sourceSnapshotRef?: unknown;
}

export interface NormalizedSourceReceipt extends UnknownRecord {
  schemaVersion: 1;
  sourceType: string;
  provider: string | null;
  sourceIdentity: string;
  sourceDigest: string;
  sourceSnapshotRef: string | null;
}

export function normalizeSourceReceipt({
  sourceType,
  provider = null,
  sourceIdentity,
  sourceDigest,
  sourceSnapshotRef = null,
}: SourceReceiptInput = {}): NormalizedSourceReceipt {
  return {
    schemaVersion: 1,
    sourceType: String(sourceType || 'manual_statement'),
    provider: provider ? String(provider) : null,
    sourceIdentity: String(sourceIdentity || ''),
    sourceDigest: String(sourceDigest || ''),
    sourceSnapshotRef: sourceSnapshotRef ? String(sourceSnapshotRef) : null,
  };
}

export interface KnowledgeCandidateInput extends UnknownRecord {
  candidateId?: unknown;
  id?: unknown;
  projectId?: unknown;
  sourceType?: unknown;
  sourceIdentity?: unknown;
  sourceDigest?: unknown;
  proposedType?: unknown;
  type?: unknown;
  statement?: unknown;
  observation?: unknown;
  text?: unknown;
  scope?: unknown;
  sourceRefs?: unknown;
  relatedFiles?: unknown;
  evidenceRefs?: unknown;
  evidenceRef?: unknown;
  confidence?: unknown;
  status?: unknown;
  trustTier?: unknown;
  conflictRefs?: unknown;
  supersedes?: unknown;
  supersedesId?: unknown;
  feedbackClassification?: unknown;
  improvementPair?: unknown;
}

export interface NormalizeCandidateContext {
  projectId?: unknown;
  sourceType?: unknown;
  sourceIdentity?: unknown;
  sourceDigest?: unknown;
  defaultStatus?: unknown;
}

export interface NormalizedKnowledgeCandidate extends UnknownRecord {
  candidateId: string;
  projectId: unknown;
  sourceType: unknown;
  sourceIdentity: unknown;
  sourceDigest: unknown;
  proposedType: string;
  statement: string;
  scope: string[];
  sourceRefs: string[];
  relatedFiles: string[];
  evidenceRefs: string[];
  confidence: number;
  status: string;
  trustTier: string;
  conflictRefs: string[];
  supersedes: string[];
  feedbackClassification?: UnknownRecord;
  improvementPair?: UnknownRecord;
  provenance: {
    sourceType: unknown;
    sourceIdentity: unknown;
    sourceDigest: unknown;
  };
}

export function normalizeCandidate(
  candidate: KnowledgeCandidateInput = {},
  {
    projectId,
    sourceType,
    sourceIdentity,
    sourceDigest,
    defaultStatus = 'staged',
  }: NormalizeCandidateContext = {},
): NormalizedKnowledgeCandidate {
  const statement = redactText(
    candidate.statement || candidate.observation || candidate.text || '',
  ).trim();
  const scope = list(candidate.scope);
  const sourceRefs = list(candidate.sourceRefs);
  const relatedFiles = list(candidate.relatedFiles);
  const proposedType = String(
    candidate.proposedType || candidate.type || 'semantic_fact',
  );
  const identity = sha256Hex({
    projectId,
    sourceType,
    sourceIdentity,
    proposedType,
    statement,
    scope: [...scope].sort(),
  }).slice(0, 32);

  const normalized: NormalizedKnowledgeCandidate = {
    candidateId: String(candidate.candidateId || candidate.id || `cand-${identity}`),
    projectId,
    sourceType,
    sourceIdentity,
    sourceDigest,
    proposedType,
    statement,
    scope,
    sourceRefs,
    relatedFiles,
    evidenceRefs: list(candidate.evidenceRefs || candidate.evidenceRef),
    confidence: Number.isFinite(candidate.confidence)
      ? Number(candidate.confidence)
      : 0.5,
    status: String(candidate.status || defaultStatus),
    trustTier: String(candidate.trustTier || 'derived'),
    conflictRefs: list(candidate.conflictRefs),
    supersedes: list(candidate.supersedes || candidate.supersedesId),
    ...(candidate.feedbackClassification
      ? { feedbackClassification: asRecord(redactObject(candidate.feedbackClassification)) }
      : {}),
    ...(candidate.improvementPair
      ? { improvementPair: asRecord(redactObject(candidate.improvementPair)) }
      : {}),
    provenance: { sourceType, sourceIdentity, sourceDigest },
  };

  return asRecord(redactObject(normalized)) as NormalizedKnowledgeCandidate;
}

export interface NormalizeSessionContext {
  provider?: unknown;
  nativeSessionId?: unknown;
  locator?: unknown;
}

export interface NormalizedSession extends UnknownRecord {
  schemaVersion: 1;
  provider: string;
  nativeSessionId: string;
  locator: string | null;
  workingDirectory: string | null;
  remote: string | null;
  createdAt: unknown;
  updatedAt: unknown;
  objective: string | null;
  changedFiles: string[];
  decisions: string[];
  failures: string[];
  nextSteps: string[];
  sourceDigest: string;
}

export function normalizeSession(
  session: UnknownRecord = {},
  {
    provider,
    nativeSessionId,
    locator,
  }: NormalizeSessionContext = {},
): NormalizedSession {
  const safe = asRecord(redactObject(session));
  const workingDirectory = safe.workingDirectory
    || safe.cwd
    || safe.projectRoot
    || safe.workspaceRoot
    || null;
  const remote = safe.remote || safe.gitRemote || safe.repository || null;
  const changedFiles = list(safe.changedFiles || safe.changedPaths || safe.files);
  const decisions = list(
    safe.decisions || safe.userDecisions || safe.architectureChoices,
  );
  const failures = list(
    safe.failures || safe.knownFailures || safe.unresolvedIssues,
  );
  const digest = `sha256:${sha256Hex({
    provider,
    nativeSessionId,
    locator,
    workingDirectory,
    remote,
    changedFiles,
    decisions,
    failures,
    updatedAt: safe.updatedAt || safe.timestamp || null,
  })}`;

  return {
    schemaVersion: 1,
    provider: String(provider),
    nativeSessionId: String(nativeSessionId || safe.sessionId || safe.id || ''),
    locator: locator ? String(locator) : null,
    workingDirectory: workingDirectory ? String(workingDirectory) : null,
    remote: remote ? String(remote) : null,
    createdAt: safe.createdAt || safe.timestamp || null,
    updatedAt: safe.updatedAt || safe.timestamp || null,
    objective: safe.objective ? redactText(safe.objective) : null,
    changedFiles,
    decisions,
    failures,
    nextSteps: list(safe.nextSteps || safe.next),
    sourceDigest: digest,
  };
}
