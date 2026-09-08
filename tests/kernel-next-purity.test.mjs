import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createKernelControlPlane } from '../scripts/kernel/control-plane.mjs';

test('next returns baseline-required without executing the bound command or writing state', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kernel-next-pure-'));
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-next-state-'));
  await mkdir(path.join(root, '.moon-relay'), { recursive: true });
  await writeFile(path.join(root, '.moon-relay', 'track.yaml'), 'track: kernel\n');
  await writeFile(path.join(root, 'package.json'), JSON.stringify({
    scripts: { 'test:sentinel': `node -e "require('fs').writeFileSync('spawned', 'bad')"` },
  }));
  const cp = await createKernelControlPlane({ runtimeHome, projectRoot: root });
  try {
    await cp.startRun({
      runId: 'pure-next',
      objective: 'do work',
      taskContract: { acceptance: ['works'], baselineRequired: true },
    });
    const before = await readFile(path.join(runtimeHome, 'state', 'runtime-state.sqlite'));
    const started = performance.now();
    const next = await cp.next('pure-next');
    const elapsed = performance.now() - started;
    const after = await readFile(path.join(runtimeHome, 'state', 'runtime-state.sqlite'));
    assert.equal(next.action.type, 'baseline-required');
    assert.equal(next.nextAction, 'baseline-required');
    assert.ok(next.action.commandRefs.includes('test:sentinel'));
    assert.ok(elapsed < 2000, `next took ${elapsed}ms`);
    assert.deepEqual(after, before);
    await assert.rejects(() => readFile(path.join(root, 'spawned')));
  } finally {
    await cp.close();
  }
});
