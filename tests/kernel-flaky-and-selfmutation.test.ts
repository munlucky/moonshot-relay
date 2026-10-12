import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createKernelControlPlane } from '../src/host/kernel/control-plane-runtime.js';

test('F1: a flaky verification (fail then pass) is recorded as blocking, not a clean pass', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'krn-flaky-home-'));
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'krn-flaky-proj-'));
  const counter = path.join(await mkdtemp(path.join(os.tmpdir(), 'krn-flaky-ctr-')), 'n');
  spawnSync('git', ['init'], { cwd: projectRoot, encoding: 'utf8' });
  // Counter lives OUTSIDE the project so the flakiness does not also mutate the
  // workspace (which would confound this with the self-mutation guard).
  await writeFile(path.join(projectRoot, 'flaky.cjs'), [
    'const fs=require("fs");',
    `const p=${JSON.stringify(counter)};`,
    'let n=0; try{n=Number(fs.readFileSync(p,"utf8"))||0}catch{}',
    'fs.writeFileSync(p,String(n+1));',
    'process.exit(n===0?1:0);',
  ].join('\n'));
  await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({
    name: 'flaky-fixture', version: '0.0.1', scripts: { 'test:flaky': 'node flaky.cjs' },
  }, null, 2));

  const cp = await createKernelControlPlane({ runtimeHome, projectRoot });
  try {
    await cp.startRun({ runId: 'r-flaky', objective: 'x' });
    await cp.transition('r-flaky', 'EXECUTE');
    await cp.transition('r-flaky', 'PROVE');

    const { execution } = await cp.executeProof('r-flaky', { obligationId: 'default', commandRef: 'test:flaky', flakyRerun: true });
    assert.equal(execution.flaky, true);
    assert.equal(execution.recordedStatus, 'failed');

    // The persisted verification must be failing, so completion stays blocked
    // until an explicit waiver is recorded.
    const comp = await cp.assessCompletion('r-flaky');
    assert.notEqual(comp.decision, 'accepted');
  } finally {
    await cp.close();
    await rm(runtimeHome, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('F2: a verification command that mutates tracked source produces stale (invalid) evidence', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'krn-selfmut-home-'));
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'krn-selfmut-proj-'));
  spawnSync('git', ['init'], { cwd: projectRoot, encoding: 'utf8' });
  // This "test" passes (exit 0) but rewrites a tracked source file as a side
  // effect — so the evidence is produced against a workspace state that no
  // longer exists once it finishes.
  await writeFile(path.join(projectRoot, 'gen.cjs'), [
    'const fs=require("fs");',
    'fs.writeFileSync("generated.txt", String(Date.now()));',
    'process.exit(0);',
  ].join('\n'));
  await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({
    name: 'selfmut-fixture', version: '0.0.1', scripts: { 'test:gen': 'node gen.cjs' },
  }, null, 2));

  const cp = await createKernelControlPlane({ runtimeHome, projectRoot });
  try {
    await cp.startRun({ runId: 'r-selfmut', objective: 'x' });
    await cp.transition('r-selfmut', 'EXECUTE');
    await cp.transition('r-selfmut', 'PROVE');

    const { execution } = await cp.executeProof('r-selfmut', { obligationId: 'default', commandRef: 'test:gen' });
    assert.equal(execution.workspaceMutatedByProof, true);
    assert.equal(execution.recordedStatus, 'failed');

    // Evidence from a self-mutating command cannot complete the run.
    const comp = await cp.assessCompletion('r-selfmut');
    assert.notEqual(comp.decision, 'accepted');
  } finally {
    await cp.close();
    await rm(runtimeHome, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  }
});
