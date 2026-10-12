import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildKernelContext } from '../src/kernel/context-build.js';
import { KERNEL_POLICY, KernelPrinciplesError, parseContextPolicyText } from '../src/kernel/policy.js';

const fixture = (stableTokenBudget: string | number, stageTokenBudget: string | number, revision = 'fixture-policy.v1') => `schemaVersion: 1\nrevision: ${revision}\nlayers:\n  - stable-principles\n  - task-contract\n  - stage-context\n  - on-demand-references\n  - evidence-digest\nforbiddenContent:\n  - raw-runtime-log\n  - transcript\nreceiptRequired: true\nstableTokenBudget: ${stableTokenBudget}\nstageTokenBudget: ${stageTokenBudget}\n`;

test('canonical policy exposes explicit 600/1800 authority and receipt digest', () => {
  assert.equal(KERNEL_POLICY.context.stableTokenBudget, 600);
  assert.equal(KERNEL_POLICY.context.stageTokenBudget, 1800);
  assert.equal(KERNEL_POLICY.context.revision, 'kernel-context-policy.v1');
  const context = buildKernelContext({ stage: 'EXECUTE', principles: [], taskContract: { objective: 'policy' } });
  assert.equal(context.receipt.policyRevision, 'kernel-context-policy.v1');
  assert.match(context.receipt.policyDigest, /^[a-f0-9]{64}$/);
});

test('fixture budget mutation changes truncation behavior without compiler edits', () => {
  const narrow = parseContextPolicyText(fixture(40, 50, 'fixture-narrow.v1'));
  const broad = parseContextPolicyText(fixture(120, 500, 'fixture-broad.v1'));
  const input = {
    stage: 'EXECUTE',
    principles: ['stable '.repeat(100)],
    taskContract: { objective: 'x' },
    stageRecords: [{ id: 'stage', type: 'stage-context', content: 'stage '.repeat(100), revision: '1' }],
  };
  const narrowContext = buildKernelContext({ ...input, contextPolicy: narrow });
  const broadContext = buildKernelContext({ ...input, contextPolicy: broad });
  assert.notEqual(narrowContext.receipt.tokenEstimate, broadContext.receipt.tokenEstimate);
  assert.equal(narrowContext.receipt.policyRevision, 'fixture-narrow.v1');
  assert.equal(broadContext.receipt.policyRevision, 'fixture-broad.v1');
});

test('fixture forbidden-content mutation changes omission authority', () => {
  const policy = parseContextPolicyText(`${fixture(600, 1800)}forbiddenContent:\n  - custom-secret-record\n`);
  const context = buildKernelContext({ stage: 'EXECUTE', principles: [], contextPolicy: policy, stageRecords: [{ id: 'custom', type: 'custom-secret-record', content: 'must omit', revision: '1' }] });
  assert.doesNotMatch(context.promptBlock, /must omit/);
  assert.deepEqual(context.receipt.omitted, [{ id: 'custom', reason: 'forbidden-type' }]);
});

test('invalid, missing, negative, and non-integer policy values fail closed', () => {
  assert.throws(() => parseContextPolicyText(fixture('', 1800)), (error) => error instanceof KernelPrinciplesError && error.code === 'kernel_context_policy_budget_invalid');
  assert.throws(() => parseContextPolicyText(fixture(-1, 1800)), (error) => error instanceof KernelPrinciplesError && error.code === 'kernel_context_policy_budget_invalid');
  assert.throws(() => parseContextPolicyText(fixture('1.5', 1800)), (error) => error instanceof KernelPrinciplesError && error.code === 'kernel_context_policy_budget_invalid');
  assert.throws(() => parseContextPolicyText(fixture(600, 500)), (error) => error instanceof KernelPrinciplesError && error.code === 'kernel_context_policy_budget_invalid');
  assert.throws(() => parseContextPolicyText('schemaVersion: 1\nrevision: x\nlayers:\n  - task-contract\nforbiddenContent:\n  - transcript\nreceiptRequired: true\nstableTokenBudget: 600\n'), (error) => error instanceof KernelPrinciplesError && error.code === 'kernel_context_policy_budget_invalid');
  assert.throws(() => parseContextPolicyText(fixture(600, 1800).replace('revision: fixture-policy.v1\n', '')), (error) => error instanceof KernelPrinciplesError && error.code === 'kernel_context_policy_revision_missing');
});
