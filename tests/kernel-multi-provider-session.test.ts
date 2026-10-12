import { assertTestPresent, assertTestRecord } from './helpers/assert-value.js';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createKernelControlPlane } from '../src/host/kernel/control-plane-runtime.js';
import { normalizeSessionBinding } from '../src/kernel/run/session-binding.js';
import { resolveKernelWorktreeIdentity } from '../src/host/kernel/workspace/worktree-resolution.js';
import { registerWorktreeObservation } from '../src/kernel/run/workspace-registration.js';
import { openKernelStateStore } from '../src/kernel/state-store.js';

const makeWorkspace = async ({ prefix, projectId }: { prefix: string; projectId: string }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
  await mkdir(path.join(root, '.moon-relay'), { recursive: true });
  await writeFile(path.join(root, '.moon-relay', 'project.identity.yaml'), `projectId: ${projectId}\n`);
  await writeFile(path.join(root, 'package.json'), JSON.stringify({
    name: projectId,
    version: '0.0.1',
    scripts: { test: 'node -e "process.exit(0)"' },
  }));
  return root;
};

const runGit = (cwd: string, args: string[]) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
};

const registerCurrentWorktree = (store: TestStateStore, { projectRoot, runtimeHome }: { projectRoot: string; runtimeHome: string }) => {
  const resolved = resolveKernelWorktreeIdentity({
    cwd: projectRoot,
    env: { ...process.env, MOON_RELAY_KERNEL_HOME: runtimeHome },
  });
  return {
    ...resolved,
    ...registerWorktreeObservation({
      stateStore: store,
      workspace: resolved.workspaceObservation,
      projectId: resolved.projectId,
    }),
  };
};

const providerScopedIdentitySpec = async () => {
  const {
    canonicalizeHostSessionId,
    createHostSessionId,
  } = await import('../src/contracts/host-session.js');
  const codex = createHostSessionId({ provider: 'codex', nativeSessionId: 'session-1' });
  const claude = createHostSessionId({ provider: 'claude', nativeSessionId: 'session-1' });

  assert.equal(codex, 'codex:session-1');
  assert.equal(claude, 'claude:session-1');
  assert.notEqual(codex, claude);
  assert.equal(
    canonicalizeHostSessionId({ provider: 'codex', sessionId: codex }),
    codex,
  );
};
test('host session identity namespaces equal native IDs by provider without double-prefixing', providerScopedIdentitySpec);

const opaqueRunIdentitySpec = async () => {
  const { createOpaqueRunId } = await import('../src/kernel/run/run-identity.js');
  const first = createOpaqueRunId();
  const second = createOpaqueRunId();

  assert.match(first, /^run-[0-9a-f-]{36}$/i);
  assert.match(second, /^run-[0-9a-f-]{36}$/i);
  assert.notEqual(first, second);
  assert.doesNotMatch(first, /session-1|codex|claude/i);
};
test('Run identity is opaque, unique, and independent of host session identity', opaqueRunIdentitySpec);

