// ADE Host adapter.
//
// ADE is a first-class native surface whose embedded agent runtime is
// Qwen-Code compatible.  Kernel never selects or tunes the backing model here;
// the active ADE session remains the model authority.  This adapter owns only
// the execution boundary required by ADE's short-context policy: every
// model-owned turn runs in one fresh child, never in the owner session, never
// concurrently, and never with nested delegation.

import { buildModelVisiblePromptMessage, buildModelVisiblePromptView } from '../model-capsule-view.mjs';

export const ADE_WORKER_AGENT = 'kernel-worker';
export const ADE_REVIEWER_AGENT = 'kernel-reviewer';

const isObject = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const firstText = (values) => values.find((value) => value !== undefined && value !== null && String(value).trim()) ?? null;

const providerEnvironment = (value) => {
  if (!isObject(value)) return null;
  return Object.freeze(Object.fromEntries(Object.entries(value).filter(([, next]) => (
    typeof next === 'string' || typeof next === 'boolean' || (typeof next === 'number' && Number.isFinite(next))
  ))));
};

const resolveLauncher = ({ spawnAgent = null, host = globalThis } = {}) => {
  if (typeof spawnAgent === 'function') return spawnAgent;
  const candidates = [
    [host?.ade, 'spawn_agent'],
    [host?.ade, 'spawnAgent'],
    [host, 'spawn_ade_agent'],
    [host, 'spawnAdeAgent'],
    [host, 'spawn_agent'],
    [host, 'spawnAgent'],
    // ADE embeds a Qwen-Code-compatible agent runtime.  These names are a
    // compatibility transport only; the Host identity remains ADE.
    [host?.qwen, 'spawn_agent'],
    [host?.qwen, 'spawnAgent'],
  ];
  for (const [owner, key] of candidates) {
    if (typeof owner?.[key] === 'function') return owner[key].bind(owner);
  }
  return null;
};

const waitForResult = async (handle) => {
  if (!isObject(handle)) return {};
  if (typeof handle.waitForOutcome === 'function') return (await handle.waitForOutcome()) || {};
  if (typeof handle.wait === 'function') return (await handle.wait()) || {};
  if (typeof handle.result === 'function') return (await handle.result()) || {};
  return handle;
};

const normalizedWorkerReport = (value = {}) => {
  const source = isObject(value) ? value : {};
  const status = ['completed', 'blocked', 'failed'].includes(source.status) ? source.status : 'completed';
  return {
    status,
    summary: typeof source.summary === 'string' ? source.summary : '',
    changedPaths: Array.isArray(source.changedPaths) ? source.changedPaths.map(String) : [],
    risks: Array.isArray(source.risks) ? source.risks.map(String) : [],
    verifications: Array.isArray(source.verifications) ? source.verifications : [],
    requestedVerifications: Array.isArray(source.requestedVerifications) ? source.requestedVerifications.map(String) : [],
    judgments: Array.isArray(source.judgments) ? source.judgments : [],
    knowledgeObservations: Array.isArray(source.knowledgeObservations) ? source.knowledgeObservations : [],
    blocker: source.blocker == null ? null : String(source.blocker),
  };
};

const normalizedReviewOutcome = (value = {}) => {
  if (!isObject(value) || !['pass', 'fail', 'blocked'].includes(value.verdict)) {
    throw new Error('ade_review_output_invalid: verdict must be pass, fail, or blocked');
  }
  return {
    verdict: value.verdict,
    findings: Array.isArray(value.findings) ? value.findings : [],
    risks: Array.isArray(value.risks) ? value.risks.map(String) : [],
    evidenceRefs: Array.isArray(value.evidenceRefs) ? value.evidenceRefs.map(String) : [],
  };
};

