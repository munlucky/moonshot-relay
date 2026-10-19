import { matchCapture } from '../../shared/match-capture.js';
import type { HostAdapterDispatch } from './adapter-dispatch.js';
// Host turn dispatcher (§11). Pulls the Kernel's directive, asks the Host
// adapter to run the turn under the requested model class, and files the
// receipt. It owns no provider client: `adapter.dispatch` is the only edge.

import { randomUUID } from 'node:crypto';
import { buildUsageReceipt, type UsageReceiptInput } from './usage-receipt.js';
import { prepareHostTurn } from './host-turn.js';
import { createModelRegistry, type ModelResolution, type ModelOverrideMap } from './model-registry.js';
import { currentHostPolicies, revalidateBeforeDispatch } from './admission-revalidator.js';
import { admitRoute } from './route-admission.js';
import { buildPromptEnvelope, measurePromptEnvelope } from './prompt-envelope.js';
import { buildToolManifest } from './tool-manifest.js';
import { resolveSessionLineage } from './session-affinity.js';
import { buildKernelContextSegments } from './context-segments.js';
import { resolveOptimizationModes } from './provider-prompt-policy.js';
import { resolveCodexModelPolicy } from './codex-model-policy.js';
import { resolveClaudeEffort } from './claude-effort-policy.js';
import {
  buildModelCapsuleView,
  buildModelVisiblePromptMessage,
  buildModelVisiblePromptView,
} from './model-capsule-view.js';
import { dispatchKernelRun } from './parallel-dispatcher.js';
import { isMutationBearingAction, isNativeDelegationRequested, isWorkUnitBounded } from './codex-actor-router.js';
import { resolveEnforcementStrategy } from '../../contracts/model-execution.js';
import { admitHostExecutionContract } from '../../contracts/host-execution-contract.js';
import { observeWorkspaceIdentity } from './workspace/workspace-identity.js';
import { attestReviewTransport, resolveReviewTransports } from './review-transport-resolver.js';
import type { ReviewTransportOverrides } from './review-transport-resolver.js';
import { normalizeHostBoundaryRequest } from './host-boundary.js';
import { validateIndependentSubagentReviewAttestation } from './independent-subagent-review.js';
import { sanitizePersistentPayload } from '../../shared/persistent-sanitizer.js';

import type { ProviderCacheCapabilities } from './provider-prompt-policy.js';
import type { WorkProfile } from '../../contracts/model-execution.js';
import type { ExecutionClass } from '../../contracts/execution-class.js';
type UnknownRecord = Record<string, unknown>;
type PrepareHostTurnInput = NonNullable<Parameters<typeof prepareHostTurn>[0]>;
type NormalizeHostBoundaryInput = Parameters<typeof normalizeHostBoundaryRequest>[0];
type CurrentHostPoliciesInput = Parameters<typeof currentHostPolicies>[0];
type AdmitRouteInput = Parameters<typeof admitRoute>[0];
type RevalidateBeforeDispatchInput = Parameters<typeof revalidateBeforeDispatch>[0];
type AdmitHostExecutionContractCapabilities = Parameters<typeof admitHostExecutionContract>[1];
type BuildModelCapsuleInput = Parameters<typeof buildModelCapsuleView>[0];
type BuildModelVisiblePromptInput = Parameters<typeof buildModelVisiblePromptView>[0];
type DispatchKernelRunInput = Parameters<typeof dispatchKernelRun>[0];
type ResolveReviewTransportsInput = NonNullable<Parameters<typeof resolveReviewTransports>[0]>;

interface HostRecord extends UnknownRecord, ProviderCacheCapabilities {
  status?: string;
  resultStatus?: string;
  failureCode?: string;
  errorCode?: string | null;
  code?: string;
  message?: string;
  reason?: string;
  rejectionCode?: string;
  failureStage?: string | null;
  failureCategory?: string | null;
  errorSummary?: string | null;
  actionKind?: string | null;
  role?: (string | null) | undefined;
  decisionId?: string | null;
  modelClass?: string;
  executionClass?: ExecutionClass | null;
  riskTier?: (string) | undefined;
  permissions?: (string | HostRecord | null) | undefined;
  independentContextRequired?: boolean;
  independentReviewRequired?: boolean;
  independentReview?: boolean;
  reviewMode?: string;
  supportsOwnerDirectRetry?: boolean;
  nativeDelegationAvailable?: boolean;
  ownerDirectDefault?: boolean;
  surface?: string | null;
  capabilities?: (HostRecord & NonNullable<Parameters<typeof buildPromptEnvelope>[0]>['capabilities'] & import('../../contracts/host-execution-contract.js').HostSemanticCapabilities) | null;
  supportsCrossSurfaceReview?: boolean;
  supportsIndependentContext?: boolean;
  supportsReadOnlyReview?: boolean;
  supportsSubagentModel?: boolean;
  nativeSubagent?: boolean;
  workProfile?: WorkProfile | null;
  reasonCodes?: string[];
  objective?: (string) | undefined;
  acceptance?: unknown[];
  constraints?: unknown[];
  nonGoals?: unknown[];
  action?: HostRecord | null;
  step?: HostRecord | null;
  subject?: HostRecord | null;
  provenance?: HostRecord | null;
  runtimePreflight?: HostRecord | null;
  launcherFailure?: HostRecord | null;
  details?: HostRecord | null;
  cause?: unknown;
  error?: unknown;
  result?: HostRecord | null;
  response?: HostRecord | null;
  payload?: HostRecord | null;
  outcome?: HostRecord | null;
  report?: HostRecord | null;
  reviewerOutcome?: HostRecord | null;
  review?: HostRecord | null;
  reviewReceipt?: (import('../../contracts/generated/kernel.review-receipt.js').KernelReviewReceipt | null) | undefined;
  reviewReceiptId?: unknown;
  reviewer?: HostRecord | null;
  verdict?: unknown;
  reviewVerdict?: unknown;
  findings?: unknown[];
  evidenceRefs?: unknown[];
  risks?: unknown[];
  changedPaths?: string[];
  mutationEvidence?: unknown;
  mutationReceipt?: unknown;
  hasMutations?: unknown;
  mutated?: unknown;
  writeCount?: unknown;
  artifactWrites?: unknown;
  modelInput?: HostRecord | null;
  hostDirective?: HostRecord | null;
  executionCapsule?: HostRecord | null;
  executionContract?: HostRecord | null;
  hostExecutionContract?: HostRecord | null;
  admission?: HostRecord | null;
  attempt?: HostRecord | null;
  attemptId?: string | null;
  bindingId?: (string | null) | undefined;
  actorSessionId?: string | null;
  enforcementStrategy?: unknown;
  executionAssignment?: HostRecord | null;
  modelRouteDecision?: HostRecord | null;
  runId?: string;
  stepId?: string | null;
  capsuleId?: string | null;
  planRevision?: number | null;
  mutationRevision?: number | null;
  currentWorkspaceIdentity?: string | null;
  workspaceIdentity?: string | null;
  workspaceId?: string | null;
  obligationId?: string | null;
  obligations?: unknown[];
  outstandingObligations?: unknown[];
  guidance?: string;
  capsuleDigest?: string | null;
  assignmentId?: string | null;
  requestedTransport?: unknown;
  transport?: unknown;
  executionMode?: unknown;
  delegationRequested?: boolean;
  concurrencyGroup?: unknown;
  skipParallel?: boolean;
  transportRetry?: boolean;
  transportFallbackReason?: unknown;
  requestedModel?: unknown;
  requestedEffort?: unknown;
  resolvedModel?: unknown;
  resolvedEffort?: unknown;
  invocation?: HostRecord | null;
  segments?: Array<HostRecord & { cacheable?: boolean; tokenEstimate?: number }>;
  cacheIdentity?: HostRecord | null;
  cachePolicy?: HostRecord | null;
  modelPolicy?: HostRecord | null;
  execution?: HostRecord | null;
  delegation?: HostRecord | null;
  type?: (string) | undefined;
  mode?: string;
  commandRef?: unknown;
  commandRefs?: string[];
  verification?: unknown;
  evidence?: unknown;
  passed?: unknown[];
  pending?: unknown[];
  failed?: unknown[];
  existing?: HostRecord | null;
  claimed?: boolean;
  expiresAt?: unknown;
  parentAttemptId?: string | null;
  routeDecisionId?: string | null;
  capsuleIdStart?: unknown;
  workspaceIdentityStart?: string | null;
  workspaceRootHash?: string | null;
  baseWorkspaceIdentity?: string | null;
  retryReason?: unknown;
  receiptId?: string;
  reviewedMutationRevision?: (number | null) | undefined;
  blockedReason?: unknown;
  fallbackEligible?: boolean;
}

interface HostExecutionSnapshot {
  runRevision: number;
  mutationRevision: number;
  stepId: string | null;
}

type ControlPlaneLike = Awaited<ReturnType<typeof import('./control-plane-runtime.js').createKernelControlPlane>>;

interface AdapterLike {
  capabilities?: (HostRecord & NonNullable<Parameters<typeof buildPromptEnvelope>[0]>['capabilities'] & import('../../contracts/host-execution-contract.js').HostSemanticCapabilities) | undefined;
  surface?: (string) | undefined;
  nativeDelegationAvailable?: boolean;
  ownerDirectDefault?: boolean;
  supportsOwnerDirectRetry?: boolean;
  dispatch: HostAdapterDispatch;
}

interface RegistryLike {
  profiles?: Record<string, unknown>;
  surface?: string | null;
  resolveExecutionClass?: (executionClass: unknown, overrides?: ModelOverrideMap) => ModelResolution;
  resolve: (modelClass: unknown, overrides?: ModelOverrideMap) => ModelResolution;
}

interface TurnLike extends HostRecord {
  modelInput?: HostRecord;
  hostDirective?: HostRecord;
  executionCapsule?: HostRecord | null;
}

interface ReviewCandidateDefaults {
  controlPlane: ControlPlaneLike;
  adapter: AdapterLike;
  registry?: (RegistryLike | null) | undefined;
  runtimeHome?: (string | null) | undefined;
  env: NodeJS.ProcessEnv;
  overrides: ModelOverrideMap;
  actionContext: HostRecord;
  parentSessionId?: (string | null) | undefined;
  parentSessionConfig?: unknown;
  toolPolicy: HostRecord;
  permissionPolicy: HostRecord;
  economics: HostRecord;
}

interface ReviewCandidate extends ReviewCandidateDefaults {
  adapter: AdapterLike;
  registry: RegistryLike;
}

interface DispatchKernelTurnAttemptInput {
  controlPlane: ControlPlaneLike;
  runId: string;
  adapter: AdapterLike;
  registry?: (RegistryLike | null) | undefined;
  runtimeHome?: (string | null) | undefined;
  env?: NodeJS.ProcessEnv;
  overrides?: ReviewTransportOverrides;
  actionContext?: HostRecord;
  parentSessionId?: (string | null) | undefined;
  parentSessionConfig?: unknown;
  toolPolicy?: HostRecord;
  permissionPolicy?: HostRecord;
  economics?: HostRecord;
  now?: () => string;
  turn?: TurnLike | null;
  attemptOverride?: HostRecord | null;
  suppressOwnerDirect?: boolean;
  suppressParallel?: boolean;
  useHostDirectiveStrategy?: boolean;
}

