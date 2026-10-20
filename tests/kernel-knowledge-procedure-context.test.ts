import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildProjectKnowledgeContext } from '../src/kernel/knowledge/context-load.js';

type RecordFixture = Record<string, unknown>;

const procedure = ({
  id,
  scope,
  summary,
  bodyStep,
  validUntil = '2099-01-01T00:00:00.000Z',
  status = 'committed',
}: {
  id: string;
  scope: string[];
  summary: string;
  bodyStep: string;
  validUntil?: string | null;
  status?: string;
}): RecordFixture => ({
  id,
  projectId: 'procedure-context',
  type: 'episodic_observation',
  statement: `Procedure metadata: ${summary}`,
  status,
  trustTier: 'verified',
  createdAt: '2026-10-12T00:00:00.000Z',
  scope,
  practiceJson: {
    kind: 'procedure',
    metadata: {
      title: summary,
      summary,
      appliesTo: scope,
      validUntil,
      tags: summary.toLowerCase().split(/\s+/),
    },
    body: {
      prerequisites: ['review current evidence'],
      steps: [bodyStep],
      verification: ['run fresh focused verification'],
      prohibitions: ['do not widen scope'],
    },
  },
});

const stateStore = (records: RecordFixture[]) => ({
  getProjectKnowledgeRevision: () => 9,
  listKnowledgeRecords: () => records,
});

test('C18: only fresh in-scope procedures materialize their body into EXECUTE context', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'procedure-context-'));
  try {
    const records = [
      procedure({
        id: 'procedure-auth',
        scope: ['src/auth/**'],
        summary: 'Authentication regression repair',
        bodyStep: 'SELECTED_BODY_STEP',
      }),
      procedure({
        id: 'procedure-docs',
        scope: ['docs/**'],
        summary: 'Documentation publishing',
        bodyStep: 'UNRELATED_BODY_STEP',
      }),
      procedure({
        id: 'procedure-expired',
        scope: ['src/auth/**'],
        summary: 'Legacy authentication repair',
        bodyStep: 'EXPIRED_BODY_STEP',
        validUntil: '2020-01-01T00:00:00.000Z',
      }),
      procedure({
        id: 'procedure-superseded',
        scope: ['src/auth/**'],
        summary: 'Superseded authentication repair',
        bodyStep: 'SUPERSEDED_BODY_STEP',
        status: 'superseded',
      }),
    ];

    const context = await buildProjectKnowledgeContext({
      projectId: 'procedure-context',
      runId: 'run-procedure-context',
      stage: 'EXECUTE',
      objective: 'repair authentication regression',
      changedPaths: ['src/auth/service.ts'],
      stateStore: stateStore(records),
      env: { MOON_RELAY_KERNEL_HOME: runtimeHome },
    });

    assert.equal(context.status, 'ready-populated');
    assert.match(context.promptBlock, /Procedure: Authentication regression repair/);
    assert.match(context.promptBlock, /Steps: SELECTED_BODY_STEP/);
    assert.match(context.promptBlock, /Verification: run fresh focused verification/);
    assert.doesNotMatch(context.promptBlock, /UNRELATED_BODY_STEP/);
    assert.doesNotMatch(context.promptBlock, /EXPIRED_BODY_STEP/);
    assert.doesNotMatch(context.promptBlock, /SUPERSEDED_BODY_STEP/);

    assert.ok(context.omittedByPolicy.some((entry) => (
      entry.id === 'procedure-docs'
      && entry.reason === 'procedure_scope_outside'
    )));
    assert.ok(context.staleOrUnavailable.some((entry) => (
      entry.id === 'procedure-expired'
      && entry.reason === 'procedure_expired'
    )));
    assert.ok(context.staleOrUnavailable.some((entry) => (
      entry.id === 'procedure-superseded'
      && entry.reason === 'status_superseded'
    )));
    const omittedCounts = context.quality.omittedCounts;
    assert.ok(omittedCounts && typeof omittedCounts === 'object' && 'stale' in omittedCounts);
    assert.equal((omittedCounts as Record<string, unknown>).stale, 1);
    assert.equal((omittedCounts as Record<string, unknown>).total, 3);
  } finally {
    await rm(runtimeHome, { recursive: true, force: true });
  }
});

