import { prepareTestHostTurn } from './helpers/kernel-host-test-api.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createKernelControlPlane } from '../scripts/kernel/control-plane.mjs';

test('host-issued capsule and workspace fencing enforce mutation paths', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kernel-mutation-'));
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-mutation-state-'));
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src', 'app.mjs'), 'export default 1');
  await writeFile(path.join(root, 'outside.mjs'), 'export default 2');
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
  const cp = await createKernelControlPlane({ runtimeHome, projectRoot: root, holder: 'session-one' });
  try {
    await cp.startRun({ runId: 'guard', objective: 'edit src', taskContract: { acceptance: ['works'], allowedPaths: ['src/**'] } });
    const host = await prepareTestHostTurn(cp, 'guard', {
      hostCapabilities: { surface: 'codex', supportsSessionModelOverride: true, supportsResolvedModelIdentity: true },
    });
    const stepId = host.executionCapsule.stepId;
    const request = {
      runId: 'guard',
      stepId,
      capsuleId: host.executionCapsule.capsuleId,
      operation: 'file_write',
      fencingToken: host.hostDirective.mutationLock.fencingToken,
      sessionToken: host.hostDirective.mutationLock.sessionToken,
    };
    assert.equal(cp.assertMutationAllowed({ ...request, targetPaths: ['src/app.mjs'] }).allowed, true);
    assert.throws(() => cp.assertMutationAllowed({ ...request, targetPaths: ['outside.mjs'] }), /mutation_path_forbidden/);
    assert.throws(() => cp.assertMutationAllowed({ ...request, operation: 'git_reset', targetPaths: ['src/app.mjs'] }), /mutation_operation_forbidden/);
    assert.throws(() => cp.assertMutationAllowed({ ...request, targetPaths: ['../escape'] }), /mutation_outside_workspace/);
  } finally {
    await cp.close();
  }
});
