import path from 'node:path';
import { spawnSync } from 'node:child_process';

export function gitSafeArgs(repoRoot, args = []) {
  const absoluteRepoRoot = path.resolve(repoRoot || process.cwd());
  return ['-c', `safe.directory=${absoluteRepoRoot}`, ...args];
}

export function runGit(repoRoot, args = [], options = {}) {
  const absoluteRepoRoot = path.resolve(repoRoot || process.cwd());
  return spawnSync('git', gitSafeArgs(absoluteRepoRoot, args), {
    cwd: absoluteRepoRoot,
    encoding: 'utf8',
    ...options,
  });
}

export function gitLsFiles(repoRoot, pathspecs = []) {
  return runGit(repoRoot, ['ls-files', '--', ...pathspecs]);
}

export function gitStatusBranchLine(repoRoot) {
  const result = runGit(repoRoot, ['status', '--short', '--branch']);
  if (result.error || (result.status ?? 0) !== 0) {
    return '';
  }
  return String(result.stdout || '').split(/\r?\n/)[0] || '';
}

export function gitConfigValue(repoRoot, key) {
  const result = runGit(repoRoot, ['config', '--get', key]);
  if (result.error || (result.status ?? 0) !== 0) {
    return '';
  }
  return String(result.stdout || '').trim();
}

export function gitCurrentBranch(repoRoot) {
  const result = runGit(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (result.error || (result.status ?? 0) !== 0) {
    return '';
  }
  const branch = String(result.stdout || '').trim();
  return branch && branch !== 'HEAD' ? branch : '';
}
