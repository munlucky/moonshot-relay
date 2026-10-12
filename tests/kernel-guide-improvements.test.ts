import { assertTestArray, assertTestNumber, assertTestPresent, assertTestRecord } from './helpers/assert-value.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildEvidenceIdentity, buildEvidenceReuseReceipt, exactEvidenceIdentityMatch } from '../src/kernel/proof/evidence-reuse.js';
import { deriveKnowledgeStatus, emptyKnowledgeDoctorFinding, extractStructuredKnowledgeCandidates, failureFingerprint, normalizeFailureSignalText } from '../src/kernel/knowledge/capture.js';
import { classifyContractChange } from '../src/kernel/change-contract.js';
import {
  compileRunObligations,
  rebindProofPolicyCommands,
  selectBoundCommandRef,
} from '../src/kernel/run/obligation-compiler.js';
import { authoritativeVerificationScope } from '../src/contracts/verification-settlement.js';
import { readFile } from 'node:fs/promises';
import { buildNextPayload } from '../src/kernel/run/run-loop.js';
import { resolveKernelCloseoutRun } from '../src/application/kernel-standalone/kernel-commit.js';
import { sanitizePersistentPayload, sanitizePersistentText } from '../src/shared/persistent-sanitizer.js';

test('structured repeated failures produce a bounded, evidence-bound knowledge candidate', () => {
  const candidate = extractStructuredKnowledgeCandidates({
    run: { runId: 'run-b', projectId: 'project-a' },
    priorRunSignals: [{ failures: [{ fingerprint: 'failure-1', statement: 'auth contract failed', evidenceRefs: ['failure://run-a/failure-1'] }] }],
    signals: { failures: [{ fingerprint: 'failure-1', statement: 'auth contract failed', evidenceRefs: ['failure://run-b/failure-1'] }] },
  });
  assert.equal(candidate.length, 1);
  assert.equal(candidate[0].proposedType, 'known_failure_pattern');
  assert.ok(assertTestNumber(assertTestArray(candidate[0].evidenceRefs).length) > 0);
});

test('knowledge capture status distinguishes submitted, committed, and empty capture', () => {
  assert.equal(deriveKnowledgeStatus({ explicitCount: 1 }), 'explicit_candidates_submitted');
  assert.equal(deriveKnowledgeStatus({ committedStatus: 'no_change' }), 'no_new_knowledge');
  assert.equal(deriveKnowledgeStatus({ committedStatus: 'committed', committedCount: 1 }), 'knowledge_committed');
  assert.equal(emptyKnowledgeDoctorFinding({ completedRuns: 2, mutationRuns: 1 }), null);
  assert.equal(assertTestPresent(emptyKnowledgeDoctorFinding({ completedRuns: 3, mutationRuns: 1, knowledgeRevision: 1, candidateCount: 0, committedCount: 0 })).code, 'knowledge_capture_missing');
});

test('failure fingerprints ignore run-specific metrics so repeated failures become candidates', () => {
  assert.equal(normalizeFailureSignalText('packaged performance 29.7 FPS at pid=1234'), 'packaged performance <metric> at pid <number>');
  assert.equal(
    normalizeFailureSignalText('packaged performance FPS=29.7 p95=141ms (node:24492)'),
    'packaged performance <metric> <metric> (node:<pid>)',
  );
  assert.equal(
    failureFingerprint({ obligationId: 'unit-test', commandRef: 'test:package', errorSummary: 'packaged performance 29.7 FPS at pid=1234' }),
    failureFingerprint({ obligationId: 'unit-test', commandRef: 'test:package', errorSummary: 'packaged performance 31.2 FPS at pid=9876' }),
  );
  assert.equal(
    failureFingerprint({ obligationId: 'unit-test', commandRef: 'test:package', errorSummary: 'packaged performance FPS=29.7 p95=141ms (node:24492)' }),
    failureFingerprint({ obligationId: 'unit-test', commandRef: 'test:package', errorSummary: 'packaged performance FPS=31.2 p95=188ms (node:8134)' }),
  );
  const candidates = extractStructuredKnowledgeCandidates({
    run: { runId: 'run-b', projectId: 'project-a' },
    priorRunSignals: [{ failures: [{ fingerprint: failureFingerprint({ obligationId: 'unit-test', commandRef: 'test:package', errorSummary: 'packaged performance 29.7 FPS at pid=1234' }), statement: 'packaged performance is below the gate', evidenceRefs: ['failure://run-a/1'], scope: ['package'] }] }],
    signals: { failures: [{ fingerprint: failureFingerprint({ obligationId: 'unit-test', commandRef: 'test:package', errorSummary: 'packaged performance 31.2 FPS at pid=9876' }), statement: 'packaged performance is below the gate', evidenceRefs: ['failure://run-b/1'], scope: ['package'] }] },
  });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].proposedType, 'known_failure_pattern');
});

