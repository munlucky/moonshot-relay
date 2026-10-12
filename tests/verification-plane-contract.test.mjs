import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { after, test } from 'node:test';

import { buildReviewCritiqueLoopReceipt } from '../scripts/lib/review-bundle.mjs';

const root = process.cwd();
const tempRoots = [];

const makeEnv = async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'moonshot-verification-plane-'));
  tempRoots.push(dir);
  return {
    repoRoot: dir,
    env: {
      PHASE_RUNTIME_DB: path.join(dir, 'runtime-state.sqlite'),
    },
  };
};

after(async () => {
  await Promise.all(tempRoots.map((dir) => rm(dir, { recursive: true, force: true })));
});

const run = (args, env = {}) => spawnSync(process.execPath, args, {
  cwd: root,
  encoding: 'utf8',
  env: {
    ...process.env,
    ...env,
  },
});

const json = (result) => {
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
};

const fullPassingPlanes = () => ([
  { plane: 'unit', status: 'passed', command: 'npm test', evidenceId: 'unit-pass' },
  { plane: 'package', status: 'passed', command: 'npm run test:package', evidenceId: 'package-pass' },
  { plane: 'installer', status: 'passed', command: 'node scripts/install-account-root-harness.mjs --runtime all --dry-run --json', evidenceId: 'installer-pass' },
  { plane: 'browser', status: 'passed', traceId: 'browser-trace-1', tracePath: '.moonshot-relay/browser-artifacts/run/goal/smoke/trace-metadata.json', evidenceDepth: 'smoke' },
  { plane: 'security', status: 'passed', scanStatus: 'passed', blockers: [] },
  { plane: 'quality', status: 'passed', command: 'git diff --check', evidenceId: 'quality-pass' },
]);

test('fresh verification plane evidence is required before accepted completion', async () => {
  const { env } = await makeEnv();
  json(run(['scripts/runtime-state.mjs', 'init', '--json'], env));

  const accepted = json(run([
    'scripts/verification-plane.mjs',
    'record-summary',
    '--run-id',
    'run-fresh-plane',
    '--goal-id',
    'goal-fresh-plane',
    '--planes-json',
    JSON.stringify(fullPassingPlanes()),
    '--task-class-json',
    '{"taskType":"docs_only"}',
    '--identity-json',
    '{"runLeaseId":"lease-plane"}',
    '--json',
  ], env));
  const assessed = json(run([
    'scripts/runtime-state.mjs',
    'assess-completion',
    '--run-id',
    'run-fresh-plane',
    '--goal-id',
    'goal-fresh-plane',
    '--json',
  ], env));

  assert.equal(accepted.status, 'recorded');
  assert.equal(accepted.requiredChecksPassed, true);
  assert.equal(accepted.taskLocalCompletion.status, 'complete');
  assert.equal(accepted.wholePlanAuthority.status, 'evidence_eligible');
  assert.equal(accepted.wholePlanAuthority.acceptedCompletionRequired, true);
  assert.equal(assessed.status, 'accepted');
  assert.equal(assessed.authoritySource, 'runtime-state.sqlite');
});

test('verification profiles summarize task-scope evidence without weakening completion authority', async () => {
  const { env } = await makeEnv();
  json(run(['scripts/runtime-state.mjs', 'init', '--json'], env));

  const docsOnly = json(run([
    'scripts/verification-plane.mjs',
    'record-summary',
    '--run-id',
    'run-docs-profile',
    '--goal-id',
    'goal-docs-profile',
    '--profile',
    'docs_only',
    '--planes-json',
    JSON.stringify([
      { plane: 'package', status: 'passed', command: 'doc payload check' },
      { plane: 'quality', status: 'passed', command: 'git diff --check' },
    ]),
    '--task-class-json',
    '{"taskType":"docs_only"}',
    '--identity-json',
    '{"runLeaseId":"lease-docs"}',
    '--json',
  ], env));
  const assessedDocs = json(run([
    'scripts/runtime-state.mjs',
    'assess-completion',
    '--run-id',
    'run-docs-profile',
    '--goal-id',
    'goal-docs-profile',
    '--json',
  ], env));

  assert.equal(docsOnly.profile, 'docs_only');
  assert.deepEqual(docsOnly.profileRequiredPlanes, ['package', 'quality']);
  assert.deepEqual(docsOnly.missingProfilePlanes, []);
  assert.deepEqual(docsOnly.completionAuthorityRequiredPlanes, ['unit', 'package', 'installer', 'browser', 'security', 'quality']);
  assert.deepEqual(docsOnly.missingCompletionAuthorityPlanes, ['unit', 'installer', 'browser', 'security']);
  assert.equal(docsOnly.requiredChecksPassed, true);
  assert.deepEqual(docsOnly.taskLocalCompletion, {
    status: 'complete',
    fresh: true,
    profile: 'docs_only',
    requiredPlanes: ['package', 'quality'],
    missingPlanes: [],
    failedPlanes: [],
    reason: 'profile evidence complete',
  });
  assert.equal(docsOnly.wholePlanAuthority.status, 'blocked');
  assert.equal(docsOnly.wholePlanAuthority.authoritySource, 'runtime-state.sqlite');
  assert.equal(docsOnly.wholePlanAuthority.acceptedCompletionRequired, true);
  assert.deepEqual(docsOnly.wholePlanAuthority.requiredPlanes, ['unit', 'package', 'installer', 'browser', 'security', 'quality']);
  assert.deepEqual(docsOnly.wholePlanAuthority.missingPlanes, ['unit', 'installer', 'browser', 'security']);
  assert.equal(assessedDocs.status, 'rejected');
  assert.equal(assessedDocs.reason, 'missing verification plane: unit');

  const promptOnly = json(run([
    'scripts/verification-plane.mjs',
    'record-summary',
    '--run-id',
    'run-prompt-profile',
    '--goal-id',
    'goal-prompt-profile',
    '--profile',
    'prompt_only',
    '--planes-json',
    JSON.stringify([{ plane: 'quality', status: 'passed', command: 'prompt review' }]),
    '--task-class-json',
    '{"taskType":"docs_only"}',
    '--identity-json',
    '{"runLeaseId":"lease-prompt"}',
    '--json',
  ], env));
  assert.equal(promptOnly.requiredChecksPassed, true);
  assert.equal(promptOnly.taskLocalCompletion.status, 'complete');
  assert.equal(promptOnly.wholePlanAuthority.status, 'blocked');
  assert.deepEqual(promptOnly.missingCompletionAuthorityPlanes, ['unit', 'package', 'installer', 'browser', 'security']);
});

test('required planes override affects summary only and unknown profile fails fast', async () => {
  const { env } = await makeEnv();
  json(run(['scripts/runtime-state.mjs', 'init', '--json'], env));

  const override = json(run([
    'scripts/verification-plane.mjs',
    'record-summary',
    '--run-id',
    'run-required-override',
    '--goal-id',
    'goal-required-override',
    '--required-planes-json',
    '["quality"]',
    '--planes-json',
    JSON.stringify([{ plane: 'quality', status: 'passed', command: 'git diff --check' }]),
    '--task-class-json',
    '{"taskType":"docs_only"}',
    '--identity-json',
    '{"runLeaseId":"lease-override"}',
    '--json',
  ], env));
  const assessed = json(run([
    'scripts/runtime-state.mjs',
    'assess-completion',
    '--run-id',
    'run-required-override',
    '--goal-id',
    'goal-required-override',
    '--json',
  ], env));

  assert.deepEqual(override.requiredPlanes, ['quality']);
  assert.deepEqual(override.profileRequiredPlanes, ['quality']);
  assert.equal(override.requiredChecksPassed, true);
  assert.equal(assessed.status, 'rejected');
  assert.equal(assessed.reason, 'missing verification plane: unit');

  const unknown = run([
    'scripts/verification-plane.mjs',
    'record-summary',
    '--run-id',
    'run-unknown-profile',
    '--goal-id',
    'goal-unknown-profile',
    '--profile',
    'unknown_profile',
    '--planes-json',
    '[]',
    '--json',
  ], env);
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /unknown verification profile: unknown_profile/);
});

