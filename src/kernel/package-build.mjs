import path from 'node:path';
import { mkdir, readFile, writeFile, cp, readdir, stat, realpath, lstat } from 'node:fs/promises';
import { auditSkillsLock } from '../shared/skills-lock.mjs';
import { buildStandaloneLock, loadStandaloneCatalog } from './standalone/catalog.mjs';
import { assertRuntimeBuild } from '../shared/runtime-build.mjs';

const forbidden = ['.moonshot-relay', 'runtime-state.sqlite', 'package/claude/profile', 'package/codex/profile', 'package/qwen/profile'];
const forbiddenNames = new Set(['runtime-state.sqlite', '.moonshot-relay']);

const mandatoryKernelFiles = [
  'schemas/kernel.track.schema.json',
  'schemas/kernel.runtime-state.schema.json',
  'skills/kernel-minimal-correct-change/SKILL.md',
  'skills/kernel-verification-before-completion/SKILL.md',
  'package/kernel/skills.lock.json',
  'package/kernel/standalone-skills.lock.json',
  'bin/moon-relay-standalone.mjs',
];

const exists = async (p) => {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
};

const isForbiddenPath = (relPath) => {
  const normalized = relPath.replaceAll('\\', '/');
  const segments = normalized.split('/');
  if (segments.some((seg) => forbiddenNames.has(seg))) return true;
  return forbidden.some((token) => normalized.includes(token));
};

const isOutsideRelative = (relPath) => relPath === '..' || relPath.startsWith('..' + path.sep) || relPath.startsWith('../') || path.isAbsolute(relPath);

const assertContained = async (sourceRoot, sourcePath) => {
  const absRoot = path.resolve(sourceRoot);
  const absSource = path.resolve(sourcePath);

  const relLexical = path.relative(absRoot, absSource);
  if (isOutsideRelative(relLexical)) {
    throw new Error(`Package source path ${sourcePath} escapes sourceRoot ${sourceRoot}`);
  }

  try {
    const realRoot = await realpath(absRoot);
    const realSource = await realpath(absSource);
    const relReal = path.relative(realRoot, realSource);
    if (isOutsideRelative(relReal)) {
      throw new Error(`Package source realpath ${realSource} escapes sourceRoot realpath ${realRoot}`);
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
};

const auditTreeContainment = async (sourceRoot, outputRoot, excludePatterns) => {
  const realOutputRoot = await realpath(outputRoot);

  const walk = async (dir) => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relToOutput = path.relative(outputRoot, fullPath).replaceAll('\\', '/');

      if (isForbiddenPath(relToOutput) || excludePatterns.some((ex) => relToOutput === ex || relToOutput.startsWith(ex + '/'))) {
        throw new Error(`Excluded or forbidden path found in materialized output tree: ${relToOutput}`);
      }

      const lst = await lstat(fullPath);
      if (lst.isSymbolicLink()) {
        const real = await realpath(fullPath);
        const relOutput = path.relative(realOutputRoot, real);
        if (isOutsideRelative(relOutput)) {
          throw new Error(`Materialized release package symlink ${relToOutput} points outside output root: ${real}`);
        }
      }

      if (lst.isDirectory()) {
        await walk(fullPath);
      }
    }
  };

  await walk(outputRoot);
};

const resolvePattern = async (sourceRoot, entry) => {
  const isWildcard = entry.endsWith('*');
  const cleanEntry = isWildcard ? entry.slice(0, -1) : entry;
  const directPath = path.join(sourceRoot, cleanEntry);

  await assertContained(sourceRoot, directPath);

  if (await exists(directPath)) {
    return [cleanEntry];
  }

  const parentDirRel = path.dirname(cleanEntry);
  const prefix = path.basename(cleanEntry);
  const parentDirAbs = path.join(sourceRoot, parentDirRel);

  await assertContained(sourceRoot, parentDirAbs);

  if (await exists(parentDirAbs)) {
    const entries = await readdir(parentDirAbs, { withFileTypes: true });
    const matches = entries
      .filter((e) => e.name.startsWith(prefix))
      .map((e) => path.join(parentDirRel, e.name).replaceAll('\\', '/'));
    if (matches.length > 0) return matches;
  }

  throw new Error(`Mandatory Kernel include entry resolved to 0 files: ${entry}`);
};

