import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createKernelControlPlane } from '../src/host/kernel/control-plane-runtime.js';
import { KernelContextRecordError, buildKernelContext } from '../src/kernel/context-build.js';

const digest = 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

test('Control Plane wires five context layers and persisted evidence lineage', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'krn-context-home-'));
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'krn-context-project-'));
  const objective = 'wire runtime context layers';
  const cp = await createKernelControlPlane({ runtimeHome, projectRoot });
  await cp.startRun({ runId: 'context-layers', objective, taskContract: { acceptanceCriteria: ['receipt'] } });
  await cp.transition('context-layers', 'EXECUTE');
  await cp.transition('context-layers', 'PROVE');
  await cp.recordProof('context-layers', {
    obligationId: 'unit-test', status: 'passed', evidenceRef: 'evidence://context/1',
    command: 'node --test context', evidenceDigest: digest,
  });

  const context = await cp.buildStageContext('context-layers', {
    stage: 'PROVE',
    references: [{ id: 'ref-1', type: 'reference', content: 'trusted source summary', revision: 'ref-v1', sourceRef: 'docs://source/1', trust: 'verified-reference' }],
    stageRecords: [{ id: 'stage-extra', type: 'stage-context', content: 'slice state', revision: 'slice-v1', sourceRef: 'slice://1', trust: 'persisted-slice' }],
  });
  assert.ok('promptBlock' in context && 'receipt' in context);
  assert.match(context.promptBlock, /## Stable Principles/);
  assert.ok('promptBlock' in context && 'receipt' in context);
  assert.match(context.promptBlock, /## Task Contract/);
  assert.ok('promptBlock' in context && 'receipt' in context);
  assert.match(context.promptBlock, /## Stage Context/);
  assert.ok('promptBlock' in context && 'receipt' in context);
  assert.match(context.promptBlock, /## On-demand References/);
  assert.ok('promptBlock' in context && 'receipt' in context);
  assert.match(context.promptBlock, /## Evidence Digest/);
  const ids = new Set(context.receipt.included.map((entry) => entry.id));
  assert.ok(ids.has('stable-principles'));
  assert.ok(ids.has('task-contract'));
  assert.ok(ids.has('stage-context-layers'));
  assert.ok(ids.has('stage-extra'));
  assert.ok(ids.has('ref-1'));
  assert.ok(ids.has('verification-unit-test'));
  const ref = context.receipt.included.find((entry) => entry.id === 'ref-1');
  assert.ok(ref);
  assert.deepEqual({ sourceRef: ref.sourceRef, revision: ref.revision }, { sourceRef: 'docs://source/1', revision: 'ref-v1' });
  const evidence = context.receipt.included.find((entry) => entry.id === 'verification-unit-test');
  assert.ok(evidence);
  assert.equal(evidence.sourceRef, 'evidence://context/1');
  assert.equal(evidence.trust, 'persisted-verification');
  await cp.close();
});

test('forbidden records are omitted and invalid raw records fail closed', () => {
  const context = buildKernelContext({
    stage: 'EXECUTE',
    principles: ['p'.repeat(3000)],
    stageRecords: [
      { id: 'raw-1', type: 'raw-runtime-log', content: 'secret token=do-not-show', revision: '1' },
      { id: 'safe-1', type: 'stage-context', content: 'safe', revision: '1' },
    ],
  });
  assert.doesNotMatch(context.promptBlock, /do-not-show/);
  assert.ok(context.receipt.omitted.some((entry) => entry.id === 'raw-1' && entry.reason === 'forbidden-type'));
  assert.ok('promptBlock' in context && 'receipt' in context);
  assert.match(context.promptBlock, /safe/);
  assert.throws(() => buildKernelContext({ stage: 'EXECUTE', principles: [], references: ['raw string'] }), (error) => error instanceof KernelContextRecordError && error.code === 'kernel_context_record_invalid');
});

test('receipt included records match retained prompt after budget truncation', () => {
  const context = buildKernelContext({
    stage: 'EXECUTE',
    principles: ['p'.repeat(3000)],
    taskContract: { objective: 'x' },
    stageRecords: Array.from({ length: 20 }, (_, index) => ({ id: `stage-${index}`, type: 'stage-context', content: 'x'.repeat(700), revision: '1' })),
    references: [{ id: 'ref-late', type: 'reference', content: 'late reference '.repeat(500), revision: '1', sourceRef: 'docs://late' }],
    evidence: [{ id: 'ev-late', type: 'evidence-digest', content: 'late evidence '.repeat(500), revision: '1', sourceRef: 'evidence://late' }],
  });
  const receiptIds = context.receipt.included.map((entry) => entry.id);
  const omittedIds = new Set(context.receipt.omitted.map((entry) => entry.id));
  assert.ok(omittedIds.has('ref-late'));
  assert.ok(omittedIds.has('ev-late'));
  assert.ok(!receiptIds.includes('ref-late'));
  assert.ok(!receiptIds.includes('ev-late'));
  assert.ok(context.receipt.omitted.some((entry) => entry.reason === 'context-budget'));
});