test('stale verification plane evidence cannot produce accepted completion', async () => {
  const { env } = await makeEnv();
  json(run(['scripts/runtime-state.mjs', 'init', '--json'], env));

  json(run([
    'scripts/verification-plane.mjs',
    'record-summary',
    '--run-id',
    'run-stale-plane',
    '--goal-id',
    'goal-stale-plane',
    '--planes-json',
    JSON.stringify(fullPassingPlanes()),
    '--identity-json',
    '{"runLeaseId":"lease-stale"}',
    '--produced-at',
    '2000-01-01T00:00:00.000Z',
    '--max-age-minutes',
    '1',
    '--json',
  ], env));
  const assessed = json(run([
    'scripts/runtime-state.mjs',
    'assess-completion',
    '--run-id',
    'run-stale-plane',
    '--goal-id',
    'goal-stale-plane',
    '--json',
  ], env));

  assert.equal(assessed.status, 'rejected');
  assert.match(assessed.reason, /stale verification evidence/);
});

test('missing required verification plane is rejected distinctly', async () => {
  const { env } = await makeEnv();
  json(run(['scripts/runtime-state.mjs', 'init', '--json'], env));
  const planes = fullPassingPlanes().filter((plane) => plane.plane !== 'security');

  const recorded = json(run([
    'scripts/verification-plane.mjs',
    'record-summary',
    '--run-id',
    'run-missing-security',
    '--goal-id',
    'goal-missing-security',
    '--planes-json',
    JSON.stringify(planes),
    '--identity-json',
    '{"runLeaseId":"lease-missing"}',
    '--json',
  ], env));
  const assessed = json(run([
    'scripts/runtime-state.mjs',
    'assess-completion',
    '--run-id',
    'run-missing-security',
    '--goal-id',
    'goal-missing-security',
    '--json',
  ], env));

  assert.equal(recorded.requiredChecksPassed, false);
  assert.deepEqual(recorded.missingPlanes, ['security']);
  assert.equal(assessed.status, 'rejected');
  assert.equal(assessed.reason, 'missing verification plane: security');
});

test('security high critical stale missing and secret scan findings block release claims', async () => {
  const { env } = await makeEnv();
  json(run(['scripts/runtime-state.mjs', 'init', '--json'], env));

  const cases = [
    {
      name: 'missing-codeql',
      scans: { codeql: { status: 'missing' }, dependencyReview: { status: 'passed' }, dependabot: { status: 'passed' }, secretScanning: { status: 'passed' } },
      expected: 'missing scan: codeql',
    },
    {
      name: 'stale-dependency-review',
      scans: { codeql: { status: 'passed' }, dependencyReview: { status: 'passed', producedAt: '2000-01-01T00:00:00.000Z' }, dependabot: { status: 'passed' }, secretScanning: { status: 'passed' } },
      expected: 'stale scan: dependencyReview',
    },
    {
      name: 'high-codeql',
      scans: { codeql: { status: 'passed', findings: [{ severity: 'high', ruleId: 'js/sql-injection' }] }, dependencyReview: { status: 'passed' }, dependabot: { status: 'passed' }, secretScanning: { status: 'passed' } },
      expected: 'high security finding: codeql',
    },
    {
      name: 'vulnerable-dependency',
      scans: { codeql: { status: 'passed' }, dependencyReview: { status: 'passed', findings: [{ severity: 'critical', package: 'demo' }] }, dependabot: { status: 'passed' }, secretScanning: { status: 'passed' } },
      expected: 'critical security finding: dependencyReview',
    },
    {
      name: 'secret-scan',
      scans: { codeql: { status: 'passed' }, dependencyReview: { status: 'passed' }, dependabot: { status: 'passed' }, secretScanning: { status: 'passed', findings: [{ severity: 'critical', type: 'token' }] } },
      expected: 'critical security finding: secretScanning',
    },
  ];

  for (const fixture of cases) {
    const result = json(run([
      'scripts/verification-plane.mjs',
      'assess-security',
      '--run-id',
      `run-${fixture.name}`,
      '--goal-id',
      `goal-${fixture.name}`,
      '--scans-json',
      JSON.stringify(fixture.scans),
      '--json',
    ], env));
    const assessed = json(run([
      'scripts/runtime-state.mjs',
      'assess-completion',
      '--run-id',
      `run-${fixture.name}`,
      '--goal-id',
      `goal-${fixture.name}`,
      '--json',
    ], env));

    assert.equal(result.releaseBlocked, true);
    assert.equal(result.blockers[0].reason, fixture.expected);
    assert.equal(assessed.status, 'rejected');
    assert.equal(assessed.reason, fixture.expected);
  }
});

test('owner-approved security exception is explicit evidence but remains visible', async () => {
  const { env } = await makeEnv();
  json(run(['scripts/runtime-state.mjs', 'init', '--json'], env));

  const result = json(run([
    'scripts/verification-plane.mjs',
    'assess-security',
    '--run-id',
    'run-security-exception',
    '--goal-id',
    'goal-security-exception',
    '--scans-json',
    JSON.stringify({
      codeql: { status: 'passed', findings: [{ severity: 'high', ruleId: 'js/path-injection' }] },
      dependencyReview: { status: 'passed' },
      dependabot: { status: 'passed' },
      secretScanning: { status: 'passed' },
    }),
    '--exception-json',
    '{"approvalId":"SEC-123","owner":"security-owner","reason":"accepted false positive"}',
    '--json',
  ], env));

  assert.equal(result.releaseBlocked, false);
  assert.equal(result.exceptionApplied, true);
  assert.equal(result.blockers[0].approvedException.approvalId, 'SEC-123');
});

test('browser trace evidence is normalized under excluded runtime artifact roots', async () => {
  const { env, repoRoot } = await makeEnv();

  const result = json(run([
    'scripts/verification-plane.mjs',
    'normalize-browser-trace',
    '--run-id',
    'run-browser-trace',
    '--goal-id',
    'goal-browser-trace',
    '--repo-root',
    repoRoot,
    '--url',
    'http://localhost:3000',
    '--flow',
    'smoke',
    '--json',
  ], env));
  const metadataPath = path.join(repoRoot, result.tracePath);
  const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));

  assert.equal(result.status, 'recorded');
  assert.match(result.tracePath, /^\.moonshot-relay\/browser-artifacts\/run-browser-trace\/goal-browser-trace\/smoke\/trace-metadata\.json$/);
  assert.equal(metadata.runId, 'run-browser-trace');
  assert.equal(metadata.goalId, 'goal-browser-trace');
  assert.equal(metadata.reproducible, true);
  assert.ok(await stat(metadataPath));
});

test('task verification classification fails closed for unknown and browser relevant work', () => {
  const unknown = json(run([
    'scripts/verification-plane.mjs',
    'classify-task',
    '--task-json',
    '{}',
    '--json',
  ]));

  assert.equal(unknown.status, 'needs_classification');
  assert.equal(unknown.failClosed, true);
  assert.equal(unknown.completionBlocked, true);
  assert.equal(unknown.requiresBrowserEvidence, true);
  assert.equal(unknown.requiresIntegrationEvidence, true);
  assert.equal(unknown.completionAuthority, false);
  assert.equal(unknown.authoritySource, 'classification_evidence_only');

  const frontend = json(run([
    'scripts/verification-plane.mjs',
    'classify-task',
    '--task-json',
    '{"taskType":"frontend"}',
    '--json',
  ]));

  assert.equal(frontend.status, 'classified');
  assert.equal(frontend.requiresBrowserEvidence, true);
  assert.equal(frontend.requiresIntegrationEvidence, false);
  assert.equal(frontend.criticalScenario, true);

  const docsOnly = json(run([
    'scripts/verification-plane.mjs',
    'classify-task',
    '--task-json',
    '{"taskType":"docs_only"}',
    '--json',
  ]));

  assert.equal(docsOnly.status, 'classified');
  assert.equal(docsOnly.requiresBrowserEvidence, false);
  assert.equal(docsOnly.requiresIntegrationEvidence, false);
  assert.equal(docsOnly.evidenceRequired, false);
});

