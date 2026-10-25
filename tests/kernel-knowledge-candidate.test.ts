import test from 'node:test';
import assert from 'node:assert/strict';
import { extractKnowledgeCandidates } from '../src/kernel/knowledge/candidate-extract.js';
import {
  deduplicateKnowledgeCandidates,
  extractStructuredKnowledgeCandidates,
} from '../src/kernel/knowledge/capture.js';
import {
  extractCodebaseCandidates,
  extractSessionCandidates,
} from '../src/kernel/knowledge-ingestion/candidate-extract.js';
import { normalizeCandidate } from '../src/kernel/knowledge-ingestion/normalize.js';

test('extractKnowledgeCandidates extracts candidates and filters secret leaks', () => {
  const candidates = extractKnowledgeCandidates({
    runId: 'run-101',
    projectId: 'test-proj',
    changedFiles: ['scripts/test.mjs'],
    evidencePack: { status: 'pass', digest: 'dig-1' },
    observedStatements: [
      'SQLite WAL mode is enabled by default.',
      'API key sk-12345678901234567890 leaked in log',
    ],
  });

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].statement, 'SQLite WAL mode is enabled by default.');
});

test('A4: generic session failures remain episodic instead of becoming durable failure patterns', () => {
  const candidates = extractSessionCandidates({
    provider: 'codex',
    nativeSessionId: 'session-a4-generic-failures',
    sourceDigest: 'sha256:a4-session',
    changedFiles: ['src/tooling/build.ts'],
    failures: [
      'TypeScript compile failed with exit code 2.',
      'Temporary provider timeout while starting a worker.',
    ],
  }, { projectId: 'a4-project' });

  assert.equal(candidates.length, 2);
  assert.equal(
    candidates.some((candidate) => candidate.proposedType === 'known_failure_pattern'),
    false,
  );
  assert.ok(candidates.every(
    (candidate) => candidate.proposedType === 'episodic_observation',
  ));
});

test('A4: candidate dedupe preserves failure provenance and resolution while suppressing exact duplicates', () => {
  const base = {
    proposedType: 'known_failure_pattern',
    statement: 'Auth refresh fails after expiry.',
    scope: ['src/auth/**'],
    signalFingerprint: 'auth-refresh-after-expiry',
    cause: 'expired refresh tokens bypass the rotation guard',
  };
  const distinct = deduplicateKnowledgeCandidates([
    {
      ...base,
      candidateId: 'failure-source-a',
      sourceRefs: ['src/auth/refresh.ts'],
      resolution: 'refresh token rotation is enforced before retry',
    },
    {
      ...base,
      candidateId: 'failure-source-b',
      sourceRefs: ['src/auth/session.ts'],
      resolution: 'refresh token rotation is enforced before retry',
    },
    {
      ...base,
      candidateId: 'failure-resolution-b',
      sourceRefs: ['src/auth/refresh.ts'],
      resolution: 'expired sessions are rejected before refresh',
    },
  ]);
  assert.equal(distinct.length, 3);

  const exactAndScoped = deduplicateKnowledgeCandidates([
    {
      ...base,
      candidateId: 'failure-exact-a',
      sourceRefs: ['src/auth/refresh.ts'],
      resolution: 'refresh token rotation is enforced before retry',
    },
    {
      ...base,
      candidateId: 'failure-exact-b',
      sourceRefs: ['src/auth/refresh.ts'],
      resolution: 'refresh token rotation is enforced before retry',
    },
    {
      ...base,
      candidateId: 'failure-billing-scope',
      scope: ['src/billing/**'],
      sourceRefs: ['src/auth/refresh.ts'],
      resolution: 'refresh token rotation is enforced before retry',
    },
  ]);
  assert.equal(exactAndScoped.length, 2);
});

test('A4: candidate dedupe preserves verification commands and procedure steps', () => {
  const verificationBase = {
    proposedType: 'required_verification',
    statement: 'Run the focused check before accepting the change.',
    scope: ['src/auth/**'],
  };
  const procedureBase = {
    proposedType: 'episodic_observation',
    statement: 'Use the bounded auth recovery procedure.',
    scope: ['src/auth/**'],
  };
  const candidates = deduplicateKnowledgeCandidates([
    {
      ...verificationBase,
      candidateId: 'verify-auth',
      verification: { commandRefs: ['test:auth'], method: 'command' },
    },
    {
      ...verificationBase,
      candidateId: 'verify-auth-integration',
      verification: { commandRefs: ['test:auth:integration'], method: 'command' },
    },
    {
      ...procedureBase,
      candidateId: 'procedure-a',
      practiceJson: {
        kind: 'procedure',
        metadata: { title: 'auth recovery' },
        body: { steps: ['reproduce', 'repair'], verification: ['test:auth'] },
      },
    },
    {
      ...procedureBase,
      candidateId: 'procedure-b',
      practiceJson: {
        kind: 'procedure',
        metadata: { title: 'auth recovery' },
        body: { steps: ['reproduce', 'repair', 'rotate session'], verification: ['test:auth'] },
      },
    },
  ]);

  assert.equal(candidates.length, 4);
});

test('W2: legacy observed candidates keep changed files as scope metadata only', () => {
  const [candidate] = extractKnowledgeCandidates({
    runId: 'run-w2-legacy',
    projectId: 'w2-project',
    changedFiles: ['src/kernel/knowledge/context-load.ts'],
    evidencePack: { status: 'pass', digest: 'sha256:evidence' },
    observedStatements: ['Context loading uses committed Knowledge.'],
  });

  assert.ok(candidate);
  assert.deepEqual(candidate.scope, ['src/kernel/knowledge/context-load.ts']);
  assert.deepEqual(candidate.relatedFiles, ['src/kernel/knowledge/context-load.ts']);
  assert.deepEqual(candidate.sourceRefs, []);
});

