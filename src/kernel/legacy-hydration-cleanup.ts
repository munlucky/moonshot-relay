import path from 'node:path';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath, rm, rmdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import {
  HYDRATION_MANIFEST_NAME,
  HYDRATION_PRODUCT_ID,
} from './project-hydrate.js';

interface HydrationManifestEntry {
  path: string;
  checksum: string;
}

interface HydrationManifest {
  productId?: string;
  files?: HydrationManifestEntry[];
}

interface CleanupRecord {
  path: string;
  reason?: string;
}

export interface CleanupLegacyKernelHydrationInput {
  projectRoot: string;
  profileReady?: boolean;
}

export interface LegacyHydrationCleanupResult {
  schemaVersion: 1;
  status: 'blocked' | 'not_hydrated' | 'collision' | 'cleaned';
  reason?: string;
  projectRoot: string;
  removed?: string[];
  preserved?: CleanupRecord[];
  conflicts?: CleanupRecord[];
  receipt?: {
    productId: string;
    createdAt: string;
    removedCount: number;
    conflictCount: number;
  };
}

const exists = async (file: string): Promise<boolean> => {
  try {
    await lstat(file);
    return true;
  } catch {
    return false;
  }
};

const sha256 = async (file: string): Promise<string> => (
  createHash('sha256').update(await readFile(file)).digest('hex')
);

const safeJoin = (root: string, relativePath: string): string => {
  const base = path.resolve(root);
  const target = path.resolve(base, relativePath);
  if (target !== base && !target.startsWith(`${base}${path.sep}`)) {
    throw new Error(`unsafe_target: ${relativePath}`);
  }
  return target;
};

const assertPhysicalContainment = async (
  root: string,
  target: string,
): Promise<void> => {
  const physicalRoot = await realpath(root);
  const relative = path.relative(path.resolve(root), target);
  let cursor = path.resolve(root);
  for (const part of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    const info = await lstat(cursor);
    if (info.isSymbolicLink()) throw new Error('link_or_reparse_component');
  }
  const physicalTarget = await realpath(target);
  if (
    physicalTarget !== physicalRoot
    && !physicalTarget.startsWith(`${physicalRoot}${path.sep}`)
  ) {
    throw new Error('physical_path_escape');
  }
  const targetInfo = await lstat(target);
  if (!targetInfo.isFile()) throw new Error('not_regular_file');
};

const isTracked = (root: string, relativePath: string): boolean => (
  spawnSync(
    'git',
    ['ls-files', '--error-unmatch', '--', relativePath],
    { cwd: root, stdio: 'ignore' },
  ).status === 0
);

export async function cleanupLegacyKernelHydration({
  projectRoot,
  profileReady = false,
}: CleanupLegacyKernelHydrationInput): Promise<LegacyHydrationCleanupResult> {
  const root = path.resolve(projectRoot);
  if (!profileReady) {
    return {
      schemaVersion: 1,
      status: 'blocked',
      reason: 'account_profile_not_ready',
      projectRoot: root,
    };
  }

  const manifestPath = safeJoin(root, HYDRATION_MANIFEST_NAME);
  if (!(await exists(manifestPath))) {
    return {
      schemaVersion: 1,
      status: 'not_hydrated',
      projectRoot: root,
      removed: [],
      preserved: [],
      conflicts: [],
    };
  }

  try {
    await assertPhysicalContainment(root, manifestPath);
  } catch {
    return {
      schemaVersion: 1,
      status: 'collision',
      projectRoot: root,
      removed: [],
      preserved: [],
      conflicts: [{
        path: HYDRATION_MANIFEST_NAME,
        reason: 'link_or_path_escape',
      }],
    };
  }

  let manifest: HydrationManifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as HydrationManifest;
  } catch {
    return {
      schemaVersion: 1,
      status: 'collision',
      projectRoot: root,
      removed: [],
      preserved: [],
      conflicts: [{
        path: HYDRATION_MANIFEST_NAME,
        reason: 'manifest_corrupt',
      }],
    };
  }

  if (manifest.productId !== HYDRATION_PRODUCT_ID) {
    return {
      schemaVersion: 1,
      status: 'collision',
      projectRoot: root,
      removed: [],
      preserved: [],
      conflicts: [{
        path: HYDRATION_MANIFEST_NAME,
        reason: 'foreign_manifest',
      }],
    };
  }

  const removed: string[] = [];
  const preserved: CleanupRecord[] = [];
  const conflicts: CleanupRecord[] = [];
  for (const entry of manifest.files || []) {
    const relativePath = String(entry.path).replaceAll('\\', '/');
    const file = safeJoin(root, relativePath);
    if (!(await exists(file))) continue;

    try {
      await assertPhysicalContainment(root, file);
    } catch {
      const conflict = { path: relativePath, reason: 'link_or_path_escape' };
      preserved.push(conflict);
      conflicts.push(conflict);
      continue;
    }

    if (isTracked(root, relativePath)) {
      preserved.push({ path: relativePath, reason: 'tracked' });
      continue;
    }

    if (await sha256(file) !== entry.checksum) {
      const conflict = { path: relativePath, reason: 'checksum_mismatch' };
      preserved.push({ path: relativePath, reason: 'modified' });
      conflicts.push(conflict);
      continue;
    }

    await rm(file, { force: true });
    removed.push(relativePath);
  }

  if (conflicts.length === 0) {
    await rm(manifestPath, { force: true });
    removed.push(HYDRATION_MANIFEST_NAME);
  } else {
    preserved.push({
      path: HYDRATION_MANIFEST_NAME,
      reason: 'cleanup_conflicts',
    });
  }

  const directories = [
    '.agents/skills/moon-relay-kernel',
    '.agents/skills',
    '.agents',
    '.codex',
    '.moon-relay',
  ];
  for (const relativePath of directories) {
    try {
      await rmdir(safeJoin(root, relativePath));
    } catch {
      // Only empty legacy directories are removed.
    }
  }

  return {
    schemaVersion: 1,
    status: conflicts.length > 0 ? 'collision' : 'cleaned',
    projectRoot: root,
    removed,
    preserved,
    conflicts,
    receipt: {
      productId: 'moon-relay-kernel-legacy-cleanup',
      createdAt: new Date().toISOString(),
      removedCount: removed.length,
      conflictCount: conflicts.length,
    },
  };
}
