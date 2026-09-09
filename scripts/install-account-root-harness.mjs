#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  access,
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  rmdir,
  stat,
  symlink,
  rename,
  writeFile,
} from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const defaultSourceRoot = path.dirname(path.dirname(scriptPath));

const manifestName = '.moonshot-relay-install-manifest.json';
const antigravitySkillsManifestName = '.moonshot-relay-antigravity-skills-manifest.json';
const legacyManifestNames = Object.freeze(['.claude-settings-install-manifest.json']);

const commonSpec = {
  runtime: 'moonshot-relay',
  payloadPath: path.join('moonshot-relay', 'profile'),
  defaultHome: () => path.join(os.homedir(), '.moonshot-relay'),
  envName: 'MOONSHOT_RELAY_HOME',
  ownedEntries: new Set([
    'bin',
    'catalog',
    'docs',
    'kernel',
    'rules',
    'schemas',
    'scripts',
    'skills',
    'templates',
    'tools',
    'package',
    'package.json',
    'package-lock.json',
    'skills.lock.json',
    'verification.contract.yaml',
  ]),
};

const runtimeSpecs = {
  claude: {
    payloadPath: path.join('claude', 'profile', '.claude'),
    defaultHome: () => path.join(os.homedir(), '.claude'),
    envName: 'CLAUDE_HOME',
    exposureEntries: new Set([
      'CLAUDE.md',
      'PROJECT.md',
      'README.md',
      'agents',
      'profile-contract.yaml',
      'rules',
      'skills',
      'verification.contract.yaml',
    ]),
    legacyNonExposureEntries: new Set([
      'bin',
      'docs',
      'schemas',
      'scripts',
      'templates',
      'tools',
    ]),
    protectedEntries: new Set([
      'backups',
      'cache',
      'debug',
      'downloads',
      'file-history',
      'history.jsonl',
      'ide',
      'memory.json',
      'paste-cache',
      'plans',
      'plugins',
      'projects',
      'session-env',
      'sessions',
      'settings.json',
      'shell-snapshots',
      'stats-cache.json',
      'statsig',
      'tasks',
      'telemetry',
      'todos',
      'memory-mcp-wrapper.log',
    ]),
    legacyHarnessCore: 'harness-core',
  },
  codex: {
    payloadPath: path.join('codex', 'profile', '.codex'),
    defaultHome: () => path.join(os.homedir(), '.codex'),
    envName: 'CODEX_HOME',
    exposureEntries: new Set([
      'AGENTS.md',
      'README.md',
      'agents',
      'rules',
      'skills',
      'verification.contract.yaml',
    ]),
    legacyNonExposureEntries: new Set([
      'bin',
      'docs',
      'schemas',
      'scripts',
      'templates',
      'tools',
    ]),
    protectedEntries: new Set([
      '.sandbox',
      '.sandbox-bin',
      '.sandbox-secrets',
      '.tmp',
      'ambient-suggestions',
      'automations',
      'auth.json',
      'backups',
      'bridge-runtime',
      'browser',
      'cache',
      'computer-use',
      'computer-use-turn-ended',
      'config.toml',
      'generated_images',
      'goals_1.sqlite',
      'history.jsonl',
      'installation_id',
      'log',
      'logs_2.sqlite',
      'memories',
      'models_cache.json',
      'node_repl',
      'pets',
      'plugins',
      'session_index.jsonl',
      'sessions',
      'sqlite',
      'state_5.sqlite',
      'tmp',
      'vendor_imports',
      'version.json',
    ]),
    legacyHarnessCore: 'harness-core',
  },
  qwen: {
    payloadPath: path.join('qwen', 'profile', '.qwen'),
    defaultHome: () => path.join(os.homedir(), '.qwen'),
    envName: 'QWEN_HOME',
    exposureEntries: new Set([
      'QWEN.md',
      'README.md',
      'agents',
      'rules',
      'skills',
      'verification.contract.yaml',
    ]),
    legacyNonExposureEntries: new Set([
      'bin',
      'docs',
      'schemas',
      'scripts',
      'templates',
      'tools',
    ]),
    protectedEntries: new Set([
      '.env',
      'auth.json',
      'backups',
      'cache',
      'credentials.json',
      'history.json',
      'history.jsonl',
      'logs',
      'memory',
      'memory.json',
      'mcp-oauth-tokens.json',
      'oauth_creds.json',
      'plugins',
      'settings.json',
      'shell_history',
      'startup-perf',
      'tmp',
      'todos',
    ]),
    legacyHarnessCore: 'harness-core',
  },
  antigravity: {
    payloadPath: path.join('antigravity', 'profile', '.gemini', 'antigravity'),
    defaultHome: () => path.join(os.homedir(), '.gemini', 'antigravity'),
    envName: 'ANTIGRAVITY_HOME',
    skillHome: () => path.join(os.homedir(), '.gemini', 'config'),
    skillEnvName: 'ANTIGRAVITY_SKILLS_HOME',
    skillHomeOption: 'antigravitySkills',
    exposureEntries: new Set([
      'GEMINI.md',
      'PROJECT.md',
      'README.md',
      'agents',
      'profile-contract.yaml',
      'rules',
      'skills',
      'verification.contract.yaml',
    ]),
    legacyNonExposureEntries: new Set([
      'bin',
      'docs',
      'schemas',
      'scripts',
      'templates',
      'tools',
    ]),
    protectedEntries: new Set([
      'annotations',
      'antigravity_state.pbtxt',
      'agyhub_summaries_proto.pb',
      'backups',
      'bin',
      'brain',
      'browser_recordings',
      'browserOnboardingStatus.txt',
      'code_tracker',
      'context_state',
      'conversations',
      'html_artifacts',
      'implicit',
      'installation_id',
      'knowledge',
      'mcp_config.json',
      'playground',
      'scratch',
      'user_settings.pb',
    ]),
    legacyHarnessCore: 'harness-core',
  },
};

