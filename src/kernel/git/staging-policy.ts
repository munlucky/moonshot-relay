import path from 'node:path';

export const HARD_DENY_PATTERNS: readonly RegExp[] = [
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

export function isPathStagable(filePath: unknown): filePath is string {
  if (typeof filePath !== 'string' || filePath.length === 0) return false;
  const normalized = filePath.replace(/\\/g, '/');
  return !HARD_DENY_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function filterStagingSelection(candidatePaths: readonly unknown[] = []): {
  selectedPaths: string[];
  excludedPaths: unknown[];
} {
  const selectedPaths: string[] = [];
  const excludedPaths: unknown[] = [];

  for (const candidate of candidatePaths) {
    if (isPathStagable(candidate)) selectedPaths.push(candidate);
    else excludedPaths.push(candidate);
  }

  return { selectedPaths, excludedPaths };
}

export function validateGitCloseoutPath(
  repoRoot: string,
  candidatePath: unknown,
  { changedPathsInGit = null }: { changedPathsInGit?: readonly string[] | null } = {},
): true {
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
  if (
    normalized.startsWith('../')
    || normalized.includes('/../')
    || normalized === '..'
  ) {
    throw new Error('GIT_PATH_TRAVERSAL: Relative path traversal (..) is forbidden');
  }
  if (!isPathStagable(normalized)) {
    throw new Error(`GIT_PATH_DENIED: Path ${normalized} is denied by staging policy`);
  }

  const resolvedRoot = path.resolve(repoRoot);
  const resolvedPath = path.resolve(repoRoot, candidatePath);
  if (
    resolvedPath !== resolvedRoot
    && !resolvedPath.startsWith(`${resolvedRoot}${path.sep}`)
  ) {
    throw new Error(
      `GIT_PATH_OUTSIDE_REPOSITORY: Path ${candidatePath} resolves outside repository ${repoRoot}`,
    );
  }

  if (changedPathsInGit && changedPathsInGit.length > 0) {
    const isChanged = changedPathsInGit.some((changedPath) => (
      changedPath === normalized
      || path.resolve(repoRoot, changedPath) === resolvedPath
    ));
    if (!isChanged) {
      throw new Error(
        `GIT_PATH_NOT_CHANGED: Path ${candidatePath} is not a changed file in repository`,
      );
    }
  }

  return true;
}
