import { normalizeCandidate } from './normalize.mjs';
import { deduplicateCandidates } from './deduplicate.mjs';

const decisionPattern = /^(?:decided|decision|architecture|we will|사용자 결정|결정|아키텍처)\s*[:\-]?\s*(.+)$/i;

export function extractSessionCandidates(session = {}, { projectId, sourceType = `${session.provider || 'provider'}_session`, sourceIdentity = session.provider && session.nativeSessionId ? `${session.provider}:${session.nativeSessionId}` : session.nativeSessionId, sourceDigest = session.sourceDigest } = {}) {
  const raw = [];
  for (const decision of session.decisions || []) raw.push({ proposedType: 'architecture_decision', statement: decision, scope: session.changedFiles, status: 'staged', trustTier: 'derived' });
  for (const failure of session.failures || []) raw.push({ proposedType: 'known_failure_pattern', statement: failure, scope: session.changedFiles, status: 'observed', trustTier: 'derived' });
  for (const next of session.nextSteps || []) raw.push({ proposedType: 'required_verification', statement: next, scope: session.changedFiles, status: 'staged', trustTier: 'derived' });
  if (session.objective) raw.push({ proposedType: 'episodic_observation', statement: `Session objective: ${session.objective}`, scope: session.changedFiles, status: 'observed', trustTier: 'derived' });
  for (const text of session.statements || []) {
    const match = String(text).match(decisionPattern);
    if (match) raw.push({ proposedType: 'architecture_decision', statement: match[1], scope: session.changedFiles, status: 'staged', trustTier: 'derived' });
  }
  return deduplicateCandidates(raw.map((candidate) => normalizeCandidate(candidate, { projectId, sourceType, sourceIdentity, sourceDigest, defaultStatus: candidate.status || 'observed' })));
}

export function extractCodebaseCandidates(index = {}, { projectId, sourceDigest = index.sourceTreeDigest } = {}) {
  const candidates = [];
  for (const file of index.files || []) {
    if (!file.path || file.path.startsWith('tests/')) continue;
    const scope = [file.path];
    const symbol = file.symbols?.[0];
    candidates.push(normalizeCandidate({
      proposedType: 'component_boundary',
      statement: `Module ${file.path} owns ${symbol ? `the ${symbol} symbols` : 'its implementation responsibility'}.`,
      scope,
      status: 'verified',
      trustTier: 'verified',
      evidenceRefs: [sourceDigest],
    }, { projectId, sourceType: 'codebase_index', sourceIdentity: `codebase:${sourceDigest}`, sourceDigest, defaultStatus: 'verified' }));
    for (const api of file.apiSurface || []) candidates.push(normalizeCandidate({ proposedType: 'api_contract', statement: `${file.path} exposes ${api}.`, scope, status: 'verified', trustTier: 'verified', evidenceRefs: [sourceDigest] }, { projectId, sourceType: 'codebase_index', sourceIdentity: `codebase:${sourceDigest}`, sourceDigest, defaultStatus: 'verified' }));
  }
  return deduplicateCandidates(candidates);
}
