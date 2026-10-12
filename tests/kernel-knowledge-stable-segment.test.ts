import test from 'node:test';
import assert from 'node:assert/strict';
import { buildKernelContextSegments } from '../src/host/kernel/context-segments.js';

// Only globally-scoped, long-lived knowledge earns a place in the project
// prefix. Promoting a record merely because its `scope` field is empty would
// put run-local facts in front of the cache boundary and churn it every turn.
const PROJECT_STABLE_TYPES = ['policy_anchor', 'architecture_decision', 'ontology_constraint', 'domain_term'];

export const isProjectStable = (record: { isGlobal?: boolean; type: string; scope?: readonly string[] }) => record.isGlobal === true && PROJECT_STABLE_TYPES.includes(record.type);

test('only global records of the four stable types qualify', () => {
  assert.equal(isProjectStable({ isGlobal: true, type: 'policy_anchor' }), true);
  assert.equal(isProjectStable({ isGlobal: true, type: 'architecture_decision' }), true);
  assert.equal(isProjectStable({ isGlobal: true, type: 'ontology_constraint' }), true);
  assert.equal(isProjectStable({ isGlobal: true, type: 'domain_term' }), true);
  assert.equal(isProjectStable({ isGlobal: true, type: 'semantic_fact' }), false);
  assert.equal(isProjectStable({ isGlobal: true, type: 'episodic_observation' }), false);
});

test('an empty scope alone does not promote a record', () => {
  assert.equal(isProjectStable({ type: 'policy_anchor', scope: [] }), false);
  assert.equal(isProjectStable({ type: 'policy_anchor', scope: [], isGlobal: false }), false);
});

test('the project segment renders each stable knowledge family under its own heading', () => {
  const built = buildKernelContextSegments({
    projectStable: {
      policyAnchors: [{ id: 'pa1', type: 'policy_anchor', revision: 'r1', statement: 'Core stays provider-neutral.' }],
      architectureRecords: [{ id: 'ad1', type: 'architecture_decision', revision: 'r1', statement: 'Host owns model identity.' }],
      ontologyConstraints: [{ id: 'oc1', type: 'ontology_constraint', revision: 'r1', severity: 'invariant', statement: 'Unmeasured stays null.' }],
      domainTerms: [{ id: 'dt1', type: 'domain_term', revision: 'r1', statement: 'A capsule is a bounded work unit.' }],
    },
  });
  const content = built.segments.projectStable.content;
  for (const heading of ['Policy Anchors', 'Architecture Decisions', 'Ontology Constraints', 'Domain Terms']) {
    assert.match(content, new RegExp(heading));
  }
  assert.match(content, /\[invariant\]/);
});

test('task-selected knowledge renders in the volatile tail, not the project prefix', () => {
  const built = buildKernelContextSegments({
    projectStable: { policyAnchors: [{ id: 'pa1', type: 'policy_anchor', revision: 'r1', statement: 'Stable.' }] },
    volatile: { taskKnowledge: [{ id: 'tk1', type: 'semantic_fact', revision: 'r1', statement: 'Run-local fact.' }] },
  });
  assert.match(built.segments.volatile.content, /Run-local fact/);
  assert.doesNotMatch(built.segments.projectStable.content, /Run-local fact/);
});

test('secrets are redacted before a knowledge record reaches a prompt segment', () => {
  const built = buildKernelContextSegments({
    projectStable: { policyAnchors: [{ id: 'pa1', type: 'policy_anchor', revision: 'r1', statement: 'Use api_key: sk-abcdefghijklmnopqrstuvwx for staging.' }] },
  });
  assert.doesNotMatch(built.segments.projectStable.content, /sk-abcdefghijklmnopqrstuvwx/);
  assert.match(built.segments.projectStable.content, /REDACTED/);
});
