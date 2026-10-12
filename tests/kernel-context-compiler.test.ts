import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildKernelContext } from '../src/kernel/context-build.js';

test('same context input produces deterministic receipt', () => {
  const input = {
    stage: 'EXECUTE',
    principles: ['minimal'],
    taskContract: { objective: 'x' },
    stageRecords: [{ id: 'code-1', type: 'code', content: 'const x=1', revision: 'abc' }],
    policyRevision: 'p1',
  };
  const a = buildKernelContext(input);
  const b = buildKernelContext(input);
  assert.equal(a.receipt.digest, b.receipt.digest);
  assert.equal(a.receipt.receiptId, b.receipt.receiptId);
  assert.ok(a.receipt.included.some((i) => i.id === 'task-contract'));
  assert.ok(a.receipt.included.some((i) => i.id === 'stable-principles'));
});

test('changing Task Contract alters receipt digest', () => {
  const baseInput = {
    stage: 'EXECUTE',
    principles: ['minimal'],
    taskContract: { objective: 'enable writes' },
    policyRevision: 'p1',
  };

  const modifiedInput = {
    ...baseInput,
    taskContract: { objective: 'disable writes' },
  };

  const rBase = buildKernelContext(baseInput);
  const rMod = buildKernelContext(modifiedInput);

  assert.notEqual(rBase.receipt.digest, rMod.receipt.digest);
  assert.notEqual(rBase.receipt.receiptId, rMod.receipt.receiptId);
});

test('changing Principles alters receipt digest', () => {
  const baseInput = {
    stage: 'EXECUTE',
    principles: ['minimal'],
    taskContract: { objective: 'x' },
    policyRevision: 'p1',
  };

  const modifiedInput = {
    ...baseInput,
    principles: ['strict'],
  };

  const rBase = buildKernelContext(baseInput);
  const rMod = buildKernelContext(modifiedInput);

  assert.notEqual(rBase.receipt.digest, rMod.receipt.digest);
  assert.notEqual(rBase.receipt.receiptId, rMod.receipt.receiptId);
});

test('changing content with same id and revision produces distinct digest', () => {
  const baseInput = {
    stage: 'EXECUTE',
    principles: ['minimal'],
    taskContract: { objective: 'x' },
    stageRecords: [{ id: 'code-1', type: 'code', content: 'allow=true', revision: 'abc' }],
    policyRevision: 'p1',
  };

  const modifiedContentInput = {
    ...baseInput,
    stageRecords: [{ id: 'code-1', type: 'code', content: 'allow=false', revision: 'abc' }],
  };

  const rBase = buildKernelContext(baseInput);
  const rContent = buildKernelContext(modifiedContentInput);

  assert.notEqual(rBase.receipt.digest, rContent.receipt.digest);
  assert.notEqual(rBase.receipt.receiptId, rContent.receipt.receiptId);
});

test('principles pass through text secret sanitization', () => {
  const input = {
    stage: 'EXECUTE',
    principles: ['token=secret12345'],
  };
  const ctx = buildKernelContext(input);
  assert.doesNotMatch(ctx.promptBlock, /secret12345/);
  assert.match(ctx.promptBlock, /\[REDACTED\]/);
});
