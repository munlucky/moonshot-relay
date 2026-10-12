// Runtime parallel dispatch is a Host concern; the model still receives only
// the existing next/report model surface.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dispatchKernelParallel, dispatchKernelRun, hostSupportsParallel } from '../src/host/kernel/parallel-dispatcher.js';

test('Host dispatcher exports the existing run dispatch entry without legacy aliases', () => {
  assert.equal(typeof dispatchKernelParallel, 'function');
  assert.equal(typeof dispatchKernelRun, 'function');
  assert.equal(Object.hasOwn({ dispatchKernelParallel, dispatchKernelRun }, 'dispatchKernelWave'), false);
  assert.equal(hostSupportsParallel({
    supportsConcurrentSessions: true,
    supportsIsolatedWorkingDirectory: true,
    supportsPerSessionEnvironment: true,
  }), true);
});
