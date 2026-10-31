#!/usr/bin/env node
import { requiredIndex } from '../shared/required-index.js';
import { matchCapture } from '../shared/match-capture.js';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { gitConfigValue } from '../shared/git-safe.js';
import { resolveKernelRuntimeHome } from './runtime-home.js';

type UnknownRecord = Record<string, unknown>;

interface KernelProjectIdentityErrorDetails extends UnknownRecord {}

export class KernelProjectIdentityError extends Error {
  code: string;
  details: KernelProjectIdentityErrorDetails;

  constructor(
    code: string,
    message: string,
    details: KernelProjectIdentityErrorDetails = {},
  ) {
    super(message);
    this.name = 'KernelProjectIdentityError';
    this.code = code;
    this.details = details;
  }
}

interface ProjectIdentityYaml {
  [key: string]: string;
}

interface PersistedAlias {
  projectId: string;
  aliases: string[];
  identitySource: string;
}

interface LegacyAlias {
  projectId: string;
  source: string;
  aliasType: string;
  canonicalRoot?: string;
}

interface ResolveProjectIdentityInput {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

const PROJECT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{1,126}[a-z0-9]$/;
const WINDOWS_RESERVED_PROJECT_ID = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

const isMaterializableProjectId = (value: string): boolean => (
  PROJECT_ID_PATTERN.test(value)
  && !WINDOWS_RESERVED_PROJECT_ID.test(value)
);

export function stableHash(value: unknown): string {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

export function sanitizeId(
  value: unknown,
  fallback = 'project',
): string {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\\/g, '/')
    .replace(/\.git$/i, '')
    .replace(/[^a-z0-9._/-]+/g, '-')
    .replace(/[\/]+/g, '-')
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '')
    .replace(/[-_.]{2,}/g, '-');
  const candidate = normalized || fallback;
  if (isMaterializableProjectId(candidate)) return candidate;
  const safe = `${fallback}-${stableHash(candidate).slice(0, 8)}`;
  return safe.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '');
}

// A persisted account alias is already an explicit project-to-root binding.
// Inspection must prefer that immutable project id instead of rejecting a
// legitimate checkout because its current root differs from the original row.
export function identityInspectionCanonicalRoot(
  identity: { identitySource?: unknown; canonicalRoot?: unknown } = {},
): string | null {
  return identity.identitySource === 'account_alias_registry'
    ? null
    : identity.canonicalRoot
      ? String(identity.canonicalRoot)
      : null;
}

export function pathHashId(cwd: string): string {
  let root = path.resolve(cwd);
  try {
    root = fs.realpathSync(root);
  } catch {
    // Preserve lexical path when the target is not materialized yet.
  }
  return `path-${stableHash(root.toLowerCase()).slice(0, 16)}`;
}