// ADE embeds the Qwen-Code-compatible profile format but owns a distinct
// runtime home and Host identity. Reuse only the materialized profile payload.
runtimeSpecs.ade = {
  ...runtimeSpecs.qwen,
  defaultHome: () => null,
  envName: 'ADE_HOME',
};

const profileRuntimeNames = Object.freeze(['claude', 'codex', 'qwen', 'ade', 'antigravity']);

const usage = () => `Usage: node scripts/install-account-root-harness.mjs [--runtime all|claude,codex,qwen,ade,antigravity] [--source-root <repo>] [--payload-root <materialized-payload>] [--moonshot-home <dir>] [--codex-home <dir>] [--claude-home <dir>] [--qwen-home <dir>] [--ade-home <dir>] [--antigravity-home <dir>] [--antigravity-skills-home <dir>] [--skip-common] [--dry-run] [--json] [--no-backup] [--remove-legacy-harness-core]`;

const parseArgs = (argv) => {
  const options = {
    sourceRoot: defaultSourceRoot,
    payloadRoot: null,
    runtime: 'all',
    homes: {},
    dryRun: false,
    json: false,
    backup: true,
    removeLegacyHarnessCore: false,
    skipCommon: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--runtime') {
      options.runtime = argv[++index];
    } else if (arg === '--source-root') {
      options.sourceRoot = path.resolve(argv[++index]);
    } else if (arg === '--payload-root') {
      options.payloadRoot = path.resolve(argv[++index]);
    } else if (arg === '--moonshot-home') {
      options.homes[commonSpec.runtime] = path.resolve(argv[++index]);
    } else if (arg === '--codex-home') {
      options.homes.codex = path.resolve(argv[++index]);
    } else if (arg === '--claude-home') {
      options.homes.claude = path.resolve(argv[++index]);
    } else if (arg === '--qwen-home') {
      options.homes.qwen = path.resolve(argv[++index]);
    } else if (arg === '--ade-home') {
      options.homes.ade = path.resolve(argv[++index]);
    } else if (arg === '--antigravity-home') {
      options.homes.antigravity = path.resolve(argv[++index]);
    } else if (arg === '--antigravity-skills-home') {
      options.homes.antigravitySkills = path.resolve(argv[++index]);
    } else if (arg === '--skip-common') {
      options.skipCommon = true;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--no-backup') {
      options.backup = false;
    } else if (arg === '--remove-legacy-harness-core') {
      options.removeLegacyHarnessCore = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log(usage());
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}\n${usage()}`);
    }
  }

  const requestedRuntimes = options.runtime === 'all'
    ? profileRuntimeNames.filter((runtime) => runtime !== 'ade' || options.homes.ade || process.env.ADE_HOME)
    : options.runtime.split(',').map((runtime) => runtime.trim()).filter(Boolean);
  if (requestedRuntimes.length === 0 || requestedRuntimes.some((runtime) => !profileRuntimeNames.includes(runtime))) {
    throw new Error(`Unsupported runtime: ${options.runtime}\n${usage()}`);
  }
  options.runtimeNames = [...new Set(requestedRuntimes)];
  if (options.runtimeNames.includes('ade') && !options.homes.ade && !process.env.ADE_HOME) {
    throw new Error(`ADE runtime requires --ade-home <dir> or ADE_HOME.\n${usage()}`);
  }

  return options;
};

const pathExists = async (target) => {
  try {
    await access(target, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
};

const toPortable = (filePath) => filePath.split(path.sep).join('/');

const hashFile = async (target) => {
  const content = await readFile(target);
  return createHash('sha256').update(content).digest('hex');
};

const matchesManagedHash = async (record, target) => (
  typeof record.sha256 === 'string'
  && /^[a-f0-9]{64}$/u.test(record.sha256)
  && await hashFile(target) === record.sha256
);

const listFiles = async (root, prefix = '') => {
  const entries = await readdir(root, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const relative = path.join(prefix, entry.name);
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFiles(absolute, relative));
    } else if (entry.isFile()) {
      files.push(relative);
    }
  }

  return files.sort();
};

const assertSafeChild = (root, candidate) => {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Unsafe path outside target root: ${resolvedCandidate}`);
  }
};

