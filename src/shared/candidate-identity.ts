import crypto from 'node:crypto';

const SHA256_RE = /^[a-f0-9]{64}$/;
const CANDIDATE_ID_RE = /^cand_[a-f0-9]{32}$/;

type UnknownRecord = Record<string, unknown>;

const isObject = (value: unknown): value is UnknownRecord => (
  value !== null
  && typeof value === 'object'
  && !Array.isArray(value)
);

export const canonicalStringify = (value: unknown): string => {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) as string;
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalStringify(item)).join(',')}]`;
  }

  return `{${Object.entries(value)
    .filter(([, nested]) => nested !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => (
      `${JSON.stringify(key)}:${canonicalStringify(nested)}`
    ))
    .join(',')}}`;
};

export const sha256Hex = (value: unknown): string => crypto
  .createHash('sha256')
  .update(typeof value === 'string' ? value : canonicalStringify(value))
  .digest('hex');

export const normalizeDigest = (value: unknown): string => {
  if (typeof value === 'string' && SHA256_RE.test(value)) return value;
  if (
    isObject(value)
    && typeof value.digest === 'string'
    && SHA256_RE.test(value.digest)
  ) {
    return value.digest;
  }
  if (
    isObject(value)
    && typeof value.sha256 === 'string'
    && SHA256_RE.test(value.sha256)
  ) {
    return value.sha256;
  }
  if (
    isObject(value)
    && typeof value.tree === 'string'
    && SHA256_RE.test(value.tree)
  ) {
    return value.tree;
  }
  return sha256Hex(value ?? '');
};

export interface CandidateDimensionsInput extends UnknownRecord {
  task?: unknown;
  taskDigest?: unknown;
  spec?: unknown;
  specDigest?: unknown;
  plan?: unknown;
  planDigest?: unknown;
  done?: unknown;
  doneDigest?: unknown;
  source?: unknown;
  sourceDigest?: unknown;
  environment?: unknown;
  environmentDigest?: unknown;
  policy?: unknown;
  policyDigest?: unknown;
}

export interface CandidateDimensions {
  task: string;
  spec: string;
  plan: string;
  done: string;
  source: string;
  environment: string;
  policy: string;
}

export const buildCandidateDimensions = (
  input: CandidateDimensionsInput = {},
): CandidateDimensions => ({
  task: normalizeDigest(input.task ?? input.taskDigest ?? ''),
  spec: normalizeDigest(input.spec ?? input.specDigest ?? ''),
  plan: normalizeDigest(input.plan ?? input.planDigest ?? ''),
  done: normalizeDigest(input.done ?? input.doneDigest ?? ''),
  source: normalizeDigest(input.source ?? input.sourceDigest ?? ''),
  environment: normalizeDigest(
    input.environment ?? input.environmentDigest ?? '',
  ),
  policy: normalizeDigest(input.policy ?? input.policyDigest ?? ''),
});

export interface CandidateIdentityInput extends CandidateDimensionsInput {
  profile?: unknown;
}

export interface CandidateIdentity {
  schemaVersion: 1;
  candidate_id: string;
  candidateId: string;
  profile: unknown;
  dimensions: CandidateDimensions;
}

export const buildCandidateIdentity = (
  input: CandidateIdentityInput = {},
): CandidateIdentity => {
  const profile = input.profile || 'full';
  const dimensions = buildCandidateDimensions(input);
  const candidate_id = `cand_${sha256Hex({
    profile,
    dimensions,
  }).slice(0, 32)}`;
  return {
    schemaVersion: 1,
    candidate_id,
    candidateId: candidate_id,
    profile,
    dimensions,
  };
};

const recordAt = (
  value: unknown,
  key: string,
): UnknownRecord => {
  if (!isObject(value)) return {};
  const nested = value[key];
  return isObject(nested) ? nested : {};
};

export const normalizeCandidateId = (
  receipt: UnknownRecord = {},
): string => {
  const candidate = recordAt(receipt, 'candidate');
  const candidateIdentity = recordAt(receipt, 'candidateIdentity');
  const value = receipt.candidate_id
    || receipt.candidateId
    || candidate.candidate_id
    || candidate.candidateId
    || candidateIdentity.candidate_id
    || candidateIdentity.candidateId
    || '';
  const normalized = String(value);
  return CANDIDATE_ID_RE.test(normalized) ? normalized : '';
};

export interface EvidenceBinding {
  candidate_id: string;
  sourceDigest: unknown;
  environmentDigest: unknown;
  policyDigest: unknown;
}

const dimensionFrom = (
  receipt: UnknownRecord,
  owner: 'candidate' | 'candidateIdentity',
  field: keyof CandidateDimensions,
): unknown => {
  const nested = recordAt(receipt, owner);
  const dimensions = recordAt(nested, 'dimensions');
  return dimensions[field];
};

const digestFrom = (
  receipt: UnknownRecord,
  owner: 'source' | 'environment' | 'policy',
): unknown => {
  const nested = recordAt(receipt, owner);
  return nested.digest;
};

export const evidenceBinding = (
  receipt: UnknownRecord = {},
): EvidenceBinding => ({
  candidate_id: normalizeCandidateId(receipt),
  sourceDigest: receipt.sourceDigest
    || digestFrom(receipt, 'source')
    || dimensionFrom(receipt, 'candidate', 'source')
    || dimensionFrom(receipt, 'candidateIdentity', 'source')
    || '',
  environmentDigest: receipt.environmentDigest
    || digestFrom(receipt, 'environment')
    || dimensionFrom(receipt, 'candidate', 'environment')
    || dimensionFrom(receipt, 'candidateIdentity', 'environment')
    || '',
  policyDigest: receipt.policyDigest
    || digestFrom(receipt, 'policy')
    || dimensionFrom(receipt, 'candidate', 'policy')
    || dimensionFrom(receipt, 'candidateIdentity', 'policy')
    || '',
});

export interface EvidenceBindingMismatch {
  field: keyof EvidenceBinding;
  expected: unknown;
  actual: unknown;
}

export interface EvidenceBindingComparison {
  matched: boolean;
  mismatches: EvidenceBindingMismatch[];
}

export const compareEvidenceBinding = (
  expected: UnknownRecord,
  actual: UnknownRecord,
): EvidenceBindingComparison => {
  const left = evidenceBinding(expected);
  const right = evidenceBinding(actual);
  const mismatches: EvidenceBindingMismatch[] = [];
  const fields: Array<keyof EvidenceBinding> = [
    'candidate_id',
    'sourceDigest',
    'environmentDigest',
    'policyDigest',
  ];
  for (const field of fields) {
    if ((left[field] || '') !== (right[field] || '')) {
      mismatches.push({
        field,
        expected: left[field] || '',
        actual: right[field] || '',
      });
    }
  }
  return { matched: mismatches.length === 0, mismatches };
};

export const assertEvidenceBinding = (
  expected: UnknownRecord,
  actual: UnknownRecord,
): true => {
  const result = compareEvidenceBinding(expected, actual);
  if (!result.matched) {
    throw new Error(
      `stale candidate evidence: ${result.mismatches
        .map((item) => item.field)
        .join(', ')}`,
    );
  }
  return true;
};
