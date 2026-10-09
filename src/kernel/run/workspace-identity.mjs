import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { matchPathScope } from '../knowledge/path-scope.mjs';

const WALK_EXCLUDES = new Set(['.git', 'node_modules', 'dist', '.moonshot-relay', '.moon-relay', '.tmp', '.history']);
const WALK_ENTRY_CAP = 20000;

const sha256 = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;

const runGit = (args, cwd) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (result.error || result.status !== 0) return null;
  return result.stdout;
};

const hashFileContent = (absolutePath) => {
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
const normalizeGitPath = (value) => {
  const raw = String(value ?? '');
  const platformPath = process.platform === 'win32' ? raw.replaceAll('\\', '/') : raw;
  return platformPath.replace(/^\.\//u, '');
};

const parseGitPathList = (value) => [...new Set(
  nulSeparated(value).map(normalizeGitPath).filter(Boolean),
)];

// Porcelain -z emits the destination and source as separate NUL-delimited
// paths for renames/copies. Keep both: a scope authority must account for the
// path that disappeared as well as the path that appeared. Retain the XY code
// too: a content digest alone cannot distinguish an index-only change.
const parseGitStatusEntries = (value) => {
  const tokens = nulSeparated(value);
  const entries = [];
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

const parseGitStatusPaths = (value) => parseGitStatusEntries(value).map((entry) => entry.path);

const normalizeVerificationScopes = (scopes) => {
  if (!Array.isArray(scopes) || scopes.length === 0) return { scopes: null, reason: 'scope-not-declared' };
  const normalized = [];
  for (const raw of scopes) {
    if (typeof raw !== 'string') return { scopes: null, reason: 'scope-entry-invalid' };
    const scope = normalizeGitPath(raw).replace(/\/{2,}/gu, '/');
    if (!scope || scope === '*' || scope === '**') return { scopes: null, reason: 'scope-too-broad' };
    if (/^(?:[A-Za-z]:|\/|\\\\)/u.test(scope) || scope.split('/').includes('..')) {
      return { scopes: null, reason: 'scope-path-invalid' };
    }
    normalized.push(scope);
  }
  const unique = [...new Set(normalized)].sort();
  return unique.length > 0 ? { scopes: unique, reason: null } : { scopes: null, reason: 'scope-not-declared' };
};

const nulSeparated = (value) => String(value || '').split('\0').filter(Boolean);

// `git ls-files --stage -z` gives the exact index object/mode/stage for every
// tracked path. Restricting the map to changed paths keeps the identity small,
// while still detecting staging, unstaging, and partial-stage changes on a
// pre-existing dirty file.
const parseGitIndexEntries = (value) => nulSeparated(value)
  .map((record) => {
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
  .filter(Boolean);

const safeProjectRelativePath = (projectRoot, relPath) => {
  const raw = String(relPath ?? '');
  const normalized = (process.platform === 'win32' ? raw.replaceAll('\\', '/') : raw)
    .replace(/^\.\//u, '');
  if (!normalized || normalized.split('/').includes('..')) return null;
  const absolute = path.resolve(projectRoot, ...normalized.split('/'));
  const relative = path.relative(path.resolve(projectRoot), absolute);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  return { normalized, absolute };
};

// A verification scope is a content snapshot, not a write-ownership hint. It
// is available only for a validated Git workspace where tracked, staged,
// modified, deleted, and untracked files can all be enumerated exactly.
const observeScopedGitWorkspace = (projectRoot, scopes) => {
  const inRepo = runGit(['rev-parse', '--is-inside-work-tree'], projectRoot);
  if (!inRepo || inRepo.trim() !== 'true') return { identity: null, method: 'unavailable', reason: 'git-worktree-unavailable' };
  const tracked = runGit(['ls-files', '-z'], projectRoot);
  const untracked = runGit(['ls-files', '--others', '--exclude-standard', '-z'], projectRoot);
  if (tracked === null || untracked === null) return { identity: null, method: 'unavailable', reason: 'file-enumeration-failed' };

  const candidates = [...new Set([...nulSeparated(tracked), ...nulSeparated(untracked)])];
  const entries = [];
  for (const candidate of candidates) {
    const safe = safeProjectRelativePath(projectRoot, candidate);
    if (!safe || !matchPathScope(safe.normalized, scopes)) continue;
    let digest;
    try {
      const stats = statSync(safe.absolute);
      if (!stats.isFile()) return { identity: null, method: 'unavailable', reason: 'non-file-observation-failed' };
      digest = createHash('sha256').update(readFileSync(safe.absolute)).digest('hex');
    } catch {
      // A tracked path that disappeared is part of the proof scope, not an
      // enumeration error: the deletion marker must change the digest.
      const exists = (() => {
        try { statSync(safe.absolute); return true; } catch { return false; }
      })();
      if (exists) return { identity: null, method: 'unavailable', reason: 'file-content-observation-failed' };
      digest = 'deleted';
    }
    entries.push([safe.normalized, digest]);
  }
  entries.sort(([left], [right]) => left.localeCompare(right));
  return {
    identity: sha256(JSON.stringify({ scopes, entries })),
    method: 'git-scoped',
    dirtyPathCount: entries.length,
    entries,
  };
};

const observeGitWorkspace = (projectRoot) => {
  const inRepo = runGit(['rev-parse', '--is-inside-work-tree'], projectRoot);
  if (!inRepo || inRepo.trim() !== 'true') return null;

  const headTree = (runGit(['rev-parse', 'HEAD^{tree}'], projectRoot) || 'no-head').trim();
  const headCommit = (runGit(['rev-parse', 'HEAD'], projectRoot) || 'no-head').trim();
  const status = runGit(['status', '--porcelain=v1', '-z', '--untracked-files=all'], projectRoot);
  const unstaged = runGit(['diff', '--name-only', '-z', '--no-renames'], projectRoot);
  const staged = runGit(['diff', '--cached', '--name-only', '-z', '--no-renames'], projectRoot);
  const untracked = runGit(['ls-files', '--others', '--exclude-standard', '-z'], projectRoot);
  const index = runGit(['ls-files', '--stage', '-z'], projectRoot);
  if (status === null || unstaged === null || staged === null || untracked === null || index === null) return null;

  const statusByPath = new Map(parseGitStatusEntries(status).map((entry) => [entry.path, entry.statusCode]));
  const indexByPath = new Map(parseGitIndexEntries(index).map((entry) => [entry.path, entry]));

  const changedPaths = [...new Set([
    ...parseGitStatusPaths(status),
    ...parseGitPathList(unstaged),
    ...parseGitPathList(staged),
    ...parseGitPathList(untracked),
  ])].sort();
  const changeEntries = changedPaths.map((relPath) => ({
    path: relPath,
    digest: hashFileContent(path.join(projectRoot, relPath)),
    indexDigest: indexByPath.get(relPath)?.indexDigest || null,
    indexMode: indexByPath.get(relPath)?.indexMode || null,
    indexStage: indexByPath.get(relPath)?.indexStage || null,
    indexStateKnown: true,
    statusCode: statusByPath.get(relPath) || null,
  }));
  // Keep the coarse workspace identity compatible across an integration
  // worktree and the owner worktree: one may have the same patch staged while
  // the other has it unstaged. The detailed index/status fields remain in
  // changeEntries and are the authority used by deriveRunChangedPaths, so an
  // index-only mutation is still visible to report scope validation without
  // making Delivery reject an equivalent patch solely because Git staging
  // differs between the two workspaces.
  const entries = changeEntries.map((entry) => JSON.stringify([
    entry.path,
    entry.digest,
  ])).sort();

  return {
    // Include the commit as well as its tree. Two commits may point at the same
    // tree (for example an allow-empty commit), but they do not carry the same
    // provenance and must not share completion evidence.
    identity: sha256(JSON.stringify({ headCommit, headTree, entries })),
    method: 'git',
    dirtyPathCount: entries.length,
    changedPaths,
    changeEntries,
  };
};

const observeStatWalkWorkspace = (projectRoot) => {
  const entries = [];
  const walk = (dir, rel) => {
    if (entries.length >= WALK_ENTRY_CAP) return;
    let names;
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
        entries.push(`${relative}::${stats.size}::${Math.floor(stats.mtimeMs)}`);
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

// Observes the actual workspace state including uncommitted and untracked
// changes; HEAD tree alone cannot distinguish a dirty working tree.
export const observeWorkspaceIdentity = ({ projectRoot = process.cwd() } = {}) => {
  const observation = observeGitWorkspace(projectRoot) || observeStatWalkWorkspace(projectRoot);
  return { ...observation, projectRoot, observedAt: new Date().toISOString() };
};

const normalizedBaselineEntries = (entries = []) => (Array.isArray(entries) ? entries : [])
  .map((entry) => {
    if (Array.isArray(entry)) return {
      path: normalizeGitPath(entry[0]),
      digest: String(entry[1] || ''),
      indexStateKnown: false,
      indexDigest: null,
      indexMode: null,
      indexStage: null,
      statusCode: null,
    };
    const indexStateKnown = entry?.indexStateKnown === true
      || Object.prototype.hasOwnProperty.call(entry || {}, 'indexDigest')
      || Object.prototype.hasOwnProperty.call(entry || {}, 'statusCode');
    return {
      path: normalizeGitPath(entry?.path),
      digest: String(entry?.digest || ''),
      indexStateKnown,
      indexDigest: indexStateKnown && entry?.indexDigest ? String(entry.indexDigest) : null,
      indexMode: indexStateKnown && entry?.indexMode ? String(entry.indexMode) : null,
      indexStage: indexStateKnown && entry?.indexStage ? String(entry.indexStage) : null,
      statusCode: indexStateKnown && entry?.statusCode ? String(entry.statusCode) : null,
    };
  })
  .filter((entry) => entry.path && entry.digest);

// Return the Run-owned portion of the live Git change set. A Run starts with
// any pre-existing dirty files as its baseline; comparing content digests (not
// just path names) keeps an initially-uncommitted fixture or a baseline file
// that is later edited from disappearing from the authoritative delta.
export const deriveRunChangedPaths = ({ observation = null, baselineChangedPaths = [], baselineEntries = [], baselineStatus = 'known' } = {}) => {
  if (baselineStatus === 'unknown') {
    return {
      status: 'unavailable',
      reason: 'workspace-baseline-unknown',
      actualChangedPaths: null,
      fullChangedPaths: Array.isArray(observation?.changedPaths) ? [...observation.changedPaths].sort() : null,
      baselineChangedPaths: [...new Set((Array.isArray(baselineChangedPaths) ? baselineChangedPaths : []).map(normalizeGitPath).filter(Boolean))].sort(),
      baselineDriftPaths: [],
    };
  }
  if (observation?.method !== 'git' || !Array.isArray(observation.changedPaths) || !Array.isArray(observation.changeEntries)) {
    return {
      status: 'unavailable',
      reason: observation?.method === 'git' ? 'git-change-observation-unavailable' : 'non-git-workspace',
      actualChangedPaths: null,
      fullChangedPaths: null,
      baselineChangedPaths: [...new Set((Array.isArray(baselineChangedPaths) ? baselineChangedPaths : []).map(normalizeGitPath).filter(Boolean))].sort(),
      baselineDriftPaths: [],
    };
  }

  // Keep the complete baseline entry, not only its working-tree digest. The
  // index fields and porcelain status are part of the authority because a
  // staged/unstaged transition can change the Run-owned state without
  // changing the file content.
  const baseline = new Map(normalizedBaselineEntries(baselineEntries).map((entry) => [entry.path, entry]));
  const baselinePaths = new Set([
    ...(Array.isArray(baselineChangedPaths) ? baselineChangedPaths : []),
    ...baseline.keys(),
  ].map(normalizeGitPath).filter(Boolean));
  const actualChangedPaths = observation.changeEntries
    .filter((entry) => {
      const previous = baseline.get(entry.path);
      if (!previous) return true;
      if (previous.digest !== entry.digest) return true;
      if (previous.indexStateKnown && (!entry.indexStateKnown
        || previous.indexDigest !== entry.indexDigest
        || previous.indexMode !== entry.indexMode
        || previous.indexStage !== entry.indexStage
        || previous.statusCode !== entry.statusCode)) return true;
      return false;
    })
    .map((entry) => entry.path);
  const currentPaths = new Set(observation.changedPaths);
  const baselineDriftPaths = [...baselinePaths].filter((entry) => !currentPaths.has(entry)).sort();

  const preExistingChanges = [...baselinePaths].filter((entry) => !actualChangedPaths.includes(entry)).sort();
  return {
    status: 'observed',
    reason: null,
    actualChangedPaths: [...new Set([...actualChangedPaths, ...baselineDriftPaths])].sort(),
    currentWorkUnitChanges: actualChangedPaths,
    preExistingChanges,
    fullChangedPaths: [...observation.changedPaths].sort(),
    baselineChangedPaths: [...baselinePaths].sort(),
    baselineDriftPaths,
  };
};

export const observeScopedWorkspaceIdentity = ({ projectRoot = process.cwd(), scopes = [] } = {}) => {
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
  const observation = observeScopedGitWorkspace(projectRoot, normalized.scopes);
  return {
    ...observation,
    status: observation.identity ? 'observed' : 'unavailable',
    reason: observation.reason || null,
    projectRoot,
    scopes: normalized.scopes,
    observedAt: new Date().toISOString(),
  };
};
