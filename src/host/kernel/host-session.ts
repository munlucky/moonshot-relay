import { requiredIndex } from '../../shared/required-index.js';
import { canonicalizeHostSessionId } from '../../contracts/host-session.js';

interface HostBindingConflict {
  source: string;
  sessionId: string;
}

export class HostBindingConflictError extends Error {
  readonly code = 'host_binding_conflict';
  readonly errorCode = 'host_binding_conflict';
  readonly nextAction = 'reopen-from-correct-worktree';
  readonly details: { bindings: HostBindingConflict[] };

  constructor(bindings: HostBindingConflict[] = []) {
    super('host_binding_conflict');
    this.name = 'HostBindingConflictError';
    this.details = { bindings };
  }
}

export interface CanonicalHostSessionResolution {
  sessionId: string | null;
  nativeSessionId: string | null;
  source: string | null;
}

interface HostSessionCandidate {
  source: string;
  value: unknown;
  provider: unknown;
}

export function resolveCanonicalHostSession({
  provider,
  explicitSessionId = null,
  envSessionId = null,
  codexThreadId = null,
}: {
  provider?: unknown;
  explicitSessionId?: unknown;
  envSessionId?: unknown;
  codexThreadId?: unknown;
} = {}): CanonicalHostSessionResolution {
  const candidates: HostSessionCandidate[] = [
    { source: 'cli', value: explicitSessionId, provider },
    { source: 'environment', value: envSessionId, provider },
    { source: 'codex-thread', value: codexThreadId, provider: 'codex' },
  ].filter(({ value }) => String(value || '').trim());

  if (candidates.length === 0) {
    return { sessionId: null, nativeSessionId: null, source: null };
  }

  const resolved = candidates.map(({ source, value, provider: candidateProvider }) => ({
    source,
    nativeSessionId: String(value).trim(),
    sessionId: canonicalizeHostSessionId({
      provider: candidateProvider,
      sessionId: value,
    }),
  }));
  if (new Set(resolved.map((item) => item.sessionId)).size > 1) {
    throw new HostBindingConflictError(
      resolved.map(({ source, sessionId }) => ({ source, sessionId })),
    );
  }
  return requiredIndex(resolved, 0);
}

export function providerForSurface(surface: unknown): string {
  const normalized = String(surface || '').trim().toLowerCase();
  if (normalized === 'codex_desktop' || normalized === 'codex') return 'codex';
  if (normalized === 'codex_cli') return 'codex-cli';
  if (normalized === 'claude_desktop' || normalized === 'claude') return 'claude';
  if (normalized === 'claude_cli' || normalized === 'claude_code') return 'claude-code';
  if (normalized === 'qwen_cli' || normalized === 'qwen') return 'qwen';
  if (normalized === 'ade_cli' || normalized === 'ade') return 'ade';
  if (normalized === 'antigravity_desktop' || normalized === 'antigravity') return 'antigravity';
  return 'unknown-host';
}