const getAllowedRoots = () => {
  const roots = [];
  if (process.env.MOONSHOT_RELAY_HOME) roots.push(process.env.MOONSHOT_RELAY_HOME);
  if (process.env.CLAUDE_HOME) roots.push(process.env.CLAUDE_HOME);
  if (process.env.CODEX_HOME) roots.push(process.env.CODEX_HOME);
  if (process.env.QWEN_HOME) roots.push(process.env.QWEN_HOME);
  if (process.env.ADE_HOME) roots.push(process.env.ADE_HOME);
  if (process.env.ANTIGRAVITY_HOME) roots.push(process.env.ANTIGRAVITY_HOME);
  if (process.env.ANTIGRAVITY_SKILLS_HOME) roots.push(process.env.ANTIGRAVITY_SKILLS_HOME);

  roots.push(path.join(os.homedir(), '.moonshot-relay'));
  roots.push(path.join(os.homedir(), '.claude'));
  roots.push(path.join(os.homedir(), '.codex'));
  roots.push(path.join(os.homedir(), '.qwen'));
  roots.push(path.join(os.homedir(), '.gemini', 'antigravity'));
  roots.push(path.join(os.homedir(), '.gemini', 'config'));

  const argv = process.argv;
  for (let i = 0; i < argv.length; i++) {
    if (['--moonshot-home', '--claude-home', '--codex-home', '--qwen-home', '--ade-home', '--antigravity-home', '--antigravity-skills-home'].includes(argv[i])) {
      if (argv[i + 1]) {
        roots.push(argv[i + 1]);
      }
    }
  }
  return roots.map((p) => path.resolve(p));
};

const assertSafeTargetPath = async (root, candidate) => {
  assertSafeChild(root, candidate);

  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  let realRoot = resolvedRoot;
  try {
    realRoot = await realpath(resolvedRoot);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }

  const allowedRoots = [realRoot];
  for (const r of getAllowedRoots()) {
    try {
      allowedRoots.push(await realpath(r));
    } catch {
      allowedRoots.push(r);
    }
  }

  let current = resolvedRoot;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const currentStat = await lstat(current);
      if (currentStat.isSymbolicLink()) {
        const linkTarget = await realpath(current);
        const isSafe = allowedRoots.some((allowedRoot) => {
          const rel = path.relative(allowedRoot, linkTarget);
          return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
        });
        if (!isSafe) {
          throw new Error(`Unsafe symlink path under target root: ${current}`);
        }
      } else {
        const resolvedCurrent = await realpath(current);
        const isSafe = allowedRoots.some((allowedRoot) => {
          const rel = path.relative(allowedRoot, resolvedCurrent);
          return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
        });
        if (!isSafe) {
          throw new Error(`Unsafe path outside target root: ${resolvedCurrent}`);
        }
      }
    } catch (error) {
      if (error.code === 'ENOENT') {
        break;
      }
      throw error;
    }
  }
};

const resolveSpecHome = ({ spec, runtime, options }) => {
  const configured = options.homes[runtime] || process.env[spec.envName] || spec.defaultHome();
  if (!configured) throw new Error(`${runtime} home is required; configure ${spec.envName} or the matching --${runtime}-home option.`);
  return path.resolve(configured);
};

const resolveSkillHome = ({ spec, runtime, options, targetRoot }) => {
  if (!spec.skillHome) {
    return targetRoot;
  }

  const configured = options.homes[spec.skillHomeOption]
    || process.env[spec.skillEnvName];
  if (configured) {
    return path.resolve(configured);
  }

  if (runtime === 'antigravity' && (options.homes.antigravity || process.env[spec.envName])) {
    return path.resolve(path.join(path.dirname(targetRoot), 'config'));
  }

  return path.resolve(spec.skillHome());
};

const resolvePackageBuilder = async (sourceRoot) => {
  const builder = path.join(sourceRoot, 'package', 'build-package.mjs');
  if (!await pathExists(builder)) {
    throw new Error(
      `Package materializer not found: ${builder}. Run this installer from the moonshot-relay source checkout or pass --source-root <repo>.`,
    );
  }
  return builder;
};

const materializePayloads = async (sourceRoot, options) => {
  if (options.payloadRoot) {
    if (!await pathExists(options.payloadRoot)) {
      throw new Error(`Materialized payload root not found: ${options.payloadRoot}`);
    }
    return { root: options.payloadRoot, cleanup: false };
  }

  const packageBuilder = await resolvePackageBuilder(sourceRoot);
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'moonshot-relay-account-root-'));
  const buildRuntimes = options.runtime === 'all'
    ? ['all']
    : ['moonshot-relay', ...new Set(options.runtimeNames.map((runtime) => runtime === 'ade' ? 'qwen' : runtime))];

  try {
    for (const runtime of buildRuntimes) {
      const result = spawnSync(process.execPath, [
        packageBuilder,
        '--runtime',
        runtime,
        '--out',
        tmpRoot,
        '--clean',
        '--json',
      ], {
        cwd: sourceRoot,
        encoding: 'utf8',
      });

      if (result.status !== 0) {
        throw new Error(result.stderr || result.stdout || `Package materialization failed for ${runtime}.`);
      }
    }
  } catch (error) {
    await rm(tmpRoot, { recursive: true, force: true });
    throw error;
  }

  return { root: tmpRoot, cleanup: true };
};

const backupTarget = async (target, backupRoot) => {
  if (!await pathExists(target)) {
    return null;
  }

  await mkdir(backupRoot, { recursive: true });
  const destination = path.join(backupRoot, path.basename(target));
  await cp(target, destination, { recursive: true, force: true });
  return destination;
};

