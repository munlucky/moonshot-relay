import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { readFileSync } from 'node:fs';
import { atomicWriteText } from './durable-write.js';

type Track = 'relay' | 'kernel';
type UnknownRecord = Record<string, unknown>;

interface TrackScope {
  scopeKey: string;
  canonicalRoot: string;
  gitCommonDir: string | null;
  gitWorktreeDir: string | null;
  workspaceRoot: string;
}

interface TrackRecord {
  schemaVersion: 1;
  track: Track;
  scope: {
    scopeKey: string;
    canonicalRoot: string;
    gitCommonDir: string | null;
    gitWorktreeDir: string | null;
  };
  projectId: string | null;
  workspaceId: string | null;
  source: string;
  runtimeHome: string;
  createdAt: string;
  updatedAt: string;
}

interface TrackResolution {
  track: Track | null;
  source: string;
  runtimeHome: string;
  scope: TrackScope;
  registered: boolean;
  registryPath?: string | null;
  markerPath?: string;
  record?: TrackRecord;
}

interface RuntimeEnv extends NodeJS.ProcessEnv {
  MOON_RELAY_KERNEL_HOME?: string;
  MOON_RELAY_TRACK?: string;
}

interface ResolveTrackOptions {
  env?: RuntimeEnv;
  allowAccountRootDefault?: boolean;
}

interface EnsureTrackInput {
  startDir?: string;
  track?: Track;
  env?: RuntimeEnv;
  projectId?: unknown;
  workspaceId?: unknown;
  source?: string;
}

interface CodedError extends Error {
  code?: string;
  errorCode?: string;
  details?: UnknownRecord;
  cause?: unknown;
}

export const RELAY_DEFAULT_HOME = path.join(os.homedir(), '.moonshot-relay');
export const KERNEL_DEFAULT_HOME = path.join(os.homedir(), '.moon-relay-kernel');

const errorCode = (error: unknown): string | null => (
  error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code || '')
    : null
);

// Resolve the physical prefix even when the final target has not been created
// yet. A lexical path check is not an isolation boundary on macOS/Linux: a
// configured home can be reached through a symlinked parent while the target
// itself is still missing.
export const canonicalPath = (value: string): string => {
  const resolved = path.resolve(value);
  let cursor = resolved;
  const suffix: string[] = [];
  while (true) {
    try {
      const physical = fs.realpathSync.native(cursor);
      return path.join(physical, ...suffix.reverse());
    } catch (error: unknown) {
      if (!['ENOENT', 'ENOTDIR'].includes(errorCode(error) || '')) throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) return resolved;
      suffix.push(path.basename(cursor));
      cursor = parent;
    }
  }
};

export const expandHome = (
  value: string | null | undefined,
  home: string = os.homedir(),
): string | null | undefined => {
  if (!value) return value;
  if (value === '~') return canonicalPath(home);
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return canonicalPath(path.join(home, value.slice(2)));
  }
  return canonicalPath(value);
};

export const resolveKernelRuntimeHome = ({
  env = process.env,
  home = os.homedir(),
}: {
  env?: RuntimeEnv;
  home?: string;
} = {}): string => (
  expandHome(env.MOON_RELAY_KERNEL_HOME || '~/.moon-relay-kernel', home)
  || canonicalPath(path.join(home, '.moon-relay-kernel'))
);

export const assertIsolatedRuntimeHomes = (
  kernelHome: string,
  relayHome: string = RELAY_DEFAULT_HOME,
): true => {
  const kernel = canonicalPath(kernelHome);
  const relay = canonicalPath(relayHome);
  if (
    kernel === relay
    || kernel.startsWith(`${relay}${path.sep}`)
    || relay.startsWith(`${kernel}${path.sep}`)
  ) {
    throw new Error('Kernel and Relay runtime homes must be isolated');
  }
  return true;
};

const TRACK_PATTERN = /^track:\s*(relay|kernel)\s*$/m;
const VALID_TRACKS = new Set<Track>(['relay', 'kernel']);
export const TRACK_REGISTRY_SCHEMA_VERSION = 1;

// Kernel admission is account-root owned. The switcher may still establish an
// ambient process track, but a successful Kernel command records the exact
// project/worktree scope below the Kernel runtime home instead of writing a
// marker into the repository. Existing repository markers remain a legacy
// compatibility boundary and win over ambient selection when present.
const trackFromEnv = (env: RuntimeEnv): Track | null => {
  const value = String(env.MOON_RELAY_TRACK || '').trim();
  return VALID_TRACKS.has(value as Track) ? value as Track : null;
};

