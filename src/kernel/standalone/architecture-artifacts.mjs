#!/usr/bin/env node
import path from 'node:path';
import { resolveStandaloneProject } from './common.mjs';
import { assertSourceUnchanged, workspaceSnapshot } from './artifact-utils.mjs';
import { writePreworkPackage } from './prework.mjs';

const doc = (title, objective, body) => `# ${title}\n\nObjective: ${objective}\n\n${body}\n`;

const greenfieldFiles = (objective) => ({
  'ARCHITECTURE_BRIEF.md': doc('Architecture Brief', objective, 'Architecture artifacts are pre-work. Kernel remains the implementation and completion authority.'),
  'REQUIREMENT_INVENTORY.md': doc('Requirement Inventory', objective, '| Requirement ID | Statement | Verification Signal |\n| --- | --- | --- |\n| REQ-001 | Preserve the requested outcome | Verification Signal: Kernel proof |'),
  'ASR_CATALOG.md': doc('ASR Catalog', objective, '| ASR ID | Requirement IDs | Scenario IDs | Decision |\n| --- | --- | --- | --- |\n| ASR-001 | REQ-001 | QAS-001 | Isolate authority boundaries |'),
  'QUALITY_ATTRIBUTE_SCENARIOS.md': doc('Quality Attribute Scenarios', objective, '| Scenario ID | Quality | Stimulus | Expected Response |\n| --- | --- | --- | --- |\n| QAS-001 | Reliability | A stale seed is handed to Kernel | Host rejects the stale seed |'),
  'DOMAIN_MODEL.md': doc('Domain Model', objective, 'Entities: Task Contract Seed, Kernel Run, Proof Receipt, Review Receipt, Completion Decision.'),
  'CAPABILITY_MAP.md': doc('Capability Map', objective, 'Pre-work produces artifacts and a seed. Kernel owns implementation, proof, review, knowledge promotion, and completion.'),
  'ARCHITECTURE_OPTIONS.md': doc('Architecture Options', objective, 'Option A: Kernel-native authority with non-authoritative pre-work. Option B: duplicate workflow runtime. Selected: Option A.'),
  'TRADEOFF_ANALYSIS.md': doc('Tradeoff Analysis', objective, 'The selected boundary minimizes public Kernel surface while preserving useful analysis and planning artifacts.'),
  'TRACEABILITY_MATRIX.md': doc('Traceability Matrix', objective, '| Requirement ID | ASR ID | ADR ID | Task ID | Verification Signal |\n| --- | --- | --- | --- | --- |\n| REQ-001 | ASR-001 | ADR-0001 | TASK-001 | Verification Signal: Kernel proof |'),
  'PLAN.md': doc('Architecture Plan', objective, '| Task ID | Owner | Verification Signal |\n| --- | --- | --- |\n| TASK-001 | Kernel | Verification Signal: Kernel proof |'),
  'ARCHITECTURE_REVIEW.md': doc('Architecture Review', objective, '## Status\n\nAccepted for Kernel Host normalization; this review is advisory and is not an independent Kernel Review Receipt.'),
  'ADR/ADR-0001-authority-boundary.md': '# ADR-0001 Authority Boundary\n\n## Status\nAccepted\n\n## Context\nPre-work must not become execution authority.\n\n## Decision\nKeep pre-work artifacts and Task Contract Seeds outside the Kernel completion authority.\n\n## Consequences\nThe Host must re-check the current user objective and detect stale seeds.\n\n## Rejected Alternatives\nA duplicate managed runtime would create conflicting authority.\n',
  'C4/C4_CONTEXT.md': '# C4 Context\n\nSystem Boundary: Kernel control plane. Requirement REQ-001 and ASR-001 are satisfied by Kernel proof.\n',
  'C4/C4_CONTAINER.md': '# C4 Container\n\nContainer: Kernel Host. Requirement REQ-001 and ASR-001 are normalized before execution.\n',
});

export async function runArchitectureArtifacts({ cwd = process.cwd(), env = process.env, objective = '', output = null, target = null } = {}) {
  const project = resolveStandaloneProject({ cwd, env });
  const requestedObjective = String(objective || '').trim() || 'Define an architecture boundary for the requested product outcome.';
  const before = workspaceSnapshot(project.projectRoot);
  const packageId = `architecture-${Date.now()}`;
  const directory = output ? path.resolve(output) : path.join(project.projectRuntimeRoot, 'prework', 'architecture', packageId);
  const packageResult = await writePreworkPackage({
    directory,
    utility: 'architecture-artifacts',
    projectId: project.projectId,
    objective: requestedObjective,
    kind: 'architecture-artifacts',
    files: greenfieldFiles(requestedObjective),
    constraints: ['Architecture artifacts do not authorize source mutation.'],
    nonGoals: ['This package is not a Task Contract and cannot complete a Kernel run.'],
  });
  const after = workspaceSnapshot(project.projectRoot);
  assertSourceUnchanged(before, after);
  return {
    status: 'pass',
    packageId,
    projectId: project.projectId,
    packagePath: directory,
    artifacts: packageResult.files,
    taskContractSeed: packageResult.seed,
    seedPath: packageResult.seedPath,
    authority: 'task-contract-seed-only',
    sourceMutation: false,
    validation: { status: 'generated', mode: target ? 'requested-target-not-mutated' : 'greenfield_prd' },
    completionDecision: null,
  };
}
