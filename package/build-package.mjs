#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  access,
  chmod,
  copyFile,
  cp,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { assertRuntimeBuild } from '../scripts/lib/runtime-build.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const packageRoot = path.dirname(scriptPath);
const repoRoot = path.dirname(packageRoot);
const runtimeSurfacePath = path.join(packageRoot, 'runtime-surface.json');

const generatedRoot = packageRoot;

const runtimeSpecs = {
  'moonshot-relay': {
    outputRoot: path.join('moonshot-relay', 'profile'),
    sharedDirs: [
      'catalog',
      'bin',
      'kernel',
      'scripts/kernel',
      'tools',
      'schemas',
      'templates',
      'skills',
      path.join('docs', 'public'),
      'rules',
    ],
    sharedFiles: [
      'package/runtime-surface.json',
      'package.json',
      'package-lock.json',
      'skills.lock.json',
      'scripts/catalog-check.mjs',
      'scripts/lib/runtime-build.mjs',
      'scripts/skill-router.mjs',
      'scripts/lint-skills.mjs',
      'scripts/architecture-context-build.mjs',
      'scripts/architecture-knowledge-resolve.mjs',
      'scripts/architecture-contract-bind.mjs',
      'scripts/architecture-handoff-build.mjs',
      'scripts/architecture-feedback-render.mjs',
      'scripts/awtl-memory-promotion.mjs',
      'scripts/architecture-artifact-validate.mjs',
      'scripts/browser-flow-runner.mjs',
      'scripts/code-review-graph-mcp-wrapper.js',
      'scripts/codex-mcp-singleton.mjs',
      'scripts/commit-moonshot-closeout-event.mjs',
      'scripts/commit-moonshot-memory-refresh.mjs',
      'scripts/commit-moonshot-promotion-audit.mjs',
      'scripts/context-state.mjs',
      'scripts/contract-engine.mjs',
      'scripts/delivery-submit.mjs',
      'scripts/doctor.mjs',
      'scripts/install-account-root-harness.mjs',
      'scripts/install-browser-runtime.mjs',
      'scripts/install-browser-runtime.sh',
      'scripts/install-project-runtime-bridge.mjs',
      'scripts/installed-release-resolve.mjs',
      'scripts/knowledge-context-build.mjs',
      'scripts/knowledge-improvement-lifecycle.mjs',
      'scripts/knowledge-records.mjs',
      'scripts/memory-claim-validate.mjs',
      'scripts/lib/awtl-event-schema.mjs',
      'scripts/lib/awtl-failure-attribution.mjs',
      'scripts/lib/awtl-harness-capture.mjs',
      'scripts/lib/awtl-memory-candidate.mjs',
      'scripts/lib/awtl-memory-promotion.mjs',
      'scripts/lib/awtl-redaction.mjs',
      'scripts/lib/awtl-replay-probes.mjs',
      'scripts/lib/awtl-replay-scorecard.mjs',
      'scripts/lib/awtl-trace-sink.mjs',
      'scripts/lib/candidate-identity.mjs',
      // Host-side Kernel model routing. These map a logical model class onto a
      // provider model for the installed Host; they carry no provider SDK and
      // are deliberately NOT part of the Kernel payload (§4.1).
      'scripts/host/kernel/model-registry.mjs',
      'scripts/host/kernel/turn-dispatcher.mjs',
      'scripts/host/kernel/usage-receipt.mjs',
      'scripts/host/kernel/adapters/claude.mjs',
      'scripts/host/kernel/adapters/codex.mjs',
      'scripts/host/kernel/adapters/fable.mjs',
      'scripts/lib/browser-failure-package.mjs',
      'scripts/lib/browser-scenario-contract.mjs',
      'scripts/lib/context-state-engine.mjs',
      'scripts/lib/commit-closeout-events.mjs',
      'scripts/lib/contract-invalidation.mjs',
      'scripts/lib/delivery-policy.mjs',
      'scripts/lib/event-ledger.mjs',
      'scripts/lib/failure-classifier.mjs',
      'scripts/lib/git-safe.mjs',
      'scripts/lib/harness-environment-snapshot.mjs',
      'scripts/lib/memory-claim-ledger.mjs',
      'scripts/lib/memory-control-plane-contracts.mjs',
      'scripts/lib/plan-graph.mjs',
      'scripts/lib/phase-runner-session-audit.mjs',
      'scripts/lib/phase-event-ledger.mjs',
      'scripts/lib/phase-run-lease-store.mjs',
      'scripts/lib/portable-command-runner.mjs',
      'scripts/lib/review-bundle.mjs',
      'scripts/lib/runtime-state-db-path.mjs',
      'scripts/lib/runtime-state-root.mjs',
      'scripts/lib/runtime-unavailable-cache.mjs',
      'scripts/memory-mcp-wrapper.js',
      'scripts/memorygraph-direct.mjs',
      'scripts/memorygraph-mcp-wrapper.js',
      'scripts/memorygraph-mcp-wrapper.mjs',
      'scripts/memorygraph-project-index.mjs',
      'scripts/ontology-constraint-validate.mjs',
      'scripts/phase-final-guard.mjs',
      'scripts/phase-runner-session-audit.mjs',
      'scripts/plan-graph-validate.mjs',
      'scripts/prepare-phase-runner-state.mjs',
      'scripts/project-identity.mjs',
      'scripts/provider-model-route-advisor.mjs',
      'scripts/review-bundle-build.mjs',
      'scripts/runtime-state.mjs',
      'scripts/skills-audit.mjs',
      'scripts/spec-test-obligations.mjs',
      'scripts/lib/skills-lock.mjs',
      'scripts/lib/runtime-state-store.mjs',
      'scripts/lib/sqlite-driver.mjs',
      'scripts/lib/sqlite-drivers/node-sqlite.mjs',
      'scripts/lib/moonshot-runtime-resolver.mjs',
      'scripts/lib/control-plane-policy.mjs',
      'scripts/lib/execution-cursor.mjs',
      'scripts/lib/workflow-bundle-resolver.mjs',
      'scripts/verification-plane.mjs',
      'scripts/lib/verification-plane.mjs',
      'scripts/lib/provider-model-routing.mjs',
      'scripts/lib/providers/codex-gpt-5-6-adapter.mjs',
      'scripts/verification-verdict-state.mjs',
      'scripts/workspace-manager.mjs',
      'scripts/lib/workspace-manager.mjs',
    ],
    materializeRuntimeDependencies: false,
    verificationTarget: 'verification.contract.yaml',
  },
  claude: {
    templateRoot: path.join(packageRoot, 'profile-templates', 'claude', '.claude'),
    outputRoot: path.join('claude', 'profile', '.claude'),
    sharedDirs: [
      'skills',
      'agents',
      'rules',
    ],
    sharedFiles: [],
    skillExposure: 'publicRuntimeSkills',
    verificationTarget: 'verification.contract.yaml',
  },
  codex: {
    templateRoot: path.join(packageRoot, 'profile-templates', 'codex', '.codex'),
    outputRoot: path.join('codex', 'profile', '.codex'),
    sharedDirs: [
      'skills',
      'agents',
      'rules',
    ],
    sharedFiles: [],
    skillExposure: 'publicRuntimeSkills',
    verificationTarget: 'verification.contract.yaml',
  },
  qwen: {
    templateRoot: path.join(packageRoot, 'profile-templates', 'qwen', '.qwen'),
    outputRoot: path.join('qwen', 'profile', '.qwen'),
    sharedDirs: [
      'skills',
      'agents',
      'rules',
    ],
    sharedFiles: [],
    skillExposure: 'publicRuntimeSkills',
    verificationTarget: 'verification.contract.yaml',
  },
  antigravity: {
    templateRoot: path.join(packageRoot, 'profile-templates', 'antigravity', '.gemini', 'antigravity'),
    outputRoot: path.join('antigravity', 'profile', '.gemini', 'antigravity'),
    sharedDirs: [
      'skills',
      'agents',
      'rules',
    ],
    sharedFiles: [],
    skillExposure: 'publicRuntimeSkills',
    verificationTarget: 'verification.contract.yaml',
  },
};

