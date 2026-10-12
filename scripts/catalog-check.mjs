#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { buildStandaloneLock, loadStandaloneCatalog, STANDALONE_LOCK_REL, STANDALONE_CATALOG_REL } from './kernel/standalone/catalog.js';

const scriptPath = fileURLToPath(import.meta.url);
const repoRootDefault = path.dirname(path.dirname(scriptPath));

const toPortable = (value) => value.split(path.sep).join('/');

const pathExists = async (target) => {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
};

const readJson = async (target) => JSON.parse(await readFile(target, 'utf8'));

const finding = (severity, code, message, details = {}) => ({
  severity,
  code,
  message,
  ...details,
});

const sameSet = (left, right) => {
  const a = [...new Set(left)].sort();
  const b = [...new Set(right)].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
};

const sameOrder = (left, right) => left.length === right.length
  && left.every((value, index) => value === right[index]);

const diffSets = (expected, actual) => ({
  missing: [...new Set(expected)].filter((value) => !actual.includes(value)).sort(),
  extra: [...new Set(actual)].filter((value) => !expected.includes(value)).sort(),
});

const standaloneLockSignature = (lock) => JSON.stringify({
  schemaVersion: lock?.schemaVersion,
  scope: lock?.scope,
  catalogId: lock?.catalogId,
  catalogDigest: lock?.catalogDigest,
  skills: (lock?.skills || []).map((entry) => ({
    name: entry.name,
    kind: entry.kind,
    skillPath: entry.skillPath,
    entrypoint: entry.entrypoint,
    exportName: entry.exportName,
    contentHash: entry.contentHash,
    cli: entry.cli,
    requiresKernelRun: entry.requiresKernelRun,
    mayMutateSource: entry.mayMutateSource,
    mayMutateGit: entry.mayMutateGit,
    mayMutateKnowledge: entry.mayMutateKnowledge,
    mayWriteArtifacts: entry.mayWriteArtifacts,
    permissions: entry.permissions,
  })),
});

export const parsePublicRuntimeSkillsFromContract = (text) => {
  const lists = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^\s*publicRuntimeSkills:\s*$/.test(lines[index])) {
      continue;
    }
    const values = [];
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const line = lines[cursor];
      const item = line.match(/^\s*-\s+([A-Za-z0-9._-]+)\s*$/);
      if (item) {
        values.push(item[1]);
        continue;
      }
      if (/^\s*$/.test(line)) {
        continue;
      }
      break;
    }
    if (values.length > 0) {
      lists.push(values);
    }
  }
  return lists;
};

const listSourceSkillDirs = async (repoRoot) => {
  const skillsRoot = path.join(repoRoot, 'skills');
  const entries = await readdir(skillsRoot, { withFileTypes: true });
  const skillDirs = [];
  for (const entry of entries) {
    if (entry.isDirectory() && await pathExists(path.join(skillsRoot, entry.name, 'SKILL.md'))) {
      skillDirs.push(entry.name);
    }
  }
  return skillDirs.sort();
};

const packageDryRunPublicSkills = (repoRoot) => {
  const result = spawnSync(process.execPath, [
    'package/build-package.mjs',
    '--runtime',
    'all',
    '--dry-run',
    '--json',
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
  });

  if (result.status !== 0) {
    return {
      status: 'failed',
      error: result.stderr || result.stdout,
      claude: [],
      codex: [],
      qwen: [],
    };
  }

  const payload = JSON.parse(result.stdout);
  const byRuntime = new Map(payload.runtimes.map((runtime) => [runtime.runtime, runtime]));
  const extract = (runtimeName, marker) => {
    const runtime = byRuntime.get(runtimeName);
    if (!runtime) {
      return [];
    }
    const skills = new Set();
    for (const entry of runtime.planned || []) {
      const match = entry.to.match(new RegExp(`${marker}/skills/([^/]+)/SKILL\\.md$`));
      if (match) {
        skills.add(match[1]);
      }
    }
    return [...skills];
  };

  return {
    status: 'pass',
    claude: extract('claude', 'package/claude/profile/.claude'),
    codex: extract('codex', 'package/codex/profile/.codex'),
    qwen: extract('qwen', 'package/qwen/profile/.qwen'),
  };
};

