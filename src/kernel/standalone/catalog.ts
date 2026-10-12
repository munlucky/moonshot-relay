import { access, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { sha256Hex } from '../../shared/candidate-identity.js';

type UnknownRecord = Record<string, unknown>;

interface StandaloneCli extends UnknownRecord {
  enabled?: unknown;
  binName?: unknown;
}

export interface StandaloneCatalogEntry extends UnknownRecord {
  name?: unknown;
  kind?: unknown;
  defaultEnabled?: unknown;
  skillPath?: unknown;
  entrypoint?: unknown;
  exportName?: unknown;
  cli?: StandaloneCli | null;
  requiresKernelRun?: unknown;
  mayMutateSource?: unknown;
  mayMutateGit?: unknown;
  mayMutateKnowledge?: unknown;
  mayWriteArtifacts?: unknown;
  requiresExplicitApprovalForKnowledgeWrite?: unknown;
  permissions?: unknown;
  authority?: unknown;
}

interface StandaloneCatalog extends UnknownRecord {
  schemaVersion?: unknown;
  catalogId?: unknown;
  skills?: StandaloneCatalogEntry[];
  entries?: StandaloneCatalogEntry[];
}

interface StandaloneFinding extends UnknownRecord {
  severity: 'blocking';
  code: string;
  message: string;
  skill?: string | null;
}

interface CatalogValidation {
  status: 'pass' | 'fail';
  findings: StandaloneFinding[];
  entries: StandaloneCatalogEntry[];
}

interface StandaloneCatalogError extends Error {
  code: string;
  findings: StandaloneFinding[];
}

export const STANDALONE_CATALOG_SCHEMA_VERSION = 2;
export const STANDALONE_CATALOG_REL = 'catalog/standalone-skills.json';
export const STANDALONE_LOCK_REL = 'package/kernel/standalone-skills.lock.json';
export const STANDALONE_KINDS = Object.freeze([
  'analysis-utility',
  'project-utility',
  'prework-utility',
] as const);

const NAME_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const BIN_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const SIDE_EFFECT_FIELDS = Object.freeze([
  'requiresKernelRun',
  'mayMutateSource',
  'mayMutateGit',
  'mayMutateKnowledge',
  'mayWriteArtifacts',
] as const);

const isObject = (value: unknown): value is UnknownRecord => Boolean(
  value && typeof value === 'object' && !Array.isArray(value),
);

const recordOf = (value: unknown): UnknownRecord => (
  isObject(value) ? value : {}
);

const catalogOf = (value: unknown): StandaloneCatalog => (
  isObject(value) ? value as StandaloneCatalog : {}
);

const entryOf = (value: unknown): StandaloneCatalogEntry | null => (
  isObject(value) ? value as StandaloneCatalogEntry : null
);

const cliOf = (value: unknown): StandaloneCli | null => (
  isObject(value) ? value as StandaloneCli : null
);

const stringList = (value: unknown): string[] => (
  Array.isArray(value) ? value.map(String) : []
);

const portable = (value: unknown): string => (
  String(value || '').replaceAll('\\', '/')
);

const isRelative = (value: unknown): boolean => {
  const normalized = portable(value);
  return Boolean(normalized)
    && !normalized.startsWith('/')
    && !/^[a-zA-Z]:\//.test(normalized)
    && normalized !== '.'
    && !normalized.split('/').includes('..');
};

const finding = (
  code: string,
  message: string,
  entry: StandaloneCatalogEntry | null = null,
  details: UnknownRecord = {},
): StandaloneFinding => ({
  severity: 'blocking',
  code,
  message,
  ...(entry ? { skill: entry.name ? String(entry.name) : null } : {}),
  ...details,
});

export const catalogEntries = (
  catalogValue: unknown = {},
): StandaloneCatalogEntry[] => {
  const catalog = catalogOf(catalogValue);
  if (Array.isArray(catalog.skills)) return catalog.skills;
  if (Array.isArray(catalog.entries)) return catalog.entries;
  return [];
};

export function validateStandaloneCatalog(
  catalogValue: unknown = {},
): CatalogValidation {
  if (!isObject(catalogValue)) {
    return {
      status: 'fail',
      findings: [
        finding(
          'catalog_not_object',
          'Standalone catalog must be an object.',
        ),
      ],
      entries: [],
    };
  }

  const catalog = catalogOf(catalogValue);
  const findings: StandaloneFinding[] = [];
  if (catalog.schemaVersion !== STANDALONE_CATALOG_SCHEMA_VERSION) {
    findings.push(finding(
      'invalid_schema_version',
      `Standalone catalog schemaVersion must be ${STANDALONE_CATALOG_SCHEMA_VERSION}.`,
      null,
      { actual: catalog.schemaVersion },
    ));
  }

  const entries = catalogEntries(catalog);
  if (entries.length === 0) {
    findings.push(finding(
      'missing_entries',
      'Standalone catalog must contain a non-empty skills array.',
    ));
  }

  const names = new Map<string, number>();
  const bins = new Map<string, string>();

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entryOf(entries[index]);
    if (!entry) {
      findings.push(finding(
        'invalid_entry',
        'Standalone catalog entries must be objects.',
      ));
      continue;
    }

    const name = String(entry.name || '');
    if (!NAME_RE.test(name)) {
      findings.push(finding(
        'invalid_name',
        `Invalid standalone name: ${name || '<missing>'}.`,
        entry,
      ));
    }
    if (names.has(name)) {
      findings.push(finding(
        'duplicate_name',
        `Duplicate standalone name: ${name}.`,
        entry,
        { firstIndex: names.get(name) },
      ));
    } else {
      names.set(name, index);
    }

    if (
      !(STANDALONE_KINDS as readonly unknown[]).includes(entry.kind)
    ) {
      findings.push(finding(
        'unknown_kind',
        `Unknown standalone kind: ${String(entry.kind || '<missing>')}.`,
        entry,
      ));
    }
    if (
      entry.defaultEnabled !== undefined
      && typeof entry.defaultEnabled !== 'boolean'
    ) {
      findings.push(finding(
        'invalid_default_enabled',
        'defaultEnabled must be boolean.',
        entry,
      ));
    }
    if (
      !isRelative(entry.skillPath)
      || !portable(entry.skillPath).startsWith('skills/')
    ) {
      findings.push(finding(
        'missing_or_invalid_skill_path',
        'skillPath must be a relative skills/<name> path.',
        entry,
      ));
    }
    if (
      !isRelative(entry.entrypoint)
      || !portable(entry.entrypoint).endsWith('.mjs')
    ) {
      findings.push(finding(
        'missing_or_invalid_entrypoint',
        'entrypoint must be a relative .mjs path.',
        entry,
      ));
    }
    if (
      !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(String(entry.exportName || ''))
    ) {
      findings.push(finding(
        'missing_or_invalid_export',
        'exportName must name the catalog materialized entrypoint export.',
        entry,
      ));
    }
    if (portable(entry.skillPath) !== `skills/${name}`) {
      findings.push(finding(
        'skill_path_name_mismatch',
        `skillPath must be skills/${name}.`,
        entry,
      ));
    }

    for (const field of SIDE_EFFECT_FIELDS) {
      if (typeof entry[field] !== 'boolean') {
        findings.push(finding(
          'invalid_side_effect_flag',
          `${field} must be boolean.`,
          entry,
        ));
      }
    }
    if (
      entry.mayMutateSource === true
      && entry.requiresKernelRun !== true
    ) {
      findings.push(finding(
        'source_mutation_without_kernel',
        'mayMutateSource=true requires requiresKernelRun=true.',
        entry,
      ));
    }
    if (
      entry.mayMutateKnowledge === true
      && entry.requiresExplicitApprovalForKnowledgeWrite !== true
    ) {
      findings.push(finding(
        'knowledge_write_without_approval',
        'Knowledge mutation requires explicit approval metadata.',
        entry,
      ));
    }
    if (
      entry.mayWriteArtifacts !== true
      && entry.kind === 'analysis-utility'
    ) {
      findings.push(finding(
        'analysis_without_artifact_boundary',
        'Analysis utilities must declare mayWriteArtifacts=true.',
        entry,
      ));
    }

    const cli = cliOf(entry.cli) || { enabled: false };
    if (typeof cli.enabled !== 'boolean') {
      findings.push(finding(
        'invalid_cli_descriptor',
        'cli.enabled must be boolean.',
        entry,
      ));
    } else if (cli.enabled) {
      if (!BIN_RE.test(String(cli.binName || ''))) {
        findings.push(finding(
          'invalid_bin_name',
          'Enabled CLI entries require a valid binName.',
          entry,
        ));
      }
      const binName = String(cli.binName || '');
      if (bins.has(binName)) {
        findings.push(finding(
          'duplicate_bin_name',
          `Duplicate CLI binName: ${binName}.`,
          entry,
          { firstSkill: bins.get(binName) },
        ));
      } else {
        bins.set(binName, name);
      }
    }
  }

  return {
    status: findings.length === 0 ? 'pass' : 'fail',
    findings,
    entries,
  };
}