test('evidence reuse requires exact declared identity and creates a current revision receipt', () => {
  const identity = buildEvidenceIdentity({ commandRef: 'test:auth', sourceInputDigest: 'sha256:source', networkPolicy: 'inherited', environment: { platform: 'test', arch: 'test', nodeVersion: 'test' } });
  assert.equal(exactEvidenceIdentityMatch(identity, { ...identity }), true);
  assert.equal(exactEvidenceIdentityMatch(identity, buildEvidenceIdentity({ commandRef: 'test:auth', sourceInputDigest: 'sha256:changed', networkPolicy: 'inherited', environment: { platform: 'test', arch: 'test', nodeVersion: 'test' } })), false);
  const receipt = buildEvidenceReuseReceipt({ runId: 'run-b', obligationId: 'required-auth', priorRunId: 'run-a', priorVerificationId: 4, mutationRevision: 2, identity, evidenceDigest: 'sha256:evidence' });
  assert.equal(receipt.receiptType, 'exact-evidence-reuse');
  assert.equal(receipt.mutationRevision, 2);
});

test('required verification metadata compiles only for a related changed scope', () => {
  const records = [{
    id: 'rv-auth',
    type: 'required_verification',
    status: 'committed',
    scope: ['src/auth/**'],
    verification: { commandRefs: ['test:auth'], receiptContractRef: 'project.auth.v1', freshnessInputs: ['sourceIdentity'] },
  }];
  const obligations = compileRunObligations({
    projectRoot: process.cwd(),
    requiredChecks: [],
    contract: { requiredObligations: [], acceptance: [] },
    commands: [{ command: 'node', args: [], ecosystem: 'node', source: 'package.json', declaration: 'scripts', commandRef: 'test:auth', commandClass: 'unit-test' }],
    knowledgeRecords: records,
    changedPaths: ['src/auth/login.mjs'],
  });
  assert.equal(obligations.length, 1);
  assert.equal(obligations[0].sourceType, 'knowledge');
  assert.equal(assertTestPresent(obligations[0].metadata).receiptContractRef, 'project.auth.v1');
  assert.equal(classifyContractChange({ previous: { allowedPaths: ['src/auth/**'] }, next: { allowedPaths: ['src/auth/**'], defectWithinScope: true, taskClass: 'bug' } }), 'defect-within-scope');
  assert.equal(classifyContractChange({ previous: { allowedPaths: ['src/auth/**'] }, next: { allowedPaths: ['src/auth/**', 'src/billing/**'], scopeExtension: true } }), 'scope-extension');
});

