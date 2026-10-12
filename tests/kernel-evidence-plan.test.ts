import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { assertEvidencePlans, normalizeAcceptance, acceptanceStatements, MissingEvidencePlanError } from '../src/kernel/task/evidence-plan.js';
import { applyEvidencePlans, normalizeTaskContract } from '../src/kernel/task/task-contract.js';
import { createKernelControlPlane } from '../src/host/kernel/control-plane-runtime.js';

test('resubmitting an identical evidence plan does not create a contract revision', () => {
  const contract = normalizeTaskContract({ acceptance: ['works'] }, { objective: 'x' });
  const first = applyEvidencePlans(contract, [{
    acceptanceId: 'AC-1',
    evidencePlan: { class: 'hard', method: 'unit-test', commandRefs: ['test:ok'], obligationId: 'unit-test' },
  }]);
  assert.ok(first);
  assert.equal(applyEvidencePlans(first, [{
    acceptanceId: 'AC-1',
    evidencePlan: { class: 'hard', method: 'unit-test', commandRefs: ['test:ok'], obligationId: 'unit-test' },
  }]), null);
  assert.ok(applyEvidencePlans(first, [{
    acceptanceId: 'AC-1',
    evidencePlan: { class: 'hard', method: 'unit-test', commandRefs: ['test:other'], obligationId: 'unit-test' },
  }]));
});

test('plain-string acceptance is allowed and normalized to statements', () => {
  const items = normalizeAcceptance(['returns 401', 'keeps 423']);
  assert.equal(items.every((i) => i.structured === false), true);
  assert.deepEqual(acceptanceStatements(['returns 401', 'keeps 423']), ['returns 401', 'keeps 423']);
  assert.doesNotThrow(() => assertEvidencePlans(['returns 401']));
});

test('structured acceptance may omit an optional evidence plan', () => {
  assert.doesNotThrow(
    () => assertEvidencePlans([{ acceptance: 'be readable' }]),
  );
  assert.throws(
    () => assertEvidencePlans([{ acceptance: 'x', evidencePlan: { class: 'bogus' } }]),
    MissingEvidencePlanError,
  );
  assert.doesNotThrow(
    () => assertEvidencePlans([{ acceptance: 'locked -> 423', evidencePlan: { class: 'hard', method: 'integration-test', commandRef: 'test:auth' } }]),
  );
});

test('startRun accepts unplanned acceptance and preserves explicit plan validation', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'krn-ep-home-'));
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'krn-ep-proj-'));
  spawnSync('git', ['init'], { cwd: projectRoot, encoding: 'utf8' });
  await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({
    name: 'x',
    scripts: { 'test:auth': 'node -e "process.exit(0)"' },
  }));
  const cp = await createKernelControlPlane({ runtimeHome, projectRoot });
  try {
    const unplanned = await cp.startRun({ runId: 'r-ep', objective: 'x', taskContract: { acceptance: [{ acceptance: 'improve readability' }] } });
    assert.equal(unplanned.acceptanceCriteria[0], 'improve readability');
    await cp.abandon('r-ep', { reason: 'test_fixture' });
    // Structured acceptance with a plan is accepted and coverage uses the statement.
    const run = await cp.startRun({ runId: 'r-ep-ok', objective: 'x', taskContract: { acceptance: [{ acceptance: 'invalid password returns 401', evidencePlan: { class: 'hard', commandRef: 'test:auth' } }] } });
    assert.deepEqual(run.acceptanceCriteria, ['invalid password returns 401']);
  } finally {
    await cp.close();
    await rm(runtimeHome, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('next proceeds directly to implementation for plain acceptance', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'krn-ep-next-home-'));
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'krn-ep-next-proj-'));
  spawnSync('git', ['init'], { cwd: projectRoot, encoding: 'utf8' });
  await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({ name: 'x', scripts: { 'test:ok': 'node -e "process.exit(0)"' } }));
  const cp = await createKernelControlPlane({ runtimeHome, projectRoot });
  try {
    await cp.startRun({ runId: 'r-ep-next', objective: 'x', taskContract: { acceptance: ['works'] } });
    const next = await cp.next('r-ep-next');
    assert.ok('action' in next && next.action && 'acceptancePlans' in next && next.acceptancePlans);
    assert.equal(next.action.type, 'implement');
    assert.equal(Object.hasOwn(next.action, 'evidencePlansRequired'), false);
    assert.equal(next.acceptancePlans[0].id, 'AC-1');
    assert.equal(next.acceptancePlans[0].evidencePlan, null);
  } finally {
    await cp.close();
    await rm(runtimeHome, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  }
});
