import path from 'node:path';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import { KERNEL_RUNTIME_ID, SURFACES } from './constants.mjs';
import { canonicalPath } from '../kernel/runtime-home.mjs';

const home = () => process.env.MOON_HARNESS_SWITCHER_HOME || path.join(process.env.USERPROFILE || os.homedir(), '.moon-harness-switcher');
export const switcherHome = () => path.resolve(home());
export const statePath = () => path.join(switcherHome(), 'state', 'state.json');
export const receiptsPath = () => path.join(switcherHome(), 'receipts');
export const journalPath = () => path.join(switcherHome(), 'state', 'journal.json');
export const shortcutRoot = () => path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Moon Harness');

const isWithin = (root, target) => {
  const resolvedRoot = canonicalPath(root);
  const resolvedTarget = canonicalPath(target);
  return resolvedTarget === resolvedRoot || resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`);
};

export const pathsOverlap = (left, right) => isWithin(left, right) || isWithin(right, left);

const providerEnvNames = Object.freeze({
  claude_desktop: 'CLAUDE_CONFIG_DIR',
  claude_cli: 'CLAUDE_CONFIG_DIR',
  codex_cli: 'CODEX_HOME',
  codex_desktop: 'CODEX_HOME',
  qwen_cli: 'QWEN_HOME',
  ade_cli: 'ADE_HOME',
  antigravity_desktop: 'ANTIGRAVITY_HOME',
});

export function resolveSurfaceRoots({ surface, sourceRoot = process.cwd(), kernelHome = process.env.MOON_RELAY_KERNEL_HOME, platform = process.platform, baseEnv = process.env } = {}) {
  if (!SURFACES.includes(surface)) throw new Error(`wrong_harness: unsupported surface ${surface}`);
  const userHome = baseEnv.USERPROFILE || baseEnv.HOME || os.homedir();
  const runtimeHome = canonicalPath(kernelHome || baseEnv.MOON_RELAY_KERNEL_HOME || path.join(userHome, '.moon-relay-kernel'));
  const defaultProvider = {
    claude_desktop: path.join(userHome, '.claude'),
    claude_cli: path.join(userHome, '.claude'),
    codex_cli: path.join(userHome, '.codex'),
    qwen_cli: path.join(userHome, '.qwen'),
    ade_cli: null,
    codex_desktop: path.join(userHome, '.codex'),
    antigravity_desktop: path.join(userHome, '.gemini', 'antigravity'),
  };
  const configuredProvider = providerEnvNames[surface] ? baseEnv[providerEnvNames[surface]] : null;
  const providerRoot = configuredProvider || defaultProvider[surface];
  if (!providerRoot) {
    const envName = providerEnvNames[surface] || 'provider home';
    throw Object.assign(new Error(`wrong_harness: ${envName} is required for ${surface}`), { code: 'wrong_harness' });
  }
  const providerHome = canonicalPath(providerRoot);
  if (pathsOverlap(runtimeHome, providerHome)) throw Object.assign(new Error(`unsafe_target: ${surface} native provider home overlaps Kernel runtime`), { code: 'unsafe_target' });
  const roots = { runtimeHome, providerHome };
  if (surface === 'codex_desktop') {
    const appDataBase = platform === 'darwin'
      ? path.join(userHome, 'Library', 'Application Support')
      : platform === 'win32'
        ? path.join(baseEnv.LOCALAPPDATA || path.join(userHome, 'AppData', 'Local'))
        : path.join(baseEnv.XDG_CONFIG_HOME || path.join(userHome, '.config'));
    roots.appDataRoot = path.join(appDataBase, 'OpenAI', 'Codex');
  }
  if (surface === 'antigravity_desktop') {
    const appDataBase = platform === 'darwin'
      ? path.join(userHome, 'Library', 'Application Support')
      : path.join(baseEnv.APPDATA || path.join(userHome, 'AppData', 'Roaming'));
    roots.appDataRoot = path.join(appDataBase, 'Antigravity');
  }
  return { ...roots, sourceRoot: path.resolve(sourceRoot), runtime: KERNEL_RUNTIME_ID, surface };
}

export async function physicalTargetIdentity(target, { protectedRoots = [] } = {}) {
  const lexical = path.resolve(target);
  const canonical = canonicalPath(target);
  let info = null;
  let symlink = false;
  try { info = await stat(lexical); symlink = (await lstat(lexical)).isSymbolicLink(); } catch { /* typed absence below */ }
  const resolved = canonical;
  const parentReparse = [];
  let cursor = lexical;
  while (cursor && cursor !== path.dirname(cursor)) {
    try {
      if ((await lstat(cursor)).isSymbolicLink() && !['/var', '/tmp', '/etc'].includes(cursor.replace(/\\/g, '/'))) {
        parentReparse.push(cursor);
      }
    } catch { /* missing parent */ }
    cursor = path.dirname(cursor);
  }
  const collision = protectedRoots.find((root) => {
    const resolvedRoot = path.resolve(root);
    return isWithin(resolvedRoot, resolved) || isWithin(resolved, resolvedRoot);
  });
  return {
    canonicalPath: resolved,
    finalResolvedPath: resolved,
    volumeId: info?.dev ?? null,
    fileId: info?.ino ?? null,
    reparseTag: symlink ? 'symlink' : null,
    parentChainReparse: parentReparse,
    ownerSid: 'unavailable',
    aclSummary: 'unavailable',
    filesystem: process.platform === 'win32' ? 'ntfs_or_windows_fs_unverified' : info ? 'posix' : 'unknown',
    exists: Boolean(info),
    safe: !symlink && parentReparse.length === 0 && !collision,
    collisionWith: collision || null,
  };
}

export async function assertSafeTarget(target, { protectedRoots = [], allowMissing = true } = {}) {
  const identity = await physicalTargetIdentity(target, { protectedRoots });
  if (!identity.safe) throw Object.assign(new Error(`unsafe_target: ${target}`), { code: 'unsafe_target', identity });
  if (!allowMissing && !identity.exists) throw Object.assign(new Error(`target_collision: missing target ${target}`), { code: 'target_collision', identity });
  return identity;
}

export const hashAllowlistedFile = async (file) => createHash('sha256').update(await readFile(file)).digest('hex');
