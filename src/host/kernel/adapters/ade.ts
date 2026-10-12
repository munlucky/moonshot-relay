// ADE Host adapter.
//
// ADE is a first-class native surface whose embedded agent runtime is
// Qwen-Code compatible. Kernel never selects or tunes the backing model here;
// the active ADE session remains the model authority. This adapter owns only
// the execution boundary required by ADE's short-context policy.

import {
  buildModelVisiblePromptMessage,
  buildModelVisiblePromptView,
} from '../model-capsule-view.js';
import { ADE_CHILD_PROMPT_TOKEN_LIMIT } from '../ade-context-policy.js';

type UnknownRecord = Record<string, unknown>;
type Launcher = (request: UnknownRecord) => unknown | Promise<unknown>;

interface DispatchDecision extends UnknownRecord {
  role?: unknown;
}

interface DispatchResolution extends UnknownRecord {
  model?: unknown;
  effort?: unknown;
}

interface AdeCapabilities extends UnknownRecord {
  supportsSubagentModel?: unknown;
  supportsIndependentContext?: unknown;
}

interface AdeDispatchInput {
  decision?: DispatchDecision | null;
  resolution?: DispatchResolution | null;
  executionCapsule?: unknown;
  modelInput?: unknown;
  workingDirectory?: unknown;
  environment?: unknown;
  parentSessionId?: unknown;
  concurrencyGroup?: unknown;
  childSession?: unknown;
}

interface AdeAdapterInput {
  spawnAgent?: Launcher | null;
  nativeAgentHost?: unknown;
  capabilities?: AdeCapabilities;
}

interface FailureInput {
  code: string;
  summary: string;
  parentSessionId?: unknown;
  stage?: string;
}

export const ADE_WORKER_AGENT = 'kernel-worker';
export const ADE_REVIEWER_AGENT = 'kernel-reviewer';

const isObject = (value: unknown): value is UnknownRecord => Boolean(
  value && typeof value === 'object' && !Array.isArray(value),
);

const firstText = (values: unknown[]): string | null => {
  const found = values.find(
    (value) => value !== undefined
      && value !== null
      && String(value).trim(),
  );
  return found === undefined || found === null
    ? null
    : String(found);
};

const providerEnvironment = (
  value: unknown,
): Readonly<Record<string, string | boolean | number>> | null => {
  if (!isObject(value)) return null;
  return Object.freeze(Object.fromEntries(
    Object.entries(value).filter(([, next]) => (
      typeof next === 'string'
      || typeof next === 'boolean'
      || (typeof next === 'number' && Number.isFinite(next))
    )),
  ) as Record<string, string | boolean | number>);
};

const launcherFrom = (
  owner: unknown,
  key: string,
): Launcher | null => {
  if (!isObject(owner)) return null;
  const candidate = owner[key];
  return typeof candidate === 'function'
    ? candidate.bind(owner) as Launcher
    : null;
};

const resolveLauncher = ({
  spawnAgent = null,
  host = globalThis,
}: {
  spawnAgent?: Launcher | null;
  host?: unknown;
} = {}): Launcher | null => {
  if (typeof spawnAgent === 'function') return spawnAgent;
  const hostRecord = isObject(host) ? host : {};
  const candidates: Array<[unknown, string]> = [
    [hostRecord.ade, 'spawn_agent'],
    [hostRecord.ade, 'spawnAgent'],
    [hostRecord, 'spawn_ade_agent'],
    [hostRecord, 'spawnAdeAgent'],
    [hostRecord, 'spawn_agent'],
    [hostRecord, 'spawnAgent'],
    [hostRecord.qwen, 'spawn_agent'],
    [hostRecord.qwen, 'spawnAgent'],
  ];
  for (const [owner, key] of candidates) {
    const launcher = launcherFrom(owner, key);
    if (launcher) return launcher;
  }
  return null;
};

const waitForResult = async (
  handle: unknown,
): Promise<UnknownRecord> => {
  if (!isObject(handle)) return {};
  for (const key of ['waitForOutcome', 'wait', 'result']) {
    const candidate = handle[key];
    if (typeof candidate === 'function') {
      const value = await candidate.call(handle);
      return isObject(value) ? value : {};
    }
  }
  return handle;
};

const normalizedWorkerReport = (value: unknown = {}) => {
  const source = isObject(value) ? value : {};
  const status = ['completed', 'blocked', 'failed'].includes(
    String(source.status || ''),
  )
    ? String(source.status)
    : 'completed';
  return {
    status,
    summary: typeof source.summary === 'string'
      ? source.summary
      : '',
    changedPaths: Array.isArray(source.changedPaths)
      ? source.changedPaths.map(String)
      : [],
    risks: Array.isArray(source.risks)
      ? source.risks.map(String)
      : [],
    verifications: Array.isArray(source.verifications)
      ? source.verifications
      : [],
    requestedVerifications: Array.isArray(
      source.requestedVerifications,
    )
      ? source.requestedVerifications.map(String)
      : [],
    judgments: Array.isArray(source.judgments)
      ? source.judgments
      : [],
    knowledgeObservations: Array.isArray(
      source.knowledgeObservations,
    )
      ? source.knowledgeObservations
      : [],
    blocker: source.blocker == null
      ? null
      : String(source.blocker),
  };
};

