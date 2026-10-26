import path from 'node:path';
import { lstatSync, readFileSync } from 'node:fs';

export const HARD_DENY_PATTERNS: readonly RegExp[] = [
  /\.git\//i,
  /\.moon-relay\//i,
  /\.moonshot-relay\//i,
  /\.claude\/memory/i,
  /\.claude\/cache\/memorygraph(\/|$)/i,
  /\.codex\/state/i,
  /\.qwen\//i,
  /(^|\/)\.env(?!\.example$).*/i,
  /\.sqlite(-wal|-shm)?$/i,
  /\.moon-relay-kernel\//i,
  /(^|\/)\.agents(\/|$)/i,
  /(^|\/)\.mcp\.json$/i,
];

// A checked-in template is configuration documentation, but its contents must
// still be checked at the shared staging boundary in every closeout path.
export function assertStagingContentSafe(repoRoot: string, filePath: string): void {
  if (path.posix.basename(filePath.replace(/\\/gu, '/')).toLowerCase() !== '.env.example') return;
  const absolute = path.resolve(repoRoot, filePath);
  const stat = lstatSync(absolute, { throwIfNoEntry: false });
  if (!stat) return; // Tracked template deletion has no content to disclose.
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) {
    throw new Error('GIT_ENV_TEMPLATE_INVALID');
  }
  const text = readFileSync(absolute, 'utf8');
  if (text.includes('\0') || /(?:gh[pousr]_[A-Za-z0-9]{20,}|sk-(?:proj-)?[A-Za-z0-9_-]{25,}|-----BEGIN .*PRIVATE KEY-----)/u.test(text)) {
    throw new Error('GIT_ENV_TEMPLATE_SECRET');
  }
  for (const line of text.split(/\r?\n/u)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const assignment = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u.exec(line.trim());
    if (!assignment) throw new Error('GIT_ENV_TEMPLATE_INVALID');
    // AUTH must be a name token: OAUTH configuration is not itself a credential.
    if (/(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|(?:^|_)AUTH)(?:_|$)/iu.test(assignment[1]!)) {
      const value = assignment[2]!.trim().replace(/^(['"])(.*)\1$/u, '$2');
      // Numeric TTL metadata carries a duration rather than the credential.
      if (/_TTL_(?:SECONDS|MS)$/iu.test(assignment[1]!) && /^\d+$/u.test(value)) continue;
      if (value && !/^(?:<[^<>]+>|\$\{[A-Za-z_][A-Za-z0-9_]*\}|changeme|replace_me|replace[-_]with[-_][A-Za-z_-]+|your[-_][A-Za-z_-]+)$/iu.test(value)) {
        throw new Error('GIT_ENV_TEMPLATE_SECRET');
      }
    }
  }
}

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
