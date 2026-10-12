import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildKernelContextSegments, renderContextSegment, digestContextSegment,
  composeLegacyPromptBlock, SEGMENT_ORDER, normalizeContextPath,
} from '../src/host/kernel/context-segments.js';

const state = () => ({
  hostStable: { principles: [{ id: 'p1', guidance: 'Keep the change minimal.' }] },
  projectStable: { policyAnchors: [{ id: 'pa1', type: 'policy_anchor', revision: 'r1', statement: 'Core stays provider-neutral.' }] },
  runStable: { objective: 'Stabilize the prefix.', acceptance: ['Segments are deterministic.'] },
  volatile: { step: { stepId: 'step-1', objective: 'Add segments.' } },
});

test('a build returns the four segments plus a compatible prompt block', () => {
  const built = buildKernelContextSegments(state());
  assert.deepEqual(Object.keys(built.segments), SEGMENT_ORDER);
  for (const name of SEGMENT_ORDER) {
    assert.match(built.segments[name].digest, /^sha256:[a-f0-9]{64}$/);
    assert.ok(built.segments[name].tokenEstimate >= 0);
  }
  assert.equal(built.promptBlock, composeLegacyPromptBlock(built.segments));
  assert.equal(built.receipt.schemaVersion, 1);
});

test('cacheable segments precede the volatile tail', () => {
  const built = buildKernelContextSegments(state());
  const block = built.promptBlock;
  assert.ok(block.indexOf('Host Stable') < block.indexOf('Project Stable'));
  assert.ok(block.indexOf('Project Stable') < block.indexOf('Run Stable'));
  assert.ok(block.indexOf('Run Stable') < block.indexOf('Volatile'));
});

test('an unknown segment kind is refused rather than rendered empty', () => {
  assert.throws(() => Reflect.apply(renderContextSegment, undefined, ['mystery', {}]), /Unknown context segment kind/);
});

test('an empty payload renders nothing at all', () => {
  // An empty heading would still be bytes in the prefix.
  assert.equal(renderContextSegment('project-stable', {}), '');
  assert.equal(digestContextSegment(''), digestContextSegment({ content: '' }));
});

test('paths are compared in a single normalized form', () => {
  assert.equal(normalizeContextPath('scripts\\kernel\\'), 'scripts/kernel');
  assert.equal(normalizeContextPath('./scripts//kernel'), 'scripts/kernel');
});
