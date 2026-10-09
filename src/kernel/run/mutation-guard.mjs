import path from 'node:path';
import { existsSync, realpathSync } from 'node:fs';
import { capsuleStaleness } from './execution-capsule.mjs';
import { findScopeViolations } from './capsule-selection.mjs';
import { runGit } from '../../shared/git-safe.mjs';
import { observeWorkspaceIdentity } from './workspace-identity.mjs';
import { assertRunWorktreeMutationAuthority } from './worktree-binding.mjs';

export const MUTATION_OPERATIONS = Object.freeze([
  'file_write', 'file_delete', 'git_commit', 'git_checkout', 'git_reset',
  'dependency_install', 'migration', 'destructive_command',
]);

// Every persisted or compared repository path crosses this primitive. The
// platform argument is explicit so tests can prove Windows and POSIX rules
// without depending on the OS that happens to run the test process.
export const canonicalPathIdentity = (value, { platform = process.platform } = {}) => {
  if (value === null || value === undefined) return '';
  const raw = String(value).trim();
  if (!raw) return '';
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const normalized = pathApi.normalize(raw.replaceAll('\\', '/')).replaceAll('\\', '/');
  const relative = normalized.replace(/^\.\/+/, '') || '.';
  return platform === 'win32' ? relative.toLowerCase() : relative;
};

const fail = (code, message) => {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  throw error;
};

const canonicalWorkspace = (workspaceRoot) => realpathSync(path.resolve(workspaceRoot));

const failForMode = (mode, genericCode, deliveryCode, message) => {
  fail(mode === 'delivery' ? deliveryCode : genericCode, message);
};

const registeredWorkspaceFor = ({ stateStore, workspaceId, run }) => (
  workspaceId && stateStore.getProjectWorkspace
    ? stateStore.getProjectWorkspace(workspaceId)
    : null
);

const readHeadCommit = (workspaceRoot) => {
  const result = runGit(workspaceRoot, ['rev-parse', '--verify', 'HEAD']);
  if (result.error || result.status !== 0) return null;
  return String(result.stdout || '').trim() || null;
};

const readWorkspaceStatus = (workspaceRoot) => {
  const result = runGit(workspaceRoot, ['status', '--porcelain=v1', '--untracked-files=all']);
  if (result.error || result.status !== 0) return null;
  return String(result.stdout || '').trim();
};