interface DispatchKernelTurnInput extends Omit<DispatchKernelTurnAttemptInput, 'turn' | 'attemptOverride' | 'suppressOwnerDirect' | 'suppressParallel' | 'useHostDirectiveStrategy'> {
  reviewFallbacks?: unknown[];
  hostAdapters?: unknown[];
  reviewTransports?: unknown[];
}

const asRecord = (value: unknown): HostRecord => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as HostRecord
    : {}
);

const nestedRecord = (record: HostRecord | null | undefined, key: string): HostRecord => asRecord(record?.[key]);
const errorRecord = (value: unknown): HostRecord => asRecord(value);

const REVIEW_ATTEMPT_META = Symbol('reviewAttemptMeta');

// Fallback is deliberately narrower than "the adapter did not complete".
// Only an explicit, pre-spawn provider/transport classification proves that no
// reviewer result was produced and that trying another transport is safe.
const REVIEW_PRESPAWN_TRANSPORT_CODES = new Set([
  'provider-unavailable',
  'transport-unavailable',
  'launcher-unavailable',
  'cli-version-mismatch',
  'pre-spawn-incompatible',
  'isolated-cli-incompatible',
]);

const REVIEW_TRANSPORT_CATEGORIES = new Set([
  'provider/infrastructure',
  'provider/transport',
  'transport',
  'transport/infrastructure',
  'infrastructure',
]);

const normalizeSnapshotStepId = (stepId: unknown): string | null => {
  if (stepId === null || stepId === undefined || stepId === '') return null;
  return String(stepId);
};

const finiteSnapshotRevision = (value: unknown): number | null => {
  const revision = Number(value);
  return Number.isInteger(revision) && revision >= 0 ? revision : null;
};

// A model payload returned by Kernel `next` is reusable only while the
// authoritative run, mutation, and work-unit cursor remain the same. This is
// intentionally a read-only projection: it adds no state, table, or public
// lifecycle surface and fails closed when the Host cannot read all fields.
export const captureHostExecutionSnapshot = ({ controlPlane, runId, requestedStepId = undefined }: { controlPlane: ControlPlaneLike; runId: string; requestedStepId?: unknown } ): Readonly<HostExecutionSnapshot> | null => {
  const snapshot = controlPlane?.getHostExecutionSnapshot?.(runId, { requestedStepId: typeof requestedStepId === 'string' ? requestedStepId : undefined });
  if (!snapshot) return null;
  const runRevision = finiteSnapshotRevision(snapshot.runRevision);
  const mutationRevision = finiteSnapshotRevision(snapshot.mutationRevision);
  const currentStepId = snapshot.stepId;
  if (runRevision === null || mutationRevision === null) return null;
  return Object.freeze({
    runRevision,
    mutationRevision,
    stepId: normalizeSnapshotStepId(currentStepId),
  });
};

export const isHostExecutionSnapshotFresh = ({ controlPlane, runId, snapshot, requestedStepId = undefined }: { controlPlane: ControlPlaneLike; runId: string; snapshot: HostExecutionSnapshot | null; requestedStepId?: unknown }): boolean => {
  if (!snapshot || snapshot.stepId === null) return false;
  const current = captureHostExecutionSnapshot({ controlPlane, runId, requestedStepId });
  return Boolean(
    current
    && current.stepId !== null
    && current.runRevision === snapshot.runRevision
    && current.mutationRevision === snapshot.mutationRevision
    && current.stepId === snapshot.stepId,
  );
};

const REVIEW_PROVIDER_EXECUTION_EVIDENCE_FIELDS = Object.freeze([
  'actorSessionId',
  'sessionId',
  'childSessionId',
  'providerRequestId',
  'requestId',
  'responseId',
  'turnId',
  'terminalEvents',
  'events',
  'observedSessionConfig',
  'observedConfig',
  'observed_session_config',
  'observed_config',
  'inputTokens',
  'cachedInputTokens',
  'cacheReadInputTokens',
  'cacheWriteInputTokens',
  'uncachedInputTokens',
  'outputTokens',
  'reasoningTokens',
  'costMicros',
  'wallClockMs',
  'durationMs',
  'previousResponseId',
  'startedAt',
  'finishedAt',
  'usage',
]);

const hasMeaningfulEvidenceValue = (value: unknown): boolean => {
  if (value === null || value === undefined || value === '') return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.values(value).some(hasMeaningfulEvidenceValue);
  if (typeof value === 'boolean') return value;
  return true;
};

const hasProviderExecutionEvidence = (source: unknown): boolean => {
  const record = asRecord(source);
  if (Object.keys(record).length === 0) return false;
  return REVIEW_PROVIDER_EXECUTION_EVIDENCE_FIELDS.some((field) => hasMeaningfulEvidenceValue(record[field]));
};

const REVIEWER_RESULT_FIELDS = Object.freeze([
  'outcome',
  'report',
  'reviewerOutcome',
  'review',
  'reviewReceipt',
  'reviewReceiptId',
  'verdict',
  'reviewVerdict',
  'findings',
  'evidenceRefs',
  'risks',
]);

const reviewerResultFields = (source: unknown): HostRecord => {
  const record = asRecord(source);
  return Object.fromEntries(REVIEWER_RESULT_FIELDS
    .filter((field) => record[field] !== undefined && record[field] !== null)
    .map((field) => [field, record[field]])) as HostRecord;
};

const hasReviewerSemanticPayload = (source: unknown, seen: Set<object> = new Set()): boolean => {
  if (!source || typeof source !== 'object' || seen.has(source)) return false;
  seen.add(source);
  const record = asRecord(source);
  if (['outcome', 'report', 'reviewerOutcome', 'review', 'reviewReceipt', 'reviewReceiptId']
    .some((field) => record[field] !== null && record[field] !== undefined)) return true;
  if (['verdict', 'reviewVerdict'].some((field) => ['pass', 'fail', 'blocked'].includes(String(record[field] || '').toLowerCase()))) return true;
  if (['findings', 'evidenceRefs', 'risks'].some((field) => Array.isArray(record[field]))) return true;
  return ['details', 'cause', 'error', 'launcherFailure', 'runtimePreflight', 'result', 'response', 'payload']
    .some((field) => hasReviewerSemanticPayload(record[field], seen));
};

const TRANSPORT_MUTATION_EVIDENCE_FIELDS = Object.freeze([
  'mutationEvidence',
  'mutationReceipt',
  'hasMutations',
  'mutated',
  'changedPaths',
  'writeCount',
  'artifactWrites',
]);

const hasMutationEvidence = (source: unknown): boolean => {
  const record = asRecord(source);
  if (Object.keys(record).length === 0) return false;
  return TRANSPORT_MUTATION_EVIDENCE_FIELDS.some((field) => hasMeaningfulEvidenceValue(record[field]));
};

const hasSemanticTransportOutcome = (source: unknown): boolean => {
  const record = asRecord(source);
  if (Object.keys(record).length === 0) return false;
  if (['outcome', 'report', 'reviewerOutcome', 'review', 'reviewReceipt', 'reviewReceiptId']
    .some((field) => record[field] !== null && record[field] !== undefined)) return true;
  return ['verdict', 'reviewVerdict'].some((field) => ['pass', 'fail', 'blocked'].includes(String(record[field] || '').toLowerCase()))
    || hasReviewerSemanticPayload(source);
};

const transportFailureSources = ({
  dispatch = {},
  dispatchError = null,
}: {
  dispatch?: HostRecord;
  dispatchError?: HostRecord | null;
} = {}): HostRecord[] => [
  dispatch,
  asRecord(dispatch.runtimePreflight),
  asRecord(dispatch.launcherFailure),
  dispatchError,
  asRecord(dispatchError?.details),
].filter((source): source is HostRecord => Boolean(source && typeof source === 'object'));

const isReadOnlyExecution = (permissions: unknown): boolean => {
  const record = asRecord(permissions);
  return permissions === 'read_only'
    || permissions === 'read-only'
    || record.filesystem === 'read_only'
    || record.filesystem === 'read-only';
};

// Transport policy belongs to this Host boundary. Adapters return facts from
// exactly one requested transport; this classifier decides whether a second,
// equivalent transport is safe before any receipt or step failure is closed.
export const classifyTransportFailure = ({
  dispatch = {},
  dispatchError = null,
  decision = {},
  executionContract = {},
  adapter = null,
  requestedTransport = null,
  retryAttempted = false,
}: {
  dispatch?: HostRecord;
  dispatchError?: HostRecord | null;
  decision?: HostRecord;
  executionContract?: HostRecord;
  adapter?: AdapterLike | null;
  requestedTransport?: unknown;
  retryAttempted?: boolean;
} = {}) => {
  const sources = transportFailureSources({ dispatch, dispatchError });
  const preSpawn = sources.some((source) => String(source.failureStage || '').trim().toLowerCase() === 'pre-spawn');
  const providerExecutionObserved = sources.some(hasProviderExecutionEvidence);
  const semanticOutcomeObserved = sources.some(hasSemanticTransportOutcome);
  const mutationEvidenceObserved = sources.some(hasMutationEvidence);
  const failed = ['failed', 'unsupported'].includes(String(dispatch.status || '').toLowerCase())
    && dispatch.resultStatus !== 'completed';
  const independentReviewRequired = decision.role === 'reviewer'
    || decision.independentContextRequired === true
    || executionContract.independentReviewRequired === true
    || executionContract.independentReview === true
    || executionContract.reviewMode === 'independent';
  const contractPreserved = adapter?.supportsOwnerDirectRetry === true
    && !independentReviewRequired
    && !isReadOnlyExecution(executionContract.permissions || decision.permissions);
  const safeToRetryTransport = requestedTransport === 'native-subagent'
    && retryAttempted !== true
    && failed
    && preSpawn
    && !providerExecutionObserved
    && !semanticOutcomeObserved
    && !mutationEvidenceObserved
    && contractPreserved;
  return {
    preSpawn,
    providerExecutionObserved,
    semanticOutcomeObserved,
    mutationEvidenceObserved,
    failed,
    contractPreserved,
    safeToRetryTransport,
    reason: safeToRetryTransport
      ? 'pre-spawn-native-transport-failure'
      : !preSpawn
        ? 'transport-started-or-stage-unknown'
        : providerExecutionObserved
          ? 'provider-execution-observed'
          : semanticOutcomeObserved
            ? 'semantic-outcome-observed'
            : mutationEvidenceObserved
              ? 'mutation-evidence-observed'
              : !contractPreserved
                ? 'equivalent-owner-transport-unavailable'
                : !failed
                  ? 'dispatch-not-failed'
                  : retryAttempted
                    ? 'transport-retry-already-attempted'
                    : 'transport-not-requested-as-native',
  };
};

const withoutReviewAttemptMeta = (response: unknown): HostRecord | null | undefined => {
  if (!response || typeof response !== 'object') return response == null ? response : asRecord(response);
  const publicResponse: HostRecord = { ...asRecord(response) };
  delete (publicResponse as HostRecord & { [REVIEW_ATTEMPT_META]?: unknown })[REVIEW_ATTEMPT_META];
  return publicResponse;
};

const withReviewAttemptMeta = (response: HostRecord, meta: HostRecord): HostRecord => ({ ...response, [REVIEW_ATTEMPT_META]: meta });