const failure = ({ code, summary, parentSessionId = null, stage = 'pre-spawn' } = {}) => ({
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

export const createAdeAdapter = ({ spawnAgent = null, nativeAgentHost = globalThis, capabilities = {} } = {}) => {
  const launcher = resolveLauncher({ spawnAgent, host: nativeAgentHost });
  const available = typeof launcher === 'function';
  let inFlight = false;
  const resolvedCapabilities = Object.freeze({
    ...capabilities,
    surface: 'ade',
    // ADE/Qwen Code can select a child-agent model, but this adapter does not
    // require or tune one. Without resolved identity the common route remains
    // advisory rather than claiming model enforcement.
    supportsSubagentModel: available && capabilities.supportsSubagentModel !== false,
    supportsSessionModelOverride: false,
    supportsIndependentContext: available && capabilities.supportsIndependentContext !== false,
    supportsCrossSurfaceReview: false,
    supportsReadOnlyReview: true,
    supportsUsageTokens: false,
    supportsResolvedModelIdentity: false,
    // Parallel dispatcher reads these Host facts directly. These invariants
    // cannot be relaxed by caller capability overrides.
    supportsConcurrentSessions: false,
    supportsIsolatedWorkingDirectory: false,
    supportsPerSessionEnvironment: false,
    orchestratorOnly: true,
    parallelDispatchAllowed: false,
    freshWorkerRequired: true,
    maxConcurrentWorkers: 1,
    maxNestedAgents: 0,
  });

  return {
    surface: 'ade',
    capabilities: resolvedCapabilities,
    ownerDirectAvailable: false,
    ownerDirectDefault: false,
    nativeDelegationAvailable: available,
    async dispatch({
      decision,
      resolution,
      executionCapsule = null,
      modelInput = {},
      workingDirectory = null,
      environment = null,
      parentSessionId = null,
      concurrencyGroup = null,
      childSession = null,
    } = {}) {
      if (!available) {
        return failure({ code: 'ade-native-subagent-unavailable', summary: 'ADE does not expose a native child-agent launcher to the Kernel Host bridge.', parentSessionId });
      }
      if (inFlight) {
        return failure({ code: 'ade-sequential-worker-busy', summary: 'ADE permits exactly one active Kernel child agent at a time.', parentSessionId });
      }

      const reviewer = decision?.role === 'reviewer';
      const agent = reviewer ? ADE_REVIEWER_AGENT : ADE_WORKER_AGENT;
      const providerPrompt = buildModelVisiblePromptView({ modelInput, capsule: executionCapsule });
      const safeChildSession = {
        ...(isObject(childSession) ? childSession : {}),
        role: reviewer ? 'reviewer' : decision?.role || 'implementer',
        freshSessionRequired: true,
        freshContext: true,
        canDelegate: false,
        canCommit: false,
        maxNestedAgents: 0,
        ...(reviewer ? { permissions: 'read_only', readOnly: true } : {}),
      };
      const request = {
        task_name: agent,
        taskName: agent,
        agent,
        // Omit model/effort when the registry has no explicit override.  ADE
        // then inherits the current session model rather than inventing a
        // provider-specific routing policy.
        ...(resolution?.model ? { model: resolution.model } : {}),
        ...(resolution?.effort ? { reasoning_effort: resolution.effort, reasoningEffort: resolution.effort } : {}),
        message: buildModelVisiblePromptMessage({ prompt: providerPrompt, review: reviewer }),
        prompt: providerPrompt,
        parent_session_id: typeof parentSessionId === 'string' ? parentSessionId : null,
        parentSessionId: typeof parentSessionId === 'string' ? parentSessionId : null,
        child_session: safeChildSession,
        childSession: safeChildSession,
        working_directory: typeof workingDirectory === 'string' ? workingDirectory : null,
        workingDirectory: typeof workingDirectory === 'string' ? workingDirectory : null,
        environment: providerEnvironment(environment),
        concurrency_group: typeof concurrencyGroup === 'string' ? concurrencyGroup : null,
        concurrencyGroup: typeof concurrencyGroup === 'string' ? concurrencyGroup : null,
      };

      inFlight = true;
      try {
        const handle = await launcher(request);
        const completed = await waitForResult(handle);
        const merged = {
          ...(isObject(handle) ? handle : {}),
          ...(isObject(completed) ? completed : {}),
          ...(isObject(completed?.result) ? completed.result : {}),
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
          return failure({ code: 'ade-child-session-missing', summary: 'ADE child execution completed without a child session identity; fresh-context isolation cannot be proven.', parentSessionId, stage: 'post-spawn' });
        }
        if (parentSessionId && String(actorSessionId) === String(parentSessionId)) {
          return failure({ code: 'ade-child-session-not-distinct', summary: 'ADE returned the owner session as the child session; fresh-context isolation failed.', parentSessionId, stage: 'post-spawn' });
        }

        if (reviewer) {
          const outcome = normalizedReviewOutcome(merged.outcome || merged.report || merged.review || {});
          return {
            status: merged.status === 'failed' ? 'failed' : 'completed',
            resultStatus: merged.status === 'failed' ? 'failed' : 'completed',
            executionMode: 'native-subagent',
            dispatchMechanism: 'native-subagent',
            requestedModel: resolution?.model || null,
            requestedEffort: resolution?.effort || null,
            resolvedModel: null,
            resolvedEffort: null,
            actorSessionId: String(actorSessionId),
            parentSessionId,
            outcome,
            report: null,
            invocation: { agent, freshSessionRequired: true, maxNestedAgents: 0, model: resolution?.model || null, effort: resolution?.effort || null },
          };
        }

        const report = normalizedWorkerReport(merged.report || merged.outcome || merged);
        return {
          status: ['blocked', 'failed'].includes(report.status) ? 'failed' : 'completed',
          resultStatus: ['blocked', 'failed'].includes(report.status) ? 'failed' : 'completed',
          executionMode: 'native-subagent',
          dispatchMechanism: 'native-subagent',
          requestedModel: resolution?.model || null,
          requestedEffort: resolution?.effort || null,
          resolvedModel: null,
          resolvedEffort: null,
          actorSessionId: String(actorSessionId),
          parentSessionId,
          outcome: null,
          report,
          invocation: { agent, freshSessionRequired: true, maxNestedAgents: 0, model: resolution?.model || null, effort: resolution?.effort || null },
        };
      } catch (error) {
        return failure({
          code: error?.code || 'ade-native-subagent-failed',
          summary: error?.message || String(error),
          parentSessionId,
          stage: error?.failureStage || 'launch',
        });
      } finally {
        inFlight = false;
      }
    },
  };
};
