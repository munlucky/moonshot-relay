import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { readFileSync } from 'node:fs';
import { atomicWriteText } from './durable-write.mjs';

export const RELAY_DEFAULT_HOME = path.join(os.homedir(), '.moonshot-relay');
export const KERNEL_DEFAULT_HOME = path.join(os.homedir(), '.moon-relay-kernel');

// Resolve the physical prefix even when the final target has not been created
// yet.  A lexical path check is not an isolation boundary on macOS/Linux: a
// configured home can be reached through a symlinked parent while the target
// itself is still missing.
export const canonicalPath = (value) => {
  const resolved = path.resolve(value);
  let cursor = resolved;
  const suffix = [];
  while (true) {
    try {
      const physical = fs.realpathSync.native(cursor);
      return path.join(physical, ...suffix.reverse());
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error?.code)) throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) return resolved;
      suffix.push(path.basename(cursor));
      cursor = parent;
    }
  }
};

export const expandHome = (value, home = os.homedir()) => {
  if (!value) return value;
  if (value === '~') return canonicalPath(home);
  if (value.startsWith('~/') || value.startsWith('~\\')) return canonicalPath(path.join(home, value.slice(2)));
  return canonicalPath(value);
};

export const resolveKernelRuntimeHome = ({ env = process.env, home = os.homedir() } = {}) =>
  expandHome(env.MOON_RELAY_KERNEL_HOME || '~/.moon-relay-kernel', home);

export const assertIsolatedRuntimeHomes = (kernelHome, relayHome = RELAY_DEFAULT_HOME) => {
  const kernel = canonicalPath(kernelHome);
  const relay = canonicalPath(relayHome);
  if (kernel === relay || kernel.startsWith(`${relay}${path.sep}`) || relay.startsWith(`${kernel}${path.sep}`)) {
    throw new Error('Kernel and Relay runtime homes must be isolated');
  }
  return true;
};

const TRACK_PATTERN = /^track:\s*(relay|kernel)\s*$/m;
const VALID_TRACKS = new Set(['relay', 'kernel']);
export const TRACK_REGISTRY_SCHEMA_VERSION = 1;

// Kernel admission is account-root owned. The switcher may still establish an
// ambient process track, but a successful Kernel command records the exact
// project/worktree scope below the Kernel runtime home instead of writing a
// marker into the repository. Existing repository markers remain a legacy
// compatibility boundary and win over ambient selection when present.
const trackFromEnv = (env) => {
  const value = String(env?.MOON_RELAY_TRACK || '').trim();
  return VALID_TRACKS.has(value) ? value : null;
};

