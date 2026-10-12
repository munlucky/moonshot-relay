import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveProgrammaticToolPolicy, PROGRAMMATIC_TOOL_SUITABLE, PROGRAMMATIC_TOOL_UNSUITABLE,
} from '../src/host/kernel/codex-model-policy.js';

test('programmatic tool calling starts disabled', () => {
  const policy = resolveProgrammaticToolPolicy({});
  assert.equal(policy.enabled, false);
  assert.equal(policy.reason, 'provider-unsupported');
});

test('bounded read-only aggregation is enabled only after an evaluation', () => {
  for (const workShape of PROGRAMMATIC_TOOL_SUITABLE) {
    assert.equal(resolveProgrammaticToolPolicy({ workShape, capabilityDetected: true }).reason, 'awaiting-evaluation', workShape);
    assert.equal(resolveProgrammaticToolPolicy({ workShape, capabilityDetected: true, evaluated: true }).enabled, true, workShape);
  }
});

test('mutating or judgment work is never eligible', () => {
  for (const workShape of PROGRAMMATIC_TOOL_UNSUITABLE) {
    const policy = resolveProgrammaticToolPolicy({ workShape, capabilityDetected: true, evaluated: true });
    assert.equal(policy.enabled, false, workShape);
    assert.equal(policy.reason, 'work-shape-unsuitable');
  }
});

test('an evaluated suitable shape is still refused without provider support', () => {
  const policy = resolveProgrammaticToolPolicy({ workShape: 'test-log-filtering', capabilityDetected: false, evaluated: true });
  assert.equal(policy.enabled, false);
  assert.equal(policy.reason, 'provider-unsupported');
});
