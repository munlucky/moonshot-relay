#!/usr/bin/env node
import path from 'node:path';
import { resolveStandaloneProject } from '../../kernel/standalone/common.js';
import {
  assertSourceUnchanged,
  workspaceSnapshot,
  type WorkspaceIdentityObserver,
} from '../../kernel/standalone/artifact-utils.js';
import { writePreworkPackage } from '../../kernel/standalone/prework.js';

interface FuturesArchitectureCandidate {
  kind: 'architecture-planning';
  affectedPaths: readonly string[];
}

interface FuturesRestoreEscalationCandidate {
  kind: 'bounded-restore';
  allowedPaths: readonly string[];
}

type FuturesEscalationCandidate =
  | FuturesArchitectureCandidate
  | FuturesRestoreEscalationCandidate;

interface FuturesArchitectureSubject {
  revision: string;
  contentDigest: string;
}

export type FuturesArchitectureHandoff =
  | Readonly<{
    status: 'ready';
    kind: 'architecture-prework-handoff';
    authority: 'prework-only';
    objective: string;
    affectedPaths: readonly string[];
    unresolvedRequirements: readonly string[];
    escalationReasons: readonly string[];
    source: Readonly<{
      reviewReceiptId: string;
      assessmentDigest: string;
      revision: string;
      contentDigest: string;
    }>;
  }>
  | Readonly<{
    status: 'blocked';
    kind: 'architecture-prework-handoff';
    authority: 'prework-only';
    reasons: readonly string[];
  }>;

interface ArchitectureArtifactsInput {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  objective?: unknown;
  output?: string | null;
  target?: string | null;
  observeWorkspaceIdentity?: WorkspaceIdentityObserver | null;
  handoff?: FuturesArchitectureHandoff | null;
}

const uniqueText = (value: readonly unknown[] = []): string[] => (
  [...new Set(value.map(String).map((entry) => entry.trim()).filter(Boolean))]
);

const SHA256 = /^sha256:[a-f0-9]{64}$/;

export const buildFuturesArchitectureHandoff = ({
  candidate,
  reviewReceiptId,
  assessmentDigest,
  subject,
  currentRevision,
  currentContentDigest,
  unresolvedRequirements = [],
  escalationReasons = [],
  objective = 'Resolve the reviewed architecture escalation before implementation resumes.',
}: {
  candidate: FuturesEscalationCandidate;
  reviewReceiptId: string;
  assessmentDigest: string;
  subject: FuturesArchitectureSubject;
  currentRevision: string | number;
  currentContentDigest: string;
  unresolvedRequirements?: readonly string[];
  escalationReasons?: readonly string[];
  objective?: string;
}): FuturesArchitectureHandoff => {
  const reasons: string[] = [];
  const normalizedEscalationReasons = uniqueText(escalationReasons);
  const architectureCandidate = candidate?.kind === 'architecture-planning';
  const restoreCandidate = candidate?.kind === 'bounded-restore';
  if (!architectureCandidate && !restoreCandidate) {
    reasons.push('architecture-candidate-required');
  }
  if (restoreCandidate && normalizedEscalationReasons.length === 0) {
    reasons.push('restore-escalation-reason-required');
  }
  if (!String(reviewReceiptId || '').trim()) reasons.push('review-receipt-required');
  if (!SHA256.test(String(assessmentDigest || ''))) reasons.push('assessment-digest-invalid');
  if (String(subject?.revision || '') !== String(currentRevision)) {
    reasons.push('architecture-handoff-stale-revision');
  }
  if (String(subject?.contentDigest || '') !== String(currentContentDigest || '')) {
    reasons.push('architecture-handoff-stale-content');
  }
  if (reasons.length > 0) {
    return Object.freeze({
      status: 'blocked' as const,
      kind: 'architecture-prework-handoff' as const,
      authority: 'prework-only' as const,
      reasons: Object.freeze([...new Set(reasons)].sort()),
    });
  }

  return Object.freeze({
    status: 'ready' as const,
    kind: 'architecture-prework-handoff' as const,
    authority: 'prework-only' as const,
    objective: String(objective || '').trim()
      || 'Resolve the reviewed architecture escalation before implementation resumes.',
    affectedPaths: Object.freeze(uniqueText(
      architectureCandidate ? candidate.affectedPaths : candidate.allowedPaths,
    )),
    unresolvedRequirements: Object.freeze(uniqueText(unresolvedRequirements)),
    escalationReasons: Object.freeze(normalizedEscalationReasons),
    source: Object.freeze({
      reviewReceiptId: String(reviewReceiptId),
      assessmentDigest: String(assessmentDigest),
      revision: String(subject.revision),
      contentDigest: String(subject.contentDigest),
    }),
  });
};

const doc = (
  title: string,
  objective: string,
  body: string,
): string => `# ${title}\n\nObjective: ${objective}\n\n${body}\n`;

const greenfieldFiles = (
  objective: string,
): Record<string, string> => ({
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

export async function runArchitectureArtifacts({
  cwd = process.cwd(),
  env = process.env,
  objective = '',
  output = null,
  target = null,
  observeWorkspaceIdentity = null,
  handoff = null,
}: ArchitectureArtifactsInput = {}) {
  const project = resolveStandaloneProject({ cwd, env });
  if (handoff?.status === 'blocked') {
    return {
      status: 'blocked' as const,
      projectId: project.projectId,
      reasons: handoff.reasons,
      authority: 'task-contract-seed-only' as const,
      sourceMutation: false,
      completionDecision: null,
    };
  }
  const requestedObjective = handoff?.status === 'ready'
    ? handoff.objective
    : String(objective || '').trim()
      || 'Define an architecture boundary for the requested product outcome.';
  const before = workspaceSnapshot(
    project.projectRoot,
    observeWorkspaceIdentity,
  );
  const packageId = `architecture-${Date.now()}`;
  const directory = output
    ? path.resolve(output)
    : path.join(
      project.projectRuntimeRoot,
      'prework',
      'architecture',
      packageId,
    );
  const packageResult = await writePreworkPackage({
    directory,
    utility: 'architecture-artifacts',
    projectId: project.projectId,
    objective: requestedObjective,
    kind: 'architecture-artifacts',
    files: greenfieldFiles(requestedObjective),
    acceptance: handoff?.status === 'ready'
      ? [...handoff.unresolvedRequirements]
      : [],
    constraints: [
      'Architecture artifacts do not authorize source mutation.',
      ...(handoff?.status === 'ready' && handoff.affectedPaths.length > 0
        ? [`Reviewed affected paths: ${handoff.affectedPaths.join(', ')}`]
        : []),
      ...(handoff?.status === 'ready' && handoff.escalationReasons.length > 0
        ? [`Restore escalation reasons: ${handoff.escalationReasons.join(', ')}`]
        : []),
    ],
    nonGoals: [
      'This package is not a Task Contract and cannot complete a Kernel run.',
      ...(handoff?.status === 'ready'
        ? ['This architecture handoff does not advance the current Work cursor or implementation approval boundary.']
        : []),
    ],
  });
  const after = workspaceSnapshot(
    project.projectRoot,
    observeWorkspaceIdentity,
  );
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
    handoffContext: handoff?.status === 'ready' ? handoff : null,
    validation: {
      status: 'generated',
      mode: target
        ? 'requested-target-not-mutated'
        : 'greenfield_prd',
    },
    completionDecision: null,
  };
}
