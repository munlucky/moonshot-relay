import test from 'node:test';
import assert from 'node:assert/strict';
import { isPathStagable, filterStagingSelection } from '../scripts/kernel/git/staging-policy.js';

test('Git Index - enforces staging policy and git index integrity', async () => {
  assert.equal(isPathStagable('README.md'), true);
  assert.equal(isPathStagable('.env'), false);

  const selection = filterStagingSelection(['README.md', '.env']);
  assert.deepEqual(selection.selectedPaths, ['README.md']);
  assert.deepEqual(selection.excludedPaths, ['.env']);
});
