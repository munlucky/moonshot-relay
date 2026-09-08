#!/usr/bin/env node
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { openKernelStateStore } from '../state-store.mjs';
import { commitProjectKnowledge } from '../knowledge/commit.mjs';
import { buildCodebaseIndex } from '../codebase/build-index.mjs';
import { extractCodebaseCandidates } from '../knowledge-ingestion/candidate-extract.mjs';
import { commitImportedProjectKnowledge } from '../knowledge-ingestion/import.mjs';
import { runGit, gitCurrentBranch } from '../../lib/git-safe.mjs';
import { isPathStagable, stageSelectedPaths } from '../git/staging-policy.mjs';
import { buildKernelCommitMessage } from '../git/commit-message.mjs';
import { gitTreeDigest } from '../../lib/candidate-identity.mjs';
import { parseCliArgs, printResult, readJson, resolveStandaloneProject, sha256, writeJsonAtomic } from './common.mjs';
import { ensureAccountRootTrack } from '../runtime-home.mjs';
import { registerWorkspace } from '../run/workspace-registration.mjs';
import { observeWorkspaceIdentity } from '../run/workspace-identity.mjs';

// The standalone commit path used to carry its own deny list, which was
// narrower than the shared one: `.env*`, `.codex/state`, `.qwen/`, `.git/` and
// non-runtime `*.sqlite` files were never refused here even though the skill
// documents provider sessions and protected paths as never staged. Both paths
// now judge against the same patterns.
export function isDeniedStagingPath(relativePath) {
  const normalized = String(relativePath || '').replaceAll('\\', '/').replace(/^\.\//, '');
  return !isPathStagable(normalized);
}

export function parseGitStatus(output = '') {
  return String(output).split(/\r?\n/).filter(Boolean).map((line) => {
    const status = line.slice(0, 2);
    let file = line.slice(3);
    if (file.includes(' -> ')) file = file.split(' -> ').pop();
    if ((file.startsWith('"') && file.endsWith('"')) || (file.startsWith("'") && file.endsWith("'"))) file = file.slice(1, -1);
    return { status, path: file.replaceAll('\\', '/') };
  });
}

export function selectStagingPaths(statusEntries = []) {
  const selected = [];
  const denied = [];
  for (const entry of statusEntries) {
    if (isDeniedStagingPath(entry.path)) denied.push({ ...entry, reason: 'deny_path' });
    else selected.push(entry.path);
  }
  return { selected: [...new Set(selected)], denied };
}

const runGitChecked = (repoRoot, args) => {
  const result = runGit(repoRoot, args, { maxBuffer: 8 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`git_failed: ${args.join(' ')}: ${String(result.stderr || result.error?.message || '').trim()}`);
  return result;
};

const pathKey = (value) => {
  const normalized = String(value || '').replaceAll('\\', '/').replace(/^\.\//, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
};

const uniquePaths = (paths = []) => [...new Set(paths.map(pathKey).filter(Boolean))].sort();

const admissionError = (code, details = {}) => Object.assign(new Error(code), {
  code,
  errorCode: code,
  details,
});

export function mutationAdmissionDigest({ runId, projectId, workspaceId, sourceIdentity, mutationRevision, changedPaths, workspaceIdentity }) {
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
} = {}) {
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
} = {}) {
  const effectiveRunId = runId || env.MOON_RELAY_KERNEL_RUN_ID || null;
  const resolveLineage = (candidate) => {
    if (typeof stateStore.resolveSuccessorLineage !== 'function') {
      return { runs: [candidate], runIds: [candidate.runId], terminalRunId: candidate.runId, isTerminal: true, edges: [] };
    }
    return stateStore.resolveSuccessorLineage(candidate.runId);
  };
  const validLineage = (candidate) => {
    const lineage = resolveLineage(candidate);
    if (!lineage.isTerminal || lineage.terminalRunId !== candidate.runId) return null;
    const entries = lineage.runs.map((lineageRun) => {
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
        && provenance
        && provenance.projectId === projectId
        && provenance.workspaceId === workspaceId
        && provenance.sourceIdentity === lineageRun.sourceIdentity
        && Number(provenance.mutationRevision) > 0
        && Number(provenance.mutationRevision) === Number(lineageRun.mutationRevision)
        && Boolean(provenance.workspaceIdentity)
        && Array.isArray(provenance.changedPaths)
        && provenance.changedPaths.length > 0;
      return { run: lineageRun, completion, provenance, valid };
    });
    return entries.every((entry) => entry.valid) ? { lineage, entries } : null;
  };
  // Stage 1: Filter Completed Structural Candidates
  const structuralCandidates = effectiveRunId
    ? [stateStore.getRun(effectiveRunId)].filter(Boolean)
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

export function admitKernelMutation({ stateStore, project, statusEntries = [], selected = [], runId = null, env = {} } = {}) {
  const workspace = registerWorkspace({ stateStore, projectId: project.projectId, workspaceRoot: project.projectRoot });
  const currentObservation = observeWorkspaceIdentity({ projectRoot: project.projectRoot });
  const currentPaths = uniquePaths(statusEntries.map((entry) => entry.path));
  const selectedPaths = uniquePaths(selected);
  const resolution = resolveKernelCloseoutRun({
    stateStore,
    projectId: project.projectId,
    workspaceId: workspace.workspaceId,
    runId,
    env,
    currentWorkspaceIdentity: currentObservation.identity || currentObservation.workspaceIdentity || null,
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

export async function kernelCommit({ cwd = process.cwd(), env = process.env, message = null, push = false, memory = false, memoryReview = false, approvalRef = null, runId = null, approve = false, approver = null, reason = null, approvalReason = null, operatorApprovalRef = null } = {}) {
  await ensureAccountRootTrack({ startDir: cwd, track: 'kernel', env, source: 'standalone-kernel-commit' });
  const project = resolveStandaloneProject({ cwd, env });
  const statusResult = runGitChecked(project.projectRoot, ['status', '--porcelain=v1']);
  const statusEntries = parseGitStatus(statusResult.stdout);
  const { selected, denied } = selectStagingPaths(statusEntries);

  if (approve) {
    const { createKernelControlPlane } = await import('../control-plane.mjs');
    const cp = await createKernelControlPlane({ projectRoot: project.projectRoot, runtimeHome: project.runtimeHome, env });
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
    let candidates = [];
    if (memory || memoryReview) {
      const map = await readJson(path.join(project.codebaseRoot, 'codebase-map.json'), { files: [] });
      candidates = extractCodebaseCandidates(map, { projectId: project.projectId, sourceDigest: index.manifest?.sourceTreeDigest });
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
    const commitSubject = commitMessage.split('\n', 1)[0];
    const beforeHeadSha = runGitChecked(project.projectRoot, ['rev-parse', 'HEAD']).stdout.trim();
    stageSelectedPaths({ repoRoot: project.projectRoot, paths: selected, git: runGit });
    const commitResult = runGitChecked(project.projectRoot, ['commit', '-m', commitMessage]);
    const commitHash = runGitChecked(project.projectRoot, ['rev-parse', 'HEAD']).stdout.trim();
    const receipt = {
      schemaVersion: 2,
      authority: 'kernel-closeout-only',
      projectId: project.projectId,
      branch: gitCurrentBranch(project.projectRoot),
      commitHash,
      commitSubject,
      commitMessage,
      selectedPaths: selected,
      deniedPaths: denied,
      treeDigest: gitTreeDigest(project.projectRoot),
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
      runGitChecked(project.projectRoot, ['push']);
      const remoteHead = runGitChecked(project.projectRoot, ['ls-remote', 'origin', `refs/heads/${receipt.branch}`]).stdout.trim().split(/\s+/)[0] || null;
      receipt.pushStatus = remoteHead === commitHash ? 'completed' : 'parity_failed';
      receipt.remoteHead = remoteHead;
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

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = parseCliArgs(process.argv.slice(2));
  kernelCommit({
    message: args.message || null,
    push: args.push === true,
    memory: args.memory === true,
    memoryReview: args.memoryReview === true,
    approvalRef: args.approvalRef || null,
    runId: args.runId || null,
    approve: args.approve === true,
    approver: args.approver || null,
    reason: args.reason || args.approvalReason || null,
    operatorApprovalRef: args.operatorApprovalRef || process.env.MOON_RELAY_KERNEL_OPERATOR_APPROVAL_REF || null,
  }).then((result) => printResult(result, { json: args.json })).catch((error) => { printResult({ status: 'error', errorCode: error.code || error.message }, { json: true }); process.exitCode = 1; });
}
