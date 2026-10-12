import type { HostAdapterDispatch } from './adapter-dispatch.js';
// Review Transport Resolver (Wave 5 / Wave 9).
// Resolves available trusted reviewer transports in priority order without
// invoking external shell or CLI subprocesses.

import { createClaudeAdapter } from './adapters/claude.js';
import { createCodexAdapter } from './adapters/codex.js';
import { createModelRegistry, type ModelOverrideMap } from './model-registry.js';

type UnknownRecord = Record<PropertyKey, unknown>;

export interface ReviewAdapter {
  surface?: unknown;
  capabilities?: ({
    surface?: unknown;
    [key: string]: unknown;
  }) | undefined;
  dispatch: HostAdapterDispatch;
}

export interface ReviewTransportEntry {
  adapter: ReviewAdapter;
  registry?: unknown;
  [key: string]: unknown;
}

type ReviewTransportCandidate = ReviewAdapter | ReviewTransportEntry;

interface ReviewTransportAttestation {
  source: string;
  adapter: ReviewAdapter;
}

const REVIEW_TRANSPORT_ATTESTATION = Symbol('kernel.review-transport-attestation');

type AttestedReviewTransport = ReviewTransportEntry & {
  [REVIEW_TRANSPORT_ATTESTATION]?: ReviewTransportAttestation;
};

const asRecord = (value: unknown): UnknownRecord | null => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : null
);

const isReviewAdapter = (value: unknown): value is ReviewAdapter => {
  const record = asRecord(value);
  return Boolean(record && typeof record.dispatch === 'function');
};

const candidateParts = (
  candidate: unknown,
): { adapter: ReviewAdapter | null; entry: ReviewTransportEntry | null } => {
  const record = asRecord(candidate);
  if (!record) return { adapter: null, entry: null };
  const nested = record.adapter;
  if (isReviewAdapter(nested)) {
    return {
      adapter: nested,
      entry: { ...record, adapter: nested },
    };
  }
  if (isReviewAdapter(record)) {
    return {
      adapter: record,
      entry: { adapter: record },
    };
  }
  return { adapter: null, entry: null };
};

export const attestReviewTransport = (
  candidate: unknown,
  source = 'host',
): AttestedReviewTransport | null => {
  const { adapter, entry } = candidateParts(candidate);
  if (!adapter || !entry) return null;
  const attested: AttestedReviewTransport = { ...entry };
  Object.defineProperty(attested, REVIEW_TRANSPORT_ATTESTATION, {
    value: Object.freeze({
      source: String(source || 'host'),
      adapter,
    }),
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return attested;
};

const hasHostAttestation = (
  candidate: unknown,
): candidate is AttestedReviewTransport => {
  const record = asRecord(candidate) as AttestedReviewTransport | null;
  const adapter = candidateParts(candidate).adapter;
  return Boolean(
    record
    && adapter
    && record[REVIEW_TRANSPORT_ATTESTATION]?.adapter === adapter,
  );
};

export interface ReviewTransportOverrides extends ModelOverrideMap {
  reviewTransports?: unknown[];
  claudeLauncher?: Parameters<typeof createClaudeAdapter>[0] extends infer Options ? Options extends { launch?: infer Launch } ? Launch : never : never;
  launchClaude?: Parameters<typeof createClaudeAdapter>[0] extends infer Options ? Options extends { launch?: infer Launch } ? Launch : never : never;
  claudeCapabilities?: Record<string, unknown>;
  codexLauncher?: NonNullable<Parameters<typeof createCodexAdapter>[0]>['nativeLaunch'];
  launchCodex?: NonNullable<Parameters<typeof createCodexAdapter>[0]>['nativeLaunch'];
  codexCapabilities?: Record<string, unknown>;
}

type ReviewAdapterFactory = (
  input?: Record<string, unknown>,
) => ReviewAdapter;

type ModelRegistryFactory = (
  input?: Record<string, unknown>,
) => unknown;

const createClaudeReviewAdapter = createClaudeAdapter;
const createCodexReviewAdapter = createCodexAdapter;
const createReviewModelRegistry = createModelRegistry;

const surfaceOf = (candidate: unknown): string => {
  const adapter = candidateParts(candidate).adapter;
  return String(
    adapter?.capabilities?.surface
    || adapter?.surface
    || '',
  ).toLowerCase();
};

export const resolveReviewTransports = ({
  adapter = null,
  reviewFallbacks = [],
  hostAdapters = [],
  reviewTransports = [],
  env = process.env,
  runtimeHome = null,
  overrides = {},
}: {
  adapter?: ReviewAdapter | null;
  reviewFallbacks?: readonly unknown[];
  hostAdapters?: readonly unknown[];
  reviewTransports?: readonly unknown[];
  env?: NodeJS.ProcessEnv;
  runtimeHome?: (string | null) | undefined;
  overrides?: ReviewTransportOverrides;
} = {}): AttestedReviewTransport[] => {
  const explicitFallbacks = reviewFallbacks.filter(hasHostAttestation);
  const additionalAdapters = [
    ...hostAdapters,
    ...reviewTransports,
    ...(Array.isArray(overrides.reviewTransports)
      ? overrides.reviewTransports
      : []),
  ].filter(hasHostAttestation);

  const candidates: Array<AttestedReviewTransport | null> = [
    ...explicitFallbacks,
    ...additionalAdapters,
  ];

  const primarySurface = String(
    adapter?.surface || adapter?.capabilities?.surface || '',
  ).toLowerCase();

  if (primarySurface === 'codex') {
    candidates.push(attestReviewTransport({
      adapter: createClaudeReviewAdapter({
        launch: overrides.claudeLauncher || overrides.launchClaude || null,
        capabilities: overrides.claudeCapabilities || {},
      }),
      registry: createReviewModelRegistry({
        surface: 'claude',
        runtimeHome,
        env,
        overrides,
      }),
    }, 'resolver:auto'));
  } else if (primarySurface === 'claude') {
    candidates.push(attestReviewTransport({
      adapter: createCodexReviewAdapter({
        runtimeHome,
        env,
        nativeLaunch: overrides.codexLauncher || overrides.launchCodex || null,
        capabilities: overrides.codexCapabilities || {},
      }),
      registry: createReviewModelRegistry({
        surface: 'codex',
        runtimeHome,
        env,
        overrides,
      }),
    }, 'resolver:auto'));
  }

  const nonNull = candidates.filter(
    (candidate): candidate is AttestedReviewTransport => Boolean(candidate),
  );
  const unique = nonNull.filter((candidate, index, self) => {
    const candidateAdapter = candidate.adapter;
    if (candidateAdapter === adapter) return false;
    return self.findIndex((other) => other.adapter === candidateAdapter) === index;
  });

  const sameProvider = unique.filter(
    (candidate) => surfaceOf(candidate) === primarySurface && primarySurface !== '',
  );
  const alternateProvider = unique.filter((candidate) => {
    const surface = surfaceOf(candidate);
    return !surface || surface !== primarySurface;
  });

  return [...sameProvider, ...alternateProvider];
};
