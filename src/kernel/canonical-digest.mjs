// Canonical serialization for Kernel artifacts (K0/K1/K3). Receipts, capsules,
// and admissions are all identified by the digest of their own content, so the
// serialization must be stable no matter which order the fields were assembled
// in or which process read them back out of SQLite.

import { createHash } from 'node:crypto';

export const canonicalJson = (value) => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
};

export const canonicalDigest = (value) => `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;

// A digest of the artifact with its own identity fields removed, so recomputing
// it from a stored artifact reproduces the value that was stored.
export const digestWithout = (value, omitted = []) => {
  const rest = { ...(value || {}) };
  for (const key of omitted) delete rest[key];
  return canonicalDigest(rest);
};
