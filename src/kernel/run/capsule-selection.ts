// Bounded context selection for an Execution Capsule (K1 §6.5).
//
// A capsule is not "everything the Kernel knows" — it is the smallest set of
// facts a fresh worker session needs. Selection is deterministic and budgeted.

import path from 'node:path';
import { matchPathScope } from '../../shared/path-scope.js';
import { canonicalJson } from '../../shared/canonical-digest.js';

type UnknownRecord = Record<string, unknown>;
type CapsuleListField =
  | 'semanticFacts'
  | 'knownFailures'
  | 'architectureRecords'
  | 'relevantSymbols'
  | 'relevantFiles';

export interface CapsuleBudget {
  maxRelevantFiles: number;
  maxRelevantSymbols: number;
  maxKnowledgeRecords: number;
  maxArchitectureRecords: number;
  maxKnownFailures: number;
  maxSerializedBytes: number;
}

interface FileTier {
  tier: number;
  group: string;
  reason: string;
}

interface RankedFile {
  path: string;
  reason: string;
  group: string;
}

interface KnowledgeRecordLike extends UnknownRecord {
  id?: unknown;
  recordId?: unknown;
  type?: string;
  recordType?: string;
  statement?: unknown;
  summary?: unknown;
  title?: unknown;
  revision?: unknown;
  scope?: unknown;
}

interface KnowledgeContextLike {
  policyAnchors?: KnowledgeRecordLike[];
  semanticFacts?: KnowledgeRecordLike[];
}

interface CapsuleKnowledgeEntry extends UnknownRecord {
  recordId: string;
  summary: string;
  revision: number | null;
}

interface ReductionStep {
  field: CapsuleListField;
  label: string;
  fileTier?: string;
}

interface ReductionRecord {
  label: string;
  kind: 'cap' | 'budget';
  dropped: number;
  limit: number;
}

interface RepositoryContextLike extends UnknownRecord {
  relevantFiles?: unknown[] | undefined;
  relevantSymbols?: unknown[] | undefined;
  knowledgeRecords?: unknown[] | undefined;
  architectureRecords?: unknown[] | undefined;
  baseline?: UnknownRecord;
}

interface CapsuleLike extends UnknownRecord {
  repositoryContext?: UnknownRecord | null;
}

export const CAPSULE_BUDGET: Readonly<CapsuleBudget> = Object.freeze({
  maxRelevantFiles: 20,
  maxRelevantSymbols: 30,
  maxKnowledgeRecords: 15,
  maxArchitectureRecords: 10,
  maxKnownFailures: 10,
  maxSerializedBytes: 65536,
});

// Paths whose CONTENT is a secret. The capsule never carries file bodies, but
// naming these files still tells a worker where to look, and a digest of one is
// a fingerprint of a credential — so they are excluded outright.
const SENSITIVE_PATTERNS = [
  /(^|\/)\.env(\.|$)/i,
  /(^|\/)\.npmrc$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.|$)/i,
  /(^|\/)secrets?\//i,
  /\.(pem|key|p12|pfx|keystore|jks)$/i,
  /credential|password|token[-_]?store/i,
];

export const isSensitivePath = (candidate: unknown): boolean => {
  const value = String(candidate || '').replaceAll('\\', '/');
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(value));
};

