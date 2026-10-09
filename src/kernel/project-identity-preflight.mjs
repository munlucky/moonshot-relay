import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import os from 'node:os';
import { readFile } from 'node:fs/promises';
import { chmod } from 'node:fs/promises';
import path from 'node:path';
import { identityInspectionCanonicalRoot, resolveKernelProjectIdentity, stableHash } from './project-identity.mjs';
import { openKernelStateStore } from './state-store.mjs';
import { ensureKnowledgeStoreDirectories, projectKnowledgeDirectory } from './knowledge/store.mjs';
import { canonicalPath, resolveKernelRuntimeHome } from './runtime-home.mjs';
import { registerWorkspace } from './run/workspace-registration.mjs';
import { atomicWriteText } from './durable-write.mjs';

const APPROVAL_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

const runtimeEnv = (env, runtimeHome) => ({
  ...env,
  MOON_RELAY_KERNEL_HOME: runtimeHome,
});

const digest = (value) => `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
const operatorSigner = () => {
  let username = '';
  try { username = os.userInfo().username; } catch { username = process.env.USER || process.env.USERNAME || ''; }
  const uid = typeof process.getuid === 'function' ? String(process.getuid()) : null;
  if (!username) throw approvalError('project_identity_operator_unavailable', 'provide-a-local-operator-identity');
  return { kind: 'os-user', username: String(username), uid };
};
const approvalKeyPath = (runtimeHome) => path.join(canonicalPath(runtimeHome), 'state', 'operator-approvals', 'project-identity', '.signing-key');
const approvalSigningKey = async (runtimeHome, { create = false } = {}) => {
  const file = approvalKeyPath(runtimeHome);
  try {
    const value = (await readFile(file, 'utf8')).trim();
    if (/^[a-f0-9]{64}$/i.test(value)) return value;
    throw new Error('invalid approval signing key');
  } catch (error) {
    if (!create || error.code !== 'ENOENT') throw approvalError('project_identity_signing_key_invalid', 'recreate-the-local-approval-signing-key', { signingKeyPath: file });
    const value = randomBytes(32).toString('hex');
    await atomicWriteText(file, value);
    await chmod(file, 0o600).catch(() => {});
    return value;
  }
};
const signedDigest = async (value, runtimeHome, options = {}) => `hmac-sha256:${createHmac('sha256', await approvalSigningKey(runtimeHome, options)).update(JSON.stringify(value)).digest('hex')}`;

const identityForProject = (identity, projectId, identitySource) => ({
  ...identity,
  projectId,
  identitySource,
  identityDigest: stableHash(`${projectId}:${identity.canonicalRoot}`),
  legacyProjectIds: [],
  legacyAliases: [],
});

const uniqueCandidates = (identity) => {
  const candidates = Array.isArray(identity.legacyAliases) ? identity.legacyAliases : [];
  return [...new Map(candidates
    .filter((candidate) => candidate?.projectId && candidate.projectId !== identity.projectId)
    .map((candidate) => [candidate.projectId, candidate])).values()];
};

const assertApprovalRef = (approvalRef) => {
  const value = String(approvalRef || '').trim();
  if (!APPROVAL_REF_PATTERN.test(value)) {
    throw Object.assign(new Error('project_identity_approval_required'), {
      code: 'project_identity_approval_required',
      errorCode: 'project_identity_approval_required',
      nextAction: 'kernel identity approve --legacy-project-id <id> --approval-ref <operator-ref> --approved-by <operator>',
    });
  }
  return value;
};

const assertApprovedBy = (approvedBy) => {
  const value = String(approvedBy || '').trim();
  if (!APPROVAL_REF_PATTERN.test(value)) {
    throw Object.assign(new Error('project_identity_approver_required'), {
      code: 'project_identity_approver_required',
      errorCode: 'project_identity_approver_required',
      nextAction: 'provide-an-operator-identity',
    });
  }
  const signer = operatorSigner();
  if (value !== signer.username) {
    throw Object.assign(new Error('project_identity_approver_mismatch'), {
      code: 'project_identity_approver_mismatch',
      errorCode: 'project_identity_approver_mismatch',
      expectedSigner: signer,
      nextAction: `repeat approval as --approved-by ${signer.username}`,
    });
  }
  return value;
};

const approvalPath = ({ runtimeHome, approvalRef }) => path.join(
  canonicalPath(runtimeHome),
  'state',
  'operator-approvals',
  'project-identity',
  `${createHash('sha256').update(String(approvalRef)).digest('hex')}.json`,
);

const approvalError = (code, nextAction, details = {}) => Object.assign(new Error(code), {
  code,
  errorCode: code,
  nextAction,
  ...details,
});

const findLegacyCandidate = (preflight, legacyProjectId) => {
  const candidate = preflight.state.legacyCandidates.find((item) => item.projectId === String(legacyProjectId || ''));
  if (!candidate || !candidate.hasData) {
    throw approvalError('project_identity_legacy_candidate_not_found', 'inspect-project-identity-candidates', { legacyProjectId });
  }
  return candidate;
};

const readIdentityApproval = async ({ runtimeHome, approvalRef, projectId, canonicalRoot, legacyProjectId }) => {
  const file = approvalPath({ runtimeHome, approvalRef });
  let approval;
  try {
    approval = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    throw approvalError(
      'project_identity_approval_receipt_missing',
      `kernel identity approve --legacy-project-id ${legacyProjectId} --approval-ref ${approvalRef} --approved-by <operator>`,
      { approvalRef, legacyProjectId, approvalPath: file },
    );
  }
  const { approvalDigest, ...unsigned } = approval || {};
  const signer = operatorSigner();
  const expectedDigest = await signedDigest(unsigned, runtimeHome);
  if (!approvalDigest || approvalDigest !== expectedDigest) {
    throw approvalError('project_identity_approval_receipt_invalid', 'recreate-the-bound-operator-approval', { approvalRef, approvalPath: file });
  }
  const matches = approval.status === 'approved'
    && approval.operation === 'identity-adopt'
    && approval.approvalRef === approvalRef
    && approval.projectId === projectId
    && approval.canonicalRoot === canonicalRoot
    && approval.legacyProjectId === legacyProjectId
    && APPROVAL_REF_PATTERN.test(String(approval.approvedBy || ''))
    && JSON.stringify(approval.signer) === JSON.stringify(signer)
    && approval.approvedBy === signer.username;
  if (!matches) {
    throw approvalError('project_identity_approval_receipt_mismatch', 'recreate-the-bound-operator-approval', { approvalRef, approvalPath: file });
  }
  return { ...approval, path: file };
};

const receiptPath = ({ runtimeHome, projectId, receiptId }) => path.join(
  projectKnowledgeDirectory(projectId, { env: { MOON_RELAY_KERNEL_HOME: runtimeHome } }),
  'receipts',
  'identity',
  `${receiptId}.json`,
);

const writeIdentityReceipt = async ({ runtimeHome, projectId, operation, identity, workspace, preflight, approvalRef = null, approvalDigest = null, legacyProjectId = null }) => {
  await ensureKnowledgeStoreDirectories(projectId, { env: { MOON_RELAY_KERNEL_HOME: runtimeHome } });
  const payload = {
    schemaVersion: 1,
    receiptId: `${operation}-${randomUUID()}`,
    operation,
    status: 'committed',
    projectId,
    canonicalRoot: identity.canonicalRoot,
    workspaceId: workspace.workspaceId,
    gitCommonDir: workspace.gitCommonDir,
    legacyProjectId,
    approvalRef,
    approvalDigest,
    signer: operatorSigner(),
    unresolvedLegacyCandidates: preflight.legacyCandidates
      .filter((candidate) => candidate.hasData)
      .map((candidate) => ({
        projectId: candidate.projectId,
        source: candidate.source,
        hasPersistedIdentity: candidate.hasPersistedIdentity,
        workspaceRoots: candidate.workspaceRoots,
      })),
    createdAt: new Date().toISOString(),
  };
  payload.receiptDigest = await signedDigest(payload, runtimeHome, { create: true });
  const target = receiptPath({ runtimeHome, projectId, receiptId: payload.receiptId });
  await atomicWriteText(target, JSON.stringify(payload, null, 2));
  return { ...payload, path: target };
};

export const inspectKernelProjectIdentity = async ({ projectRoot = process.cwd(), runtimeHome = resolveKernelRuntimeHome(), env = process.env } = {}) => {
  const effectiveRuntimeHome = canonicalPath(runtimeHome);
  const identity = resolveKernelProjectIdentity({ cwd: projectRoot, env: runtimeEnv(env, effectiveRuntimeHome) });
  const store = await openKernelStateStore({ runtimeHome: effectiveRuntimeHome });
  try {
    const state = store.inspectProjectIdentity({
      projectId: identity.projectId,
      canonicalRoot: identityInspectionCanonicalRoot(identity),
      gitCommonDir: identity.gitCommonDir,
      legacyCandidates: uniqueCandidates(identity),
    });
    const unresolved = state.legacyCandidates.filter((candidate) => candidate.hasData);
    const status = state.currentIdentity
      ? 'ready'
      : unresolved.length > 0
        ? 'repair_required'
        : 'bootstrap_required';
    return {
      schemaVersion: 1,
      status,
      runtimeHome: effectiveRuntimeHome,
      projectRoot: identity.projectRoot,
      projectId: state.currentIdentity?.projectId || identity.projectId,
      resolvedProjectId: identity.projectId,
      canonicalRoot: identity.canonicalRoot,
      identitySource: state.currentIdentity?.identitySource || identity.identitySource,
      identity: state.currentIdentity,
      legacyCandidates: state.legacyCandidates,
      unresolvedLegacyCandidates: unresolved,
      remediation: status === 'ready'
        ? null
        : status === 'repair_required'
          ? {
              action: 'choose-isolate-or-adopt',
              isolateCommand: 'kernel identity bootstrap --policy isolate',
              approvalCommand: 'kernel identity approve --legacy-project-id <id> --approval-ref <operator-ref> --approved-by <operator>',
              adoptCommand: 'kernel identity repair --legacy-project-id <id> --approval-ref <operator-ref>',
              reason: 'legacy project data exists without an explicit operator identity-repair decision',
            }
          : {
              action: 'bootstrap',
              command: 'kernel identity bootstrap --policy isolate',
              reason: 'the current root has no persisted Kernel project identity',
            },
    };
  } finally {
    store.close();
  }
};

const loadRepairContext = async ({ projectRoot, runtimeHome, env }) => {
  const effectiveRuntimeHome = canonicalPath(runtimeHome);
  const identity = resolveKernelProjectIdentity({ cwd: projectRoot, env: runtimeEnv(env, effectiveRuntimeHome) });
  const store = await openKernelStateStore({ runtimeHome: effectiveRuntimeHome });
  const preflight = await (async () => {
    const state = store.inspectProjectIdentity({
      projectId: identity.projectId,
      canonicalRoot: identityInspectionCanonicalRoot(identity),
      gitCommonDir: identity.gitCommonDir,
      legacyCandidates: uniqueCandidates(identity),
    });
    const unresolved = state.legacyCandidates.filter((candidate) => candidate.hasData);
    return {
      identity,
      state,
      unresolved,
      status: state.currentIdentity ? 'ready' : unresolved.length ? 'repair_required' : 'bootstrap_required',
    };
  })();
  return { effectiveRuntimeHome, identity, store, preflight };
};

export const bootstrapKernelProjectIdentity = async ({ projectRoot = process.cwd(), runtimeHome = resolveKernelRuntimeHome(), env = process.env, policy = 'isolate' } = {}) => {
  if (policy !== 'isolate') throw new Error(`project_identity_bootstrap_policy_unsupported: ${policy}`);
  const { effectiveRuntimeHome, identity, store, preflight } = await loadRepairContext({ projectRoot, runtimeHome, env });
  try {
    if (preflight.state.currentIdentity) {
      return {
        ...await inspectKernelProjectIdentity({ projectRoot, runtimeHome: effectiveRuntimeHome, env }),
        operation: 'bootstrap',
        mutation: 'no_op',
      };
    }
    const persisted = store.registerProjectIdentity(identityForProject(identity, identity.projectId, 'operator_isolated_legacy'));
    const workspace = registerWorkspace({ stateStore: store, projectId: persisted.projectId, workspaceRoot: projectRoot });
    const receipt = await writeIdentityReceipt({
      runtimeHome: effectiveRuntimeHome,
      projectId: persisted.projectId,
      operation: 'identity-isolation',
      identity: persisted,
      workspace,
      preflight: { legacyCandidates: preflight.state.legacyCandidates },
    });
    return {
      schemaVersion: 1,
      status: 'ready',
      operation: 'bootstrap',
      policy: 'isolate',
      mutation: 'isolated',
      projectId: persisted.projectId,
      canonicalRoot: persisted.canonicalRoot,
      workspaceId: workspace.workspaceId,
      legacyState: 'preserved-unimported',
      receipt,
    };
  } finally {
    store.close();
  }
};

export const approveKernelProjectIdentityRepair = async ({ projectRoot = process.cwd(), runtimeHome = resolveKernelRuntimeHome(), env = process.env, legacyProjectId, approvalRef, approvedBy } = {}) => {
  const approvedRef = assertApprovalRef(approvalRef);
  const approver = assertApprovedBy(approvedBy);
  const { effectiveRuntimeHome, identity, store, preflight } = await loadRepairContext({ projectRoot, runtimeHome, env });
  try {
    const candidate = findLegacyCandidate(preflight, legacyProjectId);
    if (candidate.hasPersistedIdentity && !candidate.sameRootEvidence) {
      throw Object.assign(new Error('project_identity_migration_conflict'), {
        code: 'project_identity_migration_conflict',
        errorCode: 'project_identity_migration_conflict',
        legacyProjectId: candidate.projectId,
        legacyCanonicalRoot: candidate.identity?.canonicalRoot || null,
        canonicalRoot: identity.canonicalRoot,
      });
    }
    const payload = {
      schemaVersion: 1,
      approvalRef: approvedRef,
      operation: 'identity-adopt',
      status: 'approved',
      approvedBy: approver,
      signer: operatorSigner(),
      projectId: identity.projectId,
      canonicalRoot: identity.canonicalRoot,
      legacyProjectId: candidate.projectId,
      createdAt: new Date().toISOString(),
    };
    payload.approvalDigest = await signedDigest(payload, effectiveRuntimeHome, { create: true });
    const target = approvalPath({ runtimeHome: effectiveRuntimeHome, approvalRef: approvedRef });
    await atomicWriteText(target, JSON.stringify(payload, null, 2));
    return { ...payload, path: target };
  } finally {
    store.close();
  }
};

export const repairKernelProjectIdentity = async ({ projectRoot = process.cwd(), runtimeHome = resolveKernelRuntimeHome(), env = process.env, legacyProjectId, approvalRef } = {}) => {
  const approvedRef = assertApprovalRef(approvalRef);
  const { effectiveRuntimeHome, identity, store, preflight } = await loadRepairContext({ projectRoot, runtimeHome, env });
  try {
    const candidate = findLegacyCandidate(preflight, legacyProjectId);
    if (candidate.hasPersistedIdentity && !candidate.sameRootEvidence) {
      throw Object.assign(new Error('project_identity_migration_conflict'), {
        code: 'project_identity_migration_conflict',
        errorCode: 'project_identity_migration_conflict',
        legacyProjectId: candidate.projectId,
        legacyCanonicalRoot: candidate.identity?.canonicalRoot || null,
        canonicalRoot: identity.canonicalRoot,
      });
    }
    const approval = await readIdentityApproval({
      runtimeHome: effectiveRuntimeHome,
      approvalRef: approvedRef,
      projectId: identity.projectId,
      canonicalRoot: identity.canonicalRoot,
      legacyProjectId: candidate.projectId,
    });
    const adopted = identityForProject(identity, candidate.projectId, 'operator_approved_legacy');
    const persisted = store.registerProjectIdentity(adopted);
    const workspace = registerWorkspace({ stateStore: store, projectId: persisted.projectId, workspaceRoot: projectRoot });
    const receipt = await writeIdentityReceipt({
      runtimeHome: effectiveRuntimeHome,
      projectId: persisted.projectId,
      operation: 'identity-adopt',
      identity: persisted,
      workspace,
      preflight: { legacyCandidates: preflight.state.legacyCandidates },
      approvalRef: approvedRef,
      approvalDigest: approval.approvalDigest,
      legacyProjectId: candidate.projectId,
    });
    return {
      schemaVersion: 1,
      status: 'ready',
      operation: 'repair',
      policy: 'operator_approved_legacy',
      mutation: 'identity-adopted-without-data-rewrite',
      projectId: persisted.projectId,
      canonicalRoot: persisted.canonicalRoot,
      workspaceId: workspace.workspaceId,
      legacyState: 'retained-under-adopted-id',
      approval,
      receipt,
    };
  } finally {
    store.close();
  }
};
