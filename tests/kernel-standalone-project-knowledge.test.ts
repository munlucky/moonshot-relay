import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import { zstdCompressSync } from 'node:zlib';
import { openKernelStateStore } from '../src/kernel/state-store.js';
import { buildCodebaseIndex } from '../src/host/kernel/codebase/codebase-index.js';
import { discoverProviderSessions, readProviderSession } from '../src/host/kernel/knowledge-input/session-provider.js';
import { redactText } from '../src/kernel/knowledge-ingestion/redact.js';
import { commitImportedProjectKnowledge } from '../src/kernel/knowledge-ingestion/import.js';
import { isDeniedStagingPath, selectStagingPaths } from '../src/application/kernel-standalone/kernel-commit.js';
import { isPathStagable } from '../src/kernel/git/staging-policy.js';

test('Standalone project-memory CLI keeps its DB open through asynchronous status, indexing and review', async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'standalone-memory-cli-'));
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'standalone-memory-home-'));
  const cli = path.resolve('bin/moon-relay-standalone.mjs');
  const run = (...args: string[]) => {
    const result = spawnSync(process.execPath, [cli, '--utility', 'project-memory', ...args, '--json'], {
      cwd: projectRoot,
      encoding: 'utf8',
      env: { ...process.env, MOON_RELAY_KERNEL_HOME: runtimeHome, MOON_RELAY_TRACK: 'kernel' },
    });
    assert.equal(result.status, 0, result.stdout || result.stderr);
    return JSON.parse(result.stdout) as Record<string, unknown>;
  };
  try {
    await mkdir(path.join(projectRoot, 'src'));
    await writeFile(path.join(projectRoot, 'src/math.mjs'), 'export function add(left, right) { return left + right; }\n');
    const empty = run('status');
    assert.equal(empty.status, 'ready');
    const indexed = run('codebase');
    assert.equal(indexed.status, 'analyzed');
    assert.equal(typeof indexed.sourceFile, 'string');
    const review = run('review', '--source-file', String(indexed.sourceFile));
    assert.equal(review.status, 'awaiting_review');
    const status = run('status');
    assert.equal(status.status, 'ready');
    assert.ok(Array.isArray(status.imports) && status.imports.length === 1);
    assert.equal(status.knowledgeRevision, empty.knowledgeRevision, 'indexing and review must not commit Knowledge');
    const denied = spawnSync(process.execPath, [cli, '--utility', 'project-memory', 'import', '--source-file', String(indexed.sourceFile), '--json'], {
      cwd: projectRoot, encoding: 'utf8',
      env: { ...process.env, MOON_RELAY_KERNEL_HOME: runtimeHome, MOON_RELAY_TRACK: 'kernel' },
    });
    assert.equal(denied.status, 1);
    assert.match(denied.stdout, /USER_APPROVAL_REQUIRED/);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(runtimeHome, { recursive: true, force: true });
  }
});

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


test('Codex native JSONL/Zstandard sessions are discovered newest-first and retain safe metadata', async () => {
  const sessionRoot = await mkdtemp(path.join(os.tmpdir(), 'codex-native-session-'));
  const env = { ...process.env, MOON_RELAY_CODEX_SESSION_ROOT: sessionRoot };
  try {
    const nested = path.join(sessionRoot, '2026', '11', '25');
    await mkdir(nested, { recursive: true });
    const sessionId = '01a1aa6e-426a-7663-8098-367fa22b225a';
    const compressedPath = path.join(nested, `rollout-2026-11-25T00-00-00-${sessionId}.jsonl.zst`);
    const events = [
      { type: 'session_meta', payload: { id: sessionId, timestamp: '2026-11-25T00:00:00Z', cwd: '/projects/native-app' } },
      { type: 'turn_context', payload: { cwd: '/projects/native-app' } },
      { type: 'response_item', payload: { type: 'message', content: 'private transcript must not cross Knowledge boundary' } },
    ];
    const compressed = zstdCompressSync(Buffer.from(events.map((event) => JSON.stringify(event)).join('\n') + '\n'));
    await writeFile(compressedPath, compressed);

    // The old 500-file traversal cap could hide recent sessions behind unrelated files.
    for (let index = 0; index < 502; index += 1) {
      await writeFile(path.join(sessionRoot, `old-${index}.json`), JSON.stringify({
        sessionId: `old-${index}`, cwd: '/projects/other',
      }));
    }
    const future = new Date('2030-01-01T00:00:00Z');
    await utimes(compressedPath, future, future);
    const discovered = await discoverProviderSessions('codex', { env, limit: 600 });
    assert.equal(discovered.sessions.length, 503);
    assert.equal(discovered.sessions[0].nativeSessionId, sessionId);
    assert.equal(discovered.sessions[0].workingDirectory, '/projects/native-app');

    const input = await readProviderSession('codex', sessionId, { env });
    assert.equal(input.workingDirectory, '/projects/native-app');
    assert.equal(input.sourceDigest, discovered.sessions[0].sourceDigest);
    assert.match(input.sourceDigest, /^sha256:[a-f0-9]{64}$/);
    assert.equal(input.objective, null);
    assert.equal(JSON.stringify(input).includes('private transcript'), false);

    const filtered = await discoverProviderSessions('codex', {
      env, since: '2029-01-01T00:00:00Z', limit: 600,
    });
    assert.equal(filtered.sessions.length, 1);
    assert.equal(filtered.sessions[0].nativeSessionId, sessionId);

    const corruptFile = path.join(nested, 'broken.jsonl.zst');
    await writeFile(corruptFile, 'invalid-zstandard-payload');
    await assert.rejects(readProviderSession('codex', 'broken', { locator: corruptFile, env }));
  } finally {
    await rm(sessionRoot, { recursive: true, force: true });
  }
});
