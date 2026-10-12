// Codex Host session telemetry. Requested model/effort are configuration;
// only terminal events or the matching persisted Codex rollout settings are
// evidence of what actually ran. Missing observations stay null and never echo
// a request.

import { createReadStream } from 'node:fs';
import { readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

type UnknownRecord = Record<string, unknown>;

interface CodexObservedConfig {
  model: string | null;
  effort: string | null;
  sessionId?: string | null;
  approvalPolicy?: unknown;
  sandboxPolicy?: unknown;
  permissionProfile?: unknown;
}

interface CodexSessionComparison {
  requestedModel: string | null;
  requestedEffort: string | null;
  observedModel: string | null;
  observedEffort: string | null;
  modelMatch: boolean | null;
  effortMatch: boolean | null;
  complete: boolean;
  exact: boolean;
  reason: string | null;
  expectedSessionId?: string | null;
  observedSessionId?: string | null;
  sessionMatch?: boolean;
}

interface CodexSessionInvarianceComparison {
  before: Readonly<CodexSessionComparison>;
  after: Readonly<CodexSessionComparison>;
  exact: boolean;
  reason: string | null;
}

interface CodexSessionObservationWindow {
  before: CodexObservedConfig | UnknownRecord;
  after: CodexObservedConfig | UnknownRecord;
}

type CodexMainSessionObservation =
  | CodexObservedConfig
  | UnknownRecord
  | CodexSessionObservationWindow;

const asRecord = (value: unknown): UnknownRecord => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : {}
);

const MODEL_KEYS = Object.freeze(['model', 'model_id', 'modelId', 'model_slug', 'modelSlug']);
const EFFORT_KEYS = Object.freeze(['effort', 'reasoning_effort', 'reasoningEffort', 'model_reasoning_effort']);
const TERMINAL_EVENT_TYPES = new Set(['turn.completed', 'response.completed', 'turn_context']);
const isThreadSettingsAppliedEvent = (event: unknown): boolean => {
  const record = asRecord(event);
  const payload = asRecord(record.payload);
  return record.type === 'event_msg'
    && payload.type === 'thread_settings_applied'
    && Boolean(payload.thread_settings)
    && typeof payload.thread_settings === 'object';
};