test('C18: procedure ranking uses metadata before body and budget loads only the selected body', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'procedure-budget-'));
  try {
    const longSelectedBody = `SELECTED_METADATA_BODY ${'x'.repeat(5600)}`;
    const longBodyOnlyMatch = `BODY_ONLY_AUTHENTICATION_TOKEN_REGRESSION ${'y'.repeat(5600)}`;

    const records = [
      procedure({
        id: 'procedure-metadata-match',
        scope: ['src/auth/**'],
        summary: 'Authentication token regression recovery',
        bodyStep: longSelectedBody,
      }),
      procedure({
        id: 'procedure-body-only-match',
        scope: ['src/auth/**'],
        summary: 'General maintenance workflow',
        bodyStep: longBodyOnlyMatch,
      }),
    ];

    const context = await buildProjectKnowledgeContext({
      projectId: 'procedure-context',
      runId: 'run-procedure-budget',
      stage: 'EXECUTE',
      objective: 'authentication token regression',
      changedPaths: ['src/auth/token.ts'],
      stateStore: stateStore(records),
      env: { MOON_RELAY_KERNEL_HOME: runtimeHome },
    });

    assert.match(context.promptBlock, /SELECTED_METADATA_BODY/);
    assert.doesNotMatch(context.promptBlock, /BODY_ONLY_AUTHENTICATION_TOKEN_REGRESSION/);
    assert.deepEqual(
      context.semanticFacts.map((entry) => entry.id),
      ['procedure-metadata-match'],
    );
    assert.ok(context.omittedByPolicy.some((entry) => (
      entry.id === 'procedure-body-only-match'
      && entry.reason === 'record_budget_exceeded'
    )));
  } finally {
    await rm(runtimeHome, { recursive: true, force: true });
  }
});

test('C18: invalid validity metadata fails closed instead of applying the procedure', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'procedure-invalid-validity-'));
  try {
    const context = await buildProjectKnowledgeContext({
      projectId: 'procedure-context',
      runId: 'run-invalid-validity',
      stage: 'EXECUTE',
      objective: 'repair authentication regression',
      changedPaths: ['src/auth/service.ts'],
      stateStore: stateStore([
        procedure({
          id: 'procedure-invalid-validity',
          scope: ['src/auth/**'],
          summary: 'Authentication repair',
          bodyStep: 'INVALID_VALIDITY_BODY',
          validUntil: 'not-a-date',
        }),
      ]),
      env: { MOON_RELAY_KERNEL_HOME: runtimeHome },
    });

    assert.equal(context.status, 'stale');
    assert.doesNotMatch(context.promptBlock, /INVALID_VALIDITY_BODY/);
    assert.ok(context.staleOrUnavailable.some((entry) => (
      entry.id === 'procedure-invalid-validity'
      && entry.reason === 'procedure_valid_until_invalid'
    )));
  } finally {
    await rm(runtimeHome, { recursive: true, force: true });
  }
});

test('W1: procedure identity preserves different bodies and collapses exact duplicates', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'procedure-dedupe-'));
  try {
    const context = await buildProjectKnowledgeContext({
      projectId: 'procedure-context',
      runId: 'run-procedure-dedupe',
      stage: 'EXECUTE',
      objective: 'authentication regression repair',
      changedPaths: ['src/auth/service.ts'],
      stateStore: stateStore([
        procedure({
          id: 'procedure-exact-a',
          scope: ['src/auth/**'],
          summary: 'Authentication regression repair',
          bodyStep: 'inspect bounded authentication evidence',
        }),
        procedure({
          id: 'procedure-exact-b',
          scope: ['src/auth/**'],
          summary: 'Authentication regression repair',
          bodyStep: 'inspect bounded authentication evidence',
        }),
        procedure({
          id: 'procedure-different-body',
          scope: ['src/auth/**'],
          summary: 'Authentication regression repair',
          bodyStep: 'rebuild the authentication fixture before verification',
        }),
      ]),
      env: { MOON_RELAY_KERNEL_HOME: runtimeHome },
    });

    assert.equal(context.semanticFacts.length, 2);
    assert.ok(context.semanticFacts.some((entry) => entry.id === 'procedure-different-body'));
    assert.equal(
      context.semanticFacts.filter((entry) => String(entry.id).startsWith('procedure-exact-')).length,
      1,
    );
    assert.equal(
      context.omittedByPolicy.filter((entry) => entry.reason === 'canonical_duplicate').length,
      1,
    );
    assert.match(context.promptBlock, /inspect bounded authentication evidence/);
    assert.match(context.promptBlock, /rebuild the authentication fixture before verification/);
  } finally {
    await rm(runtimeHome, { recursive: true, force: true });
  }
});
