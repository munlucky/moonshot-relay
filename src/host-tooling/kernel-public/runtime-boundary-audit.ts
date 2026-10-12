import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

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
  'bin',
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

const collectFiles = async (root: string): Promise<string[]> => {
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
    if (entry.isDirectory()) {
      files.push(...await collectFiles(fullPath));
    } else if (entry.isFile() && /\.(?:mjs|cjs|js|json|yaml|yml)$/i.test(entry.name)) {
      files.push(fullPath);
    }
  }
  return files;
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
}: {
  repoRoot: string;
  findings: AuditFinding[];
}): Promise<string[]> => {
  const queue: string[] = [];
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
    const importer = queue.shift();
    if (!importer || visited.has(importer)) continue;
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
  for (const relativeFile of ACTIVE_EXECUTION_FILES) {
    const file = path.join(repoRoot, relativeFile);
    try {
      await readFile(file, 'utf8');
      files.push(file);
    } catch (error: unknown) {
      if (errorCode(error) !== 'ENOENT') throw error;
    }
  }
  files.push(...await collectReachableExecutionImports({ repoRoot, findings }));

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