const denyRootSegments = new Set([
  '.git',
  '.moonshot-relay',
  '.moonshot-state',
  '.code-review-graph',
  'node_modules',
  '__pycache__',
]);

const denyRuntimeSegments = new Set([
  'browser-artifacts',
  'browser-runtime',
  'cache',
  'logs',
  'memorygraph',
  'memories',
  'sessions',
  'sqlite',
  'sandbox-artifacts',
  'tmp',
  'traces',
]);

const denyRuntimeRoots = new Set([
  '.claude',
  '.codex',
  '.qwen',
  '.gemini',
  '.moonshot-relay',
  '.moonshot-state',
]);

const denyPathPrefixes = [
  'scripts/fixtures/',
  'tests/fixtures/',
];

const denyBasenames = [
  /^runtime-state\.sqlite/,
  /^memory\.json$/,
  /^verification-verdict-/,
  /^runtime-verdict-/,
  /^browser-flow-verdict-/,
  /^knowledge-repo-audit-/,
  /\.test\.[cm]?js$/,
  /\.e2e\.test\.[cm]?js$/,
  /_test\.py$/,
  /\.test\.py$/,
  /\.pyc$/,
];

const usage = () => `Usage: node package/build-package.mjs [--runtime all|moonshot-relay|claude|codex|qwen|antigravity] [--out <dir>] [--clean] [--dry-run] [--json]`;

