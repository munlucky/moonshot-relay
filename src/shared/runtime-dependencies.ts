import { requiredIndex } from './required-index.js';
import path from 'node:path';
import { readFile, realpath, stat } from 'node:fs/promises';

interface PackageManifest {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

export interface RuntimeDependencyEntry {
  name: string;
  sourcePath: string;
  relativePath: string;
}

const exists = async (target: string): Promise<boolean> => {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
};

const normalizeRelative = (value: string): string => value.replaceAll('\\', '/');

const isWithin = (root: string, target: string): boolean => {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
};

const readPackageManifest = async (packageJsonPath: string): Promise<PackageManifest> => (
  JSON.parse(await readFile(packageJsonPath, 'utf8')) as PackageManifest
);

const resolveDependencyPackage = async ({
  sourceRoot,
  parentDirectory,
  dependencyName,
  optional,
}: {
  sourceRoot: string;
  parentDirectory: string;
  dependencyName: string;
  optional: boolean;
}): Promise<string | null> => {
  let cursor = path.resolve(parentDirectory);
  const resolvedRoot = path.resolve(sourceRoot);

  while (isWithin(resolvedRoot, cursor)) {
    const candidate = path.join(cursor, 'node_modules', dependencyName, 'package.json');
    if (await exists(candidate)) {
      const packageDirectory = path.dirname(candidate);
      const [realRoot, realPackageDirectory] = await Promise.all([
        realpath(resolvedRoot),
        realpath(packageDirectory),
      ]);
      if (!isWithin(realRoot, realPackageDirectory)) {
        throw new Error(
          `Runtime dependency escapes source root: ${dependencyName} -> ${realPackageDirectory}`,
        );
      }
      return packageDirectory;
    }
    if (cursor === resolvedRoot) break;
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }

  if (optional) return null;
  throw new Error(
    `Runtime dependency is not installed under source root: ${dependencyName}`,
  );
};

export const resolveRuntimeDependencyEntries = async ({
  sourceRoot = process.cwd(),
  dependencyNames,
}: {
  sourceRoot?: string;
  dependencyNames?: readonly string[];
} = {}): Promise<RuntimeDependencyEntry[]> => {
  const root = path.resolve(sourceRoot);
  const rootManifest = await readPackageManifest(path.join(root, 'package.json'));
  const names = dependencyNames ? [...new Set(dependencyNames)] : Object.keys(rootManifest.dependencies || {});
  for (const name of names) {
    if (typeof rootManifest.dependencies?.[name] !== 'string') throw new Error(`Runtime dependency is not declared: ${name}`);
  }
  const queue: Array<{
    name: string;
    parentDirectory: string;
    optional: boolean;
  }> = names
    .sort()
    .map((name) => ({
      name,
      parentDirectory: root,
      optional: false,
    }));

  const visitedDirectories = new Set<string>();
  const entries: RuntimeDependencyEntry[] = [];

  for (let index = 0; index < queue.length; index += 1) {
    const item = requiredIndex(queue, index);
    const packageDirectory = await resolveDependencyPackage({
      sourceRoot: root,
      parentDirectory: item.parentDirectory,
      dependencyName: item.name,
      optional: item.optional,
    });
    if (!packageDirectory) continue;

    const realPackageDirectory = await realpath(packageDirectory);
    if (visitedDirectories.has(realPackageDirectory)) continue;
    visitedDirectories.add(realPackageDirectory);

    const relativePath = normalizeRelative(path.relative(root, packageDirectory));
    if (!relativePath.startsWith('node_modules/')) {
      throw new Error(
        `Runtime dependency must resolve under node_modules: ${item.name} -> ${relativePath}`,
      );
    }
    entries.push({
      name: item.name,
      sourcePath: packageDirectory,
      relativePath,
    });

    const manifest = await readPackageManifest(path.join(packageDirectory, 'package.json'));
    for (const name of Object.keys(manifest.dependencies || {}).sort()) {
      queue.push({
        name,
        parentDirectory: packageDirectory,
        optional: false,
      });
    }
    for (const name of Object.keys(manifest.optionalDependencies || {}).sort()) {
      queue.push({
        name,
        parentDirectory: packageDirectory,
        optional: true,
      });
    }
  }

  return entries.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
};
