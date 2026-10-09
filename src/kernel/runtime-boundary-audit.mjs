import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

const ACTIVE_DIRECTORIES = Object.freeze([
  'bin',
  'scripts/kernel',
  'scripts/host/kernel',
  'scripts/switcher',
]);

// The public wrapper also dispatches these support commands directly. They
// are execution targets, not merely documentation, so the active boundary
// must cover them even though they live outside the Kernel-owned directories.
export const ACTIVE_EXECUTION_FILES = Object.freeze([
  'scripts/delivery-submit.mjs',
  'tools/retro/retro-cli.mjs',
]);

// These files remain available only as migration/compatibility inputs. They
// are deliberately outside ACTIVE_DIRECTORIES and must never be imported by
// an active Kernel entrypoint.
export const MIGRATION_ONLY_RUNTIME_FILES = Object.freeze([
  'scripts/install-account-root-harness.mjs',
  'scripts/install-project-runtime-bridge.mjs',
  'scripts/runtime-state.mjs',
]);

const AUDIT_FILES = new Set([
  'scripts/kernel/runtime-boundary-audit.mjs',
  'scripts/kernel/unification-audit.mjs',
]);

const FORBIDDEN_ACTIVE_PATTERNS = Object.freeze([
  ['relay-track-activation', /MOON_RELAY_TRACK\s*[:=]\s*['"]relay['"]/i],
  ['relay-home-interactive', /\bMOONSHOT_RELAY_HOME\b/i],
  ['relay-environment-materializer', /\brelaySetupEnvironment\b/i],
  ['relay-installer-execution', /\b(?:install-account-root-harness|install-project-runtime-bridge)\.mjs\b/i],
  ['provider-cli-worker', /\bcli-worker\b/i],
  ['worker-launcher-missing-blocker', /\bworker-launcher-missing\b/i],
  ['legacy-launch-path', /\blegacy-launch\b/i],
  ['account-skills-overlay-restore', /\brestoreAccountSkillsOverlay\b/i],
]);

const collectFiles = async (root) => {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...await collectFiles(fullPath));
    else if (entry.isFile() && /\.(?:mjs|cjs|js|json|yaml|yml)$/i.test(entry.name)) files.push(fullPath);
  }
  return files;
};

const IMPORT_SPECIFIER_PATTERNS = Object.freeze([
  /\bimport\s+(?:[\s\S]*?\sfrom\s+)?['"]([^'"]+)['"]/g,
  /\bexport\s+(?:[\s\S]*?\sfrom\s+)?['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*(?:(?:\/\*[\s\S]*?\*\/)|(?:\/\/[^\r\n]*(?:\r?\n|$))|\s)*['"]([^'"]+)['"]\s*\)/g,
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
]);

const localImportSpecifiers = (content) => {
  const specifiers = new Set();
  for (const pattern of IMPORT_SPECIFIER_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of content.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier?.startsWith('.')) specifiers.add(specifier);
    }
  }
  return [...specifiers];
};

const isWithinRepo = (repoRoot, file) => {
  const relative = path.relative(repoRoot, file);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
};

const resolveLocalImport = async (importer, specifier) => {
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
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error?.code)) throw error;
    }
  }
  return null;
};

const collectReachableExecutionImports = async ({ repoRoot, findings }) => {
  const queue = [];
  for (const relativeFile of ACTIVE_EXECUTION_FILES) {
    const file = path.join(repoRoot, relativeFile);
    try {
      await readFile(file, 'utf8');
      queue.push(file);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  const visited = new Set();
  const reachable = [];
  while (queue.length > 0) {
    const importer = queue.shift();
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

export async function auditActiveRuntimeBoundary({ repoRoot = path.resolve('.') } = {}) {
  const findings = [];
  const files = [];
  for (const relativeDirectory of ACTIVE_DIRECTORIES) {
    files.push(...await collectFiles(path.join(repoRoot, relativeDirectory)));
  }
  for (const relativeFile of ACTIVE_EXECUTION_FILES) {
    const file = path.join(repoRoot, relativeFile);
    try {
      await readFile(file, 'utf8');
      files.push(file);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  files.push(...await collectReachableExecutionImports({ repoRoot, findings }));

  const scannedFiles = [];
  for (const file of [...new Set(files)]) {
    const relative = path.relative(repoRoot, file).replaceAll('\\', '/');
    if (AUDIT_FILES.has(relative)) continue;
    const content = await readFile(file, 'utf8');
    scannedFiles.push(relative);
    for (const [code, pattern] of FORBIDDEN_ACTIVE_PATTERNS) {
      if (pattern.test(content)) {
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
