import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { loadStandaloneCatalog, validateStandaloneCatalog } from '../scripts/kernel/standalone/catalog.mjs';
import { admitKernelMutation, matchesCurrentMutationCandidate, resolveKernelCloseoutRun } from '../scripts/kernel/standalone/kernel-commit.mjs';
import { buildTaskContractSeed, assertCurrentSeed } from '../scripts/kernel/standalone/prework.mjs';
import { normalizeTaskContract } from '../scripts/kernel/task/task-contract.mjs';
import { resolveDomainPolicies } from '../scripts/kernel/proof/domain-policy.mjs';
import { runUnificationAudit } from '../scripts/kernel/unification-audit.mjs';
import { resolveStableWorkspaceIdentity } from '../scripts/kernel/run/workspace-registration.mjs';
import { observeWorkspaceIdentity } from '../scripts/kernel/run/workspace-identity.mjs';

const root = process.cwd();
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

test('standalone catalog is the validated membership and side-effect authority', async () => {
  const catalog = await loadStandaloneCatalog({ repoRoot: root, validateSources: true });
  assert.equal(catalog.schemaVersion, 2);
  assert.ok(catalog.skills.some((entry) => entry.name === 'explain-diff-html'));
  assert.ok(catalog.skills.every((entry) => entry.requiresKernelRun === false));
  assert.ok(catalog.skills.every((entry) => entry.mayMutateSource === false));
  const invalid = validateStandaloneCatalog({ schemaVersion: 2, skills: [{ name: 'bad', kind: 'project-utility', skillPath: 'skills/bad', entrypoint: 'scripts/bad.mjs', exportName: 'run', requiresKernelRun: false, mayMutateSource: true, mayMutateGit: false, mayMutateKnowledge: false, mayWriteArtifacts: true, cli: { enabled: false } }] });
  assert.equal(invalid.status, 'fail');
  assert.ok(invalid.findings.some((finding) => finding.code === 'source_mutation_without_kernel'));
});

test('pre-work seed is provenance and stale objective fails Kernel normalization', () => {
  const seed = buildTaskContractSeed({
    utility: 'product-definition',
    projectId: 'fixture-project',
    objective: 'Keep PostgreSQL',
    artifactDigest: 'sha256:' + 'a'.repeat(64),
    referencedArtifacts: [{ path: 'PRD.md', digest: 'sha256:' + 'b'.repeat(64) }],
  });
  assert.equal(assertCurrentSeed(seed, { objective: 'Keep PostgreSQL' }).seedDigest, seed.seedDigest);
  assert.throws(() => normalizeTaskContract({ objective: 'Use MySQL', taskContractSeed: seed, acceptance: ['works'] }, { objective: 'Use MySQL' }), (error) => error.code === 'STALE_TASK_CONTRACT_SEED');
  const contract = normalizeTaskContract({ objective: 'Keep PostgreSQL', taskContractSeed: seed, acceptance: ['works'] }, { objective: 'Keep PostgreSQL' });
  assert.equal(contract.seedProvenance.authority, 'prework-only');
  assert.equal(contract.seedProvenance.seedDigest, seed.seedDigest);
});

test('domain guidance activates frontend/browser/security conditions without creating a new authority', () => {
  const policies = resolveDomainPolicies({
    objective: 'Add auth form and preserve state after reload',
    changedPaths: ['src/Login.tsx'],
    acceptance: ['user can log in and the session persists after reload'],
    requiredVerifications: [{ commandRef: 'test:browser-login' }],
    taskClass: 'ui',
    flags: { securityBoundary: true },
  });
  assert.equal(policies.frontend.active, true);
  assert.equal(policies.browser.required, true);
  assert.equal(policies.browser.minimumDepth, 'open-act-mutate-persist-recover');
  assert.equal(policies.security.independentReviewRequired, true);
  assert.equal(policies.security.authority, 'kernel-review-policy');
});