export const checkCatalog = async (options = {}) => {
  const repoRoot = options.repoRoot || repoRootDefault;
  const catalogPath = options.catalogPath || path.join(repoRoot, 'catalog', 'moonshot-catalog.json');
  const runtimeSurfacePath = options.runtimeSurfacePath || path.join(repoRoot, 'package', 'runtime-surface.json');
  const packageContractPath = options.packageContractPath || path.join(repoRoot, 'package', 'package-contract.yaml');
  const runPackageDryRun = options.runPackageDryRun ?? true;

  const findings = [];
  const catalog = await readJson(catalogPath);
  const runtimeSurface = await readJson(runtimeSurfacePath);
  const packageContractText = await readFile(packageContractPath, 'utf8');

  const catalogPublic = (catalog.publicEntrypoints || []).map((entry) => entry.name);
  const runtimePublic = runtimeSurface.publicRuntimeSkills || [];
  const contractPublicLists = parsePublicRuntimeSkillsFromContract(packageContractText);
  const contractPublic = contractPublicLists[0] || [];

  if (!sameSet(catalogPublic, runtimePublic)) {
    findings.push(finding('blocking', 'catalog.runtime_surface_mismatch', 'Catalog publicEntrypoints must match package/runtime-surface.json.', diffSets(catalogPublic, runtimePublic)));
  }
  if (sameSet(catalogPublic, runtimePublic) && !sameOrder(catalogPublic, runtimePublic)) {
    findings.push(finding('blocking', 'catalog.runtime_surface_order_mismatch', 'Catalog and runtime surface public entrypoints must use the same frozen order.', { expected: catalogPublic, actual: runtimePublic }));
  }

  if (contractPublicLists.length === 0 || !sameSet(catalogPublic, contractPublic)) {
    findings.push(finding('blocking', 'catalog.package_contract_mismatch', 'Catalog publicEntrypoints must match package/package-contract.yaml publicRuntimeSkills.', diffSets(catalogPublic, contractPublic)));
  }
  if (contractPublicLists.length > 0 && sameSet(catalogPublic, contractPublic) && !sameOrder(catalogPublic, contractPublic)) {
    findings.push(finding('blocking', 'catalog.package_contract_order_mismatch', 'Catalog and package contract public entrypoints must use the same frozen order.', { expected: catalogPublic, actual: contractPublic }));
  }

  const sourceSkillDirs = await listSourceSkillDirs(repoRoot);
  for (const entry of catalog.publicEntrypoints || []) {
    const expectedSource = `skills/${entry.name}/SKILL.md`;
    if (entry.source !== expectedSource) {
      findings.push(finding('blocking', 'catalog.public_source_mismatch', `Public entry ${entry.name} source must be ${expectedSource}.`, { skill: entry.name, expectedSource, actualSource: entry.source || '' }));
    }
    if (!entry.source || !await pathExists(path.join(repoRoot, entry.source))) {
      findings.push(finding('blocking', 'catalog.public_source_missing', `Public entry ${entry.name} source is missing.`, { skill: entry.name, source: entry.source || '' }));
    }
    if (!sourceSkillDirs.includes(entry.name)) {
      findings.push(finding('blocking', 'catalog.public_skill_dir_missing', `Public entry ${entry.name} is not a canonical source skill directory.`, { skill: entry.name }));
    }
  }

  for (const cluster of catalog.internalSkillClusters || []) {
    for (const skill of cluster.skills || []) {
      if (!sourceSkillDirs.includes(skill)) {
        findings.push(finding('blocking', 'catalog.internal_skill_missing', `Internal catalog skill ${skill} is not a canonical source skill directory.`, { cluster: cluster.id, skill }));
      }
      if (catalogPublic.includes(skill)) {
        findings.push(finding('blocking', 'catalog.internal_exposes_public', `Internal cluster must not duplicate public entrypoint ${skill}.`, { cluster: cluster.id, skill }));
      }
    }
  }

  for (const doc of catalog.requiredDocumentation?.files || []) {
    const docPath = path.join(repoRoot, doc);
    if (!await pathExists(docPath)) {
      findings.push(finding('blocking', 'catalog.documentation_missing', `Required documentation file is missing: ${doc}`, { doc }));
      continue;
    }
    const text = await readFile(docPath, 'utf8');
    const missing = catalogPublic.filter((skill) => !text.includes(skill));
    if (missing.length > 0) {
      findings.push(finding('blocking', 'catalog.documentation_drift', `Required documentation file does not mention every public entrypoint: ${doc}`, { doc, missing }));
    }
  }

  let standaloneCatalogReport = { status: 'not-present', catalog: null, lock: null, findings: [] };
  const standaloneCatalogPath = options.standaloneCatalogPath || path.join(repoRoot, STANDALONE_CATALOG_REL);
  const standaloneLockPath = options.standaloneLockPath || path.join(repoRoot, STANDALONE_LOCK_REL);
  if (await pathExists(standaloneCatalogPath)) {
    const standaloneFindings = [];
    let standaloneCatalog = null;
    try {
      standaloneCatalog = await loadStandaloneCatalog({ repoRoot, catalogPath: standaloneCatalogPath, validateSources: true });
    } catch (error) {
      standaloneFindings.push(...(error.findings || [finding('blocking', 'standalone.catalog_invalid', error.message)]));
    }
    let standaloneLock = null;
    if (!await pathExists(standaloneLockPath)) {
      standaloneFindings.push(finding('blocking', 'standalone.lock_missing', `Standalone lock is missing: ${toPortable(path.relative(repoRoot, standaloneLockPath))}.`));
    } else {
      try {
        standaloneLock = await readJson(standaloneLockPath);
      } catch (error) {
        standaloneFindings.push(finding('blocking', 'standalone.lock_invalid_json', 'Standalone lock is not valid JSON.', { error: error.message }));
      }
    }
    if (standaloneCatalog && standaloneLock) {
      const expectedLock = await buildStandaloneLock({ repoRoot, catalog: standaloneCatalog, sourceCommit: standaloneLock.sourceCommit || '' });
      if (standaloneLockSignature(expectedLock) !== standaloneLockSignature(standaloneLock)) {
        standaloneFindings.push(finding('blocking', 'standalone.lock_catalog_drift', 'Standalone catalog, sources, and lock are not in parity.', {
          catalog: toPortable(path.relative(repoRoot, standaloneCatalogPath)),
          lock: toPortable(path.relative(repoRoot, standaloneLockPath)),
        }));
      }
    }
    standaloneCatalogReport = {
      status: standaloneFindings.length === 0 ? 'pass' : 'fail',
      catalog: toPortable(path.relative(repoRoot, standaloneCatalogPath)),
      lock: toPortable(path.relative(repoRoot, standaloneLockPath)),
      skills: standaloneCatalog?.skills?.map((entry) => entry.name) || [],
      findings: standaloneFindings,
    };
    findings.push(...standaloneFindings);
  }

  if (!packageContractText.includes('- catalog/') || !packageContractText.includes('source: catalog/moonshot-catalog.json')) {
    findings.push(finding('blocking', 'catalog.package_contract_omits_catalog', 'Package contract must declare catalog/ and catalog/moonshot-catalog.json in the common payload.'));
  }

  if (runPackageDryRun) {
    const packagePlan = packageDryRunPublicSkills(repoRoot);
    if (packagePlan.status !== 'pass') {
      findings.push(finding('blocking', 'catalog.package_dry_run_failed', 'Package dry-run failed while checking service profile exposure.', { error: packagePlan.error }));
    } else {
      for (const runtime of ['claude', 'codex', 'qwen']) {
        if (!sameSet(runtimePublic, packagePlan[runtime])) {
          findings.push(finding('blocking', 'catalog.profile_exposure_mismatch', `${runtime} profile dry-run exposes a different skill set than runtime-surface.json.`, {
            runtime,
            ...diffSets(runtimePublic, packagePlan[runtime]),
          }));
        }
        if (sameSet(runtimePublic, packagePlan[runtime]) && !sameOrder(runtimePublic, packagePlan[runtime])) {
          findings.push(finding('blocking', 'catalog.profile_exposure_order_mismatch', `${runtime} profile dry-run must materialize public skills in frozen runtime-surface order.`, { runtime, expected: runtimePublic, actual: packagePlan[runtime] }));
        }
      }
    }
  }

  const blockingCount = findings.filter((item) => item.severity === 'blocking').length;
  return {
    schemaVersion: 'moonshot-catalog-check.v1',
    status: blockingCount === 0 ? 'pass' : 'fail',
    catalog: toPortable(path.relative(repoRoot, catalogPath)),
    publicEntrypoints: catalogPublic,
    runtimeSurfacePublicSkills: runtimePublic,
    sourceSkillCount: sourceSkillDirs.length,
    standalone: standaloneCatalogReport,
    findings,
  };
};

const parseArgs = (argv) => {
  const options = { json: false, runPackageDryRun: true };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') {
      options.json = true;
    } else if (arg === '--repo-root') {
      options.repoRoot = path.resolve(argv[++index]);
    } else if (arg === '--catalog') {
      options.catalogPath = path.resolve(argv[++index]);
    } else if (arg === '--runtime-surface') {
      options.runtimeSurfacePath = path.resolve(argv[++index]);
    } else if (arg === '--package-contract') {
      options.packageContractPath = path.resolve(argv[++index]);
    } else if (arg === '--skip-package-dry-run') {
      options.runPackageDryRun = false;
    } else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node scripts/catalog-check.mjs [--json] [--repo-root <dir>] [--catalog <file>] [--runtime-surface <file>] [--package-contract <file>] [--skip-package-dry-run]');
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
};

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  checkCatalog(parseArgs(process.argv.slice(2))).then((result) => {
    if (process.argv.includes('--json')) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`${result.status}: ${result.publicEntrypoints.length} public entrypoints checked`);
      for (const item of result.findings) {
        console.log(`[${item.severity}] ${item.code}: ${item.message}`);
      }
    }
    process.exit(result.status === 'pass' ? 0 : 2);
  }).catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}
