import path from 'node:path';
import { isGeneratedPythonArtifact } from '../shared/payload-path.js';
import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { chmod, copyFile, cp, lstat, mkdir, readFile, readdir, realpath, rm, stat } from 'node:fs/promises';
import { buildRuntimeManifest } from './runtime-resolver.js';
import { canonicalPath } from './runtime-home.js';
import { atomicWriteText } from './durable-write.js';
import { planKernelPackage } from './package-build.js';

interface ManifestFile {
  path: string;
  checksum: string;
}

interface InstallManifest {
  schemaVersion: number;
  productId: string;
  installedAt?: string;
  targetRoot?: string;
  sourceRoot?: string;
  backupPath?: string | null;
  files: ManifestFile[];
}

interface BackupManifest {
  schemaVersion: number;
  productId: string;
  manifest?: InstallManifest | null;
  files?: ManifestFile[];
}

interface ManagedRuntimePlan {
  sourceCurrent: string;
  files: string[];
}

interface LauncherInput {
  runtimeHome?: string | null;
  entrypoint?: string | null;
  managedNodePath?: string | null;
  write?: boolean;
}

interface CommandShimInput {
  runtimeHome?: string | null;
  entrypoint?: string | null;
  nodePath?: string | null;
}

interface InstallKernelInput {
  targetRoot?: string;
  sourceRoot?: string;
  runtimeSource?: string | null;
  trackHome?: string | null;
  replaceModified?: boolean;
}

interface UninstallKernelInput {
  targetRoot?: string;
}

interface RollbackKernelInput {
  targetRoot?: string;
  backupPath?: string | null;
}

const errorCode = (error: unknown): string | null => (
  error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code || '')
    : null
);

const PRODUCT_ID = 'moon-relay-kernel';
const TRACK_CONTENT = 'schemaVersion: 1\ntrack: kernel\nproduct: moon-relay-kernel\n';

