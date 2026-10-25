import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { after, test } from 'node:test';

const root = process.cwd();
const fromRoot = (...segments) => path.join(root, ...segments);
const tempRoots = [];
const allocatedFixturePorts = new Set();

after(async () => {
  for (const tempRoot of tempRoots) {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

const makeTempRoot = async (prefix) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(tempRoot);
  return tempRoot;
};

const getFreePort = async () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    server.close(() => resolve(port));
  });
});

const getUniqueFixturePort = async () => {
  let port = await getFreePort();
  while (allocatedFixturePorts.has(port)) port = await getFreePort();
  allocatedFixturePorts.add(port);
  return port;
};

const createFakeBrowserctl = async (dir) => {
  const fakeBrowserctl = path.join(dir, process.platform === 'win32' ? 'browserctl.cmd' : 'browserctl');
  const script = process.platform === 'win32'
    ? '@echo off\r\necho healthy\r\nexit /b 0\r\n'
    : '#!/usr/bin/env sh\necho healthy\nexit 0\n';
  await writeFile(fakeBrowserctl, script);
  await chmod(fakeBrowserctl, 0o755);
  return fakeBrowserctl;
};

const sourceCheckoutMoonshotRelayState = () => {
  const result = spawnSync('git', ['status', '--porcelain=v1', '--untracked-files=all', '--', '.moonshot-relay'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return {
    exists: existsSync(fromRoot('.moonshot-relay')),
    status: result.stdout,
  };
};

// All browser invocations cross this boundary. It owns the absolute runner,
// temp-root cwd, verdict/artifact root, unique fixture port, and the invariant
// that the source checkout's generated-state boundary is unchanged.
const runIsolatedBrowserFlow = async ({ tempRoot = null, args = [], port = null } = {}) => {
  const fixtureRoot = tempRoot || await makeTempRoot('moonshot-relay-browser-isolated-');
  const fixturePort = port || await getUniqueFixturePort();
  const runner = fromRoot('scripts', 'browser-flow-runner.mjs');
  const verdictDir = path.join(fixtureRoot, '.moonshot-relay');
  const artifactRoot = path.join(verdictDir, 'browser-artifacts');
  await mkdir(artifactRoot, { recursive: true });
  assert.ok(path.isAbsolute(runner));
  assert.ok(args.includes('--browserctl'), 'isolated browser flows require an explicit browserctl');

  const before = sourceCheckoutMoonshotRelayState();
  const result = spawnSync(process.execPath, [runner, ...args], {
    cwd: fixtureRoot,
    encoding: 'utf8',
  });
  const after = sourceCheckoutMoonshotRelayState();
  assert.deepEqual(after, before, 'browser flow must not mutate source checkout .moonshot-relay');

  return { result, tempRoot: fixtureRoot, runner, port: fixturePort, verdictDir, artifactRoot };
};

const readRoot = async (...segments) => readFile(fromRoot(...segments), 'utf8');

test('execution templates expose spec-test obligation contract fields', async () => {
  const templateFiles = [
    ['templates', 'execution', 'SPRINT_CONTRACT.template.md'],
    ['templates', 'execution', 'QA_REPORT.template.md'],
    ['templates', 'execution', 'REQUIREMENTS_TRACEABILITY.template.md'],
    ['templates', 'execution', 'SCENARIO_MATRIX.template.md'],
    ['templates', 'execution', 'SCORECARD.template.md'],
    ['templates', 'product-definition', 'task.template.md'],
  ];
  const combined = (await Promise.all(templateFiles.map((file) => readRoot(...file)))).join('\n');

  assert.match(combined, /Spec-Test Obligations/);
  for (const field of [
    'specTestObligations',
    'verificationMode',
    'tdd_red_green',
    'characterization_first',
    'evidence_mandatory',
    'not_applicable',
    'interface',
    'depth',
    'environment',
    'redCommand',
    'greenCommand',
    'evidencePath',
    'bypassReason',
  ]) {
    assert.match(combined, new RegExp(field));
  }
  for (const failureClass of [
    'spec_test_obligation_result_missing',
    'spec_test_obligation_missing',
    'tdd_red_evidence_missing',
    'tdd_green_evidence_missing',
    'required_spec_test_not_run',
    'critical_scenario_smoke_only',
    'duplicate_spec_test_obligation',
  ]) {
    assert.match(combined, new RegExp(failureClass));
  }
});

const parseYamlStringValue = (content, key) => {
  const match = new RegExp(`${key}:\\s*"([^"]+)"`).exec(content);
  return match ? match[1] : '';
};

const profileGuidelinesRoots = new Map([
  ['AGENTS.md', 'docs/public/guidelines'],
  ['package/profile-templates/claude/.claude/CLAUDE.md', '${MOONSHOT_RELAY_HOME:-~/.moonshot-relay}/docs/public/guidelines'],
  ['package/profile-templates/codex/.codex/AGENTS.md', '${MOONSHOT_RELAY_HOME:-~/.moonshot-relay}/docs/public/guidelines'],
  ['package/profile-templates/qwen/.qwen/QWEN.md', '${MOONSHOT_RELAY_HOME:-~/.moonshot-relay}/docs/public/guidelines'],
  ['package/profile-templates/claude/.claude/PROJECT.md', '${MOONSHOT_RELAY_HOME:-~/.moonshot-relay}/docs/public/guidelines'],
]);

test('root AGENTS is a source-checkout TOC, not a profile-local pointer', async () => {
  const content = await readRoot('AGENTS.md');

  assert.notEqual(content.trim(), '.claude/CLAUDE.md');
  assert.match(content, /Canonical Source/i);
  assert.match(content, /skills\//);
  assert.match(content, /docs\/public/);
  assert.match(content, /Local runtime profiles: root `\.claude\/`, `\.codex\/`, and `\.qwen\/`/i);
});

test('profile document paths use one active task root and public guideline root', async () => {
  const files = [
    'AGENTS.md',
    'package/profile-templates/claude/.claude/CLAUDE.md',
    'package/profile-templates/qwen/.qwen/QWEN.md',
    'package/profile-templates/claude/.claude/PROJECT.md',
  ];

  for (const file of files) {
    const content = await readRoot(file);
    assert.equal(parseYamlStringValue(content, 'tasksRoot'), '.moonshot-relay/docs/tasks', `${file} tasksRoot`);
    assert.equal(parseYamlStringValue(content, 'agreementsRoot'), '.moonshot-relay/docs/agreements', `${file} agreementsRoot`);
    assert.doesNotMatch(content, /tasksRoot:\s*"docs\/claude-tasks"/);
    if (content.includes('guidelinesRoot:')) {
      assert.equal(parseYamlStringValue(content, 'guidelinesRoot'), profileGuidelinesRoots.get(file), `${file} guidelinesRoot`);
    }
  }

  const codex = await readRoot('package/profile-templates/codex/.codex/AGENTS.md');
  assert.doesNotMatch(codex, /tasksRoot:|agreementsRoot:|guidelinesRoot:/);
});

test('service profile TOCs carry current boundary metadata', async () => {
  const files = new Map([
    ['package/profile-templates/claude/.claude/CLAUDE.md', '2026-06-06'],
    ['package/profile-templates/codex/.codex/AGENTS.md', '2026-10-25'],
    ['package/profile-templates/qwen/.qwen/QWEN.md', '2026-06-06'],
  ]);

  for (const [file, reviewDate] of files) {
    const content = await readRoot(file);
    assert.match(content, new RegExp(`Last-Reviewed: ${reviewDate}`), `${file} review date`);
    assert.doesNotMatch(content, /Last-Reviewed: 2026-04-09/, `${file} stale review date`);
    assert.match(content, /runtime profile, not canonical source/i, `${file} boundary wording`);
    assert.doesNotMatch(content, /development profile, not canonical source/i, `${file} stale boundary wording`);
  }
});

test('installed profile TOCs keep knowledge discovery aligned with their runtime authority', async () => {
  for (const file of [
    'AGENTS.md',
    'package/profile-templates/claude/.claude/CLAUDE.md',
    'package/profile-templates/qwen/.qwen/QWEN.md',
  ]) {
    const content = await readRoot(file);
    assert.match(content, /Project-Local Knowledge Anchors/, `${file} anchor section`);
    assert.match(content, /knowledgeAnchors/, `${file} anchor key`);
    assert.match(content, /moonshot-architecture/, `${file} architecture skill setup`);
  }

  const codex = await readRoot('package/profile-templates/codex/.codex/AGENTS.md');
  assert.match(codex, /selected skill or runtime owns workflow state/i);
  assert.doesNotMatch(codex, /Project-Local Knowledge Anchors|knowledgeAnchors|moonshot-architecture/);
});

test('service profile TOCs point at their own profile entries and common home docs', async () => {
  const claude = await readRoot('package/profile-templates/claude/.claude/CLAUDE.md');
  const codex = await readRoot('package/profile-templates/codex/.codex/AGENTS.md');
  const qwen = await readRoot('package/profile-templates/qwen/.qwen/QWEN.md');

  assert.match(claude, /Runtime contract: `CLAUDE\.md` \+ `verification\.contract\.yaml`/);
  assert.match(codex, /Runtime contract: `AGENTS\.md` \+ `verification\.contract\.yaml`/);
  assert.match(qwen, /Runtime contract: `QWEN\.md` \+ `verification\.contract\.yaml`/);
  assert.match(claude, /@PROJECT\.md/);
  assert.match(claude, /@rules\/agents\/agent-definition\.md/);
  assert.match(codex, /@rules\/agents\/agent-definition\.md/);
  assert.match(qwen, /@rules\/agents\/agent-definition\.md/);
  assert.match(claude, /\$\{MOONSHOT_RELAY_HOME:-~\/\.moonshot-relay\}\/docs\/public\/guidelines\//);
  assert.match(codex, /\$\{MOONSHOT_RELAY_HOME:-~\/\.moonshot-relay\}\/docs\/public\/guidelines\//);
  assert.match(qwen, /\$\{MOONSHOT_RELAY_HOME:-~\/\.moonshot-relay\}\/docs\/public\/guidelines\//);
  assert.doesNotMatch(codex, /\.claude\//, 'Codex TOC must not point at Claude profile paths');
  assert.doesNotMatch(codex, /@docs\/public\/guidelines\//, 'Codex TOC common docs are not profile-local');
  assert.doesNotMatch(qwen, /\.claude\/|\.codex\//, 'Qwen TOC must not point at Claude or Codex profile paths');
  assert.doesNotMatch(qwen, /@docs\/public\/guidelines\//, 'Qwen TOC common docs are not profile-local');
});

test('plan readiness bridge reports ready state and planned outputs for reviewed plans', async () => {
  const tempRoot = await makeTempRoot('moonshot-relay-plan-ready-');
  const planDir = path.join(tempRoot, 'docs', 'implementation', 'sample-plan');
  const reviewRoot = path.join(planDir, 'planning-loop');
  await mkdir(reviewRoot, { recursive: true });
  await writeFile(path.join(planDir, '00-master-plan-v1.md'), '# Sample Plan\n');
  await writeFile(path.join(planDir, '01-sample-v1.md'), '# Phase 01\n');
  await writeFile(path.join(reviewRoot, 'plan-quality-review-iter-01.yaml'), 'status: pass\n');

  const result = spawnSync(process.execPath, [
    fromRoot('scripts', 'prepare-phase-runner-state.mjs'),
    '--dry-run',
    '--json',
    '--plan-dir',
    planDir,
    '--master-plan',
    path.join(planDir, '00-master-plan-v1.md'),
    '--status-file',
    path.join(tempRoot, '.moonshot-relay', 'docs', 'phase-status.yaml'),
    '--execution-root',
    path.join(planDir, 'execution'),
  ], {
    cwd: root,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.status, 'ready');
  assert.deepEqual(payload.phaseDocs, ['01-sample-v1.md']);
  assert.equal(payload.activeExecutionStatus, 'active');
  assert.equal(payload.activePhaseDoc, '01-sample-v1.md');
  assert.equal(payload.phases[0].status, 'in_progress');
  assert.equal(payload.dryRun, true);
  assert.equal(existsSync(path.join(tempRoot, '.moonshot-relay', 'docs', 'phase-status.yaml')), false);
  assert.ok(payload.plannedWrites.some((entry) => entry.endsWith('phase-status.yaml')));
  assert.ok(payload.plannedWrites.some((entry) => entry.endsWith('phase-runner-readiness.json')));
});

test('phase runner advances active phase after phase-local closeout evidence', async () => {
  const tempRoot = await makeTempRoot('moonshot-relay-phase-closeout-');
  const planDir = path.join(tempRoot, 'docs', 'implementation', 'sample-plan');
  const reviewRoot = path.join(planDir, 'planning-loop');
  const phaseRoot = path.join(planDir, 'execution', 'phase-01');
  await mkdir(reviewRoot, { recursive: true });
  await mkdir(phaseRoot, { recursive: true });
  await writeFile(path.join(planDir, '00-master-plan-v1.md'), '# Sample Plan\n');
  await writeFile(path.join(planDir, '01-first-v1.md'), [
    '# Phase 01',
    '',
    '## Phase 01 Closeout',
    '',
    'Status: complete',
    '',
  ].join('\n'));
  await writeFile(path.join(planDir, '02-second-v1.md'), '# Phase 02\n');
  await writeFile(path.join(reviewRoot, 'plan-quality-review-iter-01.yaml'), 'status: pass\n');
  await writeFile(path.join(phaseRoot, 'SCORECARD.md'), 'Status: pass\n');
  await writeFile(path.join(phaseRoot, 'QA_REPORT.md'), 'Status: pass\n');
  await writeFile(path.join(phaseRoot, 'HANDOFF.md'), 'Status: ready for Phase 02\n');

  const result = spawnSync(process.execPath, [
    fromRoot('scripts', 'prepare-phase-runner-state.mjs'),
    '--dry-run',
    '--json',
    '--plan-dir',
    planDir,
    '--master-plan',
    path.join(planDir, '00-master-plan-v1.md'),
    '--status-file',
    path.join(tempRoot, '.moonshot-relay', 'docs', 'phase-status.yaml'),
    '--execution-root',
    path.join(planDir, 'execution'),
  ], {
    cwd: root,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.status, 'ready');
  assert.equal(payload.activeExecutionStatus, 'active');
  assert.equal(payload.activePhaseDoc, '02-second-v1.md');
  assert.equal(payload.phases[0].status, 'complete');
  assert.equal(payload.phases[0].attempts.lastOutcome, 'phase-local-closeout-pass');
  assert.equal(payload.phases[1].status, 'in_progress');
});

test('phase runner excludes optional backlog phases from active cursor unless explicitly pulled', async () => {
  const tempRoot = await makeTempRoot('moonshot-relay-optional-backlog-');
  const planDir = path.join(tempRoot, 'docs', 'implementation', 'sample-plan');
  const reviewRoot = path.join(planDir, 'planning-loop');
  const phaseRoot = path.join(planDir, 'execution', 'phase-01');
  await mkdir(reviewRoot, { recursive: true });
  await mkdir(phaseRoot, { recursive: true });
  await writeFile(path.join(planDir, '00-master-plan-v1.md'), [
    '# Sample Plan',
    '',
    '| Phase | Title | Plan File | Depends On | Execution Readiness |',
    '|---|---|---|---|---|',
    '| 01 | Required | `01-required-v1.md` | - | ready |',
    '| 02 | Optional Canvas | `02-optional-canvas-v1.md` | 01 | backlog unless explicitly pulled into scope |',
    '',
  ].join('\n'));
  await writeFile(path.join(planDir, '01-required-v1.md'), [
    '# Phase 01',
    '',
    '## Phase 01 Closeout',
    '',
    'Status: complete',
    '',
  ].join('\n'));
  await writeFile(path.join(planDir, '02-optional-canvas-v1.md'), '# Phase 02 - Optional Canvas v1\n');
  await writeFile(path.join(reviewRoot, 'plan-quality-review-iter-01.yaml'), 'status: pass\n');
  await writeFile(path.join(phaseRoot, 'SCORECARD.md'), 'Status: pass\n');
  await writeFile(path.join(phaseRoot, 'QA_REPORT.md'), 'Status: pass\n');
  await writeFile(path.join(phaseRoot, 'HANDOFF.md'), 'Status: ready\n');

  const result = spawnSync(process.execPath, [
    fromRoot('scripts', 'prepare-phase-runner-state.mjs'),
    '--dry-run',
    '--json',
    '--plan-dir',
    planDir,
    '--master-plan',
    path.join(planDir, '00-master-plan-v1.md'),
    '--status-file',
    path.join(tempRoot, '.moonshot-relay', 'docs', 'phase-status.yaml'),
    '--execution-root',
    path.join(planDir, 'execution'),
  ], {
    cwd: root,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.activeExecutionStatus, 'all_phases_projected_complete');
  assert.equal(payload.activePhaseDoc, '');
  assert.equal(payload.phases[0].status, 'complete');
  assert.equal(payload.phases[1].status, 'optional_backlog');
});

test('tracked source roadmaps default execution scratch to account-root project execution', () => {
  const result = spawnSync(process.execPath, [
    fromRoot('scripts', 'prepare-phase-runner-state.mjs'),
    '--dry-run',
    '--json',
    '--plan-dir',
    'docs/public/roadmaps/harness-control-plane-modernization',
    '--master-plan',
    'docs/public/roadmaps/harness-control-plane-modernization/00-master-plan-v1.md',
  ], {
    cwd: root,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.planRootKind, 'source_roadmap');
  assert.equal(payload.planGraphStatus.status, 'markdown_sequential');
  assert.equal(payload.planGraphStatus.parallelAllowed, false);
  assert.equal(payload.executionPackageRecommendation.status, 'recommended');
  assert.match(payload.executionPackageRecommendation.reason, /source roadmaps/i);
  assert.equal(payload.runtimeBridgeStatus.status, 'not_applicable');
  assert.ok(
    payload.plannedWrites.some((entry) => (
      /\.moonshot-relay\/state\/projects\/munlucky-moonshot-relay\/execution\/worktrees\/wt-[a-f0-9]+\/branches\/[^/]+\/plans\/harness-control-plane-modernization\/runs\/phase-runner-\d{14}-[0-9a-f-]+\/execution\/phase-runner-readiness\.json$/.test(entry)
    )),
    payload.plannedWrites.join('\n'),
  );
  assert.equal(payload.plannedWrites.some((entry) => entry.startsWith('docs/public/roadmaps/') && entry.includes('/execution/')), false);
  assert.equal(payload.plannedWrites.some((entry) => entry.startsWith('docs/implementation/') && entry.includes('/execution/')), false);
});

test('phase runner blocks parallel markdown-only plans without graph metadata', async () => {
  const tempRoot = await makeTempRoot('moonshot-relay-parallel-no-graph-');
  const planDir = path.join(tempRoot, 'docs', 'implementation', 'sample-plan');
  await mkdir(path.join(planDir, 'planning-loop'), { recursive: true });
  await writeFile(path.join(planDir, '00-master-plan-v1.md'), '# Sample Plan\n');
  await writeFile(path.join(planDir, '01-sample-v1.md'), '# Phase 01\n');
  await writeFile(path.join(planDir, 'planning-loop', 'plan-quality-review-iter-01.yaml'), 'status: pass\n');

  const result = spawnSync(process.execPath, [
    fromRoot('scripts', 'prepare-phase-runner-state.mjs'),
    '--dry-run',
    '--json',
    '--allow-parallel',
    '--plan-dir',
    planDir,
    '--master-plan',
    path.join(planDir, '00-master-plan-v1.md'),
  ], {
    cwd: root,
    encoding: 'utf8',
  });

  assert.equal(result.status, 2, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.status, 'blocked');
  assert.equal(payload.planGraphStatus.status, 'markdown_sequential');
  assert.equal(payload.planGraphStatus.parallelAllowed, false);
  assert.ok(payload.errors.some((error) => /validated plan graph/i.test(error)), payload.errors.join('\n'));
});

test('phase runner validates explicit plan graph metadata before dispatch', async () => {
  const tempRoot = await makeTempRoot('moonshot-relay-plan-graph-ready-');
  const planDir = path.join(tempRoot, 'docs', 'implementation', 'sample-plan');
  await mkdir(path.join(planDir, 'planning-loop'), { recursive: true });
  await writeFile(path.join(planDir, '00-master-plan-v1.md'), '# Sample Plan\n');
  await writeFile(path.join(planDir, '01-sample-v1.md'), '# Phase 01\n');
  await writeFile(path.join(planDir, '02-sample-v1.md'), '# Phase 02\n');
  await writeFile(path.join(planDir, 'planning-loop', 'plan-quality-review-iter-01.yaml'), 'status: pass\n');
  await writeFile(path.join(planDir, 'plan-graph.json'), JSON.stringify({
    schemaVersion: 1,
    planId: 'sample-plan',
    phases: [
      { id: 'phase-01', doc: '01-sample-v1.md', ownedPaths: ['scripts/a.mjs'] },
      { id: 'phase-02', doc: '02-sample-v1.md', dependsOn: ['phase-01'], parallelGroup: 'later', ownedPaths: ['scripts/b.mjs'] },
    ],
  }, null, 2));

  const result = spawnSync(process.execPath, [
    fromRoot('scripts', 'prepare-phase-runner-state.mjs'),
    '--dry-run',
    '--json',
    '--allow-parallel',
    '--plan-dir',
    planDir,
    '--master-plan',
    path.join(planDir, '00-master-plan-v1.md'),
  ], {
    cwd: root,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.status, 'ready');
  assert.equal(payload.planGraphStatus.status, 'validated_graph');
  assert.equal(payload.planGraphStatus.parallelAllowed, true);
});

test('phase runner blocks graph metadata that does not cover discovered phase docs', async () => {
  const tempRoot = await makeTempRoot('moonshot-relay-plan-graph-mismatch-');
  const planDir = path.join(tempRoot, 'docs', 'implementation', 'sample-plan');
  await mkdir(path.join(planDir, 'planning-loop'), { recursive: true });
  await writeFile(path.join(planDir, '00-master-plan-v1.md'), '# Sample Plan\n');
  await writeFile(path.join(planDir, '01-sample-v1.md'), '# Phase 01\n');
  await writeFile(path.join(planDir, '02-sample-v1.md'), '# Phase 02\n');
  await writeFile(path.join(planDir, 'planning-loop', 'plan-quality-review-iter-01.yaml'), 'status: pass\n');
  await writeFile(path.join(planDir, 'plan-graph.json'), JSON.stringify({
    schemaVersion: 1,
    planId: 'sample-plan',
    phases: [
      { id: 'phase-01', doc: '01-sample-v1.md', ownedPaths: ['scripts/a.mjs'] },
    ],
  }, null, 2));

  const result = spawnSync(process.execPath, [
    fromRoot('scripts', 'prepare-phase-runner-state.mjs'),
    '--dry-run',
    '--json',
    '--allow-parallel',
    '--plan-dir',
    planDir,
    '--master-plan',
    path.join(planDir, '00-master-plan-v1.md'),
  ], {
    cwd: root,
    encoding: 'utf8',
  });

  assert.equal(result.status, 2, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.status, 'blocked');
  assert.equal(payload.planGraphStatus.status, 'blocked_graph');
  assert.equal(payload.planGraphStatus.parallelAllowed, false);
  assert.ok(payload.planGraphStatus.findings.some((finding) => finding.type === 'missing_graph_phase_doc'));
});

test('project runtime bridge accepts account-root plan packages for temp smoke without gitignore exception', async () => {
  const tempRoot = await makeTempRoot('moonshot-relay-bridge-account-package-');
  const planRoot = path.join(tempRoot, 'account-root', 'state', 'projects', 'demo', 'planning', 'packages', 'sample-plan');
  const targetRoot = path.join(tempRoot, 'target-project');
  await mkdir(planRoot, { recursive: true });
  await mkdir(targetRoot, { recursive: true });

  const result = spawnSync(process.execPath, [
    fromRoot('scripts', 'install-project-runtime-bridge.mjs'),
    '--target',
    targetRoot,
    '--plan-package',
    planRoot,
    '--json',
  ], {
    cwd: root,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.deepEqual(payload.written.sort(), [
    '.moonshot-relay/.gitignore',
    'scripts/knowledge-context-build.mjs',
    'scripts/prepare-phase-runner-state.mjs',
    'scripts/runtime-state.mjs',
    'tools/sandbox/policy.mjs',
    'verification.contract.yaml',
  ]);
  const gitignore = await readFile(path.join(targetRoot, '.moonshot-relay', '.gitignore'), 'utf8');
  assert.match(gitignore, /state\//);
});

test('phase runner reports runnable bridge recovery command outside source checkout', async () => {
  const tempRoot = await makeTempRoot('moonshot-relay-downstream-bridge-status-');
  const targetRoot = path.join(tempRoot, 'target project');
  const planDir = path.join(targetRoot, 'docs', 'implementation', 'sample plan');
  await mkdir(path.join(planDir, 'planning-loop'), { recursive: true });
  await writeFile(path.join(planDir, '00-master-plan-v1.md'), '# Sample Plan\n');
  await writeFile(path.join(planDir, '01-sample-v1.md'), '# Phase 01\n');
  await writeFile(path.join(planDir, 'planning-loop', 'plan-quality-review-iter-01.yaml'), 'status: pass\n');

  const result = spawnSync(process.execPath, [
    fromRoot('scripts', 'prepare-phase-runner-state.mjs'),
    '--dry-run',
    '--json',
    '--plan-dir',
    planDir,
    '--master-plan',
    path.join(planDir, '00-master-plan-v1.md'),
    '--execution-root',
    path.join(targetRoot, '.moonshot-relay', 'execution'),
  ], {
    cwd: targetRoot,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.runtimeBridgeStatus.status, 'missing');
  assert.match(payload.runtimeBridgeStatus.recoveryCommand, /^moonshot-relay bridge --target "/);
  assert.match(payload.runtimeBridgeStatus.recoveryCommand, /target project"/);
  assert.match(payload.runtimeBridgeStatus.recoveryCommand, /--plan-package ".*sample plan"/);
  assert.equal(payload.runtimeBridgeStatus.recoveryCommand.includes('node scripts/install-project-runtime-bridge.mjs'), false);
});

test('phase runner default run ids are unique when omitted', () => {
  const runPrepare = () => {
    const result = spawnSync(process.execPath, [
      fromRoot('scripts', 'prepare-phase-runner-state.mjs'),
      '--dry-run',
      '--json',
      '--plan-dir',
      'docs/public/roadmaps/harness-control-plane-modernization',
      '--master-plan',
      'docs/public/roadmaps/harness-control-plane-modernization/00-master-plan-v2.md',
    ], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return JSON.parse(result.stdout);
  };

  const first = runPrepare();
  const second = runPrepare();
  assert.match(first.runId, /^phase-runner-\d{14}-[0-9a-f-]{8}$/);
  assert.match(second.runId, /^phase-runner-\d{14}-[0-9a-f-]{8}$/);
  assert.notEqual(first.runId, second.runId);
  assert.notDeepEqual(first.plannedWrites, second.plannedWrites);
  assert.ok(first.plannedWrites.some((entry) => entry.includes(`/runs/${first.runId}/execution/`)));
  assert.ok(second.plannedWrites.some((entry) => entry.includes(`/runs/${second.runId}/execution/`)));
});

test('phase runner plan preparation selects phase docs matching the explicit master version', () => {
  const result = spawnSync(process.execPath, [
    fromRoot('scripts', 'prepare-phase-runner-state.mjs'),
    '--dry-run',
    '--json',
    '--plan-dir',
    'docs/public/roadmaps/harness-control-plane-modernization',
    '--master-plan',
    'docs/public/roadmaps/harness-control-plane-modernization/00-master-plan-v2.md',
  ], {
    cwd: root,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.ok(payload.phaseDocs.length >= 12);
  assert.ok(payload.phaseDocs.every((file) => file.endsWith('-v2.md')), payload.phaseDocs.join('\n'));
  assert.ok(payload.phaseDocs.includes('01-current-truth-baseline-and-source-preservation-v2.md'));
  assert.equal(payload.phaseDocs.includes('01-baseline-source-truth-v1.md'), false);
  assert.equal(payload.activePhaseDoc, '01-current-truth-baseline-and-source-preservation-v2.md');
  assert.equal(payload.phases[0].status, 'in_progress');
  assert.equal(payload.phases[1].status, 'pending');
});

test('implicit phase plan resolution blocks when multiple plan packages exist', () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'moonshot-relay-ambiguous-plans-'));
  tempRoots.push(tempRoot);
  mkdirSync(path.join(tempRoot, 'docs', 'implementation', 'plan-a'), { recursive: true });
  mkdirSync(path.join(tempRoot, 'docs', 'implementation', 'plan-b'), { recursive: true });
  writeFileSync(path.join(tempRoot, 'docs', 'implementation', 'plan-a', '00-master-plan-v1.md'), '# Plan A\n');
  writeFileSync(path.join(tempRoot, 'docs', 'implementation', 'plan-b', '00-master-plan-v1.md'), '# Plan B\n');

  const result = spawnSync(process.execPath, [
    fromRoot('scripts', 'prepare-phase-runner-state.mjs'),
    '--dry-run',
    '--json',
  ], {
    cwd: tempRoot,
    encoding: 'utf8',
  });

  assert.equal(result.status, 2, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.status, 'blocked');
  assert.ok(payload.errors.some((error) => /ambiguous/i.test(error)), payload.errors.join('\n'));
});

test('closeout template satisfies the closeout schema required contract', async () => {
  const schema = JSON.parse(await readRoot('schemas', 'plan-closeout.schema.json'));
  const template = JSON.parse(await readRoot('templates', 'execution', 'PLAN_CLOSEOUT.template.json'));

  for (const key of schema.required) {
    assert.ok(Object.hasOwn(template, key), `${key} should be present in closeout template`);
  }
  assert.equal(template.schemaVersion, 1);
  assert.ok(schema.properties.status.enum.includes(template.status));
  assert.deepEqual(Object.keys(template.verification).sort(), ['commands', 'notes', 'verdictFiles']);
  assert.ok(schema.properties.installSync.properties.status.enum.includes(template.installSync.status));
});

test('browser flow runner writes generated-state verdicts and supports smoke health checks', async () => {
  const tempRoot = await makeTempRoot('moonshot-relay-browser-flow-');
  const fakeBrowserctl = await createFakeBrowserctl(tempRoot);

  const { result } = await runIsolatedBrowserFlow({ tempRoot, args: [
    '--flow',
    'smoke',
    '--url',
    'data:text/html,ok',
    '--browserctl',
    fakeBrowserctl,
    '--run-id',
    'contract',
    '--verdict-dir',
    path.join(tempRoot, '.moonshot-relay'),
  ] });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout.trim(), /\.moonshot-relay\/browser-flow-verdict-contract\.json$/);
  const verdict = JSON.parse(await readFile(path.join(tempRoot, '.moonshot-relay', 'browser-flow-verdict-contract.json'), 'utf8'));
  assert.equal(verdict.status, 'passed');
  assert.equal(verdict.setupGap, false);
  assert.equal(verdict.flow, 'smoke');
});

test('isolated browser fixture stress keeps roots and artifacts disjoint', async () => {
  const requested = Number(process.env.MOON_RELAY_BROWSER_ISOLATION_STRESS || 1);
  const iterations = Number.isInteger(requested) && requested > 0 ? requested : 1;
  assert.ok(iterations <= 20, 'stress evidence is bounded at 20 iterations');

  const fixtures = [];
  for (let index = 0; index < iterations; index += 1) {
    const tempRoot = await makeTempRoot(`moonshot-relay-browser-stress-${index}-`);
    const fakeBrowserctl = await createFakeBrowserctl(tempRoot);
    const port = await getUniqueFixturePort();
    const fixture = await runIsolatedBrowserFlow({
      tempRoot,
      port,
      args: [
        '--flow',
        'smoke',
        '--url',
        `http://127.0.0.1:${port}/health`,
        '--browserctl',
        fakeBrowserctl,
        '--run-id',
        `stress-${index}`,
        '--verdict-dir',
        path.join(tempRoot, '.moonshot-relay'),
      ],
    });
    const verdict = JSON.parse(await readFile(path.join(fixture.verdictDir, `browser-flow-verdict-stress-${index}.json`), 'utf8'));
    assert.equal(verdict.status, 'passed');
    assert.equal(path.dirname(fixture.artifactRoot), path.join(tempRoot, '.moonshot-relay'));
    fixtures.push(fixture);
  }

  assert.equal(new Set(fixtures.map((fixture) => fixture.tempRoot)).size, iterations);
  assert.equal(new Set(fixtures.map((fixture) => fixture.artifactRoot)).size, iterations);
  assert.equal(new Set(fixtures.map((fixture) => fixture.port)).size, iterations);
});

test('browser flow runner executes configured preview lifecycle and records cleanup evidence', async () => {
  const tempRoot = await makeTempRoot('moonshot-relay-browser-preview-');
  const port = await getFreePort();
  const mockPort = await getFreePort();
  const fakeBrowserctl = await createFakeBrowserctl(tempRoot);
  const cleanupMarker = path.join(tempRoot, 'cleanup-marker.txt');
  const configPath = path.join(tempRoot, 'browser-flow-config.json');
  const secret = 'do-not-copy-secret';
  await writeFile(configPath, JSON.stringify({
    timeoutMs: 5000,
    staticCommands: [
      { command: process.execPath, args: ['-e', `console.log("static ok ${secret}")`] },
    ],
    buildCommand: { command: process.execPath, args: ['-e', `console.log("build ok ${secret}")`] },
    fixtureSeedCommand: { command: process.execPath, args: [fromRoot('tests', 'fixtures', 'browser-completion', 'seed-ok.mjs')] },
    mockApiCommand: {
      command: process.execPath,
      args: [fromRoot('tests', 'fixtures', 'browser-completion', 'mock-api.mjs'), '--port', String(mockPort)],
      env: { BROWSER_COMPLETION_SECRET: secret },
    },
    previewCommand: {
      command: process.execPath,
      args: [fromRoot('tests', 'fixtures', 'browser-completion', 'preview-server.mjs'), '--port', String(port)],
      cwd: '.',
      env: { BROWSER_COMPLETION_SECRET: secret },
    },
    readinessUrl: `http://127.0.0.1:${port}/health`,
    cleanupCommand: {
      command: process.execPath,
      args: [fromRoot('tests', 'fixtures', 'browser-completion', 'cleanup-marker.mjs')],
      env: { BROWSER_COMPLETION_CLEANUP_MARKER: cleanupMarker, BROWSER_COMPLETION_SECRET: secret },
    },
    redactValues: [secret],
  }, null, 2));

  const result = spawnSync(process.execPath, [
    fromRoot('scripts', 'browser-flow-runner.mjs'),
    '--flow',
    'preview',
    '--config',
    configPath,
    '--browserctl',
    fakeBrowserctl,
    '--run-id',
    'preview-lifecycle',
    '--verdict-dir',
    path.join(tempRoot, '.moonshot-relay'),
    '--timeout-ms',
    '5000',
  ], {
    cwd: tempRoot,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const verdict = JSON.parse(await readFile(path.join(tempRoot, '.moonshot-relay', 'browser-flow-verdict-preview-lifecycle.json'), 'utf8'));
  const verdictText = JSON.stringify(verdict);
  assert.equal(verdict.status, 'passed');
  assert.equal(verdict.setupGap, false);
  assert.equal(verdict.failureClass, '');
  assert.equal(verdict.steps.find((step) => step.name === 'browser_backend').status, 'passed');
  assert.match(verdict.steps.find((step) => step.name === 'static_1').stdout, /static ok \[REDACTED\]/);
  assert.match(verdict.steps.find((step) => step.name === 'build').stdout, /build ok \[REDACTED\]/);
  assert.equal(verdict.steps.find((step) => step.name === 'fixture_seed').stdout.trim(), 'fixture seed ok');
  assert.equal(verdict.preview.readiness.ready, true);
  assert.match(verdict.preview.logs.stdout, /preview listening/);
  assert.match(verdict.preview.logs.stdout, /preview \[REDACTED\] \[REDACTED\]/);
  assert.match(verdict.mockApi.logs.stdout, /mock api listening/);
  assert.match(verdict.mockApi.logs.stderr, /mock api \[REDACTED\] \[REDACTED\]/);
  assert.equal(verdict.cleanup.previewProcessTerminated, true);
  assert.equal(verdict.cleanup.mockApiProcessTerminated, true);
  assert.equal(verdict.cleanup.cleanupCommand.status, 'passed');
  assert.match(verdict.cleanup.cleanupCommand.stdout, /cleanup \[REDACTED\] \[REDACTED\]/);
  assert.equal(existsSync(cleanupMarker), true);
  assert.equal(verdictText.includes(secret), false);
  assert.equal(verdictText.includes('[REDACTED]'), true);
});

test('browser flow runner executes swappable agentic confirmation adapter after preview readiness', async () => {
  const tempRoot = await makeTempRoot('moonshot-relay-browser-agentic-confirmation-');
  const port = await getFreePort();
  const fakeBrowserctl = await createFakeBrowserctl(tempRoot);
  const configPath = path.join(tempRoot, 'browser-flow-config.json');
  const screenshotPath = '.moonshot-relay/browser-artifacts/run/goal/agentic/confirmation.png';
  const snapshotPath = '.moonshot-relay/browser-artifacts/run/goal/agentic/snapshot.json';
  await writeFile(configPath, JSON.stringify({
    timeoutMs: 5000,
    fixtureSeedCommand: { command: process.execPath, args: [fromRoot('tests', 'fixtures', 'browser-completion', 'seed-ok.mjs')] },
    previewCommand: {
      command: process.execPath,
      args: [fromRoot('tests', 'fixtures', 'browser-completion', 'preview-server.mjs'), '--port', String(port)],
    },
    readinessUrl: `http://127.0.0.1:${port}/health`,
    agenticConfirmation: {
      backend: 'agent-browser',
      expectedUrl: `http://127.0.0.1:${port}/health`,
      expectedText: 'Ready',
      expectedRole: 'button',
      expectedName: 'Save',
      command: {
        command: process.execPath,
        cwd: '.',
        args: [
          fromRoot('tests', 'fixtures', 'browser-completion', 'agentic-confirmation.mjs'),
          '--url',
          `http://127.0.0.1:${port}/health`,
          '--text',
          'Ready',
          '--stdoutPrefix',
          'adapter diagnostic log',
          '--screenshot',
          screenshotPath,
          '--snapshot',
          snapshotPath,
        ],
      },
    },
  }, null, 2));

  const result = spawnSync(process.execPath, [
    fromRoot('scripts', 'browser-flow-runner.mjs'),
    '--flow',
    'preview',
    '--config',
    configPath,
    '--browserctl',
    fakeBrowserctl,
    '--run-id',
    'agentic-confirmation',
    '--verdict-dir',
    path.join(tempRoot, '.moonshot-relay'),
    '--timeout-ms',
    '5000',
  ], {
    cwd: tempRoot,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const verdict = JSON.parse(await readFile(path.join(tempRoot, '.moonshot-relay', 'browser-flow-verdict-agentic-confirmation.json'), 'utf8'));
  const confirmationStep = verdict.steps.find((step) => step.name === 'agentic_browser_confirmation');
  assert.equal(verdict.status, 'passed');
  assert.equal(confirmationStep.status, 'passed');
  assert.equal(confirmationStep.backend, 'agent-browser');
  assert.equal(verdict.agenticConfirmation.expectedText, 'Ready');
  assert.equal(verdict.agenticConfirmation.expectedRole, 'button');
  assert.equal(verdict.agenticConfirmation.expectedName, 'Save');
  assert.equal(
    verdict.agenticConfirmation.adapterExpectedText,
    'adapter supplied text',
    JSON.stringify({ confirmationStep, agenticConfirmation: verdict.agenticConfirmation }, null, 2),
  );
  assert.equal(verdict.agenticConfirmation.expectedTextFound, true);
  assert.equal(verdict.agenticConfirmation.roleNameFound, true);
  assert.equal(existsSync(path.join(tempRoot, screenshotPath)), true);
  assert.equal(existsSync(path.join(tempRoot, snapshotPath)), true);
});

test('browser flow runner preserves adapter setup-gap JSON even with zero exit code', async () => {
  const tempRoot = await makeTempRoot('moonshot-relay-browser-agentic-json-gap-');
  const port = await getFreePort();
  const fakeBrowserctl = await createFakeBrowserctl(tempRoot);
  const configPath = path.join(tempRoot, 'browser-flow-config.json');
  await writeFile(configPath, JSON.stringify({
    timeoutMs: 5000,
    fixtureSeedCommand: { command: process.execPath, args: [fromRoot('tests', 'fixtures', 'browser-completion', 'seed-ok.mjs')] },
    previewCommand: {
      command: process.execPath,
      args: [fromRoot('tests', 'fixtures', 'browser-completion', 'preview-server.mjs'), '--port', String(port)],
    },
    readinessUrl: `http://127.0.0.1:${port}/health`,
    agenticConfirmation: {
      backend: 'agent-browser',
      command: {
        command: process.execPath,
        args: ['-e', 'console.log(JSON.stringify({status:"setup_gap",failureClass:"runtime_environment_failed",backendAvailable:false}))'],
      },
    },
  }, null, 2));

  const result = spawnSync(process.execPath, [
    fromRoot('scripts', 'browser-flow-runner.mjs'),
    '--flow',
    'preview',
    '--config',
    configPath,
    '--browserctl',
    fakeBrowserctl,
    '--run-id',
    'agentic-json-gap',
    '--verdict-dir',
    path.join(tempRoot, '.moonshot-relay'),
    '--timeout-ms',
    '5000',
  ], {
    cwd: tempRoot,
    encoding: 'utf8',
  });

  assert.equal(result.status, 64, result.stderr || result.stdout);
  const verdict = JSON.parse(await readFile(path.join(tempRoot, '.moonshot-relay', 'browser-flow-verdict-agentic-json-gap.json'), 'utf8'));
  assert.equal(verdict.status, 'setup_gap');
  assert.equal(verdict.setupGap, true);
  assert.equal(verdict.failureClass, 'runtime_environment_failed');
  assert.equal(verdict.steps.find((step) => step.name === 'agentic_browser_confirmation').status, 'setup_gap');
});

test('browser flow runner treats missing agentic adapter executable as setup gap', async () => {
  const tempRoot = await makeTempRoot('moonshot-relay-browser-agentic-missing-adapter-');
  const port = await getFreePort();
  const fakeBrowserctl = await createFakeBrowserctl(tempRoot);
  const configPath = path.join(tempRoot, 'browser-flow-config.json');
  await writeFile(configPath, JSON.stringify({
    timeoutMs: 5000,
    fixtureSeedCommand: { command: process.execPath, args: [fromRoot('tests', 'fixtures', 'browser-completion', 'seed-ok.mjs')] },
    previewCommand: {
      command: process.execPath,
      args: [fromRoot('tests', 'fixtures', 'browser-completion', 'preview-server.mjs'), '--port', String(port)],
    },
    readinessUrl: `http://127.0.0.1:${port}/health`,
    agenticConfirmation: {
      backend: 'agent-browser',
      command: { command: path.join(tempRoot, 'missing-agent-browser') },
    },
  }, null, 2));

  const result = spawnSync(process.execPath, [
    fromRoot('scripts', 'browser-flow-runner.mjs'),
    '--flow',
    'preview',
    '--config',
    configPath,
    '--browserctl',
    fakeBrowserctl,
    '--run-id',
    'agentic-missing-adapter',
    '--verdict-dir',
    path.join(tempRoot, '.moonshot-relay'),
    '--timeout-ms',
    '5000',
  ], {
    cwd: tempRoot,
    encoding: 'utf8',
  });

  assert.equal(result.status, 64, result.stderr || result.stdout);
  const verdict = JSON.parse(await readFile(path.join(tempRoot, '.moonshot-relay', 'browser-flow-verdict-agentic-missing-adapter.json'), 'utf8'));
  assert.equal(verdict.status, 'setup_gap');
  assert.equal(verdict.setupGap, true);
  assert.equal(verdict.failureClass, 'missing_browser_backend');
  assert.equal(verdict.browserCompletionFailureClass, 'runtime_environment_failed');
});

test('browser flow runner redacts token-shaped adapter output in raw verdicts', async () => {
  const tempRoot = await makeTempRoot('moonshot-relay-browser-agentic-raw-redaction-');
  const port = await getFreePort();
  const fakeBrowserctl = await createFakeBrowserctl(tempRoot);
  const configPath = path.join(tempRoot, 'browser-flow-config.json');
  const rawSecret = 'sk_live_runner_raw_secret_token_123';
  await writeFile(configPath, JSON.stringify({
    timeoutMs: 5000,
    fixtureSeedCommand: { command: process.execPath, args: [fromRoot('tests', 'fixtures', 'browser-completion', 'seed-ok.mjs')] },
    previewCommand: {
      command: process.execPath,
      args: [fromRoot('tests', 'fixtures', 'browser-completion', 'preview-server.mjs'), '--port', String(port)],
    },
    readinessUrl: `http://127.0.0.1:${port}/health`,
    agenticConfirmation: {
      backend: 'agent-browser',
      command: {
        command: process.execPath,
        args: ['-e', `console.log(JSON.stringify({status:"setup_gap",failureClass:"runtime_environment_failed",stderr:"${rawSecret}"}))`],
      },
    },
  }, null, 2));

  const result = spawnSync(process.execPath, [
    fromRoot('scripts', 'browser-flow-runner.mjs'),
    '--flow',
    'preview',
    '--config',
    configPath,
    '--browserctl',
    fakeBrowserctl,
    '--run-id',
    'agentic-raw-redaction',
    '--verdict-dir',
    path.join(tempRoot, '.moonshot-relay'),
    '--timeout-ms',
    '5000',
  ], {
    cwd: tempRoot,
    encoding: 'utf8',
  });

  assert.equal(result.status, 64, result.stderr || result.stdout);
  const verdictText = await readFile(path.join(tempRoot, '.moonshot-relay', 'browser-flow-verdict-agentic-raw-redaction.json'), 'utf8');
  assert.equal(verdictText.includes(rawSecret), false);
  assert.match(verdictText, /\[REDACTED\]/);
});

test('browser flow runner rejects agentic artifacts outside browser artifact root', async () => {
  const tempRoot = await makeTempRoot('moonshot-relay-browser-agentic-artifact-boundary-');
  const port = await getFreePort();
  const fakeBrowserctl = await createFakeBrowserctl(tempRoot);
  const configPath = path.join(tempRoot, 'browser-flow-config.json');
  const outsideScreenshot = path.join(tempRoot, 'outside.png');
  await writeFile(configPath, JSON.stringify({
    timeoutMs: 5000,
    fixtureSeedCommand: { command: process.execPath, args: [fromRoot('tests', 'fixtures', 'browser-completion', 'seed-ok.mjs')] },
    previewCommand: {
      command: process.execPath,
      args: [fromRoot('tests', 'fixtures', 'browser-completion', 'preview-server.mjs'), '--port', String(port)],
    },
    readinessUrl: `http://127.0.0.1:${port}/health`,
    agenticConfirmation: {
      backend: 'agent-browser',
      command: {
        command: process.execPath,
        // Without an explicit cwd the adapter falls back to process.cwd(), so a
        // relative artifact path is written into the real checkout while the
        // boundary check evaluates it against the config dir. Pin the adapter
        // to the same base the boundary uses, or this test rewrites the
        // repository's own .moonshot-relay runtime state on every run.
        cwd: '.',
        args: [
          fromRoot('tests', 'fixtures', 'browser-completion', 'agentic-confirmation.mjs'),
          '--url',
          `http://127.0.0.1:${port}/health`,
          '--screenshot',
          outsideScreenshot,
          '--snapshot',
          '.moonshot-relay/browser-artifacts/run/goal/agentic/snapshot.json',
        ],
      },
    },
  }, null, 2));

  const result = spawnSync(process.execPath, [
    fromRoot('scripts', 'browser-flow-runner.mjs'),
    '--flow',
    'preview',
    '--config',
    configPath,
    '--browserctl',
    fakeBrowserctl,
    '--run-id',
    'agentic-artifact-boundary',
    '--verdict-dir',
    path.join(tempRoot, '.moonshot-relay'),
    '--timeout-ms',
    '5000',
  ], {
    cwd: tempRoot,
    encoding: 'utf8',
  });

  const verdict = JSON.parse(await readFile(path.join(tempRoot, '.moonshot-relay', 'browser-flow-verdict-agentic-artifact-boundary.json'), 'utf8'));
  assert.equal(result.status, 1, JSON.stringify({
    stdout: result.stdout,
    stderr: result.stderr,
    status: verdict.status,
    failureClass: verdict.failureClass,
    agenticConfirmation: verdict.agenticConfirmation,
    confirmationStep: verdict.steps.find((step) => step.name === 'agentic_browser_confirmation'),
  }, null, 2));
  assert.equal(verdict.status, 'failed');
  assert.equal(verdict.failureClass, 'artifact_missing');
  assert.equal(verdict.browserCompletionFailureClass, 'artifact_missing');
  assert.equal(verdict.blockerMapping[0].source, 'browser_completion_result');
  assert.equal(verdict.blockerMapping[0].failureClass, 'artifact_missing');
  assert.equal(verdict.blockerMapping[0].blocksCompletion, true);
  // The in-boundary artifact must land under the temp base, never in the
  // checkout that runs the suite.
  const boundarySnapshot = '.moonshot-relay/browser-artifacts/run/goal/agentic/snapshot.json';
  assert.equal(existsSync(path.join(tempRoot, boundarySnapshot)), true);
  assert.equal(existsSync(outsideScreenshot), true);
});

test('browser flow runner reports unsupported agentic confirmation backend as setup gap', async () => {
  const tempRoot = await makeTempRoot('moonshot-relay-browser-agentic-gap-');
  const port = await getFreePort();
  const fakeBrowserctl = await createFakeBrowserctl(tempRoot);
  const cleanupMarker = path.join(tempRoot, 'cleanup-marker.txt');
  const configPath = path.join(tempRoot, 'browser-flow-config.json');
  await writeFile(configPath, JSON.stringify({
    timeoutMs: 5000,
    fixtureSeedCommand: { command: process.execPath, args: [fromRoot('tests', 'fixtures', 'browser-completion', 'seed-ok.mjs')] },
    previewCommand: {
      command: process.execPath,
      args: [fromRoot('tests', 'fixtures', 'browser-completion', 'preview-server.mjs'), '--port', String(port)],
    },
    readinessUrl: `http://127.0.0.1:${port}/health`,
    cleanupCommand: {
      command: process.execPath,
      args: [fromRoot('tests', 'fixtures', 'browser-completion', 'cleanup-marker.mjs')],
      env: { BROWSER_COMPLETION_CLEANUP_MARKER: cleanupMarker },
    },
    agenticConfirmation: {
      backend: 'unsupported-browser',
      command: { command: process.execPath, args: ['-e', 'console.log("{}")'] },
    },
  }, null, 2));

  const result = spawnSync(process.execPath, [
    fromRoot('scripts', 'browser-flow-runner.mjs'),
    '--flow',
    'preview',
    '--config',
    configPath,
    '--browserctl',
    fakeBrowserctl,
    '--run-id',
    'agentic-unsupported',
    '--verdict-dir',
    path.join(tempRoot, '.moonshot-relay'),
    '--timeout-ms',
    '5000',
  ], {
    cwd: tempRoot,
    encoding: 'utf8',
  });

  assert.equal(result.status, 64, result.stderr || result.stdout);
  const verdict = JSON.parse(await readFile(path.join(tempRoot, '.moonshot-relay', 'browser-flow-verdict-agentic-unsupported.json'), 'utf8'));
  assert.equal(verdict.status, 'setup_gap');
  assert.equal(verdict.setupGap, true);
  assert.equal(verdict.failureClass, 'unsupported_browser_backend');
  assert.equal(verdict.browserCompletionFailureClass, 'setup_gap');
  assert.equal(verdict.steps.find((step) => step.name === 'agentic_browser_confirmation').status, 'setup_gap');
  assert.equal(verdict.cleanup.previewProcessTerminated, true);
  assert.equal(verdict.cleanup.cleanupCommand.status, 'passed');
  assert.equal(existsSync(cleanupMarker), true);
});

test('browser flow runner reports missing preview command as setup gap and still runs cleanup', async () => {
  const tempRoot = await makeTempRoot('moonshot-relay-browser-preview-missing-');
  const fakeBrowserctl = await createFakeBrowserctl(tempRoot);
  const cleanupMarker = path.join(tempRoot, 'cleanup-marker.txt');
  const configPath = path.join(tempRoot, 'browser-flow-config.json');
  await writeFile(configPath, JSON.stringify({
    timeoutMs: 1000,
    fixtureSeedCommand: { command: process.execPath, args: [fromRoot('tests', 'fixtures', 'browser-completion', 'seed-ok.mjs')] },
    readinessUrl: 'http://127.0.0.1:9/health',
    cleanupCommand: {
      command: process.execPath,
      args: [fromRoot('tests', 'fixtures', 'browser-completion', 'cleanup-marker.mjs')],
      env: { BROWSER_COMPLETION_CLEANUP_MARKER: cleanupMarker },
    },
  }, null, 2));

  const result = spawnSync(process.execPath, [
    fromRoot('scripts', 'browser-flow-runner.mjs'),
    '--flow',
    'preview',
    '--config',
    configPath,
    '--browserctl',
    fakeBrowserctl,
    '--run-id',
    'missing-preview',
    '--verdict-dir',
    path.join(tempRoot, '.moonshot-relay'),
    '--timeout-ms',
    '1000',
  ], {
    cwd: tempRoot,
    encoding: 'utf8',
  });

  assert.equal(result.status, 64, result.stderr || result.stdout);
  const verdict = JSON.parse(await readFile(path.join(tempRoot, '.moonshot-relay', 'browser-flow-verdict-missing-preview.json'), 'utf8'));
  assert.equal(verdict.status, 'setup_gap');
  assert.equal(verdict.failureClass, 'missing_preview_command');
  assert.equal(verdict.cleanup.cleanupCommand.status, 'passed');
  assert.equal(existsSync(cleanupMarker), true);
});

test('browser flow runner reports readiness timeout as setup gap and cleans up preview process', async () => {
  const tempRoot = await makeTempRoot('moonshot-relay-browser-readiness-timeout-');
  const port = await getFreePort();
  const readinessPort = await getFreePort();
  const fakeBrowserctl = await createFakeBrowserctl(tempRoot);
  const cleanupMarker = path.join(tempRoot, 'cleanup-marker.txt');
  const configPath = path.join(tempRoot, 'browser-flow-config.json');
  await writeFile(configPath, JSON.stringify({
    timeoutMs: 800,
    fixtureSeedCommand: { command: process.execPath, args: [fromRoot('tests', 'fixtures', 'browser-completion', 'seed-ok.mjs')] },
    previewCommand: {
      command: process.execPath,
      args: [fromRoot('tests', 'fixtures', 'browser-completion', 'preview-server.mjs'), '--port', String(port)],
    },
    readinessUrl: `http://127.0.0.1:${readinessPort}/health`,
    cleanupCommand: {
      command: process.execPath,
      args: [fromRoot('tests', 'fixtures', 'browser-completion', 'cleanup-marker.mjs')],
      env: { BROWSER_COMPLETION_CLEANUP_MARKER: cleanupMarker },
    },
  }, null, 2));

  const result = spawnSync(process.execPath, [
    fromRoot('scripts', 'browser-flow-runner.mjs'),
    '--flow',
    'preview',
    '--config',
    configPath,
    '--browserctl',
    fakeBrowserctl,
    '--run-id',
    'readiness-timeout',
    '--verdict-dir',
    path.join(tempRoot, '.moonshot-relay'),
    '--timeout-ms',
    '800',
  ], {
    cwd: tempRoot,
    encoding: 'utf8',
  });

  assert.equal(result.status, 64, result.stderr || result.stdout);
  const verdict = JSON.parse(await readFile(path.join(tempRoot, '.moonshot-relay', 'browser-flow-verdict-readiness-timeout.json'), 'utf8'));
  assert.equal(verdict.status, 'setup_gap');
  assert.equal(verdict.failureClass, 'readiness_timeout');
  assert.equal(verdict.browserCompletionFailureClass, 'preview_start_failed');
  assert.equal(verdict.cleanup.previewProcessTerminated, true);
  assert.equal(verdict.cleanup.cleanupCommand.status, 'passed');
  assert.equal(existsSync(cleanupMarker), true);
});

test('browser flow runner downgrades successful preview when cleanup command fails', async () => {
  const tempRoot = await makeTempRoot('moonshot-relay-browser-cleanup-failure-');
  const port = await getFreePort();
  const fakeBrowserctl = await createFakeBrowserctl(tempRoot);
  const configPath = path.join(tempRoot, 'browser-flow-config.json');
  await writeFile(configPath, JSON.stringify({
    timeoutMs: 5000,
    fixtureSeedCommand: { command: process.execPath, args: [fromRoot('tests', 'fixtures', 'browser-completion', 'seed-ok.mjs')] },
    previewCommand: {
      command: process.execPath,
      args: [fromRoot('tests', 'fixtures', 'browser-completion', 'preview-server.mjs'), '--port', String(port)],
    },
    readinessUrl: `http://127.0.0.1:${port}/health`,
    cleanupCommand: {
      command: process.execPath,
      args: [fromRoot('tests', 'fixtures', 'browser-completion', 'cleanup-fail.mjs')],
    },
  }, null, 2));

  const result = spawnSync(process.execPath, [
    fromRoot('scripts', 'browser-flow-runner.mjs'),
    '--flow',
    'preview',
    '--config',
    configPath,
    '--browserctl',
    fakeBrowserctl,
    '--run-id',
    'cleanup-failure',
    '--verdict-dir',
    path.join(tempRoot, '.moonshot-relay'),
    '--timeout-ms',
    '5000',
  ], {
    cwd: tempRoot,
    encoding: 'utf8',
  });

  assert.equal(result.status, 64, result.stderr || result.stdout);
  const verdict = JSON.parse(await readFile(path.join(tempRoot, '.moonshot-relay', 'browser-flow-verdict-cleanup-failure.json'), 'utf8'));
  assert.equal(verdict.status, 'setup_gap');
  assert.equal(verdict.failureClass, 'cleanup_failed');
  assert.equal(verdict.browserCompletionFailureClass, 'runtime_environment_failed');
  assert.equal(verdict.cleanup.previewProcessTerminated, true);
  assert.equal(verdict.cleanup.cleanupCommand.status, 'failed');
});

test('browser flow runner downgrades successful preview when leak check fails', async () => {
  const tempRoot = await makeTempRoot('moonshot-relay-browser-leak-check-');
  const port = await getFreePort();
  const fakeBrowserctl = await createFakeBrowserctl(tempRoot);
  const configPath = path.join(tempRoot, 'browser-flow-config.json');
  await writeFile(configPath, JSON.stringify({
    timeoutMs: 5000,
    fixtureSeedCommand: { command: process.execPath, args: [fromRoot('tests', 'fixtures', 'browser-completion', 'seed-ok.mjs')] },
    previewCommand: {
      command: process.execPath,
      args: [fromRoot('tests', 'fixtures', 'browser-completion', 'preview-server.mjs'), '--port', String(port)],
    },
    readinessUrl: `http://127.0.0.1:${port}/health`,
    leakCheckCommand: {
      command: process.execPath,
      args: ['-e', 'console.error("preview leak detected"); process.exit(22)'],
    },
  }, null, 2));

  const result = spawnSync(process.execPath, [
    fromRoot('scripts', 'browser-flow-runner.mjs'),
    '--flow',
    'preview',
    '--config',
    configPath,
    '--browserctl',
    fakeBrowserctl,
    '--run-id',
    'leak-check-failure',
    '--verdict-dir',
    path.join(tempRoot, '.moonshot-relay'),
    '--timeout-ms',
    '5000',
  ], {
    cwd: tempRoot,
    encoding: 'utf8',
  });

  assert.equal(result.status, 64, result.stderr || result.stdout);
  const verdict = JSON.parse(await readFile(path.join(tempRoot, '.moonshot-relay', 'browser-flow-verdict-leak-check-failure.json'), 'utf8'));
  assert.equal(verdict.status, 'setup_gap');
  assert.equal(verdict.failureClass, 'preview_process_leak');
  assert.equal(verdict.browserCompletionFailureClass, 'runtime_environment_failed');
  assert.equal(verdict.cleanup.previewProcessTerminated, true);
  assert.equal(verdict.cleanup.leakCheckCommand.status, 'failed');
});

test('browser flow runner separates fixture seed failure and missing browser backend setup gaps', async () => {
  const tempRoot = await makeTempRoot('moonshot-relay-browser-fixture-gap-');
  const fakeBrowserctl = await createFakeBrowserctl(tempRoot);
  const cleanupMarker = path.join(tempRoot, 'cleanup-marker.txt');
  const configPath = path.join(tempRoot, 'browser-flow-config.json');
  await writeFile(configPath, JSON.stringify({
    timeoutMs: 1000,
    fixtureSeedCommand: { command: process.execPath, args: [fromRoot('tests', 'fixtures', 'browser-completion', 'seed-fail.mjs')] },
    previewCommand: { command: process.execPath, args: [fromRoot('tests', 'fixtures', 'browser-completion', 'preview-server.mjs'), '--port', '9'] },
    readinessUrl: 'http://127.0.0.1:9/health',
    cleanupCommand: {
      command: process.execPath,
      args: [fromRoot('tests', 'fixtures', 'browser-completion', 'cleanup-marker.mjs')],
      env: { BROWSER_COMPLETION_CLEANUP_MARKER: cleanupMarker },
    },
  }, null, 2));

  const fixtureFailure = spawnSync(process.execPath, [
    fromRoot('scripts', 'browser-flow-runner.mjs'),
    '--flow',
    'preview',
    '--config',
    configPath,
    '--browserctl',
    fakeBrowserctl,
    '--run-id',
    'fixture-failure',
    '--verdict-dir',
    path.join(tempRoot, '.moonshot-relay'),
    '--timeout-ms',
    '1000',
  ], {
    cwd: tempRoot,
    encoding: 'utf8',
  });

  assert.equal(fixtureFailure.status, 64, fixtureFailure.stderr || fixtureFailure.stdout);
  const fixtureVerdict = JSON.parse(await readFile(path.join(tempRoot, '.moonshot-relay', 'browser-flow-verdict-fixture-failure.json'), 'utf8'));
  assert.equal(fixtureVerdict.status, 'setup_gap');
  assert.equal(fixtureVerdict.failureClass, 'fixture_seed_failure');
  assert.equal(fixtureVerdict.browserCompletionFailureClass, 'fixture_setup_failed');
  assert.equal(fixtureVerdict.cleanup.cleanupCommand.status, 'passed');
  await rm(cleanupMarker, { force: true });

  const missingBackend = spawnSync(process.execPath, [
    fromRoot('scripts', 'browser-flow-runner.mjs'),
    '--flow',
    'preview',
    '--config',
    configPath,
    '--browserctl',
    path.join(tempRoot, 'missing-browserctl'),
    '--run-id',
    'missing-browser-backend',
    '--verdict-dir',
    path.join(tempRoot, '.moonshot-relay'),
    '--timeout-ms',
    '1000',
  ], {
    cwd: tempRoot,
    encoding: 'utf8',
  });

  assert.equal(missingBackend.status, 64, missingBackend.stderr || missingBackend.stdout);
  const backendVerdict = JSON.parse(await readFile(path.join(tempRoot, '.moonshot-relay', 'browser-flow-verdict-missing-browser-backend.json'), 'utf8'));
  assert.equal(backendVerdict.status, 'setup_gap');
  assert.equal(backendVerdict.failureClass, 'missing_browser_backend');
  assert.equal(backendVerdict.browserCompletionFailureClass, 'runtime_environment_failed');
  assert.equal(backendVerdict.cleanup.cleanupCommand.status, 'passed');
  assert.equal(existsSync(cleanupMarker), true);
});

test('browser flow runner writes structured verdict for malformed preview command', async () => {
  const tempRoot = await makeTempRoot('moonshot-relay-browser-malformed-preview-');
  const fakeBrowserctl = await createFakeBrowserctl(tempRoot);
  const cleanupMarker = path.join(tempRoot, 'cleanup-marker.txt');
  const configPath = path.join(tempRoot, 'browser-flow-config.json');
  await writeFile(configPath, JSON.stringify({
    timeoutMs: 1000,
    previewCommand: { args: ['missing-command-field'] },
    readinessUrl: 'http://127.0.0.1:9/health',
    cleanupCommand: {
      command: process.execPath,
      args: [fromRoot('tests', 'fixtures', 'browser-completion', 'cleanup-marker.mjs')],
      env: { BROWSER_COMPLETION_CLEANUP_MARKER: cleanupMarker },
    },
  }, null, 2));

  const result = spawnSync(process.execPath, [
    fromRoot('scripts', 'browser-flow-runner.mjs'),
    '--flow',
    'preview',
    '--config',
    configPath,
    '--browserctl',
    fakeBrowserctl,
    '--run-id',
    'malformed-preview',
    '--verdict-dir',
    path.join(tempRoot, '.moonshot-relay'),
    '--timeout-ms',
    '1000',
  ], {
    cwd: tempRoot,
    encoding: 'utf8',
  });

  assert.equal(result.status, 64, result.stderr || result.stdout);
  const verdict = JSON.parse(await readFile(path.join(tempRoot, '.moonshot-relay', 'browser-flow-verdict-malformed-preview.json'), 'utf8'));
  assert.equal(verdict.status, 'setup_gap');
  assert.equal(verdict.failureClass, 'preview_start_failed');
  assert.equal(verdict.browserCompletionFailureClass, 'preview_start_failed');
  assert.equal(verdict.cleanup.cleanupCommand.status, 'passed');
  assert.equal(existsSync(cleanupMarker), true);
});

test('browser flow runner redacts config env secrets from paths urls commands and logs without explicit redactValues', async () => {
  const tempRoot = await makeTempRoot('moonshot-relay-browser-redaction-');
  const port = await getFreePort();
  const fakeBrowserctl = await createFakeBrowserctl(tempRoot);
  const secret = 'env-only-secret-token';
  const secretDir = path.join(tempRoot, `config-${secret}`);
  await mkdir(secretDir, { recursive: true });
  const configPath = path.join(secretDir, 'browser-flow-config.json');
  await writeFile(configPath, JSON.stringify({
    timeoutMs: 5000,
    staticCommands: [
      { command: process.execPath, args: ['-e', 'console.log(process.cwd())'], cwd: '.' },
    ],
    previewCommand: {
      command: process.execPath,
      args: [fromRoot('tests', 'fixtures', 'browser-completion', 'preview-server.mjs'), '--port', String(port)],
      cwd: '.',
      env: { BROWSER_COMPLETION_SECRET: secret },
    },
    readinessUrl: `http://127.0.0.1:${port}/health?token=${secret}`,
  }, null, 2));

  const result = spawnSync(process.execPath, [
    fromRoot('scripts', 'browser-flow-runner.mjs'),
    '--flow',
    'preview',
    '--config',
    configPath,
    '--browserctl',
    fakeBrowserctl,
    '--run-id',
    'env-redaction',
    '--verdict-dir',
    path.join(tempRoot, '.moonshot-relay'),
    '--timeout-ms',
    '5000',
  ], {
    cwd: tempRoot,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const verdictText = await readFile(path.join(tempRoot, '.moonshot-relay', 'browser-flow-verdict-env-redaction.json'), 'utf8');
  const verdict = JSON.parse(verdictText);
  assert.equal(verdictText.includes(secret), false);
  assert.match(verdict.configPath, /\[REDACTED\]/);
  assert.match(verdict.url, /\[REDACTED\]/);
  assert.match(verdict.steps.find((step) => step.name === 'static_1').cwd, /\[REDACTED\]/);
  assert.match(verdict.steps.find((step) => step.name === 'static_1').stdout, /\[REDACTED\]/);
  assert.match(verdict.preview.readinessUrl, /\[REDACTED\]/);
  assert.match(verdict.preview.cwd, /\[REDACTED\]/);
  assert.match(verdict.preview.logs.stdout, /\[REDACTED\]/);
});

test('browser flow runner browser completion failure class stays inside schema enum', async () => {
  const schema = JSON.parse(await readRoot('schemas', 'browser-completion-result.schema.json'));
  const allowed = new Set(schema.properties.failureClass.enum);
  const tempRoot = await makeTempRoot('moonshot-relay-browser-failure-class-');
  const fakeBrowserctl = await createFakeBrowserctl(tempRoot);
  const failingBrowserctl = path.join(tempRoot, process.platform === 'win32' ? 'browserctl-fail.cmd' : 'browserctl-fail');
  await writeFile(
    failingBrowserctl,
    process.platform === 'win32' ? '@echo off\r\necho backend failed 1>&2\r\nexit /b 7\r\n' : '#!/usr/bin/env sh\necho backend failed >&2\nexit 7\n',
  );
  await chmod(failingBrowserctl, 0o755);

  const staticFailConfig = path.join(tempRoot, 'static-fail.json');
  await writeFile(staticFailConfig, JSON.stringify({
    timeoutMs: 1000,
    staticCommands: [{ command: process.execPath, args: ['-e', 'process.exit(5)'] }],
    previewCommand: { command: process.execPath, args: [fromRoot('tests', 'fixtures', 'browser-completion', 'preview-server.mjs'), '--port', '9'] },
    readinessUrl: 'http://127.0.0.1:9/health',
  }, null, 2));

  const backendFailConfig = path.join(tempRoot, 'backend-fail.json');
  await writeFile(backendFailConfig, JSON.stringify({
    timeoutMs: 1000,
    previewCommand: { command: process.execPath, args: [fromRoot('tests', 'fixtures', 'browser-completion', 'preview-server.mjs'), '--port', '9'] },
    readinessUrl: 'http://127.0.0.1:9/health',
  }, null, 2));

  const cases = [
    {
      id: 'static-fail',
      args: ['--flow', 'preview', '--config', staticFailConfig, '--browserctl', fakeBrowserctl],
    },
    {
      id: 'backend-fail',
      args: ['--flow', 'preview', '--config', backendFailConfig, '--browserctl', failingBrowserctl],
    },
    {
      id: 'unsupported-flow',
      args: ['--flow', 'visual', '--url', 'data:text/html,ok', '--browserctl', fakeBrowserctl],
    },
    {
      id: 'missing-url',
      args: ['--flow', 'smoke', '--browserctl', fakeBrowserctl],
    },
  ];

  for (const fixture of cases) {
    const result = spawnSync(process.execPath, [
      fromRoot('scripts', 'browser-flow-runner.mjs'),
      ...fixture.args,
      '--run-id',
      fixture.id,
      '--verdict-dir',
      path.join(tempRoot, '.moonshot-relay'),
      '--timeout-ms',
      '1000',
    ], {
      cwd: tempRoot,
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0, `${fixture.id} should fail`);
    const verdict = JSON.parse(await readFile(path.join(tempRoot, '.moonshot-relay', `browser-flow-verdict-${fixture.id}.json`), 'utf8'));
    assert.ok(allowed.has(verdict.browserCompletionFailureClass), `${fixture.id}: ${verdict.browserCompletionFailureClass}`);
  }
});

test('browser flow runner classifies preview port conflicts as unavailable port setup gaps', async () => {
  const tempRoot = await makeTempRoot('moonshot-relay-browser-port-gap-');
  const port = await getFreePort();
  const fakeBrowserctl = await createFakeBrowserctl(tempRoot);
  const occupyingServer = http.createServer((request, response) => {
    response.writeHead(503, { 'content-type': 'text/plain' });
    response.end('occupied\n');
  });
  await new Promise((resolve, reject) => {
    occupyingServer.once('error', reject);
    occupyingServer.listen(port, '127.0.0.1', resolve);
  });

  try {
    const configPath = path.join(tempRoot, 'browser-flow-config.json');
    await writeFile(configPath, JSON.stringify({
      timeoutMs: 1200,
      fixtureSeedCommand: { command: process.execPath, args: [fromRoot('tests', 'fixtures', 'browser-completion', 'seed-ok.mjs')] },
      previewCommand: {
        command: process.execPath,
        args: [fromRoot('tests', 'fixtures', 'browser-completion', 'preview-server.mjs'), '--port', String(port)],
      },
      readinessUrl: `http://127.0.0.1:${port}/health`,
    }, null, 2));

    const result = spawnSync(process.execPath, [
      fromRoot('scripts', 'browser-flow-runner.mjs'),
      '--flow',
      'preview',
      '--config',
      configPath,
      '--browserctl',
      fakeBrowserctl,
      '--run-id',
      'unavailable-port',
      '--verdict-dir',
      path.join(tempRoot, '.moonshot-relay'),
      '--timeout-ms',
      '1200',
    ], {
      cwd: tempRoot,
      encoding: 'utf8',
    });

    assert.equal(result.status, 64, result.stderr || result.stdout);
    const verdict = JSON.parse(await readFile(path.join(tempRoot, '.moonshot-relay', 'browser-flow-verdict-unavailable-port.json'), 'utf8'));
    assert.equal(verdict.status, 'setup_gap');
    assert.equal(verdict.failureClass, 'unavailable_port');
    assert.equal(verdict.cleanup.previewProcessTerminated, true);
  } finally {
    await new Promise((resolve) => occupyingServer.close(resolve));
  }
});

test('browser runtime verifier defaults generated verdicts to .moonshot-relay', async () => {
  const content = await readRoot('agents', 'verification', 'verify-runtime.sh');
  const verifyChanges = await readRoot('agents', 'verification', 'verify-changes.sh');
  const contract = await readRoot('schemas', 'verification.contract.yaml');

  assert.match(content, /HARNESS_VERDICT_FILE:-\.moonshot-relay\/runtime-verdict-\$\{RUN_ID\}\.json/);
  assert.match(content, /mkdir -p "\$\(dirname "\$VERDICT_FILE"\)"/);
  assert.match(verifyChanges, /HARNESS_VERDICT_FILE:-\.moonshot-relay\/verification-verdict-\$\{RUN_ID\}\.json/);
  assert.match(contract, /runtimeVerdict:\s*"\.moonshot-relay\/runtime-verdict-<runId>\.json"/);
  assert.match(contract, /verdict:\s*"\.moonshot-relay\/verification-verdict-<runId>\.json"/);
  assert.doesNotMatch(contract, /runtimeVerdict:\s*"\.claude\/runtime-verdict-/);
  assert.doesNotMatch(contract, /verdict:\s*"\.claude\/verification-verdict-/);
  assert.match(content, /grep -E '\^\(\\.moonshot-relay\|\\.claude\)\/browser-flow-verdict-'/);
});

test('package dry-run includes workflow runner support scripts and excludes verdict outputs', () => {
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
  const plannedFrom = payload.runtimes.flatMap((runtime) => runtime.planned.map((entry) => entry.from));
  const plannedTo = payload.runtimes.flatMap((runtime) => runtime.planned.map((entry) => entry.to));

  assert.ok(plannedFrom.includes('scripts/browser-flow-runner.mjs'));
  assert.ok(plannedFrom.includes('scripts/prepare-phase-runner-state.mjs'));
  assert.equal(plannedTo.some((target) => /browser-flow-verdict-/.test(target)), false);
  assert.equal(plannedTo.some((target) => /runtime-verdict-/.test(target)), false);
});

test('README directs users to npm test as the active gate', async () => {
  const readme = await readRoot('README.md');

  assert.match(readme, /npm test/);
  assert.doesNotMatch(readme, /node --test tests\/\*\.mjs/);
  assert.match(readme, /docs\/public\/reference\/phase-runner-user-workflow\.md/);
});

test('phase runner treats review rejects as carry-forward blockers while phases remain', async () => {
  const runner = await readRoot('skills', 'moonshot-phase-runner', 'SKILL.md');
  const executor = await readRoot('skills', 'moonshot-phase-executor', 'SKILL.md');

  assert.match(runner, /Do not stop the whole plan just because a completed phase produced review findings/i);
  assert.match(runner, /carry-forward evidence/i);
  assert.match(runner, /continue to the next independent actionable phase/i);
  assert.match(runner, /Only the final whole-plan completion claim requires `assess-completion` to return `accepted`/);
  assert.match(executor, /REJECT`.*worsened eval or blocking runtime event/i);
  assert.match(executor, /carry-forward blockers rather than automatic whole-plan stop conditions/i);
});

test('phase runner treats general start as full-plan execution intent', async () => {
  const runner = await readRoot('skills', 'moonshot-phase-runner', 'SKILL.md');
  const runnerKo = await readRoot('skills', 'moonshot-phase-runner', 'SKILL.ko.md');
  const workflow = await readRoot('docs', 'public', 'reference', 'phase-runner-user-workflow.md');

  for (const content of [runner, runnerKo, workflow]) {
    assert.match(content, /작업시작/);
    assert.match(content, /full-plan execution|전체 plan 실행/);
    assert.match(content, /Phase 01만|only phase 01/);
  }
  assert.match(runner, /Do not narrow it to Phase 01/i);
  assert.match(runnerKo, /임의 축소하지 않습니다/);
  assert.match(workflow, /must not stop after Phase 01/i);
});

test('phase runner regular workflow requires operational adoption closeout before live profile sync', async () => {
  const runner = await readRoot('skills', 'moonshot-phase-runner', 'SKILL.md');
  const runnerKo = await readRoot('skills', 'moonshot-phase-runner', 'SKILL.ko.md');
  const closeout = await readRoot('skills', 'moonshot-phase-runner', 'references', 'closeout-gates.md');
  const workflow = await readRoot('docs', 'public', 'reference', 'phase-runner-user-workflow.md');
  const installer = await readRoot('docs', 'public', 'installer-usage.md');
  const surface = await readRoot('docs', 'public', 'reference', 'runtime-skill-surface.md');
  const commitSkill = await readRoot('skills', 'commit-moonshot', 'SKILL.md');

  for (const content of [runner, runnerKo, closeout, workflow, installer, surface]) {
    assert.match(content, /Operational Adoption Closeout/);
    assert.match(content, /independent completion audit/i);
    assert.match(content, /independent operational adoption audit/i);
    assert.match(content, /node scripts\/doctor\.mjs check --json/);
    assert.match(content, /node scripts\/skills-audit\.mjs audit --lock skills\.lock\.json --runtime-surface package\/runtime-surface\.json --json/);
    assert.match(content, /npm run test:lab/);
    assert.match(content, /npm run test:package/);
    assert.match(content, /npm run test:eval/);
    assert.match(content, /npm test/);
    assert.match(content, /node package\/build-package\.mjs --runtime all --dry-run --json/);
    assert.match(content, /node bin\/moonshot-relay\.mjs install --runtime all --json/);
    assert.match(content, /--repo-root/);
    assert.match(content, /--lock/);
    assert.match(content, /--runtime-surface/);
    assert.match(content, /profileSurfaceParity/);
    assert.match(content, /extraCanonicalCount=0/);
  }

  assert.match(closeout, /HEAD == origin\/<branch>/);
  assert.match(workflow, /HEAD == origin\/<branch>/);
  assert.match(installer, /HEAD == origin\/<branch>/);
  assert.match(commitSkill, /Operational Adoption Closeout evidence/);
  assert.match(commitSkill, /independent completion audit/i);
  assert.match(commitSkill, /independent operational adoption audit/i);
  assert.match(commitSkill, /live install `installId`/);
  assert.match(commitSkill, /installed doctor with explicit `--repo-root`, `--lock`, and `--runtime-surface` paths/);
  assert.match(commitSkill, /installer JSON `profileSurfaceParity`/);
  assert.match(commitSkill, /profileSurfaceParity\[runtime=codex\]\.extraCanonicalCount=0/);
  assert.match(commitSkill, /skills-audit\.mjs audit --lock skills\.lock\.json --runtime-surface package\/runtime-surface\.json --json/);
  assert.match(commitSkill, /git rev-parse HEAD/);
  assert.match(commitSkill, /git rev-parse origin\/<branch>/);
});

test('phase planning defaults to project-scoped account-root paths', async () => {
  const runner = await readRoot('skills', 'moonshot-phase-runner', 'SKILL.md');
  const runnerKo = await readRoot('skills', 'moonshot-phase-runner', 'SKILL.ko.md');
  const planWriter = await readRoot('skills', 'moonshot-plan-writer', 'SKILL.md');
  const planWriterKo = await readRoot('skills', 'moonshot-plan-writer', 'SKILL.ko.md');
  const workflow = await readRoot('docs', 'public', 'reference', 'phase-runner-user-workflow.md');
  const repositoryLayout = await readRoot('docs', 'public', 'repository-layout.md');
  const installerUsage = await readRoot('docs', 'public', 'installer-usage.md');
  const combined = `${runner}\n${runnerKo}\n${planWriter}\n${planWriterKo}\n${workflow}\n${repositoryLayout}\n${installerUsage}`;

  assert.match(combined, /state\/projects\/<projectId>\/planning\/packages\/<plan-slug>/);
  assert.match(combined, /plans\/<plan-slug>\/runs\/<runId>\/execution/);
  assert.match(combined, /scripts\/project-identity\.mjs/);
  assert.match(combined, /projectId/);
  assert.match(combined, /tracked-source|tracked source|tracked_source_design/i);
  assert.match(combined, /docs\/implementation\/<plan-slug>/);
  assert.match(combined, /install-project-runtime-bridge\.mjs --plan-package docs\/implementation\/<plan-slug>/);
});

test('runtime control plane docs publish DB authority matrix and closeout boundaries', async () => {
  const controlPlane = await readRoot('docs', 'public', 'runtime-control-plane.md');
  const workflow = await readRoot('docs', 'public', 'reference', 'phase-runner-user-workflow.md');
  const coordinator = await readRoot('skills', 'moonshot-in-session-coordinator', 'SKILL.md');

  assert.match(controlPlane, /## Workflow Authority Matrix/);
  assert.match(controlPlane, /runtime-state\.sqlite/);
  assert.match(controlPlane, /\|\s*phase start\s*\|[\s\S]*runtime_events[\s\S]*phase\.start/);
  assert.match(controlPlane, /\|\s*resume\s*\|[\s\S]*resume_snapshots[\s\S]*resume\.(success|failure)/);
  assert.match(controlPlane, /\|\s*blocker\s*\|[\s\S]*runtime_events[\s\S]*blocking/);
  assert.match(controlPlane, /\|\s*phase closeout\s*\|[\s\S]*phase-local evidence/);
  assert.match(controlPlane, /\|\s*whole-plan closeout\s*\|[\s\S]*completion_decisions[\s\S]*accepted/);
  assert.match(controlPlane, /phase-status\.yaml[\s\S]*projection/i);
  assert.match(controlPlane, /projection[\s\S]*must not become authority/i);

  assert.match(workflow, /Phase closeout/i);
  assert.match(workflow, /Whole-plan closeout/i);
  assert.match(workflow, /phase-local evidence/i);
  assert.match(workflow, /assess-completion[\s\S]*accepted DB decision/i);
  assert.match(workflow, /phase-status\.yaml[\s\S]*projection/i);

  assert.match(coordinator, /phase-status\.yaml[\s\S]*projection/i);
  assert.match(coordinator, /whole-plan completion authority/i);
  assert.match(coordinator, /assess-completion[\s\S]*accepted DB decision/i);
});

test('phase runner surfaces describe phase-status as projection only', async () => {
  const files = [
    ['skills', 'moonshot-phase-runner', 'SKILL.md'],
    ['skills', 'moonshot-phase-runner', 'SKILL.ko.md'],
    ['skills', 'moonshot-phase-runner', 'references', 'control-plane.md'],
    ['skills', 'moonshot-in-session-coordinator', 'SKILL.md'],
    ['skills', 'moonshot-in-session-coordinator', 'SKILL.ko.md'],
    ['docs', 'public', 'reference', 'phase-runner-user-workflow.md'],
    ['docs', 'public', 'reference', 'phase-final-guard-hooks.md'],
    ['templates', 'execution', 'PHASE_COORDINATOR_CONTRACT.md'],
  ];
  const unsafePatterns = [
    /phaseStatusFile[\s\S]{0,120}authoritative for this run/i,
    /Runtime status:\s*active\s+`?phase-status\.yaml/i,
    /phase-status\.yaml[\s\S]{0,120}(?:is|as)\s+(?:the\s+)?(?:single\s+)?authority/i,
  ];

  for (const segments of files) {
    const text = await readRoot(...segments);
    assert.match(
      text,
      /phase-status\.yaml|phaseStatusFile/,
      `${segments.join('/')} should name the phase status projection surface`,
    );
    assert.match(
      text,
      /projection|cursor/i,
      `${segments.join('/')} should describe phase status as a projection or cursor`,
    );
    for (const pattern of unsafePatterns) {
      assert.doesNotMatch(text, pattern, `${segments.join('/')} should not imply phase-status authority`);
    }
  }
});

test('strict workflow overlay keeps workspace isolation but does not insert deprecated evidence gate', async () => {
  const bundles = await readRoot('rules', 'workflow-bundles.yaml');
  const workflow = await readRoot('rules', 'workflow.md');
  const strictBlock = bundles.match(/strict:\n([\s\S]*?)\n\nstageOrder:/)?.[1] || '';

  assert.match(strictBlock, /workspace-isolation-gate/);
  assert.doesNotMatch(strictBlock, /verification-evidence-gate/);
  assert.match(workflow, /completion-verifier[\s\S]*runtime-state authority/);
  assert.doesNotMatch(workflow, /Strict runs pass `workspace-isolation-gate` before implementation and `verification-evidence-gate`/);
});

test('workflow registry and teams template keep multi-agent fanout opt-in', async () => {
  const bundles = await readRoot('rules', 'workflow-bundles.yaml');
  const template = await readRoot('templates', 'agent-teams-config.yaml');
  const teamsRunner = await readRoot('skills', 'moonshot-teams-runner', 'SKILL.md');

  assert.match(bundles, /agentFanoutPolicy:/);
  assert.match(bundles, /default:\s*deny/);
  assert.match(bundles, /requiredSignal:\s*agentFanoutContractApproved/);
  assert.match(bundles, /maxNestedDepth:\s*0/);
  assert.match(bundles, /automatic implementation fanout/);
  assert.match(bundles, /\[implementation-runner, implementation-runner\]/);
  assert.match(bundles, /\[moonshot-teams-runner, moonshot-teams-runner\]/);

  assert.match(template, /agentFanoutContract:/);
  assert.match(template, /default:\s*"deny"/);
  assert.match(template, /requiredSignal:\s*"agentFanoutContractApproved"/);
  assert.match(template, /maxNestedDepth:\s*0/);
  assert.match(template, /defaultWriteAccess:\s*"deny"/);
  assert.match(template, /requiredOutputShape:\s*"teamReport"/);

  const triggerBlock = template.match(/triggers:\n([\s\S]*?)\n\n# Global Settings/)?.[1] || '';
  const triggerConditions = [...triggerBlock.matchAll(/condition:\s*"([^"]+)"/g)].map((match) => match[1]);
  assert.ok(triggerConditions.length >= 9, 'expected teams template trigger conditions');
  for (const condition of triggerConditions) {
    assert.match(condition, /signals\.agentFanoutContractApproved == true/, condition);
  }

  assert.match(teamsRunner, /These triggers are candidates only/);
  assert.match(teamsRunner, /agentFanoutContractApproved == true/);
});

test('product architecture handoff routes to bounded or phase execution without live adoption first', async () => {
  const product = await readRoot('skills', 'product-orchestrator', 'SKILL.md');
  const planWriter = await readRoot('skills', 'moonshot-plan-writer', 'SKILL.md');
  const bounded = await readRoot('skills', 'moonshot-orchestrator', 'SKILL.md');
  const runner = await readRoot('skills', 'moonshot-phase-runner', 'SKILL.md');
  const surface = await readRoot('docs', 'public', 'reference', 'runtime-skill-surface.md');

  assert.match(product, /architecture-heavy PRDs[\s\S]*moonshot-architecture/i);
  assert.match(planWriter, /selected ADRs[\s\S]*TRACEABILITY_MATRIX\.md[\s\S]*phase metadata/i);
  assert.match(bounded, /bounded selected ADR[\s\S]*traceability slice/i);
  assert.match(runner, /multi-phase|phase-based/i);
  assert.match(surface, /Controlled adoption[\s\S]*package dry-run[\s\S]*installer dry-run/i);
});
