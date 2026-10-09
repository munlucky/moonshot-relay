#!/usr/bin/env node
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gitConfigValue } from '../shared/git-safe.mjs';
import { resolveKernelRuntimeHome } from './runtime-home.mjs';

const PROJECT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{1,126}[a-z0-9]$/;
const WINDOWS_RESERVED_PROJECT_ID = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const isMaterializableProjectId = (value) => PROJECT_ID_PATTERN.test(value) && !WINDOWS_RESERVED_PROJECT_ID.test(value);

export class KernelProjectIdentityError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'KernelProjectIdentityError';
    this.code = code;
    this.details = details;
  }
}

export function sanitizeId(value, fallback = 'project') {
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

export function stableHash(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

// A persisted account alias is already an explicit project-to-root binding.
// Inspection must prefer that immutable project id instead of rejecting a
// legitimate checkout because its current root differs from the original row.
export function identityInspectionCanonicalRoot(identity = {}) {
  return identity.identitySource === 'account_alias_registry' ? null : identity.canonicalRoot;
}

export function pathHashId(cwd) {
  let root = path.resolve(cwd);
  try { root = fs.realpathSync(root); } catch {}
  return `path-${stableHash(root.toLowerCase()).slice(0, 16)}`;
}

export function findGitRoot(startDir) {
  let current = path.resolve(startDir);
  while (true) {
    if (fs.existsSync(path.join(current, '.git'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export function normalizeRemoteUrl(url) {
  if (!url) return '';
  let str = String(url).trim();
  str = str.replace(/^git@([^:]+):/, 'https://$1/');
  str = str.replace(/^ssh:\/\/git@([^/]+)\//, 'https://$1/');
  str = str.replace(/^git:\/\//, 'https://');
  str = str.replace(/\/+$/, '');
  str = str.replace(/\.git$/i, '');
  return str.toLowerCase();
}

export function parseProjectIdentityYaml(text) {
  const result = {};
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const noComment = rawLine.replace(/\s+#.*$/, '').trim();
    if (!noComment) continue;
    const parts = noComment.split(':');
    if (parts.length >= 2) {
      const key = parts[0].trim();
      const val = parts.slice(1).join(':').trim();
      if (key && val) {
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          result[key] = val.slice(1, -1);
        } else {
          result[key] = val;
        }
      }
    }
  }
  return result;
}

const normalizedRoot = (projectRoot) => {
  const resolved = path.resolve(projectRoot).replaceAll('\\', '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};

// The account registry predates the canonical forward-slash form and can be
// written by a different platform than the one reading it. Compare registry
// keys by path shape, not by the host platform's separator spelling.
const equivalentRegistryRoot = (value) => String(value || '')
  .replaceAll('\\', '/')
  .replace(/\/+$/, '')
  .toLowerCase();

const projectIdFromRemote = (normalized) => {
  const match = String(normalized || '').match(/^https?:\/\/([^/:?#]+)\/([^/?#]+)\/([^/?#]+)$/);
  if (!match) return null;
  const hostSlug = match[1].replace(/[^a-z0-9]/gi, '-');
  return sanitizeId(`${hostSlug}-${match[2]}-${match[3]}`);
};

const readOrigin = (projectRoot) => {
  let remoteUrl = gitConfigValue(projectRoot, 'remote.origin.url');
  if (!remoteUrl) {
    const gitConfigPath = path.join(projectRoot, '.git', 'config');
    if (fs.existsSync(gitConfigPath)) {
      try {
        const cfgText = fs.readFileSync(gitConfigPath, 'utf8');
        // Restrict the fallback parser to the origin section. A permissive
        // cross-section regex can accidentally treat a backup remote's URL as
        // this project's origin when the origin section has no URL.
        const originSection = cfgText
          .split(/(?=^\s*\[)/m)
          .find((section) => /^\s*\[remote\s+"origin"\]\s*$/im.test(section));
        const matchUrl = originSection?.match(/^\s*url\s*=\s*([^\r\n]+)$/im);
        if (matchUrl) remoteUrl = matchUrl[1].trim();
      } catch {}
    }
  }
  const normalized = normalizeRemoteUrl(remoteUrl);
  return { normalized, projectId: projectIdFromRemote(normalized) };
};

const readPersistedAlias = (kernelHome, projectRoot, alternateRoots = []) => {
  const aliasRegistryPath = path.join(kernelHome, 'state', 'project-aliases.json');
  if (!fs.existsSync(aliasRegistryPath)) return null;
  try {
    const registry = JSON.parse(fs.readFileSync(aliasRegistryPath, 'utf8'));
    // Older Windows registries used the native lower-cased backslash key,
    // while the current identity resolver uses a forward-slash canonical key.
    // Probe both forms in both the nested `roots` shape and the legacy direct
    // map so an existing immutable identity is never silently replaced by a
    // new path-derived namespace.
    const lookupRoots = [projectRoot, ...alternateRoots].filter(Boolean).map((root) => path.resolve(root));
    const rootKeys = [...new Set(lookupRoots.flatMap((root) => [
      normalizedRoot(root),
      root.toLowerCase(),
      root.replaceAll('/', '\\').toLowerCase(),
    ]))];
    const targetRoots = new Set(lookupRoots.map(equivalentRegistryRoot));
    const containers = [registry?.roots, registry];
    let entry = null;
    for (const container of containers) {
      if (!container || typeof container !== 'object') continue;
      entry = rootKeys.map((key) => container[key]).find(Boolean) || null;
      if (!entry) {
        const matchedKey = Object.keys(container)
          .find((key) => targetRoots.has(equivalentRegistryRoot(key)));
        entry = matchedKey ? container[matchedKey] : null;
      }
      if (entry) break;
    }
    if (!entry) return null;
    if (typeof entry === 'string') return { projectId: sanitizeId(entry), aliases: [], identitySource: 'account_alias_registry' };
    if (typeof entry !== 'object' || !entry.projectId) return null;
    return {
      projectId: sanitizeId(entry.projectId),
      aliases: Array.isArray(entry.aliases) ? entry.aliases.map(normalizeRemoteUrl).filter(Boolean) : [],
      identitySource: entry.identitySource || 'account_alias_registry',
    };
  } catch {
    return null;
  }
};

export function resolveKernelProjectIdentity({ cwd = process.cwd(), env = process.env } = {}) {
  const kernelHome = resolveKernelRuntimeHome({ env });

  const lexicalProjectRoot = findGitRoot(cwd) || path.resolve(cwd);
  let projectRoot = lexicalProjectRoot;
  try {
    if (fs.existsSync(lexicalProjectRoot)) projectRoot = fs.realpathSync(lexicalProjectRoot);
  } catch {
    projectRoot = lexicalProjectRoot;
  }
  const rootKey = normalizedRoot(projectRoot);

  // A remote alias can be copied into an unrelated checkout. The Git common
  // directory is repository-level proof that distinguishes legitimate
  // worktrees from a second repository with the same origin.
  let gitCommonDir = null;
  try {
    const result = spawnSync('git', ['rev-parse', '--git-common-dir'], {
      cwd: projectRoot,
      encoding: 'utf8',
    });
    if (result.status === 0 && result.stdout?.trim()) {
      gitCommonDir = fs.realpathSync(path.resolve(projectRoot, result.stdout.trim()));
    }
  } catch {
    gitCommonDir = null;
  }

  const aliases = [];
  const persisted = readPersistedAlias(kernelHome, projectRoot, [lexicalProjectRoot]);
  const origin = readOrigin(projectRoot);
  const localConfigPath = path.join(projectRoot, '.moon-relay', 'project.identity.yaml');
  let localProjectId = null;
  if (fs.existsSync(localConfigPath)) {
    try {
      const parsed = parseProjectIdentityYaml(fs.readFileSync(localConfigPath, 'utf8'));
      if (parsed.projectId) localProjectId = sanitizeId(parsed.projectId);
    } catch {}
  }

  // The workspace root is the first-run identity anchor. Origin, package name,
  // and the old remote-derived id are aliases only; adding origin must never
  // move a project into a new namespace after its first Kernel run. Keep the
  // prior persisted/path identities as explicit lineage candidates when a
  // local identity file supersedes them, otherwise their namespaces can be
  // orphaned without ever reaching the ownership checks in state-store.
  const primaryRepoRoot = gitCommonDir
    ? (path.basename(gitCommonDir).toLowerCase() === '.git' ? path.dirname(gitCommonDir) : gitCommonDir)
    : projectRoot;
  const pathDerivedProjectId = pathHashId(primaryRepoRoot);
  const projectId = localProjectId || persisted?.projectId || pathDerivedProjectId;
  const identitySource = localProjectId
    ? 'local_identity_file'
    : persisted?.identitySource || 'workspace_root';
  aliases.push(...(persisted?.aliases || []), origin.normalized);

  const packagePath = path.join(projectRoot, 'package.json');
  let packageProjectId = null;
  if (fs.existsSync(packagePath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
      if (pkg.name) packageProjectId = sanitizeId(pkg.name);
    } catch {}
  }
  const baseName = path.basename(projectRoot);
  const basenameProjectId = baseName && baseName !== '/' && baseName !== '.' ? sanitizeId(baseName) : null;
  const legacyAliases = [
    persisted?.projectId ? {
      projectId: persisted.projectId,
      source: 'persisted',
      aliasType: 'persisted-project-id',
      canonicalRoot: rootKey,
    } : null,
    pathDerivedProjectId ? {
      projectId: pathDerivedProjectId,
      source: 'path-hash',
      aliasType: 'path-derived',
      canonicalRoot: rootKey,
    } : null,
    origin.projectId ? { projectId: origin.projectId, source: 'origin', aliasType: 'remote-derived' } : null,
    packageProjectId ? { projectId: packageProjectId, source: 'package', aliasType: 'package-derived' } : null,
    basenameProjectId ? { projectId: basenameProjectId, source: 'basename', aliasType: 'basename-derived' } : null,
  ].filter((candidate) => candidate && candidate.projectId !== projectId);
  const legacyProjectIds = [...new Set(legacyAliases.map((candidate) => candidate.projectId))];

  const uniqueAliases = [...new Set(aliases.map(normalizeRemoteUrl).filter(Boolean))];
  // The digest is derived only from the immutable identity and canonical root,
  // never from the discovery source or mutable origin aliases.
  const identityDigest = stableHash(`${projectId}:${rootKey}`);

  const namespaces = {
    kernelStateRoot: path.join(kernelHome, 'state'),
    projectKnowledgeRoot: path.join(kernelHome, 'state', 'projects', projectId, 'knowledge'),
    planExecutionRoot: path.join(kernelHome, 'state', 'projects', projectId, 'execution'),
  };

  return {
    projectId,
    projectRoot,
    canonicalRoot: rootKey,
    identitySource,
    aliases: uniqueAliases,
    legacyProjectIds,
    legacyAliases,
    gitCommonDir: gitCommonDir ? normalizedRoot(gitCommonDir) : null,
    identityDigest,
    namespaces,
  };
}
