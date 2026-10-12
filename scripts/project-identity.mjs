#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitConfigValue, gitCurrentBranch } from './lib/git-safe.js';

const PROJECT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{1,126}[a-z0-9]$/;

export class ProjectIdentityError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ProjectIdentityError';
    this.code = code;
    this.details = details;
  }
}

export function accountStateRoot(env = process.env) {
  if (env.MOONSHOT_RELAY_STATE_ROOT) return path.resolve(env.MOONSHOT_RELAY_STATE_ROOT);
  if (env.CODEX_STATE_ROOT) return path.resolve(env.CODEX_STATE_ROOT);
  if (env.MOONSHOT_RELAY_HOME) return path.join(path.resolve(env.MOONSHOT_RELAY_HOME), 'state');
  const home = env.USERPROFILE || env.HOME || os.homedir();
  return path.join(home, '.moonshot-relay', 'state');
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
  if (PROJECT_ID_PATTERN.test(candidate)) return candidate;
  const safe = `${fallback}-${stableHash(candidate).slice(0, 8)}`;
  return safe.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '');
}

export function stableHash(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

export function pathHashId(cwd) {
  return `path-${stableHash(path.resolve(cwd).toLowerCase()).slice(0, 16)}`;
}

function localDisambiguatedId(value, cwd, fallback = 'project') {
  const base = sanitizeId(value, fallback);
  const localRoot = findGitRoot(cwd) || path.resolve(cwd);
  const suffix = stableHash(path.resolve(localRoot).toLowerCase()).slice(0, 8);
  const maxPrefixLength = 126 - suffix.length;
  const prefix = base
    .slice(0, Math.max(1, maxPrefixLength))
    .replace(/[-_.]+$/g, '') || fallback;
  return sanitizeId(`${prefix}-${suffix}`, fallback);
}

export function findUp(startDir, relativePath) {
  let current = path.resolve(startDir);
  while (true) {
    const candidate = path.join(current, relativePath);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) return '';
    current = parent;
  }
}

function parseYamlScalar(value) {
  const trimmed = String(value || '').trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  if (trimmed === '[]') return [];
  return trimmed;
}

export function parseProjectIdentityYaml(text) {
  const result = {};
  let activeArray = '';
  let activeObject = '';
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const noComment = rawLine.replace(/\s+#.*$/, '');
    if (!noComment.trim()) continue;
    const indent = noComment.match(/^\s*/)?.[0].length ?? 0;
    const line = noComment.trim();
    if (indent === 0 && line.endsWith(':')) {
      const key = line.slice(0, -1);
      if (key === 'aliases' || key === 'migratedFrom') {
        result[key] = [];
        activeArray = key;
        activeObject = '';
      } else {
        result[key] = {};
        activeObject = key;
        activeArray = '';
      }
      continue;
    }
    if (indent === 0) {
      const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
      if (!match) continue;
      result[match[1]] = parseYamlScalar(match[2]);
      activeArray = '';
      activeObject = '';
      continue;
    }
    if (activeArray && line.startsWith('- ')) {
      const item = line.slice(2).trim();
      if (item.includes(': ')) {
        const objectItem = {};
        const [key, ...rest] = item.split(':');
        objectItem[key.trim()] = parseYamlScalar(rest.join(':'));
        result[activeArray].push(objectItem);
      } else {
        result[activeArray].push(parseYamlScalar(item));
      }
      continue;
    }
    if (activeObject) {
      const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
      if (match) result[activeObject][match[1]] = parseYamlScalar(match[2]);
    }
  }
  return result;
}

export function readExplicitIdentity(cwd) {
  const identityPath = findUp(cwd, path.join('.claude', 'project.identity.yaml'));
  if (!identityPath) return null;
  const identity = parseProjectIdentityYaml(fs.readFileSync(identityPath, 'utf8'));
  if (!identity.projectId || !PROJECT_ID_PATTERN.test(identity.projectId)) {
    throw new ProjectIdentityError('project_identity_invalid', `Invalid projectId in ${identityPath}`, {
      path: identityPath,
      projectId: identity.projectId || ''
    });
  }
  return {
    ...identity,
    aliases: Array.isArray(identity.aliases) ? identity.aliases : [],
    migratedFrom: Array.isArray(identity.migratedFrom) ? identity.migratedFrom : [],
    identityPath
  };
}

export function findGitRoot(cwd) {
  const gitMarker = findUp(cwd, '.git');
  return gitMarker ? path.dirname(gitMarker) : '';
}

