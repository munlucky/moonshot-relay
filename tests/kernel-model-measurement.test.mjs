import { decideTestModelRoute } from './helpers/kernel-host-test-api.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createKernelControlPlane } from '../scripts/kernel/control-plane.mjs';
import { hashSessionId } from '../scripts/kernel/run/model-route-contract.mjs';

const withRun = async (fn) => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'krn-meas-home-'));
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'krn-meas-proj-'));
  spawnSync('git', ['init'], { cwd: projectRoot, encoding: 'utf8' });
  await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({ name: 'x', scripts: { test: 'node -e "process.exit(0)"', lint: 'node -e "process.exit(0)"' } }));
  const cp = await createKernelControlPlane({ runtimeHome, projectRoot });
  try {
    await cp.startRun({ runId: 'r-meas', objective: 'measurement' });
    return await fn(cp, 'r-meas');
  } finally {
    await cp.close();
    await rm(runtimeHome, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  }
};

const fileReceipt = async (cp, runId, actionKind, session, extra = {}) => {
  const decision = await decideTestModelRoute(cp, runId, { actionKind, obligationId: 'default' });
  if (decision.modelClass === 'kernel') return decision;
  await cp.recordModelUsage(runId, {
    decisionId: decision.decisionId,
    runId,
    hostSurface: 'claude',
    actorSessionId: hashSessionId(session),
    resolvedModel: `model-for-${decision.modelClass}`,
    enforcementStatus: 'enforced',
    resultStatus: 'completed',
    ...extra,
  });
  return decision;
};

test('measurement moves provider identity and tokens from unavailable to observed', async () => {
  await withRun(async (cp, runId) => {
    const before = await cp.status(runId);
    assert.equal(before.measurement.providerModelIdentity.status, 'unavailable');
    assert.equal(before.measurement.modelRouting.status, 'unavailable');

    await fileReceipt(cp, runId, 'plan', 'planner', { inputTokens: 4000, cachedInputTokens: 3000, outputTokens: 800, wallClockMs: 30000 });
    await fileReceipt(cp, runId, 'implement', 'implementer', { inputTokens: 9000, outputTokens: 2200, wallClockMs: 90000 });

    const after = await cp.status(runId);
    assert.equal(after.measurement.providerModelIdentity.status, 'observed');
    assert.deepEqual(after.measurement.providerModelIdentity.value.models.sort(), ['model-for-frontier_reasoning', 'model-for-value_coding']);
    assert.equal(after.measurement.actualInputTokens.value.total, 13000);
    assert.equal(after.measurement.actualInputTokens.value.cached, 3000);
    assert.equal(after.measurement.actualOutputTokens.value.total, 3000);
    assert.equal(after.measurement.wallClockMs.value.modelTurnsTotalMs, 120000);

    const routing = after.measurement.modelRouting.value;
    assert.equal(routing.totalTurns, 2);
    assert.equal(routing.frontierTurns, 1);
    assert.equal(routing.valueTurns, 1);
    assert.equal(routing.enforcedTurns, 2);
    assert.equal(routing.receiptCoverage.receipts, routing.receiptCoverage.providerTurns);
  });
});

test('a Host that reports no tokens leaves the token measurement unavailable', async () => {
  await withRun(async (cp, runId) => {
    await fileReceipt(cp, runId, 'implement', 'implementer');
    const status = await cp.status(runId);
    assert.equal(status.measurement.actualInputTokens.status, 'unavailable');
    assert.equal(status.measurement.actualOutputTokens.status, 'unavailable');
    assert.equal(status.measurement.wallClockMs.status, 'unavailable');
    // Provider identity is still observable even when usage counts are not.
    assert.equal(status.measurement.providerModelIdentity.status, 'observed');
    assert.equal(status.measurement.modelRouting.value.tokens.input, null);
  });
});

test('kernel-owned actions are counted but never demand a provider model', async () => {
  await withRun(async (cp, runId) => {
    await fileReceipt(cp, runId, 'prove', 'kernel');
    const status = await cp.status(runId);
    assert.equal(status.measurement.modelRouting.value.kernelOnlyActions, 1);
    assert.equal(status.measurement.modelRouting.value.receiptCoverage.providerTurns, 0);
    assert.equal(status.measurement.providerModelIdentity.status, 'unavailable');
  });
});

test('the measurement payload matches the published schema fields', async () => {
  const schema = JSON.parse(await readFile(new URL('../schemas/kernel.measurement.schema.json', import.meta.url), 'utf8'));
  await withRun(async (cp, runId) => {
    await fileReceipt(cp, runId, 'implement', 'implementer', { inputTokens: 10, outputTokens: 2 });
    const { measurement } = await cp.status(runId);
    for (const field of schema.required) assert.ok(field in measurement, `missing ${field}`);
    for (const field of Object.keys(measurement)) assert.ok(schema.properties[field], `schema is missing ${field}`);
    assert.equal(measurement.schemaVersion, 2);
  });
});
