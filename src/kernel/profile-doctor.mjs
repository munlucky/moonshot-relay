import { inspectProfile } from './profile-install.mjs';
import path from 'node:path';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolveKernelNode } from './runtime-resolver.mjs';

export async function doctorKernelProfile({ targetRoot, runtime = null, runtimeHome = null } = {}) {
  const result = await inspectProfile(targetRoot);
  if (result.status === 'not_installed') return { status: 'not_installed', effective: 'unknown', targetRoot: result.targetRoot, recovery: 'install Kernel profile before launch' };
  const providerRuntime = result.manifest.provider || result.manifest.runtime;
  if (runtime && providerRuntime !== runtime) return { status: 'wrong_harness', effective: 'unknown', targetRoot: result.targetRoot, expectedRuntime: runtime, actualRuntime: providerRuntime };
  if (result.status !== 'ready') return { status: 'drift', effective: 'unknown', targetRoot: result.targetRoot, recovery: 'rollback or reinstall manifest-owned static files', checks: result.checks };
  const commandChecks = [];
  const requiredProfileFiles = {
    codex: result.manifest.layout === 'account-root-direct'
      ? ['AGENTS.md', 'config.toml', 'hooks.json', 'skills/moon-relay-kernel/SKILL.md']
      : ['AGENTS.override.md', '.codex/config.toml', '.codex/hooks.json', 'skills/moon-relay-kernel/SKILL.md'],
    claude: ['CLAUDE.md', 'settings.json', 'skills/moon-relay-kernel/SKILL.md'],
  };
  for (const relativePath of requiredProfileFiles[providerRuntime] || ['skills/moon-relay-kernel/SKILL.md']) {
    let present = true;
    try { await access(path.join(path.resolve(targetRoot), relativePath)); } catch { present = false; }
    commandChecks.push({ check: `profile-surface:${relativePath.replaceAll('\\', '/')}`, passed: present });
  }
  if (runtimeHome) {
    const binDir = path.join(path.resolve(runtimeHome), 'bin');
    const shim = path.join(binDir, process.platform === 'win32' ? 'kernel.cmd' : 'kernel');
    let present = true;
    let executable = true;
    try {
      await access(shim);
      if (process.platform !== 'win32') await access(shim, constants.X_OK);
    } catch (error) {
      present = error.code !== 'ENOENT';
      executable = false;
    }
    const payloadRoot = [
      path.join(runtimeHome, '.moon-relay', 'kernel-payload'),
      path.join(runtimeHome, 'kernel-payload'),
    ].find((candidate) => path.resolve(candidate));
    const nodeRuntime = await resolveKernelNode({ runtimeHome: payloadRoot, skipExecuteCheck: false });
    const direct = present && executable
      ? spawnSync(shim, ['--version', '--json'], { encoding: 'utf8', shell: process.platform === 'win32' })
      : { status: 1 };
    const throughPath = spawnSync(process.platform === 'win32' ? 'kernel.cmd' : 'kernel', ['--version', '--json'], {
      encoding: 'utf8',
      shell: process.platform === 'win32',
      env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}` },
    });
    commandChecks.push(
      { check: 'kernel-shim-present', passed: present },
      { check: 'kernel-shim-executable', passed: executable },
      { check: 'node-runtime-resolves', passed: Boolean(nodeRuntime?.nodePath) },
      { check: 'kernel-cli-starts', passed: direct.status === 0 },
      { check: 'provider-child-path-resolves', passed: throughPath.status === 0 },
    );
  }
  const commandReady = commandChecks.every((check) => check.passed);
  return {
    status: commandReady ? 'ready' : 'drift',
    effective: commandReady ? 'kernel' : 'unknown',
    targetRoot: result.targetRoot,
    runtime: providerRuntime,
    managedFileCount: result.manifest.files.length,
    checks: [...(result.checks || []), ...commandChecks],
    authContentRead: false,
    sessionContentRead: false,
  };
}
