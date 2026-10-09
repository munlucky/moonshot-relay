import { createHash } from 'node:crypto';

export const canonicalStringify = (value) => {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => (item === undefined ? 'null' : canonicalStringify(item))).join(',')}]`;
  }

  const sortedKeys = Object.keys(value).sort();
  const pairs = [];
  for (const key of sortedKeys) {
    const val = value[key];
    if (val !== undefined) {
      pairs.push(`${JSON.stringify(key)}:${canonicalStringify(val)}`);
    }
  }
  return `{${pairs.join(',')}}`;
};

export const digestObject = (value) => createHash('sha256').update(canonicalStringify(value)).digest('hex');

export const makeContextReceipt = ({ stage, policyRevision, policyDigest, included, omitted, tokenEstimate }) => {
  const payload = { schemaVersion: 1, stage, policyRevision, policyDigest, tokenEstimate, included, omitted };
  const digest = digestObject(payload);
  return { ...payload, receiptId: `ctx-${digest.slice(0, 12)}`, digest };
};
