import fs from 'node:fs';
import path from 'node:path';
import { redactText } from './redact.mjs';

const completionClaim = /\b(implemented|complete|completed|fixed|passed|done|구현|완료|수정|통과)\b/i;

export function verifyCandidate(candidate, { projectRoot, sourceType = candidate.sourceType } = {}) {
  const sourceRefs = Array.isArray(candidate.sourceRefs) ? candidate.sourceRefs : [];
  const safeRefs = sourceRefs.filter((ref) => !path.isAbsolute(ref) || path.resolve(projectRoot, ref).startsWith(`${path.resolve(projectRoot)}${path.sep}`));
  const filesExist = safeRefs.length === 0 || safeRefs.every((ref) => fs.existsSync(path.resolve(projectRoot, ref)));
  const claim = redactText(candidate.statement || '');
  if (sourceType === 'codebase_index' && filesExist) return { ...candidate, status: 'verified', trustTier: 'verified', evidenceRefs: [...new Set([...(candidate.evidenceRefs || []), `source://${sourceType}`])] };
  if (completionClaim.test(claim) && !(candidate.evidenceRefs || []).length) return { ...candidate, status: 'observed', trustTier: 'derived', verification: 'model_claim_without_evidence' };
  if (!filesExist) return { ...candidate, status: 'observed', trustTier: 'derived', verification: 'source_reference_missing' };
  return { ...candidate, status: candidate.status || 'staged', trustTier: candidate.trustTier || 'derived' };
}

export function verifyCandidates(candidates = [], options = {}) {
  return candidates.map((candidate) => verifyCandidate(candidate, options));
}
