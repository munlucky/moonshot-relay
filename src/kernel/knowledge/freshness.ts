import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const DEFAULT_FRESHNESS_POLICY = 'verify_on_source_change';

export interface KnowledgeFreshnessRecord {
  scope?: string[];
  sourceRefs?: string[];
  sourceDigest?: string | null;
  [key: string]: unknown;
}

const digestPath = (projectRoot: string, ref: string) => {
  const absolute = path.isAbsolute(ref) ? ref : path.join(projectRoot, ref);
  try {
    const stats = statSync(absolute);
    if (stats.isFile()) {
      return `${ref}:${createHash('sha256').update(readFileSync(absolute)).digest('hex')}`;
    }
    return `${ref}:dir:${stats.size}`;
  } catch {
    return `${ref}:absent`;
  }
};

export interface SourceDigestOptions {
  projectRoot?: string;
  sourceRefs?: string[];
}

export const computeSourceDigest = ({
  projectRoot = process.cwd(),
  sourceRefs = [],
}: SourceDigestOptions = {}) => {
  const parts = [...sourceRefs].sort().map((ref) => digestPath(projectRoot, ref));
  return `sha256:${createHash('sha256').update(JSON.stringify(parts)).digest('hex')}`;
};

export const attachFreshness = <T extends KnowledgeFreshnessRecord>(
  record: T,
  {
    projectRoot = process.cwd(),
    sourceRefs = [],
    confidence = 0.9,
    freshnessPolicy = DEFAULT_FRESHNESS_POLICY,
  }: SourceDigestOptions & { confidence?: number; freshnessPolicy?: string } = {},
) => {
  const refs = [...sourceRefs];
  return {
    ...record,
    sourceRefs: refs,
    sourceDigest: computeSourceDigest({ projectRoot, sourceRefs: refs }),
    lastVerifiedAt: new Date().toISOString(),
    freshnessPolicy,
    confidence,
  };
};

export const cheapReVerify = (
  record: KnowledgeFreshnessRecord,
  { projectRoot = process.cwd() }: Pick<SourceDigestOptions, 'projectRoot'> = {},
) => {
  const refs = record.sourceRefs || [];
  if (refs.length === 0) return { status: 'fresh', reason: 'no-source-refs' };

  const missing = refs.filter((ref) => !existsSync(path.isAbsolute(ref) ? ref : path.join(projectRoot, ref)));
  if (missing.length > 0) return { status: 'stale', reason: 'referenced-path-missing', missing };

  const currentDigest = computeSourceDigest({ projectRoot, sourceRefs: refs });
  if (currentDigest === record.sourceDigest) return { status: 'fresh', reason: 'digest-unchanged' };
  return { status: 'needs_deep_verify', reason: 'digest-changed', currentDigest };
};
