import path from 'node:path';
import { runGit } from '../../shared/git-safe.mjs';

export const HARD_DENY_PATTERNS = [
  /\.git\//i,
  /\.moon-relay\//i,
  /\.moonshot-relay\//i,
  /\.claude\/memory/i,
  /\.claude\/cache\/memorygraph(\/|$)/i,
  /\.codex\/state/i,
  /\.qwen\//i,
  /\.env.*/i,
  /\.sqlite(-wal|-shm)?$/i,
  /\.moon-relay-kernel\//i,
  /(^|\/)\.agents(\/|$)/i,
  /(^|\/)\.mcp\.json$/i,
];

export function isPathStagable(filePath) {
  if (!filePath) return false;
  const normalized = filePath.replace(/\\/g, '/');
  for (const pattern of HARD_DENY_PATTERNS) {
    if (pattern.test(normalized)) {
      return false;
    }
  }
  return true;
}

export function filterStagingSelection(candidatePaths = []) {
  const selectedPaths = [];
  const excludedPaths = [];

  for (const p of candidatePaths) {
    if (isPathStagable(p)) {
      selectedPaths.push(p);
    } else {
      excludedPaths.push(p);
    }
  }

  return { selectedPaths, excludedPaths };
}

// `git add -- <path>` exits 1 when the pathspec matches a file that is tracked
// AND covered by an ignore rule (an ancestor-directory rule is the common
// case). It stages the change anyway, so the caller aborts on a non-zero exit
// with the index already dirty, and the retry selects the same path and fails
// identically — a permanent closeout deadlock. `git add -u` updates tracked
// entries without consulting the exclude rules, while plain `git add` still
// refuses an ignored *untracked* path, so splitting the selection by
// trackedness fixes the deadlock without weakening that refusal.
export function partitionStagingPathsByTracking({ repoRoot, paths = [], git = runGit, env = undefined } = {}) {
  const unique = [...new Set(paths.filter((candidate) => typeof candidate === 'string' && candidate.length > 0))];
  if (unique.length === 0) return { tracked: [], untracked: [] };

  const options = env ? { env } : {};
  const result = git(repoRoot, ['ls-files', '-z', '--', ...unique], options);
  if (result.error || (result.status ?? 0) !== 0) {
    throw new Error(`GIT_LS_FILES_FAILED: ${String(result.stderr || result.error?.message || '').trim()}`);
  }

  const trackedSet = new Set(
    String(result.stdout || '').split('\0').filter(Boolean).map((entry) => entry.replace(/\\/g, '/')),
  );
  const tracked = [];
  const untracked = [];
  for (const candidate of unique) {
    if (trackedSet.has(candidate.replace(/\\/g, '/'))) tracked.push(candidate);
    else untracked.push(candidate);
  }
  return { tracked, untracked };
}

export function stageSelectedPaths({ repoRoot, paths = [], git = runGit, env = undefined } = {}) {
  const { tracked, untracked } = partitionStagingPathsByTracking({ repoRoot, paths, git, env });
  const options = env ? { env } : {};
  const invocations = [];
  if (tracked.length > 0) invocations.push(['add', '-u', '--', ...tracked]);
  if (untracked.length > 0) invocations.push(['add', '--', ...untracked]);

  for (const args of invocations) {
    const result = git(repoRoot, args, options);
    if (result.error || (result.status ?? 0) !== 0) {
      throw new Error(`GIT_ADD_FAILED: git ${args.slice(0, 2).join(' ')}: ${String(result.stderr || result.error?.message || '').trim()}`);
    }
  }
  return { tracked, untracked, staged: [...tracked, ...untracked] };
}

export function validateGitCloseoutPath(repoRoot, candidatePath, { changedPathsInGit = null } = {}) {
  if (typeof candidatePath !== 'string' || !candidatePath.trim()) {
    throw new Error('GIT_INVALID_PATH: Path must be a non-empty string');
  }
  if (candidatePath.includes('\0')) {
    throw new Error('GIT_PATH_CONTAINS_NUL: Path contains NUL character');
  }
  if (path.isAbsolute(candidatePath)) {
    throw new Error('GIT_PATH_IS_ABSOLUTE: Absolute paths are forbidden');
  }
  const normalized = candidatePath.replace(/\\/g, '/');
  if (normalized.startsWith('../') || normalized.includes('/../') || normalized === '..') {
    throw new Error('GIT_PATH_TRAVERSAL: Relative path traversal (..) is forbidden');
  }
  if (!isPathStagable(normalized)) {
    throw new Error(`GIT_PATH_DENIED: Path ${normalized} is denied by staging policy`);
  }

  const resolvedRoot = path.resolve(repoRoot);
  const resolvedPath = path.resolve(repoRoot, candidatePath);

  if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`GIT_PATH_OUTSIDE_REPOSITORY: Path ${candidatePath} resolves outside repository ${repoRoot}`);
  }

  if (Array.isArray(changedPathsInGit) && changedPathsInGit.length > 0) {
    const isChanged = changedPathsInGit.some((p) => p === normalized || path.resolve(repoRoot, p) === resolvedPath);
    if (!isChanged) {
      throw new Error(`GIT_PATH_NOT_CHANGED: Path ${candidatePath} is not a changed file in repository`);
    }
  }

  return true;
}
