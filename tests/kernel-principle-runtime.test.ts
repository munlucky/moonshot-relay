import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createKernelControlPlane } from '../src/host/kernel/control-plane-runtime.js';
import { KernelPrinciplesError, loadKernelPrinciples, parseKernelPrinciplesText } from '../src/kernel/policy.js';

test('canonical principles are structured, positive, and revisioned', () => {
  const result = loadKernelPrinciples();
  assert.equal(result.revision, 'kernel-principles.v1');
  assert.equal(result.sourceRef, 'kernel/principles.yaml');
  assert.ok(/^[a-f0-9]{64}$/.test(result.sourceDigest));
  assert.equal(result.principles.length, 7);
  for (const principle of result.principles) {
    assert.ok(principle.id);
    assert.ok(principle.guidance);
    assert.ok(principle.rationale);
    assert.equal(principle.revision, 'kernel-principles.v1');
  }
});

test('Control Plane injects canonical principles by default with provenance receipt', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'krn-principles-home-'));
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'krn-principles-project-'));
  const cp = await createKernelControlPlane({ runtimeHome, projectRoot });
  await cp.startRun({ runId: 'principle-default', objective: 'verify canonical runtime injection' });

  const context = await cp.buildStageContext('principle-default', { principles: {} });
  assert.ok('promptBlock' in context && 'receipt' in context);
  assert.match(context.promptBlock, /## Stable Principles/);
  assert.ok('promptBlock' in context && 'receipt' in context);
  assert.match(context.promptBlock, /user-goal-and-verifiable-outcome-first/);
  const receipt = context.receipt.included.find((entry) => entry.id === 'stable-principles');
  assert.ok(receipt);
  assert.equal(receipt.sourceRef, 'kernel/principles.yaml');
  assert.equal(receipt.revision, 'kernel-principles.v1');
  assert.ok(receipt.sourceDigest);
  assert.ok(/^[a-f0-9]{64}$/.test(receipt.sourceDigest));

  const withExtension = await cp.buildStageContext('principle-default', {
    principleExtensions: [{ id: 'caller.test-extension', guidance: 'Keep the test seam explicit.', rationale: 'Makes extension behavior observable.' }],
  });
  assert.ok('promptBlock' in withExtension);
  assert.match(withExtension.promptBlock, /caller\.test-extension/);
  assert.ok('promptBlock' in withExtension);
  assert.match(withExtension.promptBlock, /user-goal-and-verifiable-outcome-first/);
  await assert.rejects(
    cp.buildStageContext('principle-default', { principleExtensions: [{ id: 'minimal-correct-change', guidance: 'replace', rationale: 'replace' }] }),
    (error) => error instanceof KernelPrinciplesError && error.code === 'kernel_principle_override_forbidden',
  );
  await cp.close();
});

test('empty and malformed canonical principle documents fail with typed errors', () => {
  assert.throws(() => parseKernelPrinciplesText('schemaVersion: 1\nrevision: x\nprinciples:\n'), (error) => error instanceof KernelPrinciplesError && error.code === 'kernel_principles_empty');
  assert.throws(() => parseKernelPrinciplesText('schemaVersion: 1\nrevision: x\nprinciples:\n  - id: only-id\n'), (error) => error instanceof KernelPrinciplesError && error.code === 'kernel_principles_record_invalid');
  assert.throws(() => parseKernelPrinciplesText('schemaVersion: 2\nrevision: x\nprinciples:\n  - id: x\n    guidance: g\n    rationale: r\n'), (error) => error instanceof KernelPrinciplesError && error.code === 'kernel_principles_schema_invalid');
});
