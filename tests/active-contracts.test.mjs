import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { activeGate } from './helpers/active-gate.mjs';

const root = process.cwd();
const fromRoot = (...segments) => path.join(root, ...segments);

const walk = async (relativeDir) => {
  const absolute = fromRoot(relativeDir);
  if (!existsSync(absolute)) {
    return [];
  }
  const entries = await readdir(absolute, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relative = path.join(relativeDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walk(relative));
    } else {
      files.push(relative.replaceAll(path.sep, '/'));
    }
  }
  return files;
};

const walkEntries = async (relativeDir) => {
  const absolute = fromRoot(relativeDir);
  if (!existsSync(absolute)) {
    return [];
  }
  const entries = await readdir(absolute, { withFileTypes: true });
  const results = [`${relativeDir.replaceAll(path.sep, '/')}/`];
  for (const entry of entries) {
    const relative = path.join(relativeDir, entry.name);
    const portable = relative.replaceAll(path.sep, '/');
    if (entry.isDirectory()) {
      // Avoid spread-push: large local runtime state trees exceed the
      // maximum argument count and throw RangeError.
      for (const nested of await walkEntries(relative)) results.push(nested);
    } else {
      const info = await stat(path.join(absolute, entry.name));
      results.push(`${portable}:${info.size}:${info.mtimeMs}`);
    }
  }
  return results.sort();
};

const runtimeStateSnapshot = async () => {
  const entries = [];
  for (const dir of ['.claude', '.codex', '.qwen', '.moonshot-relay', '.moonshot-state']) {
    for (const entry of await walkEntries(dir)) entries.push(entry);
  }
  return entries;
};

const hasGitBash = () => {
  const result = spawnSync('bash', [
    '-lc',
    'uname -o 2>/dev/null || uname -s',
  ], {
    cwd: root,
    encoding: 'utf8',
  });

  return result.status === 0 && /(MSYS|MINGW|CYGWIN)/i.test(result.stdout);
};

const activeTextFiles = async () => [
  'README.md',
  ...await walk('docs/public'),
  ...await walk('agents'),
  ...await walk('skills'),
  ...await walk('package/profile-templates'),
].filter((file) => /\.(md|yaml|yml|toml|sh)$/.test(file));

const legacyAdapterReferenceFile = 'docs/public/reference/legacy-phase-adapters.md';
const legacyArchiveFragment = ['archive', 'scripts', 'legacy-phase-adapters'].join('/');

