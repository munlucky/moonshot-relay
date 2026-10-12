import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';

interface HydrationFileEntry {
  path: string;
  checksum: string;
}

interface HydrationManifest {
  schemaVersion: number;
  productId: string;
  track: 'kernel';
  projectRoot: string;
  hydratedAt: string;
  files: HydrationFileEntry[];
}

interface CatalogEntrypoint {
  name?: unknown;
}

interface KernelCatalog {
  publicEntrypoints?: CatalogEntrypoint[];
}

interface ProjectRootInput {
  projectRoot: string;
}

interface HydrateInput extends ProjectRootInput {
  sourceRoot?: string;
  dryRun?: boolean;
}

interface NodeErrorLike extends Error {
  code?: string;
}

export const HYDRATION_PRODUCT_ID = 'moon-relay-kernel-project-hydration';
export const HYDRATION_MANIFEST_NAME = '.moon-relay/kernel-profile-manifest.json';
export const TRACK_MARKER_NAME = '.moon-relay/track.yaml';

const TRACK_CONTENT = 'schemaVersion: 1\ntrack: kernel\nproduct: moon-relay-kernel\n';

const errorCode = (error: unknown): string | null => (
  error && typeof error === 'object' && 'code' in error
    ? String((error as NodeErrorLike).code || '')
    : null
);

const exists = async (file: string): Promise<boolean> => {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
};

const sha256 = async (file: string): Promise<string> => (
  createHash('sha256').update(await readFile(file)).digest('hex')
);

const atomicWrite = async (file: string, value: string): Promise<void> => {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, value, 'utf8');
  await rename(tmp, file);
};

const copyTree = async (from: string, to: string): Promise<void> => {
  await mkdir(path.dirname(to), { recursive: true });
  await cp(from, to, { recursive: true, force: true });
};

const collectRelativeFiles = async (
  root: string,
  rel: string = '',
): Promise<string[]> => {
  const target = path.join(root, rel);
  if (!(await exists(target))) return [];
  const info = await stat(target);
  if (info.isFile()) return [rel.replaceAll('\\', '/')];

  const result: string[] = [];
  for (const entry of await readdir(target, { withFileTypes: true })) {
    result.push(...await collectRelativeFiles(root, path.join(rel, entry.name)));
  }
  return result;
};

const rejectSymlink = async (file: string): Promise<void> => {
  try {
    if ((await lstat(file)).isSymbolicLink()) {
      throw new Error(`unsafe_target: symlink ${file}`);
    }
  } catch (error: unknown) {
    if (errorCode(error) !== 'ENOENT') throw error;
  }
};

const safeJoin = (root: string, rel: string): string => {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(root, rel);
  if (
    resolved !== resolvedRoot
    && !resolved.startsWith(`${resolvedRoot}${path.sep}`)
  ) {
    throw new Error(`unsafe_target: ${rel}`);
  }
  return resolved;
};

const parseManifest = (value: string): HydrationManifest => (
  JSON.parse(value) as HydrationManifest
);

export function projectManifestPath(projectRoot: string): string {
  return path.join(path.resolve(projectRoot), HYDRATION_MANIFEST_NAME);
}

export function projectTrackPath(projectRoot: string): string {
  return path.join(path.resolve(projectRoot), TRACK_MARKER_NAME);
}

export async function checkCatalogPublicSkills(
  sourceRoot: string,
): Promise<string[]> {
  const catalogPath = path.resolve(
    sourceRoot,
    'catalog',
    'kernel-skills.json',
  );
  if (!(await exists(catalogPath))) {
    throw new Error(`catalog_missing: ${catalogPath}`);
  }

  const catalog = JSON.parse(
    await readFile(catalogPath, 'utf8'),
  ) as KernelCatalog;
  const publicNames = (catalog.publicEntrypoints || [])
    .map((entry) => String(entry.name || ''))
    .filter(Boolean);

  if (publicNames.length !== 1 || publicNames[0] !== 'moon-relay-kernel') {
    throw new Error(
      'invalid_public_catalog: expected exactly ["moon-relay-kernel"], '
      + `got ${JSON.stringify(publicNames)}`,
    );
  }
  return publicNames;
}

