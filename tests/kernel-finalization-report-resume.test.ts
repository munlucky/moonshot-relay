import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createKernelControlPlane } from '../src/host/kernel/control-plane-runtime.js';

test('a passed step accepts an unchanged PROVE report when completion coverage remains', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kernel-final-report-'));
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-final-report-state-'));
  await mkdir(path.join(root, '.moon-relay'), { recursive: true });
  await writeFile(path.join(root, '.moon-relay', 'track.yaml'), 'track: kernel\n');
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { 'test:ok': `node -e "process.exit(0)"` } }));
  await writeFile(path.join(root, 'app.mjs'), 'export default 1');
  const cp = await createKernelControlPlane({ runtimeHome, projectRoot: root });
  try {
    await cp.startRun({
      runId: 'final-report',
      objective: 'finish',
      taskContract: {
        allowedPaths: ['app.mjs'],
        acceptance: [
          { acceptance: 'A', evidencePlan: { class: 'hard', method: 'unit-test', commandRefs: ['test:ok'], obligationId: 'default' } },
          { acceptance: 'B', evidencePlan: { class: 'hard', method: 'unit-test', commandRefs: ['test:ok'], obligationId: 'default' } },
        ],
      },
    });
    const first = await cp.report('final-report', {
      stepId: 'step-1-1',
      summary: 'implemented',
      changedPaths: ['app.mjs'],
      verifications: [{ obligationId: 'default', commandRef: 'test:ok', acceptanceCoverage: ['AC-1'] }],
    });
    assert.ok(first && 'step' in first && first.step && 'next' in first);
    assert.equal(first.step.state, 'passed');
    assert.ok(first.next && typeof first.next === 'object' && 'action' in first.next);
    assert.ok(first.next.action && typeof first.next.action === 'object' && 'type' in first.next.action);
    assert.equal(first.next.action.type, 'report');
    const second = await cp.report('final-report', {
      stepId: 'step-1-1',
      summary: 'complete coverage',
      changedPaths: ['app.mjs'],
      verifications: [{ obligationId: 'default', commandRef: 'test:ok', acceptanceCoverage: ['AC-1', 'AC-2'] }],
    });
    assert.ok(second && 'executed' in second);
    assert.notEqual(second.status, 'step-rejected');
    assert.ok(Array.isArray(second.executed));
    const executed: unknown = second.executed[0];
    assert.ok(executed && typeof executed === 'object' && 'status' in executed);
    assert.equal(executed.status, 'passed');
  } finally {
    await cp.close();
  }
});
