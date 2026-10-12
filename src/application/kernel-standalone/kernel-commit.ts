#!/usr/bin/env node
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { isDirectEntrypoint } from '../../shared/runtime-assets.js';
import { openKernelStateStore } from '../../kernel/state-store.js';
import { commitProjectKnowledge } from '../../kernel/knowledge/commit.js';
import { buildCodebaseIndex } from '../../host/kernel/codebase/codebase-index.js';
import { extractCodebaseCandidates } from '../../kernel/knowledge-ingestion/candidate-extract.js';
import { commitImportedProjectKnowledge } from '../../kernel/knowledge-ingestion/import.js';
import { isPathStagable } from '../../kernel/git/staging-policy.js';
import {
  createWorkingTreeCommit,
  parseGitStatusOutput,
  pushWorkingTreeCommit,
  readGitStatusEntries,
  type GitStatusEntry,
} from '../../host/kernel/git/closeout-operations.js';
import { buildKernelCommitMessage } from '../../kernel/git/commit-message.js';
import { parseCliArgs, printResult, readJson, resolveStandaloneProject, sha256, writeJsonAtomic } from '../../kernel/standalone/common.js';
import { ensureAccountRootTrack } from '../../kernel/runtime-home.js';
import { registerWorkspace } from '../../kernel/run/workspace-registration.js';
import { resolveStableWorkspaceIdentity } from '../../host/kernel/workspace/stable-workspace.js';
import { observeWorkspaceIdentity } from '../../host/kernel/workspace/workspace-identity.js';
import type { WorkRun } from '../../kernel/run/work-authority.js';
import type {
  CompletionDecisionAuthority,
  MutationProvenanceAuthority,
} from '../../kernel/proof/completion-provenance.js';
import type { RegisteredWorkspace } from '../../kernel/run/workspace-registration.js';
import type { StableWorkspaceObservation } from '../../contracts/workspace-observation.js';

type UnknownRecord = Record<string, unknown>;

interface DeniedGitStatusEntry extends GitStatusEntry {
  reason: 'deny_path';
}

interface StandaloneProject extends UnknownRecord {
  projectId: string;
  projectRoot: string;
  runtimeHome: string;
  codebaseRoot: string;
  importsRoot: string;
  receiptsRoot: string;
  projectRuntimeRoot: string;
}

interface KernelCommitRun extends WorkRun {
  projectId: string | null;
  workspaceId: string | null;
  worktreeId: string | null;
  sourceIdentity: string;
  mutationRevision: number;
  currentWorkspaceIdentity: string | null;
  finalizationStatus: string | null;
  currentState: string | null;
  status: string | null;
}

interface MutationProvenance extends MutationProvenanceAuthority {
  status?: string | null;
  changedPaths?: string[];
  resultWorkspaceIdentity?: string | null;
  workspaceIdentityEnd?: string | null;
  workspaceId?: string | null;
  attemptId?: string | null;
}

interface CompletionDecision extends CompletionDecisionAuthority {
  decision?: string | null;
  sourceIdentity?: string | null;
  mutationRevision?: number | null;
}

interface SuccessorLineage {
  runs: KernelCommitRun[];
  runIds: string[];
  terminalRunId: string;
  isTerminal: boolean;
  edges: unknown[];
}

interface ValidLineageEntry {
  run: KernelCommitRun;
  completion: CompletionDecision;
  provenance: MutationProvenance;
}

interface ValidLineage {
  lineage: SuccessorLineage;
  entries: ValidLineageEntry[];
}

interface KernelCommitStateStore {
  getRun(runId: string): KernelCommitRun | null;
  listRuns(input: { projectId: string; statuses: string[] }): KernelCommitRun[];
  resolveSuccessorLineage?(runId: string): SuccessorLineage;
  getMutationProvenance(runId: string): MutationProvenance | null;
  getCompletionDecision(runId: string): CompletionDecision | null;
  getLatestImplementationAttempt(runId: string): MutationProvenance | null;
  registerProjectWorkspace(workspace: StableWorkspaceObservation & { worktreeId?: string }): RegisteredWorkspace;
}

