import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { runGit } from '../src/shared/git-safe.js';
import { executeKernelGitCloseout, KernelGitCloseoutError } from '../src/kernel/git/closeout.js';
import { observeWorkspaceIdentity } from '../src/host/kernel/workspace/workspace-identity.js';
import { createGitCloseoutHost } from '../src/host/kernel/git/closeout-operations.js';

const gitCloseoutHost = createGitCloseoutHost();

test('executeKernelGitCloseout isolates pre-staged user changes using temporary index', async () => {
  const tmpRepo = await mkdtemp(path.join(os.tmpdir(), 'git-closeout-safety-'));

  // Initialize repo and initial commit
  runGit(tmpRepo, ['init', '-b', 'main']);
  runGit(tmpRepo, ['config', 'user.name', 'Test User']);
  runGit(tmpRepo, ['config', 'user.email', 'test@example.com']);

  const fileA = path.join(tmpRepo, 'fileA.txt');
  const fileB = path.join(tmpRepo, 'fileB.txt');

  await writeFile(fileA, 'Initial A\n');
  runGit(tmpRepo, ['add', 'fileA.txt']);
  runGit(tmpRepo, ['commit', '-m', 'Initial commit']);

  // User pre-stages fileA.txt modification
  await writeFile(fileA, 'User pre-staged change in fileA\n');
  runGit(tmpRepo, ['add', 'fileA.txt']);

  // Kernel creates fileB.txt
  await writeFile(fileB, 'Kernel change in fileB\n');

  const gitCloseoutRequest = {
    requested: true,
    mode: 'commit',
    approvalReceipt: 'receipt-user-app',
  };
  const knowledgeCommitReceipt = {
    digest: 'kc-digest-123',
  };

  await assert.rejects(
    async () =>
      executeKernelGitCloseout({
        runId: 'git-run-1',
        projectId: 'test-proj',
        repoRoot: tmpRepo,
        gitCloseoutRequest,
        knowledgeCommitReceipt,
        changedFiles: ['fileB.txt'],
        gitCloseoutHost,
      }),
    (err) => err instanceof KernelGitCloseoutError && err.code === 'GIT_PREEXISTING_STAGED_CHANGES'
  );
});

test('executeKernelGitCloseout rejects detached HEAD', async () => {
  const tmpRepo = await mkdtemp(path.join(os.tmpdir(), 'git-detached-test-'));

  runGit(tmpRepo, ['init']);
  runGit(tmpRepo, ['config', 'user.name', 'Test User']);
  runGit(tmpRepo, ['config', 'user.email', 'test@example.com']);

  const fileA = path.join(tmpRepo, 'fileA.txt');
  await writeFile(fileA, 'Initial A\n');
  runGit(tmpRepo, ['add', 'fileA.txt']);
  runGit(tmpRepo, ['commit', '-m', 'Initial commit']);

  // Checkout detached commit SHA
  const sha = String(runGit(tmpRepo, ['rev-parse', 'HEAD']).stdout).trim();
  runGit(tmpRepo, ['checkout', sha]);

  await assert.rejects(
    async () =>
      executeKernelGitCloseout({
        runId: 'git-run-detached',
        projectId: 'test-proj',
        repoRoot: tmpRepo,
        gitCloseoutRequest: { requested: true, mode: 'commit', approvalReceipt: 'receipt-1' },
        knowledgeCommitReceipt: { digest: 'kc-1' },
        changedFiles: ['fileA.txt'],
        gitCloseoutHost,
      }),
    (err) => err instanceof KernelGitCloseoutError && err.code === 'DETACHED_HEAD'
  );
});

test('executeKernelGitCloseout rejects direct workspace mutation before staging', async () => {
  const tmpRepo = await mkdtemp(path.join(os.tmpdir(), 'git-closeout-identity-'));
  try {
    runGit(tmpRepo, ['init', '-b', 'main']);
    runGit(tmpRepo, ['config', 'user.name', 'Test User']);
    runGit(tmpRepo, ['config', 'user.email', 'test@example.com']);

    const file = path.join(tmpRepo, 'file.txt');
    await writeFile(file, 'initial\n');
    runGit(tmpRepo, ['add', 'file.txt']);
    runGit(tmpRepo, ['commit', '-m', 'Initial commit']);
    const before = observeWorkspaceIdentity({ projectRoot: tmpRepo }).identity;
    const headBefore = String(runGit(tmpRepo, ['rev-parse', 'HEAD']).stdout).trim();
    await writeFile(file, 'direct mutation\n');

    let observedIdentity: string | null = null;
    const closeout: { receipt?: { status?: unknown } } = {};
    const stateStore = {
      getRun: () => ({
        runId: 'git-identity-run',
        sourceIdentity: 'source-git-identity',
        mutationRevision: 1,
        currentWorkspaceIdentity: before,
      }),
      getCompletionDecision: () => ({
        decision: 'accepted',
        sourceIdentity: 'source-git-identity',
        mutationRevision: 1,
        decisionJson: {
          decision: 'accepted',
          sourceIdentity: 'source-git-identity',
          mutationRevision: 1,
          currentWorkspaceIdentity: before,
        },
      }),
      getMutationProvenance: () => ({
        runId: 'git-identity-run',
        sourceIdentity: 'source-git-identity',
        mutationRevision: 1,
        workspaceIdentity: before,
      }),
      observeWorkspaceIdentity: (_runId: string, identity: string) => {
        observedIdentity = identity;
        return { changed: true };
      },
      recordGitCloseoutReceipt: (_runId: string, receipt: { status?: unknown }) => { closeout.receipt = receipt; },
    };

    await assert.rejects(
      async () => executeKernelGitCloseout({
        runId: 'git-identity-run',
        projectId: 'test-project',
        repoRoot: tmpRepo,
        stateStore,
        observeWorkspaceIdentity,
        gitCloseoutRequest: { requested: true, mode: 'commit', approvalReceipt: 'receipt-identity' },
        knowledgeCommitReceipt: { digest: 'knowledge-identity' },
        changedFiles: ['file.txt'],
        gitCloseoutHost,
      }),
      (error) => error instanceof KernelGitCloseoutError && error.code === 'WORKSPACE_IDENTITY_MISMATCH',
    );

    assert.ok(observedIdentity);
    assert.notEqual(observedIdentity, before);
    assert.ok(closeout.receipt);
    assert.equal(closeout.receipt.status, 'stale_workspace');
    assert.equal(runGit(tmpRepo, ['rev-parse', 'HEAD']).status, 0);
    assert.equal(String(runGit(tmpRepo, ['rev-parse', 'HEAD']).stdout).trim(), headBefore);
  } finally {
    await rm(tmpRepo, { recursive: true, force: true });
  }
});