test('browser completion result is evidence-only and maps critical weak evidence to blocking browser plane', async () => {
  const schema = JSON.parse(await readFile(path.join(root, 'schemas', 'browser-completion-result.schema.json'), 'utf8'));
  assert.equal(schema.additionalProperties, false);
  assert.ok(schema.required.includes('authoritySource'));
  assert.equal(schema.properties.authoritySource.const, 'evidence_only');
  assert.equal(schema.properties.completionAuthority.const, false);

  const smokeCritical = json(run([
    'scripts/verification-plane.mjs',
    'browser-result',
    '--run-id',
    'run-browser-result',
    '--goal-id',
    'goal-browser-result',
    '--scenario-id',
    'critical-ui',
    '--status',
    'clean_pass',
    '--failure-class',
    'none',
    '--evidence-depth',
    'smoke',
    '--task-json',
    '{"taskType":"frontend"}',
    '--json',
  ]));

  assert.equal(smokeCritical.status, 'built');
  assert.equal(smokeCritical.browserResult.artifactId, 'BROWSER_COMPLETION_RESULT');
  assert.equal(smokeCritical.browserResult.completionAuthority, false);
  assert.equal(smokeCritical.browserResult.authoritySource, 'evidence_only');
  assert.equal(smokeCritical.browserResult.criticalSmokeOnlyWarning, true);
  assert.equal(smokeCritical.browserPlane.plane, 'browser');
  assert.equal(smokeCritical.browserPlane.status, 'blocked');
  assert.match(smokeCritical.browserPlane.reason, /smoke-only/);

  const deepCritical = json(run([
    'scripts/verification-plane.mjs',
    'browser-result',
    '--run-id',
    'run-browser-result',
    '--goal-id',
    'goal-browser-result',
    '--scenario-id',
    'critical-ui',
    '--status',
    'clean_pass',
    '--failure-class',
    'none',
    '--evidence-depth',
    'open-act-mutate-persist-recover',
    '--task-json',
    '{"taskType":"frontend"}',
    '--json',
  ]));

  assert.equal(deepCritical.browserPlane.status, 'passed');

  const flakyCritical = json(run([
    'scripts/verification-plane.mjs',
    'browser-result',
    '--run-id',
    'run-browser-result',
    '--goal-id',
    'goal-browser-result',
    '--scenario-id',
    'critical-ui',
    '--status',
    'flaky_pass',
    '--failure-class',
    'none',
    '--evidence-depth',
    'open-act-mutate-persist-recover',
    '--task-json',
    '{"taskType":"frontend"}',
    '--json',
  ]));

  assert.equal(flakyCritical.browserPlane.status, 'blocked');
  assert.match(flakyCritical.browserPlane.reason, /flaky_pass/);
});

