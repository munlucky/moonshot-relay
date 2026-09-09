import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { canonicalPath } from '../scripts/kernel/runtime-home.mjs';
import { resolveCodexDesktop } from '../scripts/switcher/app-resolver/codex.mjs';
import { resolveAntigravity } from '../scripts/switcher/app-resolver/antigravity.mjs';
import { buildCodexDesktopLaunch, verifyCodexChild } from '../scripts/switcher/providers/codex.mjs';
import { buildAntigravityLaunch, verifyAntigravityChild } from '../scripts/switcher/providers/antigravity.mjs';
import { providerParityMatrix } from '../scripts/switcher/providers/matrix.mjs';
import { buildProcessEnvironment } from '../scripts/switcher/launch-adapter.mjs';
import { resolveSurfaceRoots } from '../scripts/switcher/paths.mjs';
test('Kernel launch exports the Kernel home without rewriting Provider homes', () => {
  const runtimeHome = path.join(os.tmpdir(), 'kernel-env');
  const providerHome = path.join(os.homedir(), '.claude');
  const env = buildProcessEnvironment({
    surface: 'claude_cli',
    roots: { runtimeHome, providerHome },
    baseEnv: { CLAUDE_CONFIG_DIR: providerHome },
  });
  assert.equal(env.MOON_RELAY_KERNEL_HOME, canonicalPath(runtimeHome));
  assert.equal(env.CLAUDE_CONFIG_DIR, providerHome);
  assert.equal(env.MOON_RELAY_KERNEL_RUNTIME, 'moon-relay-kernel');
});
test('Codex launch uses the native user Provider HOME and Kernel runtime metadata', () => {
  const roots = { runtimeHome: path.join(os.tmpdir(), 'kernel'), providerHome: path.join(os.homedir(), '.codex'), appDataRoot: path.join(os.tmpdir(), 'codex-app') };
  const spec = buildCodexDesktopLaunch({ roots, executable: 'ChatGPT.exe' });
  assert.equal(spec.env.CODEX_HOME, roots.providerHome); assert.equal(spec.args.includes(roots.appDataRoot), false);
  assert.equal(verifyCodexChild({ expectedProviderHome: roots.providerHome, childEnvironment: spec.env, childExecutable: 'ChatGPT.exe', expectedExecutable: 'ChatGPT.exe' }).status, 'verified');
  assert.equal(spec.env.MOON_RELAY_KERNEL_HOME, canonicalPath(roots.runtimeHome));
});
test('Antigravity launch uses the native Gemini HOME and user data dir', () => {
  const roots = { runtimeHome: path.join(os.tmpdir(), 'kernel'), providerHome: path.join(os.homedir(), '.gemini', 'antigravity'), appDataRoot: path.join(os.tmpdir(), 'ag-app') };
  const spec = buildAntigravityLaunch({ roots, executable: 'Antigravity.exe' });
  assert.equal(spec.env.GEMINI_HOME, roots.providerHome); assert.equal(verifyAntigravityChild({ expectedProviderHome: roots.providerHome, childEnvironment: spec.env, childArgs: spec.args, expectedAppDataRoot: roots.appDataRoot }).status, 'verified');
  assert.equal(spec.env.MOON_RELAY_KERNEL_HOME, canonicalPath(roots.runtimeHome));
});
test('provider parity matrix keeps all native surfaces disjoint from Kernel state', () => {
  const result = providerParityMatrix({
    kernelHome: path.join(os.tmpdir(), 'kernel'),
    baseEnv: { ...process.env, ADE_HOME: path.join(os.tmpdir(), 'ade-provider-home') },
  });
  assert.equal(result.status, 'passed'); assert.equal(result.rows.length, 7); assert.ok(result.rows.every((row) => row.sensitiveContentRead === false));
});
test('Codex Desktop uses the native macOS Application Support root', () => {
  const kernelHome = path.join(os.tmpdir(), 'kernel-macos');
  const roots = resolveSurfaceRoots({ surface: 'codex_desktop', kernelHome, platform: 'darwin' });
  assert.match(roots.appDataRoot, /Library[\\/]Application Support[\\/]OpenAI[\\/]Codex$/);
  assert.equal(roots.runtime, 'moon-relay-kernel');
});
test('phase 04/05 application resolvers do not hard-code a versioned WindowsApps path', async () => {
  const codex = await resolveCodexDesktop({ candidates: [], commandResolver: async () => null, windowsAppsResolver: async () => null });
  const anti = await resolveAntigravity({ candidates: [], commandResolver: async () => null });
  assert.doesNotMatch(JSON.stringify(codex), /OpenAI\.Codex_\d/); assert.doesNotMatch(JSON.stringify(anti), /Antigravity_\d/);
});
test('phase 04 Codex resolver derives packaged shell activation metadata from the installed path', async () => {
  const root = await fsTempRoot();
  const executable = path.join(root, 'WindowsApps', 'OpenAI.Codex_26.715.9757.0_x64__2p2nqsd0c76g0', 'app', 'ChatGPT.exe');
  await mkdir(path.dirname(executable), { recursive: true }); await writeFile(executable, 'fixture');
  const result = await resolveCodexDesktop({ candidates: [executable], commandResolver: async () => null });
  assert.equal(result.launchKind, 'packaged_shell_activation');
  assert.equal(result.aumid, 'OpenAI.Codex_2p2nqsd0c76g0!App');
  assert.equal(result.packageFamily, 'OpenAI.Codex_2p2nqsd0c76g0');
});
test('Codex resolver discovers the newest versioned WindowsApps install after an app update', async () => {
  const root = await fsTempRoot();
  const windowsAppsRoot = path.join(root, 'WindowsApps');
  const oldExecutable = path.join(windowsAppsRoot, 'OpenAI.Codex_26.700.1.0_x64__publisher', 'app', 'ChatGPT.exe');
  const newExecutable = path.join(windowsAppsRoot, 'OpenAI.Codex_26.715.9757.0_x64__publisher', 'app', 'ChatGPT.exe');
  await mkdir(path.dirname(oldExecutable), { recursive: true }); await mkdir(path.dirname(newExecutable), { recursive: true });
  await writeFile(oldExecutable, 'old'); await writeFile(newExecutable, 'new');
  const result = await resolveCodexDesktop({ candidates: [], platform: 'win32', windowsAppsRoot, commandResolver: async () => null });
  assert.equal(result.executable, newExecutable);
  assert.equal(result.launchKind, 'packaged_shell_activation');
});
test('Codex resolver discovers a macOS app bundle without a version-pinned path', async () => {
  const root = await fsTempRoot();
  const executable = path.join(root, 'Codex.app', 'Contents', 'MacOS', 'Codex');
  await mkdir(path.dirname(executable), { recursive: true }); await writeFile(executable, 'fixture');
  const result = await resolveCodexDesktop({ candidates: [], platform: 'darwin', macOsAppRoots: [root], windowsAppsResolver: async () => null, commandResolver: async () => null });
  assert.equal(result.executable, executable);
  assert.equal(result.launchKind, 'macos_app_bundle');
  assert.equal(result.appDataRootMode, 'process_argument');
});
async function fsTempRoot() { return await mkdtemp(path.join(os.tmpdir(), 'codex-resolver-')); }
