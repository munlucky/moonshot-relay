import test from 'node:test';
import assert from 'node:assert/strict';
import { parseKernelContract } from '../src/contracts/schema-codec.js';
import {
  resolveRecordType,
  validateKnowledgeRecord,
} from '../src/kernel/knowledge/records.js';
import { mapCandidateToCanonicalRecord } from '../src/kernel/knowledge/canonical-record-mapper.js';
import {
  scoreRelevance,
} from '../src/kernel/knowledge/path-scope.js';
import { STAGE_TYPE_POLICY } from '../src/kernel/knowledge/context-load.js';

const createdAt = '2026-10-12T00:00:00.000Z';

const procedureRecord = ({
  id,
  statement,
  scope,
  metadata,
  body,
}: {
  id: string;
  statement: string;
  scope: string[];
  metadata: Record<string, unknown>;
  body: Record<string, unknown>;
}) => ({
  id,
  projectId: 'procedure-fixture',
  type: 'episodic_observation' as const,
  statement,
  status: 'committed' as const,
  trustTier: 'verified' as const,
  createdAt,
  scope,
  practiceJson: {
    kind: 'procedure',
    metadata,
    body,
  },
});

test('C17: three representative procedures round-trip through the existing knowledge record schema', () => {
  const procedures = [
    procedureRecord({
      id: 'procedure-release',
      statement: 'Release the package only after the build and focused verification pass.',
      scope: ['src/release/**'],
      metadata: {
        title: 'Release package',
        summary: 'Build and verify before release.',
        appliesTo: ['src/release/**'],
        validUntil: '2027-01-01T00:00:00.000Z',
        tags: ['release', 'package'],
      },
      body: {
        prerequisites: ['working tree is reviewed'],
        steps: ['build package', 'run focused verification', 'publish approved artifact'],
        verification: ['package build receipt', 'focused test receipt'],
        prohibitions: ['do not publish from an unverified workspace'],
      },
    }),
    procedureRecord({
      id: 'procedure-auth-debug',
      statement: 'Investigate authentication regressions within the auth scope before changing shared boundaries.',
      scope: ['src/auth/**'],
      metadata: {
        title: 'Authentication regression triage',
        summary: 'Triage auth failures without widening scope.',
        appliesTo: ['src/auth/**'],
        validUntil: null,
        tags: ['auth', 'regression'],
      },
      body: {
        prerequisites: ['reproduction evidence exists'],
        steps: ['reproduce failure', 'inspect bounded auth paths', 'apply the smallest fix'],
        verification: ['fresh auth regression test'],
        prohibitions: ['do not widen the architecture boundary during triage'],
      },
    }),
    procedureRecord({
      id: 'procedure-schema-change',
      statement: 'Regenerate contract artifacts after a canonical schema change.',
      scope: ['schemas/**', 'src/contracts/**'],
      metadata: {
        title: 'Schema regeneration',
        summary: 'Keep generated contracts synchronized with canonical schemas.',
        appliesTo: ['schemas/**', 'src/contracts/**'],
        validUntil: '2027-06-30T00:00:00.000Z',
        tags: ['schema', 'contracts'],
      },
      body: {
        prerequisites: ['canonical schema is the intended source change'],
        steps: ['run contract generation', 'run typecheck', 'run generated drift check'],
        verification: ['contract generation receipt', 'typecheck receipt'],
        prohibitions: ['do not edit generated contract files as the source of truth'],
      },
    }),
  ];

  for (const procedure of procedures) {
    const encoded = JSON.stringify(procedure);
    const decoded = JSON.parse(encoded);
    const parsed = parseKernelContract('kernel.knowledge-record', decoded);

    assert.equal(parsed.type, 'episodic_observation');
    assert.equal(validateKnowledgeRecord(parsed), true);
    assert.deepEqual(parsed.practiceJson, procedure.practiceJson);
    assert.deepEqual(parsed.scope, procedure.scope);
  }
});

