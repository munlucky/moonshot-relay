import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const SHA256_RE = /^[a-f0-9]{64}$/;
const CANDIDATE_ID_RE = /^cand_[a-f0-9]{32}$/;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export const canonicalStringify = (value) => {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalStringify(item)).join(',')}]`;

  return `{${Object.entries(value)
    .filter(([, nested]) => nested !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalStringify(nested)}`)
    .join(',')}}`;
};

export const sha256Hex = (value) => crypto
  .createHash('sha256')
  .update(typeof value === 'string' ? value : canonicalStringify(value))
  .digest('hex');

export const normalizeDigest = (value) => {
  if (typeof value === 'string' && SHA256_RE.test(value)) return value;
  if (isObject(value) && typeof value.digest === 'string' && SHA256_RE.test(value.digest)) return value.digest;
  if (isObject(value) && typeof value.sha256 === 'string' && SHA256_RE.test(value.sha256)) return value.sha256;
  if (isObject(value) && typeof value.tree === 'string' && SHA256_RE.test(value.tree)) return value.tree;
  return sha256Hex(value ?? '');
};

export const gitTreeDigest = (cwd = process.cwd()) => {
  const result = spawnSync('git', ['rev-parse', 'HEAD^{tree}'], {
    cwd,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    return '';
  }
  return result.stdout.trim();
};

export const buildCandidateDimensions = (input = {}) => ({
  task: normalizeDigest(input.task ?? input.taskDigest ?? ''),
  spec: normalizeDigest(input.spec ?? input.specDigest ?? ''),
  plan: normalizeDigest(input.plan ?? input.planDigest ?? ''),
  done: normalizeDigest(input.done ?? input.doneDigest ?? ''),
  source: normalizeDigest(input.source ?? input.sourceDigest ?? ''),
  environment: normalizeDigest(input.environment ?? input.environmentDigest ?? ''),
  policy: normalizeDigest(input.policy ?? input.policyDigest ?? ''),
});

export const buildCandidateIdentity = (input = {}) => {
  const profile = input.profile || 'full';
  const dimensions = buildCandidateDimensions(input);
  const candidate_id = `cand_${sha256Hex({ profile, dimensions }).slice(0, 32)}`;
  return {
    schemaVersion: 1,
    candidate_id,
    candidateId: candidate_id,
    profile,
    dimensions,
  };
};

export const normalizeCandidateId = (receipt = {}) => {
  const value = receipt.candidate_id
    || receipt.candidateId
    || receipt.candidate?.candidate_id
    || receipt.candidate?.candidateId
    || receipt.candidateIdentity?.candidate_id
    || receipt.candidateIdentity?.candidateId
    || '';
  return CANDIDATE_ID_RE.test(value) ? value : '';
};

export const evidenceBinding = (receipt = {}) => ({
  candidate_id: normalizeCandidateId(receipt),
  sourceDigest: receipt.sourceDigest
    || receipt.source?.digest
    || receipt.candidate?.dimensions?.source
    || receipt.candidateIdentity?.dimensions?.source
    || '',
  environmentDigest: receipt.environmentDigest
    || receipt.environment?.digest
    || receipt.candidate?.dimensions?.environment
    || receipt.candidateIdentity?.dimensions?.environment
    || '',
  policyDigest: receipt.policyDigest
    || receipt.policy?.digest
    || receipt.candidate?.dimensions?.policy
    || receipt.candidateIdentity?.dimensions?.policy
    || '',
});

export const compareEvidenceBinding = (expected, actual) => {
  const left = evidenceBinding(expected);
  const right = evidenceBinding(actual);
  const mismatches = [];
  for (const field of ['candidate_id', 'sourceDigest', 'environmentDigest', 'policyDigest']) {
    if ((left[field] || '') !== (right[field] || '')) {
      mismatches.push({ field, expected: left[field] || '', actual: right[field] || '' });
    }
  }
  return { matched: mismatches.length === 0, mismatches };
};

export const assertEvidenceBinding = (expected, actual) => {
  const result = compareEvidenceBinding(expected, actual);
  if (!result.matched) {
    throw new Error(`stale candidate evidence: ${result.mismatches.map((item) => item.field).join(', ')}`);
  }
  return true;
};
