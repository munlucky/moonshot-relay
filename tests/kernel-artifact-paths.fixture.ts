import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { resolveRunArtifactPaths } from '../src/kernel/artifact-paths.js';

test('artifact resolver isolates writable artifacts by project and run', () => {
  const a = resolveRunArtifactPaths({ runtimeHome: 'C:\\kernel', projectId: 'project-a', runId: 'run-1' });
  const b = resolveRunArtifactPaths({ runtimeHome: 'C:\\kernel', projectId: 'project-b', runId: 'run-1' });
  assert.notEqual(a.root, b.root);
  for (const key of ['projections', 'evidence', 'receipts', 'finalization'] as const) {
    assert.ok(a[key].startsWith(`${a.root}${path.sep}`));
  }
});

test('artifact resolver prevents Windows alias collisions while retaining exact identities', () => {
  const upper = resolveRunArtifactPaths({ runtimeHome: 'C:\\kernel', projectId: 'Project', runId: 'Run.' });
  const lower = resolveRunArtifactPaths({ runtimeHome: 'C:\\kernel', projectId: 'project', runId: 'run' });
  assert.notEqual(upper.root.toLowerCase(), lower.root.toLowerCase());
  assert.deepEqual(upper.identity.projectId, 'Project');
  assert.deepEqual(upper.identity.runId, 'Run.');
});
