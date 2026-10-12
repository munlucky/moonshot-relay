// Generated from src/shared/candidate-identity.ts. Edit the source and run npm run build.
import crypto from 'node:crypto';
const SHA256_RE = /^[a-f0-9]{64}$/;
const CANDIDATE_ID_RE = /^cand_[a-f0-9]{32}$/;
const isObject = (value) => (value !== null
    && typeof value === 'object'
    && !Array.isArray(value));
export const canonicalStringify = (value) => {
    if (value === undefined)
        return 'null';
    if (value === null || typeof value !== 'object') {
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        return `[${value.map((item) => canonicalStringify(item)).join(',')}]`;
    }
    return `{${Object.entries(value)
        .filter(([, nested]) => nested !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => (`${JSON.stringify(key)}:${canonicalStringify(nested)}`))
        .join(',')}}`;
};
export const sha256Hex = (value) => crypto
    .createHash('sha256')
    .update(typeof value === 'string' ? value : canonicalStringify(value))
    .digest('hex');
export const normalizeDigest = (value) => {
    if (typeof value === 'string' && SHA256_RE.test(value))
        return value;
    if (isObject(value)
        && typeof value.digest === 'string'
        && SHA256_RE.test(value.digest)) {
        return value.digest;
    }
    if (isObject(value)
        && typeof value.sha256 === 'string'
        && SHA256_RE.test(value.sha256)) {
        return value.sha256;
    }
    if (isObject(value)
        && typeof value.tree === 'string'
        && SHA256_RE.test(value.tree)) {
        return value.tree;
    }
    return sha256Hex(value ?? '');
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
const recordAt = (value, key) => {
    if (!isObject(value))
        return {};
    const nested = value[key];
    return isObject(nested) ? nested : {};
};
export const normalizeCandidateId = (receipt = {}) => {
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
const dimensionFrom = (receipt, owner, field) => {
    const nested = recordAt(receipt, owner);
    const dimensions = recordAt(nested, 'dimensions');
    return dimensions[field];
};
const digestFrom = (receipt, owner) => {
    const nested = recordAt(receipt, owner);
    return nested.digest;
};
export const evidenceBinding = (receipt = {}) => ({
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
export const compareEvidenceBinding = (expected, actual) => {
    const left = evidenceBinding(expected);
    const right = evidenceBinding(actual);
    const mismatches = [];
    const fields = [
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
export const assertEvidenceBinding = (expected, actual) => {
    const result = compareEvidenceBinding(expected, actual);
    if (!result.matched) {
        throw new Error(`stale candidate evidence: ${result.mismatches
            .map((item) => item.field)
            .join(', ')}`);
    }
    return true;
};
