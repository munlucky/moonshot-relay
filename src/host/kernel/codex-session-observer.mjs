// Codex Host session telemetry. Requested model/effort are configuration;
// only terminal events or the matching persisted Codex rollout settings are
// evidence of what actually ran. Missing observations stay null and never echo
// a request.

import { createReadStream } from 'node:fs';
import { readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const MODEL_KEYS = Object.freeze(['model', 'model_id', 'modelId', 'model_slug', 'modelSlug']);
const EFFORT_KEYS = Object.freeze(['effort', 'reasoning_effort', 'reasoningEffort', 'model_reasoning_effort']);
const TERMINAL_EVENT_TYPES = new Set(['turn.completed', 'response.completed', 'turn_context']);
const isThreadSettingsAppliedEvent = (event) => event?.type === 'event_msg'
  && event?.payload?.type === 'thread_settings_applied'
  && event?.payload?.thread_settings
  && typeof event.payload.thread_settings === 'object';

const codexSessionDateDirectories = (sessionsRoot, startedAt = new Date()) => {
  const directories = new Set();
  for (const offset of [-86_400_000, 0, 86_400_000]) {
    const date = new Date(startedAt.getTime() + offset);
    const local = [date.getFullYear(), date.getMonth() + 1, date.getDate()];
    const utc = [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()];
    for (const [year, month, day] of [local, utc]) {
      directories.add(path.join(sessionsRoot, String(year), String(month).padStart(2, '0'), String(day).padStart(2, '0')));
    }
  }
  return [...directories];
};

const findCodexSessionRollout = async ({ threadId, env = process.env, startedAt = new Date() }) => {
  if (!/^[0-9a-f-]{16,}$/i.test(String(threadId || ''))) return null;
  const codexHome = env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const suffix = `${threadId}.jsonl`;
  for (const directory of codexSessionDateDirectories(path.join(codexHome, 'sessions'), startedAt)) {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { continue; }
    const match = entries.find((entry) => entry.isFile() && entry.name.endsWith(suffix));
    if (match) return path.join(directory, match.name);
  }
  return null;
};

const nestedObjects = (value) => [
  value,
  value?.response,
  value?.turn,
  value?.metadata,
  value?.payload,
  value?.thread_settings,
  value?.payload?.thread_settings,
].filter((entry) => entry && typeof entry === 'object');

const firstText = (objects, keys) => {
  for (const object of objects) {
    for (const key of keys) {
      const value = object[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
  }
  return null;
};

const normalizeEffort = (value) => {
  if (typeof value !== 'string' || !value.trim()) return null;
  return value.trim().toLowerCase();
};

// The main Codex session is a Host identity invariant, not a Kernel model
// enum. The owner may choose its model and effort at runtime; concrete model
// and effort choices for a delegated child belong only to that invocation.
export const CODEX_MAIN_SESSION_POLICY = Object.freeze({
  role: 'orchestrator',
  // The Codex owner is also the default executor for an ordinary bounded
  // work unit. A native child is an optional delegation surface, not a
  // prerequisite for implementation.
  ownerExecutionDefault: true,
  delegation: 'optional',
});

// These are Host capabilities, not model-routing outcomes. A missing parent
// observation means that this process cannot prove the session boundary; it
// is actionable unsupported capability, whereas an observed mismatch is a
// hard invariant failure.
export const CODEX_HOST_UNSUPPORTED_CAPABILITY = 'codex-host-capability-unsupported';
export const CODEX_PARENT_SESSION_TELEMETRY_CAPABILITY = 'parent-session-telemetry';
export const CODEX_PARENT_SESSION_REMEDIATION = 'Run through a native Codex Host bridge or provide trusted before/after parent session observations.';

export const resolveObservedCodexSessionConfig = (events = []) => {
  let model = null;
  let effort = null;
  for (const event of [...events].reverse()) {
    if (!TERMINAL_EVENT_TYPES.has(event?.type) && !isThreadSettingsAppliedEvent(event)) continue;
    const objects = nestedObjects(event);
    model ||= firstText(objects, MODEL_KEYS);
    effort ||= normalizeEffort(firstText(objects, EFFORT_KEYS));
    if (model && effort) break;
  }
  return Object.freeze({ model, effort });
};

export const compareCodexSessionConfig = ({ requested = {}, observed = {} } = {}) => {
  const requestedModel = requested.model ? String(requested.model) : null;
  const requestedEffort = normalizeEffort(requested.effort);
  const observedModel = observed.model ? String(observed.model) : null;
  const observedEffort = normalizeEffort(observed.effort);
  const modelMatch = Boolean(requestedModel && observedModel && requestedModel === observedModel);
  const effortMatch = Boolean(requestedEffort && observedEffort && requestedEffort === observedEffort);
  const complete = Boolean(observedModel && observedEffort);
  return Object.freeze({
    requestedModel,
    requestedEffort,
    observedModel,
    observedEffort,
    modelMatch,
    effortMatch,
    complete,
    exact: complete && modelMatch && effortMatch,
    reason: !observedModel
      ? 'model-observation-missing'
      : !observedEffort
        ? 'effort-observation-missing'
        : !modelMatch
          ? 'model-mismatch'
          : !effortMatch
            ? 'effort-mismatch'
            : null,
  });
};

export const compareCodexMainSessionConfig = ({ expectedSessionId = null, observed = {} } = {}) => {
  const observedSessionId = observed?.sessionId ? String(observed.sessionId) : null;
  const sessionMatch = Boolean(expectedSessionId && observedSessionId && String(expectedSessionId) === observedSessionId);
  const observedModel = observed.model ? String(observed.model) : null;
  const observedEffort = normalizeEffort(observed.effort);
  return Object.freeze({
    requestedModel: null,
    requestedEffort: null,
    observedModel,
    observedEffort,
    // These fields are telemetry only for the owner session. They must not be
    // interpreted as a model/effort correctness gate.
    modelMatch: null,
    effortMatch: null,
    complete: Boolean(observedModel && observedEffort),
    expectedSessionId: expectedSessionId ? String(expectedSessionId) : null,
    observedSessionId,
    sessionMatch,
    exact: sessionMatch,
    reason: sessionMatch ? null : 'parent-session-not-stable',
  });
};

export const compareCodexMainSessionInvariance = ({ expectedSessionId = null, before = {}, after = {} } = {}) => {
  const beforeComparison = compareCodexMainSessionConfig({ expectedSessionId, observed: before });
  const afterComparison = compareCodexMainSessionConfig({ expectedSessionId, observed: after });
  const exact = beforeComparison.exact && afterComparison.exact;
  return Object.freeze({
    before: beforeComparison,
    after: afterComparison,
    exact,
    reason: !beforeComparison.exact
      ? `before-${beforeComparison.reason}`
      : !afterComparison.exact
        ? `after-${afterComparison.reason}`
        : null,
  });
};

const comparisonEntries = (comparison) => comparison?.before && comparison?.after
  ? [comparison.before, comparison.after]
  : comparison ? [comparison] : [];

const missingParentTelemetryReason = ({ parentSessionId, comparison } = {}) => {
  if (!parentSessionId) return 'parent-session-id-missing';
  const entries = comparisonEntries(comparison);
  if (entries.length === 0) return 'parent-session-telemetry-missing';
  if (entries.some((entry) => !entry?.observedSessionId)) return 'parent-session-id-telemetry-missing';
  return null;
};

// This is deliberately explicit about an unobserved parent. A policy
// declaration is not telemetry: callers may only call the parent `declared`
// until a Host supplies a before/after observation. When supplied, a mismatch
// is a hard failure and cannot be hidden by a successful child dispatch.
export const buildCodexMainSessionPolicy = ({ parentSessionId = null, observed = null } = {}) => {
  const comparison = observed?.before && observed?.after
    ? compareCodexMainSessionInvariance({ expectedSessionId: parentSessionId, before: observed.before, after: observed.after })
    : observed
      ? compareCodexMainSessionConfig({ expectedSessionId: parentSessionId, observed })
    : null;
  const current = comparison?.after || comparison;
  const capabilityReason = missingParentTelemetryReason({ parentSessionId, comparison });
  const observationStatus = comparison
    ? (comparison.exact
      ? (observed?.before && observed?.after ? 'enforced' : 'observed')
      : capabilityReason ? 'unsupported' : 'failed')
    : (parentSessionId ? 'declared' : 'unsupported');
  return Object.freeze({
    ...CODEX_MAIN_SESSION_POLICY,
    sessionId: parentSessionId ? String(parentSessionId) : null,
    observedModel: current?.observedModel || null,
    observedEffort: current?.observedEffort || null,
    observedSessionId: current?.observedSessionId || null,
    observationStatus,
    observationReason: comparison?.reason || capabilityReason,
    capability: capabilityReason
      ? Object.freeze({
        type: 'unsupported-capability',
        code: CODEX_HOST_UNSUPPORTED_CAPABILITY,
        capability: CODEX_PARENT_SESSION_TELEMETRY_CAPABILITY,
        reason: capabilityReason,
        remediation: CODEX_PARENT_SESSION_REMEDIATION,
      })
      : null,
  });
};

export const isCodexCapabilityUnavailable = (policy = {}) => policy.observationStatus === 'unsupported';

export const resolveObservedCodexSessionConfigFromEvents = resolveObservedCodexSessionConfig;

export const resolveObservedCodexSessionConfigFromRollout = async ({ threadId, env = process.env, startedAt = new Date() } = {}) => {
  const rolloutPath = await findCodexSessionRollout({ threadId, env, startedAt });
  if (!rolloutPath) return null;
  let identityMatched = false;
  let observed = {
    model: null,
    effort: null,
    approvalPolicy: null,
    sandboxPolicy: null,
    permissionProfile: null,
  };
  const lines = readline.createInterface({ input: createReadStream(rolloutPath), crlfDelay: Infinity });
  for await (const line of lines) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event?.type === 'session_meta') {
      const sessionId = event?.payload?.session_id ?? event?.payload?.id;
      identityMatched = sessionId === threadId;
    }
    const current = resolveObservedCodexSessionConfigFromEvents([event]);
    observed = {
      model: current.model || observed.model,
      effort: current.effort || observed.effort,
      approvalPolicy: event?.type === 'turn_context'
        ? event?.payload?.approval_policy ?? observed.approvalPolicy
        : observed.approvalPolicy,
      sandboxPolicy: event?.type === 'turn_context'
        ? event?.payload?.sandbox_policy ?? observed.sandboxPolicy
        : observed.sandboxPolicy,
      permissionProfile: event?.type === 'turn_context'
        ? event?.payload?.permission_profile ?? observed.permissionProfile
        : observed.permissionProfile,
    };
  }
  return identityMatched ? Object.freeze(observed) : null;
};
