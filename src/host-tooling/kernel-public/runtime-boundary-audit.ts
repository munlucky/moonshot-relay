import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { resolveKernelPackageInclude } from '../../kernel/package-build.js';

interface AuditFinding {
  code: string;
  message: string;
  file?: string;
}

interface ResolvedLocalImport {
  logicalPath: string;
  physicalPath: string;
}

const ACTIVE_DIRECTORIES = Object.freeze([
  'scripts/kernel',
  'scripts/host/kernel',
  'scripts/switcher',
]);

export const ACTIVE_EXECUTION_FILES = Object.freeze([
  'scripts/delivery-submit.mjs',
  'tools/retro/retro-cli.mjs',
]);

export const MIGRATION_ONLY_RUNTIME_FILES = Object.freeze([
  'scripts/install-account-root-harness.mjs',
  'scripts/install-project-runtime-bridge.mjs',
  'scripts/runtime-state.mjs',
]);

const AUDIT_FILES = new Set<string>([
  'scripts/kernel/runtime-boundary-audit.mjs',
  'scripts/kernel/unification-audit.mjs',
]);

const FORBIDDEN_ACTIVE_PATTERNS: readonly (readonly [string, RegExp])[] = Object.freeze([
  ['relay-track-activation', /MOON_RELAY_TRACK\s*[:=]\s*['"]relay['"]/i],
  ['relay-home-interactive', /\bMOONSHOT_RELAY_HOME\b/i],
  ['relay-environment-materializer', /\brelaySetupEnvironment\b/i],
  ['relay-installer-execution', /\b(?:install-account-root-harness|install-project-runtime-bridge)\.mjs\b/i],
  ['provider-cli-worker', /\bcli-worker\b/i],
  ['worker-launcher-missing-blocker', /\bworker-launcher-missing\b/i],
  ['legacy-launch-path', /\blegacy-launch\b/i],
  ['account-skills-overlay-restore', /\brestoreAccountSkillsOverlay\b/i],
]);

const errorCode = (error: unknown): string | null => (
  error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code || '')
    : null
);

const collectFiles = async (root: string, packageRoot?: string, visited = new Set<string>()): Promise<string[]> => {
  if (packageRoot) {
    const physical = await realpath(root);
    if (!isWithinRepo(packageRoot, physical)) throw new Error(`Kernel bin escapes package root: ${root}`);
    if (visited.has(physical)) return [];
    visited.add(physical);
  }
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error: unknown) {
    if (errorCode(error) === 'ENOENT') return [];
    throw error;
  }

  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    const resolvedEntry = packageRoot && entry.isSymbolicLink() ? await stat(fullPath) : entry;
    if (packageRoot && !isWithinRepo(packageRoot, await realpath(fullPath))) throw new Error(`Kernel bin escapes package root: ${fullPath}`);
    if (resolvedEntry.isDirectory()) {
      files.push(...await collectFiles(fullPath, packageRoot, visited));
    } else if (resolvedEntry.isFile() && /\.(?:mjs|cjs|js|json|yaml|yml)$/i.test(entry.name)) {
      files.push(fullPath);
    }
  }
  return files;
};

// The shared npm bin directory also contains Relay-only products. Kernel
// membership comes from its existing package contract, not a filename exception.
const collectKernelBinFiles = async (repoRoot: string, findings: AuditFinding[]): Promise<string[]> => {
  try {
    const manifest = JSON.parse(await readFile(path.join(repoRoot, 'package/kernel/manifest.json'), 'utf8')) as { include?: unknown; entrypoint?: unknown };
    const safeRelative = (entry: unknown): entry is string => typeof entry === 'string' && Boolean(entry)
      && !path.isAbsolute(entry) && !entry.includes('\\') && !entry.split('/').includes('..');
    if (!Array.isArray(manifest.include) || !manifest.include.length
      || !manifest.include.every(safeRelative) || !safeRelative(manifest.entrypoint)) {
      throw new Error('Invalid Kernel package include list');
    }
    const entries = manifest.include.filter((entry: string) => entry.startsWith('bin/')) as string[];
    if (!entries.length) throw new Error('Kernel package declares no bin entrypoints');
    const physicalRoot = await realpath(repoRoot);
    const files: string[] = [];
    for (const entry of entries) {
      for (const relative of await resolveKernelPackageInclude(repoRoot, entry)) {
        const file = path.join(repoRoot, relative);
        if (!isWithinRepo(physicalRoot, await realpath(file))) throw new Error(`Kernel bin escapes package root: ${relative}`);
        const entryStat = await stat(file);
        files.push(...(entryStat.isDirectory() ? await collectFiles(file, physicalRoot) : [file]));
      }
    }
    const physicalFiles = new Set<string>();
    for (const file of files) {
      const physical = await realpath(file);
      if (!isWithinRepo(physicalRoot, physical)) throw new Error(`Kernel bin escapes package root: ${file}`);
      physicalFiles.add(physical);
    }
    const entrypoint = await realpath(path.join(repoRoot, manifest.entrypoint));
    if (!files.length || !(await stat(entrypoint)).isFile() || !physicalFiles.has(entrypoint)) {
      throw new Error('Kernel entrypoint is not a selected bin file');
    }
    return files;
  } catch (error: unknown) {
    findings.push({
      code: 'active-runtime-kernel-manifest-invalid',
      file: 'package/kernel/manifest.json',
      message: `Cannot establish Kernel bin membership: ${error instanceof Error ? error.message : String(error)}.`,
    });
    return [];
  }
};