test('kernel commit admission rejects unknown, foreign, and drifted provenance', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'moon-relay-kernel-admission-'));
  try {
    git(temp, ['init', '-q']);
    git(temp, ['config', 'user.email', 'kernel@test.invalid']);
    git(temp, ['config', 'user.name', 'Kernel Test']);
    await writeFile(path.join(temp, 'app.txt'), 'base\n', 'utf8');
    git(temp, ['add', 'app.txt']);
    git(temp, ['commit', '-qm', 'base']);
    await writeFile(path.join(temp, 'app.txt'), 'kernel mutation\n', 'utf8');
    const project = { projectId: 'fixture-project', projectRoot: temp };
    const workspaceIdentity = observeWorkspaceIdentity({ projectRoot: temp }).identity;
    const stable = resolveStableWorkspaceIdentity({ projectId: project.projectId, workspaceRoot: temp });
    const sourceIdentity = 'sha256:' + 'c'.repeat(64);
    const run = { runId: 'run-valid', projectId: project.projectId, workspaceId: stable.workspaceId, worktreeId: 'worktree-fixture', status: 'completed', currentState: 'CLOSE', finalizationStatus: 'completed', mutationRevision: 1, sourceIdentity, currentWorkspaceIdentity: workspaceIdentity };
    const completion = { runId: run.runId, decision: 'accepted', sourceIdentity, mutationRevision: 1 };
    const provenance = { runId: run.runId, projectId: project.projectId, workspaceId: stable.workspaceId, sourceIdentity, mutationRevision: 1, changedPaths: ['app.txt'], workspaceIdentity, mutationDigest: 'sha256:' + 'd'.repeat(64), status: 'passed' };
    const stateStore = {
      registerProjectWorkspace: () => ({ workspaceId: stable.workspaceId }),
      getRun: (runId) => runId === run.runId ? run : null,
      listRuns: () => [run],
      getCompletionDecision: () => completion,
      getMutationProvenance: () => provenance,
      getLatestImplementationAttempt: () => null,
    };
    assert.equal(admitKernelMutation({ stateStore, project, statusEntries: [{ status: ' M', path: 'app.txt' }], selected: ['app.txt'], runId: run.runId }).run.runId, run.runId);
    assert.throws(() => resolveKernelCloseoutRun({ stateStore, projectId: project.projectId, workspaceId: stable.workspaceId, runId: 'unknown' }), (error) => error.code === 'UNKNOWN_RUN_ID');

    // Auto-discovery requires exact mutation provenance and rejects ambiguity.
    const olderRun = { ...run, runId: 'run-older', completedAt: '2026-09-05T00:00:00.000Z' };
    const newerRun = { ...run, runId: 'run-newer', completedAt: '2026-09-01T00:00:00.000Z' };
    const provenanceFor = (id) => ({ ...provenance, runId: id });
    const multiStateStore = {
      ...stateStore,
      getRun: (id) => (id === 'run-older' ? olderRun : id === 'run-newer' ? newerRun : null),
      listRuns: () => [olderRun, newerRun],
      getCompletionDecision: (id) => ({ runId: id, decision: 'accepted', sourceIdentity }),
      getMutationProvenance: (id) => provenanceFor(id),
    };
    assert.throws(() => resolveKernelCloseoutRun({ stateStore: multiStateStore, projectId: project.projectId, workspaceId: stable.workspaceId }), (error) => error.code === 'RUN_PROVENANCE_AMBIGUOUS');
    // Test: 2 completed runs in DB, both match exact provenance -> RUN_PROVENANCE_AMBIGUOUS fail closed
    assert.throws(() => resolveKernelCloseoutRun({
      stateStore: multiStateStore,
      projectId: project.projectId,
      workspaceId: stable.workspaceId,
      currentWorkspaceIdentity: workspaceIdentity,
      currentPaths: ['app.txt'],
      selectedPaths: ['app.txt'],
    }), (error) => error.code === 'RUN_PROVENANCE_AMBIGUOUS');

    // Test: 2 completed runs in DB, Run A matches current workspace identity/paths, Run B has older workspace identity -> Run A is selected cleanly
    const runA = { ...run, runId: 'run-a', currentWorkspaceIdentity: workspaceIdentity };
    const runB = { ...run, runId: 'run-b', currentWorkspaceIdentity: 'sha256:' + 'e'.repeat(64) };
    const provenanceA = { ...provenance, runId: 'run-a', workspaceIdentity };
    const provenanceB = { ...provenance, runId: 'run-b', workspaceIdentity: 'sha256:' + 'e'.repeat(64) };
    const twoRunsStore = {
      ...stateStore,
      getRun: (id) => (id === 'run-a' ? runA : id === 'run-b' ? runB : null),
      listRuns: () => [runB, runA],
      getCompletionDecision: (id) => ({ runId: id, decision: 'accepted', sourceIdentity }),
      getMutationProvenance: (id) => (id === 'run-a' ? provenanceA : id === 'run-b' ? provenanceB : null),
    };
    const resolvedRunA = resolveKernelCloseoutRun({
      stateStore: twoRunsStore,
      projectId: project.projectId,
      workspaceId: stable.workspaceId,
      currentWorkspaceIdentity: workspaceIdentity,
      currentPaths: ['app.txt'],
      selectedPaths: ['app.txt'],
    });
    assert.equal(resolvedRunA.run.runId, 'run-a');

    // Test: selected path outside provenance -> fail closed
    assert.throws(() => resolveKernelCloseoutRun({
      stateStore: twoRunsStore,
      projectId: project.projectId,
      workspaceId: stable.workspaceId,
      currentWorkspaceIdentity: workspaceIdentity,
      currentPaths: ['app.txt'],
      selectedPaths: ['outside.txt'],
    }), (error) => error.code === 'RUN_PROVENANCE_REQUIRED');

    const uniqueStateStore = { ...multiStateStore, listRuns: () => [olderRun] };
    assert.equal(resolveKernelCloseoutRun({ stateStore: uniqueStateStore, projectId: project.projectId, workspaceId: stable.workspaceId }).run.runId, 'run-older');
    assert.throws(() => resolveKernelCloseoutRun({ stateStore: { ...stateStore, listRuns: () => [] }, projectId: project.projectId, workspaceId: stable.workspaceId }), (error) => error.code === 'RUN_PROVENANCE_REQUIRED');

    // Verify MOON_RELAY_KERNEL_RUN_ID environment variable override when runId is omitted
    const resolvedEnv = resolveKernelCloseoutRun({ stateStore: multiStateStore, projectId: project.projectId, workspaceId: stable.workspaceId, env: { MOON_RELAY_KERNEL_RUN_ID: 'run-older' } });
    assert.equal(resolvedEnv.run.runId, 'run-older');
    await writeFile(path.join(temp, 'foreign.txt'), 'outside kernel\n', 'utf8');
    const foreignIdentity = observeWorkspaceIdentity({ projectRoot: temp }).identity;
    run.currentWorkspaceIdentity = foreignIdentity;
    provenance.workspaceIdentity = foreignIdentity;
    assert.throws(() => admitKernelMutation({ stateStore, project, statusEntries: [{ status: ' M', path: 'app.txt' }, { status: '??', path: 'foreign.txt' }], selected: ['app.txt'], runId: run.runId }), (error) => error.code === 'FOREIGN_MUTATION');
    await rm(path.join(temp, 'foreign.txt'));
    run.currentWorkspaceIdentity = workspaceIdentity;
    provenance.workspaceIdentity = workspaceIdentity;
    await writeFile(path.join(temp, 'app.txt'), 'post-kernel edit\n', 'utf8');
    assert.throws(() => admitKernelMutation({ stateStore, project, statusEntries: [{ status: ' M', path: 'app.txt' }], selected: ['app.txt'], runId: run.runId }), (error) => error.code === 'MUTATION_PROVENANCE_DRIFT');
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('matchesCurrentMutationCandidate and resolveKernelCloseoutRun canonicalize separators and Windows path case', () => {
  const run = { runId: 'run-case', currentWorkspaceIdentity: 'id-1' };
  const provenancePath = process.platform === 'win32' ? 'Src\\App.mjs' : 'src\\app.mjs';
  const selectedPath = process.platform === 'win32' ? 'SRC/App.mjs' : 'src/app.mjs';
  const provenance = { workspaceIdentity: 'id-1', changedPaths: [provenancePath] };
  assert.equal(matchesCurrentMutationCandidate({
    run,
    provenance,
    currentWorkspaceIdentity: 'id-1',
    currentPaths: ['src/app.mjs'],
    selectedPaths: [selectedPath],
  }), true);

  const project = { projectId: 'fixture-project' };
  const workspaceId = 'ws-1';
  const stateStore = {
    listRuns: () => [
      {
        runId: 'run-case',
        projectId: project.projectId,
        workspaceId,
        worktreeId: 'worktree-1',
        status: 'completed',
        currentState: 'CLOSE',
        finalizationStatus: 'completed',
        mutationRevision: 1,
        sourceIdentity: 'src-id',
        currentWorkspaceIdentity: 'id-1',
      },
    ],
    getCompletionDecision: () => ({ decision: 'accepted' }),
    getMutationProvenance: () => ({
      projectId: project.projectId,
      workspaceId,
      sourceIdentity: 'src-id',
      mutationRevision: 1,
      workspaceIdentity: 'id-1',
      changedPaths: [provenancePath],
    }),
  };
  const resolved = resolveKernelCloseoutRun({
    stateStore,
    projectId: project.projectId,
    workspaceId,
    currentWorkspaceIdentity: 'id-1',
    currentPaths: ['src/app.mjs'],
    selectedPaths: [selectedPath],
  });
  assert.equal(resolved.run.runId, 'run-case');

  const missingWorktreeStore = {
    ...stateStore,
    listRuns: () => [{ ...stateStore.listRuns()[0], worktreeId: null }],
  };
  assert.throws(() => resolveKernelCloseoutRun({
    stateStore: missingWorktreeStore,
    projectId: project.projectId,
    workspaceId,
    currentWorkspaceIdentity: 'id-1',
    currentPaths: ['src/app.mjs'],
    selectedPaths: ['SRC/App.mjs'],
  }), (error) => error.code === 'RUN_PROVENANCE_REQUIRED');
});

test('replacement and authority audit passes current checkout', async () => {
  const result = await runUnificationAudit({ repoRoot: root });
  assert.equal(result.status, 'pass');
  assert.ok(Object.values(result.gates).every(Boolean));
});