test('command binding follows evidence plan, knowledge, caller, then policy fallback priority', () => {
  const commands: NonNullable<NonNullable<Parameters<typeof compileRunObligations>[0]>['commands']> = [
    { command: 'node', args: [], ecosystem: 'node', source: 'package.json', declaration: 'scripts', commandRef: 'test:policy', commandClass: 'unit-test' },
    { command: 'node', args: [], ecosystem: 'node', source: 'package.json', declaration: 'scripts', commandRef: 'test:caller', commandClass: 'unit-test' },
    { command: 'node', args: [], ecosystem: 'node', source: 'package.json', declaration: 'scripts', commandRef: 'test:knowledge', commandClass: 'unit-test' },
    { command: 'node', args: [], ecosystem: 'node', source: 'package.json', declaration: 'scripts', commandRef: 'test:plan', commandClass: 'unit-test' },
  ];
  const knowledgeRecords = [{
    id: 'rv-unit',
    type: 'required_verification',
    status: 'committed',
    scope: [],
    verification: {
      obligationId: 'unit-test',
      commandRef: 'test:knowledge',
      scope: ['src/knowledge/**'],
    },
  }];
  const compile = (acceptance: NonNullable<NonNullable<NonNullable<Parameters<typeof compileRunObligations>[0]>['contract']>['acceptance']>) => compileRunObligations({
    projectRoot: process.cwd(),
    requiredChecks: ['unit-test'],
    contract: {
      requiredVerifications: [{
        obligationId: 'unit-test',
        commandRef: 'test:caller',
        scope: ['src/caller/**'],
      }],
      acceptance,
    },
    commands,
    knowledgeRecords,
    changedPaths: ['src/knowledge/login.mjs'],
  });

  const withoutPlan = compile([{ id: 'AC-1', acceptance: 'the unit behavior works' }]);
  assert.equal(selectBoundCommandRef(withoutPlan[0], { projectCommands: commands }), 'test:knowledge');
  assert.deepEqual(authoritativeVerificationScope(withoutPlan[0]), {
    scope: ['src/knowledge/**'],
    freshnessInputs: [],
    sourceType: 'knowledge',
    sourceRef: 'rv-unit',
  });

  const withPlan = compile([{
    id: 'AC-2',
    acceptance: 'the planned unit behavior works',
    evidencePlan: { obligationId: 'unit-test', class: 'hard', method: 'unit-test', commandRefs: ['test:plan'] },
  }]);
  assert.equal(selectBoundCommandRef(withPlan[0], { projectCommands: commands }), 'test:plan');
});

test('greenfield policy obligations rebind to commands declared before proof', () => {
  const greenfield = compileRunObligations({
    projectRoot: process.cwd(),
    requiredChecks: ['unit-test'],
    contract: { acceptance: [] },
    commands: [],
  });
  assert.equal(greenfield[0].satisfiable, false);
  const rebound = rebindProofPolicyCommands({
    obligations: greenfield,
    projectRoot: process.cwd(),
    commands: [{ command: 'node', args: [], ecosystem: 'node', source: 'package.json', declaration: 'scripts', commandRef: 'test:new', commandClass: 'unit-test' }],
  });
  assert.equal(rebound[0].satisfiable, true);
  assert.deepEqual(rebound[0].allowedCommandRefs, ['test:new']);
  assert.equal(selectBoundCommandRef(rebound[0], { projectCommands: [{ command: 'node', args: [], ecosystem: 'node', source: 'package.json', declaration: 'scripts', commandRef: 'test:new', commandClass: 'unit-test' }] }), 'test:new');
});

test('project knowledge documentation states the required_verification contract convention', async () => {
  const doc = await readFile(new URL('../docs/public/project-knowledge-plane.md', import.meta.url), 'utf8');
  for (const heading of [
    '## Project Verification Contract (`required_verification`)',
    '### Command indirection',
    '### Architecture fitness',
    '### Mutation quality',
    '### User-visible acceptance',
    '### Linking a `known_failure_pattern`',
    '### When to create a record',
  ]) {
    assert.ok(doc.includes(heading), `missing documentation section: ${heading}`);
  }
  assert.ok(doc.includes('commandRef: architecture:test'));
  assert.ok(doc.includes('test:payment-mutation'));
  assert.ok(doc.includes('e2e:login'));
  assert.ok(doc.includes('test:refresh-regression'));
});

test('architecture, mutation, and acceptance verification compile only for a matching changed scope', () => {
  const records = [
    {
      id: 'rv-architecture',
      type: 'required_verification',
      status: 'committed',
      scope: ['src/domain/**'],
      verification: { commandRefs: ['architecture:test'] },
    },
    {
      id: 'rv-mutation',
      type: 'required_verification',
      status: 'committed',
      scope: ['src/domain/payment/**'],
      verification: { commandRefs: ['test:payment-mutation'] },
    },
    {
      id: 'rv-e2e',
      type: 'required_verification',
      status: 'committed',
      scope: ['src/features/login/**'],
      verification: { commandRefs: ['e2e:login'] },
    },
  ];
  const commands = [
    { command: 'node', args: [], ecosystem: 'node', source: 'package.json', declaration: 'scripts', commandRef: 'architecture:test', commandClass: 'unit-test' },
    { command: 'node', args: [], ecosystem: 'node', source: 'package.json', declaration: 'scripts', commandRef: 'test:payment-mutation', commandClass: 'unit-test' },
    { command: 'node', args: [], ecosystem: 'node', source: 'package.json', declaration: 'scripts', commandRef: 'e2e:login', commandClass: 'e2e' },
  ];
  const compile = (changedPaths: string[]) => compileRunObligations({
    projectRoot: process.cwd(),
    requiredChecks: [],
    contract: { requiredObligations: [], acceptance: [] },
    commands,
    knowledgeRecords: records,
    changedPaths,
  });

  const payment = compile(['src/domain/payment/total.mjs']);
  assert.deepEqual(
    payment.flatMap((obligation) => obligation.allowedCommandRefs).sort(),
    ['architecture:test', 'test:payment-mutation'],
  );

  const login = compile(['src/features/login/LoginForm.tsx']);
  assert.deepEqual(login.flatMap((obligation) => obligation.allowedCommandRefs), ['e2e:login']);

  // An unrelated scope must not trigger expensive project verification.
  assert.deepEqual(compile(['docs/readme.md']), []);
});