const IMPORT_SPECIFIER_PATTERNS: readonly RegExp[] = Object.freeze([
  /\bimport\s+(?:[\s\S]*?\sfrom\s+)?['"]([^'"]+)['"]/g,
  /\bexport\s+(?:[\s\S]*?\sfrom\s+)?['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*(?:(?:\/\*[\s\S]*?\*\/)|(?:\/\/[^\r\n]*(?:\r?\n|$))|\s)*['"]([^'"]+)['"]\s*\)/g,
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
]);

const localImportSpecifiers = (content: string): string[] => {
  const specifiers = new Set<string>();
  for (const pattern of IMPORT_SPECIFIER_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of content.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier?.startsWith('.')) specifiers.add(specifier);
    }
  }
  return [...specifiers];
};

const isWithinRepo = (repoRoot: string, file: string): boolean => {
  const relative = path.relative(repoRoot, file);
  return Boolean(relative)
    && !relative.startsWith('..')
    && !path.isAbsolute(relative);
};

const resolveLocalImport = async (
  importer: string,
  specifier: string,
): Promise<ResolvedLocalImport | null> => {
  const base = path.resolve(path.dirname(importer), specifier);
  const candidates = [
    base,
    `${base}.mjs`,
    `${base}.js`,
    `${base}.cjs`,
    `${base}.json`,
    path.join(base, 'index.mjs'),
    path.join(base, 'index.js'),
    path.join(base, 'index.cjs'),
  ];

  for (const candidate of candidates) {
    try {
      const physicalPath = await realpath(candidate);
      const entry = await stat(physicalPath);
      if (entry.isFile()) return { logicalPath: candidate, physicalPath };
    } catch (error: unknown) {
      if (!['ENOENT', 'ENOTDIR'].includes(errorCode(error) || '')) throw error;
    }
  }
  return null;
};

const collectReachableExecutionImports = async ({
  repoRoot,
  findings,
  entryFiles = [],
}: {
  repoRoot: string;
  findings: AuditFinding[];
  entryFiles?: string[];
}): Promise<string[]> => {
  const queue: string[] = [...entryFiles];
  for (const relativeFile of ACTIVE_EXECUTION_FILES) {
    const file = path.join(repoRoot, relativeFile);
    try {
      await readFile(file, 'utf8');
      queue.push(file);
    } catch (error: unknown) {
      if (errorCode(error) !== 'ENOENT') throw error;
    }
  }

  const visited = new Set<string>();
  const reachable: string[] = [];
  while (queue.length > 0) {
    const logicalImporter = queue.shift();
    if (!logicalImporter) continue;
    const importer = await realpath(logicalImporter);
    if (visited.has(importer)) continue;
    visited.add(importer);
    reachable.push(importer);

    const content = await readFile(importer, 'utf8');
    const importerRelative = path.relative(repoRoot, importer).replaceAll('\\', '/');
    for (const specifier of localImportSpecifiers(content)) {
      const resolved = await resolveLocalImport(importer, specifier);
      if (!resolved) {
        findings.push({
          code: 'active-runtime-import-unresolved',
          file: importerRelative,
          message: `${importerRelative} has an unresolved local import: ${specifier}.`,
        });
        continue;
      }
      if (!isWithinRepo(repoRoot, resolved.physicalPath)) {
        findings.push({
          code: 'active-runtime-import-outside-repo',
          file: importerRelative,
          message: `${importerRelative} imports a local module outside the repository: ${specifier}.`,
        });
        continue;
      }
      queue.push(resolved.physicalPath);
    }
  }
  return reachable;
};

export async function auditActiveRuntimeBoundary({
  repoRoot = path.resolve('.'),
}: {
  repoRoot?: string;
} = {}) {
  const findings: AuditFinding[] = [];
  const files: string[] = [];

  for (const relativeDirectory of ACTIVE_DIRECTORIES) {
    files.push(...await collectFiles(path.join(repoRoot, relativeDirectory)));
  }
  files.push(...await collectKernelBinFiles(repoRoot, findings));
  for (const relativeFile of ACTIVE_EXECUTION_FILES) {
    const file = path.join(repoRoot, relativeFile);
    try {
      await readFile(file, 'utf8');
      files.push(file);
    } catch (error: unknown) {
      if (errorCode(error) !== 'ENOENT') throw error;
    }
  }
  files.push(...await collectReachableExecutionImports({ repoRoot, findings, entryFiles: files }));

  const scannedFiles: string[] = [];
  for (const file of [...new Set(files)]) {
    const relative = path.relative(repoRoot, file).replaceAll('\\', '/');
    if (AUDIT_FILES.has(relative)) continue;

    const fileContent = await readFile(file, 'utf8');
    scannedFiles.push(relative);
    for (const [code, pattern] of FORBIDDEN_ACTIVE_PATTERNS) {
      if (pattern.test(fileContent)) {
        findings.push({
          code: `active-runtime-${code}`,
          file: relative,
          message: `${relative} contains a retired runtime path: ${code}.`,
        });
      }
    }
  }

  return {
    schemaVersion: 1,
    status: findings.length ? 'fail' : 'pass',
    scannedDirectories: [...ACTIVE_DIRECTORIES],
    scannedFiles,
    migrationOnlyFiles: [...MIGRATION_ONLY_RUNTIME_FILES],
    findings,
  };
}