test('playwright result normalization turns deterministic artifacts into browser completion evidence', async () => {
  const { repoRoot } = await makeEnv();
  const artifacts = [
    { type: 'screenshot', path: '.moonshot-relay/browser-artifacts/run/goal/integration/screenshot.png' },
    { type: 'trace', path: '.moonshot-relay/browser-artifacts/run/goal/integration/trace.zip' },
    { type: 'console', path: '.moonshot-relay/browser-artifacts/run/goal/integration/console.jsonl' },
    { type: 'network', path: '.moonshot-relay/browser-artifacts/run/goal/integration/network.jsonl' },
    { type: 'report', path: '.moonshot-relay/browser-artifacts/run/goal/integration/playwright-report/index.html' },
  ];
  for (const artifact of artifacts) {
    const artifactPath = path.join(repoRoot, artifact.path);
    await mkdir(path.dirname(artifactPath), { recursive: true });
    await writeFile(artifactPath, `${artifact.type}\n`);
  }

  const clean = json(run([
    'scripts/verification-plane.mjs',
    'normalize-playwright-result',
    '--repo-root',
    repoRoot,
    '--run-id',
    'run-playwright-clean',
    '--goal-id',
    'goal-playwright-clean',
    '--scenario-id',
    'integration-flow',
    '--scenario-json',
    '{"evidenceDepth":"open-act-mutate-persist-recover"}',
    '--result-json',
    JSON.stringify({
      status: 'passed',
      artifacts,
      console: [{ level: 'info', text: 'ready' }],
      network: [{ url: 'http://127.0.0.1/api', status: 200 }],
      command: 'npx playwright test',
      stdout: 'passed',
      stderr: '',
      retryCount: 0,
      uncontrolledNetworkBlocked: true,
      deterministicSelectors: true,
      fixedTime: true,
    }),
    '--task-json',
    '{"taskType":"frontend"}',
    '--json',
  ]));

  assert.equal(clean.status, 'normalized');
  assert.equal(clean.browserResult.status, 'clean_pass');
  assert.equal(clean.browserResult.failureClass, 'none');
  assert.equal(clean.browserResult.evidenceDepth, 'open-act-mutate-persist-recover');
  assert.equal(clean.browserResult.completionAuthority, false);
  assert.equal(clean.browserResult.authoritySource, 'evidence_only');
  assert.equal(clean.browserResult.redactionManifest.uncontrolledNetworkBlocked, true);
  assert.equal(clean.browserPlane.status, 'passed');

  const missingArtifact = json(run([
    'scripts/verification-plane.mjs',
    'normalize-playwright-result',
    '--repo-root',
    repoRoot,
    '--run-id',
    'run-playwright-missing-artifact',
    '--goal-id',
    'goal-playwright-missing-artifact',
    '--scenario-id',
    'integration-flow',
    '--result-json',
    JSON.stringify({ status: 'passed', artifacts: artifacts.filter((artifact) => artifact.type !== 'trace') }),
    '--json',
  ]));

  assert.equal(missingArtifact.browserResult.status, 'failed');
  assert.equal(missingArtifact.browserResult.failedStage, 'artifact');
  assert.equal(missingArtifact.browserResult.failureClass, 'artifact_missing');
  assert.deepEqual(missingArtifact.diagnostics.missingArtifactTypes, ['trace']);

  const diagnosticSecret = 'playwright-secret-token';
  const consoleFailureRaw = run([
    'scripts/verification-plane.mjs',
    'normalize-playwright-result',
    '--repo-root',
    repoRoot,
    '--run-id',
    'run-playwright-console',
    '--goal-id',
    'goal-playwright-console',
    '--scenario-id',
    'smoke-flow',
    '--result-json',
    JSON.stringify({ status: 'passed', artifacts, console: [{ level: 'error', text: `hydration failed ${diagnosticSecret}` }] }),
    '--json',
  ]);
  const consoleFailure = json(consoleFailureRaw);

  assert.equal(consoleFailure.browserResult.status, 'failed');
  assert.equal(consoleFailure.browserResult.failedStage, 'console');
  assert.equal(consoleFailure.browserResult.failureClass, 'playwright_assertion_failed');
  assert.equal(consoleFailureRaw.stdout.includes(diagnosticSecret), false);

  const networkFailure = json(run([
    'scripts/verification-plane.mjs',
    'normalize-playwright-result',
    '--repo-root',
    repoRoot,
    '--run-id',
    'run-playwright-network',
    '--goal-id',
    'goal-playwright-network',
    '--scenario-id',
    'smoke-flow',
    '--result-json',
    JSON.stringify({ status: 'passed', artifacts, network: [{ url: `http://127.0.0.1/api?token=${diagnosticSecret}`, status: 503, errorText: diagnosticSecret }] }),
    '--json',
  ]));

  assert.equal(networkFailure.browserResult.status, 'failed');
  assert.equal(networkFailure.browserResult.failedStage, 'network');
  assert.equal(networkFailure.browserResult.failureClass, 'playwright_assertion_failed');

  const flaky = json(run([
    'scripts/verification-plane.mjs',
    'normalize-playwright-result',
    '--repo-root',
    repoRoot,
    '--run-id',
    'run-playwright-flaky',
    '--goal-id',
    'goal-playwright-flaky',
    '--scenario-id',
    'critical-ui',
    '--scenario-json',
    '{"evidenceDepth":"open-act-mutate-persist-recover"}',
    '--result-json',
    JSON.stringify({
      status: 'passed',
      artifacts,
      retryCount: 1,
      uncontrolledNetworkBlocked: true,
      deterministicSelectors: true,
      fixedTime: true,
    }),
    '--task-json',
    '{"taskType":"frontend"}',
    '--json',
  ]));

  assert.equal(flaky.browserResult.status, 'flaky_pass');
  assert.equal(flaky.browserPlane.status, 'blocked');
  assert.match(flaky.browserPlane.reason, /flaky_pass/);

  const missingDeterminism = json(run([
    'scripts/verification-plane.mjs',
    'normalize-playwright-result',
    '--repo-root',
    repoRoot,
    '--run-id',
    'run-playwright-missing-determinism',
    '--goal-id',
    'goal-playwright-missing-determinism',
    '--scenario-id',
    'integration-flow',
    '--scenario-json',
    '{"evidenceDepth":"open-act-mutate-persist-recover"}',
    '--result-json',
    JSON.stringify({ status: 'passed', artifacts }),
    '--json',
  ]));

  assert.equal(missingDeterminism.browserResult.status, 'setup_gap');
  assert.equal(missingDeterminism.browserResult.failedStage, 'determinism');
  assert.equal(missingDeterminism.browserResult.failureClass, 'runtime_environment_failed');
  assert.equal(missingDeterminism.browserPlane.status, 'blocked');

  const smokeOnlyCritical = json(run([
    'scripts/verification-plane.mjs',
    'normalize-playwright-result',
    '--repo-root',
    repoRoot,
    '--run-id',
    'run-playwright-smoke-only',
    '--goal-id',
    'goal-playwright-smoke-only',
    '--scenario-id',
    'critical-ui',
    '--scenario-json',
    '{"evidenceDepth":"smoke"}',
    '--result-json',
    JSON.stringify({ status: 'passed', artifacts }),
    '--task-json',
    '{"taskType":"frontend"}',
    '--json',
  ]));

  assert.equal(smokeOnlyCritical.browserResult.status, 'clean_pass');
  assert.equal(smokeOnlyCritical.browserResult.criticalSmokeOnlyWarning, true);
  assert.equal(smokeOnlyCritical.browserPlane.status, 'blocked');

  const outsideArtifact = json(run([
    'scripts/verification-plane.mjs',
    'normalize-playwright-result',
    '--repo-root',
    repoRoot,
    '--run-id',
    'run-playwright-outside-artifact',
    '--goal-id',
    'goal-playwright-outside-artifact',
    '--scenario-id',
    'smoke-flow',
    '--result-json',
    JSON.stringify({
      status: 'passed',
      artifacts: [
        ...artifacts.filter((artifact) => artifact.type !== 'trace'),
        { type: 'trace', path: 'tmp/trace.zip' },
      ],
    }),
    '--json',
  ]));

  assert.equal(outsideArtifact.browserResult.status, 'failed');
  assert.equal(outsideArtifact.browserResult.failureClass, 'artifact_missing');
  assert.deepEqual(outsideArtifact.diagnostics.invalidArtifactPaths, ['tmp/trace.zip']);

  const absoluteArtifact = json(run([
    'scripts/verification-plane.mjs',
    'normalize-playwright-result',
    '--repo-root',
    repoRoot,
    '--run-id',
    'run-playwright-absolute-artifact',
    '--goal-id',
    'goal-playwright-absolute-artifact',
    '--scenario-id',
    'smoke-flow',
    '--result-json',
    JSON.stringify({
      status: 'passed',
      artifacts: [
        ...artifacts.filter((artifact) => artifact.type !== 'trace'),
        { type: 'trace', path: path.join(repoRoot, 'outside-trace.zip') },
      ],
    }),
    '--json',
  ]));

  assert.equal(absoluteArtifact.browserResult.status, 'failed');
  assert.equal(absoluteArtifact.browserResult.failureClass, 'artifact_missing');

  const traversalArtifact = json(run([
    'scripts/verification-plane.mjs',
    'normalize-playwright-result',
    '--repo-root',
    root,
    '--run-id',
    'run-playwright-traversal-artifact',
    '--goal-id',
    'goal-playwright-traversal-artifact',
    '--scenario-id',
    'smoke-flow',
    '--result-json',
    JSON.stringify({
      status: 'passed',
      artifacts: ['screenshot', 'trace', 'console', 'network', 'report'].map((type) => ({
        type,
        path: '.moonshot-relay/browser-artifacts/../../package.json',
      })),
    }),
    '--json',
  ]));

  assert.equal(traversalArtifact.browserResult.status, 'failed');
  assert.equal(traversalArtifact.browserResult.failureClass, 'artifact_missing');
  assert.deepEqual(traversalArtifact.diagnostics.invalidArtifactPaths, [
    '.moonshot-relay/browser-artifacts/../../package.json',
    '.moonshot-relay/browser-artifacts/../../package.json',
    '.moonshot-relay/browser-artifacts/../../package.json',
    '.moonshot-relay/browser-artifacts/../../package.json',
    '.moonshot-relay/browser-artifacts/../../package.json',
  ]);

  const setupGap = json(run([
    'scripts/verification-plane.mjs',
    'normalize-playwright-result',
    '--repo-root',
    repoRoot,
    '--run-id',
    'run-playwright-setup-gap',
    '--goal-id',
    'goal-playwright-setup-gap',
    '--scenario-id',
    'smoke-flow',
    '--result-json',
    JSON.stringify({ status: 'setup_gap', failedStage: 'preview', failureClass: 'preview_start_failed', artifacts: [] }),
    '--json',
  ]));

  assert.equal(setupGap.browserResult.status, 'setup_gap');
  assert.equal(setupGap.browserResult.failureClass, 'preview_start_failed');
  assert.equal(setupGap.browserPlane.status, 'blocked');

  const runnerLocalSetupGap = json(run([
    'scripts/verification-plane.mjs',
    'normalize-playwright-result',
    '--repo-root',
    repoRoot,
    '--run-id',
    'run-playwright-runner-local-setup-gap',
    '--goal-id',
    'goal-playwright-runner-local-setup-gap',
    '--scenario-id',
    'smoke-flow',
    '--result-json',
    JSON.stringify({ status: 'setup_gap', failedStage: 'preview', failureClass: 'missing_preview_command', artifacts: [] }),
    '--json',
  ]));

  assert.equal(runnerLocalSetupGap.browserResult.status, 'setup_gap');
  assert.equal(runnerLocalSetupGap.browserResult.failureClass, 'setup_gap');
  assert.equal(runnerLocalSetupGap.browserPlane.status, 'blocked');

  const commandSecret = 'sk_live_abc123';
  const commandSecretRaw = run([
    'scripts/verification-plane.mjs',
    'normalize-playwright-result',
    '--repo-root',
    repoRoot,
    '--run-id',
    'run-playwright-command-secret',
    '--goal-id',
    'goal-playwright-command-secret',
    '--scenario-id',
    'smoke-flow',
    '--result-json',
    JSON.stringify({
      status: 'passed',
      artifacts,
      commands: [{
        command: `npx playwright test --token=${commandSecret}`,
        stdout: `stdout ${commandSecret}`,
        stderr: `stderr ${commandSecret}`,
        env: { API_TOKEN: commandSecret },
        exitCode: 0,
      }],
    }),
    '--json',
  ]);
  const commandSecretResult = json(commandSecretRaw);

  assert.equal(commandSecretRaw.stdout.includes(commandSecret), false);
  assert.equal(commandSecretResult.browserResult.status, 'clean_pass');
  assert.equal(commandSecretResult.browserResult.commands.some((command) => Object.hasOwn(command, 'env')), false);
});