const isReviewTransportFailure = ({ dispatch = {}, dispatchError = null }: { dispatch?: HostRecord; dispatchError?: HostRecord | null } = {}): boolean => {
  // An outcome is semantic evidence, even when the surrounding provider
  // status is imperfect.  It must never trigger reviewer shopping.
  if (dispatch?.outcome !== null && dispatch?.outcome !== undefined) return false;
  // A pre-spawn marker is not enough once the Host also reports evidence that
  // a provider process or session existed.  Such a contradictory result is a
  // terminal integrity/telemetry failure, not a safe transport retry.
  if ([dispatch, dispatch?.runtimePreflight, dispatch?.launcherFailure, dispatchError, dispatchError?.details]
    .some(hasProviderExecutionEvidence)) return false;
  // A thrown transport error may carry a reviewer outcome/report in an Error,
  // its nested details, or its launcher failure payload. That is semantic
  // evidence even when the adapter could not return a normal dispatch object;
  // preserve the result and fail closed instead of shopping for another
  // reviewer.
  if ([dispatch, dispatch?.runtimePreflight, dispatch?.launcherFailure, dispatchError, dispatchError?.details]
    .some((source) => hasReviewerSemanticPayload(source))) return false;
  if (dispatch?.launcherFailure) return false;
  const dispatchStage = String(dispatch?.failureStage || '').trim().toLowerCase();
  if (dispatchStage && dispatchStage !== 'pre-spawn') return false;
  if (!['failed', 'unsupported'].includes(String(dispatch?.status || '').toLowerCase())) return false;
  if (dispatch.resultStatus && dispatch.resultStatus !== 'failed') return false;

  const sources = [
    dispatch?.runtimePreflight,
    dispatchError?.details,
    dispatch,
  ].map(asRecord).filter((source) => Object.keys(source).length > 0);
  return sources.some((source) => {
    const code = String(source.errorCode || dispatchError?.code || '').trim();
    const failureStage = String(source.failureStage || '').trim().toLowerCase();
    const failureCategory = String(source.failureCategory || '').trim().toLowerCase();
    return source.status === 'failed'
      && failureStage === 'pre-spawn'
      && REVIEW_PRESPAWN_TRANSPORT_CODES.has(code)
      && REVIEW_TRANSPORT_CATEGORIES.has(failureCategory);
  });
};

const isReviewActionContext = (actionContext: HostRecord = {}): boolean => Boolean(
  String(actionContext.actionKind || '').startsWith('review')
  || actionContext.independentReviewRequired === true,
);

const hasOwn = (value: unknown, key: PropertyKey): boolean => Object.prototype.hasOwnProperty.call(value || {}, key);

const normalizeReviewCandidate = (candidate: unknown, defaults: ReviewCandidateDefaults): ReviewCandidate => {
  const candidateRecord = asRecord(candidate);
  const source = candidateRecord.adapter ? candidateRecord : { adapter: candidate };
  const adapterRecord = asRecord(source.adapter);
  if (typeof adapterRecord.dispatch !== 'function') throw new TypeError('Host review adapter dispatch required');
  const adapter = { ...adapterRecord, dispatch: adapterRecord.dispatch as AdapterLike['dispatch'], capabilities: adapterRecord.capabilities || undefined, surface: adapterRecord.surface || undefined };
  const surface = adapter?.capabilities?.surface || adapter?.surface || null;
  const primarySurface = defaults.adapter?.capabilities?.surface || defaults.adapter?.surface || null;
  const primaryRegistry: RegistryLike | null = defaults.registry || (primarySurface
    ? createModelRegistry({
      surface: primarySurface,
      runtimeHome: defaults.runtimeHome,
      env: defaults.env,
      overrides: defaults.overrides,
    })
    : null);
  // A same-surface fallback is only another transport for the already
  // selected provider route; it cannot bring a second model/effort registry
  // that silently changes that route. A different surface needs its existing
  // provider registry to map the same Kernel model class to that provider's
  // concrete model. Caller overrides are still inherited below, never taken
  // from the fallback entry.
  const registry: RegistryLike = (surface && surface === primarySurface
    ? primaryRegistry
    : hasOwn(source, 'registry') && source.registry
      ? source.registry
      : createModelRegistry({
        surface,
        runtimeHome: defaults.runtimeHome,
        env: defaults.env,
        overrides: defaults.overrides,
      })) as RegistryLike;
  return {
    controlPlane: defaults.controlPlane,
    adapter,
    // A fallback may choose its own provider registry, but every other
    // authority input is inherited from the original Kernel turn below.
    registry,
    runtimeHome: defaults.runtimeHome,
    env: defaults.env,
    overrides: defaults.overrides,
    actionContext: defaults.actionContext,
    parentSessionId: defaults.parentSessionId,
    parentSessionConfig: defaults.parentSessionConfig,
    toolPolicy: defaults.toolPolicy,
    permissionPolicy: defaults.permissionPolicy,
    economics: defaults.economics,
  };
};

const reviewCandidateUnavailableReason = (candidate: ReviewCandidate): string | null => {
  const adapter = candidate?.adapter;
  if (!adapter || typeof adapter.dispatch !== 'function') return 'adapter-unavailable';
  if (adapter.nativeDelegationAvailable !== true) return 'reviewer-launcher-unavailable';
  if (adapter.capabilities?.supportsIndependentContext !== true) return 'independent-context-unavailable';
  if (adapter.capabilities?.supportsReadOnlyReview !== true) return 'read-only-review-unavailable';
  const surface = adapter.capabilities?.surface || adapter.surface || null;
  if (!surface || candidate.registry?.surface !== surface || typeof candidate.registry?.resolve !== 'function') return 'reviewer-registry-unavailable';
  return null;
};

// A repeated Host call can replay the same stale `review` action after the
// Kernel has already ingested its receipt. Reusing the current pass is safe
// only when the reviewed obligation, workspace, mutation revision, and hard
// evidence set are all identical. A different obligation remains a distinct
// review point and is allowed to run independently.
const currentReviewReceiptFor = ({ controlPlane, runId, obligationId }: { controlPlane: ControlPlaneLike; runId: string; obligationId: unknown }): import('../../contracts/generated/kernel.review-receipt.js').KernelReviewReceipt | null => (
  typeof controlPlane?.findReusableReviewReceipt === 'function'
    ? controlPlane.findReusableReviewReceipt(runId, { obligationId: typeof obligationId === 'string' ? obligationId : null })
    : null
);

const buildDeduplicatedReviewResponse = ({ runId, turn = null, receipt }: { runId: string; turn?: TurnLike | null; receipt?: import('../../contracts/generated/kernel.review-receipt.js').KernelReviewReceipt | null }): HostRecord => ({
  schemaVersion: 1,
  runId,
  dispatched: false,
  deduplicated: true,
  reason: 'review-already-recorded',
  modelInput: turn?.modelInput || null,
  hostDirective: turn?.hostDirective || null,
  executionCapsule: turn?.executionCapsule || turn?.hostDirective?.executionCapsule || null,
  dispatch: {
    dispatchMechanism: 'deduplicated-review-receipt',
    actorRole: 'reviewer',
    actorSessionId: receipt?.reviewer?.actorSessionId || null,
  },
  review: {
    required: true,
    independent: true,
    status: 'receipt-recorded',
    review: {
      verdict: receipt?.verdict || 'pass',
      findings: receipt?.findings || [],
      risks: [],
      evidenceRefs: [],
    },
    reviewReceipt: receipt,
  },
  reviewReceipt: receipt,
  reviewReceiptId: receipt?.receiptId || null,
  receipt: null,
  report: null,
});

// A decision carries no risk-shape data (security/migration/...) to the Host
// today, only actionKind/riskTier/reasonCodes, so the recommendation below is
// computed from those alone; `shapes` stays at each policy function's
// default. `repeatedFailure` mirrors the predicate summarizeModelRouting()
// already uses to count an escalated turn, plus 'ESCALATION_LOCKED' — the
// reason resolveModelRoute() emits to KEEP an already-escalated obligation on
// frontier_reasoning for its subsequent attempts. Without it, applying the
// model-policy recommendation on a locked turn would fall through to the
// default Codex Luna/Max (or Claude's default effort) and silently undo
// the very escalation the lock exists to hold.
const isRepeatedFailure = (decision: HostRecord): boolean =>
  decision.workProfile?.repeatedFailure === true
  || (decision.reasonCodes || []).some((code) => String(code).endsWith('_ESCALATION') || String(code).endsWith('_REPLAN') || code === 'PROTECTED_OBLIGATION_FAILURE' || code === 'ESCALATION_LOCKED');

// Maps each policy module's internal reason vocabulary onto the receipt's
// closed MODEL_ESCALATION_REASONS enum; a reason with no honest mapping
// (the default-path reasons) reports no escalation rather than 'unknown'.
const ESCALATION_REASON_MAP = Object.freeze({
  'protected-review': 'risk-tier',
  'engineering-review': 'review-policy',
  'planning-action': 'complexity',
  'complex-implementation': 'complexity',
  'routine-batch': 'complexity',
  'repeated-failure-escalation': 'repeated-failure',
  'repeated-failure': 'repeated-failure',
  'user-requested-model': 'user-request',
  'user-requested-reasoning': 'user-request',
  'user-requested': 'user-request',
});

const firstMappedEscalationReason = (reasons: readonly unknown[] = []): string | null => {
  for (const reason of reasons) {
    const mapped = (ESCALATION_REASON_MAP as Readonly<Record<string, string>>)[String(reason)];
    if (mapped) return mapped;
  }
  return null;
};

// Resolves the provider model-policy recommendation for this turn.
// Returned unconditionally (not gated on modelPolicyMode) so shadow mode can
// still measure what *would* have been chosen; only the caller decides
// whether to apply it to the resolution actually used for admission and
// dispatch.
export const resolveTurnModelPolicy = ({ decision = {}, hostCapabilities = {} }: { decision?: HostRecord; hostCapabilities?: HostRecord } = {}) => {
  const repeatedFailure = isRepeatedFailure(decision);
  if (hostCapabilities.surface === 'codex') {
    const policy = resolveCodexModelPolicy({
      executionClass: decision.executionClass ?? decision.workProfile?.executionClass ?? null,
      actionKind: String(decision.actionKind || 'implement'),
      complexity: decision.workProfile?.complexity || 'standard',
    });
    return {
      executionClass: policy.executionClass,
      model: policy.model,
      effort: policy.effort,
      reasons: policy.reasons,
      policyRevision: policy.policyRevision,
    };
  }
  if (hostCapabilities.surface === 'claude') {
    const policy = resolveClaudeEffort({ actionKind: String(decision.actionKind || 'implement'), riskTier: decision.riskTier || undefined, triggers: repeatedFailure ? ['repeated-failure'] : [] });
    return {
      model: null,
      effort: policy.effort,
      reasons: policy.reasons,
      policyRevision: policy.policyRevision,
    };
  }
  return null;
};

// Only the execution contract crosses to the worker (§4.4) — never the
// planner's reasoning, the conversation, or unrelated repository context.
export const verificationProjectionToEvidence = (projection: unknown): HostRecord[] => {
  if (Array.isArray(projection)) return projection.map(asRecord);
  const record = asRecord(projection);
  if (Object.keys(record).length === 0) return [];
  return [
    ...(Array.isArray(record.passed) ? record.passed.map((obligationId: unknown) => ({ obligationId: String(obligationId), status: 'passed' })) : []),
    ...(Array.isArray(record.pending) ? record.pending.map((obligationId: unknown) => ({ obligationId: String(obligationId), status: 'pending' })) : []),
    ...(Array.isArray(record.failed) ? record.failed.map((failureValue: unknown) => {
      const failure = asRecord(failureValue);
      return {
        ...failure,
        obligationId: String(failure.obligationId || failure.commandRef || ''),
        status: 'failed',
      };
    }) : []),
  ].filter((entry) => Boolean(entry.obligationId));
};