test('active human-facing references do not use missing profile-local guideline source paths', async () => {
  const violations = [];
  for (const file of await activeTextFiles()) {
    const text = await readFile(fromRoot(file), 'utf8');
    text.split(/\r?\n/).forEach((line, index) => {
      if (/\.claude\/docs\/guidelines(?:\/|["'`\s]|$)/.test(line)) {
        violations.push(`${file}:${index + 1}: ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(violations, []);
});

test('selected source skills reference existing Markdown targets', async () => {
  const missing = [];
  for (const skill of ['commit-moonshot', 'session-logger']) {
    for (const variant of ['SKILL.md', 'SKILL.ko.md']) {
      const source = `skills/${skill}/${variant}`;
      const content = await readFile(fromRoot(source), 'utf8');
      for (const match of content.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
        const href = match[1].split('#')[0];
        if (!href || /^(?:[a-z]+:|\/)/i.test(href)) continue;
        const target = path.resolve(path.dirname(fromRoot(source)), href);
        if (!existsSync(target)) missing.push(`${source}: ${href}`);
      }
    }
  }
  assert.deepEqual(missing, []);
});

test('harness memory promoter uses the repository boundary without a fixed OS checkout', async () => {
  for (const file of ['agents/harness-memory-promoter.md', 'agents/harness-memory-promoter.ko.md']) {
    const source = await readFile(fromRoot(file), 'utf8');
    assert.doesNotMatch(source, /C:\\dev\\moonshot-relay/i, file);
    assert.match(source, /moonshot-relay/, file);
  }
});

test('active public guideline references resolve in source', async () => {
  const missing = [];
  const guidelineRef = /docs\/public\/guidelines\/[A-Za-z0-9_.-]+/g;
  for (const file of await activeTextFiles()) {
    const text = await readFile(fromRoot(file), 'utf8');
    for (const match of text.matchAll(guidelineRef)) {
      if (!existsSync(fromRoot(match[0]))) {
        missing.push(`${file}: ${match[0]}`);
      }
    }
  }
  assert.deepEqual(missing, []);
});

test('public guidelines contain durable policy content, not placeholder stubs', async () => {
  const violations = [];
  for (const file of await walk('docs/public/guidelines')) {
    if (!file.endsWith('.md')) {
      continue;
    }
    const text = await readFile(fromRoot(file), 'utf8');
    const meaningfulLines = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));
    const onlyPlaceholder = meaningfulLines.every((line) => /^Canonical source guideline\b/.test(line));
    if (meaningfulLines.length < 4 || onlyPlaceholder) {
      violations.push(file);
    }
  }
  assert.deepEqual(violations, []);
});

test('public guidelines are resolved from docs/public and classified', async () => {
  const repositoryLayout = await readFile(fromRoot('docs/public/repository-layout.md'), 'utf8');
  const guidelineFiles = (await walk('docs/public/guidelines'))
    .filter((file) => file.endsWith('.md'))
    .map((file) => path.basename(file))
    .sort();
  const missing = [];

  assert.match(repositoryLayout, /## Public Guideline Classification/);
  assert.match(repositoryLayout, /policy-anchor|reference-index/);
  assert.match(repositoryLayout, /placeholder detector only/);
  assert.doesNotMatch(repositoryLayout, /\.claude\/docs\/guidelines/);

  for (const file of guidelineFiles) {
    if (!repositoryLayout.includes(file)) {
      missing.push(file);
    }
  }

  assert.deepEqual(missing, []);
});

test('external dynamic workflow patterns stay provider-neutral and fanout default-deny', async () => {
  const guideline = await readFile(fromRoot('docs/public/guidelines/external-skill-pattern-transfer.md'), 'utf8');
  const teamsRunner = await readFile(fromRoot('skills/moonshot-teams-runner/SKILL.md'), 'utf8');
  const teamsRunnerKo = await readFile(fromRoot('skills/moonshot-teams-runner/SKILL.ko.md'), 'utf8');
  const workflow = await readFile(fromRoot('rules/workflow.md'), 'utf8');
  const delegation = await readFile(fromRoot('rules/agents/agent-delegation.md'), 'utf8');
  const repositoryLayout = await readFile(fromRoot('docs/public/repository-layout.md'), 'utf8');
  const combined = `${guideline}\n${teamsRunner}\n${teamsRunnerKo}\n${workflow}\n${delegation}`;

  assert.match(guideline, /Managed agent shape/);
  assert.match(guideline, /Dynamic work decomposition/);
  assert.match(guideline, /provider runtime coupling/i);
  assert.match(guideline, /agentFanoutContract:/);
  assert.match(guideline, /default[s]? to single-coordinator execution/i);
  assert.match(guideline, /maxNestedDepth:\s*0/);
  assert.match(guideline, /writeAccess:[\s\S]*default:\s*"deny"/);

  for (const content of [teamsRunner, teamsRunnerKo, workflow, delegation]) {
    assert.match(content, /agentFanoutContract/);
    assert.match(content, /default[- ]deny|default multi-agent fanout is denied|기본 .*fanout.*금지/i);
    assert.match(content, /maxNestedDepth.*0|nested teams|중첩/i);
  }

  assert.match(combined, /owned-path implementation/);
  assert.match(combined, /requirePlanApproval:\s*true|requirePlanApproval.*true/);
  assert.match(combined, /allowedOwnedPaths/);
  assert.match(combined, /fresh verification commands|fresh verification/i);
  assert.doesNotMatch(combined, /requires Claude-specific|must require Claude-specific|should require Claude-specific/i);
  assert.match(repositoryLayout, /external-skill-pattern-transfer\.md[\s\S]*moonshot-teams-runner[\s\S]*rules\/workflow\*/);
});

test('minimal-correct implementation guideline is wired into implementation flows', async () => {
  const requiredRef = 'docs/public/guidelines/minimal-correct-implementation.md';
  const files = [
    'skills/moonshot-orchestrator/SKILL.md',
    'skills/moonshot-orchestrator/SKILL.ko.md',
    'skills/moonshot-orchestrator/references/bounded-flow.md',
    'skills/moonshot-phase-runner/SKILL.md',
    'skills/moonshot-phase-runner/SKILL.ko.md',
    'templates/execution/SCORECARD.template.md',
  ];

  const missing = [];
  for (const file of files) {
    const text = await readFile(fromRoot(file), 'utf8');
    if (!text.includes(requiredRef)) {
      missing.push(file);
    }
  }

  const orchestrator = await readFile(fromRoot('skills/moonshot-orchestrator/SKILL.md'), 'utf8');
  const phaseRunner = await readFile(fromRoot('skills/moonshot-phase-runner/SKILL.md'), 'utf8');
  const scorecard = await readFile(fromRoot('templates/execution/SCORECARD.template.md'), 'utf8');

  assert.match(orchestrator, /before choosing the implementation shape/);
  assert.match(orchestrator, /Minimality decision/);
  assert.match(phaseRunner, /mandatory implementation-shape constraint/);
  assert.match(scorecard, /OBJ-MIN/);
  assert.deepEqual(missing, []);
});

test('active memory skills do not present legacy .claude memorygraph cache as the default seed', async () => {
  const violations = [];
  for (const file of [
    'skills/project-memory-refresh/SKILL.md',
    'skills/project-memory-refresh/SKILL.ko.md',
    'skills/commit-moonshot/SKILL.md',
    'skills/commit-moonshot/SKILL.ko.md',
    'skills/doc-auto-sync/SKILL.md',
    'skills/doc-auto-sync/SKILL.ko.md',
  ]) {
    const text = await readFile(fromRoot(file), 'utf8');
    text.split(/\r?\n/).forEach((line, index) => {
      if (/--seed\s+\.claude\/cache\/memorygraph\/project-graph-seed\.json|path:\s*"\.claude\/cache\/memorygraph\/project-graph-seed\.json"/.test(line)) {
        violations.push(`${file}:${index + 1}: ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(violations, []);
});

test('active memory instructions default to account-root project knowledge state', async () => {
  const files = [
    'agents/project-memory-refresh.md',
    'agents/project-memory-refresh.ko.md',
    'skills/harness-memory-promoter/SKILL.md',
    'skills/harness-memory-promoter/SKILL.ko.md',
    'skills/commit-moonshot/SKILL.ko.md',
  ];
  const violations = [];

  for (const file of files) {
    const text = await readFile(fromRoot(file), 'utf8');
    assert.match(
      text,
      /\$\{MOONSHOT_RELAY_HOME:-~\/\.moonshot-relay\}\/state\/projects\/|account-root project knowledge namespace|계정 루트 project namespace/,
      `${file} should name account-root project knowledge state`,
    );

    text.split(/\r?\n/).forEach((line, index) => {
      if (/MEMORYGRAPH_DATA_DIR=.*\.moonshot-relay\/memorygraph|%USERPROFILE%\/\.codex\/(?:state\/projects|harness\/releases)|기본 저장소.*`\.claude\/memorygraph/.test(line)) {
        violations.push(`${file}:${index + 1}: ${line.trim()}`);
      }
    });
  }

  assert.deepEqual(violations, []);
});

test('active workflow defaults keep generated state out of service profiles', async () => {
  const files = [
    'schemas/verification.contract.yaml',
    'schemas/analysis-context.schema.yaml',
    'scripts/prepare-phase-runner-state.mjs',
    'scripts/lib/phase-event-ledger.mjs',
    'scripts/lib/phase-run-lease-store.mjs',
    'scripts/lib/runtime-unavailable-cache.mjs',
    'agents/phase-attempt-agent.md',
    'agents/phase-attempt-agent.ko.md',
    'skills/moonshot-phase-runner/SKILL.md',
    'skills/moonshot-phase-runner/SKILL.ko.md',
    'skills/moonshot-phase-executor/SKILL.md',
    'skills/moonshot-phase-executor/SKILL.ko.md',
    'skills/moonshot-in-session-coordinator/SKILL.md',
    'skills/moonshot-in-session-coordinator/SKILL.ko.md',
    'skills/moonshot-plan-writer/assets/master-plan.template.md',
    'skills/moonshot-plan-writer/assets/master-plan.template.ko.md',
    'skills/browser-verifier/SKILL.md',
    'skills/browser-verifier/SKILL.ko.md',
    'templates/execution/QA_REPORT.template.md',
    'docs/public/reference/phase-runner-user-workflow.md',
  ];
  const violations = [];

  for (const file of files) {
    const text = await readFile(fromRoot(file), 'utf8');
    text.split(/\r?\n/).forEach((line, index) => {
      if (/\.claude\/docs\/phase-status\.yaml|\.claude\/browser-flow-verdict-|\.claude\/verification-verdict-/.test(line)) {
        violations.push(`${file}:${index + 1}: ${line.trim()}`);
      }
    });
  }

  assert.deepEqual(violations, []);
});

test('active common docs and workflow files do not target .claude docs', async () => {
  const files = [
    ...await walk('agents'),
    ...await walk('skills'),
    ...await walk('schemas'),
    ...await walk('scripts'),
    ...await walk('templates'),
    ...await walk('package/profile-templates'),
  ].filter((file) => /\.(md|yaml|yml|mjs|js|sh)$/.test(file));
  const violations = [];

  for (const file of files) {
    const text = await readFile(fromRoot(file), 'utf8');
    text.split(/\r?\n/).forEach((line, index) => {
      if (/\.claude\/docs\//.test(line)) {
        violations.push(`${file}:${index + 1}: ${line.trim()}`);
      }
    });
  }

  assert.deepEqual(violations, []);
});

test('installer docs route WSL/Linux users to the Node installer path', async () => {
  const docs = [
    await readFile(fromRoot('README.md'), 'utf8'),
    await readFile(fromRoot('docs/public/installer-usage.md'), 'utf8'),
    await readFile(fromRoot('docs/public/repository-layout.md'), 'utf8'),
  ].join('\n');

  assert.match(docs, /WSL\/Linux|unsupported shell: Linux/);
  assert.match(docs, /node bin\/moonshot-relay\.mjs install --dry-run --runtime all|node bin\/moonshot-relay\.mjs install --runtime all/);
  assert.match(docs, /Git Bash/);
});

test('README install guidance rejects stale runtime paths', async () => {
  const readme = await readFile(fromRoot('README.md'), 'utf8');
  const psInstaller = await readFile(fromRoot('install-claude.ps1'), 'utf8');
  const codexReadme = await readFile(fromRoot('package/profile-templates/codex/.codex/README.md'), 'utf8');

  assert.doesNotMatch(readme, /프로젝트 로컬 메모리.*\.moonshot-relay\/memorygraph/);
  assert.doesNotMatch(readme, /제품 정의 템플릿:\s*`?\.claude\/templates\//);
  assert.doesNotMatch(readme, /실행 브리지 템플릿:\s*`?\.claude\/templates\//);
  assert.doesNotMatch(readme, /출력 템플릿:\s*`?\.claude\/templates\//);
  assert.doesNotMatch(readme, /\/your-project\/\.claude\/skills/);
  assert.doesNotMatch(psInstaller, /Git Bash\/WSL/);
  assert.doesNotMatch(codexReadme, /^# `\.claude` Development Profile/m);

  const installSection = readme.match(/### 한 줄 설치 \(권장\)([\s\S]*?)### Agent Skills CLI 부트스트랩/);
  assert.ok(installSection, 'README should keep a quick install section');
  assert.match(installSection[1], /npx -y github:munlucky\/moonshot-relay install/);
  assert.doesNotMatch(installSection[1], /curl[\s\S]{0,160}install-claude\.sh[\s\S]{0,80}\|\s*bash/);
  assert.match(readme, /install-claude\.sh`는 macOS\/Git Bash compatibility installer/);
});

test('skill and agent docs do not present .claude skills or agents as source', async () => {
  const files = [
    ...await walk('skills'),
    ...await walk('agents'),
  ].filter((file) => /\.(md|sh)$/.test(file) || /(?:^|\/)AGENTS(?:\.ko)?\.md$/.test(file));
  const allowedContext = /installed[/-]?(?:local )?profile|local profile|profile materialization|materialize[sd]?|compatibility|generated(?:\/local)? profile|generated runtime output|runtime output|hydration|local profile changes|mixed with|migration compatibility|active profile surfaces|project-local Claude profile|설치|호환|프로필|materialize|generated copy/i;
  const violations = [];

  for (const file of files) {
    const text = await readFile(fromRoot(file), 'utf8');
    const lines = text.split(/\r?\n/);
    lines.forEach((line, index) => {
      if (!/\.claude\/(?:skills|agents)(?:\/|`|"|'|\s|,|\)|$)/.test(line)) {
        return;
      }
      const context = lines
        .slice(Math.max(0, index - 3), Math.min(lines.length, index + 4))
        .join(' ');
      if (!allowedContext.test(context)) {
        violations.push(`${file}:${index + 1}: ${line.trim()}`);
      }
    });
  }

  assert.deepEqual(violations, []);
});

test('active skills and docs do not recommend default archive execution', async () => {
  const violations = [];
  for (const file of await activeTextFiles()) {
    if (file === legacyAdapterReferenceFile) {
      continue;
    }
    const text = await readFile(fromRoot(file), 'utf8');
    text.split(/\r?\n/).forEach((line, index) => {
      if (/(?:^|\s)(?:bash|node|npm|pnpm|yarn)\s+archive\/scripts\/legacy-phase-adapters\//.test(line)) {
        violations.push(`${file}:${index + 1}: ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(violations, []);
});

test('active skills and docs do not contain personal absolute reference paths', async () => {
  const violations = [];
  for (const file of await activeTextFiles()) {
    const text = await readFile(fromRoot(file), 'utf8');
    if (text.includes('/Users/dev/')) {
      violations.push(file);
    }
  }
  assert.deepEqual(violations, []);
});

test('package dry-run reports planned copy entries', () => {
  const result = spawnSync(process.execPath, [
    'package/build-package.mjs',
    '--runtime',
    'all',
    '--dry-run',
    '--json',
  ], { cwd: root, encoding: 'utf8' });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  for (const runtime of payload.runtimes) {
    assert.ok(Array.isArray(runtime.planned), `${runtime.runtime} should report planned[]`);
    assert.ok(runtime.planned.length > 0, `${runtime.runtime} should report non-empty planned[]`);
    assert.equal(runtime.copiedCount, runtime.planned.length);
  }
});

test('directly executable shell entrypoints use LF line endings', async () => {
  const candidates = [
    ...await walk('bin'),
    ...await walk('scripts'),
    ...await walk('agents'),
    'install-claude.sh',
  ].filter((file) => /\.(sh|bash|zsh)$/.test(file) || file === 'bin/browserctl');
  const violations = [];
  for (const file of candidates) {
    const info = await stat(fromRoot(file));
    if (!info.isFile()) {
      continue;
    }
    const bytes = await readFile(fromRoot(file));
    if (bytes.includes(Buffer.from('\r\n'))) {
      violations.push(file);
    }
  }
  assert.deepEqual(violations, []);
});

test('browser runtime installer resolves source checkout runtime assets', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'moonshot-browser-source-'));
  const emptyHome = path.join(tempRoot, 'empty-home');
  const binDir = path.join(tempRoot, 'bin');
  try {
    await mkdir(emptyHome, { recursive: true });
    const result = spawnSync(process.execPath, [
      'scripts/install-browser-runtime.mjs',
      '--bin-dir',
      binDir,
      '--profile-home',
      emptyHome,
    ], {
      cwd: root,
      env: {
        ...process.env,
        HOME: emptyHome,
        USERPROFILE: emptyHome,
        MOONSHOT_BROWSER_PROFILE_HOME: emptyHome,
        MOONSHOT_RELAY_HOME: emptyHome,
      },
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const installedShim = process.platform === 'win32'
      ? path.join(binDir, 'browserctl.cmd')
      : path.join(binDir, 'browserctl');
    assert.ok(existsSync(installedShim), `expected installed browserctl shim at ${installedShim}`);
    if (process.platform !== 'win32') {
      for (const profile of ['.zprofile', '.bash_profile', '.profile']) {
        const profileText = await readFile(path.join(emptyHome, profile), 'utf8');
        assert.match(profileText, new RegExp(binDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      }
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('active tests do not execute archive compatibility scripts', async () => {
  const archiveFragment = ['archive', 'scripts', 'legacy-phase-adapters'].join('/');
  const violations = [];

  for (const file of ['tests/active-contracts.test.mjs']) {
    const text = await readFile(fromRoot(file), 'utf8');
    text.split(/\r?\n/).forEach((line, index) => {
      if (line.includes(archiveFragment)) {
        violations.push(`${file}:${index + 1}: ${line.trim()}`);
      }
    });
  }

  assert.deepEqual(violations, []);
});

test('active verification contract does not expose legacy adapter command catalog', async () => {
  const contract = await readFile(fromRoot('schemas', 'verification.contract.yaml'), 'utf8');

  assert.doesNotMatch(contract, /^legacyCommands:/m);
  assert.doesNotMatch(contract, new RegExp(legacyArchiveFragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(contract, /legacyValidationProfiles:/);
  assert.match(contract, /legacy_phase_adapter:/);
});

test('browser flow setup gap payload shape is contractually defined', async () => {
  const text = await readFile(fromRoot('agents/verification/verify-runtime.sh'), 'utf8');

  assert.match(text, /BROWSER_FLOW_SETUP_GAP_REASON="browser_flow_runner_unavailable"/);
  assert.match(text, /BROWSER_FLOW_EXPECTED_RUNNER="\$BROWSER_FLOW_RUNNER"/);
  assert.match(text, /"browserFlowStatus": os\.environ\["BROWSER_FLOW_STATUS_VALUE"\]/);
  assert.match(text, /"browserFlowSetupGapReason": os\.environ\["BROWSER_FLOW_SETUP_GAP_REASON_VALUE"\]/);
  assert.match(text, /"browserFlowExpectedRunner": os\.environ\["BROWSER_FLOW_EXPECTED_RUNNER_VALUE"\]/);
});

test('browser flow missing runner uses temp verdict path and leaves repo state unchanged', {
  skip: hasGitBash() ? false : 'Git Bash/MSYS bash unavailable; Node-level setup-gap contract test covers payload shape.',
}, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'moonshot-relay-browser-flow-missing-'));
  const verdictPath = path.join(tempRoot, 'runtime-verdict.json');
  const missingRunner = path.join(tempRoot, 'missing-browser-flow-runner.mjs');
  const fakeBrowserctl = path.join(tempRoot, 'browserctl');
  const before = await runtimeStateSnapshot();
  await writeFile(fakeBrowserctl, '#!/usr/bin/env bash\nexit 0\n', 'utf8');
  await chmod(fakeBrowserctl, 0o755);

  const result = spawnSync('bash', [
    'agents/verification/verify-runtime.sh',
    '--url=data:text/html,ok',
    '--browser-flow=smoke',
    '--browser-only',
  ], {
    cwd: root,
    env: {
      ...process.env,
      HARNESS_VERDICT_FILE: verdictPath,
      MOONSHOT_RELAY_HOME: path.join(tempRoot, '.moonshot-relay'),
      CLAUDE_HOME: path.join(tempRoot, '.claude'),
      USERPROFILE: tempRoot,
      HOME: tempRoot,
      TMP: tempRoot,
      TEMP: tempRoot,
      TMPDIR: tempRoot,
      BROWSERCTL_PATH: fakeBrowserctl,
      BROWSER_FLOW_RUNNER_PATH: missingRunner,
    },
    encoding: 'utf8',
  });

  try {
    assert.ok([1, 3].includes(result.status), result.stderr || result.stdout);
    assert.equal(existsSync(verdictPath), true, result.stderr || result.stdout);
    assert.doesNotMatch(result.stdout, /\.claude\/runtime-verdict-[^\s]+\.json/);
    const payload = JSON.parse(await readFile(verdictPath, 'utf8'));
    assert.equal(payload.checks.browserFlowStatus, 'setup_gap');
    assert.equal(payload.checks.browserFlowSetupGapReason, 'browser_flow_runner_unavailable');
    assert.equal(payload.checks.browserFlowExpectedRunner, missingRunner);
    assert.deepEqual(await runtimeStateSnapshot(), before);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('active archive boundary scan has zero violations', async () => {
  const manifest = JSON.parse(await readFile(fromRoot('package.json'), 'utf8'));
  const gate = activeGate(manifest);

  assert.doesNotMatch(gate, /legacy-archive-contract\.test\.mjs/);
  assert.doesNotMatch(gate, /archive[\\/]/);
});
