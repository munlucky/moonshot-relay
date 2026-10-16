import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createKernelRecoveryContinuity } from '../src/host/kernel/run/agent-recovery.js';

test('Host recovery continuity carries the previous capsule and preserves the three-comparison bound', async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'kernel-recovery-continuity-project-'));
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-recovery-continuity-runtime-'));
  try {
    const continuity = createKernelRecoveryContinuity();
    const diagnose = () => continuity.diagnose({
      projectRoot,
      runtimeHome,
      runId: 'missing-run',
      failure: { code: 'same-runtime-failure' },
    });

    const attempts = [diagnose(), diagnose(), diagnose(), diagnose()];
    assert.deepEqual(
      attempts.map((entry) => entry.recovery.unchangedAttempts),
      [0, 1, 2, 3],
    );
    assert.equal(attempts[3].recovery.mode, 'escalate');

    continuity.clear({ projectRoot, runtimeHome, runId: 'missing-run' });
    assert.equal(diagnose().recovery.unchangedAttempts, 0);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(runtimeHome, { recursive: true, force: true });
  }
});

test('Host recovery continuity resets comparison count when the diagnosed failure changes', async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'kernel-recovery-change-project-'));
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-recovery-change-runtime-'));
  try {
    const continuity = createKernelRecoveryContinuity();
    continuity.diagnose({
      projectRoot,
      runtimeHome,
      runId: 'missing-run',
      failure: { code: 'first-failure' },
    });
    const repeated = continuity.diagnose({
      projectRoot,
      runtimeHome,
      runId: 'missing-run',
      failure: { code: 'first-failure' },
    });
    assert.equal(repeated.recovery.unchangedAttempts, 1);

    const changed = continuity.diagnose({
      projectRoot,
      runtimeHome,
      runId: 'missing-run',
      failure: { code: 'second-failure' },
    });
    assert.equal(changed.recovery.unchangedAttempts, 0);
    assert.notEqual(changed.recovery.fingerprint, repeated.recovery.fingerprint);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(runtimeHome, { recursive: true, force: true });
  }
});
