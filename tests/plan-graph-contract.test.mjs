import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { after, test } from 'node:test';

import {
  detectScopeDrift,
  markdownPlanCompatibility,
  schedulablePhases,
  validatePlanGraph,
} from '../scripts/lib/plan-graph.mjs';

const tempRoots = [];

after(async () => {
  await Promise.all(tempRoots.map((dir) => rm(dir, { recursive: true, force: true })));
});

const validGraph = () => ({
  schemaVersion: 1,
  planId: 'evidence-driven-agent-harness',
  executionMode: 'graph',
  phases: [
    {
      id: 'phase-01',
      doc: '01-architecture-contract-normalization-v1.md',
      ownedPaths: ['docs/public/roadmaps/evidence-driven-agent-harness/architecture-handoff/**'],
      acceptanceEvidence: ['execution/phase-01/SCORECARD.md'],
    },
    {
      id: 'phase-02',
      doc: '02-candidate-identity-and-artifact-schemas-v1.md',
      dependsOn: ['phase-01'],
      parallelGroup: 'schema',
      ownedPaths: ['schemas/candidate-identity.schema.json', 'scripts/lib/candidate-identity.js'],
    },
    {
      id: 'phase-03',
      doc: '03-contract-engine-and-spec-revision-v1.md',
      dependsOn: ['phase-01'],
      parallelGroup: 'schema',
      ownedPaths: ['schemas/task-contract.schema.json', 'scripts/contract-engine.mjs'],
    },
  ],
});

test('plan graph validates dependencies and non-overlapping parallel write sets', () => {
  const result = validatePlanGraph(validGraph());
  assert.equal(result.status, 'pass');
  assert.deepEqual(result.findings, []);
  assert.deepEqual(schedulablePhases({ graph: validGraph(), completed: ['phase-01'] }), ['phase-02', 'phase-03']);
});

test('plan graph blocks missing dependencies and parallel write conflicts', () => {
  const graph = validGraph();
  graph.phases[1].dependsOn = ['phase-99'];
  graph.phases[2].ownedPaths = ['scripts/lib/candidate-identity.js'];
  const result = validatePlanGraph(graph);

  assert.equal(result.status, 'blocked');
  assert.deepEqual(result.findings.map((finding) => finding.type), ['missing_dependency', 'parallel_write_conflict']);
});

test('plan graph requires schema identity and phase doc bindings', () => {
  const graph = {
    phases: [
      { id: 'phase-01', ownedPaths: ['scripts/a.mjs'] },
    ],
  };
  const result = validatePlanGraph(graph, { expectedPhaseDocs: ['01-a-v1.md'] });

  assert.equal(result.status, 'blocked');
  assert.deepEqual(result.findings.map((finding) => finding.type), [
    'missing_schema_version',
    'missing_plan_id',
    'missing_phase_doc',
    'missing_graph_phase_doc',
  ]);
});

test('scope drift reports actual changed files outside declared write set', () => {
  const result = detectScopeDrift({
    declaredWriteSet: ['scripts/lib/**', 'schemas/plan-graph.schema.json'],
    changedFiles: ['scripts/lib/plan-graph.mjs', 'docs/public/repository-layout.md'],
  });

  assert.equal(result.status, 'drift');
  assert.deepEqual(result.driftFiles, ['docs/public/repository-layout.md']);
  assert.equal(result.findings[0].type, 'scope_drift');
});

test('markdown-only phase packages remain supported until migration is explicit', () => {
  const result = markdownPlanCompatibility({ phaseDocs: ['01-a.md', '02-b.md'] });
  assert.equal(result.status, 'supported');
  assert.equal(result.executionMode, 'markdown-compatible');
});

test('plan graph CLI blocks scope drift', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'moonshot-plan-graph-'));
  tempRoots.push(tempRoot);
  const graphPath = path.join(tempRoot, 'plan-graph.json');
  await writeFile(graphPath, JSON.stringify(validGraph(), null, 2));

  const result = spawnSync(process.execPath, [
    'scripts/plan-graph-validate.mjs',
    '--graph',
    graphPath,
    '--changed-files-json',
    JSON.stringify(['skills/moonshot-phase-runner/SKILL.md']),
    '--json',
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });

  assert.equal(result.status, 2, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.status, 'blocked');
  assert.equal(payload.drift.status, 'drift');
});
