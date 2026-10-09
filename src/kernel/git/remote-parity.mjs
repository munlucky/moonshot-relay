import { runGit } from '../../shared/git-safe.mjs';

export function verifyRemoteParity(repoRoot, { branch = 'main', remote = 'origin' } = {}) {
  const localRes = runGit(repoRoot, ['rev-parse', 'HEAD']);
  if (localRes.status !== 0) {
    return { parity: 'mismatched', localHeadSha: '', remoteHeadSha: '', reason: 'Failed to resolve local HEAD' };
  }
  const localHeadSha = String(localRes.stdout).trim();

  const remoteRes = runGit(repoRoot, ['ls-remote', remote, `refs/heads/${branch}`]);
  if (remoteRes.status !== 0) {
    return { parity: 'mismatched', localHeadSha, remoteHeadSha: '', reason: 'Failed to query remote' };
  }

  const remoteHeadSha = String(remoteRes.stdout).split(/\s+/)[0] || '';
  const matched = localHeadSha === remoteHeadSha;

  return {
    parity: matched ? 'matched' : 'mismatched',
    localHeadSha,
    remoteHeadSha,
  };
}
