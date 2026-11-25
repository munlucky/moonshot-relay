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

const rawDigestAbsolute = (absolute: string): string => {
  try {
    const stats = statSync(absolute);
    if (stats.isFile()) {
      return createHash('sha256').update(readFileSync(absolute)).digest('hex');
    }
    return `dir:${stats.size}`;
  } catch {
    return 'absent';
  }
};

export interface SourceDigestMemo {
  checkExists(absolute: string): boolean;
  digestFile(absolute: string): string;
  verifyUnchanged(): boolean;
}

export const createSourceDigestMemo = (): SourceDigestMemo => {
  const existsCache = new Map<string, { value: boolean; hits: number }>();
  const digestCache = new Map<string, { value: string; hits: number }>();
  return {
    checkExists(absolute: string): boolean {
      const cached = existsCache.get(absolute);
      if (cached) {
        cached.hits += 1;
        return cached.value;
      }
      const value = existsSync(absolute);
      existsCache.set(absolute, { value, hits: 1 });
      return value;
    },
    digestFile(absolute: string): string {
      const cached = digestCache.get(absolute);
      if (cached) {
        cached.hits += 1;
        return cached.value;
      }
      const value = rawDigestAbsolute(absolute);
      digestCache.set(absolute, { value, hits: 1 });
      return value;
    },
    verifyUnchanged(): boolean {
      for (const [absolute, entry] of existsCache.entries()) {
        if (entry.hits <= 1) continue;
        if (existsSync(absolute) !== entry.value) return false;
      }
      for (const [absolute, entry] of digestCache.entries()) {
        if (entry.hits <= 1) continue;
        if (rawDigestAbsolute(absolute) !== entry.value) return false;
      }
      return true;
    },
  };
};

const digestPath = (projectRoot: string, ref: string, memo?: SourceDigestMemo | null) => {
  const absolute = path.isAbsolute(ref) ? ref : path.join(projectRoot, ref);
  const raw = memo ? memo.digestFile(absolute) : rawDigestAbsolute(absolute);
  return `${ref}:${raw}`;
};

export interface SourceDigestOptions {
  projectRoot?: string;
  sourceRefs?: string[];
  memo?: SourceDigestMemo | null;
}

export const computeSourceDigest = ({
  projectRoot = process.cwd(),
  sourceRefs = [],
  memo = null,
}: SourceDigestOptions = {}) => {
  const parts = [...sourceRefs].sort().map((ref) => digestPath(projectRoot, ref, memo));
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
  { projectRoot = process.cwd(), memo = null }: Pick<SourceDigestOptions, 'projectRoot' | 'memo'> = {},
) => {
  const refs = record.sourceRefs || [];
  if (refs.length === 0) return { status: 'fresh', reason: 'no-source-refs' };

  const missing = refs.filter((ref) => {
    const absolute = path.isAbsolute(ref) ? ref : path.join(projectRoot, ref);
    return !(memo ? memo.checkExists(absolute) : existsSync(absolute));
  });
  if (missing.length > 0) return { status: 'stale', reason: 'referenced-path-missing', missing };

  const currentDigest = computeSourceDigest({ projectRoot, sourceRefs: refs, memo });
  if (currentDigest === record.sourceDigest) return { status: 'fresh', reason: 'digest-unchanged' };
  return { status: 'needs_deep_verify', reason: 'digest-changed', currentDigest };
};