const normalizedReviewOutcome = (value: unknown = {}) => {
  if (
    !isObject(value)
    || !['pass', 'fail', 'blocked'].includes(
      String(value.verdict || ''),
    )
  ) {
    throw new Error(
      'ade_review_output_invalid: verdict must be pass, fail, or blocked',
    );
  }
  return {
    verdict: String(value.verdict),
    findings: Array.isArray(value.findings)
      ? value.findings
      : [],
    risks: Array.isArray(value.risks)
      ? value.risks.map(String)
      : [],
    evidenceRefs: Array.isArray(value.evidenceRefs)
      ? value.evidenceRefs.map(String)
      : [],
  };
};

const failure = ({
  code,
  summary,
  parentSessionId = null,
  stage = 'pre-spawn',
}: FailureInput) => ({
  status: 'failed',
  resultStatus: 'failed',
  executionMode: 'native-subagent',
  dispatchMechanism: 'native-subagent',
  errorCode: code,
  errorSummary: summary,
  failureCategory: 'provider/transport',
  failureStage: stage,
  actorSessionId: null,
  parentSessionId,
  outcome: null,
  report: null,
});

const errorField = (
  error: unknown,
  field: string,
): unknown => (
  isObject(error) ? error[field] : undefined
);

export const createAdeAdapter = ({
  spawnAgent = null,
  nativeAgentHost = globalThis,
  capabilities = {},
}: AdeAdapterInput = {}) => {
  const launcher = resolveLauncher({
    spawnAgent,
    host: nativeAgentHost,
  });
  const available = typeof launcher === 'function';
  let inFlight = false;
  const resolvedCapabilities = Object.freeze({
    ...capabilities,
    surface: 'ade',
    supportsSubagentModel:
      available
      && capabilities.supportsSubagentModel !== false,
    supportsSessionModelOverride: false,
    supportsIndependentContext:
      available
      && capabilities.supportsIndependentContext !== false,
    supportsCrossSurfaceReview: false,
    supportsReadOnlyReview: true,
    supportsUsageTokens: false,
    supportsResolvedModelIdentity: false,
    supportsConcurrentSessions: false,
    supportsIsolatedWorkingDirectory: false,
    supportsPerSessionEnvironment: false,
    orchestratorOnly: true,
    parallelDispatchAllowed: false,
    freshWorkerRequired: true,
    maxConcurrentWorkers: 1,
    maxNestedAgents: 0,
    semantic: Object.freeze({
      freshContext: available,
      workspaceWrite: available,
      workspaceIsolation: false,
      parallelExecution: false,
      independentReview: available,
      modelSelection: false,
    }),
  });

  return {
    surface: 'ade',
    capabilities: resolvedCapabilities,
    ownerDirectAvailable: false,
    ownerDirectDefault: false,
    nativeDelegationAvailable: available,
    async dispatch({
      decision = null,
      resolution = null,
      executionCapsule = null,
      modelInput = {},
      workingDirectory = null,
      environment = null,
      parentSessionId = null,
      concurrencyGroup = null,
      childSession = null,
    }: AdeDispatchInput = {}) {
      if (!launcher) {
        return failure({
          code: 'ade-native-subagent-unavailable',
          summary:
            'ADE does not expose a native child-agent launcher to the Kernel Host bridge.',
          parentSessionId,
        });
      }
      if (inFlight) {
        return failure({
          code: 'ade-sequential-worker-busy',
          summary:
            'ADE permits exactly one active Kernel child agent at a time.',
          parentSessionId,
        });
      }

      const reviewer = decision?.role === 'reviewer';
      const agent = reviewer
        ? ADE_REVIEWER_AGENT
        : ADE_WORKER_AGENT;
      const providerPrompt = buildModelVisiblePromptView({
        modelInput,
        capsule: executionCapsule,
      });
      const safeChildSession = {
        ...(isObject(childSession) ? childSession : {}),
        role: reviewer
          ? 'reviewer'
          : String(decision?.role || 'implementer'),
        freshSessionRequired: true,
        freshContext: true,
        canDelegate: false,
        canCommit: false,
        maxNestedAgents: 0,
        inheritParentContext: false,
        promptTokenLimit: ADE_CHILD_PROMPT_TOKEN_LIMIT,
        ...(reviewer
          ? { permissions: 'read_only', readOnly: true }
          : {}),
      };
      const childPrompt = buildModelVisiblePromptMessage({
        prompt: providerPrompt,
        review: reviewer,
      });
      const request: UnknownRecord = {
        task_name: agent,
        taskName: agent,
        agent,
        subagent_type: agent,
        subagentType: agent,
        description: reviewer
          ? 'Review one bounded Kernel subject'
          : 'Execute one bounded Kernel work unit',
        run_in_background: false,
        runInBackground: false,
        ...(resolution?.model
          ? { model: resolution.model }
          : {}),
        ...(resolution?.effort
          ? {
              reasoning_effort: resolution.effort,
              reasoningEffort: resolution.effort,
            }
          : {}),
        message: childPrompt,
        prompt: childPrompt,
        parent_session_id:
          typeof parentSessionId === 'string'
            ? parentSessionId
            : null,
        parentSessionId:
          typeof parentSessionId === 'string'
            ? parentSessionId
            : null,
        child_session: safeChildSession,
        childSession: safeChildSession,
        working_directory:
          typeof workingDirectory === 'string'
            ? workingDirectory
            : null,
        workingDirectory:
          typeof workingDirectory === 'string'
            ? workingDirectory
            : null,
        environment: providerEnvironment(environment),
        concurrency_group:
          typeof concurrencyGroup === 'string'
            ? concurrencyGroup
            : null,
        concurrencyGroup:
          typeof concurrencyGroup === 'string'
            ? concurrencyGroup
            : null,
      };

      inFlight = true;
      try {
        const handle = await launcher(request);
        const completed = await waitForResult(handle);
        const merged: UnknownRecord = {
          ...(isObject(handle) ? handle : {}),
          ...completed,
          ...(isObject(completed.result)
            ? completed.result
            : {}),
        };
        const actorSessionId = firstText([
          merged.actorSessionId,
          merged.actor_session_id,
          merged.childSessionId,
          merged.child_session_id,
          merged.sessionId,
          merged.session_id,
        ]);
        if (!actorSessionId) {
          return failure({
            code: 'ade-child-session-missing',
            summary:
              'ADE child execution completed without a child session identity; fresh-context isolation cannot be proven.',
            parentSessionId,
            stage: 'post-spawn',
          });
        }
        if (
          parentSessionId
          && actorSessionId === String(parentSessionId)
        ) {
          return failure({
            code: 'ade-child-session-not-distinct',
            summary:
              'ADE returned the owner session as the child session; fresh-context isolation failed.',
            parentSessionId,
            stage: 'post-spawn',
          });
        }

        if (reviewer) {
          const outcome = normalizedReviewOutcome(
            merged.outcome
            || merged.report
            || merged.review
            || {},
          );
          return {
            status: merged.status === 'failed'
              ? 'failed'
              : 'completed',
            resultStatus: merged.status === 'failed'
              ? 'failed'
              : 'completed',
            executionMode: 'native-subagent',
            dispatchMechanism: 'native-subagent',
            requestedModel: resolution?.model || null,
            requestedEffort: resolution?.effort || null,
            resolvedModel: null,
            resolvedEffort: null,
            actorSessionId,
            parentSessionId,
            outcome,
            report: null,
            invocation: {
              agent,
              freshSessionRequired: true,
              maxNestedAgents: 0,
              promptTokenLimit: ADE_CHILD_PROMPT_TOKEN_LIMIT,
              runInBackground: false,
              model: resolution?.model || null,
              effort: resolution?.effort || null,
            },
          };
        }

        const report = normalizedWorkerReport(
          merged.report || merged.outcome || merged,
        );
        const failed = ['blocked', 'failed'].includes(
          report.status,
        );
        return {
          status: failed ? 'failed' : 'completed',
          resultStatus: failed ? 'failed' : 'completed',
          executionMode: 'native-subagent',
          dispatchMechanism: 'native-subagent',
          requestedModel: resolution?.model || null,
          requestedEffort: resolution?.effort || null,
          resolvedModel: null,
          resolvedEffort: null,
          actorSessionId,
          parentSessionId,
          outcome: null,
          report,
          invocation: {
            agent,
            freshSessionRequired: true,
            maxNestedAgents: 0,
            promptTokenLimit: ADE_CHILD_PROMPT_TOKEN_LIMIT,
            runInBackground: false,
            model: resolution?.model || null,
            effort: resolution?.effort || null,
          },
        };
      } catch (error: unknown) {
        return failure({
          code: String(
            errorField(error, 'code')
            || 'ade-native-subagent-failed',
          ),
          summary:
            error instanceof Error
              ? error.message
              : String(error),
          parentSessionId,
          stage: String(
            errorField(error, 'failureStage') || 'launch',
          ),
        });
      } finally {
        inFlight = false;
      }
    },
  };
};
