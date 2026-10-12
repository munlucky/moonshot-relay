import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, readFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openKernelStateStore } from '../src/kernel/state-store.js';

test('existing Relay DB is not read or modified by Kernel store', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'krn-nomig-'));
  const relay = path.join(root, '.moonshot-relay');
  const kernel = path.join(root, '.moon-relay-kernel');
  await mkdir(path.join(relay, 'state'), { recursive: true });
  const f = path.join(relay, 'state', 'runtime-state.sqlite');
  await writeFile(f, 'relay-sentinel');

  const s = await openKernelStateStore({ runtimeHome: kernel, relayHome: relay });
  s.createRun({ runId: 'r', objective: 'x', sourceIdentity: 'src-1' });
  s.close();

  assert.equal(await readFile(f, 'utf8'), 'relay-sentinel');
});
