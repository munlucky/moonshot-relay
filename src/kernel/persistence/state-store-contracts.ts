import type { DeclaredRunObligationInput, PersistedRunObligation, PersistedVerification } from './trust-store.js';
import type { PersistedWorkStep, WorkStepStore } from './work-store.js';
import type { WorkAttempt, WorkAttemptStore, FinishStepAttemptInput } from './work-attempt-store.js';
import type { PersistedProjectIdentity } from './project-identity-store.js';
import type { PersistedProjectWorkspace, PersistedSessionBinding, PersistedWorkspaceMutationLock, PersistedWorktreeMutationLease } from './work-lifecycle-store.js';
import type { KnowledgeLifecycleStore } from './knowledge-lifecycle-store.js';
import type { ReviewReceiptInput } from '../proof/review-receipt.js';
import type { ModelRouteDecisionInput } from '../../contracts/model-route.js';
import type { ContractStep } from '../task/task-contract.js';
import type { WorkspaceChangeEntry } from '../../contracts/workspace-observation.js';
import type { ProofTier } from '../proof-route.js';
import type { normalizeModelUsageReceipt } from '../../contracts/model-execution.js';
export type ModelUsageReceiptInput = Parameters<typeof normalizeModelUsageReceipt>[0];
export type UnknownRecord = Record<string, unknown>;
export interface SqliteTableRow {
    name: string;
}
export interface RawWorkspaceRow {
    workspace_id: string;
    project_id: string;
    canonical_root: string;
    identity_json: string | null;
}
export interface KnowledgeRevisionRow {
    revision: number;
    updated_at: string;
}
export interface StoredTaskContract extends UnknownRecord {
    digest?: string;
    acceptance?: Array<{
        id?: string;
        statement?: string;
        evidencePlan?: UnknownRecord | null;
    }>;
    completionPredicate?: {
        requiredOutcomes?: string[];
    };
    steps?: ContractStep[];
}
export interface RunSignals extends UnknownRecord {
    efficiency?: unknown;
    failures?: unknown[];
    blockers?: unknown[];
    architectureJudgments?: unknown[];
    regressionVerifications?: unknown[];
    invariantObservations?: unknown[];
    supersessionEvidence?: unknown[];
}
export interface StoredRunRoute extends UnknownRecord {
    stages?: string[];
}
export interface KernelRun extends UnknownRecord {
    schemaVersion: number;
    runId: string;
    objective: string;
    currentState: string;
    state: string;
    status: string;
    revision: number;
    mutationRevision: number;
    sourceIdentity: string;
    runStartWorkspaceIdentity: string | null;
    currentWorkspaceIdentity: string | null;
    blockedReason: string | null;
    blockingClass: string | null;
    interventionCount: number;
    projectMode: string | null;
    baselineFailures: {
        obligationId: string;
        commandRef: string;
        exitCode?: number | null;
    }[];
    baselineStatus: string;
    replanCount: number;
    proofTier: ProofTier;
    evidenceTier: string;
    requiredObligations: string[];
    acceptanceCriteria: string[];
    releaseEvidenceRequired: boolean;
    projectId: string | null;
    knowledgeRevisionStart: string | null;
    knowledgeRevisionClose: string | null;
    knowledgeStatus: string | null;
    contextPackRef: string | null;
    baselineChangedPaths: string[];
    baselineWorkspaceEntries: WorkspaceChangeEntry[];
    reportBaselineChangedPaths: string[];
    reportBaselineWorkspaceEntries: WorkspaceChangeEntry[];
    workspaceBaselineStatus: string;
    taskContract: StoredTaskContract | null;
    contractRevision: number;
    finalizationStatus: string;
    route: StoredRunRoute | null;
    implementationContext: UnknownRecord | null;
    planRevision: number;
    workspaceId: string | null;
    worktreeId: string | null;
    ownerBindingId: string | null;
    successorKey: string | null;
    runSignals: RunSignals;
    updatedAt: string;
}
export interface BindingInput {
    bindingId: string;
    projectId: string;
    runId: string;
    sessionId: string;
    provider: string;
    workspaceId?: string | null;
    workspaceRoot?: string | null;
    surface?: string | null;
    accessMode: string;
    status: string;
    expiresAt?: string | null;
}
export interface LegacyIdentityCandidate {
    projectId?: string;
    source?: string;
    aliasType?: string;
    canonicalRoot?: string | null;
}
export interface ProjectIdentityInput {
    projectId?: string;
    canonicalRoot?: string;
    projectRoot?: string;
    identitySource?: string;
    identityDigest?: string;
    worktreeId?: string;
    gitCommonDir?: string | null;
    gitWorktreeDir?: string | null;
    aliases?: string[];
    legacyAliases?: Array<string | LegacyIdentityCandidate>;
    legacyProjectIds?: string[];
}
export type IdentityRow = PersistedProjectIdentity & {
    projectId?: string;
    canonicalRoot?: string;
    identitySource?: string;
    identityDigest?: string;
    aliasesJson?: string;
    createdAt?: string;
    updatedAt?: string;
};
export interface WorkspaceInput {
    workspaceId: string;
    projectId?: string;
    worktreeId?: string;
    canonicalRoot?: string;
    gitCommonDir?: string | null;
    gitWorktreeDir?: string | null;
    identity: ProjectIdentityInput;
}
export type CreateRunInput = {
    runId: string;
    objective: string;
    sourceIdentity: string;
    proofTier?: string;
    evidenceTier?: string;
    requiredObligations?: string[];
    acceptanceCriteria?: string[];
    requireReleaseEvidence?: boolean;
    projectId?: string | null;
    knowledgeRevisionStart?: string | null;
    workspaceIdentity?: string | null;
    projectMode?: string | null;
    taskContract?: StoredTaskContract | null;
    contractRevision?: number;
    route?: StoredRunRoute | null;
    implementationContext?: UnknownRecord | null;
    workspaceId?: string | null;
    worktreeId?: string | null;
    baselineChangedPaths?: string[];
    baselineWorkspaceEntries?: WorkspaceChangeEntry[];
    reportBaselineChangedPaths?: string[] | null;
    reportBaselineWorkspaceEntries?: WorkspaceChangeEntry[] | null;
    workspaceBaselineStatus?: string;
    ownerBindingId?: string | null;
    successorKey?: string | null;
    withinTransaction?: boolean;
    runStartWorkspaceIdentity?: string | null;
};
export type CompletionEvaluation = ({
    decision: string;
    run: null;
} | {
    decision: string;
    digest: string;
    run: KernelRun;
    decisionPayload: UnknownRecord;
}) & UnknownRecord;
