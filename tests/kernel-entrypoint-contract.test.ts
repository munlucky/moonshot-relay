import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { routeTask } from '../src/kernel/route.js';

const projectWithTrack = async (track: string) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'krn-route-'));
  await mkdir(path.join(root, '.moon-relay'), { recursive: true });
  await writeFile(path.join(root, '.moon-relay', 'track.yaml'), `schemaVersion: 1\ntrack: ${track}\nproduct: moon-relay-${track}\n`);
  return root;
};

test('wrong harness rejects routing from the project marker', async () => {
  const root = await projectWithTrack('relay');
  assert.deepEqual(routeTask({ taskClass: 'feature' }, { projectRoot: root }), { status: 'wrong_harness', requestedTrack: 'kernel', activeTrack: 'relay', route: [] });
});

test('low-risk task uses the Kernel fast path from the project marker', async () => {
  const root = await projectWithTrack('kernel');
  assert.deepEqual(routeTask({ taskClass: 'feature', behaviorChanging: false }, { projectRoot: root }).route, ['FRAME', 'EXECUTE', 'PROVE', 'CLOSE']);
});
