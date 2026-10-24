import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import os from 'node:os';
import { readFile } from 'node:fs/promises';
import { chmod } from 'node:fs/promises';
import path from 'node:path';
import { identityInspectionCanonicalRoot, resolveKernelProjectIdentity, stableHash } from './project-identity.js';
import { openKernelStateStore } from './state-store.js';
import { ensureKnowledgeStoreDirectories, projectKnowledgeDirectory } from './knowledge/store.js';
import { canonicalPath, resolveKernelRuntimeHome } from './runtime-home.js';
import {
  registerWorkspace,
  type RegisteredWorkspace,
  type WorkspaceRegistryStore,
} from './run/workspace-registration.js';
import type { StableWorkspaceObservation } from '../contracts/workspace-observation.js';
import { atomicWriteText } from './durable-write.js';

type UnknownRecord = Record<string, unknown>;
type KernelProjectIdentity = ReturnType<typeof resolveKernelProjectIdentity>;
type LegacyIdentityAlias = KernelProjectIdentity['legacyAliases'][number];

interface PersistedIdentity extends UnknownRecord {
  projectId: string;
  canonicalRoot: string;
  identitySource?: string | null | undefined;
  identityDigest?: (string | null) | undefined;
  aliases?: string[];
  gitCommonDir?: string | null;
}

interface IdentityCandidate extends UnknownRecord {
  projectId: string;
  source?: (string | null) | undefined;
  hasData: boolean;
  hasPersistedIdentity: boolean;
  sameRootEvidence: boolean;
  identity?: PersistedIdentity | null;
  workspaceRoots: string[];
}

interface IdentityInspection {
  currentIdentity: PersistedIdentity | null;
  legacyCandidates: IdentityCandidate[];
}

interface IdentityStateStore extends WorkspaceRegistryStore<RegisteredWorkspace> {
  inspectProjectIdentity(input: {
    projectId?: string | null;
    canonicalRoot?: string | null;
    gitCommonDir?: string | null;
    legacyCandidates?: LegacyIdentityAlias[];
  }): IdentityInspection;
  registerProjectIdentity(identity: KernelProjectIdentity): PersistedIdentity | null;
  mergeProjectIdentity(input: {
    sourceProjectId: string;
    targetProjectId: string;
    canonicalRoot: string;
    gitCommonDir?: string | null;
    approvedTargetIdentity?: KernelProjectIdentity | null;
  }): PersistedIdentity | null;
  close(): void;
}

type WorkspaceResolver = (input: {
  projectId: string;
  workspaceRoot: string;
}) => StableWorkspaceObservation;

interface IdentityPreflight {
  identity: KernelProjectIdentity;
  state: IdentityInspection;
  unresolved: IdentityCandidate[];
  status: string;
}

interface RepairContext {
  effectiveRuntimeHome: string;
  identity: KernelProjectIdentity;
  store: IdentityStateStore;
  preflight: IdentityPreflight;
}

interface InspectInput {
  projectRoot?: string;
  runtimeHome?: (string) | undefined;
  env?: NodeJS.ProcessEnv;
}

interface BootstrapInput extends InspectInput {
  policy?: string;
  resolveStableWorkspaceIdentity?: WorkspaceResolver | null;
}

interface ApprovalInput extends InspectInput {
  legacyProjectId?: string | null;
  approvalRef?: string | null;
  approvedBy?: string | null;
}

interface RepairInput extends InspectInput {
  legacyProjectId?: string | null;
  approvalRef?: string | null;
  resolveStableWorkspaceIdentity?: WorkspaceResolver | null;
}

interface ApprovalReceipt extends UnknownRecord {
  approvalDigest?: string;
  approvalRef: string;
  operation: string;
  status: string;
  approvedBy: string;
  signer: ReturnType<typeof operatorSigner>;
  projectId: string;
  canonicalRoot: string;
  legacyProjectId: string;
  createdAt: string;
}

interface IdentityReceipt extends UnknownRecord {
  schemaVersion: number;
  receiptId: string;
  operation: string;
  status: string;
  projectId: string;
  canonicalRoot: string;
  workspaceId: string;
  gitCommonDir: string | null;
  legacyProjectId: string | null;
  approvalRef: string | null;
  approvalDigest: string | null;
  signer: ReturnType<typeof operatorSigner>;
  unresolvedLegacyCandidates: Array<{
    projectId: string;
    source?: string | null;
    hasPersistedIdentity: boolean;
    workspaceRoots: string[];
  }>;
  createdAt: string;
  receiptDigest?: string;
}

const APPROVAL_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

const runtimeEnv = (env: NodeJS.ProcessEnv, runtimeHome: string): NodeJS.ProcessEnv => ({
  ...env,
  MOON_RELAY_KERNEL_HOME: runtimeHome,
});