export const canonicalMutationPath = ({ workspaceRoot, targetPath, platform = process.platform } = {}) => {
  const root = canonicalWorkspace(workspaceRoot);
  const portableTarget = String(targetPath || '').replaceAll('\\', '/');
  const requested = path.isAbsolute(portableTarget) ? path.resolve(portableTarget) : path.resolve(root, portableTarget);
  let cursor = requested;
  while (!existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  const resolvedBase = realpathSync(cursor);
  const resolved = path.resolve(resolvedBase, path.relative(cursor, requested));
  const comparableRoot = canonicalPathIdentity(root, { platform });
  const comparable = canonicalPathIdentity(resolved, { platform });
  const rootPrefix = comparableRoot.endsWith('/') ? comparableRoot : `${comparableRoot}/`;
  if (comparable !== comparableRoot && !comparable.startsWith(rootPrefix)) {
    fail('mutation_outside_workspace', `target escapes workspace: ${targetPath}`);
  }
  const relative = canonicalPathIdentity(path.relative(root, resolved), { platform });
  if (!relative || relative === '.' || relative.startsWith('../') || path.isAbsolute(relative)) {
    if (!relative || relative === '.') return '.';
    fail('mutation_outside_workspace', `target escapes workspace: ${targetPath}`);
  }
  return relative;
};

// The workspace lock and its fencing credentials are the shared mutation
// authority. Ordinary Step mutations and owner Delivery materialization both
// enter through this primitive; the caller decides whether a Step/Capsule
// scope must be checked after the fence is held.
export const assertWorkspaceMutationFence = ({
  stateStore,
  workspaceRoot,
  runId,
  workspaceId = null,
  projectId = null,
  fencingToken = null,
  sessionToken = null,
  worktree = null,
  requireOwnerWorktree = false,
  mode = 'mutation',
} = {}) => {
  if (!stateStore || !workspaceRoot) fail('mutation_guard_invalid', 'stateStore and workspaceRoot are required');
  const run = stateStore.getRun(runId);
  if (!run || run.status !== 'active') {
    failForMode(mode, 'mutation_run_inactive', 'delivery_run_inactive', runId);
  }

  const effectiveWorkspaceId = workspaceId || run.workspaceId;
  const registeredWorkspace = registeredWorkspaceFor({ stateStore, workspaceId: effectiveWorkspaceId, run });
  if (registeredWorkspace
    && canonicalPathIdentity(workspaceRoot) !== canonicalPathIdentity(registeredWorkspace.canonicalRoot)) {
    failForMode(mode, 'mutation_workspace_mismatch', 'delivery_workspace_mismatch', effectiveWorkspaceId || runId);
  }

  if (requireOwnerWorktree) {
    try {
      assertRunWorktreeMutationAuthority({
        stateStore,
        run,
        worktree: worktree || {
          projectId: projectId || run.projectId,
          worktreeId: run.worktreeId,
          workspaceId: effectiveWorkspaceId,
        },
      });
    } catch (error) {
      failForMode(
        mode,
        error.code || 'mutation_worktree_authority_lost',
        'delivery_worktree_authority_lost',
        error.message,
      );
    }
  }

  if (!effectiveWorkspaceId) {
    failForMode(mode, 'mutation_workspace_mismatch', 'delivery_workspace_mismatch', runId);
  }
  const lock = stateStore.getWorkspaceMutationLockV2(effectiveWorkspaceId);
  if (!lock) {
    failForMode(mode, 'workspace_mutation_lock_missing', 'delivery_mutation_fence_lost', run.projectId);
  }
  if (fencingToken === null || fencingToken === undefined || !sessionToken) {
    failForMode(mode, 'mutation_fence_credentials_missing', 'delivery_mutation_fence_lost', run.projectId);
  }
  if (
    lock.holderRunId !== runId
    || lock.fencingToken !== fencingToken
    || lock.sessionToken !== sessionToken
  ) {
    failForMode(mode, 'workspace_mutation_fence_mismatch', 'delivery_mutation_fence_lost', run.projectId);
  }

  return {
    allowed: true,
    run,
    workspaceId: effectiveWorkspaceId || null,
    workspace: registeredWorkspace,
    lock,
    fencingToken: lock.fencingToken,
    sessionToken: lock.sessionToken,
  };
};

// Delivery CAS adds the owner Run/worktree snapshot and the native workspace
// checks to the shared fence. `phase=pre` is used immediately before git
// apply; `phase=post` deliberately permits the expected dirty state while
// still requiring the Run/revision/HEAD/fence to be unchanged.
export const assertOwnerWorkspaceMutationCAS = ({
  stateStore,
  workspaceRoot,
  runId,
  workspaceId = null,
  projectId = null,
  worktree = null,
  fencingToken = null,
  sessionToken = null,
  expectedMutationRevision = null,
  expectedWorkspaceIdentity = null,
  expectedHeadCommitSha = null,
  expectedWorkspaceId = null,
  expectedWorktreeId = null,
  expectedProjectId = null,
  actualWorkspaceIdentity = null,
  phase = 'pre',
} = {}) => {
  const fence = assertWorkspaceMutationFence({
    stateStore,
    workspaceRoot,
    runId,
    workspaceId,
    projectId,
    fencingToken,
    sessionToken,
    worktree,
    requireOwnerWorktree: true,
    mode: 'delivery',
  });
  const run = fence.run;
  if (expectedWorkspaceId && run.workspaceId !== expectedWorkspaceId) {
    fail('delivery_worktree_authority_lost', `Run workspace ${run.workspaceId || '<missing>'} does not match expected workspace ${expectedWorkspaceId}`);
  }
  if (expectedProjectId && run.projectId !== expectedProjectId) {
    fail('delivery_worktree_authority_lost', `Run project ${run.projectId} does not match expected project ${expectedProjectId}`);
  }
  if (expectedWorktreeId && run.worktreeId !== expectedWorktreeId) {
    fail('delivery_worktree_authority_lost', `Run worktree ${run.worktreeId || '<missing>'} does not match expected worktree ${expectedWorktreeId}`);
  }
  if (expectedMutationRevision !== null && expectedMutationRevision !== undefined
    && Number(run.mutationRevision) !== Number(expectedMutationRevision)) {
    fail('delivery_mutation_revision_stale', `Run mutation revision ${run.mutationRevision} does not match expected ${expectedMutationRevision}`);
  }
  if (expectedWorkspaceIdentity && run.currentWorkspaceIdentity !== expectedWorkspaceIdentity) {
    fail('delivery_workspace_drift', 'Run workspace identity no longer matches the Delivery CAS snapshot');
  }

  const headCommitSha = readHeadCommit(workspaceRoot);
  if (!headCommitSha) fail('delivery_head_changed', 'Delivery HEAD is unavailable');
  if (expectedHeadCommitSha && headCommitSha !== expectedHeadCommitSha) {
    fail('delivery_head_changed', `Delivery HEAD ${headCommitSha} does not match expected ${expectedHeadCommitSha}`);
  }

  const observedIdentity = actualWorkspaceIdentity || observeWorkspaceIdentity({ projectRoot: workspaceRoot }).identity;
  if (phase === 'pre' || phase === 'post-commit') {
    if (expectedWorkspaceIdentity && observedIdentity !== expectedWorkspaceIdentity) {
      fail('delivery_workspace_drift', 'Delivery workspace identity no longer matches the CAS snapshot');
    }
  }
  if (phase === 'pre') {
    const status = readWorkspaceStatus(workspaceRoot);
    if (status === null) fail('delivery_workspace_drift', 'Delivery workspace status is unavailable');
    if (status) fail('delivery_workspace_drift', 'Delivery workspace is dirty before materialization');
  }

  return {
    ...fence,
    run,
    headCommitSha,
    workspaceIdentity: observedIdentity,
    phase,
  };
};

export const assertMutationAllowed = ({
  stateStore,
  workspaceRoot,
  runId,
  stepId,
  capsuleId,
  operation,
  targetPaths = [],
  fencingToken = null,
  sessionToken = null,
} = {}) => {
  if (!stateStore || !workspaceRoot) fail('mutation_guard_invalid', 'stateStore and workspaceRoot are required');
  if (!MUTATION_OPERATIONS.includes(operation)) fail('mutation_operation_unknown', operation);
  const run = stateStore.getRun(runId);
  if (!run || run.status !== 'active') fail('mutation_run_inactive', runId);
  const step = stateStore.getRunStep(runId, stepId);
  if (!step || !['ready', 'running', 'active'].includes(step.state)) fail('mutation_step_inactive', stepId);
  const capsule = stateStore.getExecutionCapsule(capsuleId, { runId });
  if (!capsule || capsule.stepId !== stepId || capsule.role !== 'implementer') fail('mutation_capsule_invalid', capsuleId);
  const capsuleRun = step.baseWorkspaceIdentity
    ? { ...run, currentWorkspaceIdentity: step.baseWorkspaceIdentity }
    : run;
  const stale = capsuleStaleness({ capsule, run: capsuleRun });
  if (stale.stale) fail('mutation_capsule_stale', stale.reasons.join(', '));
  if (capsule.expiresAt && Date.parse(capsule.expiresAt) <= Date.now()) fail('mutation_capsule_expired', capsuleId);
  if (['git_reset', 'destructive_command'].includes(operation)) fail('mutation_operation_forbidden', operation);
  if (operation === 'git_commit' && capsule.permissions?.canCommit !== true) fail('mutation_operation_forbidden', operation);

  const effectiveWorkspaceId = step.executionWorkspaceId || run.workspaceId;
  const fence = assertWorkspaceMutationFence({
    stateStore,
    workspaceRoot,
    runId,
    workspaceId: effectiveWorkspaceId,
    fencingToken,
    sessionToken,
  });

  const relativePaths = targetPaths.map((targetPath) => canonicalMutationPath({ workspaceRoot, targetPath }));
  const violations = findScopeViolations({
    changedPaths: relativePaths,
    allowedPaths: capsule.workUnit?.allowedPaths || [],
    forbiddenPaths: capsule.workUnit?.forbiddenPaths || [],
  });
  if (violations.length) fail('mutation_path_forbidden', violations.map((item) => item.path).join(', '));
  return { allowed: true, runId, stepId, workspaceId: effectiveWorkspaceId || null, capsuleId, operation, targetPaths: relativePaths, fencingToken: fence.fencingToken };
};