export const planKernelPackage = async ({ sourceRoot = process.cwd(), outputRoot }) => {
  await assertRuntimeBuild(sourceRoot);
  const manifest = JSON.parse(await readFile(path.join(sourceRoot, 'package', 'kernel', 'manifest.json'), 'utf8'));
  const standaloneCatalog = await loadStandaloneCatalog({ repoRoot: sourceRoot, validateSources: true });

  const excludePatterns = [...forbidden, ...(manifest.exclude || [])].map((p) => p.replaceAll('\\', '/'));

  const planned = [];
  for (const entry of manifest.include) {
    const resolvedEntries = await resolvePattern(sourceRoot, entry);
    for (const rel of resolvedEntries) {
      const normalizedRel = rel.replaceAll('\\', '/');

      if (isForbiddenPath(normalizedRel) || excludePatterns.some((ex) => normalizedRel === ex || normalizedRel.startsWith(ex + '/'))) {
        continue;
      }

      const source = path.join(sourceRoot, rel);
      const target = path.join(outputRoot, rel);

      await assertContained(sourceRoot, source);

      planned.push({
        source,
        target,
        rel: normalizedRel,
      });
    }
  }

  for (const item of planned) {
    if (isForbiddenPath(item.rel)) {
      throw new Error(`Forbidden Relay surface in Kernel package plan: ${item.rel}`);
    }
  }

  for (const req of mandatoryKernelFiles) {
    const found = planned.some((p) => p.rel === req || req.startsWith(p.rel + '/'));
    if (!found) {
      throw new Error(`Required kernel file missing from package plan: ${req}`);
    }
  }

  return { manifest, planned, excludePatterns, standaloneCatalog };
};

export const materializeKernelPackage = async ({ sourceRoot = process.cwd(), outputRoot, dryRun = false }) => {
  const plan = await planKernelPackage({ sourceRoot, outputRoot });

  const lockPath = path.join(sourceRoot, 'package', 'kernel', 'skills.lock.json');
  if (await exists(lockPath)) {
    const lock = JSON.parse(await readFile(lockPath, 'utf8'));
    const audit = await auditSkillsLock({ repoRoot: sourceRoot, scope: 'kernel', lock });
    if (audit.status !== 'pass') {
      throw new Error(`Kernel skills lock audit failed with status ${audit.status}: ${JSON.stringify(audit.findings)}`);
    }
  } else {
    throw new Error('Kernel skills lock file missing: package/kernel/skills.lock.json');
  }
  const standaloneLockPath = path.join(sourceRoot, 'package', 'kernel', 'standalone-skills.lock.json');
  const standaloneLock = JSON.parse(await readFile(standaloneLockPath, 'utf8'));
  const derivedStandaloneLock = await buildStandaloneLock({ repoRoot: sourceRoot, catalog: plan.standaloneCatalog, sourceCommit: standaloneLock.sourceCommit || '' });
  if (standaloneLock.catalogId !== derivedStandaloneLock.catalogId || standaloneLock.catalogDigest !== derivedStandaloneLock.catalogDigest) {
    throw new Error('Standalone catalog/lock parity failed: catalogDigest mismatch');
  }
  const expectedStandalone = new Map(derivedStandaloneLock.skills.map((entry) => [entry.name, entry.contentHash]));
  const actualStandalone = new Map((standaloneLock.skills || []).map((entry) => [entry.name, entry.contentHash]));
  if (expectedStandalone.size !== actualStandalone.size || [...expectedStandalone].some(([name, hash]) => actualStandalone.get(name) !== hash)) {
    throw new Error('Standalone catalog/lock parity failed: contentHash mismatch');
  }

  // Create clean sanitized plan for package artifact (storing relative paths only)
  const relativePlan = {
    manifest: plan.manifest,
    files: plan.planned.map((item) => ({
      rel: item.rel,
      sourceRel: item.rel,
      targetRel: item.rel,
    })),
  };

  if (dryRun) return { dryRun: true, plan: relativePlan };
  await mkdir(outputRoot, { recursive: true });

  for (const item of plan.planned) {
    await cp(item.source, item.target, { recursive: true, force: true });
  }

  for (const req of mandatoryKernelFiles) {
    const targetFile = path.join(outputRoot, req);
    if (!(await exists(targetFile))) {
      throw new Error(`Materialization verification failed, required file missing: ${targetFile}`);
    }
  }

  await auditTreeContainment(sourceRoot, outputRoot, plan.excludePatterns);

  await writeFile(path.join(outputRoot, 'kernel-package-plan.json'), JSON.stringify(relativePlan, null, 2));
  return { dryRun: false, plan: relativePlan };
};
