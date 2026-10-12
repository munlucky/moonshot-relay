import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { matchPathScope } from '../../../shared/path-scope.js';

const WALK_EXCLUDES = new Set(['.git', 'node_modules', 'dist', '.moonshot-relay', '.moon-relay', '.tmp', '.history']);
const WALK_ENTRY_CAP = 20000;

interface GitStatusEntry {
  path: string;
  statusCode: string;
}

interface GitIndexEntry {
  path: string;
  indexMode: string | null;
  indexDigest: string;
  indexStage: string;
}

import type { WorkspaceChangeEntry, WorkspaceObservation, ScopedWorkspaceObservation } from '../../../contracts/workspace-observation.js';
export type { WorkspaceChangeEntry, WorkspaceObservation, ScopedWorkspaceObservation } from '../../../contracts/workspace-observation.js';

type ScopeNormalization =
  | { scopes: string[]; reason: null }
  | { scopes: null; reason: string };

const sha256 = (value: string | Buffer): string =>
  `sha256:${createHash('sha256').update(value).digest('hex')}`;

const runGit = (args: readonly string[], cwd: string): string | null => {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) return null;
  return result.stdout;
};

const hashFileContent = (absolutePath: string): string => {
  try {
    return createHash('sha256').update(readFileSync(absolutePath)).digest('hex');
  } catch {
    return 'unreadable';
  }
};

