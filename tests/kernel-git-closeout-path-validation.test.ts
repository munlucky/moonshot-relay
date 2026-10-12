import test from 'node:test';
import assert from 'node:assert/strict';
import { isPathStagable, filterStagingSelection } from '../src/kernel/git/staging-policy.js';

test('staging policy filters out runtime state, dot-git, dot-env, and secret files', () => {
  assert.equal(isPathStagable('.moonshot-relay/runtime.sqlite'), false);
  assert.equal(isPathStagable('.git/config'), false);
  assert.equal(isPathStagable('.env'), false);
  assert.equal(isPathStagable('scripts/kernel/control-plane.js'), true);

  const selection = filterStagingSelection([
    'scripts/kernel/control-plane.js',
    '.moonshot-relay/runtime.sqlite',
    '.env',
  ]);
  assert.deepEqual(selection.selectedPaths, ['scripts/kernel/control-plane.js']);
  assert.equal(selection.excludedPaths.length, 2);
});