const normalizeScopePath = (value: unknown): string => {
  const normalized = String(value || '').replaceAll('\\', '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
};

const gitValue = (cwd: string, argument: string): string | null => {
  try {
    const result = spawnSync('git', ['rev-parse', argument], {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 3000,
    });
    return result.status === 0 && result.stdout?.trim()
      ? result.stdout.trim()
      : null;
  } catch {
    return null;
  }
};

const findWorkspaceRoot = (startDir: string): string => {
  let current = path.resolve(startDir);
  while (true) {
    if (fs.existsSync(path.join(current, '.git'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(startDir);
    current = parent;
  }
};

const resolveGitPath = (
  workspaceRoot: string,
  value: string | null,
): string | null => {
  if (!value) return null;
  try {
    return normalizeScopePath(
      canonicalPath(path.resolve(workspaceRoot, value)),
    );
  } catch {
    return normalizeScopePath(path.resolve(workspaceRoot, value));
  }
};

// This is deliberately independent from the project-id resolver. Track
// admission happens before Kernel state is opened, so the scope key must be
// available without reading or writing the repository and without relying on a
// previously persisted project identity.
export const resolveProjectTrackScope = (
  startDir: string = process.cwd(),
): TrackScope => {
  const workspaceRoot = findWorkspaceRoot(startDir);
  const canonicalRoot = normalizeScopePath(canonicalPath(workspaceRoot));
  const gitCommonDir = resolveGitPath(
    workspaceRoot,
    gitValue(workspaceRoot, '--git-common-dir'),
  );
  const gitWorktreeDir = resolveGitPath(
    workspaceRoot,
    gitValue(workspaceRoot, '--git-dir'),
  );
  const identity = { canonicalRoot, gitCommonDir, gitWorktreeDir };
  const scopeKey = `track-scope-${createHash('sha256')
    .update(JSON.stringify(identity))
    .digest('hex')}`;
  return {
    scopeKey,
    canonicalRoot,
    gitCommonDir,
    gitWorktreeDir,
    workspaceRoot,
  };
};

export const trackRegistryRoot = (
  runtimeHome: string = resolveKernelRuntimeHome(),
): string => path.join(canonicalPath(runtimeHome), 'state', 'track-scopes');

export const trackRegistryPath = ({
  runtimeHome = resolveKernelRuntimeHome(),
  scope = resolveProjectTrackScope(),
}: {
  runtimeHome?: string;
  scope?: TrackScope;
} = {}): string => (
  path.join(trackRegistryRoot(runtimeHome), `${scope.scopeKey}.json`)
);

const markerChain = (
  startDir: string,
  { excludedRoot = null }: { excludedRoot?: string | null } = {},
): string[] => {
  const chain: string[] = [];
  let curr = path.resolve(startDir);
  while (true) {
    if (
      !excludedRoot
      || normalizeScopePath(curr) !== normalizeScopePath(excludedRoot)
    ) {
      chain.push(path.join(curr, '.moon-relay', 'track.yaml'));
    }
    const parent = path.dirname(curr);
    if (parent === curr) break;
    curr = parent;
  }
  return chain;
};

const parseTrackMarker = (content: string): Track | null => (
  (content.match(TRACK_PATTERN)?.[1] as Track | undefined) || null
);

const readMarkerTrackSync = (
  markers: string[],
): { track: Track; source: 'project_marker'; markerPath: string } | null => {
  for (const marker of markers) {
    try {
      const track = parseTrackMarker(readFileSync(marker, 'utf8'));
      if (track) {
        return {
          track,
          source: 'project_marker',
          markerPath: marker,
        };
      }
    } catch (error: unknown) {
      if (errorCode(error) !== 'ENOENT') throw error;
    }
  }
  return null;
};

const readAccountTrackSync = ({
  runtimeHome,
  scope,
}: {
  runtimeHome: string;
  scope: TrackScope;
}): {
  track: Track;
  source: 'account_root_scope';
  registryPath: string;
  record: TrackRecord;
} | null => {
  const registryPath = trackRegistryPath({ runtimeHome, scope });
  try {
    const parsed = JSON.parse(readFileSync(registryPath, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw Object.assign(
        new Error(`track_registry_scope_mismatch: ${registryPath}`),
        { code: 'track_registry_scope_mismatch' },
      );
    }
    const record = parsed as Partial<TrackRecord>;
    const recordScope = record.scope || {
      scopeKey: '',
      canonicalRoot: '',
      gitCommonDir: null,
      gitWorktreeDir: null,
    };
    const valid = record.schemaVersion === TRACK_REGISTRY_SCHEMA_VERSION
      && VALID_TRACKS.has(record.track as Track)
      && recordScope.scopeKey === scope.scopeKey
      && normalizeScopePath(recordScope.canonicalRoot) === scope.canonicalRoot
      && (recordScope.gitCommonDir || null) === scope.gitCommonDir
      && (recordScope.gitWorktreeDir || null) === scope.gitWorktreeDir;
    if (!valid || !record.track) {
      throw Object.assign(
        new Error(`track_registry_scope_mismatch: ${registryPath}`),
        { code: 'track_registry_scope_mismatch' },
      );
    }
    return {
      track: record.track as Track,
      source: 'account_root_scope',
      registryPath,
      record: record as TrackRecord,
    };
  } catch (error: unknown) {
    const code = errorCode(error);
    if (code === 'ENOENT') return null;
    if (code === 'track_registry_scope_mismatch') throw error;
    throw Object.assign(
      new Error(`track_registry_corrupt: ${registryPath}`),
      { code: 'track_registry_corrupt', cause: error },
    );
  }
};

const runtimeTrackSync = (
  runtimeHome: string,
): {
  track: Track;
  source: 'account_root_runtime';
  markerPath: string;
} | null => {
  const markerPath = path.join(
    canonicalPath(runtimeHome),
    '.moon-relay',
    'track.yaml',
  );
  try {
    const track = parseTrackMarker(readFileSync(markerPath, 'utf8'));
    return track
      ? { track, source: 'account_root_runtime', markerPath }
      : null;
  } catch (error: unknown) {
    if (errorCode(error) === 'ENOENT') return null;
    throw error;
  }
};

export const resolveProjectTrackSync = (
  startDir: string = process.cwd(),
  {
    env = process.env,
    allowAccountRootDefault = false,
  }: ResolveTrackOptions = {},
): TrackResolution => {
  const runtimeHome = resolveKernelRuntimeHome({ env });
  const scope = resolveProjectTrackScope(startDir);
  const marker = readMarkerTrackSync(
    markerChain(startDir, { excludedRoot: runtimeHome }),
  );
  if (marker) {
    return {
      ...marker,
      runtimeHome,
      scope,
      registered: false,
    };
  }

  const ambient = trackFromEnv(env);
  if (ambient === 'relay') {
    return {
      track: ambient,
      source: 'environment',
      runtimeHome,
      scope,
      registered: false,
    };
  }

  const account = readAccountTrackSync({ runtimeHome, scope });
  if (account) {
    return {
      ...account,
      runtimeHome,
      scope,
      registered: true,
    };
  }

  if (ambient) {
    return {
      track: ambient,
      source: 'environment',
      runtimeHome,
      scope,
      registered: false,
    };
  }

  const runtime = runtimeTrackSync(runtimeHome);
  if (allowAccountRootDefault && runtime) {
    return {
      ...runtime,
      runtimeHome,
      scope,
      registered: false,
    };
  }
  return {
    track: null,
    source: 'unbound',
    runtimeHome,
    scope,
    registered: false,
  };
};

export const resolveProjectTrack = async (
  startDir: string = process.cwd(),
  options: ResolveTrackOptions = {},
): Promise<TrackResolution> => resolveProjectTrackSync(startDir, options);

export const readProjectTrack = async (
  startDir: string = process.cwd(),
  options: ResolveTrackOptions = {},
): Promise<Track | null> => (
  resolveProjectTrack(startDir, options).then((resolution) => resolution.track)
);

export const readProjectTrackSync = (
  startDir: string = process.cwd(),
  options: ResolveTrackOptions = {},
): Track | null => resolveProjectTrackSync(startDir, options).track;

const trackConflict = (
  resolution: TrackResolution,
  track: Track,
): CodedError => Object.assign(
  new Error(
    `wrong_harness: account-root track is ${resolution.track || 'unbound'} `
    + `for ${resolution.scope.canonicalRoot}; requested ${track}`,
  ),
  {
    code: 'wrong_harness',
    errorCode: 'wrong_harness',
    details: {
      activeTrack: resolution.track || null,
      source: resolution.source,
      canonicalRoot: resolution.scope.canonicalRoot,
      scopeKey: resolution.scope.scopeKey,
      registryPath: resolution.registryPath || null,
    },
  },
);

export const ensureAccountRootTrack = async ({
  startDir = process.cwd(),
  track = 'kernel',
  env = process.env,
  projectId = null,
  workspaceId = null,
  source = 'kernel-command',
}: EnsureTrackInput = {}) => {
  if (!VALID_TRACKS.has(track)) {
    throw new Error(`wrong_harness: unsupported track ${track}`);
  }
  const resolution = resolveProjectTrackSync(
    startDir,
    { env, allowAccountRootDefault: true },
  );
  if (resolution.track !== track) throw trackConflict(resolution, track);
  if (resolution.source === 'account_root_scope') {
    return { ...resolution, status: 'existing' as const };
  }

  const registryPath = trackRegistryPath({
    runtimeHome: resolution.runtimeHome,
    scope: resolution.scope,
  });
  const timestamp = new Date().toISOString();
  const record: TrackRecord = {
    schemaVersion: TRACK_REGISTRY_SCHEMA_VERSION,
    track,
    scope: {
      scopeKey: resolution.scope.scopeKey,
      canonicalRoot: resolution.scope.canonicalRoot,
      gitCommonDir: resolution.scope.gitCommonDir,
      gitWorktreeDir: resolution.scope.gitWorktreeDir,
    },
    projectId: projectId ? String(projectId) : null,
    workspaceId: workspaceId ? String(workspaceId) : null,
    source,
    runtimeHome: resolution.runtimeHome,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  await atomicWriteText(registryPath, `${JSON.stringify(record, null, 2)}\n`);
  return {
    ...resolution,
    track,
    source: 'account_root_scope' as const,
    registryPath,
    record,
    registered: true,
    status: 'registered' as const,
  };
};