test('C17: tacit practice already maps to episodic observation and retains structured procedure fields', () => {
  const candidate = {
    proposedType: 'tacit_practice',
    statement: 'Run focused verification before release.',
    scope: ['src/release/**'],
    sourceRefs: [],
    confidence: 0.9,
    candidateJson: {
      kind: 'procedure',
      metadata: {
        summary: 'Focused release verification.',
        appliesTo: ['src/release/**'],
        validUntil: '2027-01-01T00:00:00.000Z',
      },
      body: {
        prerequisites: ['build succeeds'],
        steps: ['run focused tests'],
        verification: ['focused receipt'],
        prohibitions: ['no unverified publish'],
      },
    },
  };

  const mapped = mapCandidateToCanonicalRecord(candidate, {
    runId: 'run-procedure',
    projectId: 'procedure-fixture',
    revision: 1,
  });

  assert.equal(resolveRecordType('tacit_practice'), 'episodic_observation');
  assert.equal(mapped.type, 'episodic_observation');
  assert.deepEqual(mapped.practiceJson, candidate.candidateJson);
});

test('C17: procedure retrieval can use existing stage, scope, and relevance rules without a new record type', () => {
  const relevant = procedureRecord({
    id: 'procedure-auth',
    statement: 'Triage authentication token regressions.',
    scope: ['src/auth/**'],
    metadata: {
      summary: 'Authentication token triage.',
      appliesTo: ['src/auth/**'],
      tags: ['authentication', 'token'],
    },
    body: {
      prerequisites: ['failing auth evidence'],
      steps: ['inspect token validation'],
      verification: ['auth tests'],
      prohibitions: ['no unrelated edits'],
    },
  });
  const unrelated = procedureRecord({
    id: 'procedure-docs',
    statement: 'Publish documentation.',
    scope: ['docs/**'],
    metadata: {
      summary: 'Documentation publishing.',
      appliesTo: ['docs/**'],
      tags: ['documentation'],
    },
    body: {
      prerequisites: [],
      steps: ['publish docs'],
      verification: ['link check'],
      prohibitions: [],
    },
  });

  assert.ok(STAGE_TYPE_POLICY.FRAME.includes('episodic_observation'));
  assert.ok(STAGE_TYPE_POLICY.EXECUTE.includes('episodic_observation'));
  assert.equal(STAGE_TYPE_POLICY.PROVE.includes('episodic_observation'), false);

  const relevantScore = scoreRelevance({
    item: relevant,
    objective: 'fix authentication token regression',
    paths: ['src/auth/token.ts'],
  });
  const unrelatedScore = scoreRelevance({
    item: unrelated,
    objective: 'fix authentication token regression',
    paths: ['src/auth/token.ts'],
  });
  assert.ok(relevantScore > unrelatedScore);
});

test('C17: known failure and ordinary episodic observation stay distinct from reusable procedure payloads', () => {
  const knownFailure = parseKernelContract('kernel.knowledge-record', {
    id: 'known-failure-auth-timeout',
    projectId: 'procedure-fixture',
    type: 'known_failure_pattern',
    statement: 'Auth integration checks can fail when the fixture clock is not deterministic.',
    status: 'committed',
    trustTier: 'verified',
    createdAt,
    scope: ['tests/auth/**'],
    failureJson: {
      fingerprint: 'auth-fixture-clock',
      mitigation: 'use the deterministic fixture clock',
    },
  });

  const observation = parseKernelContract('kernel.knowledge-record', {
    id: 'episodic-auth-observation',
    projectId: 'procedure-fixture',
    type: 'episodic_observation',
    statement: 'The auth fixture clock drifted during this run.',
    status: 'observed',
    trustTier: 'derived',
    createdAt,
    scope: ['tests/auth/**'],
    practiceJson: {
      kind: 'observation',
      runId: 'run-observation',
    },
  });

  assert.equal(validateKnowledgeRecord(knownFailure), true);
  assert.equal(validateKnowledgeRecord(observation), true);
  assert.equal(knownFailure.type, 'known_failure_pattern');
  assert.equal(observation.type, 'episodic_observation');
  assert.notEqual(
    (observation.practiceJson as { kind?: unknown }).kind,
    'procedure',
  );
});