const exists = async (target: string): Promise<boolean> => {
  try { await stat(target); return true; } catch { return false; }
};
const sha256File = async (target: string): Promise<string> => createHash('sha256').update(await readFile(target)).digest('hex');
const isWithin = (root: string, target: string): boolean => target === root || target.startsWith(`${root}${path.sep}`);
const assertNoSymlinkComponents = (root: string, target: string, label = 'target path'): string => {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  if (!isWithin(resolvedRoot, resolvedTarget)) throw new Error(`Kernel installer path escapes target root: ${target}`);
  let cursor = resolvedTarget;
  while (cursor !== resolvedRoot && isWithin(resolvedRoot, cursor)) {
    try {
      if (lstatSync(cursor).isSymbolicLink()) throw new Error(`unsafe_target: symlinked ${label}: ${cursor}`);
    } catch (error: unknown) {
      if (errorCode(error) !== 'ENOENT') throw error;
    }
    cursor = path.dirname(cursor);
  }
  return resolvedTarget;
};
const assertContained = (root: string, target: string): string => {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  return assertNoSymlinkComponents(resolvedRoot, resolvedTarget);
};
const rejectSymlink = async (target: string, label: string): Promise<void> => {
  try {
    if ((await lstat(target)).isSymbolicLink()) throw new Error(`Kernel installer refuses symlinked ${label}: ${target}`);
  } catch (error: unknown) {
    if (errorCode(error) !== 'ENOENT') throw error;
  }
};
const COMMON_SYSTEM_SYMLINKS = new Set(['/tmp', '/var', '/etc']);
const safeInstallRoot = async (target: string, label = 'target directory'): Promise<string> => {
  const lexical = path.resolve(target);
  let cursor = lexical;
  while (true) {
    try {
      if ((await lstat(cursor)).isSymbolicLink() && !COMMON_SYSTEM_SYMLINKS.has(cursor.replaceAll('\\', '/'))) {
        throw new Error(`unsafe_target: symlinked ${label}: ${cursor}`);
      }
    } catch (error: unknown) {
      if (errorCode(error) !== 'ENOENT') throw error;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return canonicalPath(lexical);
};

const atomicWrite = async (target: string, content: string): Promise<void> => {
  await atomicWriteText(target, content);
};
const copyTree = async (source: string, target: string, payload = false): Promise<void> => {
  await mkdir(path.dirname(target), { recursive: true });
  await cp(source, target, { recursive: true, force: true,
    ...(payload ? { filter: (file: string) => !isGeneratedPythonArtifact(file) } : {}),
  });
};

const copyKnownFiles = async (
  sourceRoot: string,
  targetRoot: string,
  files: readonly string[],
): Promise<void> => {
  for (const rel of files) {
    const source = path.join(sourceRoot, rel);
    const target = path.join(targetRoot, rel);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(source, target);
  }
};

const collectFiles = async (root: string, rel = ''): Promise<string[]> => {
  const target = path.join(root, rel);
  if (!(await exists(target))) return [];
  const info = await stat(target);
  if (info.isFile()) return [rel.replaceAll('\\', '/')];
  const files: string[] = [];
  for (const entry of await readdir(target, { withFileTypes: true })) {
    const child = path.join(rel, entry.name);
    if (entry.isDirectory()) files.push(...await collectFiles(root, child));
    else files.push(child.replaceAll('\\', '/'));
  }
  return files;
};

const readManifest = async (manifestPath: string): Promise<InstallManifest & { manifest?: InstallManifest; files: ManifestFile[] }> => JSON.parse(await readFile(manifestPath, 'utf8')) as InstallManifest & { manifest?: InstallManifest; files: ManifestFile[] };

const nodeRelativePath = () => (process.platform === 'win32' ? 'node.exe' : path.join('bin', 'node'));
const installedPayloadRoots = (root: string): string[] => [
  path.join(root, '.moon-relay', 'kernel-payload'),
  path.join(root, 'kernel-payload'),
  root,
];
const firstExisting = async (candidates: string[]): Promise<string | null> => {
  for (const candidate of candidates) if (await exists(candidate)) return candidate;
  return null;
};
const quoteWindows = (value: unknown): string => String(value).replaceAll('%', '%%').replaceAll('"', '\\"');
const quotePosix = (value: unknown): string => `'${String(value).replaceAll("'", "'\\''")}'`;

const resolveInstalledEntrypoint = async (root: string, requested: string | null): Promise<string> => requested
  ? path.resolve(requested)
  : await firstExisting(installedPayloadRoots(root).map((candidate) => path.join(candidate, 'bin', 'moon-relay-kernel.mjs')))
    || path.join(root, '.moon-relay', 'kernel-payload', 'bin', 'moon-relay-kernel.mjs');

const resolveInstalledNode = async (root: string, requested: string | null): Promise<string> => requested
  ? path.resolve(requested)
  : await firstExisting(installedPayloadRoots(root).map((candidate) => path.join(candidate, 'runtime', 'current', nodeRelativePath())))
    || path.join(root, '.moon-relay', 'kernel-payload', 'runtime', 'current', nodeRelativePath());

export const materializeKernelMcpLauncher = async ({ runtimeHome, entrypoint = null, managedNodePath = null, write = true }: LauncherInput = {}) => {
  if (!runtimeHome) throw new Error('Kernel MCP launcher requires runtimeHome');
  const root = await safeInstallRoot(runtimeHome, 'runtime home');
  const binDir = path.join(root, 'bin');
  const cli = await resolveInstalledEntrypoint(root, entrypoint);
  const node = await resolveInstalledNode(root, managedNodePath);
  const launcherPath = path.join(binDir, process.platform === 'win32' ? 'moon-relay-kernel-mcp.cmd' : 'moon-relay-kernel-mcp');
  if (write) {
    await mkdir(binDir, { recursive: true });
    if (process.platform === 'win32') {
      await atomicWrite(launcherPath, `@echo off\r\nsetlocal\r\n"${quoteWindows(node)}" "${quoteWindows(cli)}" mcp-bridge %*\r\nexit /b %ERRORLEVEL%\r\n`);
    } else {
      await atomicWrite(launcherPath, `#!/bin/sh\nexec ${quotePosix(node)} ${quotePosix(cli)} mcp-bridge "$@"\n`);
      await chmod(launcherPath, 0o755);
    }
  }
  return { status: write ? 'installed' : 'planned', launcherPath, nodePath: node, entrypoint: cli, managedRuntime: await exists(node), written: write ? [launcherPath] : [] };
};

export const materializeKernelCommandShim = async ({ runtimeHome, entrypoint, nodePath = null }: CommandShimInput = {}) => {
  if (!runtimeHome || !entrypoint) throw new Error('Kernel command shim requires runtimeHome and entrypoint');
  const root = await safeInstallRoot(runtimeHome);
  const cli = path.resolve(entrypoint);
  const node = nodePath ? path.resolve(nodePath) : 'node';
  const binDir = path.join(root, 'bin');
  await mkdir(binDir, { recursive: true });
  const legacyHostModule = ['moon-relay-kernel', 'host.mjs'].join('-');
  const legacyHostCli = path.join(path.dirname(cli), legacyHostModule);
  const normalizeLineEndings = (value: unknown): string => String(value).replaceAll('\r\n', '\n');
  const legacyShims = process.platform === 'win32'
    ? [
      { name: 'kernel-host.cmd', content: `@echo off\r\nnode "${legacyHostCli}" %*\r\n` },
      { name: 'kernel-host.ps1', content: `& node "${legacyHostCli}" @args\r\n` },
    ]
    : [{ name: 'kernel-host', content: `#!/bin/sh\nexec node "${legacyHostCli}" "$@"\n` }];
  const retired = [];
  for (const legacy of legacyShims) {
    const target = assertContained(root, path.join(binDir, legacy.name));
    try {
      const info = await lstat(target);
      if (!info.isFile()) continue;
      const existing = await readFile(target, 'utf8');
      // Only remove the exact shim emitted by the pre-native Host installer.
      // A user-modified or foreign file remains untouched for collision safety.
      if (normalizeLineEndings(existing) !== normalizeLineEndings(legacy.content)) continue;
      await rm(target, { force: true });
      retired.push(target);
    } catch (error: unknown) {
      if (errorCode(error) !== 'ENOENT') throw error;
    }
  }
  const written = [];
  if (process.platform === 'win32') {
    for (const name of ['kernel', 'moon-relay-kernel']) {
      const cmd = path.join(binDir, `${name}.cmd`);
      const ps1 = path.join(binDir, `${name}.ps1`);
      const command = node === 'node' ? 'node' : `"${quoteWindows(node)}"`;
      await atomicWrite(cmd, `@echo off\r\n${command} "${quoteWindows(cli)}" %*\r\n`);
      await atomicWrite(ps1, `& ${command} "${quoteWindows(cli)}" @args\r\n`);
      written.push(cmd, ps1);
    }
  } else {
    for (const name of ['kernel', 'moon-relay-kernel']) {
      const shim = path.join(binDir, name);
      const command = node === 'node' ? 'node' : quotePosix(node);
      await atomicWrite(shim, `#!/bin/sh\nexec ${command} ${quotePosix(cli)} "$@"\n`);
      await chmod(shim, 0o755);
      written.push(shim);
    }
  }
  return { status: 'installed', runtimeHome: root, entrypoint: cli, nodePath: node, written, retired };
};

// Ordinary installs remain collision-protected; only an explicit closeout
// sync may replace a trusted, modified Kernel-owned projection.
export const installKernel = async ({ targetRoot = process.cwd(), sourceRoot = process.cwd(), runtimeSource = null, trackHome = null, replaceModified = false }: InstallKernelInput = {}) => {
  const root = await safeInstallRoot(targetRoot);
  const source = path.resolve(sourceRoot);
  const kernelDir = assertContained(root, path.join(root, '.moon-relay'));
  const payloadRoot = assertContained(kernelDir, path.join(kernelDir, 'kernel-payload'));
  const trackPath = path.join(kernelDir, 'track.yaml');
  const manifestPath = path.join(kernelDir, 'install-manifest.json');
  await rejectSymlink(kernelDir, 'target directory');

  if (await exists(trackPath)) {
    const current = await readFile(trackPath, 'utf8');
    const currentTrack = current.match(/^track:\s*(relay|kernel)\s*$/m)?.[1];
    if (currentTrack === 'relay') throw new Error('Kernel install refused: existing Relay marker is protected');
    if (currentTrack !== 'kernel') throw new Error('Kernel install refused: unknown existing track marker');
    if (!(await exists(manifestPath))) throw new Error('Kernel install refused: existing Kernel marker has no trusted install manifest');
  }

  const backupId = `backup-${Date.now()}`;
  const backupPath = path.join(kernelDir, 'backups', backupId);
  const snapshotRoot = path.join(backupPath, 'snapshot');
  const existingManifest = await exists(manifestPath) ? await readManifest(manifestPath) : null;
  if (existingManifest && existingManifest.productId !== PRODUCT_ID) throw new Error('Kernel install refused: manifest belongs to another product');
  let managedRuntimePlan: { sourceCurrent: string; nodeRel: string; files: string[] } | null = null;
  if (runtimeSource) {
    if (!(await exists(runtimeSource))) {
      throw new Error(`Kernel managed runtime source does not exist: ${runtimeSource}`);
    }
    const sourceRootWithCurrent = path.join(runtimeSource, 'runtime', 'current');
    const sourceCurrentCandidate = await exists(sourceRootWithCurrent)
      ? sourceRootWithCurrent
      : (await exists(path.join(runtimeSource, 'current')) ? path.join(runtimeSource, 'current') : runtimeSource);
    // Provider installers commonly expose runtime/current as a junction or
    // symlink. Kernel payloads must contain the resolved files, never that
    // provider-owned link.
    const sourceCurrent = await realpath(sourceCurrentCandidate);
    const nodeRel = process.platform === 'win32' ? 'node.exe' : path.join('bin', 'node');
    if (!(await exists(path.join(sourceCurrent, nodeRel)))) {
      throw new Error(`Kernel managed runtime is missing ${nodeRel}`);
    }
    managedRuntimePlan = {
      sourceCurrent,
      nodeRel,
      // runtime-manifest.json is generated for the installed location. Never
      // copy a provider/source manifest and then record it a second time.
      files: (await collectFiles(sourceCurrent, '')).filter((rel) => rel !== 'runtime-manifest.json'),
    };
  }

  const packagePlan = await planKernelPackage({
    sourceRoot: source,
    outputRoot: payloadRoot,
  });
  const planned = packagePlan.planned.map((item) => {
    const targetRel = path.join('kernel-payload', item.rel).replaceAll('\\', '/');
    return {
      sourcePath: item.source,
      targetRel,
      targetPath: assertContained(kernelDir, item.target),
      files: [] as string[],
    };
  });
  if (planned.length === 0) throw new Error(`Kernel payload source is empty: ${source}`);

  // A sync must also reconcile files that were owned by an older payload but
  // are no longer present in the current source tree. Keep this set limited
  // to the trusted prior manifest so unrelated files under the target remain
  // untouched.
  const desiredPaths = new Set(['track.yaml']);
  for (const item of planned) {
    item.files = (await collectFiles(item.sourcePath, '')).filter((rel) => !isGeneratedPythonArtifact(rel));
    for (const rel of item.files) {
      desiredPaths.add(path.join(item.targetRel, rel).replaceAll('\\', '/'));
    }
  }
  if (managedRuntimePlan) {
    for (const rel of managedRuntimePlan.files) {
      desiredPaths.add(path.join('kernel-payload', 'runtime', 'current', rel).replaceAll('\\', '/'));
    }
    desiredPaths.add('kernel-payload/runtime/current/runtime-manifest.json');
  }

  const existingFiles = existingManifest?.files || [];
  const collisions = [];
  for (const file of existingFiles) {
    const target = assertContained(kernelDir, path.join(kernelDir, file.path));
    await rejectSymlink(target, 'owned file');
    if (await exists(target)) {
      const actual = await sha256File(target);
      if (actual !== file.checksum && !replaceModified) {
        collisions.push({ path: file.path, reason: 'modified-owned-file', expected: file.checksum, actual });
      } else {
        const snapshot = path.join(snapshotRoot, file.path);
        await copyTree(target, snapshot);
      }
    }
  }
  if (collisions.length) return { status: 'collision', targetRoot: root, collisions };

  try {
    await mkdir(kernelDir, { recursive: true });
    await atomicWrite(trackPath, TRACK_CONTENT);
    const installed = [{ path: 'track.yaml', checksum: await sha256File(trackPath) }];
    for (const file of existingFiles) {
      if (!desiredPaths.has(file.path)) {
        await rm(assertContained(kernelDir, path.join(kernelDir, file.path)), { force: true, recursive: true });
      }
    }
    for (const item of planned) {
      await copyKnownFiles(item.sourcePath, item.targetPath, item.files);
      for (const rel of item.files) {
        const absolute = path.join(item.targetPath, rel);
        const manifestRel = path.join(item.targetRel, rel).replaceAll('\\', '/');
        installed.push({ path: manifestRel, checksum: await sha256File(absolute) });
      }
    }
    if (runtimeSource) {
      const runtimeRoot = path.join(kernelDir, 'kernel-payload', 'runtime');
      const runtimeTarget = assertContained(kernelDir, path.join(runtimeRoot, 'current'));
      const runtimePlan = managedRuntimePlan;
      if (!runtimePlan) throw new Error('Kernel managed runtime plan is unavailable');
      await copyKnownFiles(runtimePlan.sourceCurrent, runtimeTarget, runtimePlan.files);
      const nodeRel = runtimePlan.nodeRel;
      const nodeTarget = path.join(runtimeTarget, nodeRel);
      if (!(await exists(nodeTarget))) throw new Error(`Kernel managed runtime is missing ${nodeRel}`);
      const runtimeManifestPath = path.join(runtimeTarget, 'runtime-manifest.json');
      await atomicWrite(runtimeManifestPath, JSON.stringify(await buildRuntimeManifest({ runtimeHome: path.join(kernelDir, 'kernel-payload'), nodePath: nodeTarget }), null, 2));
      for (const rel of runtimePlan.files) {
        installed.push({
          path: path.join('kernel-payload', 'runtime', 'current', rel).replaceAll('\\', '/'),
          checksum: await sha256File(path.join(runtimeTarget, rel)),
        });
      }
      installed.push({
        path: 'kernel-payload/runtime/current/runtime-manifest.json',
        checksum: await sha256File(runtimeManifestPath),
      });
    }

    const manifest = {
      schemaVersion: 2,
      productId: PRODUCT_ID,
      installedAt: new Date().toISOString(),
      targetRoot: root,
      sourceRoot: source,
      backupPath: existingFiles.length ? backupPath : null,
      files: installed,
    };
    if (existingFiles.length) {
      await atomicWrite(path.join(backupPath, 'backup-manifest.json'), JSON.stringify({ schemaVersion: 1, productId: PRODUCT_ID, manifest: existingManifest, files: existingFiles }, null, 2));
    }
    await atomicWrite(manifestPath, JSON.stringify(manifest, null, 2));
    const runtimeHome = trackHome ? await safeInstallRoot(trackHome, 'track home') : null;
    const managedNodePath = runtimeSource
      ? path.join(kernelDir, 'kernel-payload', 'runtime', 'current', nodeRelativePath())
      : null;
    const commandShim = runtimeHome
      ? await materializeKernelCommandShim({
        runtimeHome,
        entrypoint: path.join(kernelDir, 'kernel-payload', 'bin', 'moon-relay-kernel.mjs'),
        nodePath: managedNodePath && await exists(managedNodePath) ? managedNodePath : null,
      })
      : null;
    const mcpLauncher = runtimeHome
      ? await materializeKernelMcpLauncher({
        runtimeHome,
        entrypoint: path.join(kernelDir, 'kernel-payload', 'bin', 'moon-relay-kernel.mjs'),
        managedNodePath,
      })
      : null;
    return { status: 'installed', targetRoot: root, installedFilesCount: installed.length, manifestPath, backupPath: existingFiles.length ? backupPath : null, commandShim, mcpLauncher };
  } catch (error) {
    await rm(path.join(kernelDir, 'kernel-payload'), { force: true, recursive: true });
    for (const file of existingFiles) {
      const snapshot = path.join(snapshotRoot, file.path);
      if (await exists(snapshot)) await copyTree(snapshot, assertContained(kernelDir, path.join(kernelDir, file.path)));
    }
    if (!existingManifest) await rm(trackPath, { force: true });
    throw error;
  }
};

export const uninstallKernel = async ({ targetRoot = process.cwd() }: UninstallKernelInput = {}) => {
  const root = await safeInstallRoot(targetRoot);
  const kernelDir = assertContained(root, path.join(root, '.moon-relay'));
  const manifestPath = path.join(kernelDir, 'install-manifest.json');
  if (!(await exists(manifestPath))) return { status: 'not_installed', targetRoot: root };
  const manifest = await readManifest(manifestPath);
  if (manifest.productId !== PRODUCT_ID) throw new Error('Kernel uninstall refused: foreign manifest');
  const conflicts = [];
  for (const file of manifest.files || []) {
    const target = assertContained(kernelDir, path.join(kernelDir, file.path));
    await rejectSymlink(target, 'owned file');
    if (await exists(target) && await sha256File(target) !== file.checksum) conflicts.push({ path: file.path, reason: 'modified-owned-file' });
  }
  if (conflicts.length) return { status: 'collision', targetRoot: root, conflicts };
  for (const file of manifest.files || []) await rm(assertContained(kernelDir, path.join(kernelDir, file.path)), { force: true, recursive: true });
  await rm(manifestPath, { force: true });
  return { status: 'uninstalled', targetRoot: root, preserved: ['Relay marker/profile/runtime outside Kernel manifest'] };
};

export const rollbackKernel = async ({ targetRoot = process.cwd(), backupPath = null }: RollbackKernelInput = {}) => {
  const root = await safeInstallRoot(targetRoot);
  if (!backupPath || !(await exists(backupPath))) return { status: 'no_backup_found', targetRoot: root };
  const backupRoot = path.resolve(backupPath);
  const snapshotRoot = path.join(backupRoot, 'snapshot');
  if (!isWithin(path.join(root, '.moon-relay'), backupRoot) || !(await exists(snapshotRoot))) throw new Error('Kernel rollback backup is outside the target root or incomplete');
  await rejectSymlink(backupRoot, 'rollback backup');
  const backupManifestPath = path.join(backupRoot, 'backup-manifest.json');
  if (!(await exists(backupManifestPath))) throw new Error('Kernel rollback backup has no manifest');
  const backupManifest = await readManifest(backupManifestPath);
  const priorManifest = backupManifest.manifest || {
    schemaVersion: 2,
    productId: PRODUCT_ID,
    files: backupManifest.files || [],
  };
  const currentManifestPath = path.join(root, '.moon-relay', 'install-manifest.json');
  if (!(await exists(currentManifestPath))) throw new Error('Kernel rollback target has no current install manifest');
  const currentManifest = await readManifest(currentManifestPath);
  const priorPaths = new Set((priorManifest.files || []).map((file) => file.path));
  const collisions = [];
  for (const file of currentManifest.files || []) {
    const target = assertContained(root, path.join(root, '.moon-relay', file.path));
    await rejectSymlink(target, 'current owned file');
    if (!(await exists(target))) collisions.push({ path: file.path, reason: 'missing-current-file' });
    else if (await sha256File(target) !== file.checksum) collisions.push({ path: file.path, reason: 'modified-current-file' });
  }
  if (collisions.length) return { status: 'collision', targetRoot: root, backupPath: backupRoot, collisions };
  for (const file of currentManifest.files || []) {
    if (!priorPaths.has(file.path)) await rm(assertContained(root, path.join(root, '.moon-relay', file.path)), { force: true, recursive: true });
  }
  const restored = [];
  for (const rel of await collectFiles(snapshotRoot, '')) {
    const source = path.join(snapshotRoot, rel);
    const target = assertContained(root, path.join(root, '.moon-relay', rel));
    await copyTree(source, target);
    restored.push(rel.replaceAll('\\', '/'));
  }
  await atomicWrite(currentManifestPath, JSON.stringify(priorManifest, null, 2));
  return { status: 'rolled_back', targetRoot: root, backupPath: backupRoot, restored, removed: (currentManifest.files || []).filter((file) => !priorPaths.has(file.path)).map((file) => file.path) };
};