const normalize = (candidate: unknown): string => (
  String(candidate || '')
    .replaceAll('\\', '/')
    .replace(/^\.\//, '')
);

// §6.5 reduction order, lowest value first.
export const CAPSULE_REDUCTION_ORDER: readonly ReductionStep[] = Object.freeze([
  { field: 'semanticFacts', label: 'knowledge-record' },
  { field: 'knownFailures', label: 'known-failure' },
  { field: 'architectureRecords', label: 'architecture-record' },
  { field: 'relevantSymbols', label: 'relevant-symbol' },
  { field: 'relevantFiles', label: 'adjacent-file', fileTier: 'adjacentFiles' },
  { field: 'relevantFiles', label: 'acceptance-file', fileTier: 'acceptanceFiles' },
  { field: 'relevantFiles', label: 'scope-file', fileTier: 'scopeFiles' },
]);

// Selection tiers, highest priority first.
const FILE_TIERS: readonly FileTier[] = Object.freeze([
  { tier: 1, group: 'scopeFiles', reason: 'inside the work unit scope' },
  { tier: 2, group: 'acceptanceFiles', reason: 'named by the acceptance criteria' },
  { tier: 3, group: 'adjacentFiles', reason: 'adjacent to a changed path' },
]);

const directoriesOf = (paths: unknown[] = []): Set<string> => (
  new Set(
    paths
      .map((entry) => path.posix.dirname(normalize(entry)))
      .filter((directory) => directory && directory !== '.'),
  )
);

export const rankRelevantFiles = ({
  candidates = [],
  allowedPaths = [],
  acceptancePaths = [],
  changedPaths = [],
  limit = CAPSULE_BUDGET.maxRelevantFiles,
}: {
  candidates?: unknown[];
  allowedPaths?: string[];
  acceptancePaths?: unknown[];
  changedPaths?: unknown[];
  limit?: number;
} = {}): RankedFile[] => {
  const scoped = allowedPaths.filter((entry) => entry && entry !== '**');
  const acceptanceSet = new Set(acceptancePaths.map(normalize));
  const changedDirs = directoriesOf(changedPaths);
  const ranked: Array<{ tier: number; path: string }> = [];

  for (const candidate of candidates) {
    const relative = normalize(candidate);
    if (!relative || isSensitivePath(relative)) continue;

    let tier: number | null = null;
    if (scoped.length > 0 && matchPathScope(relative, scoped)) tier = 1;
    else if (acceptanceSet.has(relative)) tier = 2;
    else if (changedDirs.has(path.posix.dirname(relative))) tier = 3;
    if (tier === null) continue;

    ranked.push({ tier, path: relative });
  }

  ranked.sort((left, right) => (
    (left.tier - right.tier) || left.path.localeCompare(right.path)
  ));

  return ranked.slice(0, limit).map((entry) => {
    const fileTier = FILE_TIERS.find((item) => item.tier === entry.tier);
    if (!fileTier) {
      throw new Error(`capsule_file_tier_missing: ${entry.tier}`);
    }
    return {
      path: entry.path,
      reason: fileTier.reason,
      group: fileTier.group,
    };
  });
};

const recordSummary = (record: KnowledgeRecordLike): string => {
  const statement = record.statement || record.summary || record.title || '';
  return String(statement).slice(0, 400);
};

export const selectKnowledgeRecords = ({
  knowledgeContext = null,
  allowedPaths = [],
  budget = CAPSULE_BUDGET,
}: {
  knowledgeContext?: KnowledgeContextLike | null;
  allowedPaths?: string[];
  budget?: CapsuleBudget;
} = {}) => {
  const records: KnowledgeRecordLike[] = [
    ...(knowledgeContext?.policyAnchors || []),
    ...(knowledgeContext?.semanticFacts || []),
  ];
  const scoped = allowedPaths.filter((entry) => entry && entry !== '**');

  const inScope = (record: KnowledgeRecordLike): boolean => {
    if (!Array.isArray(record.scope) || record.scope.length === 0) return true;
    if (scoped.length === 0) return true;

    return record.scope.some((entry) => (
      matchPathScope(normalize(entry), scoped)
      || matchPathScope(normalize(scoped[0]), [String(entry)])
    ));
  };

  const architectureTypes = new Set([
    'architecture_decision',
    'component_boundary',
    'api_contract',
  ]);
  const failureTypes = new Set(['known_failure_pattern']);
  const architectureRecords: CapsuleKnowledgeEntry[] = [];
  const knowledgeRecords: CapsuleKnowledgeEntry[] = [];
  const knownFailures: CapsuleKnowledgeEntry[] = [];

  for (const record of records) {
    if (!inScope(record)) continue;

    const type = record.type || record.recordType || 'semantic_fact';
    const entry: CapsuleKnowledgeEntry = {
      recordId: String(record.id || record.recordId || 'unknown'),
      summary: recordSummary(record),
      revision: Number.isInteger(record.revision)
        ? Number(record.revision)
        : null,
    };

    if (architectureTypes.has(type)) architectureRecords.push(entry);
    else if (failureTypes.has(type)) knownFailures.push(entry);
    else knowledgeRecords.push(entry);
  }

  const byId = (
    left: CapsuleKnowledgeEntry,
    right: CapsuleKnowledgeEntry,
  ): number => left.recordId.localeCompare(right.recordId);

  return {
    knowledgeRecords: knowledgeRecords
      .sort(byId)
      .slice(0, budget.maxKnowledgeRecords),
    architectureRecords: architectureRecords
      .sort(byId)
      .slice(0, budget.maxArchitectureRecords),
    knownFailurePatterns: knownFailures
      .sort(byId)
      .slice(0, budget.maxKnownFailures),
  };
};

const repositoryOf = (capsule: CapsuleLike): RepositoryContextLike => {
  const candidate = capsule.repositoryContext;
  return candidate && typeof candidate === 'object' && !Array.isArray(candidate)
    ? candidate as RepositoryContextLike
    : {};
};

const knownFailuresOf = (repository: RepositoryContextLike): unknown[] | undefined => {
  const baseline = repository.baseline;
  if (!baseline || typeof baseline !== 'object' || Array.isArray(baseline)) {
    return undefined;
  }
  const value = baseline.knownFailures;
  return Array.isArray(value) ? value : undefined;
};

const listsOf = (capsule: CapsuleLike): Record<CapsuleListField, unknown[] | undefined> => {
  const repository = repositoryOf(capsule);
  return {
    semanticFacts: repository.knowledgeRecords,
    knownFailures: knownFailuresOf(repository),
    architectureRecords: repository.architectureRecords,
    relevantSymbols: repository.relevantSymbols,
    relevantFiles: repository.relevantFiles,
  };
};

const REASON_FOR_TIER: Record<string, string> = Object.fromEntries(
  FILE_TIERS.map((tier) => [tier.group, tier.reason]),
);

const dropOne = (
  list: unknown[] | undefined,
  fileTier?: string,
): boolean => {
  if (!Array.isArray(list) || list.length === 0) return false;
  if (!fileTier) return Boolean(list.pop());

  const reason = REASON_FOR_TIER[fileTier];
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const entry = list[index];
    if (
      !entry
      || typeof entry !== 'object'
      || Array.isArray(entry)
      || (entry as UnknownRecord).reason !== reason
    ) {
      continue;
    }
    list.splice(index, 1);
    return true;
  }
  return false;
};