interface MutationAdmissionDigestInput {
  runId: string;
  projectId: string;
  workspaceId: string;
  sourceIdentity: string;
  mutationRevision: number;
  changedPaths: string[];
  workspaceIdentity: string;
}

interface MatchesCurrentMutationCandidateInput {
  run?: Pick<KernelCommitRun, 'runId' | 'currentWorkspaceIdentity'> | null;
  provenance?: MutationProvenance | null;
  currentWorkspaceIdentity?: string | null;
  currentPaths?: string[];
  selectedPaths?: string[];
}

interface ResolveKernelCloseoutRunInput {
  stateStore: KernelCommitStateStore;
  projectId: string;
  workspaceId: string;
  runId?: string | null;
  env?: NodeJS.ProcessEnv;
  currentWorkspaceIdentity?: string | null;
  currentPaths?: string[];
  selectedPaths?: string[];
}

interface KernelCloseoutResolution {
  run: KernelCommitRun;
  completion: CompletionDecision;
  lineage: SuccessorLineage;
  provenance: MutationProvenance | null;
  approvedPaths: string[];
}

interface MutationAdmission {
  run: KernelCommitRun;
  completion: CompletionDecision;
  workspace: RegisteredWorkspace;
  provenance: MutationProvenance;
  sourceIdentity: string;
  mutationRevision: number;
  approvedPaths: string[];
  currentPaths: string[];
  workspaceIdentity: string;
  mutationDigest: string;
}

interface AdmitKernelMutationInput {
  stateStore: KernelCommitStateStore;
  project: Pick<StandaloneProject, 'projectId' | 'projectRoot'>;
  statusEntries?: GitStatusEntry[];
  selected?: string[];
  runId?: string | null;
  env?: NodeJS.ProcessEnv;
}

interface ResolveCommitMessageInput {
  cwd?: string;
  message?: string | null;
  messageFile?: string | null;
}

interface KernelCommitInput {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  message?: string | null;
  messageFile?: string | null;
  push?: boolean;
  memory?: boolean;
  memoryReview?: boolean;
  approvalRef?: string | null;
  runId?: string | null;
  approve?: boolean;
  approver?: string | null;
  reason?: string | null;
  approvalReason?: string | null;
  operatorApprovalRef?: string | null;
}

interface KnowledgeCandidate extends UnknownRecord {
  candidateId?: string;
}

interface KernelCommitReceipt extends UnknownRecord {
  schemaVersion: number;
  authority: string;
  projectId: string;
  branch: string | null;
  commitHash: string;
  commitSubject: string;
  commitMessage: string;
  selectedPaths: string[];
  deniedPaths: DeniedGitStatusEntry[];
  treeDigest: string;
  knowledgeStatus: string;
  closeoutStatus: string;
  mutationAdmission: UnknownRecord | null;
  createdAt: string;
  knowledgeReceipt?: unknown;
  candidateSnapshot?: string;
  pushStatus?: string;
  remoteHead?: string | null;
}

interface KernelCommitCliArgs extends UnknownRecord {
  _: string[];
  json: boolean;
  message?: string;
  messageFile?: string;
  push?: boolean;
  memory?: boolean;
  memoryReview?: boolean;
  approvalRef?: string;
  runId?: string;
  approve?: boolean;
  approver?: string;
  reason?: string;
  approvalReason?: string;
  operatorApprovalRef?: string;
}

interface WorkspaceMutationObservation {
  identity: string;
  changedPaths: string[];
}

interface KernelCommitControlPlane {
  resolveRunId(input: { explicitRunId: string | null; envRunId: string | null }): Promise<string | null>;
  approveObligation(input: UnknownRecord): Promise<unknown>;
  close(): Promise<void>;
}