export async function validateStandaloneCatalogSources(
  catalog: unknown,
  { repoRoot = process.cwd() }: { repoRoot?: string } = {},
): Promise<CatalogValidation> {
  const result = validateStandaloneCatalog(catalog);
  const findings = [...result.findings];
  for (const entry of result.entries) {
    for (const rel of [entry.skillPath, entry.entrypoint]) {
      const absolute = path.resolve(repoRoot, String(rel || ''));
      try {
        await access(absolute);
      } catch {
        findings.push(finding(
          'source_missing',
          `Catalog source is missing: ${portable(rel)}.`,
          entry,
          { path: portable(rel) },
        ));
      }
    }
  }
  return {
    ...result,
    status: findings.length === 0 ? 'pass' : 'fail',
    findings,
  };
}

export async function loadStandaloneCatalog({
  repoRoot = process.cwd(),
  catalogPath = null,
  validateSources = false,
}: {
  repoRoot?: string;
  catalogPath?: string | null;
  validateSources?: boolean;
} = {}): Promise<StandaloneCatalog & { skills: StandaloneCatalogEntry[] }> {
  const resolvedPath = catalogPath
    ? path.resolve(catalogPath)
    : path.join(path.resolve(repoRoot), STANDALONE_CATALOG_REL);
  const catalog = catalogOf(
    JSON.parse(await readFile(resolvedPath, 'utf8')),
  );
  const validation = validateSources
    ? await validateStandaloneCatalogSources(catalog, { repoRoot })
    : validateStandaloneCatalog(catalog);

  if (validation.status !== 'pass') {
    const error = new Error(
      `STANDALONE_CATALOG_INVALID: ${validation.findings
        .map((item) => item.code)
        .join(', ')}`,
    ) as StandaloneCatalogError;
    error.code = 'STANDALONE_CATALOG_INVALID';
    error.findings = validation.findings;
    throw error;
  }
  return { ...catalog, skills: validation.entries };
}