test('W2: candidate normalization preserves scope, sourceRefs, and relatedFiles independently', () => {
  const context = {
    projectId: 'w2-project',
    sourceType: 'manual',
    sourceIdentity: 'manual:w2',
    sourceDigest: 'sha256:source',
  };
  const first = normalizeCandidate({
    proposedType: 'semantic_fact',
    statement: 'Knowledge applies to the kernel but is verified from one source file.',
    scope: ['src/kernel/**'],
    sourceRefs: ['src/kernel/knowledge/context-load.ts'],
    relatedFiles: ['docs/reference.md'],
  }, context);
  const second = normalizeCandidate({
    proposedType: 'semantic_fact',
    statement: 'Knowledge applies to the kernel but is verified from one source file.',
    scope: ['src/kernel/**'],
    sourceRefs: ['src/kernel/knowledge/freshness.ts'],
    relatedFiles: ['docs/other.md'],
  }, context);

  assert.deepEqual(first.scope, ['src/kernel/**']);
  assert.deepEqual(first.sourceRefs, ['src/kernel/knowledge/context-load.ts']);
  assert.deepEqual(first.relatedFiles, ['docs/reference.md']);
  assert.equal(first.candidateId, second.candidateId, 'candidate identity must depend on applicability scope, not freshness source');
});

test('W2: relatedFiles-only candidates do not invent scope or freshness sources', () => {
  const candidate = normalizeCandidate({
    proposedType: 'semantic_fact',
    statement: 'Related metadata does not define applicability or freshness.',
    relatedFiles: ['src/kernel/knowledge/context-load.ts'],
  }, {
    projectId: 'w2-project',
    sourceType: 'manual',
    sourceIdentity: 'manual:related-only',
    sourceDigest: 'sha256:related-only',
  });

  assert.deepEqual(candidate.scope, []);
  assert.deepEqual(candidate.sourceRefs, []);
  assert.deepEqual(candidate.relatedFiles, ['src/kernel/knowledge/context-load.ts']);
});

test('W2: session changed files remain applicability and related metadata, not freshness sources', () => {
  const [candidate] = extractSessionCandidates({
    provider: 'codex',
    nativeSessionId: 'session-w2',
    sourceDigest: 'sha256:session',
    changedFiles: ['src/auth/login.ts'],
    decisions: ['Auth remains owned by the auth module.'],
  }, { projectId: 'w2-project' });

  assert.ok(candidate);
  assert.deepEqual(candidate.scope, ['src/auth/login.ts']);
  assert.deepEqual(candidate.relatedFiles, ['src/auth/login.ts']);
  assert.deepEqual(candidate.sourceRefs, []);
});

test('W2: codebase candidates explicitly bind freshness to the observed source file', () => {
  const [candidate] = extractCodebaseCandidates({
    sourceTreeDigest: 'sha256:tree',
    files: [{ path: 'src/auth/login.ts', symbols: ['login'], apiSurface: [] }],
  }, { projectId: 'w2-project' });

  assert.ok(candidate);
  assert.deepEqual(candidate.scope, ['src/auth/login.ts']);
  assert.deepEqual(candidate.sourceRefs, ['src/auth/login.ts']);
  assert.deepEqual(candidate.relatedFiles, ['src/auth/login.ts']);
});

test('W2: structured auto capture uses only explicit source refs for freshness', () => {
  const [candidate] = extractStructuredKnowledgeCandidates({
    run: { runId: 'run-w2', projectId: 'w2-project' },
    signals: {
      invariantObservations: [{
        statement: 'Kernel Knowledge selection stays within its declared boundary.',
        scope: ['src/kernel/**'],
        changedPaths: ['src/kernel/knowledge/context-load.ts'],
        sourceRefs: ['src/kernel/knowledge/freshness.ts'],
        evidenceRefs: ['receipt://w2/invariant'],
      }],
    },
  });

  assert.ok(candidate);
  assert.deepEqual(candidate.scope, ['src/kernel/**']);
  assert.deepEqual(candidate.relatedFiles, ['src/kernel/knowledge/context-load.ts']);
  assert.deepEqual(candidate.sourceRefs, ['src/kernel/knowledge/freshness.ts']);
});

test('W2: cross-run evidence does not reinterpret applicability scope as freshness source', () => {
  const [candidate] = extractStructuredKnowledgeCandidates({
    run: { runId: 'run-b', projectId: 'w2-project' },
    priorRunSignals: [{
      runId: 'run-a',
      failures: [{
        fingerprint: 'w2-failure',
        statement: 'Auth refresh fails after expiry.',
        scope: ['src/auth/**'],
        evidenceRefs: ['failure://run-a/auth'],
      }],
    }],
    signals: {
      runId: 'run-b',
      failures: [{
        fingerprint: 'w2-failure',
        statement: 'Auth refresh fails after expiry.',
        scope: ['src/auth/**'],
        evidenceRefs: ['failure://run-b/auth'],
      }],
    },
  });

  assert.ok(candidate);
  assert.deepEqual(candidate.scope, ['src/auth/**']);
  assert.deepEqual(candidate.relatedFiles, ['src/auth/**']);
  assert.deepEqual(candidate.sourceRefs, []);
});
