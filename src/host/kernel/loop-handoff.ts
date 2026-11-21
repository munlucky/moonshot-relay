import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteText } from '../../kernel/durable-write.js';
import { sanitizePersistentText } from '../../shared/persistent-sanitizer.js';
import type { createKernelControlPlane } from './control-plane-runtime.js';
import type { CodexAppServerTransport, CodexAppServerTurn } from './codex-app-server-transport.js';
import { observeWorkspaceIdentity } from './workspace/workspace-identity.js';

type ControlPlane = Awaited<ReturnType<typeof createKernelControlPlane>>;
type RecordValue = Record<string, unknown>;
type Report = Awaited<ReturnType<ControlPlane['report']>>;
type Boundary = { file: string; runId: string; stepId: string; digest: string };
type Notes = { decisions?: string[]; rejectedApproaches?: string[]; remainingRisks?: string[] };
const record = (value: unknown): RecordValue =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};
const records = (value: unknown) => Array.isArray(value) ? value.map(record) : [];
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const deferred = (reason: string) => ({ status: 'deferred' as const, reason });
const inFlight = new Set<string>();
const consumed = new WeakMap<CodexAppServerTransport, string>();

async function observe(controlPlane: ControlPlane, runId: string) {
  const status = await controlPlane.status(runId);
  if (!status || !('run' in status)) return null;
  const { run, workAuthority, trustAuthority, knowledgeAuthority } = status;
  const step = workAuthority?.currentWorkUnit;
  if (run.status !== 'active' || !run.workspaceId || !step || step.state !== 'ready'
    || !run.ownerBindingId || run.ownerBindingId !== controlPlane.getRunOwnerBindingId(runId)) return null;
  const lease = controlPlane.stateStore.getLease(runId);
  if ((lease && Date.parse(lease.expiresAt) > Date.now())
    || controlPlane.stateStore.getWorkspaceMutationLockV2(run.workspaceId)
    || controlPlane.getHostRoutingSnapshot(runId).stepAttempts.some(attempt =>
      ['started', 'reported', 'verifying'].includes(attempt.status))) return null;

  const workspace = observeWorkspaceIdentity({ projectRoot: controlPlane.projectRoot });
  if (workspace.identity !== run.currentWorkspaceIdentity || !workspace.changedPaths) return null;
  const snapshot = {
    runId, projectId: run.projectId, worktreeId: run.worktreeId, workspaceId: run.workspaceId,
    ownerBindingId: run.ownerBindingId, contractRevision: run.contractRevision,
    contractDigest: run.taskContract?.digest ?? null, planRevision: run.planRevision,
    mutationRevision: run.mutationRevision, cursor: workAuthority.cursor, state: run.state,
    workspaceIdentity: workspace.identity, knowledgeRevision: knowledgeAuthority?.project.knowledgeRevision ?? null,
    evidenceDigest: record(trustAuthority?.decision).evidenceDigest ?? null,
    requirements: trustAuthority?.requirements, evidence: trustAuthority?.evidence,
  };
  return { snapshot, run, workAuthority, trustAuthority, workspace, step };
}

const list = (values: readonly unknown[], empty: string) => values.length
  ? values.map(value => `- ${sanitizePersistentText(value).replaceAll(/[\r\n]+/g, ' ').replaceAll('<', '&lt;')}`).join('\n')
  : `- ${empty}`;
const noteLines = (values: unknown) => Array.isArray(values) ? values.filter(value => typeof value === 'string' && value.trim()) : [];
const noteEnd = '\n<!-- End of decision history -->\n';

async function readArtifact(file: string) {
  const stored = await readFile(file, 'utf8');
  const match = /^<!-- Kernel loop handoff v1 ([0-9a-f]{64}) ([0-9a-f]{64}) ([0-9a-f]{64}) -->\n/u.exec(stored);
  if (!match) return null;
  const markdown = stored.slice(match[0].length);
  const [, lineage, identity, digest] = match;
  if (!lineage || !identity || !digest || digest !== hash(lineage + identity + markdown)) return null;
  return { lineage, identity, digest, markdown };
}