const codexSessionDateDirectories = (
  sessionsRoot: string,
  startedAt: Date = new Date(),
): string[] => {
  const directories = new Set<string>();
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

const findCodexSessionRollout = async ({
  threadId,
  env = process.env,
  startedAt = new Date(),
}: {
  threadId?: unknown;
  env?: NodeJS.ProcessEnv;
  startedAt?: Date;
} = {}): Promise<string | null> => {
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

const nestedObjects = (value: unknown): UnknownRecord[] => {
  const record = asRecord(value);
  const payload = asRecord(record.payload);
  return [
    record,
    asRecord(record.response),
    asRecord(record.turn),
    asRecord(record.metadata),
    payload,
    asRecord(record.thread_settings),
    asRecord(payload.thread_settings),
  ].filter((entry) => Object.keys(entry).length > 0);
};

const firstText = (
  objects: readonly UnknownRecord[],
  keys: readonly string[],
): string | null => {
  for (const object of objects) {
    for (const key of keys) {
      const value = object[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
  }
  return null;
};

const normalizeEffort = (value: unknown): string | null => {
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

export const resolveObservedCodexSessionConfig = (
  events: readonly unknown[] = [],
): Readonly<CodexObservedConfig> => {
  let model: string | null = null;
  let effort: string | null = null;
  for (const event of [...events].reverse()) {
    const record = asRecord(event);
    if (!TERMINAL_EVENT_TYPES.has(String(record.type || '')) && !isThreadSettingsAppliedEvent(event)) continue;
    const objects = nestedObjects(event);
    model ||= firstText(objects, MODEL_KEYS);
    effort ||= normalizeEffort(firstText(objects, EFFORT_KEYS));
    if (model && effort) break;
  }
  return Object.freeze({ model, effort });
};

export const compareCodexSessionConfig = ({
  requested = {},
  observed = {},
}: {
  requested?: UnknownRecord;
  observed?: CodexObservedConfig | UnknownRecord;
} = {}): Readonly<CodexSessionComparison> => {
  const requestedRecord = asRecord(requested);
  const observedRecord = asRecord(observed);
  const requestedModel = requestedRecord.model ? String(requestedRecord.model) : null;
  const requestedEffort = normalizeEffort(requestedRecord.effort);
  const observedModel = observedRecord.model ? String(observedRecord.model) : null;
  const observedEffort = normalizeEffort(observedRecord.effort);
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

export const compareCodexMainSessionConfig = ({
  expectedSessionId = null,
  observed = {},
}: {
  expectedSessionId?: unknown;
  observed?: CodexObservedConfig | UnknownRecord;
} = {}): Readonly<CodexSessionComparison> => {
  const observedRecord = asRecord(observed);
  const observedSessionId = observedRecord.sessionId ? String(observedRecord.sessionId) : null;
  const sessionMatch = Boolean(expectedSessionId && observedSessionId && String(expectedSessionId) === observedSessionId);
  const observedModel = observedRecord.model ? String(observedRecord.model) : null;
  const observedEffort = normalizeEffort(observedRecord.effort);
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

export const compareCodexMainSessionInvariance = ({
  expectedSessionId = null,
  before = {},
  after = {},
}: {
  expectedSessionId?: unknown;
  before?: CodexObservedConfig | UnknownRecord;
  after?: CodexObservedConfig | UnknownRecord;
} = {}): Readonly<CodexSessionInvarianceComparison> => {
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

const isInvarianceComparison = (
  comparison: CodexSessionComparison | CodexSessionInvarianceComparison,
): comparison is CodexSessionInvarianceComparison => (
  'before' in comparison && 'after' in comparison
);

const comparisonEntries = (
  comparison: CodexSessionComparison | CodexSessionInvarianceComparison | null | undefined,
): Readonly<CodexSessionComparison>[] => {
  if (!comparison) return [];
  return isInvarianceComparison(comparison)
    ? [comparison.before, comparison.after]
    : [comparison];
};

const missingParentTelemetryReason = ({
  parentSessionId,
  comparison,
}: {
  parentSessionId?: unknown;
  comparison?: CodexSessionComparison | CodexSessionInvarianceComparison | null;
} = {}): string | null => {
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
const isObservationWindow = (
  observed: CodexMainSessionObservation,
): observed is CodexSessionObservationWindow => (
  'before' in observed && 'after' in observed
);

export const buildCodexMainSessionPolicy = ({
  parentSessionId = null,
  observed = null,
}: {
  parentSessionId?: unknown;
  observed?: CodexMainSessionObservation | null;
} = {}) => {
  const hasWindow = Boolean(observed && isObservationWindow(observed));
  const comparison: CodexSessionComparison | CodexSessionInvarianceComparison | null = observed
    ? hasWindow
      ? compareCodexMainSessionInvariance({
        expectedSessionId: parentSessionId,
        before: (observed as CodexSessionObservationWindow).before,
        after: (observed as CodexSessionObservationWindow).after,
      })
      : compareCodexMainSessionConfig({
        expectedSessionId: parentSessionId,
        observed: observed as CodexObservedConfig | UnknownRecord,
      })
    : null;
  const current = comparison
    ? isInvarianceComparison(comparison) ? comparison.after : comparison
    : null;
  const capabilityReason = missingParentTelemetryReason({ parentSessionId, comparison });
  const observationStatus = comparison
    ? (comparison.exact
      ? (hasWindow ? 'enforced' : 'observed')
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

export const isCodexCapabilityUnavailable = (
  policy: { observationStatus?: unknown } = {},
): boolean => policy.observationStatus === 'unsupported';

export const resolveObservedCodexSessionConfigFromEvents = resolveObservedCodexSessionConfig;

export const resolveObservedCodexSessionConfigFromRollout = async ({
  threadId,
  env = process.env,
  startedAt = new Date(),
}: {
  threadId?: unknown;
  env?: NodeJS.ProcessEnv;
  startedAt?: Date;
} = {}): Promise<Readonly<CodexObservedConfig> | null> => {
  const normalizedThreadId = String(threadId || '');
  const rolloutPath = await findCodexSessionRollout({
    threadId: normalizedThreadId,
    env,
    startedAt,
  });
  if (!rolloutPath) return null;

  let identityMatched = false;
  let observed: CodexObservedConfig = {
    model: null,
    effort: null,
    approvalPolicy: null,
    sandboxPolicy: null,
    permissionProfile: null,
  };
  const lines = readline.createInterface({
    input: createReadStream(rolloutPath),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const event = asRecord(parsed);
    const payload = asRecord(event.payload);
    if (event.type === 'session_meta') {
      const sessionId = payload.session_id ?? payload.id;
      identityMatched = String(sessionId || '') === normalizedThreadId;
    }
    const current = resolveObservedCodexSessionConfigFromEvents([event]);
    observed = {
      model: current.model || observed.model,
      effort: current.effort || observed.effort,
      approvalPolicy: event.type === 'turn_context'
        ? payload.approval_policy ?? observed.approvalPolicy
        : observed.approvalPolicy,
      sandboxPolicy: event.type === 'turn_context'
        ? payload.sandbox_policy ?? observed.sandboxPolicy
        : observed.sandboxPolicy,
      permissionProfile: event.type === 'turn_context'
        ? payload.permission_profile ?? observed.permissionProfile
        : observed.permissionProfile,
    };
  }
  return identityMatched ? Object.freeze(observed) : null;
};
