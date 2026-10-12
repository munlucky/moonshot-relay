import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp } from 'node:fs/promises';
import { executeKernelGitCloseout } from '../src/kernel/git/closeout.js';

test('Kernel Git Closeout E2E skips cleanly without explicit request', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'kernel-git-e2e-'));
  const receipt = await executeKernelGitCloseout({
    runId: 'git-e2e-run',
    projectId: 'test-git-proj',
    repoRoot: tmp,
    gitCloseoutRequest: null,
  });

  assert.equal(receipt.status, 'skipped');
});
