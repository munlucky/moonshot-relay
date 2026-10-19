import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { installKernel, uninstallKernel } from '../src/kernel/installer.js';
import { createKernelControlPlane } from '../src/host/kernel/control-plane-runtime.js';
import { resolveKernelProjectIdentity } from '../src/kernel/project-identity.js';

const unavailableFields = ['providerModelIdentity', 'actualInputTokens', 'actualOutputTokens', 'falseCompletionDecision', 'wallClockMs', 'modelRouting'] as const;
const observedFields = ['retryCount', 'replanCount', 'userInterventionCount', 'hardEvidenceCoverage', 'promptTokenBudget'] as const;
const workflowEfficiencyNumericFields = [
  'transitions', 'modelTurns', 'proofExecutions', 'proofReuses', 'reviewExecutions',
  'frameMs', 'executeMs', 'proveMs', 'closeMs',
] as const;
const workflowEfficiencyNullableFields = [
  'proofWallMs', 'reviewWallMs', 'lockWaitMs', 'nextPayloadBytes', 'promptFootprint',
] as const;
const workflowEfficiencyFields = [...workflowEfficiencyNumericFields, ...workflowEfficiencyNullableFields] as const;

test('measurement schema is closed and status exposes typed unavailable fields', async () => {
  const schema = JSON.parse(await readFile(new URL('../schemas/kernel.measurement.schema.json', import.meta.url), 'utf8'));
  assert.equal(schema.properties.schemaVersion.const, 2);
  assert.equal(schema.additionalProperties, false);
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'krn-measurement-home-'));
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'krn-measurement-project-'));
  const cp = await createKernelControlPlane({ runtimeHome, projectRoot });
  await cp.startRun({ runId: 'measurement-status', objective: 'measurement contract' });
  const status = await cp.status('measurement-status');
  assert.ok(status && 'measurement' in status);
  assert.equal(status.measurement.schemaVersion, 2);
  assert.equal(status.measurement.harnessIdentity, 'moon-relay-kernel');
  assert.match(status.measurement.sourceIdentity, /^[a-zA-Z0-9_.:/-]+$/);
  assert.ok(status.measurement.estimatedStaticTokens > 0);
  for (const field of unavailableFields) {
    assert.equal(status.measurement[field].status, 'unavailable', field);
    assert.ok(status.measurement[field].reason, field);
  }
  for (const field of observedFields) {
    assert.equal(status.measurement[field].status, 'observed', field);
  }
  assert.equal(status.measurement.retryCount.value, 0);
  assert.equal(status.measurement.userInterventionCount.value, 0);
  assert.equal(status.measurement.contaminationSignals.status, 'observed');
  assert.equal(status.measurement.workflowEfficiency.status, 'observed');
  assert.deepEqual(Object.keys(status.measurement.workflowEfficiency.value).sort(), [...workflowEfficiencyFields].sort());
  for (const field of workflowEfficiencyNumericFields) {
    assert.equal(typeof status.measurement.workflowEfficiency.value[field], 'number', field);
    assert.ok(Number.isInteger(status.measurement.workflowEfficiency.value[field]), field);
  }
  for (const field of workflowEfficiencyNullableFields) {
    assert.equal(status.measurement.workflowEfficiency.value[field], null, field);
  }
  await cp.close();
});

test('disposable installed CLI exposes schema-shaped context receipt and measurement', async () => {
  const targetRoot = await mkdtemp(path.join(os.tmpdir(), 'krn-measurement-installed-'));
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'krn-measurement-installed-home-'));
  await installKernel({ targetRoot, sourceRoot: process.cwd() });
  const cli = path.join(targetRoot, '.moon-relay', 'kernel-payload', 'bin', 'moon-relay-kernel.mjs');
  const projectId = resolveKernelProjectIdentity({ cwd: targetRoot }).projectId;
  const contractPath = path.join(targetRoot, 'measurement-contract.json');
  await writeFile(contractPath, JSON.stringify({ objective: 'installed measurement', acceptance: ['measurement is exposed'] }));
  const env = {
    ...process.env,
    MOON_RELAY_KERNEL_HOME: runtimeHome,
    MOON_RELAY_KERNEL_RUN_ID: 'installed-measurement',
    MOON_RELAY_KERNEL_PROJECT_ID: projectId,
    MOON_RELAY_KERNEL_SESSION_ID: 'installed-measurement-session',
    CODEX_THREAD_ID: '',
  };
  const run = spawnSync(process.execPath, [cli, 'next', '--project-root', targetRoot, '--contract-json', contractPath, '--json'], { env, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const context = spawnSync(process.execPath, [cli, 'context', '--project-root', targetRoot, '--run-id', 'installed-measurement', '--json'], { env, encoding: 'utf8' });
  assert.equal(context.status, 0, context.stderr);
  const contextResult = JSON.parse(context.stdout);
  assert.match(contextResult.promptBlock, /## Stable Principles/);
  assert.ok(contextResult.receipt.included.some((entry: { id: string }) => entry.id === 'capability-decision-installed-measurement'));
  const status = spawnSync(process.execPath, [cli, 'status', '--project-root', targetRoot, '--run-id', 'installed-measurement', '--json'], { env, encoding: 'utf8' });
  assert.equal(status.status, 0, status.stderr);
  const statusResult = JSON.parse(status.stdout);
  assert.equal(statusResult.measurement.harnessIdentity, 'moon-relay-kernel');
  assert.equal(statusResult.measurement.actualInputTokens.status, 'unavailable');
  const uninstall = await uninstallKernel({ targetRoot });
  assert.equal(uninstall.status, 'uninstalled');
});
