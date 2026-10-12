import test from 'node:test';
import assert from 'node:assert/strict';
import type {
  FuturesAssessmentInput,
  FuturesEvidenceInput,
} from '../src/contracts/futures-evidence.js';
import { assessFuturesEvidence } from '../src/kernel/proof/futures-assessment.js';
import { collectFuturesEvidence } from '../src/kernel/proof/futures-evidence.js';

const sha = (char: string): string => `sha256:${char.repeat(64)}`;

const evidenceInput = (): FuturesEvidenceInput => ({
  revision: 12,
  contentDigest: sha('a'),
  changeSet: {
    status: 'observed',
    reason: null,
    actualChangedPaths: ['src/a.ts', 'src/b.ts'],
  },
  dependencyBoundaries: [
    { fromPath: 'src/a.ts', toPath: 'src/contracts/a.ts' },
  ],
  regressionScope: ['test:focused'],
  unknowns: [],
});

const input = (
  overrides: Partial<FuturesAssessmentInput> = {},
): FuturesAssessmentInput => ({
  evidence: collectFuturesEvidence(evidenceInput()),
  currentRevision: 12,
  currentContentDigest: sha('a'),
  existingObligations: ['verify-regression'],
  signals: {
    behavior: 'preserved',
    scope: 'within',
    architecture: 'not-required',
  },
  ...overrides,
});

test('Green keeps work on existing obligations without granting mutation authority', () => {
  const source = input();
  const before = structuredClone(source);
  const result = assessFuturesEvidence(source);

  assert.equal(result.status, 'assessed');
  assert.equal(result.color, 'green');
  assert.deepEqual(result.actionCandidate, {
    kind: 'existing-obligations',
    obligationIds: ['verify-regression'],
  });
  assert.deepEqual(source, before, 'assessment must not mutate evidence or work input');
  assert.equal('command' in result, false);
  assert.equal('mutation' in result, false);
  assert.equal('completion' in result, false);
});

test('Yellow proposes only a bounded restore candidate using observed changed paths', () => {
  const result = assessFuturesEvidence(input({
    signals: {
      behavior: 'regressed',
      scope: 'within',
      architecture: 'not-required',
    },
  }));

  assert.equal(result.color, 'yellow');
  assert.deepEqual(result.actionCandidate, {
    kind: 'bounded-restore',
    allowedPaths: ['src/a.ts', 'src/b.ts'],
  });
});

test('Red routes scope expansion or structural decisions to architecture planning only', () => {
  const outside = assessFuturesEvidence(input({
    signals: {
      behavior: 'preserved',
      scope: 'outside',
      architecture: 'not-required',
    },
  }));
  const structural = assessFuturesEvidence(input({
    signals: {
      behavior: 'regressed',
      scope: 'within',
      architecture: 'required',
    },
  }));

  for (const result of [outside, structural]) {
    assert.equal(result.color, 'red');
    assert.equal(result.actionCandidate.kind, 'architecture-planning');
    assert.equal('execute' in result.actionCandidate, false);
    assert.equal('rollback' in result.actionCandidate, false);
  }
});

test('missing or unknown evidence remains incomplete instead of becoming Green or Yellow', () => {
  const evidence = collectFuturesEvidence({
    ...evidenceInput(),
    dependencyBoundaries: null,
    unknowns: ['dependency boundary unavailable'],
  });
  const result = assessFuturesEvidence(input({
    evidence,
    signals: {
      behavior: 'unknown',
      scope: 'within',
      architecture: 'not-required',
    },
  }));

  assert.equal(result.status, 'incomplete');
  assert.equal(result.color, null);
  assert.equal(result.actionCandidate.kind, 'collect-evidence');
  assert.ok(result.reasons.includes('evidence:dependency-boundaries-unavailable'));
  assert.ok(result.reasons.includes('evidence:unresolved-unknowns'));
  assert.ok(result.reasons.includes('signal:behavior-unknown'));
});

test('stale revision or content identity is rejected before assessment', () => {
  assert.throws(
    () => assessFuturesEvidence(input({ currentRevision: 13 })),
    /futures_assessment_stale:revision/,
  );
  assert.throws(
    () => assessFuturesEvidence(input({ currentContentDigest: sha('b') })),
    /futures_assessment_stale:contentDigest/,
  );
});

test('tampered evidence digest is rejected instead of being assessed', () => {
  const evidence = collectFuturesEvidence(evidenceInput());
  const tampered = {
    ...evidence,
    changeObservation: {
      ...evidence.changeObservation,
      changedPaths: ['src/forged.ts'],
    },
  };

  assert.throws(
    () => assessFuturesEvidence(input({
      evidence: tampered,
    })),
    /futures_assessment_invalid:evidence\.digest/,
  );
});

test('assessment digest is deterministic and bound to signal and evidence identity', () => {
  const first = assessFuturesEvidence(input());
  const second = assessFuturesEvidence(input({
    existingObligations: ['verify-regression', 'verify-regression'],
  }));
  const yellow = assessFuturesEvidence(input({
    signals: {
      behavior: 'regressed',
      scope: 'within',
      architecture: 'not-required',
    },
  }));

  assert.equal(first.digest, second.digest);
  assert.notEqual(first.digest, yellow.digest);
  assert.match(first.digest, /^sha256:[a-f0-9]{64}$/);
});
