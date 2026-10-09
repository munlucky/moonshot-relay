import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

// Knowledge freshness (§21.3). A record carries the source it was derived from
// (sourceRefs + sourceDigest) and a policy for when to re-verify. A changed
// source digest does NOT immediately discard the record: a cheap re-verify
// (do the referenced paths still exist?) decides keep-vs-stale; expensive
// re-verification is deferred until the record is actually used.

const DEFAULT_FRESHNESS_POLICY = 'verify_on_source_change';

const digestPath = (projectRoot, ref) => {
  const absolute = path.isAbsolute(ref) ? ref : path.join(projectRoot, ref);
  try {
    const stats = statSync(absolute);
    if (stats.isFile()) return `${ref}:${createHash('sha256').update(readFileSync(absolute)).digest('hex')}`;
    return `${ref}:dir:${stats.size}`;
  } catch {
    return `${ref}:absent`;
  }
};

export const computeSourceDigest = ({ projectRoot = process.cwd(), sourceRefs = [] } = {}) => {
  const parts = [...sourceRefs].sort().map((ref) => digestPath(projectRoot, ref));
  return `sha256:${createHash('sha256').update(JSON.stringify(parts)).digest('hex')}`;
};

export const attachFreshness = (record, { projectRoot = process.cwd(), sourceRefs = [], confidence = 0.9, freshnessPolicy = DEFAULT_FRESHNESS_POLICY } = {}) => {
  const refs = sourceRefs.length > 0 ? sourceRefs : (record.scope || []);
  return {
    ...record,
    sourceRefs: refs,
    sourceDigest: computeSourceDigest({ projectRoot, sourceRefs: refs }),
    lastVerifiedAt: new Date().toISOString(),
    freshnessPolicy,
    confidence,
  };
};

// Cheap re-verify: only checks that the referenced paths still exist. Returns
// 'fresh' when the digest is unchanged, 'stale' when a referenced path
// vanished, and 'needs_deep_verify' when the digest drifted but paths remain
// (deferred to real use).
export const cheapReVerify = (record, { projectRoot = process.cwd() } = {}) => {
  const refs = record.sourceRefs || [];
  if (refs.length === 0) return { status: 'fresh', reason: 'no-source-refs' };

  const missing = refs.filter((ref) => !existsSync(path.isAbsolute(ref) ? ref : path.join(projectRoot, ref)));
  if (missing.length > 0) {
    return { status: 'stale', reason: 'referenced-path-missing', missing };
  }

  const currentDigest = computeSourceDigest({ projectRoot, sourceRefs: refs });
  if (currentDigest === record.sourceDigest) {
    return { status: 'fresh', reason: 'digest-unchanged' };
  }
  return { status: 'needs_deep_verify', reason: 'digest-changed', currentDigest };
};
