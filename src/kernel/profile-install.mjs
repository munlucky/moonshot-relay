import path from 'node:path';
import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { cp, lstat, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import { KERNEL_PROFILE_RUNTIMES } from './profile-build.mjs';
import { canonicalPath, resolveKernelRuntimeHome } from './runtime-home.mjs';
import { atomicWriteText } from './durable-write.mjs';
import { materializeKernelMcpLauncher } from './installer.mjs';
import { loadStandaloneCatalog, standaloneDescriptors } from './standalone/catalog.mjs';
import {
  PROFILE_OWNERSHIP,
  MANAGED_SECTION_ID,
  collectJsonPathOwnership,
  getJsonPath,
  inspectJsonOwnership,
  inspectManagedSection,
  isKernelHookEntry,
  mergeManagedSection,
  removeJsonOwnership,
  removeManagedSection,
  valueDigest,
} from './profile-projection.mjs';

export const PROFILE_PRODUCT_ID = 'moon-relay-kernel-profile';
export const PROFILE_MANIFEST_NAME = '.moon-relay-kernel-profile-manifest.json';
export const PROFILE_MARKER_NAME = '.moon-relay-kernel-profile.json';
const PROFILE_BACKUP_METADATA = new Set([PROFILE_MANIFEST_NAME, 'account-root-backup.json', 'preexisting.json']);
export const KERNEL_ENTRYPOINT_SKILL = 'moon-relay-kernel';
export const KERNEL_SKILL_INSTALL_REL = `skills/${KERNEL_ENTRYPOINT_SKILL}`;
export const ACCOUNT_ROOT_PROFILE_LAYOUT = 'account-root-direct';
export const LEGACY_RELAY_SKILL_NAMES = Object.freeze([
  'commit-moonshot',
  'moonshot-architecture',
  'moonshot-orchestrator',
  'moonshot-phase-runner',
  'moonshot-plan-writer',
  'moonshot-relay-setup',
  'product-orchestrator',
  'session-logger',
]);

export const canonicalKernelSkillDir = (sourceRoot) => path.resolve(sourceRoot, 'skills', KERNEL_ENTRYPOINT_SKILL);
export const canonicalStandaloneSkillDirs = async (sourceRoot) => {
  let catalog;
  try {
    catalog = await loadStandaloneCatalog({ repoRoot: sourceRoot, validateSources: true });
  } catch (error) {
    const missingCatalog = error?.code === 'ENOENT'
      && path.resolve(error.path || '') === path.resolve(sourceRoot, 'catalog', 'standalone-skills.json');
    if (!missingCatalog) throw error;
    return [];
  }
  return standaloneDescriptors(catalog, { enabledOnly: true })
    .map((entry) => ({ name: entry.name, dir: path.resolve(sourceRoot, entry.skillPath) }));
};

const exists = async (file) => {
  try { await stat(file); return true; } catch { return false; }
};
const sha256 = async (file) => createHash('sha256').update(await readFile(file)).digest('hex');
const atomicWrite = async (file, value) => atomicWriteText(file, value);
const copyTree = async (from, to) => {
  await mkdir(path.dirname(to), { recursive: true });
  await cp(from, to, { recursive: true, force: true });
};
const files = async (root, rel = '') => {
  const target = path.join(root, rel);
  if (!(await exists(target))) return [];
  const info = await stat(target);
  if (info.isFile()) return [rel.replaceAll('\\', '/')];
  const result = [];
  for (const entry of await readdir(target, { withFileTypes: true })) {
    result.push(...await files(root, path.join(rel, entry.name)));
  }
  return result;
};

const directorySnapshot = async (directory) => {
  const result = [];
  const visit = async (current, relative = '') => {
    await rejectSymlink(current);
    const info = await lstat(current);
    if (!info.isDirectory()) throw new Error('owned_directory_not_directory');
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const childRelative = path.join(relative, entry.name).replaceAll('\\', '/');
      const child = path.join(current, entry.name);
      await rejectSymlink(child);
      if (entry.isDirectory()) {
        await visit(child, childRelative);
      } else if (entry.isFile()) {
        result.push({ path: childRelative, checksum: await sha256(child) });
      } else {
        throw new Error(`owned_directory_entry_not_regular: ${childRelative}`);
      }
    }
  };
  await visit(directory);
  return result.sort((left, right) => left.path.localeCompare(right.path));
};

const directoryDigest = (snapshot) => createHash('sha256')
  .update(JSON.stringify(snapshot.map((entry) => ({ path: entry.path, checksum: entry.checksum }))))
  .digest('hex');

const inspectOwnedDirectory = async (root, entry) => {
  const directory = safeJoin(root, entry.path);
  if (!(await exists(directory))) return { status: 'missing' };
  await rejectSymlink(directory);
  let snapshot;
  try {
    snapshot = await directorySnapshot(directory);
  } catch (error) {
    return { status: 'collision', reason: error.code || error.message || 'owned-directory-invalid' };
  }

  const declaredChildren = Array.isArray(entry.children)
    ? entry.children
    : Array.isArray(entry.files) ? entry.files : null;
  if (declaredChildren) {
    const expected = declaredChildren.map((child) => {
      if (typeof child === 'string') return { path: child.replaceAll('\\', '/'), checksum: null };
      return { path: String(child?.path || '').replaceAll('\\', '/'), checksum: child?.checksum || child?.digest || null };
    });
    if (expected.some((child) => !child.path || !child.checksum)) {
      return { status: 'collision', reason: 'owned-directory-metadata-invalid' };
    }
    const expectedByPath = new Map(expected.map((child) => [child.path, child.checksum]));
    const actualByPath = new Map(snapshot.map((child) => [child.path, child.checksum]));
    if (expectedByPath.size !== actualByPath.size
      || [...expectedByPath].some(([relative, checksum]) => actualByPath.get(relative) !== checksum)) {
      return { status: 'collision', reason: 'modified-owned-directory' };
    }
  }
  if (entry.checksum && directoryDigest(snapshot) !== entry.checksum) {
    return { status: 'collision', reason: 'modified-owned-directory' };
  }
  if (!declaredChildren && !entry.checksum && snapshot.length > 0) {
    return { status: 'collision', reason: 'owned-directory-metadata-missing' };
  }
  return { status: 'ok', checksum: directoryDigest(snapshot), snapshot };
};

const COMMON_SYSTEM_SYMLINKS = new Set(['/tmp', '/var', '/etc']);
const normalizeWin32NamespacePath = (value) => {
  const raw = String(value || '');
  if (process.platform !== 'win32') return raw;
  if (raw.startsWith('\\\\?\\UNC\\')) return `\\\\${raw.slice('\\\\?\\UNC\\'.length)}`;
  if (raw.startsWith('\\\\?\\')) return raw.slice('\\\\?\\'.length);
  return raw;
};