const serializedBytes = (capsule: unknown): number => (
  Buffer.byteLength(canonicalJson(capsule), 'utf8')
);

const clonedCapsule = (capsule: CapsuleLike): CapsuleLike => (
  JSON.parse(JSON.stringify(capsule)) as CapsuleLike
);

export const applyCapsuleBudget = (
  capsule: CapsuleLike,
  budget: CapsuleBudget = CAPSULE_BUDGET,
) => {
  const working = clonedCapsule(capsule);
  const reductions: ReductionRecord[] = [];
  const repository = repositoryOf(working);

  const cap = (
    list: unknown[] | undefined,
    max: number,
    label: string,
  ): unknown[] | undefined => {
    if (!Array.isArray(list) || list.length <= max) return list;
    reductions.push({
      label,
      kind: 'cap',
      dropped: list.length - max,
      limit: max,
    });
    return list.slice(0, max);
  };

  repository.relevantFiles = cap(
    repository.relevantFiles,
    budget.maxRelevantFiles,
    'relevant-file',
  );
  repository.relevantSymbols = cap(
    repository.relevantSymbols,
    budget.maxRelevantSymbols,
    'relevant-symbol',
  );
  repository.knowledgeRecords = cap(
    repository.knowledgeRecords,
    budget.maxKnowledgeRecords,
    'knowledge-record',
  );
  repository.architectureRecords = cap(
    repository.architectureRecords,
    budget.maxArchitectureRecords,
    'architecture-record',
  );

  const baseline = repository.baseline;
  if (
    baseline
    && typeof baseline === 'object'
    && !Array.isArray(baseline)
    && Array.isArray(baseline.knownFailures)
  ) {
    baseline.knownFailures = cap(
      baseline.knownFailures,
      budget.maxKnownFailures,
      'known-failure',
    );
  }

  working.repositoryContext = repository;

  for (const step of CAPSULE_REDUCTION_ORDER) {
    while (serializedBytes(working) > budget.maxSerializedBytes) {
      const lists = listsOf(working);
      if (!dropOne(lists[step.field], step.fileTier)) break;

      const existing = reductions.find((entry) => (
        entry.label === step.label && entry.kind === 'budget'
      ));
      if (existing) existing.dropped += 1;
      else {
        reductions.push({
          label: step.label,
          kind: 'budget',
          dropped: 1,
          limit: budget.maxSerializedBytes,
        });
      }
    }
    if (serializedBytes(working) <= budget.maxSerializedBytes) break;
  }

  const bytes = serializedBytes(working);
  return {
    capsule: working,
    reductions,
    serializedBytes: bytes,
    withinBudget: bytes <= budget.maxSerializedBytes,
  };
};

export const findScopeViolations = ({
  changedPaths = [],
  allowedPaths = [],
  forbiddenPaths = [],
}: {
  changedPaths?: unknown[];
  allowedPaths?: string[];
  forbiddenPaths?: string[];
} = {}): Array<{ path: string; reason: string }> => {
  const allowed = allowedPaths.filter(Boolean);
  const forbidden = forbiddenPaths.filter(Boolean);
  const violations: Array<{ path: string; reason: string }> = [];

  for (const changed of changedPaths) {
    const relative = normalize(changed);
    if (!relative) continue;

    if (forbidden.length > 0 && matchPathScope(relative, forbidden)) {
      violations.push({ path: relative, reason: 'forbidden-path' });
      continue;
    }

    // An empty or `**` allowlist declares the whole workspace; only a
    // narrowed scope can be violated.
    if (allowed.length === 0 || allowed.includes('**')) continue;
    if (!matchPathScope(relative, allowed)) {
      violations.push({ path: relative, reason: 'outside-allowed-paths' });
    }
  }

  return violations;
};
