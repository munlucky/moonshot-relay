import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveKernelCapabilities } from '../src/kernel/capability-resolver.js';

test('kernel-commit-closeout capability is selected when gitCloseoutRequested and completionAccepted are true, decoupled from knowledgeCommitReceiptExists', () => {
  // Case 1: gitCloseoutRequested is false -> kernel-commit-closeout not selected
  const cap1 = resolveKernelCapabilities({
    gitCloseoutRequested: false,
    completionAccepted: true,
    knowledgeCommitReceiptExists: false,
  });
  const closeout1 = cap1.selected.find((c) => c.id === 'kernel-commit-closeout');
  assert.equal(closeout1, undefined);

  // Case 2: completionAccepted is false -> kernel-commit-closeout not selected
  const cap2 = resolveKernelCapabilities({
    gitCloseoutRequested: true,
    completionAccepted: false,
    knowledgeCommitReceiptExists: true,
  });
  const closeout2 = cap2.selected.find((c) => c.id === 'kernel-commit-closeout');
  assert.equal(closeout2, undefined);

  // Case 3: gitCloseoutRequested and completionAccepted true, knowledgeCommitReceiptExists false -> selected!
  const cap3 = resolveKernelCapabilities({
    gitCloseoutRequested: true,
    completionAccepted: true,
    knowledgeCommitReceiptExists: false,
  });
  const closeout3 = cap3.selected.find((c) => c.id === 'kernel-commit-closeout');
  assert.ok(closeout3);
  assert.equal(closeout3.id, 'kernel-commit-closeout');

  // Case 4: gitCloseoutRequested and completionAccepted true with knowledge omitted -> selected!
  const cap4 = resolveKernelCapabilities({
    gitCloseoutRequested: true,
    completionAccepted: true,
  });
  const closeout4 = cap4.selected.find((c) => c.id === 'kernel-commit-closeout');
  assert.ok(closeout4);
  assert.equal(closeout4.id, 'kernel-commit-closeout');
});