export const buildExecutionContract = (modelInput: HostRecord = {}, decision: HostRecord = {}): HostRecord => {
  const action = asRecord(modelInput.action);
  const verificationEvidence = verificationProjectionToEvidence(modelInput.verification || modelInput.evidence);
  const base: HostRecord = {
    objective: modelInput.objective || '',
    acceptance: Array.isArray(modelInput.acceptance) ? modelInput.acceptance : [],
    constraints: Array.isArray(modelInput.constraints) ? modelInput.constraints : [],
    nonGoals: Array.isArray(modelInput.nonGoals) ? modelInput.nonGoals : [],
    role: decision.role,
    permissions: decision.permissions,
    workProfile: decision.workProfile || null,
    action: { type: action.type, guidance: action.guidance || '' },
  };
  if (decision.role === 'reviewer') {
    const acceptanceMatch = String(decision.obligationId || '').match(/^judgment-ac-(\d+)$/i);
    const acceptance = Array.isArray(base.acceptance) ? base.acceptance : [];
    const scopedAcceptance = acceptanceMatch
      ? acceptance.filter((entry) => String(asRecord(entry).id || '').toUpperCase() === `AC-${matchCapture(acceptanceMatch, 1)}`)
      : (decision.obligationId === 'security-review' ? [] : acceptance);
    return {
      objective: base.objective,
      acceptance: scopedAcceptance,
      role: base.role,
      permissions: base.permissions,
      changedPaths: Array.isArray(modelInput.changedPaths) ? modelInput.changedPaths : [],
      // Prior protected judgments are not evidence for a sibling judgment.
      // Passing them here would bypass the review-capsule isolation and can
      // create circular failures between otherwise independent obligations.
      verificationEvidence: verificationEvidence
        .filter((entry) => entry.evidenceClass !== 'judgment'),
      riskTier: decision.riskTier,
    };
  }
  return {
    ...base,
    outstandingObligations: Array.isArray(action.outstandingObligations) ? action.outstandingObligations : [],
    requiredEvidence: Array.isArray(action.obligations) ? action.obligations : [],
    currentEvidence: verificationEvidence,
  };
};

const admissionCapsule = (capsule: HostRecord | null) => capsule ? { ...capsule, permissions: typeof capsule.permissions === 'object' ? capsule.permissions : null } : null;

const buildReviewerOutcomeForIngestion = ({ outcome, executionCapsule }: { outcome: unknown; executionCapsule: HostRecord | null }): HostRecord | null => {
  const outcomeRecord = asRecord(outcome);
  if (Object.keys(outcomeRecord).length === 0) return null;
  const subject = nestedRecord(executionCapsule, 'subject');
  const reviewedMutationRevision = subject.mutationRevision;
  if (!Number.isInteger(reviewedMutationRevision)) return null;
  // The mutation revision is Host/Kernel provenance, not model output. The
  // reviewer must never be able to claim that it inspected a different state
  // by echoing a caller-supplied revision.
  return { ...outcomeRecord, reviewedMutationRevision };
};

// Compiles the Host prompt envelope for one turn from the Kernel's `next`
// payload. Project-stable knowledge is left empty here: `next`
// exposes it today only as `knowledge`, a single pre-rendered text block
// that mixes project- and task-scoped facts, so it cannot yet be split into
// the project-stable / volatile layers the envelope expects. Splitting that
// requires a Kernel-side change to `buildStageContext`'s return shape and is
// tracked separately; this wiring does not fabricate a split it cannot prove.
// Likewise no tool schema reaches this generic dispatcher yet, so the tool
// manifest is empty rather than guessed.
export const buildTurnPromptEnvelope = ({
  modelInput = {},
  decision = {},
  resolution,
  hostCapabilities = {},
  modelPolicyRevision = null,
  env = process.env,
}: {
  modelInput?: HostRecord;
  decision?: HostRecord;
  resolution: ModelResolution;
  hostCapabilities?: HostRecord;
  modelPolicyRevision?: unknown;
  env?: NodeJS.ProcessEnv;
}) => {
  const action = asRecord(modelInput.action);
  // The current work unit lives at action.step (run-loop.js's buildNextPayload
  // only sets it there for implement/fix actions), not at a top-level `step` —
  // reading the wrong path silently produced an empty step, no allowed/
  // forbidden paths, and a null control stepId on every real turn.
  const step = asRecord(action.step);
  const contextSegments = buildKernelContextSegments({
    runStable: {
      objective: modelInput.objective,
      acceptance: modelInput.acceptance || [],
      constraints: modelInput.constraints || [],
      nonGoals: modelInput.nonGoals || [],
    },
    volatile: {
      action: { type: action.type, guidance: action.guidance },
      step: { stepId: step.stepId, objective: step.objective },
      allowedPaths: step.allowedPaths || [],
      forbiddenPaths: step.forbiddenPaths || [],
      evidence: verificationProjectionToEvidence(modelInput.verification || modelInput.evidence),
      // action.obligations is the *outstanding* subset recomputed every turn
      // (run-loop.js's buildNextPayload derives it from what has not yet
      // passed) — it shrinks as obligations pass and is absent entirely on a
      // fix action. Classifying it as run-stable would move runStableDigest,
      // and reset cache/session affinity, on every obligation that clears
      // even though the task contract itself never changed. No stable,
      // contract-level obligation set reaches the Host at this layer today
      // (a known gap, not silently worked around), so this stays volatile.
      outstandingObligations: action.obligations || [],
    },
  }).segments;
  return buildPromptEnvelope({
    provider: hostCapabilities.surface || undefined,
    surface: hostCapabilities.surface,
    role: decision.role || undefined,
    action: decision.actionKind || undefined,
    riskTier: decision.riskTier,
    toolManifest: buildToolManifest([]),
    contextSegments,
    modelPolicy: {
      executionClass: decision.executionClass ?? null,
      modelClass: decision.modelClass,
      resolvedModel: resolution.model,
      resolvedEffort: resolution.effort,
      policyRevision: modelPolicyRevision,
    },
    capabilities: hostCapabilities,
    control: { runId: decision.runId, stepId: step.stepId, capsuleId: action.capsuleId },
    env,
  });
};

// Parallel workers still use the normal Host routing boundary. The dispatcher
// obtains the Kernel directive for each Step, then calls this
// helper before it reaches an adapter so model resolution, route admission,
// dispatch-time revalidation, and the prompt envelope cannot be skipped by the
// parallel path.
export const prepareParallelWorkerDispatch = async ({
  controlPlane,
  runId,
  adapter,
  hosted,
  step,
  registry = null,
  runtimeHome = null,
  env = process.env,
  overrides = {},
  toolPolicy = {},
  permissionPolicy = {},
  economics = {},
}: {
  controlPlane: ControlPlaneLike;
  runId: string;
  adapter: AdapterLike;
  hosted: { modelInput?: unknown; hostDirective?: unknown; executionCapsule?: unknown };
  step: NonNullable<NonNullable<Parameters<typeof admitRoute>[0]>['step']>;
  registry?: (RegistryLike | null) | undefined;
  runtimeHome?: (string | null) | undefined;
  env?: NodeJS.ProcessEnv;
  overrides?: ModelOverrideMap;
  toolPolicy?: HostRecord;
  permissionPolicy?: HostRecord;
  economics?: HostRecord;
}): Promise<HostRecord> => {
  const hostCapabilities = adapter.capabilities || {};
  const modelInput = asRecord(hosted.modelInput);
  const hostDirective = asRecord(hosted.hostDirective);
  const decision = asRecord(hostDirective.modelRouteDecision);
  if (!decision) return { status: 'failed', failureCode: 'worker-route-missing' };
  const hostBoundary = normalizeHostBoundaryRequest({ modelInput, hostDirective });
  if (decision.executionClass === null || decision.modelClass === 'kernel') return { status: 'failed', failureCode: 'kernel-owned-worker-action' };

  const modelRegistry: RegistryLike = registry || createModelRegistry({ surface: hostCapabilities.surface || null, runtimeHome, env, overrides }) as RegistryLike;
  let resolution = typeof modelRegistry.resolveExecutionClass === 'function'
    ? modelRegistry.resolveExecutionClass(decision.executionClass, overrides)
    : modelRegistry.resolve(decision.modelClass, overrides);
  const modes = resolveOptimizationModes(env);
  const modelPolicyMode = hostCapabilities.surface === 'codex' ? modes.codexModelPolicyMode : modes.modelPolicyMode;
  const modelPolicyRecommendation = resolveTurnModelPolicy({ decision, hostCapabilities });
  if (modelPolicyMode === 'on' && modelPolicyRecommendation && resolution.source !== 'invocation-override') {
    const appliedModel = modelPolicyRecommendation.model || resolution.model;
    resolution = {
      ...resolution,
      model: appliedModel,
      effort: modelPolicyRecommendation.effort || resolution.effort,
      ...(appliedModel ? { source: 'model-policy', enforcementIntent: 'enforced' } : {}),
    };
  }

  const capsuleInput = hosted.executionCapsule || hostDirective.executionCapsule || null;
  const executionCapsule = capsuleInput ? asRecord(capsuleInput) : null;
  const attemptId = hostDirective.attemptId || null;
  const policies = currentHostPolicies({ registry: modelRegistry, capabilities: hostCapabilities, toolPolicy, permissionPolicy });
  const admission = asRecord(await controlPlane.recordRouteAdmission(runId, admitRoute({
    run: await controlPlane.getRun(runId) || undefined,
    step,
    attemptId,
    decision,
    resolution,
    capabilities: hostCapabilities,
    capsule: admissionCapsule(executionCapsule),
    policies,
    economics,
  })));
  if (admission.decision === 'blocked' || admission.decision === 'redecision_required') {
    return { status: 'failed', failureCode: admission.rejectionCode || admission.decision, modelInput, hostDirective, decision, resolution, executionCapsule, admission };
  }

  const revalidated = revalidateBeforeDispatch({
    admission,
    registry: modelRegistry,
    capabilities: hostCapabilities,
    toolPolicy,
    permissionPolicy,
  });
  if (!revalidated.valid) {
    const drifted = asRecord(await controlPlane.recordRouteAdmission(runId, admitRoute({
      run: await controlPlane.getRun(runId) || undefined,
      step,
      attemptId,
      decision,
      resolution,
      capabilities: hostCapabilities,
      capsule: admissionCapsule(executionCapsule),
      policies: currentHostPolicies({ registry: modelRegistry, capabilities: hostCapabilities, toolPolicy, permissionPolicy }),
      economics,
    })));
    return { status: 'failed', failureCode: String(revalidated.rejectionCode || 'route-admission-drift'), modelInput, hostDirective, decision, resolution: asRecord(resolution as unknown), executionCapsule, admission: drifted, drift: revalidated.drift };
  }

  return {
    status: 'ready',
    runId,
    modelInput,
    hostDirective,
    decision,
    resolution,
    executionCapsule,
    modelVisibleCapsule: executionCapsule ? buildModelCapsuleView(executionCapsule, { role: decision.role }) : null,
    modelVisiblePrompt: buildModelVisiblePromptView({ modelInput, capsule: executionCapsule }),
    executionContract: buildExecutionContract(modelInput, decision),
    hostExecutionContract: asRecord(hostBoundary.contract),
    admission,
    strategy: hostDirective.enforcementStrategy,
    envelope: buildTurnPromptEnvelope({
      modelInput,
      decision,
      resolution,
      hostCapabilities,
      modelPolicyRevision: modelPolicyRecommendation?.policyRevision ?? null,
      env,
    }),
  };
};