export async function inspectKernelProject({
  projectRoot,
}: ProjectRootInput) {
  const root = path.resolve(projectRoot);
  const trackFile = projectTrackPath(root);
  const manifestFile = projectManifestPath(root);

  if (!(await exists(trackFile)) || !(await exists(manifestFile))) {
    return { status: 'not_hydrated' as const, projectRoot: root };
  }

  const trackContent = await readFile(trackFile, 'utf8');
  const currentTrack = trackContent
    .match(/^track:\s*(relay|kernel)\s*$/m)?.[1];
  if (currentTrack !== 'kernel') {
    return {
      status: 'drift' as const,
      projectRoot: root,
      reason: 'track_mismatch',
    };
  }

  let manifest: HydrationManifest;
  try {
    manifest = parseManifest(await readFile(manifestFile, 'utf8'));
  } catch {
    return {
      status: 'drift' as const,
      projectRoot: root,
      reason: 'manifest_corrupt',
    };
  }

  if (manifest.productId !== HYDRATION_PRODUCT_ID) {
    return {
      status: 'drift' as const,
      projectRoot: root,
      reason: 'foreign_manifest',
    };
  }

  const checks: Array<{
    path: string;
    present: boolean;
    checksum: string | null;
    expected: string;
  }> = [];
  for (const entry of manifest.files || []) {
    const file = safeJoin(root, entry.path);
    const present = await exists(file);
    const checksum = present ? await sha256(file) : null;
    checks.push({
      path: entry.path,
      present,
      checksum,
      expected: entry.checksum,
    });
  }

  const allValid = checks.every(
    (item) => item.present && item.checksum === item.expected,
  );
  if (!allValid) {
    return { status: 'drift' as const, projectRoot: root, checks };
  }

  const skillsDir = path.join(root, '.agents', 'skills');
  if (await exists(skillsDir)) {
    const skillEntries = await readdir(skillsDir, { withFileTypes: true });
    const dirNames = skillEntries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    if (dirNames.length !== 1 || dirNames[0] !== 'moon-relay-kernel') {
      return {
        status: 'drift' as const,
        projectRoot: root,
        reason: 'invalid_skill_count',
        discoveredSkills: dirNames,
      };
    }
  } else {
    return {
      status: 'drift' as const,
      projectRoot: root,
      reason: 'skills_dir_missing',
    };
  }

  return {
    status: 'ready' as const,
    projectRoot: root,
    manifest,
    checks,
  };
}

