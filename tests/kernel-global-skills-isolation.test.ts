import { loadLegacyAsyncRecordFunction, loadLegacyFunction } from './helpers/legacy-module-boundary.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
const launchSwitch = await loadLegacyAsyncRecordFunction('scripts/switcher/operations.mjs', 'launchSwitch');
const readJournal = await loadLegacyFunction('scripts/switcher/state-store.mjs', 'readJournal');
import { installKernelProfile, canonicalKernelSkillDir, KERNEL_SKILL_INSTALL_REL } from '../src/kernel/profile-install.js';

const PROFILES_ROOT = path.join('package', 'kernel', 'profiles');

const withAccountHome = async <T>(label: string, body: (home: string) => T | Promise<T>) => {
  const home = path.join(os.tmpdir(), `${label}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`);
  const original = { home: process.env.HOME, userProfile: process.env.USERPROFILE, switcher: process.env.MOON_HARNESS_SWITCHER_HOME };
  try {
    await mkdir(home, { recursive: true });
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.MOON_HARNESS_SWITCHER_HOME = path.join(home, 'switcher');
    return await body(home);
  } finally {
    for (const [key, value] of [['HOME', original.home], ['USERPROFILE', original.userProfile], ['MOON_HARNESS_SWITCHER_HOME', original.switcher]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(home, { recursive: true, force: true });
  }
};

const readyKernelRoots = async (home: string) => {
  const runtimeHome = path.join(home, 'kernel');
  const providerHome = path.join(home, 'native-claude');
  await mkdir(runtimeHome, { recursive: true });
  await writeFile(path.join(runtimeHome, 'install-manifest.json'), JSON.stringify({ productId: 'moon-relay-kernel' }), 'utf8');
  await installKernelProfile({ sourceRoot: process.cwd(), runtime: 'claude', targetRoot: providerHome });
  return { runtimeHome, providerHome };
};

test('installing a Kernel profile serves the canonical entrypoint skill from the provider home', async () => {
  const target = path.join(os.tmpdir(), `kernel-profile-skill-${Date.now()}`);
  try {
    for (const runtime of ['claude', 'codex', 'qwen', 'ade', 'antigravity']) {
      const root = path.join(target, runtime);
      const result = await installKernelProfile({ sourceRoot: process.cwd(), runtime, targetRoot: root });
      const installed = path.join(root, KERNEL_SKILL_INSTALL_REL, 'SKILL.md');
      assert.equal(
        await readFile(installed, 'utf8'),
        await readFile(path.join(canonicalKernelSkillDir(process.cwd()), 'SKILL.md'), 'utf8'),
        `${runtime} provider home must serve the canonical SKILL.md`
      );
      assert.ok(result.manifestPath);
      const owned = await readFile(result.manifestPath, 'utf8');
      assert.ok(JSON.parse(owned).files.some((entry: { path: string }) => entry.path === `${KERNEL_SKILL_INSTALL_REL}/SKILL.md`), `${runtime} manifest must own the skill`);
    }
  } finally {
    await rm(target, { recursive: true, force: true });
  }
});

test('profile-shipped copies of the entrypoint skill do not drift from the canonical source', async () => {
  const canonical = await readFile(path.join(canonicalKernelSkillDir(process.cwd()), 'SKILL.md'), 'utf8');
  for (const runtime of await readdir(PROFILES_ROOT)) {
    const shipped = path.join(PROFILES_ROOT, runtime, 'skills', 'moon-relay-kernel', 'SKILL.md');
    const content = await readFile(shipped, 'utf8').catch(() => null);
    if (content === null) continue;
    assert.equal(content, canonical, `${shipped} drifted from the canonical skill`);
  }
});

test('a Kernel launch leaves the account-root skills directory untouched', async () => {
  await withAccountHome('kernel-account-root', async (home) => {
    const accountSkills = path.join(home, '.claude', 'skills');
    await mkdir(path.join(accountSkills, 'operator-skill'), { recursive: true });
    await writeFile(path.join(accountSkills, 'operator-skill', 'SKILL.md'), '# operator owned\n', 'utf8');
    const { runtimeHome, providerHome } = await readyKernelRoots(home);

    const receipt = await launchSwitch({
      surface: 'claude_cli',
      sourceRoot: process.cwd(),
      dryRun: true,
      processProvider: async () => [],
      launchSpec: { command: 'claude', args: [], roots: { runtimeHome, providerHome }, env: {} },
    });

    assert.equal(receipt.status, 'committed');
    assert.deepEqual(await readdir(accountSkills), ['operator-skill']);
    assert.equal(await readFile(path.join(accountSkills, 'operator-skill', 'SKILL.md'), 'utf8'), '# operator owned\n');
    assert.ok(receipt && typeof receipt === 'object' && 'effective' in receipt);
    assert.ok(receipt.effective && typeof receipt.effective === 'object');
    assert.ok(receipt.effective && typeof receipt.effective === 'object' && 'discoveredSkills' in receipt.effective);
    assert.deepEqual(receipt.effective.discoveredSkills, ['moon-relay-kernel']);
  });
});

test('a Kernel launch refuses a shared mutable provider surface and leaves no journal behind', async () => {
  await withAccountHome('kernel-shared-surface', async (home) => {
    const { runtimeHome, providerHome } = await readyKernelRoots(home);
    await mkdir(path.join(providerHome, 'skills', 'moonshot-orchestrator'), { recursive: true });
    await writeFile(path.join(providerHome, 'skills', 'moonshot-orchestrator', 'SKILL.md'), '# relay skill\n', 'utf8');
    let spawned = 0;

    const receipt = await launchSwitch({
      surface: 'claude_cli',
      sourceRoot: process.cwd(),
      dryRun: false,
      processProvider: async () => [],
      spawnImpl: () => { spawned += 1; return { pid: 1234, unref() {} }; },
      launchSpec: { command: 'claude', args: [], roots: { runtimeHome, providerHome }, env: {} },
    });

    assert.equal(receipt.status, 'shared_mutable_surface');
    assert.equal(receipt.errorCode, 'shared_mutable_surface');
    assert.ok(receipt && typeof receipt === 'object' && 'effective' in receipt);
    assert.ok(receipt.effective && typeof receipt.effective === 'object');
    assert.ok(receipt.effective && typeof receipt.effective === 'object' && 'discoveredSkills' in receipt.effective);
    assert.deepEqual(receipt.effective.discoveredSkills, ['moon-relay-kernel', 'moonshot-orchestrator']);
    assert.equal(spawned, 0);
    assert.equal(await readJournal(), null);
  });
});

test('a Kernel launch refuses a provider home that does not serve the entrypoint skill', async () => {
  await withAccountHome('kernel-missing-skill', async (home) => {
    const { runtimeHome, providerHome } = await readyKernelRoots(home);
    await rm(path.join(providerHome, 'skills'), { recursive: true, force: true });

    const receipt = await launchSwitch({
      surface: 'claude_cli',
      sourceRoot: process.cwd(),
      dryRun: true,
      processProvider: async () => [],
      launchSpec: { command: 'claude', args: [], roots: { runtimeHome, providerHome }, env: {} },
    });

    assert.equal(receipt.status, 'kernel_profile_not_ready');
    assert.equal(await readJournal(), null);
  });
});