const dispatchKernelTurnAttempt = async ({
  controlPlane,
  runId,
  adapter,
  registry,
  runtimeHome,
  env = process.env,
  overrides = {},
  actionContext = {},
  parentSessionId = null,
  parentSessionConfig = null,
  toolPolicy = {},
  permissionPolicy = {},
  economics = {},
  now = () => new Date().toISOString(),
  turn: preloadedTurn = null,
  attemptOverride = null,
  suppressOwnerDirect = false,
  suppressParallel = false,
  useHostDirectiveStrategy = true,
}: DispatchKernelTurnAttemptInput): Promise<HostRecord> => {
  if (!adapter) throw new Error('dispatchKernelTurn requires a Host adapter');
  const hostCapabilities = adapter.capabilities || {};
  const adeOrchestratorOnly = ['ade', 'ade_cli'].includes(String(hostCapabilities.surface || '').toLowerCase());
  if (adeOrchestratorOnly) {
    actionContext = {
      ...actionContext,
      executionMode: 'native-subagent',
      delegationRequested: true,
      skipParallel: true,
    };
    suppressParallel = true;
  }
  const hasSubagentCapability = adapter.nativeDelegationAvailable === true
    || hostCapabilities.nativeSubagent === true
    || hostCapabilities.supportsSubagentModel === true;
  const nativeAvailable = Boolean(adapter.nativeDelegationAvailable && hasSubagentCapability);

  const isExplicitOwnerDirect = actionContext.executionMode === 'owner-direct' || actionContext.ownerDirect === true;

  const nativeDelegationRequested = isNativeDelegationRequested({
    executionMode: actionContext.executionMode,
    delegationRequested: actionContext.delegationRequested,
    actionContext,
    capabilities: hostCapabilities,
    hasNativeLauncher: adapter.nativeDelegationAvailable === true,
  });

  // Codex Desktop is already the native owner session. When it has no
  // optional native worker launcher, return the Kernel work unit to that
  // owner instead of entering the child-worker dispatcher and manufacturing a
  // missing-worker failure. `next()` is deliberately used here rather than
  // `hostNext()`: the latter acquires a worker mutation lock and opens a
  // delegated attempt that an owner-direct turn cannot close.
  const ownerDirectRequested = ['codex', 'claude'].includes(String(hostCapabilities.surface || ''))
    && adapter.ownerDirectDefault === true
    && suppressOwnerDirect !== true
    && !['prove', 'close'].includes(String(actionContext.actionKind || ''))
    && (isExplicitOwnerDirect || !nativeAvailable || !nativeDelegationRequested);
  let evaluatedModelInput: HostRecord | null = null;
  let evaluatedModelInputSnapshot: HostExecutionSnapshot | null = null;
  if (ownerDirectRequested) {
    const snapshotBeforeNext = captureHostExecutionSnapshot({
      controlPlane,
      runId,
      requestedStepId: actionContext.stepId,
    });
    const modelInput = asRecord(await controlPlane.next(runId, { stepId: actionContext.stepId || null }));
    evaluatedModelInput = modelInput;
    if (snapshotBeforeNext) {
      evaluatedModelInputSnapshot = {
        ...snapshotBeforeNext,
        stepId: normalizeSnapshotStepId(modelInput?.action?.step?.stepId) || snapshotBeforeNext.stepId,
      };
    }
    if (modelInput.status === 'not_found') return modelInput;
    const independentReviewRequired = modelInput.action?.type === 'review'
      && modelInput.action?.independentReviewRequired === true;
    if (independentReviewRequired) {
      if (!hasSubagentCapability) {
        return {
          schemaVersion: 1,
          runId,
          dispatched: false,
          executionMode: 'independent-review',
          reason: 'independent-review-required',
          review: {
            required: true,
            status: 'pending',
            independent: true,
            crossSurface: Boolean(adapter?.capabilities?.supportsCrossSurfaceReview),
          },
          blocker: null,
          modelInput,
          hostDirective: null,
          receipt: null,
          report: null,
        };
      }
      actionContext = {
        ...actionContext,
        executionMode: 'native-subagent',
        delegationRequested: true,
      };
    } else {
      const isMutation = isMutationBearingAction(actionContext.actionKind, modelInput.action?.type);
      const isBounded = isWorkUnitBounded({ modelInput, stepId: modelInput.action?.step?.stepId, allowedPaths: modelInput.action?.step?.allowedPaths });
      if (!isExplicitOwnerDirect && isMutation && isBounded && nativeAvailable) {
        actionContext = {
          ...actionContext,
          executionMode: 'native-subagent',
          delegationRequested: true,
        };
      } else {
        return {
          schemaVersion: 1,
          runId,
          dispatched: false,
          executionMode: 'owner-direct',
          reason: 'owner-session-execution-required',
          ownerExecution: {
            mode: 'owner-direct',
            delegation: { mode: 'optional', available: false },
            report: 'kernel report',
          },
          modelInput,
          hostDirective: null,
          receipt: null,
          report: null,
        };
      }
    }
  }
  const parallelMode = String(env.MOON_RELAY_KERNEL_PARALLEL_MODE || 'shadow').toLowerCase();
  if (parallelMode === 'on' && suppressParallel !== true && actionContext.skipParallel !== true ) {
    return asRecord(await dispatchKernelRun({
      controlPlane,
      runId,
      adapter,
      projectRoot: controlPlane.projectRoot,
      runtimeHome,
      parentSessionId,
      parentSessionConfig,
      env,
      actionContext,
      prepareDispatch: ({ hosted, step }: UnknownRecord) => prepareParallelWorkerDispatch({
        controlPlane,
        runId,
        adapter,
        hosted: asRecord(hosted) as TurnLike,
        step: asRecord(step),
        registry,
        runtimeHome,
        env,
        overrides,
        toolPolicy,
        permissionPolicy,
        economics,
      }),
      sequentialDispatcher: () => dispatchKernelTurn({
        controlPlane,
        runId,
        adapter,
        registry,
        runtimeHome,
        env,
        overrides,
        actionContext: { ...actionContext, skipParallel: true },
        parentSessionId,
        parentSessionConfig,
        toolPolicy,
        permissionPolicy,
        economics,
        now,
      }),
    }));
  }
  const reusableModelInput = evaluatedModelInput
    && isHostExecutionSnapshotFresh({
      controlPlane,
      runId,
      snapshot: evaluatedModelInputSnapshot,
      requestedStepId: actionContext.stepId || undefined,
    })
    ? evaluatedModelInput
    : null;
  const turn = preloadedTurn || asRecord(await prepareHostTurn({
    controlPlane,
    runId,
    hostCapabilities,
    actionContext,
    modelInput: reusableModelInput,
  })) as TurnLike;
  if (turn.status === 'not_found') return turn;

  const modelInput = asRecord(turn.modelInput);
  const hostDirective = asRecord(turn.hostDirective);
  if (!hostDirective.modelRouteDecision) return turn;
  const decision = asRecord(hostDirective.modelRouteDecision);
  const hostBoundary = normalizeHostBoundaryRequest({ modelInput, hostDirective });
  const boundAttempt = attemptOverride || hostDirective.attempt || null;
  const attemptId = boundAttempt?.attemptId || hostDirective.attemptId || null;
  const enforcementStrategy = useHostDirectiveStrategy
    ? hostDirective.enforcementStrategy
    : resolveEnforcementStrategy(hostCapabilities, decision);
  const candidateHostDirective: HostRecord = {
    ...hostDirective,
    hostCapabilities,
    enforcementStrategy,
    attemptId,
    attempt: boundAttempt,
  };
  // prove/close belong to the trusted proof runtime; dispatching a model for
  // them would hand completion authority to a provider.
  if (decision.executionClass === null || decision.modelClass === 'kernel') {
    return { schemaVersion: 1, runId, dispatched: false, reason: 'kernel-owned-action', modelInput, hostDirective, receipt: null };
  }

  const semanticAdmission = admitHostExecutionContract(hostDirective.executionContract as Parameters<typeof admitHostExecutionContract>[0], (adapter.capabilities || {}));
  if (semanticAdmission.decision !== 'admitted') {
    return {
      schemaVersion: 1,
      runId,
      dispatched: false,
      status: 'blocked',
      reason: semanticAdmission.rejectionCode || 'host_capability_unavailable',
      missingCapabilities: semanticAdmission.missingCapabilities,
      modelInput,
      hostDirective: candidateHostDirective,
      executionCapsule: turn.executionCapsule || hostDirective.executionCapsule || null,
      receipt: null,
    };
  }

  const modelRegistry: RegistryLike = registry || createModelRegistry({ surface: hostCapabilities.surface || null, runtimeHome, env, overrides }) as RegistryLike;
  let resolution = typeof modelRegistry.resolveExecutionClass === 'function'
    ? modelRegistry.resolveExecutionClass(decision.executionClass, overrides)
    : modelRegistry.resolve(decision.modelClass, overrides);
  // Wave 5/6: the model-policy recommendation is computed unconditionally so
  // its reasons can be recorded on the receipt even in shadow mode, but it is
  // only applied to the resolution admission and dispatch actually use when
  // Codex uses its provider-specific switch; Claude continues to use the
  // generic switch. Shadow must never change what actually runs.
  const modes = resolveOptimizationModes(env);
  const modelPolicyMode = hostCapabilities.surface === 'codex' ? modes.codexModelPolicyMode : modes.modelPolicyMode;
  const modelPolicyRecommendation = resolveTurnModelPolicy({ decision, hostCapabilities });
  // 'invocation-override' is the registry's own highest-precedence source
  // (§10.2: an explicit per-call override outranks environment, profile, and
  // host-default). Applying the model-policy recommendation on top of it would
  // silently run a different model than the one a caller explicitly asked
  // for — e.g. an experiment pinning a specific model for one call.
  if (modelPolicyMode === 'on' && modelPolicyRecommendation && resolution.source !== 'invocation-override') {
    const appliedModel = modelPolicyRecommendation.model || resolution.model;
    resolution = {
      ...resolution,
      model: appliedModel,
      effort: modelPolicyRecommendation.effort || resolution.effort,
      // Claiming 'model-policy'/'enforced' asserts a concrete, Host-decided
      // model exists. Claude's recommendation supplies only an effort, so a
      // registry with no configured model would otherwise still flip to
      // 'enforced' with no model behind it — letting a T3 review's
      // checkRoleRules() pass on an unproven resolution. Only claim it when
      // the merge actually produced a model.
      ...(appliedModel ? { source: 'model-policy', enforcementIntent: 'enforced' } : {}),
    };
  }
  // K1: the capsule is the authority for what the worker may see and touch.
  // The flat contract is still passed for adapters that have not moved yet.
  const executionCapsuleValue = turn.executionCapsule || hostDirective.executionCapsule || null;
  const executionCapsule = executionCapsuleValue ? asRecord(executionCapsuleValue) : null;
  const attempt = boundAttempt;

  // K3: admission sits between the decision and the dispatch. A blocked or
  // drifted admission stops the turn here — no worker runs, and the refusal is
  // persisted rather than looking like a turn that never happened.
  const policies = currentHostPolicies({ registry: modelRegistry, capabilities: hostCapabilities, toolPolicy, permissionPolicy });
  const admission = asRecord(await controlPlane.recordRouteAdmission(runId, admitRoute({
    run: await controlPlane.getRun(runId) || undefined,
    attemptId,
    decision,
    resolution,
    capabilities: hostCapabilities,
    capsule: admissionCapsule(executionCapsule),
    policies,
    economics,
  })));
  if (admission.decision === 'blocked' || admission.decision === 'redecision_required') {
    return { schemaVersion: 1, runId, dispatched: false, reason: admission.rejectionCode || admission.decision, admission, modelInput, hostDirective: candidateHostDirective, executionCapsule, receipt: null };
  }
  const revalidated = revalidateBeforeDispatch({
    admission,
    registry: modelRegistry,
    capabilities: adapter.capabilities,
    toolPolicy,
    permissionPolicy,
  });
  if (!revalidated.valid) {
    const drifted = asRecord(await controlPlane.recordRouteAdmission(runId, admitRoute({
      run: await controlPlane.getRun(runId) || undefined,
      attemptId,
      decision,
      resolution,
      capabilities: adapter.capabilities,
      capsule: admissionCapsule(executionCapsule),
      policies: currentHostPolicies({ registry: modelRegistry, capabilities: adapter.capabilities, toolPolicy, permissionPolicy }),
      economics,
    })));
    return { schemaVersion: 1, runId, dispatched: false, reason: String(revalidated.rejectionCode || 'route-admission-drift'), admission: drifted, drift: revalidated.drift, modelInput, hostDirective: candidateHostDirective, executionCapsule, receipt: null };
  }

  // Wave 3/7: the envelope is computed on every real turn — not only in the
  // replay corpus — so its digests and cache policy are what the launcher and
  // the usage receipt actually see. Computing it here does not itself change
  // `executionContract`, so a Host still on the legacy path behaves exactly
  // as before; a Host whose `launch()` reads `envelope.segments` gets the
  // cache-stable prompt and breakpoints described in Waves 3-5.
  const envelope = buildTurnPromptEnvelope({
    modelInput,
    decision,
    resolution,
    hostCapabilities,
    modelPolicyRevision: modelPolicyRecommendation?.policyRevision ?? null,
    env,
  });
  // No persisted cross-turn lineage store exists yet (§Wave 7 follow-up), so
  // `previous` stays null and continuity is never claimed (`continued` is
  // always false here). `instanceSeed` still keys the id off this turn's own
  // decisionId, so two independent turns that happen to share the same
  // identity fingerprint do not mint the same sessionLineageId — without it,
  // an aggregate that groups receipts by lineage id would misread them as one
  // continued session.
  const sessionLineage = resolveSessionLineage({ previous: null, current: envelope.cacheIdentity, role: decision.role, instanceSeed: decision.decisionId });

  // The adapter is the provider boundary. It receives the current Host
  // capsule for lineage/transport work and reprojects the six-field prompt
  // there; no broad capsule view is sent to a launcher.
  const modelVisiblePrompt = buildModelVisiblePromptView({ modelInput, capsule: executionCapsule });
  const providerMessage = buildModelVisiblePromptMessage({
    prompt: modelVisiblePrompt,
    review: decision.role === 'reviewer',
  });
  const promptMeasurement = measurePromptEnvelope(envelope, { providerMessage });
  const executionContract = buildExecutionContract(modelInput, decision);
  const requestedTransport = actionContext.requestedTransport
    || actionContext.transport
    || (actionContext.executionMode === 'native-subagent' ? 'native-subagent' : null);

  const startedAt = now();
  let dispatch: HostRecord;
  let dispatchError: HostRecord | null = null;
  try {
    dispatch = asRecord(await adapter.dispatch({
      decision: { ...decision, role: String(decision.role || '') },
      resolution: { ...resolution },
      strategy: enforcementStrategy,
      executionCapsule,
      modelInput,
      modelVisiblePrompt,
      executionContract,
      hostExecutionContract: asRecord(hostBoundary.contract),
      envelope,
      workingDirectory: controlPlane.projectRoot || null,
      environment: env,
      parentSessionId,
      parentSessionConfig,
      reviewSubject: decision.role === 'reviewer'
        ? {
          runId: executionCapsule?.runId || decision.runId || null,
          capsuleDigest: executionCapsule?.provenance?.capsuleDigest || null,
          workspaceIdentity: executionCapsule?.subject?.workspaceIdentity || executionCapsule?.provenance?.workspaceIdentity || null,
          mutationRevision: executionCapsule?.subject?.mutationRevision ?? executionCapsule?.mutationRevision ?? null,
        }
        : null,
      concurrencyGroup: actionContext.concurrencyGroup || runId,
      actionContext,
      requestedTransport,
      executionMode: actionContext.executionMode || ((!isExplicitOwnerDirect && isMutationBearingAction(decision.actionKind, modelInput.action?.type) && executionCapsule && isWorkUnitBounded({ capsule: executionCapsule, modelInput }) && nativeAvailable) ? 'native-subagent' : null),
      delegationRequested: Boolean(nativeDelegationRequested || decision.role === 'reviewer' || (!isExplicitOwnerDirect && isMutationBearingAction(decision.actionKind, modelInput.action?.type) && executionCapsule && isWorkUnitBounded({ capsule: executionCapsule, modelInput }) && nativeAvailable)),
      childSession: {
        canDelegate: false,
        canCommit: false,
        maxNestedAgents: 0,
        freshSessionRequired: adeOrchestratorOnly || decision.workProfile?.independentContextRequired === true || decision.independentContextRequired === true || decision.role === 'reviewer',
      },
    }));
  } catch (error: unknown) {
    const failure = errorRecord(error);
    dispatchError = failure;
    const failureDetails = asRecord(failure.details);
    const failureStage = failure.failureStage || failureDetails.failureStage || null;
    const failureCategory = failure.failureCategory || failureDetails.failureCategory || null;
    const semanticErrorPayload = {
      ...reviewerResultFields(failureDetails.result),
      ...reviewerResultFields(failureDetails),
      ...reviewerResultFields(failure),
    };
    const launcherFailure = failure.launcherFailure || failureDetails.launcherFailure || null;
    dispatch = {
      status: 'failed',
      resultStatus: 'failed',
      errorCode: failure.code || failure.errorCode || null,
      errorSummary: failure.message || String(error),
      failureCategory,
      failureStage,
      ...semanticErrorPayload,
      ...(launcherFailure ? { launcherFailure } : {}),
      ...(failureStage === 'pre-spawn' ? {
        runtimePreflight: {
          status: 'failed',
          errorCode: failure.code || failure.errorCode || null,
          failureCategory,
          failureStage,
          ...reviewerResultFields(failureDetails.runtimePreflight),
        },
      } : {}),
    };
  }

  const transportClassification = classifyTransportFailure({
    dispatch,
    dispatchError,
    decision,
    executionContract,
    adapter,
    requestedTransport,
    retryAttempted: actionContext.transportRetry === true,
  });
  if (transportClassification.safeToRetryTransport) {
    const retry = await dispatchKernelTurnAttempt({
      controlPlane,
      runId,
      adapter,
      registry,
      runtimeHome,
      env,
      overrides,
      actionContext: {
        ...actionContext,
        executionMode: 'owner-direct',
        requestedTransport: 'owner-direct',
        delegationRequested: false,
        transportRetry: true,
        transportFallbackReason: transportClassification.reason,
      },
      parentSessionId,
      parentSessionConfig,
      toolPolicy,
      permissionPolicy,
      economics,
      now,
      turn,
      attemptOverride: attempt,
      suppressOwnerDirect: true,
      suppressParallel: true,
      useHostDirectiveStrategy,
    });
    return {
      ...retry,
      transportFallback: {
        ...transportClassification,
        from: requestedTransport,
        to: 'owner-direct',
      },
    };
  }

  // The independent-subagent transport is a Host fallback, but its result is
  // not trusted merely because it contains a reviewer verdict. Require the
  // transport's explicit execution attestation before creating even the
  // usage receipt that can feed the Kernel review chain. Existing native
  // adapters retain their established provider-specific checks.
  if (decision.role === 'reviewer' && dispatch.dispatchMechanism === 'independent-subagent') {
    const reviewSubject = {
      runId: executionCapsule?.runId || decision.runId || null,
      capsuleDigest: executionCapsule?.provenance?.capsuleDigest || null,
      workspaceIdentity: executionCapsule?.subject?.workspaceIdentity || executionCapsule?.provenance?.workspaceIdentity || null,
      mutationRevision: executionCapsule?.subject?.mutationRevision ?? executionCapsule?.mutationRevision ?? null,
    };
    const attestation = validateIndependentSubagentReviewAttestation({
      dispatch,
      invocation: dispatch.invocation || {
        model: resolution.model,
        effort: resolution.effort,
      },
      reviewSubject,
      parentSessionId,
    });
    if (!attestation.valid) {
      dispatch = {
        ...dispatch,
        status: 'failed',
        resultStatus: 'failed',
        errorCode: 'review-transport-attestation-invalid',
        errorSummary: `Independent reviewer attestation failed: ${attestation.reasons.join(', ')}`,
        failureCategory: 'transport/infrastructure',
        failureStage: 'post-spawn',
        outcome: null,
        report: null,
      };
    }
  }

  // Provider output is untrusted text. Sanitize once at the Host boundary so
  // the same safe value is used for receipts, Kernel reports, and the public
  // dispatch response; no provider-specific adapter may bypass persistence
  // redaction.
  dispatch = asRecord(sanitizePersistentPayload(dispatch));

  const receipt = buildUsageReceipt({
    decision,
    capabilities: hostCapabilities,
    strategy: enforcementStrategy,
    resolution: { ...resolution },
    dispatch,
    capsule: executionCapsule,
    admission,
    attemptId,
    bindingId: attempt?.bindingId || null,
    // A pre-spawn refusal has no provider session. Include the canonical
    // attempt in its synthetic Host identity so retry receipts cannot collide
    // when a caller supplies a fixed clock or retries the same route.
    actorSessionId: dispatch.actorSessionId || `${hostCapabilities.surface}:${decision.decisionId}:${attemptId || startedAt || 'unbound'}`,
    parentSessionId,
    startedAt,
    finishedAt: now(),
    envelope,
    sessionLineage,
    promptMeasurement,
    cacheContext: {
      // Recorded regardless of modelPolicyMode: the whole point of computing
      // the recommendation unconditionally is that shadow mode can measure
      // which turns *would* have escalated (for risk, complexity, review
      // policy, or repeated failure) before the mode is ever turned on.
      // Gating this on 'on' discarded the only receipt-level evidence of
      // that measurement.
      modelEscalationReason: firstMappedEscalationReason(modelPolicyRecommendation?.reasons),
      // The denominator eligibleHitRatio needs: the token estimate of every
      // segment this turn declared cacheable. Without it every live receipt
      // reports a null eligiblePrefixTokens, so summarizeCacheEconomics() can
      // never publish a real hit ratio outside the replay corpus.
      eligiblePrefixTokens: envelope.segments.filter((segment) => segment.cacheable).reduce((total, segment) => total + segment.tokenEstimate, 0),
    },
  });
  await controlPlane.recordModelUsage(runId, receipt);
  const response = {
    schemaVersion: 1,
    runId,
    dispatched: true,
    modelInput,
    hostDirective: candidateHostDirective,
    resolution,
    dispatch,
    executionCapsule,
    admission,
    receipt,
    envelope,
    promptMeasurement,
    attemptId,
    report: dispatch.report
      ? {
        ...dispatch.report,
        attemptId,
        bindingId: attempt?.bindingId || dispatch.report.bindingId,
        assignmentId: dispatch.report.assignmentId || candidateHostDirective.executionAssignment?.assignmentId || null,
        actorSessionId: dispatch.report.actorSessionId || dispatch.actorSessionId || null,
      }
      : null,
  };
  if (decision.role !== 'reviewer') {
    if (dispatch.status === 'failed' || dispatch.resultStatus === 'failed') {
      const stepId = executionCapsule?.stepId || boundAttempt?.stepId;
      if (stepId && typeof controlPlane?.failStepAttempt === 'function') {
        try {
          await controlPlane.failStepAttempt(runId, stepId, {
            code: dispatch.errorCode || 'worker-dispatch-failed',
            failureCategory: dispatch.failureCategory || 'provider/infrastructure',
            errorSummary: dispatch.errorSummary || undefined,
          });
        } catch {
          // fail safe if attempt is already closed
        }
      }
    }
    return response;
  }

  if (dispatch.status !== 'completed' || !dispatch.outcome) {
    finishUnusableReviewAttempt({
      controlPlane,
      attempt,
      reason: dispatch.errorCode || (dispatch.outcome ? 'reviewer-dispatch-failed' : 'reviewer-outcome-missing'),
    });
    return withReviewAttemptMeta({
      ...response,
      review: {
        required: true,
        independent: true,
        status: dispatch.status === 'failed' || dispatch.status === 'unsupported' || !dispatch.outcome ? 'blocked' : 'pending',
        blockedReason: dispatch.status === 'failed' || dispatch.status === 'unsupported'
          ? dispatch.errorCode || 'reviewer-dispatch-failed'
          : 'reviewer-outcome-missing',
        errorSummary: dispatch.errorSummary || null,
      },
      reviewReceipt: null,
      reviewReceiptId: null,
    }, {
      fallbackEligible: isReviewTransportFailure({ dispatch, dispatchError }),
    });
  }

  const reviewerOutcome = buildReviewerOutcomeForIngestion({
    outcome: dispatch.outcome,
    executionCapsule,
  });
  if (!reviewerOutcome) {
    finishUnusableReviewAttempt({
      controlPlane,
      attempt,
      reason: 'reviewer-provenance-missing',
    });
    return withReviewAttemptMeta({
      ...response,
      review: { required: true, independent: true, status: 'blocked', blockedReason: 'reviewer-provenance-missing' },
      reviewReceipt: null,
      reviewReceiptId: null,
      blocker: { reason: 'reviewer-provenance-missing', detail: 'The Host could not bind the reviewer outcome to the current capsule mutation revision.' },
    }, { fallbackEligible: false });
  }

  try {
    const review = asRecord(await controlPlane.ingestReviewerOutcome({
      runId,
      stepId: executionCapsule?.stepId || undefined,
      capsuleId: executionCapsule?.capsuleId || undefined,
      routeDecisionId: decision.decisionId || undefined,
      usageReceiptId: receipt.receiptId,
      reviewerSessionId: dispatch.actorSessionId || undefined,
      outcome: reviewerOutcome,
    }));
    return withReviewAttemptMeta({
      ...response,
      review,
      reviewReceipt: review.reviewReceipt || null,
      reviewReceiptId: review.reviewReceipt?.receiptId || null,
    }, { fallbackEligible: false });
  } catch (error: unknown) {
    const reviewError = errorRecord(error);
    // A usage receipt may exist even when the review chain is incomplete. It
    // remains observable, but it can never be promoted to a review receipt by
    // the Host or by the model.
    finishUnusableReviewAttempt({
      controlPlane,
      attempt,
      reason: 'incomplete_review_chain',
    });
    return withReviewAttemptMeta({
      ...response,
      review: {
        required: true,
        independent: true,
        status: 'blocked',
        blockedReason: 'incomplete_review_chain',
        errorSummary: String(reviewError.message || error),
      },
      reviewReceipt: null,
      reviewReceiptId: null,
      blocker: { reason: 'incomplete_review_chain', detail: String(reviewError.message || error) },
    }, { fallbackEligible: false });
  }
};