function readGitConfigRemote(gitRoot) {
  if (!gitRoot) return '';
  const configPath = path.join(gitRoot, '.git', 'config');
  if (!fs.existsSync(configPath)) return '';
  const text = fs.readFileSync(configPath, 'utf8');
  const remoteBlock = text.match(/\[remote "origin"\]([\s\S]*?)(?:\n\[|$)/);
  const urlMatch = remoteBlock?.[1]?.match(/^\s*url\s*=\s*(.+)$/m);
  return urlMatch?.[1]?.trim() || '';
}

export function gitRemoteUrl(cwd) {
  return gitConfigValue(cwd, 'remote.origin.url') || readGitConfigRemote(findGitRoot(cwd));
}

export function remoteSlug(remoteUrl) {
  const input = String(remoteUrl || '').trim().replace(/\.git$/i, '');
  if (!input) return '';
  const sshMatch = input.match(/[:/]([^/:]+\/[^/]+)$/);
  if (sshMatch) return sanitizeId(sshMatch[1]);
  try {
    const parsed = new URL(input);
    return sanitizeId(parsed.pathname.replace(/^\/+/, ''));
  } catch {
    return sanitizeId(input);
  }
}

export function packageName(cwd) {
  const packagePath = findUp(cwd, 'package.json');
  if (!packagePath) return '';
  try {
    const parsed = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
    return typeof parsed.name === 'string' ? parsed.name : '';
  } catch {
    return '';
  }
}

function readRegistry(registryPath) {
  if (!fs.existsSync(registryPath)) return { projects: [], aliases: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    return {
      projects: Array.isArray(parsed.projects) ? parsed.projects : [],
      aliases: parsed.aliases && typeof parsed.aliases === 'object' && !Array.isArray(parsed.aliases) ? parsed.aliases : {}
    };
  } catch (error) {
    throw new ProjectIdentityError('project_registry_invalid', `Invalid project registry JSON: ${registryPath}`, {
      path: registryPath,
      cause: error.message
    });
  }
}

function registryAliasIndex(registry) {
  const index = new Map();
  const add = (alias, projectId) => {
    if (!alias || !projectId) return;
    const key = String(alias).toLowerCase();
    if (!index.has(key)) index.set(key, new Set());
    index.get(key).add(projectId);
  };
  for (const [alias, projectId] of Object.entries(registry.aliases || {})) add(alias, projectId);
  for (const project of registry.projects || []) {
    for (const alias of project.aliases || []) add(alias, project.projectId);
    if (project.canonicalRemote?.slug) add(project.canonicalRemote.slug, project.projectId);
    if (project.canonicalRemote?.url) add(remoteSlug(project.canonicalRemote.url), project.projectId);
  }
  return index;
}

function registryProject(registry, projectId) {
  return (registry.projects || []).find((project) => project.projectId === projectId) || { projectId, aliases: [] };
}

function resolveRegistryAlias(registry, candidateAliases) {
  const index = registryAliasIndex(registry);
  for (const alias of candidateAliases.filter(Boolean)) {
    const ids = index.get(String(alias).toLowerCase());
    if (!ids) continue;
    if (ids.size > 1) {
      throw new ProjectIdentityError('project_identity_collision', `Registry alias maps to multiple project ids: ${alias}`, {
        alias,
        projectIds: [...ids].sort()
      });
    }
    return { identity: registryProject(registry, [...ids][0]), matchedAlias: alias };
  }
  return null;
}

function assertNoFallbackCollision(registry, projectId, source) {
  const projectIds = new Set((registry.projects || []).map((project) => project.projectId).filter(Boolean));
  if (projectIds.has(projectId)) {
    throw new ProjectIdentityError(
      'project_identity_collision',
      `Fallback ${source} projectId collides with registry projectId without an alias match: ${projectId}`,
      { projectId, source }
    );
  }
}

function currentBranch(cwd) {
  return gitCurrentBranch(cwd);
}

function namespaceFor(identity, cwd, env, options = {}) {
  const stateRoot = accountStateRoot(env);
  const gitRoot = findGitRoot(cwd) || path.resolve(cwd);
  const worktreeId = options.worktreeId || `wt-${stableHash(path.resolve(gitRoot).toLowerCase()).slice(0, 16)}`;
  const branchId = options.branchId || sanitizeId(currentBranch(cwd) || 'unknown-branch', 'branch');
  const runId = options.runId || env.HARNESS_RUN_ID || env.CODEX_RUN_ID || 'local-run';
  const projectRoot = path.join(stateRoot, 'projects', identity.projectId);
  const planningRoot = path.join(projectRoot, 'planning');
  const executionBaseRoot = path.join(projectRoot, 'execution');
  const worktreeRoot = path.join(executionBaseRoot, 'worktrees', worktreeId);
  const branchRoot = path.join(worktreeRoot, 'branches', branchId);
  const planExecutionRoot = path.join(branchRoot, 'plans');
  const runRoot = path.join(branchRoot, 'runs', runId);
  return {
    accountStateRoot: stateRoot,
    projectRoot,
    planningRoot,
    planningPackageRoot: path.join(planningRoot, 'packages'),
    knowledgeRoot: path.join(projectRoot, 'knowledge'),
    executionBaseRoot,
    worktreeRoot,
    branchRoot,
    planExecutionRoot,
    executionRoot: runRoot,
    worktreeId,
    branchId,
    runId,
    runRoot
  };
}

export function resolveProjectIdentity(options = {}) {
  const cwd = path.resolve(options.cwd || process.cwd());
  const env = options.env || process.env;
  const explicit = readExplicitIdentity(cwd);
  if (explicit) {
    const namespaces = namespaceFor(explicit, cwd, env, options);
    return { identity: explicit, source: 'explicit', cwd, namespaces };
  }

  const stateRoot = accountStateRoot(env);
  const registryPath = path.join(stateRoot, 'project-registry.json');
  const registry = readRegistry(registryPath);
  const gitRoot = findGitRoot(cwd);
  const remote = gitRemoteUrl(cwd);
  const slug = remoteSlug(remote);
  const pkgName = packageName(cwd);
  const rootBase = gitRoot ? path.basename(gitRoot) : '';
  const cwdBase = path.basename(cwd);
  const aliases = [slug, remote, pkgName, sanitizeId(pkgName), rootBase, sanitizeId(rootBase), cwdBase, sanitizeId(cwdBase)];

  const registryMatch = resolveRegistryAlias(registry, aliases);
  if (registryMatch) {
    const identity = {
      projectId: registryMatch.identity.projectId,
      aliases: registryMatch.identity.aliases || [],
      canonicalRemote: registryMatch.identity.canonicalRemote,
      owner: registryMatch.identity.owner,
      createdAt: registryMatch.identity.createdAt,
      migratedFrom: registryMatch.identity.migratedFrom || [],
      registryPath,
      matchedAlias: registryMatch.matchedAlias
    };
    const namespaces = namespaceFor(identity, cwd, env, options);
    return { identity, source: 'registry-alias', cwd, namespaces };
  }

  const fallbackCandidates = [
    ['git-remote-slug', slug],
    ['package-name-local', pkgName ? localDisambiguatedId(pkgName, cwd, 'package') : ''],
    ['git-root-basename-local', rootBase ? localDisambiguatedId(rootBase, cwd, 'project') : ''],
    ['path-hash', pathHashId(cwd)]
  ].filter(([, value]) => value && PROJECT_ID_PATTERN.test(value));

  for (const [source, projectId] of fallbackCandidates) {
    assertNoFallbackCollision(registry, projectId, source);
    const identity = {
      projectId,
      aliases: aliases.filter(Boolean),
      canonicalRemote: remote ? { url: remote, slug } : undefined,
      createdAt: null,
      migratedFrom: []
    };
    const namespaces = namespaceFor(identity, cwd, env, options);
    return { identity, source, cwd, namespaces };
  }

  const identity = { projectId: pathHashId(cwd), aliases: [], createdAt: null, migratedFrom: [] };
  const namespaces = namespaceFor(identity, cwd, env, options);
  return { identity, source: 'path-hash', cwd, namespaces };
}

function parseArgs(argv) {
  const args = { cwd: process.cwd(), json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === '--cwd') args.cwd = argv[++index] || args.cwd;
    else if (item.startsWith('--cwd=')) args.cwd = item.slice('--cwd='.length);
    else if (item === '--json') args.json = true;
    else if (item === '--run-id') args.runId = argv[++index] || '';
    else if (item.startsWith('--run-id=')) args.runId = item.slice('--run-id='.length);
    else if (item === '--help' || item === '-h') args.help = true;
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node project-identity.mjs [--cwd <path>] [--run-id <id>] [--json]

Resolves project identity and account-root namespaces without writing account-root state.`);
}

function cli() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  try {
    const resolved = resolveProjectIdentity({ cwd: args.cwd, runId: args.runId });
    if (args.json) {
      console.log(JSON.stringify(resolved, null, 2));
      return;
    }
    console.log(`${resolved.identity.projectId} ${resolved.namespaces.knowledgeRoot}`);
  } catch (error) {
    const payload = {
      ok: false,
      code: error.code || 'project_identity_error',
      message: error.message,
      details: error.details || {}
    };
    if (args.json) console.error(JSON.stringify(payload, null, 2));
    else console.error(`${payload.code}: ${payload.message}`);
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) cli();