// The standalone commit path used to carry its own deny list, which was
// narrower than the shared one: `.env*`, `.codex/state`, `.qwen/`, `.git/` and
// non-runtime `*.sqlite` files were never refused here even though the skill
// documents provider sessions and protected paths as never staged. Both paths
// now judge against the same patterns.
export function isDeniedStagingPath(relativePath: string): boolean {
  const normalized = String(relativePath || '').replaceAll('\\', '/').replace(/^\.\//, '');
  return !isPathStagable(normalized);
}

export const parseGitStatus = parseGitStatusOutput;

export function selectStagingPaths(statusEntries: GitStatusEntry[] = []): { selected: string[]; denied: DeniedGitStatusEntry[] } {
  const selected: string[] = [];
  const denied: DeniedGitStatusEntry[] = [];
  for (const entry of statusEntries) {
    if (isDeniedStagingPath(entry.path)) denied.push({ ...entry, reason: 'deny_path' });
    else selected.push(entry.path);
  }
  return { selected: [...new Set(selected)], denied };
}

const pathKey = (value: unknown): string => {
  const normalized = String(value || '').replaceAll('\\', '/').replace(/^\.\//, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
};

const uniquePaths = (paths: readonly unknown[] = []): string[] => [...new Set(paths.map(pathKey).filter(Boolean))].sort();

const admissionError = (code: string, details: UnknownRecord = {}) => Object.assign(new Error(code), {
  code,
  errorCode: code,
  details,
});

export function mutationAdmissionDigest({ runId, projectId, workspaceId, sourceIdentity, mutationRevision, changedPaths, workspaceIdentity }: MutationAdmissionDigestInput): string {
  return sha256({
    runId,
    projectId,
    workspaceId,
    sourceIdentity,
    mutationRevision: Number(mutationRevision || 0),
    changedPaths: uniquePaths(changedPaths),
    workspaceIdentity,
  });
}

export function matchesCurrentMutationCandidate({
  run,
  provenance,
  currentWorkspaceIdentity = null,
  currentPaths = [],
  selectedPaths = [],
}: MatchesCurrentMutationCandidateInput = {}): boolean {
  if (!run || !provenance) return false;
  const targetWorkspaceIdentity = provenance.workspaceIdentity || provenance.resultWorkspaceIdentity || provenance.workspaceIdentityEnd || null;
  if (currentWorkspaceIdentity) {
    if (targetWorkspaceIdentity && targetWorkspaceIdentity !== currentWorkspaceIdentity) return false;
    if (run.currentWorkspaceIdentity && run.currentWorkspaceIdentity !== currentWorkspaceIdentity) return false;
  }
  const approvedPaths = new Set(uniquePaths(Array.isArray(provenance.changedPaths) ? provenance.changedPaths : []));
  if (approvedPaths.size === 0) return false;

  const currentList = uniquePaths(Array.isArray(currentPaths) ? currentPaths : []);
  for (const candidatePath of currentList) {
    if (!approvedPaths.has(candidatePath)) return false;
  }

  const selectedList = uniquePaths(Array.isArray(selectedPaths) ? selectedPaths : []);
  for (const candidatePath of selectedList) {
    if (!approvedPaths.has(candidatePath)) return false;
  }

  return true;
}

export function resolveKernelCloseoutRun({
  stateStore,
  projectId,
  workspaceId,
  runId = null,
  env = {},
  currentWorkspaceIdentity = null,
  currentPaths = [],
  selectedPaths = [],
}: ResolveKernelCloseoutRunInput): KernelCloseoutResolution {
  const effectiveRunId = runId || env.MOON_RELAY_KERNEL_RUN_ID || null;
  const resolveLineage = (candidate: KernelCommitRun): SuccessorLineage | null => {
    try {
      if (typeof stateStore.resolveSuccessorLineage !== 'function') {
        return { runs: [candidate], runIds: [candidate.runId], terminalRunId: candidate.runId, isTerminal: true, edges: [] };
      }
      return stateStore.resolveSuccessorLineage(candidate.runId);
    } catch {
      return null;
    }
  };
  const validLineage = (candidate: KernelCommitRun): ValidLineage | null => {
    const lineage = resolveLineage(candidate);
    if (!lineage || !lineage.isTerminal || lineage.terminalRunId !== candidate.runId) return null;

    const entries: ValidLineageEntry[] = [];
    for (const lineageRun of lineage.runs) {
      const provenance = stateStore.getMutationProvenance(lineageRun.runId);
      const completion = stateStore.getCompletionDecision(lineageRun.runId);
      const valid = lineageRun.projectId === projectId
        && lineageRun.workspaceId === workspaceId
        && Boolean(lineageRun.worktreeId)
        && Boolean(candidate.worktreeId)
        && lineageRun.worktreeId === candidate.worktreeId
        && lineageRun.status === 'completed'
        && lineageRun.currentState === 'CLOSE'
        && lineageRun.finalizationStatus === 'completed'
        && completion?.decision === 'accepted'
        && Boolean(provenance)
        && provenance?.projectId === projectId
        && provenance?.workspaceId === workspaceId
        && provenance?.sourceIdentity === lineageRun.sourceIdentity
        && Number(provenance?.mutationRevision) > 0
        && Number(provenance?.mutationRevision) === Number(lineageRun.mutationRevision)
        && Boolean(provenance?.workspaceIdentity)
        && Array.isArray(provenance?.changedPaths)
        && provenance.changedPaths.length > 0;
      if (!valid || !completion || !provenance) return null;
      entries.push({ run: lineageRun, completion, provenance });
    }
    return { lineage, entries };
  };
  // Stage 1: Filter Completed Structural Candidates
  const structuralCandidates: KernelCommitRun[] = effectiveRunId
    ? (() => {
        const candidate = stateStore.getRun(effectiveRunId);
        return candidate ? [candidate] : [];
      })()
    : stateStore.listRuns({ projectId, statuses: ['completed'] })
      .filter((candidate) => candidate.projectId === projectId && candidate.workspaceId === workspaceId)
      .filter((candidate) => validLineage(candidate));

  // Stage 2: Filter Exact Current Mutation Candidates
  let candidates = structuralCandidates;
  if (!effectiveRunId && (currentWorkspaceIdentity || (Array.isArray(currentPaths) && currentPaths.length > 0) || (Array.isArray(selectedPaths) && selectedPaths.length > 0))) {
    candidates = structuralCandidates.filter((candidate) => {
      const lineage = validLineage(candidate);
      if (!lineage) return false;
      const provenance = {
        changedPaths: lineage.entries.flatMap((entry) => entry.provenance.changedPaths || []),
        workspaceIdentity: candidate.currentWorkspaceIdentity,
      };
      return matchesCurrentMutationCandidate({
        run: candidate,
        provenance,
        currentWorkspaceIdentity,
        currentPaths,
        selectedPaths,
      });
    });
  }

  if (candidates.length === 0) {
    throw admissionError(effectiveRunId ? 'UNKNOWN_RUN_ID' : 'RUN_PROVENANCE_REQUIRED', { runId: effectiveRunId, projectId, workspaceId });
  }
  if (!effectiveRunId && candidates.length > 1) {
    throw admissionError('RUN_PROVENANCE_AMBIGUOUS', { projectId, workspaceId, runIds: candidates.map((candidate) => candidate.runId) });
  }
  const run = candidates[0];
  if (!run) throw admissionError('RUN_PROVENANCE_REQUIRED', { projectId, workspaceId });
  const resolvedLineage = validLineage(run);
  if (!resolvedLineage) {
    throw admissionError(effectiveRunId ? 'RUN_NOT_FINALIZED' : 'RUN_PROVENANCE_REQUIRED', { runId: run.runId });
  }
  if (run.projectId !== projectId) {
    throw admissionError('RUN_PROJECT_MISMATCH', { runId: run.runId, expectedProjectId: projectId, actualProjectId: run.projectId });
  }
  if (!run.workspaceId || run.workspaceId !== workspaceId) {
    throw admissionError('WORKSPACE_BINDING_MISMATCH', { runId: run.runId, expectedWorkspaceId: workspaceId, actualWorkspaceId: run.workspaceId });
  }
  if (run.status !== 'completed' || run.currentState !== 'CLOSE' || run.finalizationStatus !== 'completed') {
    throw admissionError('RUN_NOT_FINALIZED', { runId: run.runId, status: run.status, state: run.currentState, finalizationStatus: run.finalizationStatus });
  }
  const completion = stateStore.getCompletionDecision(run.runId);
  if (!completion || completion.decision !== 'accepted') {
    throw admissionError('COMPLETION_NOT_ACCEPTED', { runId: run.runId, completion: completion?.decision || null });
  }
  return {
    run,
    completion,
    lineage: resolvedLineage.lineage,
    provenance: resolvedLineage.entries.at(-1)?.provenance || null,
    approvedPaths: uniquePaths(resolvedLineage.entries.flatMap((entry) => entry.provenance.changedPaths || [])),
  };
}

export function admitKernelMutation({ stateStore, project, statusEntries = [], selected = [], runId = null, env = process.env }: AdmitKernelMutationInput): MutationAdmission {
  const workspaceObservation = resolveStableWorkspaceIdentity({
    projectId: project.projectId,
    workspaceRoot: project.projectRoot,
  });
  const workspace = registerWorkspace({
    stateStore,
    workspace: workspaceObservation,
    projectId: project.projectId,
  });
  const currentObservation = observeWorkspaceIdentity({ projectRoot: project.projectRoot });
  const currentPaths = uniquePaths(statusEntries.map((entry) => entry.path));
  const selectedPaths = uniquePaths(selected);
  const resolution = resolveKernelCloseoutRun({
    stateStore,
    projectId: project.projectId,
    workspaceId: workspace.workspaceId,
    runId,
    env,
    currentWorkspaceIdentity: currentObservation.identity || null,
    currentPaths,
    selectedPaths,
  });
  const { run, completion } = resolution;
  const provenance = resolution.provenance || stateStore.getMutationProvenance(run.runId) || stateStore.getLatestImplementationAttempt(run.runId);
  if (!provenance || provenance.status && provenance.status !== 'passed') {
    throw admissionError('MUTATION_PROVENANCE_MISSING', { runId: run.runId });
  }
  const approvedPaths = uniquePaths(resolution.approvedPaths || provenance.changedPaths || []);
  if (approvedPaths.length === 0) {
    throw admissionError('MUTATION_PROVENANCE_MISSING', { runId: run.runId, reason: 'changed_paths_empty' });
  }
  const approvedSet = new Set(approvedPaths);
  const foreignPaths = currentPaths.filter((candidate) => !approvedSet.has(candidate));
  const unapprovedSelectedPaths = selectedPaths.filter((candidate) => !approvedSet.has(candidate));
  if (foreignPaths.length > 0 || unapprovedSelectedPaths.length > 0) {
    throw admissionError('FOREIGN_MUTATION', {
      runId: run.runId,
      foreignPaths,
      unapprovedSelectedPaths,
      approvedPaths,
    });
  }
  const expectedSourceIdentity = run.sourceIdentity;
  if (!expectedSourceIdentity || provenance.sourceIdentity !== expectedSourceIdentity || completion.sourceIdentity !== expectedSourceIdentity) {
    throw admissionError('SOURCE_IDENTITY_MISMATCH', {
      runId: run.runId,
      expectedSourceIdentity,
      provenanceSourceIdentity: provenance.sourceIdentity || null,
      completionSourceIdentity: completion.sourceIdentity || null,
    });
  }
  const mutationRevision = Number(provenance.mutationRevision ?? run.mutationRevision ?? 0);
  if (mutationRevision <= 0 || mutationRevision !== Number(run.mutationRevision || 0) || Number(completion.mutationRevision || 0) !== mutationRevision) {
    throw admissionError('MUTATION_REVISION_MISMATCH', {
      runId: run.runId,
      runMutationRevision: run.mutationRevision,
      provenanceMutationRevision: provenance.mutationRevision,
      completionMutationRevision: completion.mutationRevision,
    });
  }
  const expectedWorkspaceIdentity = provenance.workspaceIdentity || provenance.resultWorkspaceIdentity || provenance.workspaceIdentityEnd;
  if (!expectedWorkspaceIdentity || expectedWorkspaceIdentity !== currentObservation.identity || (run.currentWorkspaceIdentity && run.currentWorkspaceIdentity !== currentObservation.identity)) {
    throw admissionError('MUTATION_PROVENANCE_DRIFT', {
      runId: run.runId,
      expectedWorkspaceIdentity,
      runWorkspaceIdentity: run.currentWorkspaceIdentity,
      currentWorkspaceIdentity: currentObservation.identity,
    });
  }
  if (provenance.workspaceId && provenance.workspaceId !== workspace.workspaceId) {
    throw admissionError('WORKSPACE_BINDING_MISMATCH', {
      runId: run.runId,
      expectedWorkspaceId: workspace.workspaceId,
      provenanceWorkspaceId: provenance.workspaceId,
    });
  }
  return {
    run,
    completion,
    workspace,
    provenance,
    sourceIdentity: expectedSourceIdentity,
    mutationRevision,
    approvedPaths,
    currentPaths,
    workspaceIdentity: currentObservation.identity,
    mutationDigest: mutationAdmissionDigest({
      runId: run.runId,
      projectId: project.projectId,
      workspaceId: workspace.workspaceId,
      sourceIdentity: expectedSourceIdentity,
      mutationRevision,
      changedPaths: approvedPaths,
      workspaceIdentity: currentObservation.identity,
    }),
  };
}

export async function resolveCommitMessage({ cwd = process.cwd(), message = null, messageFile = null }: ResolveCommitMessageInput = {}): Promise<string | null> {
  if (messageFile === null || messageFile === undefined) return message;
  if (message !== null && message !== undefined) throw admissionError('COMMIT_MESSAGE_INPUT_CONFLICT');
  if (typeof messageFile !== 'string' || !messageFile.trim()) throw admissionError('COMMIT_MESSAGE_FILE_REQUIRED');
  const text = (await readFile(path.resolve(cwd, messageFile), 'utf8')).replace(/^\uFEFF/u, '').replace(/\r\n?/gu, '\n').trim();
  if (text.includes('\u0000') || !text.split('\n').slice(1).some(line => line.trim())) throw admissionError('COMMIT_MESSAGE_BODY_REQUIRED');
  return text;
}

export async function kernelCommit({ cwd = process.cwd(), env = process.env, message = null, messageFile = null, push = false, memory = false, memoryReview = false, approvalRef = null, runId = null, approve = false, approver = null, reason = null, approvalReason = null, operatorApprovalRef = null }: KernelCommitInput = {}) {
  message = await resolveCommitMessage({ cwd, message, messageFile });
  await ensureAccountRootTrack({ startDir: cwd, track: 'kernel', env, source: 'standalone-kernel-commit' });
  const project = resolveStandaloneProject({ cwd, env });
  const statusEntries = readGitStatusEntries(project.projectRoot);
  const { selected, denied } = selectStagingPaths(statusEntries);

  if (approve) {
    const { createKernelControlPlane } = await import('../../host/kernel/control-plane-runtime.js');
    const cp = await createKernelControlPlane({
      projectRoot: project.projectRoot,
      runtimeHome: project.runtimeHome,
      env,
    });
    try {
      const effectiveRunId = runId || env.MOON_RELAY_KERNEL_RUN_ID || await cp.resolveRunId({ explicitRunId: null, envRunId: null });
      if (effectiveRunId) {
        await cp.approveObligation({
          runId: effectiveRunId,
          allJudgments: true,
          approver: approver || process.env.USERNAME || process.env.USER || 'operator',
          reason: reason || approvalReason || 'User approved via kernel-commit --approve',
          approvalRef: operatorApprovalRef || env.MOON_RELAY_KERNEL_OPERATOR_APPROVAL_REF || null,
          autoFinalize: true,
        });
      }
    } finally {
      await cp.close();
    }
  }

  const stateStore = await openKernelStateStore({ runtimeHome: project.runtimeHome });
  try {
    const admission = selected.length > 0
      ? admitKernelMutation({ stateStore, project, statusEntries, selected, runId, env })
      : null;
    const index = await buildCodebaseIndex({ projectRoot: project.projectRoot, projectId: project.projectId, codebaseRoot: project.codebaseRoot, runtimeHome: project.runtimeHome });
    let candidates: KnowledgeCandidate[] = [];
    if (memory || memoryReview) {
      const map = await readJson<UnknownRecord>(path.join(project.codebaseRoot, 'codebase-map.json'), { files: [] });
      candidates = extractCodebaseCandidates(map || {}, { projectId: project.projectId, sourceDigest: index.manifest?.sourceTreeDigest });
    }
    if (memoryReview && !approvalRef) return { status: 'awaiting_review', projectId: project.projectId, staging: { selected, denied }, candidates, index };
    if (selected.length === 0) return { status: 'no_op', projectId: project.projectId, staging: { selected, denied }, index, candidates };
    const commitMessage = buildKernelCommitMessage({
      message,
      run: admission?.run,
      completion: admission?.completion,
      projectId: project.projectId,
      selectedPaths: selected,
      excludedPaths: denied,
      knowledgeStatus: memory ? (approvalRef ? 'approval-requested' : 'candidate-snapshot') : 'not-requested',
      closeoutMode: push ? 'commit_and_push' : 'commit',
    });
    const commitSubject = commitMessage.split('\n', 1)[0] ?? '';
    const commitResult = createWorkingTreeCommit({
      repoRoot: project.projectRoot,
      selectedPaths: selected,
      commitMessage,
    });
    const beforeHeadSha = commitResult.beforeHeadSha;
    const commitHash = commitResult.commitSha;
    const receipt: KernelCommitReceipt = {
      schemaVersion: 2,
      authority: 'kernel-closeout-only',
      projectId: project.projectId,
      branch: commitResult.branch,
      commitHash,
      commitSubject,
      commitMessage,
      selectedPaths: selected,
      deniedPaths: denied,
      treeDigest: commitResult.treeDigest,
      knowledgeStatus: 'staged',
      closeoutStatus: 'partial',
      mutationAdmission: admission ? {
        runId: admission.run.runId,
        workspaceId: admission.workspace.workspaceId,
        sourceIdentity: admission.sourceIdentity,
        mutationRevision: admission.mutationRevision,
        workspaceIdentityBeforeCommit: admission.workspaceIdentity,
        approvedPaths: admission.approvedPaths,
        mutationDigest: admission.mutationDigest,
        provenanceAttemptId: admission.provenance.attemptId || null,
      } : null,
      createdAt: new Date().toISOString(),
    };
    if (memory && candidates.length > 0) {
      const sourceDigest = index.manifest?.sourceTreeDigest || sha256(commitHash);
      if (approvalRef) {
        const result = await commitImportedProjectKnowledge({ stateStore, projectId: project.projectId, expectedKnowledgeRevision: stateStore.getProjectKnowledgeRevision(project.projectId), candidates: candidates.map((candidate) => ({ ...candidate, selected: true })), sourceReceipt: { sourceType: 'git_commit', sourceIdentity: `git:${commitHash}`, sourceDigest, sourceSnapshotRef: `git:${commitHash}` }, userApprovalRef: approvalRef, receiptsRoot: project.receiptsRoot });
        receipt.knowledgeStatus = result.status;
        receipt.closeoutStatus = result.status === 'committed' || result.status === 'no_op' ? 'completed' : 'partial';
        receipt.knowledgeReceipt = result.receipt || null;
      } else {
        const snapshotPath = path.join(project.importsRoot, 'sources', `${sourceDigest.replace(/[^a-zA-Z0-9-]/g, '')}.json`);
        await writeJsonAtomic(snapshotPath, { schemaVersion: 1, kind: 'git_commit', projectId: project.projectId, sourceReceipt: { sourceType: 'git_commit', sourceIdentity: `git:${commitHash}`, sourceDigest, sourceSnapshotRef: `git:${commitHash}` }, candidates, createdAt: new Date().toISOString() });
        receipt.candidateSnapshot = path.relative(project.projectRuntimeRoot, snapshotPath).replaceAll('\\', '/');
      }
    }
    const receiptPath = path.join(project.receiptsRoot, 'commits', `${commitHash}.json`);
    await writeJsonAtomic(receiptPath, receipt);
    if (push) {
      const pushResult = pushWorkingTreeCommit({
        repoRoot: project.projectRoot,
        commitSha: commitHash,
        branch: receipt.branch || commitResult.branch,
      });
      if (pushResult.parity === 'not_checked') {
        throw new Error(`git_failed: push: ${pushResult.stderr.trim()}`);
      }
      receipt.pushStatus = pushResult.status === 'completed' ? 'completed' : 'parity_failed';
      receipt.remoteHead = pushResult.remoteHeadSha;
      if (receipt.pushStatus !== 'completed') throw new Error('REMOTE_PARITY_FAILED');
      await writeJsonAtomic(receiptPath, receipt);
    }
    if (admission) {
      stateStore.recordGitCloseoutReceipt(admission.run.runId, {
        projectId: project.projectId,
        mode: 'kernel-commit',
        commitSha: commitHash,
        branch: receipt.branch,
        pushStatus: push ? receipt.pushStatus : 'skipped',
        parity: push ? 'remote' : 'local',
        status: 'completed',
        beforeHeadSha,
        selectedPaths: selected,
        receiptJson: receipt,
      });
    }
    return { status: 'committed', projectId: project.projectId, commitHash, commitSubject, commitMessage, receipt, staging: { selected, denied }, index };
  } finally { await stateStore.close(); }
}

if (isDirectEntrypoint(import.meta.url)) {
  const args = parseCliArgs(process.argv.slice(2));
  kernelCommit({
    message: typeof args.message === 'string' ? args.message : null,
    messageFile: typeof args.messageFile === 'string' ? args.messageFile : null,
    push: args.push === true,
    memory: args.memory === true,
    memoryReview: args.memoryReview === true,
    approvalRef: typeof args.approvalRef === 'string' ? args.approvalRef : null,
    runId: typeof args.runId === 'string' ? args.runId : null,
    approve: args.approve === true,
    approver: typeof args.approver === 'string' ? args.approver : null,
    reason: typeof args.reason === 'string' ? args.reason : typeof args.approvalReason === 'string' ? args.approvalReason : null,
    operatorApprovalRef: (typeof args.operatorApprovalRef === 'string' ? args.operatorApprovalRef : null) || process.env.MOON_RELAY_KERNEL_OPERATOR_APPROVAL_REF || null,
  }).then((result) => printResult(result, { json: args.json })).catch((error) => { printResult({ status: 'error', errorCode: error.code || error.message }, { json: true }); process.exitCode = 1; });
}