const finishUnusableReviewAttempt = ({ controlPlane, attempt, reason }: { controlPlane: ControlPlaneLike; attempt?: HostRecord | null; reason: unknown }): void => {
  if (!attempt?.runId || !attempt?.attemptId || typeof controlPlane?.interruptAttempt !== 'function') return;
  controlPlane.interruptAttempt(attempt.runId, attempt.attemptId, { reason: String(reason || '') });
};

const beginReviewFallbackAttempt = ({ controlPlane, runId, turn, decision, previousAttempt }: { controlPlane: ControlPlaneLike; runId: string; turn: TurnLike; decision: HostRecord; previousAttempt?: HostRecord | null }): HostRecord | null => {
  const executionCapsule = turn?.executionCapsule || turn?.hostDirective?.executionCapsule || null;
  if (!previousAttempt?.attemptId || !executionCapsule?.stepId || typeof controlPlane?.beginAttempt !== 'function') return null;
  try {
    return controlPlane.beginAttempt(runId, {
      stepId: executionCapsule.stepId,
      bindingId: previousAttempt.bindingId || null,
      capsuleId: executionCapsule.capsuleId,
      capsuleDigest: executionCapsule.provenance?.capsuleDigest || previousAttempt.capsuleDigest || null,
      routeDecisionId: decision?.decisionId || previousAttempt.routeDecisionId || null,
      parentAttemptId: previousAttempt.attemptId,
      provenanceKind: 'routed',
      planRevision: Number(previousAttempt.planRevision || decision?.planRevision || 1),
      mutationRevision: Number(executionCapsule.subject?.mutationRevision ?? previousAttempt.mutationRevision ?? 0),
      workspaceIdentityStart: executionCapsule.provenance?.workspaceIdentity || previousAttempt.workspaceIdentityStart || null,
      workspaceId: previousAttempt.workspaceId || null,
      workspaceRootHash: previousAttempt.workspaceRootHash || null,
      baseWorkspaceIdentity: previousAttempt.baseWorkspaceIdentity || null,
      retryReason: 'review-transport-fallback',
    });
  } catch {
    // A fallback without a fresh canonical attempt would reuse a failed
    // provider receipt, so the caller must stop rather than weaken lineage.
    return null;
  }
};

