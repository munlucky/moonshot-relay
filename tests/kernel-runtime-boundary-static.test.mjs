import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ACTIVE_EXECUTION_FILES, auditActiveRuntimeBoundary } from '../scripts/kernel/runtime-boundary-audit.mjs';
import {
  HOST_EXECUTION_CONTRACT_SCHEMA_VERSION,
  admitHostExecutionContract,
  buildHostExecutionContract,
  validateHostExecutionContract,
} from '../scripts/kernel/run/host-execution-contract.mjs';
import {
  HOST_EXECUTION_ORDER,
  normalizeHostBoundaryRequest,
} from '../scripts/host/kernel/host-boundary.mjs';

const collectFiles = async (dir, ext = '.mjs') => {
  const result = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      result.push(...await collectFiles(fullPath, ext));
    } else if (entry.isFile() && (ext ? fullPath.endsWith(ext) : true)) {
      result.push(fullPath);
    }
  }
  return result;
};

test('Static boundary: No production file imports deleted legacy launchers', async () => {
  const productionDirs = [
    path.resolve('scripts/kernel'),
    path.resolve('scripts/switcher'),
    path.resolve('scripts/host'),
    path.resolve('bin'),
  ];
  const forbiddenPatterns = [
    /codex-cli-launcher/i,
    /codex-runtime/i,
    /codex-profile-materializer/i,
    /codex-review-host/i,
    /moon-relay-kernel-host/i,
  ];

  for (const dir of productionDirs) {
    const files = await collectFiles(dir);
    for (const file of files) {
      const content = await readFile(file, 'utf8');
      for (const pattern of forbiddenPatterns) {
        assert.equal(
          pattern.test(content),
          false,
          `Forbidden legacy launcher reference matched in production file ${file}: ${pattern}`,
        );
      }
    }
  }
});

test('Static boundary: No production file contains forbidden legacy vocabulary strings', async () => {
  const productionDirs = [
    path.resolve('scripts/kernel'),
    path.resolve('scripts/switcher'),
    path.resolve('scripts/host'),
    path.resolve('bin'),
  ];
  const forbiddenStrings = [
    'relaunch-through-kernel-host',
    'shared-host-dispatch',
    'profile-and-data-root',
  ];

  for (const dir of productionDirs) {
    const files = await collectFiles(dir);
    for (const file of files) {
      const content = await readFile(file, 'utf8');
      for (const str of forbiddenStrings) {
        assert.equal(
          content.includes(str),
          false,
          `Forbidden legacy string '${str}' found in production file ${file}`,
        );
      }
    }
  }
});

test('Static boundary: Active Kernel surfaces cannot reintroduce retired runtime paths', async () => {
  const audit = await auditActiveRuntimeBoundary({ repoRoot: path.resolve('.') });
  assert.equal(audit.status, 'pass', JSON.stringify(audit.findings, null, 2));
  for (const file of ACTIVE_EXECUTION_FILES) assert.ok(audit.scannedFiles.includes(file), `${file} must be audited as a reachable execution target`);
  assert.ok(audit.migrationOnlyFiles.includes('scripts/install-account-root-harness.mjs'));
});

test('Static boundary: Reachable local helpers are included in active execution audit', async () => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'kernel-boundary-closure-'));
  try {
    await mkdir(path.join(fixtureRoot, 'scripts'), { recursive: true });
    await writeFile(path.join(fixtureRoot, 'scripts', 'delivery-submit.mjs'), "import(/* comment before specifier */ './reachable-helper.mjs');\n", 'utf8');
    await writeFile(path.join(fixtureRoot, 'scripts', 'reachable-helper.mjs'), "export const marker = 'MOONSHOT_RELAY_HOME';\n", 'utf8');
    const audit = await auditActiveRuntimeBoundary({ repoRoot: fixtureRoot });
    assert.equal(audit.status, 'fail');
    assert.ok(audit.scannedFiles.includes('scripts/reachable-helper.mjs'));
    assert.ok(audit.findings.some((finding) => finding.file === 'scripts/reachable-helper.mjs' && finding.code === 'active-runtime-relay-home-interactive'));
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test('Static boundary: Symlinked reachable helpers outside the repository fail closed', async () => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'kernel-boundary-symlink-'));
  const externalRoot = await mkdtemp(path.join(os.tmpdir(), 'kernel-boundary-external-'));
  try {
    await mkdir(path.join(fixtureRoot, 'scripts'), { recursive: true });
    await writeFile(path.join(fixtureRoot, 'scripts', 'delivery-submit.mjs'), "import './linked/helper.mjs';\n", 'utf8');
    await writeFile(path.join(externalRoot, 'helper.mjs'), "export const marker = 'MOONSHOT_RELAY_HOME';\n", 'utf8');
    await symlink(externalRoot, path.join(fixtureRoot, 'scripts', 'linked'), 'junction');

    const audit = await auditActiveRuntimeBoundary({ repoRoot: fixtureRoot });
    assert.equal(audit.status, 'fail', JSON.stringify(audit, null, 2));
    assert.ok(audit.findings.some((finding) => finding.code === 'active-runtime-import-outside-repo'));
    assert.equal(audit.scannedFiles.some((file) => file.includes('kernel-boundary-external-')), false);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
    await rm(externalRoot, { recursive: true, force: true });
  }
});