test('next is self-describing at the model boundary', () => {
  const payload = buildNextPayload({
    run: { runId: 'run-self-describing', objective: 'describe work', status: 'active', state: 'EXECUTE', acceptanceCriteria: ['works'] },
    contract: {
      acceptance: [{ id: 'AC-1', statement: 'works' }],
      constraints: ['stay bounded'],
      nonGoals: ['no redesign'],
    },
    obligations: [{
      obligationId: 'unit-test',
      evidenceClass: 'hard',
      verificationMethod: 'kernel-executed-command',
      allowedCommandRefs: ['test:unit'],
      acceptanceIds: ['AC-1'],
      metadata: { timeoutMs: 5000, verificationScope: 'focused' },
    }],
    requiredObligations: ['unit-test'],
    workAuthority: {
      currentWorkUnit: { stepId: 'step-1', allowedPaths: ['src/**'], forbiddenPaths: ['src/secrets/**'] },
      goalStatus: 'active',
      progress: { remainingCount: 1 },
    },
  });
  assert.equal(payload.stepId, 'step-1');
  assert.deepEqual(payload.allowedPaths, ['src/**']);
  assert.deepEqual(payload.acceptanceIds, ['AC-1']);
  assert.deepEqual(payload.requiredVerifications[0], {
    obligationId: 'unit-test',
    evidenceClass: 'hard',
    verificationMethod: 'kernel-executed-command',
    allowedCommandRefs: ['test:unit'],
    commandRef: 'test:unit',
    acceptanceIds: ['AC-1'],
    verificationScope: 'focused',
    timeoutMs: 5000,
  });
  assert.equal(assertTestRecord(payload).nextAction, 'implement');
});

test('successor closeout resolves the existing binding chain and unions provenance', () => {
  const runA = {
    runId: 'run-a', projectId: 'project', workspaceId: 'workspace', worktreeId: 'worktree',
    status: 'completed', currentState: 'CLOSE', finalizationStatus: 'completed', sourceIdentity: 'src-a',
    mutationRevision: 1, currentWorkspaceIdentity: 'identity-a',
  };
  const runB = {
    runId: 'run-b', projectId: 'project', workspaceId: 'workspace', worktreeId: 'worktree',
    status: 'completed', currentState: 'CLOSE', finalizationStatus: 'completed', sourceIdentity: 'src-b',
    mutationRevision: 1, currentWorkspaceIdentity: 'identity-current',
  };
  const lineage = { runIds: ['run-a', 'run-b'], runs: [runA, runB], edges: [], terminalRunId: 'run-b', isTerminal: true };
  const stateStore = {
    getLatestImplementationAttempt: () => null,
    registerProjectWorkspace: () => { throw new Error('unexpected workspace registration'); },
    listRuns: () => [runA, runB],
    getRun: (runId: string) => (runId === 'run-a' ? runA : runId === 'run-b' ? runB : null),
    resolveSuccessorLineage: (runId: string) => runId === 'run-b'
      ? lineage
      : { ...lineage, terminalRunId: runId, isTerminal: false },
    getCompletionDecision: (runId: string) => ({ decision: 'accepted', sourceIdentity: runId === 'run-a' ? 'src-a' : 'src-b' }),
    getMutationProvenance: (runId: string) => runId === 'run-a'
      ? { projectId: 'project', workspaceId: 'workspace', sourceIdentity: 'src-a', mutationRevision: 1, workspaceIdentity: 'identity-a', changedPaths: ['a.ts'] }
      : { projectId: 'project', workspaceId: 'workspace', sourceIdentity: 'src-b', mutationRevision: 1, workspaceIdentity: 'identity-current', changedPaths: ['b.ts'] },
  };
  const resolved = resolveKernelCloseoutRun({
    stateStore,
    projectId: 'project',
    workspaceId: 'workspace',
    currentWorkspaceIdentity: 'identity-current',
    currentPaths: ['a.ts', 'b.ts'],
    selectedPaths: ['a.ts', 'b.ts'],
  });
  assert.equal(resolved.run.runId, 'run-b');
  assert.deepEqual(resolved.lineage.runIds, ['run-a', 'run-b']);
  assert.deepEqual(resolved.approvedPaths, ['a.ts', 'b.ts']);
});

