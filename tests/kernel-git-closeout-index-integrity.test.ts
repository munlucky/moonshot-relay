import test from 'node:test';
import assert from 'node:assert/strict';
import { executeKernelGitCloseout, KernelGitCloseoutError } from '../src/kernel/git/closeout.js';

test('executeKernelGitCloseout fails closed when approval receipt is missing and does not require knowledge receipt', async () => {
  await assert.rejects(
    async () =>
      executeKernelGitCloseout({
        runId: 'r-git-1',
        projectId: 'p-git-1',
        repoRoot: process.cwd(),
        gitCloseoutRequest: { requested: true, approvalReceipt: '' },
        knowledgeCommitReceipt: null,
      }),
    (err) => err instanceof KernelGitCloseoutError && err.code === 'APPROVAL_REQUIRED'
  );
});
