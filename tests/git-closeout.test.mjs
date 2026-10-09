import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { executeKernelGitCloseout } from '../scripts/kernel/git/closeout.mjs';

test('Git Closeout - verifies Git closeout execution contract', async (t) => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'git-closeout-contract-'));
  t.after(() => rm(repoRoot, { recursive: true, force: true }));
  const git = (args) => {
    const result = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git(['init', '--quiet']);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '--quiet', '-m', 'Initial fixture']);
  const gitCloseoutRequest = {
    requested: true,
    mode: 'soft',
    approvalReceipt: 'receipt-123',
    commitSha: 'd'.repeat(40),
  };

  const knowledgeCommitReceipt = {
    status: 'committed',
    revisionAfter: '1',
    committedCount: 1,
  };

  // When no changed files selected, returns skipped
  const resSkipped = await executeKernelGitCloseout({
    runId: 'run-git-1',
    projectId: 'proj-git-1',
    repoRoot,
    gitCloseoutRequest,
    knowledgeCommitReceipt,
    changedFiles: [],
  });

  assert.ok(resSkipped);
  assert.equal(resSkipped.status, 'skipped');

  // When requested is false, returns skipped
  const resUnrequested = await executeKernelGitCloseout({
    runId: 'run-git-1',
    projectId: 'proj-git-1',
    repoRoot,
    gitCloseoutRequest: { requested: false },
    knowledgeCommitReceipt,
    changedFiles: ['README.md'],
  });

  assert.ok(resUnrequested);
  assert.equal(resUnrequested.status, 'skipped');

  await writeFile(path.join(repoRoot, 'existing.txt'), 'pre-existing staged work\n');
  git(['add', 'existing.txt']);
  await assert.rejects(executeKernelGitCloseout({
    runId: 'run-git-1', projectId: 'proj-git-1', repoRoot,
    gitCloseoutRequest, knowledgeCommitReceipt, changedFiles: [],
  }), { code: 'GIT_PREEXISTING_STAGED_CHANGES' });
  assert.equal(git(['diff', '--cached', '--name-only']), 'existing.txt');
});
