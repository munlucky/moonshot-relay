import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { buildRunLocatorRecord, writeRunLocator } from '../scripts/kernel/run/run-locator.mjs';

const setup = async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'krn-loc-failsoft-home-'));
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'krn-loc-failsoft-proj-'));
  spawnSync('git', ['init'], { cwd: projectRoot, encoding: 'utf8' });
  await mkdir(path.join(projectRoot, '.moon-relay'), { recursive: true });
  await writeFile(path.join(projectRoot, '.moon-relay', 'track.yaml'), 'track: kernel\nproduct: moon-relay-kernel\n');
  await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({
    name: 'locator-failsoft-fixture',
    version: '0.0.1',
    scripts: { test: 'node -e "process.exit(0)"' },
  }));
  await writeFile(path.join(projectRoot, 'index.mjs'), 'export const active = true;\n');

  // Create a stale locator pointing to non-existent runtime
  const locatorRoot = path.join(runtimeHome, 'state', 'run-locator');
  await mkdir(locatorRoot, { recursive: true });
  await writeRunLocator({
    run: { runId: 'run-stale-999', status: 'active', projectId: 'fake-proj' },
    runtimeHome: path.join(runtimeHome, 'nonexistent-runtime'),
    projectRoot,
    locatorRoot,
  });

  const contractPath = path.join(projectRoot, 'task-contract.json');
  await writeFile(contractPath, JSON.stringify({
    objective: 'fail-soft locator turn 0 bootstrap',
    acceptance: [{ acceptance: 'runs' }],
    allowedPaths: ['index.mjs'],
  }));

  return { runtimeHome, projectRoot, contractPath };
};

const cleanup = async ({ runtimeHome, projectRoot }) => {
  await rm(runtimeHome, { recursive: true, force: true });
  await rm(projectRoot, { recursive: true, force: true });
};


test('S-01/S-20: run id is the durable Task handle and does not depend on owner session identity', () => {
  const record = buildRunLocatorRecord({
    run: { runId: 'run-durable-task', status: 'active', projectId: 'project-durable' },
    runtimeHome: path.join(os.tmpdir(), 'durable-runtime'),
    projectIdentity: {
      projectId: 'project-durable',
      canonicalRoot: path.join(os.tmpdir(), 'durable-project'),
      gitCommonDir: path.join(os.tmpdir(), 'durable-project', '.git'),
    },
  });
  assert.equal(record.runId, 'run-durable-task');
  assert.equal(record.taskHandle, record.runId);
  assert.equal(Object.hasOwn(record, 'ownerSessionId'), false);
  const restarted = buildRunLocatorRecord({
    run: { runId: record.runId, status: 'active', projectId: record.projectId },
    runtimeHome: record.runtimeHome,
    projectIdentity: {
      projectId: record.projectId,
      canonicalRoot: record.canonicalRoot,
      gitCommonDir: record.gitCommonDir,
    },
    previous: record,
  });
  assert.equal(restarted.taskHandle, record.taskHandle);
  assert.equal(Object.hasOwn(restarted, 'ownerSessionId'), false);
});

test('Locator Wave 3: Stale locator does not block Turn 0 next with contract', async () => {
  const fixture = await setup();
  try {
    const kernelBin = path.resolve('bin/moon-relay-kernel.mjs');
    const result = spawnSync(process.execPath, [
      kernelBin,
      'next',
      '--contract-json',
      fixture.contractPath,
      '--project-root',
      fixture.projectRoot,
      '--json',
    ], {
      cwd: fixture.projectRoot,
      env: { ...process.env, MOON_RELAY_KERNEL_HOME: fixture.runtimeHome },
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, `CLI should succeed with code 0, stderr: ${result.stderr}`);
    const parsed = JSON.parse(result.stdout.trim());
    assert.equal(parsed.action?.type, 'implement', 'Should issue implement action');
    assert.notEqual(parsed.runId, 'run-stale-999', 'Fresh Run must be created rather than reusing stale run');
  } finally {
    await cleanup(fixture);
  }
});

test('Locator Wave 3: Context command executes cleanly despite stale locator', async () => {
  const fixture = await setup();
  try {
    const kernelBin = path.resolve('bin/moon-relay-kernel.mjs');
    const result = spawnSync(process.execPath, [
      kernelBin,
      'context',
      '--project-root',
      fixture.projectRoot,
      '--json',
    ], {
      cwd: fixture.projectRoot,
      env: { ...process.env, MOON_RELAY_KERNEL_HOME: fixture.runtimeHome },
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, `CLI should succeed with code 0, stderr: ${result.stderr}`);
    const parsed = JSON.parse(result.stdout.trim());
    assert.ok(parsed, 'Context payload returned');
  } finally {
    await cleanup(fixture);
  }
});

test('Locator Wave 3: Explicit --run-id pointing to stale locator candidate fails closed rather than silently minting fresh run', async () => {
  const fixture = await setup();
  try {
    const kernelBin = path.resolve('bin/moon-relay-kernel.mjs');
    const result = spawnSync(process.execPath, [
      kernelBin,
      'next',
      '--run-id',
      'run-stale-999',
      '--contract-json',
      fixture.contractPath,
      '--project-root',
      fixture.projectRoot,
      '--json',
    ], {
      cwd: fixture.projectRoot,
      env: { ...process.env, MOON_RELAY_KERNEL_HOME: fixture.runtimeHome },
      encoding: 'utf8',
    });

    assert.notEqual(result.status, 0, 'Explicit run-id to stale locator must fail closed');
    const parsed = JSON.parse(result.stdout || result.stderr);
    assert.equal(parsed.errorCode, 'runtime_binding_stale');
  } finally {
    await cleanup(fixture);
  }
});

