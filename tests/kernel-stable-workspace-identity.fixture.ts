import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { resolveStableWorkspaceIdentity } from '../src/host/kernel/workspace/stable-workspace.js';

test('stable workspace identity survives file changes and separates worktrees', async () => {
  const repository = await mkdtemp(path.join(os.tmpdir(), 'kernel-stable-workspace-repo-'));
  const worktree = await mkdtemp(path.join(os.tmpdir(), 'kernel-stable-workspace-tree-'));
  try {
    spawnSync('git', ['init'], { cwd: repository, encoding: 'utf8' });
    spawnSync('git', ['config', 'user.email', 'kernel@example.invalid'], { cwd: repository });
    spawnSync('git', ['config', 'user.name', 'Kernel Test'], { cwd: repository });
    await writeFile(path.join(repository, 'tracked.txt'), 'one');
    spawnSync('git', ['add', '.'], { cwd: repository });
    spawnSync('git', ['commit', '-m', 'baseline'], { cwd: repository });
    spawnSync('git', ['worktree', 'add', '--detach', worktree], { cwd: repository });

    const first = resolveStableWorkspaceIdentity({ projectId: 'project-1', workspaceRoot: repository });
    await writeFile(path.join(repository, 'tracked.txt'), 'two');
    const afterMutation = resolveStableWorkspaceIdentity({ projectId: 'project-1', workspaceRoot: repository });
    const otherWorktree = resolveStableWorkspaceIdentity({ projectId: 'project-1', workspaceRoot: worktree });

    assert.equal(afterMutation.workspaceId, first.workspaceId);
    assert.notEqual(otherWorktree.workspaceId, first.workspaceId);
  } finally {
    spawnSync('git', ['worktree', 'remove', '--force', worktree], { cwd: repository });
    await rm(repository, { recursive: true, force: true });
    await rm(worktree, { recursive: true, force: true });
  }
});

test('greenfield workspace identity is stable before the project root exists', async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'kernel-greenfield-workspace-'));
  const workspaceRoot = path.join(parent, 'not-created-yet');
  try {
    const first = resolveStableWorkspaceIdentity({ projectId: 'greenfield-project', workspaceRoot });
    const second = resolveStableWorkspaceIdentity({ projectId: 'greenfield-project', workspaceRoot });
    assert.equal(first.workspaceId, second.workspaceId);
    assert.equal(first.canonicalRoot, path.resolve(workspaceRoot));
    assert.equal(first.gitCommonDir, null);
    assert.equal(first.gitWorktreeDir, null);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
