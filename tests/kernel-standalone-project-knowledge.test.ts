import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { openKernelStateStore } from '../src/kernel/state-store.js';
import { buildCodebaseIndex } from '../src/host/kernel/codebase/codebase-index.js';
import { discoverProviderSessions, readProviderSession } from '../src/host/kernel/knowledge-input/session-provider.js';
import { redactText } from '../src/kernel/knowledge-ingestion/redact.js';
import { commitImportedProjectKnowledge } from '../src/kernel/knowledge-ingestion/import.js';
import { isDeniedStagingPath, selectStagingPaths } from '../src/application/kernel-standalone/kernel-commit.js';
import { isPathStagable } from '../src/kernel/git/staging-policy.js';

test('manual knowledge import uses explicit approval without a Kernel Run and is idempotent by source digest', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-import-home-'));
  const stateStore = await openKernelStateStore({ runtimeHome });
  try {
    const sourceReceipt = { sourceType: 'codex_session', sourceIdentity: 'codex:session-1', sourceDigest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' };
    const first = await commitImportedProjectKnowledge({
      stateStore,
      projectId: 'project-import-test',
      expectedKnowledgeRevision: 1,
      candidates: [{ candidateId: 'cand-1', proposedType: 'architecture_decision', statement: 'Auth is owned by auth-service.', scope: ['src/auth/service.mjs'], status: 'staged' }],
      sourceReceipt,
      userApprovalRef: 'user-selected:cand-1',
      env: { MOON_RELAY_KERNEL_HOME: runtimeHome },
    });
    assert.equal(first.status, 'committed');
    assert.ok(first.receipt);
    assert.equal(first.receipt.authorityType, 'user_approved_import');
    assert.equal(first.receipt.knowledgeRevisionBefore, 1);
    assert.equal(first.receipt.knowledgeRevisionAfter, 2);
    assert.equal(stateStore.getProjectKnowledgeRevision('project-import-test'), 2);
    const second = await commitImportedProjectKnowledge({ stateStore, projectId: 'project-import-test', expectedKnowledgeRevision: 2, candidates: [{ candidateId: 'cand-1', proposedType: 'architecture_decision', statement: 'Auth is owned by auth-service.', scope: ['src/auth/service.mjs'] }], sourceReceipt, userApprovalRef: 'user-selected:cand-1', env: { MOON_RELAY_KERNEL_HOME: runtimeHome } });
    assert.equal(second.status, 'no_op');
    assert.ok(first.receipt);
    assert.ok(first.receipt.importId);
    const imported = stateStore.getKnowledgeImport(first.receipt.importId);
    assert.ok(imported);
    assert.equal(imported.status, 'committed');
  } finally {
    await stateStore.close();
    await rm(runtimeHome, { recursive: true, force: true });
  }
});

test('redaction removes credentials and forbidden prompt/transcript content', () => {
  assert.equal(redactText('token=abc123 secret=xyz sk-12345678901234567890'), 'token=[REDACTED] secret=[REDACTED] [REDACTED]');
});

test('Code Index writes account-root manifests and cache-hits the same tree', async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'kernel-codebase-project-'));
  const codebaseRoot = await mkdtemp(path.join(os.tmpdir(), 'kernel-codebase-index-'));
  try {
    await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({ name: 'fixture' }));
    await writeFile(path.join(projectRoot, 'app.mjs'), 'export function run() { return 1; }\n');
    const first = await buildCodebaseIndex({ projectRoot, projectId: 'codebase-test', codebaseRoot });
    assert.equal(first.status, 'completed');
    assert.equal(first.manifest.status, 'fresh');
    const second = await buildCodebaseIndex({ projectRoot, projectId: 'codebase-test', codebaseRoot });
    assert.equal(second.status, 'cache_hit');
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(codebaseRoot, { recursive: true, force: true });
  }
});

test('Host session input strips raw transcript and redacts allowed metadata before Knowledge sees it', async () => {
  const sessionRoot = await mkdtemp(path.join(os.tmpdir(), 'kernel-session-input-'));
  try {
    const sessionFile = path.join(sessionRoot, 'session-123.json');
    await writeFile(sessionFile, JSON.stringify({
      sessionId: 'session-123',
      cwd: 'C:/dev/example',
      objective: 'Investigate token=abc123 and keep the result',
      decisions: ['Use SQLite', 'Authorization: Bearer top-secret-token'],
      failures: ['secret=hunter2'],
      nextSteps: ['Run tests'],
      messages: [{ role: 'user', content: 'raw transcript body' }],
      transcript: 'raw transcript body',
      systemPrompt: 'hidden system prompt',
      developerPrompt: 'hidden developer prompt',
      toolOutput: 'sensitive tool output',
      accessToken: 'should-never-cross-boundary',
    }));

    const env = {
      ...process.env,
      MOON_RELAY_CODEX_SESSION_ROOT: sessionRoot,
    };
    const discovered = await discoverProviderSessions('codex', { env });
    assert.equal(discovered.status, 'ready');
    assert.equal(discovered.sessions.length, 1);
    assert.equal(discovered.sessions[0].nativeSessionId, 'session-123');

    const input = await readProviderSession('codex', 'session-123', {
      locator: discovered.sessions[0].locator,
      env,
    });
    assert.equal(input.nativeSessionId, 'session-123');
    assert.equal(input.objective, 'Investigate token=[REDACTED] and keep the result');
    assert.equal(input.failures[0], 'secret=[REDACTED]');
    assert.equal(input.decisions[1], 'Authorization: [REDACTED]');
    for (const forbidden of ['raw', 'parsed', 'messages', 'transcript', 'systemPrompt', 'developerPrompt', 'toolOutput', 'accessToken']) {
      assert.equal(Object.hasOwn(input, forbidden), false, `Host Knowledge input must not expose ${forbidden}`);
    }
  } finally {
    await rm(sessionRoot, { recursive: true, force: true });
  }
});

test('Kernel commit staging uses explicit paths and deny filters', () => {
  assert.equal(isDeniedStagingPath('.agents/skills/example/SKILL.md'), true);
  assert.equal(isDeniedStagingPath('src/app.mjs'), false);
  const selected = selectStagingPaths([{ status: ' M', path: 'src/app.mjs' }, { status: '??', path: '.mcp.json' }]);
  assert.deepEqual(selected.selected, ['src/app.mjs']);
  assert.equal(selected.denied[0].reason, 'deny_path');
});

test('Kernel commit deny judgement matches the shared staging policy', () => {
  // These were staged-able through the standalone path before the deny lists
  // were unified, even though the skill documents them as never staged.
  for (const denied of ['.env', '.env.local', '.codex/state/session.json', '.qwen/session.json', '.git/config', 'data/local.sqlite']) {
    assert.equal(isDeniedStagingPath(denied), true, `expected deny: ${denied}`);
    assert.equal(isPathStagable(denied), false, `shared policy must agree: ${denied}`);
  }
  for (const allowed of ['src/app.mjs', 'scripts/kernel/git/closeout.js']) {
    assert.equal(isDeniedStagingPath(allowed), false, `expected allow: ${allowed}`);
    assert.equal(isPathStagable(allowed), true, `shared policy must agree: ${allowed}`);
  }
});
