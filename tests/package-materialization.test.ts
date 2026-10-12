import { assertTestRecord, assertTestArray, assertTestString } from './helpers/assert-value.js';
import assert from 'node:assert/strict';
import { resolveRuntimeDependencyEntries } from '../src/shared/runtime-dependencies.js';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { after, test } from 'node:test';
import { gitLsFiles } from '../src/shared/git-safe.js';

const root = process.cwd();
const fromRoot = (...segments: string[]) => path.join(root, ...segments);
const sha256 = (value: Parameters<ReturnType<typeof createHash>['update']>[0]) => createHash('sha256').update(value).digest('hex');

let materializedRoot: string | null = null;

const materializePackage = async () => {
  if (materializedRoot) {
    return materializedRoot;
  }

  materializedRoot = await mkdtemp(path.join(os.tmpdir(), 'moonshot-relay-package-'));
  const result = spawnSync(process.execPath, [
    'package/build-package.mjs',
    '--runtime',
    'all',
    '--out',
    materializedRoot,
    '--clean',
    '--json',
  ], {
    cwd: root,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  return materializedRoot;
};

const claudeProfile = async () => path.join(await materializePackage(), 'claude', 'profile', '.claude');
const codexProfile = async () => path.join(await materializePackage(), 'codex', 'profile', '.codex');
const qwenProfile = async () => path.join(await materializePackage(), 'qwen', 'profile', '.qwen');
const antigravityProfile = async () => path.join(await materializePackage(), 'antigravity', 'profile', '.gemini', 'antigravity');
const commonProfile = async () => path.join(await materializePackage(), 'moonshot-relay', 'profile');

const runtimeSurface = JSON.parse(await readFile(fromRoot('package', 'runtime-surface.json'), 'utf8'));
const publicRuntimeSkills = assertTestArray(runtimeSurface.publicRuntimeSkills).map(assertTestString).sort();

after(async () => {
  if (materializedRoot) {
    await rm(materializedRoot, { recursive: true, force: true });
  }
});

const requiredClaudeEntries = [
  'CLAUDE.md',
  'PROJECT.md',
  'README.md',
  'verification.contract.yaml',
  'profile-contract.yaml',
  'skills',
  'agents',
  'rules',
];

const requiredCodexEntries = [
  'AGENTS.md',
  'README.md',
  'verification.contract.yaml',
  'config.toml',
  'skills',
  'agents',
  'rules',
];

const requiredQwenEntries = [
  'QWEN.md',
  'README.md',
  'verification.contract.yaml',
  'settings.json',
  'skills',
  'agents',
  'rules',
];

const requiredCommonPayloadFiles = [
  'catalog/moonshot-catalog.json',
  'docs/public/repository-layout.md',
  'rules/workflow.md',
  'rules/workflow-bundles.yaml',
  'schemas/verification.contract.yaml',
  'schemas/discovery-map.schema.json',
  'schemas/spec-test-obligation.schema.json',
  'schemas/browser-completion-result.schema.json',
  'schemas/browser-scenario.schema.json',
  'schemas/context-pack.schema.json',
  'schemas/awtl-testcase-candidate-v1.schema.json',
  'schemas/improvement-candidate-v1.schema.json',
  'schemas/memory-promotion-ledger.schema.json',
  'schemas/verification-plane.schema.json',
  'schemas/tool-registry.schema.json',
  'templates/GOAL_CONTRACT.template.yaml',
  'templates/product-definition/DISCOVERY_MAP.template.md',
  'templates/product-definition/DISCOVERY_TICKET.template.md',
  'templates/product-definition/RESEARCH_NOTE.template.md',
  'templates/product-definition/PROTOTYPE_DECISION.template.md',
  'skills/completion-verifier/SKILL.md',
  'skills/moonshot-plan-writer/SKILL.md',
  'skills/verification-contract-gate/SKILL.md',
  'bin/browserctl',
  'kernel/proof-policy.yaml',
  'tools/agent-api/registry.yaml',
  'tools/agent-api/dispatch.mjs',
  'tools/evals/harness-control-plane.mjs',
  'tools/evals/skill-deletion-eval.mjs',
  'tools/evals/skill-lint-carry-forward.json',
  'tools/evals/fixtures/harness-control-plane/golden-regression.json',
  'tools/harness-lab/harness-lab.mjs',
  'tools/awtl/trace-to-testcase.mjs',
  'tools/sandbox/policy.mjs',
  'tools/browserd/package.json',
  'tools/browserd/server.mjs',
  'scripts/catalog-check.mjs',
  'scripts/skill-router.mjs',
  'scripts/lint-skills.mjs',
  'scripts/install-browser-runtime.sh',
  'scripts/install-project-runtime-bridge.mjs',
  'scripts/architecture-context-build.mjs',
  'scripts/architecture-knowledge-resolve.mjs',
  'scripts/architecture-contract-bind.mjs',
  'scripts/architecture-handoff-build.mjs',
  'scripts/architecture-feedback-render.mjs',
  'scripts/architecture-artifact-validate.mjs',
  'scripts/memorygraph-mcp-wrapper.js',
  'scripts/memorygraph-mcp-wrapper.mjs',
  'scripts/code-review-graph-mcp-wrapper.js',
  'scripts/browser-flow-runner.mjs',
  'scripts/context-state.mjs',
  'scripts/contract-engine.mjs',
  'scripts/delivery-submit.mjs',
  'scripts/commit-moonshot-memory-refresh.mjs',
  'scripts/phase-final-guard.mjs',
  'scripts/phase-runner-session-audit.mjs',
  'scripts/prepare-phase-runner-state.mjs',
  'scripts/skills-audit.mjs',
  'scripts/spec-test-obligations.mjs',
  'scripts/memory-claim-validate.mjs',
  'scripts/doctor.mjs',
  'scripts/kernel/runtime-home.js',
  'scripts/kernel/control-plane.js',
  'scripts/kernel/standalone/skills-lock.js',
  'scripts/plan-graph-validate.mjs',
  'scripts/review-bundle-build.mjs',
  'scripts/lib/git-safe.js',
  'scripts/lib/candidate-identity.js',
  'scripts/lib/browser-failure-package.mjs',
  'scripts/lib/browser-scenario-contract.mjs',
  'scripts/lib/contract-invalidation.mjs',
  'scripts/lib/delivery-policy.mjs',
  'scripts/lib/event-ledger.mjs',
  'scripts/lib/memory-claim-ledger.mjs',
  'scripts/lib/memory-control-plane-contracts.mjs',
  'scripts/lib/plan-graph.mjs',
  'scripts/lib/phase-runner-session-audit.mjs',
  'scripts/lib/review-bundle.mjs',
  'scripts/lib/phase-event-ledger.mjs',
  'scripts/lib/phase-run-lease-store.mjs',
  'scripts/lib/context-state-engine.mjs',
  'scripts/lib/runtime-state-db-path.mjs',
  'scripts/lib/runtime-state-root.mjs',
  'scripts/lib/runtime-state-store.mjs',
  'scripts/lib/control-plane-policy.mjs',
  'scripts/lib/execution-cursor.mjs',
  'scripts/lib/workflow-bundle-resolver.mjs',
  'scripts/runtime-state.mjs',
  'scripts/installed-release-resolve.mjs',
  'scripts/verification-plane.mjs',
  'scripts/lib/verification-plane.mjs',
  'scripts/workspace-manager.mjs',
  'scripts/lib/workspace-manager.mjs',
  'scripts/verification-verdict-state.mjs',
  'package/runtime-surface.json',
  'skills.lock.json',
  'docs/public/guidelines/harness-bootstrap-lab.md',
  'package.json',
  'package-lock.json',
  'scripts/lib/sqlite-driver.mjs',
  'scripts/lib/sqlite-drivers/node-sqlite.mjs',
];

const requiredClaudeConcreteFiles = [
  'skills/commit-moonshot/SKILL.md',
  'skills/moonshot-architecture/SKILL.md',
  'skills/moonshot-orchestrator/SKILL.md',
  'skills/moonshot-phase-runner/SKILL.md',
  'skills/moonshot-plan-writer/SKILL.md',
  'skills/product-orchestrator/SKILL.md',
  'skills/session-logger/SKILL.md',
  'skills/explain-diff-html/SKILL.md',
  'agents/phase-attempt-agent.md',
  'rules/workflow.md',
];

const requiredConcreteCodexFiles = [
  'skills/commit-moonshot/SKILL.md',
  'skills/moonshot-architecture/SKILL.md',
  'skills/moonshot-orchestrator/SKILL.md',
  'skills/moonshot-phase-runner/SKILL.md',
  'skills/moonshot-plan-writer/SKILL.md',
  'skills/product-orchestrator/SKILL.md',
  'skills/session-logger/SKILL.md',
  'skills/explain-diff-html/SKILL.md',
  'agents/phase-attempt-agent.md',
  'rules/workflow.md',
];

const requiredConcreteQwenFiles = [
  'skills/commit-moonshot/SKILL.md',
  'skills/moonshot-architecture/SKILL.md',
  'skills/moonshot-orchestrator/SKILL.md',
  'skills/moonshot-phase-runner/SKILL.md',
  'skills/moonshot-plan-writer/SKILL.md',
  'skills/product-orchestrator/SKILL.md',
  'skills/session-logger/SKILL.md',
  'skills/explain-diff-html/SKILL.md',
  'agents/phase-attempt-agent.md',
  'rules/workflow.md',
];

const requiredAntigravityEntries = [
  'GEMINI.md',
  'PROJECT.md',
  'README.md',
  'verification.contract.yaml',
  'profile-contract.yaml',
  'skills',
  'agents',
  'rules',
];

const requiredConcreteAntigravityFiles = [
  'skills/commit-moonshot/SKILL.md',
  'skills/moonshot-architecture/SKILL.md',
  'skills/moonshot-orchestrator/SKILL.md',
  'skills/moonshot-phase-runner/SKILL.md',
  'skills/moonshot-plan-writer/SKILL.md',
  'skills/product-orchestrator/SKILL.md',
  'skills/session-logger/SKILL.md',
  'skills/explain-diff-html/SKILL.md',
  'agents/phase-attempt-agent.md',
  'rules/workflow.md',
];

const generatedStateFragments = [
  '.moonshot-relay/',
  '.moonshot-relay/harness-lab/',
  '.moonshot-state/',
  '.claude/state/',
  '/logs/',
  '/cache/',
  '/traces/',
  '/browser-artifacts/',
  '/sandbox-artifacts/',
  '/browser-runtime/',
  '/memories/',
  '/sessions/',
  '/sqlite/',
  '/.qwen/cache/',
  '/.qwen/logs/',
  '/.qwen/tmp/',
  '/scripts/fixtures/',
  '/tests/fixtures/',
  '/node_modules/',
  '/tmp/',
  '/memorygraph/',
  '/.local/',
  'runtime-state.sqlite',
  'memory.json',
  'verification-verdict-',
  'runtime-verdict-',
  'browser-flow-verdict-',
  'knowledge-repo-audit-',
  '.code-review-graph/',
  '.test.mjs',
  '.e2e.test.mjs',
  '_test.py',
  '.test.py',
];

const phase06GeneratedArtifactFragments = [
  '.moonshot-relay/browser-artifacts/',
  '.moonshot-relay/harness-lab/',
  '.moonshot-relay/eval-artifacts/',
  '.moonshot-relay/verification-reports/',
  '.moonshot-state/browser-artifacts/',
  '.claude/browser-artifacts/',
  '.claude/sandbox-artifacts/',
  'screenshots/',
  'videos/',
  'traces/',
  'reports/',
  'verification-verdict-',
  'runtime-verdict-',
  'browser-flow-verdict-',
  'lab-closeout-receipt.json',
  'candidate-summary.json',
  'lab-result.json',
  'events.jsonl',
];

const obsoleteWorkflowScriptExclusions = [
  '.claude/archive/scripts/legacy-phase-adapters/agent-loop.mjs',
  '.claude/archive/scripts/legacy-phase-adapters/verify-code-policy.mjs',
  '.claude/scripts/check-mcp.sh',
  '.claude/scripts/harness-surface-inventory.mjs',
  '.claude/scripts/verify-phase-closeout-fixtures.mjs',
  '.claude/scripts/lib/windows-safe-files.mjs',
  '.claude/scripts/lib/phase-attempt-telemetry.mjs',
  '.claude/scripts/moonshot-phase-dispatch.mjs',
  '.claude/scripts/moonshot-phase-dispatch.sh',
  '.claude/scripts/agent-loop.sh',
  '.claude/scripts/harness-prepare-worktree.sh',
  '.claude/scripts/verify-phase-runner-boundary.sh',
  '.claude/scripts/verification-agent-run.mjs',
];

const runtimeStateDenylistExamples = [
  '.moonshot-relay/logs/agent-loop/run.log',
  '.moonshot-relay/cache/code-review-graph-native-mcp-cache.json',
  '.moonshot-relay/traces/self-test/agent_work_trace.jsonl',
  '.moonshot-relay/browser-artifacts/session/output.json',
  '.moonshot-relay/harness-lab/runs/candidate-001/candidate-summary.json',
  '.moonshot-relay/harness-lab/runs/candidate-001/lab-result.json',
  '.moonshot-relay/harness-lab/runs/candidate-001/lab-closeout-receipt.json',
  '.moonshot-relay/harness-lab/runs/candidate-001/events.jsonl',
  '.moonshot-relay/eval-artifacts/harness-control-plane/scorecard.json',
  '.moonshot-relay/verification-reports/run/output.json',
  '.moonshot-relay/memorygraph/memory.db',
  '.moonshot-relay/runtime-state.sqlite',
  '.moonshot-state/logs/agent-loop/run.log',
  '.moonshot-state/cache/code-review-graph-native-mcp-cache.json',
  '.moonshot-state/traces/self-test/agent_work_trace.jsonl',
  '.moonshot-state/browser-artifacts/session/output.json',
  '.moonshot-state/memorygraph/memory.db',
  '.moonshot-state/runtime-state.sqlite',
  '.claude/tools/browserd/node_modules/playwright/package.json',
  '.claude/state/runtime-state.sqlite',
  '.claude/logs/agent-loop/run.log',
  '.claude/cache/memorygraph/memory_update_candidates.jsonl',
  '.claude/traces/self-test/agent_work_trace.jsonl',
  '.claude/browser-artifacts/session/output.json',
  '.claude/browser-runtime/profile/lock',
  '.claude/memorygraph/memory.db',
  '.claude/runtime-state.sqlite-wal',
  '.claude/verification-verdict-phase05-final.json',
  '.claude/knowledge-repo-audit-20260515.json',
  '.claude/memory.json',
  '.codex/cache/session.json',
  '.codex/sqlite/state.sqlite',
  '.codex/memories/project.jsonl',
  '.codex/sessions/session.json',
  '.qwen/cache/session.json',
  '.qwen/logs/qwen.log',
  '.qwen/tmp/project/shell_history',
  '.qwen/memory.json',
  '.code-review-graph/index.sqlite',
];

const rootVerdictFragments = new Set([
  'verification-verdict-',
  'runtime-verdict-',
  'browser-flow-verdict-',
  'knowledge-repo-audit-',
]);

const listFiles = async (absoluteDir: string, prefix = ''): Promise<string[]> => {
  const entries = await readdir(absoluteDir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const relativePath = path.join(prefix, entry.name);
    const absolutePath = path.join(absoluteDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFiles(absolutePath, relativePath));
    } else {
      files.push(relativePath.replaceAll(path.sep, '/'));
    }
  }

  return files;
};

const assertEntryExists = async (profileRoot: string, entry: unknown) => {
  const target = path.join(profileRoot, assertTestString(entry));
  assert.equal(existsSync(target), true, `${profileRoot}/${entry} should exist`);
  assert.ok(await stat(target), `${profileRoot}/${entry} should be stat-able`);
};

const listSkillDirs = async (profileRoot: string) => {
  const entries = await readdir(path.join(profileRoot, 'skills'), { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
};

const dependencyLayout = assertTestRecord(JSON.parse(await readFile(path.join(root, 'package/source-layout.json'), 'utf8')));
const schemaDependencyNames = [...new Set(assertTestArray(dependencyLayout.externalImports)
  .filter(entry => assertTestRecord(entry).from === 'src/contracts/schema-codec.ts')
  .map(entry => assertTestString(assertTestRecord(entry).specifier))
  .map(specifier => specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : assertTestString(specifier.split('/')[0])))];
const schemaDependencyRoots = (await resolveRuntimeDependencyEntries({ sourceRoot: root, dependencyNames: schemaDependencyNames })).map(entry => entry.relativePath);
const matchesGeneratedStateFragment = (file: string, fragment: string) => {
  if (rootVerdictFragments.has(fragment)) {
    return new RegExp(`(?:^|/)\\.claude/${fragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(file);
  }

  if (fragment === '/node_modules/' && schemaDependencyRoots.some(root => file.includes('/' + root + '/'))) return false;
  return file.includes(fragment);
};

test('Moonshot Relay common package payload includes shared harness entries', async () => {
  const profileRoot = await commonProfile();
  for (const entry of [
    'bin',
    'catalog',
    'docs/public',
    'rules',
    'schemas',
    'scripts',
    'templates',
    'tools/browserd',
    'package/runtime-surface.json',
    'skills.lock.json',
    'verification.contract.yaml',
  ]) {
    await assertEntryExists(profileRoot, entry);
  }

  for (const entry of requiredCommonPayloadFiles) {
    await assertEntryExists(profileRoot, entry);
  }
});

test('materialized Moon Relay Kernel CLI has a closed import graph', async () => {
  const profileRoot = await commonProfile();
  const result = spawnSync(process.execPath, [
    path.join(profileRoot, 'bin', 'moon-relay-kernel.mjs'),
    '--version',
  ], {
    cwd: profileRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      MOON_RELAY_KERNEL_REEXEC: '1',
    },
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /moon-relay-kernel/);
});

test('Claude package payload includes only service profile entries', async () => {
  const profileRoot = await claudeProfile();
  for (const entry of requiredClaudeEntries) {
    await assertEntryExists(profileRoot, entry);
  }

  for (const entry of requiredClaudeConcreteFiles) {
    await assertEntryExists(profileRoot, entry);
  }
  assert.deepEqual(await listSkillDirs(profileRoot), publicRuntimeSkills);
  assert.equal(existsSync(path.join(profileRoot, 'skills', 'completion-verifier', 'SKILL.md')), false);

  for (const entry of ['bin', 'tools', 'schemas', 'scripts', 'templates', 'docs/public']) {
    assert.equal(existsSync(path.join(profileRoot, entry)), false, `${entry} should live in the common Moonshot Relay payload`);
  }
});

test('Codex package payload includes only service profile entries', async () => {
  const profileRoot = await codexProfile();
  for (const entry of requiredCodexEntries) {
    await assertEntryExists(profileRoot, entry);
  }

  for (const entry of requiredConcreteCodexFiles) {
    await assertEntryExists(profileRoot, entry);
  }
  assert.deepEqual(await listSkillDirs(profileRoot), publicRuntimeSkills);
  assert.equal(existsSync(path.join(profileRoot, 'skills', 'completion-verifier', 'SKILL.md')), false);

  for (const entry of ['bin', 'tools', 'schemas', 'scripts', 'templates', 'docs/public']) {
    assert.equal(existsSync(path.join(profileRoot, entry)), false, `${entry} should live in the common Moonshot Relay payload`);
  }
});

test('Qwen package payload includes only service profile entries', async () => {
  const profileRoot = await qwenProfile();
  for (const entry of requiredQwenEntries) {
    await assertEntryExists(profileRoot, entry);
  }

  for (const entry of requiredConcreteQwenFiles) {
    await assertEntryExists(profileRoot, entry);
  }
  assert.deepEqual(await listSkillDirs(profileRoot), publicRuntimeSkills);
  assert.equal(existsSync(path.join(profileRoot, 'skills', 'completion-verifier', 'SKILL.md')), false);

  for (const entry of ['bin', 'tools', 'schemas', 'scripts', 'templates', 'docs/public']) {
    assert.equal(existsSync(path.join(profileRoot, entry)), false, `${entry} should live in the common Moonshot Relay payload`);
  }
});

test('Antigravity package payload includes only service profile entries', async () => {
  const profileRoot = await antigravityProfile();
  for (const entry of requiredAntigravityEntries) {
    await assertEntryExists(profileRoot, entry);
  }

  for (const entry of requiredConcreteAntigravityFiles) {
    await assertEntryExists(profileRoot, entry);
  }
  assert.deepEqual(await listSkillDirs(profileRoot), publicRuntimeSkills);
  assert.equal(existsSync(path.join(profileRoot, 'skills', 'completion-verifier', 'SKILL.md')), false);

  for (const entry of ['bin', 'tools', 'schemas', 'scripts', 'templates', 'docs/public']) {
    assert.equal(existsSync(path.join(profileRoot, entry)), false, `${entry} should live in the common Moonshot Relay payload`);
  }
});

test('Codex MCP config resolves shared scripts through Moonshot Relay home', async () => {
  const profileRoot = await codexProfile();
  const config = await readFile(path.join(profileRoot, 'config.toml'), 'utf8');

  assert.doesNotMatch(config, /\.claude[\\/]scripts[\\/]/);
  assert.match(config, /MOONSHOT_RELAY_HOME/);
  assert.match(config, /\.moonshot-relay/);
  assert.match(config, /scripts', 'codex-mcp-singleton\.mjs'/);
  assert.match(config, /<MOONSHOT_RELAY_HOME>\/scripts\/memorygraph-mcp-wrapper\.mjs/);
  assert.match(config, /<MOONSHOT_RELAY_HOME>\/scripts\/code-review-graph-mcp-wrapper\.js/);
});

test('excludes runtime state from package payloads and local-only artifacts', async () => {
  const files = [
    ...await listFiles(await commonProfile(), 'moonshot-relay'),
    ...await listFiles(await claudeProfile(), '.claude'),
    ...await listFiles(await codexProfile(), '.codex'),
    ...await listFiles(await qwenProfile(), '.qwen'),
    ...await listFiles(await antigravityProfile(), '.gemini/antigravity'),
  ];

  for (const file of files) {
    for (const fragment of phase06GeneratedArtifactFragments) {
      assert.equal(
        matchesGeneratedStateFragment(file, fragment),
        false,
        `${file} should not include generated state fragment ${fragment}`,
      );
    }
  }
});

test('excludes archived legacy and obsolete workflow scripts from Claude package payload', async () => {
  const files = new Set(await listFiles(await claudeProfile(), '.claude'));

  for (const exclusion of obsoleteWorkflowScriptExclusions) {
    assert.equal(files.has(exclusion), false, `${exclusion} should not be installed in the Claude payload`);
  }
});

test('excludes runtime state roots from package materialization denylist', () => {
  for (const file of runtimeStateDenylistExamples) {
    assert.equal(
      generatedStateFragments.some((fragment) => matchesGeneratedStateFragment(file, fragment)),
      true,
      `${file} should match generated runtime state denylist`,
    );
  }
});

test('package materialization contract names generated payload roots and exclusions', async () => {
  const contract = await readFile(fromRoot('package/package-contract.yaml'), 'utf8');
  assert.match(contract, /generatedProfileRoot: package\/moonshot-relay\/profile\//);
  assert.match(contract, /generatedCopyPolicy: ignored_generated_package_payload/);
  assert.match(contract, /templateRoot: package\/profile-templates\/claude\/\.claude\//);
  assert.match(contract, /templateRoot: package\/profile-templates\/codex\/\.codex\//);
  assert.match(contract, /templateRoot: package\/profile-templates\/qwen\/\.qwen\//);
  assert.match(contract, /generatedProfileRoot: package\/claude\/profile\/\.claude\//);
  assert.match(contract, /generatedProfileRoot: package\/codex\/profile\/\.codex\//);
  assert.match(contract, /generatedProfileRoot: package\/qwen\/profile\/\.qwen\//);
  assert.match(contract, /templateRoot: package\/profile-templates\/antigravity\/\.gemini\/antigravity\//);
  assert.match(contract, /generatedProfileRoot: package\/antigravity\/profile\/\.gemini\/antigravity\//);
  assert.match(contract, /skillRuntimeRoot: \.gemini\/config\//);
  assert.match(contract, /materializer: package\/build-package\.mjs/);
  assert.match(contract, /commonSupportScripts:/);
  assert.match(contract, /source: package\.json/);
  assert.match(contract, /source: catalog\/moonshot-catalog\.json/);
  assert.match(contract, /source: scripts\/catalog-check\.mjs/);
  assert.match(contract, /source: scripts\/skill-router\.mjs/);
  assert.match(contract, /source: scripts\/lint-skills\.mjs/);
  assert.match(contract, /source: scripts\/spec-test-obligations\.mjs/);
  assert.match(contract, /source: schemas\/spec-test-obligation\.schema\.json/);
  assert.match(contract, /source: package-lock\.json/);
  assert.doesNotMatch(contract, /source: node_modules\/better-sqlite3\/\*\*/);
  assert.match(contract, /source: scripts\/lib\/browser-failure-package\.mjs/);
  assert.match(contract, /source: scripts\/lib\/browser-scenario-contract\.mjs/);
  assert.match(contract, /runtimeDependencyDelivery:/);
  assert.match(contract, /typed_degraded_authority_blocked/);
  assert.match(contract, /rolloutSmokeLevels:/);
  assert.match(contract, /temp-home-smoke/);
  assert.match(contract, /live-account-root-smoke/);
  assert.match(contract, /preservedStateRoots:/);
  assert.match(contract, /archivedLegacyScripts:/);
  assert.match(contract, /archive\/scripts\/legacy-phase-adapters\//);
  assert.doesNotMatch(contract, /source: scripts\/\*\*/);
  assert.match(contract, /\.claude\/logs\/\*\*/);
  assert.match(contract, /\.claude\/runtime-state\.sqlite\*/);
  assert.match(contract, /\.code-review-graph\/\*\*/);
  assert.match(contract, /\.moonshot-state\/\*\*/);
  assert.match(contract, /\.codex\/cache\/\*\*/);
  assert.match(contract, /\.codex\/sqlite\/\*\*/);
  assert.match(contract, /\.codex\/memories\/\*\*/);
  assert.match(contract, /\.codex\/sessions\/\*\*/);
  assert.match(contract, /\.qwen\/cache\/\*\*/);
  assert.match(contract, /\.qwen\/logs\/\*\*/);
  assert.match(contract, /\.qwen\/tmp\/\*\*/);
  assert.doesNotMatch(contract, /excludedDevOnlyPayload:/);
});

test('package dry-run distinguishes source verdict helpers from generated verdict outputs', () => {
  const result = spawnSync(process.execPath, [
    'package/build-package.mjs',
    '--runtime',
    'all',
    '--dry-run',
    '--json',
  ], {
    cwd: root,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  const plannedFrom = assertTestArray(payload.runtimes).flatMap((runtime) => assertTestArray(assertTestRecord(runtime).planned).map((entry) => assertTestString(assertTestRecord(entry).from)));
  const plannedTo = assertTestArray(payload.runtimes).flatMap((runtime) => assertTestArray(assertTestRecord(runtime).planned).map((entry) => assertTestString(assertTestRecord(entry).to)));
  const plannedPaths = [...plannedFrom, ...plannedTo];

  for (const runtimeValue of assertTestArray(payload.runtimes)) {
    const runtime = assertTestRecord(runtimeValue);
    const destinations = assertTestArray(runtime.planned).map((entry) => assertTestString(assertTestRecord(entry).to));
    const duplicates = destinations.filter((destination, index) => destinations.indexOf(destination) !== index);
    assert.equal(
      new Set(destinations).size,
      destinations.length,
      `${runtime.runtime} package plan has duplicate destinations: ${[...new Set(duplicates)].join(', ')}`,
    );
  }

  assert.ok(plannedFrom.includes('scripts/verification-verdict-state.mjs'));
  assert.ok(plannedFrom.includes('catalog/moonshot-catalog.json'));
  assert.ok(plannedFrom.includes('scripts/catalog-check.mjs'));
  assert.ok(plannedFrom.includes('scripts/skill-router.mjs'));
  assert.ok(plannedFrom.includes('scripts/lint-skills.mjs'));
  assert.ok(plannedFrom.includes('skills/completion-verifier/SKILL.md'));
  assert.ok(plannedFrom.includes('scripts/browser-flow-runner.mjs'));
  assert.ok(plannedFrom.includes('scripts/prepare-phase-runner-state.mjs'));
  assert.ok(plannedFrom.includes('scripts/phase-final-guard.mjs'));
  assert.ok(plannedFrom.includes('scripts/phase-runner-session-audit.mjs'));
  assert.ok(plannedFrom.includes('docs/public/reference/phase-final-guard-hooks.md'));
  assert.ok(plannedFrom.includes('scripts/contract-engine.mjs'));
  assert.ok(plannedFrom.includes('scripts/delivery-submit.mjs'));
  assert.ok(plannedFrom.includes('scripts/plan-graph-validate.mjs'));
  assert.ok(plannedFrom.includes('scripts/review-bundle-build.mjs'));
  assert.ok(plannedFrom.includes('scripts/workspace-manager.mjs'));
  assert.ok(plannedFrom.includes('scripts/skills-audit.mjs'));
  assert.ok(plannedFrom.includes('scripts/spec-test-obligations.mjs'));
  assert.ok(plannedFrom.includes('schemas/discovery-map.schema.json'));
  assert.ok(plannedFrom.includes('schemas/spec-test-obligation.schema.json'));
  assert.ok(plannedFrom.includes('templates/product-definition/DISCOVERY_MAP.template.md'));
  assert.ok(plannedFrom.includes('templates/product-definition/DISCOVERY_TICKET.template.md'));
  assert.ok(plannedFrom.includes('templates/product-definition/RESEARCH_NOTE.template.md'));
  assert.ok(plannedFrom.includes('templates/product-definition/PROTOTYPE_DECISION.template.md'));
  assert.ok(plannedFrom.includes('scripts/doctor.mjs'));
  assert.ok(plannedFrom.includes('scripts/lib/candidate-identity.js'));
  assert.ok(plannedFrom.includes('scripts/lib/browser-failure-package.mjs'));
  assert.ok(plannedFrom.includes('scripts/lib/browser-scenario-contract.mjs'));
  assert.ok(plannedFrom.includes('scripts/lib/contract-invalidation.mjs'));
  assert.ok(plannedFrom.includes('scripts/lib/delivery-policy.mjs'));
  assert.ok(plannedFrom.includes('scripts/lib/event-ledger.mjs'));
  assert.ok(plannedFrom.includes('scripts/lib/plan-graph.mjs'));
  assert.ok(plannedFrom.includes('scripts/lib/phase-runner-session-audit.mjs'));
  assert.ok(plannedFrom.includes('scripts/lib/review-bundle.mjs'));
  assert.ok(plannedFrom.includes('scripts/kernel/standalone/skills-lock.js'));
  assert.ok(plannedFrom.includes('scripts/lib/workspace-manager.mjs'));
  assert.ok(plannedFrom.includes('scripts/install-project-runtime-bridge.mjs'));
  assert.ok(plannedFrom.includes('scripts/architecture-knowledge-resolve.mjs'));
  assert.ok(plannedFrom.includes('scripts/architecture-contract-bind.mjs'));
  assert.ok(plannedFrom.includes('scripts/architecture-handoff-build.mjs'));
  assert.ok(plannedFrom.includes('scripts/architecture-feedback-render.mjs'));
  assert.ok(plannedTo.includes('package/moonshot-relay/profile/skills/completion-verifier/SKILL.md'));
  assert.ok(plannedTo.includes('package/codex/profile/.codex/skills/moonshot-phase-runner/SKILL.md'));
  assert.ok(plannedTo.includes('package/qwen/profile/.qwen/skills/moonshot-phase-runner/SKILL.md'));
  assert.equal(plannedTo.includes('package/codex/profile/.codex/skills/completion-verifier/SKILL.md'), false);
  assert.equal(plannedTo.includes('package/claude/profile/.claude/skills/completion-verifier/SKILL.md'), false);
  assert.equal(plannedTo.includes('package/qwen/profile/.qwen/skills/completion-verifier/SKILL.md'), false);
  assert.equal(plannedTo.includes('package/codex/profile/.codex/skills/skills-doctor/SKILL.md'), false);
  assert.equal(plannedTo.includes('package/claude/profile/.claude/skills/skills-doctor/SKILL.md'), false);
  assert.equal(plannedTo.includes('package/qwen/profile/.qwen/skills/skills-doctor/SKILL.md'), false);
  assert.equal(plannedTo.some((target) => /\.claude\/verification-verdict-[^/]*\.json$/.test(target)), false);
  assert.equal(plannedTo.some((target) => /\.claude\/runtime-verdict-[^/]*\.json$/.test(target)), false);
  assert.equal(plannedTo.some((target) => /\.claude\/browser-flow-verdict-[^/]*\.json$/.test(target)), false);

  for (const fragment of phase06GeneratedArtifactFragments) {
    assert.equal(
      plannedPaths.some((target) => matchesGeneratedStateFragment(target, fragment)),
      false,
      `dry-run plan should exclude generated artifact fragment ${fragment}`,
    );
  }
});

test('package smoke runs materialized runtime-state from package home', async () => {
  const profileRoot = await commonProfile();
  const runtimeStateScript = path.join(profileRoot, 'scripts', 'runtime-state.mjs');
  const result = spawnSync(process.execPath, [
    runtimeStateScript,
    'status',
    '--run-id',
    'package-home-smoke',
    '--goal-id',
    'runtime-state-availability',
    '--json',
  ], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      MOONSHOT_RELAY_HOME: profileRoot,
      PHASE_RUNTIME_DB: '',
      NODE_PATH: '',
    },
  });
  const payload = JSON.parse(result.stdout);
  const expectedDbPath = path.join(
    profileRoot,
    'state',
    'projects',
    'munlucky-moonshot-relay',
    'knowledge',
    'runtime-state.sqlite',
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(payload.runtimeCapabilityStatus.status, 'available');
  assert.equal(payload.runtimeCapabilityStatus.dbPath, expectedDbPath);
  assert.equal(existsSync(expectedDbPath), true);
  assert.equal(existsSync(path.join(profileRoot, 'node_modules', 'better-sqlite3', 'package.json')), false);
});

test('generated package profiles are not tracked source files', () => {
  const result = gitLsFiles(root, ['package/moonshot-relay/profile', 'package/claude/profile', 'package/codex/profile', 'package/qwen/profile', 'package/antigravity/profile']);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), '', 'generated package profile files should not be tracked');
});

test('account-root installer merges shared directories without deleting unrelated skills', async () => {
  const installRoot = await mkdtemp(path.join(os.tmpdir(), 'moonshot-relay-account-root-install-'));
  const moonshotHome = path.join(installRoot, 'moonshot-home');
  const claudeHome = path.join(installRoot, 'claude-home');
  const codexHome = path.join(installRoot, 'codex-home');
  const qwenHome = path.join(installRoot, 'qwen-home');
  const antigravityHome = path.join(installRoot, 'antigravity-home');
  const antigravitySkillsHome = path.join(installRoot, 'antigravity-skills-home');

  await mkdir(path.join(moonshotHome, 'state', 'projects', 'demo', 'knowledge'), { recursive: true });
  await writeFile(path.join(moonshotHome, 'state', 'projects', 'demo', 'knowledge', 'preserve.txt'), 'keep\n');
  await mkdir(path.join(codexHome, 'skills', 'external-skill'), { recursive: true });
  await writeFile(path.join(codexHome, 'skills', 'external-skill', 'SKILL.md'), 'external\n');
  await mkdir(path.join(codexHome, 'skills', 'completion-verifier'), { recursive: true });
  await writeFile(path.join(codexHome, 'skills', 'completion-verifier', 'SKILL.md'), 'stale managed\n');
  await mkdir(path.join(codexHome, 'skills', 'user-modified-managed'), { recursive: true });
  await writeFile(path.join(codexHome, 'skills', 'user-modified-managed', 'SKILL.md'), 'user edit\n');
  await mkdir(path.join(codexHome, 'skills', 'moonshot-phase-executor'), { recursive: true });
  await writeFile(path.join(codexHome, 'skills', 'moonshot-phase-executor', 'SKILL.md'), 'stale canonical internal\n');
  await mkdir(path.join(codexHome, 'sessions'), { recursive: true });
  await writeFile(path.join(codexHome, 'sessions', 'preserve.json'), '{}\n');
  await writeFile(path.join(codexHome, 'auth.json'), '{}\n');
  await mkdir(path.join(codexHome, 'schemas'), { recursive: true });
  await writeFile(path.join(codexHome, 'schemas', 'old-managed.schema.json'), '{}\n');
  await mkdir(path.join(codexHome, 'docs', 'public'), { recursive: true });
  await writeFile(path.join(codexHome, 'docs', 'public', 'old.md'), 'old\n');
  await writeFile(path.join(codexHome, '.moonshot-relay-install-manifest.json'), `${JSON.stringify({
    copied: [
      { path: 'schemas/old-managed.schema.json', sha256: sha256('{}\n') },
      { path: 'skills/completion-verifier/SKILL.md', sha256: sha256('stale managed\n') },
      { path: 'skills/user-modified-managed/SKILL.md', sha256: sha256('original managed\n') },
    ],
  })}\n`);
  await mkdir(path.join(qwenHome, 'skills', 'external-skill'), { recursive: true });
  await writeFile(path.join(qwenHome, 'skills', 'external-skill', 'SKILL.md'), 'external\n');
  await mkdir(path.join(qwenHome, 'skills', 'completion-verifier'), { recursive: true });
  await writeFile(path.join(qwenHome, 'skills', 'completion-verifier', 'SKILL.md'), 'stale managed\n');
  await mkdir(path.join(qwenHome, 'skills', 'moonshot-phase-executor'), { recursive: true });
  await writeFile(path.join(qwenHome, 'skills', 'moonshot-phase-executor', 'SKILL.md'), 'stale canonical internal\n');
  await mkdir(path.join(qwenHome, 'tmp'), { recursive: true });
  await writeFile(path.join(qwenHome, 'tmp', 'preserve.txt'), 'keep\n');
  await writeFile(path.join(qwenHome, 'settings.json'), '{"user":"settings"}\n');
  await mkdir(path.join(qwenHome, 'schemas'), { recursive: true });
  await writeFile(path.join(qwenHome, 'schemas', 'old-managed.schema.json'), '{}\n');
  await mkdir(path.join(qwenHome, 'docs', 'public'), { recursive: true });
  await writeFile(path.join(qwenHome, 'docs', 'public', 'old.md'), 'old\n');
  await writeFile(path.join(qwenHome, '.moonshot-relay-install-manifest.json'), `${JSON.stringify({
    copied: [
      { path: 'schemas/old-managed.schema.json', sha256: sha256('{}\n') },
      { path: 'skills/completion-verifier/SKILL.md', sha256: sha256('stale managed\n') },
    ],
  })}\n`);
  await mkdir(path.join(claudeHome, 'skills', 'external-skill'), { recursive: true });
  await writeFile(path.join(claudeHome, 'skills', 'external-skill', 'SKILL.md'), 'external\n');
  await mkdir(path.join(claudeHome, 'skills', 'completion-verifier'), { recursive: true });
  await writeFile(path.join(claudeHome, 'skills', 'completion-verifier', 'SKILL.md'), 'stale managed\n');
  await mkdir(path.join(claudeHome, 'skills', 'moonshot-phase-executor'), { recursive: true });
  await writeFile(path.join(claudeHome, 'skills', 'moonshot-phase-executor', 'SKILL.md'), 'stale canonical internal\n');
  await mkdir(path.join(claudeHome, 'sessions'), { recursive: true });
  await writeFile(path.join(claudeHome, 'sessions', 'preserve.json'), '{}\n');
  await writeFile(path.join(claudeHome, 'memory.json'), '{}\n');
  await mkdir(path.join(claudeHome, 'scripts'), { recursive: true });
  await writeFile(path.join(claudeHome, 'scripts', 'old-managed.mjs'), 'old\n');
  await mkdir(path.join(claudeHome, 'schemas'), { recursive: true });
  await writeFile(path.join(claudeHome, 'schemas', 'verification.contract.yaml'), 'runtimeVerdict: ".claude/runtime-verdict-<runId>.json"\n');
  await mkdir(path.join(claudeHome, 'docs', 'public'), { recursive: true });
  await writeFile(path.join(claudeHome, 'docs', 'public', 'old.md'), 'old\n');
  await writeFile(path.join(claudeHome, '.moonshot-relay-install-manifest.json'), `${JSON.stringify({
    copied: [
      { path: 'scripts/old-managed.mjs', sha256: sha256('old\n') },
      { path: 'skills/completion-verifier/SKILL.md', sha256: sha256('stale managed\n') },
    ],
  })}\n`);

  await mkdir(path.join(antigravityHome, 'skills', 'external-skill'), { recursive: true });
  await writeFile(path.join(antigravityHome, 'skills', 'external-skill', 'SKILL.md'), 'external\n');
  await mkdir(path.join(antigravityHome, 'skills', 'completion-verifier'), { recursive: true });
  await writeFile(path.join(antigravityHome, 'skills', 'completion-verifier', 'SKILL.md'), 'stale managed\n');
  await mkdir(path.join(antigravityHome, 'skills', 'moonshot-phase-executor'), { recursive: true });
  await writeFile(path.join(antigravityHome, 'skills', 'moonshot-phase-executor', 'SKILL.md'), 'stale canonical internal\n');
  await mkdir(path.join(antigravityHome, 'tmp'), { recursive: true });
  await writeFile(path.join(antigravityHome, 'tmp', 'preserve.txt'), 'keep\n');
  await writeFile(path.join(antigravityHome, '.moonshot-relay-install-manifest.json'), `${JSON.stringify({
    copied: [
      { path: 'skills/completion-verifier/SKILL.md', sha256: sha256('stale managed\n') },
    ],
  })}\n`);
  await mkdir(path.join(antigravitySkillsHome, 'skills', 'external-skill'), { recursive: true });
  await writeFile(path.join(antigravitySkillsHome, 'skills', 'external-skill', 'SKILL.md'), 'external\n');
  await mkdir(path.join(antigravitySkillsHome, 'skills', 'completion-verifier'), { recursive: true });
  await writeFile(path.join(antigravitySkillsHome, 'skills', 'completion-verifier', 'SKILL.md'), 'stale managed\n');
  await mkdir(path.join(antigravitySkillsHome, 'skills', 'moonshot-phase-executor'), { recursive: true });
  await writeFile(path.join(antigravitySkillsHome, 'skills', 'moonshot-phase-executor', 'SKILL.md'), 'stale canonical internal\n');
  await writeFile(path.join(antigravitySkillsHome, '.moonshot-relay-antigravity-skills-manifest.json'), `${JSON.stringify({
    copied: [
      { path: 'skills/completion-verifier/SKILL.md', sha256: sha256('stale managed\n') },
    ],
  })}\n`);

  try {
    const result = spawnSync(process.execPath, [
      'scripts/install-account-root-harness.mjs',
      '--runtime',
      'all',
      '--source-root',
      root,
      '--moonshot-home',
      moonshotHome,
      '--claude-home',
      claudeHome,
      '--codex-home',
      codexHome,
      '--qwen-home',
      qwenHome,
      '--antigravity-home',
      antigravityHome,
      '--antigravity-skills-home',
      antigravitySkillsHome,
      '--remove-legacy-harness-core',
      '--json',
    ], {
      cwd: root,
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const installPayload = JSON.parse(result.stdout);
    assert.ok(installPayload.installId);
    assert.equal(installPayload.verification.every((entry: unknown) => (
      assertTestArray(assertTestRecord(entry).missing).length === 0 && assertTestArray(assertTestRecord(entry).mismatch).length === 0
    )), true);
    const globalSkillsManifest = JSON.parse(await readFile(
      path.join(antigravitySkillsHome, '.moonshot-relay-antigravity-skills-manifest.json'),
      'utf8',
    ));
    assert.ok(globalSkillsManifest.copied.length > 0);
    assert.equal(
      assertTestRecord(assertTestArray(installPayload.manifests).find((manifest) => assertTestRecord(manifest).runtime === 'antigravity-global-skills')).copiedCount,
      globalSkillsManifest.copied.length,
    );
    assert.equal(installPayload.profileSurfaceParity.length, 4);
    const codexParity = installPayload.profileSurfaceParity.find((entry: unknown) => assertTestRecord(entry).runtime === 'codex');
    const claudeParity = installPayload.profileSurfaceParity.find((entry: unknown) => assertTestRecord(entry).runtime === 'claude');
    const qwenParity = installPayload.profileSurfaceParity.find((entry: unknown) => assertTestRecord(entry).runtime === 'qwen');
    const antigravityParity = installPayload.profileSurfaceParity.find((entry: unknown) => assertTestRecord(entry).runtime === 'antigravity');
    assert.equal(codexParity.status, 'pass');
    assert.equal(claudeParity.status, 'pass');
    assert.equal(qwenParity.status, 'pass');
    assert.equal(antigravityParity.status, 'pass');
    assert.equal(antigravityParity.skillTargetRoot, antigravitySkillsHome);
    assert.equal(codexParity.extraCanonicalCount, 0);
    assert.equal(qwenParity.extraCanonicalCount, 0);
    assert.equal(antigravityParity.extraCanonicalCount, 0);
    assert.deepEqual(codexParity.missingPublicSkills, []);
    assert.deepEqual(claudeParity.missingPublicSkills, []);
    assert.deepEqual(qwenParity.missingPublicSkills, []);
    assert.deepEqual(antigravityParity.missingPublicSkills, []);
    assert.deepEqual(codexParity.extraCanonicalSkills, []);
    assert.deepEqual(qwenParity.extraCanonicalSkills, []);
    assert.deepEqual(antigravityParity.extraCanonicalSkills, []);
    assert.equal(existsSync(path.join(codexHome, 'skills', 'external-skill', 'SKILL.md')), true);
    assert.equal(await readFile(path.join(codexHome, 'skills', 'user-modified-managed', 'SKILL.md'), 'utf8'), 'user edit\n');
    assert.equal(existsSync(path.join(claudeHome, 'skills', 'external-skill', 'SKILL.md')), true);
    assert.equal(existsSync(path.join(qwenHome, 'skills', 'external-skill', 'SKILL.md')), true);
    assert.equal(existsSync(path.join(antigravityHome, 'skills', 'external-skill', 'SKILL.md')), true);
    assert.equal(existsSync(path.join(antigravitySkillsHome, 'skills', 'external-skill', 'SKILL.md')), true);
    assert.equal(existsSync(path.join(codexHome, 'skills', 'completion-verifier', 'SKILL.md')), false);
    assert.equal(existsSync(path.join(claudeHome, 'skills', 'completion-verifier', 'SKILL.md')), false);
    assert.equal(existsSync(path.join(qwenHome, 'skills', 'completion-verifier', 'SKILL.md')), false);
    assert.equal(existsSync(path.join(antigravityHome, 'skills', 'completion-verifier', 'SKILL.md')), false);
    assert.equal(existsSync(path.join(antigravitySkillsHome, 'skills', 'completion-verifier', 'SKILL.md')), false);
    assert.equal(existsSync(path.join(codexHome, 'skills', 'moonshot-phase-executor', 'SKILL.md')), false);
    assert.equal(existsSync(path.join(claudeHome, 'skills', 'moonshot-phase-executor', 'SKILL.md')), false);
    assert.equal(existsSync(path.join(qwenHome, 'skills', 'moonshot-phase-executor', 'SKILL.md')), false);
    assert.equal(existsSync(path.join(antigravityHome, 'skills', 'moonshot-phase-executor', 'SKILL.md')), false);
    assert.equal(existsSync(path.join(antigravitySkillsHome, 'skills', 'moonshot-phase-executor', 'SKILL.md')), false);
    assert.equal(existsSync(path.join(codexHome, 'skills', 'moonshot-phase-runner', 'SKILL.md')), true);
    assert.equal(existsSync(path.join(claudeHome, 'skills', 'moonshot-phase-runner', 'SKILL.md')), true);
    assert.equal(existsSync(path.join(qwenHome, 'skills', 'moonshot-phase-runner', 'SKILL.md')), true);
    assert.equal(existsSync(path.join(antigravityHome, 'skills', 'moonshot-phase-runner', 'SKILL.md')), true);
    assert.equal(existsSync(path.join(antigravitySkillsHome, 'skills', 'moonshot-phase-runner', 'SKILL.md')), true);
    assert.equal(existsSync(path.join(codexHome, 'skills', 'moonshot-plan-writer', 'SKILL.md')), true);
    assert.equal(existsSync(path.join(claudeHome, 'skills', 'moonshot-plan-writer', 'SKILL.md')), true);
    assert.equal(existsSync(path.join(qwenHome, 'skills', 'moonshot-plan-writer', 'SKILL.md')), true);
    assert.equal(existsSync(path.join(antigravityHome, 'skills', 'moonshot-plan-writer', 'SKILL.md')), true);
    assert.equal(existsSync(path.join(antigravitySkillsHome, 'skills', 'moonshot-plan-writer', 'SKILL.md')), true);
    assert.equal(existsSync(path.join(moonshotHome, 'skills', 'moonshot-plan-writer', 'SKILL.md')), true);
    assert.equal(existsSync(path.join(claudeHome, 'rules', 'workflow.md')), true);
    assert.equal(existsSync(path.join(moonshotHome, 'rules', 'workflow-bundles.yaml')), true);
    assert.equal(existsSync(path.join(moonshotHome, 'skills', 'completion-verifier', 'SKILL.md')), true);
    assert.equal(existsSync(path.join(moonshotHome, 'skills.lock.json')), true);
    assert.equal(existsSync(path.join(moonshotHome, 'catalog', 'moonshot-catalog.json')), true);
    assert.equal(existsSync(path.join(moonshotHome, 'kernel', 'proof-policy.yaml')), true);
    assert.equal(existsSync(path.join(moonshotHome, 'scripts', 'kernel', 'runtime-home.js')), true);
    assert.equal(existsSync(path.join(moonshotHome, 'scripts', 'install-account-root-harness.mjs')), true);
    assert.equal(existsSync(path.join(moonshotHome, 'templates', 'GOAL_CONTRACT.template.yaml')), true);
    assert.equal(existsSync(path.join(moonshotHome, 'node_modules', 'better-sqlite3', 'package.json')), false);
    assert.equal(existsSync(path.join(moonshotHome, 'node_modules', 'bindings', 'package.json')), false);
    assert.equal(existsSync(path.join(moonshotHome, 'state', 'projects', 'demo', 'knowledge', 'preserve.txt')), true);
    assert.equal(existsSync(path.join(codexHome, 'sessions', 'preserve.json')), true);
    assert.equal(existsSync(path.join(codexHome, 'auth.json')), true);
    assert.equal(existsSync(path.join(qwenHome, 'tmp', 'preserve.txt')), true);
    assert.equal(await readFile(path.join(qwenHome, 'settings.json'), 'utf8'), '{"user":"settings"}\n');
    assert.equal(existsSync(path.join(claudeHome, 'sessions', 'preserve.json')), true);
    assert.equal(existsSync(path.join(claudeHome, 'memory.json')), true);
    assert.equal(existsSync(path.join(antigravityHome, 'tmp', 'preserve.txt')), true);
    assert.equal(existsSync(path.join(claudeHome, 'scripts')), false);
    assert.equal(existsSync(path.join(claudeHome, 'schemas')), false);
    assert.equal(existsSync(path.join(claudeHome, 'docs', 'public')), false);
    assert.equal(existsSync(path.join(codexHome, 'scripts')), false);
    assert.equal(existsSync(path.join(codexHome, 'schemas')), false);
    assert.equal(existsSync(path.join(codexHome, 'docs', 'public')), false);
    assert.equal(existsSync(path.join(qwenHome, 'scripts')), false);
    assert.equal(existsSync(path.join(qwenHome, 'schemas')), false);
    assert.equal(existsSync(path.join(qwenHome, 'docs', 'public')), false);
    assert.equal(existsSync(path.join(antigravityHome, 'scripts')), false);
    assert.equal(existsSync(path.join(antigravityHome, 'schemas')), false);
    assert.equal(existsSync(path.join(antigravityHome, 'docs', 'public')), false);

    const kernelCliSmoke = spawnSync(process.execPath, [
      path.join(moonshotHome, 'bin', 'moon-relay-kernel.mjs'),
      '--version',
    ], {
      cwd: moonshotHome,
      encoding: 'utf8',
      env: {
        ...process.env,
        MOON_RELAY_KERNEL_REEXEC: '1',
      },
    });
    assert.equal(kernelCliSmoke.status, 0, kernelCliSmoke.stderr || kernelCliSmoke.stdout);
    assert.match(kernelCliSmoke.stdout, /moon-relay-kernel/);

    const runtimeSmoke = spawnSync(process.execPath, [
      path.join(moonshotHome, 'scripts', 'runtime-state.mjs'),
      'status',
      '--run-id',
      'package-install-smoke',
      '--goal-id',
      'runtime-state-availability',
      '--json',
    ], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        MOONSHOT_RELAY_HOME: moonshotHome,
      },
    });
    assert.equal(runtimeSmoke.status, 0, runtimeSmoke.stderr || runtimeSmoke.stdout);
    const runtimePayload = JSON.parse(runtimeSmoke.stdout);
    assert.equal(runtimePayload.runtimeCapabilityStatus.status, 'available');

    const degradedSmoke = spawnSync(process.execPath, [
      path.join(moonshotHome, 'scripts', 'runtime-state.mjs'),
      'status',
      '--run-id',
      'package-install-smoke',
      '--goal-id',
      'runtime-state-availability',
      '--json',
    ], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        MOONSHOT_RELAY_HOME: moonshotHome,
        MOONSHOT_RUNTIME_STATE_DISABLE_NATIVE: '1',
      },
    });
    assert.equal(degradedSmoke.status, 0, degradedSmoke.stderr || degradedSmoke.stdout);
    const degradedPayload = JSON.parse(degradedSmoke.stdout);
    assert.equal(degradedPayload.runtimeCapabilityStatus.status, 'degraded');
    assert.equal(degradedPayload.runtimeCapabilityStatus.reason, 'missing_native_module');
  } finally {
    await rm(installRoot, { recursive: true, force: true });
  }
});

type TestControlPlane = Awaited<ReturnType<typeof import('../src/host/kernel/control-plane-runtime.js').createKernelControlPlane>>;
type TestStateStore = Awaited<ReturnType<typeof import('../src/kernel/state-store.js').openKernelStateStore>>;
