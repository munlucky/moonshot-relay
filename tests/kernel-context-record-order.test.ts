import test from 'node:test';
import assert from 'node:assert/strict';
import { buildKernelContextSegments, sortContextRecords, canonicalizeRecord } from '../src/host/kernel/context-segments.js';

const shuffle = <T>(list: readonly T[]) => [...list].reverse();

test('record order in the database does not change the digest', () => {
  const anchors = [
    { id: 'pa2', type: 'policy_anchor', revision: 'r1', statement: 'Second anchor.' },
    { id: 'pa1', type: 'policy_anchor', revision: 'r1', statement: 'First anchor.' },
    { id: 'pa3', type: 'policy_anchor', revision: 'r1', statement: 'Third anchor.' },
  ];
  const forward = buildKernelContextSegments({ projectStable: { policyAnchors: anchors } });
  const reversed = buildKernelContextSegments({ projectStable: { policyAnchors: shuffle(anchors) } });
  assert.equal(forward.segments.projectStable.digest, reversed.segments.projectStable.digest);
});

test('knowledge sorts by type, then id, then revision, then digest', () => {
  const records = [
    { type: 'b', id: '2', revision: 'r1', contentDigest: 'd' },
    { type: 'a', id: '2', revision: 'r1', contentDigest: 'd' },
    { type: 'a', id: '1', revision: 'r2', contentDigest: 'd' },
    { type: 'a', id: '1', revision: 'r1', contentDigest: 'd' },
  ];
  assert.deepEqual(
    sortContextRecords(records, 'knowledge').map((r) => `${r.type}${r.id}${r.revision}`),
    ['a1r1', 'a1r2', 'a2r1', 'b2r1'],
  );
});

test('evidence sorts by obligation, then digest, then status', () => {
  const evidence = [
    { obligationId: 'b', evidenceDigest: 'x', status: 'passed' },
    { obligationId: 'a', evidenceDigest: 'y', status: 'failed' },
    { obligationId: 'a', evidenceDigest: 'x', status: 'passed' },
  ];
  assert.deepEqual(
    sortContextRecords(evidence, 'evidence').map((r) => `${r.obligationId}${r.evidenceDigest}`),
    ['ax', 'ay', 'bx'],
  );
});

test('graph relations sort by from, relation, to', () => {
  const graph = [
    { from: 'b', relation: 'uses', to: 'a' },
    { from: 'a', relation: 'uses', to: 'c' },
    { from: 'a', relation: 'owns', to: 'z' },
  ];
  assert.deepEqual(
    sortContextRecords(graph, 'graph').map((r) => `${r.from}-${r.relation}-${r.to}`),
    ['a-owns-z', 'a-uses-c', 'b-uses-a'],
  );
});

test('records that tie on every declared key still order deterministically', () => {
  const tied = [
    { type: 'a', id: '1', revision: 'r1', contentDigest: 'd', extra: 'zeta' },
    { type: 'a', id: '1', revision: 'r1', contentDigest: 'd', extra: 'alpha' },
  ];
  assert.deepEqual(sortContextRecords(tied, 'knowledge'), sortContextRecords(shuffle(tied), 'knowledge'));
});

test('canonicalization drops observation fields and sorts keys', () => {
  const canonical = canonicalizeRecord({ z: 1, a: 2, observedAt: 'now', rowid: 7, score: 0.5 });
  assert.ok(canonical && typeof canonical === 'object');
  assert.deepEqual(Object.keys(canonical), ['a', 'z']);
});