test('Static boundary: Host boundary manifest declares the six Host execution concerns', async () => {
  const manifest = await readFile(path.resolve('kernel/host-boundary.yaml'), 'utf8');
  for (const concern of ['provider', 'model', 'reasoning-effort', 'session', 'worktree', 'git', 'prompt-envelope', 'prompt-cache', 'package-materialization', 'account-profile-projection']) {
    assert.match(manifest, new RegExp(`^  - ${concern.replace('-', '\\-')}$`, 'm'));
  }
  assert.deepEqual(HOST_EXECUTION_ORDER, [
    'model/provider-policy',
    'prompt-envelope/cache',
    'session-execution',
    'worktree',
    'git',
    'package/profile',
  ]);
});

test('Static boundary: Kernel emits a provider-neutral HostExecutionContract', () => {
  const contract = buildHostExecutionContract({
    decision: {
      runId: 'run-boundary',
      decisionId: 'route-000000000000000000000000',
      actionKind: 'implement',
      role: 'implementer',
      permissions: 'workspace_write',
      executionClass: 'complex_implementation',
      workProfile: { executionClass: 'complex_implementation', complexity: 'complex', independentContextRequired: false },
    },
    assignment: {
      executionMode: 'owner-direct',
      delegation: { mode: 'optional', requested: false },
      freshSessionRequired: false,
    },
    workUnit: { objective: 'bounded change', allowedPaths: ['src/'], forbiddenPaths: ['.env'] },
  });
  assert.equal(contract.schemaVersion, HOST_EXECUTION_CONTRACT_SCHEMA_VERSION);
  assert.equal(contract.executionClass, 'complex_implementation');
  assert.equal(contract.workUnit.objective, 'bounded change');
  for (const forbidden of ['provider', 'model', 'effort', 'sessionId', 'worktreeRoot', 'gitState', 'cacheKey']) {
    assert.equal(Object.hasOwn(contract, forbidden), false, `${forbidden} must stay Host-owned`);
    assert.equal(JSON.stringify(contract).includes(`\"${forbidden}\"`), false, `${forbidden} must stay Host-owned`);
  }
  assert.equal(validateHostExecutionContract(contract), contract);
});


test('W-04: HostExecutionContract v2 expresses semantic requirements without provider details', () => {
  const contract = buildHostExecutionContract({
    decision: {
      runId: 'run-semantic',
      decisionId: 'route-semantic-000000000000',
      actionKind: 'review_engineering',
      role: 'reviewer',
      permissions: 'read_only',
      executionClass: 'review',
      independentContextRequired: true,
      workProfile: { executionClass: 'review', complexity: 'complex', independentContextRequired: true },
    },
    assignment: {
      executionMode: 'independent-review',
      delegation: { mode: 'required', requested: true },
      freshSessionRequired: true,
      workProfile: { parallelizable: false },
    },
    workUnit: { objective: 'review bounded subject', allowedPaths: ['src/'] },
  });
  assert.equal(contract.schemaVersion, 2);
  assert.deepEqual(contract.requirements, {
    freshContext: true,
    workspaceWrite: false,
    workspaceIsolation: false,
    parallelExecution: false,
    independentReview: true,
    modelSelection: false,
  });
  assert.doesNotMatch(JSON.stringify(contract.requirements), /codex|claude|gemini|gpt|opus|modelId/i);

  const blocked = admitHostExecutionContract(contract, {
    semantic: { freshContext: true, independentReview: false, modelSelection: false },
  });
  assert.equal(blocked.decision, 'blocked');
  assert.deepEqual(blocked.missingCapabilities, ['independentReview']);

  const admitted = admitHostExecutionContract(contract, {
    semantic: { freshContext: true, independentReview: true, modelSelection: false },
  });
  assert.equal(admitted.decision, 'admitted');
  assert.deepEqual(admitted.missingCapabilities, []);
});

test('Static boundary: Host validates the boundary before it accepts a directive', () => {
  const directive = {
    modelRouteDecision: {
      runId: 'run-boundary',
      decisionId: 'route-111111111111111111111111',
      actionKind: 'implement',
      role: 'implementer',
      permissions: 'workspace_write',
      executionClass: 'standard',
      workProfile: { executionClass: 'standard', complexity: 'standard' },
    },
    executionAssignment: { executionMode: 'owner-direct', delegation: { mode: 'optional', requested: false } },
  };
  const normalized = normalizeHostBoundaryRequest({
    modelInput: { action: { step: { stepId: 'step-boundary' } } },
    hostDirective: directive,
  });
  assert.equal(normalized.contract.executionClass, 'standard');
  assert.throws(
    () => validateHostExecutionContract({ ...normalized.contract, model: 'gpt-6-astra' }),
    /host_execution_contract_provider_field/,
  );
});