const normalizeScopePath = (value) => {
  const normalized = String(value || '').replaceAll('\\', '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
};

const gitValue = (cwd, argument) => {
  try {
    const result = spawnSync('git', ['rev-parse', argument], {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 3000,
    });
    return result.status === 0 && result.stdout?.trim() ? result.stdout.trim() : null;
  } catch {
    return null;
  }
};

const findWorkspaceRoot = (startDir) => {
  let current = path.resolve(startDir);
  while (true) {
    if (fs.existsSync(path.join(current, '.git'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(startDir);
    current = parent;
  }
};

const resolveGitPath = (workspaceRoot, value) => {
  if (!value) return null;
  try {
    return normalizeScopePath(canonicalPath(path.resolve(workspaceRoot, value)));
  } catch {
    return normalizeScopePath(path.resolve(workspaceRoot, value));
  }
};

// This is deliberately independent from the project-id resolver. Track
// admission happens before Kernel state is opened, so the scope key must be
// available without reading or writing the repository and without relying on a
// previously persisted project identity. A Git worktree gets a distinct key
// from its common directory plus its worktree git directory; non-Git roots are
// still isolated by their canonical path.
export const resolveProjectTrackScope = (startDir = process.cwd()) => {
  const workspaceRoot = findWorkspaceRoot(startDir);
  const canonicalRoot = normalizeScopePath(canonicalPath(workspaceRoot));
  const gitCommonDir = resolveGitPath(workspaceRoot, gitValue(workspaceRoot, '--git-common-dir'));
  const gitWorktreeDir = resolveGitPath(workspaceRoot, gitValue(workspaceRoot, '--git-dir'));
  const identity = { canonicalRoot, gitCommonDir, gitWorktreeDir };
  const scopeKey = `track-scope-${createHash('sha256').update(JSON.stringify(identity)).digest('hex')}`;
  return { scopeKey, canonicalRoot, gitCommonDir, gitWorktreeDir, workspaceRoot };
};

export const trackRegistryRoot = (runtimeHome = resolveKernelRuntimeHome()) =>
  path.join(canonicalPath(runtimeHome), 'state', 'track-scopes');

export const trackRegistryPath = ({ runtimeHome = resolveKernelRuntimeHome(), scope = resolveProjectTrackScope() } = {}) =>
  path.join(trackRegistryRoot(runtimeHome), `${scope.scopeKey}.json`);

const markerChain = (startDir, { excludedRoot = null } = {}) => {
  const chain = [];
  let curr = path.resolve(startDir);
  while (true) {
    if (!excludedRoot || normalizeScopePath(curr) !== normalizeScopePath(excludedRoot)) {
      chain.push(path.join(curr, '.moon-relay', 'track.yaml'));
    }
    const parent = path.dirname(curr);
    if (parent === curr) break;
    curr = parent;
  }
  return chain;
};

const parseTrackMarker = (content) => content.match(TRACK_PATTERN)?.[1] || null;

const readMarkerTrackSync = (markers) => {
  for (const marker of markers) {
    try {
      const track = parseTrackMarker(readFileSync(marker, 'utf8'));
      if (track) return { track, source: 'project_marker', markerPath: marker };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return null;
};

const readAccountTrackSync = ({ runtimeHome, scope }) => {
  const registryPath = trackRegistryPath({ runtimeHome, scope });
  try {
    const record = JSON.parse(readFileSync(registryPath, 'utf8'));
    const valid = record?.schemaVersion === TRACK_REGISTRY_SCHEMA_VERSION
      && VALID_TRACKS.has(record.track)
      && record.scope?.scopeKey === scope.scopeKey
      && normalizeScopePath(record.scope?.canonicalRoot) === scope.canonicalRoot
      && (record.scope?.gitCommonDir || null) === scope.gitCommonDir
      && (record.scope?.gitWorktreeDir || null) === scope.gitWorktreeDir;
    if (!valid) {
      throw Object.assign(new Error(`track_registry_scope_mismatch: ${registryPath}`), { code: 'track_registry_scope_mismatch' });
    }
    return { track: record.track, source: 'account_root_scope', registryPath, record };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error.code === 'track_registry_scope_mismatch') throw error;
    throw Object.assign(new Error(`track_registry_corrupt: ${registryPath}`), { code: 'track_registry_corrupt', cause: error });
  }
};

const runtimeTrackSync = (runtimeHome) => {
  const markerPath = path.join(canonicalPath(runtimeHome), '.moon-relay', 'track.yaml');
  try {
    const track = parseTrackMarker(readFileSync(markerPath, 'utf8'));
    return track ? { track, source: 'account_root_runtime', markerPath } : null;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
};

export const resolveProjectTrackSync = (startDir = process.cwd(), { env = process.env, allowAccountRootDefault = false } = {}) => {
  const runtimeHome = resolveKernelRuntimeHome({ env });
  const scope = resolveProjectTrackScope(startDir);
  const marker = readMarkerTrackSync(markerChain(startDir, { excludedRoot: runtimeHome }));
  if (marker) return { ...marker, runtimeHome, scope, registered: false };

  // A Relay process has its own account/runtime home. Do not let a Kernel
  // scope record bleed into an explicitly launched Relay session; the durable
  // repository marker above still remains the stronger cross-track boundary.
  const ambient = trackFromEnv(env);
  if (ambient === 'relay') return { track: ambient, source: 'environment', runtimeHome, scope, registered: false };

  const account = readAccountTrackSync({ runtimeHome, scope });
  if (account) return { ...account, runtimeHome, scope, registered: true };

  if (ambient) return { track: ambient, source: 'environment', runtimeHome, scope, registered: false };

  const runtime = runtimeTrackSync(runtimeHome);
  if (allowAccountRootDefault && runtime) return { ...runtime, runtimeHome, scope, registered: false };
  return { track: null, source: 'unbound', runtimeHome, scope, registered: false };
};

export const resolveProjectTrack = async (startDir = process.cwd(), options = {}) =>
  resolveProjectTrackSync(startDir, options);

export const readProjectTrack = async (startDir = process.cwd(), options = {}) =>
  resolveProjectTrack(startDir, options).then((resolution) => resolution.track);

export const readProjectTrackSync = (startDir = process.cwd(), options = {}) =>
  resolveProjectTrackSync(startDir, options).track;

const trackConflict = (resolution, track) => Object.assign(
  new Error(`wrong_harness: account-root track is ${resolution.track || 'unbound'} for ${resolution.scope.canonicalRoot}; requested ${track}`),
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
} = {}) => {
  if (!VALID_TRACKS.has(track)) throw new Error(`wrong_harness: unsupported track ${track}`);
  const resolution = resolveProjectTrackSync(startDir, { env, allowAccountRootDefault: true });
  if (resolution.track !== track) throw trackConflict(resolution, track);
  if (resolution.source === 'account_root_scope') return { ...resolution, status: 'existing' };

  const registryPath = trackRegistryPath({ runtimeHome: resolution.runtimeHome, scope: resolution.scope });
  const timestamp = new Date().toISOString();
  const record = {
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
    source: 'account_root_scope',
    registryPath,
    record,
    registered: true,
    status: 'registered',
  };
};