test('agentic browser confirmation is evidence-only and cannot override Playwright state', async () => {
  const { repoRoot } = await makeEnv();
  const artifacts = [
    { type: 'screenshot', path: '.moonshot-relay/browser-artifacts/run/goal/integration/screenshot.png' },
    { type: 'trace', path: '.moonshot-relay/browser-artifacts/run/goal/integration/trace.zip' },
    { type: 'console', path: '.moonshot-relay/browser-artifacts/run/goal/integration/console.jsonl' },
    { type: 'network', path: '.moonshot-relay/browser-artifacts/run/goal/integration/network.jsonl' },
    { type: 'report', path: '.moonshot-relay/browser-artifacts/run/goal/integration/playwright-report/index.html' },
  ];
  const confirmationScreenshot = '.moonshot-relay/browser-artifacts/run/goal/integration/agentic-confirmation.png';
  const confirmationSnapshot = '.moonshot-relay/browser-artifacts/run/goal/integration/accessibility-snapshot.json';
  for (const artifact of [...artifacts, { path: confirmationScreenshot, type: 'screenshot' }, { path: confirmationSnapshot, type: 'accessibility_snapshot' }]) {
    const artifactPath = path.join(repoRoot, artifact.path);
    await mkdir(path.dirname(artifactPath), { recursive: true });
    await writeFile(artifactPath, `${artifact.type}\n`);
  }
  const scenario = {
    evidenceDepth: 'open-act-mutate-persist-recover',
    expectedUrl: 'http://127.0.0.1:3000/done',
    expectedText: 'Ready',
    expectedRole: 'button',
    expectedName: 'Save',
  };
  const cleanPlaywright = {
    status: 'passed',
    artifacts,
    uncontrolledNetworkBlocked: true,
    deterministicSelectors: true,
    fixedTime: true,
  };
  const cleanConfirmation = {
    backend: 'agent-browser',
    url: 'http://127.0.0.1:3000/done',
    expectedTextFound: true,
    roleNameFound: true,
    screenshotPath: confirmationScreenshot,
    snapshotPath: confirmationSnapshot,
    accessibilitySnapshot: { role: 'main', name: 'Ready' },
    consoleSummary: { errorCount: 0 },
    networkSummary: { failedRequestCount: 0 },
    command: 'agent-browser confirm',
    stdout: 'ok',
    exitCode: 0,
  };

  const clean = json(run([
    'scripts/verification-plane.mjs',
    'normalize-browser-confirmation',
    '--repo-root',
    repoRoot,
    '--run-id',
    'run-agentic-clean',
    '--goal-id',
    'goal-agentic-clean',
    '--scenario-id',
    'integration-flow',
    '--scenario-json',
    JSON.stringify(scenario),
    '--playwright-result-json',
    JSON.stringify(cleanPlaywright),
    '--confirmation-json',
    JSON.stringify(cleanConfirmation),
    '--task-json',
    '{"taskType":"frontend"}',
    '--json',
  ]));

  assert.equal(clean.browserResult.status, 'clean_pass');
  assert.equal(clean.browserResult.evidenceDepth, 'agentic-browser-confirmation');
  assert.equal(clean.browserResult.completionAuthority, false);
  assert.equal(clean.browserResult.authoritySource, 'evidence_only');
  assert.equal(clean.browserPlane.status, 'passed');

  const failedPlaywright = json(run([
    'scripts/verification-plane.mjs',
    'normalize-browser-confirmation',
    '--repo-root',
    repoRoot,
    '--run-id',
    'run-agentic-failed-playwright',
    '--goal-id',
    'goal-agentic-failed-playwright',
    '--scenario-id',
    'integration-flow',
    '--scenario-json',
    JSON.stringify(scenario),
    '--playwright-result-json',
    JSON.stringify({ ...cleanPlaywright, status: 'failed', assertions: [{ status: 'failed' }] }),
    '--confirmation-json',
    JSON.stringify(cleanConfirmation),
    '--task-json',
    '{"taskType":"frontend"}',
    '--json',
  ]));

  assert.equal(failedPlaywright.browserResult.status, 'failed');
  assert.equal(failedPlaywright.browserResult.failedStage, 'playwright');
  assert.equal(failedPlaywright.browserResult.failureClass, 'playwright_assertion_failed');
  assert.equal(failedPlaywright.browserPlane.status, 'failed');

  const setupGapPlaywright = json(run([
    'scripts/verification-plane.mjs',
    'normalize-browser-confirmation',
    '--repo-root',
    repoRoot,
    '--run-id',
    'run-agentic-setup-gap-playwright',
    '--goal-id',
    'goal-agentic-setup-gap-playwright',
    '--scenario-id',
    'integration-flow',
    '--scenario-json',
    JSON.stringify(scenario),
    '--playwright-result-json',
    JSON.stringify({ ...cleanPlaywright, status: 'setup_gap', failureClass: 'runtime_environment_failed' }),
    '--confirmation-json',
    JSON.stringify(cleanConfirmation),
    '--task-json',
    '{"taskType":"frontend"}',
    '--json',
  ]));

  assert.equal(setupGapPlaywright.browserResult.status, 'setup_gap');
  assert.equal(setupGapPlaywright.browserResult.failedStage, 'playwright');
  assert.equal(setupGapPlaywright.browserResult.failureClass, 'runtime_environment_failed');
  assert.equal(setupGapPlaywright.browserPlane.status, 'blocked');

  const flakyPlaywright = json(run([
    'scripts/verification-plane.mjs',
    'normalize-browser-confirmation',
    '--repo-root',
    repoRoot,
    '--run-id',
    'run-agentic-flaky-playwright',
    '--goal-id',
    'goal-agentic-flaky-playwright',
    '--scenario-id',
    'integration-flow',
    '--scenario-json',
    JSON.stringify(scenario),
    '--playwright-result-json',
    JSON.stringify({ ...cleanPlaywright, retryCount: 1 }),
    '--confirmation-json',
    JSON.stringify(cleanConfirmation),
    '--task-json',
    '{"taskType":"frontend"}',
    '--json',
  ]));

  assert.equal(flakyPlaywright.browserResult.status, 'flaky_pass');
  assert.equal(flakyPlaywright.browserPlane.status, 'blocked');
  assert.match(flakyPlaywright.browserPlane.reason, /flaky_pass/);

  const backendGap = json(run([
    'scripts/verification-plane.mjs',
    'normalize-browser-confirmation',
    '--repo-root',
    repoRoot,
    '--run-id',
    'run-agentic-backend-gap',
    '--goal-id',
    'goal-agentic-backend-gap',
    '--scenario-id',
    'integration-flow',
    '--scenario-json',
    JSON.stringify(scenario),
    '--playwright-result-json',
    JSON.stringify(cleanPlaywright),
    '--confirmation-json',
    JSON.stringify({ ...cleanConfirmation, backendAvailable: false }),
    '--task-json',
    '{"taskType":"frontend"}',
    '--json',
  ]));

  assert.equal(backendGap.browserResult.status, 'setup_gap');
  assert.equal(backendGap.browserResult.failureClass, 'runtime_environment_failed');
  assert.equal(backendGap.browserPlane.status, 'blocked');

  const unsupportedBackend = json(run([
    'scripts/verification-plane.mjs',
    'normalize-browser-confirmation',
    '--repo-root',
    repoRoot,
    '--run-id',
    'run-agentic-unsupported-backend',
    '--goal-id',
    'goal-agentic-unsupported-backend',
    '--scenario-id',
    'integration-flow',
    '--scenario-json',
    JSON.stringify(scenario),
    '--playwright-result-json',
    JSON.stringify(cleanPlaywright),
    '--confirmation-json',
    JSON.stringify({ ...cleanConfirmation, backend: 'unsupported-browser' }),
    '--task-json',
    '{"taskType":"frontend"}',
    '--json',
  ]));

  assert.equal(unsupportedBackend.browserResult.status, 'setup_gap');
  assert.equal(unsupportedBackend.browserResult.failureClass, 'setup_gap');
  assert.equal(unsupportedBackend.browserPlane.status, 'blocked');

  const missingSnapshot = json(run([
    'scripts/verification-plane.mjs',
    'normalize-browser-confirmation',
    '--repo-root',
    repoRoot,
    '--run-id',
    'run-agentic-missing-snapshot',
    '--goal-id',
    'goal-agentic-missing-snapshot',
    '--scenario-id',
    'integration-flow',
    '--scenario-json',
    JSON.stringify(scenario),
    '--playwright-result-json',
    JSON.stringify(cleanPlaywright),
    '--confirmation-json',
    JSON.stringify({
      ...cleanConfirmation,
      accessibilitySnapshot: null,
      snapshotPath: '.moonshot-relay/browser-artifacts/../../package.json',
    }),
    '--task-json',
    '{"taskType":"frontend"}',
    '--json',
  ]));

  assert.equal(missingSnapshot.browserResult.status, 'failed');
  assert.equal(missingSnapshot.browserResult.failureClass, 'artifact_missing');
  assert.deepEqual(missingSnapshot.diagnostics.invalidArtifactPaths, ['.moonshot-relay/browser-artifacts/../../package.json']);

  const tamperedAssertions = json(run([
    'scripts/verification-plane.mjs',
    'normalize-browser-confirmation',
    '--repo-root',
    repoRoot,
    '--run-id',
    'run-agentic-tampered',
    '--goal-id',
    'goal-agentic-tampered',
    '--scenario-id',
    'integration-flow',
    '--scenario-json',
    JSON.stringify(scenario),
    '--playwright-result-json',
    JSON.stringify(cleanPlaywright),
    '--confirmation-json',
    JSON.stringify({ ...cleanConfirmation, updatedExpectedText: 'Changed' }),
    '--task-json',
    '{"taskType":"frontend"}',
    '--json',
  ]));

  assert.equal(tamperedAssertions.browserResult.status, 'failed');
  assert.equal(tamperedAssertions.browserResult.failedStage, 'assertion_contract');
  assert.equal(tamperedAssertions.browserResult.failureClass, 'browser_confirmation_failed');

  const authorityContaminated = json(run([
    'scripts/verification-plane.mjs',
    'normalize-browser-confirmation',
    '--repo-root',
    repoRoot,
    '--run-id',
    'run-agentic-authority-contaminated',
    '--goal-id',
    'goal-agentic-authority-contaminated',
    '--scenario-id',
    'integration-flow',
    '--scenario-json',
    JSON.stringify(scenario),
    '--playwright-result-json',
    JSON.stringify(cleanPlaywright),
    '--confirmation-json',
    JSON.stringify({ ...cleanConfirmation, completionAuthority: true, authoritySource: 'adapter_claim' }),
    '--task-json',
    '{"taskType":"frontend"}',
    '--json',
  ]));

  assert.equal(authorityContaminated.browserResult.status, 'failed');
  assert.equal(authorityContaminated.browserResult.failedStage, 'authority_contract');
  assert.equal(authorityContaminated.browserResult.failureClass, 'browser_confirmation_failed');

  const failedNetworkAlias = json(run([
    'scripts/verification-plane.mjs',
    'normalize-browser-confirmation',
    '--repo-root',
    repoRoot,
    '--run-id',
    'run-agentic-failed-network-alias',
    '--goal-id',
    'goal-agentic-failed-network-alias',
    '--scenario-id',
    'integration-flow',
    '--scenario-json',
    JSON.stringify(scenario),
    '--playwright-result-json',
    JSON.stringify(cleanPlaywright),
    '--confirmation-json',
    JSON.stringify({ ...cleanConfirmation, networkSummary: { failedCount: 1 } }),
    '--task-json',
    '{"taskType":"frontend"}',
    '--json',
  ]));

  assert.equal(failedNetworkAlias.browserResult.status, 'failed');
  assert.equal(failedNetworkAlias.browserResult.failedStage, 'network');
  assert.equal(failedNetworkAlias.browserResult.failureClass, 'browser_confirmation_failed');

  const playwrightWaived = json(run([
    'scripts/verification-plane.mjs',
    'normalize-browser-confirmation',
    '--repo-root',
    repoRoot,
    '--run-id',
    'run-agentic-playwright-waived',
    '--goal-id',
    'goal-agentic-playwright-waived',
    '--scenario-id',
    'integration-flow',
    '--scenario-json',
    JSON.stringify({
      ...scenario,
      playwrightRequired: false,
      playwrightWaiver: {
        reason: 'static HTML confirmation only',
        approvedBy: 'phase-04-test',
      },
    }),
    '--confirmation-json',
    JSON.stringify(cleanConfirmation),
    '--task-json',
    '{"taskType":"browser","requiresBrowserEvidence":true,"requiresIntegrationEvidence":false,"criticalScenario":false}',
    '--json',
  ]));

  assert.equal(playwrightWaived.browserResult.status, 'clean_pass');
  assert.equal(playwrightWaived.browserPlane.status, 'passed');

  const criticalPlaywrightWaived = json(run([
    'scripts/verification-plane.mjs',
    'normalize-browser-confirmation',
    '--repo-root',
    repoRoot,
    '--run-id',
    'run-agentic-critical-playwright-waived',
    '--goal-id',
    'goal-agentic-critical-playwright-waived',
    '--scenario-id',
    'critical-integration-flow',
    '--scenario-json',
    JSON.stringify({
      ...scenario,
      playwrightRequired: false,
      playwrightWaiver: {
        reason: 'critical waiver should not close browser proof',
        approvedBy: 'phase-05-review',
      },
    }),
    '--confirmation-json',
    JSON.stringify(cleanConfirmation),
    '--task-json',
    '{"taskType":"frontend"}',
    '--json',
  ]));

  assert.equal(criticalPlaywrightWaived.browserResult.status, 'failed');
  assert.equal(criticalPlaywrightWaived.browserResult.failedStage, 'playwright');
  assert.equal(criticalPlaywrightWaived.diagnostics.playwrightExempt, false);
  assert.equal(criticalPlaywrightWaived.browserPlane.status, 'failed');
});