// The existing Report owns settlement and the continuation. The file only
// carries context, including claims supplied separately by the model or operator.
export async function saveKernelLoopHandoff({
  controlPlane, runtimeHome, runId, report, summary, notes,
}: {
  controlPlane: ControlPlane; runtimeHome: string; runId: string;
  report: Report | RecordValue; summary?: unknown; notes?: Notes;
}) {
  const result = record(report);
  const prior = record(result.step);
  const next = record(result.next);
  const action = record(next.action);
  const nextStep = record(action.step);
  if (result.runId !== runId || result.idempotentReplay || prior.state !== 'passed'
    || action.type !== 'implement' || prior.stepId === nextStep.stepId) {
    return deferred('no_settled_loop_boundary');
  }
  try {
    const state = await observe(controlPlane, runId);
    if (!state || state.step.stepId !== nextStep.stepId
      || typeof prior.stepId !== 'string' || !state.workAuthority.progress.completedWorkUnitIds.includes(prior.stepId)
      || state.snapshot.mutationRevision !== record(record(next.workAuthority).run).mutationRevision
      || state.snapshot.contractRevision !== record(record(next.workAuthority).task).contractRevision
      || state.snapshot.planRevision !== record(record(next.workAuthority).run).planRevision) {
      return deferred('loop_boundary_changed');
    }
    const lineage = hash(JSON.stringify([runId, state.run.projectId, state.run.worktreeId]));
    const file = path.join(runtimeHome, 'reports', 'loop-handoffs', `${lineage}.md`);
    const previous = await readArtifact(file).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
      return undefined;
    });
    const newNotes = [
      ...noteLines(notes?.decisions).map(note => `Decision — ${note}`),
      ...noteLines(notes?.rejectedApproaches).map(note => `Rejected — ${note}`),
    ];
    if (previous === null) return deferred('handoff_corrupt');
    if (previous && previous.lineage !== lineage) return deferred('handoff_foreign');
    const oldNotes = previous?.markdown.split(noteEnd, 1)[0]?.split('\n').slice(3)
      .filter(line => line.startsWith('- Decision — ') || line.startsWith('- Rejected — ')) ?? [];
    const history = [...new Set([...oldNotes, ...(newNotes.length ? list(newNotes, '').split('\n') : [])])];
    const trust = record(state.trustAuthority?.evidence);
    const evidence = [...records(trust.hard), ...records(trust.review)].map(item =>
      `${item.obligationId} · ${item.status} · ${item.commandRef ?? 'no command'} · ${item.evidenceDigest ?? item.receiptId ?? 'no receipt'} · ${record(item.freshness).status ?? 'freshness unavailable'}`);
    const completed = controlPlane.getRunSteps(runId).filter(step =>
      state.workAuthority.progress.completedWorkUnitIds.includes(step.stepId));
    const markdown = [
      '# Kernel loop handoff\n\n## Decision history (advisory)',
      history.join('\n') || '- No decisions recorded.',
      noteEnd.trim(),
      '## Task',
      list([state.run.objective], ''),
      list(state.run.acceptanceCriteria, 'No criteria recorded.'),
      ...([['Non-goals', state.run.taskContract?.nonGoals], ['Constraints', state.run.taskContract?.constraints]] as const)
        .filter(([, values]) => Array.isArray(values) && values.length)
        .map(([label, values]) => `### ${label}\n${list(values as unknown[], '')}`),
      '## Settled work',
      list(completed.map(step => `${step.stepId} · ${step.objective}`), ''),
      list(noteLines([summary]), 'No summary supplied for the latest work unit.'),
      `## Workspace at ${state.workspace.headCommitSha ?? 'unavailable HEAD'}`,
      list(state.workspace.changedPaths ?? [], 'Clean workspace.'),
      '## Kernel evidence',
      list(evidence, 'No evidence recorded.'),
      '## Remaining risks (advisory)',
      list(noteLines(notes?.remainingRisks), 'No risks reported.'),
      '## Next work',
      list([`${state.step.stepId} · ${state.step.objective}`], ''),
      '### Allowed paths',
      list(state.step.allowedPaths, 'Consult the Kernel work directive.'),
      `Remaining steps: ${state.workAuthority.progress.remainingWorkUnitIds.length}`,
      '',
    ].join('\n');
    const identity = hash(JSON.stringify(state.snapshot));
    const digest = hash(lineage + identity + markdown);
    await atomicWriteText(file, `<!-- Kernel loop handoff v1 ${lineage} ${identity} ${digest} -->\n${markdown}`);
    return { status: 'saved' as const, file, runId, stepId: state.step.stepId, digest };
  } catch {
    return deferred('handoff_save_failed');
  }
}

// Called by the owning Host after the active model turn and Report both settle.
// Never calls next or report, and starts only a read-only model turn.
export async function continueKernelCodexLoop({
  controlPlane, transport, handoff, turn, compact,
}: {
  controlPlane: ControlPlane; transport: CodexAppServerTransport; handoff: Boundary;
  turn: Omit<CodexAppServerTurn, 'cwd' | 'writableWorker' | 'executionOwner' | 'onNativeExecution'>;
  compact: boolean;
}) {
  const { runId, stepId, file, digest } = handoff;
  if (consumed.get(transport) === digest) return deferred('loop_continuation_already_dispatched');
  if (inFlight.has(file)) return deferred('loop_continuation_active');
  inFlight.add(file);
  try {
    const native = transport.observeTurn();
    if (native.connection !== 'connected' || native.turn !== 'idle' || !native.threadId) return deferred('host_turn_not_idle');
    if (native.contextRunId !== runId || native.contextWorkspace !== await realpath(controlPlane.projectRoot)) {
      return deferred('host_context_binding_mismatch');
    }
    const matches = async () => {
      const artifact = await readArtifact(file);
      const state = await observe(controlPlane, runId);
      return artifact?.digest === digest && state?.step.stepId === stepId
        && artifact.lineage === hash(JSON.stringify([runId, state.run.projectId, state.run.worktreeId]))
        && artifact.identity === hash(JSON.stringify(state.snapshot)) ? artifact : null;
    };
    if (!await matches()) return deferred('handoff_corrupt_or_stale');
    const cleanup = compact ? await transport.compactContext() : deferred('context_cleanup_not_requested');
    const confirmed = await matches();
    if (!confirmed) return deferred('handoff_corrupt_or_stale');
    const resumed = transport.observeTurn();
    if (resumed.connection !== 'connected' || resumed.turn !== 'idle' || resumed.threadId !== native.threadId) {
      return deferred('host_context_unavailable');
    }
    consumed.set(transport, digest);
    const result = await transport.runTurn({
      ...turn, cwd: controlPlane.projectRoot,
      prompt: `${turn.prompt}\n\nUse the attached handoff as context. Follow the canonical Kernel work directive and current evidence.\n\n${confirmed.markdown}`,
    });
    return { status: 'continued' as const, cleanup, turn: result };
  } catch {
    return deferred('loop_continuation_failed');
  } finally {
    inFlight.delete(file);
  }
}
