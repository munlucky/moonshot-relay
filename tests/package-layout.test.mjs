import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import { existsSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { gitLsFiles } from '../scripts/lib/git-safe.mjs';
import { activeGate, activeGateSegments } from './helpers/active-gate.mjs';

const root = process.cwd();
const fromRoot = (...segments) => path.join(root, ...segments);

const canonicalDirs = [
  'src',
  'skills',
  'agents',
  'rules',
  'scripts',
  'bin',
  'tools',
  'schemas',
  'templates',
  'tests',
  'package',
];

const wrapperDirs = ['.claude-plugin', '.codex-plugin'];

const profileTemplateDirs = [
  'package/profile-templates/claude/.claude',
  'package/profile-templates/codex/.codex',
  'package/profile-templates/qwen/.qwen',
];

const archiveDirs = [
  'archive/scripts/legacy-phase-adapters',
];

const canonicalSourceMinimums = new Map([
  ['src', 5],
  ['skills', 10],
  ['agents', 5],
  ['rules', 5],
  ['scripts', 5],
  ['bin', 1],
  ['tools', 5],
  ['schemas', 2],
  ['templates', 5],
]);

const generatedStateExclusions = [
  '.moonshot-relay/**',
  '.moonshot-state/**',
  'docs/implementation/**/execution/**',
  'docs/implementation/**/close/**',
  'docs/implementation/**/archive/**',
  '.claude/logs/**',
  '.claude/cache/**',
  '.claude/traces/**',
  '.claude/browser-artifacts/**',
  '.claude/browser-runtime/**',
  '.claude/tools/**/node_modules/**',
  '.claude/tmp/**',
  '.claude/runtime-state.sqlite*',
  '.claude/memory.json',
  '.claude/memorygraph/**',
  '.claude/*verdict*.json',
  '.codex/cache/**',
  '.codex/sqlite/**',
  '.codex/memories/**',
  '.codex/sessions/**',
  '.qwen/cache/**',
  '.qwen/logs/**',
  '.qwen/tmp/**',
  '.qwen/memory.json',
  '.code-review-graph/**',
];

const listFiles = async (relativeDir) => {
  const absoluteDir = fromRoot(relativeDir);
  const entries = await readdir(absoluteDir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const relativePath = path.join(relativeDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFiles(relativePath));
    } else {
      files.push(relativePath.replaceAll(path.sep, '/'));
    }
  }

  return files;
};

test('canonical source and package boundary directories exist', () => {
  for (const dir of canonicalDirs) {
    const fullPath = fromRoot(dir);
    assert.equal(existsSync(fullPath), true, `${dir} should exist`);
    assert.equal(lstatSync(fullPath).isDirectory(), true, `${dir} should be a directory`);
  }

  for (const dir of wrapperDirs) {
    const fullPath = fromRoot(dir);
    assert.equal(existsSync(fullPath), true, `${dir} should exist`);
    assert.equal(lstatSync(fullPath).isDirectory(), true, `${dir} should be a directory`);
  }

  for (const dir of profileTemplateDirs) {
    const fullPath = fromRoot(dir);
    assert.equal(existsSync(fullPath), true, `${dir} should exist`);
    assert.equal(lstatSync(fullPath).isDirectory(), true, `${dir} should be a directory`);
  }

  for (const dir of archiveDirs) {
    const fullPath = fromRoot(dir);
    assert.equal(existsSync(fullPath), true, `${dir} should exist`);
    assert.equal(lstatSync(fullPath).isDirectory(), true, `${dir} should be a directory`);
  }
});

const trackedImplementationPlanAllowlist = [
  /^docs\/implementation\/[^/]+\/[0-9][0-9]-[^/]+\.md$/,
  /^docs\/implementation\/[^/]+\/(?:ARCHITECTURE_REVIEW|ASR_CATALOG|CURRENT_ARCHITECTURE|IMPACT_MAP|PLAN|PRD_FIT_GAP|REQUIREMENT_INVENTORY|SPEC_DELTA|TRACEABILITY_MATRIX|TRADEOFF_ANALYSIS)\.md$/,
  /^docs\/implementation\/[^/]+\/ADR\/[^/]+\.md$/,
  /^docs\/implementation\/[^/]+\/C4\/[^/]+\.md$/,
  /^docs\/implementation\/[^/]+\/planning-loop\/[^/]+\.(?:ya?ml|json|md)$/,
  /^docs\/implementation\/[^/]+\/architecture-handoff\/.+\.(?:ya?ml|json|md)$/,
];

