import { sha256Hex } from '../../shared/candidate-identity.mjs';
import { redactObject, redactText } from './redact.mjs';

const list = (value) => (Array.isArray(value) ? value : value ? [value] : []).map((item) => redactText(item)).filter(Boolean);

export function normalizeSourceReceipt({ sourceType, provider = null, sourceIdentity, sourceDigest, sourceSnapshotRef = null } = {}) {
  return {
    schemaVersion: 1,
    sourceType: String(sourceType || 'manual_statement'),
    provider: provider ? String(provider) : null,
    sourceIdentity: String(sourceIdentity || ''),
    sourceDigest: String(sourceDigest || ''),
    sourceSnapshotRef: sourceSnapshotRef ? String(sourceSnapshotRef) : null,
  };
}

export function normalizeCandidate(candidate = {}, { projectId, sourceType, sourceIdentity, sourceDigest, defaultStatus = 'staged' } = {}) {
  const statement = redactText(candidate.statement || candidate.observation || candidate.text || '').trim();
  const scope = list(candidate.scope || candidate.sourceRefs || candidate.relatedFiles);
  const proposedType = String(candidate.proposedType || candidate.type || 'semantic_fact');
  const identity = sha256Hex({ projectId, sourceType, sourceIdentity, proposedType, statement, scope: [...scope].sort() }).slice(0, 32);
  return redactObject({
    candidateId: candidate.candidateId || candidate.id || `cand-${identity}`,
    projectId,
    sourceType,
    sourceIdentity,
    sourceDigest,
    proposedType,
    statement,
    scope,
    sourceRefs: scope,
    evidenceRefs: list(candidate.evidenceRefs || candidate.evidenceRef),
    confidence: Number.isFinite(candidate.confidence) ? Number(candidate.confidence) : 0.5,
    status: candidate.status || defaultStatus,
    trustTier: candidate.trustTier || 'derived',
    conflictRefs: list(candidate.conflictRefs),
    supersedes: list(candidate.supersedes || candidate.supersedesId),
    provenance: { sourceType, sourceIdentity, sourceDigest },
  });
}

export function normalizeSession(session = {}, { provider, nativeSessionId, locator } = {}) {
  const safe = redactObject(session);
  const workingDirectory = safe.workingDirectory || safe.cwd || safe.projectRoot || safe.workspaceRoot || null;
  const remote = safe.remote || safe.gitRemote || safe.repository || null;
  const changedFiles = list(safe.changedFiles || safe.changedPaths || safe.files);
  const decisions = list(safe.decisions || safe.userDecisions || safe.architectureChoices);
  const failures = list(safe.failures || safe.knownFailures || safe.unresolvedIssues);
  const digest = `sha256:${sha256Hex({ provider, nativeSessionId, locator, workingDirectory, remote, changedFiles, decisions, failures, updatedAt: safe.updatedAt || safe.timestamp || null })}`;
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