test('browser completion result sanitizes raw command evidence and omits env', () => {
  const secret = 'sk_live_browser_result_123';
  const result = json(run([
    'scripts/verification-plane.mjs',
    'browser-result',
    '--run-id',
    'run-browser-result-redaction',
    '--goal-id',
    'goal-browser-result-redaction',
    '--scenario-id',
    'redaction',
    '--status',
    'clean_pass',
    '--failure-class',
    'none',
    '--evidence-depth',
    'open-act-mutate-persist-recover',
    '--commands-json',
    JSON.stringify([{
      command: `npx playwright test --key=${secret}`,
      stdout: `stdout ${secret}`,
      stderr: `stderr ${secret}`,
      env: { API_TOKEN: secret },
      exitCode: 0,
    }]),
    '--task-json',
    '{"taskType":"docs_only"}',
    '--json',
  ]));
  const serialized = JSON.stringify(result);

  assert.equal(serialized.includes(secret), false);
  assert.equal(result.browserResult.commands.some((command) => Object.hasOwn(command, 'env')), false);
  assert.equal(result.browserPlane.status, 'passed');
});

test('record-summary consumes task class and browser completion result as task-local blockers', async () => {
  const { env } = await makeEnv();
  json(run(['scripts/runtime-state.mjs', 'init', '--json'], env));

  const browserResult = {
    schemaVersion: 1,
    artifactId: 'BROWSER_COMPLETION_RESULT',
    runId: 'run-task-browser-summary',
    goalId: 'goal-task-browser-summary',
    scenarioId: 'critical-ui',
    status: 'clean_pass',
    failedStage: '',
    failureClass: 'none',
    evidenceDepth: 'smoke',
    sourceFingerprint: 'source-1',
    commands: [],
    artifacts: [],
    repairPromptPath: '',
    setupGap: false,
    completionAuthority: false,
    authoritySource: 'evidence_only',
    artifactSha256: '',
    generatedAt: new Date().toISOString(),
    producerCommand: 'node scripts/verification-plane.mjs browser-result',
    staleStatus: 'fresh',
    runtimeDecisionRef: '',
    redactionManifest: {},
    taskVerificationClass: null,
    criticalSmokeOnlyWarning: true,
  };

  const summary = json(run([
    'scripts/verification-plane.mjs',
    'record-summary',
    '--run-id',
    'run-task-browser-summary',
    '--goal-id',
    'goal-task-browser-summary',
    '--profile',
    'script_change',
    '--task-class-json',
    '{"taskType":"frontend"}',
    '--browser-result-json',
    JSON.stringify(browserResult),
    '--planes-json',
    JSON.stringify([
      { plane: 'unit', status: 'passed', command: 'npm test' },
      { plane: 'quality', status: 'passed', command: 'git diff --check' },
    ]),
    '--identity-json',
    '{"runLeaseId":"lease-task-browser"}',
    '--json',
  ], env));
  const assessed = json(run([
    'scripts/runtime-state.mjs',
    'assess-completion',
    '--run-id',
    'run-task-browser-summary',
    '--goal-id',
    'goal-task-browser-summary',
    '--json',
  ], env));
  const status = json(run([
    'scripts/runtime-state.mjs',
    'status',
    '--run-id',
    'run-task-browser-summary',
    '--goal-id',
    'goal-task-browser-summary',
    '--json',
  ], env));

  assert.equal(summary.requiredChecksPassed, false);
  assert.equal(summary.taskLocalCompletion.status, 'blocked');
  assert.equal(summary.taskEvidenceBlockers[0].code, 'browser_evidence_blocked');
  assert.equal(summary.evalResult.status, 'recorded');
  assert.equal(status.compactStatus.latestEval.status, 'failed');
  assert.equal(assessed.status, 'rejected');
  assert.equal(assessed.reason, 'missing verification plane: package');
});