const isAllowedTrackedDoc = (file) => (
  file.startsWith('docs/public/')
  || file.startsWith('docs/capability-assets/')
  || file.startsWith('docs/decomplexification/')
  || trackedImplementationPlanAllowlist.some((pattern) => pattern.test(file))
);

test('tracked docs are limited to public docs, capability assets, and source-local implementation plans', () => {
  const output = gitLsFiles(root, ['docs']).stdout;
  const violations = output
    .split(/\r?\n/)
    .filter(Boolean)
    .filter((file) => !isAllowedTrackedDoc(file));

  assert.deepEqual(
    violations,
    [],
    `Only docs/public, docs/capability-assets, and allowlisted docs/implementation plan artifacts are trackable:\n${violations.join('\n')}`,
  );
});

test('tracked roadmaps and account-root plans are separated from runtime execution scratch space', async () => {
  const trackedDocs = gitLsFiles(root, ['docs']).stdout.split(/\r?\n/).filter(Boolean);

  assert.ok(
    trackedDocs.includes('docs/public/roadmaps/harness-control-plane-modernization/00-master-plan-v1.md'),
    'The harness control-plane modernization roadmap should be tracked under docs/public/roadmaps/',
  );
  const trackedImplementationDocs = trackedDocs.filter((file) => file.startsWith('docs/implementation/'));
  assert.equal(
    trackedImplementationDocs.length,
    0,
    'default source checkout should not track repo-local docs/implementation plan packages',
  );
  assert.deepEqual(
    trackedImplementationDocs.filter((file) => !isAllowedTrackedDoc(file)),
    [],
    'tracked docs/implementation entries must be phase plans or planning-loop review artifacts',
  );
  assert.equal(
    trackedImplementationDocs.some((file) => /\/(?:execution|close|archive)\//.test(file)),
    false,
    'docs/implementation execution, closeout, and archive artifacts remain runtime scratch and must not be tracked',
  );

  const readme = await readFile(fromRoot('README.md'), 'utf8');
  const repositoryLayout = await readFile(fromRoot('docs', 'public', 'repository-layout.md'), 'utf8');
  const installerUsage = await readFile(fromRoot('docs', 'public', 'installer-usage.md'), 'utf8');
  const combined = `${readme}\n${repositoryLayout}\n${installerUsage}`;

  assert.match(combined, /docs\/public\/roadmaps\/harness-control-plane-modernization/);
  assert.match(combined, /docs\/implementation\/\*\*/);
  assert.match(combined, /state\/projects\/<projectId>\/planning\/packages\/<plan-slug>/);
  assert.match(combined, /plans\/<plan-slug>\/runs\/<runId>\/execution/);
  assert.match(combined, /account-root project planning namespace/i);
  assert.match(combined, /runtime execution scratch/i);
});

test('canonical source directories contain real harness files, not README-only placeholders', async () => {
  for (const [dir, minimumFileCount] of canonicalSourceMinimums) {
    const files = await listFiles(dir);
    const sourceFiles = files.filter((file) => !file.endsWith('/README.md') && file !== `${dir}/README.md`);

    assert.ok(
      sourceFiles.length >= minimumFileCount,
      `${dir}/ should contain at least ${minimumFileCount} real source files, found ${sourceFiles.length}`,
    );
  }

  assert.equal(existsSync(fromRoot('skills', 'moonshot-phase-runner', 'SKILL.md')), true);
  assert.equal(existsSync(fromRoot('scripts', 'install-account-root-harness.mjs')), true);
  assert.equal(existsSync(fromRoot('package.json')), true);
  assert.equal(existsSync(fromRoot('bin', 'moonshot-relay.mjs')), true);
  assert.equal(existsSync(fromRoot('scripts', 'memorygraph-mcp-wrapper.js')), true);
  assert.equal(existsSync(fromRoot('bin', 'browserctl')), true);
  assert.equal(existsSync(fromRoot('tools', 'browserd', 'package.json')), true);
  assert.equal(existsSync(fromRoot('rules', 'workflow.md')), true);
  assert.equal(existsSync(fromRoot('schemas', 'verification.contract.yaml')), true);
  assert.equal(existsSync(fromRoot('templates', 'GOAL_CONTRACT.template.yaml')), true);
});

test('package contract declares required source payload entries and generated-state exclusions', async () => {
  const contract = await readFile(fromRoot('package', 'package-contract.yaml'), 'utf8');

  for (const key of ['skills', 'agents', 'rules', 'scripts', 'bin', 'tools', 'schemas', 'templates', 'tests', 'publicDocs']) {
    assert.match(contract, new RegExp(`^  ${key}:`, 'm'), `canonicalSource.${key} should be declared`);
  }

  for (const entry of [
    'skills/**',
    'agents/**',
    'rules/**',
    'bin/**',
    'tools/**',
    'schemas/**',
    'templates/**',
    'docs/public/**',
    'tests/package-layout.test.mjs',
    'schemas/verification.contract.yaml',
    'schemas/discovery-map.schema.json',
    'schemas/spec-test-obligation.schema.json',
    'templates/product-definition/DISCOVERY_MAP.template.md',
    'templates/product-definition/DISCOVERY_TICKET.template.md',
    'templates/product-definition/RESEARCH_NOTE.template.md',
    'templates/product-definition/PROTOTYPE_DECISION.template.md',
    'package/build-package.mjs',
    'scripts/install-account-root-harness.mjs',
    'scripts/browser-flow-runner.mjs',
    'scripts/architecture-knowledge-resolve.mjs',
    'scripts/architecture-contract-bind.mjs',
    'scripts/architecture-handoff-build.mjs',
    'scripts/architecture-feedback-render.mjs',
    'scripts/commit-moonshot-closeout-event.mjs',
    'tools/harness-lab/harness-lab.mjs',
    'docs/public/guidelines/harness-bootstrap-lab.md',
    'package/runtime-surface.json',
    'commonSupportScripts:',
    'archivedLegacyScripts:',
    'archive/scripts/legacy-phase-adapters/',
    'scripts/install-browser-runtime.sh',
    'scripts/prepare-phase-runner-state.mjs',
    'scripts/spec-test-obligations.mjs',
    'scripts/memorygraph-mcp-wrapper.js',
    'scripts/code-review-graph-mcp-wrapper.js',
    'package/profile-templates/claude/.claude/',
    'package/profile-templates/codex/.codex/',
    'package/profile-templates/qwen/.qwen/',
    'package/moonshot-relay/profile/',
  ]) {
    assert.match(contract, new RegExp(entry.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${entry} should be listed`);
  }

  for (const exclusion of generatedStateExclusions) {
    assert.match(contract, new RegExp(exclusion.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${exclusion} should be excluded`);
  }

  assert.doesNotMatch(contract, /source: scripts\/lib\/\*\*/);
  assert.match(contract, /scripts\/lib\/runtime-state-root\.mjs/);
  assert.match(contract, /scripts\/fixtures\/\*\*/);
  assert.match(contract, /tests\/fixtures\/\*\*/);

  assert.match(contract, /symlinkPolicy: avoid_required_symlinks/);
  assert.match(contract, /windowsMaterializationPolicy:/);
  assert.match(contract, /duplicateSourcePolicy:/);
  assert.match(contract, /accountRootInstall:/);
  assert.match(contract, /defaultShellInstaller: install-claude\.sh/);
  assert.match(contract, /mode: account-root-direct/);
  assert.match(contract, /projectCompatibilityMode: "install-claude\.sh --project"/);
  assert.match(contract, /sharedRuntimeHome:/);
  assert.match(contract, /env: MOONSHOT_RELAY_HOME/);
  assert.match(contract, /windowsCmd: "%MOONSHOT_RELAY_HOME%"/);
  assert.match(contract, /windowsPowerShell: "\$env:MOONSHOT_RELAY_HOME"/);
  assert.match(contract, /posixShell: "\$\{MOONSHOT_RELAY_HOME\}"/);
  assert.match(contract, /common: "\$\{MOONSHOT_RELAY_HOME:-~\/\.moonshot-relay\}"/);
  assert.match(contract, /claude: "\$\{CLAUDE_HOME:-~\/\.claude\}"/);
  assert.match(contract, /codex: "\$\{CODEX_HOME:-~\/\.codex\}"/);
  assert.match(contract, /qwen: "\$\{QWEN_HOME:-~\/\.qwen\}"/);
  assert.match(contract, /antigravitySkills: "\$\{ANTIGRAVITY_SKILLS_HOME:-~\/\.gemini\/config\}"/);
  assert.match(contract, /commonPayloadEntries:/);
  assert.match(contract, /skillExposure:/);
  assert.match(contract, /manifest: package\/runtime-surface\.json/);
  const runtimeSurface = JSON.parse(await readFile(fromRoot('package', 'runtime-surface.json'), 'utf8'));
  for (const publicSkill of runtimeSurface.publicRuntimeSkills) {
    assert.match(contract, new RegExp(publicSkill));
  }
  assert.match(contract.match(/publicRuntimeSkills:[\s\S]*?internalSkillPolicy:/)?.[0] || '', /moonshot-plan-writer/);
  assert.match(contract, /commonPayloadSkillPolicy: preserve_all_canonical_skills/);
  assert.match(contract, /serviceProfileSkillPolicy: allowlist_only/);
  assert.match(contract, /managedSkillPrunePolicy: prune_previously_managed_profile_skills_absent_from_current_payload_preserve_external/);
  assert.match(contract, /docs\/public\//);
  assert.match(contract, /^\s+- skills\/$/m);
  assert.doesNotMatch(contract, /^\s+- docs\/$/m);
  assert.match(contract, /^\s+- rules\/$/m);
  assert.match(contract, /runtimeExposureEntries:/);
  assert.match(contract, /legacyHarnessCorePolicy: remove_when_requested_after_backup/);
});

test('moonshot-relay package dry-run includes explicit runtime fixture and helper payloads', async () => {
  const result = spawnSync(process.execPath, [
    'package/build-package.mjs',
    '--runtime',
    'moonshot-relay',
    '--dry-run',
    '--json',
  ], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 20,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  const planned = new Set(payload.runtimes?.[0]?.planned?.map((entry) => entry.from) || []);
  assert.equal(planned.has('scripts/lib/harness-environment-snapshot.mjs'), true);
  assert.equal(planned.has('tools/evals/fixtures/harness-search-fixtures/fixture-manifest.json'), true);
  assert.equal(planned.has('tools/retro/retro-cli.mjs'), true);
  assert.equal(planned.has('schemas/retro.collect.schema.json'), true);
  assert.equal(planned.has('templates/retro/DAILY_RETRO.md'), true);
});

test('package scripts define the active gate without archive discovery', async () => {
  const manifest = JSON.parse(await readFile(fromRoot('package.json'), 'utf8'));
  const scripts = manifest.scripts || {};
  const requiredModernizationContracts = [
    'tests/runtime-control-plane-contract.test.mjs',
    'tests/completion-authority-contract.test.mjs',
    'tests/runtime-read-model-contract.test.mjs',
    'tests/context-state-engine-contract.test.mjs',
    'tests/tool-registry-dispatcher-contract.test.mjs',
    'tests/sandbox-compute-plane-contract.test.mjs',
    'tests/verification-plane-contract.test.mjs',
    'tests/spec-test-obligations-contract.test.mjs',
    'tests/eval-regression-contract.test.mjs',
    'tests/tool-sandbox-eval-contract.test.mjs',
    'tests/harness-lab-contract.test.mjs',
    'tests/retro-collect-contract.test.mjs',
    'tests/retro-redaction-contract.test.mjs',
    'tests/daily-retro-contract.test.mjs',
    'tests/retro-improvement-proposer-contract.test.mjs',
    'tests/retro-issue-draft-contract.test.mjs',
    'tests/retro-cli-contract.test.mjs',
    'tests/retro-no-promotion-authority-contract.test.mjs',
    'tests/discovery-map-contract.test.mjs',
    'tests/research-evidence-contract.test.mjs',
    'tests/agent-policy/fact-decision-classification.test.mjs',
    'tests/moonshot-architecture-skill-surface.test.mjs',
    'tests/moonshot-architecture-template-contract.test.mjs',
    'tests/moonshot-architecture-schema-contract.test.mjs',
    'tests/architecture-knowledge-schema-contract.test.mjs',
    'tests/architecture-knowledge-resolve.test.mjs',
    'tests/architecture-contract-bind.test.mjs',
    'tests/architecture-handoff-build.test.mjs',
    'tests/architecture-feedback-render.test.mjs',
    'tests/moonshot-architecture-internal-skills.test.mjs',
    'tests/moonshot-architecture-context-pack.test.mjs',
    'tests/moonshot-architecture-greenfield-flow.test.mjs',
    'tests/moonshot-architecture-brownfield-flow.test.mjs',
    'tests/moonshot-architecture-handoff-contract.test.mjs',
    'tests/moonshot-architecture-contract-binding-flow.test.mjs',
    'tests/moonshot-architecture-regression.test.mjs',
  ];

  assert.equal(typeof scripts.test, 'string', 'package.json should define scripts.test');
  assert.match(manifest.description, /Claude, Codex, and Qwen profiles/);
  assert.ok(manifest.files.includes('!package/qwen/profile/'), 'generated Qwen profile payload must stay out of npm package files');
  assert.equal(scripts['test:active'], 'npm test');
  // The gate is segmented because one string of every test path exceeds the
  // Windows command-line limit; every segment is still a plain node --test run.
  const gateSegments = activeGateSegments(manifest);
  assert.ok(gateSegments.length > 0, 'the active gate must resolve to at least one node --test segment');
  for (const segment of gateSegments) {
    assert.match(segment, /^node --test tests\//);
    assert.doesNotMatch(segment, /(?:^|\s)node --test\s*$/);
  }
  const gate = activeGate(manifest);
  for (const contractTest of requiredModernizationContracts) {
    assert.match(gate, new RegExp(contractTest.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${contractTest} should be in npm test`);
  }
  assert.doesNotMatch(gate, /archive[\\/]/);
  assert.doesNotMatch(gate, /\.claude[\\/]scripts/);
  assert.equal(typeof scripts['test:package'], 'string', 'package.json should define scripts.test:package');
  assert.equal(typeof scripts['test:retro'], 'string', 'package.json should define scripts.test:retro');
  assert.equal(typeof scripts['test:eval'], 'string', 'package.json should define scripts.test:eval');
  assert.equal(typeof scripts['test:lab'], 'string', 'package.json should define scripts.test:lab');
  assert.match(scripts['test:retro'], /tests\/retro-collect-contract\.test\.mjs/);
  assert.match(scripts['test:eval'], /tools\/evals\/harness-control-plane\.mjs run --json/);
  assert.match(scripts['test:lab'], /tools\/harness-lab\/harness-lab\.mjs run --candidate-root \. --json/);
  assert.doesNotMatch(scripts['test:package'], /archive[\\/]/);
});

test('repository layout docs name canonical source, local runtime profile, generated state, and package payload boundaries', async () => {
  const repositoryLayout = await readFile(fromRoot('docs', 'public', 'repository-layout.md'), 'utf8');
  const installerUsage = await readFile(fromRoot('docs', 'public', 'installer-usage.md'), 'utf8');
  const packageReadme = await readFile(fromRoot('package', 'README.md'), 'utf8');
  const combined = `${repositoryLayout}\n${installerUsage}\n${packageReadme}`;

  for (const phrase of ['canonical source', 'local runtime profile', 'generated state', 'package payload']) {
    assert.match(combined, new RegExp(phrase, 'i'), `${phrase} boundary should be documented`);
  }

  assert.match(repositoryLayout, /Do not add new canonical source under root `\.claude\/`, `\.codex\/`, or `\.qwen\/`/);
  assert.match(repositoryLayout, /do not create or depend on nested `harness-core` directories/i);
  assert.match(packageReadme, /Generated state is never part of the package payload/);
  assert.match(packageReadme, /install-account-root-harness\.mjs/);
  assert.match(packageReadme, /npx -y github:munlucky\/moonshot-relay install/);
  assert.match(installerUsage, /default mode is account-root installation/i);
  assert.match(installerUsage, /npx -y github:munlucky\/moonshot-relay install/);
  assert.match(installerUsage, /~\/\.moonshot-relay/);
  assert.match(installerUsage, /--project/);
  assert.match(repositoryLayout, /Default installs materialize shared Moonshot Relay runtime assets/);
  assert.match(repositoryLayout, /Claude keeps `\.claude\/rules\/`/);
});

test('skills and agents use Moonshot Relay home for shared runtime assets', async () => {
  const runtimeInstructionFiles = [
    ...await listFiles('skills'),
    ...await listFiles('agents'),
  ].filter((file) => /\.(md|sh)$/.test(file));
  const forbiddenSharedRuntimeProfileRef = /(?:^|[^A-Za-z0-9_])\.claude[\\/](?:docs|scripts|schemas|templates|tools|bin|config)(?:[\\/]|`|"|'|\s|$)/;
  const violations = [];

  for (const file of runtimeInstructionFiles) {
    const content = await readFile(fromRoot(file), 'utf8');
    const lines = content.split(/\r?\n/);
    lines.forEach((line, index) => {
      if (forbiddenSharedRuntimeProfileRef.test(line)) {
        violations.push(`${file}:${index + 1}: ${line.trim()}`);
      }
    });
  }

  assert.deepEqual(
    violations,
    [],
    `Shared runtime assets must be referenced through MOONSHOT_RELAY_HOME, not .claude profile-local paths:\n${violations.join('\n')}`,
  );
});

test('active docs do not advertise profile-local scripts as canonical commands', async () => {
  const activeInstructionFiles = [
    'README.md',
    'scripts/commit-moonshot-closeout-event.mjs',
    'scripts/commit-moonshot-memory-refresh.mjs',
    'scripts/commit-moonshot-promotion-audit.mjs',
  ];
  const violations = [];

  for (const file of activeInstructionFiles) {
    const content = await readFile(fromRoot(file), 'utf8');
    const lines = content.split(/\r?\n/);
    lines.forEach((line, index) => {
      if (/node\s+\.claude[\\/]scripts[\\/]/.test(line)) {
        violations.push(`${file}:${index + 1}: ${line.trim()}`);
      }
    });
  }

  assert.deepEqual(
    violations,
    [],
    `Active instructions must use <MOONSHOT_RELAY_HOME>/scripts or explain legacy wrappers:\n${violations.join('\n')}`,
  );
});

test('browser verifier distinguishes canonical source from installed profile entrypoint', async () => {
  for (const file of [
    'skills/browser-verifier/SKILL.md',
    'skills/browser-verifier/SKILL.ko.md',
  ]) {
    const content = await readFile(fromRoot(file), 'utf8');
    assert.match(content, /agents\/verification\/verify-runtime\.sh/);
    assert.match(content, /\.claude\/agents\/verification\/verify-runtime\.sh/);
    assert.doesNotMatch(content, /\.claude\/agents\/verification\/verify-runtime\.sh[^.\n]*(?:canonical|standard|표준)/i);
  }
});

test('moonshot skill deep references resolve within source skill directories', async () => {
  const skillFiles = [
    ...await listFiles('skills'),
  ].filter((file) => /^skills\/moonshot-/.test(file) && /\/SKILL(?:\.ko)?\.md$/.test(file));
  const missing = [];

  for (const file of skillFiles) {
    const content = await readFile(fromRoot(file), 'utf8');
    const lines = content.split(/\r?\n/);
    const skillDir = path.dirname(file);
    const deepReferenceIndex = lines.findIndex((line) => line.trim() === 'deepReferences:');
    if (deepReferenceIndex === -1) {
      continue;
    }
    for (let index = deepReferenceIndex + 1; index < lines.length; index += 1) {
      const line = lines[index];
      if (/^\S/.test(line) && line.trim() !== '') {
        break;
      }
      const match = line.match(/^\s*-\s+(.+?)\s*$/);
      if (!match) {
        continue;
      }
      const referencePath = match[1].replace(/^['"]|['"]$/g, '');
      const resolved = referencePath.startsWith('.')
        ? referencePath
        : path.join(skillDir, referencePath).replaceAll(path.sep, '/');
      if (!existsSync(fromRoot(resolved))) {
        missing.push(`${file}: ${referencePath} -> ${resolved}`);
      }
    }
  }

  assert.deepEqual(
    missing,
    [],
    `Moonshot skill deepReferences must resolve in source:\n${missing.join('\n')}`,
  );
});

test('explicit Moonshot Relay script references point at packaged support scripts', async () => {
  const runtimeInstructionFiles = [
    ...await listFiles('skills'),
    ...await listFiles('agents'),
    ...await listFiles(path.join('package', 'profile-templates')),
  ].filter((file) => /\.(md|sh)$/.test(file));
  const explicitScriptRef = /<MOONSHOT_RELAY_HOME>\/(scripts\/[^`"'\s)|*]+)/g;
  const missing = [];

  for (const file of runtimeInstructionFiles) {
    const content = await readFile(fromRoot(file), 'utf8');
    for (const match of content.matchAll(explicitScriptRef)) {
      const sourcePath = match[1];
      if (!existsSync(fromRoot(sourcePath))) {
        missing.push(`${file}: ${sourcePath}`);
      }
    }
  }

  assert.deepEqual(
    missing,
    [],
    `Explicit Moonshot Relay script references must exist in canonical scripts/:\n${missing.join('\n')}`,
  );
});

test('root runtime profiles are local-only and not tracked source', () => {
  const tracked = gitLsFiles(root, ['.claude', '.codex', '.qwen']).stdout.trim();

  assert.equal(tracked, '', 'root .claude/, .codex/, and .qwen/ must remain local-only and untracked');
});