export async function hydrateKernelProject({
  projectRoot,
  sourceRoot = process.cwd(),
  dryRun = false,
}: HydrateInput) {
  const root = path.resolve(projectRoot);
  const source = path.resolve(sourceRoot);

  await checkCatalogPublicSkills(source);

  const trackFile = projectTrackPath(root);
  const manifestFile = projectManifestPath(root);

  if (await exists(trackFile)) {
    const content = await readFile(trackFile, 'utf8');
    const currentTrack = content
      .match(/^track:\s*(relay|kernel)\s*$/m)?.[1];
    if (currentTrack === 'relay') {
      throw new Error(
        'target_collision: existing Relay track marker is protected',
      );
    }
  }

  await rejectSymlink(root);

  const prior = await exists(manifestFile)
    ? parseManifest(await readFile(manifestFile, 'utf8'))
    : null;
  if (prior && prior.productId !== HYDRATION_PRODUCT_ID) {
    throw new Error('target_collision: foreign hydration manifest');
  }

  if (prior) {
    for (const entry of prior.files || []) {
      const file = safeJoin(root, entry.path);
      await rejectSymlink(file);
      if (
        await exists(file)
        && await sha256(file) !== entry.checksum
      ) {
        throw new Error(
          `target_collision: modified owned file ${entry.path}`,
        );
      }
    }
  }

  const unmanagedSkillDir = path.join(
    root,
    '.agents',
    'skills',
    'moon-relay-kernel',
  );
  if (await exists(unmanagedSkillDir) && !prior) {
    throw new Error(
      'target_collision: existing unmanaged moon-relay-kernel skill',
    );
  }

  if (dryRun) {
    return { status: 'dry_run' as const, projectRoot: root };
  }

  const stagedFiles: HydrationFileEntry[] = [];

  await atomicWrite(trackFile, TRACK_CONTENT);
  stagedFiles.push({
    path: TRACK_MARKER_NAME,
    checksum: await sha256(trackFile),
  });

  const skillSource = path.join(source, 'skills', 'moon-relay-kernel');
  const skillTarget = path.join(
    root,
    '.agents',
    'skills',
    'moon-relay-kernel',
  );
  if (await exists(skillSource)) {
    await copyTree(skillSource, skillTarget);
    for (const rel of await collectRelativeFiles(skillTarget)) {
      const fullPath = safeJoin(skillTarget, rel);
      const manifestRel = path
        .join('.agents', 'skills', 'moon-relay-kernel', rel)
        .replaceAll('\\', '/');
      stagedFiles.push({
        path: manifestRel,
        checksum: await sha256(fullPath),
      });
    }
  } else {
    throw new Error(`skill_source_missing: ${skillSource}`);
  }

  const codexProfileSource = path.join(
    source,
    'package',
    'kernel',
    'profiles',
    'codex',
  );
  if (await exists(codexProfileSource)) {
    const relFiles = await collectRelativeFiles(codexProfileSource);
    for (const rel of relFiles) {
      const srcFile = path.join(codexProfileSource, rel);
      const destFile = safeJoin(root, rel);
      await copyTree(srcFile, destFile);
      stagedFiles.push({
        path: rel.replaceAll('\\', '/'),
        checksum: await sha256(destFile),
      });
    }
  } else {
    throw new Error(`profile_source_missing: ${codexProfileSource}`);
  }

  const manifest: HydrationManifest = {
    schemaVersion: 1,
    productId: HYDRATION_PRODUCT_ID,
    track: 'kernel',
    projectRoot: root,
    hydratedAt: new Date().toISOString(),
    files: stagedFiles,
  };

  await atomicWrite(
    manifestFile,
    JSON.stringify(manifest, null, 2),
  );

  return {
    status: 'hydrated' as const,
    projectRoot: root,
    manifestPath: manifestFile,
    hydratedFilesCount: stagedFiles.length,
  };
}

export async function unhydrateKernelProject({
  projectRoot,
}: ProjectRootInput) {
  const root = path.resolve(projectRoot);
  const manifestFile = projectManifestPath(root);
  const trackFile = projectTrackPath(root);

  if (!(await exists(manifestFile))) {
    return { status: 'not_hydrated' as const, projectRoot: root };
  }

  const manifest = parseManifest(await readFile(manifestFile, 'utf8'));
  if (manifest.productId !== HYDRATION_PRODUCT_ID) {
    throw new Error('wrong_harness: foreign hydration manifest');
  }

  for (const entry of manifest.files || []) {
    const file = safeJoin(root, entry.path);
    await rejectSymlink(file);
    if (
      await exists(file)
      && await sha256(file) !== entry.checksum
    ) {
      return {
        status: 'collision' as const,
        projectRoot: root,
        path: entry.path,
      };
    }
  }

  for (const entry of manifest.files || []) {
    const file = safeJoin(root, entry.path);
    await rm(file, { force: true, recursive: true });
  }

  await rm(manifestFile, { force: true });
  await rm(trackFile, { force: true });

  const skillDir = path.join(
    root,
    '.agents',
    'skills',
    'moon-relay-kernel',
  );
  await rm(skillDir, { force: true, recursive: true });

  return {
    status: 'unhydrated' as const,
    projectRoot: root,
    preserved: ['user files', 'non-manifest project assets'],
  };
}