test('record-summary consumes spec-test obligation failures as task-local blockers', async () => {
  const { env } = await makeEnv();
  json(run(['scripts/runtime-state.mjs', 'init', '--json'], env));

  const summary = json(run([
    'scripts/verification-plane.mjs',
    'record-summary',
    '--run-id',
    'run-spec-obligation-fail',
    '--goal-id',
    'goal-spec-obligation-fail',
    '--profile',
    'script_change',
    '--task-class-json',
    '{"taskType":"docs_only"}',
    '--planes-json',
    JSON.stringify([
      { plane: 'unit', status: 'passed', command: 'npm test' },
      { plane: 'quality', status: 'passed', command: 'git diff --check' },
    ]),
    '--spec-test-obligations-json',
    JSON.stringify({
      status: 'fail',
      summary: { requiredItemCount: 2, obligationCount: 1, findingCount: 1 },
      findings: [
        {
          class: 'spec_test_obligation_missing',
          id: 'REQ-002',
          severity: 'blocking',
          message: 'REQ-002 has no specTestObligations row',
        },
      ],
    }),
    '--identity-json',
    '{"runLeaseId":"lease-spec-obligation"}',
    '--json',
  ], env));
  const assessed = json(run([
    'scripts/runtime-state.mjs',
    'assess-completion',
    '--run-id',
    'run-spec-obligation-fail',
    '--goal-id',
    'goal-spec-obligation-fail',
    '--json',
  ], env));

  assert.equal(summary.requiredChecksPassed, false);
  assert.equal(summary.specTestObligations.status, 'fail');
  assert.equal(summary.taskEvidenceBlockers[0].code, 'spec_test_obligation_missing');
  assert.match(summary.taskEvidenceBlockers[0].reason, /REQ-002/);
  assert.equal(assessed.status, 'rejected');
  assert.match(assessed.reason, /REQ-002/);
});

test('phase closeout fails closed when spec-test obligation result is missing', async () => {
  const { env } = await makeEnv();
  json(run(['scripts/runtime-state.mjs', 'init', '--json'], env));

  const summary = json(run([
    'scripts/verification-plane.mjs',
    'record-summary',
    '--run-id',
    'run-spec-obligation-missing-result',
    '--goal-id',
    'goal-spec-obligation-missing-result',
    '--profile',
    'script_change',
    '--task-class-json',
    '{"taskType":"docs_only"}',
    '--planes-json',
    JSON.stringify([
      { plane: 'unit', status: 'passed', command: 'npm test' },
      { plane: 'quality', status: 'passed', command: 'git diff --check' },
    ]),
    '--phase-closeout',
    'true',
    '--identity-json',
    '{"runLeaseId":"lease-spec-obligation-missing-result"}',
    '--json',
  ], env));
  const assessed = json(run([
    'scripts/runtime-state.mjs',
    'assess-completion',
    '--run-id',
    'run-spec-obligation-missing-result',
    '--goal-id',
    'goal-spec-obligation-missing-result',
    '--json',
  ], env));

  assert.equal(summary.requiredChecksPassed, false);
  assert.equal(summary.specTestObligations, null);
  assert.equal(summary.taskEvidenceBlockers[0].code, 'spec_test_obligation_result_missing');
  assert.match(summary.taskEvidenceBlockers[0].reason, /validator result is required/);
  assert.equal(assessed.status, 'rejected');
  assert.match(assessed.reason, /spec-test obligation validator result is required/);
});

test('record-summary fails closed without task class and browser result overrides forged passed browser plane', async () => {
  const { env } = await makeEnv();
  json(run(['scripts/runtime-state.mjs', 'init', '--json'], env));

  const noTaskClass = json(run([
    'scripts/verification-plane.mjs',
    'record-summary',
    '--run-id',
    'run-no-task-class',
    '--goal-id',
    'goal-no-task-class',
    '--planes-json',
    JSON.stringify(fullPassingPlanes()),
    '--identity-json',
    '{"runLeaseId":"lease-no-task-class"}',
    '--json',
  ], env));

  assert.equal(noTaskClass.taskVerificationClass.status, 'needs_classification');
  assert.equal(noTaskClass.requiredChecksPassed, false);
  assert.equal(noTaskClass.taskEvidenceBlockers[0].code, 'needs_classification');
  assert.equal(noTaskClass.wholePlanAuthority.status, 'evidence_eligible');

  const browserResult = {
    schemaVersion: 1,
    artifactId: 'BROWSER_COMPLETION_RESULT',
    runId: 'run-forged-browser-plane',
    goalId: 'goal-forged-browser-plane',
    scenarioId: 'critical-ui',
    status: 'clean_pass',
    failedStage: '',
    failureClass: 'none',
    evidenceDepth: 'smoke',
    sourceFingerprint: 'source-1',
    commands: [],
    artifacts: [],
    repairPromptPath: '',
    setupGap: false,
    completionAuthority: false,
    authoritySource: 'evidence_only',
    artifactSha256: '',
    generatedAt: new Date().toISOString(),
    producerCommand: 'node scripts/verification-plane.mjs browser-result',
    staleStatus: 'fresh',
    runtimeDecisionRef: '',
    redactionManifest: {},
    taskVerificationClass: null,
    criticalSmokeOnlyWarning: true,
  };
  const forgedPlane = json(run([
    'scripts/verification-plane.mjs',
    'record-summary',
    '--run-id',
    'run-forged-browser-plane',
    '--goal-id',
    'goal-forged-browser-plane',
    '--task-class-json',
    '{"taskType":"frontend"}',
    '--browser-result-json',
    JSON.stringify(browserResult),
    '--planes-json',
    JSON.stringify(fullPassingPlanes()),
    '--identity-json',
    '{"runLeaseId":"lease-forged-browser-plane"}',
    '--json',
  ], env));

  assert.equal(forgedPlane.requiredChecksPassed, false);
  assert.equal(forgedPlane.planes.find((plane) => plane.plane === 'browser').status, 'blocked');
  assert.equal(forgedPlane.taskEvidenceBlockers[0].code, 'browser_evidence_blocked');
  assert.equal(forgedPlane.wholePlanAuthority.status, 'blocked');
  assert.match(forgedPlane.wholePlanAuthority.reason, /failed verification plane: browser/);
});

test('package contract excludes generated verification traces and includes verification plane helper', async () => {
  const contract = await readFile(path.join(root, 'package', 'package-contract.yaml'), 'utf8');
  const packageTest = await readFile(path.join(root, 'tests', 'package-materialization.test.ts'), 'utf8');

  assert.match(contract, /source: scripts\/verification-plane\.mjs/);
  assert.match(contract, /source: scripts\/lib\/verification-plane\.mjs/);
  assert.match(contract, /\.moonshot-relay\/browser-artifacts\/\*\*/);
  assert.match(contract, /\.moonshot-relay\/verification-reports\/\*\*/);
  assert.match(packageTest, /scripts\/verification-plane\.mjs/);
  assert.match(packageTest, /scripts\/lib\/verification-plane\.mjs/);
});