const allRuntimeNames = ['moonshot-relay', 'claude', 'codex', 'qwen', 'antigravity'];
let runtimeSurfaceCache = null;

const parseArgs = (argv) => {
  const options = {
    runtime: 'all',
    out: generatedRoot,
    clean: false,
    dryRun: false,
    json: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--runtime') {
      options.runtime = argv[++index];
    } else if (arg === '--out') {
      options.out = path.resolve(argv[++index]);
    } else if (arg === '--clean') {
      options.clean = true;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log(usage());
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}\n${usage()}`);
    }
  }

  if (!['all', ...allRuntimeNames].includes(options.runtime)) {
    throw new Error(`Unsupported runtime: ${options.runtime}\n${usage()}`);
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

const shouldExclude = (sourcePath) => {
  const relative = path.relative(repoRoot, sourcePath);
  const portableRelative = toPortable(relative);
  const segments = relative.split(path.sep);
  const basename = path.basename(sourcePath);

  if (segments.some((segment) => denyRootSegments.has(segment))) {
    return true;
  }

  if (denyPathPrefixes.some((prefix) => portableRelative === prefix.slice(0, -1) || portableRelative.startsWith(prefix))) {
    return true;
  }

  if (denyRuntimeRoots.has(segments[0]) && segments.some((segment) => denyRuntimeSegments.has(segment))) {
    return true;
  }

  return denyBasenames.some((pattern) => pattern.test(basename));
};

const walkTree = async (source, visit) => {
  const entries = await readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = path.join(source, entry.name);
    await visit(absolute, entry);
    if (entry.isDirectory()) {
      await walkTree(absolute, visit);
    }
  }
};

const planTree = async (source, destination, plannedCopies) => {
  await walkTree(source, async (candidate) => {
    const excluded = shouldExclude(candidate);
    if (!excluded) {
      plannedCopies.push({
        from: toPortable(path.relative(repoRoot, candidate)),
        to: toPortable(path.relative(repoRoot, path.join(destination, path.relative(source, candidate)))),
      });
    }
  });
};

const copyTree = async (source, destination, plannedCopies, options = {}) => {
  if (!await pathExists(source)) {
    throw new Error(`Missing package source: ${path.relative(repoRoot, source)}`);
  }

  if (options.dryRun) {
    await planTree(source, destination, plannedCopies);
    return;
  }

  await cp(source, destination, {
    recursive: true,
    force: true,
    preserveTimestamps: false,
    filter: (candidate) => {
      const excluded = shouldExclude(candidate);
      if (!excluded && candidate !== source) {
        plannedCopies.push({
          from: toPortable(path.relative(repoRoot, candidate)),
          to: toPortable(path.relative(repoRoot, path.join(destination, path.relative(source, candidate)))),
        });
      }
      return !excluded;
    },
  });
};

const loadRuntimeSurface = async () => {
  if (!runtimeSurfaceCache) {
    runtimeSurfaceCache = JSON.parse(await readFile(runtimeSurfacePath, 'utf8'));
    if (!Array.isArray(runtimeSurfaceCache.publicRuntimeSkills) || runtimeSurfaceCache.publicRuntimeSkills.length === 0) {
      throw new Error('package/runtime-surface.json must define publicRuntimeSkills.');
    }
  }
  return runtimeSurfaceCache;
};

const copyPublicRuntimeSkills = async (sourceRoot, destinationRoot, plannedCopies, options = {}) => {
  const surface = await loadRuntimeSurface();
  const publicSkills = [...surface.publicRuntimeSkills];

  for (const skillName of publicSkills) {
    const source = path.join(sourceRoot, skillName);
    const destination = path.join(destinationRoot, skillName);
    await copyTree(source, destination, plannedCopies, options);
  }
};

const copyTreeWithoutPackageExclusions = async (source, destination, plannedCopies, options = {}) => {
  if (!await pathExists(source)) {
    throw new Error(`Missing runtime dependency source: ${path.relative(repoRoot, source)}`);
  }

  if (options.dryRun) {
    await walkTree(source, async (candidate) => {
      plannedCopies.push({
        from: toPortable(path.relative(repoRoot, candidate)),
        to: toPortable(path.relative(repoRoot, path.join(destination, path.relative(source, candidate)))),
      });
    });
    return;
  }

  await cp(source, destination, {
    recursive: true,
    force: true,
    preserveTimestamps: false,
    filter: (candidate) => {
      if (candidate !== source) {
        plannedCopies.push({
          from: toPortable(path.relative(repoRoot, candidate)),
          to: toPortable(path.relative(repoRoot, path.join(destination, path.relative(source, candidate)))),
        });
      }
      return true;
    },
  });
};

const productionDependencyRoots = async () => {
  const lock = JSON.parse(await readFile(path.join(repoRoot, 'package-lock.json'), 'utf8'));
  return Object.entries(lock.packages || {})
    .filter(([entry, meta]) => entry.startsWith('node_modules/') && !meta.dev)
    .map(([entry]) => entry)
    .sort();
};

const materializeRuntimeDependencies = async (outputRoot, plannedCopies, options = {}) => {
  for (const dependencyRoot of await productionDependencyRoots()) {
    await copyTreeWithoutPackageExclusions(
      path.join(repoRoot, dependencyRoot),
      path.join(outputRoot, dependencyRoot),
      plannedCopies,
      options,
    );
  }
};

const copyFilePreservingMode = async (source, destination, plannedCopies, options = {}) => {
  plannedCopies.push({
    from: toPortable(path.relative(repoRoot, source)),
    to: toPortable(path.relative(repoRoot, destination)),
  });
  if (options.dryRun) {
    return;
  }
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(source, destination);
  const sourceStat = await stat(source);
  await chmod(destination, sourceStat.mode);
};

const materializeRuntime = async (runtime, options) => {
  const spec = runtimeSpecs[runtime];
  assert(spec, `Unknown runtime spec: ${runtime}`);

  const outputRoot = path.join(options.out, spec.outputRoot);
  const plannedCopies = [];

  if (options.clean && !options.dryRun) {
    await rm(outputRoot, { recursive: true, force: true });
  }

  if (!options.dryRun) {
    await mkdir(outputRoot, { recursive: true });
  }

  if (spec.templateRoot) {
    await copyTree(spec.templateRoot, outputRoot, plannedCopies, options);
  }

  for (const sharedDir of spec.sharedDirs) {
    const source = path.join(repoRoot, sharedDir);
    const targetName = path.basename(sharedDir);
    const destination = /[\\/]/.test(sharedDir)
      ? path.join(outputRoot, sharedDir)
      : path.join(outputRoot, targetName);
    if (sharedDir === 'skills' && spec.skillExposure === 'publicRuntimeSkills') {
      await copyPublicRuntimeSkills(source, destination, plannedCopies, options);
    } else {
      await copyTree(source, destination, plannedCopies, options);
    }
  }

  for (const sharedFile of spec.sharedFiles) {
    const source = path.join(repoRoot, sharedFile);
    const destination = path.join(outputRoot, sharedFile);
    await copyFilePreservingMode(source, destination, plannedCopies, options);
  }

  if (runtime === 'moonshot-relay') {
    const sourceNode = process.execPath;
    const nodeContent = await readFile(sourceNode);
    const checksum = createHash('sha256').update(nodeContent).digest('hex');

    const manifest = {
      schemaVersion: 1,
      platform: process.platform,
      arch: process.arch,
      // The payload must identify the binary that was actually copied. A
      // fixed version here makes an offline bundle report a different Node
      // version from the managed executable and breaks target-version
      // verification.
      version: process.version.replace(/^v/u, ''),
      checksum,
    };
    
    const versionString = `${manifest.version}-${manifest.platform}-${manifest.arch}`;
    const runtimeOutDir = path.join(outputRoot, 'runtime');
    const versionOutDir = path.join(runtimeOutDir, 'versions', versionString);
    
    if (!options.dryRun) {
      await mkdir(versionOutDir, { recursive: true });
    }
    
    const nodeBinaryName = process.platform === 'win32' ? 'node.exe' : 'bin/node';
    const destNode = path.join(versionOutDir, nodeBinaryName);
    
    await copyFilePreservingMode(sourceNode, destNode, plannedCopies, options);
    
    const manifestDest = path.join(runtimeOutDir, 'runtime-manifest.json');
    plannedCopies.push({
      from: 'runtime/runtime-manifest.json',
      to: toPortable(path.relative(repoRoot, manifestDest))
    });
    if (!options.dryRun) {
      await writeFile(manifestDest, JSON.stringify(manifest, null, 2));
    }
  }

  if (spec.materializeRuntimeDependencies) {
    await materializeRuntimeDependencies(outputRoot, plannedCopies, options);
  }

  const verificationSource = path.join(repoRoot, 'schemas', 'verification.contract.yaml');
  await copyFilePreservingMode(verificationSource, path.join(outputRoot, spec.verificationTarget), plannedCopies, options);

  return { runtime, outputRoot, copied: plannedCopies };
};

const main = async () => {
  const options = parseArgs(process.argv.slice(2));
  await assertRuntimeBuild(repoRoot);
  const runtimes = options.runtime === 'all' ? allRuntimeNames : [options.runtime];
  const results = [];

  for (const runtime of runtimes) {
    results.push(await materializeRuntime(runtime, options));
  }

  if (options.json) {
    console.log(JSON.stringify({
      out: options.out,
      runtimes: results.map((result) => ({
        runtime: result.runtime,
        outputRoot: toPortable(path.relative(repoRoot, result.outputRoot)),
        copiedCount: result.copied.length,
        planned: options.dryRun ? result.copied : undefined,
      })),
    }, null, 2));
  } else {
    for (const result of results) {
      console.log(`materialized ${result.runtime}: ${path.relative(repoRoot, result.outputRoot)} (${result.copied.length} entries)`);
    }
  }
};

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
