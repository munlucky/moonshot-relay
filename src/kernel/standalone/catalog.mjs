import { access, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { sha256Hex } from '../../shared/candidate-identity.mjs';

export const STANDALONE_CATALOG_SCHEMA_VERSION = 2;
export const STANDALONE_CATALOG_REL = 'catalog/standalone-skills.json';
export const STANDALONE_LOCK_REL = 'package/kernel/standalone-skills.lock.json';
export const STANDALONE_KINDS = Object.freeze([
  'analysis-utility',
  'project-utility',
  'prework-utility',
]);

const NAME_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const BIN_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const SIDE_EFFECT_FIELDS = Object.freeze([
  'requiresKernelRun',
  'mayMutateSource',
  'mayMutateGit',
  'mayMutateKnowledge',
  'mayWriteArtifacts',
]);

const portable = (value) => String(value || '').replaceAll('\\', '/');
const isRelative = (value) => {
  const normalized = portable(value);
  return Boolean(normalized)
    && !normalized.startsWith('/')
    && !/^[a-zA-Z]:\//.test(normalized)
    && normalized !== '.'
    && !normalized.split('/').includes('..');
};

const finding = (code, message, entry = null, details = {}) => ({
  severity: 'blocking',
  code,
  message,
  ...(entry ? { skill: entry.name || null } : {}),
  ...details,
});

export const catalogEntries = (catalog = {}) => (
  Array.isArray(catalog.skills) ? catalog.skills
    : Array.isArray(catalog.entries) ? catalog.entries
      : []
);

export function validateStandaloneCatalog(catalog = {}) {
  const findings = [];
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) {
    return { status: 'fail', findings: [finding('catalog_not_object', 'Standalone catalog must be an object.')], entries: [] };
  }
  if (catalog.schemaVersion !== STANDALONE_CATALOG_SCHEMA_VERSION) {
    findings.push(finding('invalid_schema_version', `Standalone catalog schemaVersion must be ${STANDALONE_CATALOG_SCHEMA_VERSION}.`, null, { actual: catalog.schemaVersion }));
  }
  const entries = catalogEntries(catalog);
  if (entries.length === 0) findings.push(finding('missing_entries', 'Standalone catalog must contain a non-empty skills array.'));

  const names = new Map();
  const bins = new Map();
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      findings.push(finding('invalid_entry', 'Standalone catalog entries must be objects.'));
      continue;
    }
    const name = String(entry.name || '');
    if (!NAME_RE.test(name)) findings.push(finding('invalid_name', `Invalid standalone name: ${name || '<missing>'}.`, entry));
    if (names.has(name)) findings.push(finding('duplicate_name', `Duplicate standalone name: ${name}.`, entry, { firstIndex: names.get(name) }));
    else names.set(name, entries.indexOf(entry));

    if (!STANDALONE_KINDS.includes(entry.kind)) findings.push(finding('unknown_kind', `Unknown standalone kind: ${entry.kind || '<missing>'}.`, entry));
    if (entry.defaultEnabled !== undefined && typeof entry.defaultEnabled !== 'boolean') findings.push(finding('invalid_default_enabled', 'defaultEnabled must be boolean.', entry));
    if (!isRelative(entry.skillPath) || !portable(entry.skillPath).startsWith('skills/')) findings.push(finding('missing_or_invalid_skill_path', 'skillPath must be a relative skills/<name> path.', entry));
    if (!isRelative(entry.entrypoint) || !portable(entry.entrypoint).endsWith('.mjs')) findings.push(finding('missing_or_invalid_entrypoint', 'entrypoint must be a relative .mjs path.', entry));
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(String(entry.exportName || ''))) findings.push(finding('missing_or_invalid_export', 'exportName must name the catalog materialized entrypoint export.', entry));
    if (portable(entry.skillPath) !== `skills/${name}`) findings.push(finding('skill_path_name_mismatch', `skillPath must be skills/${name}.`, entry));

    for (const field of SIDE_EFFECT_FIELDS) {
      if (typeof entry[field] !== 'boolean') findings.push(finding('invalid_side_effect_flag', `${field} must be boolean.`, entry));
    }
    if (entry.mayMutateSource === true && entry.requiresKernelRun !== true) {
      findings.push(finding('source_mutation_without_kernel', 'mayMutateSource=true requires requiresKernelRun=true.', entry));
    }
    if (entry.mayMutateKnowledge === true && entry.requiresExplicitApprovalForKnowledgeWrite !== true) {
      findings.push(finding('knowledge_write_without_approval', 'Knowledge mutation requires explicit approval metadata.', entry));
    }
    if (entry.mayWriteArtifacts !== true && entry.kind === 'analysis-utility') {
      findings.push(finding('analysis_without_artifact_boundary', 'Analysis utilities must declare mayWriteArtifacts=true.', entry));
    }

    const cli = entry.cli || { enabled: false };
    if (typeof cli !== 'object' || Array.isArray(cli) || typeof cli.enabled !== 'boolean') {
      findings.push(finding('invalid_cli_descriptor', 'cli.enabled must be boolean.', entry));
    } else if (cli.enabled) {
      if (!BIN_RE.test(String(cli.binName || ''))) findings.push(finding('invalid_bin_name', 'Enabled CLI entries require a valid binName.', entry));
      const binName = String(cli.binName || '');
      if (bins.has(binName)) findings.push(finding('duplicate_bin_name', `Duplicate CLI binName: ${binName}.`, entry, { firstSkill: bins.get(binName) }));
      else bins.set(binName, name);
    }
  }
  return { status: findings.length === 0 ? 'pass' : 'fail', findings, entries };
}

