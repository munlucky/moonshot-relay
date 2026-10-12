import test from 'node:test';
import assert from 'node:assert/strict';
import { executeKernelGitCloseout, KernelGitCloseoutError } from '../src/kernel/git/closeout.js';

test('executeKernelGitCloseout skips cleanly when Git closeout is not requested', async () => {
  const result = await executeKernelGitCloseout({
    runId: 'run-1',
    projectId: 'test-proj',
    gitCloseoutRequest: { requested: false },
  });

  assert.equal(result.status, 'skipped');
});

test('executeKernelGitCloseout rejects unapproved request', async () => {
  await assert.rejects(
    async () =>
      executeKernelGitCloseout({
        runId: 'run-1',
        projectId: 'test-proj',
        gitCloseoutRequest: { requested: true, mode: 'commit', approvalReceipt: '' },
      }),
    KernelGitCloseoutError
  );
});