const observeReviewSubjectFreshness = ({ controlPlane, runId, executionCapsule }: { controlPlane: ControlPlaneLike; runId: string; executionCapsule?: HostRecord | null }): HostRecord => {
  const projectRoot = controlPlane.projectRoot;
  const unavailable = (reasons: string[]): HostRecord => ({ stale: true, reasons, liveWorkspaceIdentity: null, run: null });
  if (typeof controlPlane?.getHostReviewSubject !== 'function'
    || typeof controlPlane?.observeHostWorkspaceIdentity !== 'function'
    || !projectRoot) {
    return unavailable(['review-workspace-observation-unavailable']);
  }

  let liveObservation;
  try {
    liveObservation = observeWorkspaceIdentity({ projectRoot });
  } catch {
    return unavailable(['review-workspace-observation-failed']);
  }
  if (!liveObservation?.identity) return unavailable(['review-workspace-identity-unavailable']);

  let run = controlPlane.getHostReviewSubject(runId);
  if (!run) return unavailable(['run-not-found']);

  const subject = executionCapsule?.subject || {};
  const capsuleWorkspaceIdentity = subject.workspaceIdentity
    || executionCapsule?.provenance?.workspaceIdentity
    || null;
  const capsuleMutationRevision = subject.mutationRevision
    ?? executionCapsule?.mutationRevision
    ?? null;
  const reasons = [];

  // Advance the existing authoritative Run observation before comparing the
  // capsule. This makes a concurrent mutation visible to the next PROVE turn
  // while keeping the stale capsule fail-closed for this fallback chain.
  if (run.currentWorkspaceIdentity !== liveObservation.identity) {
    reasons.push('review-workspace-identity-changed');
    try {
      controlPlane.observeHostWorkspaceIdentity(runId, liveObservation.identity);
      run = controlPlane.getHostReviewSubject(runId);
    } catch {
      return unavailable(['review-workspace-observation-persist-failed']);
    }
  }
  if (capsuleWorkspaceIdentity !== liveObservation.identity) reasons.push('capsule-workspace-identity-stale');
  if (!Number.isInteger(Number(capsuleMutationRevision))) {
    reasons.push('capsule-mutation-revision-unavailable');
  } else if (Number(capsuleMutationRevision) !== Number(run?.mutationRevision)) {
    reasons.push('capsule-mutation-revision-stale');
  }
  return {
    stale: reasons.length > 0,
    reasons,
    liveWorkspaceIdentity: liveObservation.identity,
    run,
  };
};

const buildReviewSubjectStaleResponse = ({ turn, runId, lastTransportFailure, freshness }: { turn: TurnLike; runId: string; lastTransportFailure?: HostRecord | null; freshness: HostRecord }): HostRecord => {
  const base = withoutReviewAttemptMeta(lastTransportFailure) || {
    schemaVersion: 1,
    runId,
    dispatched: false,
    ...(turn?.modelInput === undefined ? {} : { modelInput: turn.modelInput }),
    ...(turn?.hostDirective === undefined ? {} : { hostDirective: turn.hostDirective }),
    executionCapsule: turn?.executionCapsule || turn?.hostDirective?.executionCapsule || null,
    receipt: null,
    report: null,
  };
  const freshnessReasons = Array.isArray(freshness.reasons) ? freshness.reasons.map(String) : [];
  const detail = freshnessReasons.join(', ') || 'review capsule subject changed';
  return {
    ...base,
    reason: 'review-subject-stale',
    executionMode: 'independent-review',
    review: {
      required: true,
      independent: true,
      status: 'blocked',
      blockedReason: 'review-subject-stale',
      errorSummary: detail,
    },
    reviewReceipt: null,
    reviewReceiptId: null,
    blocker: {
      reason: 'review-subject-stale',
      detail: `Reviewer fallback stopped because the capsule subject changed (${detail}). Request a fresh PROVE review action.`,
    },
  };
};

