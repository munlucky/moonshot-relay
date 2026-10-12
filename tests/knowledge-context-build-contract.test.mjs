import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { rebuildKnowledgeProjection } from '../scripts/kernel/knowledge/projection.js';
import { openKernelStateStore } from '../scripts/kernel/state-store.js';

const root = process.cwd();
const tempRoots = [];

after(async () => {
  await Promise.all(tempRoots.map((dir) => rm(dir, { recursive: true, force: true })));
});

const runContext = (stage, env = {}) => {
  const result = spawnSync(process.execPath, [
    'scripts/knowledge-context-build.mjs',
    '--cwd',
    root,
    '--stage',
    stage,
    '--json',
  ], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout).projectKnowledgeContext;
};

const projectIdentity = (env = {}) => {
  const result = spawnSync(process.execPath, [
    'scripts/project-identity.mjs',
    '--cwd',
    root,
    '--json',
  ], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
};

const writeJsonl = async (filePath, records) => {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8');
};

test('knowledge-context-build keeps promptBlock usable when contextPack is ignored', () => {
  const context = runContext('execute');
  const { contextPack, metadata, ...legacyConsumerView } = context;

  assert.ok(contextPack);
  assert.ok(metadata);
  assert.equal(typeof legacyConsumerView.promptBlock, 'string');
  assert.equal(legacyConsumerView.stage, 'execute');
  assert.ok(Array.isArray(legacyConsumerView.semanticFacts));
  assert.ok(Array.isArray(legacyConsumerView.graphSynopsis));
  assert.ok(Array.isArray(legacyConsumerView.ontologyConstraints));
});

test('knowledge-context-build keeps runtimeAuthorityRef optional for intake and plan contexts', () => {
  const intake = runContext('intake');
  const plan = runContext('plan');

  assert.equal(intake.contextPack.runtimeAuthorityRef, null);
  assert.equal(plan.contextPack.runtimeAuthorityRef, null);
  assert.equal(intake.metadata.servingMode, intake.strictness);
  assert.equal(plan.metadata.servingMode, plan.strictness);
});

test('knowledge-context-build supports memory control-plane stages', () => {
  for (const stage of ['init', 'requirements', 'design', 'validate-plan', 'prepare', 'review', 'score', 'replan', 'close']) {
    const context = runContext(stage);
    assert.equal(context.stage, stage);
    assert.equal(context.contextPack.stage, stage);
    assert.equal(context.contextPack.promptFacingAuthority, 'projectKnowledgeContext.promptBlock');
    assert.equal(context.promptBlock.includes('candidateMemory'), false);
  }
});

test('knowledge-context-build enforces stage-scoped retrieval omissions', async () => {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'knowledge-stage-policy-'));
  tempRoots.push(stateRoot);
  const env = { MOONSHOT_RELAY_STATE_ROOT: stateRoot };
  const identity = projectIdentity(env);
  const projectId = identity.identity.projectId;
  const knowledgeRoot = identity.namespaces.knowledgeRoot;

  await mkdir(knowledgeRoot, { recursive: true });
  await writeFile(path.join(knowledgeRoot, 'revision.json'), JSON.stringify({
    revision: 'stage-policy-test',
    updatedAt: '2026-07-09T00:00:00.000Z',
  }), 'utf8');
  await writeJsonl(path.join(knowledgeRoot, 'semantic', 'verified-facts.jsonl'), [{
    type: 'semantic_fact',
    id: 'fact:solution-memory',
    projectId,
    status: 'verified',
    createdAt: '2026-07-09T00:00:00.000Z',
    updatedAt: '2026-07-09T00:00:00.000Z',
    statement: 'prior solution patch must not be used as a subjective score',
    sourceType: 'test',
    sourceRef: 'tests/knowledge-context-build-contract.test.mjs',
    trustTier: 'verified',
    provenanceRef: 'cmd:stage-policy',
    verifiedBy: 'test:stage-policy',
    verifiedAt: '2026-07-09T00:00:00.000Z',
    supersedes: [],
  }]);
  await writeJsonl(path.join(knowledgeRoot, 'graph', 'kg-relations.jsonl'), [{
    type: 'kg_relation',
    id: 'kg:design-conclusion',
    projectId,
    status: 'verified',
    createdAt: '2026-07-09T00:00:00.000Z',
    updatedAt: '2026-07-09T00:00:00.000Z',
    from: 'design',
    to: 'requirement',
    relation: 'CONCLUDED_AS',
    sourceRef: 'tests/knowledge-context-build-contract.test.mjs',
    trustTier: 'verified',
    supersedes: [],
  }]);
  await writeJsonl(path.join(knowledgeRoot, 'ontology', 'constraints.jsonl'), [{
    type: 'ontology_constraint',
    id: 'constraint:evidence-only-score',
    projectId,
    status: 'verified',
    createdAt: '2026-07-09T00:00:00.000Z',
    updatedAt: '2026-07-09T00:00:00.000Z',
    scope: 'score',
    appliesTo: ['memory_quality'],
    severity: 'blocking',
    enforcedBy: 'scripts/verification-plane.mjs',
    sourceRef: 'docs/public/guidelines/memory-control-plane.md',
    supersedes: [],
  }]);

  const requirements = runContext('requirements', env);
  assert.equal(requirements.semanticFacts.length, 1);
  assert.equal(requirements.graphSynopsis.length, 0);
  assert.ok(requirements.omittedByPolicy.some((item) => item.reason === 'stage_requirements_forbids_kg_relation'));

  const score = runContext('score', env);
  assert.equal(score.semanticFacts.length, 0);
  assert.equal(score.graphSynopsis.length, 0);
  assert.ok(score.ontologyConstraints.some((item) => item.id === 'ontology:constraint:evidence-only-score'));
  assert.ok(score.omittedByPolicy.some((item) => item.reason === 'stage_score_forbids_semantic_fact'));
  assert.equal(score.promptBlock.includes('prior solution patch'), false);
});