const multiProviderOwnershipSpec = async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-provider-state-'));
  const projectId = 'kernel-provider-shared-project';
  const codexRoot = await makeWorkspace({ prefix: 'kernel-provider-codex', projectId });
  const claudeParent = await mkdtemp(path.join(os.tmpdir(), 'kernel-provider-claude-parent-'));
  const claudeRoot = path.join(claudeParent, 'worktree');
  const nativeSessionId = 'session-1';
  const codexRunId = 'run-codex-provider';
  const claudeRunId = 'run-claude-provider';
  try {
    runGit(codexRoot, ['init']);
    runGit(codexRoot, ['config', 'user.email', 'kernel-test@example.invalid']);
    runGit(codexRoot, ['config', 'user.name', 'Kernel Test']);
    runGit(codexRoot, ['add', '.']);
    runGit(codexRoot, ['commit', '-m', 'provider worktree fixture']);
    runGit(codexRoot, ['worktree', 'add', claudeRoot, 'HEAD']);

    const codex = await createKernelControlPlane({
      runtimeHome,
      projectRoot: codexRoot,
      requireHostBinding: true,
      env: {
        MOON_RELAY_KERNEL_SESSION_ID: nativeSessionId,
        MOON_RELAY_KERNEL_PROVIDER: 'codex',
        MOON_RELAY_KERNEL_RUN_ID: codexRunId,
      },
    });
    try {
      await codex.ensureRun({
        runId: codexRunId,
        objective: 'Codex work',
        taskContract: { acceptance: ['Codex Run is isolated'] },
      });
    } finally {
      await codex.close();
    }

    const claude = await createKernelControlPlane({
      runtimeHome,
      projectRoot: claudeRoot,
      requireHostBinding: true,
      env: {
        MOON_RELAY_KERNEL_SESSION_ID: nativeSessionId,
        MOON_RELAY_KERNEL_PROVIDER: 'claude',
        MOON_RELAY_KERNEL_RUN_ID: claudeRunId,
      },
    });
    try {
      const created = await claude.ensureRun({
        runId: claudeRunId,
        objective: 'Claude work',
        taskContract: { acceptance: ['Claude Run is isolated'] },
      });
      assert.equal(created.status, 'created');
      assert.equal(assertTestPresent(created.run).runId, claudeRunId);
    } finally {
      await claude.close();
    }
  } finally {
    if (existsSync(claudeRoot)) runGit(codexRoot, ['worktree', 'remove', '--force', claudeRoot]);
    await rm(codexRoot, { recursive: true, force: true });
    await rm(claudeParent, { recursive: true, force: true });
    await rm(runtimeHome, { recursive: true, force: true });
  }
};
test('Codex and Claude sessions with the same native ID own independent Runs in one project', multiProviderOwnershipSpec);

const legacyProviderCollisionSpec = async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-provider-legacy-'));
  const projectId = 'kernel-provider-legacy-project';
  const projectRoot = await makeWorkspace({ prefix: 'kernel-provider-legacy', projectId });
  try {
    const legacy = await openKernelStateStore({ runtimeHome });
    try {
      const worktree = registerCurrentWorktree(legacy, { projectRoot, runtimeHome });
      legacy.createRun({
        runId: 'codex-legacy-run',
        objective: 'legacy Codex work',
        sourceIdentity: `sha256:${'d'.repeat(64)}`,
        projectId,
        worktreeId: worktree.worktreeId,
        workspaceId: worktree.workspaceId,
      });
      legacy.createSessionBinding(normalizeSessionBinding({
        bindingId: 'binding-legacy-codex',
        sessionId: 'shared-native-session',
        provider: 'codex',
        runId: 'codex-legacy-run',
        projectId,
        workspaceId: worktree.workspaceId,
        accessMode: 'owner',
      }));
    } finally {
      legacy.close();
    }

    const claude = await createKernelControlPlane({
      runtimeHome,
      projectRoot,
      requireHostBinding: true,
      env: {
        MOON_RELAY_KERNEL_SESSION_ID: 'claude:shared-native-session',
        MOON_RELAY_KERNEL_LEGACY_SESSION_ID: 'shared-native-session',
        MOON_RELAY_KERNEL_PROVIDER: 'claude',
      },
    });
    try {
      await assert.rejects(
        claude.resolveRunId(),
        (error) => assertTestRecord(error).code === 'provider_session_invalid',
      );
    } finally {
      await claude.close();
    }
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(runtimeHome, { recursive: true, force: true });
  }
};
test('legacy fallback validates the stored provider and rejects a cross-provider native-session collision', legacyProviderCollisionSpec);

