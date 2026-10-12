import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  HIGH_ROI_OPTIMIZATION_IDS,
  OPTIMIZATION_DISPOSITIONS,
  OPTIMIZATION_ITEM_IDS,
  validateOptimizationCycle,
} from '../src/host-tooling/kernel-public/optimization-cycle.js';

test('Optimization Cycle closes every O-1 through O-20 exactly once', () => {
  const result = validateOptimizationCycle();
  assert.equal(result.status, 'pass');
  assert.equal(result.cycleStatus, 'COMPLETE');
  assert.equal(result.itemCount, 20);
  assert.deepEqual(OPTIMIZATION_DISPOSITIONS.map((item) => item.id), OPTIMIZATION_ITEM_IDS);
  assert.deepEqual(result.highRoiUnresolved, []);
  assert.equal(result.dispositionCounts.IMPLEMENTED, 0);
  assert.equal(result.dispositionCounts.REJECTED + result.dispositionCounts.DEFERRED + result.dispositionCounts.NOT_APPLICABLE, 20);
  assert.deepEqual(result.highRoiIds, HIGH_ROI_OPTIMIZATION_IDS);
});

test('IMPLEMENTED optimization dispositions require the complete evidence shape', () => {
  const invalid = OPTIMIZATION_DISPOSITIONS.map((item) => item.id === 'O-2'
    ? { ...item, disposition: 'IMPLEMENTED', baseline: '', change: '' }
    : item);
  const result = validateOptimizationCycle(invalid);
  assert.equal(result.status, 'fail');
  assert.ok(result.findings.some((finding) => finding.code === 'implemented-baseline-missing'));
  assert.ok(result.findings.some((finding) => finding.code === 'implemented-change-missing'));
});