const rejectSymlink = async (file) => {
  try {
    if ((await lstat(file)).isSymbolicLink()) throw new Error(`unsafe_target: symlink ${file}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
};

const safeProfileRoot = async (target, label = 'profile root') => {
  const lexical = path.resolve(normalizeWin32NamespacePath(target));
  let cursor = lexical;
  while (true) {
    try {
      if ((await lstat(cursor)).isSymbolicLink() && !COMMON_SYSTEM_SYMLINKS.has(cursor.replaceAll('\\', '/'))) {
        throw new Error(`unsafe_target: symlinked ${label}: ${cursor}`);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return canonicalPath(lexical);
};

const assertNoSymlinkComponents = (root, target, label = 'profile target') => {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`unsafe_target: ${target}`);
  }
  let cursor = resolvedTarget;
  while (cursor !== resolvedRoot && cursor.startsWith(`${resolvedRoot}${path.sep}`)) {
    try {
      if (lstatSync(cursor).isSymbolicLink()) throw new Error(`unsafe_target: symlinked ${label}: ${cursor}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    cursor = path.dirname(cursor);
  }
  return resolvedTarget;
};

const safeJoin = (root, rel) => {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(root, rel);
  return assertNoSymlinkComponents(resolvedRoot, resolved, `profile path ${rel}`);
};

export const profileManifestPath = (targetRoot) => path.join(path.resolve(targetRoot), PROFILE_MANIFEST_NAME);
export const profileMarkerPath = (targetRoot) => path.join(path.resolve(targetRoot), PROFILE_MARKER_NAME);

export function deepMergeJson(target, source) {
  if (typeof target !== 'object' || target === null || typeof source !== 'object' || source === null) {
    return source !== undefined ? source : target;
  }
  if (Array.isArray(target) || Array.isArray(source)) return Array.isArray(source) ? source : target;
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (key in target && typeof target[key] === 'object' && typeof source[key] === 'object'
      && !Array.isArray(target[key]) && !Array.isArray(source[key])) {
      result[key] = deepMergeJson(target[key], source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

const ownershipFor = (entry) => entry?.ownership || PROFILE_OWNERSHIP.OWNED_FILE;
const createdByKernelFor = ({ present, priorEntry }) => priorEntry ? priorEntry.createdByKernel !== false : !present;
const parseJsonFile = async (file) => JSON.parse(await readFile(file, 'utf8'));

const parseDeveloperAssignment = (text) => {
  const pattern = /(^[ \t]*developer_instructions[ \t]*=[ \t]*)(?:("""|''')([\s\S]*?)\2|([^\r\n]*))(?=\r?\n|$)/m;
  const match = String(text || '').match(pattern);
  if (!match) return null;
  return {
    start: match.index,
    end: match.index + match[0].length,
    prefix: match[1],
    delimiter: match[2] || '',
    body: match[2] ? match[3] : match[4],
    raw: match[0],
  };
};

const extractDeveloperInstruction = (text) => {
  const assignment = parseDeveloperAssignment(text);
  if (!assignment) throw new Error('profile_source_invalid: Kernel Codex profile is missing developer_instructions');
  return assignment.raw.trim();
};

const mergeKernelDeveloperInstructions = (existing, incoming) => {
  const target = String(existing || '');
  const source = parseDeveloperAssignment(incoming);
  if (!source) throw new Error('profile_source_invalid: Kernel Codex profile is missing developer_instructions');
  const current = parseDeveloperAssignment(target);
  if (current) {
    const body = mergeManagedSection(current.body, source.body, MANAGED_SECTION_ID);
    const replacement = `${current.prefix}${current.delimiter}${body}${current.delimiter}`;
    return `${target.slice(0, current.start)}${replacement}${target.slice(current.end)}`;
  }
  const assignment = `developer_instructions = """\n${mergeManagedSection('', source.body, MANAGED_SECTION_ID)}\n"""\n`;
  const firstTable = target.search(/^\s*\[/m);
  if (firstTable < 0) return `${target.trimEnd()}${target.trim() ? '\n\n' : ''}${assignment}`;
  const before = target.slice(0, firstTable).trimEnd();
  const after = target.slice(firstTable);
  return `${before}\n\n${assignment}\n${after}`;
};

const rewriteKernelProjectHook = (value, command) => {
  if (Array.isArray(value)) return value.map((item) => rewriteKernelProjectHook(item, command));
  if (!value || typeof value !== 'object') return value;
  const result = { ...value };
  if (typeof result.command === 'string' && /assert-track\b/.test(result.command)) result.command = command;
  for (const [key, child] of Object.entries(result)) {
    if (key !== 'command') result[key] = rewriteKernelProjectHook(child, command);
  }
  return result;
};

const mergeKernelHooks = (existing, incoming, command) => {
  if (existing && Object.hasOwn(existing, 'hooks') && (!existing.hooks || typeof existing.hooks !== 'object' || Array.isArray(existing.hooks))) {
    const error = new Error('shared_json_shape_collision: hooks');
    error.code = 'shared_json_shape_collision';
    throw error;
  }
  const merged = deepMergeJson(existing || {}, incoming || {});
  const existingEvents = existing?.hooks && typeof existing.hooks === 'object' ? existing.hooks : {};
  const incomingEvents = incoming?.hooks && typeof incoming.hooks === 'object' ? incoming.hooks : {};
  if (Object.hasOwn(existingEvents, 'SessionStart') && !Array.isArray(existingEvents.SessionStart)) {
    const error = new Error('shared_json_shape_collision: hooks.SessionStart');
    error.code = 'shared_json_shape_collision';
    throw error;
  }
  merged.hooks = { ...existingEvents, ...incomingEvents };
  if ('SessionStart' in incomingEvents || 'SessionStart' in existingEvents) {
    const retained = Array.isArray(existingEvents.SessionStart)
      ? existingEvents.SessionStart.filter((item) => !isKernelHookEntry(item))
      : [];
    const kernelHooks = Array.isArray(incomingEvents.SessionStart)
      ? rewriteKernelProjectHook(incomingEvents.SessionStart, command)
      : [];
    merged.hooks.SessionStart = [...retained, ...kernelHooks];
  }
  return merged;
};

const quoteShellPath = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
const hookCommandFor = (runtimeHome) => `${quoteShellPath(path.join(canonicalPath(runtimeHome), 'bin', 'kernel'))} assert-track --project-only --allow-non-kernel --json`;

const setJsonPath = (value, jsonPath, replacement) => {
  const segments = String(jsonPath).split('.').filter(Boolean);
  if (segments.length === 0) return replacement;
  let current = value;
  for (const segment of segments.slice(0, -1)) {
    if (segment in current && (!current[segment] || typeof current[segment] !== 'object' || Array.isArray(current[segment]))) {
      const error = new Error(`json_path_container_invalid: ${jsonPath}`);
      error.code = 'json_path_container_invalid';
      throw error;
    }
    if (!current[segment] || typeof current[segment] !== 'object' || Array.isArray(current[segment])) current[segment] = {};
    current = current[segment];
  }
  current[segments.at(-1)] = replacement;
  return value;
};

const jsonPathContainerConflict = (value, jsonPath) => {
  let current = value;
  for (const segment of String(jsonPath).split('.').filter(Boolean).slice(0, -1)) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return 'json-path-container-invalid';
    if (!(segment in current)) return null;
    current = current[segment];
  }
  return current && typeof current === 'object' && !Array.isArray(current) ? null : 'json-path-container-invalid';
};

const jsonPathsFor = (rel, incoming) => {
  const normalized = rel.replaceAll('\\', '/');
  if (path.posix.basename(normalized) === 'settings.json') return ['mcpServers.moon-relay-kernel'];
  if (path.posix.basename(normalized) === 'hooks.json') return ['hooks.SessionStart'];
  return Object.keys(incoming);
};

const materializedJsonSource = ({ runtime, rel, source, mcpLauncher }) => {
  const incoming = JSON.parse(JSON.stringify(source));
  if (runtime === 'claude' && path.posix.basename(rel.replaceAll('\\', '/')) === 'settings.json') {
    incoming.mcpServers = {
      ...(incoming.mcpServers || {}),
      'moon-relay-kernel': { command: mcpLauncher, args: [] },
    };
  }
  return incoming;
};

const buildJsonProjection = ({ existing, incoming, rel, hookCommand }) => {
  const normalized = rel.replaceAll('\\', '/');
  if (path.posix.basename(normalized) === 'hooks.json') return mergeKernelHooks(existing, incoming, hookCommand);
  const projected = JSON.parse(JSON.stringify(existing || {}));
  for (const jsonPath of jsonPathsFor(normalized, incoming)) {
    const sourceValue = getJsonPath(incoming, jsonPath);
    if (sourceValue.present) setJsonPath(projected, jsonPath, sourceValue.value);
  }
  return projected;
};

const sourceChecksum = async (sourcePath) => sha256(sourcePath);
const isManagedTextPath = (rel) => ['AGENTS.md', 'AGENTS.override.md', 'CLAUDE.md', 'QWEN.md', 'GEMINI.md'].includes(path.posix.basename(rel.replaceAll('\\', '/')));
const isJsonPath = (rel) => path.posix.basename(rel.replaceAll('\\', '/')).endsWith('.json');

const collision = (targetRoot, pathName, ownership, reason, extra = {}) => ({
  path: pathName,
  ownership,
  reason,
  ...extra,
});
const priorEntryFor = (prior, rel) => (prior?.files || []).find((entry) => entry.path === rel.replaceAll('\\', '/')) || null;

const entryFromJson = async ({ rel, projected, ownedPaths, sourceChecksumValue, createdByKernel }) => {
  const entry = {
    path: rel.replaceAll('\\', '/'),
    ownership: PROFILE_OWNERSHIP.JSON_PATHS,
    ownedPaths: [...new Set(ownedPaths)],
    ownedPathDigests: {},
    ownedArrayDigests: {},
    createdByKernel,
    sourceChecksum: sourceChecksumValue,
  };
  for (const jsonPath of entry.ownedPaths) {
    const ownership = collectJsonPathOwnership(projected, jsonPath, { array: jsonPath === 'hooks.SessionStart' });
    if (ownership.digest) entry.ownedPathDigests[jsonPath] = ownership.digest;
    if (jsonPath === 'hooks.SessionStart') entry.ownedArrayDigests[jsonPath] = ownership.arrayDigests;
  }
  entry.checksum = valueDigest(projected);
  return entry;
};

const checkUnmanagedJsonCollision = ({ existing, incoming, rel }) => {
  for (const jsonPath of jsonPathsFor(rel, incoming)) {
    const containerReason = jsonPathContainerConflict(existing, jsonPath);
    if (containerReason) return collision(null, rel, PROFILE_OWNERSHIP.JSON_PATHS, containerReason, { ownedPath: jsonPath });
    const oldValue = getJsonPath(existing, jsonPath);
    if (!oldValue.present) continue;
    if (jsonPath === 'hooks.SessionStart') {
      continue;
    }
    const newValue = getJsonPath(incoming, jsonPath);
    if (newValue.present && valueDigest(oldValue.value) !== valueDigest(newValue.value)) {
      return collision(null, rel, PROFILE_OWNERSHIP.JSON_PATHS, 'existing-owned-path-without-manifest', { ownedPath: jsonPath });
    }
  }
  return null;
};

const buildSourceFileMap = async (sourceRoot, runtime) => {
  const profileSource = path.resolve(sourceRoot, 'package', 'kernel', 'profiles', runtime);
  const sourceMap = new Map();
  for (const rel of await files(profileSource)) sourceMap.set(rel, { rel, sourcePath: safeJoin(profileSource, rel), kind: 'profile' });
  const canonicalSkill = canonicalKernelSkillDir(sourceRoot);
  for (const rel of await files(canonicalSkill)) {
    const targetRel = path.join(KERNEL_SKILL_INSTALL_REL, rel).replaceAll('\\', '/');
    sourceMap.set(targetRel, { rel: targetRel, sourcePath: path.join(canonicalSkill, rel), kind: 'canonical-skill' });
  }
  for (const { name, dir } of await canonicalStandaloneSkillDirs(sourceRoot)) {
    if (!(await exists(dir))) continue;
    for (const rel of await files(dir)) {
      const targetRel = path.join('skills', name, rel).replaceAll('\\', '/');
      sourceMap.set(targetRel, { rel: targetRel, sourcePath: path.join(dir, rel), kind: 'standalone-skill' });
    }
  }
  return sourceMap;
};

const kernelHookCommands = (value) => {
  if (Array.isArray(value)) return value.flatMap(kernelHookCommands);
  if (!value || typeof value !== 'object') return [];
  const commands = typeof value.command === 'string' && /assert-track\b/.test(value.command) ? [value.command] : [];
  return [...commands, ...Object.entries(value)
    .filter(([key]) => key !== 'command')
    .flatMap(([, child]) => kernelHookCommands(child))];
};

export const resolveProfileEntryRoot = ({ root, entry = null, manifest = null, runtime = null, skillsRoot = null }) => {
  const effectiveProvider = manifest?.provider || manifest?.runtime || runtime;
  const effectiveSkillsRoot = manifest?.skillsRoot || skillsRoot;
  const relPath = typeof entry === 'string' ? entry : entry?.path;
  if (effectiveProvider === 'antigravity' && effectiveSkillsRoot && relPath && String(relPath).startsWith('skills/')) {
    return canonicalPath(effectiveSkillsRoot);
  }
  return canonicalPath(root);
};

const profileProjectionIsCurrent = async ({ root, sourceRoot, runtime, runtimeHome, skillsRoot = null, manifest }) => {
  if (!manifest || manifest.sourceRoot !== path.resolve(sourceRoot) || manifest.provider !== runtime) return false;
  if (runtime === 'antigravity') {
    const desiredSkillsRoot = skillsRoot ? canonicalPath(skillsRoot) : null;
    const manifestSkillsRoot = manifest.skillsRoot ? canonicalPath(manifest.skillsRoot) : null;
    if (desiredSkillsRoot !== manifestSkillsRoot) return false;
  }
  if ((await inspectProfile(root)).status !== 'ready') return false;
  const sourceMap = await buildSourceFileMap(sourceRoot, runtime);
  const desiredPaths = new Set([...sourceMap.keys(), PROFILE_MARKER_NAME]);
  const currentPaths = new Set((manifest.files || []).map((entry) => entry.path));
  if (currentPaths.size !== desiredPaths.size || [...desiredPaths].some((rel) => !currentPaths.has(rel))) return false;
  const byPath = new Map((manifest.files || []).map((entry) => [entry.path, entry]));
  for (const item of sourceMap.values()) {
    const entry = byPath.get(item.rel);
    if (!entry || entry.sourceChecksum !== await sourceChecksum(item.sourcePath)) return false;
  }
  const marker = byPath.get(PROFILE_MARKER_NAME);
  if (!marker) return false;
  const markerText = `${JSON.stringify(markerFor(runtime), null, 2)}\n`;
  if (marker.checksum !== createHash('sha256').update(markerText).digest('hex')) return false;
  const effectiveRuntimeHome = runtimeHome || resolveKernelRuntimeHome();
  if (runtime === 'claude') {
    const settings = byPath.get('settings.json');
    if (!settings) return false;
    const value = await parseJsonFile(safeJoin(root, settings.path));
    const configured = getJsonPath(value, 'mcpServers.moon-relay-kernel').value;
    const launcher = await materializeKernelMcpLauncher({ runtimeHome: effectiveRuntimeHome, write: false });
    if (configured?.command !== launcher.launcherPath || JSON.stringify(configured?.args || []) !== '[]') return false;
  }
  if (runtime === 'codex') {
    const hooks = byPath.get('hooks.json');
    if (!hooks) return false;
    const value = await parseJsonFile(safeJoin(root, hooks.path));
    const commands = kernelHookCommands(getJsonPath(value, 'hooks.SessionStart').value);
    const expected = hookCommandFor(effectiveRuntimeHome);
    if (commands.length === 0 || commands.some((command) => command !== expected)) return false;
  }
  return true;
};

const readPriorManifest = async (root) => {
  const manifestPath = profileManifestPath(root);
  return await exists(manifestPath) ? JSON.parse(await readFile(manifestPath, 'utf8')) : null;
};

const preflightOwnedEntry = async (root, entry, { manifest = null, runtime = null, skillsRoot = null } = {}) => {
  const entryRoot = resolveProfileEntryRoot({ root, entry, manifest, runtime, skillsRoot });
  const file = safeJoin(entryRoot, entry.path);
  await rejectSymlink(file);
  if (!(await exists(file))) return null;
  const ownership = ownershipFor(entry);
  if (ownership === PROFILE_OWNERSHIP.OWNED_DIRECTORY) {
    const inspected = await inspectOwnedDirectory(entryRoot, entry);
    return inspected.status === 'collision'
      ? collision(entryRoot, entry.path, ownership, inspected.reason || 'modified-owned-directory')
      : null;
  }
  if (ownership === PROFILE_OWNERSHIP.MANAGED_SECTION) {
    const text = await readFile(file, 'utf8');
    const region = entry.format === 'toml-developer-instructions' ? parseDeveloperAssignment(text)?.body : text;
    if (region === undefined || region === null) return collision(entryRoot, entry.path, ownership, 'managed-section-container-missing');
    const inspected = inspectManagedSection(region, entry.sectionId || MANAGED_SECTION_ID);
    if (inspected.status !== 'present') return collision(entryRoot, entry.path, ownership, inspected.reason || 'managed-section-missing');
    if (entry.managedChecksum && inspected.digest !== entry.managedChecksum) return collision(entryRoot, entry.path, ownership, 'modified-managed-section');
    return null;
  }
  if (ownership === PROFILE_OWNERSHIP.JSON_PATHS) {
    let value;
    try { value = await parseJsonFile(file); } catch { return collision(entryRoot, entry.path, ownership, 'invalid-shared-json'); }
    const failures = inspectJsonOwnership(value, entry);
    if (failures.length > 0) return collision(entryRoot, entry.path, ownership, failures[0].reason, failures[0]);
    return null;
  }
  if (entry.checksum && await sha256(file) !== entry.checksum) return collision(entryRoot, entry.path, ownership, 'modified-owned-file');
  return null;
};

export async function inspectProfile(targetRoot) {
  const root = await safeProfileRoot(targetRoot);
  const manifestPath = profileManifestPath(root);
  if (!(await exists(manifestPath))) return { status: 'not_installed', targetRoot: root };
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const checks = [];
  for (const entry of manifest.files || []) {
    const entryRoot = resolveProfileEntryRoot({ root, entry, manifest });
    const file = safeJoin(entryRoot, entry.path);
    const present = await exists(file);
    const ownership = ownershipFor(entry);
    let checksum = present && ownership !== PROFILE_OWNERSHIP.OWNED_DIRECTORY ? await sha256(file) : null;
    let isOk = false;
    let reason = null;
    let ownedPath = null;
    if (present && ownership === PROFILE_OWNERSHIP.OWNED_DIRECTORY) {
      const inspected = await inspectOwnedDirectory(entryRoot, entry);
      isOk = inspected.status === 'ok';
      checksum = inspected.checksum || null;
      reason = isOk ? null : inspected.reason || 'modified-owned-directory';
    } else if (present && ownership === PROFILE_OWNERSHIP.MANAGED_SECTION) {
      try {
        const text = await readFile(file, 'utf8');
        const region = entry.format === 'toml-developer-instructions' ? parseDeveloperAssignment(text)?.body : text;
        const inspected = region === undefined || region === null
          ? { status: 'collision', reason: 'managed-section-container-missing' }
          : inspectManagedSection(region, entry.sectionId || MANAGED_SECTION_ID);
        isOk = inspected.status === 'present' && (!entry.managedChecksum || inspected.digest === entry.managedChecksum);
        reason = isOk ? null : inspected.reason || 'modified-managed-section';
      } catch (error) { reason = error.message; }
    } else if (present && ownership === PROFILE_OWNERSHIP.JSON_PATHS) {
      try {
        const failures = inspectJsonOwnership(await parseJsonFile(file), entry);
        isOk = failures.length === 0;
        reason = failures[0]?.reason || null;
        ownedPath = failures[0]?.ownedPath || null;
      } catch (error) { reason = `invalid-json:${error.message}`; }
    } else if (present) {
      isOk = !entry.checksum || checksum === entry.checksum;
      if (!isOk && entry.requiredContent) {
        try { isOk = (await readFile(file, 'utf8')).includes(entry.requiredContent); } catch {}
      }
      if (!isOk && !entry.ownership && entry.path.endsWith('.json')) {
        try { isOk = Boolean(await parseJsonFile(file)); } catch {}
      }
      if (!isOk) reason = 'modified-owned-file';
    }
    checks.push({ path: entry.path, ownership, present, checksum, expected: entry.checksum || null, requiredContent: entry.requiredContent || null, ownedPath, reason, isOk });
  }
  return { status: checks.every((item) => item.present && item.isOk) ? 'ready' : 'drift', targetRoot: root, manifest, checks };
}

const prepareProfilePlan = async ({ root, skillsRoot = null, item, runtime, runtimeHome, prior, force }) => {
  const rel = item.rel.replaceAll('\\', '/');
  const planRoot = (runtime === 'antigravity' && skillsRoot && rel.startsWith('skills/'))
    ? await safeProfileRoot(skillsRoot, 'skills root')
    : root;
  const target = safeJoin(planRoot, rel);
  const priorEntry = priorEntryFor(prior, rel);
  const present = await exists(target);
  const sourceHash = await sourceChecksum(item.sourcePath);
  if (isManagedTextPath(rel)) {
    const incoming = await readFile(item.sourcePath, 'utf8');
    if (priorEntry && !force) {
      const problem = await preflightOwnedEntry(root, priorEntry, { manifest: prior, runtime, skillsRoot });
      if (problem) return { collision: problem };
    }
    const existing = present ? await readFile(target, 'utf8') : '';
    let projected;
    try { projected = mergeManagedSection(existing, incoming, MANAGED_SECTION_ID); } catch (error) {
      return { collision: collision(root, rel, PROFILE_OWNERSHIP.MANAGED_SECTION, error.reason || error.code || 'managed-section-collision') };
    }
    const section = inspectManagedSection(projected, MANAGED_SECTION_ID);
    return {
      type: 'text',
      target,
      content: projected,
      entry: { path: rel, ownership: PROFILE_OWNERSHIP.MANAGED_SECTION, sectionId: MANAGED_SECTION_ID, managedChecksum: section.digest, sourceChecksum: sourceHash, createdByKernel: createdByKernelFor({ present, priorEntry }), checksum: valueDigest(projected) },
    };
  }
  if (isJsonPath(rel)) {
    const incomingRaw = JSON.parse(await readFile(item.sourcePath, 'utf8'));
    const mcpLauncher = await materializeKernelMcpLauncher({ runtimeHome: runtimeHome || resolveKernelRuntimeHome(), write: false });
    const incoming = materializedJsonSource({ runtime, rel, source: incomingRaw, mcpLauncher: mcpLauncher.launcherPath });
    let existing = {};
    if (present) {
      try { existing = await parseJsonFile(target); } catch { return { collision: collision(root, rel, PROFILE_OWNERSHIP.JSON_PATHS, 'invalid-shared-json') }; }
      if (priorEntry && !force) {
        const problem = await preflightOwnedEntry(root, priorEntry, { manifest: prior, runtime, skillsRoot });
        if (problem) return { collision: problem };
      } else if (!priorEntry) {
        const problem = checkUnmanagedJsonCollision({ existing, incoming, rel });
        if (problem) return { collision: { ...problem, targetRoot: root } };
      }
    }
    let projected;
    try {
      projected = buildJsonProjection({ existing, incoming, rel, hookCommand: hookCommandFor(runtimeHome || resolveKernelRuntimeHome()) });
    } catch (error) {
      return { collision: collision(root, rel, PROFILE_OWNERSHIP.JSON_PATHS, error.code || 'json-projection-failed') };
    }
    const entry = await entryFromJson({ rel, projected, ownedPaths: jsonPathsFor(rel, incoming), sourceChecksumValue: sourceHash, createdByKernel: createdByKernelFor({ present, priorEntry }) });
    return { type: 'json', target, content: `${JSON.stringify(projected, null, 2)}\n`, entry };
  }

  if (priorEntry) {
    const problem = await preflightOwnedEntry(root, priorEntry, { manifest: prior, runtime, skillsRoot });
    if (problem && !force) return { collision: problem };
  } else if (present) {
    const actual = await sha256(target);
    if (actual !== sourceHash) return { collision: collision(root, rel, PROFILE_OWNERSHIP.OWNED_FILE, 'existing-owned-file-without-manifest') };
  }
  return {
    type: 'file',
    target,
    sourcePath: item.sourcePath,
    entry: { path: rel, ownership: PROFILE_OWNERSHIP.OWNED_FILE, sourceChecksum: sourceHash, createdByKernel: createdByKernelFor({ present, priorEntry }), checksum: sourceHash },
  };
};

const applyProfilePlans = async (plans) => {
  for (const plan of plans) {
    await mkdir(path.dirname(plan.target), { recursive: true });
    if (plan.type === 'file') await copyTree(plan.sourcePath, plan.target);
    else await atomicWrite(plan.target, plan.content);
  }
};

const backupManifestEntries = async ({ root, prior, backupPath }) => {
  if (!prior || !backupPath) return;
  for (const entry of prior.files || []) {
    const sourceRoot = resolveProfileEntryRoot({ root, entry, manifest: prior });
    const source = safeJoin(sourceRoot, entry.path);
    if (await exists(source)) await copyTree(source, safeJoin(backupPath, entry.path));
  }
  await mkdir(backupPath, { recursive: true });
  await atomicWrite(path.join(backupPath, PROFILE_MANIFEST_NAME), JSON.stringify(prior, null, 2));
};

const backupExistingPlanEntries = async ({ root, plans, paths, backupPath }) => {
  if (!backupPath || paths.length === 0) return;
  const selected = new Set(paths);
  for (const plan of plans) {
    if (!selected.has(plan.entry.path) || !(await exists(plan.target))) continue;
    await copyTree(plan.target, safeJoin(backupPath, plan.entry.path));
  }
  await mkdir(backupPath, { recursive: true });
  await atomicWrite(path.join(backupPath, 'preexisting.json'), JSON.stringify({ schemaVersion: 1, targetRoot: root, paths }, null, 2));
};

const markerFor = (runtime, layout = null) => ({
  schemaVersion: 1,
  productId: PROFILE_PRODUCT_ID,
  runtime: 'moon-relay-kernel',
  provider: runtime,
  ...(layout ? { layout } : {}),
  ownership: Object.values(PROFILE_OWNERSHIP),
});

const isCompatibleProfileMarker = ({ marker, runtime, layout = null }) => {
  if (!marker || marker.productId !== PROFILE_PRODUCT_ID) return false;
  if (layout) {
    if (marker.layout !== layout) return false;
    if (marker.runtime === 'moon-relay-kernel') {
      return marker.provider === runtime || marker.runtime === runtime;
    }
    return marker.track === 'kernel' && marker.runtime === runtime;
  }
  if (marker.layout) return false;
  if (marker.runtime === 'moon-relay-kernel') {
    return marker.provider === runtime;
  }
  return marker.track === 'kernel' && marker.runtime === runtime;
};

const isCompatibleProfileManifest = ({ manifest, runtime, layout = null }) => {
  if (!manifest || manifest.productId !== PROFILE_PRODUCT_ID) return false;
  if (layout) {
    if (manifest.layout !== layout) return false;
    return (manifest.runtime === runtime || manifest.provider === runtime)
      && (manifest.kernelRuntime === 'moon-relay-kernel' || manifest.track === 'kernel');
  }
  if (manifest.layout) return false;
  return (manifest.runtime === 'moon-relay-kernel' && manifest.provider === runtime)
    || (manifest.track === 'kernel' && manifest.runtime === runtime);
};

const trustedPriorManifest = async ({ root, manifest, runtime, layout = null }) => {
  try {
    if (!manifest || manifest.productId !== PROFILE_PRODUCT_ID || !Array.isArray(manifest.files)) return null;
    if (!isCompatibleProfileManifest({ manifest, runtime, layout })) return null;
    if (typeof manifest.targetRoot !== 'string' || canonicalPath(manifest.targetRoot) !== root) return null;
    const markerEntry = priorEntryFor(manifest, PROFILE_MARKER_NAME);
    if (!markerEntry
      || ownershipFor(markerEntry) !== PROFILE_OWNERSHIP.OWNED_FILE
      || typeof markerEntry.checksum !== 'string') return null;
    const markerPath = safeJoin(root, PROFILE_MARKER_NAME);
    if (!(await exists(markerPath))) return null;
    await rejectSymlink(markerPath);
    if (await sha256(markerPath) !== markerEntry.checksum) return null;
    if (!isCompatibleProfileMarker({ marker: await parseJsonFile(markerPath), runtime, layout })) return null;
    return manifest;
  } catch {
    return null;
  }
};

const markerPlan = async ({ root, runtime, prior, force, layout = null }) => {
  const rel = PROFILE_MARKER_NAME;
  const target = safeJoin(root, rel);
  const present = await exists(target);
  const priorEntry = priorEntryFor(prior, rel);
  if (priorEntry && !force) {
    const problem = await preflightOwnedEntry(root, priorEntry, { manifest: prior, runtime });
    if (problem) return { collision: problem };
  } else if (present && !priorEntry) {
    return { collision: collision(root, rel, PROFILE_OWNERSHIP.OWNED_FILE, 'marker-without-trusted-manifest') };
  }
  const content = `${JSON.stringify(markerFor(runtime, layout), null, 2)}\n`;
  return { type: 'text', target, content, entry: { path: rel, ownership: PROFILE_OWNERSHIP.OWNED_FILE, createdByKernel: createdByKernelFor({ present, priorEntry }), checksum: createHash('sha256').update(content).digest('hex') } };
};

export async function installKernelProfile({ sourceRoot = process.cwd(), runtime, targetRoot, skillsRoot = null, runtimeHome = null, force = false } = {}) {
  if (!KERNEL_PROFILE_RUNTIMES.includes(runtime)) throw new Error(`unsupported_profile: ${runtime}`);
  const root = await safeProfileRoot(targetRoot);
  const source = path.resolve(sourceRoot, 'package', 'kernel', 'profiles', runtime);
  if (!(await exists(source))) throw new Error(`application_not_resolved: profile source missing for ${runtime}`);
  await mkdir(root, { recursive: true });
  await rejectSymlink(root);
  const markerPath = profileMarkerPath(root);
  const manifestPath = profileManifestPath(root);
  const priorManifest = await readPriorManifest(root);
  if (priorManifest && priorManifest.productId !== PROFILE_PRODUCT_ID) throw new Error('target_collision: foreign profile manifest');
  const prior = await trustedPriorManifest({ root, manifest: priorManifest, runtime });
  if (await exists(markerPath) && !prior) throw new Error('target_collision: marker without trusted manifest');
  if (!(await exists(canonicalKernelSkillDir(sourceRoot)))) throw new Error(`skill_source_missing: ${canonicalKernelSkillDir(sourceRoot)}`);
  if (prior && !force) {
    if (await profileProjectionIsCurrent({ root, sourceRoot, runtime, runtimeHome, manifest: prior })) {
      return { status: 'already_current', runtime, targetRoot: root, manifestPath, backupPath: null, installedFilesCount: prior.files?.length || 0 };
    }
  }

  if (skillsRoot && runtime === 'antigravity') {
    const externalRoot = await safeProfileRoot(skillsRoot, 'skills root');
    const external = safeJoin(externalRoot, KERNEL_SKILL_INSTALL_REL);
    if (await exists(external)) {
      for (const rel of await files(canonicalKernelSkillDir(sourceRoot))) {
        const targetRel = path.join(KERNEL_SKILL_INSTALL_REL, rel).replaceAll('\\', '/');
        const priorEntry = priorEntryFor(prior, targetRel);
        if (priorEntry) continue;
        const target = safeJoin(external, rel);
        if (!(await exists(target)) || await sha256(target) !== await sha256(path.join(canonicalKernelSkillDir(sourceRoot), rel))) {
          return { status: 'collision', targetRoot: root, collisions: [collision(externalRoot, targetRel, PROFILE_OWNERSHIP.OWNED_FILE, 'external-skill-collision')] };
        }
      }
    }
  }

  const plans = [];
  const collisions = [];
  for (const item of (await buildSourceFileMap(sourceRoot, runtime)).values()) {
    const plan = await prepareProfilePlan({ root, skillsRoot, item, runtime, runtimeHome, prior, force });
    if (plan.collision) collisions.push(plan.collision); else plans.push(plan);
  }
  const marker = await markerPlan({ root, runtime, prior, force });
  if (marker.collision) collisions.push(marker.collision); else plans.push(marker);
  if (collisions.length > 0) return { status: 'collision', runtime, targetRoot: root, collisions };

  const preexistingPaths = !prior && force
    ? (await Promise.all(plans.map(async (plan) => (await exists(plan.target)) ? plan.entry.path : null))).filter(Boolean)
    : [];
  const backupPath = prior || preexistingPaths.length > 0
    ? path.join(root, '.moon-relay-kernel-backups', `backup-${Date.now()}`)
    : null;
  try {
    await backupManifestEntries({ root, prior, backupPath });
    await backupExistingPlanEntries({ root, plans, paths: preexistingPaths, backupPath });
    await applyProfilePlans(plans);
    if (skillsRoot && runtime === 'antigravity') {
      const externalRoot = await safeProfileRoot(skillsRoot, 'skills root');
      const external = safeJoin(externalRoot, KERNEL_SKILL_INSTALL_REL);
      if (!(await exists(external))) await copyTree(canonicalKernelSkillDir(sourceRoot), external);
    }
    const manifest = { schemaVersion: 2, productId: PROFILE_PRODUCT_ID, runtime: 'moon-relay-kernel', provider: runtime, ...(skillsRoot && runtime === 'antigravity' ? { skillsRoot: canonicalPath(skillsRoot) } : {}), targetRoot: root, sourceRoot: path.resolve(sourceRoot), installedAt: new Date().toISOString(), backupPath, files: plans.map((plan) => plan.entry) };
    await atomicWrite(manifestPath, JSON.stringify(manifest, null, 2));
    return { status: prior ? 'reinstalled' : 'installed', runtime, targetRoot: root, manifestPath, backupPath, installedFilesCount: manifest.files.length };
  } catch (error) {
    if (prior && backupPath && await exists(backupPath)) {
      try { await rollbackKernelProfile({ targetRoot: root, backupPath }); } catch {}
    } else if (!prior && backupPath && preexistingPaths.length > 0 && await exists(backupPath)) {
      for (const plan of plans) await rm(plan.target, { force: true, recursive: true });
      for (const rel of preexistingPaths) {
        const backup = safeJoin(backupPath, rel);
        if (await exists(backup)) await copyTree(backup, safeJoin(root, rel));
      }
    } else if (!prior) {
      for (const plan of plans) await rm(plan.target, { force: true, recursive: true });
    }
    throw error;
  }
}

const accountSkillItems = async (sourceRoot) => {
  const items = [{ name: KERNEL_ENTRYPOINT_SKILL, dir: canonicalKernelSkillDir(sourceRoot) }];
  for (const item of await canonicalStandaloneSkillDirs(sourceRoot)) if (await exists(item.dir)) items.push(item);
  return items;
};

const accountPlan = async ({ root, sourceRoot, runtimeHome, prior, force }) => {
  const source = path.resolve(sourceRoot, 'package', 'kernel', 'profiles', 'codex');
  const plans = [];
  const collisions = [];
  const push = async (plan) => { if (plan.collision) collisions.push(plan.collision); else plans.push(plan); };
  await push(await prepareProfilePlan({ root, runtime: 'codex', runtimeHome, prior, force, item: { rel: 'AGENTS.md', sourcePath: path.join(source, 'AGENTS.override.md'), kind: 'account-guidance' } }));

  const configTarget = safeJoin(root, 'config.toml');
  const configSource = path.join(source, '.codex', 'config.toml');
  const configPresent = await exists(configTarget);
  const configPrior = priorEntryFor(prior, 'config.toml');
  if (configPrior && !force) {
    const problem = await preflightOwnedEntry(root, configPrior);
    if (problem) collisions.push(problem);
  }
  if (!collisions.length || !configPrior || force) {
    const configExisting = configPresent ? await readFile(configTarget, 'utf8') : '';
    let configText;
    try { configText = mergeKernelDeveloperInstructions(configExisting, await readFile(configSource, 'utf8')); } catch (error) { collisions.push(collision(root, 'config.toml', PROFILE_OWNERSHIP.MANAGED_SECTION, error.code || 'config-merge-failed')); }
    if (configText) {
      const assignment = parseDeveloperAssignment(configText);
      const section = assignment ? inspectManagedSection(assignment.body, MANAGED_SECTION_ID) : null;
      if (!section || section.status !== 'present') collisions.push(collision(root, 'config.toml', PROFILE_OWNERSHIP.MANAGED_SECTION, 'managed-section-missing'));
      else plans.push({ type: 'text', target: configTarget, content: configText, entry: { path: 'config.toml', ownership: PROFILE_OWNERSHIP.MANAGED_SECTION, sectionId: MANAGED_SECTION_ID, format: 'toml-developer-instructions', managedChecksum: section.digest, sourceChecksum: await sourceChecksum(configSource), createdByKernel: createdByKernelFor({ present: configPresent, priorEntry: configPrior }), checksum: valueDigest(configText) } });
    }
  }

  const hookTarget = safeJoin(root, 'hooks.json');
  const hookSource = path.join(source, '.codex', 'hooks.json');
  const hookPresent = await exists(hookTarget);
  const hookPrior = priorEntryFor(prior, 'hooks.json');
  let hookExisting = {};
  if (hookPresent) {
    try { hookExisting = await parseJsonFile(hookTarget); } catch { collisions.push(collision(root, 'hooks.json', PROFILE_OWNERSHIP.JSON_PATHS, 'invalid-shared-json')); }
  }
  if (hookPrior && !force) {
    const problem = await preflightOwnedEntry(root, hookPrior);
    if (problem) collisions.push(problem);
  } else if (!hookPrior && hookPresent && !collisions.length) {
    const sourceJson = await parseJsonFile(hookSource);
    const problem = checkUnmanagedJsonCollision({ existing: hookExisting, incoming: sourceJson, rel: 'hooks.json' });
    if (problem) collisions.push({ ...problem, targetRoot: root });
  }
  if (!collisions.length || force) {
    const sourceJson = await parseJsonFile(hookSource);
    try {
      const projected = mergeKernelHooks(hookExisting, sourceJson, hookCommandFor(runtimeHome));
      plans.push({ type: 'json', target: hookTarget, content: `${JSON.stringify(projected, null, 2)}\n`, entry: await entryFromJson({ rel: 'hooks.json', projected, ownedPaths: ['hooks.SessionStart'], sourceChecksumValue: await sourceChecksum(hookSource), createdByKernel: createdByKernelFor({ present: hookPresent, priorEntry: hookPrior }) }) });
    } catch (error) {
      collisions.push(collision(root, 'hooks.json', PROFILE_OWNERSHIP.JSON_PATHS, error.code || 'json-projection-failed', { ownedPath: 'hooks.SessionStart' }));
    }
  }

  for (const { name, dir } of await accountSkillItems(sourceRoot)) {
    for (const rel of await files(dir)) {
      const targetRel = path.join('skills', name, rel).replaceAll('\\', '/');
      const target = safeJoin(root, targetRel);
      const present = await exists(target);
      const priorEntry = priorEntryFor(prior, targetRel);
      const checksum = await sourceChecksum(path.join(dir, rel));
      if (present && priorEntry) {
        const problem = await preflightOwnedEntry(root, priorEntry);
        if (problem && !force) collisions.push(problem);
      } else if (present && !priorEntry && await sha256(target) !== checksum) {
        collisions.push(collision(root, targetRel, PROFILE_OWNERSHIP.OWNED_FILE, 'existing-owned-file-without-manifest'));
      }
      plans.push({ type: 'file', target, sourcePath: path.join(dir, rel), entry: { path: targetRel, ownership: PROFILE_OWNERSHIP.OWNED_FILE, sourceChecksum: checksum, createdByKernel: createdByKernelFor({ present, priorEntry }), checksum } });
    }
  }
  return { plans, collisions };
};

const accountProjectionIsCurrent = async ({ root, sourceRoot, runtimeHome, manifest }) => {
  if (!manifest || manifest.sourceRoot !== path.resolve(sourceRoot)) return false;
  if ((await inspectProfile(root)).status !== 'ready') return false;
  const plan = await accountPlan({ root, sourceRoot, runtimeHome, prior: manifest, force: false });
  if (plan.collisions.length > 0) return false;
  const desiredPaths = new Set([...plan.plans.map((item) => item.entry.path), PROFILE_MARKER_NAME]);
  const currentPaths = new Set((manifest.files || []).map((entry) => entry.path));
  if (currentPaths.size !== desiredPaths.size || [...desiredPaths].some((rel) => !currentPaths.has(rel))) return false;
  const byPath = new Map((manifest.files || []).map((entry) => [entry.path, entry]));
  for (const item of plan.plans) {
    const prior = byPath.get(item.entry.path);
    if (!prior) return false;
    if (item.entry.sourceChecksum && prior.sourceChecksum !== item.entry.sourceChecksum) return false;
    if (item.entry.ownership === PROFILE_OWNERSHIP.MANAGED_SECTION && prior.managedChecksum !== item.entry.managedChecksum) return false;
  }
  return true;
};

export async function installKernelAccountRoot({ sourceRoot = process.cwd(), runtime = 'codex', targetRoot, runtimeHome = null, force = false } = {}) {
  if (runtime !== 'codex') throw new Error(`unsupported_account_root_profile: ${runtime}`);
  const root = await safeProfileRoot(targetRoot);
  const source = path.resolve(sourceRoot, 'package', 'kernel', 'profiles', runtime);
  if (!(await exists(source))) throw new Error(`application_not_resolved: profile source missing for ${runtime}`);
  if (!(await exists(canonicalKernelSkillDir(sourceRoot)))) throw new Error(`skill_source_missing: ${canonicalKernelSkillDir(sourceRoot)}`);
  await mkdir(root, { recursive: true });
  await rejectSymlink(root);
  const manifestPath = profileManifestPath(root);
  const markerPath = profileMarkerPath(root);
  const priorManifest = await readPriorManifest(root);
  if (priorManifest && priorManifest.productId !== PROFILE_PRODUCT_ID) throw new Error('target_collision: foreign profile manifest');
  if (priorManifest && priorManifest.layout !== ACCOUNT_ROOT_PROFILE_LAYOUT) throw new Error('target_collision: foreign or non-account-root Kernel profile manifest');
  const prior = await trustedPriorManifest({ root, manifest: priorManifest, runtime, layout: ACCOUNT_ROOT_PROFILE_LAYOUT });
  if (await exists(markerPath) && !prior) throw new Error('target_collision: marker without trusted manifest');
  const effectiveRuntimeHome = runtimeHome || resolveKernelRuntimeHome();
  if (prior && !force && await accountProjectionIsCurrent({ root, sourceRoot, runtimeHome: effectiveRuntimeHome, manifest: prior })) {
    return { status: 'already_current', runtime, layout: ACCOUNT_ROOT_PROFILE_LAYOUT, targetRoot: root, manifestPath, backupPath: prior.backupPath || null, retiredRelaySkills: prior.retiredRelaySkills || [], installedFilesCount: prior.files?.length || 0 };
  }

  const { plans, collisions } = await accountPlan({ root, sourceRoot, runtimeHome: effectiveRuntimeHome, prior, force });
  const marker = await markerPlan({ root, runtime, prior, force, layout: ACCOUNT_ROOT_PROFILE_LAYOUT });
  if (marker.collision) collisions.push(marker.collision); else plans.push(marker);
  if (collisions.length > 0) return { status: 'collision', runtime, targetRoot: root, collisions };

  const backupPath = path.join(root, '.moon-relay-kernel-backups', `account-root-${Date.now()}-${process.pid}`);
  const retiredRelaySkills = [];
  const backupEntries = [];
  try {
    if (prior) await backupManifestEntries({ root, prior, backupPath });
    for (const relativePath of ['AGENTS.md', 'config.toml', 'hooks.json']) {
      const existing = safeJoin(root, relativePath);
      if (await exists(existing)) {
        await copyTree(existing, safeJoin(backupPath, relativePath));
        backupEntries.push(relativePath);
      }
    }
    for (const name of LEGACY_RELAY_SKILL_NAMES) {
      const legacy = safeJoin(root, path.join('skills', name));
      if (await exists(legacy)) {
        await copyTree(legacy, safeJoin(backupPath, path.join('skills', name)));
        backupEntries.push(path.join('skills', name).replaceAll('\\', '/'));
        await rm(legacy, { recursive: true, force: true });
        retiredRelaySkills.push(name);
      }
    }
    await applyProfilePlans(plans);
    const hasBackup = backupEntries.length > 0 || Boolean(prior);
    const manifest = { schemaVersion: 2, productId: PROFILE_PRODUCT_ID, runtime, kernelRuntime: 'moon-relay-kernel', layout: ACCOUNT_ROOT_PROFILE_LAYOUT, targetRoot: root, runtimeHome: canonicalPath(effectiveRuntimeHome), sourceRoot: path.resolve(sourceRoot), installedAt: new Date().toISOString(), backupPath: hasBackup ? backupPath : null, retiredRelaySkills, files: plans.map((plan) => plan.entry) };
    await atomicWrite(manifestPath, JSON.stringify(manifest, null, 2));
    if (!hasBackup) await rm(backupPath, { recursive: true, force: true });
    else await atomicWrite(path.join(backupPath, 'account-root-backup.json'), JSON.stringify({ schemaVersion: 2, targetRoot: root, retiredRelaySkills }, null, 2));
    return { status: prior ? 'reinstalled' : 'installed', runtime, layout: ACCOUNT_ROOT_PROFILE_LAYOUT, targetRoot: root, manifestPath, backupPath: hasBackup ? backupPath : null, retiredRelaySkills, installedFilesCount: manifest.files.length };
  } catch (error) {
    if (prior && await exists(backupPath)) {
      try { await rollbackKernelProfile({ targetRoot: root, backupPath }); } catch {}
    } else if (!prior) {
      for (const plan of plans) await rm(plan.target, { force: true, recursive: true });
    }
    throw error;
  }
}

const removeEmptyParents = async (root, file) => {
  let cursor = path.dirname(file);
  while (cursor !== root && cursor.startsWith(`${root}${path.sep}`)) {
    try {
      if ((await readdir(cursor)).length > 0) break;
      await rm(cursor, { recursive: true, force: true });
      cursor = path.dirname(cursor);
    } catch { break; }
  }
};

const pruneEmptyJsonContainers = (value) => {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.filter((item) => item !== undefined).map(pruneEmptyJsonContainers);
  for (const [key, child] of Object.entries(value)) {
    if (child && typeof child === 'object') {
      pruneEmptyJsonContainers(child);
      if ((Array.isArray(child) && child.length === 0) || (!Array.isArray(child) && Object.keys(child).length === 0)) delete value[key];
    }
  }
  return value;
};

const removeManagedEntry = async (root, entry, { manifest = null, runtime = null, skillsRoot = null } = {}) => {
  const entryRoot = resolveProfileEntryRoot({ root, entry, manifest, runtime, skillsRoot });
  const file = safeJoin(entryRoot, entry.path);
  if (!(await exists(file))) return { changed: false };
  const ownership = ownershipFor(entry);
  if (ownership === PROFILE_OWNERSHIP.MANAGED_SECTION) {
    const text = await readFile(file, 'utf8');
    if (entry.format === 'toml-developer-instructions') {
      const assignment = parseDeveloperAssignment(text);
      if (!assignment) return { collision: collision(entryRoot, entry.path, ownership, 'managed-section-container-missing') };
      const inspected = inspectManagedSection(assignment.body, entry.sectionId || MANAGED_SECTION_ID);
      if (inspected.status !== 'present') return { collision: collision(entryRoot, entry.path, ownership, inspected.reason || 'managed-section-missing') };
      if (entry.managedChecksum && inspected.digest !== entry.managedChecksum) return { collision: collision(entryRoot, entry.path, ownership, 'modified-managed-section') };
      const removed = removeManagedSection(assignment.body, entry.sectionId || MANAGED_SECTION_ID);
      if (entry.createdByKernel && !removed.text.trim()) await rm(file, { force: true });
      else await atomicWrite(file, `${text.slice(0, assignment.start)}${assignment.prefix}${assignment.delimiter}${removed.text}${assignment.delimiter}${text.slice(assignment.end)}`);
      return { changed: true };
    }
    const inspected = inspectManagedSection(text, entry.sectionId || MANAGED_SECTION_ID);
    if (inspected.status !== 'present') return { collision: collision(entryRoot, entry.path, ownership, inspected.reason || 'managed-section-missing') };
    if (entry.managedChecksum && inspected.digest !== entry.managedChecksum) return { collision: collision(entryRoot, entry.path, ownership, 'modified-managed-section') };
    const removed = removeManagedSection(text, entry.sectionId || MANAGED_SECTION_ID);
    if (entry.createdByKernel && !removed.text.trim()) await rm(file, { force: true });
    else await atomicWrite(file, removed.text);
    return { changed: true };
  }
  if (ownership === PROFILE_OWNERSHIP.JSON_PATHS) {
    let value;
    try { value = await parseJsonFile(file); } catch { return { collision: collision(entryRoot, entry.path, ownership, 'invalid-shared-json') }; }
    const result = removeJsonOwnership(value, entry);
    if (result.failures.length > 0) return { collision: collision(entryRoot, entry.path, ownership, result.failures[0].reason, result.failures[0]) };
    if (!result.changed) return { changed: false };
    if (entry.createdByKernel) pruneEmptyJsonContainers(result.value);
    if (entry.createdByKernel && Object.keys(result.value || {}).length === 0) await rm(file, { force: true });
    else await atomicWrite(file, `${JSON.stringify(result.value, null, 2)}\n`);
    return { changed: true };
  }
  if (ownership === PROFILE_OWNERSHIP.OWNED_DIRECTORY) {
    const problem = await preflightOwnedEntry(root, entry, { manifest, runtime, skillsRoot });
    if (problem) return { collision: problem };
    if (entry.createdByKernel === false) return { changed: false, preserved: true };
    await rm(file, { force: true, recursive: true });
    await removeEmptyParents(entryRoot, file);
    return { changed: true };
  }
  const checksum = await sha256(file);
  if (entry.checksum && checksum !== entry.checksum) return { collision: collision(entryRoot, entry.path, ownership, 'modified-owned-file') };
  if (entry.createdByKernel === false && entry.path !== PROFILE_MARKER_NAME) return { changed: false, preserved: true };
  await rm(file, { force: true, recursive: true });
  await removeEmptyParents(entryRoot, file);
  return { changed: true };
};

export async function uninstallKernelProfile({ targetRoot } = {}) {
  const root = await safeProfileRoot(targetRoot);
  const manifestPath = profileManifestPath(root);
  if (!(await exists(manifestPath))) return { status: 'not_installed', targetRoot: root };
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (manifest.productId !== PROFILE_PRODUCT_ID) throw new Error('wrong_harness: foreign profile manifest');
  if (manifest.layout === ACCOUNT_ROOT_PROFILE_LAYOUT && Number(manifest.schemaVersion || 1) < 2) {
    const sharedEntry = (manifest.files || []).find((entry) => ['AGENTS.md', 'config.toml', 'hooks.json'].includes(entry.path));
    const legacyCollision = collision(
      root,
      sharedEntry?.path || 'account-root',
      ownershipFor(sharedEntry),
      'legacy-account-manifest-requires-reinstall',
    );
    return { status: 'collision', targetRoot: root, ...legacyCollision, collisions: [legacyCollision] };
  }
  const collisions = [];
  for (const entry of manifest.files || []) {
    const problem = await preflightOwnedEntry(root, entry, { manifest });
    if (problem) collisions.push(problem);
  }
  if (collisions.length > 0) return { status: 'collision', targetRoot: root, path: collisions[0].path, ownership: collisions[0].ownership, reason: collisions[0].reason, collisions };
  for (const entry of manifest.files || []) {
    const result = await removeManagedEntry(root, entry, { manifest });
    if (result.collision) return { status: 'collision', targetRoot: root, ...result.collision, collisions: [result.collision] };
  }
  await rm(manifestPath, { force: true });
  return { status: 'uninstalled', targetRoot: root, preserved: ['provider-created auth/session/cache/db/log/user data', 'foreign MCP entries', 'foreign hooks and instruction text'] };
}

export async function rollbackKernelProfile({ targetRoot, backupPath } = {}) {
  if (!backupPath || !(await exists(backupPath))) return { status: 'no_backup_found', targetRoot: path.resolve(targetRoot) };
  const root = await safeProfileRoot(targetRoot);
  const backup = path.resolve(backupPath);
  if (!backup.startsWith(`${root}${path.sep}`)) throw new Error('unsafe_target: backup outside profile root');
  const priorManifest = JSON.parse(await readFile(path.join(backup, PROFILE_MANIFEST_NAME), 'utf8'));
  const current = await inspectProfile(root);
  if (current.status === 'drift') return { status: 'collision', targetRoot: root };
  const currentManifest = current.manifest || (await exists(profileManifestPath(root)) ? JSON.parse(await readFile(profileManifestPath(root), 'utf8')) : null);
  const priorFiles = new Set((priorManifest.files || []).map((entry) => entry.path));
  const introducedEntries = (currentManifest?.files || []).filter((entry) => !priorFiles.has(entry.path));
  for (const entry of introducedEntries) {
    const problem = await preflightOwnedEntry(root, entry, { manifest: currentManifest });
    if (problem) return { status: 'collision', targetRoot: root, path: problem.path, ownership: problem.ownership, reason: problem.reason };
  }
  for (const entry of introducedEntries) {
    const entryRoot = resolveProfileEntryRoot({ root, entry, manifest: currentManifest });
    const file = safeJoin(entryRoot, entry.path);
    await rm(file, { force: true, recursive: true });
    await removeEmptyParents(entryRoot, file);
  }
  for (const rel of await files(backup)) {
    if (PROFILE_BACKUP_METADATA.has(rel)) continue;
    const targetRoot = resolveProfileEntryRoot({ root, entry: rel, manifest: priorManifest });
    await copyTree(safeJoin(backup, rel), safeJoin(targetRoot, rel));
  }
  await atomicWrite(profileManifestPath(root), JSON.stringify(priorManifest, null, 2));
  const postVerification = await inspectProfile(root);
  if (postVerification.status !== 'ready') throw new Error(`rollback_failed: post-rollback inspectProfile status is ${postVerification.status}`);
  return { status: 'rolled_back', targetRoot: root, backupPath: backup };
}