export const standaloneDescriptors = (
  catalog: unknown,
  { enabledOnly = false }: { enabledOnly?: boolean } = {},
) => catalogEntries(catalog)
  .filter((entry) => !enabledOnly || entry.defaultEnabled !== false)
  .map((entry) => ({
    ...entry,
    name: String(entry.name || ''),
    kind: String(entry.kind || ''),
    skillPath: portable(entry.skillPath),
    entrypoint: portable(entry.entrypoint),
    exportName: String(entry.exportName || ''),
    authority: entry.authority ? String(entry.authority) : null,
    cli: cliOf(entry.cli) ? { ...cliOf(entry.cli) } : { enabled: false },
  }));

export const standaloneEntry = (
  catalog: unknown,
  name: string,
) => standaloneDescriptors(catalog)
  .find((entry) => entry.name === name)
  || null;

export const standaloneBinMap = (
  catalog: unknown,
  { enabledOnly = true }: { enabledOnly?: boolean } = {},
) => Object.fromEntries(
  standaloneDescriptors(catalog, { enabledOnly })
    .filter((entry) => entry.cli?.enabled)
    .map((entry) => [
      String(entry.cli?.binName || ''),
      entry.entrypoint,
    ]),
);

export async function buildStandaloneLock({
  repoRoot = process.cwd(),
  catalog = null,
  sourceCommit = '',
  generatedAt = new Date().toISOString(),
}: {
  repoRoot?: string;
  catalog?: unknown;
  sourceCommit?: string;
  generatedAt?: string;
} = {}) {
  const resolvedCatalog = catalog
    || await loadStandaloneCatalog({ repoRoot, validateSources: true });
  const catalogRecord = recordOf(resolvedCatalog);
  const entries = standaloneDescriptors(resolvedCatalog);
  const skills: UnknownRecord[] = [];

  for (const entry of entries) {
    const skillPath = String(entry.skillPath || '');
    const entrypoint = String(entry.entrypoint || '');
    const skillText = await readFile(
      path.join(repoRoot, skillPath, 'SKILL.md'),
      'utf8',
    );
    const executableText = await readFile(
      path.join(repoRoot, entrypoint),
      'utf8',
    );
    skills.push({
      name: entry.name,
      kind: entry.kind,
      skillPath,
      entrypoint,
      exportName: entry.exportName,
      contentHash: sha256Hex(
        `${skillText}\n---ENTRYPOINT---\n${executableText}`,
      ),
      cli: entry.cli || { enabled: false },
      requiresKernelRun: entry.requiresKernelRun,
      mayMutateSource: entry.mayMutateSource,
      mayMutateGit: entry.mayMutateGit,
      mayMutateKnowledge: entry.mayMutateKnowledge,
      mayWriteArtifacts: entry.mayWriteArtifacts,
      permissions: stringList(entry.permissions),
    });
  }

  return {
    schemaVersion: 2,
    scope: 'kernel-standalone',
    catalogId: catalogRecord.catalogId,
    catalogDigest: sha256Hex(resolvedCatalog),
    generatedAt,
    sourceCommit: sourceCommit || null,
    skills,
  };
}

export async function writeStandaloneLock({
  repoRoot = process.cwd(),
  outputPath = null,
  ...options
}: {
  repoRoot?: string;
  outputPath?: string | null;
  catalog?: unknown;
  sourceCommit?: string;
  generatedAt?: string;
} = {}) {
  const lock = await buildStandaloneLock({ repoRoot, ...options });
  const target = outputPath
    ? path.resolve(outputPath)
    : path.join(path.resolve(repoRoot), STANDALONE_LOCK_REL);
  await writeFile(
    target,
    `${JSON.stringify(lock, null, 2)}\n`,
    'utf8',
  );
  return { path: target, lock };
}