// Git's NUL-delimited path output is already an exact path value. Do not trim
// it: leading/trailing whitespace is legal in a POSIX filename and must not be
// collapsed into another scope entry. A backslash is a separator only on
// Windows; on POSIX it may be a literal filename character.
const normalizeGitPath = (value: unknown): string => {
  const raw = String(value ?? '');
  const platformPath = process.platform === 'win32'
    ? raw.replaceAll('\\', '/')
    : raw;
  return platformPath.replace(/^\.\//u, '');
};

const nulSeparated = (value: unknown): string[] =>
  String(value || '').split('\0').filter(Boolean);

const parseGitPathList = (value: unknown): string[] => [...new Set(
  nulSeparated(value).map(normalizeGitPath).filter(Boolean),
)];

// Porcelain -z emits the destination and source as separate NUL-delimited
// paths for renames/copies. Keep both: a scope authority must account for the
// path that disappeared as well as the path that appeared. Retain the XY code
// too: a content digest alone cannot distinguish an index-only change.
const parseGitStatusEntries = (value: unknown): GitStatusEntry[] => {
  const tokens = nulSeparated(value);
  const entries: GitStatusEntry[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const record = tokens[index];
    if (!record || record.length < 4) continue;
    const statusCode = record.slice(0, 2);
    const currentPath = normalizeGitPath(record.slice(3));
    if (currentPath) entries.push({ path: currentPath, statusCode });
    if (/[RC]/u.test(statusCode) && tokens[index + 1]) {
      const previousPath = normalizeGitPath(tokens[index + 1]);
      if (previousPath) entries.push({ path: previousPath, statusCode });
      index += 1;
    }
  }
  return [...new Map(entries.map((entry) => [entry.path, entry])).values()];
};

const parseGitStatusPaths = (value: unknown): string[] =>
  parseGitStatusEntries(value).map((entry) => entry.path);

const normalizeVerificationScopes = (scopes: unknown): ScopeNormalization => {
  if (!Array.isArray(scopes) || scopes.length === 0) {
    return { scopes: null, reason: 'scope-not-declared' };
  }
  const normalized: string[] = [];
  for (const raw of scopes) {
    if (typeof raw !== 'string') {
      return { scopes: null, reason: 'scope-entry-invalid' };
    }
    const scope = normalizeGitPath(raw).replace(/\/{2,}/gu, '/');
    if (!scope || scope === '*' || scope === '**') {
      return { scopes: null, reason: 'scope-too-broad' };
    }
    if (/^(?:[A-Za-z]:|\/|\\\\)/u.test(scope) || scope.split('/').includes('..')) {
      return { scopes: null, reason: 'scope-path-invalid' };
    }
    normalized.push(scope);
  }
  const unique = [...new Set(normalized)].sort();
  return unique.length > 0
    ? { scopes: unique, reason: null }
    : { scopes: null, reason: 'scope-not-declared' };
};

// `git ls-files --stage -z` gives the exact index object/mode/stage for every
// tracked path. Restricting the map to changed paths keeps the identity small,
// while still detecting staging, unstaging, and partial-stage changes on a
// pre-existing dirty file.
const parseGitIndexEntries = (value: unknown): GitIndexEntry[] =>
  nulSeparated(value)
    .map((record): GitIndexEntry | null => {
      const separator = record.indexOf('\t');
      if (separator < 0) return null;
      const [mode, objectId, stage] = record.slice(0, separator).split(/\s+/u);
      const relativePath = normalizeGitPath(record.slice(separator + 1));
      if (!relativePath || !objectId) return null;
      return {
        path: relativePath,
        indexMode: mode || null,
        indexDigest: objectId,
        indexStage: stage || '0',
      };
    })
    .filter((entry): entry is GitIndexEntry => entry !== null);

const safeProjectRelativePath = (
  projectRoot: string,
  relPath: unknown,
): { normalized: string; absolute: string } | null => {
  const raw = String(relPath ?? '');
  const normalized = (
    process.platform === 'win32' ? raw.replaceAll('\\', '/') : raw
  ).replace(/^\.\//u, '');
  if (!normalized || normalized.split('/').includes('..')) return null;
  const absolute = path.resolve(projectRoot, ...normalized.split('/'));
  const relative = path.relative(path.resolve(projectRoot), absolute);
  if (
    relative === '..'
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
  ) {
    return null;
  }
  return { normalized, absolute };
};

const observeScopedGitWorkspace = (
  projectRoot: string,
  scopes: string[],
): Omit<ScopedWorkspaceObservation, 'status' | 'projectRoot' | 'scopes' | 'observedAt'> => {
  const inRepo = runGit(['rev-parse', '--is-inside-work-tree'], projectRoot);
  if (!inRepo || inRepo.trim() !== 'true') {
    return {
      identity: null,
      method: 'unavailable',
      reason: 'git-worktree-unavailable',
    };
  }
  const tracked = runGit(['ls-files', '-z'], projectRoot);
  const untracked = runGit(
    ['ls-files', '--others', '--exclude-standard', '-z'],
    projectRoot,
  );
  if (tracked === null || untracked === null) {
    return {
      identity: null,
      method: 'unavailable',
      reason: 'file-enumeration-failed',
    };
  }

  const candidates = [...new Set([
    ...nulSeparated(tracked),
    ...nulSeparated(untracked),
  ])];
  const entries: Array<[string, string]> = [];
  for (const candidate of candidates) {
    const safe = safeProjectRelativePath(projectRoot, candidate);
    if (!safe || !matchPathScope(safe.normalized, scopes)) continue;
    let digest: string;
    try {
      const stats = statSync(safe.absolute);
      if (!stats.isFile()) {
        return {
          identity: null,
          method: 'unavailable',
          reason: 'non-file-observation-failed',
        };
      }
      digest = createHash('sha256')
        .update(readFileSync(safe.absolute))
        .digest('hex');
    } catch {
      const exists = (() => {
        try {
          statSync(safe.absolute);
          return true;
        } catch {
          return false;
        }
      })();
      if (exists) {
        return {
          identity: null,
          method: 'unavailable',
          reason: 'file-content-observation-failed',
        };
      }
      digest = 'deleted';
    }
    entries.push([safe.normalized, digest]);
  }
  entries.sort(([left], [right]) => left.localeCompare(right));
  return {
    identity: sha256(JSON.stringify({ scopes, entries })),
    method: 'git-scoped',
    reason: null,
    dirtyPathCount: entries.length,
    entries,
  };
};

const observeGitWorkspace = (
  projectRoot: string,
): Omit<WorkspaceObservation, 'projectRoot' | 'observedAt'> | null => {
  const inRepo = runGit(['rev-parse', '--is-inside-work-tree'], projectRoot);
  if (!inRepo || inRepo.trim() !== 'true') return null;

  const headTree = (
    runGit(['rev-parse', 'HEAD^{tree}'], projectRoot) || 'no-head'
  ).trim();
  const headCommit = (
    runGit(['rev-parse', 'HEAD'], projectRoot) || 'no-head'
  ).trim();
  const status = runGit(
    ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
    projectRoot,
  );
  const unstaged = runGit(
    ['diff', '--name-only', '-z', '--no-renames'],
    projectRoot,
  );
  const staged = runGit(
    ['diff', '--cached', '--name-only', '-z', '--no-renames'],
    projectRoot,
  );
  const untracked = runGit(
    ['ls-files', '--others', '--exclude-standard', '-z'],
    projectRoot,
  );
  const index = runGit(['ls-files', '--stage', '-z'], projectRoot);
  if (
    status === null
    || unstaged === null
    || staged === null
    || untracked === null
    || index === null
  ) {
    return null;
  }

  const statusByPath = new Map(
    parseGitStatusEntries(status).map((entry) => [entry.path, entry.statusCode]),
  );
  const indexByPath = new Map(
    parseGitIndexEntries(index).map((entry) => [entry.path, entry]),
  );

  const changedPaths = [...new Set([
    ...parseGitStatusPaths(status),
    ...parseGitPathList(unstaged),
    ...parseGitPathList(staged),
    ...parseGitPathList(untracked),
  ])].sort();
  const changeEntries: WorkspaceChangeEntry[] = changedPaths.map((relPath) => ({
    path: relPath,
    digest: hashFileContent(path.join(projectRoot, relPath)),
    indexDigest: indexByPath.get(relPath)?.indexDigest || null,
    indexMode: indexByPath.get(relPath)?.indexMode || null,
    indexStage: indexByPath.get(relPath)?.indexStage || null,
    indexStateKnown: true,
    statusCode: statusByPath.get(relPath) || null,
  }));
  const entries = changeEntries.map((entry) => JSON.stringify([
    entry.path,
    entry.digest,
  ])).sort();

  return {
    identity: sha256(JSON.stringify({ headCommit, headTree, entries })),
    method: 'git',
    dirtyPathCount: entries.length,
    changedPaths,
    changeEntries,
  };
};

const observeStatWalkWorkspace = (
  projectRoot: string,
): Omit<WorkspaceObservation, 'projectRoot' | 'observedAt'> => {
  const entries: string[] = [];
  const walk = (dir: string, rel: string): void => {
    if (entries.length >= WALK_ENTRY_CAP) return;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (entries.length >= WALK_ENTRY_CAP) return;
      if (WALK_EXCLUDES.has(name)) continue;
      const absolute = path.join(dir, name);
      const relative = rel ? `${rel}/${name}` : name;
      let stats;
      try {
        stats = statSync(absolute);
      } catch {
        continue;
      }
      if (stats.isDirectory()) {
        walk(absolute, relative);
      } else if (stats.isFile()) {
        entries.push(
          `${relative}::${stats.size}::${Math.floor(stats.mtimeMs)}`,
        );
      }
    }
  };
  walk(projectRoot, '');
  entries.sort();
  return {
    identity: sha256(JSON.stringify({ entries })),
    method: 'stat-walk',
    dirtyPathCount: null,
    changedPaths: null,
    changeEntries: [],
  };
};

export const observeWorkspaceIdentity = ({
  projectRoot = process.cwd(),
}: {
  projectRoot?: string;
} = {}): WorkspaceObservation => {
  const observation =
    observeGitWorkspace(projectRoot)
    || observeStatWalkWorkspace(projectRoot);
  return {
    ...observation,
    projectRoot,
    observedAt: new Date().toISOString(),
  };
};

export const observeScopedWorkspaceIdentity = ({
  projectRoot = process.cwd(),
  scopes = [],
}: {
  projectRoot?: string;
  scopes?: readonly unknown[];
} = {}): ScopedWorkspaceObservation => {
  const normalized = normalizeVerificationScopes(scopes);
  if (!normalized.scopes) {
    return {
      identity: null,
      method: 'unavailable',
      status: 'unavailable',
      reason: normalized.reason,
      projectRoot,
      scopes: [],
      observedAt: new Date().toISOString(),
    };
  }
  const observation = observeScopedGitWorkspace(
    projectRoot,
    normalized.scopes,
  );
  return {
    ...observation,
    status: observation.identity ? 'observed' : 'unavailable',
    reason: observation.reason || null,
    projectRoot,
    scopes: normalized.scopes,
    observedAt: new Date().toISOString(),
  };
};
