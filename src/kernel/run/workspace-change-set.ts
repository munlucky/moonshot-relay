// Pure Work change-set derivation.
//
// Host owns physical Git/filesystem observation. Work receives the observation
// and decides which changed paths belong to the Run relative to its persisted
// baseline. No filesystem, Git, provider, or process execution occurs here.

export interface WorkspaceChangeEntry {
  path?: unknown;
  digest?: unknown;
  indexStateKnown?: unknown;
  indexDigest?: unknown;
  indexMode?: unknown;
  indexStage?: unknown;
  statusCode?: unknown;
}

export interface WorkspaceChangeObservation {
  method?: unknown;
  changedPaths?: unknown;
  changeEntries?: unknown;
}

export interface BaselineChangeEntry {
  path: string;
  digest: string;
  indexStateKnown: boolean;
  indexDigest: string | null;
  indexMode: string | null;
  indexStage: string | null;
  statusCode: string | null;
}

export interface DeriveRunChangedPathsInput {
  observation?: WorkspaceChangeObservation | null;
  baselineChangedPaths?: unknown;
  baselineEntries?: unknown;
  baselineStatus?: unknown;
  platform?: NodeJS.Platform;
}

export interface UnavailableRunChangeSet {
  status: 'unavailable';
  reason: 'workspace-baseline-unknown' | 'git-change-observation-unavailable' | 'non-git-workspace';
  actualChangedPaths: null;
  fullChangedPaths: string[] | null;
  baselineChangedPaths: string[];
  baselineDriftPaths: string[];
}

export interface ObservedRunChangeSet {
  status: 'observed';
  reason: null;
  actualChangedPaths: string[];
  currentWorkUnitChanges: string[];
  preExistingChanges: string[];
  fullChangedPaths: string[];
  baselineChangedPaths: string[];
  baselineDriftPaths: string[];
}

export type RunChangeSet = UnavailableRunChangeSet | ObservedRunChangeSet;

const normalizePath = (value: unknown, platform: NodeJS.Platform): string => {
  const raw = String(value ?? '');
  const platformPath = platform === 'win32' ? raw.replaceAll('\\', '/') : raw;
  return platformPath.replace(/^\.\//u, '');
};

const stringList = (value: unknown, platform: NodeJS.Platform): string[] => (
  Array.isArray(value)
    ? [...new Set(value.map((entry) => normalizePath(entry, platform)).filter(Boolean))].sort()
    : []
);

const normalizeBaselineEntries = (
  entries: unknown,
  platform: NodeJS.Platform,
): BaselineChangeEntry[] => (
  Array.isArray(entries) ? entries : []
).map((entry): BaselineChangeEntry => {
  if (Array.isArray(entry)) {
    return {
      path: normalizePath(entry[0], platform),
      digest: String(entry[1] || ''),
      indexStateKnown: false,
      indexDigest: null,
      indexMode: null,
      indexStage: null,
      statusCode: null,
    };
  }

  const record = entry && typeof entry === 'object'
    ? entry as WorkspaceChangeEntry
    : {};
  const indexStateKnown = record.indexStateKnown === true
    || Object.prototype.hasOwnProperty.call(record, 'indexDigest')
    || Object.prototype.hasOwnProperty.call(record, 'statusCode');

  return {
    path: normalizePath(record.path, platform),
    digest: String(record.digest || ''),
    indexStateKnown,
    indexDigest: indexStateKnown && record.indexDigest ? String(record.indexDigest) : null,
    indexMode: indexStateKnown && record.indexMode ? String(record.indexMode) : null,
    indexStage: indexStateKnown && record.indexStage ? String(record.indexStage) : null,
    statusCode: indexStateKnown && record.statusCode ? String(record.statusCode) : null,
  };
}).filter((entry) => Boolean(entry.path && entry.digest));

const normalizeLiveEntries = (
  entries: unknown,
  platform: NodeJS.Platform,
): BaselineChangeEntry[] => (
  Array.isArray(entries) ? entries : []
).filter((entry): entry is WorkspaceChangeEntry => Boolean(entry) && typeof entry === 'object')
  .map((entry) => ({
    path: normalizePath(entry.path, platform),
    digest: String(entry.digest || ''),
    indexStateKnown: entry.indexStateKnown === true,
    indexDigest: entry.indexDigest ? String(entry.indexDigest) : null,
    indexMode: entry.indexMode ? String(entry.indexMode) : null,
    indexStage: entry.indexStage ? String(entry.indexStage) : null,
    statusCode: entry.statusCode ? String(entry.statusCode) : null,
  }))
  .filter((entry) => Boolean(entry.path));

export const deriveRunChangedPaths = ({
  observation = null,
  baselineChangedPaths = [],
  baselineEntries = [],
  baselineStatus = 'known',
  platform = process.platform,
}: DeriveRunChangedPathsInput = {}): RunChangeSet => {
  const normalizedBaselinePaths = stringList(baselineChangedPaths, platform);

  if (baselineStatus === 'unknown') {
    return {
      status: 'unavailable',
      reason: 'workspace-baseline-unknown',
      actualChangedPaths: null,
      fullChangedPaths: Array.isArray(observation?.changedPaths)
        ? stringList(observation.changedPaths, platform)
        : null,
      baselineChangedPaths: normalizedBaselinePaths,
      baselineDriftPaths: [],
    };
  }

  if (
    observation?.method !== 'git'
    || !Array.isArray(observation.changedPaths)
    || !Array.isArray(observation.changeEntries)
  ) {
    return {
      status: 'unavailable',
      reason: observation?.method === 'git'
        ? 'git-change-observation-unavailable'
        : 'non-git-workspace',
      actualChangedPaths: null,
      fullChangedPaths: null,
      baselineChangedPaths: normalizedBaselinePaths,
      baselineDriftPaths: [],
    };
  }

  const baselineEntriesNormalized = normalizeBaselineEntries(baselineEntries, platform);
  const baseline = new Map(baselineEntriesNormalized.map((entry) => [entry.path, entry]));
  const baselinePaths = new Set([
    ...normalizedBaselinePaths,
    ...baseline.keys(),
  ]);

  const liveEntries = normalizeLiveEntries(observation.changeEntries, platform);
  const actualChangedPaths = liveEntries
    .filter((entry) => {
      const previous = baseline.get(entry.path);
      if (!previous) return true;
      if (previous.digest !== entry.digest) return true;
      if (
        previous.indexStateKnown
        && (
          !entry.indexStateKnown
          || previous.indexDigest !== entry.indexDigest
          || previous.indexMode !== entry.indexMode
          || previous.indexStage !== entry.indexStage
          || previous.statusCode !== entry.statusCode
        )
      ) return true;
      return false;
    })
    .map((entry) => entry.path);

  const fullChangedPaths = stringList(observation.changedPaths, platform);
  const currentPaths = new Set(fullChangedPaths);
  const baselineDriftPaths = [...baselinePaths]
    .filter((entry) => !currentPaths.has(entry))
    .sort();
  const preExistingChanges = [...baselinePaths]
    .filter((entry) => !actualChangedPaths.includes(entry))
    .sort();

  return {
    status: 'observed',
    reason: null,
    actualChangedPaths: [...new Set([...actualChangedPaths, ...baselineDriftPaths])].sort(),
    currentWorkUnitChanges: [...new Set(actualChangedPaths)].sort(),
    preExistingChanges,
    fullChangedPaths,
    baselineChangedPaths: [...baselinePaths].sort(),
    baselineDriftPaths,
  };
};
