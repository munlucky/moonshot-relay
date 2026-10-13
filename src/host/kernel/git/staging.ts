import { runGit } from '../../../shared/git-safe.js';
import { assertStagingContentSafe } from '../../../kernel/git/staging-policy.js';

type GitRunner = typeof runGit;

interface StagingInput {
  repoRoot: string;
  paths?: readonly string[];
  git?: GitRunner;
  env?: (NodeJS.ProcessEnv) | undefined;
}

export interface StagingPartition {
  tracked: string[];
  untracked: string[];
}

export interface StagingResult extends StagingPartition {
  staged: string[];
}

export function partitionStagingPathsByTracking({
  repoRoot,
  paths = [],
  git = runGit,
  env = undefined,
}: StagingInput): StagingPartition {
  const unique = [...new Set(
    paths.filter((candidate) => typeof candidate === 'string' && candidate.length > 0),
  )];
  if (unique.length === 0) return { tracked: [], untracked: [] };

  const options = env ? { env } : {};
  const result = git(repoRoot, ['--literal-pathspecs', 'ls-files', '-z', '--', ...unique], options);
  if (result.error || (result.status ?? 0) !== 0) {
    throw Object.assign(
      new Error(
        `GIT_LS_FILES_FAILED: ${String(
          result.stderr || result.error?.message || '',
        ).trim()}`,
      ),
      { code: 'GIT_LS_FILES_FAILED' },
    );
  }

  const trackedSet = new Set(
    String(result.stdout || '')
      .split('\0')
      .filter(Boolean)
      .map((entry) => entry.replace(/\\/g, '/')),
  );
  const tracked: string[] = [];
  const untracked: string[] = [];
  for (const candidate of unique) {
    if (trackedSet.has(candidate.replace(/\\/g, '/'))) tracked.push(candidate);
    else untracked.push(candidate);
  }
  return { tracked, untracked };
}

export function stageSelectedPaths({
  repoRoot,
  paths = [],
  git = runGit,
  env = undefined,
}: StagingInput): StagingResult {
  for (const candidate of paths) {
    assertStagingContentSafe(repoRoot, candidate);
  }
  const { tracked, untracked } = partitionStagingPathsByTracking({
    repoRoot,
    paths,
    git,
    env,
  });
  const options = env ? { env } : {};
  const invocations: string[][] = [];
  if (tracked.length > 0) invocations.push(['--literal-pathspecs', 'add', '-u', '--', ...tracked]);
  if (untracked.length > 0) invocations.push(['--literal-pathspecs', 'add', '--', ...untracked]);

  for (const args of invocations) {
    const result = git(repoRoot, args, options);
    if (result.error || (result.status ?? 0) !== 0) {
      throw Object.assign(
        new Error(
          `GIT_ADD_FAILED: git ${args.slice(0, 2).join(' ')}: ${String(
            result.stderr || result.error?.message || '',
          ).trim()}`,
        ),
        { code: 'GIT_ADD_FAILED' },
      );
    }
  }
  return {
    tracked,
    untracked,
    staged: [...tracked, ...untracked],
  };
}