const buildReviewClaimFailureResponse = ({ turn, runId, claim, claimKey }: { turn: TurnLike; runId: string; claim?: HostRecord | null; claimKey: string }): HostRecord => {
  const reason = claim?.reason || 'review-claim-not-established';
  const base = {
    schemaVersion: 1,
    runId,
    dispatched: false,
    modelInput: turn?.modelInput || null,
    hostDirective: turn?.hostDirective || null,
    executionCapsule: turn?.executionCapsule || turn?.hostDirective?.executionCapsule || null,
    receipt: null,
    report: null,
  };
  return {
    ...base,
    reason,
    executionMode: 'independent-review',
    claim: claim || { claimed: false, reason },
    claimKey: claimKey || null,
    review: {
      required: true,
      independent: true,
      status: 'blocked',
      blockedReason: reason,
      errorSummary: 'Reviewer dispatch stopped because durable claim ownership was not established.',
    },
    reviewReceipt: null,
    reviewReceiptId: null,
    blocker: {
      reason,
      detail: 'No reviewer provider was invoked without an owned durable review claim.',
    },
  };
};

export const dispatchKernelTurn = async ({
  controlPlane,
  runId,
  adapter,
  registry,
  runtimeHome,
  env = process.env,
  overrides = {},
  actionContext = {},
  parentSessionId = null,
  parentSessionConfig = null,
  toolPolicy = {},
  permissionPolicy = {},
  economics = {},
  now = () => new Date().toISOString(),
  reviewFallbacks = [],
  hostAdapters = [],
  reviewTransports = [],
}: DispatchKernelTurnInput): Promise<HostRecord> => {
  if (!adapter) throw new Error('dispatchKernelTurn requires a Host adapter');
  const fallbackEntries = resolveReviewTransports({
    adapter,
    reviewFallbacks: (Array.isArray(reviewFallbacks) ? reviewFallbacks : [])
      .map((entry) => attestReviewTransport(entry, 'dispatcher:explicit-fallback'))
      .filter(Boolean),
    hostAdapters: (Array.isArray(hostAdapters) ? hostAdapters : [])
      .map((entry) => attestReviewTransport(entry, 'dispatcher:host-adapter'))
      .filter(Boolean),
    reviewTransports: (Array.isArray(reviewTransports) ? reviewTransports : [])
      .map((entry) => attestReviewTransport(entry, 'dispatcher:review-transport'))
      .filter(Boolean),
    env,
    runtimeHome,
    overrides,
  });
  const reviewIntent = isReviewActionContext(actionContext);

  // Review is one obligation-level action. A retried call for the same
  // subject must not create a second reviewer session or receipt.
  if (reviewIntent && actionContext.obligationId) {
    const existing = currentReviewReceiptFor({
      controlPlane,
      runId,
      obligationId: actionContext.obligationId,
    });
    if (existing) return buildDeduplicatedReviewResponse({ runId, receipt: existing });
  }

  // Preserve the original owner-direct and parallel paths byte-for-byte for
  // ordinary work.  Review candidates need one shared hostNext result, so the
  // reviewer path below preloads that turn before trying any adapter.
  if (!reviewIntent) {
    return withoutReviewAttemptMeta(await dispatchKernelTurnAttempt({
      controlPlane,
      runId,
      adapter,
      registry,
      runtimeHome,
      env,
      overrides,
      actionContext,
      parentSessionId,
      parentSessionConfig,
      toolPolicy,
      permissionPolicy,
      economics,
      now,
    })) as HostRecord;
  }

  const hostCapabilities = adapter.capabilities || {};
  const turn = asRecord(await prepareHostTurn({
    controlPlane,
    runId,
    hostCapabilities,
    actionContext,
  })) as TurnLike;
  if (turn.status === 'not_found') return turn;
  const turnHostDirective = asRecord(turn.hostDirective);
  if (!turnHostDirective.modelRouteDecision) return turn;
  const decision = asRecord(turnHostDirective.modelRouteDecision);
  const turnAttempt = asRecord(turnHostDirective.attempt);
  const turnExecutionCapsuleValue = turn.executionCapsule || turnHostDirective.executionCapsule || null;
  const turnExecutionCapsule = turnExecutionCapsuleValue ? asRecord(turnExecutionCapsuleValue) : null;
  const existing = currentReviewReceiptFor({
    controlPlane,
    runId,
    obligationId: decision.obligationId,
  });
  if (existing) {
    finishUnusableReviewAttempt({
      controlPlane,
      attempt: Object.keys(turnAttempt).length > 0 ? turnAttempt : null,
      reason: 'review-already-recorded',
    });
    return buildDeduplicatedReviewResponse({ runId, turn, receipt: existing });
  }
  const reviewStepId = decision.stepId || turnAttempt.stepId || turnExecutionCapsule?.stepId;
  const reviewPlanRevision = turnExecutionCapsule?.planRevision ?? turnAttempt.planRevision ?? null;
  const reviewMutationRevision = turnExecutionCapsule?.mutationRevision ?? turnAttempt.mutationRevision ?? null;
  // The claim label is part of the durable subject identity. Including the
  // plan and step prevents a new plan from inheriting a stale old-plan claim.
  const reviewClaimKey = JSON.stringify({
    runId,
    stepId: reviewStepId || null,
    planRevision: reviewPlanRevision,
    mutationRevision: reviewMutationRevision,
    obligationId: decision.obligationId || 'review',
  });
  const reviewClaimHolder = `host-review:${process.pid}:${randomUUID()}`;
  const reviewClaim = controlPlane.claimReviewAttempt?.({
    runId,
    stepId: reviewStepId || '',
    claimKey: reviewClaimKey,
    holder: reviewClaimHolder,
    expiresAt: new Date(Date.now() + 300000).toISOString(),
    role: decision.role,
    actionKind: decision.actionKind,
    obligationId: decision.obligationId,
    planRevision: reviewPlanRevision,
    mutationRevision: reviewMutationRevision,
  });
  if (reviewClaim?.reason === 'already-claimed' || (reviewClaim && !reviewClaim.claimed && reviewClaim.existing)) {
    return { ...buildDeduplicatedReviewResponse({ runId, turn, receipt: null }), status: 'review-in-progress', reason: 'review-already-claimed', claim: reviewClaim.existing || null };
  }
  const reviewClaimEstablished = reviewClaim?.claimed === true && Boolean(reviewClaim.existing?.attemptId);
  if (decision.role === 'reviewer' && !reviewClaimEstablished) {
    const claimFailureReason = reviewClaim?.reason || 'review-claim-not-established';
    finishUnusableReviewAttempt({
      controlPlane,
      attempt: Object.keys(turnAttempt).length > 0 ? turnAttempt : null,
      reason: claimFailureReason,
    });
    return buildReviewClaimFailureResponse({ runId, turn, claim: reviewClaim, claimKey: reviewClaimKey });
  }
  const defaults: ReviewCandidateDefaults = {
    controlPlane,
    adapter,
    registry,
    runtimeHome,
    env,
    overrides,
    actionContext,
    parentSessionId,
    parentSessionConfig,
    toolPolicy,
    permissionPolicy,
    economics,
  };

  // A caller may pass a fallback list defensively while the current action is
  // ordinary work.  The list is only meaningful for a reviewer decision.
  if (decision.role !== 'reviewer') {
    return withoutReviewAttemptMeta(await dispatchKernelTurnAttempt({
      ...defaults,
      runId,
      now,
      turn,
      suppressOwnerDirect: true,
      suppressParallel: true,
    })) as HostRecord;
  }

  const candidates = [{ adapter }, ...fallbackEntries].map((candidate) => normalizeReviewCandidate(candidate, defaults));
  const candidateUnavailableReasons = candidates.map((candidate) => reviewCandidateUnavailableReason(candidate));
  let lastTransportFailure: HostRecord | null = null;
  let canonicalAttempt: HostRecord | null = Object.keys(turnAttempt).length > 0 ? turnAttempt : null;
  for (const [candidateIndex, candidate] of candidates.entries()) {
    if (candidateUnavailableReasons[candidateIndex]) continue;

    // Every fallback candidate gets a fresh child attempt, including when an
    // unavailable candidate was skipped between two usable transports. This
    // keeps one canonical attempt per attempted transport and preserves the
    // parent chain through arbitrary fallback hops.
    let fallbackAttempt: HostRecord | null = null;
    if (candidateIndex > 0) {
      const freshness = observeReviewSubjectFreshness({
        controlPlane,
        runId,
        executionCapsule: turnExecutionCapsule,
      });
      if (freshness.stale) {
        finishUnusableReviewAttempt({
          controlPlane,
          attempt: canonicalAttempt || asRecord(lastTransportFailure?.hostDirective).attempt as HostRecord || (Object.keys(turnAttempt).length > 0 ? turnAttempt : null),
          reason: 'review-subject-stale',
        });
        return buildReviewSubjectStaleResponse({
          turn,
          runId,
          lastTransportFailure,
          freshness,
        });
      }
      const previousAttempt = canonicalAttempt;
      finishUnusableReviewAttempt({
        controlPlane,
        attempt: canonicalAttempt,
        reason: candidateUnavailableReasons.slice(0, candidateIndex).find(Boolean) || 'reviewer-transport-unavailable',
      });
      fallbackAttempt = beginReviewFallbackAttempt({
        controlPlane,
        runId,
        turn,
        decision,
        previousAttempt,
      });
      if (!fallbackAttempt) break;
    }

    const attempt = await dispatchKernelTurnAttempt({
      ...candidate,
      runId,
      now,
      turn,
      suppressOwnerDirect: true,
      suppressParallel: true,
      useHostDirectiveStrategy: candidateIndex === 0,
      attemptOverride: fallbackAttempt,
    });
    canonicalAttempt = asRecord(attempt.hostDirective).attempt ? asRecord(asRecord(attempt.hostDirective).attempt) : fallbackAttempt || canonicalAttempt;
    const meta = (attempt as HostRecord & { [REVIEW_ATTEMPT_META]?: HostRecord })[REVIEW_ATTEMPT_META];
    if (meta?.fallbackEligible !== true) return withoutReviewAttemptMeta(attempt) as HostRecord;
    lastTransportFailure = attempt;
  }

  if (lastTransportFailure) {
    finishUnusableReviewAttempt({
      controlPlane,
      attempt: canonicalAttempt || (asRecord(lastTransportFailure.hostDirective).attempt ? asRecord(asRecord(lastTransportFailure.hostDirective).attempt) : null) || (Object.keys(turnAttempt).length > 0 ? turnAttempt : null),
      reason: lastTransportFailure.review?.blockedReason || 'reviewer-transport-failed',
    });
  } else {
    finishUnusableReviewAttempt({
      controlPlane,
      attempt: canonicalAttempt || (Object.keys(turnAttempt).length > 0 ? turnAttempt : null),
      reason: 'no-independent-review-capability',
    });
  }
  controlPlane.releaseReviewClaim?.(reviewClaimKey, reviewClaimHolder, {
    runId,
    stepId: reviewStepId,
    planRevision: reviewPlanRevision,
  });

  const base = withoutReviewAttemptMeta(lastTransportFailure) || {
    schemaVersion: 1,
    runId,
    dispatched: false,
    modelInput: asRecord(turn.modelInput),
    hostDirective: turnHostDirective,
    executionCapsule: turnExecutionCapsule,
    receipt: null,
    report: null,
  };
  return {
    ...base,
    reason: 'no-independent-review-capability',
    executionMode: 'independent-review',
    review: {
      required: true,
      independent: true,
      status: 'blocked',
      blockedReason: 'no-independent-review-capability',
      errorSummary: null,
    },
    reviewReceipt: null,
    reviewReceiptId: null,
    blocker: {
      reason: 'no-independent-review-capability',
      detail: 'No configured reviewer transport produced an independent outcome.',
    },
  };
};