test('knowledge-context-build reads the canonical projection layout produced from SQLite', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'knowledge-canonical-context-'));
  tempRoots.push(runtimeHome);
  const env = {
    MOON_RELAY_KERNEL_HOME: runtimeHome,
    MOONSHOT_RELAY_STATE_ROOT: path.join(runtimeHome, 'state'),
  };
  const identity = projectIdentity(env);
  const projectId = identity.identity.projectId;
  const store = await openKernelStateStore({ runtimeHome });

  try {
    store.saveKnowledgeRecord(projectId, 'policy-c31-canonical', {
      recordType: 'policy_anchor',
      status: 'committed',
      trustTier: 'verified',
      recordJson: {
        id: 'policy-c31-canonical',
        projectId,
        type: 'policy_anchor',
        statement: 'Canonical projection policy reaches the prompt consumer.',
        scope: ['scripts/**'],
        status: 'committed',
        trustTier: 'verified',
        createdAt: new Date().toISOString(),
        sourceRefs: ['scripts/knowledge-context-build.mjs'],
        sourceDigest: 'sha256:c31-canonical-source',
      },
      revision: 1,
    });

    const projection = await rebuildKnowledgeProjection(projectId, {
      stateStore: store,
      runtimeHome,
      env,
    });
    assert.equal(projection.status, 'rebuilt');

    const context = runContext('plan', env);
    assert.equal(context.status, 'ready');
    assert.ok(context.policyAnchors.some((item) => (
      item.id === 'policy:policy-c31-canonical'
      && item.text === 'Canonical projection policy reaches the prompt consumer.'
      && item.sourceRef === 'scripts/knowledge-context-build.mjs'
    )));
    assert.equal(
      context.metadata.unavailableCount,
      0,
    );
    assert.equal(
      context.knowledgeRevision,
      String(store.getProjectKnowledgeRevision(projectId)),
    );
  } finally {
    store.close();
  }
});

test('canonical projection tamper deletion and stale revision never mutate SQLite authority and regeneration restores consumer read', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'knowledge-canonical-derived-'));
  tempRoots.push(runtimeHome);
  const env = {
    MOON_RELAY_KERNEL_HOME: runtimeHome,
    MOONSHOT_RELAY_STATE_ROOT: path.join(runtimeHome, 'state'),
  };
  const identity = projectIdentity(env);
  const projectId = identity.identity.projectId;
  const store = await openKernelStateStore({ runtimeHome });

  try {
    store.saveKnowledgeRecord(projectId, 'policy-c31-derived', {
      recordType: 'policy_anchor',
      status: 'committed',
      trustTier: 'verified',
      recordJson: {
        id: 'policy-c31-derived',
        projectId,
        type: 'policy_anchor',
        statement: 'Projection artifacts are derived from SQLite authority.',
        scope: ['scripts/**'],
        status: 'committed',
        trustTier: 'verified',
        createdAt: new Date().toISOString(),
        sourceRefs: ['scripts/knowledge-context-build.mjs'],
      },
      revision: 1,
    });

    const rebuild = async () => {
      const result = await rebuildKnowledgeProjection(projectId, {
        stateStore: store,
        runtimeHome,
        env,
      });
      assert.equal(result.status, 'rebuilt');
      return result;
    };
    let projection = await rebuild();
    const authorityRevision = store.getProjectKnowledgeRevision(projectId);
    const authorityRecord = () => store
      .listKnowledgeRecords({
        projectId,
        statuses: ['committed', 'verified'],
      })
      .find((record) => record.id === 'policy-c31-derived');

    const policyPath = path.join(projection.projectDir, 'policy', 'anchors.jsonl');
    await writeFile(policyPath, '{"tampered":', 'utf8');
    const tampered = runContext('plan', env);
    assert.equal(tampered.status, 'degraded_read');
    assert.ok(authorityRecord());
    assert.equal(store.getProjectKnowledgeRevision(projectId), authorityRevision);

    projection = await rebuild();
    const restored = runContext('plan', env);
    assert.equal(restored.status, 'ready');
    assert.ok(restored.policyAnchors.some((item) => item.id === 'policy:policy-c31-derived'));

    const revisionPath = path.join(projection.projectDir, 'revision.json');
    const manifest = JSON.parse(await readFile(revisionPath, 'utf8'));
    await writeFile(revisionPath, JSON.stringify({
      ...manifest,
      updatedAt: '2000-01-01T00:00:00.000Z',
    }), 'utf8');
    const stale = runContext('plan', env);
    assert.equal(stale.status, 'stale');
    assert.ok(stale.policyAnchors.some((item) => item.id === 'policy:policy-c31-derived'));
    assert.equal(store.getProjectKnowledgeRevision(projectId), authorityRevision);

    projection = await rebuild();
    await rm(path.join(projection.projectDir, 'policy', 'anchors.jsonl'));
    const deleted = runContext('plan', env);
    assert.equal(
      deleted.policyAnchors.some((item) => item.id === 'policy:policy-c31-derived'),
      false,
    );
    assert.ok(authorityRecord());
    assert.equal(store.getProjectKnowledgeRevision(projectId), authorityRevision);

    await rebuild();
    const regenerated = runContext('plan', env);
    assert.ok(regenerated.policyAnchors.some((item) => item.id === 'policy:policy-c31-derived'));
    assert.equal(store.getProjectKnowledgeRevision(projectId), authorityRevision);
  } finally {
    store.close();
  }
});
