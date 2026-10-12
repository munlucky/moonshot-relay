import path from 'node:path';
import {
  spawnSync,
  type SpawnSyncOptionsWithStringEncoding,
  type SpawnSyncReturns,
} from 'node:child_process';

export type GitCommandResult = SpawnSyncReturns<string>;

export type RunGitOptions = Omit<
  SpawnSyncOptionsWithStringEncoding,
  'cwd' | 'encoding'
>;

export function gitSafeArgs(
  repoRoot: string,
  args: readonly string[] = [],
): string[] {
  const absoluteRepoRoot = path.resolve(repoRoot || process.cwd());
  return ['-c', `safe.directory=${absoluteRepoRoot}`, ...args];
}

export function runGit(
  repoRoot: string,
  args: readonly string[] = [],
  options: RunGitOptions = {},
): GitCommandResult {
  const absoluteRepoRoot = path.resolve(repoRoot || process.cwd());
  return spawnSync(
    'git',
    gitSafeArgs(absoluteRepoRoot, args),
    {
      cwd: absoluteRepoRoot,
      encoding: 'utf8',
      ...options,
    },
  );
}

export function gitLsFiles(
  repoRoot: string,
  pathspecs: readonly string[] = [],
): GitCommandResult {
  return runGit(repoRoot, ['ls-files', '--', ...pathspecs]);
}

export function gitStatusBranchLine(repoRoot: string): string {
  const result = runGit(repoRoot, ['status', '--short', '--branch']);
  if (result.error || (result.status ?? 0) !== 0) return '';
  return String(result.stdout || '').split(/\r?\n/)[0] || '';
}

export function gitConfigValue(repoRoot: string, key: string): string {
  const result = runGit(repoRoot, ['config', '--get', key]);
  if (result.error || (result.status ?? 0) !== 0) return '';
  return String(result.stdout || '').trim();
}

export function gitCurrentBranch(repoRoot: string): string {
  const result = runGit(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (result.error || (result.status ?? 0) !== 0) return '';
  const branch = String(result.stdout || '').trim();
  return branch && branch !== 'HEAD' ? branch : '';
}
