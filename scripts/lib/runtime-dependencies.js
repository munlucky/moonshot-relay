// Generated from src/shared/runtime-dependencies.ts. Edit the source and run npm run build.
import { requiredIndex } from './required-index.js';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
const nativeAddonPaths = async (root, relative = '') => {
    const directory = path.join(root, relative);
    const addons = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.name === 'node_modules')
            continue;
        const childRelative = path.join(relative, entry.name);
        if (entry.isDirectory())
            addons.push(...await nativeAddonPaths(root, childRelative));
        else if (entry.isFile() && entry.name.endsWith('.node'))
            addons.push(path.join(root, childRelative));
    }
    return addons.sort();
};
const NATIVE_ADDON_PROBE = `
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  const addons = JSON.parse(input);
  for (const addon of addons) {
    try {
      const module = { exports: {} };
      process.dlopen(module, addon.path);
    } catch (error) {
      process.stderr.write(JSON.stringify({ name: addon.name, path: addon.path, message: error?.message || String(error) }));
      process.exit(1);
    }
  }
});`;
export const assertRuntimeDependencyCompatibility = async (entries) => {
    const probes = [];
    for (const entry of entries) {
        for (const addon of await nativeAddonPaths(entry.sourcePath))
            probes.push({ name: entry.name, path: addon });
    }
    if (probes.length === 0)
        return;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', NATIVE_ADDON_PROBE], {
        input: JSON.stringify(probes),
        encoding: 'utf8',
        windowsHide: true,
        timeout: 10_000,
        maxBuffer: 64 * 1024,
    });
    if (result.status === 0)
        return;
    let failure = {};
    try {
        failure = JSON.parse(result.stderr || '{}');
    }
    catch {
        const message = result.stderr || result.error?.message;
        failure = message ? { message } : {};
    }
    const dependency = failure.name || probes[0]?.name || 'unknown';
    throw Object.assign(new Error(`Native runtime dependency is incompatible with the current execution surface: ${dependency}: ${failure.message || 'native addon load failed'}`), {
        code: 'NATIVE_RUNTIME_INCOMPATIBLE',
        details: {
            dependency,
            addonPath: failure.path || null,
            platform: process.platform,
            arch: process.arch,
            nodeVersion: process.version,
            modulesAbi: process.versions.modules || null,
        },
    });
};
const exists = async (target) => {
    try {
        await stat(target);
        return true;
    }
    catch {
        return false;
    }
};
const normalizeRelative = (value) => value.replaceAll('\\', '/');
const isWithin = (root, target) => {
    const relative = path.relative(root, target);
    return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
};
const readPackageManifest = async (packageJsonPath) => JSON.parse(await readFile(packageJsonPath, 'utf8'));
const resolveDependencyPackage = async ({ sourceRoot, parentDirectory, dependencyName, optional, }) => {
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
                throw new Error(`Runtime dependency escapes source root: ${dependencyName} -> ${realPackageDirectory}`);
            }
            return packageDirectory;
        }
        if (cursor === resolvedRoot)
            break;
        const parent = path.dirname(cursor);
        if (parent === cursor)
            break;
        cursor = parent;
    }
    if (optional)
        return null;
    throw new Error(`Runtime dependency is not installed under source root: ${dependencyName}`);
};
export const resolveRuntimeDependencyEntries = async ({ sourceRoot = process.cwd(), dependencyNames, } = {}) => {
    const root = path.resolve(sourceRoot);
    const rootManifest = await readPackageManifest(path.join(root, 'package.json'));
    const names = dependencyNames ? [...new Set(dependencyNames)] : Object.keys(rootManifest.dependencies || {});
    for (const name of names) {
        if (typeof rootManifest.dependencies?.[name] !== 'string')
            throw new Error(`Runtime dependency is not declared: ${name}`);
    }
    const queue = names
        .sort()
        .map((name) => ({
        name,
        parentDirectory: root,
        optional: false,
    }));
    const visitedDirectories = new Set();
    const entries = [];
    for (let index = 0; index < queue.length; index += 1) {
        const item = requiredIndex(queue, index);
        const packageDirectory = await resolveDependencyPackage({
            sourceRoot: root,
            parentDirectory: item.parentDirectory,
            dependencyName: item.name,
            optional: item.optional,
        });
        if (!packageDirectory)
            continue;
        const realPackageDirectory = await realpath(packageDirectory);
        if (visitedDirectories.has(realPackageDirectory))
            continue;
        visitedDirectories.add(realPackageDirectory);
        const relativePath = normalizeRelative(path.relative(root, packageDirectory));
        if (!relativePath.startsWith('node_modules/')) {
            throw new Error(`Runtime dependency must resolve under node_modules: ${item.name} -> ${relativePath}`);
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