export async function validateStandaloneCatalogSources(catalog, { repoRoot = process.cwd() } = {}) {
  const result = validateStandaloneCatalog(catalog);
  const findings = [...result.findings];
  for (const entry of result.entries) {
    for (const rel of [entry.skillPath, entry.entrypoint]) {
      const absolute = path.resolve(repoRoot, rel);
      try {
        await access(absolute);
      } catch {
        findings.push(finding('source_missing', `Catalog source is missing: ${portable(rel)}.`, entry, { path: portable(rel) }));
      }
    }
  }
  return { ...result, status: findings.length === 0 ? 'pass' : 'fail', findings };
}

export async function loadStandaloneCatalog({ repoRoot = process.cwd(), catalogPath = null, validateSources = false } = {}) {
  const resolvedPath = catalogPath ? path.resolve(catalogPath) : path.join(path.resolve(repoRoot), STANDALONE_CATALOG_REL);
  const catalog = JSON.parse(await readFile(resolvedPath, 'utf8'));
  const validation = validateSources
    ? await validateStandaloneCatalogSources(catalog, { repoRoot })
    : validateStandaloneCatalog(catalog);
  if (validation.status !== 'pass') {
    const error = new Error(`STANDALONE_CATALOG_INVALID: ${validation.findings.map((item) => item.code).join(', ')}`);
    error.code = 'STANDALONE_CATALOG_INVALID';
    error.findings = validation.findings;
    throw error;
  }
  return { ...catalog, skills: validation.entries };
}

export const standaloneDescriptors = (catalog, { enabledOnly = false } = {}) => catalogEntries(catalog)
  .filter((entry) => !enabledOnly || entry.defaultEnabled !== false)
  .map((entry) => ({
    ...entry,
    skillPath: portable(entry.skillPath),
    entrypoint: portable(entry.entrypoint),
    exportName: entry.exportName,
    cli: entry.cli ? { ...entry.cli } : { enabled: false },
  }));

export const standaloneEntry = (catalog, name) => standaloneDescriptors(catalog).find((entry) => entry.name === name) || null;

export const standaloneBinMap = (catalog, { enabledOnly = true } = {}) => Object.fromEntries(
  standaloneDescriptors(catalog, { enabledOnly })
    .filter((entry) => entry.cli?.enabled)
    .map((entry) => [entry.cli.binName, entry.entrypoint]),
);

export async function buildStandaloneLock({ repoRoot = process.cwd(), catalog = null, sourceCommit = '', generatedAt = new Date().toISOString() } = {}) {
  const resolvedCatalog = catalog || await loadStandaloneCatalog({ repoRoot, validateSources: true });
  const entries = standaloneDescriptors(resolvedCatalog);
  const skills = [];
  for (const entry of entries) {
    const skillText = await readFile(path.join(repoRoot, entry.skillPath, 'SKILL.md'), 'utf8');
    const executableText = await readFile(path.join(repoRoot, entry.entrypoint), 'utf8');
    skills.push({
      name: entry.name,
      kind: entry.kind,
      skillPath: entry.skillPath,
      entrypoint: entry.entrypoint,
      exportName: entry.exportName,
      contentHash: sha256Hex(`${skillText}\n---ENTRYPOINT---\n${executableText}`),
      cli: entry.cli || { enabled: false },
      requiresKernelRun: entry.requiresKernelRun,
      mayMutateSource: entry.mayMutateSource,
      mayMutateGit: entry.mayMutateGit,
      mayMutateKnowledge: entry.mayMutateKnowledge,
      mayWriteArtifacts: entry.mayWriteArtifacts,
      permissions: [...(entry.permissions || [])],
    });
  }
  return {
    schemaVersion: 2,
    scope: 'kernel-standalone',
    catalogId: resolvedCatalog.catalogId,
    catalogDigest: sha256Hex(resolvedCatalog),
    generatedAt,
    sourceCommit: sourceCommit || null,
    skills,
  };
}

export async function writeStandaloneLock({ repoRoot = process.cwd(), outputPath = null, ...options } = {}) {
  const lock = await buildStandaloneLock({ repoRoot, ...options });
  const target = outputPath ? path.resolve(outputPath) : path.join(path.resolve(repoRoot), STANDALONE_LOCK_REL);
  await writeFile(target, `${JSON.stringify(lock, null, 2)}\n`, 'utf8');
  return { path: target, lock };
}
