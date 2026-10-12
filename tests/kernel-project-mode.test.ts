import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { detectProjectMode } from '../src/kernel/task/project-mode.js';
import { observeRepositoryStructure } from '../src/host/kernel/workspace/repository-observation.js';
import { createKernelControlPlane } from '../src/host/kernel/control-plane-runtime.js';

test('empty project with no manifest, source, or git history is greenfield', async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'krn-mode-green-'));
  try {
    const detected = detectProjectMode({ observation: observeRepositoryStructure({ projectRoot }) });
    assert.equal(detected.mode, 'greenfield');
    assert.equal(detected.signals.hasManifest, false);
    assert.equal(detected.signals.hasSource, false);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('project with a build manifest is brownfield', async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'krn-mode-brown-'));
  try {
    await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({ name: 'x', scripts: { test: 'node -e "process.exit(0)"', lint: 'node -e "process.exit(0)"' } }));
    const detected = detectProjectMode({ observation: observeRepositoryStructure({ projectRoot }) });
    assert.equal(detected.mode, 'brownfield');
    assert.equal(detected.signals.hasManifest, true);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('project with more than a few source files is brownfield even without a manifest', async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'krn-mode-src-'));
  try {
    await mkdir(path.join(projectRoot, 'src'), { recursive: true });
    for (let i = 0; i < 5; i += 1) {
      await writeFile(path.join(projectRoot, 'src', `mod${i}.js`), `export const v${i} = ${i};\n`);
    }
    const detected = detectProjectMode({ observation: observeRepositoryStructure({ projectRoot }) });
    assert.equal(detected.mode, 'brownfield');
    assert.equal(detected.signals.hasSource, true);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('existing kernel knowledge alone marks a project brownfield', async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'krn-mode-know-'));
  try {
    const detected = detectProjectMode({ observation: observeRepositoryStructure({ projectRoot }), hasKernelKnowledge: true });
    assert.equal(detected.mode, 'brownfield');
    assert.equal(detected.signals.hasKernelKnowledge, true);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('startRun records the detected project mode on the run (internal, not model-visible)', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'krn-mode-home-'));
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'krn-mode-run-'));
  spawnSync('git', ['init'], { cwd: projectRoot, encoding: 'utf8' });
  await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({ name: 'run-fixture', scripts: { test: 'node -e "process.exit(0)"', lint: 'node -e "process.exit(0)"' } }));
  const cp = await createKernelControlPlane({ runtimeHome, projectRoot });
  try {
    await cp.startRun({ runId: 'r-mode', objective: 'mode' });
    const run = await cp.getRun('r-mode');
    assert.ok(run);
    assert.equal(run.projectMode, 'brownfield');

    // Model-visible next payload must not leak the internal mode.
    const next = await cp.next('r-mode');
    assert.ok(!JSON.stringify(next).includes('brownfield'));
  } finally {
    await cp.close();
    await rm(runtimeHome, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  }
});