test('matching legacy provider ownership migrates once to the canonical session ID', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-provider-migrate-'));
  const projectId = 'kernel-provider-migrate-project';
  const projectRoot = await makeWorkspace({ prefix: 'kernel-provider-migrate', projectId });
  try {
    const store = await openKernelStateStore({ runtimeHome });
    try {
      const worktree = registerCurrentWorktree(store, { projectRoot, runtimeHome });
      store.createRun({
        runId: 'codex-legacy-run',
        objective: 'legacy Codex work',
        sourceIdentity: `sha256:${'e'.repeat(64)}`,
        projectId,
        worktreeId: worktree.worktreeId,
        workspaceId: worktree.workspaceId,
      });
      store.createSessionBinding(normalizeSessionBinding({
        bindingId: 'binding-legacy-codex',
        sessionId: 'shared-native-session',
        provider: 'codex',
        runId: 'codex-legacy-run',
        projectId,
        workspaceId: worktree.workspaceId,
        accessMode: 'owner',
      }));
    } finally {
      store.close();
    }

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const codex = await createKernelControlPlane({
        runtimeHome,
        projectRoot,
        requireHostBinding: true,
        env: {
          MOON_RELAY_KERNEL_SESSION_ID: 'codex:shared-native-session',
          MOON_RELAY_KERNEL_LEGACY_SESSION_ID: 'shared-native-session',
          MOON_RELAY_KERNEL_PROVIDER: 'codex',
        },
      });
      try {
        assert.equal(await codex.resolveRunId(), 'codex-legacy-run');
      } finally {
        await codex.close();
      }
    }

    const migrated = await openKernelStateStore({ runtimeHome });
    try {
      assert.equal(
        assertTestPresent(migrated.getActiveOwnerBinding({
          projectId,
          sessionId: 'codex:shared-native-session',
        })).bindingId,
        'binding-legacy-codex',
      );
      assert.equal(
        migrated.getActiveOwnerBinding({
          projectId,
          sessionId: 'shared-native-session',
        }),
        null,
      );
    } finally {
      migrated.close();
    }
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(runtimeHome, { recursive: true, force: true });
  }
});

test('legacy codex-* ownership with unknown provider is inferred only for Codex', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-provider-unknown-codex-'));
  const projectId = 'kernel-provider-unknown-codex-project';
  const projectRoot = await makeWorkspace({ prefix: 'kernel-provider-unknown-codex', projectId });
  const nativeSessionId = 'legacy-thread-id';
  try {
    const store = await openKernelStateStore({ runtimeHome });
    try {
      const worktree = registerCurrentWorktree(store, { projectRoot, runtimeHome });
      store.createRun({
        runId: `codex-${nativeSessionId}`,
        objective: 'legacy Codex work',
        sourceIdentity: `sha256:${'f'.repeat(64)}`,
        projectId,
        worktreeId: worktree.worktreeId,
        workspaceId: worktree.workspaceId,
      });
      store.createSessionBinding(normalizeSessionBinding({
        bindingId: 'binding-unknown-codex',
        sessionId: nativeSessionId,
        provider: 'unknown',
        runId: `codex-${nativeSessionId}`,
        projectId,
        workspaceId: worktree.workspaceId,
        accessMode: 'owner',
      }));
    } finally {
      store.close();
    }

    const codex = await createKernelControlPlane({
      runtimeHome,
      projectRoot,
      requireHostBinding: true,
      env: {
        MOON_RELAY_KERNEL_SESSION_ID: `codex:${nativeSessionId}`,
        MOON_RELAY_KERNEL_LEGACY_SESSION_ID: nativeSessionId,
        MOON_RELAY_KERNEL_PROVIDER: 'codex',
      },
    });
    try {
      assert.equal(await codex.resolveRunId(), `codex-${nativeSessionId}`);
    } finally {
      await codex.close();
    }
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(runtimeHome, { recursive: true, force: true });
  }
});

type TestControlPlane = Awaited<ReturnType<typeof import('../src/host/kernel/control-plane-runtime.js').createKernelControlPlane>>;
type TestStateStore = Awaited<ReturnType<typeof import('../src/kernel/state-store.js').openKernelStateStore>>;