test('record-summary requires review critique loop receipt for browser completion claims', async () => {
  const { env } = await makeEnv();
  json(run(['scripts/runtime-state.mjs', 'init', '--json'], env));
  const identity = {
    runLeaseId: 'lease-review-loop',
    candidate_id: `cand_${'a'.repeat(32)}`,
    sourceDigest: 'b'.repeat(64),
    bundleDigest: 'c'.repeat(64),
  };
  const passingSpecTestObligations = {
    schemaVersion: 1,
    status: 'pass',
    summary: { requiredItemCount: 0, obligationCount: 0, findingCount: 0 },
    items: [],
    obligations: [],
    findings: [],
  };

  const missingReview = json(run([
    'scripts/verification-plane.mjs',
    'record-summary',
    '--run-id',
    'run-review-loop-missing',
    '--goal-id',
    'goal-review-loop-missing',
    '--planes-json',
    JSON.stringify(fullPassingPlanes()),
    '--task-class-json',
    '{"taskType":"frontend"}',
    '--identity-json',
    JSON.stringify(identity),
    '--json',
  ], env));
  const missingAssessed = json(run([
    'scripts/runtime-state.mjs',
    'assess-completion',
    '--run-id',
    'run-review-loop-missing',
    '--goal-id',
    'goal-review-loop-missing',
    '--json',
  ], env));

  assert.equal(missingReview.requiredChecksPassed, false);
  assert.equal(missingReview.taskEvidenceBlockers.some((blocker) => blocker.code === 'review_critique_loop_missing'), true);
  assert.equal(missingAssessed.status, 'rejected');
  assert.match(missingAssessed.reason, /missing browser completion result/);

  const receipt = buildReviewCritiqueLoopReceipt({
    candidate_id: identity.candidate_id,
    sourceDigest: identity.sourceDigest,
    bundleDigest: identity.bundleDigest,
    iterations: [
      {
        reviewers: [
          { reviewerId: 'agent-a', focus: 'requirements_contract' },
          { reviewerId: 'agent-b', focus: 'runtime_authority' },
        ],
      },
      {
        reviewers: [
          { reviewerId: 'agent-c', focus: 'regression_risk' },
          { reviewerId: 'agent-d', focus: 'security_or_data_safety' },
        ],
      },
    ],
    parentResolutions: [
      { findingId: 'finding-1', status: 'accepted', evidence: 'fixed', blockerId: '' },
      { findingId: 'finding-2', status: 'rejected_with_evidence', evidence: 'covered by test', blockerId: '' },
    ],
  });
  const browserResult = {
    schemaVersion: 1,
    artifactId: 'BROWSER_COMPLETION_RESULT',
    runId: 'run-review-loop-present',
    goalId: 'goal-review-loop-present',
    scenarioId: 'critical-ui',
    status: 'clean_pass',
    failedStage: '',
    failureClass: 'none',
    evidenceDepth: 'open-act-mutate-persist-recover',
    sourceFingerprint: identity.sourceDigest,
    commands: [],
    artifacts: [{ type: 'trace', path: '.moonshot-relay/browser-artifacts/run/goal/critical-ui/trace.zip' }],
    repairPromptPath: '',
    setupGap: false,
    completionAuthority: false,
    authoritySource: 'evidence_only',
    artifactSha256: '',
    generatedAt: new Date().toISOString(),
    producerCommand: 'node scripts/verification-plane.mjs normalize-browser-confirmation',
    staleStatus: 'fresh',
    runtimeDecisionRef: '',
    redactionManifest: {},
    taskVerificationClass: null,
    criticalSmokeOnlyWarning: false,
  };

  const acceptedReview = json(run([
    'scripts/verification-plane.mjs',
    'record-summary',
    '--run-id',
    'run-review-loop-present',
    '--goal-id',
    'goal-review-loop-present',
    '--planes-json',
    JSON.stringify(fullPassingPlanes()),
    '--task-class-json',
    '{"taskType":"frontend"}',
    '--browser-result-json',
    JSON.stringify(browserResult),
    '--identity-json',
    JSON.stringify(identity),
    '--review-critique-loop-json',
    JSON.stringify(receipt),
    '--json',
  ], env));
  const acceptedAssessed = json(run([
    'scripts/runtime-state.mjs',
    'assess-completion',
    '--run-id',
    'run-review-loop-present',
    '--goal-id',
    'goal-review-loop-present',
    '--json',
  ], env));

  assert.equal(acceptedReview.requiredChecksPassed, true);
  assert.equal(acceptedReview.reviewCritiqueLoopRequired, true);
  assert.equal(acceptedAssessed.status, 'accepted');

  const mismatchedReview = json(run([
    'scripts/verification-plane.mjs',
    'record-summary',
    '--run-id',
    'run-review-loop-mismatch',
    '--goal-id',
    'goal-review-loop-mismatch',
    '--planes-json',
    JSON.stringify(fullPassingPlanes()),
    '--task-class-json',
    '{"taskType":"frontend"}',
    '--browser-result-json',
    JSON.stringify({ ...browserResult, runId: 'run-review-loop-mismatch', goalId: 'goal-review-loop-mismatch' }),
    '--identity-json',
    JSON.stringify({ ...identity, sourceDigest: 'e'.repeat(64) }),
    '--review-critique-loop-json',
    JSON.stringify(receipt),
    '--json',
  ], env));

  assert.equal(mismatchedReview.requiredChecksPassed, false);
  assert.equal(mismatchedReview.taskEvidenceBlockers.some((blocker) => blocker.code === 'review_critique_loop_source_mismatch'), true);

  const docsOnlyCompletionClaim = json(run([
    'scripts/verification-plane.mjs',
    'record-summary',
    '--run-id',
    'run-docs-only-completion-claim',
    '--goal-id',
    'goal-docs-only-completion-claim',
    '--planes-json',
    JSON.stringify(fullPassingPlanes()),
    '--task-class-json',
    '{"taskType":"docs_only"}',
    '--identity-json',
    JSON.stringify({ ...identity, runLeaseId: 'lease-docs-only-completion' }),
    '--completion-claim',
    'true',
    '--spec-test-obligations-json',
    JSON.stringify(passingSpecTestObligations),
    '--json',
  ], env));
  const docsOnlyAssessed = json(run([
    'scripts/runtime-state.mjs',
    'assess-completion',
    '--run-id',
    'run-docs-only-completion-claim',
    '--goal-id',
    'goal-docs-only-completion-claim',
    '--json',
  ], env));

  assert.equal(docsOnlyCompletionClaim.requiredChecksPassed, false);
  assert.equal(docsOnlyCompletionClaim.reviewCritiqueLoopRequired, true);
  assert.equal(docsOnlyAssessed.status, 'rejected');
  assert.match(docsOnlyAssessed.reason, /missing review-critique-loop receipt/);

  const contaminatedReceipt = {
    ...receipt,
    rawPrompt: 'DO_NOT_STORE_RAW_PROMPT',
  };
  const contaminated = json(run([
    'scripts/verification-plane.mjs',
    'record-summary',
    '--run-id',
    'run-review-loop-contaminated',
    '--goal-id',
    'goal-review-loop-contaminated',
    '--planes-json',
    JSON.stringify(fullPassingPlanes()),
    '--task-class-json',
    '{"taskType":"docs_only"}',
    '--identity-json',
    JSON.stringify({ ...identity, runLeaseId: 'lease-review-loop-contaminated', completionClaim: true }),
    '--spec-test-obligations-json',
    JSON.stringify(passingSpecTestObligations),
    '--review-critique-loop-json',
    JSON.stringify(contaminatedReceipt),
    '--json',
  ], env));

  assert.equal(contaminated.requiredChecksPassed, false);
  assert.equal(contaminated.taskEvidenceBlockers.some((blocker) => blocker.code === 'review_critique_loop_forbidden_context'), true);
  assert.equal(JSON.stringify(contaminated).includes('DO_NOT_STORE_RAW_PROMPT'), false);
});
