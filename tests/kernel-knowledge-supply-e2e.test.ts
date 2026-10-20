import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createKernelControlPlane } from '../src/host/kernel/control-plane-runtime.js';
import { computeSourceDigest } from '../src/kernel/knowledge/freshness.js';

type UnknownRecord = Record<string, unknown>;

const asRecord = (value: unknown): UnknownRecord => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as UnknownRecord;
};

const asRecords = (value: unknown): UnknownRecord[] => {
  assert.ok(Array.isArray(value));
  return value.map(asRecord);
};

const ids = (value: unknown): string[] => asRecords(value).map((entry) => String(entry.id));

const hasReason = (value: unknown, id: string, reason: string): boolean => (
  asRecords(value).some((entry) => entry.id === id && entry.reason === reason)
);

const occurrenceCount = (text: string, needle: string): number => (
  text.split(needle).length - 1
);

test('W4: stage materialization supplies only fresh relevant canonical Knowledge across FRAME EXECUTE and PROVE', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'kernel-knowledge-supply-e2e-'));
  const runtimeHome = path.join(tmp, 'runtime');
  const projectRoot = path.join(tmp, 'project');
  const sourcePath = 'src/service.ts';
  const architecturePath = 'docs/architecture.md';
  const driftPath = 'docs/drift.md';

  await mkdir(path.join(projectRoot, 'src'), { recursive: true });
  await mkdir(path.join(projectRoot, 'docs'), { recursive: true });
  await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({
    name: 'knowledge-supply-e2e',
    scripts: { test: 'node -e "process.exit(0)"' },
  }));
  await writeFile(path.join(projectRoot, sourcePath), 'export const serviceMode = "bounded";\n');
  await writeFile(path.join(projectRoot, architecturePath), 'Service changes stay inside the bounded service layer.\n');
  await writeFile(path.join(projectRoot, driftPath), 'before drift\n');

  const cp = await createKernelControlPlane({ runtimeHome, projectRoot, holder: 'w4-supply-e2e' });
  try {
    const seed = await cp.startRun({
      runId: 'run-supply-seed',
      objective: 'Resolve Knowledge project identity for supply fixture',
    });
    assert.ok(seed.projectId);
    const projectId = String(seed.projectId);
    await cp.abandon('run-supply-seed', { reason: 'fixture_seed_complete' });

    const sourceDigest = computeSourceDigest({ projectRoot, sourceRefs: [sourcePath] });
    const architectureDigest = computeSourceDigest({ projectRoot, sourceRefs: [architecturePath] });
    const driftDigest = computeSourceDigest({ projectRoot, sourceRefs: [driftPath] });

    const records: Array<{ id: string; type: string; record: UnknownRecord }> = [
      {
        id: 'K1-frame-architecture',
        type: 'architecture_decision',
        record: {
          id: 'K1-frame-architecture', projectId, type: 'architecture_decision', status: 'committed', trustTier: 'verified',
          statement: 'Service changes must preserve the bounded service architecture.',
          scope: ['src/**'], sourceRefs: [architecturePath], sourceDigest: architectureDigest,
        },
      },
      {
        id: 'K2-execute-fact',
        type: 'semantic_fact',
        record: {
          id: 'K2-execute-fact', projectId, type: 'semantic_fact', status: 'committed', trustTier: 'verified',
          statement: 'Service implementation uses the bounded service mode.',
          scope: ['src/**'], sourceRefs: [sourcePath], sourceDigest,
        },
      },
      {
        id: 'K3-procedure-a',
        type: 'episodic_observation',
        record: {
          id: 'K3-procedure-a', projectId, type: 'episodic_observation', status: 'committed', trustTier: 'verified',
          statement: 'Procedure metadata: bounded service repair', scope: ['src/**'], sourceRefs: [sourcePath], sourceDigest,
          practiceJson: {
            kind: 'procedure',
            metadata: { title: 'Bounded service repair', summary: 'bounded service repair', appliesTo: ['src/**'], validUntil: '2099-01-01T00:00:00.000Z' },
            body: { prerequisites: ['inspect current service evidence'], steps: ['PROCEDURE_STEP_A'], verification: ['run focused service verification'], prohibitions: ['do not widen scope'] },
          },
        },
      },
      {
        id: 'K4-procedure-b',
        type: 'episodic_observation',
        record: {
          id: 'K4-procedure-b', projectId, type: 'episodic_observation', status: 'committed', trustTier: 'verified',
          statement: 'Procedure metadata: bounded service repair', scope: ['src/**'], sourceRefs: [sourcePath], sourceDigest,
          practiceJson: {
            kind: 'procedure',
            metadata: { title: 'Bounded service repair', summary: 'bounded service repair', appliesTo: ['src/**'], validUntil: '2099-01-01T00:00:00.000Z' },
            body: { prerequisites: ['inspect current service evidence'], steps: ['PROCEDURE_STEP_B'], verification: ['run focused service verification'], prohibitions: ['do not widen scope'] },
          },
        },
      },
      {
        id: 'K5-prove-verification',
        type: 'required_verification',
        record: {
          id: 'K5-prove-verification', projectId, type: 'required_verification', status: 'committed', trustTier: 'verified',
          statement: 'Run the bounded service verification before accepting the change.',
          scope: ['src/**'], sourceRefs: [sourcePath], sourceDigest,
          verification: { commandRefs: ['test:service'], obligationId: 'service-proof', method: 'command', evidenceLevel: 'work' },
        },
      },
      ...['K6-known-failure', 'K7-known-failure-duplicate'].map((id) => ({
        id,
        type: 'known_failure_pattern',
        record: {
          id, projectId, type: 'known_failure_pattern', status: 'committed', trustTier: 'verified',
          statement: 'Service regression repeats when bounded state is bypassed.',
          scope: ['src/**'], sourceRefs: [sourcePath], sourceDigest,
        },
      })),
      {
        id: 'K8-missing-source',
        type: 'semantic_fact',
        record: {
          id: 'K8-missing-source', projectId, type: 'semantic_fact', status: 'committed', trustTier: 'verified',
          statement: 'Missing source Knowledge must never be supplied.',
          scope: ['src/**'], sourceRefs: ['docs/missing-source.md'], sourceDigest: 'sha256:missing',
        },
      },
      {
        id: 'K9-changed-source',
        type: 'semantic_fact',
        record: {
          id: 'K9-changed-source', projectId, type: 'semantic_fact', status: 'committed', trustTier: 'verified',
          statement: 'Changed source Knowledge requires deep verification before reuse.',
          scope: ['src/**'], sourceRefs: [driftPath], sourceDigest: driftDigest,
        },
      },
      {
        id: 'K10-scope-only-fact',
        type: 'semantic_fact',
        record: {
          id: 'K10-scope-only-fact', projectId, type: 'semantic_fact', status: 'committed', trustTier: 'verified',
          statement: 'Scope-only service guidance remains eligible without source refs.',
          scope: ['src/**'],
        },
      },
      {
        id: 'K11-wrong-stage-component',
        type: 'component_boundary',
        record: {
          id: 'K11-wrong-stage-component', projectId, type: 'component_boundary', status: 'committed', trustTier: 'verified',
          statement: 'The service component boundary applies only during implementation context.',
          scope: ['src/**'], sourceRefs: [sourcePath], sourceDigest,
        },
      },
    ];

    for (const entry of records) {
      cp.stateStore.saveKnowledgeRecord(projectId, entry.id, {
        recordType: entry.type,
        status: 'committed',
        trustTier: 'verified',
        revision: 1,
        recordJson: entry.record,
      });
    }

    // K9 becomes drifted only after its committed digest is fixed.
    await writeFile(path.join(projectRoot, driftPath), 'after drift\n');

    const target = await cp.startRun({
      runId: 'run-supply-target',
      objective: 'Implement and verify the bounded service change',
    });
    assert.equal(target.projectId, projectId);

    const contextInput = { taskContract: { changedPaths: [sourcePath] } };

    const frame = asRecord(await cp.buildStageContext('run-supply-target', { stage: 'FRAME', ...contextInput }));
    const frameKnowledge = asRecord(frame.knowledgeContext);
    assert.equal(frameKnowledge.status, 'ready-populated');
    assert.deepEqual(ids(frameKnowledge.semanticFacts).sort(), [
      'K1-frame-architecture',
      'K10-scope-only-fact',
      'K2-execute-fact',
      'K3-procedure-a',
      'K4-procedure-b',
    ].sort());
    assert.ok(hasReason(frameKnowledge.omittedByPolicy, 'K5-prove-verification', 'type_required_verification_not_in_FRAME'));
    assert.ok(hasReason(frameKnowledge.omittedByPolicy, 'K11-wrong-stage-component', 'type_component_boundary_not_in_FRAME'));
    assert.ok(hasReason(frameKnowledge.staleOrUnavailable, 'K8-missing-source', 'freshness_stale'));
    assert.ok(hasReason(frameKnowledge.staleOrUnavailable, 'K9-changed-source', 'freshness_needs_deep_verify'));
    assert.equal(asRecords(frameKnowledge.staleOrUnavailable).some((entry) => entry.id === 'K10-scope-only-fact'), false);
    assert.match(String(frameKnowledge.promptBlock), /bounded service architecture/);
    assert.match(String(frameKnowledge.promptBlock), /bounded service mode/);
    assert.doesNotMatch(String(frameKnowledge.promptBlock), /Missing source Knowledge/);
    assert.doesNotMatch(String(frameKnowledge.promptBlock), /Changed source Knowledge/);
    assert.doesNotMatch(String(frameKnowledge.promptBlock), /component boundary applies only during implementation/);

    const frameRepeat = asRecord(await cp.buildStageContext('run-supply-target', { stage: 'FRAME', ...contextInput }));
    assert.equal(asRecord(frameRepeat.knowledgeContext).digest, frameKnowledge.digest);
    const frameReceipt = cp.stateStore.getKnowledgeContextReceipt('run-supply-target', 'FRAME');
    assert.equal(frameReceipt?.digest, frameKnowledge.digest);

    await cp.transition('run-supply-target', 'EXECUTE');
    const execute = asRecord(await cp.buildStageContext('run-supply-target', { stage: 'EXECUTE', ...contextInput }));
    const executeKnowledge = asRecord(execute.knowledgeContext);
    assert.equal(executeKnowledge.status, 'ready-populated');
    assert.deepEqual(ids(executeKnowledge.semanticFacts).sort(), [
      'K10-scope-only-fact',
      'K11-wrong-stage-component',
      'K2-execute-fact',
      'K3-procedure-a',
      'K4-procedure-b',
      'K5-prove-verification',
    ].sort());
    assert.ok(hasReason(executeKnowledge.omittedByPolicy, 'K1-frame-architecture', 'type_architecture_decision_not_in_EXECUTE'));
    assert.ok(hasReason(executeKnowledge.omittedByPolicy, 'K6-known-failure', 'type_known_failure_pattern_not_in_EXECUTE'));
    assert.match(String(executeKnowledge.promptBlock), /PROCEDURE_STEP_A/);
    assert.match(String(executeKnowledge.promptBlock), /PROCEDURE_STEP_B/);
    assert.match(String(executeKnowledge.promptBlock), /Run the bounded service verification before accepting the change/);
    assert.doesNotMatch(String(executeKnowledge.promptBlock), /bounded service architecture/);
    assert.doesNotMatch(String(executeKnowledge.promptBlock), /Missing source Knowledge/);
    assert.doesNotMatch(String(executeKnowledge.promptBlock), /Changed source Knowledge/);
    assert.equal(asRecords(executeKnowledge.semanticFacts).filter((entry) => entry.statement === 'Procedure metadata: bounded service repair').length, 2);
    assert.ok(hasReason(executeKnowledge.staleOrUnavailable, 'K8-missing-source', 'freshness_stale'));
    assert.ok(hasReason(executeKnowledge.staleOrUnavailable, 'K9-changed-source', 'freshness_needs_deep_verify'));

    const executeRepeat = asRecord(await cp.buildStageContext('run-supply-target', { stage: 'EXECUTE', ...contextInput }));
    assert.equal(asRecord(executeRepeat.knowledgeContext).digest, executeKnowledge.digest);
    assert.equal(cp.stateStore.getKnowledgeContextReceipt('run-supply-target', 'EXECUTE')?.digest, executeKnowledge.digest);

    await cp.transition('run-supply-target', 'PROVE');
    const prove = asRecord(await cp.buildStageContext('run-supply-target', { stage: 'PROVE', ...contextInput }));
    const proveKnowledge = asRecord(prove.knowledgeContext);
    assert.equal(proveKnowledge.status, 'ready-populated');
    assert.deepEqual(ids(proveKnowledge.semanticFacts).sort(), [
      'K10-scope-only-fact',
      'K2-execute-fact',
      'K5-prove-verification',
      'K6-known-failure',
    ].sort());
    assert.ok(hasReason(proveKnowledge.omittedByPolicy, 'K7-known-failure-duplicate', 'canonical_duplicate'));
    assert.ok(hasReason(proveKnowledge.omittedByPolicy, 'K3-procedure-a', 'type_episodic_observation_not_in_PROVE'));
    assert.ok(hasReason(proveKnowledge.omittedByPolicy, 'K11-wrong-stage-component', 'type_component_boundary_not_in_PROVE'));
    assert.ok(hasReason(proveKnowledge.staleOrUnavailable, 'K8-missing-source', 'freshness_stale'));
    assert.ok(hasReason(proveKnowledge.staleOrUnavailable, 'K9-changed-source', 'freshness_needs_deep_verify'));
    assert.match(String(proveKnowledge.promptBlock), /Run the bounded service verification before accepting the change/);
    assert.equal(occurrenceCount(String(proveKnowledge.promptBlock), 'Service regression repeats when bounded state is bypassed.'), 1);
    assert.doesNotMatch(String(proveKnowledge.promptBlock), /PROCEDURE_STEP_A/);
    assert.doesNotMatch(String(proveKnowledge.promptBlock), /component boundary applies only during implementation/);
    assert.doesNotMatch(String(proveKnowledge.promptBlock), /Missing source Knowledge/);
    assert.doesNotMatch(String(proveKnowledge.promptBlock), /Changed source Knowledge/);

    const proveVerification = asRecords(proveKnowledge.semanticFacts).find((entry) => entry.id === 'K5-prove-verification');
    assert.ok(proveVerification);
    assert.deepEqual(asRecord(proveVerification.verification).commandRefs, ['test:service']);
    assert.equal(asRecord(proveVerification.verification).obligationId, 'service-proof');

    const proveRepeat = asRecord(await cp.buildStageContext('run-supply-target', { stage: 'PROVE', ...contextInput }));
    assert.equal(asRecord(proveRepeat.knowledgeContext).digest, proveKnowledge.digest);
    assert.equal(cp.stateStore.getKnowledgeContextReceipt('run-supply-target', 'PROVE')?.digest, proveKnowledge.digest);
  } finally {
    await cp.close();
    await rm(tmp, { recursive: true, force: true });
  }
});
