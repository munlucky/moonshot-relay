import { runGit } from '../../../shared/git-safe.js';

export interface RemoteParityOptions {
  branch?: string;
  remote?: string;
}

export interface RemoteParityResult {
  parity: 'matched' | 'mismatched';
  localHeadSha: string;
  remoteHeadSha: string;
  reason?: string;
}

export function verifyRemoteParity(
  repoRoot: string,
  {
    branch = 'main',
    remote = 'origin',
  }: RemoteParityOptions = {},
): RemoteParityResult {
  const localRes = runGit(repoRoot, ['rev-parse', 'HEAD']);
  if (localRes.status !== 0) {
    return {
      parity: 'mismatched',
      localHeadSha: '',
      remoteHeadSha: '',
      reason: 'Failed to resolve local HEAD',
    };
  }
  const localHeadSha = String(localRes.stdout).trim();

  const remoteRes = runGit(repoRoot, ['ls-remote', remote, `refs/heads/${branch}`]);
  if (remoteRes.status !== 0) {
    return {
      parity: 'mismatched',
      localHeadSha,
      remoteHeadSha: '',
      reason: 'Failed to query remote',
    };
  }

  const remoteHeadSha = String(remoteRes.stdout).split(/\s+/)[0] || '';
  return {
    parity: localHeadSha === remoteHeadSha ? 'matched' : 'mismatched',
    localHeadSha,
    remoteHeadSha,
  };
}