export function findGitRoot(startDir: string): string | null {
  let current = path.resolve(startDir);
  while (true) {
    if (fs.existsSync(path.join(current, '.git'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export function normalizeRemoteUrl(url: unknown): string {
  if (!url) return '';
  let str = String(url).trim();
  str = str.replace(/^git@([^:]+):/, 'https://$1/');
  str = str.replace(/^ssh:\/\/git@([^/]+)\//, 'https://$1/');
  str = str.replace(/^git:\/\//, 'https://');
  str = str.replace(/\/+$/, '');
  str = str.replace(/\.git$/i, '');
  return str.toLowerCase();
}

export function parseProjectIdentityYaml(text: unknown): ProjectIdentityYaml {
  const result: ProjectIdentityYaml = {};
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const noComment = rawLine.replace(/\s+#.*$/, '').trim();
    if (!noComment) continue;
    const parts = noComment.split(':');
    if (parts.length < 2) continue;
    const key = requiredIndex(parts, 0).trim();
    const val = parts.slice(1).join(':').trim();
    if (!key || !val) continue;
    result[key] = (
      (val.startsWith('"') && val.endsWith('"'))
      || (val.startsWith("'") && val.endsWith("'"))
    )
      ? val.slice(1, -1)
      : val;
  }
  return result;
}

const normalizedRoot = (projectRoot: string): string => {
  const resolved = path.resolve(projectRoot)
    .replaceAll('\\', '/')
    .replace(/\/+$/, '');
  return process.platform === 'win32'
    ? resolved.toLowerCase()
    : resolved;
};

const equivalentRegistryRoot = (value: unknown): string => (
  String(value || '')
    .replaceAll('\\', '/')
    .replace(/\/+$/, '')
    .toLowerCase()
);

const projectIdFromRemote = (normalized: string): string | null => {
  const match = String(normalized || '')
    .match(/^https?:\/\/([^/:?#]+)\/([^/?#]+)\/([^/?#]+)$/);
  if (!match) return null;
  const hostSlug = matchCapture(match, 1).replace(/[^a-z0-9]/gi, '-');
  return sanitizeId(`${hostSlug}-${matchCapture(match, 2)}-${matchCapture(match, 3)}`);
};

const readOrigin = (
  projectRoot: string,
): { normalized: string; projectId: string | null } => {
  let remoteUrl = gitConfigValue(projectRoot, 'remote.origin.url');
  if (!remoteUrl) {
    const gitConfigPath = path.join(projectRoot, '.git', 'config');
    if (fs.existsSync(gitConfigPath)) {
      try {
        const cfgText = fs.readFileSync(gitConfigPath, 'utf8');
        const originSection = cfgText
          .split(/(?=^\s*\[)/m)
          .find((section) => /^\s*\[remote\s+"origin"\]\s*$/im.test(section));
        const matchUrl = originSection
          ?.match(/^\s*url\s*=\s*([^\r\n]+)$/im);
        if (matchUrl) remoteUrl = matchCapture(matchUrl, 1).trim();
      } catch {
        // Git config fallback is best-effort.
      }
    }
  }
  const normalized = normalizeRemoteUrl(remoteUrl);
  return {
    normalized,
    projectId: projectIdFromRemote(normalized),
  };
};

const readPersistedAlias = (
  kernelHome: string,
  projectRoot: string,
  alternateRoots: string[] = [],
): PersistedAlias | null => {
  const aliasRegistryPath = path.join(
    kernelHome,
    'state',
    'project-aliases.json',
  );
  if (!fs.existsSync(aliasRegistryPath)) return null;
  try {
    const registry = JSON.parse(
      fs.readFileSync(aliasRegistryPath, 'utf8'),
    ) as UnknownRecord;
    const lookupRoots = [projectRoot, ...alternateRoots]
      .filter(Boolean)
      .map((root) => path.resolve(root));
    const rootKeys = [...new Set(lookupRoots.flatMap((root) => [
      normalizedRoot(root),
      root.toLowerCase(),
      root.replaceAll('/', '\\').toLowerCase(),
    ]))];
    const targetRoots = new Set(
      lookupRoots.map(equivalentRegistryRoot),
    );
    const nestedRoots = (
      registry.roots
      && typeof registry.roots === 'object'
      && !Array.isArray(registry.roots)
    )
      ? registry.roots as UnknownRecord
      : null;
    const containers = [nestedRoots, registry];

    let entry: unknown = null;
    for (const container of containers) {
      if (!container) continue;
      entry = rootKeys
        .map((key) => container[key])
        .find(Boolean) || null;
      if (!entry) {
        const matchedKey = Object.keys(container)
          .find((key) => targetRoots.has(equivalentRegistryRoot(key)));
        entry = matchedKey ? container[matchedKey] : null;
      }
      if (entry) break;
    }

    if (!entry) return null;
    if (typeof entry === 'string') {
      return {
        projectId: sanitizeId(entry),
        aliases: [],
        identitySource: 'account_alias_registry',
      };
    }
    if (
      typeof entry !== 'object'
      || Array.isArray(entry)
      || entry === null
      || !('projectId' in entry)
      || !(entry as UnknownRecord).projectId
    ) {
      return null;
    }
    const record = entry as UnknownRecord;
    return {
      projectId: sanitizeId(record.projectId),
      aliases: Array.isArray(record.aliases)
        ? record.aliases
          .map(normalizeRemoteUrl)
          .filter(Boolean)
        : [],
      identitySource: record.identitySource
        ? String(record.identitySource)
        : 'account_alias_registry',
    };
  } catch {
    return null;
  }
};

export function resolveKernelProjectIdentity({
  cwd = process.cwd(),
  env = process.env,
}: ResolveProjectIdentityInput = {}) {
  const kernelHome = resolveKernelRuntimeHome({ env });

  const lexicalProjectRoot = findGitRoot(cwd) || path.resolve(cwd);
  let projectRoot = lexicalProjectRoot;
  try {
    if (fs.existsSync(lexicalProjectRoot)) {
      projectRoot = fs.realpathSync(lexicalProjectRoot);
    }
  } catch {
    projectRoot = lexicalProjectRoot;
  }
  const rootKey = normalizedRoot(projectRoot);

  let gitCommonDir: string | null = null;
  try {
    const result = spawnSync(
      'git',
      ['rev-parse', '--git-common-dir'],
      {
        cwd: projectRoot,
        encoding: 'utf8',
      },
    );
    if (result.status === 0 && result.stdout?.trim()) {
      gitCommonDir = fs.realpathSync.native(
        path.resolve(projectRoot, result.stdout.trim()),
      );
    }
  } catch {
    gitCommonDir = null;
  }

  const aliases: string[] = [];
  const persisted = readPersistedAlias(
    kernelHome,
    projectRoot,
    [lexicalProjectRoot],
  );
  const origin = readOrigin(projectRoot);
  const localConfigPath = path.join(
    projectRoot,
    '.moon-relay',
    'project.identity.yaml',
  );
  let localProjectId: string | null = null;
  if (fs.existsSync(localConfigPath)) {
    try {
      const parsed = parseProjectIdentityYaml(
        fs.readFileSync(localConfigPath, 'utf8'),
      );
      if (parsed.projectId) {
        localProjectId = sanitizeId(parsed.projectId);
      }
    } catch {
      // Local identity parsing is best-effort.
    }
  }

  const primaryRepoRoot = gitCommonDir
    ? (
      path.basename(gitCommonDir).toLowerCase() === '.git'
        ? path.dirname(gitCommonDir)
        : gitCommonDir
    )
    : projectRoot;
  const pathDerivedProjectId = pathHashId(primaryRepoRoot);
  const projectId = localProjectId
    || persisted?.projectId
    || pathDerivedProjectId;
  const identitySource = localProjectId
    ? 'local_identity_file'
    : persisted?.identitySource || 'workspace_root';

  aliases.push(...(persisted?.aliases || []), origin.normalized);

  const packagePath = path.join(projectRoot, 'package.json');
  let packageProjectId: string | null = null;
  if (fs.existsSync(packagePath)) {
    try {
      const pkg = JSON.parse(
        fs.readFileSync(packagePath, 'utf8'),
      ) as { name?: unknown };
      if (pkg.name) packageProjectId = sanitizeId(pkg.name);
    } catch {
      // package.json name is only an alias candidate.
    }
  }

  const baseName = path.basename(projectRoot);
  const basenameProjectId = (
    baseName
    && baseName !== '/'
    && baseName !== '.'
  )
    ? sanitizeId(baseName)
    : null;

  const legacyAliases = [
    persisted?.projectId
      ? {
          projectId: persisted.projectId,
          source: 'persisted',
          aliasType: 'persisted-project-id',
          canonicalRoot: rootKey,
        }
      : null,
    pathDerivedProjectId
      ? {
          projectId: pathDerivedProjectId,
          source: 'path-hash',
          aliasType: 'path-derived',
          canonicalRoot: rootKey,
        }
      : null,
    origin.projectId
      ? {
          projectId: origin.projectId,
          source: 'origin',
          aliasType: 'remote-derived',
        }
      : null,
    packageProjectId
      ? {
          projectId: packageProjectId,
          source: 'package',
          aliasType: 'package-derived',
        }
      : null,
    basenameProjectId
      ? {
          projectId: basenameProjectId,
          source: 'basename',
          aliasType: 'basename-derived',
        }
      : null,
  ].filter(
    (candidate): candidate is LegacyAlias => (
      Boolean(candidate)
      && candidate?.projectId !== projectId
    ),
  );

  const legacyProjectIds = [
    ...new Set(
      legacyAliases.map((candidate) => candidate.projectId),
    ),
  ];
  const uniqueAliases = [
    ...new Set(
      aliases.map(normalizeRemoteUrl).filter(Boolean),
    ),
  ];
  const identityDigest = stableHash(
    `${projectId}:${rootKey}`,
  );

  const namespaces = {
    kernelStateRoot: path.join(kernelHome, 'state'),
    projectKnowledgeRoot: path.join(
      kernelHome,
      'state',
      'projects',
      projectId,
      'knowledge',
    ),
    planExecutionRoot: path.join(
      kernelHome,
      'state',
      'projects',
      projectId,
      'execution',
    ),
  };

  return {
    projectId,
    projectRoot,
    canonicalRoot: rootKey,
    identitySource,
    aliases: uniqueAliases,
    legacyProjectIds,
    legacyAliases,
    gitCommonDir: gitCommonDir
      ? normalizedRoot(gitCommonDir)
      : null,
    identityDigest,
    namespaces,
  };
}