test('canonical sanitizer protects provider output and transport header variants', () => {
  const text = sanitizePersistentText('Authorization: Bearer abc x-refresh-token: xyz x-api-key: key123');
  assert.doesNotMatch(text, /Bearer abc|xyz|key123/);
  const payload = sanitizePersistentPayload({ Authorization: 'Bearer abc', 'x-refresh-token': 'xyz', nested: { 'x-api-key': 'key123' } });
  assert.equal(assertTestRecord(payload).Authorization, '[REDACTED]');
  assert.equal(assertTestRecord(payload)['x-refresh-token'], '[REDACTED]');
  assert.equal(assertTestRecord(assertTestRecord(payload).nested)['x-api-key'], '[REDACTED]');
  const headerPayload = sanitizePersistentPayload({ 'Set-Cookie': 'sid=secret', 'access-token': 'access-value', 'refresh-token': 'refresh-value' });
  assert.equal(assertTestRecord(headerPayload)['Set-Cookie'], '[REDACTED]');
  assert.equal(assertTestRecord(headerPayload)['access-token'], '[REDACTED]');
  assert.equal(assertTestRecord(headerPayload)['refresh-token'], '[REDACTED]');
});

test('successor closeout rejects incomplete worktree identity', () => {
  const runA = {
    runId: 'run-a', projectId: 'project', workspaceId: 'workspace', worktreeId: null,
    status: 'completed', currentState: 'CLOSE', finalizationStatus: 'completed', sourceIdentity: 'src-a',
    mutationRevision: 1, currentWorkspaceIdentity: 'identity-a',
  };
  const runB = {
    runId: 'run-b', projectId: 'project', workspaceId: 'workspace', worktreeId: 'worktree',
    status: 'completed', currentState: 'CLOSE', finalizationStatus: 'completed', sourceIdentity: 'src-b',
    mutationRevision: 1, currentWorkspaceIdentity: 'identity-current',
  };
  const stateStore = {
    getLatestImplementationAttempt: () => null,
    registerProjectWorkspace: () => { throw new Error('unexpected workspace registration'); },
    listRuns: () => [runA, runB],
    getRun: (runId: string) => ({ 'run-a': runA, 'run-b': runB }[runId] || null),
    resolveSuccessorLineage: () => ({ runIds: ['run-a', 'run-b'], runs: [runA, runB], edges: [], terminalRunId: 'run-b', isTerminal: true }),
    getCompletionDecision: () => ({ decision: 'accepted' }),
    getMutationProvenance: (runId: string) => ({
      projectId: 'project', workspaceId: 'workspace', sourceIdentity: runId === 'run-a' ? 'src-a' : 'src-b',
      mutationRevision: 1, workspaceIdentity: runId === 'run-a' ? 'identity-a' : 'identity-current', changedPaths: [`${runId}.ts`],
    }),
  };
  assert.throws(() => resolveKernelCloseoutRun({
    stateStore,
    projectId: 'project',
    workspaceId: 'workspace',
    currentWorkspaceIdentity: 'identity-current',
    currentPaths: ['run-a.ts', 'run-b.ts'],
    selectedPaths: ['run-a.ts', 'run-b.ts'],
  }), /RUN_PROVENANCE_REQUIRED/);
});

type TestControlPlane = Awaited<ReturnType<typeof import('../src/host/kernel/control-plane-runtime.js').createKernelControlPlane>>;
type TestStateStore = Awaited<ReturnType<typeof import('../src/kernel/state-store.js').openKernelStateStore>>;