const registerObservedWorkspace = ({
  stateStore,
  resolveStableWorkspaceIdentity,
  projectId,
  workspaceRoot,
}: {
  stateStore: IdentityStateStore;
  resolveStableWorkspaceIdentity: WorkspaceResolver | null;
  projectId: string;
  workspaceRoot: string;
}): RegisteredWorkspace => {
  if (typeof resolveStableWorkspaceIdentity !== 'function') {
    throw Object.assign(new Error('workspace_observer_required'), {
      code: 'workspace_observer_required',
    });
  }
  const workspace = resolveStableWorkspaceIdentity({ projectId, workspaceRoot });
  return registerWorkspace({ stateStore, workspace, projectId });
};

const digest = (value: unknown): string => `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
const operatorSigner = () => {
  let username = '';
  try { username = os.userInfo().username; } catch { username = process.env.USER || process.env.USERNAME || ''; }
  const uid = typeof process.getuid === 'function' ? String(process.getuid()) : null;
  if (!username) throw approvalError('project_identity_operator_unavailable', 'provide-a-local-operator-identity');
  return { kind: 'os-user', username: String(username), uid };
};
const approvalKeyPath = (runtimeHome: string): string => path.join(canonicalPath(runtimeHome), 'state', 'operator-approvals', 'project-identity', '.signing-key');
const approvalSigningKey = async (runtimeHome: string, { create = false }: { create?: boolean } = {}): Promise<string> => {
  const file = approvalKeyPath(runtimeHome);
  try {
    const value = (await readFile(file, 'utf8')).trim();
    if (/^[a-f0-9]{64}$/i.test(value)) return value;
    throw new Error('invalid approval signing key');
  } catch (error: unknown) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
    if (!create || code !== 'ENOENT') throw approvalError('project_identity_signing_key_invalid', 'recreate-the-local-approval-signing-key', { signingKeyPath: file });
    const value = randomBytes(32).toString('hex');
    await atomicWriteText(file, value);
    await chmod(file, 0o600).catch(() => {});
    return value;
  }
};
const signedDigest = async (value: unknown, runtimeHome: string, options: { create?: boolean } = {}): Promise<string> => `hmac-sha256:${createHmac('sha256', await approvalSigningKey(runtimeHome, options)).update(JSON.stringify(value)).digest('hex')}`;

const identityForProject = (identity: KernelProjectIdentity, projectId: string, identitySource: string): KernelProjectIdentity => ({
  ...identity,
  projectId,
  identitySource,
  identityDigest: stableHash(`${projectId}:${identity.canonicalRoot}`),
  legacyProjectIds: [],
  legacyAliases: [],
});

const uniqueCandidates = (identity: KernelProjectIdentity): LegacyIdentityAlias[] => {
  const candidates = Array.isArray(identity.legacyAliases) ? identity.legacyAliases : [];
  return [...new Map(candidates
    .filter((candidate) => candidate?.projectId && candidate.projectId !== identity.projectId)
    .map((candidate) => [candidate.projectId, candidate])).values()];
};

const assertApprovalRef = (approvalRef: unknown): string => {
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

const assertApprovedBy = (approvedBy: unknown): string => {
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

const approvalPath = ({ runtimeHome, approvalRef }: { runtimeHome: string; approvalRef: string }): string => path.join(
  canonicalPath(runtimeHome),
  'state',
  'operator-approvals',
  'project-identity',
  `${createHash('sha256').update(String(approvalRef)).digest('hex')}.json`,
);

const approvalError = (code: string, nextAction: string, details: UnknownRecord = {}) => Object.assign(new Error(code), {
  code,
  errorCode: code,
  nextAction,
  ...details,
});

const candidateHasPersistedState = (candidate: IdentityCandidate): boolean => (
  candidate.hasData || candidate.hasPersistedIdentity
);

const findLegacyCandidate = (preflight: IdentityPreflight, legacyProjectId: unknown): IdentityCandidate => {
  const candidate = preflight.state.legacyCandidates.find((item) => item.projectId === String(legacyProjectId || ''));
  if (!candidate || !candidateHasPersistedState(candidate)) {
    throw approvalError('project_identity_legacy_candidate_not_found', 'inspect-project-identity-candidates', { legacyProjectId });
  }
  return candidate;
};

const readIdentityApproval = async ({ runtimeHome, approvalRef, projectId, canonicalRoot, legacyProjectId }: { runtimeHome: string; approvalRef: string; projectId: string; canonicalRoot: string; legacyProjectId: string }): Promise<ApprovalReceipt & { path: string }> => {
  const file = approvalPath({ runtimeHome, approvalRef });
  let approval: ApprovalReceipt;
  try {
    approval = JSON.parse(await readFile(file, 'utf8')) as ApprovalReceipt;
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

const receiptPath = ({ runtimeHome, projectId, receiptId }: { runtimeHome: string; projectId: string; receiptId: string }): string => path.join(
  projectKnowledgeDirectory(projectId, { env: { MOON_RELAY_KERNEL_HOME: runtimeHome } }),
  'receipts',
  'identity',
  `${receiptId}.json`,
);

const writeIdentityReceipt = async ({
  runtimeHome,
  projectId,
  operation,
  identity,
  workspace,
  preflight,
  approvalRef = null,
  approvalDigest = null,
  legacyProjectId = null,
}: {
  runtimeHome: string;
  projectId: string;
  operation: string;
  identity: PersistedIdentity;
  workspace: RegisteredWorkspace;
  preflight: { legacyCandidates: IdentityCandidate[] };
  approvalRef?: string | null;
  approvalDigest?: (string | null) | undefined;
  legacyProjectId?: string | null;
}): Promise<IdentityReceipt & { path: string }> => {
  await ensureKnowledgeStoreDirectories(projectId, { env: { MOON_RELAY_KERNEL_HOME: runtimeHome } });
  const payload: IdentityReceipt = {
    schemaVersion: 1,
    receiptId: `${operation}-${randomUUID()}`,
    operation,
    status: 'committed',
    projectId,
    canonicalRoot: identity.canonicalRoot,
    workspaceId: workspace.workspaceId,
    gitCommonDir: workspace.gitCommonDir || null,
    legacyProjectId,
    approvalRef,
    approvalDigest,
    signer: operatorSigner(),
    unresolvedLegacyCandidates: preflight.legacyCandidates
      .filter(candidateHasPersistedState)
      .map((candidate) => ({
        projectId: candidate.projectId,
        source: candidate.source ?? null,
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

export const inspectKernelProjectIdentity = async ({ projectRoot = process.cwd(), runtimeHome = resolveKernelRuntimeHome(), env = process.env }: InspectInput = {}) => {
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
    const unresolved = state.legacyCandidates.filter((candidate) => (
      candidateHasPersistedState(candidate)
      && (!state.currentIdentity || candidate.sameRootEvidence)
    ));
    const status = unresolved.length > 0
      ? 'repair_required'
      : state.currentIdentity
        ? 'ready'
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

const loadRepairContext = async ({ projectRoot, runtimeHome, env }: { projectRoot: string; runtimeHome: string; env: NodeJS.ProcessEnv }): Promise<RepairContext> => {
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
    const unresolved = state.legacyCandidates.filter((candidate) => (
      candidateHasPersistedState(candidate)
      && (!state.currentIdentity || candidate.sameRootEvidence)
    ));
    return {
      identity,
      state,
      unresolved,
      status: unresolved.length ? 'repair_required' : state.currentIdentity ? 'ready' : 'bootstrap_required',
    };
  })();
  return { effectiveRuntimeHome, identity, store, preflight };
};

export const bootstrapKernelProjectIdentity = async ({ projectRoot = process.cwd(), runtimeHome = resolveKernelRuntimeHome(), env = process.env, policy = 'isolate', resolveStableWorkspaceIdentity = null }: BootstrapInput = {}) => {
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
    const persisted = store.registerProjectIdentity(identityForProject(identity, identity.projectId, 'operator_isolated_legacy'))!;
    const workspace = registerObservedWorkspace({
      stateStore: store,
      resolveStableWorkspaceIdentity,
      projectId: persisted.projectId,
      workspaceRoot: projectRoot,
    });
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

export const approveKernelProjectIdentityRepair = async ({ projectRoot = process.cwd(), runtimeHome = resolveKernelRuntimeHome(), env = process.env, legacyProjectId = null, approvalRef = null, approvedBy = null }: ApprovalInput = {}) => {
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
    const payload: ApprovalReceipt = {
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

export const repairKernelProjectIdentity = async ({ projectRoot = process.cwd(), runtimeHome = resolveKernelRuntimeHome(), env = process.env, legacyProjectId = null, approvalRef = null, resolveStableWorkspaceIdentity = null }: RepairInput = {}) => {
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
    const currentProjectId = preflight.state.currentIdentity?.projectId || null;
    const mergedCurrentIdentity = Boolean(currentProjectId && currentProjectId !== candidate.projectId);
    const persisted = mergedCurrentIdentity
      ? store.mergeProjectIdentity({
          sourceProjectId: currentProjectId!,
          targetProjectId: candidate.projectId,
          canonicalRoot: identity.canonicalRoot,
          gitCommonDir: identity.gitCommonDir,
          approvedTargetIdentity: candidate.hasPersistedIdentity ? null : adopted,
        })!
      : store.registerProjectIdentity(adopted)!;
    const workspace = registerObservedWorkspace({
      stateStore: store,
      resolveStableWorkspaceIdentity,
      projectId: persisted.projectId,
      workspaceRoot: projectRoot,
    });
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
      mutation: mergedCurrentIdentity
        ? 'identity-adopted-with-current-state-merge'
        : 'identity-adopted-without-data-rewrite',
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
