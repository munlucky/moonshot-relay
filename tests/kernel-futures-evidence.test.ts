import test from 'node:test';
import assert from 'node:assert/strict';
import type { FuturesEvidenceInput } from '../src/contracts/futures-evidence.js';
import { collectFuturesEvidence } from '../src/kernel/proof/futures-evidence.js';

const digest = (char: string): string => `sha256:${char.repeat(64)}`;

const fixture = (): FuturesEvidenceInput => ({
  revision: 7,
  contentDigest: digest('a'),
  changeSet: {
    status: 'observed',
    reason: null,
    actualChangedPaths: ['src/z.ts', './src/a.ts', 'src/z.ts'],
  },
  dependencyBoundaries: [
    { fromPath: 'src/z.ts', toPath: 'src/contracts/z.ts' },
    { fromPath: './src/a.ts', toPath: 'src/contracts/a.ts' },
  ],
  regressionScope: ['test:focused', 'typecheck', 'test:focused'],
  unknowns: [],
});

test('identical semantic input produces identical deterministic Futures evidence', () => {
  const firstInput = fixture();
  const secondInput: FuturesEvidenceInput = {
    ...fixture(),
    changeSet: {
      status: 'observed',
      reason: null,
      actualChangedPaths: ['src/z.ts', 'src/a.ts'],
    },
    dependencyBoundaries: [
      { fromPath: 'src/a.ts', toPath: 'src/contracts/a.ts' },
      { fromPath: 'src/z.ts', toPath: 'src/contracts/z.ts' },
    ],
    regressionScope: ['typecheck', 'test:focused'],
  };
  const before = structuredClone(firstInput);

  const first = collectFuturesEvidence(firstInput);
  const second = collectFuturesEvidence(secondInput);

  assert.deepEqual(first, second);
  assert.deepEqual(firstInput, before, 'collector must not mutate its input');
  assert.equal(first.status, 'complete');
  assert.deepEqual(first.changeObservation.changedPaths, ['src/a.ts', 'src/z.ts']);
  assert.deepEqual(first.regressionScope, ['test:focused', 'typecheck']);
  assert.match(first.digest, /^sha256:[a-f0-9]{64}$/);
});

test('revision and content digest are both part of the evidence identity', () => {
  const baseline = collectFuturesEvidence(fixture());
  const nextRevision = collectFuturesEvidence({ ...fixture(), revision: 8 });
  const nextContent = collectFuturesEvidence({ ...fixture(), contentDigest: digest('b') });

  assert.notEqual(nextRevision.digest, baseline.digest);
  assert.notEqual(nextContent.digest, baseline.digest);
});

test('missing observations stay incomplete instead of collapsing to a low-risk value', () => {
  const evidence = collectFuturesEvidence({
    revision: 'rev-9',
    contentDigest: digest('c'),
    changeSet: {
      status: 'unavailable',
      reason: 'workspace-baseline-unknown',
      actualChangedPaths: null,
    },
    dependencyBoundaries: null,
    regressionScope: null,
    unknowns: ['dependency graph unavailable'],
  });

  assert.equal(evidence.status, 'incomplete');
  assert.deepEqual(evidence.incompleteReasons, [
    'changed-paths-unavailable',
    'dependency-boundaries-unavailable',
    'regression-scope-unavailable',
    'unresolved-unknowns',
  ]);
  assert.equal(evidence.changeObservation.changedPaths, null);
  assert.equal(evidence.dependencyBoundaries, null);
  assert.equal(evidence.regressionScope, null);
  assert.equal('risk' in evidence, false, 'collection must not perform model/risk assessment');
});

test('explicitly observed empty sets are distinct from unavailable evidence', () => {
  const evidence = collectFuturesEvidence({
    revision: 10,
    contentDigest: digest('d'),
    changeSet: { status: 'observed', reason: null, actualChangedPaths: [] },
    dependencyBoundaries: [],
    regressionScope: [],
    unknowns: [],
  });

  assert.equal(evidence.status, 'complete');
  assert.deepEqual(evidence.incompleteReasons, []);
  assert.deepEqual(evidence.changeObservation.changedPaths, []);
  assert.deepEqual(evidence.dependencyBoundaries, []);
  assert.deepEqual(evidence.regressionScope, []);
});

test('contaminated identities and paths are rejected instead of normalized into evidence', () => {
  assert.throws(
    () => collectFuturesEvidence({ ...fixture(), contentDigest: 'not-a-digest' }),
    /futures_evidence_invalid:contentDigest/,
  );
  assert.throws(
    () => collectFuturesEvidence({
      ...fixture(),
      changeSet: {
        status: 'observed',
        reason: null,
        actualChangedPaths: ['../outside.ts'],
      },
    }),
    /futures_evidence_invalid:changeSet\.actualChangedPaths/,
  );
  assert.throws(
    () => collectFuturesEvidence({
      ...fixture(),
      dependencyBoundaries: [
        { fromPath: '/absolute/source.ts', toPath: 'src/target.ts' },
      ],
    }),
    /futures_evidence_invalid:dependencyBoundaries\[0\]\.fromPath/,
  );
});