test('Wave 4: session bindings are Host access handles and never a Work identity selector', async () => {
  const store = await readFile(path.resolve('scripts/kernel/state-store.mjs'), 'utf8');
  const resolver = await readFile(path.resolve('scripts/kernel/run/invocation-resolver.mjs'), 'utf8');
  const controlPlane = await readFile(path.resolve('scripts/kernel/control-plane.mjs'), 'utf8');

  assert.equal(store.includes('getActiveSessionBinding('), false);
  assert.equal(store.includes('preserveSessionId'), false);
  assert.equal(store.includes('incrementReplanCount('), false);
  assert.equal(resolver.includes('getActiveOwnerBinding'), false);
  assert.equal(controlPlane.includes('binding?.runId'), false);
  assert.equal(controlPlane.includes('signalReplan('), false);
  assert.match(controlPlane, /getActiveRunBinding/);
});

test('Wave 9: Route admission policy is Host-owned and Kernel keeps only provider-neutral receipt semantics', async () => {
  const kernelAdmission = await readFile(path.resolve('scripts/kernel/routing/route-admission.mjs'), 'utf8');
  const hostAdmission = await readFile(path.resolve('scripts/host/kernel/route-admission.mjs'), 'utf8');

  for (const forbidden of [
    'supportsSubagentModel',
    'supportsSessionModelOverride',
    'estimatedCostUnits',
    'REVIEW_NOT_FRONTIER',
    'configured-frontier',
  ]) {
    assert.equal(kernelAdmission.includes(forbidden), false, `${forbidden} must stay Host-owned`);
  }
  assert.match(kernelAdmission, /admissionAllowsDispatch/);
  assert.match(hostAdmission, /export const admitRoute/);
  assert.match(hostAdmission, /export const policyDigests/);
  assert.match(hostAdmission, /revalidateAdmissionAtDispatch/);
});

test('Wave 16: Host turn/routing orchestration is not reintroduced into the Kernel Control Plane', async () => {
  const controlPlane = await readFile(path.resolve('scripts/kernel/control-plane.mjs'), 'utf8');
  const hostTurn = await readFile(path.resolve('scripts/host/kernel/host-turn.mjs'), 'utf8');
  const hostRouting = await readFile(path.resolve('scripts/host/kernel/host-routing.mjs'), 'utf8');

  for (const forbidden of [
    'async hostNext(',
    'async decideModelRoute(',
    'recommendRouting(runId',
    'createHostRoutingBridge',
  ]) {
    assert.equal(controlPlane.includes(forbidden), false, `${forbidden} must remain Host-owned`);
  }
  assert.match(hostTurn, /export const prepareHostTurn/);
  assert.match(hostRouting, /export const createHostRoutingBridge/);
});

test('Wave 17: workspace mutation fencing has one canonical lock authority', async () => {
  const store = await readFile(path.resolve('scripts/kernel/state-store.mjs'), 'utf8');
  const guard = await readFile(path.resolve('scripts/kernel/run/mutation-guard.mjs'), 'utf8');

  assert.equal(store.includes('CREATE TABLE IF NOT EXISTS workspace_mutation_locks ('), false);
  for (const forbidden of [
    'acquireWorkspaceMutationLock({',
    'getWorkspaceMutationLock(projectId)',
    'releaseWorkspaceMutationLock({',
    'renewWorkspaceMutationLock({',
  ]) {
    assert.equal(store.includes(forbidden), false, `${forbidden} is a retired project-wide lock API`);
  }
  assert.match(store, /workspace_mutation_locks_v2/);
  assert.match(guard, /getWorkspaceMutationLockV2/);
  assert.equal(guard.includes('getWorkspaceMutationLock(run.projectId)'), false);
});

test('Wave 18: canonical Work Attempt is the only durable attempt authority', async () => {
  const store = await readFile(path.resolve('scripts/kernel/state-store.mjs'), 'utf8');
  const controlPlane = await readFile(path.resolve('scripts/kernel/control-plane.mjs'), 'utf8');
  const hostRouting = await readFile(path.resolve('scripts/host/kernel/host-routing.mjs'), 'utf8');

  assert.equal(store.includes('CREATE TABLE IF NOT EXISTS attempts ('), false);
  for (const forbidden of ['recordAttempt(', 'getAttempts(', 'nextAttemptNumber(', 'finishAttempt(']) {
    assert.equal(store.includes(forbidden), false, `${forbidden} is a retired run-level attempt API`);
    assert.equal(controlPlane.includes(forbidden), false, `${forbidden} must not be reintroduced in Control Plane`);
    assert.equal(hostRouting.includes(forbidden), false, `${forbidden} must not be reintroduced in Host routing`);
  }
  assert.match(store, /CREATE TABLE IF NOT EXISTS run_step_attempts/);
  assert.match(store, /getStepAttempts\(runId/);
  assert.match(hostRouting, /getStepAttempts\(runId\)/);
});