const readJsonFile = async (target) => {
  try {
    const parsed = JSON.parse(await readFile(target, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const pruneEmptyDirs = async (targetRoot, directories) => {
  const sorted = [...directories]
    .sort((a, b) => b.length - a.length);

  for (const relativeDir of sorted) {
    const absoluteDir = path.join(targetRoot, relativeDir);
    try {
      await rmdir(absoluteDir);
    } catch {
      // Directory is not empty, missing, or otherwise owned by the runtime/user.
    }
  }
};

const removePreviouslyManagedNonExposureFiles = async ({ targetRoot, exposureEntries, options }) => {
  if (options.dryRun) {
    return [];
  }

  const manifest = await readJsonFile(path.join(targetRoot, manifestName));
  if (!manifest || !Array.isArray(manifest.copied)) {
    return [];
  }

  const removed = [];
  const pruneCandidates = new Set();

  for (const record of manifest.copied) {
    if (!record || typeof record.path !== 'string') {
      continue;
    }

    const segments = record.path.split(/[\\/]/).filter(Boolean);
    const topLevel = segments[0];
    if (!topLevel || exposureEntries.has(topLevel)) {
      continue;
    }

    const target = path.join(targetRoot, ...segments);
    await assertSafeTargetPath(targetRoot, target);
    if (!await pathExists(target)) {
      continue;
    }

    const targetStat = await stat(target);
    if (targetStat.isDirectory()) {
      continue;
    }
    if (!await matchesManagedHash(record, target)) {
      continue;
    }

    await rm(target, { force: true });
    removed.push(toPortable(record.path));

    let relativeDir = path.dirname(path.join(...segments));
    while (relativeDir && relativeDir !== '.') {
      pruneCandidates.add(toPortable(relativeDir));
      relativeDir = path.dirname(relativeDir);
    }
  }

  await pruneEmptyDirs(targetRoot, pruneCandidates);
  return removed;
};

const removePreviouslyManagedSkillsAbsentFromPayload = async ({
  targetRoot,
  sourceRoot,
  options,
  manifestFileName = manifestName,
}) => {
  if (options.dryRun) {
    return [];
  }

  const manifest = await readJsonFile(path.join(targetRoot, manifestFileName));
  if (!manifest || !Array.isArray(manifest.copied)) {
    return [];
  }

  const removed = [];
  const pruneCandidates = new Set();

  for (const record of manifest.copied) {
    if (!record || typeof record.path !== 'string') {
      continue;
    }

    const segments = record.path.split(/[\\/]/).filter(Boolean);
    if (segments[0] !== 'skills' || !segments[1]) {
      continue;
    }

    const sourceSkill = path.join(sourceRoot, 'skills', segments[1]);
    if (await pathExists(sourceSkill)) {
      continue;
    }

    const target = path.join(targetRoot, ...segments);
    await assertSafeTargetPath(targetRoot, target);
    if (!await pathExists(target)) {
      continue;
    }

    const targetStat = await stat(target);
    if (targetStat.isDirectory()) {
      continue;
    }
    if (!await matchesManagedHash(record, target)) {
      continue;
    }

    await rm(target, { force: true });
    removed.push(toPortable(record.path));

    let relativeDir = path.dirname(path.join(...segments));
    while (relativeDir && relativeDir !== '.') {
      pruneCandidates.add(toPortable(relativeDir));
      relativeDir = path.dirname(relativeDir);
    }
  }

  await pruneEmptyDirs(targetRoot, pruneCandidates);
  return removed;
};

const removeCanonicalProfileSkillsAbsentFromPayload = async ({
  targetRoot,
  sourceRepo,
  sourceRoot,
  backupRoot,
  options,
}) => {
  const targetSkillsRoot = path.join(targetRoot, 'skills');
  const sourceSkillsRoot = path.join(sourceRepo, 'skills');
  const payloadSkillsRoot = path.join(sourceRoot, 'skills');
  if (!await pathExists(targetSkillsRoot) || !await pathExists(sourceSkillsRoot)) {
    return { removed: [], backups: [] };
  }

  const sourceSkillEntries = await readdir(sourceSkillsRoot, { withFileTypes: true });
  const canonicalSkillNames = new Set(sourceSkillEntries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name));
  const payloadSkillEntries = await pathExists(payloadSkillsRoot)
    ? await readdir(payloadSkillsRoot, { withFileTypes: true })
    : [];
  const payloadSkillNames = new Set(payloadSkillEntries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name));

  await assertSafeTargetPath(targetRoot, targetSkillsRoot);

  const removed = [];
  const backups = [];
  const targetSkillEntries = await readdir(targetSkillsRoot, { withFileTypes: true });
  for (const entry of targetSkillEntries) {
    if (!entry.isDirectory()) {
      continue;
    }
    if (!canonicalSkillNames.has(entry.name) || payloadSkillNames.has(entry.name)) {
      continue;
    }

    const target = path.join(targetSkillsRoot, entry.name);
    await assertSafeTargetPath(targetRoot, target);
    if (!options.dryRun && options.backup) {
      const backup = await backupTarget(target, backupRoot);
      if (backup) {
        backups.push(toPortable(path.relative(targetRoot, backup)));
      }
    }
    if (!options.dryRun) {
      await rm(target, { recursive: true, force: true });
    }
    removed.push(toPortable(path.join('skills', entry.name)));
  }

  await pruneEmptyDirs(targetRoot, ['skills']);
  return { removed, backups };
};

const removeLegacyNonExposureEntries = async ({
  targetRoot,
  backupRoot,
  exposureEntries,
  legacyEntries,
  options,
}) => {
  if (!legacyEntries || legacyEntries.size === 0) {
    return { removed: [], backups: [] };
  }

  const removed = [];
  const backups = [];

  for (const entryName of legacyEntries) {
    if (exposureEntries.has(entryName)) {
      continue;
    }

    const target = path.join(targetRoot, entryName);
    await assertSafeTargetPath(targetRoot, target);
    if (!await pathExists(target)) {
      continue;
    }

    if (!options.dryRun) {
      if (options.backup) {
        const backup = await backupTarget(target, backupRoot);
        if (backup) {
          backups.push(toPortable(path.relative(targetRoot, backup)));
        }
      }
      await rm(target, { recursive: true, force: true });
    }

    removed.push(entryName);
  }

  return { removed, backups };
};

const copyPayloadEntry = async ({ source, target, targetRoot, dryRun, replaceDirectories = false }) => {
  if (dryRun) {
    return;
  }

  await assertSafeTargetPath(targetRoot, target);
  await mkdir(path.dirname(target), { recursive: true });
  const sourceStat = await stat(source);
  if (sourceStat.isDirectory()) {
    if (replaceDirectories) {
      await rm(target, { recursive: true, force: true });
      await cp(source, target, { recursive: true, force: true });
      return;
    }

    if (await pathExists(target)) {
      const targetStat = await stat(target);
      if (!targetStat.isDirectory()) {
        await rm(target, { recursive: true, force: true });
        await cp(source, target, { recursive: true, force: true });
        return;
      }
    } else {
      await mkdir(target, { recursive: true });
    }

    const entries = await readdir(source, { withFileTypes: true });
    for (const entry of entries) {
      await copyPayloadEntry({
        source: path.join(source, entry.name),
        target: path.join(target, entry.name),
        targetRoot,
        dryRun,
        replaceDirectories,
      });
    }
  } else {
    if (await pathExists(target)) {
      const targetStat = await stat(target);
      if (targetStat.isDirectory()) {
        await rm(target, { recursive: true, force: true });
      }
    }
    await copyFile(source, target);
  }
};

const installPayloadSpec = async ({
  spec,
  runtime,
  payloadRoot,
  options,
  installId,
  sourceRepo,
  ownedEntries,
  replaceDirectories = false,
}) => {
  const targetRoot = resolveSpecHome({ spec, runtime, options });
  const skillTargetRoot = resolveSkillHome({ spec, runtime, options, targetRoot });
  const sourceRoot = path.join(payloadRoot, spec.payloadPath);

  if (!await pathExists(sourceRoot)) {
    throw new Error(`Missing materialized ${runtime} payload: ${sourceRoot}`);
  }

  const sourceEntries = (await readdir(sourceRoot, { withFileTypes: true }))
    .filter((entry) => !ownedEntries || ownedEntries.has(entry.name));
  const backupRoot = path.join(targetRoot, 'backups', `moonshot-relay-account-root-${installId}`);
  const copied = [];
  const skipped = [];
  const backups = [];
  const removed = [];

  if (!options.dryRun) {
    await mkdir(targetRoot, { recursive: true });
  }

  if (ownedEntries && !replaceDirectories) {
    removed.push(...await removePreviouslyManagedNonExposureFiles({
      targetRoot,
      exposureEntries: ownedEntries,
      options,
    }));

    if (ownedEntries.has('skills')) {
      removed.push(...await removePreviouslyManagedSkillsAbsentFromPayload({
        targetRoot,
        sourceRoot,
        options,
      }));

      const canonicalSkillCleanup = await removeCanonicalProfileSkillsAbsentFromPayload({
        targetRoot,
        sourceRepo,
        sourceRoot,
        backupRoot,
        options,
      });
      removed.push(...canonicalSkillCleanup.removed);
      backups.push(...canonicalSkillCleanup.backups);
    }

    const legacyCleanup = await removeLegacyNonExposureEntries({
      targetRoot,
      backupRoot,
      exposureEntries: ownedEntries,
      legacyEntries: spec.legacyNonExposureEntries,
      options,
    });
    removed.push(...legacyCleanup.removed);
    backups.push(...legacyCleanup.backups);
  }

  for (const entry of sourceEntries) {
    if (spec.protectedEntries?.has(entry.name)) {
      skipped.push({
        path: entry.name,
        reason: 'protected_runtime_entry',
      });
      continue;
    }

    const source = path.join(sourceRoot, entry.name);
    const target = path.join(targetRoot, entry.name);
    await assertSafeTargetPath(targetRoot, target);

    if (options.backup && !options.dryRun) {
      const backup = await backupTarget(target, backupRoot);
      if (backup) {
        backups.push(toPortable(path.relative(targetRoot, backup)));
      }
    }

    await copyPayloadEntry({ source, target, targetRoot, dryRun: options.dryRun, replaceDirectories });

    const files = entry.isDirectory()
      ? await listFiles(source, entry.name)
      : [entry.name];

    for (const relativeFile of files) {
      const targetFile = path.join(targetRoot, relativeFile);
      copied.push({
        path: toPortable(relativeFile),
        sha256: options.dryRun ? null : await hashFile(targetFile),
      });
    }
  }

  const legacyHarnessCore = spec.legacyHarnessCore
    ? path.join(targetRoot, spec.legacyHarnessCore)
    : null;
  if (legacyHarnessCore && options.removeLegacyHarnessCore && await pathExists(legacyHarnessCore)) {
    assertSafeChild(targetRoot, legacyHarnessCore);
    if (!options.dryRun) {
      if (options.backup) {
        const backup = await backupTarget(legacyHarnessCore, backupRoot);
        if (backup) {
          backups.push(toPortable(path.relative(targetRoot, backup)));
        }
      }
      await rm(legacyHarnessCore, { recursive: true, force: true });
    }
    skipped.push({
      path: spec.legacyHarnessCore,
      reason: 'removed_legacy_harness_core',
    });
  }

  const manifest = {
    schemaVersion: 1,
    installId,
    runtime,
    installMode: 'account-root-direct',
    targetRoot,
    sourceRepo,
    commonRoot: path.resolve(
      options.homes[commonSpec.runtime]
        || process.env[commonSpec.envName]
        || commonSpec.defaultHome(),
    ),
    skillTargetRoot,
    legacyHarnessCorePresent: legacyHarnessCore ? await pathExists(legacyHarnessCore) : false,
    copied,
    skipped,
    backups,
    removed,
  };

  if (!options.dryRun) {
    await writeFile(path.join(targetRoot, manifestName), `${JSON.stringify(manifest, null, 2)}\n`);
    for (const legacyManifestName of legacyManifestNames) {
      const legacyManifestPath = path.join(targetRoot, legacyManifestName);
      if (await pathExists(legacyManifestPath)) {
        let legacyManifest;
        try {
          const parsedLegacyManifest = JSON.parse(await readFile(legacyManifestPath, 'utf8'));
          legacyManifest = parsedLegacyManifest
            && typeof parsedLegacyManifest === 'object'
            && !Array.isArray(parsedLegacyManifest)
            ? parsedLegacyManifest
            : {};
        } catch {
          legacyManifest = {};
        }
        await writeFile(legacyManifestPath, `${JSON.stringify({
          ...legacyManifest,
          legacyManifest: true,
          supersededBy: manifestName,
        }, null, 2)}\n`);
      }
    }
  }

  return manifest;
};

const installAntigravitySkillsProjection = async ({
  spec,
  payloadRoot,
  options,
  installId,
  sourceRepo,
}) => {
  const profileTargetRoot = resolveSpecHome({ spec, runtime: 'antigravity', options });
  const targetRoot = resolveSkillHome({
    spec,
    runtime: 'antigravity',
    options,
    targetRoot: profileTargetRoot,
  });
  const sourceRoot = path.join(payloadRoot, spec.payloadPath);
  const sourceSkillsRoot = path.join(sourceRoot, 'skills');
  const targetSkillsRoot = path.join(targetRoot, 'skills');
  const backupRoot = path.join(targetRoot, 'backups', `moonshot-relay-antigravity-skills-${installId}`);
  const copied = [];
  const skipped = [];
  const backups = [];
  const removed = [];

  if (!await pathExists(sourceSkillsRoot)) {
    throw new Error(`Missing materialized antigravity skills payload: ${sourceSkillsRoot}`);
  }

  if (!options.dryRun) {
    await mkdir(targetRoot, { recursive: true });
    removed.push(...await removePreviouslyManagedSkillsAbsentFromPayload({
      targetRoot,
      sourceRoot,
      options,
      manifestFileName: antigravitySkillsManifestName,
    }));

    const canonicalSkillCleanup = await removeCanonicalProfileSkillsAbsentFromPayload({
      targetRoot,
      sourceRepo,
      sourceRoot,
      backupRoot,
      options,
    });
    removed.push(...canonicalSkillCleanup.removed);
    backups.push(...canonicalSkillCleanup.backups);
  }

  const sourceEntries = await readdir(sourceSkillsRoot, { withFileTypes: true });
  for (const entry of sourceEntries) {
    const source = path.join(sourceSkillsRoot, entry.name);
    const target = path.join(targetSkillsRoot, entry.name);
    await assertSafeTargetPath(targetRoot, target);

    if (options.backup && !options.dryRun) {
      const backup = await backupTarget(target, backupRoot);
      if (backup) {
        backups.push(toPortable(path.relative(targetRoot, backup)));
      }
    }

    await copyPayloadEntry({
      source,
      target,
      targetRoot,
      dryRun: options.dryRun,
      replaceDirectories: false,
    });

    const files = entry.isDirectory()
      ? await listFiles(source, entry.name)
      : [entry.name];
    for (const relativeFile of files) {
      const relativePath = path.join('skills', relativeFile);
      const targetFile = path.join(targetRoot, relativePath);
      copied.push({
        path: toPortable(relativePath),
        sha256: options.dryRun ? null : await hashFile(targetFile),
      });
    }
  }

  const manifest = {
    schemaVersion: 1,
    installId,
    runtime: 'antigravity-global-skills',
    installMode: 'account-root-direct',
    targetRoot,
    sourceRepo,
    profileRoot: profileTargetRoot,
    commonRoot: path.resolve(
      options.homes[commonSpec.runtime]
        || process.env[commonSpec.envName]
        || commonSpec.defaultHome(),
    ),
    copied,
    skipped,
    backups,
    removed,
  };

  if (!options.dryRun) {
    await writeFile(
      path.join(targetRoot, antigravitySkillsManifestName),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
  }

  return manifest;
};

const copyRecursive = async (src, dest) => {
  const statVal = await stat(src);
  if (statVal.isDirectory()) {
    await mkdir(dest, { recursive: true });
    const entries = await readdir(src);
    for (const entry of entries) {
      await copyRecursive(path.join(src, entry), path.join(dest, entry));
    }
  } else {
    await copyFile(src, dest);
  }
};

const installManagedNodeRuntime = async ({ targetRoot, payloadRoot, options }) => {
  const sourceRuntimeDir = path.join(payloadRoot, 'moonshot-relay', 'profile', 'runtime');
  const targetRuntimeDir = path.join(targetRoot, 'runtime');
  
  if (!await pathExists(sourceRuntimeDir)) {
    return;
  }
  
  const manifestPath = path.join(sourceRuntimeDir, 'runtime-manifest.json');
  if (!await pathExists(manifestPath)) {
    throw new Error(`Missing runtime-manifest.json in payload`);
  }
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const versionString = `${manifest.version}-${manifest.platform}-${manifest.arch}`;
  
  const sourceVersionDir = path.join(sourceRuntimeDir, 'versions', versionString);
  const targetVersionsDir = path.join(targetRuntimeDir, 'versions');
  const targetVersionDir = path.join(targetVersionsDir, versionString);
  const targetCurrentDir = path.join(targetRuntimeDir, 'current');
  
  if (options.dryRun) {
    if (!options.json) {
      console.log(`[dry-run] Would copy runtime version to ${targetVersionDir}`);
      console.log(`[dry-run] Would atomically switch ${targetCurrentDir} to ${targetVersionDir}`);
    }
    return;
  }
  
  await mkdir(targetVersionsDir, { recursive: true });
  
  const targetVersionTmpDir = `${targetVersionDir}.tmp`;
  await rm(targetVersionTmpDir, { recursive: true, force: true });
  await copyRecursive(sourceVersionDir, targetVersionTmpDir);
  
  const nodeBinaryName = manifest.platform === 'win32' ? 'node.exe' : 'bin/node';
  const nodeBinaryPath = path.join(targetVersionTmpDir, nodeBinaryName);
  
  if (!await pathExists(nodeBinaryPath)) {
    await rm(targetVersionTmpDir, { recursive: true, force: true });
    throw new Error(`Missing Node binary in materialized payload: ${nodeBinaryPath}`);
  }
  
  const { spawnSync } = await import('node:child_process');
  const smoke = spawnSync(nodeBinaryPath, ['-v'], { encoding: 'utf8' });
  if (smoke.status !== 0 || !smoke.stdout.startsWith('v')) {
    await rm(targetVersionTmpDir, { recursive: true, force: true });
    throw new Error(`Runtime binary failed execution smoke check: ${smoke.stderr || smoke.stdout}`);
  }
  
  await rm(targetVersionDir, { recursive: true, force: true });
  await rename(targetVersionTmpDir, targetVersionDir);
  
  let previousPath = null;
  if (await pathExists(targetCurrentDir)) {
    previousPath = await realpath(targetCurrentDir).catch(() => targetCurrentDir);
  }
  
  const targetCurrentTmp = `${targetCurrentDir}.tmp`;
  await rm(targetCurrentTmp, { recursive: true, force: true });
  
  try {
    if (manifest.platform === 'win32') {
      await symlink(targetVersionDir, targetCurrentTmp, 'junction');
    } else {
      await symlink(targetVersionDir, targetCurrentTmp);
    }
    await rm(targetCurrentDir, { recursive: true, force: true });
    await rename(targetCurrentTmp, targetCurrentDir);
  } catch (err) {
    await copyRecursive(targetVersionDir, targetCurrentTmp);
    await rm(targetCurrentDir, { recursive: true, force: true });
    await rename(targetCurrentTmp, targetCurrentDir);
  }
  
  await writeFile(path.join(targetRuntimeDir, 'runtime-manifest.json'), JSON.stringify({
    ...manifest,
    previousRuntime: previousPath ? path.relative(targetRuntimeDir, previousPath) : null
  }, null, 2));
};

const installCommonRuntime = async ({ payloadRoot, options, installId, sourceRepo }) => {
  const manifest = await installPayloadSpec({
    spec: commonSpec,
    runtime: commonSpec.runtime,
    payloadRoot,
    options,
    installId,
    sourceRepo,
    ownedEntries: commonSpec.ownedEntries,
    replaceDirectories: true,
  });
  
  const targetRoot = resolveSpecHome({ spec: commonSpec, runtime: commonSpec.runtime, options });
  await installManagedNodeRuntime({ targetRoot, payloadRoot, options });
  
  return manifest;
};

const installRuntime = async ({ runtime, payloadRoot, options, installId, sourceRepo }) => {
  const spec = runtimeSpecs[runtime];
  const manifest = await installPayloadSpec({
    spec,
    runtime,
    payloadRoot,
    options,
    installId,
    sourceRepo,
    ownedEntries: spec.exposureEntries,
    replaceDirectories: false,
  });

  if (runtime !== 'antigravity') {
    return [manifest];
  }

  const skillsManifest = await installAntigravitySkillsProjection({
    spec,
    payloadRoot,
    options,
    installId,
    sourceRepo,
  });
  return [manifest, skillsManifest];
};

const verifyRuntimeManifest = async (manifest) => {
  const missing = [];
  const mismatch = [];

  for (const record of manifest.copied) {
    const target = path.join(record.targetRoot || manifest.targetRoot, record.path);
    if (!await pathExists(target)) {
      missing.push(record.path);
      continue;
    }
    const actualHash = await hashFile(target);
    if (actualHash !== record.sha256) {
      mismatch.push(record.path);
    }
  }

  return {
    runtime: manifest.runtime,
    targetRoot: manifest.targetRoot,
    checked: manifest.copied.length,
    missing,
    mismatch,
  };
};

const readRuntimeSurface = async (sourceRepo) => {
  const surface = await readJsonFile(path.join(sourceRepo, 'package', 'runtime-surface.json'));
  if (!surface || !Array.isArray(surface.publicRuntimeSkills)) {
    throw new Error('package/runtime-surface.json must define publicRuntimeSkills.');
  }
  return surface.publicRuntimeSkills;
};

const listDirectoryNames = async (root) => {
  if (!await pathExists(root)) {
    return [];
  }
  const entries = await readdir(root, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
};

const computeProfileSurfaceParity = async ({ manifest, sourceRepo, publicRuntimeSkills }) => {
  if (!['claude', 'codex', 'qwen', 'ade', 'antigravity'].includes(manifest.runtime)) {
    return null;
  }

  const skillTargetRoot = manifest.skillTargetRoot || manifest.targetRoot;
  const installedSkillNames = await listDirectoryNames(path.join(skillTargetRoot, 'skills'));
  const canonicalSkillNames = new Set(await listDirectoryNames(path.join(sourceRepo, 'skills')));
  const expected = [...publicRuntimeSkills].sort();
  const expectedSet = new Set(expected);
  const missingPublicSkills = expected.filter((skill) => !installedSkillNames.includes(skill));
  const extraPublicSkills = installedSkillNames
    .filter((skill) => expectedSet.has(skill) === false && canonicalSkillNames.has(skill) === false);
  const extraCanonicalSkills = installedSkillNames
    .filter((skill) => expectedSet.has(skill) === false && canonicalSkillNames.has(skill));

  return {
    runtime: manifest.runtime,
    targetRoot: manifest.targetRoot,
    skillTargetRoot,
    expectedPublicSkills: expected,
    installedPublicSkills: installedSkillNames.filter((skill) => expectedSet.has(skill)).sort(),
    missingPublicSkills,
    extraPublicSkills,
    extraCanonicalSkills,
    extraCanonicalCount: extraCanonicalSkills.length,
    status: missingPublicSkills.length === 0 && extraCanonicalSkills.length === 0 ? 'pass' : 'blocked',
  };
};

const main = async () => {
  const options = parseArgs(process.argv.slice(2));
  const sourceRepo = options.sourceRoot;
  const runtimes = options.runtimeNames;
  const installId = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
  const materialized = await materializePayloads(sourceRepo, options);
  const payloadRoot = materialized.root;
  const publicRuntimeSkills = await readRuntimeSurface(sourceRepo);

  try {
    const manifests = [];
    if (!options.skipCommon) {
      manifests.push(await installCommonRuntime({ payloadRoot, options, installId, sourceRepo }));
    }
    for (const runtime of runtimes) {
      manifests.push(...await installRuntime({ runtime, payloadRoot, options, installId, sourceRepo }));
    }

    const verification = options.dryRun
      ? []
      : await Promise.all(manifests.map((manifest) => verifyRuntimeManifest(manifest)));
    const profileSurfaceParity = options.dryRun
      ? []
      : (await Promise.all(manifests.map((manifest) => computeProfileSurfaceParity({
        manifest,
        sourceRepo,
        publicRuntimeSkills,
      })))).filter(Boolean);

    const result = {
      installId,
      mode: 'account-root-direct',
      dryRun: options.dryRun,
      manifests: manifests.map((manifest) => ({
        runtime: manifest.runtime,
        targetRoot: manifest.targetRoot,
        skillTargetRoot: manifest.skillTargetRoot || null,
        copiedCount: manifest.copied.length,
        legacyHarnessCorePresent: manifest.legacyHarnessCorePresent,
        skipped: manifest.skipped,
        removedCount: manifest.removed.length,
        backupCount: manifest.backups.length,
      })),
      verification,
      profileSurfaceParity,
    };

    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      for (const manifest of result.manifests) {
        const verb = result.dryRun ? 'would install' : 'installed';
        console.log(`${manifest.runtime}: ${verb} ${manifest.copiedCount} files into ${manifest.targetRoot}`);
      }
    }
  } finally {
    if (materialized.cleanup) {
      await rm(payloadRoot, { recursive: true, force: true });
    }
  }
};

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
